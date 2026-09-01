@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Arkkan Agent - FTC2

cd /d "%~dp0"

echo ════════════════════════════════════════════════════════
echo    Arkkan Agent — وكيل أركان المحلي (FTC2)
echo    العنوان: http://localhost:9955
echo ════════════════════════════════════════════════════════

REM ── 1) التأكد من تثبيت Node.js ──
where node >nul 2>nul
if errorlevel 1 (
    echo [خطأ] Node.js غير مثبّت على هذا الجهاز.
    echo        حمّله من https://nodejs.org ثم أعد تشغيل هذا الملف.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo [•] إصدار Node.js: !NODE_VER!

REM ── 2) تثبيت Playwright لو مش موجود (مرة واحدة) ──
if not exist "node_modules\playwright" (
    echo [إعداد] تثبيت الاعتماديات لأول مرة... قد يستغرق دقائق.
    call npm install --no-save playwright@^1.62.1
    call npx --no-install playwright install chromium
)

REM ── 3) تشغيل الوكيل مع إعادة تشغيل تلقائية عند أي انهيار ──
:loop
echo.
echo [تشغيل] node arkkan-agent.js   (اضغط Ctrl+C للإيقاف)
node arkkan-agent.js
echo.
echo [إنتباه] توقف الوكيل — إعادة المحاولة بعد 3 ثوانٍ...
timeout /t 3 /nobreak >nul
goto loop