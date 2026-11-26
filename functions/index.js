/**
 * Cloud Functions entry point — TEF Admin Import System.
 *
 * Exposes exactly two callable (onCall) functions, matching
 * ADMIN_IMPORT_SYSTEM_ARCHITECTURE.md §2:
 *   - extractDraft : PDF -> OCR/text -> heuristic parse -> draft (Firestore only)
 *   - publishYear  : reviewed draft -> commit to the public GitHub repo
 *
 * Requires (see ../PHASE2_IMPLEMENTATION_NOTES.md for the full setup checklist
 * the project owner — not Claude — needs to do once per Firebase project):
 *   - Firebase Blaze (pay-as-you-go) billing plan enabled
 *   - Cloud Vision API enabled
 *   - A `GITHUB_TOKEN` secret set via `firebase functions:secrets:set GITHUB_TOKEN`
 *     (a fine-grained GitHub PAT scoped to Contents: read/write on
 *     TEF-All/tef-results-2567- only)
 */

const { onCall } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');

const { extractDraftHandler } = require('./src/extractDraft');
const { publishYearHandler } = require('./src/publishYear');

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();
const visionClient = new vision.ImageAnnotatorClient();

const githubTokenSecret = defineSecret('GITHUB_TOKEN');

// Keep cost predictable: cap concurrent instances, run in a region close to
// Thailand to reduce latency (asia-southeast1 = Singapore).
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 5 });

exports.extractDraft = onCall(
  { timeoutSeconds: 300, memory: '512MiB' },
  async (request) => extractDraftHandler(request.data, { auth: request.auth }, { db, bucket, visionClient })
);

exports.publishYear = onCall(
  // Bumped from 120s: publish now also downloads the original PDF from
  // Storage and uploads it to GitHub (see publishYear.js), one more
  // round-trip than before.
  { secrets: [githubTokenSecret], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => publishYearHandler(request.data, { auth: request.auth }, { db, bucket, githubTokenSecret })
);
