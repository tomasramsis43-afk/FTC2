#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
فحص صحة الكود قبل أي رفع (commit/push) لمشروع FTC2.
شغّله من جذر الريبو: python3 tools/check.py
أو عبر: ./tools/check.sh

يفحص:
  1) صحة صياغة JavaScript في frontend/app-inline.js و server/server.js
  2) استخراج كل <script> داخل frontend/app.html والتأكد من صحة صياغتها
  3) توازن وسوم HTML الأساسية (div / section / button) في app.html
  4) عناصر مخفية افتراضياً عبر CSS (id{display:none}) ولها inline style يتعارض
     معها ويجعلها ظاهرة رغم ذلك (نفس نوع الخطأ الذي حصل مع #app-wrap)
  5) دوال JavaScript معرَّفة أكثر من مرة على المستوى الأعلى (نسخ‌ولصق قديم يسبب
     الكتابة فوق نسخة سابقة بصمت)
  6) عناصر يشير إليها JavaScript بمعرّف ثابت ($('#x') أو getElementById('x'))
     لكنها غير موجودة إطلاقاً في app.html — غالباً بقايا كود قديم أو خطأ مطبعي

الفحص لا يعدّل أي ملف؛ فقط يطبع تقريراً ويخرج بكود 1 لو وجد مشكلة حقيقية.
"""
import re
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_HTML = os.path.join(ROOT, 'frontend', 'app.html')
APP_JS = os.path.join(ROOT, 'frontend', 'app-inline.js')
SERVER_JS = os.path.join(ROOT, 'server', 'server.js')

errors = []
warnings = []


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def node_check(path, label):
    if not os.path.exists(path):
        warnings.append(f'{label}: الملف غير موجود ({path}) — تم تخطي الفحص')
        return
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    if r.returncode != 0:
        errors.append(f'{label}: خطأ في صياغة JavaScript:\n{r.stderr.strip()}')
    else:
        print(f'✅ {label}: صياغة صحيحة')


def check_inline_scripts(html):
    blocks = re.findall(r'<script(?:(?!src=)[^>])*>(.*?)</script>', html, re.S)
    combined = '\n;\n'.join(blocks)
    tmp_path = '/tmp/_ftc2_inline_check.js'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        f.write(combined)
    r = subprocess.run(['node', '--check', tmp_path], capture_output=True, text=True)
    if r.returncode != 0:
        errors.append(f'app.html (سكريبتات inline): خطأ في الصياغة:\n{r.stderr.strip()}')
    else:
        print(f'✅ app.html: كل السكريبتات الداخلية ({len(blocks)}) صياغتها صحيحة')


def check_tag_balance(html):
    for tag in ['div', 'section', 'button']:
        opens = len(re.findall(r'<' + tag + r'(?:\s|>)', html))
        closes = len(re.findall(r'</' + tag + r'>', html))
        if opens != closes:
            errors.append(f'عدم توازن وسوم <{tag}>: فتح {opens} / غلق {closes} (فرق {opens - closes})')
        else:
            print(f'✅ توازن <{tag}>: {opens} فتح / {closes} غلق')


def check_conflicting_hidden_elements(html):
    """يبحث عن أي عنصر له قاعدة CSS تخفيه افتراضياً (#id{display:none}) لكن
       عنصره في HTML عنده inline style يظهره فعلياً (نفس خطأ app-wrap)."""
    hidden_by_css = re.findall(r'#([\w-]+)\s*\{\s*display:\s*none', html)
    found_issue = False
    for el_id in hidden_by_css:
        m = re.search(r'<[^>]+id=["\']' + re.escape(el_id) + r'["\'][^>]*style=["\']([^"\']*)["\']', html)
        if m and re.search(r'display\s*:\s*(block|flex|inline|inline-block|grid)', m.group(1)):
            errors.append(f'العنصر #{el_id}: مخفي افتراضياً في CSS لكن عنده inline style يظهره ({m.group(1)}) — نفس خطأ app-wrap القديم')
            found_issue = True
    if not found_issue:
        print(f'✅ لا يوجد أي عنصر مخفي في CSS ومتعارض معه inline style ({len(hidden_by_css)} عنصر تم فحصه)')


def check_duplicate_functions(js):
    names = re.findall(r'^function\s+([A-Za-z_$][\w$]*)\s*\(', js, re.M)
    seen = {}
    dups = []
    for n in names:
        seen[n] = seen.get(n, 0) + 1
    for n, c in seen.items():
        if c > 1:
            dups.append(f'{n} (×{c})')
    if dups:
        errors.append('دوال معرَّفة أكثر من مرة (قد تكتب نسخة فوق أخرى بصمت): ' + ', '.join(dups))
    else:
        print(f'✅ لا يوجد دوال مكرّرة التعريف ({len(seen)} دالة مفحوصة)')


def check_orphaned_ids(html, js):
    html_ids = set(re.findall(r'id=["\']([\w-]+)["\']', html))
    # نجمع كل المعرّفات الثابتة (نص حرفي فقط، بدون ${...}) المُستخدَمة في JS
    js_ids = set()
    for m in re.finditer(r"""\$\(\s*['"]#([\w-]+)['"]\s*\)""", js):
        js_ids.add(m.group(1))
    for m in re.finditer(r"""getElementById\(\s*['"]([\w-]+)['"]\s*\)""", js):
        js_ids.add(m.group(1))
    # عناصر تُنشأ ديناميكياً وقت التشغيل (createElement ثم .id = 'x') فهي طبيعي ألا تكون في app.html
    dynamically_created = set(re.findall(r"""\.id\s*=\s*['"]([\w-]+)['"]""", js))
    missing = sorted(js_ids - html_ids - dynamically_created)
    if missing:
        warnings.append(
            'معرّفات (IDs) يشير إليها JavaScript بنص حرفي لكنها غير موجودة في app.html '
            'ولا تُنشأ ديناميكياً (قد تكون بقايا كود قديم — راجعها يدوياً):\n  ' +
            '\n  '.join(missing)
        )
    else:
        print(f'✅ كل المعرّفات المُستخدَمة في JS ({len(js_ids)}) موجودة فعلاً في app.html أو تُنشأ ديناميكياً')


def main():
    print('=== فحص صحة كود FTC2 ===\n')
    html = read(APP_HTML) if os.path.exists(APP_HTML) else ''
    js = read(APP_JS) if os.path.exists(APP_JS) else ''

    node_check(APP_JS, 'frontend/app-inline.js')
    node_check(SERVER_JS, 'server/server.js')
    if html:
        check_inline_scripts(html)
        check_tag_balance(html)
        check_conflicting_hidden_elements(html)
    if js:
        check_duplicate_functions(js)
    if html and js:
        check_orphaned_ids(html, js)

    print('\n=== النتيجة ===')
    if warnings:
        print(f'\n⚠️  {len(warnings)} تنبيه (يستحق المراجعة لكنه ليس خطأ قاطعاً):')
        for w in warnings:
            print(f'  - {w}\n')
    if errors:
        print(f'❌ {len(errors)} خطأ حقيقي وجب إصلاحه قبل الرفع:')
        for e in errors:
            print(f'  - {e}\n')
        sys.exit(1)
    else:
        print('✅ لا توجد أخطاء. الكود جاهز للرفع.')
        sys.exit(0)


if __name__ == '__main__':
    main()
