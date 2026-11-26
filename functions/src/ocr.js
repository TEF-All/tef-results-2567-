/**
 * OCR / text-extraction layer.
 *
 * Strategy (matches ADMIN_IMPORT_SYSTEM_ARCHITECTURE.md §2, function `extractDraft`):
 *   1. Try to read the PDF's own text layer first (pdf-parse). Most TEF result
 *      sheets are produced from Word/Excel, so this is often enough and costs
 *      nothing — no Vision API call at all.
 *   2. Only if the text layer is empty/too short (i.e. the PDF is a scanned
 *      image) fall back to Google Cloud Vision's DOCUMENT_TEXT_DETECTION via
 *      `batchAnnotateFiles`, which accepts a PDF directly (no manual
 *      page-to-image rendering needed). Vision's sync API caps a single
 *      request at 5 pages, so documents longer than that are chunked into
 *      multiple requests.
 *
 * Both paths return the same shape: { source: 'text_layer' | 'vision_ocr',
 * pages: [{ pageNumber, text }] } so tableParser.js never needs to know which
 * path produced the text.
 */

const MIN_TEXT_LAYER_CHARS_PER_PAGE = 40; // below this, treat the page as "no usable text layer"
const VISION_MAX_PAGES_PER_REQUEST = 5; // Cloud Vision files.annotate sync limit

/**
 * Pulls word-level bounding boxes out of a Vision `fullTextAnnotation`.
 *
 * Why this matters: `fullTextAnnotation.text` is a flat string where Vision
 * has already collapsed each line's inter-column whitespace down to single
 * spaces. That destroyed tableParser.js's old "split on 2+ spaces" column
 * detection the moment it met a real scanned result sheet — every column on
 * a line collapsed into one undifferentiated blob (confirmed against the 16
 * real competition PDFs supplied 2026-11-26; see tableParser.js header
 * comment). The only way to recover real column structure is to use the
 * geometry Vision still gives us per word, and reconstruct rows/columns
 * from pixel positions instead of from whitespace.
 *
 * @returns {Array<{text:string,x0:number,x1:number,y0:number,y1:number}>}
 */
function wordsFromFullTextAnnotation(fta) {
  const words = [];
  if (!fta || !Array.isArray(fta.pages)) return words;
  for (const page of fta.pages) {
    // Confirmed against a real production Vision response (2026-11-26): for
    // a PDF submitted via batchAnnotateFiles, Vision returns an EMPTY
    // `vertices` array (`[]`, not absent) on every word, with real
    // coordinates only in `normalizedVertices` (0..1 floats). `[] || x`
    // evaluates to `[]` in JS (empty array is truthy), so the old
    // `vertices || normalizedVertices` fallback never actually reached
    // normalizedVertices — every word got 0 vertices and was dropped,
    // silently emptying `words` and sending every page through the legacy
    // flat-text parser. Fix: explicitly prefer vertices only when it has
    // real points, and scale normalizedVertices by the page's pixel size.
    const pageW = typeof page.width === 'number' && page.width > 0 ? page.width : null;
    const pageH = typeof page.height === 'number' && page.height > 0 ? page.height : null;
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const text = (word.symbols || []).map((s) => (s && s.text) || '').join('');
          if (!text.trim()) continue;
          const bbox = word.boundingBox || {};
          let xs;
          let ys;
          if (Array.isArray(bbox.vertices) && bbox.vertices.length >= 4) {
            xs = bbox.vertices.map((v) => v.x || 0);
            ys = bbox.vertices.map((v) => v.y || 0);
          } else if (Array.isArray(bbox.normalizedVertices) && bbox.normalizedVertices.length >= 4) {
            // Normalized (0..1) coordinates — scale to the page's pixel
            // dimensions when known so thresholds elsewhere (medH * 0.35,
            // etc.) behave the same regardless of which field Vision used.
            // Without a known page size, fall back to the 0..1 values
            // directly — still internally consistent since every
            // downstream threshold is relative to the words' own median
            // height, not an absolute pixel count.
            const sx = pageW || 1;
            const sy = pageH || 1;
            xs = bbox.normalizedVertices.map((v) => (v.x || 0) * sx);
            ys = bbox.normalizedVertices.map((v) => (v.y || 0) * sy);
          } else {
            continue;
          }
          words.push({
            text,
            x0: Math.min(...xs),
            x1: Math.max(...xs),
            y0: Math.min(...ys),
            y1: Math.max(...ys),
          });
        }
      }
    }
  }
  return words;
}

async function extractTextLayer(pdfBuffer) {
  // Lazy require: keeps cold start fast for the (common) OCR path where
  // pdf-parse's text-layer attempt still runs first but isn't the bottleneck.
  const pdfParse = require('pdf-parse');

  const pageTexts = [];
  await pdfParse(pdfBuffer, {
    // pdf-parse calls this once per page in document order.
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent();
      const text = textContent.items.map((item) => item.str).join(' ');
      pageTexts.push(text);
      return text;
    },
  });

  const totalChars = pageTexts.reduce((sum, t) => sum + t.trim().length, 0);
  const avgCharsPerPage = pageTexts.length ? totalChars / pageTexts.length : 0;

  return {
    hasUsableTextLayer: avgCharsPerPage >= MIN_TEXT_LAYER_CHARS_PER_PAGE,
    // words: [] (always) — pdf-parse's text layer gives us strings, not
    // per-word geometry, so tableParser.js uses its legacy flat-text path
    // for these pages. That's fine: a real text layer (not OCR) preserves
    // meaningful whitespace far better than Vision's flattened OCR text did.
    pages: pageTexts.map((text, i) => ({ pageNumber: i + 1, text, words: [] })),
  };
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function extractWithVision(pdfBuffer, visionClient, pageCountHint) {
  // We don't always know the page count up front (pdf-parse gives it to us as
  // a side effect above, but if the text-layer attempt threw we may not have
  // it) — ask for a generous page range and let Vision tell us what exists;
  // unmatched page numbers simply come back with empty responses.
  const totalPages = pageCountHint || 30; // generous cap; real docs are a handful of pages
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
  const pageChunks = chunk(pageNumbers, VISION_MAX_PAGES_PER_REQUEST);

  const content = pdfBuffer.toString('base64');
  const allPages = [];

  for (const pages of pageChunks) {
    const [result] = await visionClient.batchAnnotateFiles({
      requests: [
        {
          inputConfig: { content, mimeType: 'application/pdf' },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          pages,
        },
      ],
    });

    const responses = result.responses?.[0]?.responses || [];
    responses.forEach((pageResp, idx) => {
      const pageNumber = pages[idx];
      const text = pageResp.fullTextAnnotation?.text || '';
      if (text.trim().length > 0) {
        // Best-effort: if geometry extraction throws for any reason (an
        // unexpected response shape), fall back to words: [] rather than
        // failing the whole page — tableParser.js treats an empty words
        // array as "use the legacy flat-text parser" for that page.
        let words = [];
        try {
          words = wordsFromFullTextAnnotation(pageResp.fullTextAnnotation);
        } catch (err) {
          console.error(
            '[OCR_DEBUG] wordsFromFullTextAnnotation threw for page',
            pageNumber,
            '-',
            err && err.message,
            err && err.stack
          );
          words = [];
        }
        // Lightweight confirmation log — kept intentionally (cheap, one line
        // per page) so a future "table still won't split" report can be
        // checked against this instead of re-adding debug instrumentation.
        console.log('[OCR] page', pageNumber, 'wordsExtracted:', words.length);
        allPages.push({ pageNumber, text, words });
      }
      // A page past the end of the real document comes back with no
      // fullTextAnnotation at all — Vision doesn't error, it just returns
      // nothing for it, so we silently skip it rather than guessing.
    });

    // Stop early once we hit a fully-empty chunk — almost certainly past the
    // end of the document, and it saves quota/cost.
    if (responses.every((r) => !r.fullTextAnnotation?.text)) break;
  }

  allPages.sort((a, b) => a.pageNumber - b.pageNumber);
  return allPages;
}

/**
 * @param {Buffer} pdfBuffer
 * @param {import('@google-cloud/vision').v1.ImageAnnotatorClient} visionClient
 * @returns {Promise<{ source: 'text_layer'|'vision_ocr', pages: Array<{pageNumber:number, text:string}> }>}
 */
async function extractText(pdfBuffer, visionClient) {
  let textLayerResult = null;
  try {
    textLayerResult = await extractTextLayer(pdfBuffer);
  } catch (err) {
    // A malformed/encrypted PDF can throw here — that's fine, we just fall
    // through to Vision OCR below instead of failing the whole draft.
    textLayerResult = null;
  }

  if (textLayerResult && textLayerResult.hasUsableTextLayer) {
    return { source: 'text_layer', pages: textLayerResult.pages };
  }

  const pageCountHint = textLayerResult ? textLayerResult.pages.length : undefined;
  const pages = await extractWithVision(pdfBuffer, visionClient, pageCountHint);
  return { source: 'vision_ocr', pages };
}

module.exports = { extractText, wordsFromFullTextAnnotation };
