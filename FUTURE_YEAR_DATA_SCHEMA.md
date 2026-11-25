# Schema สำหรับข้อมูลปี พ.ศ. 2568 / 2569 (และปีถัดๆ ไป)

> ไฟล์นี้เป็นเอกสารอ้างอิง/ตัวอย่างโครงสร้างเท่านั้น **ไม่มีข้อมูลผลการแข่งขันจริงหรือข้อมูลจำลองที่ปะปนกับของจริง**
> ตัวอย่างด้านล่างทั้งหมดเป็น "สมมติ" (fictional / schema-only) สำหรับให้คนที่จะนำเข้าข้อมูลจริงในอนาคตทำตามโครงสร้างนี้

## 1. หลักการที่ยึดตาม (สืบทอดจาก TEF_RESULTS_HANDOFF.md / README เดิม)

- แยกข้อมูลตาม **year → event (item) → class → entry** เสมอ
- `null` = ไม่มีข้อมูล/อ่านไม่ออกจากต้นฉบับ ≠ `0` ซึ่งหมายถึงค่าจริงที่เป็นศูนย์
- ทุก entry ต้องตามรอยกลับไปยังต้นฉบับได้: `source_file` + `page_number`
- ค่าที่อ่านไม่ชัดเจนต้องตั้ง `needs_review: true` ห้ามเดาเป็นตัวเลข
- คะแนน/อันดับที่ระบบคำนวณเอง (ถ้ามี) ต้องแยกจากค่าที่พิมพ์ในเอกสารต้นฉบับ ไม่ถือเป็นค่ารับรอง
- schema ต้องรองรับ 4 ประเภทกีฬาหลัก: **Jumping, Dressage, Eventing, Endurance** ซึ่งมีรูปแบบตารางคะแนนต่างกัน (ดูหัวข้อ 3)

## 2. โครงสร้างไฟล์ต่อปี (คงรูปแบบเดิมของปี 2567 ไว้ 100%)

ระบบปัจจุบัน (`tef_master_data.json` / `.js`) ใช้โครงสร้างนี้สำหรับปี 2567 อยู่แล้ว — ปีใหม่ใช้ **รูปแบบเดียวกันทุกประการ** เพื่อให้ `index.html` อ่านได้โดยไม่ต้องแก้โค้ดเพิ่ม:

```jsonc
{
  "summary": {
    "year_be": 2568,          // ปี พ.ศ. ของไฟล์นี้
    "total_items": 0,          // จำนวนรายการแข่งขันที่นำเข้าแล้วจริง (ไม่ใช่ตัวเลขคาดการณ์)
    "total_entries": 0
  },
  "events": [
    {
      "item_id": 1,
      "name": "ชื่อรายการแข่งขัน (ตามเอกสารต้นฉบับ)",
      "source_file": "โฟลเดอร์ต้นฉบับ/ไฟล์.pdf",
      "pdf_files": ["โฟลเดอร์ต้นฉบับ/ไฟล์1.pdf", "โฟลเดอร์ต้นฉบับ/ไฟล์2.pdf"],
      "preview_images": ["scan_previews/2568_item_01_page_1.jpg"],
      "classes": [
        {
          "class_name": "ชื่อคลาส/รุ่นตามเอกสาร",
          "discipline": "Jumping | Dressage | Eventing | Endurance",
          "date": "YYYY-MM-DD",
          "page_number": 1,
          "preview_image": "scan_previews/2568_item_01_page_1.jpg",
          "entries": [ /* ดูหัวข้อ 3 ตามประเภทกีฬา */ ]
        }
      ]
    }
  ]
}
```

## 3. โครงสร้าง `entry` แยกตามประเภทกีฬา (เพิ่มเติมจากของเดิม แต่ไม่ลบ field เดิม)

แนวทาง: **เก็บ field เดิมที่ webapp ใช้แสดงผลไว้ครบ** (`rank, bib, athlete, horse, club, discipline, r1_score, jo_score, score_display, status`)
แล้ว **เพิ่ม field โครงสร้างใหม่แบบยืดหยุ่น** เพื่อให้ข้อมูลใช้คำนวณ/ตรวจสอบย้อนหลังได้ โดยไม่ต้องแก้ตัว webapp ที่มีอยู่ (เพราะมันอ่านแค่ field เดิม ส่วน field ใหม่ไว้ใช้ตอนทำระบบตรวจทาน/validation ในอนาคต):

```jsonc
{
  "rank": 1,                     // null ถ้าไม่มีอันดับ (เช่น ถูกตัดสิทธิ์) — ห้ามใส่ 0 แทน
  "bib": "162",                  // เก็บเป็น string เสมอ (เลขบิบอาจมีตัวอักษรนำหน้า)
  "athlete": "ชื่อ-สกุล ตามที่พิมพ์ในเอกสาร",
  "name_as_printed": "ชื่อ-สกุล ตามที่พิมพ์ในเอกสาร", // ก่อนจับคู่กับทะเบียนนักกีฬากลาง (ถ้ามีระบบนั้นในอนาคต)
  "horse": "ชื่อม้า",
  "club": "สโมสร/สังกัด",
  "discipline": "Jumping",
  "status": null,                 // null = ปกติ, "E" = ตัดสิทธิ์, "W"/"WD" = ถอนตัว, "R" = Retired

  // --- ค่าที่พิมพ์ในเอกสารต้นฉบับ (ของจริง ห้ามคำนวณเอง) ---
  "official_value": {
    "display": "83.78s (โทษ 0)",       // สตริงตามที่เอกสารพิมพ์ไว้ (เข้ากับ r1_score/score_display เดิม)
    // ตัวอย่าง field เฉพาะประเภทกีฬา — ใส่เฉพาะที่เอกสารมีจริง ที่เหลือเป็น null:
    "time_seconds": 83.78,             // Jumping/Endurance
    "faults": 0,                        // Jumping
    "jump_off_time_seconds": null,
    "jump_off_faults": null,
    "technical_percent": null,          // Dressage
    "collective_percent": null,         // Dressage
    "total_percent": null,              // Dressage
    "dressage_penalty": null,           // Eventing phase (100 - total_percent)
    "jumping_penalty": null,            // Eventing phase
    "xc_penalty": null,                 // Eventing cross-country phase
    "loop_times": null,                 // Endurance: array ของเวลาต่อ loop ถ้ามี
    "vet_gate_result": null             // Endurance
  },

  // --- ค่าที่ระบบคำนวณเอง (เผื่ออนาคตมีการจัดอันดับ/ตรวจทานอัตโนมัติ) ---
  "calculated_value": {
    "computed_total_penalty": null,
    "note": "ค่าในกลุ่มนี้ใช้เพื่อ cross-check เท่านั้น ห้ามถือเป็นผลรับรองแทนค่าที่พิมพ์ในเอกสาร"
  },

  // --- Traceability / Review ---
  "source_file": "โฟลเดอร์ต้นฉบับ/ไฟล์.pdf",
  "source_page": 1,
  "needs_review": false,     // true = อ่านไม่ชัดเจน/อ่านไม่ออก ต้องให้คนตรวจก่อนเผยแพร่
  "review_status": "pending" // "pending" | "reviewed" | "published" — ใช้คุมการเผยแพร่แยกจากการแกะข้อมูลดิบ
}
```

**หมายเหตุสำคัญ:** นี่เป็นแค่ตัวอย่างโครงสร้าง — งานรอบนี้ไม่ได้สร้างไฟล์ข้อมูลจริงสำหรับปี 2568/2569 (ยังไม่มี `tef_master_data_2568.json` อยู่ในระบบเลย) ตามข้อกำหนด "ไม่อัปโหลดหรือประมวลผลข้อมูลจริงในงานรอบนี้"

## 4. วิธีนำเข้าข้อมูลจริงเมื่อมีในอนาคต

1. แกะข้อมูล OCR ของปีนั้นให้อยู่ในรูปแบบตามหัวข้อ 2–3 ข้างต้น บันทึกเป็นไฟล์ เช่น `tef_master_data_2568.json`
2. แปลงเป็นไฟล์ JS ที่ set ตัวแปร namespace (ไม่ชนกับของปี 2567):
   ```js
   window.TEF_DATA_BY_YEAR = window.TEF_DATA_BY_YEAR || {};
   window.TEF_DATA_BY_YEAR['2568'] = { summary: {...}, events: [...] };
   ```
   บันทึกเป็น `tef_master_data_2568.js`
3. เพิ่ม `<script src="tef_master_data_2568.js"></script>` ใน `index.html` (และ `tef_results_webapp.html` ที่ต้องเหมือนกันทุกตัวอักษร) หลังบรรทัด `<script src="tef_master_data.js"></script>`
4. ใน `index.html` แก้ `window.TEF_YEARS_CONFIG` รายการปี 2568 จาก
   `{ year: "2568", ..., status: "coming_soon", dataKey: "2568" }`
   เป็น
   `{ year: "2568", ..., status: "available", dataKey: "2568" }`
5. เท่านี้พอ — ไม่ต้องแก้โค้ดส่วนอื่นเลย ปีนั้นจะขึ้นมาใช้งานได้ทันทีในหน้าเว็บเดิม

## 5. ประเด็นที่ควรตัดสินใจก่อนเริ่มนำเข้าข้อมูลจริง (ยังไม่ต้องตัดสินใจตอนนี้)

- จะเก็บทะเบียนนักกีฬากลาง (athlete registry) แยกจากผลแข่งขันหรือไม่ (ใช้ TEF ID เป็นหลัก + ชื่อ/FEI ID เป็นตัวช่วยจับคู่)
- เกณฑ์ความมั่นใจของ OCR ที่ต้องส่งให้คนตรวจ (`needs_review` threshold)
- ผลประเภททีม เก็บเป็นระเบียนแยกหรือคำนวณจากผลเดี่ยว
