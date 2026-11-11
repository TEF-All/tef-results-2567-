#!/bin/bash
cd "$(dirname "$0")"
echo "=========================================================="
echo " Starting TEF Local Server on http://localhost:8000"
echo " Opening http://localhost:8000/tef_results_webapp.html"
echo " (กด Ctrl + C เพื่อปิดเซิร์ฟเวอร์เมื่อใช้งานเสร็จสิ้น)"
echo "=========================================================="
open "http://localhost:8000/tef_results_webapp.html"
python3 -m http.server 8000
