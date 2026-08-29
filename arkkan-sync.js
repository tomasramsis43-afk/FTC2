/**
 * arkkan-sync.js — FTC2 ↔ Arkkan Auto Sync
 * 
 * يجيب العملاء الناقصين من FTC2، يسحب بياناتهم من Arkkan،
 * ويرفعها مباشرة لـ FTC2 API.
 * 
 * تشغيل:
 *   node arkkan-sync.js
 * 
 * متطلبات:
 *   npm install playwright exceljs
 *   npx playwright install chromium
 */

const { chromium } = require('playwright');

// ═══════════════════════════════════════════════
//  إعدادات — عدّل هنا فقط
// ═══════════════════════════════════════════════
const FTC2_URL      = 'https://ftc2-z4av.onrender.com';
const FTC2_USER     = 'Tomas';
const FTC2_PASS     = '753956To';
const ARKKAN_PORTAL = 'https://arkkanapp.net/Bases/MainPage.aspx?url=98A7B2';
const ARKKAN_DOCBASE= 'https://arkkanapp.net/Documents/';
const HEADLESS      = true;   // false لو عايز تشوف المتصفح
const DELAY_BETWEEN = 3000;   // ms بين كل عميل وتاني
// ═══════════════════════════════════════════════

const wait = ms => new Promise(r => setTimeout(r, ms));

// ── حقول الـ client اللي نعتبرها "ناقصة" لو فاضية ──
function isMissing(c) {
  return !c.invoice       ||
         !c.courseNumber  ||
         !c.date          ||
         !c.coursePrice   ||
         !c.bagInvoice    ||
         !c.bagPurchaseDate ||
         !c.startDate;
}

// ── تسجيل الدخول لـ FTC2 والحصول على JWT ──
async function ftc2Login() {
  const res = await fetch(`${FTC2_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: FTC2_USER, password: FTC2_PASS })
  });
  if (!res.ok) throw new Error(`FTC2 login failed: ${res.status}`);
  const data = await res.json();
  const token = data.token || data.accessToken || data.jwt;
  if (!token) throw new Error('FTC2 login: no token in response');
  console.log('✅ تم تسجيل الدخول لـ FTC2');
  return token;
}

// ── جلب كل العملاء من FTC2 ──
async function ftc2GetClients(token) {
  const res = await fetch(`${FTC2_URL}/api/clients`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`FTC2 get clients failed: ${res.status}`);
  const data = await res.json();
  const clients = Array.isArray(data) ? data : (data.clients || data.data || []);
  console.log(`📋 إجمالي العملاء في FTC2: ${clients.length}`);
  return clients;
}

// ── تحديث عميل في FTC2 ──
async function ftc2UpdateClient(token, clientKey, fields) {
  // نحاول PATCH أولاً، لو مش موجود نجرب PUT
  const res = await fetch(`${FTC2_URL}/api/clients/${encodeURIComponent(clientKey)}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(fields)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`FTC2 update failed (${res.status}): ${txt.slice(0, 100)}`);
  }
  return res.json().catch(() => ({}));
}

// ── إغلاق أي dialog في Arkkan ──
function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

// ── سحب بيانات عميل واحد من Arkkan ──
async function fetchFromArkkan(pg, ctx, item) {
  const result = {
    invoice: '', courseNumber: '', date: '', coursePrice: '',
    bagInvoice: '', bagPurchaseDate: '', startDate: ''
  };

  let fr = pg.frames().find(ff => ff.url().includes('Arkan/frm8157'));
  if (!fr) throw new Error('فقدان إطار التفاصيل');

  // ── ملء الفلتر والبحث ──
  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', item.clientId);
  if (item.referNum) {
    await fr.fill('#ctl00_Student_id_fltr_Txt_ref', item.referNum).catch(() => {});
  }
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');
  await wait(4000);

  // انتظار ظهور نتائج الدورات
  let nC = 0;
  for (let t = 0; t < 8 && !nC; t++) {
    await wait(1000);
    nC = await fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').count();
  }
  const nB = await fr.locator('#ctl00_Training_bags_GridView1 tr.RowItems').count();
  console.log(`   دورات: ${nC} | حقائب: ${nB}`);

  // ── بيانات الدورة ──
  if (nC > 0) {
    const c0 = fr.locator('#ctl00_Courses_Students_GridView1 tr.RowItems').first();
    result.courseNumber = (await c0.locator('.Course_number').innerText().catch(() => '')).trim();
    result.startDate    = (await c0.locator('.Startdate').innerText().catch(() => '')).trim();

    // إيصال الدورة
    const clickedC = await fr.evaluate(() => {
      const rows = document.querySelectorAll('#ctl00_Courses_Students_GridView1 tr.RowItems');
      const el = rows[0]; if (!el) return false;
      const a   = el.querySelector('a');
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      const target = (a && (a.textContent || '').includes('الايصال')) ? a : inp;
      if (target) { target.click(); return true; }
      return false;
    });

    if (clickedC) {
      let recF = null;
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(ff => /\/Documents\//.test(ff.url()));
      }
      if (recF) {
        const txt = await recF.evaluate(() => document.body.innerText);
        result.invoice     = (txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1]?.trim() || '';
        result.coursePrice = (txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/)    || [])[1]?.trim() || '';
        // تاريخ الإيصال
        result.date        = (txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/)|| [])[1]?.trim() || '';
        await closeDialog(pg);
        await wait(1500);
        fr = pg.frames().find(ff => ff.url().includes('Arkan/frm8157'));
      }
    }
  }

  // ── بيانات الحقيبة ──
  if (nB > 0) {
    const clickedB = await fr.evaluate(() => {
      const rows = document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems');
      const el = rows[0]; if (!el) return false;
      const inp = [...el.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
      if (inp) { inp.click(); return true; }
      return false;
    });

    if (clickedB) {
      let recF = null;
      for (let t = 0; t < 20 && !recF; t++) {
        await wait(1000);
        recF = pg.frames().find(ff => /\/Documents\//.test(ff.url()));
      }
      if (recF) {
        const txt = await recF.evaluate(() => document.body.innerText);
        result.bagInvoice     = (txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1]?.trim() || '';
        result.bagPurchaseDate= (txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/)|| [])[1]?.trim() || '';
        await closeDialog(pg);
        await wait(1500);
      }
    }
  }

  return result;
}

// ════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════
(async () => {
  console.log('🚀 بدء Arkkan Sync...\n');

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
  const ctx     = await browser.newContext();
  const pg      = await ctx.newPage();

  let updated = 0, failed = 0;

  try {
    await pg.goto(ARKKAN_PORTAL, { waitUntil: 'domcontentloaded' });
    await wait(2500);
    await pg.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
      if (a) a.click();
    });
    await pg.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await wait(3500);

    for (let i = 0; i < missing.length; i++) {
      const c   = missing[i];
      const tag = `[${i + 1}/${missing.length}] ${c.clientId} — ${c.name || ''}`;
      console.log(tag);

      try {
        const fetched = await fetchFromArkkan(pg, ctx, c);

        // نبني object يحتوي فقط الحقول الناقصة
        const patch = {};
        if (!c.invoice        && fetched.invoice)        patch.invoice        = fetched.invoice;
        if (!c.courseNumber   && fetched.courseNumber)   patch.courseNumber   = fetched.courseNumber;
        if (!c.date           && fetched.date)           patch.date           = fetched.date;
        if (!c.coursePrice    && fetched.coursePrice)    patch.coursePrice    = parseFloat(fetched.coursePrice) || fetched.coursePrice;
        if (!c.bagInvoice     && fetched.bagInvoice)     patch.bagInvoice     = fetched.bagInvoice;
        if (!c.bagPurchaseDate&& fetched.bagPurchaseDate)patch.bagPurchaseDate= fetched.bagPurchaseDate;
        if (!c.startDate      && fetched.startDate)      patch.startDate      = fetched.startDate;

        if (Object.keys(patch).length === 0) {
          console.log(`   ⚠️  لم تُجلب أي بيانات من Arkkan`);
        } else {
          await ftc2UpdateClient(token, c.clientId, patch);
          updated++;
          console.log(`   ✅ تم التحديث:`, Object.keys(patch).join(', '));
        }
      } catch (e) {
        failed++;
        console.log(`   ❌ خطأ: ${e.message.slice(0, 120)}`);
      }

      if (i < missing.length - 1) await wait(DELAY_BETWEEN);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ تم تحديث: ${updated} عميل`);
  console.log(`❌ فشل:      ${failed} عميل`);
  console.log(`═`.repeat(50));
})();
