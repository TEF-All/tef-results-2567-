const { HttpsError } = require('firebase-functions/v2/https');
const { requireAdmin } = require('./auth');
const { publishYearToGithub, getFile } = require('./githubPublish');
const { DRAFT_STATUS } = require('./schema');

/**
 * publishYear(data: { draftId: string })
 *
 * This is the ONLY function that ever writes to the public GitHub repo, and
 * it refuses to run unless every entry in the draft has already been
 * reviewed (needs_review === false). That is the "OCR output must always go
 * through human review before being saved/published — never auto-save" rule
 * from the project brief, enforced in code rather than just by convention.
 *
 * Steps:
 *   1. Load the draft, verify status + review-completeness.
 *   2. Fetch the year's existing tef_master_data_<year>.json from GitHub (if
 *      any) to find the next free item_id — never overwrite other events
 *      already published for that year.
 *   3. Append this draft as one new `events[]` entry, write the per-year
 *      .json/.js files, flip TEF_YEARS_CONFIG status, commit.
 *   4. Mark the draft 'published' with the commit shas, for traceability.
 */
async function publishYearHandler(data, context, { db, githubTokenSecret }) {
  await requireAdmin(db, context);

  const { draftId } = data || {};
  if (!draftId || typeof draftId !== 'string') {
    throw new HttpsError('invalid-argument', 'ต้องระบุ draftId');
  }

  const draftRef = db.collection('drafts').doc(draftId);
  const draftSnap = await draftRef.get();
  if (!draftSnap.exists) {
    throw new HttpsError('not-found', `ไม่พบ draft ${draftId}`);
  }
  const draft = draftSnap.data();

  if (draft.status === DRAFT_STATUS.PUBLISHED) {
    throw new HttpsError('failed-precondition', 'draft นี้เผยแพร่ไปแล้ว');
  }
  if (!Array.isArray(draft.entries) || draft.entries.length === 0) {
    throw new HttpsError('failed-precondition', 'draft นี้ยังไม่มีรายการผลการแข่งขัน (entries ว่าง)');
  }
  const stillNeedsReview = draft.entries.filter((e) => e.needs_review === true);
  if (stillNeedsReview.length > 0) {
    throw new HttpsError(
      'failed-precondition',
      `ยังมี ${stillNeedsReview.length} รายการที่ต้องตรวจทานก่อน (needs_review=true) — แก้ไขให้ครบก่อนกด Confirm Import`
    );
  }

  const token = githubTokenSecret.value();
  if (!token) {
    throw new HttpsError(
      'failed-precondition',
      'ยังไม่ได้ตั้งค่า GITHUB_TOKEN secret — ดู PHASE2_IMPLEMENTATION_NOTES.md หัวข้อการตั้งค่า'
    );
  }

  const year = String(draft.year);
  const jsonPath = `tef_master_data_${year}.json`;

  // Anything from here down that touches GitHub can throw a plain Error (see
  // githubPublish.js) — Cloud Functions callable hides a plain Error's real
  // message from the client and returns just "INTERNAL", so we must
  // re-throw as an HttpsError to actually surface what went wrong in the
  // admin UI's alert() instead of a useless generic code name.
  let existing;
  try {
    existing = await getFile(token, jsonPath);
  } catch (err) {
    throw new HttpsError('internal', `เผยแพร่ไม่สำเร็จ: ${err.message}`);
  }
  const existingData = existing ? JSON.parse(existing.content) : { summary: { total_items: 0, total_entries: 0 }, events: [] };

  const nextItemId = (existingData.events || []).reduce((max, e) => Math.max(max, e.item_id || 0), 0) + 1;

  const newEvent = {
    item_id: nextItemId,
    name: draft.event_name,
    source_file: draft.source_file,
    pdf_files: draft.source_file ? [draft.source_file] : [],
    preview_images: [],
    classes: [
      {
        class_name: draft.event_name,
        discipline: draft.discipline,
        date: draft.event_date || null,
        page_number: 1,
        preview_image: null,
        entries: draft.entries,
      },
    ],
  };

  const events = [...(existingData.events || []), newEvent];
  const summary = {
    total_items: events.length,
    total_entries: events.reduce(
      (sum, e) => sum + e.classes.reduce((s2, c) => s2 + (c.entries || []).length, 0),
      0
    ),
  };

  let commits;
  try {
    ({ commits } = await publishYearToGithub(token, {
      year,
      summary,
      events,
      commitMessageSuffix: `draft ${draftId}: ${draft.event_name}`,
    }));
  } catch (err) {
    throw new HttpsError('internal', `เผยแพร่ไม่สำเร็จ: ${err.message}`);
  }

  await draftRef.update({
    status: DRAFT_STATUS.PUBLISHED,
    published_at: new Date(),
    published_item_id: nextItemId,
    github_commits: commits,
  });

  return { success: true, year, itemId: nextItemId, commits };
}

module.exports = { publishYearHandler };
