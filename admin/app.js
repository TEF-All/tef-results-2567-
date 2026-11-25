// TEF Admin Import System — frontend logic.
//
// Loaded as a module from index.html. Talks only to:
//   - Firebase Auth (Google sign-in)
//   - Firestore (admin_users allowlist check, drafts collection)
//   - Storage (PDF upload)
//   - Cloud Functions (extractDraft, publishYear — both callable)
// It never talks to GitHub directly; only the publishYear Cloud Function
// (running with a server-side secret) does that. See functions/src/.

// Pinned SDK version — bump deliberately, not silently, when upgrading.
const SDK_VERSION = '10.13.2';
const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const { initializeApp } = await import(`${base}/firebase-app.js`);
const {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} = await import(`${base}/firebase-auth.js`);
const {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy, limit,
  onSnapshot, updateDoc, serverTimestamp,
} = await import(`${base}/firebase-firestore.js`);
const { getStorage, ref, uploadBytes } = await import(`${base}/firebase-storage.js`);
const { getFunctions, httpsCallable } = await import(`${base}/firebase-functions.js`);

// Firebase Hosting serves this reserved endpoint with the current project's
// public web-app config automatically — nothing to hardcode here, and
// nothing secret in it either (it's a client identifier, not a credential).
const firebaseConfig = await fetch('/__/firebase/init.json').then((r) => r.json());
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'asia-southeast1'); // must match setGlobalOptions region in functions/index.js

const extractDraftFn = httpsCallable(functions, 'extractDraft');
const publishYearFn = httpsCallable(functions, 'publishYear');

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);
const viewSignedOut = $('viewSignedOut');
const viewNotAllowed = $('viewNotAllowed');
const viewMain = $('viewMain');
const userBox = $('userBox');

let currentUser = null;
let currentDraftId = null;
let currentDraftUnsub = null;
let draftListUnsub = null;

function showOnly(view) {
  [viewSignedOut, viewNotAllowed, viewMain].forEach((v) => (v.style.display = v === view ? 'block' : 'none'));
}

// ---- Auth ----
$('btnSignIn').addEventListener('click', () => signInWithPopup(auth, new GoogleAuthProvider()));
$('btnSignOut2').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    showOnly(viewSignedOut);
    userBox.innerHTML = '';
    return;
  }

  const adminSnap = await getDoc(doc(db, 'admin_users', user.uid));
  if (!adminSnap.exists() || adminSnap.data().allowed !== true) {
    $('uidDisplay').textContent = user.uid;
    showOnly(viewNotAllowed);
    return;
  }

  userBox.innerHTML = `<span>${user.displayName || user.email}</span><button id="btnSignOut" class="btn">ออกจากระบบ</button>`;
  $('btnSignOut').addEventListener('click', () => signOut(auth));
  showOnly(viewMain);
  watchDraftList();
});

// ---- Upload + scan ----
$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const year = $('fYear').value;
  const discipline = $('fDiscipline').value;
  const eventName = $('fEventName').value.trim();
  const eventDate = $('fEventDate').value || null;
  const file = $('fFile').files[0];
  if (!file) return;

  const btn = $('btnUpload');
  btn.disabled = true;
  const statusEl = $('uploadStatus');

  try {
    statusEl.textContent = 'กำลังสร้าง draft...';
    const draftId = crypto.randomUUID();
    const storagePath = `uploads/${draftId}/${file.name}`;

    await setDoc(doc(db, 'drafts', draftId), {
      year,
      discipline,
      event_name: eventName,
      event_date: eventDate,
      source_file: file.name,
      storage_path: storagePath,
      status: 'uploaded',
      created_by: currentUser.uid,
      created_at: serverTimestamp(),
      entries: [],
    });

    statusEl.textContent = 'กำลังอัปโหลดไฟล์ PDF...';
    await uploadBytes(ref(storage, storagePath), file, { contentType: 'application/pdf' });

    statusEl.textContent = 'กำลังสแกน/แกะข้อมูล (OCR) — อาจใช้เวลาถึง 1 นาทีสำหรับไฟล์ที่เป็นภาพสแกน...';
    const result = await extractDraftFn({ draftId });
    statusEl.textContent = `เสร็จแล้ว: พบ ${result.data.totalEntries} รายการ (ต้องตรวจทาน ${result.data.needsReviewCount} รายการ) — แหล่งที่มา: ${result.data.extractionSource === 'text_layer' ? 'text layer ของ PDF' : 'Vision OCR'}`;

    $('uploadForm').reset();
    openDraft(draftId);
  } catch (err) {
    statusEl.textContent = `เกิดข้อผิดพลาด: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- Draft list ----
function watchDraftList() {
  if (draftListUnsub) draftListUnsub();
  const q = query(collection(db, 'drafts'), orderBy('created_at', 'desc'), limit(30));
  draftListUnsub = onSnapshot(q, (snap) => {
    const list = $('draftList');
    list.innerHTML = '';
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const li = document.createElement('li');
      li.className = docSnap.id === currentDraftId ? 'active' : '';
      li.innerHTML = `<span>${escapeHtml(d.event_name || '(ไม่มีชื่อ)')} <span class="muted">· ${d.year} · ${d.discipline}</span></span>
        <span class="status-badge ${d.status}">${d.status}</span>`;
      li.addEventListener('click', () => openDraft(docSnap.id));
      list.appendChild(li);
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Review panel for one draft ----
function openDraft(draftId) {
  currentDraftId = draftId;
  if (currentDraftUnsub) currentDraftUnsub();

  $('reviewPanel').style.display = 'block';
  currentDraftUnsub = onSnapshot(doc(db, 'drafts', draftId), (snap) => {
    if (!snap.exists()) return;
    renderReview(draftId, snap.data());
  });
}

function renderReview(draftId, draft) {
  $('reviewTitle').textContent = `ตรวจทานผล: ${draft.event_name || '(ไม่มีชื่อ)'}`;
  $('reviewMeta').textContent =
    `ปี ${draft.year} · ${draft.discipline} · สถานะ: ${draft.status}` +
    (draft.extraction_source ? ` · แกะข้อมูลด้วย: ${draft.extraction_source === 'text_layer' ? 'text layer' : 'Vision OCR'}` : '') +
    (draft.error ? ` · ❌ ${draft.error}` : '');

  const entries = Array.isArray(draft.entries) ? draft.entries : [];
  const tbody = $('entriesBody');
  tbody.innerHTML = '';

  entries.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    if (entry.needs_review) tr.className = 'needs-review';
    tr.innerHTML = `
      <td class="warn-icon">${entry.needs_review ? '⚠' : ''}</td>
      <td><input type="number" data-field="rank" value="${entry.rank ?? ''}" /></td>
      <td><input type="text" data-field="bib" value="${escapeHtml(entry.bib ?? '')}" /></td>
      <td><input type="text" data-field="athlete" value="${escapeHtml(entry.athlete ?? '')}" /></td>
      <td><input type="text" data-field="horse" value="${escapeHtml(entry.horse ?? '')}" /></td>
      <td><input type="text" data-field="club" value="${escapeHtml(entry.club ?? '')}" /></td>
      <td><input type="text" data-field="display" value="${escapeHtml(entry.official_value?.display ?? '')}" /></td>
      <td style="text-align:center;"><input type="checkbox" data-field="reviewed" ${entry.needs_review ? '' : 'checked'} /></td>
    `;
    tr.dataset.index = idx;
    tbody.appendChild(tr);
  });

  const allReviewed = entries.length > 0 && entries.every((e) => !e.needs_review);
  $('btnConfirmImport').disabled = !allReviewed;
  $('btnConfirmImport').title = allReviewed ? '' : 'ยังมีรายการที่ต้องตรวจทานก่อน (⚠)';

  $('btnSaveEdits').onclick = () => saveEdits(draftId);
  $('btnRescan').onclick = () => rescan(draftId);
  $('btnConfirmImport').onclick = () => confirmImport(draftId);
}

function readEntriesFromTable() {
  const rows = [...$('entriesBody').querySelectorAll('tr')];
  return rows.map((tr) => {
    const get = (field) => tr.querySelector(`[data-field="${field}"]`);
    const reviewed = get('reviewed').checked;
    return {
      rank: get('rank').value ? Number(get('rank').value) : null,
      bib: get('bib').value || null,
      athlete: get('athlete').value || null,
      horse: get('horse').value || null,
      club: get('club').value || null,
      display: get('display').value || null,
      reviewed,
    };
  });
}

async function saveEdits(draftId) {
  const snap = await getDoc(doc(db, 'drafts', draftId));
  const draft = snap.data();
  const edits = readEntriesFromTable();
  const merged = draft.entries.map((entry, idx) => {
    const e = edits[idx];
    if (!e) return entry;
    return {
      ...entry,
      rank: e.rank,
      bib: e.bib,
      athlete: e.athlete,
      name_as_printed: entry.name_as_printed ?? e.athlete,
      horse: e.horse,
      club: e.club,
      official_value: { ...entry.official_value, display: e.display },
      needs_review: !e.reviewed,
      review_status: e.reviewed ? 'reviewed' : 'pending',
    };
  });
  await updateDoc(doc(db, 'drafts', draftId), { entries: merged });
}

async function rescan(draftId) {
  await extractDraftFn({ draftId });
}

async function confirmImport(draftId) {
  // Always save whatever is currently in the table first, so Confirm never
  // publishes stale/unsaved edits.
  await saveEdits(draftId);
  const btn = $('btnConfirmImport');
  btn.disabled = true;
  btn.textContent = 'กำลังเผยแพร่...';
  try {
    const result = await publishYearFn({ draftId });
    alert(`เผยแพร่สำเร็จ! ปี ${result.data.year}, item_id ${result.data.itemId}`);
  } catch (err) {
    alert(`เผยแพร่ไม่สำเร็จ: ${err.message || err}`);
  } finally {
    btn.textContent = '✅ Confirm Import';
  }
}
