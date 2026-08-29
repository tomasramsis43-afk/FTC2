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

  // إطارات الإيصالات الموجودة قبل الضغط — لنقرأ الإطار الجديد فقط لا القديم.
  const framesBefore = pg.frames().filter(f => /\/Documents\//.test(f.url()));

  // ── إيصال الدورة ──
  if (nC > 0) {
    const c0 = fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').first();
    result.courseNumber = (await c0.locator('.Course_number').innerText().catch(() => '')).trim();
    result.startDate    = (await c0.locator('.Startdate').innerText().catch(() => '')).trim();

    const clicked = await fr.evaluate(() => {
      const el = document.querySelector('#ctl00_Courses_Students_GridView1 tr.RowItems');
      if (!el) return false;
      const a = el.querySelector('a');
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      const t = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
      if (t) { t.click(); return true; }
      return false;
    });

    if (clicked) {
      let recF = null;
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesBefore.includes(f));
      }
      if (recF) {
        const txt = await recF.evaluate(() => document.body.innerText);
        result.invoice     = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
        result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d.,]/g, '').trim();
        result.date        = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();
        await closeDialog(pg);
        await wait(1500);
        fr = pg.frames().find(f => f.url().includes('Arkan/frm8157')) || await ensureDetailsFrame(pg);
      }
    }
  }

  // ── إيصال الحقيبة ──
  if (fr && nB > 0) {
    const clickedB = await fr.evaluate(() => {
      const el = document.querySelector('#ctl00_Training_bags_GridView1 tr.RowItems');
      if (!el) return false;
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      if (inp) { inp.click(); return true; }
      return false;
    });

    if (clickedB) {
      let recFb = null;
      for (let t = 0; t < 20 && !recFb; t++) {
        await wait(1000);
        recFb = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesBefore.includes(f));
      }
      if (recFb) {
        const txt = await recFb.evaluate(() => document.body.innerText);
        result.bagInvoice      = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
        result.bagPurchaseDate = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();
        await closeDialog(pg);
        await wait(1500);
      }
    }
  }

  return result;
}

/* تهيئة/إعادة تهيئة المتصفح وصفحة أركان. */
async function initBrowser() {
  if (!playwright) {
    throw new Error('مكتبة playwright غير مثبتة في السيرفر — شغّل أولاً: npm install playwright');
  }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _page = null; _ready = false; }

  _browser = await playwright.chromium.launch({ headless: HEADLESS });
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