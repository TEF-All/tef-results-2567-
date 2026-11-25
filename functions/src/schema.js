/**
 * Shared constants + helpers for the TEF Admin Import System.
 * Keep this the single source of truth for GitHub repo location and
 * discipline list so the rest of the functions never hardcode them twice.
 */

// Fixed target repo for publishYear — this project only ever publishes to
// the one public results site, so this is intentionally not configurable
// per-request (avoids a compromised/buggy admin client pushing elsewhere).
const GITHUB_OWNER = 'TEF-All';
const GITHUB_REPO = 'tef-results-2567-';
const GITHUB_BRANCH = 'main';

const DISCIPLINES = ['Jumping', 'Dressage', 'Eventing', 'Endurance'];

const DRAFT_STATUS = {
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  READY_FOR_REVIEW: 'ready_for_review',
  REVIEWED: 'reviewed', // admin has fixed every needs_review row and clicked "Confirm Import"
  PUBLISHED: 'published',
  ERROR: 'error',
};

// Empty-entry template matching FUTURE_YEAR_DATA_SCHEMA.md section 3.
// extractDraft fills what it can read; everything else stays null, never guessed.
function blankEntry() {
  return {
    rank: null,
    bib: null,
    athlete: null,
    name_as_printed: null,
    horse: null,
    club: null,
    discipline: null,
    status: null,
    official_value: {
      display: null,
      time_seconds: null,
      faults: null,
      jump_off_time_seconds: null,
      jump_off_faults: null,
      technical_percent: null,
      collective_percent: null,
      total_percent: null,
      dressage_penalty: null,
      jumping_penalty: null,
      xc_penalty: null,
      loop_times: null,
      vet_gate_result: null,
    },
    calculated_value: {
      computed_total_penalty: null,
      note: 'ค่าในกลุ่มนี้ใช้เพื่อ cross-check เท่านั้น ห้ามถือเป็นผลรับรองแทนค่าที่พิมพ์ในเอกสาร',
    },
    source_file: null,
    source_page: null,
    needs_review: true, // default true until a parser is confident enough to clear it
    review_status: 'pending',
  };
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  DISCIPLINES,
  DRAFT_STATUS,
  blankEntry,
};
