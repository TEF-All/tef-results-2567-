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
    pages: pageTexts.map((text, i) => ({ pageNumber: i + 1, text })),
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
        allPages.push({ pageNumber, text });
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

module.exports = { extractText };
