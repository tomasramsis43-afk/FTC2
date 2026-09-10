/**
 * arkkan-agent.js — عميل أركان المحلي (نسخة محسّنة)
 * ══════════════════════════════════════════════════════════════
 * سيرفر HTTP محلي على localhost:9955 يفتح متصفح Chromium (Playwright)
 * ويجلب بيانات العملاء من موقع أركان، ليستخدمه برنامج FTC2.
 *
 * التحسينات:
 *  ├── Sequential Queue: معالجة عملاء واحد تلو الآخر
 *  ├── Client State Isolation: مسح الحالة بين كل عميل وآخر
 *  ├── Frame Snapshot: اكتشاف الإطارات الجديدة فقط
 *  ├── Data Validation: التحقق من صحة البيانات قبل الإرجاع
 *  ├── FHD Rules: قواعد صارمة لاختيار الدورة/الفاتورة
 *  ├── Protection Detection: اكتشاف 403/429/CAPTCHA والوقوف
 *  ├── Retry with Backoff: إعادة محاولة للأخطاء المؤقتة فقط
 *  ├── Configurable Delays: توقيتات قابلة للضبط من environment
 *  └── Security Hardening: CORS آمن + input validation
 *
 * التشغيل:
 *   npm install playwright
 *   npx playwright install chromium
 *   node arkkan-agent.js
 *
 * نقاط النهاية:
 *   GET  /api/arkkan/status
 *   POST /api/arkkan/warm
 *   POST /api/arkkan/fetch   { clientId, referNum? }
 *   POST /api/arkkan/receipts { clientId, referNum? }
 *     ← يفتح إيصالات الدورة (FHD) + الحقيبة ويلتقطها كـ PDF (أو PNG في الوضع غير النصي)
 *       على الجهاز: يعيد { count, receipts: [{ kind, invoice, date, mime, base64, ext, fileName }] }
 *   POST /api/arkkan/exams   { clientId, referNum? }
 *   POST /api/arkkan/submit-trainee { clientId, name, phone?, nationality?, credentials?: { user, pass } }
 *     ← يرفع "طلب متدرب" إلى بوابة الحقيبة (Traniee_Request.aspx) بعد تسجيل الدخول؛
 *       الاعتمادات من ARKKAN_USER/ARKKAN_PASS أو من جسم الطلب، ولا تُسجَّل أبداً.
 * ============================================================ */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/* تحميل ملف .env بسيط (بلا اعتماديات خارجية) — يُقرأ من مجلد التشغيل ومن مجلد
   الوكيل؛ القيم الموجودة فعلاً في البيئة لها الأولوية ولا تُستبدل أبداً.
   الاعتمادات هنا (إن كانت في .env) تظل على الجهاز ولا تُرسل لأي مكان. */
function loadEnvFile(dir) {
  try {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) return;
    for (let line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {}
}
loadEnvFile(process.cwd());
loadEnvFile(__dirname);

const cfg = require('./arkkan-config');
const { log, ProtectionError, ValidationError, TimeoutError, FrameError, NoDataError, maskId, mask, isProtectionError } = require('./arkkan-logger');
const { wait, SequentialQueue, JOB_STATUS, withRetry, snapshotFrames, findNewFrame, waitForStable, clearInputFields, isolateClientState, validateClientId, validateReferNum, readJsonBody, dateKey } = require('./arkkan-utils');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

/* ══════════════════════════════════════════════
   Browser State
   ══════════════════════════════════════════════ */
let _browser = null;

/* ── إخفاء أي نافذة متصفح تظهر عنوة على ويندوز (شبكة أمان) ──
   الاعتماد على --window-position/--window-size وحده مش كافي أحياناً: على بعض
   أجهزة ويندوز فيه باگ معروف في Chromium بيخلي عملية chrome-headless-shell
   تفتح نافذة حقيقية ظاهرة رغم إنها headless فعليًا من ناحية الرندر، وممكن
   تتكرر (تقفل وتفتح) مع كل إعادة تشغيل للمتصفح. الحل الضامن: مسح دوري (كل
   ثانيتين) بأمر PowerShell بسيط بيخفي أي نافذة لأي عملية اسمها
   chrome-headless-shell/headless_shell عن طريق Win32 ShowWindow(hwnd, SW_HIDE)
   — العملية نفسها فاضلة شغالة عادي، بس مش ظاهرة للمستخدم خالص. لا يعمل شيء
   على أنظمة غير ويندوز (macOS/Linux ما عندهمش الباگ ده أصلاً). */
let _winHideTimer = null;
function startWindowsWindowHider() {
  if (process.platform !== 'win32' || _winHideTimer) return;
  const psCmd = [
    '$ErrorActionPreference=\'SilentlyContinue\';',
    'Add-Type -Name W -Namespace P -MemberDefinition',
    '\'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);\';',
    'Get-Process -Name chrome-headless-shell,headless_shell -ErrorAction SilentlyContinue |',
    'ForEach-Object { if ($_.MainWindowHandle -ne 0) { [P.W]::ShowWindow($_.MainWindowHandle,0) } }'
  ].join(' ');
  const run = () => {
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "${psCmd}"`, { windowsHide: true }, () => {});
  };
  run();
  _winHideTimer = setInterval(run, 2000);
  if (typeof _winHideTimer.unref === 'function') _winHideTimer.unref();
}
startWindowsWindowHider();
let _workers = [];
let _ready = false;
let _protectionActive = false;
let _protectionUntil = 0;
// Sequential Queue: معالجة عملاء واحد تلو الآخر دائماً لمنع خلط البيانات
// (Concurrency ثابت 1 — ممنوع تشغيل عدة عمليات أركان في نفس الوقت)
const _jobQueue = new SequentialQueue(1);

/* ── الإيقاف الذاتي بعد الخمول ──
   الوكيل لا يعمل إلا عند ضغط زر جلب/رفع من البرنامج (وبضغطة "تشغيل" اليدوية).
   بعد إكمال أي طلب وظيفي وتمضية IDLE_EXIT_MS دون مهام، يُغلق المتصفح ويخرج
   بكود خروج مميز (IDLE_EXIT_CODE=42) — يتبيَّنه المٌشغّل في Electron فلا
   يُعيد تشغيله تلقائياً، بل يبقى متوقفاً حتى ضغطة الزرار التالية. */
const IDLE_EXIT_CODE = 42;
const IDLE_EXIT_MS = (() => {
  // كانت القيمة الافتراضية 20 ثانية فقط — قصيرة جداً بالنسبة للعمليات الجماعية
  // (bulk fetch/submit تعمل عميل وراء عميل بالتتابع)، حيث كل عميل لوحده بياخد
  // عشرات الثواني (تنقّل صفحات + تأخيرات عشوائية لتفادي كشف البوت + حفظ النتيجة
  // فى قاعدة البيانات قبل بدء العميل التالي). فكان الوكيل بيدخل خمول ويقفل
  // المتصفح بين عميل وعميل، وأول طلب للعميل التالي بيشغّله من الصفر تاني —
  // فتظهر نافذة المتصفح وتختفي بالتناوب أثناء أي عملية جماعية. رفعناها لـ 90
  // ثانية عشان تستحمل الفجوات الطبيعية دي، ولسه بتقفل تلقائياً لو فعلاً
  // المستخدم بلاش استخدام الوكيل لمدة كافية.
  const v = parseInt(process.env.ARKKAN_IDLE_EXIT_MS || '90000', 10);
  return Number.isFinite(v) && v > 0 ? v : 90000;
})();
let _idleExitTimer = null;
function cancelIdleExit() {
  if (_idleExitTimer) { clearTimeout(_idleExitTimer); _idleExitTimer = null; }
}
function scheduleIdleExit(delayMs = IDLE_EXIT_MS) {
  cancelIdleExit();
  _idleExitTimer = setTimeout(() => {
    log.info(`🛑 لا توجد مهام — إيقاف الوكيل والإغلاق التلقائي بعد ${Math.round(delayMs / 1000)} ث`);
    (async () => {
      try { await _browser?.close().catch(() => {}); } catch {}
      process.exit(IDLE_EXIT_CODE);
    })();
  }, delayMs);
}

/* ══════════════════════════════════════════════
   Resource Blocking (لتسريع الجلب)
   ══════════════════════════════════════════════ */
function blockHeavyResources(ctx) {
  if (!ctx || !ctx.route) return;
  ctx.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
    return route.continue().catch(() => {});
  }).catch(() => {});
}

/* ══════════════════════════════════════════════
   Dialog Management
   ══════════════════════════════════════════════ */
async function clearArkanDialogs(pg) {
  return pg.evaluate(() => {
    const els = document.querySelectorAll(
      '.toastyDialog_msgContainer, .toastyDialog_msgMask, [id^="toastyDialog_"], #iframeSearch'
    );
    for (const el of els) el.style.display = 'none';
  }).catch(() => {});
}

async function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

/* ══════════════════════════════════════════════
   Protection Detection
   ══════════════════════════════════════════════ */
function isProtectionPage(text) {
  const lower = String(text || '').toLowerCase();
  for (const signal of cfg.PROTECTION.CAPTCHA_SIGNALS) {
    if (lower.includes(signal)) return true;
  }
  return false;
}

async function checkForProtection(pg) {
  try {
    const text = await pg.evaluate(() => document.body?.innerText || '').catch(() => '');
    if (isProtectionPage(text)) {
      _protectionActive = true;
      _protectionUntil = Date.now() + 5 * 60 * 1000; // 5 دقائق إيقاف
      log.protection('CAPTCHA/BLOCK', 'تم اكتشاف حماية خارجية — إيقاف 5 دقائق');
      return true;
    }
  } catch {}
  return false;
}

function isProtectionActive() {
  if (!_protectionActive) return false;
  if (Date.now() > _protectionUntil) {
    _protectionActive = false;
    log.info('انتهت فترة الحماية — يمكن المتابعة');
    return false;
  }
  return true;
}

/* ══════════════════════════════════════════════
   Frame Navigation
   ══════════════════════════════════════════════ */
const DETAILS_FRAME_PATTERN = /Arkan\/frm8157/;
const DOCUMENTS_FRAME_PATTERN = /\/Documents\//;
const EXAMS_FRAME_PATTERN = /frm8159/;

async function ensureDetailsFrame(pg) {
  let fr = pg.frames().find(f => DETAILS_FRAME_PATTERN.test(f.url()));
  if (fr) return fr;

  await pg.goto(cfg.ARKKAN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // انتظار ظهور زر "تفاصيل متدرب" مع Timeout واضح
  let clicked = false;
  const tA = Date.now();
  while (Date.now() - tA < cfg.DELAY.DETAILS_TIMEOUT && !clicked) {
    clicked = await pg.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
      if (a) { a.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) await wait(cfg.DELAY.DIALOG_POLL);
  }

  // انتظار ظهور الإطار مع Timeout واضح
  const tB = Date.now();
  while (Date.now() - tB < cfg.DELAY.DETAILS_TIMEOUT) {
    const f = pg.frames().find(x => DETAILS_FRAME_PATTERN.test(x.url()));
    if (f) return f;
    await wait(cfg.DELAY.DIALOG_POLL);
  }
  return pg.frames().find(x => DETAILS_FRAME_PATTERN.test(x.url())) || null;
}

/* ══════════════════════════════════════════════
   Load Student (مع Client State Isolation)
   ══════════════════════════════════════════════ */
async function loadStudent(pg, { clientId, referNum = '' }) {
  // 1. عزل الحالة: مسح أي بيانات من العميل السابق
  let fr = await ensureDetailsFrame(pg);
  if (!fr) throw new FrameError('تعذّر فتح صفحة تفاصيل المتدرب في أركان');

  await isolateClientState(fr, pg);

  // 2. ملء حقول البحث مع التحقق من صحة المدخلات
  const idValidation = validateClientId(clientId);
  if (!idValidation.valid) throw new FrameError(idValidation.reason);
  const refValidation = validateReferNum(referNum);
  if (!refValidation.valid) throw new FrameError(refValidation.reason);

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', idValidation.value);
  if (refValidation.value) {
    await fr.fill('#ctl00_Student_id_fltr_Txt_ref', refValidation.value).catch(() => {});
  } else {
    // مسح صريح لحقل Reference Number لو العميل الجديد لا يملكه
    await fr.fill('#ctl00_Student_id_fltr_Txt_ref', '').catch(() => {});
  }

  await fr.click('#ctl00_Student_id_fltr_btnConfirm');

  // 3. انتظار النتائج مع Smart Wait
  const readSig = () => fr.evaluate(() => {
    const txt = (sel) => [...document.querySelectorAll(sel)].map(r => r.innerText.trim());
    return {
      rowsC: txt('#ctl00_Courses_Students_GridView1 tr.RowItems'),
      rowsB: txt('#ctl00_Training_bags_GridView1 tr.RowItems'),
    };
  }).catch(() => ({ rowsC: [], rowsB: [] }));

  const hasData = (sig) => sig.rowsC.length > 0 || sig.rowsB.length > 0;

  let sigStable = await waitForStable({
    readFn: readSig,
    hasDataFn: hasData,
    timeoutMs: cfg.DELAY.RESULT_TIMEOUT,
    pollMs: cfg.DELAY.RESULT_STABLE,
  });

  if (!hasData(sigStable)) {
    await wait(cfg.DELAY.RETRY_STABLE);
    sigStable = await waitForStable({
      readFn: readSig,
      hasDataFn: hasData,
      timeoutMs: cfg.DELAY.RESULT_TIMEOUT,
      pollMs: cfg.DELAY.RESULT_STABLE,
    });
  }

  // 4. فحص الحماية بعد كل عملية بحث
  await checkForProtection(pg);

  const nC = (sigStable && sigStable.rowsC.length) || 0;
  const nB = (sigStable && sigStable.rowsB.length) || 0;
  log.info(`loadStudent: client=${maskId(clientId)} — دورات: ${nC} | حقائب: ${nB}`);
  return { fr, nC, nB };
}

/* ══════════════════════════════════════════════
   Fetch Client Data (مع FHD Rules + Frame Snapshot)
   ══════════════════════════════════════════════ */

/* جلب "الرقم المرجعي" من منصة إدارة النظام (Bases) — بحث برقم الهوية فقط.
   ── تستخدم اعتمادات حساب إدارة النظام (من إعدادات البرنامج، منفصلة عن بوابة
      الحقيبة). سياق مستقل يُغلق بعد الانتهاء. بلا اعتمادات تعود فارغة بصمت
      ولا تُوقف جلب البيانات العادي (تخطي ضمني للرقم المرجعي). ── */
async function fetchBasesRefNum({ clientId, creds }) {
  const user = String((creds && creds.user) || '').trim();
  const pass = String((creds && creds.pass) || '');
  if (!user || !pass) throw new Error('ضع بيانات حساب منصة إدارة النظام في تبويب «مزامنة أركان» أولاً');
  if (!_browser) throw new Error('الوكيل المحلي لم يُنشئ المتصفح بعد — أعد تشغيله');
  log.info(`جلب رقم مرجعي: تسجيل الدخول إلى منصة إدارة النظام`);

  let ctx = null;
  try {
    ctx = await _browser.newContext({ locale: 'ar' });
    blockHeavyResources(ctx);
    const pg = await ctx.newPage();

    await pg.goto(cfg.ARKKAN_BASES_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
    await wait(cfg.DELAY.PAGE_LOAD);

    const hasLogin = await pg.locator('#UsrName').count().catch(() => 0);
    if (hasLogin) {
      await pg.fill('#UsrName', user);
      await pg.fill('#Pwd', pass);
      await pg.click('#btnLogin');
      // الانتظار: إما اختفاء نموذج الدخول، أو تحوّل الصفحة إلى الصفحة الرئيسية، أو انقضاء المهلة
      const t0 = Date.now();
      let loggedIn = false;
      while (Date.now() - t0 < cfg.TIMEOUT.LOGIN) {
        const url = pg.url();
        if (/MainPagewebsite/.test(url)) { loggedIn = true; break; }
        const still = await pg.locator('#UsrName').count().catch(() => 0);
        if (!still) { loggedIn = true; break; }
        await wait(cfg.DELAY.DIALOG_POLL);
      }
      await wait(cfg.DELAY.PAGE_LOAD);
      if (!loggedIn) {
        throw new Error('فشل تسجيل الدخول إلى منصة إدارة النظام — تحقق من اسم المستخدم وكلمة المرور');
      }
    } else {
      throw new Error('صفحة تسجيل الدخول غير متوفرة — قد تكون المنصة محجوبة مؤقتاً');
    }

    // رابط وحدة "استعلام عن رقم مرجعي" (روابط الوحدات مشفّرة/ديناميكية لكل جلسة)
    const href = await pg.locator('#dvMenu a', { hasText: 'استعلام عن رقم مرجعي' }).first()
      .getAttribute('href').catch(() => '');
    if (!href) throw new Error('رابط وحدة «استعلام عن رقم مرجعي» غير موجود في القائمة');

    await pg.goto('https://arkkanapp2.net/Bases/' + href, { waitUntil: 'domcontentloaded', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
    await wait(cfg.DELAY.PAGE_LOAD);

    let fr = null;
    const tF = Date.now();
    while (Date.now() - tF < cfg.DELAY.DETAILS_TIMEOUT) {
      fr = pg.frames().find(f => /frm8023_Students/.test(f.url()));
      if (fr) break;
      await wait(cfg.DELAY.DIALOG_POLL);
    }
    if (!fr) throw new Error('نموذج الاستعلام لم يُفتح بعد البحث');

    // البحث برقم الهوية فقط — بدون أي اعتماد على الرقم المرجعي الحالي
    await fr.fill('#ctl00_ID_Number-fltr', String(clientId).trim());
    await fr.click('#ctl00_btnSearch');

    const readRef = () => fr.evaluate(() => {
      // أعمدة الجدول: [checkbox, اسم المتدرب, الرقم المرجعي, رقم الهوية]
      const row = document.querySelector('#ctl00_GridSearch_GridView1 tr.RowItems');
      if (!row) return '';
      const cells = [...row.querySelectorAll('td')];
      return (cells[2]?.innerText || '').trim();
    }).catch(() => '');

    const val = await waitForStable({
      readFn: readRef,
      hasDataFn: v => !!v,
      timeoutMs: cfg.DELAY.RESULT_TIMEOUT,
      pollMs: cfg.DELAY.RESULT_STABLE,
    });
    log.info(`fetchBasesRefNum: client=${maskId(clientId)} — ${val ? 'refNum=' + mask(val) : 'لا نتيجة'}`);
    return val || '';
  } catch (e) {
    log.warn('fetchBasesRefNum: ' + (e.message || '').slice(0, 160));
    throw e;
  } finally {
    await ctx?.close().catch(() => {});
  }
}

async function fetchClientData(pg, { clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', bagOwnDate: '', startDate: '',
    referNum: '',
    _validation: { clientId, referNum, timestamp: Date.now() },
  };

  let { fr, nC, nB } = await loadStudent(pg, { clientId, referNum });

  // ── قاعدة FHD الصارمة: لا نأخذ أي بيانات إلا إذا كان رقم الدورة يبدأ بـ FHD ──
  if (nC > 0) {
    const courseRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')].map((r, i) => ({
        i,
        cn: (r.querySelector('.Course_number')?.innerText || '').trim(),
        start: (r.querySelector('.Startdate')?.innerText || '').trim(),
      }));
    });

    // الدورات المطابقة لقاعدة FHD فقط
    const fhdRows = courseRows.filter(r => /^FHD/i.test(r.cn));

    for (const cr of fhdRows) {
      // لقطة الإطارات قبل فتح المستند
      const beforeDocFrames = snapshotFrames(pg, DOCUMENTS_FRAME_PATTERN);

      const clicked = await fr.evaluate((i) => {
        const el = document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')[i];
        if (!el) return false;
        const a = el.querySelector('a');
        const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        const t = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
        if (t) { t.click(); return true; }
        return false;
      }, cr.i);
      if (!clicked) throw new FrameError(`تعذّر النقر على زر الإيصال للدورة (${cr.cn})`);

      // اكتشاف الإطار الجديد فقط (وليس أي إطار موجود)
      const recF = await findNewFrame(pg, DOCUMENTS_FRAME_PATTERN, beforeDocFrames, cfg.DELAY.DOCUMENT_OPEN);
      if (!recF) throw new TimeoutError(`تعذّر فتح إيصال الدورة (${cr.cn}) بعد الانتظار`);

      const txt = await recF.evaluate(() => document.body.innerText);

      // فحص الحماية في محتوى المستند
      if (isProtectionPage(txt)) {
        _protectionActive = true;
        _protectionUntil = Date.now() + 5 * 60 * 1000;
        log.protection('IN_DOCUMENT', 'تم اكتشاف حماية داخل المستند');
        break;
      }

      const inv = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
        .replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();

      await closeDialog(pg);

      // انتظار إغلاق المستند
      const t1 = Date.now();
      while (Date.now() - t1 < cfg.DELAY.DIALOG_CLOSE &&
             pg.frames().some(f => DOCUMENTS_FRAME_PATTERN.test(f.url()) && !beforeDocFrames.includes(f))) {
        await wait(cfg.DELAY.DIALOG_POLL);
      }

      fr = pg.frames().find(f => DETAILS_FRAME_PATTERN.test(f.url())) || await ensureDetailsFrame(pg);

      // الشرط الثاني: رقم الفاتورة يجب أن يبدأ بـ FHD
      if (!/^FHD/i.test(inv)) {
        log.info(`fetchClientData: client=${maskId(clientId)} — دورة ${cr.cn} إيصالها غير FHD (${inv}) — تُترك فارغة`);
        continue;
      }

      result.courseNumber = cr.cn;
      result.startDate = cr.start;
      result.invoice = inv;
      result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '')
        .replace(/[^\d.,]/g, '').trim();
      result.date = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
        .replace(/[^\d\/-]/g, '').trim();
      break;
    }
  }

  if (nC > 0 && !result.courseNumber && !result.invoice) {
    log.info(`fetchClientData: client=${maskId(clientId)} — لا دورة مطابقة لقاعدة FHD`);
  }

  // ── بيانات الحقيبة (مع Frame Snapshot) ──
  if (fr && nB > 0) {
    const bagRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')]
        .map((r, i) => {
          const inp = [...r.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
          if (!inp) return null;
          const type = (r.querySelector('td:nth-child(4)')?.innerText || '').trim();
          return { i, own: /خاص|خصوصي/.test(type) };
        })
        .filter(Boolean);
    });

    let bagBest = { invoice: '', bagPurchaseDate: '' };
    let bagOwnDate = '';
    for (const br of bagRows) {
      const beforeDocFrames = snapshotFrames(pg, DOCUMENTS_FRAME_PATTERN);
      const idx = br.i;
      const clickedB = await fr.evaluate((i) => {
        const row = document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')[i];
        const inp = row && [...row.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        if (inp) { inp.click(); return true; }
        return false;
      }, idx);
      if (!clickedB) continue;

      const recFb = await findNewFrame(pg, DOCUMENTS_FRAME_PATTERN, beforeDocFrames, cfg.DELAY.DOCUMENT_OPEN * 0.6);
      if (!recFb) continue;

      const txt = await recFb.evaluate(() => document.body.innerText);
      const inv = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
        .replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
      const dt = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
        .replace(/[^\d\/-]/g, '').trim();

      if (dt && dateKey(dt) > dateKey(bagBest.bagPurchaseDate)) {
        bagBest = { invoice: inv, bagPurchaseDate: dt };
      }
      if (br.own && dt && dateKey(dt) > dateKey(bagOwnDate)) {
        bagOwnDate = dt;
      }

      await closeDialog(pg);
      const t1 = Date.now();
      while (Date.now() - t1 < cfg.DELAY.DIALOG_CLOSE &&
             pg.frames().some(f => DOCUMENTS_FRAME_PATTERN.test(f.url()) && !beforeDocFrames.includes(f))) {
        await wait(cfg.DELAY.DIALOG_POLL);
      }
    }

    result.bagInvoice = bagBest.invoice;
    result.bagPurchaseDate = bagBest.bagPurchaseDate;
    result.bagOwnDate = bagOwnDate || bagBest.bagPurchaseDate;
  }

  await smartRefresh(pg);
  return finalizeResult(result);
}

/* ══════════════════════════════════════════════
   Receipt Download (تصدير إيصالات الدورة + الحقيبة كملفات على الجهاز)
   ── يفتح كل إيصال في سياق نظيف (بدون حجب الموارد) ويلتقطه كـ PDF؛
      في الوضع غير Headless يسقط تلقائياً إلى PNG بصفحة الإيصال كاملة. ──
   ══════════════════════════════════════════════ */

// اسم ملف نظيف من رقم الفاتورة/الدورة — يُحذف أي محرف غير أمن في أسماء الملفات
function cleanFileToken(v, fallback) {
  const s = String(v || '').replace(/[^\w\u0600-\u06FF\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80);
  return s || fallback || 'receipt';
}

// التقاط صفحة الإيصال كملف: سياق جديد في نفس المتصفح مع نفس كوكيز الجلسة —
// لأن سياقات العمال تحجب الاستايلات/الصور (لتسريع الجلب) فتصبح النسخة الفوتوغرافية
// بلا تنسيق. السياق النظيف يعيد نسخة مطابقة للمعروض للمستخدم.
async function captureReceiptAsFile(baseCtx, recF) {
  if (!recF || !_browser) return null;
  const url = recF.url();
  if (!url) return null;
  let newCtx = null;
  try {
    const cookies = await baseCtx.cookies();
    newCtx = await _browser.newContext({ locale: 'ar' });
    if (cookies && cookies.length) await newCtx.addCookies(cookies).catch(() => {});
    const shot = await newCtx.newPage();
    await shot.goto(url, { waitUntil: 'load', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
    await wait(cfg.DELAY.PAGE_LOAD);
    if (cfg.HEADLESS && typeof shot.pdf === 'function') {
      const buf = await shot.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      if (buf && buf.length) return { mime: 'application/pdf', base64: buf.toString('base64'), ext: 'pdf' };
    }
    const buf = await shot.screenshot({ fullPage: true });
    return { mime: 'image/png', base64: buf.toString('base64'), ext: 'png' };
  } catch (e) {
    log.warn('captureReceiptAsFile failed:', (e.message || '').slice(0, 120));
    return null;
  } finally {
    await newCtx?.close().catch(() => {});
  }
}

// فتح إيصال صف معين (دورة أو حقيبة)، التقاط ملفه، ثم إغلاق النافذة والعودة للإطار الأصلي.
// يعيد الإطار المحدَّث (may be refreshed بعد إغلاق المستند) عبر الثنائي { receipt, fr }.
async function openDocAndCapture(pg, fr, gridSel, rowIdx, kind, nameHint, clientId) {
  const beforeDocFrames = snapshotFrames(pg, DOCUMENTS_FRAME_PATTERN);
  const clicked = await fr.evaluate(({ sel, i }) => {
    const el = document.querySelectorAll(sel)[i];
    if (!el) return false;
    const a = el.querySelector('a');
    const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
    const t = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
    if (t) { t.click(); return true; }
    return false;
  }, { sel: gridSel, i: rowIdx }).catch(() => false);
  if (!clicked) return { receipt: null, fr };

  const recF = await findNewFrame(pg, DOCUMENTS_FRAME_PATTERN, beforeDocFrames, cfg.DELAY.DOCUMENT_OPEN);
  if (!recF) return { receipt: { protection: isProtectionActive() }, fr };

  const txt = await recF.evaluate(() => document.body.innerText || '').catch(() => '');
  if (isProtectionPage(txt)) {
    _protectionActive = true;
    _protectionUntil = Date.now() + 5 * 60 * 1000;
    log.protection('IN_DOCUMENT', 'تم اكتشاف حماية داخل مستند الإيصال');
    await closeDialog(pg);
    return { receipt: { protection: true }, fr };
  }

  const inv = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
    .replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
  const dt = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
    .replace(/[^\d\/-]/g, '').trim();

  const file = await captureReceiptAsFile(pg.context(), recF);

  await closeDialog(pg);
  const t1 = Date.now();
  while (Date.now() - t1 < cfg.DELAY.DIALOG_CLOSE &&
         pg.frames().some(f => DOCUMENTS_FRAME_PATTERN.test(f.url()) && !beforeDocFrames.includes(f))) {
    await wait(cfg.DELAY.DIALOG_POLL);
  }
  fr = pg.frames().find(f => DETAILS_FRAME_PATTERN.test(f.url())) || await ensureDetailsFrame(pg);

  if (!file) return { receipt: null, fr };
  const idNum = cleanFileToken(clientId, 'عميل');
  const receipt = {
    kind,
    invoice: inv,
    date: dt,
    mime: file.mime,
    base64: file.base64,
    ext: file.ext,
    fileName: `${kind === 'course' ? 'دورة' : 'حقيبة'}_${idNum}.${file.ext}`,
  };
  return { receipt, fr };
}

/* جلب إيصالات عميل: كر الإيصالات لكل الصفوف FHD + كل إيصالات الحقائب. */
async function fetchClientReceipts(pg, { clientId, referNum = '' }) {
  const receipts = [];
  let { fr, nC, nB } = await loadStudent(pg, { clientId, referNum });

  // ── إيصالات الدورات (قاعدة FHD فقط) ──
  if (nC > 0) {
    const courseRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')].map((r, i) => ({
        i,
        cn: (r.querySelector('.Course_number')?.innerText || '').trim(),
      }));
    }).catch(() => []);
    const fhdRows = courseRows.filter(r => /^FHD/i.test(r.cn)).slice(0, 5);
    for (const cr of fhdRows) {
      const { receipt, fr: nextFr } = await openDocAndCapture(pg, fr, '#ctl00_Courses_Students_GridView1 tr.RowItems', cr.i, 'course', cr.cn, clientId);
      fr = nextFr;
      if (receipt && receipt.protection) { log.info('receipts: توقف بسبب الحماية'); break; }
      if (receipt && receipt.base64) receipts.push({ courseNumber: cr.cn, ...receipt });
    }
  }

  // ── إيصالات الحقائب ──
  if (fr && nB > 0) {
    const bagRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')]
        .map((r, i) => {
          const inp = [...r.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
          if (!inp) return null;
          return { i };
        })
        .filter(Boolean)
        .slice(0, 5);
    }).catch(() => []);
    for (const br of bagRows) {
      const { receipt, fr: nextFr } = await openDocAndCapture(pg, fr, '#ctl00_Training_bags_GridView1 tr.RowItems', br.i, 'bag', '', clientId);
      fr = nextFr;
      if (receipt && receipt.protection) { log.info('receipts: توقف بسبب الحماية'); break; }
      if (receipt && receipt.base64) receipts.push(receipt);
    }
  }

  await smartRefresh(pg);
  return {
    clientId,
    count: receipts.length,
    receipts,
    fetchedAt: new Date().toISOString(),
  };
}

/* ══════════════════════════════════════════════
   Data Validation — التحقق من صحة البيانات قبل الإرجاع
   ── لا تُسلَّم بيانات غير مؤكدة: أي حقل مستخرج يُتحقق منه ──
   ── وإذا لم يمكن تحديد النتيجة الصحيحة بثقة: validation_failed ──
   ══════════════════════════════════════════════ */
function validateExtracted(result) {
  const issues = [];

  // رقم الفاتورة: إن وُجد يجب أن يكون صالحاً وغير مشوّه
  if (result.invoice) {
    if (!/^[A-Za-z0-9\/\-]+$/.test(result.invoice)) issues.push('invoice: format invalid');
    if (result.invoice.length < 3) issues.push('invoice: too short');
  }

  // رقم الدورة: إن وُجد يجب أن يكون صالحاً
  if (result.courseNumber && result.courseNumber.length < 2) {
    issues.push('courseNumber: too short');
  }

  // قيمة الفاتورة: إن وُجدت يجب أن تكون رقماً صالحاً
  if (result.coursePrice) {
    const numeric = parseFloat(String(result.coursePrice).replace(/[^\d.\-]/g, ''));
    if (isNaN(numeric) || numeric < 0) issues.push('coursePrice: not a valid number');
  }

  // التاريخ: إن وُجد يجب أن يُقرأ كتاريخ صالح
  const dateFields = [
    ['date', result.date],
    ['bagPurchaseDate', result.bagPurchaseDate],
    ['startDate', result.startDate],
  ];
  for (const [field, value] of dateFields) {
    if (!value) continue;
    const parsed = new Date(value.includes('/') ? value.replace(/\//g, '-') : value);
    if (isNaN(parsed.getTime())) issues.push(`${field}: unreadable date`);
  }

  if (issues.length) {
    log.warn(`validation: ${JSON.stringify(issues)}`);
    return { ...result, _validation: { ...result._validation, status: 'VALIDATION_FAILED', issues } };
  }
  return { ...result, _validation: { ...result._validation, status: 'SUCCESS', issues: [] } };
}

function finalizeResult(result) {
  // إزالة أي بيانات غير مؤكدة (لا نُسلّم قيماً غامضة للواجهة لتتجنب خلطها)
  return validateExtracted(result);
}

/* ══════════════════════════════════════════════
   Fetch Exam Scores (مع Frame Snapshot)
   ══════════════════════════════════════════════ */
async function fetchExamScoresOn(pg, { clientId, referNum = '' }) {
  const result = { attempts: [], lastDate: '', lastResult: '', lastGrade: '' };

  await loadStudent(pg, { clientId, referNum });

  let fr = pg.frames().find(f => DETAILS_FRAME_PATTERN.test(f.url()));
  let clicked = false;
  for (let t = 0; t < 40 && !clicked; t++) {
    clicked = await (fr ? fr.evaluate(() => {
      const btn = [...document.querySelectorAll('input, button')].find(el =>
        (el.value || el.innerText || '').trim() === 'الاختبارات');
      if (btn) { btn.click(); return true; }
      return false;
    }) : Promise.resolve(false)).catch(() => false);
    if (!clicked) await wait(cfg.DELAY.DIALOG_POLL);
  }
  if (!clicked) throw new NoDataError('لا توجد صفحة اختبارات لهذا العميل في أركان');

  // لقطة الإطارات قبل فتح صفحة الاختبارات
  const beforeExamFrames = snapshotFrames(pg, EXAMS_FRAME_PATTERN);

  const frT = await findNewFrame(pg, EXAMS_FRAME_PATTERN, beforeExamFrames, cfg.DELAY.DOCUMENT_OPEN * 0.7);
  if (!frT) throw new FrameError('تعذّر فتح صفحة نتائج الاختبارات في أركان');

  const readGrids = () => frT.evaluate(() => {
    const rowsOf = (gv) => [...document.querySelectorAll(gv + ' tr.RowItems')]
      .map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()));
    return {
      exam: rowsOf('#ctl00_Exam_master2_GridView1'),
      retake: rowsOf('#ctl00_Exam_master3_GridView1'),
      ready: !!(document.getElementById('ctl00_Exam_master2_GridView1') || document.getElementById('ctl00_Exam_master3_GridView1')),
    };
  });

  // Smart Wait مع Timeout واضح
  const parsed = await waitForStable({
    readFn: async () => {
      const data = await readGrids().catch(() => ({ exam: [], retake: [], ready: false }));
      return data;
    },
    hasDataFn: (data) => (data.exam && data.exam.length) || (data.retake && data.retake.length),
    stableCount: cfg.POLL.STABLE_COUNT,
    timeoutMs: cfg.POLL.EXAM_INTERVAL * cfg.POLL.EXAM_MAX_TICKS,
    pollMs: cfg.POLL.EXAM_INTERVAL,
    label: 'examScores',
  }) || { exam: [], retake: [], ready: false };

  const attempts = [];
  for (const r of parsed.retake) attempts.push({ r: r[2], g: r[3], d: '' });
  for (const r of parsed.exam) attempts.push({ r: r[4], g: r[5], d: r[1].replace(/^تم\s+الاختبار\s+بتاريخ\s*/, '') });

  const last4 = attempts.slice(-4);
  result.attempts = last4;
  if (last4.length) {
    const lastA = last4[last4.length - 1];
    result.lastResult = lastA.r;
    result.lastGrade = lastA.g;
    result.lastDate = lastA.d || '';
  }

  await frT.evaluate(() => {
    const b = document.querySelector('button.close');
    if (b) b.click();
  }).catch(() => {});
  await wait(cfg.DELAY.SMART_REFRESH);
  await clearArkanDialogs(pg);
  await smartRefresh(pg);

  return result;
}

/* ══════════════════════════════════════════════
   Submit Trainee Request (بوابة الحقيبة التثقيفية)
   ── يرفع "طلب متدرب" من بيانات برنامج FTC2 إلى نموذج
      Traniee_Request.aspx داخل بوابة الحقيبة (بعد تسجيل الدخول) ──
   ══════════════════════════════════════════════ */

// كل عملية رفع تستخدم سياقاً مستقلاً (دخول + صفحة) يُغلق بعد الانتهاء —
// حتى لا تتسرب بيانات عميل إلى آخر ولا تتداخل مع جلسات جلب البيانات العامة.
const SUBMIT_SHOT_DIR = path.join(__dirname, '.arkkan-submits');

/* إنشاء صفحة مخصصة لهذه العملية فقط + تسجيل الدخول + فتح النموذج.
   يُغلق المتصل السياق دائماً بعد النهاية (try/finally). */
async function openTraineePage(creds) {
  const ctx = await _browser.newContext({ locale: 'ar' });
  blockHeavyResources(ctx);
  const pg = await ctx.newPage();

  // التقط أي نافذة JS أصلية (alert/confirm) — بعض الشاشات تستخدمها بدل SweetAlert.
  // رسائل بوابة الحقيبة الأساسية تخرج عبر sweetalert (عنصر في الـ DOM)، وده زائد للأمان.
  let submitDialog = '';
  const dialog = {
    read: () => submitDialog,
    clear: () => { submitDialog = ''; },
  };
  pg.on('dialog', async d => {
    try { submitDialog = String(d.message() || '').trim(); } catch {}
    await d.dismiss().catch(() => {});
  });

  // الطريق الأضمن: اعتراض استجابة AJAX الخاصة بطلب addtrainee —
  // السيرفر يرد JSON فيه d.check و d.retmas (نص النتيجة الرسمي).
  let xhrSubmit = null;
  const xhr = {
    read: () => xhrSubmit,
    clear: () => { xhrSubmit = null; },
  };
  pg.on('response', async res => {
    try {
      const u = res.url() || '';
      if (!u.includes('addtrainee')) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const j = await res.json().catch(() => null);
      if (!j || !j.d) return;
      xhrSubmit = {
        check: j.d.check,
        retmas: String(j.d.retmas || '').trim(),
      };
    } catch {}
  });

  await pg.goto(cfg.ARKKAN_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
  await wait(cfg.DELAY.PAGE_LOAD);
  const hasLoginForm = await pg.locator('#UsernameLog').count();
  if (hasLoginForm) {
    log.info(`رفع طلب: تسجيل الدخول إلى بوابة الحقيبة (${String(creds.user).slice(0, 4)}…)`);
    await pg.fill('#UsernameLog', creds.user);
    await pg.fill('#Password', creds.pass);
    await pg.click('#btn_submitEnter');
    // انتظار انتهاء postback الدخول
    const t0 = Date.now();
    while (Date.now() - t0 < cfg.TIMEOUT.LOGIN) {
      const still = await pg.locator('#UsernameLog').count().catch(() => 0);
      if (!still) break;
      await wait(cfg.DELAY.DIALOG_POLL);
    }
    await wait(cfg.DELAY.PAGE_LOAD);
    await checkForProtection(pg);
    if (isProtectionActive()) throw new ProtectionError('تم اكتشاف حماية أثناء تسجيل الدخول — إيقاف مؤقت');
  }

  await pg.goto(cfg.ARKKAN_TRAINEE_URL, { waitUntil: 'domcontentloaded', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
  let fr = await findTraineeFrame(pg, '#firstName', cfg.DELAY.PAGE_LOAD * 3);
  if (!fr) {
    // انتهت الجلسة بعد الدخول؟ محاولة واحدة إضافية
    if (await pg.locator('#UsernameLog').count()) {
      await pg.fill('#UsernameLog', creds.user);
      await pg.fill('#Password', creds.pass);
      await pg.click('#btn_submitEnter');
      await wait(cfg.DELAY.PAGE_LOAD);
      await pg.goto(cfg.ARKKAN_TRAINEE_URL, { waitUntil: 'domcontentloaded', timeout: cfg.TIMEOUT.LOGIN }).catch(() => {});
      fr = await findTraineeFrame(pg, '#firstName', cfg.DELAY.PAGE_LOAD * 3);
    }
    if (!fr) {
      await checkForProtection(pg);
      throw new FrameError('تعذّر فتح نموذج "اضافة طلب متدرب" في بوابة الحقيبة');
    }
  }
  return { ctx, pg, fr, dialog, xhr };
}

/* الاعتمادات: البيئة/ملف .env أولاً، ثم جسم الطلب (بحسب ما يقدمه البرنامج).
   لا تُسجَّل كلمة المرور في أي سجل. */
function traineeCredentials(body) {
  const envUser = String(cfg.ARKKAN_USER || '').trim();
  const envPass = String(cfg.ARKKAN_PASS || '');
  const b = (body && body.credentials) || {};
  const user = String(b.user || '').trim();
  const pass = String(b.pass || '');
  const finalUser = envUser || user;
  const finalPass = envPass || pass;
  if (!finalUser || !finalPass) {
    throw new ValidationError('بيانات حساب بوابة الحقيبة غير مضبوطة — ضع ARKKAN_USER/ARKKAN_PASS في ملف .env أو أدخل بيانات الحساب في تبويب "مزامنة أركان" بالبرنامج');
  }
  return { user: finalUser, pass: finalPass };
}

/* مطابقة جنسية البرنامج (مفتاح إنجليزي أو اسم عربي) مع كود أركان.
   الرقم وحده يُقبل كما هو. لا يرسل أبداً جنسية غير معروفة. */
function resolveNationalityCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{1,4}$/.test(s)) return s;
  const key = s.replace(/\s+/g, ' ').toLowerCase();
  return cfg.TRAINEE.NATIONALITIES[key] || null;
}

/* بحث عن حقل في الإطار الرئيسي أو أي إطار (النموذج قد يُفتح داخل iframe) */
async function findTraineeFrame(pg, sel, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const fr of pg.frames()) {
      if (fr.isDetached()) continue;
      try { if (await fr.locator(sel).count()) return fr; } catch {}
    }
    await wait(cfg.DELAY.FRAME_WAIT);
  }
  return null;
}

/* تصنيف نتيجة الإرسال من نص التأكيد/الرفض الظاهر على الموقع.
   ملاحظة: رسالة النجاح الفعلية في بوابة الحقيبة هي
   "تم تنفيذ طلبك بنجاح" — نلتقطها بمؤشر "بنجاح" مع حارس يمنع
   التصنيف الناجح لو النص يحمل نفي (فشل/لم يتم/خطأ...). */
function classifyTraineeResult(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const negative = ['لم يتم', 'لم تتم', 'لم تنجح', 'فشل', 'غير ناجح', 'غير مكتمل', 'خطا', 'خطأ', 'لا يمكن', 'يرجى التأكد', 'تعذر'];
  if (negative.some(w => t.includes(w))) return null;
  const dup = ['موجود', 'مكرر', 'مسجل مسبق', 'مسجّل مسبق', 'مسجل سابقا', 'مسجّل سابقاً', 'سبق تسجيله', 'مسبقا', 'مسبقاً', 'بالفعل', 'already', 'موجودة'];
  if (dup.some(w => t.includes(w))) return { status: 'duplicate', message: text };
  const ok = ['بنجاح', 'تمت الاضافة', 'تمت الإضافة', 'تم الاضافة', 'تم اضافة', 'تم الحفظ', 'تم حفظ', 'تم التسجيل', 'تم تسجيل', 'تم بنجاح', 'success', 'ناجح'];
  if (ok.some(w => t.includes(w))) return { status: 'submitted', message: text };
  return null;
}

/* قراءة رسالة الإرسال من الـ DOM — بوابة الحقيبة تعرضها عبر SweetAlert v1
   (عنصر .sweet-alert يُضاف للمستند لحظة ظهوره ثم يختفي تلقائياً بعده ثانيتين)،
   مع بدائل swal2 والتحقق وأي toast عام — نمسح كل الإطارات. */
async function readVisibleSubmitMsg(pg) {
  for (const fr of pg.frames()) {
    if (fr.isDetached()) continue;
    const t = await fr.evaluate(() => {
      const sels = [
        '.sweet-alert',
        '.swal2-popup',
        '.swal2-title',
        '.swal2-html-container',
        '.toastyDialog_msgContainer',
        '[id^="toastyDialog_"]',
        '[class*="toast"]',
        '[class*="alert-success"]',
        '[class*="alert-danger"]',
      ];
      for (const el of document.querySelectorAll(sels.join(','))) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
        const t2 = (el.innerText || '').trim();
        if (t2) return t2;
      }
      return '';
    }).catch(() => '');
    if (t) return t;
  }
  return '';
}

/* انتظار نتيجة الإرسال. مصادر النتيجة بالترتيب:
   1) رد السيرفر المباشر (XHR addtrainee) — check + retmas الرسميين.
   2) رسالة SweetAlert / التحقق في الـ DOM.
   3) أي نافذة JS أصلية (alert/confirm) عبر getDialog().
   عند وصول رد السيرفر بنجاح (check=1) نقرر فوراً دون انتظار. */
async function waitTraineeResult(pg, opts) {
  const t0 = Date.now();
  let lastToast = '';
  let rawRetmas = '';
  let softCap = 0;
  while (Date.now() - t0 < cfg.TIMEOUT.SUBMIT) {
    if (softCap && Date.now() >= softCap) break;
    const x = opts && opts.getXhr ? opts.getXhr() : null;
    if (x && x.retmas && !rawRetmas) { rawRetmas = x.retmas; softCap = Date.now() + 6000; }
    let toast = await readVisibleSubmitMsg(pg);
    if (!toast && x && x.retmas) toast = x.retmas;
    const native = opts && opts.getDialog ? opts.getDialog() : '';
    if (native) toast = toast ? toast + ' | ' + native : native;
    if (toast) lastToast = toast;
    if (x && String(x.check) === '1') return { status: 'submitted', message: x.retmas, toast: toast || '', check: String(x.check) };
    const cls = classifyTraineeResult(toast);
    if (cls) return { ...cls, toast: toast || '', check: x ? String(x.check) : '' };
    await checkForProtection(pg);
    if (isProtectionActive()) throw new ProtectionError('تم اكتشاف حماية أثناء إرسال الطلب — إيقاف مؤقت');
    await wait(cfg.DELAY.DIALOG_POLL);
  }
  return {
    status: 'unknown',
    message: rawRetmas ? ('؟ غير مألوف من السيرفر: ' + rawRetmas.slice(0, 200)) : 'لم يظهر تأكيد/رفض خلال المهلة — راجع اللقطة المرفقة',
    toast: lastToast,
    retmas: rawRetmas,
  };
}

/* لقطة للنتيجة — للمراجعة اليدوية عند أي شك */
function saveSubmitShot(pg, idMask) {
  try {
    fs.mkdirSync(SUBMIT_SHOT_DIR, { recursive: true });
    const safe = String(idMask).replace(/[^A-Za-z0-9._-]/g, '_');
    const file = path.join(SUBMIT_SHOT_DIR, `submit-${Date.now()}-${safe}.png`);
    return pg.screenshot({ path: file, fullPage: false }).then(() => file).catch(() => '');
  } catch { return Promise.resolve(''); }
}

async function submitTraineeRequest(body) {
  const idResult = validateClientId(body.clientId);
  if (!idResult.valid) throw new ValidationError(idResult.reason);
  const name = String(body.name || '').trim();
  if (!name) throw new ValidationError('اسم المتدرب مطلوب');
  const natCode = resolveNationalityCode(body.nationality);
  if (!natCode) throw new ValidationError('الجنسية غير معروفة في أركان: ' + String(body.nationality || '—').slice(0, 40));
  const phone = String(body.phone || '').trim();
  const creds = traineeCredentials(body);

  const idenType = natCode === cfg.TRAINEE.SAUDI_CODE ? cfg.TRAINEE.IDEN_SAUDI : cfg.TRAINEE.IDEN_RESIDENT;
  const empty = cfg.TRAINEE.NAME_EMPTY_FILL;

  const { ctx, pg, fr, dialog, xhr } = await openTraineePage(creds);
  try {
    // تعديل الحقول بحسب قرارات المستخدم:
    //   الاسم كاملاً في الخانة الأولى والثلاث الأخرى مسافة واحدة فقط
    //   النوع = ذكر دائماً، نوع الهوية تلقائي حسب الجنسية
    //   البلدية = "أمانة منطقة الرياض -- بلدية الخرج"
    //   الرخصة/رقم السجل تُترك فارغة
    await fr.fill('#firstName', name);
    await fr.fill('#secoundName', empty);
    await fr.fill('#thirdName', empty);
    await fr.fill('#familyName', empty);
    await fr.selectOption('#type', cfg.TRAINEE.GENDER);
    await fr.selectOption('#iden_type', idenType);
    await fr.fill('#iden_Num', idResult.value);
    await fr.selectOption('#Nat', natCode);
    await fr.selectOption('#allcity', cfg.TRAINEE.CITY_VALUE);
    await fr.fill('#phone', phone);

    if (dialog) dialog.clear();
    if (xhr) xhr.clear();
    log.info(`رفع طلب: client=${maskId(idResult.value)} name=${mask(name, 2)} nat=${natCode} type=${idenType}`);
    await fr.click('#btn_add11');

    const res = await waitTraineeResult(pg, {
      getDialog: () => (dialog ? dialog.read() : ''),
      getXhr: () => (xhr ? xhr.read() : null),
    });
    const shot = await saveSubmitShot(pg, maskId(idResult.value));
    log.info(`رفع طلب: msg=${String(res.message || res.toast || '').slice(0, 80)}`);
    log.clientResult(idResult.value, 'submit', res.status);
    return {
      status: res.status,
      message: res.message,
      toast: res.toast || '',
      screenshot: shot,
      submittedAt: new Date().toISOString(),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ══════════════════════════════════════════════
   Smart Refresh (المتصفح → صفحة فارغة → أركان)
   ══════════════════════════════════════════════ */
async function smartRefresh(pg) {
  try {
    await pg.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    return await ensureDetailsFrame(pg);
  } catch (e) {
    log.warn('smartRefresh failed:', (e.message || '').slice(0, 200));
    return null;
  }
}

/* ══════════════════════════════════════════════
   Browser Initialization
   ══════════════════════════════════════════════ */
async function initBrowser() {
  if (!playwright) throw new Error('مكتبة playwright غير مثبتة — شغّل: npm install playwright && npx playwright install chromium');
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _workers = []; _ready = false; }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // headless:true ثابت أصلاً، بس على بعض أجهزة ويندوز بيظهر باگ معروف في Chromium
      // (chrome-headless-shell) بيفتح نافذة حقيقية رغم إنه headless فعليًا من ناحية
      // الرندر. الحل: نجبر أي نافذة ممكن تتفتح إنها تطلع برّه حدود الشاشة تمامًا
      // بإحداثيات سالبة كبيرة، فمتبقاش ظاهرة للمستخدم مهما حصل.
      _browser = await playwright.chromium.launch({
        headless: true,
        args: ['--window-position=-32000,-32000', '--window-size=1,1']
      });
      for (let i = 0; i < cfg.MAX_WORKERS; i++) {
        const ctx = await _browser.newContext();
        blockHeavyResources(ctx);
        const pg = await ctx.newPage();
        const fr = await ensureDetailsFrame(pg);
        if (!fr) throw new Error('تعذّر الوصول لصفحة تفاصيل المتدرب');
        _workers.push({ page: pg, ctx });
      }
      _ready = true;
      log.info(`✅ جاهز — ${_workers.length} عامل. المنفذ: ${cfg.AGENT_PORT}`);
      return;
    } catch (e) {
      log.warn(`محاولة ${attempt}/3 فشلت:`, (e.message || '').slice(0, 300));
      await _browser?.close().catch(() => {});
      _browser = null; _workers = []; _ready = false;
      if (attempt < 3) await wait(3000);
    }
  }
  throw new Error('تعذّر تهيئة أركان بعد 3 محاولات — تحقق من الإنترنت والوصول لموقع أركان');
}

function ensureInit() {
  if (_ready) return Promise.resolve();
  return initBrowser();
}

/* ══════════════════════════════════════════════
   Page Selection (Round-Robin)
   ══════════════════════════════════════════════ */
let _rr = 0;
function pickPage() {
  if (!_workers.length) return null;
  _rr = (_rr + 1) % _workers.length;
  return _workers[_rr].page;
}

/* ══════════════════════════════════════════════
   Status
   ══════════════════════════════════════════════ */
function getStatus() {
  const mu = process.memoryUsage();
  return {
    ready: !!(_ready && _browser && _workers.length),
    playwrightInstalled: !!playwright,
    workers: _workers.length,
    maxWorkers: cfg.MAX_WORKERS,
    protectionActive: isProtectionActive(),
    queuePending: _jobQueue.pending,
    queueActive: _jobQueue.active,
    memory: {
      nodeRssMB: Math.round(mu.rss / 1024 / 1024),
      freeMB: Math.round(os.freemem() / 1024 / 1024),
      totalMB: Math.round(os.totalmem() / 1024 / 1024),
    },
  };
}

/* ══════════════════════════════════════════════
   Timeout Wrapper
   ══════════════════════════════════════════════ */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`انتهت مهلة الجلب من أركان (أكثر من ${Math.round(ms / 1000)} ثانية)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* ══════════════════════════════════════════════
   HTTP Server
   ══════════════════════════════════════════════ */
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  // CORS آمن: فقط من localhost أو Electron
  const origin = req.headers.origin || '';
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  res.setHeader('Access-Control-Allow-Origin', isLocal ? origin : cfg.CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // الإيقاف الذاتي: أي طلب وظيفي يلغي مؤقت الخروج (نشاط جديد)، وطلبات
  // status/ping لا تُبقي الوكيل حياً ولا تعيد تسليح المؤقت.
  const isIdleSafeQuery = url === '/api/arkkan/status' || url === '/ping';
  if (!isIdleSafeQuery) cancelIdleExit();
  res.once('finish', () => { if (!isIdleSafeQuery) scheduleIdleExit(); });

  try {
    // ── Status ──
    if (url === '/api/arkkan/status' && req.method === 'GET') {
      return sendJson(res, 200, getStatus());
    }

    // ── Warm ──
    if (url === '/api/arkkan/warm' && req.method === 'POST') {
      try {
        await withTimeout(ensureInit(), cfg.TIMEOUT.WARM);
        return sendJson(res, 200, getStatus());
      } catch (e) {
        return sendJson(res, 503, { error: e.message, ...getStatus() });
      }
    }

    // ── Fetch Client Data ──
    if (url === '/api/arkkan/fetch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idResult = validateClientId(body.clientId);
      if (!idResult.valid) return sendJson(res, 400, { error: idResult.reason });

      // فحص الحماية
      if (isProtectionActive()) {
        return sendJson(res, 429, {
          error: 'تم اكتشاف حماية خارجية — إيقاف مؤقت',
          retryAfter: Math.round((_protectionUntil - Date.now()) / 1000),
        });
      }

      try {
        await ensureInit();
        const pg = pickPage();
        if (!pg) throw new Error('المتصفح غير جاهز بعد');

        // استخدام Sequential Queue لضمان المعالجة المتسلسلة
        const data = await _jobQueue.enqueue({
          id: `fetch-${idResult.value}-${Date.now()}`,
          clientId: idResult.value,
          action: 'fetch',
          fn: () => withTimeout(
            fetchClientData(pg, {
              clientId: idResult.value,
              referNum: String(body.referNum || '').trim(),
            }),
            cfg.TIMEOUT.FETCH
          ),
        });

        return sendJson(res, 200, data);
      } catch (e) {
        if (isProtectionError(e)) {
          return sendJson(res, 429, { error: e.message });
        }
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    // ── Fetch RefNum Only (الرقم المرجعي من منصة إدارة النظام بالهوية فقط) ──
    // زر مستقل في شريط التحديد الجماعي بشيت العملاء — لا يتداخل مع جلب البيانات.
    if (url === '/api/arkkan/refnum' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idResult = validateClientId(body.clientId);
      if (!idResult.valid) return sendJson(res, 400, { error: idResult.reason });

      if (isProtectionActive()) {
        return sendJson(res, 429, {
          error: 'تم اكتشاف حماية خارجية — إيقاف مؤقت',
          retryAfter: Math.round((_protectionUntil - Date.now()) / 1000),
        });
      }

      try {
        const basesCreds = (body && body.basesCreds) || {};
        const user = String(basesCreds.user || '').trim();
        const pass = String(basesCreds.pass || '');
        if (!user || !pass) {
          return sendJson(res, 400, { error: 'ضع بيانات حساب منصة إدارة النظام في تبويب «مزامنة أركان» أولاً' });
        }

        await ensureInit();
        const data = await _jobQueue.enqueue({
          id: `refnum-${idResult.value}-${Date.now()}`,
          clientId: idResult.value,
          action: 'refnum',
          fn: () => withTimeout(
            fetchBasesRefNum({ clientId: idResult.value, creds: { user, pass } }),
            cfg.TIMEOUT.REFNUM
          ),
        });

        return sendJson(res, 200, { clientId: idResult.value, refNum: data || '' });
      } catch (e) {
        if (isProtectionError(e)) {
          return sendJson(res, 429, { error: e.message });
        }
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    // ── Fetch Client Receipts (إيصالات الدورة + الحقيبة كـ PDF) ──
    if (url === '/api/arkkan/receipts' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idResult = validateClientId(body.clientId);
      if (!idResult.valid) return sendJson(res, 400, { error: idResult.reason });

      if (isProtectionActive()) {
        return sendJson(res, 429, {
          error: 'تم اكتشاف حماية خارجية — إيقاف مؤقت',
          retryAfter: Math.round((_protectionUntil - Date.now()) / 1000),
        });
      }

      try {
        await ensureInit();
        const pg = pickPage();
        if (!pg) throw new Error('المتصفح غير جاهز بعد');

        const data = await _jobQueue.enqueue({
          id: `receipts-${idResult.value}-${Date.now()}`,
          clientId: idResult.value,
          action: 'receipts',
          fn: () => withTimeout(
            fetchClientReceipts(pg, {
              clientId: idResult.value,
              referNum: String(body.referNum || '').trim(),
            }),
            cfg.TIMEOUT.RECEIPTS
          ),
        });

        return sendJson(res, 200, data);
      } catch (e) {
        if (isProtectionError(e)) {
          return sendJson(res, 429, { error: e.message });
        }
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }
    if (url === '/api/arkkan/exams' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const idResult = validateClientId(body.clientId);
      if (!idResult.valid) return sendJson(res, 400, { error: idResult.reason });

      if (isProtectionActive()) {
        return sendJson(res, 429, {
          error: 'تم اكتشاف حماية خارجية — إيقاف مؤقت',
          retryAfter: Math.round((_protectionUntil - Date.now()) / 1000),
        });
      }

      try {
        await ensureInit();
        const pg = pickPage();
        if (!pg) throw new Error('المتصفح غير جاهز بعد');

        const data = await _jobQueue.enqueue({
          id: `exams-${idResult.value}-${Date.now()}`,
          clientId: idResult.value,
          action: 'exams',
          fn: () => withTimeout(
            fetchExamScoresOn(pg, {
              clientId: idResult.value,
              referNum: String(body.referNum || '').trim(),
            }),
            cfg.TIMEOUT.FETCH
          ),
        });

        return sendJson(res, 200, data);
      } catch (e) {
        if (isProtectionError(e)) {
          return sendJson(res, 429, { error: e.message });
        }
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    // ── Submit Trainee Request (رفع طلب متدرب إلى بوابة الحقيبة) ──
    if (url === '/api/arkkan/submit-trainee' && req.method === 'POST') {
      const body = await readJsonBody(req);

      if (isProtectionActive()) {
        return sendJson(res, 429, {
          error: 'تم اكتشاف حماية خارجية — إيقاف مؤقت',
          retryAfter: Math.round((_protectionUntil - Date.now()) / 1000),
        });
      }

      try {
        await initBrowser();
        const result = await _jobQueue.enqueue({
          id: `submit-${Date.now()}`,
          clientId: String(body.clientId || ''),
          action: 'submit',
          fn: () => withTimeout(submitTraineeRequest(body), cfg.TIMEOUT.SUBMIT),
        });
        return sendJson(res, 200, result);
      } catch (e) {
        if (isProtectionError(e)) {
          return sendJson(res, 429, { error: e.message });
        }
        const status = e.code === 'VALIDATION_FAILED' ? 400 : (/playwright|chromium|متصفح/.test(e.message) ? 503 : 502);
        return sendJson(res, status, { error: e.message });
      }
    }

    // ── Ping ──
    if (url === '/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ready: _ready });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'خطأ غير متوقع' });
  }
});

/* ══════════════════════════════════════════════
   Start Server
   ══════════════════════════════════════════════ */
server.listen(cfg.AGENT_PORT, async () => {
  log.info(`\n${'═'.repeat(50)}`);
  log.info(`  🚀 Arkkan Agent — المنفذ ${cfg.AGENT_PORT}`);
  log.info(`${'═'.repeat(50)}\n`);
  try {
    await initBrowser();
  } catch (e) {
    console.error('❌ فشل فتح المتصفح عند البدء (يُعاد المحاولة تلقائياً):', e.message);
  }
  // لا يعمل الوكيل في الخلفية إلا عند الطلب: إذا لم يأتِ أي جلب/رفع خلال مهلة
  // الإقلاع يغلق نفسه بنفسه (كود خروج مميز 42 يوقفه Electron بدون إعادة تشغيل).
  scheduleIdleExit(Math.max(IDLE_EXIT_MS * 2, 60000));
});

process.on('SIGINT', async () => {
  log.info('🛑 إيقاف الـ agent...');
  await _browser?.close().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  // لا ن exited — نترك النظام يعمل
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});
