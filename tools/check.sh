#!/usr/bin/env bash
# فحص صحة الكود قبل أي رفع — شغّله من جذر الريبو: ./tools/check.sh
set -e
cd "$(dirname "$0")/.."
python3 tools/check.py
