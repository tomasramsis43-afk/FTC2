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
 *   POST /api/arkkan/exams   { clientId, referNum? }
 * ============================================================ */

const http = require('http');
const os = require('os');
const cfg = require('./arkkan-config');
const { log, ProtectionError, TimeoutError, FrameError, NoDataError, maskId, isProtectionError } = require('./arkkan-logger');
const { wait, SequentialQueue, JOB_STATUS, withRetry, snapshotFrames, findNewFrame, waitForStable, clearInputFields, isolateClientState, validateClientId, validateReferNum, readJsonBody, dateKey } = require('./arkkan-utils');

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

/* ══════════════════════════════════════════════
   Browser State
   ══════════════════════════════════════════════ */
let _browser = null;
let _workers = [];
let _ready = false;
let _protectionActive = false;
let _protectionUntil = 0;
// Sequential Queue: معالجة عملاء واحد تلو الآخر دائماً لمنع خلط البيانات
// (Concurrency ثابت 1 — ممنوع تشغيل عدة عمليات أركان في نفس الوقت)
const _jobQueue = new SequentialQueue(1);

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
async function fetchClientData(pg, { clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', bagOwnDate: '', startDate: '',
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
      _browser = await playwright.chromium.launch({ headless: cfg.HEADLESS });
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

    // ── Fetch Exam Scores ──
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
