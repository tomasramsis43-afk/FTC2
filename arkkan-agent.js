/**
 * arkkan-agent.js — عميل أركان المحلي
 * ══════════════════════════════════════════════════════════════
 * سيرفر HTTP محلي على localhost:9955 يفتح متصفح Chromium (Playwright)
 * ويجلب بيانات العملاء من موقع أركان، ليستخدمه برنامج FTC2 (الفرونت إند)
 * بدل ما يطلب من سيرفر Render فتح المتصفح (كان بيستهلك RAM الاستضافة
 * المجانية المحدودة 512MB ويسبب استقرار سيء / OOM).
 *
 * لازم يفضل شغال على أي جهاز هيستخدم تبويب "مزامنة أركان" في البرنامج.
 *
 * التشغيل:
 *   npm install playwright   (مرة واحدة بس على الجهاز ده)
 *   npx playwright install chromium
 *   node arkkan-agent.js
 *
 * نقاط النهاية (نفس مسارات الفرونت إند القديمة على Render، بس محلياً):
 *   GET  /api/arkkan/status
 *   POST /api/arkkan/warm
 *   POST /api/arkkan/fetch   { clientId, referNum? }
 *   POST /api/arkkan/exams   { clientId, referNum? }
 * ============================================================ */

const http = require('http');
const os = require('os');

const wait = ms => new Promise(r => setTimeout(r, ms));

let playwright = null;
try { playwright = require('playwright'); } catch (e) { playwright = null; }

const PORT = parseInt(process.env.ARKKAN_AGENT_PORT || '9955', 10);
const ARKKAN_URL = 'https://arkkanapp2.net/Bases/MainPage.aspx?url=98A7B2';
const HEADLESS = process.env.ARKKAN_HEADLESS !== 'false'; // ARKKAN_HEADLESS=false لو عايز تشوف المتصفح شغال

/* مفتاح رقمي للمقارنة الزمنية (يدعم YYYY/MM/DD و DD/MM/YYYY) لتحديد الأحدث */
function dateKey(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return m[3] + String(m[2]).padStart(2, '0') + String(m[1]).padStart(2, '0');
  return s;
}

/* على جهاز محلي مفيش داعي لمنع تحميل الصور — بس بنسيبها موقوفة برضو
   عشان تسريع الجلب (مش محتاجين نشوف الصفحة أصلاً، الجلب نصي وجداول فقط). */
function blockHeavyResources(bx) {
  if (!bx || !bx.route) return;
  bx.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
    return route.continue().catch(() => {});
  }).catch(() => {});
}

function clearArkanDialogs(pg) {
  return pg.evaluate(() => {
    const els = document.querySelectorAll('.toastyDialog_msgContainer, .toastyDialog_msgMask, [id^="toastyDialog_"], #iframeSearch');
    for (const el of els) el.style.display = 'none';
  }).catch(() => {});
}

function closeDialog(pg) {
  return pg.evaluate(() => {
    const btn = document.querySelector('.toastyDialog_closeBtn');
    if (btn) btn.click();
  }).catch(() => {});
}

async function ensureDetailsFrame(pg) {
  let fr = pg.frames().find(f => f.url().includes('Arkan/frm8157'));
  if (fr) return fr;

  await pg.goto(ARKKAN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  let clicked = false;
  const tA = Date.now();
  while (Date.now() - tA < 8000 && !clicked) {
    clicked = await pg.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').trim() === 'تفاصيل متدرب');
      if (a) { a.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) await wait(150);
  }

  const tB = Date.now();
  while (Date.now() - tB < 8000) {
    const f = pg.frames().find(x => x.url().includes('Arkan/frm8157'));
    if (f) return f;
    await wait(150);
  }
  return pg.frames().find(x => x.url().includes('Arkan/frm8157')) || null;
}

async function loadStudent(pg, { clientId, referNum = '' }) {
  await clearArkanDialogs(pg);
  let fr = await ensureDetailsFrame(pg);
  if (!fr) throw new Error('تعذّر فتح صفحة تفاصيل المتدرب في أركان');

  await fr.fill('#ctl00_Student_id_fltr_txtIdentityNo', String(clientId));
  if (referNum) await fr.fill('#ctl00_Student_id_fltr_Txt_ref', String(referNum)).catch(() => {});
  await fr.click('#ctl00_Student_id_fltr_btnConfirm');

  const readSig = () => fr.evaluate(() => {
    const txt = (sel) => [...document.querySelectorAll(sel)].map(r => r.innerText.trim());
    return {
      rowsC: txt('#ctl00_Courses_Students_GridView1 tr.RowItems'),
      rowsB: txt('#ctl00_Training_bags_GridView1 tr.RowItems')
    };
  }).catch(() => ({ rowsC: [], rowsB: [] }));

  const hasData = (sig) => sig.rowsC.length > 0 || sig.rowsB.length > 0;

  const waitStable = (timeoutMs) => new Promise(resolve => {
    let last = null, stable = 0;
    const t0 = Date.now();
    const tick = async () => {
      const sig = await readSig();
      const same = last && hasData(sig) &&
        JSON.stringify(sig.rowsC) === JSON.stringify(last.rowsC) &&
        JSON.stringify(sig.rowsB) === JSON.stringify(last.rowsB);
      stable = same ? stable + 1 : 0;
      last = sig;
      if ((stable >= 2 && hasData(last)) || Date.now() - t0 >= timeoutMs) { resolve(last); return; }
      setTimeout(tick, 250);
    };
    tick();
  });

  let sigStable = await waitStable(9000);
  if (!hasData(sigStable)) {
    await wait(700);
    sigStable = await waitStable(9000);
  }

  const nC = (sigStable && sigStable.rowsC.length) || 0;
  const nB = (sigStable && sigStable.rowsB.length) || 0;
  console.log(`[arkkan-agent] clientId=${clientId} — دورات: ${nC} | حقائب: ${nB}`);
  return { fr, nC, nB };
}

async function fetchClientData(pg, { clientId, referNum = '' }) {
  const result = {
    invoice: '', courseNumber: '', date: '',
    coursePrice: '', bagInvoice: '', bagPurchaseDate: '', bagOwnDate: '', startDate: ''
  };

  let { fr, nC, nB } = await loadStudent(pg, { clientId, referNum });

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
      if (!clicked) throw new Error(`تعذّر النقر على زر الإيصال للدورة (${cr.cn})`);

      const framesNow = pg.frames().filter(f => /\/Documents\//.test(f.url()));
      let recF = null;
      for (let t = 0; t < 300 && !recF; t++) {
        await wait(120);
        recF = pg.frames().find(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f));
      }
      if (!recF) throw new Error(`تعذّر فتح إيصال الدورة (${cr.cn}) بعد الانتظار — أعد المحاولة`);

      const txt = await recF.evaluate(() => document.body.innerText);
      result.invoice     = ((txt.match(/(?:Invoice No\.|رقم الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\x20-\x7E\u0600-\u06FF0-9]/g, ' ').trim();
      result.coursePrice = ((txt.match(/(?:Total Paid Fee|الاجمالي)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d.,]/g, '').trim();
      result.date        = ((txt.match(/(?:Invoice Date|تاريخ الفاتورة)\s*([^\t\n]+)/) || [])[1] || '').replace(/[^\d\/-]/g, '').trim();

      await closeDialog(pg);
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && pg.frames().some(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f))) {
        await wait(150);
      }
      fr = pg.frames().find(f => f.url().includes('Arkan/frm8157')) || await ensureDetailsFrame(pg);

      if (fhdRows.length && !/^FHD/i.test(result.invoice)) {
        result.invoice = ''; result.coursePrice = ''; result.date = '';
        continue;
      }
      break;
    }
  }

  if (nC > 0 && !result.invoice && !result.coursePrice) {
    throw new Error('تم العثور على دورات لهذا العميل لكن تعذّرت قراءة بيانات فاتورة الدورة من أركان — أعد المحاولة');
  }

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
      const idx = br.i;
      const clickedB = await fr.evaluate((i) => {
        const row = document.querySelectorAll('#ctl00_Training_bags_GridView1 tr.RowItems')[i];
        const inp = row && [...row.querySelectorAll('input')].find(x => x.value === 'الايصال' || x.value === 'الإيصال');
        if (inp) { inp.click(); return true; }
        return false;
      }, idx);
      if (!clickedB) continue;

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

      if (dt && dateKey(dt) > dateKey(bagBest.bagPurchaseDate)) {
        bagBest = { invoice: inv, bagPurchaseDate: dt };
      }
      if (br.own && dt && dateKey(dt) > dateKey(bagOwnDate)) {
        bagOwnDate = dt;
      }

      await closeDialog(pg);
      const t1 = Date.now();
      while (Date.now() - t1 < 5000 && pg.frames().some(f => /\/Documents\//.test(f.url()) && !framesNow.includes(f))) {
        await wait(150);
      }
    }

    result.bagInvoice = bagBest.invoice;
    result.bagPurchaseDate = bagBest.bagPurchaseDate;
    result.bagOwnDate = bagOwnDate || bagBest.bagPurchaseDate;
  }

  await smartRefresh(pg);
  return result;
}

async function fetchExamScoresOn(pg, { clientId, referNum = '' }) {
  const result = { attempts: [], lastDate: '', lastResult: '', lastGrade: '' };

  await loadStudent(pg, { clientId, referNum });

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

  const framesNow = pg.frames().filter(f => f.url().includes('frm8159'));
  let frT = null;
  for (let t = 0; t < 200 && !frT; t++) {
    await wait(120);
    frT = pg.frames().find(f => f.url().includes('frm8159') && !framesNow.includes(f));
  }
  if (!frT) frT = pg.frames().find(f => f.url().includes('frm8159'));
  if (!frT) throw new Error('تعذّر فتح صفحة نتائج الاختبارات في أركان');

  const readGrids = () => frT.evaluate(() => {
    const rowsOf = (gv) => [...document.querySelectorAll(gv + ' tr.RowItems')]
      .map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()));
    return {
      exam:   rowsOf('#ctl00_Exam_master2_GridView1'),
      retake: rowsOf('#ctl00_Exam_master3_GridView1'),
      ready:  !!(document.getElementById('ctl00_Exam_master2_GridView1') || document.getElementById('ctl00_Exam_master3_GridView1'))
    };
  });

  let parsed = null, last = null, stable = 0;
  for (let t = 0; t < 60; t++) {
    parsed = await readGrids().catch(() => ({ exam: [], retake: [], ready: false }));
    const hasData = parsed.exam.length || parsed.retake.length;
    if (hasData) {
      const same = last &&
        JSON.stringify(parsed.exam) === JSON.stringify(last.exam) &&
        JSON.stringify(parsed.retake) === JSON.stringify(last.retake);
      stable = same ? stable + 1 : 0;
      last = { exam: parsed.exam, retake: parsed.retake };
      if (stable >= 2) break;
    } else if (parsed.ready) {
      break;
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
    const lastA = last4[last4.length - 1];
    result.lastResult = lastA.r;
    result.lastGrade = lastA.g;
    result.lastDate = lastA.d || '';
  }

  await frT.evaluate(() => {
    const b = document.querySelector('button.close');
    if (b) b.click();
  }).catch(() => {});
  await wait(300);
  await clearArkanDialogs(pg);
  await smartRefresh(pg);

  return result;
}

async function smartRefresh(pg) {
  try {
    await pg.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    return await ensureDetailsFrame(pg);
  } catch (e) {
    console.warn('[arkkan-agent] فشل الريفرش الذكي:', (e.message || '').slice(0, 200));
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   تهيئة المتصفح — عامل واحد بس كفاية على جهاز محلي (مفيش قيد RAM
   زي Render)، وممكن ترفعه لو محتاج جلب جماعي أسرع عبر
   ARKKAN_AGENT_WORKERS.
   ══════════════════════════════════════════════════════════════ */
const MAX_WORKERS = Math.max(1, Math.min(4, parseInt(process.env.ARKKAN_AGENT_WORKERS || '1', 10) || 1));

let _browser = null;
let _workers = [];
let _ready = false;
let _rr = 0;
let _initChain = Promise.resolve();

function pushWorker(page, ctx) {
  if (_workers.some(w => w.page === page)) return;
  _workers.push({ page, ctx, queue: Promise.resolve() });
}

function enqueueOn(page, fn) {
  let w = _workers.find(x => x.page === page);
  if (!w) { w = { page, ctx: null, queue: Promise.resolve() }; _workers.push(w); }
  const p = w.queue.then(fn, fn);
  w.queue = p.then(() => {}, () => {});
  return p;
}

function pickPage() {
  if (!_workers.length) return null;
  _rr = (_rr + 1) % _workers.length;
  return _workers[_rr].page;
}

async function initBrowser() {
  if (!playwright) throw new Error('مكتبة playwright غير مثبتة — شغّل: npm install playwright && npx playwright install chromium');
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _workers = []; _ready = false; }

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      _browser = await playwright.chromium.launch({ headless: HEADLESS });
      for (let i = 0; i < MAX_WORKERS; i++) {
        const ctx = await _browser.newContext();
        blockHeavyResources(ctx);
        const pg = await ctx.newPage();
        const fr = await ensureDetailsFrame(pg);
        if (!fr) throw new Error('تعذّر الوصول لصفحة تفاصيل المتدرب');
        pushWorker(pg, ctx);
      }
      _ready = true;
      console.log(`[arkkan-agent] ✅ جاهز — ${_workers.length} عامل. الـ agent يستمع على http://localhost:${PORT}`);
      return;
    } catch (e) {
      console.warn(`[arkkan-agent] محاولة ${attempt}/${MAX_ATTEMPTS} فشلت:`, (e.message || '').slice(0, 300));
      await _browser?.close().catch(() => {});
      _browser = null; _workers = []; _ready = false;
      if (attempt < MAX_ATTEMPTS) await wait(3000);
    }
  }
  throw new Error('تعذّر تهيئة أركان بعد 3 محاولات — تحقق من الإنترنت والوصول لموقع أركان');
}

function ensureInit() {
  if (_ready) return Promise.resolve();
  const p = _initChain.then(() => (_ready ? null : initBrowser()));
  _initChain = p.then(() => {}, () => {});
  return p;
}

function getStatus() {
  const mu = process.memoryUsage();
  return {
    ready: !!(_ready && _browser && _workers.length),
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

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`انتهت مهلة الجلب من أركان (أكثر من ${Math.round(ms / 1000)} ثانية)`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/* ══════════════════════════════════════════════════════════════
   HTTP Server — نفس مسارات الفرونت إند القديمة على Render، بس محلياً
   بدون أي مصادقة (الـ agent شغال على جهاز المستخدم نفسه فقط).
   ══════════════════════════════════════════════════════════════ */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('جسم الطلب غير صالح')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  try {
    if (url === '/api/arkkan/status' && req.method === 'GET') {
      return sendJson(res, 200, getStatus());
    }

    if (url === '/api/arkkan/warm' && req.method === 'POST') {
      try {
        await withTimeout(ensureInit(), 60000);
        return sendJson(res, 200, getStatus());
      } catch (e) {
        return sendJson(res, 503, { error: e.message, ...getStatus() });
      }
    }

    if (url === '/api/arkkan/fetch' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.clientId || '').trim();
      if (!id) return sendJson(res, 400, { error: 'رقم الهوية مطلوب' });
      try {
        await ensureInit();
        const pg = pickPage();
        if (!pg) throw new Error('المتصفح غير جاهز بعد');
        const data = await withTimeout(enqueueOn(pg, () => fetchClientData(pg, { clientId: id, referNum: String(body.referNum || '').trim() })), 90000);
        return sendJson(res, 200, data);
      } catch (e) {
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    if (url === '/api/arkkan/exams' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const id = String(body.clientId || '').trim();
      if (!id) return sendJson(res, 400, { error: 'رقم الهوية مطلوب' });
      try {
        await ensureInit();
        const pg = pickPage();
        if (!pg) throw new Error('المتصفح غير جاهز بعد');
        const data = await withTimeout(enqueueOn(pg, () => fetchExamScoresOn(pg, { clientId: id, referNum: String(body.referNum || '').trim() })), 90000);
        return sendJson(res, 200, data);
      } catch (e) {
        const status = /playwright|chromium|متصفح/.test(e.message) ? 503 : 502;
        return sendJson(res, status, { error: e.message });
      }
    }

    if (url === '/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, ready: _ready });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    sendJson(res, 500, { error: e.message || 'خطأ غير متوقع' });
  }
});

server.listen(PORT, async () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  🚀 Arkkan Agent — منفذ ${PORT}`);
  console.log(`${'═'.repeat(50)}\n`);
  try {
    await initBrowser();
  } catch (e) {
    console.error('❌ فشل فتح المتصفح عند البدء (هيُعاد المحاولة تلقائياً عند أول طلب):', e.message);
  }
});

process.on('SIGINT', async () => {
  console.log('\n🛑 إيقاف الـ agent...');
  await _browser?.close().catch(() => {});
  process.exit(0);
});
