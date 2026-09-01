/**
 * arkkan-agent.js — عميل أركان المحلي
 * ══════════════════════════════════════
 * سيرفر محلي على localhost:9955 يستقبل طلبات من FTC2
 * ويجلب البيانات من موقع أركان عبر Playwright.
 *
 * التشغيل:
 *   node arkkan-agent.js
 *
 * المتطلبات:
 *   npm install playwright
 *   npx playwright install chromium
 */

const http       = require('http');
const { chromium } = require('playwright');

const PORT        = 9955;
const ARKKAN_URL  = 'https://arkkanapp2.net/Bases/MainPage.aspx?url=98A7B2';
const HEADLESS    = true;

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════
//  إغلاق dialog أركان
// ══════════════════════════════════════
function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

// ══════════════════════════════════════
//  سحب بيانات عميل واحد
// ══════════════════════════════════════
async function fetchClientData(pg, { clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', startDate: ''
  };

  let fr = pg.frames().find(ff => ff.url().includes('Arkan/frm8157'));
  if (!fr) throw new Error('فقدان إطار التفاصيل — أعد تشغيل الـ agent');

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', clientId);
  if (referNum) await fr.fill('#ctl00_Student_id_fltr_Txt_ref', referNum).catch(() => {});
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');
  await wait(4000);

  let nC = 0;
  for (let t = 0; t < 8 && !nC; t++) {
    await wait(1000);
    nC = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count();
  }
  const nB = await fr.locator('#ctl00_Training_bags_GridView1 tr.RowItems').count();

  // بيانات الدورة
  if (nC > 0) {
    const c0 = fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').first();
    result.courseNumber = (await c0.locator('.Course_number').innerText().catch(() => '')).trim();
    result.startDate    = (await c0.locator('.Startdate').innerText().catch(() => '')).trim();

    // إيصال الدورة
    const clicked = await fr.evaluate(() => {
      const el  = document.querySelector('#ctl00_Courses_Students_GridView1 tr.RowItems');
      if (!el) return false;
      const a   = el.querySelector('a');
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      const t   = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
      if (t) { t.click(); return true; }
      return false;
    });

    if (clicked) {
      let recF = null;
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(ff => /\/Documents\//.test(ff.url()));
      }
      if (recF) {
        const txt = await recF.evaluate(() => document.body.innerText);
        result.invoice     = (txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/)  || [])[1]?.trim() || '';
        result.coursePrice = (txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/)     || [])[1]?.trim() || '';
        result.date        = (txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1]?.trim() || '';
        await closeDialog(pg);
        await wait(1500);
        fr = pg.frames().find(ff => ff.url().includes('Arkan/frm8157'));
      }
    }
  }

  // إيصال الحقيبة
  if (nB > 0) {
    const clicked = await fr.evaluate(() => {
      const el  = document.querySelector('#ctl00_Training_bags_GridView1 tr.RowItems');
      if (!el) return false;
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      if (inp) { inp.click(); return true; }
      return false;
    });

    if (clicked) {
      let recF = null;
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(ff => /\/Documents\//.test(ff.url()));
      }
      if (recF) {
        const txt = await recF.evaluate(() => document.body.innerText);
        result.bagInvoice     = (txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/)  || [])[1]?.trim() || '';
        result.bagPurchaseDate= (txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1]?.trim() || '';
        await closeDialog(pg);
        await wait(1500);
      }
    }
  }

  return result;
}

// ══════════════════════════════════════
//  تهيئة المتصفح وصفحة أركان
// ══════════════════════════════════════
let _browser = null, _page = null, _ready = false;

async function initBrowser() {
  console.log('🌐 فتح متصفح أركان...');
  _browser = await chromium.launch({ headless: HEADLESS });
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

  _ready = true;
  console.log('✅ أركان جاهز — الـ agent يستمع على http://localhost:' + PORT);
}

// ══════════════════════════════════════
//  HTTP Server
// ══════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // CORS للسماح لـ FTC2 (أي origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /ping — فحص الاتصال ──
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: _ready }));
    return;
  }

  // ── /fetch — جلب بيانات عميل ──
  if (req.url === '/fetch' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      if (!_ready) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'أركان غير جاهز بعد، انتظر لحظة' }));
        return;
      }
      try {
        const payload = JSON.parse(body);
        if (!payload.clientId) throw new Error('clientId مطلوب');
        const data = await fetchClientData(_page, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

// ══════════════════════════════════════
//  بدء التشغيل
// ══════════════════════════════════════
server.listen(PORT, async () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  🚀 Arkkan Agent — منفذ ${PORT}`);
  console.log(`${'═'.repeat(50)}\n`);
  try {
    await initBrowser();
  } catch (e) {
    console.error('❌ فشل فتح المتصفح:', e.message);
    _ready = false;
  }
});

process.on('SIGINT', async () => {
  console.log('\n🛑 إيقاف الـ agent...');
  await _browser?.close().catch(() => {});
  process.exit(0);
});
