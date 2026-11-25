# เฟส 1: วิเคราะห์ระบบเดิม + ข้อเสนอ Architecture สำหรับ Admin Import System

> สถานะ: เอกสารข้อเสนอเท่านั้น — **ยังไม่มีการเขียนโค้ดระบบ OCR/Admin ใดๆ ในรอบนี้** ตามที่ตกลงกันว่าเฟส 1 ทำแค่วิเคราะห์ + เสนอแนว + ระบุไฟล์ที่จะต้องแก้/เพิ่ม

## 1. สิ่งที่ตรวจสอบจากโค้ดจริง (ไม่ได้เดา)

โครงสร้างข้อมูลปี 2567 ปัจจุบัน (`tef_master_data.json` / `.js`) ที่หน้าเว็บ `index.html` อ่านจริง:

```jsonc
{
  "summary": { "total_items": 29, "total_entries": 2450, "year_be": 2567 },
  "events": [
    {
      "item_id": 1,
      "name": "ชื่อรายการแข่งขัน",
      "source_file": "...", "pdf_files": [...], "preview_images": [...],
      "classes": [
        {
          "class_name": "...", "discipline": "Jumping|Dressage|Eventing|Endurance",
          "date": "...", "page_number": 1, "preview_image": "...",
          "entries": [
            { "rank": 1, "bib": "162", "athlete": "...", "horse": "...", "club": "...",
              "discipline": "...", "r1_score": "...", "jo_score": "...",
              "score_display": "...", "status": null, "raw_details": {...} }
          ]
        }
      ]
    }
  ]
}
```

ระบบเว็บ (`index.html`) โหลดข้อมูลผ่าน `<script src="tef_master_data.js">` → `window.TEF_DATA` เท่านั้น **ไม่มี fetch() เลย** — เป็น static site ล้วนๆ บน GitHub Pages ไม่มี backend

**จากงานเฟสก่อนหน้า (push แล้วจริงที่ commit `3601801`)** ระบบรองรับหลายปีไว้แล้วผ่าน `window.TEF_YEARS_CONFIG` + `window.TEF_DATA_BY_YEAR['<year>']` — **นี่คือจุดที่ Admin Import System รอบนี้จะต่อเข้าได้พอดี** โดยไม่ต้องแก้โครง public site เพิ่มเลย (ดูข้อ 4)

## 2. สถาปัตยกรรมที่เสนอ (ตามที่คุณเลือก: Firebase)

```
┌─────────────────────────────┐        ┌──────────────────────────────────────┐
│  Public Website (เดิม)        │        │  Admin Import System (ใหม่)            │
│  GitHub Pages — อ่านอย่างเดียว  │ ◄────  │  Firebase Hosting + Auth + Functions   │
│  ไม่มี backend, ไม่มี token      │  publish │  + Firestore + Storage                │
└─────────────────────────────┘        └──────────────────────────────────────┘
```

- **Firebase Authentication** — จำกัดเฉพาะ UID ที่อยู่ใน allowlist (เก็บใน Firestore collection `admin_users`) ป้องกันคนนอกเข้าหน้า import
- **Firebase Storage** — เก็บไฟล์ PDF ที่แอดมินอัปโหลด
- **Firestore** — เก็บ "draft" ที่ยังไม่ confirm:
  - `drafts/{draftId}`: `{ year, discipline, event_name, source_file, status: "processing"|"ready_for_review"|"confirmed", confidence, entries: [...same schema as FUTURE_YEAR_DATA_SCHEMA.md...] }`
  - `admin_users/{uid}`: `{ allowed: true, name }`
- **Cloud Functions** (2 ตัวหลัก):
  1. `extractDraft` — รับ PDF จาก Storage → เช็คว่ามี text layer หรือเป็นภาพสแกน → ถ้ามี text layer ดึงตรงๆ, ถ้าเป็นภาพสแกนค่อยส่งเข้า OCR → พยายามแยกตาราง (rank/bib/athlete/horse/club/score) ตาม schema → เขียนผลเป็น draft ใน Firestore (`status: "ready_for_review"`) พร้อม flag `needs_review` ในช่องที่มั่นใจต่ำ **ไม่แตะ `tef_master_data*.json` เลยในขั้นนี้**
  2. `publishYear` — ทำงานเมื่อแอดมินกด **Confirm Import** หลังตรวจ/แก้ไข draft แล้วเท่านั้น → รวม entries ที่ confirm แล้วเข้ากับไฟล์ของปีนั้น → gen `tef_master_data_<year>.js` (namespace `window.TEF_DATA_BY_YEAR['<year>']`) → ใช้ GitHub token ที่เก็บเป็น **Cloud Functions secret** (ไม่อยู่ใน frontend เด็ดขาด) ยิง GitHub API commit ไฟล์เข้า repo + พลิกสถานะปีนั้นใน `TEF_YEARS_CONFIG` จาก `coming_soon` → `available` → GitHub Pages build ใหม่อัตโนมัติ

ข้อดี: **public site เดิมไม่ต้องแก้โค้ดเพิ่มเลย** เพราะ mechanism "เพิ่มปีใหม่" ที่ผมเตรียมไว้แล้วถูกออกแบบมาให้ automation ฝั่งนี้เรียกใช้ได้พอดี

## 3. ประเด็นที่ต้องตัดสินใจก่อนเริ่มเขียนโค้ดจริง (เฟส 2)

| ประเด็น | ตัวเลือก | หมายเหตุ |
|---|---|---|
| **OCR engine** | (ก) Tesseract (โอเพนซอร์ส ฟรี 100%) <br>(ข) Google Cloud Vision API (แม่นกว่ามากกับตารางผสมไทย/อังกฤษ มี free tier 1,000 หน้า/เดือน) | จากประสบการณ์แกะข้อมูลเองในโปรเจกต์นี้ ตารางมีคอลัมน์ซ้อนซับซ้อน (เช่น Eventing 3 เฟส) ความแม่นยำของ Tesseract กับเอกสารแบบนี้น่าจะต่ำ ต้องแก้มือเยอะ — แต่เป็นของฟรีจริง ไม่มีเงื่อนไขอื่น |
| **Cloud Functions ต้องเปิด Blaze plan** | Firebase กำหนดให้ Cloud Functions (2nd gen) ต้อง enable บัตร/billing บนโปรเจกต์ก่อนถึงจะ deploy ได้ แม้ค่าใช้งานจริงจะเป็น 0 บาทถ้าอยู่ในโควตาฟรี | **ผมจะไม่ทำขั้นตอนนี้ให้เอง** เพราะเป็นเรื่องการเงิน/บัตรของคุณโดยตรง (เป็นกฎที่ยึดไว้) — คุณต้องเปิด Blaze plan เองในภายหลัง ถ้าจะใช้แนวทางนี้ |
| **ใช้ Firebase project เดิมหรือสร้างใหม่** | เจอในบันทึกว่ามีโปรเจกต์ Firebase สำหรับฐานข้อมูลสโมสร/นักกีฬาอยู่แล้ว | ควรใช้โปรเจกต์เดียวกันหรือแยก — รอคุณตัดสินใจ |

## 4. รายชื่อไฟล์ที่คาดว่าจะต้องเพิ่ม/แก้ในเฟส 2 (ยังไม่ได้ทำ)

**เพิ่มใหม่ (ไม่กระทบของเดิม):**
- `admin/` — เว็บแอดมิน (หน้า login, upload, ตาราง review ตาม mockup ที่คุณส่งมา)
- `functions/` — Cloud Functions source (`extractDraft`, `publishYear`)
- `firestore.rules`, `storage.rules` — security rules (กันไม่ให้คนนอก Admin อ่าน/เขียน draft)
- `firebase.json`, `.firebaserc` — Firebase project config

**แก้ไขเล็กน้อย (โดย `publishYear` อัตโนมัติ ไม่ใช่แก้มือ):**
- `index.html` / `tef_results_webapp.html` — แก้แค่ 1 บรรทัดใน `TEF_YEARS_CONFIG` ต่อปีที่ publish (เครื่องจักรที่เตรียมไว้แล้วจากเฟสก่อน)

**ไม่แตะเลย:**
- `tef_master_data.json` / `.js` (ข้อมูลปี 2567)
- โครง public site ทั้งหมด

## 5. ขอบเขตที่ยังไม่รวมในเฟสนี้
- ยังไม่ได้เลือก OCR engine จริง, ยังไม่ได้สร้าง Firebase project/Functions ใดๆ
- ยังไม่ได้ออกแบบหน้า UI ของ Admin Import ในระดับโค้ด (มีแค่โครงจากที่คุณ mockup ไว้)
- ยังไม่ได้ตัดสินใจเรื่อง Blaze plan / OCR engine — รอคุณเลือกก่อนเริ่มเฟส 2
