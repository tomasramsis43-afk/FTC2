/* ============================================================
   arkkan-fetch.js — جلب بيانات أركان من داخل الخادم نفسه
   ------------------------------------------------------------
   بديل الـ arkkan-agent الخارجي: الخادم يفتح متصفح Chromium مخفياً
   (Playwright) فيجلب بيانات عميل من منصة أركان — بلا الحاجة لأي
   برنامج منفصل، ويخدمها عبر مسارات API التي يستهلكها البرنامج مباشرة.

   المتطلبات (تُثبَّت مرة واحدة في مجلد server):
     npm install playwright
     npx playwright install chromium
   ============================================================ */

const wait = ms => new Promise(r => setTimeout(r, ms));
const path = require('path');

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

let _browser = null;
let _page = null;
let _ready = false;
let _queue = Promise.resolve();   // طابور: صفحة واحدة مشتركة — الطلبات تتسلسل

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

/* جلب بيانات عميل واحد من صفحة تفاصيل المتدرب المفتوحة. */
async function fetchClientData({ clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', startDate: ''
  };

  const pg = _page;
  if (!pg) throw new Error('المتصفح غير جاهز بعد');

  let fr = await ensureDetailsFrame(pg);
  if (!fr) throw new Error('تعذّر فتح صفحة تفاصيل المتدرب في أركان');

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', String(clientId));
  if (referNum) await fr.fill('#ctl00_Student_id_fltr_Txt_ref', String(referNum)).catch(() => {});
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');
  await wait(4000);

  let nC = 0;
  for (let t = 0; t < 8 && !nC; t++) {
    await wait(1000);
    nC = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count();
  }
  const nB = await fr.locator('#ctl00_Training_bags_GridView1 tr.RowItems').count();

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
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f));
      }
      if (!recF) break;

      const txt = await recF.evaluate(() => document.body.innerText);
      result.invoice     = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
      result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d.,]/g, '').trim();
      result.date        = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();
      await closeDialog(pg);
      await wait(1500);
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
          return inp ? i : null;
        })
        .filter(i => i !== null);
    });

    let bagBest = { invoice: '', bagPurchaseDate: '' };
    for (const idx of bagRows) {
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
      for (let t = 0; t < 20 && !recFb; t++) {
        await wait(1000);
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

      await closeDialog(pg);
      await wait(1500);
    }

    result.bagInvoice = bagBest.invoice;
    result.bagPurchaseDate = bagBest.bagPurchaseDate;
  }

  return result;
}

/* تهيئة/إعادة تهيئة المتصفح وصفحة أركان. */
async function initBrowser() {
  if (!playwright) {
    throw new Error('مكتبة playwright غير مثبتة في السيرفر — شغّل أولاً: npm install playwright');
  }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _page = null; _ready = false; }

  _browser = await playwright.chromium.launch({
    headless: HEADLESS,
    // أوساط أمان متوافقة مع الحاويات/الاستضافة (Render): لا حاجة لـ /dev/shm،
    // ولا لامتيازات root-sandbox.
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const ctx = await _browser.newContext();
  _page = await ctx.newPage();

  await _page.goto(ARKKAN_URL, { waitUntil: 'domcontentloaded' });
  await wait(2500);
  await _page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
    if (a) a.click();
  });
  await _page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await wait(3500);

  const fr = _page.frames().find(f => f.url().includes('Arkan/frm8157'));
  if (!fr) throw new Error('تعذّر الوصول لصفحة تفاصيل المتدرب — تحقق من الإنترنت والوصول لموقع أركان');

  _ready = true;
  console.log('✅ جاهزية أركان داخل السيرفر — متصفح مخفي مفتوح');
}

/* تشغيل مهمة كجزء من الطابور المتسلسل (صفحة مشتركة = لا توازٍ). */
function enqueue(fn) {
  const p = _queue.then(() => fn(), () => fn());
  _queue = p.catch(() => {});
  return p;
}

/* التأكد من الجاهزية (مع إعادة المحاولة لو انهار المتصفح). */
async function warm() {
  if (_browser && _page && _page.isClosed()) {
    _browser = null; _page = null; _ready = false;
  }
  if (_ready) return;
  await enqueue(initBrowser);
}

function fetchOne(payload) {
  return enqueue(async () => {
    if (!_ready) await initBrowser();
    return fetchClientData(payload);
  });
}

function getStatus() {
  return {
    ready: !!(_ready && _browser && _page && !_page.isClosed()),
    playwrightInstalled: !!playwright
  };
}

async function close() {
  await _browser?.close().catch(() => {});
  _browser = null; _page = null; _ready = false;
}

module.exports = { getStatus, warm, fetchOne, close };