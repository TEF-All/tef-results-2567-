# เฟส 2: ระบบ Admin Import System (Firebase) — สรุปสิ่งที่สร้างแล้ว

> ต่อจาก `ADMIN_IMPORT_SYSTEM_ARCHITECTURE.md` (เฟส 1 — ข้อเสนอเท่านั้น) — ไฟล์นี้คือสิ่งที่ **เขียนโค้ดจริงแล้ว** ในเฟส 2

## 1. การตัดสินใจที่ยืนยันแล้วก่อนเริ่มเขียนโค้ด

| ประเด็น | ผลการตัดสินใจ |
|---|---|
| OCR engine | **Google Cloud Vision API** (free tier 1,000 หน้า/เดือน) — ตามที่คุณเลือก |
| Backend | **Firebase** (Auth + Cloud Functions + Firestore + Storage) |
| Firebase project | **แนะนำให้สร้างใหม่แยกต่างหาก** จากโปรเจกต์ฐานข้อมูลสโมสร/นักกีฬาเดิม — ดูเหตุผลข้อ 2 |
| Billing (Blaze plan) | **ผมไม่ได้ทำขั้นตอนนี้ให้** — เป็นเรื่องการเงิน/บัตรของคุณ ต้องเปิดเองตอนพร้อม deploy จริง (ดูหัวข้อ 5) |

### เหตุผลที่แนะนำ Firebase project ใหม่แยกต่างหาก (ตอบคำถาม "แนะนำหน่อย เอาแบบฟรี")

ทั้งสองทาง **ฟรีเท่ากัน** — การสร้าง Firebase project ใหม่ไม่มีค่าใช้จ่ายใดๆ และเงื่อนไข Blaze plan (ต้องเปิด billing ถึงจะ deploy Cloud Functions ได้ แม้ใช้งานจริง 0 บาท) เกิดขึ้นเหมือนกันไม่ว่าจะเลือกใช้โปรเจกต์ไหน — **ไม่ใช่ปัจจัยที่ต้องเลือกจากเรื่องเงิน**

เหตุผลที่แนะนำ "สร้างใหม่แยกต่างหาก":
1. **แยก blast radius** — ถ้า Cloud Function หรือ security rules ของระบบ import นี้มีบั๊ก จะไม่กระทบระบบฐานข้อมูลสโมสร/นักกีฬาที่ใช้งานอยู่จริงเลย
2. **แยก quota/billing tracking** — ดูง่ายว่าใช้ Cloud Vision API ไปกี่หน้า/เดือน, Cloud Functions invoke กี่ครั้ง โดยไม่ปนกับการใช้งานของระบบอื่น
3. **แยกสิทธิ์ผู้ดูแล** — ถ้าในอนาคตอยากให้คนละกลุ่มดูแลแต่ละระบบ ทำได้ง่ายกว่าเพราะแยกโปรเจกต์กันตั้งแต่ต้น
4. ข้อเสียเดียวของการแยกคือ "ต้องตั้งค่าซ้ำอีกรอบ" (สร้าง project, เปิด API, ตั้ง Auth ฯลฯ) — ซึ่งเป็นงานทำครั้งเดียว ไม่ใช่ภาระต่อเนื่อง

ถ้าคุณอยากประหยัดเวลาตั้งค่ามากกว่าความปลอดภัยตรงนี้ ใช้โปรเจกต์เดิมก็ทำงานได้เหมือนกัน — โค้ดในเฟสนี้ไม่ได้ผูกกับ project ใดเป็นการเฉพาะ (`.firebaserc` เป็น placeholder ให้ใส่ project ID เองตอน deploy)

## 2. สิ่งที่เขียนโค้ดจริงแล้วในรอบนี้

```
functions/
  package.json              # deps: firebase-admin, firebase-functions, @google-cloud/vision, pdf-parse
  index.js                  # ประกาศ 2 callable functions: extractDraft, publishYear
  src/
    schema.js                # ค่าคงที่ (repo ปลายทาง, รายชื่อ discipline) + blankEntry() ตาม schema
    auth.js                  # requireAdmin() เช็ค allowlist จาก admin_users ทุกครั้งที่ฟังก์ชันถูกเรียก
    ocr.js                   # ลอง text layer ของ PDF ก่อน → ถ้าไม่พอค่อยเรียก Cloud Vision (batchAnnotateFiles)
    tableParser.js           # heuristic แยกแถวผลการแข่งขันเป็น entry ตาม schema (ดูข้อจำกัดหัวข้อ 6)
    githubPublish.js         # อ่าน/เขียนไฟล์ผ่าน GitHub Contents API, flip TEF_YEARS_CONFIG, แทรก <script> tag
    extractDraft.js          # handler: PDF → OCR → parse → เขียน draft ใน Firestore เท่านั้น (ไม่แตะ GitHub)
    publishYear.js           # handler: ปฏิเสธถ้ายังมี needs_review=true แม้แต่แถวเดียว → ถึงจะ commit ขึ้น GitHub

firestore.rules             # เฉพาะ uid ที่อยู่ใน admin_users และ allowed=true เท่านั้นที่อ่าน/เขียน drafts ได้
storage.rules                # เฉพาะ admin ที่ allowlist แล้วเท่านั้นที่อัปโหลด/อ่านไฟล์ใน uploads/ ได้ (จำกัด ≤25MB, ต้องเป็น PDF)
firebase.json                # ผูก Firestore/Storage rules + Cloud Functions (nodejs20) + Hosting (เสิร์ฟ admin/)
.firebaserc                  # placeholder — ต้องใส่ Firebase project ID ของคุณเองก่อน deploy
firestore.indexes.json       # ว่าง (ยังไม่ต้องใช้ composite index ในรอบนี้)

admin/
  index.html                 # หน้า Admin: login / not-authorized / main (upload + รายการ draft + ตารางตรวจทาน)
  style.css
  app.js                     # Firebase Auth (Google) + Firestore + Storage + เรียก callable functions
```

**ไม่แตะเลย** (ยืนยันแล้ว): `tef_master_data.json`, `tef_master_data.js`, และโครง public site ทั้งหมด (`index.html`/`tef_results_webapp.html` จะถูกแก้โดย `publishYear` อัตโนมัติ **เฉพาะตอนเผยแพร่ปีใหม่จริง** เท่านั้น ไม่ใช่ตอนนี้)

## 3. หลักการด้านความปลอดภัยที่บังคับใช้จริงในโค้ด (ไม่ใช่แค่คำสัญญาในเอกสาร)

- **Human review ก่อนเผยแพร่เสมอ**: `publishYear` เช็คทุกแถวใน `entries[]` — ถ้ามีแถวไหน `needs_review === true` แม้แต่แถวเดียว ฟังก์ชันจะ**ปฏิเสธและไม่เขียนอะไรขึ้น GitHub เลย** (ดู `functions/src/publishYear.js` บรรทัดเช็ค `stillNeedsReview`)
- **Allowlist เช็คซ้ำ 2 ชั้น**: ทั้ง Firestore/Storage rules (ฝั่ง client เขียนตรงไม่ได้ถ้าไม่ผ่าน) และใน Cloud Function เอง (`requireAdmin()`) — เพราะ Cloud Function รันด้วยสิทธิ์ admin SDK ซึ่งไม่ถูกจำกัดโดย rules
- **GitHub token ไม่เคยอยู่ฝั่ง frontend**: เก็บเป็น Cloud Functions secret (`GITHUB_TOKEN`) อ่านได้เฉพาะใน `publishYear` ที่รันบนเซิร์ฟเวอร์เท่านั้น
- **`extractDraft` ไม่แตะ GitHub เลย** — เขียนแค่ Firestore ตามที่ architecture เฟส 1 กำหนดไว้

## 4. สิ่งที่ตรวจสอบแล้วจริง (ก่อนรายงานว่าเสร็จ)

สิ่งที่ **ทำได้จริง** ในรอบนี้ (ไม่มี Firebase project จริงให้ deploy — ยังไม่ได้สร้าง):

| รายการตรวจสอบ | ผล |
|---|---|
| Syntax ของทุกไฟล์ `.js` ใน `functions/` (`node --check`) | ✅ ผ่านทั้ง 8 ไฟล์ |
| `npm install` ใน `functions/` ไม่มี error, resolve dependency ได้ครบ | ✅ ผ่าน |
| `tableParser.js` แยกแถวผลตัวอย่าง (Jumping, ข้อมูลสมมติ) ออกมาถูกต้องตามคอลัมน์ | ✅ ผ่าน (ดูตัวอย่างด้านล่าง) |
| `githubPublish.js` — `flipYearStatus` + `ensureDataScriptTag` รันกับ `index.html` **ของจริงในระบบ** | ✅ ผ่าน: แทรก `<script>` ถูกจุด, idempotent (รันซ้ำไม่ซ้ำ tag), flip เฉพาะปีที่ระบุ, ปี 2567/2569 ไม่ถูกแตะ |
| `admin/app.js` syntax (ตรวจเป็น ES module) | ✅ ผ่าน |
| Deploy จริงขึ้น Firebase (functions, rules, hosting) | ❌ **ยังไม่ได้ทำ** — ไม่มี Firebase project ให้ deploy ใส่ (ต้องรอคุณตั้งค่าตามหัวข้อ 5) |
| ทดสอบกับไฟล์ PDF ผลการแข่งขันจริง (scanned) | ❌ **ยังไม่ได้ทำ** — ตามกติกาเฟสนี้ที่ห้ามใช้ข้อมูลจริง/ตัวอย่างปลอมปนรอบนี้ |

ตัวอย่างผลการแยกข้อมูล (จากข้อความสมมติ ไม่ใช่ไฟล์จริง):
```
input:  "1   162  Somchai Jaidee  Thunder   Bangkok RC  83.78s (0 faults)"
output: { rank:1, bib:"162", athlete:"Somchai Jaidee", horse:"Thunder",
          club:"Bangkok RC", official_value:{ time_seconds:83.78, faults:0 },
          needs_review:false }
```

## 5. สิ่งที่คุณต้องทำเอง (ผมจะไม่ทำให้ — เรื่องการเงิน/บัญชีของคุณโดยตรง)

ทำตามลำดับนี้ตอนพร้อม deploy จริง:

1. **สร้าง Firebase project ใหม่** ที่ https://console.firebase.google.com (ฟรี, ไม่มีขั้นตอนไหนเกี่ยวกับบัตร)
2. ใส่ Project ID ที่ได้ลงใน `.firebaserc` แทน `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID`
3. ในหน้า Console: เปิดใช้งาน **Authentication → Sign-in method → Google**
4. **เปิด Blaze plan (pay-as-you-go)** — จำเป็นสำหรับ Cloud Functions (2nd gen) แม้ใช้งานในโควตาฟรี 0 บาทก็ตาม — ขั้นตอนนี้ต้องผูกบัตรของคุณเอง ผมจะไม่ทำให้
5. เปิดใช้งาน **Cloud Vision API** ใน Google Cloud Console (โปรเจกต์เดียวกับ Firebase)
6. สร้าง **GitHub Personal Access Token** แบบ fine-grained จำกัดสิทธิ์เฉพาะ repo `TEF-All/tef-results-2567-` scope `Contents: Read and write` แล้วตั้งเป็น secret:
   ```
   firebase functions:secrets:set GITHUB_TOKEN
   ```
7. ติดตั้ง Firebase CLI (`npm install -g firebase-tools`) แล้ว `firebase login`, `firebase use <project-id>`
8. Deploy:
   ```
   cd functions && npm install && cd ..
   firebase deploy --only functions,firestore:rules,storage:rules,hosting
   ```
9. เข้าหน้า Admin ที่ `https://<project-id>.web.app` → เข้าสู่ระบบด้วย Google ครั้งแรก (จะขึ้น "ยังไม่ได้รับสิทธิ์" พร้อมแสดง UID)
10. ไปที่ Firestore Console → สร้าง document `admin_users/{UID ที่ได้}` → ใส่ `{ allowed: true, name: "ชื่อผู้ดูแล" }`
11. รีเฟรชหน้า Admin — ควรเข้าใช้งานได้แล้ว

## 6. ข้อจำกัดที่ต้องรู้ก่อนใช้งานจริง (พูดตรงๆ ไม่ปิดบัง)

- **`tableParser.js` เป็น heuristic รุ่นแรก ยังไม่เคยทดสอบกับไฟล์สแกนจริงของ TEF** — เพราะรอบนี้ไม่มีไฟล์จริงให้ทดสอบ (ตามกติกาที่ห้ามใช้ข้อมูลจริง/ตัวอย่างปลอมรอบนี้) แพทเทิร์น regex ที่ใช้ (แยกคอลัมน์ด้วยช่องว่าง, หาเวลา/เปอร์เซ็นต์/โทษด้วย regex ต่อ discipline) เป็นการเดาอย่างมีเหตุผลจากโครงสร้างข้อมูลที่เห็นใน `tef_master_data.json` เดิม **ไม่ใช่การรับประกันว่าจะอ่านไฟล์จริงถูกต้อง** — คาดว่าต้องปรับ regex เพิ่มเมื่อเจอไฟล์จริงชุดแรก (เป็นเรื่องปกติของงาน OCR ลักษณะนี้ ไม่ใช่บั๊ก)
- เพราะเหตุนี้ ทุกแถวที่ parser ไม่มั่นใจ (คอลัมน์ไม่ครบ, อันดับ/ชื่อนักกีฬาดูไม่สมเหตุสมผล) จะถูกตั้ง `needs_review: true` โดยอัตโนมัติ และ **ระบบปฏิเสธการเผยแพร่จนกว่าแอดมินจะแก้ให้ครบ** — เป็นกลไกป้องกันไม่ให้ข้อมูลผิดหลุดขึ้นเว็บจริง
- Admin UI ตอนนี้รองรับแก้ไขทีละแถวผ่านตารางได้ (rank/bib/athlete/horse/club/ผลลัพธ์ที่แสดง) แต่ยังไม่มีปุ่ม "เพิ่มแถวใหม่" หรือ "ลบแถว" — ถ้า OCR อ่านเกิน/ขาดแถว ตอนนี้ต้องแก้โดยลบ draft แล้วอัปโหลดใหม่ (ปรับปรุงได้ภายหลังถ้าพบว่าจำเป็นจริง)
- Admin hosting (`admin/`) เสิร์ฟจาก Firebase Hosting default site — ยังไม่ได้ตั้ง custom domain หรือจำกัด IP ใดๆ เพิ่มเติม (การป้องกันหลักคือ Google sign-in + allowlist ไม่ใช่ network-level)
- ยังไม่มี automated test suite (unit tests) — มีแค่ smoke test แบบ manual ตามหัวข้อ 4

## 7. ขั้นต่อไปที่แนะนำ (ไม่ได้ทำเองตอนนี้ รอคุณสั่ง)

- ทำตามหัวข้อ 5 เพื่อ deploy ขึ้น Firebase project จริง
- เมื่อมีไฟล์ผลการแข่งขันจริงไฟล์แรก (สแกนหรือ PDF จาก Word/Excel) ลองอัปโหลดผ่าน Admin UI แล้วดูว่า `tableParser.js` อ่านได้แม่นแค่ไหน — ผมพร้อมปรับ regex ให้ตรงกับรูปแบบไฟล์จริงหลังเห็นตัวอย่างจริงอย่างน้อย 1 ไฟล์
