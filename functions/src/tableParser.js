/**
 * Table parser — turns OCR/text-layer output into draft `entry` rows
 * matching the schema in FUTURE_YEAR_DATA_SCHEMA.md §3.
 *
 * REWRITTEN 2026-11-26 against 16 real TEF competition PDFs (Jumping,
 * Dressage, Endurance, and a Thai-language school-games jumping table) that
 * the admin uploaded after the first version of this parser produced almost
 * entirely scrambled rows. Root cause, confirmed by rendering the real pages
 * and inspecting Vision's actual output shape: `fullTextAnnotation.text` is
 * a FLAT string where Vision has already collapsed each line's inter-column
 * whitespace down to single spaces. The old parser split columns on "2+
 * spaces in the line" — a heuristic that depends on whitespace Vision
 * simply does not preserve. That is why rank/bib/athlete/horse/club all
 * piled into one blob per row.
 *
 * The fix: ocr.js now also returns each word's pixel bounding box
 * (`page.words`). This parser reconstructs the table from that geometry —
 * clustering words into visual rows by Y position, finding the header row
 * by matching known column-label keywords (English *and* Thai — several of
 * the real files are Thai-language school-equestrian result sheets), then
 * assigning each data row's words to a column by X position relative to the
 * header's anchors. That is robust to whatever whitespace Vision did or
 * didn't preserve, because it never looks at whitespace at all.
 *
 * HONEST LIMITATION (keep this comment): real organizers print wildly
 * different sheet layouts (FEI international jumping score sheets, Thai
 * school-games sheets, single-row-per-page dressage scorecards, multi-row
 * FEI endurance "loop" race reports with merged rank/name cells). This
 * parser handles the known shapes seen in that batch of 16 files plus a
 * generic header-anchored fallback and a positional last-resort fallback,
 * but it will not perfectly parse every possible layout an organizer could
 * produce. That is exactly why every row still defaults to
 * needs_review: true unless it cleanly matches an expected pattern, and why
 * publishYear refuses to publish while any row still has
 * needs_review === true — a human always confirms before anything reaches
 * the public site.
 */

const { blankEntry } = require('./schema');

// ---------------------------------------------------------------------------
// Legacy flat-text helpers (kept for pages with no word geometry, i.e. a
// genuine PDF text layer rather than Vision OCR — see ocr.js, extractTextLayer
// always returns words: []). A real text layer preserves whitespace far
// better than Vision's flattened OCR text, so the old heuristic is a
// reasonable fallback there, and keeping it avoids any behavior change for
// that path.
// ---------------------------------------------------------------------------

function splitColumns(line) {
  const wide = line.trim().split(/\s{2,}/).filter(Boolean);
  if (wide.length >= 4) return wide;
  return line.trim().split(/\s+/).filter(Boolean);
}

function toNumberOrNull(str) {
  if (str === undefined || str === null) return null;
  const cleaned = String(str).replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function applyDisciplineFields(entry, discipline, displayText) {
  const joined = displayText || '';

  switch (discipline) {
    case 'Jumping': {
      const timeMatch = joined.match(/(\d+\.\d+)\s*s?/);
      const faultsMatch = joined.match(/(\d+)\s*(?:faults?|pen|โทษ)/i);
      entry.official_value.time_seconds = timeMatch ? toNumberOrNull(timeMatch[1]) : null;
      entry.official_value.faults = faultsMatch ? toNumberOrNull(faultsMatch[1]) : null;
      const jumpOff = joined.match(/jump[\s-]?off[^\d]*(\d+\.?\d*)[^\d]*(\d+)?/i);
      if (jumpOff) {
        entry.official_value.jump_off_time_seconds = toNumberOrNull(jumpOff[1]);
        entry.official_value.jump_off_faults = toNumberOrNull(jumpOff[2]);
      }
      break;
    }
    case 'Dressage': {
      const pct = joined.match(/(\d{1,3}\.\d{1,3})\s*%?/);
      entry.official_value.total_percent = pct ? toNumberOrNull(pct[1]) : null;
      const tech = joined.match(/tech(?:nical)?[^\d]*(\d{1,3}\.?\d*)/i);
      const coll = joined.match(/collective[^\d]*(\d{1,3}\.?\d*)/i);
      entry.official_value.technical_percent = tech ? toNumberOrNull(tech[1]) : null;
      entry.official_value.collective_percent = coll ? toNumberOrNull(coll[1]) : null;
      break;
    }
    case 'Eventing': {
      const dp = joined.match(/dressage[^\d]*(\d+\.?\d*)/i);
      const jp = joined.match(/jump(?:ing)?[^\d]*(\d+\.?\d*)/i);
      const xc = joined.match(/(?:xc|cross[\s-]?country)[^\d]*(\d+\.?\d*)/i);
      entry.official_value.dressage_penalty = dp ? toNumberOrNull(dp[1]) : null;
      entry.official_value.jumping_penalty = jp ? toNumberOrNull(jp[1]) : null;
      entry.official_value.xc_penalty = xc ? toNumberOrNull(xc[1]) : null;
      break;
    }
    case 'Endurance': {
      const loops = [...joined.matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)/g)].map((m) => m[1]);
      entry.official_value.loop_times = loops.length ? loops : null;
      const vet = joined.match(/\b(pass|fail|ผ่าน|ไม่ผ่าน)\b/i);
      entry.official_value.vet_gate_result = vet ? vet[1] : null;
      break;
    }
    default:
      break;
  }
}

function parseLegacyLine(line, discipline, sourceFile, pageNumber) {
  const entry = blankEntry();
  entry.source_file = sourceFile;
  entry.source_page = pageNumber;
  entry.discipline = discipline;

  const columns = splitColumns(line);
  if (columns.length < 5) {
    entry.needs_review = true;
    entry.official_value.display = columns.join(' ');
    return entry;
  }
  const [rankRaw, bibRaw, athleteRaw, horseRaw, clubRaw, ...rest] = columns;
  const rank = toNumberOrNull(rankRaw);
  entry.rank = rank;
  entry.bib = bibRaw != null ? String(bibRaw) : null;
  entry.athlete = athleteRaw || null;
  entry.name_as_printed = athleteRaw || null;
  entry.horse = horseRaw || null;
  entry.club = clubRaw || null;
  entry.official_value.display = rest.join(' ') || null;
  const looksClean =
    rank !== null && athleteRaw && athleteRaw.length >= 2 && horseRaw && horseRaw.length >= 2;
  entry.needs_review = !looksClean;
  applyDisciplineFields(entry, discipline, rest.join(' '));
  return entry;
}

function parseLegacyPage(page, discipline, sourceFile) {
  const entries = [];
  const lines = page.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^\d/.test(line)) continue;
    if (/^\d+\s*$/.test(line)) continue;
    entries.push(parseLegacyLine(line, discipline, sourceFile, page.pageNumber));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Geometry-based engine (used whenever page.words is non-empty, i.e. the
// Vision OCR path).
// ---------------------------------------------------------------------------

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function toGeomWords(words) {
  return words.map((w) => ({
    text: w.text,
    x0: w.x0,
    x1: w.x1,
    y0: w.y0,
    y1: w.y1,
    cx: (w.x0 + w.x1) / 2,
    cy: (w.y0 + w.y1) / 2,
    h: Math.max(1, w.y1 - w.y0),
  }));
}

// Groups words into visual table rows by Y position. Vision gives us words,
// not lines, so this (not whitespace) is what defines a "row" here.
function clusterRows(words) {
  const medH = median(words.map((w) => w.h)) || 10;
  const sorted = [...words].sort((a, b) => a.cy - b.cy);
  const rows = [];
  let current = [];
  let currentCy = null;
  for (const w of sorted) {
    if (current.length === 0) {
      current = [w];
      currentCy = w.cy;
      continue;
    }
    if (Math.abs(w.cy - currentCy) > medH * 0.65) {
      rows.push(current);
      current = [w];
      currentCy = w.cy;
    } else {
      current.push(w);
      currentCy = current.reduce((s, x) => s + x.cy, 0) / current.length;
    }
  }
  if (current.length) rows.push(current);
  rows.forEach((r) => r.sort((a, b) => a.cx - b.cx));
  return rows;
}

// Reconstructs a row's text left-to-right from word geometry, gap-aware
// (not whitespace-aware): a small horizontal gap glues two word-fragments
// together (handles OCR splitting a single word, or a Thai syllable cluster,
// into multiple "words" with no real gap between them); a larger gap
// becomes a single space; a very large gap — a real column boundary —
// becomes a double space. It also returns a start/end index for every
// contributing word, so a keyword match found in the joined text can be
// mapped back to the exact word(s) that produced it, and therefore to their
// real pixel position.
const THAI_RE = /[฀-๿]/;

// Decides the separator between two horizontally-adjacent words, gap-aware
// (not whitespace-aware — see module header comment for why). Thai script
// has no in-word spaces at all, and OCR frequently over-segments a single
// Thai word into one "word" per glyph/mark with visible gaps between them
// (consonants, stacked tone marks and vowels). So next to Thai text, treat
// any gap as "same word" unless it's wide enough to plausibly be a real
// column break — otherwise a name like "ชนากาญจนกิจ" comes out as
// "ช น า ก า ญ จ น ก ิ จ". This is shared by every place in this file that
// joins words back into text (the row-level reconstruction used for header
// matching, and per-column cell text), so the fix applies everywhere.
function wordSeparator(prevText, nextText, gap, medH) {
  const thaiAdjacent = THAI_RE.test(prevText) || THAI_RE.test(nextText);
  if (thaiAdjacent) {
    return gap > medH * 4.5 ? '  ' : '';
  }
  if (gap > medH * 2.2) return '  ';
  if (gap > medH * 0.35) return ' ';
  return '';
}

function joinWordsGlued(words) {
  if (!words.length) return '';
  const medH = median(words.map((w) => w.h)) || 10;
  let text = words[0].text;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].x0 - words[i - 1].x1;
    text += wordSeparator(words[i - 1].text, words[i].text, gap, medH) + words[i].text;
  }
  return text;
}

function reconstructRow(rowWords) {
  const medH = median(rowWords.map((w) => w.h)) || 10;
  let text = '';
  const spans = [];
  let prevX1 = null;
  let prevText = '';
  for (const w of rowWords) {
    const gap = prevX1 == null ? 0 : w.x0 - prevX1;
    if (prevX1 != null) text += wordSeparator(prevText, w.text, gap, medH);
    const start = text.length;
    text += w.text;
    spans.push({ start, end: text.length, word: w });
    prevX1 = w.x1;
    prevText = w.text;
  }
  return { text, spans };
}

// Splits a row into gap-delimited cells (used by the positional fallback,
// where we have no header labels to anchor on at all).
function splitRowIntoCells(rowWords) {
  if (!rowWords.length) return [];
  const medH = median(rowWords.map((w) => w.h)) || 10;
  const cellGap = medH * 1.6;
  const cells = [];
  let current = [rowWords[0]];
  for (let i = 1; i < rowWords.length; i++) {
    const gap = rowWords[i].x0 - current[current.length - 1].x1;
    if (gap > cellGap) {
      cells.push(current);
      current = [rowWords[i]];
    } else {
      current.push(rowWords[i]);
    }
  }
  cells.push(current);
  return cells.map((words) => ({
    text: reconstructRow(words).text.trim(),
    cx: words.reduce((s, w) => s + w.cx, 0) / words.length,
    x0: Math.min(...words.map((w) => w.x0)),
    x1: Math.max(...words.map((w) => w.x1)),
  }));
}

// English + Thai column-label keywords per semantic role. Several real
// files are Thai school-games sheets (ลำดับ/ชื่อนักกีฬา/ชื่อม้า/สังกัด); a
// few common OCR confusions for the Thai spellings are included as
// alternates (ซ/ช, and the two ways ลำ/ลํา can come out of OCR) since exact
// substring matching is otherwise fragile against those.
const ROLE_KEYWORDS = {
  RANK: ['rank', 'place', 'อันดับ', 'ลำดับ', 'ลําดับ'],
  BIB: [
    'bib', 'h.no', 'h. no', 'horses no', 'horse no', 'horses  no',
    'หมายเลขม้า', 'เลขหมาย', 'เลขที่ม้า',
  ],
  ATHLETE: ['rider', 'athlete', 'ชื่อนักกีฬา', 'ซื่อนักกีฬา', 'นักกีฬา'],
  HORSE: ['horse', 'ชื่อม้า', 'ซื่อม้า'],
  CLUB: ['club', 'nation', 'country', 'team', 'สังกัด'],
};

// Signature keywords that mean "this is the FEI-style endurance loop-by-loop
// race report", which needs a completely different reconstruction strategy
// (see parseEndurancePage below) because its rank/name cells are merged
// across several physical table rows (one per loop).
function looksLikeEnduranceRaceReport(rowTexts) {
  const joined = rowTexts.join(' ').toUpperCase();
  return (
    (joined.includes('LOOP') && (joined.includes('ARRIVAL') || joined.includes('VET-IN'))) ||
    joined.includes('RACE REPORT')
  );
}

function findHeaderAnchors(rows, maxRowIndex) {
  let best = null;
  const limit = Math.min(rows.length, Math.max(1, maxRowIndex));
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const { text, spans } = reconstructRow(row);
    const lower = text.toLowerCase();
    const anchors = {};
    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
      for (const kw of keywords) {
        const isLatin = /[a-z]/i.test(kw);
        const hay = isLatin ? lower : text;
        const idx = hay.indexOf(kw);
        if (idx !== -1) {
          const endIdx = idx + kw.length;
          const covering = spans.filter((s) => s.start < endIdx && s.end > idx);
          if (covering.length) {
            const x0 = Math.min(...covering.map((s) => s.word.x0));
            const x1 = Math.max(...covering.map((s) => s.word.x1));
            anchors[role] = { x0, x1, cx: (x0 + x1) / 2 };
          }
          break;
        }
      }
    }
    const score = Object.keys(anchors).length;
    if (score >= 2 && (anchors.RANK || anchors.ATHLETE) && (!best || score > best.score)) {
      best = { rowIndex: i, anchors, score };
    }
  }
  return best;
}

function buildColumnBoundaries(anchors) {
  const order = ['RANK', 'BIB', 'ATHLETE', 'HORSE', 'CLUB'];
  const present = order
    .filter((r) => anchors[r])
    .map((r) => ({ role: r, cx: anchors[r].cx }));
  present.sort((a, b) => a.cx - b.cx);
  const cols = [];
  for (let i = 0; i < present.length; i++) {
    const left = i === 0 ? -Infinity : (present[i - 1].cx + present[i].cx) / 2;
    let right;
    if (i < present.length - 1) {
      right = (present[i].cx + present[i + 1].cx) / 2;
    } else if (present.length >= 2) {
      const gap = present[i].cx - present[i - 1].cx;
      right = present[i].cx + gap / 2;
    } else {
      right = present[i].cx + 300;
    }
    cols.push({ role: present[i].role, left, right });
  }
  return cols;
}

// Columns whose content is semantically always a bare number (plus maybe
// trailing "." or "," list punctuation) - never a letter. Used below to
// catch the dominant real-world column-boundary bug: buildColumnBoundaries
// places the RANK|ATHLETE divider at the midpoint between the two header
// LABELS' own x-positions, which is a poor proxy for where the real data
// column actually splits whenever RANK is a narrow header hugging the left
// margin next to a wide RIDER/ATHLETE column whose text starts almost
// immediately. Confirmed against real production word coordinates (CSIY-B
// Pattaya 2026, 2026-11-26): every rider's first name/initial word landed
// to the left of that boundary and inside the RANK bucket (e.g. "Nueafha"
// at cx=55 vs. a RANK|ATHLETE boundary of 61.75), where it was then
// silently dropped once the rank text was reduced to digits-only. A rank
// or bib cell with non-numeric words IS exactly this leak, every time -
// semantic validation is far more robust here than trying to tune the
// pixel boundary itself, since it doesn't depend on exact column widths
// that vary PDF to PDF.
const NUMERIC_ONLY_ROLES = ['RANK', 'BIB'];

function assignRowToColumns(rowWords, cols) {
  const byRoleWords = {};
  const restWords = [];
  for (const w of rowWords) {
    let placed = false;
    for (const c of cols) {
      if (w.cx >= c.left && w.cx < c.right) {
        (byRoleWords[c.role] = byRoleWords[c.role] || []).push(w);
        placed = true;
        break;
      }
    }
    if (!placed) restWords.push(w);
  }
  for (const role of NUMERIC_ONLY_ROLES) {
    const words = byRoleWords[role];
    if (!words || !words.length) continue;
    const numericWords = words.filter((w) => /^\d+[.,]?$/.test(w.text));
    const strayWords = words.filter((w) => !/^\d+[.,]?$/.test(w.text));
    if (!strayWords.length) continue;
    if (numericWords.length) byRoleWords[role] = numericWords;
    else delete byRoleWords[role];
    byRoleWords.ATHLETE = [...(byRoleWords.ATHLETE || []), ...strayWords].sort(
      (a, b) => a.cx - b.cx
    );
  }
  const byRole = {};
  for (const [role, words] of Object.entries(byRoleWords)) {
    byRole[role] = joinWordsGlued(words);
  }
  const rest = reconstructRow(restWords).text.trim().replace(/\s{2,}/g, '  ');
  return { byRole, rest };
}

// Some sheets (e.g. the real "Place | Rider | Horse | Club" dressage
// scorecards) print rank+bib glued to the leftmost column with no separate
// bib anchor. If the leftmost field starts with "<number> <restOfText>",
// split the number out as rank/bib rather than leaving it stuck to the
// athlete name.
function splitLeadingNumber(text) {
  if (!text) return { lead: null, rest: text };
  const m = text.match(/^(\d{1,4})[.,]?\s+(.*)$/);
  if (m) return { lead: m[1], rest: m[2] };
  return { lead: null, rest: text };
}

// Cleans a name-ish field (athlete/horse/club) reconstructed from
// column-assigned words. Two artifacts confirmed against real production
// output (CSIY-B Pattaya 2026, 2026-11-26):
//  - A stray leading "." or "," — the preceding RANK cell's own trailing
//    punctuation (e.g. "3." or "4,") sometimes lands just inside the next
//    column's X range and gets attached to the athlete text instead
//    (",Touku Rit Renanda", ".KyawWana").
//  - Two real words glued with no space at all — joinWordsGlued's "same
//    word" gap threshold is sometimes narrower than the true gap between
//    a first name and surname in this font ("HarizKAMALUDIN",
//    "LouieLACSON"). A lowercase-letter-immediately-followed-by-uppercase
//    transition essentially never happens inside one real word of a
//    name, so it's split. A genuinely intercapped surname (McDonald) is
//    rare enough, and every row here is needs_review anyway pending human
//    confirmation, that splitting is the safer default.
function cleanupNameField(text) {
  if (!text) return text;
  let cleaned = text.replace(/^[.,;:]+\s*/, '');
  cleaned = cleaned.replace(/([a-zก-๙])([A-Z])/g, '$1 $2');
  cleaned = cleaned.trim();
  return cleaned || null;
}

function buildEntryFromColumns(byRole, rest, discipline, sourceFile, pageNumber) {
  const entry = blankEntry();
  entry.source_file = sourceFile;
  entry.source_page = pageNumber;
  entry.discipline = discipline;

  let athleteRaw = byRole.ATHLETE || null;
  let rankRaw = byRole.RANK || null;
  let bibRaw = byRole.BIB || null;

  if (!rankRaw && athleteRaw) {
    const split = splitLeadingNumber(athleteRaw);
    if (split.lead) {
      rankRaw = split.lead;
      athleteRaw = split.rest;
    }
  }
  if (rankRaw && !bibRaw) {
    // "<rank> <bib>" sometimes lands together in the rank field when the
    // sheet has a Horses-No. column with no detected header anchor for it.
    const m = rankRaw.match(/^(\d{1,3})\s+(\d{2,5})$/);
    if (m) {
      rankRaw = m[1];
      bibRaw = m[2];
    }
  }

  const horseRaw = byRole.HORSE || null;
  const clubRaw = byRole.CLUB || null;

  entry.rank = toNumberOrNull(rankRaw);
  entry.bib = bibRaw ? String(bibRaw).trim() : null;
  entry.athlete = cleanupNameField(athleteRaw);
  entry.name_as_printed = entry.athlete;
  entry.horse = cleanupNameField(horseRaw);
  entry.club = cleanupNameField(clubRaw);
  entry.official_value.display = rest || null;

  const looksClean =
    (entry.rank !== null || entry.bib) &&
    entry.athlete && entry.athlete.length >= 2 &&
    entry.horse && entry.horse.length >= 2;
  entry.needs_review = !looksClean;

  applyDisciplineFields(entry, discipline, rest);
  return entry;
}

// Last-resort path for a page where no header row could be matched by
// keyword at all (seen with some real Thai sheets after OCR letter
// confusions, e.g. ลำดับ misread so no keyword matched). Falls back to pure
// position: first gap-separated cell is rank if it's a bare number, then the
// next few non-numeric cells are taken positionally as athlete/horse/club,
// and everything else is the display string. Always flagged needs_review
// since there's no header confirming the layout.
function parsePositionalRow(rowWords, discipline, sourceFile, pageNumber) {
  const cells = splitRowIntoCells(rowWords);
  if (cells.length < 3) return null;

  const entry = blankEntry();
  entry.source_file = sourceFile;
  entry.source_page = pageNumber;
  entry.discipline = discipline;
  entry.needs_review = true;

  let idx = 0;
  const rank = toNumberOrNull(cells[0].text);
  if (rank !== null && /^\d+\.?$/.test(cells[0].text.trim())) {
    entry.rank = rank;
    idx = 1;
  }
  // Optional bib: a short pure-numeric cell right after rank.
  if (cells[idx] && /^\d{1,6}$/.test(cells[idx].text.trim())) {
    entry.bib = cells[idx].text.trim();
    idx += 1;
  }
  const textCells = [];
  const restCells = [];
  for (let i = idx; i < cells.length; i++) {
    const isNumericish = /^[\d.:,\-\s]+$/.test(cells[i].text) || cells[i].text.length === 0;
    if (!isNumericish && textCells.length < 3) {
      textCells.push(cells[i].text);
    } else {
      restCells.push(cells[i].text);
    }
  }
  entry.athlete = cleanupNameField(textCells[0] || null);
  entry.name_as_printed = entry.athlete;
  entry.horse = cleanupNameField(textCells[1] || null);
  entry.club = cleanupNameField(textCells[2] || null);
  entry.official_value.display = restCells.join('  ') || null;

  if (!entry.athlete && !entry.horse) return null; // nothing usable at all
  applyDisciplineFields(entry, discipline, entry.official_value.display);
  return entry;
}

function parseGenericHeaderedPage(rows, header, discipline, sourceFile, pageNumber) {
  const cols = buildColumnBoundaries(header.anchors);
  const entries = [];
  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const { byRole, rest } = assignRowToColumns(row, cols);
    // Skip rows that are clearly not data (signature blocks, page-footer
    // timestamps, stray marks) — no athlete/horse/rank/rest content at all.
    const hasAnyContent = Object.values(byRole).some(Boolean) || rest;
    if (!hasAnyContent) continue;
    // Skip rows that landed no column-matched content at all (a page
    // footer timestamp, a generated-at stamp, a stray ID in the margin).
    // Confirmed against real production output (CSIY-B Pattaya 2026,
    // 2026-11-26): three such stray lines ("10049008", "28/2/2026.",
    // "28/2/2026 16:42") slipped through as fake entries because the old
    // check only skipped a row with NO digits anywhere in its leftover
    // text — a date or ID is all digits, so it wasn't skipped. A real
    // data row always has rank, bib, athlete or horse in a recognized
    // column; requiring one of those (rather than "any digit anywhere")
    // is what actually distinguishes a table row from page furniture.
    const hasNameish = byRole.ATHLETE || byRole.HORSE;
    const hasRankOrBib = byRole.RANK || byRole.BIB;
    if (!hasNameish && !hasRankOrBib) continue;
    entries.push(buildEntryFromColumns(byRole, rest, discipline, sourceFile, pageNumber));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// FEI-style endurance "Race Report (Full Result)" — one block of 4-ish rows
// per rider/horse (one row per loop), with rank/name/team merged across the
// whole block. See tableParser.js header comment / ocr.js for why this
// needs its own reconstruction instead of the generic header-anchor path.
// ---------------------------------------------------------------------------

// The FEI endurance race-report header wraps across several physical
// lines ("RIDER" / "NO." / "VET-IN" / "TAKEN" etc. each on their own row —
// confirmed against the real "KING'S CUP THAILAND ENDURANCE CHAMPIONSHIP"
// sheets). So, unlike findHeaderAnchors above, this accumulates keyword
// matches across every row in the scanned region rather than requiring
// them to co-occur on one row, and remembers the last row any header
// keyword was found on so body-row parsing starts after the whole
// multi-line header block, not partway through it.
function findEnduranceAnchors(rows, maxRowIndex) {
  const limit = Math.min(rows.length, Math.max(1, maxRowIndex));
  const anchors = {};
  let headerRowIndex = 0;
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const { text, spans } = reconstructRow(row);
    const lower = text.toLowerCase();
    const tryMatch = (role, kw) => {
      if (anchors[role]) return;
      const idx = lower.indexOf(kw);
      if (idx === -1) return;
      const endIdx = idx + kw.length;
      const covering = spans.filter((s) => s.start < endIdx && s.end > idx);
      if (covering.length) {
        anchors[role] = covering[0].word.cx;
        headerRowIndex = Math.max(headerRowIndex, i);
      }
    };
    tryMatch('RANK', 'rank');
    tryMatch('LOOP', 'loop');
    tryMatch('RIDERNO', 'rider');
    tryMatch('STATUS', 'status');
    tryMatch('SPEED', 'speed');
    if (lower.includes('riding') && lower.includes('time')) tryMatch('TOTALTIME', 'riding');
  }
  const score = Object.keys(anchors).length;
  if (score < 2 || !anchors.RIDERNO) return null;
  return { rowIndex: headerRowIndex, anchors };
}

function nearestCol(cx, colEntries) {
  let bestRole = null;
  let bestDist = Infinity;
  for (const [role, x] of colEntries) {
    const d = Math.abs(cx - x);
    if (d < bestDist) {
      bestDist = d;
      bestRole = role;
    }
  }
  return bestRole;
}

function parseEndurancePage(rows, header, sourceFile, pageNumber) {
  const colEntries = Object.entries(header.anchors);
  // Everything left of the RIDERNO anchor (or LOOP anchor if RIDERNO wasn't
  // found) is the merged "name of riders/horses/team" zone.
  const nameBoundary =
    header.anchors.RIDERNO != null ? header.anchors.RIDERNO : header.anchors.LOOP;

  const blocks = [];
  let current = null;

  for (let i = header.rowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.length) continue;
    const nameWords = nameBoundary != null ? row.filter((w) => w.cx < nameBoundary - 20) : [];
    const otherWords = nameBoundary != null ? row.filter((w) => w.cx >= nameBoundary - 20) : row;

    const nameText = reconstructRow(nameWords).text.trim();

    // Assign each "other" word to its nearest known column by X distance —
    // simpler and more forgiving here than hard boundaries, since this
    // table has many narrow numeric columns.
    const byRoleWords = {};
    for (const w of otherWords) {
      const role = nearestCol(w.cx, colEntries);
      if (!role) continue;
      (byRoleWords[role] = byRoleWords[role] || []).push(w);
    }
    const byRole = {};
    for (const [role, ws] of Object.entries(byRoleWords)) byRole[role] = joinWordsGlued(ws);

    const riderNoMatch = (byRole.RIDERNO || '').match(/\d{2,6}/);
    const riderNo = riderNoMatch ? riderNoMatch[0] : null;

    if (riderNo && (!current || current.riderNo !== riderNo)) {
      if (current) blocks.push(current);
      current = { riderNo, rankRaw: byRole.RANK || null, nameLines: [], latest: {} };
    }
    if (!current) {
      // No rider-number column detected yet on this row; skip rather than
      // guess a block boundary.
      continue;
    }
    if (nameText) current.nameLines.push(nameText);
    if (byRole.RANK && !current.rankRaw) current.rankRaw = byRole.RANK;
    if (byRole.TOTALTIME) current.latest.totalTime = byRole.TOTALTIME;
    if (byRole.SPEED) current.latest.speed = byRole.SPEED;
    if (byRole.STATUS) current.latest.status = byRole.STATUS;
  }
  if (current) blocks.push(current);

  return blocks.map((block) => {
    const entry = blankEntry();
    entry.source_file = sourceFile;
    entry.source_page = pageNumber;
    entry.discipline = 'Endurance';
    entry.bib = block.riderNo;
    entry.rank = toNumberOrNull(block.rankRaw);
    entry.athlete = block.nameLines[0] || null;
    entry.name_as_printed = entry.athlete;
    entry.horse = block.nameLines[1] || null;
    entry.club = block.nameLines[2] || null;
    const parts = [];
    if (block.latest.totalTime) parts.push(`Total riding time: ${block.latest.totalTime}`);
    if (block.latest.speed) parts.push(`Avg speed: ${block.latest.speed} km/h`);
    if (block.latest.status) parts.push(`Status: ${block.latest.status}`);
    entry.official_value.display = parts.join(' | ') || null;
    const vet = (block.latest.status || '').match(/\b(pass|fail|eliminated|el|rtd|wd)\b/i);
    entry.official_value.vet_gate_result = vet ? vet[1] : null;
    // Endurance's merged-cell, multi-row-per-rider layout (rank/name/team
    // wrapped across up to 4 physical loop-rows, with many tightly-packed
    // numeric columns) is inherently the hardest of the four to reconstruct
    // with full confidence — the bib/athlete/horse grouping is now correct,
    // but which exact value ends up in time/speed/status can still drift
    // from the true final-loop figures. Always flag for review rather than
    // claim certainty the geometry can't fully back up.
    entry.needs_review = true;
    return entry;
  });
}

// ---------------------------------------------------------------------------
// Per-page dispatch
// ---------------------------------------------------------------------------

function parseGeometryPage(page, discipline, sourceFile) {
  const words = toGeomWords(page.words);
  if (!words.length) return [];
  const rows = clusterRows(words);
  const scanLimit = Math.max(1, Math.ceil(rows.length * 0.6));

  const rowTexts = rows.slice(0, scanLimit).map((r) => reconstructRow(r).text);
  if (discipline === 'Endurance' || looksLikeEnduranceRaceReport(rowTexts)) {
    const enduranceHeader = findEnduranceAnchors(rows, scanLimit);
    if (enduranceHeader) {
      return parseEndurancePage(rows, enduranceHeader, sourceFile, page.pageNumber);
    }
    // Fell through — this page looked like it might be an endurance race
    // report (or was tagged Endurance) but didn't have a recognizable
    // "RIDER NO./LOOP" header (e.g. a "Best Condition" award certificate
    // page within the same PDF, or a plain leaderboard page instead of the
    // loop-by-loop report). Don't give up — try the generic ranked-table
    // path below before falling back further, since not every page in an
    // Endurance PDF is necessarily a loop report.
  }

  const header = findHeaderAnchors(rows, scanLimit);
  if (header) {
    console.log(
      '[TP_DEBUG_DRESSAGE] page', page.pageNumber,
      'discipline', discipline,
      'header FOUND rowIndex', header.rowIndex,
      'anchors', JSON.stringify(header.anchors)
    );
    return parseGenericHeaderedPage(rows, header, discipline, sourceFile, page.pageNumber);
  }

  // Temporary diagnostic: header anchor matching failed entirely, so this
  // page is about to fall through to the per-row positional fallback below.
  // Dump the first several clustered rows' raw text + each word's cx so we
  // can see exactly what Vision OCR returned for the header area and why
  // none of ROLE_KEYWORDS matched it, instead of guessing.
  console.log(
    '[TP_DEBUG_DRESSAGE] page', page.pageNumber,
    'discipline', discipline,
    'header NOT FOUND — first rows:',
    JSON.stringify(
      rows.slice(0, 15).map((r) => ({
        text: reconstructRow(r).text,
        words: r.map((w) => ({ t: w.text, cx: Math.round(w.cx), cy: Math.round(w.cy) })),
      }))
    )
  );

  // No header recognized at all (e.g. OCR mangled every header keyword, or
  // this page is a schedule/cover/signature page with no results table).
  // Try the positional fallback per row; a page that's genuinely not a
  // results table (a programme page, a certificate) will simply produce no
  // usable rows and contribute nothing, which is correct.
  const entries = [];
  for (const row of rows) {
    const e = parsePositionalRow(row, discipline, sourceFile, page.pageNumber);
    if (e) entries.push(e);
  }
  return entries;
}

/**
 * @param {Array<{pageNumber:number, text:string, words?:Array}>} pages
 * @param {string} discipline one of DISCIPLINES in schema.js
 * @param {string} sourceFile original PDF filename, for traceability
 * @returns {{entries: Array<object>, stats: {total:number, needsReview:number}}}
 */
function parseEntries(pages, discipline, sourceFile) {
  const entries = [];
  for (const page of pages) {
    if (Array.isArray(page.words) && page.words.length > 0) {
      entries.push(...parseGeometryPage(page, discipline, sourceFile));
    } else {
      entries.push(...parseLegacyPage(page, discipline, sourceFile));
    }
  }
  const needsReview = entries.filter((e) => e.needs_review).length;
  return { entries, stats: { total: entries.length, needsReview } };
}

module.exports = { parseEntries, splitColumns, toNumberOrNull };
