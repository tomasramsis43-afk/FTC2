/**
 * arkkan-sync.js — FTC2 ↔ Arkkan Auto Sync (نسخة محسّنة)
 * 
 * يجيب العملاء الناقصين من FTC2، يسحب بياناتهم من Аркан،
 * ويرفعها مباشرة لـ FTC2 API.
 * 
 * التحسينات:
 *  ├── Credentials من Environment Variables (لا يون موجودة في الكود)
 *  ├── Sequential Processing: عميل واحد في كل مرة
 *  ├── Client State Isolation: مسح الحالة الخصوصية
 *  ├── Retry مع Exponential Backoff
 *  ├── Protection Detection (403/429/CAPTCHA)
 *  ├── Logging آمن (إخفاء أرقام الهوية)
 *  ├── Configurable Delays من environment
 *  └── Job State لكل عميل
 * 
 * تشغيل:
 *   FTC2_USER=username FTC2_PASS=password node arkkan-sync.js
 * 
 * أو عبر ملف .env في نفس المجلد (اختياري)
 */

const { chromium } = require('playwright');
const cfg = require('./arkkan-config');
const { log, maskId, mask, ProtectionError, TimeoutError, FrameError, NoDataError, isRetryableError, isProtectionError } = require('./arkkan-logger');
const { wait, randomDelay, JOB_STATUS, withRetry, snapshotFrames, findNewFrame, waitForStable, isolateClientState, validateClientId, validateReferNum, dateKey, normalizeDate } = require('./arkkan-utils');

/* ── بيانات الاعتماد من Environment ──
   لا تضع أي كلمة مرور في الكود أبداً */
const FTC2_URL = cfg.FTC2_URL;
const FTC2_USER = process.env.FTC2_USER || cfg.FTC2_USER;
const FTC2_PASS = process.env.FTC2_PASS || cfg.FTC2_PASS;

if (!FTC2_USER || !FTC2_PASS) {
  console.error('❌ يجب ضبط FTC2_USER و FTC2_PASS كمتغيرات بيئة.');
  console.error('   مثال:');
  console.error('   $env:FTC2_USER="اسم_المستخدم"; $env:FTC2_PASS="كلمة_المرور"; node arkkan-sync.js');
  process.exit(1);
}

const ARKKAN_URL = cfg.ARKKAN_URL;
const ARKKAN_DOCBASE = cfg.ARKKAN_DOCBASE;
const HEADLESS = cfg.HEADLESS;
const DETAILS_FRAME_PATTERN = /Arkan\/frm8157/;
const DOCUMENTS_FRAME_PATTERN = /\/Documents\//;

/* ── حقول الـ client اللي نعتبرها "ناقصة" لو فاضية ── */
function isMissing(c) {
  return !c.invoice          ||
         !c.courseNumber     ||
         !c.receiptIssueDate ||
         !c.coursePrice      ||
         !c.bagInvoice       ||
         !c.bagPurchaseDate  ||
         !c.startDate;
}

/* ── تسجيل الدخول لـ FTC2 ── */
async function ftc2Login() {
  const res = await fetch(`${FTC2_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: FTC2_USER, password: FTC2_PASS }),
  });
  if (!res.ok) throw new Error(`FTC2 login failed: ${res.status}`);
  const data = await res.json();
  const token = data.token || data.accessToken || data.jwt;
  if (!token) throw new Error('FTC2 login: لا يوجد token في الاستجابة');
  log.info('✅ تم تسجيل الدخول لـ FTC2');
  return token;
}

/* ── جلب كل العملاء من FTC2 ── */
async function ftc2GetClients(token) {
  const res = await fetch(`${FTC2_URL}/api/clients`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`FTC2 get clients failed: ${res.status}`);
  const data = await res.json();
  const clients = Array.isArray(data) ? data : (data.clients || data.data || []);
  log.info(`📋 إجمالي العملاء في FTC2: ${clients.length}`);
  return clients;
}

/* ── تحديث عميل في FTC2 ── */
async function ftc2UpdateClient(token, clientKey, fields) {
  const res = await fetch(`${FTC2_URL}/api/clients/${encodeURIComponent(clientKey)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`FTC2 update failed (${res.status}): ${txt.slice(0, 100)}`);
  }
  return res.json().catch(() => ({}));
}

/* ── إغلاق أي dialog في Arkkan ── */
function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

/* ── سحب بيانات عميل واحد من Arkkan (مع State Isolation) ── */
async function fetchFromArkkan(pg, item) {
  const result = {
    invoice: '', courseNumber: '', date: '', coursePrice: '',
    bagInvoice: '', bagPurchaseDate: '', startDate: '',
    _validation: { clientId: item.clientId, referNum: item.referNum || '', timestamp: Date.now() },
  };

  log.clientFetch(item.clientId, item.referNum || '', 'fetchFromArkkan');

  let fr = pg.frames().find(ff => DETAILS_FRAME_PATTERN.test(ff.url()));
  if (!fr) throw new FrameError('فقدان إطار التفاصيل');

  // عزل حالة العميل السابق
  await isolateClientState(fr, pg);

  // ملء الفلتر مع التحقق من صحة المدخلات
  const idValidation = validateClientId(item.clientId);
  if (!idValidation.valid) throw new FrameError(idValidation.reason);
  const refValidation = validateReferNum(item.referNum);
  if (!refValidation.valid) throw new FrameError(refValidation.reason);

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', idValidation.value);
  if (refValidation.value) {
    await fr.fill('#ctl00_Student_id_fltr_Txt_ref', refValidation.value).catch(() => {});
  } else {
    // مسح صريح لحقل Reference Number لو العميل الجديد لا يملكه — منع خلط العملاء
    await fr.fill('#ctl00_Student_id_fltr_Txt_ref', '').catch(() => {});
  }
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');
  await wait(cfg.DELAY.PAGE_LOAD);

  // انتظار ظهور النتائج مع Timeout واضح
  let nC = 0;
  for (let t = 0; t < 8 && !nC; t++) {
    await wait(1000);
    nC = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count();
  }
  const nB = await fr.locator('#ctl00_Training_bags_GridView1 tr.RowItems').count();
  log.sensitive('coursetData', { clientId: item.clientId, courses: nC, bags: nB });

  // ── بيانات الدورة مع قاعدة FHD ──
  if (nC > 0) {
    // قراءة جميع الدورات وفلترة قاعدة FHD
    const courseRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')].map((r, i) => ({
        i,
        cn: (r.querySelector('.Course_number')?.innerText || '').trim(),
        start: (r.querySelector('.Startdate')?.innerText || '').trim(),
      }));
    });

    // الدورات FHD فقط
    const fhdRows = courseRows.filter(r => /^FHD/i.test(r.cn));

    for (const cr of fhdRows) {
      // لقطة الإطارات قبل فتح المستند
      const beforeDocFrames = snapshotFrames(pg, DOCUMENTS_FRAME_PATTERN);

      const clickedC = await fr.evaluate((i) => {
        const rows = document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems');
        const el = rows[i]; if (!el) return false;
        const a = el.querySelector('a');
        const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        const target = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
        if (target) { target.click(); return true; }
        return false;
      }, cr.i);

      if (clickedC) {
        // اكتشاف الإطار الجديد فقط
        const recF = await findNewFrame(pg, DOCUMENTS_FRAME_PATTERN, beforeDocFrames, cfg.DELAY.DOCUMENT_OPEN);
        if (recF) {
          const txt = await recF.evaluate(() => document.body.innerText);
          const inv = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
            .replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();

          // الشرط الثاني: رقم الفاتورة يبدأ بـ FHD
          if (/^FHD/i.test(inv)) {
            result.invoice = inv;
            result.courseNumber = cr.cn;
            result.startDate = cr.start;
            result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '')
              .replace(/[^\d.,]/g, '').trim();
            result.date = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '')
              .replace(/[^\d\/-]/g, '').trim();
            break;
          } else {
            log.warn(`دورة ${cr.cn} إيصالها غير FHD (${inv}) — تُترك فارغة`);
          }
        }
      }

      await closeDialog(pg);
      await wait(1500);
      fr = pg.frames().find(ff => DETAILS_FRAME_PATTERN.test(ff.url()));
    }
  }

  // ── بيانات الحقيبة ──
  if (nB > 0) {
    const bagRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')]
        .map((r, i) => {
          const inp = [...r.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
          if (!inp) return null;
          return { i, own: /خاص|خصوصي/.test((r.querySelector('td:nth-child(4)')?.innerText || '').trim()) };
        })
        .filter(Boolean);
    });

    let bagBest = { invoice: '', bagPurchaseDate: '' };
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

      await closeDialog(pg);
      await wait(1500);
    }

    result.bagInvoice = bagBest.invoice;
    result.bagPurchaseDate = bagBest.bagPurchaseDate;
  }

  log.sensitive('fetchComplete', { clientId: item.clientId, invoice: result.invoice, courseNumber: result.courseNumber });
  return validateFetched(result);
}

/* التحقق من صحة البيانات المستخرجة — لا نُسلّم قيماً غير مؤكدة/مشوّهة */
function validateFetched(result) {
  const issues = [];
  if (result.invoice && !/^[A-Za-z0-9\/\-]+$/.test(result.invoice)) issues.push('invoice: format invalid');
  if (result.coursePrice) {
    const numeric = parseFloat(String(result.coursePrice).replace(/[^\d.\-]/g, ''));
    if (isNaN(numeric) || numeric < 0) issues.push('coursePrice: not a valid number');
  }
  const dateFields = [['date', result.date], ['bagPurchaseDate', result.bagPurchaseDate], ['startDate', result.startDate]];
  for (const [field, value] of dateFields) {
    if (!value) continue;
    const parsed = new Date(value.includes('/') ? value.replace(/\//g, '-') : value);
    if (isNaN(parsed.getTime())) issues.push(`${field}: unreadable date`);
  }
  if (issues.length) {
    result._validation = { ...result._validation, status: 'VALIDATION_FAILED', issues };
    log.warn(`validation: ${JSON.stringify(issues)}`);
  } else {
    result._validation = { ...result._validation, status: 'SUCCESS', issues: [] };
  }
  return result;
}

/* ══════════════════════════════════════════════
   Main (Sequential Queue)
   ══════════════════════════════════════════════ */
(async () => {
  console.log('\n🚀 بدء Arkkan Sync...\n');

  try {
    // 1. Login لـ FTC2
    const token = await ftc2Login();

    // 2. جلب العملاء الناقصين
    const allClients = await ftc2GetClients(token);
    const missing = allClients.filter(c => c.clientId && isMissing(c));
    console.log(`🔍 عملاء ناقصين: ${missing.length}\n`);

    if (!missing.length) {
      console.log('✅ كل العملاء بياناتهم مكتملة!');
      return;
    }

    // 3. فتح Arkkan
    const browser = await chromium.launch({ headless: HEADLESS });
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();

    let updated = 0, failed = 0;
    const jobStates = {};

    try {
      await pg.goto(ARKKAN_URL, { waitUntil: 'domcontentloaded' });
      await wait(2500);
      await pg.evaluate(() => {
        const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
        if (a) a.click();
      });
      await pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await wait(3500);

      // Sequential Processing: عميل واحد في كل مرة
      for (let i = 0; i < missing.length; i++) {
        const c = missing[i];
        const clientKey = String(c.clientId);
        jobStates[clientKey] = JOB_STATUS.PENDING;
        const tag = `[${i + 1}/${missing.length}] ${maskId(c.clientId)} — ${c.name || ''}`;
        console.log(tag);

        // فحص الحماية قبل كل عميل
        try {
          const pageText = await pg.evaluate(() => document.body?.innerText || '').catch(() => '');
          const lower = pageText.toLowerCase();
          if (lower.includes('captcha') || lower.includes('access denied') || lower.includes('unusual security')) {
            const err = new ProtectionError('تم اكتشاف حماية خارجية — إيقاف المزامنة');
            err.isBlocked = true;
            throw err;
          }
        } catch (e) {
          if (e.isBlocked) { failed++; jobStates[clientKey] = JOB_STATUS.BLOCKED; break; }
        }

        jobStates[clientKey] = JOB_STATUS.PROCESSING;
        try {
          // مع Retry للأخطاء المؤقتة فقط
          const fetched = await withRetry(
            () => fetchFromArkkan(pg, c),
            { label: `fetch ${maskId(c.clientId)}`, clientId: c.clientId, maxAttempts: cfg.RETRY.MAX_ATTEMPTS }
          );

          // لا نُرسل بيانات لم تُجتَز التحقق — علامة validation_failed
          if (fetched._validation && fetched._validation.status === 'VALIDATION_FAILED') {
            jobStates[clientKey] = JOB_STATUS.VALIDATION_FAILED;
            failed++;
            console.log(`   ⚠️ فشل التحقق من بيانات أركان: ${(fetched._validation.issues || []).join('; ')}`);
          } else {
            // نبني object يحتوي فقط الحقول الناقصة
            const patch = {};
            if (!c.invoice && fetched.invoice)                     patch.invoice          = fetched.invoice;
            if (!c.courseNumber && fetched.courseNumber)           patch.courseNumber     = fetched.courseNumber;
            if (!c.receiptIssueDate && fetched.date)               patch.receiptIssueDate = normalizeDate(fetched.date);
            if (!c.coursePrice && fetched.coursePrice)             patch.coursePrice      = parseFloat(fetched.coursePrice) || fetched.coursePrice;
            if (!c.bagInvoice && fetched.bagInvoice)               patch.bagInvoice       = fetched.bagInvoice;
            if (!c.bagPurchaseDate && fetched.bagPurchaseDate)     patch.bagPurchaseDate  = normalizeDate(fetched.bagPurchaseDate);
            if (!c.startDate && fetched.startDate)                 patch.startDate        = normalizeDate(fetched.startDate);

            if (Object.keys(patch).length === 0) {
              jobStates[clientKey] = JOB_STATUS.NO_DATA;
              console.log(`   ⚠️  لم تُجلب أي بيانات من أركان`);
            } else {
              await ftc2UpdateClient(token, clientKey, patch);
              jobStates[clientKey] = JOB_STATUS.SUCCESS;
              updated++;
              console.log(`   ✅ تم التحديث:`, Object.keys(patch).join(', '));
            }
          }
        } catch (e) {
          if (isProtectionError(e)) {
            jobStates[clientKey] = JOB_STATUS.BLOCKED;
            failed++;
            console.log(`   ⛔ حماية خارجية — إيقاف`, e.message.slice(0, 120));
            break; // لا نستمر مع الحماية
          } else if (isRetryableError(e)) {
            jobStates[clientKey] = JOB_STATUS.RETRY_PENDING;
          } else if (e.code === 'VALIDATION_FAILED') {
            jobStates[clientKey] = JOB_STATUS.VALIDATION_FAILED;
          }
          failed++;
          console.log(`   ❌ خطأ: ${e.message.slice(0, 120)}`);
        }

        // توقيت قابل للضبط بين العملاء (نطاق عشوائي MIN→MAX من الإعدادات)
        if (i < missing.length - 1) await wait(randomDelay(cfg.DELAY.MIN, cfg.DELAY.MAX));
      }
    } finally {
      await browser.close().catch(() => {});
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`✅ تم تحديث: ${updated} عميل`);
    console.log(`❌ فشل:      ${failed} عميل`);
    console.log(`═`.repeat(50));
  } catch (e) {
    console.error('\n❌ خطأ رئيسي:', e.message);
    process.exitCode = 1;
  }
})();