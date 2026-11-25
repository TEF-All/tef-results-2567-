/**
 * Heuristic table parser — turns raw page text (from either the PDF's own
 * text layer or Vision OCR) into draft `entry` rows matching the schema in
 * FUTURE_YEAR_DATA_SCHEMA.md §3.
 *
 * HONEST LIMITATION (do not remove this comment): this is a first-pass,
 * regex-based heuristic. It has not been run against a real scanned TEF
 * result sheet yet (none were supplied this round, by design — see the
 * project's "no real/placeholder data this round" rule). It WILL need
 * tuning once real PDFs are fed through it. That is exactly why every row
 * defaults to needs_review: true unless it cleanly matches an expected
 * pattern, and why publishYear refuses to publish while any row still has
 * needs_review === true — a human always confirms before anything reaches
 * the public site.
 */

const { blankEntry } = require('./schema');

// A results row almost always starts with a rank or bib number. We split on
// runs of 2+ spaces (common in PDF-extracted/OCR text where columns were
// spaced apart) and fall back to single spaces if that produces too few
// columns to be plausible.
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

// Generic row shape shared by all four disciplines for the fields the
// existing webapp already renders (rank/bib/athlete/horse/club/score_display).
// Discipline-specific official_value fields are layered on top below.
function parseGenericRow(columns, discipline, sourceFile, pageNumber) {
  const entry = blankEntry();
  entry.source_file = sourceFile;
  entry.source_page = pageNumber;
  entry.discipline = discipline;

  // Expect something like: [rank, bib, athlete, horse, club, ...scoreCols]
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

  // A plausible row has a numeric rank and non-empty athlete/horse text.
  // Anything softer than that gets flagged for human review rather than
  // silently accepted.
  const looksClean =
    rank !== null && athleteRaw && athleteRaw.length >= 2 && horseRaw && horseRaw.length >= 2;
  entry.needs_review = !looksClean;

  applyDisciplineFields(entry, discipline, rest);
  return entry;
}

function applyDisciplineFields(entry, discipline, restColumns) {
  const joined = restColumns.join(' ');

  switch (discipline) {
    case 'Jumping': {
      // Typical print: "83.78s (0 faults)" or "83.78 0" or with jump-off "72.10/0"
      const timeMatch = joined.match(/(\d+\.?\d*)\s*s?/);
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
      const pct = joined.match(/(\d{1,3}\.\d{1,2})\s*%/);
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
      // Unknown discipline string from the UI — keep display only, flag it.
      entry.needs_review = true;
  }
}

/**
 * @param {Array<{pageNumber:number, text:string}>} pages
 * @param {string} discipline one of DISCIPLINES in schema.js
 * @param {string} sourceFile original PDF filename, for traceability
 * @returns {{entries: Array<object>, stats: {total:number, needsReview:number}}}
 */
function parseEntries(pages, discipline, sourceFile) {
  const entries = [];

  for (const page of pages) {
    const lines = page.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      // Skip obvious header/footer noise: lines with no leading digit at all
      // are very unlikely to be a results row (rank or bib always leads).
      if (!/^\d/.test(line)) continue;
      // Skip lines that are just a page number or a lone number (headers like "Page 2").
      if (/^\d+\s*$/.test(line)) continue;

      const columns = splitColumns(line);
      const entry = parseGenericRow(columns, discipline, sourceFile, page.pageNumber);
      entries.push(entry);
    }
  }

  const needsReview = entries.filter((e) => e.needs_review).length;
  return { entries, stats: { total: entries.length, needsReview } };
}

module.exports = { parseEntries, splitColumns, toNumberOrNull };
