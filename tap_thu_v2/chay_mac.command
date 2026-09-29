#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Máy chưa có Python 3. Cài tại https://www.python.org/downloads/ rồi mở lại file này."
  read -r -p "Nhấn Enter để đóng..." _
  exit 1
fi
python3 app.py
echo
read -r -p "Nhấn Enter để đóng cửa sổ..." _
