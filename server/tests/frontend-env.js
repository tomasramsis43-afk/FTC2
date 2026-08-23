'use strict';
// ============================================================================
// بيئة تشغيل مبسّطة لملفات frontend/js/*.js داخل Node (بدون متصفح حقيقي/jsdom).
// الهدف: تحميل نفس الكود المصدري الفعلي (بدون نسخه أو إعادة كتابته) وتشغيله في
// "sandbox" بأقل قدر من الـ stubs الضرورية، حتى تفحص الاختبارات الدوال الحقيقية
// الموجودة في المشروع مباشرة — وليس نسخة مقلَّدة منها قد تنحرف عن الأصل لاحقاً.
//
// هذه الملفات مكتوبة كسكربتات متصفح عادية (بلا export/module)، وتُعرِّف دوالاً
// ومتغيرات على مستوى عام (global scope) — بالضبط كما تعمل فعلياً في app.html.
// نحمّلها هنا بنفس الطريقة عبر vm.createContext + vm.Script، فتصبح كل الدوال
// المعرَّفة (accountNormalBalance, assertBalancedLines, allocVaultSeq...) متاحة
// كخصائص على الكائن sandbox المُرجَع، جاهزة للاختبار مباشرة.
// ============================================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');

function makeElementStub(){
  const el = {
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; }, toggle(){} },
    dataset: {},
    children: [],
    addEventListener(){},
    removeEventListener(){},
    setAttribute(){},
    getAttribute(){ return null; },
    appendChild(){},
    cloneNode(){ return makeElementStub(); },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    closest(){ return null; },
  };
  return el;
}

function buildSandbox(){
  const localStorageStore = {};
  const documentStub = {
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    getElementById(){ return null; },
    createElement(){ return makeElementStub(); },
    addEventListener(){},
    removeEventListener(){},
    body: makeElementStub(),
    documentElement: { style: { setProperty(){} } },
    readyState: 'complete',
  };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener(){},
    removeEventListener(){},
    document: documentStub,
    navigator: { userAgent: 'node-test', language: 'ar', hardwareConcurrency: 4, deviceMemory: 8 },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    localStorage: {
      getItem: k => (k in localStorageStore ? localStorageStore[k] : null),
      setItem: (k, v) => { localStorageStore[k] = String(v); },
      removeItem: k => { delete localStorageStore[k]; },
      key: i => Object.keys(localStorageStore)[i] || null,
      get length(){ return Object.keys(localStorageStore).length; },
    },
    crypto: { subtle: {}, getRandomValues: arr => arr },
    ResizeObserver: undefined,
    MutationObserver: class { observe(){} disconnect(){} },
    requestAnimationFrame: fn => setTimeout(fn, 0),
    Intl,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    // بيانات التطبيق العامة (تُملأ/تُستبدل من كل اختبار حسب الحاجة)
    settings: {},
    vaultTx: [], deletedVaultTx: [],
    clients: [], journalDE: [], journalEntries: [], purchases: [], manualSalesInvoices: [],
    chartOfAccounts: [], companies: [], companyTransfers: [],
    currentUser: 'tester',
    // دوال مساعدة مستخدمة داخل الملفات لكن معرَّفة في ملفات أخرى من المشروع (ui-framework.js) —
    // نوفّر هنا أبسط تطبيق مطابق لسلوكها المعروف فقط لتشغيل الكود، دون أي تأثير على منطق
    // الدوال التي نختبرها فعلياً (accounting-core.js / module-accounting.js أنفسهم).
    num: v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; },
    uid: (() => { let i = 0; return () => 'test-id-' + (++i); })(),
    fmt: v => String(v),
    showToast(){},
    async logAudit(){},
    todayISO: () => '2026-01-01',
    inRange: () => true,
    addDaysISO: () => '',
    accSelectedRange: () => ({}),
    downloadXlsx(){},
    XLSX: { utils: { book_new: () => ({}), book_append_sheet(){}, json_to_sheet: () => ({}) }, writeFile(){}, SSF: { parse_date_code: () => null } },
    openPrintTarget: () => ({ document: { write(){} } }),
    printDocHead: () => '',
    printDocFooterButton: () => '',
    finishPrintDoc(){},
    CENTER_LOGO_B64: '',
    courseInvoiceClients: () => [],
  };
  sandbox.window = sandbox; // نفس نمط المتصفح: window === global scope
  sandbox.globalThis = sandbox;
  return sandbox;
}

// يحمّل ملفاً أو أكثر (بالترتيب المُعطى) من frontend/js داخل نفس الـ context، ويرجع الـ context
// نفسه (كائن يحمل كل الدوال/المتغيرات المعرَّفة في تلك الملفات كخصائص مباشرة عليه).
function loadFrontendFiles(filenames){
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  const frontendDir = path.join(__dirname, '..', '..', 'frontend', 'js');
  for(const name of filenames){
    const filePath = path.join(frontendDir, name);
    const code = fs.readFileSync(filePath, 'utf8');
    const script = new vm.Script(code, { filename: name });
    script.runInContext(context);
  }
  return context;
}

module.exports = { loadFrontendFiles };
