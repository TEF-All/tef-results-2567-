const { HttpsError } = require('firebase-functions/v2/https');
const { requireAdmin } = require('./auth');
const { extractText } = require('./ocr');
const { parseEntries } = require('./tableParser');
const { DRAFT_STATUS } = require('./schema');

/**
 * extractDraft(data: { draftId: string })
 *
 * Preconditions (set up by the admin UI before calling this):
 *   - Firestore doc drafts/{draftId} exists with { year, discipline,
 *     event_name, source_file, storage_path, status: 'uploaded' }
 *   - The PDF itself already sits in Storage at `storage_path`.
 *
 * Effect: reads the PDF, extracts text (text layer or Vision OCR), runs the
 * heuristic table parser, and writes `entries` + stats back onto the same
 * draft doc with status 'ready_for_review'. Never touches anything outside
 * Firestore/Storage — no GitHub write happens here (see publishYear.js).
 */
async function extractDraftHandler(data, context, { db, bucket, visionClient }) {
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

  if (!draft.storage_path) {
    throw new HttpsError('failed-precondition', 'draft นี้ยังไม่มีไฟล์ PDF ที่อัปโหลด');
  }

  await draftRef.update({ status: DRAFT_STATUS.PROCESSING, processing_started_at: new Date() });

  try {
    const [fileBuffer] = await bucket.file(draft.storage_path).download();
    const { source, pages } = await extractText(fileBuffer, visionClient);

    if (pages.length === 0) {
      await draftRef.update({
        status: DRAFT_STATUS.ERROR,
        error: 'อ่านข้อความจากไฟล์ไม่ได้เลย (ทั้ง text layer และ OCR ว่างเปล่า) — ตรวจสอบไฟล์ต้นฉบับ',
      });
      throw new HttpsError('internal', 'ไม่พบข้อความในเอกสาร ทั้ง text layer และ OCR ว่างเปล่า');
    }

    const { entries, stats } = parseEntries(pages, draft.discipline, draft.source_file);

    await draftRef.update({
      status: DRAFT_STATUS.READY_FOR_REVIEW,
      extraction_source: source, // 'text_layer' | 'vision_ocr' — shown in the admin UI for transparency
      entries,
      stats,
      processed_at: new Date(),
      error: null,
    });

    return {
      success: true,
      extractionSource: source,
      totalEntries: stats.total,
      needsReviewCount: stats.needsReview,
    };
  } catch (err) {
    await draftRef.update({ status: DRAFT_STATUS.ERROR, error: String(err.message || err) });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('internal', `การแกะข้อมูลล้มเหลว: ${err.message || err}`);
  }
}

module.exports = { extractDraftHandler };
