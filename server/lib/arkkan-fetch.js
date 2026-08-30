/* ============================================================
   arkkan-fetch.js — جلب بيانات أركان من داخل الخادم نفسه
   ------------------------------------------------------------
   بديل الـ arkkan-agent الخارجي: الخادم يفتح متصفح Chromium مخفياً
   (Playwright) فيجلب بيانات عميل من منصة أركان — بلا الحاجة لأي
   برنامج منفصل، ويخدمها عبر مسارات API التي يستهلكها البرنامج مباشرة.

   التوازي: عدد صفحات العمالة = ARKKAN_CONCURRENCY (افتراضياً 2،
   ووضعه 1 يعيد السلوك التسلسلي القديم) — كل عامل في جلسة/كوكيز مستقلة
   عن غيره، يُسلسل طلباته داخلياً فقط، فلا تتداخل بيانات العملاء.

   المتطلبات (تُثبَّت مرة واحدة في مجلد server):
     npm install playwright
     npx playwright install chromium
   ============================================================ */

const wait = ms => new Promise(r => setTimeout(r, ms));
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

/* مفتاح رقمي للمقارنة الزمنية (يدعم YYYY/MM/DD و DD/MM/YYYY) لتحديد الأحدث */
function dateKey(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return m[3] + String(m[2]).padStart(2, '0') + String(m[1]).padStart(2, '0');
  return s;
}

/* مجلد المتصفح نضعه داخل node_modules نفسه ليعيش مع النشر (منصات مثل
   Render بتمسح الكاش الخارجي /opt/render/.cache فلا نعتمد عليه). لو
   عايز مسار مخصص حط المتغير ARKKAN_BROWSERS_PATH قبل التشغيل. */
process.env.PLAYWRIGHT_BROWSERS_PATH =
  process.env.ARKKAN_BROWSERS_PATH || path.join(__dirname, '..', 'node_modules', '.local-browsers');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { playwright = null; }

const ARKKAN_URL = 'https://arkkanapp.net/Bases/MainPage.aspx?url=98A7B2';
const HEADLESS = true;

/* درجة التوازي: كل عامل صفحة متصفح مستقلة في جلسة/كوكيز مستقلة — رقم أكبر = جلب
   أسرع، ووضعه 1 ليعود السلوك التسلسلي القديم. على الاستضافة محدودة الذاكرة
   (مثل خطة Render المجانية 512MB) نضبط الافتراضي حسب الذاكرة المتاحة تلقائياً:
     ذاكرة < 768MB  → 1 عامل (الأأمن، واطئ الذاكرة)
     ذاكرة < 1.5GB  → 2 عامل
     وإلا           → 4 عامل
   تجاوز يدوي بأي وقت عبر ARKKAN_CONCURRENCY (يُقيَّد بـ 1..4). */
function defaultWorkers() {
  const mb = os.totalmem() / (1024 * 1024);
  if (mb < 768) return 1;
  if (mb < 1536) return 2;
  return 4;
}
const MAX_WORKERS = Math.max(1, Math.min(4, parseInt(process.env.ARKKAN_CONCURRENCY || String(defaultWorkers()), 10) || defaultWorkers()));

/* أوساط إطلاق Chromium موفّرة للذاكرة (مهمة على الحاويات صغيرة الذاكرة):
   لا نوّلد عمليات/فروع زائدة، نوقف تحميل الإضافات والخلفيات، ونحدّ سقف
   ذاكرة JS لكل عملية حتى لا يرتفع الاستهلاك خارج الخطة. */
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-features=site-per-process',
  '--js-flags=--max-old-space-size=256'
];

/* إغلاق المتصفح تلقائياً بعد فترة خمول (حتى لا يظل Chromium مفتوحاً بلا داعٍ
   على الاستضافة). أثناء الجلب الجماعي الطلبات متتالية فلا يُغلق أبداً. */
const IDLE_MS = Math.max(10000, parseInt(process.env.ARKKAN_IDLE_MS || '120000', 10) || 120000);

let _browser = null;
let _ctx = null;
let _workers = [];               // [{ page, ctx, queue, busy, lastUse }] — عامل لكل صفحة وطابورها
let _ready = false;
let _initChain = Promise.resolve();  // تأمين تهيئة واحدة فقط عند أول طلب
let _rr = 0;                     // مؤشر توزيع الطلبات بالتناوب على العمالة
let _lastUsed = 0;               // آخر نشاط فعلي — لعتبة إغلاق الخمول

/* علي مدار الجلب نستخرج النصوص والجداول فقط — فلا حاجة لتحميل الصور والخطوط
   والوسائط وأوراق الأنماط (تستهلك ذاكرة ووقتاً بلا أي فائدة). منعها يخفّض
   استهلاك الذاكرة بشكل ملموس على الاستضافة الصغيرة ويسرّع الجلب نفسه. */
function blockHeavyResources(bx) {
  if (!bx || !bx.route) return;
  bx.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
    return route.continue().catch(() => {});
  }).catch(() => {});
}

/* إخفاء أي نوافذ toasty/تغطيات عالقة من جلسات سابقة تحجب النقرات
   (تتراكم مع الإيصالات ونوافذ الاختبارات على الخادم الذي يعمل طويلاً) */
function clearArkanDialogs(pg) {
  return pg.evaluate(() => {
    const els = document.querySelectorAll('.toastyDialog_msgContainer, .toastyDialog_msgMask, [id^="toastyDialog_"], #iframeSearch');
    for (const el of els) el.style.display = 'none';
  }).catch(() => {});
}

/* إغلاق نافذة الإيصال (لن نمسح حاويات الـ toastyDialog لأن هذا يكسر
   الـ plugin ويفشل الإيصال التالي — نضغط زر الإغلاق المخصص فقط). */
function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

/* التأكد من وجود إطار تفاصيل المتدرب (frm8157) — لو فُقد (انتهاء جلسة
   أو إعادة تحميل) نعيد الدخول إلى صفحة أركان ثم نفتح تفاصيل المتدرب. */
async function ensureDetailsFrame(pg) {
  let fr = pg.frames().find(f => f.url().includes('Arkan/frm8157'));
  if (fr) return fr;

  await pg.goto(ARKKAN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await wait(2500);
  await pg.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
    if (a) a.click();
  });
  await pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await wait(3500);
  return pg.frames().find(f => f.url().includes('Arkan/frm8157'));
}

/* ملء بيانات العميل والضغط على تأكيد والانتظار المتكيّف لحين تحميل شبكة
   الدورات — يعيد إطار تفاصيل المتدرب (fr) وعدد صفوف الدورات (nC) والحقائب (nB). */
async function loadStudent(pg, { clientId, referNum = '' }) {
  // تنظيف أي تغطيات عالقة من طلبات سابقة تحجب أزرار أركان قبل أي تفاعل
  await clearArkanDialogs(pg);
  let fr = await ensureDetailsFrame(pg);
  if (!fr) throw new Error('تعذّر فتح صفحة تفاصيل المتدرب في أركان');

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', String(clientId));
  if (referNum) await fr.fill('#ctl00_Student_id_fltr_Txt_ref', String(referNum)).catch(() => {});
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');

  // انتظار متكيّف: نراقب تغيّر بيانات شبكة الدورات بدل نوم ثابت 4 ثوانٍ
  // (الصفحة قابلة لإعادة الاستخدام، فقد تظهر بيانات العميل السابق وهمياً).
  // نقرأ الحالة القديمة فقط لو كانت القائمة فيها صفوف فعلاً (بلا انتظار بلا داعٍ).
  const hasBefore = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count();
  const before = hasBefore
    ? (await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems .Course_number').first().innerText({ timeout: 800 }).catch(() => '')).trim()
    : '';
  let nC = 0;
  const tC = Date.now();
  while (Date.now() - tC < 9000) {
    const rows = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count().catch(() => 0);
    if (rows === 0) {
      if (before) { nC = 0; break; } // اكتملت المعالجة والقائمة فارغة فعلاً
    } else {
      const now = (await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems .Course_number').first().innerText({ timeout: 1500 }).catch(() => '')).trim();
      if (!before || (now && now !== before)) { nC = rows; break; } // تحمّلت بيانات جديدة
    }
    await wait(250);
  }
  if (!nC) { await wait(1200); nC = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count().catch(() => 0); }
  const nB = await fr.locator('#ctl00_Training_bags_GridView1 tr.RowItems').count().catch(() => 0);
  return { fr, nC, nB };
}

/* جلب بيانات عميل واحد من صفحة تفاصيل المتدرب المفتوحة (pg = صفحة العامل). */
async function fetchClientData(pg, { clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', bagOwnDate: '', startDate: ''
  };

  if (!pg) throw new Error('المتصفح غير جاهز بعد');

  let { fr, nC, nB } = await loadStudent(pg, { clientId, referNum });

  // ── إيصال الدورة: نأخذ فقط سطر الدورة الذي يبدأ رقمه بـ FHD (رقم الدورة
  //    ورقم الفاتورة معاً). لو ما فيش سطر FHD نتبع السلوك القديم: أول سطر. ──
  if (nC > 0) {
    const courseRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')].map((r, i) => ({
        i,
        cn: (r.querySelector('.Course_number')?.innerText || '').trim(),
        start: (r.querySelector('.Startdate')?.innerText || '').trim()
      }));
    });

    const fhdRows = courseRows.filter(r => /^FHD/i.test(r.cn));
    const rowsToUse = fhdRows.length ? fhdRows : courseRows;

    for (const cr of rowsToUse) {
      result.courseNumber = cr.cn;
      result.startDate = cr.start;

      const clicked = await fr.evaluate((i) => {
        const el = document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems')[i];
        if (!el) return false;
        const a = el.querySelector('a');
        const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        const t = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
        if (t) { t.click(); return true; }
        return false;
      }, cr.i);
      if (!clicked) break;

      const framesNow = pg.frames().filter(f => /\/Documents\//.test(f.url()));
      let recF = null;
      for (let t = 0; t < 160 && !recF; t++) {
        await wait(120);
        recF = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f));
      }
      if (!recF) break;

      const txt = await recF.evaluate(() => document.body.innerText);
      result.invoice     = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
      result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d.,]/g, '').trim();
      result.date        = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();
      await closeDialog(pg);
      // ننتظر اختفاء إطار الإيصال — أسرع من نوم ثابت 1.5 ثانية
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && pg.frames().some(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f))) {
        await wait(150);
      }
      fr = pg.frames().find(f => f.url().includes('Arkan/frm8157')) || await ensureDetailsFrame(pg);

      // مع سطور FHD: الفاتورة لا تُقبل إلا إذا بدأت بـ FHD — وإلا نجرب السطر التالي
      if (fhdRows.length && !/^FHD/i.test(result.invoice)) {
        result.invoice = ''; result.coursePrice = ''; result.date = '';
        continue;
      }
      break;
    }
  }

  // ── إيصالات الحقيبة: قد يكون هناك أكثر من إيصال (حقيبتان مثلاً) —
  //    نفتح جميعها ونأخذ بيانات الأحدث (الأكبر تاريخاً) بكل حقولها. ──
  if (fr && nB > 0) {
    const bagRows = await fr.evaluate(() => {
      return [...document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')]
        .map((r, i) => {
          const inp = [...r.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
          if (!inp) return null;
          // خانة "نوع الصرف" = رابع عمود؛ صفوف الحقيبة الخاصة تظهر بنوع يحتوي "خاص/خصوصي"
          const type = (r.querySelector('td:nth-child(4)')?.innerText || '').trim();
          return { i, own: /خاص|خصوصي/.test(type) };
        })
        .filter(Boolean);
    });

    let bagBest = { invoice: '', bagPurchaseDate: '' };
    let bagOwnDate = '';
    for (const br of bagRows) {
      const idx = br.i;
      const clickedB = await fr.evaluate((i) => {
        const row = document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')[i];
        const inp = row && [...row.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        if (inp) { inp.click(); return true; }
        return false;
      }, idx);
      if (!clickedB) continue;

      // إطارات مفتوحة الآن → نقرأ الإطار الجديد فقط غير الموجود قبل
      const framesNow = pg.frames().filter(f => /\/Documents\//.test(f.url()));
      let recFb = null;
      for (let t = 0; t < 160 && !recFb; t++) {
        await wait(120);
        recFb = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f));
      }
      if (!recFb) continue;

      const txt = await recFb.evaluate(() => document.body.innerText);
      const inv = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
      const dt  = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();

      // الأحدث = الأكبر تاريخاً — نأخذه بكل بياناته (الرقم والتاريخ معاً)
      if (dt && dateKey(dt) > dateKey(bagBest.bagPurchaseDate)) {
        bagBest = { invoice: inv, bagPurchaseDate: dt };
      }
      // تاريخ إيصال الحقيبة الخاصة (صفوف نوعها "خاص/خصوصي") — نأخذ الأحدث منها
      if (br.own && dt && dateKey(dt) > dateKey(bagOwnDate)) {
        bagOwnDate = dt;
      }

      await closeDialog(pg);
      // ننتظر اختفاء إطار الإيصال — أسرع من نوم ثابت 1.5 ثانية
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && pg.frames().some(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f))) {
        await wait(150);
      }
    }

    result.bagInvoice = bagBest.invoice;
    result.bagPurchaseDate = bagBest.bagPurchaseDate;
    // تاريخ الحقيبة الخاصة: من صف نوعه "خاص"، وإلا نستعمل تاريخ أحدث إيصال حقيبة
    result.bagOwnDate = bagOwnDate || bagBest.bagPurchaseDate;
  }

  return result;
}

/* نتائج اختبارات عميل من صفحة frm8159 في أركان:
   - جدول "الاختبارات" = آخر اختبار (بتاريخه ونتيجته ودرجاته)
   - جدول "سجل اعادة الاختبارات" = المحاولات السابقة الراسخة (بلا تواريخ)
   نرتب المحاولات زمنياً (الإعادات ثم الأخير) ونعيد آخر 4 فقط + تاريخ آخر اختبار. */
async function fetchExamScoresOn(pg, { clientId, referNum = '' }) {
  const result = { attempts: [], lastDate: '', lastResult: '', lastGrade: '' };

  if (!pg) throw new Error('المتصفح غير جاهز بعد');

  await loadStudent(pg, { clientId, referNum });

  // زر "الاختبارات" قد يتأخر تحميله مع بعض العملاء (صفحة بطيئة/كثيفة) —
  // نراقبه لحظات قبل الحكم بعدم توفره، ليقل الفشل الوهمي في الجلب الجماعي.
  let fr = pg.frames().find(f => f.url().includes('Arkan/frm8157'));
  let clicked = false;
  for (let t = 0; t < 40 && !clicked; t++) {
    clicked = await (fr ? fr.evaluate(() => {
      const btn = [...document.querySelectorAll('input, button')].find(el =>
        (el.value || el.innerText || '').trim() === 'الاختبارات');
      if (btn) { btn.click(); return true; }
      return false;
    }) : Promise.resolve(false)).catch(() => false);
    if (!clicked) await wait(150);
  }
  if (!clicked) throw new Error('لا توجد صفحة اختبارات لهذا العميل في أركان — تأكد من صحة الرقم المرجعي أو من تسجيل دورة له في أركان');

  // نلاحق إطار نتائج الاختبارات الجديد فقط (غير الموجود قبل الضغط) حتى لا
  // نقرأ إطاراً قديماً عالقاً من عميل سابق؛ وإلا نأخذ آخر إطار متاح.
  const framesNow = pg.frames().filter(f => f.url().includes('frm8159'));
  let frT = null;
  for (let t = 0; t < 200 && !frT; t++) {
    await wait(120);
    frT = pg.frames().find(f => f.url().includes('frm8159') && !framesNow.includes(f));
  }
  if (!frT) frT = pg.frames().find(f => f.url().includes('frm8159'));
  if (!frT) throw new Error('تعذّر فتح صفحة نتائج الاختبارات في أركان');

  // الإطار قد يظهر قبل تحميل محتواه، وقد تُحمَّل الجداول تباعاً —
  // ننتظر ظهور البيانات (لا نكتفي بـ"ثبات فارغ")، وننهي مبكراً لو ظهرت
  // الجداول فعلاً بلا صفوف (العميل بلا اختبارات).
  const readGrids = () => frT.evaluate(() => {
    const rowsOf = (gv) => [...document.querySelectorAll(gv + ' tr.RowItems')]
      .map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()));
    return {
      exam:   rowsOf('#ctl00_Exam_master2_GridView1'), // [key, تاريخ, دورة, متدرب, نتيجة, درجات]
      retake: rowsOf('#ctl00_Exam_master3_GridView1'), // [key, متدرب, نتيجة, درجات]
      ready:  !!(document.getElementById('ctl00_Exam_master2_GridView1') || document.getElementById('ctl00_Exam_master3_GridView1'))
    };
  });

  let parsed = null;
  let last = null;
  let stable = 0;
  for (let t = 0; t < 60; t++) {
    parsed = await readGrids().catch(() => ({ exam: [], retake: [], ready: false }));
    const hasData = parsed.exam.length || parsed.retake.length;
    if (hasData) {
      const same = last &&
        JSON.stringify(parsed.exam) === JSON.stringify(last.exam) &&
        JSON.stringify(parsed.retake) === JSON.stringify(last.retake);
      stable = same ? stable + 1 : 0;
      last = { exam: parsed.exam, retake: parsed.retake };
      if (stable >= 2) break; // تكرّرت البيانات مرتين → اكتمل التحميل
    } else if (parsed.ready) {
      break; // الجداول ظهرت من غير صفوف → لا توجد اختبارات لهذا العميل
    }
    await wait(200);
  }
  if (!parsed) parsed = { exam: [], retake: [], ready: false };

  const attempts = [];
  for (const r of parsed.retake) attempts.push({ r: r[2], g: r[3], d: '' });
  for (const r of parsed.exam) attempts.push({ r: r[4], g: r[5], d: r[1].replace(/^تم\s+الاختبار\s+بتاريخ\s*/, '') });

  const last4 = attempts.slice(-4);
  result.attempts = last4;
  if (last4.length) {
    const last = last4[last4.length - 1];
    result.lastResult = last.r;
    result.lastGrade = last.g;
    result.lastDate = last.d || '';
  }

  // إغلاق نافذة الاختبارات (زر ×Close الذي يفتح فيه زر "إعادة الاختبارات" في حالة وجوده)
  await frT.evaluate(() => {
    const b = document.querySelector('button.close');
    if (b) b.click();
  }).catch(() => {});
  await wait(300);
  await clearArkanDialogs(pg); // تنظيف أي تغطيات خلفها النافذة ليبقى الاعتماد في الطلب التالي

  return result;
}

/* تهيئة/إعادة تهيئة المتصفح وصفحة أركان (وعوامل التوازي في الخلفية). */
async function initBrowser() {
  if (!playwright) {
    throw new Error('مكتبة playwright غير مثبتة في السيرفر — شغّل أولاً: npm install playwright');
  }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _ctx = null; _workers = []; _ready = false; }

  // لو متصفح Chromium لم يُنزّل أثناء البناء (فشل postinstall على الاستضافة مثل Render
  // — ملاحظة: install-browser الآن لا يوقف النشر، فيُعاد التنزيل هنا عند أول جلب)
  try {
    const exe = playwright.chromium.executablePath();
    if (exe && !fs.existsSync(exe)) {
      console.log('[arkkan] متصفح Chromium غير موجود — بدء التنزيل الآن (يستغرق دقائق)');
      execSync('npx playwright install chromium', { stdio: 'inherit', env: process.env });
    }
  } catch (e) {
    // لو فشل التنزيل هنا أيضاً، launch التالية تُظهر الخطأ الواضح
    console.warn('[arkkan] تعذّر التنزيل الفوري لـChromium:', (e.message || '').slice(0, 300));
  }

  _browser = await playwright.chromium.launch({
    headless: HEADLESS,
    args: BROWSER_ARGS
  });
  _ctx = await _browser.newContext();
  blockHeavyResources(_ctx);
  const page0 = await _ctx.newPage();
  pushWorker(page0, _ctx);

  await page0.goto(ARKKAN_URL, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  await page0.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
    if (a) a.click();
  });
  await page0.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await wait(3500);

  const fr = page0.frames().find(f => f.url().includes('Arkan/frm8157'));
  if (!fr) throw new Error('تعذّر الوصول لصفحة تفاصيل المتدرب — تحقق من الإنترنت والوصول لموقع أركان');

  _ready = true;
  console.log('✅ جاهزية أركان داخل السيرفر — متصفح مخفي مفتوح');

  // صفحات التوازي الإضافية تُبنى في الخلفية (فشلها لا يوقف العمل — الأساسي يكفي)
  spawnExtraPages().catch(e => console.error('[arkkan] تعذّر فتح صفحات التوازي:', e.message));
}

/* بناء صفحات التوازي الإضافية — كل عامل في سياق (كوكيز/جلسة) مستقل تماماً:
   أركان نظام ASP.NET يحتفظ بحالة "العميل الحالي" على مستوى الجلسة، فالمشاركة
   في نفس الجلسة كانت تُدخل بيانات عميل على عميل آخر. كل عامل يتصفح أركان
   بنفسه فينشئ جلسة تخصه، فلا تتداخل البيانات أبداً بين العمال. */
let _spawning = false;
async function spawnExtraPages() {
  if (_spawning) return;
  const need = Math.max(0, MAX_WORKERS - _workers.length);
  if (!need) return;
  _spawning = true;
  try {
    const results = await Promise.allSettled(Array.from({ length: need }, async () => {
      const bx = await _browser.newContext();
      blockHeavyResources(bx);
      const pg = await bx.newPage();
      try {
        if (!(await ensureDetailsFrame(pg))) throw new Error('لا إطار تفاصيل المتدرب');
        pushWorker(pg, bx);
      } catch (e) {
        await bx.close().catch(() => {});
        throw e;
      }
    }));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    console.log(`[arkkan] صفحات التوازي جاهزة: ${_workers.length}/${MAX_WORKERS} (فشل ${results.length - ok})`);
  } finally {
    _spawning = false;
  }
}

/* إضافة عامل (صفحة + سياقها) لتجمّع التوازي مع طابوره المستقل. */
function pushWorker(page, ctx) {
  if (_workers.some(w => w.page === page)) return;
  _workers.push({ page, ctx: ctx || _ctx, queue: Promise.resolve(), busy: 0, lastUse: Date.now() });
}

/* تشغيل مهمة على صفحة عامل محدد — كل عامل طابوره المتسلسل الخاص حتى لا تتعارض
   نقرات/تنقّلات صفحتين على نفس الصفحة؛ التوازي يتم بين صفحات مختلفة فقط.
   بند (busy) يتتبّع المهمات قيد التنفيذ حتى لا يغلقها حارس الذاكرة وهي مشغولة. */
function enqueueOn(page, fn) {
  let w = _workers.find(x => x.page === page);
  if (!w) { w = { page, ctx: _ctx, queue: Promise.resolve(), busy: 0, lastUse: Date.now() }; _workers.push(w); }
  w.lastUse = Date.now();
  const p = w.queue.then(() => {
    w.busy++;
    return fn();
  }, () => {
    w.busy++;
    return fn();
  }).finally(() => {
    w.busy--;
    w.lastUse = Date.now();
  });
  w.queue = p.then(() => {}, () => {});
  return p;
}

/* تقليص عدد العمال (إغلاق سياقات العمالة الخاملة) عند ضغط الذاكرة؛ لا نلمس
   العمال المشغولين ولا العامل الأساسي (page0 من _ctx). */
async function shrinkWorkers(n) {
  const idle = _workers
    .filter(w => w.busy === 0 && w.ctx !== _ctx)
    .sort((a, b) => a.lastUse - b.lastUse);
  const toClose = idle.slice(0, Math.max(0, _workers.length - n)).filter(w => w.page !== _workers[0]?.page);
  for (const w of toClose) {
    await w.ctx.close().catch(() => {});
    _workers = _workers.filter(x => x.page !== w.page);
  }
  if (toClose.length) console.log(`[arkkan] ضغط ذاكرة — تقليص العمالة إلى ${_workers.length}`);
}

/* حارس الذاكرة: كل 15 ثانية نراقب الذاكرة الفعلية. إذا انخفضت المساحة الحرة
   عن عتبة نخفض العمالة (بإغلاق السياقات الخاملة فقط)، وإذا تعافت نعيد فتح
   صفحات التوازي (بحد MAX_WORKERS) — كي لا يتوقف الجلب على 512MB بتاتاً. */
function memGuard() {
  if (!_ready || !_browser) return;
  const free = os.freemem();
  const total = os.totalmem();
  const ratio = free / total;
  if (ratio < 0.12 && _workers.length > 1) {
    shrinkWorkers(1).catch(() => {});
  } else if (ratio > 0.25 && _workers.length < MAX_WORKERS) {
    spawnExtraPages().catch(e => console.error('[arkkan] فشل إعادة فتح التوازي:', e.message));
  }
}
setInterval(memGuard, 15000).unref();

/* تأمين تهيئة واحدة فقط للمتصفح عند أول طلب (متزامنة بين عدة طلبات دفعة واحدة). */
function ensureInit() {
  if (_ready) return Promise.resolve();
  const p = _initChain.then(() => (_ready ? null : initBrowser()));
  _initChain = p.then(() => {}, () => {});
  return p;
}

/* اختيار صفحة عامل بالتناوب (توزيع الحمل المتساوي على العمالة الجاهزة). */
function pickPage() {
  if (!_workers.length) return null;
  _rr = (_rr + 1) % _workers.length;
  return _workers[_rr].page;
}

/* التأكد من الجاهزية (مع إعادة البناء الكاملة لو انهار أي جزء من المتصفح). */
async function warm() {
  const dead = (_browser && !_browser.isConnected()) || _workers.some(w => w.page.isClosed());
  if (dead) await close().catch(() => {});
  await ensureInit();
}

function fetchOne(payload) {
  return ensureInit().then(() => {
    const pg = pickPage();
    if (!pg) throw new Error('المتصفح غير جاهز بعد');
    _lastUsed = Date.now();
    return enqueueOn(pg, () => fetchClientData(pg, payload));
  });
}

/* جلب نتائج اختبارات عميل — على صفحة من تجمّع العمالة (توازٍ مع فحص واحد/جماعي). */
function fetchExamScores(payload) {
  return ensureInit().then(() => {
    const pg = pickPage();
    if (!pg) throw new Error('المتصفح غير جاهز بعد');
    _lastUsed = Date.now();
    return enqueueOn(pg, () => fetchExamScoresOn(pg, payload));
  });
}

function getStatus() {
  const p0 = _workers[0] && !_workers[0].page.isClosed() ? _workers[0].page : null;
  const mu = process.memoryUsage();
  return {
    ready: !!(_ready && _browser && p0),
    playwrightInstalled: !!playwright,
    workers: _workers.length,
    maxWorkers: MAX_WORKERS,
    memory: {
      nodeRssMB: Math.round(mu.rss / 1024 / 1024),
      freeMB: Math.round(os.freemem() / 1024 / 1024),
      totalMB: Math.round(os.totalmem() / 1024 / 1024)
    }
  };
}

async function close() {
  await _browser?.close().catch(() => {});
  _browser = null; _ctx = null; _workers = []; _ready = false;
}

/* مؤقّت إغلاق الخمول: كل 30 ثانية، إن لم تصل طلبات منذ IDLE_MS
   والمتصفح مفتوح نغلقه لتفريغ الذاكرة — يُعاد فتحه عند أول طلب تالٍ. */
setInterval(() => {
  if (_ready && _lastUsed && Date.now() - _lastUsed > IDLE_MS) {
    console.log('[arkkan] لا طلبات منذ فترة — إغلاق المتصفح لتخفيف الذاكرة');
    close().catch(() => {});
  }
}, 30000).unref();

module.exports = { getStatus, warm, fetchOne, fetchExamScores, close };