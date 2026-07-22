/* ============================================================
   نظام الترخيص وتشفير البيانات — التحقق بالكامل على السيرفر
   - التحقق من كود الترخيص واشتقاق مفتاح التشفير (AES-256-GCM) يحدث
     الآن بالكامل عبر POST /api/license/validate على السيرفر. سرّ
     التوقيع (LICENSE_SECRET) لم يعد موجوداً أو محسوباً في هذا الملف
     إطلاقاً، حتى لا يظهر لأي شخص يفتح أدوات المطوّر في المتصفح.
   - الفرونت-إند هنا فقط يرسل الكود المُدخَل للسيرفر، ويستورد مفتاح
     AES-GCM الذي يرجعه (encKey) عبر Web Crypto، دون أي معرفة بالسرّ
     نفسه أو بكيفية اشتقاق المفتاح.
   ============================================================ */
const LICENSE_STORAGE_KEY = "appLicenseKeyV1";
let ENC_KEY = null; // مفتاح AES-GCM (CryptoKey) يُستورد من نتيجة السيرفر بعد التفعيل

function bytesToBase64(bytes){
  let binary = ''; const chunk = 0x8000;
  for(let i=0;i<bytes.length;i+=chunk){ binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk)); }
  return btoa(binary);
}
function base64ToBytes(b64){
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* يستدعي مسار التحقق على السيرفر بدل حساب أي شيء محلياً. يرجع نفس شكل
   النتيجة المستخدم سابقاً في باقي الكود (valid/reason/clientId/expiryDate/expired)
   بالإضافة إلى encKeyRaw (base64) عند النجاح، ليتم استيرادها كـ CryptoKey. */
async function validateLicenseKey(rawKey){
  try{
    const res = await fetch(API_BASE + '/api/license/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: rawKey }),
    });
    const data = await res.json();
    if(!res.ok || !data) return { valid:false, reason:'تعذّر الاتصال بالسيرفر للتحقق من الترخيص' };
    if(!data.valid){
      return {
        valid:false,
        reason: data.reason || 'كود الترخيص غير صحيح',
        expired: !!data.expired,
        clientId: data.clientId || null,
      };
    }
    return {
      valid:true,
      clientId: data.clientId,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
      encKeyRaw: data.encKey, // base64 — يُستورد لاحقاً في activateAndStart
    };
  }catch(e){
    return { valid:false, reason:'تعذّر الاتصال بالسيرفر للتحقق من الترخيص، تحقق من اتصال الإنترنت' };
  }
}

async function encryptValue(plaintext){
  if(!ENC_KEY) return plaintext;
  try{
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, ENC_KEY, data);
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv,0); combined.set(new Uint8Array(cipherBuf), iv.length);
    return 'ENC1:' + bytesToBase64(combined);
  }catch(e){ return plaintext; }
}
async function decryptValue(stored){
  if(typeof stored !== 'string' || !stored.startsWith('ENC1:')) return stored; // بيانات قديمة أو غير مشفّرة (توافق للخلف)
  if(!ENC_KEY) throw new Error('مفتاح التشفير غير متاح بعد');
  const bytes = base64ToBytes(stored.slice(5));
  const iv = bytes.slice(0,12);
  const data = bytes.slice(12);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, ENC_KEY, data);
  return new TextDecoder().decode(plainBuf);
}

/* ============================================================
   Storage — نسخة متصلة بالخادم المركزي (بدل localStorage)
   نفس الواجهة تماماً (get/set/delete/list) حتى لا يتغيّر أي سطر آخر
   في باقي البرنامج. البيانات تُشفَّر كما كانت دائماً قبل الإرسال،
   والخادم لا يفكّ أي تشفير — فقط يخزّن النص المشفّر كما هو.
   ============================================================ */
const API_BASE = ''; // فارغ = نفس عنوان الموقع (الخادم يخدم الواجهة والـ API معاً). عدّله فقط لو شغّلت الواجهة من عنوان مختلف عن الخادم.
let SERVER_AUTH_TOKEN = null; // يُملأ بعد نجاح تسجيل الدخول على الخادم
let SERVER_AUTH_USERNAME = null; // اسم المستخدم كما أرجعه الخادم عند تسجيل الدخول
let SERVER_AUTH_ROLE = null; // صلاحية المستخدم كما أرجعها الخادم — هي المرجع الوحيد للصلاحيات الآن
/* الأدوار المدعومة: admin (كامل) / accountant (محاسب: الأقسام المالية فقط) / reception (استقبال: تسجيل بيانات فقط بدون أرقام مالية) / staff (الافتراضي القديم: كل شيء ما عدا الإعدادات والمراجعة والمحاسبة).
   يجب أن يُرجع الخادم (/api/auth/login) أحد هذه القيم بالضبط في data.role حتى يُفعَّل الدور المطلوب — أي قيمة أخرى أو فارغة تُعامل كـ staff احترازياً. */
const VALID_ROLES = ['admin','accountant','reception','staff'];
function normalizeRole(r){ return VALID_ROLES.includes(r) ? r : 'staff'; }
const _kvVersions = {}; // آخر نسخة (version) معروفة لكل مفتاح، لمنع الكتابة فوق تعديل شخص آخر بصمت

async function serverFetch(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(SERVER_AUTH_TOKEN ? { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    // انتهت الجلسة أو لم يسجَّل الدخول بعد — أعد عرض شاشة الدخول على الخادم
    SERVER_AUTH_TOKEN = null;
    try { sessionStorage.removeItem('serverAuthToken'); } catch (e) {}
    showServerLoginScreen('انتهت صلاحية الجلسة، يرجى تسجيل الدخول مجدداً');
    throw new Error('غير مصرَّح — يرجى تسجيل الدخول');
  }
  return res;
}

window.storage = {
    async get(key, shared){
      try{
        const res = await serverFetch(`/api/storage/${encodeURIComponent(key)}`);
        if(!res.ok) return null;
        const data = await res.json();
        _kvVersions[key] = data.version || 0;
        if(data.value === null || data.value === undefined) return null;
        const value = await decryptValue(data.value);
        return { key, value, shared: !!shared };
      }catch(e){ return null; }
    },
    async set(key, value, shared){
      try{
        const toStore = await encryptValue(value);
        const res = await serverFetch(`/api/storage/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: JSON.stringify({ value: toStore, version: _kvVersions[key] || 0 }),
        });
        if(res.status === 409){
          const conflict = await res.json();
          _kvVersions[key] = conflict.currentVersion || _kvVersions[key];
          showToast('⚠️ ' + (conflict.error || 'تعارض في الحفظ: عدّل شخص آخر نفس البيانات، يرجى تحديث الصفحة وإعادة المحاولة'));
          return null;
        }
        if(!res.ok) return null;
        const data = await res.json();
        _kvVersions[key] = data.version || 0;
        return { key, value, shared: !!shared };
      }catch(e){ return null; }
    },
    async delete(key, shared){
      try{
        await serverFetch(`/api/storage/${encodeURIComponent(key)}`, { method: 'DELETE' });
        delete _kvVersions[key];
        return { key, deleted: true, shared: !!shared };
      }catch(e){ return null; }
    },
    async list(prefix, shared){
      try{
        const res = await serverFetch(`/api/storage?prefix=${encodeURIComponent(prefix||'')}`);
        if(!res.ok) return null;
        const data = await res.json();
        return { keys: data.keys, prefix, shared: !!shared };
      }catch(e){ return null; }
    }
};

/* ---------------- شاشة الدخول على الخادم المركزي (منفصلة عن نظام المستخدمين الداخلي للبرنامج) ---------------- */
function showServerLoginScreen(errorMsg){
  const el = document.getElementById('server-login-screen');
  if(!el) return;
  el.style.display = 'flex';
  const errEl = document.getElementById('server-login-error');
  if(errorMsg){ errEl.textContent = errorMsg; errEl.style.display = 'block'; }
  else { errEl.style.display = 'none'; }
}
async function serverLogin(username, password){
  const res = await fetch(API_BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if(!res.ok) throw new Error(data.error || 'تعذّر تسجيل الدخول');
  SERVER_AUTH_TOKEN = data.token;
  /* الصلاحية (admin/staff) أصبحت تُحدَّد من استجابة الخادم نفسها (هوية المستخدم الذي سجّل دخوله فعليًا)،
     وليس من قائمة "المستخدمين" الداخلية داخل البرنامج. إن لم يُرجع الخادم دور المستخدم لأي سبب،
     نفترض "staff" (الأضيق صلاحية) كإجراء أمان احترازي، بدل افتراض "admin" الذي قد يمنح صلاحيات كاملة
     لمستخدم لا يستحقها. يجب أن يُرجع مسار /api/auth/login على الخادم الحقلين username و role. */
  SERVER_AUTH_USERNAME = data.username || username;
  SERVER_AUTH_ROLE = normalizeRole(data.role);
  try{
    sessionStorage.setItem('serverAuthToken', data.token);
    sessionStorage.setItem('serverAuthUsername', SERVER_AUTH_USERNAME);
    sessionStorage.setItem('serverAuthRole', SERVER_AUTH_ROLE);
  }catch(e){}
  return data;
}



const DEFAULT_SETTINGS = {
  courses: [
    {name:'Food safety', price:980},
    {name:'Barber', price:980},
    {name:'Beauty salon', price:980},
    {name:'Laundry', price:1030}
  ],
  nationalities: ['Saudi','Yemeni','Egyption','Sudanese','Türkiye','Syria','Tunisia','Afghanistan','Ethiopia','Morocco','Palestine','Jordan','Bangladesh','Hindi','Pakistani','Nepali','Indonesia','Filipino','SriLanka','Tanzanian','Ghanaian','Ugandan','Lebanon'],
  channels: [
    {name:'نقدي', dest:'vault'},
    {name:'بطاقة / شبكة (مدى)', dest:'network'},
    {name:'تحويل بنكي', dest:'bank'},
    {name:'طبي', dest:'other'},
    {name:'المركز', dest:'other'}
  ],
  bagPrice: 456.55,
  priceSaudi: 293.45,
  priceNonSaudi: 573.45,
  expenseCategories: ['رواتب','إيجار','كهرباء','مياه','انترنت','مستلزمات مكتب','مصاريف انتقال','صيانة','مسحوبات شركاء','مشتريات','أخرى'],
  centerInfo: {
    name: 'مركز فهد للتدريب',
    taxNumber: '300934595800003',
    phone: '+966552194377'
  },
  nextInvoiceNo: 1,
  nextReturnInvoiceNo: 1,
  nextVoucherNo: 1,
  nextManualSalesInvoiceNo: 1,
  darkMode: false,
  soundEnabled: true,
  autoBackupEnabled: true,
  autoBackupIntervalDays: 7,
  lastAutoBackupAt: null,
  lowBalanceThreshold: 5000,
  bagOverdueDays: 14,
  monthlyReportWhatsapp: '',
  monthlyPdfReportsWhatsappNumbers: '',
  vatPdfReportWhatsappNumbers: '',
  lastMonthlyReportPromptMonth: null,
  nextVaultSeq: 1,
  vaultLockedThrough: '',
  bagFinanceLinkEnabled: true,
  powerAutomate: { webhookUrl: '', notifyNewClient: true, notifyCourseNumber: true }
};
const CENTER_LOGO_B64 = "/9j/4AAQSkZJRgABAQEBLAEsAAD/4QKyRXhpZgAATU0AKgAAAAgAAodpAAQAAAABAAABMuocAAcAAAEMAAAAJgAAAAAc6gAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWQAwACAAAAFAAAAoCQBAACAAAAFAAAApSSkQACAAAAAzAwAACSkgACAAAAAzAwAADqHAAHAAABDAAAAXQAAAAAHOoAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADIwMjQ6MDY6MDEgMTU6NTQ6NDMAMjAyNDowNjowMSAxNTo1NDo0MwAAAP/hAqxodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvADw/eHBhY2tldCBiZWdpbj0n77u/JyBpZD0nVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkJz8+DQo8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIj48cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPjxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSJ1dWlkOmZhZjViZGQ1LWJhM2QtMTFkYS1hZDMxLWQzM2Q3NTE4MmYxYiIgeG1sbnM6ZXhpZj0iaHR0cDovL25zLmFkb2JlLmNvbS9leGlmLzEuMC8iPjxleGlmOkRhdGVUaW1lT3JpZ2luYWw+MjAyNC0wNi0wMVQxNTo1NDo0MzwvZXhpZjpEYXRlVGltZU9yaWdpbmFsPjwvcmRmOkRlc2NyaXB0aW9uPjwvcmRmOlJERj48L3g6eG1wbWV0YT4NCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8P3hwYWNrZXQgZW5kPSd3Jz8+/9sAQwADAgIDAgIDAwMDBAMDBAUIBQUEBAUKBwcGCAwKDAwLCgsLDQ4SEA0OEQ4LCxAWEBETFBUVFQwPFxgWFBgSFBUU/9sAQwEDBAQFBAUJBQUJFA0LDRQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU/8AAEQgBbAFfAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYH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";

let clients = [];
let bagStock = [];
let vaultTx = [];
let deletedVaultTx = []; // سجل الحركات المالية الملغاة (حذف منطقي Soft Delete) — لا تُستخدم في أي حسابات، فقط للتدقيق والاسترجاع
let vaultDenomTx = []; // سجل حركات تصنيف الفئات النقدية بالخزنة (دخول/خروج/تسوية جرد) — رصيد كل فئة = مجموع الدخول - مجموع الخروج، لا يدخل ضمن أي رصيد محاسبي آخر
let bankStatementRows = []; // كشف الحساب البنكي المستورد لأغراض المطابقة البنكية — لا يدخل ضمن أي رصيد أو تقرير، فقط للمطابقة اليدوية/التلقائية مع حركات "البنك"
let bankReconShowMatched = false; // تبديل عرض الحركات المطابَقة في شاشة المطابقة البنكية
let deletedInvoices = []; // سجل فواتير العملاء المحذوفة (حذف منطقي) — يحتفظ برقم الفاتورة التسلسلي والسبب دون إعادة استخدام الرقم أبداً
let courseSessions = [];
let journalEntries = [];
let chartOfAccounts = []; // دليل الحسابات: {id, code, name, type} — type ∈ asset/liability/equity/revenue/expense
let journalDE = []; // القيود اليومية بنظام القيد المزدوج: {id, date, description, lines:[{accountId, debit, credit}], createdAt}
let budgetEntries = []; // الموازنة التقديرية: {id, year, accountId, months:[12 رقم], updatedBy, updatedAt}
let suppliers = [];
let purchases = [];
let manualSalesInvoices = []; // فواتير مبيعات ضريبية يدوية (مبيعات لا ترتبط بفاتورة دورة تدريبية داخل شيت العملاء)
let zakatAdjustments = {}; // تعديلات وعاء الزكاة المُدخلة يدوياً، مفتاحها السنة الميلادية
/* ---------------- فلتر السنة العام (خانة أعلى البرنامج — يُطبَّق على كل الشيتات والتقارير) ---------------- */
let selectedYearFilter = localStorage.getItem('selectedYearFilter') || 'all';
/* أزواج حقول (من تاريخ / إلى تاريخ) الموجودة في مختلف شاشات البرنامج؛ عند اختيار سنة يتم ضبطها كلها تلقائياً على حدود تلك السنة */
const YEAR_FILTER_DATE_PAIRS = [
  ['cl-date-from','cl-date-to'],
  ['ctf-date-from','ctf-date-to'],
  ['cs-filter-from','cs-filter-to'],
  ['cs-missing-from','cs-missing-to'],
  ['cs-missing-exp-from','cs-missing-exp-to'],
  ['v-from','v-to'],
  ['cbp-date-from','cbp-date-to'],
  ['bst-date-from','bst-date-to'],
  ['rp-from','rp-to'],
  ['audit-date-from','audit-date-to'],
];
/* هل يوافق هذا التاريخ السنة المختارة حالياً؟ (يُستخدم في الشاشات التي لا يوجد لها فلتر تاريخ خاص بها، مثل لوحة التحكم) */
function matchYear(dateStr){
  if(selectedYearFilter==='all') return true;
  return String(dateStr||'').slice(0,4)===String(selectedYearFilter);
}
/* نفس فلتر السنة العام، لكن مخصص لفواتير الدورات: يعتمد على تاريخ صدور الفاتورة (receiptIssueDate)
   بدل تاريخ تسجيل العميل، اتساقاً مع الإقرار الضريبي الذي يحتسب حسب تاريخ الفاتورة فعلياً.
   الفواتير التي لم يُدخل لها تاريخ إصدار بعد تبقى ظاهرة دائماً (بغض النظر عن السنة المختارة)
   حتى لا تختفي من الشاشة قبل استكمال بياناتها. */
function matchInvoiceYear(c){
  if(selectedYearFilter==='all') return true;
  if(!c.receiptIssueDate) return true;
  return String(c.receiptIssueDate).slice(0,4)===String(selectedYearFilter);
}
/* تجميع كل السنوات الموجودة فعلياً في بيانات البرنامج (عملاء، حركات مالية، دورات، مخزون حقائب، تحويلات شركات) */
function collectAllYears(){
  const years = new Set();
  const grab = (arr, key)=>{ (arr||[]).forEach(x=>{ const y = String((x&&x[key])||'').slice(0,4); if(/^\d{4}$/.test(y)) years.add(y); }); };
  grab(clients,'date'); grab(vaultTx,'date'); grab(courseSessions,'date'); grab(bagStock,'date');
  if(typeof companyTransfers!=='undefined') grab(companyTransfers,'date');
  return Array.from(years).sort((a,b)=>b.localeCompare(a));
}
function populateYearFilterSelect(){
  const sel = $('#year-filter');
  if(!sel) return;
  const years = collectAllYears();
  if(selectedYearFilter!=='all' && !years.includes(selectedYearFilter)) selectedYearFilter = 'all';
  sel.innerHTML = `<option value="all">كل السنوات (المدة كلها)</option>` + years.map(y=>`<option value="${y}">سنة ${y}</option>`).join('');
  sel.value = selectedYearFilter;
}
/* يضبط كل حقول (من/إلى تاريخ) في كل شاشات البرنامج على حدود السنة المختارة، ثم يعيد رسم كل الشيتات والتقارير */
function applyYearFilterToAllViews(){
  const from = selectedYearFilter==='all' ? '' : `${selectedYearFilter}-01-01`;
  const to = selectedYearFilter==='all' ? '' : `${selectedYearFilter}-12-31`;
  YEAR_FILTER_DATE_PAIRS.forEach(([f,t])=>{
    const fe = $('#'+f), te = $('#'+t);
    if(fe) fe.value = from;
    if(te) te.value = to;
  });
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderOwnBagClients==='function') renderOwnBagClients();
  if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCourseInvoices==='function') renderCourseInvoices();
  if(typeof renderMissingCourse==='function') renderMissingCourse();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
}
function initYearFilter(){
  populateYearFilterSelect();
  applyYearFilterToAllViews();
  $('#year-filter').addEventListener('change', e=>{
    selectedYearFilter = e.target.value;
    localStorage.setItem('selectedYearFilter', selectedYearFilter);
    applyYearFilterToAllViews();
    showToast(selectedYearFilter==='all' ? 'تم عرض كل السنوات (المدة كلها)' : `تم تحديد سنة العمل: ${selectedYearFilter}`);
  });
}
let currentLang = 'ar';
const I18N = {
  ar: {
    appTitle:'نظام إدارة العملاء والكورسات', appSubtitle:'بديل رقمي لملف الإكسل — العملاء، الدورات، الحقائب، والمدفوعات',
    logout:'تسجيل الخروج',
    navDashboard:'لوحة التحكم', navClients:'العملاء', navCompanies:'تحويلات الشركات', navCourses:'الدورات', navVault:'الحركات المالية',
    navBags:'مخزون الحقائب', navReports:'التقارير', navAudit:'سجل المراجعة', navSettings:'الإعدادات',
    chartByCourse:'التوزيع حسب نوع الدورة', chartByNat:'التوزيع حسب الجنسية (الأكثر تسجيلاً)', chartByChannel:'التوزيع حسب طريقة الدفع',
    accountingNoteTitle:'ملاحظة محاسبية',
    accountingNoteBody:'قيمة الحقيبة (456.55 ر.س) يدفعها العميل ولا تُحسب من ضمن دخل المركز — المبلغ يُستخدم لشراء الحقيبة فعلياً. لذلك "دخل المركز الصافي" أعلاه لا يشمل مبالغ الحقائب، وتجد تفاصيلها كاملة في تبويب "مخزون الحقائب".',
    searchPlaceholder:'بحث بالاسم / الجوال / رقم الهوية / رقم الفاتورة',
    allCourses:'كل الدورات', allNats:'كل الجنسيات', allStatuses:'كل حالات السداد', fullyPaid:'مسدد بالكامل', owing:'متبقي عليه',
    exportCsv:'تصدير حسب الفلتر', exportExcel:'تصدير Excel (للتعديل)', importExcel:'استيراد بيانات العملاء', newClient:'+ عميل جديد',
    importExportHint:'الاستيراد والتصدير مرتبطان برقم الهوية: إن كان رقم الهوية موجوداً مسبقاً سيتم تحديث الأعمدة التي بها قيمة في الملف فقط (الأعمدة الفارغة تبقى كما هي في النظام)، وإن لم يكن موجوداً سيُضاف كعميل جديد.',
    thId:'رقم الهوية', thName:'الاسم', thRef:'الرقم المرجعي', thNat:'الجنسية', thCourse:'الدورة', thCourseNum:'رقم الدورة',
    thInvoice:'رقم الفاتورة', thRegDate:'تاريخ التسجيل', thTotal:'الإجمالي', thPaid:'إجمالي المدفوع', thRemaining:'المتبقي', thBag:'الحقيبة', thChannel:'طريقة الدفع',
    noRecords:'لا توجد سجلات مطابقة — جرّب تعديل البحث أو أضف عميلاً جديداً',
    edit:'تعديل', delete:'حذف', save:'حفظ', cancel:'إلغاء', invoiceBtn:'فاتورة', print:'طباعة',
    editCourse:'تعديل الدورة', printAttendance:'طباعة كشف الحضور', markAbsent:'تحديد غياب', clearAbsent:'إلغاء الغياب',
    compTitle:'تحويلات الشركات',
    compIntro:'تُستخدم هذه الشاشة عندما تدفع شركة دفعة واحدة تغطي عدة متدربين (مثال: 1000 ريال لمتدربين، كل متدرب 500 ريال) — حوالة بنكية أو نقدي أو بطاقة، حسب طريقة الدفع التي تُحدَّد لكل حوالة عند إضافتها. تُوزَّع قيمة الحوالة على المتدربين برقم الهوية، ويُرحَّل إجمالي المدفوع لكل فرد (قيمة الدورة + قيمة الحقيبة) تلقائياً لشيت "الحركات المالية" إلى الحساب المرتبط بطريقة الدفع المختارة لهذه الحوالة (الخزنة (كاش) / البنك / الشبكة) — إلا إذا كان هذا المتدرب مسجّلاً بالفعل ومدفوعاً عنه في شيت "العملاء"، فلا يُرحَّل مرة أخرى لتجنّب تكرار الأرقام.',
    compAgreedTitle:'الشركات المتفق معها',
    compAgreedHint:'المبلغ هنا هو المبلغ المتفق عليه لنصيب المتدرب الواحد بعد الخصم — يظهر تلقائياً عند اختيار اسم هذه الشركة في نموذج "عميل جديد" بشيت العملاء. إن كانت الشركة تتفق على مبلغ مختلف حسب الفئة، استخدم قسم "مبالغ حسب الفئة" أدناه بدلاً منه.',
    compFieldName:'اسم الشركة', compFieldTax:'الرقم الضريبي للشركة', compFieldAmount:'المبلغ المتفق عليه للمتدرب الواحد (بعد الخصم) — عام/افتراضي',
    btnAddCompany:'+ إضافة شركة', btnCancelEdit:'إلغاء التعديل',
    compCatsTitle:'مبالغ مختلفة حسب الفئة (اختياري)',
    compCatsHint:'إذا كانت الشركة تتفق على سعر مختلف لكل فئة (مثال: مقيم بسعر، سعودي بسعر آخر)، أضف الفئات هنا. سيظهر هذا التقسيم عند اختيار الشركة في شيت العملاء، ويمكن تعبئته تلقائياً عند إضافة حوالة جديدة لهذه الشركة.',
    btnAddCategory:'+ إضافة فئة',
    thTaxNo:'الرقم الضريبي', thAgreedAmount:'المبلغ المتفق عليه / متدرب', thTransferCount:'عدد الحوالات', thTransferTotal:'إجمالي الحوالات',
    compNewTransferTitle:'إضافة حوالة جديدة',
    compFieldCompany:'الشركة', compFieldDate:'تاريخ الحوالة', compFieldValue:'قيمة الحوالة', compFieldTraineeCount:'عدد المتدربين المراد تدريبهم',
    fieldNotes:'ملاحظات',
    compChannelHint:'حسب طريقة الدفع المختارة (حسب طرق الدفع المُعرَّفه في الإعدادات) — سيُرحَّل مبلغ متدربيها تلقائياً لشيت "الحركات المالية" إلى الحساب المرتبط بهذه الطريقة (الخزنة (كاش) / البنك / الشبكة) بدلاً من افتراض أنها دائماً حوالة بنكية.',
    compSplitTitle:'تقسيم المبلغ حسب فئات (اختياري)',
    compSplitHint:'إذا كانت الحوالة تغطي فئات مختلفة بأسعار مختلفة (مثال: 10 مقيمين بسعر و5 سعوديين بسعر آخر)، أضف كل فئة هنا بعددها وسعر الفرد فيها — سيُحسب "قيمة الحوالة" و"عدد المتدربين" أعلاه تلقائياً من مجموع الفئات، وتصبح تلك الحقول للعرض فقط. لحذف التقسيم والعودة للإدخال اليدوي، احذف كل الفئات أدناه.',
    btnFillFromCompanySettings:'تعبئة الفئات من إعدادات الشركة',
    compGroupsTotalPrefix:'إجمالي الفئات:', compGroupsTotalSuffix:'لعدد', traineeWord:'متدرب',
    compShareLabel:'نصيب المتدرب الواحد المحتسب:',
    btnSaveTransfer:'حفظ الحوالة',
    compLogTitle:'سجل تحويلات الشركات والمتدربين التابعين لها',
    btnDownloadTemplate:'تحميل نموذج استيراد المتدربين', btnExportCsvFiltered:'تصدير CSV (حسب الفلتر الحالي)',
    compSummaryTitle:'ملخص أعداد المتدربين حسب الشركة (إجمالي كل الحوالات)',
    compSummaryHint:'جدول ثابت يعرض لكل شركة إجمالي عدد متدربيها في كل حوالاتها المسجّلة، وكم منهم أخذ الدورة فعلاً (تاريخ دورته الفعلي وصل أو فات) وكم لم يأخذها بعد — بغض النظر عن أي فلترة مستخدمة أدناه في سجل الحوالات.',
  },
  en: {
    appTitle:'Client & Course Management System', appSubtitle:'A digital alternative to Excel — clients, courses, bags, and payments',
    logout:'Log out',
    navDashboard:'Dashboard', navClients:'Clients', navCompanies:'Company Transfers', navCourses:'Courses', navVault:'Financial Transactions',
    navBags:'Bag Inventory', navReports:'Reports', navAudit:'Audit Log', navSettings:'Settings',
    chartByCourse:'Distribution by course type', chartByNat:'Distribution by nationality (most registered)', chartByChannel:'Distribution by payment method',
    accountingNoteTitle:'Accounting note',
    accountingNoteBody:'The bag fee (SAR 456.55) is paid by the client and is not counted as center income — it is used to actually purchase the bag. So "Net center income" above excludes bag amounts; see full details in the "Bag Inventory" tab.',
    searchPlaceholder:'Search by name / phone / ID number / invoice number',
    allCourses:'All courses', allNats:'All nationalities', allStatuses:'All payment statuses', fullyPaid:'Fully paid', owing:'Balance due',
    exportCsv:'Export by filter', exportExcel:'Export Excel (editable)', importExcel:'Import client data', newClient:'+ New client',
    importExportHint:'Import/export are linked by ID number: if the ID already exists, only columns with a value in the file are updated (empty columns are left unchanged); otherwise a new client is added.',
    thId:'ID Number', thName:'Name', thRef:'Reference No.', thNat:'Nationality', thCourse:'Course', thCourseNum:'Course No.',
    thInvoice:'Invoice No.', thRegDate:'Registration Date', thTotal:'Total', thPaid:'Total Paid', thRemaining:'Remaining', thBag:'Bag', thChannel:'Payment Method',
    noRecords:'No matching records — try adjusting your search or add a new client',
    edit:'Edit', delete:'Delete', save:'Save', cancel:'Cancel', invoiceBtn:'Invoice', print:'Print',
    editCourse:'Edit course', printAttendance:'Print attendance sheet', markAbsent:'Mark absent', clearAbsent:'Clear absence',
    compTitle:'Company Transfers',
    compIntro:'This screen is used when a company makes one payment covering several trainees (e.g. SAR 1000 for two trainees, SAR 500 each) — bank transfer, cash, or card, depending on the payment method set for each transfer when it is added. The transfer amount is distributed to trainees by ID number, and each person\'s total paid (course fee + bag fee) is automatically posted to the "Financial Transactions" sheet, to the account linked to the payment method chosen for this transfer (Cash Vault / Bank / Network) — unless this trainee is already registered and paid in the "Clients" sheet, in which case it is not posted again to avoid duplicate amounts.',
    compAgreedTitle:'Contracted Companies',
    compAgreedHint:'The amount here is the agreed amount per trainee\'s share after discount — it appears automatically when this company\'s name is selected in the "New Client" form on the Clients sheet. If the company agrees on a different amount per category, use the "Amounts by Category" section below instead.',
    compFieldName:'Company Name', compFieldTax:'Company Tax Number', compFieldAmount:'Agreed Amount per Trainee (after discount) — general/default',
    btnAddCompany:'+ Add Company', btnCancelEdit:'Cancel Edit',
    compCatsTitle:'Different Amounts by Category (optional)',
    compCatsHint:'If the company agrees on a different price per category (e.g. resident at one price, Saudi at another), add the categories here. This split will appear when the company is selected on the Clients sheet, and can be auto-filled when adding a new transfer for this company.',
    btnAddCategory:'+ Add Category',
    thTaxNo:'Tax Number', thAgreedAmount:'Agreed Amount / Trainee', thTransferCount:'Transfer Count', thTransferTotal:'Total Transfers',
    compNewTransferTitle:'Add New Transfer',
    compFieldCompany:'Company', compFieldDate:'Transfer Date', compFieldValue:'Transfer Amount', compFieldTraineeCount:'Number of Trainees to Train',
    fieldNotes:'Notes',
    compChannelHint:'Based on the selected payment method (per the payment methods defined in Settings) — the trainees\' amount will be automatically posted to the "Financial Transactions" sheet, to the account linked to this method (Cash Vault / Bank / Network), instead of always assuming it is a bank transfer.',
    compSplitTitle:'Split Amount by Category (optional)',
    compSplitHint:'If the transfer covers different categories at different prices (e.g. 10 residents at one price and 5 Saudis at another), add each category here with its count and per-person price — the "Transfer Amount" and "Number of Trainees" above will be calculated automatically from the category totals, and become display-only. To remove the split and return to manual entry, delete all categories below.',
    btnFillFromCompanySettings:'Fill Categories from Company Settings',
    compGroupsTotalPrefix:'Category total:', compGroupsTotalSuffix:'for', traineeWord:'trainee(s)',
    compShareLabel:'Calculated share per trainee:',
    btnSaveTransfer:'Save Transfer',
    compLogTitle:'Company Transfers Log and Their Trainees',
    btnDownloadTemplate:'Download Trainee Import Template', btnExportCsvFiltered:'Export CSV (current filter)',
    compSummaryTitle:'Trainee Count Summary by Company (all transfers total)',
    compSummaryHint:'A fixed table showing, for each company, the total number of trainees across all its recorded transfers, how many have actually taken the course (actual course date has passed or arrived) and how many have not yet — regardless of any filter used below in the transfers log.',
  }
};
function tr(key){ return (I18N[currentLang] && I18N[currentLang][key]) || I18N.ar[key] || key; }
function applyLanguage(lang){
  currentLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang==='ar' ? 'rtl' : 'ltr';
  $all('[data-i18n]').forEach(el=>{ const k=el.dataset.i18n; if(I18N[lang] && I18N[lang][k]!==undefined) el.textContent = I18N[lang][k]; });
  $all('[data-i18n-placeholder]').forEach(el=>{ const k=el.dataset.i18nPlaceholder; if(I18N[lang] && I18N[lang][k]!==undefined) el.placeholder = I18N[lang][k]; });
  $('#btn-lang-toggle').textContent = lang==='ar' ? 'EN' : 'AR';
  try{ window.storage.set('appLang', lang, false); }catch(e){}
  // إعادة رسم كل الجداول والمحتوى الديناميكي لتحديث النصوص المولّدة من JS
  if(typeof renderTable==='function') renderTable();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderAccounting==='function') renderAccounting();
}
/* تبديل الوضع الليلي/النهاري لكامل الواجهة، مع حفظ التفضيل ضمن إعدادات المستخدم */
function applyTheme(isDark){
  document.body.classList.toggle('dark-theme', !!isDark);
  const btn = $('#btn-theme-toggle');
  if(btn) btn.innerHTML = isDark
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
}
/* ================= نظام المؤثرات الصوتية ================= */
const SoundFX = (()=>{
  let ctx = null;
  function getCtx(){
    if(!ctx){
      try{ ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ return null; }
    }
    if(ctx.state==='suspended') ctx.resume();
    return ctx;
  }
  function enabled(){ return !!(typeof settings!=='undefined' && settings.soundEnabled); }
  // نغمة/سلسلة نغمات بسيطة بموجة جيبية ناعمة مع envelope قصير حتى لا تكون مزعجة
  function tone(freq, start, dur, type='sine', peak=.11){
    const c = getCtx(); if(!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime+start);
    gain.gain.setValueAtTime(0, c.currentTime+start);
    gain.gain.linearRampToValueAtTime(peak, c.currentTime+start+.012);
    gain.gain.exponentialRampToValueAtTime(.0001, c.currentTime+start+dur);
    osc.connect(gain); gain.connect(c.destination);
    osc.start(c.currentTime+start);
    osc.stop(c.currentTime+start+dur+.02);
  }
  return {
    click(){ if(!enabled()) return; tone(720,0,.055,'sine',.06); },
    nav(){ if(!enabled()) return; tone(560,0,.07,'sine',.07); tone(760,.05,.09,'sine',.05); },
    success(){ if(!enabled()) return; tone(587,0,.09,'sine',.09); tone(880,.09,.16,'sine',.09); },
    error(){ if(!enabled()) return; tone(220,0,.12,'sawtooth',.05); tone(180,.1,.16,'sawtooth',.045); },
    delete(){ if(!enabled()) return; tone(400,0,.06,'triangle',.07); tone(260,.05,.13,'triangle',.06); },
    open(){ if(!enabled()) return; tone(660,0,.06,'sine',.05); },
    login(){ if(!enabled()) return; tone(523,0,.09,'sine',.08); tone(659,.08,.09,'sine',.08); tone(880,.16,.18,'sine',.08); }
  };
})();
function applySoundIcon(){
  const btn = $('#btn-sound-toggle');
  if(!btn) return;
  btn.classList.toggle('muted', !settings.soundEnabled);
  btn.title = settings.soundEnabled ? 'كتم المؤثرات الصوتية' : 'تشغيل المؤثرات الصوتية';
}
let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
let companies = [];
let companyTransfers = [];
let ctraineeTargetTransferId = null;
let ctEditingTraineeId = null;
let ctImportTargetTransferId = null;
let ctImportTextTargetTransferId = null;
let ctImportCompanyTargetId = null;
let editingId = null;
let bagPurchaseTargetId = null;
let editingTransferId = null;
let editingVaultId = null;
let editingPaymentTxId = null;
let addingClientPayment = false;
let editingBagStockId = null;
let editingSessionId = null;
let editingCompanyId = null;
let users = [];
let auditLog = [];
let currentUser = null;
let currentUserRole = 'admin'; // 'admin' (صلاحيات كاملة) أو 'staff' (صلاحيات محدودة — بدون الإعدادات وسجل المراجعة)

const $ = s => document.querySelector(s);
const $all = s => document.querySelectorAll(s);

/* دالة تأخير التنفيذ (debounce) — تُستخدم مع حقول البحث النصي حتى لا يُعاد رسم الجداول الكبيرة
   مع كل ضغطة حرف (وهذا هو السبب الرئيسي لبطء البرنامج مع كثرة البيانات)، بل بعد توقف الكتابة فقط */
function debounce(fn, wait=280){
  let t;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(()=> fn.apply(this,args), wait);
  };
}
/* ربط حدث input بنسخة مؤخّرة من الدالة (يبقى تفاعل باقي الحقول مثل select/date فورياً كما هو) */
function onSearchInput(selector, fn){
  const el = typeof selector==='string' ? $(selector) : selector;
  if(el) el.addEventListener('input', debounce(fn));
}

function guessDest(name){
  const n = (name||'').toLowerCase();
  if(n.includes('نقد')||n.includes('كاش')||n.includes('خزين')) return 'vault';
  if(n.includes('بنك')||n.includes('تحويل')) return 'bank';
  if(n.includes('بطاق')||n.includes('شبك')||n.includes('مدى')) return 'network';
  return 'other';
}
function destLabel(d){ return {vault:'الخزنة (كاش)', bank:'البنك', network:'الشبكة', other:'أخرى'}[d] || 'أخرى'; }
/* تصحيح/مزامنة تلقائي لسجل عمليات مخزون الحقائب: تُضيف عملية "تسليم" (issue) بأثر رجعي لأي عميل
   مصدر حقيبته "من المخزون" (bagSource==='stock') وليس له عملية مقابلة مسجّلة بعد في bagStock.
   تُستدعى عند تحميل البيانات وأيضاً فور انتهاء أي استيراد Excel قد يضبط مصدر حقيبة عميل على "من المخزون"،
   حتى يتحدّث رقم "المخزون الحالي" فوراً دون الحاجة لإعادة تحميل/فتح التطبيق من جديد.
   تُعيد true إن تم تسجيل أي تصحيح (وتتولى الحفظ بنفسها)، وfalse إن لم يكن هناك ما يحتاج تصحيحاً. */
async function syncBagStockIssues(){
  let migrated = false;
  clients.forEach(c=>{
    if(c.bagSource==='stock' && !bagStock.some(b=>b.type==='issue' && b.issuedClientId===c.id)){
      bagStock.push({
        id: uid(), type:'issue', qty:-1, unitPrice:0,
        date: c.bagPurchaseDate || c.date || todayISO(),
        createdAt: c.createdAt || Date.now(),
        issuedClientId: c.id, issuedClientName: c.name,
        notes: 'ترحيل/تصحيح تلقائي لعملية تسليم من المخزون (تمت مزامنتها تلقائياً مع شيت العملاء)'
      });
      migrated = true;
    }
  });
  if(migrated){ recalcBagFundLedger(); await saveBagStock(); await saveSettings(); }
  return migrated;
}
async function loadData(){
  try{
    const r = await window.storage.get('clients', false);
    clients = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ clients = []; }
  try{
    const r = await window.storage.get('settings', false);
    settings = r && r.value ? JSON.parse(r.value) : JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if(settings.bagPrice===undefined) settings.bagPrice = DEFAULT_SETTINGS.bagPrice;
    if(settings.priceSaudi===undefined) settings.priceSaudi = DEFAULT_SETTINGS.priceSaudi;
    if(settings.priceNonSaudi===undefined) settings.priceNonSaudi = DEFAULT_SETTINGS.priceNonSaudi;
    if(settings.bagFundBalance===undefined) settings.bagFundBalance = 0;
    if(!settings.expenseCategories) settings.expenseCategories = DEFAULT_SETTINGS.expenseCategories;
    if(settings.expenseCategories.includes('كهرباء وماء')){
      settings.expenseCategories = settings.expenseCategories.filter(c=>c!=='كهرباء وماء');
      ['كهرباء','مياه'].forEach(c=>{ if(!settings.expenseCategories.includes(c)) settings.expenseCategories.push(c); });
      await saveSettings();
    }
    if(!settings.expenseCategories.includes('مشتريات')){ settings.expenseCategories.push('مشتريات'); await saveSettings(); }
    if(!settings.nextVaultSeq) settings.nextVaultSeq = DEFAULT_SETTINGS.nextVaultSeq;
    if(!settings.powerAutomate) settings.powerAutomate = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.powerAutomate));
    if(settings.vaultLockedThrough===undefined) settings.vaultLockedThrough = DEFAULT_SETTINGS.vaultLockedThrough;
    if(settings.channels && typeof settings.channels[0]==='string'){
      settings.channels = settings.channels.map(n=>({name:n, dest:guessDest(n)}));
      await saveSettings();
    }
    if(!settings.channels) settings.channels = DEFAULT_SETTINGS.channels;
    if(!settings.centerInfo) settings.centerInfo = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.centerInfo));
    if(!settings.nextInvoiceNo) settings.nextInvoiceNo = 1;
    if(!settings.nextReturnInvoiceNo) settings.nextReturnInvoiceNo = 1;
    if(!settings.nextVoucherNo) settings.nextVoucherNo = 1;
    if(!settings.nextManualSalesInvoiceNo) settings.nextManualSalesInvoiceNo = 1;
    if(settings.darkMode===undefined) settings.darkMode = false;
    if(settings.soundEnabled===undefined) settings.soundEnabled = true;
    if(settings.autoBackupEnabled===undefined) settings.autoBackupEnabled = true;
    if(settings.lowBalanceThreshold===undefined) settings.lowBalanceThreshold = 5000;
    if(settings.bagOverdueDays===undefined) settings.bagOverdueDays = 14;
    if(settings.monthlyReportWhatsapp===undefined) settings.monthlyReportWhatsapp = '';
    if(settings.monthlyPdfReportsWhatsappNumbers===undefined) settings.monthlyPdfReportsWhatsappNumbers = '';
    if(settings.vatPdfReportWhatsappNumbers===undefined) settings.vatPdfReportWhatsappNumbers = '';
    if(settings.lastMonthlyReportPromptMonth===undefined) settings.lastMonthlyReportPromptMonth = null;
    if(!settings.autoBackupIntervalDays) settings.autoBackupIntervalDays = 7;
    if(settings.lastAutoBackupAt===undefined) settings.lastAutoBackupAt = null;
    if(settings.bagFinanceLinkEnabled===undefined) settings.bagFinanceLinkEnabled = true;
  }catch(e){ settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); await saveSettings(); }
  try{
    const r = await window.storage.get('bagStock', false);
    bagStock = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ bagStock = []; }
  // ترحيل/تصحيح تلقائي: أي عميل مصدر حقيبته "من المخزون" (bagSource==='stock') ولم يكن له عملية "تسليم"
  // مقابلة في سجل عمليات مخزون الحقائب — تُضاف له عملية بأثر رجعي، حتى يبقى "المخزون الحالي" مبنياً دائماً
  // على سجل عمليات المخزون نفسه ومتزامناً مع شيت العملاء. الدالة نفسها تُستدعى أيضاً بعد أي استيراد Excel
  // قد يضبط مصدر حقيبة عميل على "من المخزون"، حتى يتحدّث رقم المخزون فوراً دون الحاجة لإعادة تحميل التطبيق.
  await syncBagStockIssues();
  try{
    const r = await window.storage.get('vaultTx', false);
    vaultTx = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ vaultTx = []; }
  try{
    const r = await window.storage.get('deletedVaultTx', false);
    deletedVaultTx = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ deletedVaultTx = []; }
  try{
    const r = await window.storage.get('vaultDenomTx', false);
    vaultDenomTx = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ vaultDenomTx = []; }
  try{
    const r = await window.storage.get('bankStatementRows', false);
    bankStatementRows = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ bankStatementRows = []; }
  try{
    const r = await window.storage.get('deletedInvoices', false);
    deletedInvoices = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ deletedInvoices = []; }
  try{
    const r = await window.storage.get('courseSessions', false);
    courseSessions = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ courseSessions = []; }
  try{
    const r = await window.storage.get('appLang', false);
    currentLang = (r && r.value) ? r.value : 'ar';
  }catch(e){ currentLang = 'ar'; }
  // مفتاح users قديم/غير مستخدم فعلياً في أي قرار صلاحية حالياً (النظام الحقيقي
  // بالكامل عبر SERVER_AUTH_ROLE من الخادم منذ إزالة شاشة الدخول المحلي القديمة)،
  // فنحمّله فقط لو الدور الحالي admin — تمهيداً لتقييده على مستوى السيرفر بأمان
  // بدون أي طلب مرفوض أو رسالة خطأ مربكة لباقي الأدوار.
  if (normalizeRole(SERVER_AUTH_ROLE) === 'admin') {
    try{
      const r = await window.storage.get('users', false);
      users = r && r.value ? JSON.parse(r.value) : [];
    }catch(e){ users = []; }
    if(!users.length){
      users = [{username:'admin', password:'admin123', role:'admin', createdAt:Date.now()}];
      await saveUsers();
    }
    let rolesBackfilled = false;
    users.forEach(u=>{ if(!u.role){ u.role = 'admin'; rolesBackfilled = true; } });
    if(rolesBackfilled) await saveUsers();
  } else {
    users = [];
  }
  try{
    const r = await window.storage.get('auditLog', false);
    auditLog = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ auditLog = []; }
  try{
    const r = await window.storage.get('companies', false);
    companies = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ companies = []; }
  try{
    const r = await window.storage.get('companyTransfers', false);
    companyTransfers = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ companyTransfers = []; }
  try{
    const r = await window.storage.get('journalEntries', false);
    journalEntries = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ journalEntries = []; }
  try{
    const r = await window.storage.get('chartOfAccounts', false);
    chartOfAccounts = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ chartOfAccounts = []; }
  seedChartOfAccountsIfEmpty();
  try{
    const r = await window.storage.get('journalDE', false);
    journalDE = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ journalDE = []; }
  try{
    const r = await window.storage.get('budgetEntries', false);
    budgetEntries = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ budgetEntries = []; }
  try{
    const r = await window.storage.get('suppliers', false);
    suppliers = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ suppliers = []; }
  try{
    const r = await window.storage.get('purchases', false);
    purchases = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ purchases = []; }
  try{
    const r = await window.storage.get('manualSalesInvoices', false);
    manualSalesInvoices = r && r.value ? JSON.parse(r.value) : [];
  }catch(e){ manualSalesInvoices = []; }
  try{
    const r = await window.storage.get('zakatAdjustments', false);
    zakatAdjustments = r && r.value ? JSON.parse(r.value) : {};
  }catch(e){ zakatAdjustments = {}; }
}
async function saveUsers(){
  try{ await window.storage.set('users', JSON.stringify(users), false); }catch(e){ showToast('تعذر حفظ بيانات المستخدمين'); }
}
async function saveAuditLog(){
  try{ await window.storage.set('auditLog', JSON.stringify(auditLog), false); }catch(e){ /* silent */ }
}
async function logAudit(action, section, description){
  auditLog.push({
    id: uid(),
    ts: Date.now(),
    user: currentUser || 'غير معروف',
    action, // add | edit | delete
    section, // اسم الشيت
    description
  });
  await saveAuditLog();
}
async function saveClients(){
  try{ await window.storage.set('clients', JSON.stringify(clients), false); }catch(e){ showToast('تعذر حفظ البيانات'); }
}
async function saveSettings(){
  try{ await window.storage.set('settings', JSON.stringify(settings), false); }catch(e){ showToast('تعذر حفظ الإعدادات'); }
}
async function saveBagStock(){
  try{ await window.storage.set('bagStock', JSON.stringify(bagStock), false); }catch(e){ showToast('تعذر حفظ سجل المخزون'); }
}
async function saveVaultTx(){
  try{ await window.storage.set('vaultTx', JSON.stringify(vaultTx), false); }catch(e){ showToast('تعذر حفظ حركات الخزنة'); }
}
async function saveDeletedVaultTx(){
  try{ await window.storage.set('deletedVaultTx', JSON.stringify(deletedVaultTx), false); }catch(e){ showToast('تعذر حفظ سجل الحركات الملغاة'); }
}
async function saveVaultDenomTx(){
  try{ await window.storage.set('vaultDenomTx', JSON.stringify(vaultDenomTx), false); }catch(e){ showToast('تعذر حفظ سجل تصنيف الفئات النقدية'); }
}
async function saveBankStatementRows(){
  try{ await window.storage.set('bankStatementRows', JSON.stringify(bankStatementRows), false); }catch(e){ showToast('تعذر حفظ كشف الحساب البنكي'); }
}
async function saveDeletedInvoices(){
  try{ await window.storage.set('deletedInvoices', JSON.stringify(deletedInvoices), false); }catch(e){ showToast('تعذر حفظ سجل الفواتير المحذوفة'); }
}

/* ================= معايير محاسبية: ترقيم تسلسلي رسمي + قفل فترات + حذف منطقي ================= */
// رقم تسلسلي دائم لا يتكرر ولا يُعاد استخدامه لأي حركة مالية جديدة تُضاف لأي شاشة في النظام
function allocVaultSeq(){
  const s = settings.nextVaultSeq || 1;
  settings.nextVaultSeq = s + 1;
  return s;
}
// هل هذا التاريخ يقع ضمن فترة محاسبية مُقفلة (بعد اعتماد قوائمها)؟
function isDateLocked(dateStr){
  return !!(settings.vaultLockedThrough && dateStr && dateStr <= settings.vaultLockedThrough);
}
function vaultLockToast(){
  showToast(`هذه الحركة ضمن فترة محاسبية مُقفلة حتى ${settings.vaultLockedThrough} — لا يمكن إضافتها أو تعديلها أو حذفها. لتغيير ذلك راجع "قفل الفترة المحاسبية" أعلى شاشة الحركات المالية`);
}
// حذف منطقي (Soft Delete): تُنقل الحركة من السجل الفعّال إلى سجل الحركات الملغاة مع سبب موثّق، ولا تُحذف بياناتها نهائياً أبداً
function softDeleteVaultTx(id, reason){
  const idx = vaultTx.findIndex(t=>t.id===id);
  if(idx===-1) return null;
  const removed = vaultTx[idx];
  vaultTx.splice(idx,1);
  removed.deletedAt = Date.now();
  removed.deletedBy = currentUser || 'غير معروف';
  removed.deletedReason = reason || '';
  deletedVaultTx.push(removed);
  return removed;
}
// يسجّل نسخة "قبل/بعد" كاملة من الحركة ضمن سجل تعديلاتها الخاص (بدل الاكتفاء برسالة نصية في سجل المراجعة العام)
function pushVaultTxHistory(tx, beforeSnapshot, afterSnapshot){
  if(!tx.history) tx.history = [];
  tx.history.push({
    at: Date.now(),
    user: currentUser || 'غير معروف',
    before: beforeSnapshot,
    after: afterSnapshot
  });
}
async function saveCourseSessions(){
  try{ await window.storage.set('courseSessions', JSON.stringify(courseSessions), false); }catch(e){ showToast('تعذر حفظ بيانات الدورات'); }
}
async function saveCompanies(){
  try{ await window.storage.set('companies', JSON.stringify(companies), false); }catch(e){ showToast('تعذر حفظ بيانات الشركات'); }
}
async function saveCompanyTransfers(){
  try{ await window.storage.set('companyTransfers', JSON.stringify(companyTransfers), false); }catch(e){ showToast('تعذر حفظ بيانات تحويلات الشركات'); }
}
async function saveJournalEntries(){
  try{ await window.storage.set('journalEntries', JSON.stringify(journalEntries), false); }catch(e){ showToast('تعذر حفظ القيود اليدوية'); }
}
async function saveChartOfAccounts(){
  try{ await window.storage.set('chartOfAccounts', JSON.stringify(chartOfAccounts), false); }catch(e){ showToast('تعذر حفظ دليل الحسابات'); }
}
async function saveJournalDE(){
  try{ await window.storage.set('journalDE', JSON.stringify(journalDE), false); }catch(e){ showToast('تعذر حفظ القيود اليومية'); }
}
async function saveBudgetEntries(){
  try{ await window.storage.set('budgetEntries', JSON.stringify(budgetEntries), false); }catch(e){ showToast('تعذر حفظ بيانات الموازنة'); }
}
async function saveSuppliers(){
  try{ await window.storage.set('suppliers', JSON.stringify(suppliers), false); }catch(e){ showToast('تعذر حفظ بيانات الموردين'); }
}
async function savePurchases(){
  try{ await window.storage.set('purchases', JSON.stringify(purchases), false); }catch(e){ showToast('تعذر حفظ بيانات المشتريات'); }
}
async function saveManualSalesInvoices(){
  try{ await window.storage.set('manualSalesInvoices', JSON.stringify(manualSalesInvoices), false); }catch(e){ showToast('تعذر حفظ فواتير المبيعات اليدوية'); }
}
async function saveZakatAdjustments(){
  try{ await window.storage.set('zakatAdjustments', JSON.stringify(zakatAdjustments), false); }catch(e){ showToast('تعذر حفظ تعديلات وعاء الزكاة'); }
}

/* ========== نسخ احتياطي كامل / استعادة ========== */
function gatherFullBackupData(){
  return {
    _backupType: 'مركز-فهد-نسخة-احتياطية-كاملة',
    _createdAt: new Date().toISOString(),
    clients, settings, bagStock, vaultTx, courseSessions,
    users, auditLog, companies, companyTransfers, journalEntries, bankStatementRows,
    suppliers, purchases, vaultDenomTx, manualSalesInvoices, zakatAdjustments,
    chartOfAccounts, journalDE, budgetEntries
  };
}
function downloadFullBackup(auto){
  const data = gatherFullBackupData();
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `نسخة_احتياطية_كاملة_${stampNow()}${auto?'_تلقائية':''}.json`;
  a.click();
}
async function maybeRunAutoBackup(){
  if(!settings.autoBackupEnabled) return;
  const intervalMs = (Number(settings.autoBackupIntervalDays)||7) * 86400000;
  const last = settings.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).getTime() : 0;
  if(Date.now() - last < intervalMs) return;
  downloadFullBackup(true);
  settings.lastAutoBackupAt = new Date().toISOString();
  await saveSettings();
  showToast('تم إنشاء نسخة احتياطية تلقائية وتنزيلها');
}
async function restoreFullBackup(file){
  let data;
  try{
    const text = await file.text();
    data = JSON.parse(text);
  }catch(e){ showToast('تعذّرت قراءة ملف النسخة الاحتياطية — تأكد أنه ملف JSON صحيح'); return; }
  if(!data || typeof data!=='object' || !('clients' in data) || !('settings' in data)){
    showToast('هذا الملف لا يبدو نسخة احتياطية صحيحة لهذا البرنامج'); return;
  }
  if(!await customConfirm('سيتم استبدال كل البيانات الحالية في البرنامج (العملاء، الدورات، الحقائب، الحركات المالية، الشركات، الإعدادات، المستخدمين، وسجل المراجعة) بمحتوى ملف النسخة الاحتياطية المختار.\n\nيُنصَح بتنزيل نسخة احتياطية من الوضع الحالي أولاً قبل المتابعة. هل تريد المتابعة؟')){
    return;
  }
  // نسخة احتياطية من الوضع الحالي قبل الاستبدال، تحسّباً
  downloadFullBackup(false);
  clients = data.clients || [];
  settings = data.settings || JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  bagStock = data.bagStock || [];
  vaultTx = data.vaultTx || [];
  courseSessions = data.courseSessions || [];
  users = data.users && data.users.length ? data.users : users;
  auditLog = data.auditLog || [];
  companies = data.companies || [];
  companyTransfers = data.companyTransfers || [];
  journalEntries = data.journalEntries || [];
  bankStatementRows = data.bankStatementRows || [];
  suppliers = data.suppliers || [];
  purchases = data.purchases || [];
  vaultDenomTx = data.vaultDenomTx || [];
  manualSalesInvoices = data.manualSalesInvoices || [];
  zakatAdjustments = data.zakatAdjustments || {};
  chartOfAccounts = data.chartOfAccounts || [];
  seedChartOfAccountsIfEmpty();
  journalDE = data.journalDE || [];
  budgetEntries = data.budgetEntries || [];
  await Promise.allSettled([
    saveClients(), saveSettings(), saveBagStock(), saveVaultTx(),
    saveCourseSessions(), saveUsers(), saveAuditLog(), saveCompanies(), saveCompanyTransfers(), saveJournalEntries(), saveBankStatementRows(),
    saveSuppliers(), savePurchases(), saveVaultDenomTx(), saveManualSalesInvoices(), saveZakatAdjustments(),
    saveChartOfAccounts(), saveJournalDE(), saveBudgetEntries()
  ]);
  await logAudit('edit','الإعدادات', 'تمت استعادة كل بيانات البرنامج من ملف نسخة احتياطية');
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderZatca==='function') renderZatca();
  applyTheme(!!settings.darkMode); applySoundIcon();
  showToast('تمت استعادة البيانات بنجاح');
}

const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
function showToast(msg){
  const t = $('#toast');
  const isError = /تعذّر|تعذر|خطأ|فشل|غير صحيح/.test(msg);
  const isDelete = /حذف/.test(msg);
  t.innerHTML = `<span>${isError ? ICON_WARN : ICON_OK}</span><span>${escapeHtml(msg)}</span>`;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.remove('show'), 2400);
  if(isError) SoundFX.error();
  else if(isDelete) SoundFX.delete();
  else SoundFX.success();
}

/* ==========================================================================
   عرض أخطاء الجافاسكربت بصرياً داخل الصفحة نفسها (بدل الاعتماد على Console
   أدوات المطوّر، لأنها قد لا تكون متاحة في بعض بيئات التشغيل مثل تطبيقات
   سطح المكتب المغلقة). أي خطأ غير متوقع يظهر في صندوق أحمر أعلى الصفحة مع
   نص الخطأ الكامل، بدل أن يختفي بصمت ويبدو الزر وكأنه "لا يعمل".
   ========================================================================== */
function showFatalErrorBox(title, err){
  let box = document.getElementById('js-error-box');
  if(!box){
    box = document.createElement('div');
    box.id = 'js-error-box';
    box.style.cssText = 'position:fixed; top:10px; left:10px; right:10px; z-index:99999; background:#fff3f0; border:2px solid #c0392b; color:#7a1f14; padding:14px 18px; border-radius:10px; font-size:13px; font-family:monospace; direction:ltr; text-align:left; max-height:40vh; overflow:auto; box-shadow:0 6px 20px rgba(0,0,0,.25);';
    document.body.appendChild(box);
  }
  const msg = (err && (err.stack || err.message)) || String(err);
  box.innerHTML = `<div style="direction:rtl; font-family:'Tajawal',sans-serif; font-weight:800; margin-bottom:8px; display:flex; justify-content:space-between;"><span>⚠️ خطأ برمجي: ${title}</span><button style="border:none;background:#c0392b;color:#fff;border-radius:6px;padding:2px 10px;cursor:pointer;" onclick="document.getElementById('js-error-box').remove()">إغلاق</button></div><pre style="white-space:pre-wrap; margin:0;">${String(msg).replace(/</g,'&lt;')}</pre>`;
}
window.addEventListener('error', e=>{
  showFatalErrorBox(e.message || 'خطأ غير معروف', e.error);
});
window.addEventListener('unhandledrejection', e=>{
  showFatalErrorBox('(Promise) '+((e.reason && e.reason.message) || 'خطأ غير معروف'), e.reason);
});

/* =====================================================================
   بديل مخصص لـ confirm()/prompt() الأصليتين في المتصفح.
   السبب: نوافذ confirm()/prompt() الأصلية قد تُحجب بصمت (بدون أي رسالة خطأ)
   داخل بيئات معاينة معينة (مثل معاينة الـ Artifacts)، فتبدو الأزرار وكأنها
   "لا تعمل" رغم أن الكود يعمل فعلياً. هذا الحل يستخدم نافذة منبثقة داخل
   الصفحة نفسها (Modal) بدلاً من نافذة المتصفح النظامية، فتعمل في كل بيئة.
   ===================================================================== */
let _customDialogResolve = null;
function _closeCustomDialog(result){
  $('#custom-dialog-overlay').classList.remove('show');
  const resolve = _customDialogResolve;
  _customDialogResolve = null;
  if(resolve) resolve(result);
}
$('#custom-dialog-cancel').addEventListener('click', ()=> _closeCustomDialog(null));
$('#custom-dialog-overlay').addEventListener('click', e=>{ if(e.target.id==='custom-dialog-overlay') _closeCustomDialog(null); });
$('#custom-dialog-input').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#custom-dialog-ok').click(); } });
$('#custom-dialog-ok').addEventListener('click', ()=>{
  const input = $('#custom-dialog-input');
  const errEl = $('#custom-dialog-error');
  if(input.style.display!=='none'){
    const val = input.value;
    if(input.dataset.required==='1' && !val.trim()){
      errEl.textContent = 'هذا الحقل إلزامي';
      errEl.style.display = 'block';
      input.focus();
      return;
    }
    _closeCustomDialog(val);
  }else{
    _closeCustomDialog(true);
  }
});
// بديل confirm(): يرجع Promise<boolean>
function customConfirm(message, title){
  return new Promise(resolve=>{
    _customDialogResolve = v=> resolve(!!v);
    $('#custom-dialog-title').textContent = title || 'تأكيد';
    $('#custom-dialog-message').textContent = message;
    const input = $('#custom-dialog-input');
    input.style.display = 'none';
    input.value = '';
    $('#custom-dialog-error').style.display = 'none';
    $('#custom-dialog-overlay').classList.add('show');
    $('#custom-dialog-ok').focus();
  });
}
// بديل prompt(): يرجع Promise<string|null>. إن كان required=true فالحقل إلزامي (لا يُغلق إلا بقيمة أو بالإلغاء)
function customPrompt(message, {title, required=false, placeholder=''}={}){
  return new Promise(resolve=>{
    _customDialogResolve = v=> resolve(v===null || v===undefined ? null : v);
    $('#custom-dialog-title').textContent = title || 'إدخال';
    $('#custom-dialog-message').textContent = message;
    const input = $('#custom-dialog-input');
    input.style.display = 'block';
    input.value = '';
    input.placeholder = placeholder;
    input.dataset.required = required ? '1' : '0';
    $('#custom-dialog-error').style.display = 'none';
    $('#custom-dialog-overlay').classList.add('show');
    setTimeout(()=> input.focus(), 30);
  });
}

/* ===== نظام التراجع والتقدم العام (Undo / Redo) =====
   قبل أي عملية إضافة/تعديل/حذف في أي جزء من البرنامج، نأخذ نسخة كاملة من البيانات
   ونضعها في مكدس التراجع. زر "تراجع" يعيد آخر نسخة محفوظة، وزر "تقدم" يعيد تنفيذ
   العملية التي تم التراجع عنها إن لم يقم المستخدم بأي عملية جديدة بعدها. */
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 20;
function currentStateSnapshot(label){
  return {
    label,
    ts: Date.now(),
    clients: JSON.parse(JSON.stringify(clients)),
    vaultTx: JSON.parse(JSON.stringify(vaultTx)),
    bagStock: JSON.parse(JSON.stringify(bagStock)),
    courseSessions: JSON.parse(JSON.stringify(courseSessions)),
    settings: JSON.parse(JSON.stringify(settings)),
    users: JSON.parse(JSON.stringify(users)),
    companies: JSON.parse(JSON.stringify(companies)),
    companyTransfers: JSON.parse(JSON.stringify(companyTransfers))
  };
}
function snapshotState(label){
  try{
    undoStack.push(currentStateSnapshot(label));
    if(undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = []; // أي عملية جديدة تُلغي إمكانية "التقدم" السابقة
    updateUndoRedoButtons();
  }catch(e){ /* تجاهل أي خطأ في أخذ النسخة الاحتياطية حتى لا يوقف العملية الأصلية */ }
}
function updateUndoRedoButtons(){
  const ub = $('#btn-undo');
  if(ub){
    if(undoStack.length){
      ub.disabled = false; ub.style.opacity = '1';
      ub.title = `تراجع عن: ${undoStack[undoStack.length-1].label}`;
    }else{
      ub.disabled = true; ub.style.opacity = '.5';
      ub.title = 'لا توجد عملية للتراجع عنها';
    }
  }
  const rb = $('#btn-redo');
  if(rb){
    if(redoStack.length){
      rb.disabled = false; rb.style.opacity = '1';
      rb.title = `تقدم إلى: ${redoStack[redoStack.length-1].label}`;
    }else{
      rb.disabled = true; rb.style.opacity = '.5';
      rb.title = 'لا توجد عملية للتقدم إليها';
    }
  }
}
async function applyStateSnapshot(entry){
  clients = entry.clients;
  vaultTx = entry.vaultTx;
  bagStock = entry.bagStock;
  courseSessions = entry.courseSessions;
  settings = entry.settings;
  users = entry.users;
  companies = entry.companies || [];
  companyTransfers = entry.companyTransfers || [];
  await saveClients();
  await saveVaultTx();
  await saveBagStock();
  await saveCourseSessions();
  await saveSettings();
  await saveUsers();
  await saveCompanies();
  await saveCompanyTransfers();
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof refreshAuditFilterOptions==='function') refreshAuditFilterOptions();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderUsersList==='function') renderUsersList();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderCompanies==='function') renderCompanies();
}
async function performUndo(){
  if(!undoStack.length){ showToast('لا توجد عملية للتراجع عنها'); return; }
  redoStack.push(currentStateSnapshot(undoStack[undoStack.length-1].label));
  const entry = undoStack.pop();
  await applyStateSnapshot(entry);
  await logAudit('edit','النظام', `تم التراجع عن العملية: ${entry.label}`);
  updateUndoRedoButtons();
  showToast(`تم التراجع عن: ${entry.label}`);
}
async function performRedo(){
  if(!redoStack.length){ showToast('لا توجد عملية للتقدم إليها'); return; }
  const label = redoStack[redoStack.length-1].label;
  undoStack.push(currentStateSnapshot(label));
  const entry = redoStack.pop();
  await applyStateSnapshot(entry);
  await logAudit('edit','النظام', `تم التقدم لإعادة العملية: ${entry.label}`);
  updateUndoRedoButtons();
  showToast(`تم التقدم إلى: ${entry.label}`);
}
document.addEventListener('DOMContentLoaded', ()=>{
  const ub=$('#btn-undo'); if(ub) ub.addEventListener('click', performUndo);
  const rb=$('#btn-redo'); if(rb) rb.addEventListener('click', performRedo);
});
if(document.readyState!=='loading'){
  const ub=$('#btn-undo'); if(ub) ub.addEventListener('click', performUndo);
  const rb=$('#btn-redo'); if(rb) rb.addEventListener('click', performRedo);
}

/* ---------------- اختصارات لوحة المفاتيح ---------------- */
/* خريطة كل نافذة منبثقة (overlay) بمعرّف زر الإلغاء/الإغلاق الخاص بها، لإعادة استخدام منطق الإغلاق
   الأصلي لكل نافذة (بما فيه تصفير أي متغيرات حالة مرتبطة) بدل التعامل معها كصندوق أسود واحد */
const KB_OVERLAY_CANCEL = {
  'custom-dialog-overlay': 'custom-dialog-cancel',
  'overlay': 'btn-cancel',
  'bulk-add-overlay': 'btn-bulk-add-cancel',
  'bulk-update-overlay': 'btn-bulk-update-cancel',
  'bulk-message-overlay': 'btn-bulk-message-cancel',
  'bulk-delete-overlay': 'btn-bulk-delete-cancel',
  'cs-bulk-overlay': 'cs-bulk-cancel',
  'refnum-bulk-overlay': 'refnum-bulk-cancel',
  'ci-bulk-overlay': 'ci-bulk-cancel',
  'vault-overlay': 'vf-cancel',
  'ctrainee-overlay': 'ctr-cancel',
  'ctimporttext-overlay': 'ctit-cancel',
  'bag-overlay': 'bp-cancel',
  'session-overlay': 'sf-cancel',
  'voided-overlay': 'voided-close',
  'shortcuts-overlay': 'shortcuts-close'
};
const KB_TAB_KEYS = {'1':'dashboard','2':'clients','3':'companies','4':'courses','5':'courseinvoices','6':'vault','7':'bags','8':'reports','9':'accounting','0':'audit'};
function kbIsTypingTarget(el){
  if(!el) return false;
  const tag = (el.tagName||'').toLowerCase();
  return tag==='input' || tag==='textarea' || tag==='select' || el.isContentEditable;
}
function kbAnyOverlayOpen(){
  return Object.keys(KB_OVERLAY_CANCEL).some(id=>{ const ov=document.getElementById(id); return ov && ov.classList.contains('show'); }) || !!document.getElementById('print-preview-overlay');
}
function kbCloseTopOverlay(){
  // أولوية: نافذة التأكيد المخصصة (أعلى طبقة دوماً) ثم نافذة معاينة الطباعة إن كانت مفتوحة، ثم باقي النوافذ
  const cd = document.getElementById('custom-dialog-overlay');
  if(cd && cd.classList.contains('show')){ document.getElementById('custom-dialog-cancel')?.click(); return true; }
  const pp = document.getElementById('print-preview-overlay');
  if(pp){ pp.remove(); return true; }
  for(const [ovId, cancelId] of Object.entries(KB_OVERLAY_CANCEL)){
    if(ovId==='custom-dialog-overlay') continue;
    const ov = document.getElementById(ovId);
    if(ov && ov.classList.contains('show')){ document.getElementById(cancelId)?.click(); return true; }
  }
  return false;
}
function kbSaveOpenOverlay(){
  for(const ovId of Object.keys(KB_OVERLAY_CANCEL)){
    const ov = document.getElementById(ovId);
    if(ov && ov.classList.contains('show')){
      const form = ov.querySelector('form');
      if(form){ if(form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit',{cancelable:true})); return true; }
      const primaryBtn = ov.querySelector('.modal-actions .btn-primary');
      if(primaryBtn){ primaryBtn.click(); return true; }
    }
  }
  return false;
}
document.addEventListener('keydown', e=>{
  // لا تعمل الاختصارات قبل تفعيل الترخيص أو تسجيل الدخول
  const lic = document.getElementById('license-screen');
  const srvLog = document.getElementById('server-login-screen');
  if(lic && lic.style.display!=='none') return;
  if(srvLog && srvLog.style.display==='flex') return; // شاشة تسجيل الدخول على السيرفر لا تزال ظاهرة
  const typing = kbIsTypingTarget(document.activeElement);
  // Esc: إغلاق أي نافذة منبثقة مفتوحة
  if(e.key==='Escape'){
    if(kbCloseTopOverlay()) e.preventDefault();
    return;
  }
  // ؟ : عرض/إخفاء قائمة الاختصارات
  if(!typing && (e.key==='؟' || e.key==='?')){
    e.preventDefault();
    document.getElementById('shortcuts-overlay')?.classList.toggle('show');
    return;
  }
  // Ctrl/Cmd + S: حفظ النموذج المفتوح حالياً (بدل حفظ صفحة المتصفح)
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase()==='s'){
    if(kbAnyOverlayOpen()){ e.preventDefault(); kbSaveOpenOverlay(); }
    return;
  }
  // Ctrl/Cmd + Z: تراجع عن آخر عملية (فقط خارج الكتابة النصية وخارج أي نافذة مفتوحة، حتى لا يتعارض مع تراجع الكتابة الافتراضي في المتصفح)
  if((e.ctrlKey||e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='z'){
    if(!typing && !kbAnyOverlayOpen()){ e.preventDefault(); performUndo(); }
    return;
  }
  // Ctrl/Cmd + Shift + Z: إعادة (تقدّم) العملية
  if((e.ctrlKey||e.metaKey) && e.shiftKey && e.key.toLowerCase()==='z'){
    if(!typing && !kbAnyOverlayOpen()){ e.preventDefault(); performRedo(); }
    return;
  }
  // / : الانتقال لتبويب العملاء والتركيز على مربع البحث
  if(e.key==='/' && !typing && !kbAnyOverlayOpen()){
    e.preventDefault();
    const clientsBtn = document.querySelector('nav.tabs button[data-view="clients"]');
    if(clientsBtn && !clientsBtn.classList.contains('active')) clientsBtn.click();
    document.getElementById('search')?.focus();
    return;
  }
  // Alt + N: إضافة عميل جديد
  if(e.altKey && !e.ctrlKey && e.key.toLowerCase()==='n'){
    e.preventDefault();
    if(kbAnyOverlayOpen()) return;
    const clientsBtn = document.querySelector('nav.tabs button[data-view="clients"]');
    if(clientsBtn && !clientsBtn.classList.contains('active')) clientsBtn.click();
    document.getElementById('btn-add')?.click();
    return;
  }
  // Alt + S: تبويب الإعدادات
  if(e.altKey && !e.ctrlKey && e.key.toLowerCase()==='s'){
    e.preventDefault();
    document.querySelector('nav.tabs button[data-view="settings"]')?.click();
    return;
  }
  // Alt + 0..9: التنقل المباشر بين التبويبات
  if(e.altKey && !e.ctrlKey && KB_TAB_KEYS[e.key]){
    e.preventDefault();
    document.querySelector(`nav.tabs button[data-view="${KB_TAB_KEYS[e.key]}"]`)?.click();
    return;
  }
});
document.getElementById('btn-shortcuts-help')?.addEventListener('click', ()=> document.getElementById('shortcuts-overlay').classList.add('show'));
document.getElementById('shortcuts-close')?.addEventListener('click', ()=> document.getElementById('shortcuts-overlay').classList.remove('show'));
document.getElementById('shortcuts-overlay')?.addEventListener('click', e=>{ if(e.target.id==='shortcuts-overlay') document.getElementById('shortcuts-overlay').classList.remove('show'); });

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function stampNow(){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function downloadXlsx(filename, sheetName, rows){
  const safeRows = (rows && rows.length) ? rows : [{'—':'لا توجد بيانات'}];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0,31));
  XLSX.writeFile(wb, filename);
}
function num(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function fmt(n){ return n.toLocaleString('en-US',{maximumFractionDigits:2}); }
/* ---------------- تفقيط المبالغ (تحويل الرقم إلى كتابة بالحروف) ---------------- */
function numberToArabicWords(amount){
  amount = Math.round((num(amount) + Number.EPSILON) * 100) / 100;
  const negative = amount < 0;
  amount = Math.abs(amount);
  let riyals = Math.floor(amount);
  let halalas = Math.round((amount - riyals) * 100);
  if(halalas >= 100){ riyals += 1; halalas = 0; }

  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
  const onesF = ['', 'إحدى', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع'];
  const teens = ['عشرة','أحد عشر','اثنا عشر','ثلاثة عشر','أربعة عشر','خمسة عشر','ستة عشر','سبعة عشر','ثمانية عشر','تسعة عشر'];
  const teensF = ['عشرة','إحدى عشرة','اثنتا عشرة','ثلاث عشرة','أربع عشرة','خمس عشرة','ست عشرة','سبع عشرة','ثمان عشرة','تسع عشرة'];
  const tensWords = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مئتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  const oneScale = ['', 'ألف', 'مليون', 'مليار'];
  const twoScale = ['', 'ألفان', 'مليونان', 'ملياران'];
  const pluralScale = ['', 'آلاف', 'ملايين', 'مليارات'];

  function threeDigitsToWords(n, feminine){
    if(n===0) return '';
    const o = feminine ? onesF : ones;
    const t = feminine ? teensF : teens;
    const h = Math.floor(n/100), r = n%100;
    const parts = [];
    if(h>0) parts.push(hundreds[h]);
    if(r>0){
      if(r<10) parts.push(o[r]);
      else if(r<20) parts.push(t[r-10]);
      else{
        const td = Math.floor(r/10), od = r%10;
        parts.push(od>0 ? (o[od] + ' و' + tensWords[td]) : tensWords[td]);
      }
    }
    return parts.join(' و');
  }
  function integerToWords(n){
    if(n===0) return 'صفر';
    const groups = [];
    let x = n;
    while(x>0){ groups.push(x%1000); x = Math.floor(x/1000); }
    const segments = [];
    for(let i=groups.length-1;i>=0;i--){
      const g = groups[i];
      if(g===0) continue;
      if(i===0){ segments.push(threeDigitsToWords(g, false)); }
      else if(g===1){ segments.push(oneScale[i]); }
      else if(g===2){ segments.push(twoScale[i]); }
      else if(g>=3 && g<=10){ segments.push(threeDigitsToWords(g, true) + ' ' + pluralScale[i]); }
      else{ segments.push(threeDigitsToWords(g, false) + ' ' + oneScale[i]); }
    }
    return segments.join(' و');
  }

  let words = integerToWords(riyals) + ' ريال سعودي';
  if(halalas>0) words += ' و' + integerToWords(halalas) + ' هللة';
  words = 'فقط ' + words + ' لا غير';
  if(negative) words = 'سالب ' + words;
  return words;
}
/* تاريخ اليوم بالتوقيت المحلي (وليس UTC)، لتجنّب رجوع التاريخ يوماً للخلف في الساعات الأولى من اليوم */
function todayISO(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
/* إضافة عدد أيام إلى تاريخ ISO (YYYY-MM-DD) وإرجاع الناتج بنفس الصيغة */
function addDaysISO(iso, days){
  const base = iso ? new Date(iso+'T00:00:00') : new Date();
  base.setDate(base.getDate() + days);
  const y = base.getFullYear();
  const m = String(base.getMonth()+1).padStart(2,'0');
  const d = String(base.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

/* فهرس مؤقت: حركات "وارد" في الخزنة مجمّعة حسب رقم هوية العميل، لتفادي مسح كامل vaultTx
   من جديد لكل عميل عند حساب المدفوعات (كان بطيئاً مع آلاف العملاء والحركات).
   يُبنى عند أول استخدام ثم يُفرَّغ تلقائياً بعد نهاية دورة التنفيذ الحالية (microtask)،
   فيبقى صحيحاً دائماً بغض النظر عن أي تعديل لاحق على vaultTx، دون حاجة لأي تحديث يدوي له. */
let _vaultInTxIndexCache = null;
function vaultInTxIndex(){
  if(_vaultInTxIndexCache) return _vaultInTxIndexCache;
  const map = new Map();
  for(const t of vaultTx){
    if(t.type==='in' && t.clientId){
      let arr = map.get(t.clientId);
      if(!arr){ arr = []; map.set(t.clientId, arr); }
      arr.push(t);
    }
  }
  _vaultInTxIndexCache = map;
  Promise.resolve().then(()=>{ _vaultInTxIndexCache = null; });
  return map;
}
/* نفس فكرة الفهرس أعلاه، لكن لحركات "مردودات المبيعات" (isReturn) المرتبطة برقم هوية العميل،
   حتى تُخصم قيمتها من إجمالي المدفوع لهذا العميل. */
let _vaultReturnTxIndexCache = null;
function vaultReturnTxIndex(){
  if(_vaultReturnTxIndexCache) return _vaultReturnTxIndexCache;
  const map = new Map();
  for(const t of vaultTx){
    if(t.isReturn && t.clientId){
      let arr = map.get(t.clientId);
      if(!arr){ arr = []; map.set(t.clientId, arr); }
      arr.push(t);
    }
  }
  _vaultReturnTxIndexCache = map;
  Promise.resolve().then(()=>{ _vaultReturnTxIndexCache = null; });
  return map;
}
function bagAmount(c){ return c.bagSource==='own' ? 0 : num(c.bagPrice); }
function centerIncome(c){ return num(c.coursePrice) - num(c.discount); }
function total(c){ return centerIncome(c) + bagAmount(c); }
function paidTotal(c){
  // إجمالي كل المبالغ الواردة المرتبطة برقم هوية هذا العميل في "الحركات المالية"
  // (الدفعة عند التسجيل + أي دفعات لاحقة تُسجَّل مباشرة في تبويب الحركات المالية بنفس رقم الهوية)
  // ناقصاً أي مردودات مبيعات سُجِّلت له، فتُخصم من إجمالي مدفوعاته فوراً.
  if(!c.clientId) return num(c.paid) + num(c.paid2);
  const txs = vaultInTxIndex().get(c.clientId);
  const inSum = txs ? txs.reduce((s,t)=>s+num(t.amount),0) : 0;
  const returnTxs = vaultReturnTxIndex().get(c.clientId);
  const returnSum = returnTxs ? returnTxs.reduce((s,t)=>s+num(t.amount),0) : 0;
  return Math.max(0, inSum - returnSum);
}
function remaining(c){ return Math.max(0, total(c) - paidTotal(c)); }
function paymentChannelsLabel(c){
  // نبني طريقة الدفع من كل الحركات الواردة المرتبطة برقم هوية هذا العميل في "الحركات المالية"
  // (تشمل دفعتَي التسجيل المُرحَّلتين تلقائياً، وأي دفعة إضافية أُضيفت لاحقاً يدوياً من تبويب "الحركات المالية" بنفس رقم الهوية)
  // بهذا يظهر أي تعديل أو دفعة جديدة تُسجَّل من الحركات المالية مباشرة في شيت العملاء دون الحاجة لتعديل العميل يدوياً.
  if(c.clientId){
    const txs = (vaultInTxIndex().get(c.clientId) || []).filter(t=>num(t.amount)>0);
    if(txs.length){
      const byMethod = {};
      const order = [];
      txs.forEach(t=>{
        const m = t.method || '—';
        if(!(m in byMethod)) order.push(m);
        byMethod[m] = (byMethod[m]||0) + num(t.amount);
      });
      return order.map(m=> `${m} (${fmt(byMethod[m])})`).join(' + ');
    }
  }
  const parts = [];
  if(num(c.paid)>0 && c.channel) parts.push(`${c.channel} (${fmt(num(c.paid))})`);
  if(num(c.paid2)>0 && c.channel2) parts.push(`${c.channel2} (${fmt(num(c.paid2))})`);
  return parts.length ? parts.join(' + ') : (c.channel || '—');
}
function bagSourceLabel(c){
  if(c.bagSource==='own') return 'خاصته';
  if(c.bagSource==='stock') return 'من المخزون';
  return c.bagStatus==='purchased' ? 'تم الشراء' : 'مطلوب شراء';
}
/* هل حقيبة هذا العميل بحالة "مطلوب شراء" نظيفة أصلاً (بدون فاتورة أو تاريخ شراء)؟ أي لا يوجد شيء لإلغائه */
function clientBagIsClean(c){
  return c.bagSource==='buy' && c.bagStatus==='pending' && !c.bagInvoice && !c.bagPurchaseDate;
}
/* إلغاء حقيبة عميل واحد: تُحذف تماماً من سجل عمليات الشراء المكتملة ومن سجل "اشتروا حقيبتهم الخاصة"،
   وتعود حالته إلى "مطلوب شراء" بقيمة الحقيبة الافتراضية من الإعدادات (كما لو لم تُحدَّد له حقيبة من قبل) */
function resetClientBagToPending(c){
  // إن كانت الحقيبة مُسلَّمة من المخزون، نحذف عملية "التسليم" المرتبطة بها من سجل عمليات مخزون الحقائب أولاً
  // حتى تُضاف الحقيبة تلقائياً للمخزون المتاح مجدداً (المخزون الحالي يُحسب بالكامل من هذا السجل)
  if(c.bagSource==='stock'){
    const idx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===c.id);
    if(idx>-1){ bagStock.splice(idx,1); recalcBagFundLedger(); }
  }
  c.bagSource = 'buy';
  c.bagPrice = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  c.bagInvoice = '';
  c.bagStatus = 'pending';
  delete c.bagPurchaseDate;
  delete c.bagPaymentMethod;
  syncClientLedgerEntry(c);
}
/* تحديد أن هذا العميل اشترى حقيبته الخاصة: تُصفَّر قيمة الحقيبة فوراً وتختفي من كل سجلات الحقائب (يُستخدم من نموذج الاستيراد الجماعي) */
function markClientBagOwn(c){
  c.bagSource = 'own';
  c.bagPrice = 0;
  c.bagInvoice = '';
  c.bagStatus = 'n/a';
  delete c.bagPurchaseDate;
  delete c.bagPaymentMethod;
  syncClientLedgerEntry(c);
}
/* زر سريع لإلغاء الحقيبة يظهر بجانب حالة الحقيبة في شيت العملاء — يظهر فقط إن كان هناك فعلاً حقيبة/بيانات لإلغائها */
function bagCancelBtnHtml(c){
  if(clientBagIsClean(c)) return '';
  return ` <button class="btn btn-ghost btn-sm" data-cancelbag="${c.id}" title="إلغاء الحقيبة المسجّلة لهذا العميل وإعادته لحالة مطلوب شراء" style="padding:2px 6px; font-size:11px; margin-inline-start:4px;">إلغاء الحقيبة</button>`;
}
/* خانة سريعة لشراء الحقيبة تظهر بجانب حالة "مطلوب شراء" — تُتيح الشراء مباشرة من مكانها */
function bagBuyCheckboxHtml(c){
  if(c.bagSource!=='buy' || c.bagStatus==='purchased') return '';
  return ` <label style="display:inline-flex; align-items:center; gap:3px; cursor:pointer; margin-inline-start:6px; font-size:11.5px; color:var(--text-muted);" title="اضغط لتسليم الحقيبة الآن من المخزون">
    <input type="checkbox" data-bagbuy="${c.id}"> شراء
  </label>`;
}
function courseDurationDays(courseType){
  const n = String(courseType||'').toLowerCase();
  return n.includes('food') || n.includes('غذائي') || n.includes('سلامة') ? 2 : 1;
}

/* ---------------- توحيد أسماء أنواع الدورات (منع التكرار بسبب اختلاف حالة الأحرف أو المسافات الزائدة) ---------------- */
/* تعيد الاسم "المعتمد" لنوع الدورة كما هو مسجّل في قائمة أنواع الدورات بالإعدادات (settings.courses)،
   بمطابقة غير حساسة لحالة الأحرف وتجاهل المسافات الزائدة — حتى لا يُحسب "Food safety" و"food safety" كنوعين مختلفين */
function normalizeCourseTypeValue(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return v;
  const match = settings.courses.find(c=> String(c.name||'').trim().toLowerCase() === v.toLowerCase());
  return match ? match.name : v;
}
/* يوحّد قائمة أنواع الدورات نفسها في الإعدادات (يدمج أي اسمين مكررين يختلفان فقط بحالة الأحرف/مسافات زائدة في واحد فقط)،
   ثم يصحح نوع الدورة المسجّل على كل عميل ودورة في الشيت بالكامل ليطابق الاسم المعتمد — يعمل مرة تلقائياً عند كل فتح للبرنامج
   ولا يكرر أي تصحيح تم بالفعل (آمن التكرار). */
async function cleanupDuplicateCourseTypes(){
  let changed = false;
  // 1) نحسب عدد مرات استخدام كل صياغة (حالة أحرف) فعلياً في شيت العملاء وشيت الدورات،
  //    لاختيار الصياغة الأكثر استخدامًا كصياغة معتمدة لكل نوع دورة (بدل الاعتماد على ترتيب الإدخال فقط)
  const usageCount = new Map(); // lowercase key -> Map(variant -> count)
  const bump = (raw)=>{
    const v = String(raw||'').trim().replace(/\s+/g,' ');
    if(!v) return;
    const key = v.toLowerCase();
    if(!usageCount.has(key)) usageCount.set(key, new Map());
    const variants = usageCount.get(key);
    variants.set(v, (variants.get(v)||0)+1);
  };
  clients.forEach(c=> bump(c.courseType));
  courseSessions.forEach(s=> bump(s.courseType));
  (settings.courses||[]).forEach(c=> bump(c.name));
  const canonicalOf = new Map(); // lowercase key -> chosen variant name
  usageCount.forEach((variants, key)=>{
    let best = null, bestCount = -1;
    variants.forEach((count, variant)=>{ if(count>bestCount){ best = variant; bestCount = count; } });
    canonicalOf.set(key, best);
  });
  // 2) دمج التكرار داخل قائمة أنواع الدورات نفسها (الإعدادات) حسب الصياغة المعتمدة لكل اسم
  const seenSettings = new Map();
  const dedupedCourses = [];
  (settings.courses||[]).forEach(c=>{
    const key = String(c.name||'').trim().toLowerCase();
    if(!key) return;
    const canonicalName = canonicalOf.get(key) || c.name.trim();
    if(seenSettings.has(key)){
      const original = seenSettings.get(key);
      if(!original.price && c.price) original.price = c.price;
      changed = true;
    }else{
      const entry = {name:canonicalName, price:c.price};
      if(entry.name !== c.name) changed = true;
      seenSettings.set(key, entry);
      dedupedCourses.push(entry);
    }
  });
  if(changed) settings.courses = dedupedCourses;
  // 3) تصحيح نوع الدورة المسجّل على كل عميل ليطابق الصياغة المعتمدة
  let clientsChanged = false;
  clients.forEach(c=>{
    if(!c.courseType) return;
    const key = String(c.courseType).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeCourseTypeValue(c.courseType);
    if(fixed !== c.courseType){ c.courseType = fixed; clientsChanged = true; }
  });
  // 4) تصحيح نوع الدورة المسجّل على كل دورة في شيت الدورات
  let sessionsChanged = false;
  courseSessions.forEach(s=>{
    if(!s.courseType) return;
    const key = String(s.courseType).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeCourseTypeValue(s.courseType);
    if(fixed !== s.courseType){ s.courseType = fixed; sessionsChanged = true; }
  });
  if(changed || clientsChanged || sessionsChanged){
    if(changed) await saveSettings();
    if(clientsChanged) await saveClients();
    if(sessionsChanged) await saveCourseSessions();
    await logAudit('edit','الإعدادات', 'تصحيح تلقائي: توحيد أسماء أنواع الدورات المكررة (بسبب اختلاف حالة الأحرف أو مسافات زائدة) في شيت العملاء وشيت الدورات وقائمة الإعدادات');
  }
}

/* ---------------- توحيد أسماء الجنسيات (منع التكرار بسبب اختلاف حالة الأحرف أو مسافات زائدة) ---------------- */
/* تعيد الاسم "المعتمد" للجنسية كما هو مسجّل في قائمة الجنسيات بالإعدادات (settings.nationalities)،
   بمطابقة غير حساسة لحالة الأحرف وتجاهل المسافات الزائدة — حتى لا تُحسب "Yemeni" و"yemeni" كجنسيتين مختلفتين */
function normalizeNationalityValue(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return v;
  const match = (settings.nationalities||[]).find(n=> String(n||'').trim().toLowerCase() === v.toLowerCase());
  return match ? match : v;
}
/* يوحّد قائمة الجنسيات نفسها في الإعدادات (يدمج أي اسمين مكررين يختلفان فقط بحالة الأحرف/مسافات زائدة في واحد فقط)،
   ثم يصحح الجنسية المسجّلة على كل عميل في الشيت بالكامل لتطابق الاسم المعتمد — يعمل مرة تلقائياً عند كل فتح للبرنامج
   ولا يكرر أي تصحيح تم بالفعل (آمن التكرار). */
async function cleanupDuplicateNationalities(){
  let changed = false;
  // 1) نحسب عدد مرات استخدام كل صياغة (حالة أحرف) فعلياً في شيت العملاء وقائمة الجنسيات بالإعدادات،
  //    لاختيار الصياغة الأكثر استخداماً كصياغة معتمدة لكل جنسية
  const usageCount = new Map(); // lowercase key -> Map(variant -> count)
  const bump = (raw)=>{
    const v = String(raw||'').trim().replace(/\s+/g,' ');
    if(!v) return;
    const key = v.toLowerCase();
    if(!usageCount.has(key)) usageCount.set(key, new Map());
    const variants = usageCount.get(key);
    variants.set(v, (variants.get(v)||0)+1);
  };
  clients.forEach(c=> bump(c.nationality));
  (settings.nationalities||[]).forEach(n=> bump(n));
  const canonicalOf = new Map(); // lowercase key -> chosen variant name
  usageCount.forEach((variants, key)=>{
    let best = null, bestCount = -1;
    variants.forEach((count, variant)=>{ if(count>bestCount){ best = variant; bestCount = count; } });
    canonicalOf.set(key, best);
  });
  // 2) دمج التكرار داخل قائمة الجنسيات نفسها (الإعدادات) حسب الصياغة المعتمدة لكل اسم
  const seenSettings = new Set();
  const dedupedNats = [];
  (settings.nationalities||[]).forEach(n=>{
    const key = String(n||'').trim().toLowerCase();
    if(!key) return;
    const canonicalName = canonicalOf.get(key) || String(n).trim();
    if(seenSettings.has(key)){
      changed = true;
    }else{
      if(canonicalName !== n) changed = true;
      seenSettings.add(key);
      dedupedNats.push(canonicalName);
    }
  });
  if(changed) settings.nationalities = dedupedNats;
  // 3) تصحيح الجنسية المسجّلة على كل عميل لتطابق الصياغة المعتمدة
  let clientsChanged = false;
  clients.forEach(c=>{
    if(!c.nationality) return;
    const key = String(c.nationality).trim().toLowerCase().replace(/\s+/g,' ');
    const fixed = canonicalOf.get(key) || normalizeNationalityValue(c.nationality);
    if(fixed !== c.nationality){ c.nationality = fixed; clientsChanged = true; }
  });
  if(changed || clientsChanged){
    if(changed) await saveSettings();
    if(clientsChanged) await saveClients();
    await logAudit('edit','الإعدادات', 'تصحيح تلقائي: توحيد أسماء الجنسيات المكررة (بسبب اختلاف حالة الأحرف أو مسافات زائدة) في شيت العملاء وقائمة الإعدادات');
  }
}

/* ---------------- توحيد أسماء طرق الدفع (منع تعدد المسميات لنفس الطريقة عبر كل الشيتات) ---------------- */
/* طرق الدفع المعتمدة الوحيدة في كامل البرنامج هي settings.channels (نفس القائمة الظاهرة في شيت "الحركات المالية" والإعدادات).
   هذه الدالة تحوّل أي اسم بديل/قديم لطريقة الدفع (مثل "تحويل" أو "بطاقة" أو "كاش مباشر" أو "إيداع كاش في الحساب البنكي"...)
   إلى الاسم المعتمد المطابق في settings.channels، بمطابقة حسب الوجهة الفعلية للحساب (خزنة كاش / بنك / شبكة). */
function canonicalizeChannelName(raw){
  const v = String(raw||'').trim().replace(/\s+/g,' ');
  if(!v) return '';
  const direct = (settings.channels||[]).find(c=> String(c.name||'').trim().toLowerCase()===v.toLowerCase());
  if(direct) return direct.name;
  const aliasToDest = {
    'تحويل':'bank', 'حوالة':'bank', 'حوالة بنكية':'bank', 'حواله بنكيه':'bank',
    'إيداع بنكي':'bank', 'ايداع بنكي':'bank', 'إيداع / تحويل بنكي':'bank', 'ايداع / تحويل بنكي':'bank',
    'إيداع كاش في الحساب البنكي':'bank', 'ايداع كاش في الحساب البنكي':'bank',
    'تحويل بنكي من صاحب المركز (دعم شركاء)':'bank', 'سحب من الحساب البنكي':'bank', 'سحب بنكي':'bank',
    'بطاقة':'network', 'شبكة':'network', 'مدى':'network', 'بطاقة مدى':'network', 'بطاقة/شبكة':'network', 'بطاقة/مدى':'network',
    'كاش':'vault', 'كاش مباشر':'vault', 'نقداً':'vault', 'نقدا':'vault', 'سحب نقدي':'vault', 'إيداع نقدي':'vault', 'ايداع نقدي':'vault'
  };
  const dest = aliasToDest[v.toLowerCase()];
  if(dest){ const ch = (settings.channels||[]).find(c=>c.dest===dest); if(ch) return ch.name; }
  return v; // اسم غير معروف: يُترك كما هو حتى لا تُفقد أي معلومة، ويمكن مراجعته يدوياً من الإعدادات
}
/* توحيد بأثر رجعي: يمر على شيت "الحركات المالية" وسجل تمويل الحقائب وبيانات العملاء (طريقة دفع الحقيبة/الحوالة)
   ويوحّد أي مسمى مكرر لنفس طريقة الدفع وفق القائمة المعتمدة أعلاه. كما يحاول استنتاج طريقة الدفع لأي حركة مالية
   غير محددة (بدون طريقة دفع) بالاعتماد على "الحساب/الوجهة" الفعلي المسجّل لها (خزنة كاش → نقدي، بنك → تحويل بنكي،
   شبكة → بطاقة/شبكة مدى) — أما حركات وجهتها "أخرى" (طبي/المركز) فتبقى دون تخمين لعدم وجود طريقة واحدة مؤكدة لها.
   تعمل تلقائياً وبأمان عند كل فتح للبرنامج (آمنة التكرار — لا تُعيد تغيير ما تم توحيده مسبقاً). */
async function cleanupDuplicatePaymentMethods(){
  let vaultChanged = false, bagStockChanged = false, clientsChanged = false;
  let fixedCount = 0, inferredCount = 0;
  vaultTx.forEach(t=>{
    if(t.method){
      const fixed = canonicalizeChannelName(t.method);
      if(fixed && fixed!==t.method){ t.method = fixed; vaultChanged = true; fixedCount++; }
    }else if(t.destination && t.destination!=='other'){
      const ch = (settings.channels||[]).find(c=>c.dest===t.destination);
      if(ch){ t.method = ch.name; vaultChanged = true; inferredCount++; }
    }
  });
  bagStock.forEach(b=>{
    if(!b.method) return;
    const fixed = canonicalizeChannelName(b.method);
    if(fixed && fixed!==b.method){ b.method = fixed; bagStockChanged = true; }
  });
  clients.forEach(c=>{
    if(c.channel){ const fixed = canonicalizeChannelName(c.channel); if(fixed && fixed!==c.channel){ c.channel = fixed; clientsChanged = true; } }
    if(c.channel2){ const fixed = canonicalizeChannelName(c.channel2); if(fixed && fixed!==c.channel2){ c.channel2 = fixed; clientsChanged = true; } }
    if(c.bagPaymentMethod){ const fixed = canonicalizeChannelName(c.bagPaymentMethod); if(fixed && fixed!==c.bagPaymentMethod){ c.bagPaymentMethod = fixed; clientsChanged = true; } }
  });
  if(vaultChanged || bagStockChanged || clientsChanged){
    if(vaultChanged) await saveVaultTx();
    if(bagStockChanged) await saveBagStock();
    if(clientsChanged) await saveClients();
    const parts = [];
    if(fixedCount) parts.push(`توحيد ${fixedCount} حركة كانت مسجّلة بمسمى بديل لطريقة الدفع (مثل "تحويل" أو "بطاقة") إلى الاسم المعتمد في الإعدادات`);
    if(inferredCount) parts.push(`استنتاج طريقة الدفع تلقائياً لـ ${inferredCount} حركة كانت "غير محددة"، بالاعتماد على الحساب/الوجهة الفعلي لكل حركة`);
    await logAudit('edit','الحركات المالية', `تصحيح تلقائي: ${parts.join(' — ') || 'توحيد مسميات طرق الدفع المكررة عبر شيت الحركات المالية ومخزون الحقائب وبيانات العملاء'}`);
  }
}

/* ---------------- تحديث كامل الشيت ---------------- */
/* يعيد رسم كل الشاشات (حتى غير الظاهرة حالياً) من البيانات الحالية في الذاكرة،
   لضمان أن أي معادلة أو قيمة محسوبة تغيّرت تنعكس فوراً على الشاشة دون الحاجة لإعادة تحميل الصفحة */
function refreshEverything(){
  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderOwnBagClients==='function') renderOwnBagClients();
  if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCourseInvoices==='function') renderCourseInvoices();
  if(typeof renderMissingCourse==='function') renderMissingCourse();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderCtGroups==='function') renderCtGroups();
  if(typeof renderCmCats==='function') renderCmCats();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  if(typeof renderSettings==='function') renderSettings();
  if(typeof renderUsersList==='function') renderUsersList();
  if(typeof updateUndoRedoButtons==='function') updateUndoRedoButtons();
  showToast('تم تحديث الشيت بالكامل');
}
$('#btn-refresh-all').addEventListener('click', refreshEverything);

/* ---------------- إلغاء كل الفلاتر وخانات البحث في كل الشيتات ---------------- */
function clearAllSheetFilters(){
  // ملاحظة: فلتر "السنة" العلوي (year-filter) مقصود إبقاؤه — هو إعداد عام للبرنامج
  // وليس فلتر بحث داخل شيت معيّن، فلا يُمس هنا.
  const textLikeIds = [
    'search','cl-date-from','cl-date-to','cl-paid-min','cl-paid-max',
    'ci-search','ci-date-from','ci-date-to',
    'v-search','v-from','v-to',
    'cbp-search','cbp-date-from','cbp-date-to',
    'ownbag-search',
    'pending-bags-search',
    'purchase-search','purchase-date-from','purchase-date-to',
    'supplier-search',
    'audit-search','audit-date-from','audit-date-to',
    'cs-filter-num','cs-filter-clientid','cs-filter-from','cs-filter-to',
    'cs-missing-from','cs-missing-to','cs-missing-exp-from','cs-missing-exp-to',
    'bst-date-from','bst-date-to',
    'ctf-date-from','ctf-date-to',
    'rp-from','rp-to',
  ];
  textLikeIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });

  const selectIds = [
    'filter-course','filter-nat','filter-status','filter-company','filter-invoice','filter-coursenum','filter-refnum',
    'ci-filter-diff','v-filter-dest','v-filter-type',
    'cbp-year-filter','ownbag-year-filter',
    'purchase-supplier-filter','purchase-status-filter',
    'audit-filter-action','audit-filter-section',
  ];
  selectIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.selectedIndex = 0; });

  ['v-filter-dup','v-filter-nomethod'].forEach(id=>{ const el=document.getElementById(id); if(el) el.checked=false; });

  showSuspendedOnly = false;
  $('#btn-filter-suspended')?.classList.remove('btn-gold');
  $('#btn-filter-suspended')?.classList.add('btn-ghost');
  showUnpurchasedBagsOnly = false;
  $('#btn-filter-unpurchased-bags')?.classList.remove('btn-gold');
  $('#btn-filter-unpurchased-bags')?.classList.add('btn-ghost');
  csUndefinedOnly = false;
  $('#btn-filter-undefined')?.classList.remove('btn-primary');
  $('#btn-filter-undefined')?.classList.add('btn-ghost');

  if(typeof refreshFilterOptions==='function') refreshFilterOptions();
  if(typeof renderDashboard==='function') renderDashboard();
  if(typeof renderTable==='function') renderTable();
  if(typeof renderVault==='function') renderVault();
  if(typeof renderBags==='function') renderBags();
  if(typeof renderOwnBagClients==='function') renderOwnBagClients();
  if(typeof renderClientBagPurchases==='function') renderClientBagPurchases();
  if(typeof renderCourses==='function') renderCourses();
  if(typeof renderCourseInvoices==='function') renderCourseInvoices();
  if(typeof renderMissingCourse==='function') renderMissingCourse();
  if(typeof renderCompanies==='function') renderCompanies();
  if(typeof renderCtGroups==='function') renderCtGroups();
  if(typeof renderCmCats==='function') renderCmCats();
  if(typeof renderReports==='function') renderReports();
  if(typeof renderBudget==='function') renderBudget();
  if(typeof renderAccounting==='function') renderAccounting();
  if(typeof renderAuditLog==='function') renderAuditLog();
  showToast('تم إلغاء كل الفلاتر وخانات البحث');
}
$('#btn-clear-all-filters').addEventListener('click', clearAllSheetFilters);

/* ---------------- Nav ---------------- */
const RESTRICTED_STAFF_VIEWS = ['settings','audit','accounting','zatca','budget'];
/* مصفوفة صلاحيات الأدوار: null = صلاحيات كاملة (admin) أو نفس سلوك staff القديم (استخدام RESTRICTED_STAFF_VIEWS كقائمة حظر).
   لأي دور له مصفوفة (array)، تُستخدم كـ "قائمة سماح" — فقط الأقسام المذكورة تظهر له، وما عداها مخفي تماماً. */
const ROLE_PERMISSIONS = {
  admin: null,
  staff: null, // نفس السلوك القديم: كل شيء ما عدا RESTRICTED_STAFF_VIEWS
  accountant: ['dashboard','clients','vault','accounting','budget','reports','purchases','companies'],
  reception: ['dashboard','clients','courses','courseinvoices','bags']
};
function canAccessView(view){
  if(currentUserRole==='admin') return true;
  const allow = ROLE_PERMISSIONS[currentUserRole];
  if(Array.isArray(allow)) return allow.includes(view);
  return !RESTRICTED_STAFF_VIEWS.includes(view); // staff أو دور غير معروف: القائمة السوداء القديمة كإجراء أمان احترازي
}
$all('nav.tabs button[data-view]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    if(!canAccessView(btn.dataset.view)){
      showToast('هذا القسم غير متاح لصلاحيتك الحالية');
      return;
    }
    SoundFX.nav();
    $all('nav.tabs button[data-view]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    $all('section.view').forEach(v=>v.classList.remove('active'));
    $('#view-'+btn.dataset.view).classList.add('active');
    if(btn.dataset.view==='clients') renderTable();
    if(btn.dataset.view==='dashboard') renderDashboard();
    if(btn.dataset.view==='settings') renderSettings();
    if(btn.dataset.view==='bags') renderBags();
    if(btn.dataset.view==='vault') renderVault();
    if(btn.dataset.view==='courses') renderCourses();
    if(btn.dataset.view==='courseinvoices') renderCourseInvoices();
    if(btn.dataset.view==='audit') renderAuditLog();
    if(btn.dataset.view==='reports') renderReports();
    if(btn.dataset.view==='companies') renderCompanies();
    if(btn.dataset.view==='accounting') renderAccounting();
    if(btn.dataset.view==='budget') renderEpmBudget();
    if(btn.dataset.view==='purchases') renderPurchases();
    if(btn.dataset.view==='zatca') renderZatca();
  });
});
/* إظهار/إخفاء التبويبات حسب صلاحية الدور الحالي (مصفوفة ROLE_PERMISSIONS) */
function applyRolePermissions(){
  $all('nav.tabs button[data-view]').forEach(btn=>{
    btn.style.display = canAccessView(btn.dataset.view) ? '' : 'none';
  });
  // إن كان المستخدم على قسم غير مسموح له به (مثلاً بعد تسجيل دخول مستخدم آخر بنفس الجلسة) نعيده للوحة التحكم
  const activeBtn = $('nav.tabs button.active');
  if(activeBtn && !canAccessView(activeBtn.dataset.view)){
    $('[data-view="dashboard"]').click();
  }
}

/* ---------------- Dashboard ---------------- */
function renderDashboard(){
  const c = clients.filter(x=>matchYear(x.date));
  const totalIncome = c.reduce((s,x)=>s+centerIncome(x),0);
  const totalBags = c.filter(x=>!x.suspended).reduce((s,x)=>s+bagAmount(x),0);
  const totalPaid = c.reduce((s,x)=>s+paidTotal(x),0);
  const totalRemaining = c.filter(x=>!x.suspended && !x.cancelled).reduce((s,x)=>s+remaining(x),0);
  $('#cards').innerHTML = `
    <div class="card"><div class="k">عدد العملاء</div><div class="v">${c.length}</div></div>
    <div class="card"><div class="k">دخل المركز الصافي (الدورات)</div><div class="v gold">${fmt(totalIncome)}</div></div>
    <div class="card"><div class="k">حصيلة الحقائب (تمريري)</div><div class="v">${fmt(totalBags)}</div></div>
    <div class="card"><div class="k">إجمالي المتبقي على العملاء</div><div class="v red">${fmt(totalRemaining)}</div></div>
  `;
  $('#quickstats').innerHTML = `
    <div><div class="n">${c.length}</div><div class="l">عميل</div></div>
    <div><div class="n">${fmt(totalPaid)}</div><div class="l">مستلم</div></div>
    <div><div class="n">${fmt(totalRemaining)}</div><div class="l">متبقي</div></div>
  `;
  drawDonut('#chart-course', groupCount(c,'courseType'));
  drawDonut('#chart-nat', groupCount(c,'nationality'), 8);
  drawDonut('#chart-channel', groupChannelAmounts(c), 20, v=>fmt(v)+' ﷼');
  renderCfoDashboard();
  renderSmartAlerts();
}

/* ============ التنبيهات الذكية (Smart Alerts) ============ */
function daysSinceDate(dateStr){
  if(!dateStr) return 0;
  const d = new Date(dateStr);
  if(isNaN(d.getTime())) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function renderSmartAlerts(){
  const el = $('#smart-alerts-panel');
  if(!el) return;
  const alerts = [];

  // ١) حقائب مطلوب شراؤها متأخرة عن الحد المسموح
  const overdueDays = settings.bagOverdueDays || 14;
  const overdueBags = clients.filter(c=> c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended && daysSinceDate(c.date) > overdueDays);
  if(overdueBags.length){
    alerts.push({level:'red', icon:'👜', text:`${overdueBags.length} حقيبة مطلوب شراؤها تجاوزت ${overdueDays} يوم بدون شراء`, view:'clients'});
  }

  // ٢) انخفاض رصيد الخزنة + البنك عن الحد الأدنى
  const today = todayISO();
  const liquid = balanceOfAsOf('vault', today) + balanceOfAsOf('bank', today);
  const threshold = settings.lowBalanceThreshold ?? 5000;
  if(liquid < threshold){
    alerts.push({level:'red', icon:'💰', text:`رصيد الخزنة والبنك (${fmt(liquid)}) أقل من الحد الأدنى المحدد (${fmt(threshold)})`, view:'vault'});
  }

  // ٣) اقتراب انتهاء الترخيص
  if(LICENSE_EXPIRY_DATE){
    const daysLeft = Math.ceil((new Date(LICENSE_EXPIRY_DATE).getTime() - Date.now()) / 86400000);
    if(daysLeft <= 14 && daysLeft >= 0){
      alerts.push({level:'gold', icon:'🔑', text:`ترخيص البرنامج سينتهي خلال ${daysLeft} يوم — يُرجى التجديد قريباً`});
    }
  }

  // ٤) دورات قريبة من اكتمال العدد (لم تكتمل بعد)
  if(typeof coursesFilteredSessions==='function' && typeof groupClientsByCourseNumber==='function'){
    const byCourseNumber = groupClientsByCourseNumber();
    const nearFull = courseSessions.filter(s=>{
      if(!s.capacity) return false;
      const enrolled = (byCourseNumber.get(s.courseNumber)||[]).filter(c=>!c.cancelled).length;
      const ratio = enrolled / s.capacity;
      return ratio >= 0.8 && enrolled < s.capacity;
    });
    if(nearFull.length){
      alerts.push({level:'gold', icon:'📚', text:`${nearFull.length} دورة اقتربت من اكتمال العدد (80% فأكثر)`, view:'courses'});
    }
  }

  // ٥) تذكير بالنسخ الاحتياطي التلقائي (لو معطّل أو متأخر بشكل غير متوقع)
  if(!settings.autoBackupEnabled){
    alerts.push({level:'gold', icon:'💾', text:'النسخ الاحتياطي التلقائي معطّل حالياً — يُفضّل تفعيله من الإعدادات', view:'settings'});
  }

  // ٦) ملخص الشهر الماضي جاهز للإرسال عبر واتساب (يظهر أول 7 أيام من الشهر الجديد فقط ولمرة واحدة لكل شهر)
  if(settings.monthlyReportWhatsapp && typeof lastCompleteMonthKey==='function'){
    const key = lastCompleteMonthKey();
    const dayOfMonth = new Date().getDate();
    if(dayOfMonth<=7 && settings.lastMonthlyReportPromptMonth!==key){
      alerts.push({level:'gold', icon:'📤', text:`ملخص ${monthLabelAr(key)} جاهز — اضغط لإرساله عبر واتساب`, action:'monthly-wa', actionKey:key});
    }
  }

  if(!alerts.length){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="panel" style="border-right:4px solid var(--red);">
    <h3 style="margin:0 0 8px;">🔔 تنبيهات تحتاج انتباهك</h3>
    ${alerts.map(a=> `<div style="display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--border);" ${a.view?`class="sa-alert-item" data-sa-view="${a.view}" style="cursor:pointer;"`:(a.action?`class="sa-alert-item" data-sa-action="${a.action}" data-sa-action-key="${a.actionKey||''}" style="cursor:pointer;"`:'')}>
      <span style="font-size:18px;">${a.icon}</span>
      <span style="font-size:13px; color:${a.level==='red'?'var(--red)':'var(--gold-dark)'};">${escapeHtml(a.text)}</span>
    </div>`).join('')}
  </div>`;
}
$('#smart-alerts-panel')?.addEventListener('click', async e=>{
  const actionItem = e.target.closest('[data-sa-action]');
  if(actionItem){
    if(actionItem.dataset.saAction==='monthly-wa'){
      const key = actionItem.dataset.saActionKey;
      sendMonthlyReportWhatsapp(key);
      settings.lastMonthlyReportPromptMonth = key;
      await saveSettings();
      renderSmartAlerts();
    }
    return;
  }
  const item = e.target.closest('[data-sa-view]');
  if(!item) return;
  document.querySelector(`nav.tabs button[data-view="${item.dataset.saView}"]`)?.click();
});


/* ================= لوحة تحكم CFO-Style: أيقونات + دوال مساعدة ================= */
const CFO_ICONS = {
  sales:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  profit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  wallet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M17 15h.01"/></svg>',
  alert:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  vault:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
  bank:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 9h20z"/><path d="M5 10v9M9 10v9M15 10v9M19 10v9"/><path d="M2 21h20"/></svg>',
  network:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16V6a1 1 0 0 1 1-1h9v11"/><path d="M13 9h4l3 3v4h-2"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/></svg>',
  invoice:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l3 3v17H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>'
};
/* نسبة التغيّر المئوية بين قيمتين، بحماية من القسمة على صفر */
function cfoPct(cur, prev){
  if(!prev) return cur>0 ? 100 : (cur<0 ? -100 : 0);
  return ((cur-prev)/Math.abs(prev))*100;
}
function cfoDeltaBadge(cur, prev){
  const p = cfoPct(cur, prev);
  const cls = p>=0 ? 'up' : 'down';
  const sign = p>=0 ? '+' : '';
  return `<b class="${cls}">${sign}${p.toFixed(1)}%</b>`;
}
function cfoKpi(icon, label, value){
  return `<div class="cfo-kpi">
    <div class="cfo-kpi-icon">${CFO_ICONS[icon]||''}</div>
    <div class="cfo-kpi-body">
      <div class="cfo-kpi-label">${escapeHtml(label)}</div>
      <div class="cfo-kpi-value">${value}</div>
    </div>
  </div>`;
}
function cfoDeltasRow(yearCur, yearPrev, monthCur, monthPrev){
  return `<div class="cfo-deltas">
    <span class="lbl">مقارنة بالسنة الماضية ${cfoDeltaBadge(yearCur, yearPrev)}</span>
    <span class="lbl">مقارنة بالشهر الماضي ${cfoDeltaBadge(monthCur, monthPrev)}</span>
  </div>`;
}
/* اتجاه شهري لصافي دخل المركز من الدورات (آخر n شهر، بمعزل عن فلتر السنة العام) */
function monthlyCourseIncomeTrend(n=12){
  const keys = lastNMonthKeys(n);
  const net = keys.map(k=> Math.round(clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===k).reduce((s,c)=>s+centerIncome(c),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'صافي دخل المركز', color:'var(--gold-dark)', values:net}] };
}
/* اتجاه شهري للمبالغ المحصّلة فعلياً (من الحركات المالية الداخلة) */
function monthlyCollectedTrend(n=12){
  const keys = lastNMonthKeys(n);
  const vals = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'المحصّل شهرياً', color:'var(--teal)', values:vals}] };
}
/* اتجاه شهري لإجمالي المشتريات */
function monthlyPurchasesTrend(n=12){
  const keys = lastNMonthKeys(n);
  const vals = keys.map(k=> Math.round(purchases.filter(p=>(p.date||'').slice(0,7)===k).reduce((s,p)=>s+num(p.total),0)*100)/100);
  return { labels: keys.map(monthLabelAr), series:[{name:'المشتريات شهرياً', color:'var(--red)', values:vals}] };
}
/* إجمالي المستحق (غير المدفوع) لكل مورد */
function supplierUnpaidTotals(){
  const map = {};
  purchases.filter(p=>p.status==='unpaid').forEach(p=>{ map[p.supplierId] = (map[p.supplierId]||0) + num(p.total); });
  const bySupplier = suppliers.map(s=> [s.name, map[s.id]||0]).filter(([,v])=>v>0);
  return bySupplier.sort((a,b)=>b[1]-a[1]);
}
/* إجمالي المتبقي على العملاء مجمّعاً حسب نوع الدورة (لأعلى فئات المتبقي) */
function remainingByCourseType(){
  const map = {};
  clients.filter(c=>!c.suspended && !c.cancelled).forEach(c=>{
    const r = remaining(c);
    if(r>0){ const k = c.courseType || 'غير محدد'; map[k]=(map[k]||0)+r; }
  });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
/* رسم لوحة CFO-Style الكاملة (6 لوحات: الدخل، التحصيل والمتبقي، الخزنة والبنك، المشتريات المستحقة، توزيع الدورات، طريقة الدفع) */
function renderCfoDashboard(){
  const el = $('#cfo-grid');
  if(!el) return;
  // القسم ده فيه أرصدة الخزنة/البنك واتجاهات التحصيل — بيانات مالية حساسة تخص
  // من له صلاحية "الخزنة" أو "المحاسبة" فقط، حتى لو "لوحة التحكم" نفسها متاحة
  // لأدوار أوسع (زي الاستقبال). كان بيُعرض للجميع بلا استثناء قبل هذا التعديل.
  if(!canAccessView('vault') && !canAccessView('accounting')){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = '';

  const now = new Date();
  const thisYear = now.getFullYear(), lastYear = thisYear-1;
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth()+1).padStart(2,'0')}`;

  const activeClients = clients.filter(c=>!c.cancelled);
  const sumWhere = (yearOrMonth, keyType) => activeClients
    .filter(c=> keyType==='year' ? String(c.date||'').slice(0,4)===String(yearOrMonth) : String(c.date||'').slice(0,7)===yearOrMonth)
    .reduce((s,c)=>s+centerIncome(c),0);

  // === لوحة 1: الدخل من الدورات ===
  const salesYear = clients.filter(c=>!c.cancelled && String(c.date||'').slice(0,4)===String(thisYear)).reduce((s,c)=>s+num(c.coursePrice),0);
  const netYear = sumWhere(thisYear,'year');
  const netLastYear = sumWhere(lastYear,'year');
  const netThisMonth = sumWhere(thisMonthKey,'month');
  const netLastMonth = sumWhere(lastMonthKey,'month');
  const incomeTrend = monthlyCourseIncomeTrend(12);

  // === لوحة 2: التحصيل والمتبقي ===
  const collectedYear = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,4)===String(thisYear)).reduce((s,t)=>s+num(t.amount),0);
  const collectedLastYear = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,4)===String(lastYear)).reduce((s,t)=>s+num(t.amount),0);
  const collectedThisMonth = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,7)===thisMonthKey).reduce((s,t)=>s+num(t.amount),0);
  const collectedLastMonth = vaultTx.filter(t=>t.type==='in' && String(t.date||'').slice(0,7)===lastMonthKey).reduce((s,t)=>s+num(t.amount),0);
  const totalRemainingNow = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  const collectTrend = monthlyCollectedTrend(12);
  const remainBars = remainingByCourseType();

  // === لوحة 3: الخزنة والبنك ===
  const vaultBal = balanceOf('vault'), bankBal = balanceOf('bank'), networkBal = balanceOf('network');
  const netFlowYear = vaultTx.filter(t=>String(t.date||'').slice(0,4)===String(thisYear)).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowLastYear = vaultTx.filter(t=>String(t.date||'').slice(0,4)===String(lastYear)).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowThisMonth = vaultTx.filter(t=>String(t.date||'').slice(0,7)===thisMonthKey).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const netFlowLastMonth = vaultTx.filter(t=>String(t.date||'').slice(0,7)===lastMonthKey).reduce((s,t)=> s + (t.type==='in'?num(t.amount):-num(t.amount)), 0);
  const cashFlowTrend = monthlyFinancialTrend(12);

  // === لوحة 4: المشتريات المستحقة (الموردون) ===
  const unpaidPurchases = purchases.filter(p=>p.status==='unpaid');
  const unpaidTotal = unpaidPurchases.reduce((s,p)=>s+num(p.total),0);
  const purchasesYear = purchases.filter(p=>String(p.date||'').slice(0,4)===String(thisYear)).reduce((s,p)=>s+num(p.total),0);
  const purchasesLastYear = purchases.filter(p=>String(p.date||'').slice(0,4)===String(lastYear)).reduce((s,p)=>s+num(p.total),0);
  const purchasesThisMonth = purchases.filter(p=>String(p.date||'').slice(0,7)===thisMonthKey).reduce((s,p)=>s+num(p.total),0);
  const purchasesLastMonth = purchases.filter(p=>String(p.date||'').slice(0,7)===lastMonthKey).reduce((s,p)=>s+num(p.total),0);
  const purchasesTrend = monthlyPurchasesTrend(12);
  const apBars = supplierUnpaidTotals();

  el.innerHTML = `
    <div class="cfo-panel">
      <h3 class="cfo-panel-title">تحليل الدخل من الدورات</h3>
      <div class="cfo-kpis">
        ${cfoKpi('sales','إجمالي المبيعات ' + thisYear, fmt(salesYear)+' ﷼')}
        ${cfoKpi('profit','صافي دخل المركز', fmt(netYear)+' ﷼')}
      </div>
      ${cfoDeltasRow(netYear, netLastYear, netThisMonth, netLastMonth)}
      <div class="cfo-visual" id="cfo-trend-income"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">تحصيل المدفوعات والمتبقي</h3>
      <div class="cfo-kpis">
        ${cfoKpi('wallet','المحصّل ' + thisYear, fmt(collectedYear)+' ﷼')}
        ${cfoKpi('alert','المتبقي على العملاء', fmt(totalRemainingNow)+' ﷼')}
      </div>
      ${cfoDeltasRow(collectedYear, collectedLastYear, collectedThisMonth, collectedLastMonth)}
      <div class="cfo-caption">المتبقي حسب نوع الدورة (الأعلى)</div>
      <div class="cfo-visual cfo-bars" id="cfo-bars-remaining"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">الخزنة والبنك</h3>
      <div class="cfo-kpis cfo-kpis-3">
        ${cfoKpi('vault','الخزنة (كاش)', fmt(vaultBal)+' ﷼')}
        ${cfoKpi('bank','البنك', fmt(bankBal)+' ﷼')}
        ${cfoKpi('network','الشبكة', fmt(networkBal)+' ﷼')}
      </div>
      ${cfoDeltasRow(netFlowYear, netFlowLastYear, netFlowThisMonth, netFlowLastMonth)}
      <div class="cfo-visual" id="cfo-trend-cash"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title">المشتريات والموردون (مستحقات)</h3>
      <div class="cfo-kpis">
        ${cfoKpi('invoice','مستحق للموردين', fmt(unpaidTotal)+' ﷼')}
        ${cfoKpi('truck','فواتير غير مدفوعة', String(unpaidPurchases.length))}
      </div>
      ${cfoDeltasRow(purchasesYear, purchasesLastYear, purchasesThisMonth, purchasesLastMonth)}
      ${apBars.length ? `<div class="cfo-caption">أعلى الموردين استحقاقاً</div><div class="cfo-visual cfo-bars" id="cfo-bars-ap"></div>` : `<div class="cfo-visual" id="cfo-trend-purchases"></div>`}
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title" data-i18n="chartByCourseCfo">التوزيع حسب نوع الدورة</h3>
      <div class="cfo-visual" id="cfo-donut-course"></div>
    </div>

    <div class="cfo-panel">
      <h3 class="cfo-panel-title" data-i18n="chartByChannelCfo">التوزيع حسب طريقة الدفع</h3>
      <div class="cfo-visual" id="cfo-donut-channel"></div>
    </div>
  `;

  drawLineChart('#cfo-trend-income', incomeTrend.labels, incomeTrend.series);
  drawLineChart('#cfo-trend-cash', cashFlowTrend.labels, cashFlowTrend.series);
  if(apBars.length){ drawBars('#cfo-bars-ap', apBars, 6, v=>fmt(v)+' ﷼'); }
  else { drawLineChart('#cfo-trend-purchases', purchasesTrend.labels, purchasesTrend.series); }
  drawBars('#cfo-bars-remaining', remainBars, 6, v=>fmt(v)+' ﷼');
  const cAll = clients.filter(x=>matchYear(x.date));
  drawDonut('#cfo-donut-course', groupCount(cAll,'courseType'));
  drawDonut('#cfo-donut-channel', groupChannelAmounts(cAll), 20, v=>fmt(v)+' ﷼');
}
function groupCount(list, field){
  const map = {};
  list.forEach(x=>{ const k = x[field] || 'غير محدد'; map[k]=(map[k]||0)+1; });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
/* توزيع "طريقة الدفع" الفعلي: يجمع المبالغ المستلمة فعلياً (paid + paid2) على كل طريقة دفع مسجّلة،
   بحيث يُحتسب كل جزء من الدفعة المقسّمة (channel/channel2) على حدة بمبلغه الحقيقي، وليس مجرد عدّ
   العملاء حسب أول طريقة دفع فقط — فتُطابق النتيجة ما هو موجود فعلياً في بيانات العملاء. */
function groupChannelAmounts(list){
  const map = {};
  list.forEach(x=>{
    const amt1 = num(x.paid);
    if(amt1>0){
      const k1 = canonicalizeChannelName(x.channel) || x.channel || 'غير محدد';
      map[k1] = (map[k1]||0) + amt1;
    }
    const amt2 = num(x.paid2);
    if(amt2>0){
      const k2 = canonicalizeChannelName(x.channel2) || x.channel2 || 'غير محدد';
      map[k2] = (map[k2]||0) + amt2;
    }
  });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]);
}
function drawBars(sel, entries, limit=20, formatter){
  const el = $(sel);
  entries = entries.slice(0, limit);
  if(entries.length===0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }
  const max = Math.max(...entries.map(e=>e[1]));
  el.innerHTML = entries.map(([k,v])=>`
    <div class="bar-row">
      <div class="label">${k}</div>
      <div class="track"><div class="fill" style="width:${(v/max*100).toFixed(1)}%"></div></div>
      <div class="val">${formatter ? formatter(v) : v}</div>
    </div>`).join('');
}

/* لوحة ألوان الشارت الدائري — امتداد من نفس هوية ألوان البرنامج (gold/navy/teal/red) لعدد فئات أكبر */
const DONUT_COLORS = ['#E8951F','#2F6C9E','#2B7568','#B03F31','#C97814','#5B8AA6','#4FA394','#D9A76A','#8C6E3E','#7C93A8','#E0B583','#3E5C76'];

/* رسم بياني دائري (Donut) بألوان هوية البرنامج — يجمع بين الأناقة (فراغ مركزي، نهايات مدورة، فواصل ناعمة)
   وحيوية بصرية أعصر (تدرّج لوني خفيف وظل رقيق لكل شريحة) دون كسر الطابع الهادئ للواجهة. */
function drawDonut(sel, entries, limit=20, formatter){
  const el = $(sel);
  entries = entries.slice(0, limit);
  if(entries.length===0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }
  const total = entries.reduce((s,e)=>s+num(e[1]),0);
  if(total<=0){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات بعد</div>'; return; }

  const cx=100, cy=100, r=72, strokeW=28;
  const circumference = 2*Math.PI*r;
  const gap = entries.length>1 ? 3 : 0;
  let angleStart = -90;
  let defsHtml = '<defs>';
  let segsHtml = '';
  entries.forEach(([k,v],i)=>{
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const gid = `${sel.replace(/[^a-zA-Z0-9]/g,'')}-g${i}`;
    defsHtml += `<linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${color}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${color}" stop-opacity=".8"/>
    </linearGradient>`;
    const frac = num(v)/total;
    const angle = frac*360 - gap;
    const dash = Math.max(angle,0)/360*circumference;
    const rest = circumference - dash;
    segsHtml += `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${r}" fill="none"
      stroke="url(#${gid})" stroke-width="${strokeW}" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${rest.toFixed(1)}"
      transform="rotate(${angleStart} ${cx} ${cy})"
      style="filter:drop-shadow(0 2px 4px rgba(20,30,40,.14)); transition:opacity .15s ease, filter .15s ease;">
      <title>${escapeHtml(String(k))}: ${formatter ? formatter(v) : v}</title>
    </circle>`;
    angleStart += frac*360;
  });
  defsHtml += '</defs>';

  const legendHtml = entries.map(([k,v],i)=>{
    const color = DONUT_COLORS[i % DONUT_COLORS.length];
    const pct = (num(v)/total*100).toFixed(1);
    return `<div class="donut-legend-item" style="display:flex; align-items:center; gap:8px; font-size:12.5px; padding:3px 0;">
      <span style="width:10px; height:10px; border-radius:3px; background:${color}; flex:none;"></span>
      <span style="flex:1; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(k))}</span>
      <span style="font-family:'IBM Plex Mono',monospace; font-weight:600; color:var(--text-muted); font-size:11.5px;">${formatter ? formatter(v) : v}</span>
      <span style="font-family:'IBM Plex Mono',monospace; color:var(--text-muted); font-size:11px; min-width:38px; text-align:left;">${pct}%</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="display:flex; align-items:center; gap:22px; flex-wrap:wrap; justify-content:center;">
      <svg width="200" height="200" viewBox="0 0 200 200" style="flex:none;">
        ${defsHtml}${segsHtml}
        <g text-anchor="middle" style="font-family:'IBM Plex Mono',monospace;">
          <text x="${cx}" y="${cy-3}" font-size="19" font-weight="700" fill="var(--navy-dark)">${fmt(total)}</text>
          <text x="${cx}" y="${cy+15}" font-size="10" fill="var(--text-muted)">الإجمالي</text>
        </g>
      </svg>
      <div style="flex:1; min-width:160px; max-width:260px;">${legendHtml}</div>
    </div>`;
}

/* رسم بياني خطي بسيط (SVG) لعرض اتجاهات متعددة عبر الزمن دون الحاجة لمكتبة خارجية */
function drawLineChart(sel, labels, series){
  const el = $(sel);
  if(!el) return;
  const hasData = labels.length && series.some(s=>s.values.some(v=>v));
  if(!hasData){ el.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">لا توجد بيانات كافية بعد</div>'; return; }
  const W = 900, H = 280, padL = 60, padR = 20, padT = 16, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const allVals = series.flatMap(s=>s.values);
  let max = Math.max(...allVals, 0), min = Math.min(...allVals, 0);
  if(max===min) max = min + 1;
  const xStep = labels.length>1 ? innerW/(labels.length-1) : 0;
  const yScale = v => padT + innerH - ((v-min)/(max-min))*innerH;
  const xScale = i => padL + i*xStep;
  const gridLines = 4;
  let gridsHtml = '';
  for(let g=0; g<=gridLines; g++){
    const v = min + (max-min)*g/gridLines;
    const y = yScale(v);
    gridsHtml += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    gridsHtml += `<text x="${padL-8}" y="${(y+4).toFixed(1)}" font-size="10" fill="var(--text-muted)" text-anchor="end">${fmt(Math.round(v))}</text>`;
  }
  const showEvery = labels.length>8 ? Math.ceil(labels.length/8) : 1;
  const labelsHtml = labels.map((l,i)=> i%showEvery===0 ? `<text x="${xScale(i).toFixed(1)}" y="${H-8}" font-size="10" fill="var(--text-muted)" text-anchor="middle">${escapeHtml(l)}</text>` : '').join('');
  const seriesHtml = series.map(s=>{
    const pts = s.values.map((v,i)=>`${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
    const dots = s.values.map((v,i)=>`<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(v).toFixed(1)}" r="3.2" fill="${s.color}"><title>${escapeHtml(labels[i])}: ${fmt(v)}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');
  const legendHtml = series.map(s=>`<span style="display:inline-flex; align-items:center; gap:5px; margin-left:16px; font-size:12px; color:var(--text-muted);"><span style="width:10px; height:10px; border-radius:50%; background:${s.color}; display:inline-block;"></span>${escapeHtml(s.name)}</span>`).join('');
  el.innerHTML = `
    <div style="margin-bottom:10px;">${legendHtml}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; max-height:280px; display:block;">
      ${gridsHtml}
      ${seriesHtml}
      ${labelsHtml}
    </svg>`;
}
/* آخر n شهر كمفاتيح YYYY-MM */
function lastNMonthKeys(n){
  const arr = [];
  const now = new Date();
  for(let i=n-1;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    arr.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }
  return arr;
}
const MONTH_NAMES_AR_SHORT = ['ينا','فبر','مار','أبر','ماي','يون','يول','أغس','سبت','أكت','نوف','ديس'];
const MONTH_NAMES_AR_FULL = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const WEEKDAY_NAMES_AR = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
function monthLabelAr(key){
  const [y,m] = key.split('-');
  return `${MONTH_NAMES_AR_SHORT[Number(m)-1]} ${y.slice(2)}`;
}
/* تقرير شهري يومي: لكل يوم من أيام الشهر المختار (من 1 إلى آخر يوم فيه)، عدد العملاء الذين سُجّلوا في ذلك اليوم
   (تاريخ التسجيل c.date)، وتفصيل المبالغ المحصّلة فعلياً في ذلك اليوم من "الحركات المالية" (نقدي/شبكة/بنك)
   حسب الوجهة الفعلية للحركة (نفس منطق الجدول الشهري في شاشة التقارير). يشمل كل أيام الشهر حتى لو لم
   يُسجَّل فيها أي عميل أو تُحصَّل أي مبالغ (تظهر بصفر). */
function monthlyClientsDailyReport(yearMonth){
  const [yStr, mStr] = yearMonth.split('-');
  const year = Number(yStr), month = Number(mStr); // month: 1-12
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = [];
  let totalReg = 0, totalCash = 0, totalNetwork = 0, totalBank = 0, totalAmount = 0;
  for(let day=1; day<=daysInMonth; day++){
    const dateStr = `${yStr}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const regCount = clients.filter(c=>c.date===dateStr).length;
    const dayIn = vaultTx.filter(t=>t.type==='in' && t.date===dateStr);
    const cash = dayIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
    const network = dayIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
    const bank = dayIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    const amount = cash + network + bank;
    const weekday = WEEKDAY_NAMES_AR[new Date(year, month-1, day).getDay()];
    totalReg += regCount; totalCash += cash; totalNetwork += network; totalBank += bank; totalAmount += amount;
    rows.push({ day, dateStr, weekday, regCount, cash, network, bank, amount });
  }
  return { year, month, monthLabel: `${MONTH_NAMES_AR_FULL[month-1]} ${year}`, rows, totalReg, totalCash, totalNetwork, totalBank, totalAmount };
}
function monthlyClientsReportBodyHtml(yearMonth){
  const rep = monthlyClientsDailyReport(yearMonth);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const rowsHtml = rep.rows.map(r=>`
    <tr>
      <td class="mono">${r.day}</td>
      <td class="mono">${escapeHtml(r.dateStr)}</td>
      <td>${escapeHtml(r.weekday)}</td>
      <td class="mono">${r.regCount}</td>
      <td class="mono">${fmt(r.cash)}</td>
      <td class="mono">${fmt(r.network)}</td>
      <td class="mono">${fmt(r.bank)}</td>
      <td class="mono" style="font-weight:bold;">${fmt(r.amount)}</td>
    </tr>`).join('');
  return `
    <div class="head">
      <div><h2>تقرير شهري — تسجيلات ومبالغ العملاء</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(rep.monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">تاريخ الطباعة: ${escapeHtml(today)}</div>
    <table>
      <thead><tr><th>اليوم</th><th>التاريخ</th><th>اسم اليوم</th><th>عدد العملاء المسجّلين</th><th>نقدي (كاش)</th><th>شبكة</th><th>بنك</th><th>الإجمالي</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;">
          <td colspan="3">الإجمالي</td>
          <td class="mono">${rep.totalReg}</td>
          <td class="mono">${fmt(rep.totalCash)}</td>
          <td class="mono">${fmt(rep.totalNetwork)}</td>
          <td class="mono">${fmt(rep.totalBank)}</td>
          <td class="mono">${fmt(rep.totalAmount)}</td>
        </tr>
      </tbody>
    </table>`;
}
function printMonthlyClientsReport(yearMonth){
  const rep = monthlyClientsDailyReport(yearMonth);
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('تقرير شهري — ' + rep.monthLabel, {variant: 'table'})}
  <body>
    ${monthlyClientsReportBodyHtml(yearMonth)}
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}
$('#btn-monthly-report')?.addEventListener('click', ()=>{
  const now = new Date();
  $('#mr-month').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  $('#monthly-report-overlay').classList.add('show');
});
$('#mr-cancel')?.addEventListener('click', ()=> $('#monthly-report-overlay').classList.remove('show'));
$('#mr-generate')?.addEventListener('click', ()=>{
  const val = $('#mr-month').value;
  if(!val){ showToast('اختر الشهر أولاً'); return; }
  printMonthlyClientsReport(val);
  $('#monthly-report-overlay').classList.remove('show');
});
/* اتجاه الإيرادات/المصروفات/الصافي الشهري لآخر n شهر (مستقل عن فلتر الفترة، يعرض كامل السجل) */
function monthlyFinancialTrend(n=12){
  const keys = lastNMonthKeys(n);
  const income = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  const expense = keys.map(k=> Math.round(vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0)*100)/100);
  const net = keys.map((k,i)=> Math.round((income[i]-expense[i])*100)/100);
  return { labels: keys.map(monthLabelAr), series:[
    {name:'الإيرادات', color:'var(--teal)', values:income},
    {name:'المصروفات', color:'var(--red)', values:expense},
    {name:'الصافي', color:'var(--gold-dark)', values:net},
  ]};
}
/* اتجاه عدد العملاء المسجّلين شهرياً لآخر n شهر */
function monthlyRegistrationsTrend(n=12){
  const keys = lastNMonthKeys(n);
  const counts = keys.map(k=> clients.filter(c=>(c.date||'').slice(0,7)===k).length);
  return { labels: keys.map(monthLabelAr), series:[{name:'عدد التسجيلات', color:'var(--navy)', values:counts}] };
}
/* جدول شهري: عدد المسجّلين والمبالغ المدفوعة (كاش/شبكة/بنك) لآخر n شهر */
function monthlyRegistrationsPaymentsTable(n=12){
  const keys = lastNMonthKeys(n);
  return keys.map(k=>{
    const regCount = clients.filter(c=>!c.suspended && (c.date||'').slice(0,7)===k).length;
    const monthIn = vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===k);
    const cash = monthIn.filter(t=>(t.destination||'vault')==='vault').reduce((s,t)=>s+num(t.amount),0);
    const network = monthIn.filter(t=>(t.destination||'vault')==='network').reduce((s,t)=>s+num(t.amount),0);
    const bank = monthIn.filter(t=>(t.destination||'vault')==='bank').reduce((s,t)=>s+num(t.amount),0);
    return { key:k, label: monthLabelAr(k), regCount, cash, network, bank, total: cash+network+bank };
  });
}
/* دخل المركز حسب نوع الدورة، مقيّداً بفلتر الفترة الحالي في شاشة التقارير */
function revenueByCourseType(){
  const rows = clientsInPeriod().filter(c=>!c.cancelled);
  const totals = {};
  rows.forEach(c=>{ const k = c.courseType||'غير محدد'; totals[k]=(totals[k]||0)+centerIncome(c); });
  return Object.entries(totals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]);
}
/* حساب إحصائيات الفترة السابقة مباشرة (بنفس عدد أيام الفترة الحالية) للمقارنة */
function periodComparison(){
  const fromStr = $('#rp-from').value;
  const toStr = $('#rp-to').value;
  const toDate = toStr ? new Date(toStr) : new Date();
  let fromDate;
  if(fromStr){ fromDate = new Date(fromStr); }
  else{
    const allDates = [...clients.map(c=>c.date), ...vaultTx.map(t=>t.date)].filter(Boolean).sort();
    fromDate = allDates.length ? new Date(allDates[0]) : new Date(toDate.getTime() - 30*86400000);
  }
  const spanMs = Math.max(toDate - fromDate, 86400000);
  const prevTo = new Date(fromDate.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  const prevFromISO = prevFrom.toISOString().slice(0,10);
  const prevToISO = prevTo.toISOString().slice(0,10);
  const prevRows = vaultTx.filter(t=> (t.date||'') >= prevFromISO && (t.date||'') <= prevToISO);
  const prevIncome = prevRows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const prevExpense = prevRows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const prevClients = clients.filter(c=>{ const d=c.date||''; return d>=prevFromISO && d<=prevToISO; }).length;
  return { prevIncome, prevExpense, prevClients, prevFromISO, prevToISO };
}
function pctChange(curr, prev){
  if(!prev) return curr>0 ? 100 : 0;
  return Math.round(((curr-prev)/Math.abs(prev))*1000)/10;
}
/* شارة تغيّر: الأخضر يعني تحسّن (للإيرادات/العملاء/الصافي)، والأحمر يعني تراجع */
function changeBadgePositive(pct){
  if(pct>0) return `<span style="color:var(--teal); font-size:11.5px;">▲ ${pct}%</span>`;
  if(pct<0) return `<span style="color:var(--red); font-size:11.5px;">▼ ${Math.abs(pct)}%</span>`;
  return `<span style="color:var(--text-muted); font-size:11.5px;">— 0%</span>`;
}
/* شارة تغيّر معكوسة: الأحمر يعني زيادة (مناسبة للمصروفات، حيث الزيادة سلبية)*/
function changeBadgeNegative(pct){
  if(pct>0) return `<span style="color:var(--red); font-size:11.5px;">▲ ${pct}%</span>`;
  if(pct<0) return `<span style="color:var(--teal); font-size:11.5px;">▼ ${Math.abs(pct)}%</span>`;
  return `<span style="color:var(--text-muted); font-size:11.5px;">— 0%</span>`;
}

/* ---------------- Clients table ---------------- */
function populateSelect(sel, values, withEmpty){
  sel.innerHTML = (withEmpty?'<option value="">—</option>':'') + values.map(v=>`<option value="${v}">${v}</option>`).join('');
}
function refreshFilterOptions(){
  if(typeof populateYearFilterSelect==='function') populateYearFilterSelect();
  const courseFilterVal = $('#filter-course').value;
  populateSelect($('#filter-course'), settings.courses.map(c=>c.name), false);
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="__unknown__">⚠ الدورات غير المعلومة (بدون نوع دورة)</option>');
  $('#filter-course').insertAdjacentHTML('afterbegin','<option value="">كل الدورات</option>');
  $('#filter-course').value = courseFilterVal || '';

  const natFilterVal = $('#filter-nat').value;
  populateSelect($('#filter-nat'), settings.nationalities, false);
  $('#filter-nat').insertAdjacentHTML('afterbegin','<option value="">كل الجنسيات</option>');
  $('#filter-nat').value = natFilterVal || '';

  const companyFilterVal = $('#filter-company').value;
  // نجمع أسماء الشركات من القائمة الرئيسية (تبويب تحويلات الشركات) ومن العملاء المسجَّلين فعلياً، حتى تظهر أي شركة أُضيفت هناك فوراً هنا وتبقى الفلترة مرتبطة بين التبويبين
  const companyNamesForFilter = [...new Set([...companies.map(c=>c.name), ...clients.map(c=>c.companyName)].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  populateSelect($('#filter-company'), companyNamesForFilter, false);
  $('#filter-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
  $('#filter-company').value = companyNamesForFilter.includes(companyFilterVal) ? companyFilterVal : '';
}
function filteredClients(){
  const q = $('#search').value.trim().toLowerCase();
  const fc = $('#filter-course').value;
  const fn = $('#filter-nat').value;
  const fs = $('#filter-status').value;
  const fcomp = $('#filter-company').value;
  const finv = $('#filter-invoice') ? $('#filter-invoice').value : '';
  const fcn = $('#filter-coursenum') ? $('#filter-coursenum').value : '';
  const frn = $('#filter-refnum') ? $('#filter-refnum').value : '';
  const dfrom = $('#cl-date-from').value;
  const dto = $('#cl-date-to').value;
  const paidMinRaw = $('#cl-paid-min').value;
  const paidMaxRaw = $('#cl-paid-max').value;
  const paidMin = paidMinRaw!=='' ? num(paidMinRaw) : null;
  const paidMax = paidMaxRaw!=='' ? num(paidMaxRaw) : null;
  return clients.filter(c=>{
    if(showSuspendedOnly && !c.suspended) return false;
    if(showUnpurchasedBagsOnly && !(c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended)) return false;
    if(fc==='__unknown__'){ if(c.courseType && c.courseType.trim()) return false; }
    else if(fc && c.courseType!==fc) return false;
    if(fn && c.nationality!==fn) return false;
    if(fs==='paid' && remaining(c)>0) return false;
    if(fs==='owe' && remaining(c)<=0) return false;
    if(fcomp && c.companyName!==fcomp) return false;
    if(finv==='no' && c.invoice && String(c.invoice).trim()) return false;
    if(finv==='yes' && !(c.invoice && String(c.invoice).trim())) return false;
    if(fcn==='no' && c.courseNumber && String(c.courseNumber).trim()) return false;
    if(fcn==='yes' && !(c.courseNumber && String(c.courseNumber).trim())) return false;
    if(frn==='no' && c.referNum && String(c.referNum).trim()) return false;
    if(frn==='yes' && !(c.referNum && String(c.referNum).trim())) return false;
    if(dfrom && (!c.date || c.date<dfrom)) return false;
    if(dto && (!c.date || c.date>dto)) return false;
    if(paidMin!==null && paidTotal(c)<paidMin) return false;
    if(paidMax!==null && paidTotal(c)>paidMax) return false;
    if(q){
      const hay = [c.name,c.phone,c.clientId,c.invoice,c.referNum,c.courseNumber].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
}
let tableCurrentPage = 1;
let tableLastFilterSig = '';
let showSuspendedOnly = false;
let showUnpurchasedBagsOnly = false;
/* ============ نظام ترقيم صفحات عام (يُستخدم في كل الشيتات الطويلة) ============
   لكل جدول: state = {page:1, sig:''} خاص به، وبادئة (prefix) فريدة لعناصر الـ HTML:
   #{prefix}-pagination, #{prefix}-page-size, #{prefix}-page-info, #{prefix}-page-current,
   #{prefix}-page-first/prev/next/last */
function genericPageSize(prefix){
  const v = $(`#${prefix}-page-size`)?.value || '50';
  return v==='all' ? Infinity : Number(v);
}
function applyGenericPagination(prefix, rows, state, filterSigParts){
  const sig = JSON.stringify(filterSigParts);
  if(sig !== state.sig){ state.page = 1; state.sig = sig; }
  const pageSize = genericPageSize(prefix);
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(state.page > totalPages) state.page = totalPages;
  if(state.page < 1) state.page = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((state.page-1)*pageSize, state.page*pageSize) : rows;
  const pag = $(`#${prefix}-pagination`);
  if(pag){
    pag.style.display = rows.length ? '' : 'none';
    const startN = rows.length ? (state.page-1)*(Number.isFinite(pageSize)?pageSize:rows.length)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(rows.length, state.page*pageSize) : rows.length;
    const infoEl = $(`#${prefix}-page-info`); if(infoEl) infoEl.textContent = rows.length ? `عرض ${startN} - ${endN} من ${rows.length}` : '';
    const curEl = $(`#${prefix}-page-current`); if(curEl) curEl.textContent = `صفحة ${state.page} / ${totalPages}`;
    const fb = $(`#${prefix}-page-first`); if(fb) fb.disabled = state.page<=1;
    const pb = $(`#${prefix}-page-prev`); if(pb) pb.disabled = state.page<=1;
    const nb = $(`#${prefix}-page-next`); if(nb) nb.disabled = state.page>=totalPages;
    const lb = $(`#${prefix}-page-last`); if(lb) lb.disabled = state.page>=totalPages;
  }
  return pageRows;
}
function bindGenericPagination(prefix, state, renderFn){
  $(`#${prefix}-page-size`)?.addEventListener('change', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-first`)?.addEventListener('click', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-prev`)?.addEventListener('click', ()=>{ state.page=Math.max(1,state.page-1); renderFn(); });
  $(`#${prefix}-page-next`)?.addEventListener('click', ()=>{ state.page=state.page+1; renderFn(); });
  $(`#${prefix}-page-last`)?.addEventListener('click', ()=>{ state.page=Infinity; renderFn(); });
}
function genericPaginationToolbarHtml(prefix){
  return `<div class="toolbar" id="${prefix}-pagination" style="padding:12px 16px; display:none;">
    <span class="mono" id="${prefix}-page-info" style="font-size:12.5px; color:var(--text-muted);"></span>
    <span class="spacer"></span>
    <select id="${prefix}-page-size" style="max-width:110px;">
      <option value="20">20 / صفحة</option>
      <option value="50" selected>50 / صفحة</option>
      <option value="100">100 / صفحة</option>
      <option value="200">200 / صفحة</option>
      <option value="all">عرض الكل</option>
    </select>
    <button class="btn btn-ghost btn-sm" id="${prefix}-page-first">« الأولى</button>
    <button class="btn btn-ghost btn-sm" id="${prefix}-page-prev">‹ السابقة</button>
    <span class="mono" id="${prefix}-page-current" style="font-size:12.5px; padding:0 6px;"></span>
    <button class="btn btn-ghost btn-sm" id="${prefix}-page-next">التالية ›</button>
    <button class="btn btn-ghost btn-sm" id="${prefix}-page-last">الأخيرة »</button>
  </div>`;
}

function currentTablePageSize(){
  const v = $('#table-page-size')?.value || '100';
  return v==='all' ? Infinity : Number(v);
}
function renderTable(){
  let rows = filteredClients();
  const cfc = $('#clients-filtered-count'); if(cfc) cfc.textContent = rows.length;
  const ctc = $('#clients-total-count'); if(ctc) ctc.textContent = clients.length;

  $('#empty-state').style.display = rows.length ? 'none' : 'block';

  // إعادة الصفحة إلى الأولى تلقائياً كلما تغيّر البحث أو أي فلتر (وليس عند التنقّل بين الصفحات فقط)
  const filterSig = JSON.stringify([
    $('#search')?.value, $('#filter-course')?.value, $('#filter-nat')?.value, $('#filter-status')?.value,
    $('#filter-company')?.value, $('#filter-invoice')?.value, $('#filter-coursenum')?.value, $('#filter-refnum')?.value, $('#cl-date-from')?.value, $('#cl-date-to')?.value,
    $('#cl-paid-min')?.value, $('#cl-paid-max')?.value, showSuspendedOnly, showUnpurchasedBagsOnly
  ]);
  if(filterSig !== tableLastFilterSig){ tableCurrentPage = 1; tableLastFilterSig = filterSig; }

  const pageSize = currentTablePageSize();
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(tableCurrentPage > totalPages) tableCurrentPage = totalPages;
  if(tableCurrentPage < 1) tableCurrentPage = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((tableCurrentPage-1)*pageSize, tableCurrentPage*pageSize) : rows;

  const pag = $('#table-pagination');
  if(pag){
    pag.style.display = rows.length ? '' : 'none';
    const startN = rows.length ? (tableCurrentPage-1)*(Number.isFinite(pageSize)?pageSize:rows.length)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(rows.length, tableCurrentPage*pageSize) : rows.length;
    $('#table-page-info').textContent = rows.length ? `عرض ${startN} - ${endN} من ${rows.length}` : '';
    $('#table-page-current').textContent = `صفحة ${tableCurrentPage} / ${totalPages}`;
    $('#table-page-first').disabled = tableCurrentPage<=1;
    $('#table-page-prev').disabled = tableCurrentPage<=1;
    $('#table-page-next').disabled = tableCurrentPage>=totalPages;
    $('#table-page-last').disabled = tableCurrentPage>=totalPages;
  }

  currentPageClientIds = pageRows.map(c=>c.id);
  $('#table-body').innerHTML = pageRows.map(c=>{
    const rem = remaining(c);
    const nameBadges = `${escapeHtml(c.name)}${phoneWithWhatsapp(c.phone)}${c.cancelled ? ' <span class="stamp owe">ملغى</span>' : ''}${c.absent ? ' <span class="stamp owe">غياب</span>' : ''}${c.suspended ? ' <span class="stamp owe">موقوف</span>' : ''}`;
    return `<tr${(c.cancelled || c.suspended) ? ' style="opacity:.55;"' : ''}>
      <td><input type="checkbox" class="row-select-client" data-id="${c.id}" ${selectedClientIds.has(c.id)?'checked':''}></td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${nameBadges}</td>
      <td class="mono">${escapeHtml(c.referNum||'—')}</td>
      <td>${escapeHtml(c.nationality||'')}</td>
      <td>${escapeHtml(c.courseType||'')}</td>
      <td class="mono">${escapeHtml(c.courseNumber||'—')}</td>
      <td class="mono">${escapeHtml(c.invoice||'—')}</td>
      <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
      <td class="mono">${fmt(total(c))}</td>
      <td class="mono">${fmt(paidTotal(c))}</td>
      <td class="mono">${fmt(rem)}</td>
      <td><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}${bagCancelBtnHtml(c)}</td>
      <td><span class="stamp ${rem>0?'owe':'paid'}">${escapeHtml(paymentChannelsLabel(c))}</span></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-gold btn-sm" data-invoice="${c.id}">${tr('invoiceBtn')}</button>
        ${c.taxInvoiceNo ? `<button class="btn btn-danger btn-sm" data-delinvoice="${c.id}" title="حذف الفاتورة الضريبية الصادرة لهذا العميل (حذف منطقي مع الاحتفاظ بالرقم التسلسلي)">حذف الفاتورة</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-edit="${c.id}">${tr('edit')}</button>
        ${c.suspended
          ? `<button class="btn btn-ghost btn-sm" data-unsuspend="${c.id}" title="إعادة العميل ليظهر في شيت الدورات ومخزون الحقائب">إلغاء الإيقاف</button>`
          : `<button class="btn btn-ghost btn-sm" data-suspend="${c.id}" title="إيقاف العميل مؤقتاً — يبقى في شيت العملاء لكن يختفي من شيت الدورات ومخزون الحقائب">موقوف</button>`}
        <button class="btn btn-danger btn-sm" data-del="${c.id}">${tr('delete')}</button>
      </td>
    </tr>`;
  }).join('');
  // نحذف من التحديد أي عميل لم يعد موجوداً أصلاً (حُذف من مكان آخر)، حتى لا يبقى تحديد "شبح"
  const allIds = new Set(clients.map(c=>c.id));
  [...selectedClientIds].forEach(id=>{ if(!allIds.has(id)) selectedClientIds.delete(id); });
  renderBulkSelectionBar(rows);
}

let selectedClientIds = new Set();
let currentPageClientIds = [];
function renderBulkSelectionBar(filteredRows){
  const bar = $('#bulk-actions-bar');
  if(!bar) return;
  const count = selectedClientIds.size;
  bar.style.display = count>0 ? '' : 'none';
  $('#bulk-selected-count').textContent = count;
  $('#bulk-filtered-total').textContent = filteredRows.length;
  const selectAllBox = $('#select-all-clients');
  if(selectAllBox){
    const pageIds = currentPageClientIds;
    const selectedOnPage = pageIds.filter(id=>selectedClientIds.has(id)).length;
    selectAllBox.checked = pageIds.length>0 && selectedOnPage===pageIds.length;
    selectAllBox.indeterminate = selectedOnPage>0 && selectedOnPage<pageIds.length;
  }
}
$('#table-body').addEventListener('change', e=>{
  if(e.target.classList.contains('row-select-client')){
    const id = e.target.dataset.id;
    if(e.target.checked) selectedClientIds.add(id); else selectedClientIds.delete(id);
    renderBulkSelectionBar(filteredClients());
  }
});
$('#select-all-clients').addEventListener('change', e=>{
  if(e.target.checked) currentPageClientIds.forEach(id=>selectedClientIds.add(id));
  else currentPageClientIds.forEach(id=>selectedClientIds.delete(id));
  renderTable();
});
$('#btn-select-all-filtered').addEventListener('click', ()=>{
  filteredClients().forEach(c=>selectedClientIds.add(c.id));
  renderTable();
});
$('#btn-clear-selection').addEventListener('click', ()=>{
  selectedClientIds.clear();
  renderTable();
});
$('#btn-bulk-delete-selected').addEventListener('click', async ()=>{
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(!ids.length){ showToast('لا يوجد عملاء محددين'); return; }
  const namesPreview = clients.filter(c=>ids.includes(c.id)).slice(0,5).map(c=>c.name).join('، ');
  const extra = ids.length>5 ? ` وآخرين (${ids.length-5})` : '';
  if(!await customConfirm(`تأكيد حذف ${ids.length} عميل دفعة واحدة؟ (${namesPreview}${extra})\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف مجموعة عملاء دفعة واحدة (${ids.length} عميل)`);
  const removedNames = clients.filter(c=>ids.includes(c.id)).map(c=>c.name);
  clients = clients.filter(c=>!ids.includes(c.id));
  ids.forEach(id=>removeClientLedgerEntries(id));
  await saveClients(); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${ids.length} عميل دفعة واحدة: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}`);
  selectedClientIds.clear();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${ids.length} عميل بنجاح`);
});
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* تطبيع رقم جوال العميل ليتوافق مع صيغة واتساب الدولية (يفترض أرقام السعودية عند غياب رمز الدولة) */
function normalizePhoneForWhatsapp(phone){
  let p = String(phone||'').trim().replace(/[^\d+]/g,'');
  if(!p) return '';
  p = p.replace(/^\+/, '');
  if(p.startsWith('00')) p = p.slice(2);
  if(p.startsWith('0')) p = '966' + p.slice(1);          // 05XXXXXXXX -> 9665XXXXXXXX
  else if(/^5\d{8}$/.test(p)) p = '966' + p;              // 5XXXXXXXX (بدون صفر) -> 9665XXXXXXXX
  if(!/^\d{8,15}$/.test(p)) return '';
  return p;
}
/* رابط "wa.me" لمراسلة العميل مباشرة عبر واتساب، أو نص فارغ إن كان الرقم غير صالح للتطبيع */
function whatsappLink(phone){
  const p = normalizePhoneForWhatsapp(phone);
  return p ? `https://wa.me/${p}` : '';
}
const WA_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="flex:none;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.34c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.55-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.78.97-.14.17-.29.19-.53.06-.25-.12-1.04-.38-1.99-1.22-.73-.66-1.23-1.47-1.37-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.84-.86 2.05s.88 2.38 1 2.55c.12.17 1.73 2.64 4.2 3.7.59.25 1.05.4 1.41.51.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.16-.48-.28z"/></svg>';
/* يبني HTML للرقم بجانب اسم العميل: رابط واتساب قابل للنقر إن أمكن تطبيع الرقم، وإلا نص عادي */
function phoneWithWhatsapp(phone){
  if(!phone) return '';
  const link = whatsappLink(phone);
  if(!link) return ` <span class="mono" style="color:var(--text-muted); font-size:11.5px;">(${escapeHtml(phone)})</span>`;
  return ` <a href="${link}" target="_blank" rel="noopener" class="mono" title="مراسلة العميل عبر واتساب" style="color:#25D366; font-size:11.5px; text-decoration:none; display:inline-flex; align-items:center; gap:3px; vertical-align:middle;">${WA_ICON}(${escapeHtml(phone)})</a>`;
}

// بديل عن window.open للطباعة: بعض تطبيقات Electron لا تدعم معاينة الطباعة (Print Preview)
// للنوافذ المفتوحة عبر window.open، فتظهر رسالة "This app doesn't support print preview".
// الحل: إنشاء iframe داخل نفس النافذة الرئيسية وكتابة محتوى الطباعة بداخله،
// فتعمل الطباعة والمعاينة بشكل طبيعي لأن الـ iframe جزء من نفس النافذة المُهيأة للطباعة.
// ملاحظة مهمة: يجب أن يكون الـ iframe *ظاهراً* بحجم حقيقي وليس صفراً/مخفياً،
// لأن محتوى الطباعة يتضمن زر "طباعة / حفظ PDF" ينقر عليه المستخدم يدوياً —
// وإن كان الإطار مخفياً (visibility:hidden) أو بحجم صفر فلن يظهر شيء على الإطلاق
// عند الضغط على زر الطباعة (وهذا كان سبب عدم عمل طباعة كشف الحضور والفاتورة).
/* ============================================================
   قالب موحّد لمستندات الطباعة (فواتير/سندات/تقارير/كشوف)
   بدل تكرار نفس قواعد CSS يدوياً في كل دالة طباعة على حدة —
   أي تعديل على شكل الطباعة (لون، خط، مسافات) يتم هنا فقط ويظهر في كل المستندات.
   ============================================================ */
const PRINT_PALETTE = { navy:'#1C3A52', gold:'#C97814', red:'#B03F31', text:'#1E2530', muted:'#626B78', border:'#DBE1E8', surfaceAlt:'#E7EBF0' };

function printDocStyles({accent = PRINT_PALETTE.navy, borderColor, amountColor, variant = 'full'} = {}){
  const p = PRINT_PALETTE;
  borderColor = borderColor || accent;
  amountColor = amountColor || accent;
  const base = `
    body{font-family:'Tahoma','Arial',sans-serif; color:${p.text}; margin:0; padding:${variant==='table'?'24px':'28px'};}
    .footer-note{margin-top:30px; font-size:11.5px; color:${p.muted}; text-align:center; border-top:1px solid ${p.border}; padding-top:12px;}
    @media print{ .no-print{display:none;} body{padding:10px;} }
    /* ---------- عرض المستند على شاشة جوال (لا يؤثر على الطباعة الفعلية) ----------
       المستند مصمم أصلاً لمقاس ورق A4، فبدون هذا الجزء يظهر مصغّراً جداً أو
       يتطلب تكبيراً يدوياً داخل معاينة الطباعة على الموبايل. */
    @media screen and (max-width:700px){
      body{padding:14px; overflow-x:auto;}
      table{width:max-content; min-width:100%;}
      th, td{white-space:nowrap;}
    }
  `;
  if(variant==='table' || variant==='table-center'){
    const cellAlign = variant==='table-center' ? 'center' : 'right';
    return base + `
    .head{display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid ${borderColor}; padding-bottom:14px; margin-bottom:16px;}
    .head img{width:70px; height:70px; border-radius:50%; object-fit:cover;}
    h2{color:${borderColor}; margin:0 0 4px;}
    .meta{font-size:13px; color:${p.muted}; margin-bottom:18px; display:flex; gap:18px; flex-wrap:wrap;}
    table{width:100%; border-collapse:collapse; font-size:12.5px;}
    th,td{border:1px solid ${p.border}; padding:8px; text-align:${cellAlign};}
    ${cellAlign==='right' ? 'td.mono, td:last-child{text-align:left; font-family:monospace;}' : ''}
    th{background:${p.surfaceAlt}; text-align:${cellAlign==='right'?'right':'center'};}
    `;
  }
  const amountBg = accent===p.red ? '#FBEEEA' : p.surfaceAlt;
  const amountBorder = accent===p.red ? '#E9CFC9' : p.border;
  return base + `
    .inv-head{display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${borderColor}; box-shadow:0 3px 0 ${p.gold}; padding-bottom:16px; margin-bottom:20px;}
    .inv-head .logo{width:90px; height:90px; border-radius:50%; object-fit:cover;}
    .inv-head .center-name{font-size:19px; font-weight:bold; color:${p.navy}; margin:0 0 4px;}
    .inv-head .center-meta{font-size:12.5px; color:${p.muted}; line-height:1.7;}
    .inv-title{text-align:left;}
    .inv-title h2{margin:0; color:${accent}; font-size:22px;}
    .inv-title .no{font-family:monospace; font-size:14px; margin-top:4px;}
    .zatca-qr{display:flex; flex-direction:column; align-items:center; gap:4px; margin-right:auto;}
    .zatca-qr img{width:110px; height:110px; border:1px solid ${p.border}; border-radius:6px; padding:4px; background:#fff;}
    .zatca-qr span{font-size:10.5px; color:${p.muted};}
    .info-grid{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:22px; font-size:13px;}
    .info-box{border:1px solid ${p.border}; border-radius:8px; padding:12px 14px;}
    .info-box h4{margin:0 0 8px; font-size:12.5px; color:${p.muted};}
    .info-row{display:flex; justify-content:space-between; padding:3px 0;}
    table.items{width:100%; border-collapse:collapse; margin-bottom:18px;}
    table.items th{background:${p.surfaceAlt}; text-align:right; padding:9px 12px; font-size:12.5px; color:${p.navy};}
    table.items td{padding:9px 12px; border-bottom:1px solid ${p.border}; font-size:13px;}
    table.items td.num{text-align:left; font-family:monospace;}
    .totals{width:320px; margin-right:auto; margin-left:0; font-size:13.5px;}
    .totals .r{display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid ${p.surfaceAlt};}
    .totals .grand{font-weight:bold; color:${p.navy}; font-size:15px; border-top:2px solid ${p.navy}; margin-top:4px; padding-top:8px;}
    .amount-box{background:${amountBg}; border:1px solid ${amountBorder}; border-radius:8px; padding:16px; text-align:center; margin-bottom:22px;}
    .amount-box .lbl{font-size:12.5px; color:${p.muted}; margin-bottom:6px;}
    .amount-box .amt{font-size:26px; font-weight:bold; color:${amountColor}; font-family:monospace;}
    .sig-grid{display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:50px;}
    .sig-box{text-align:center;}
    .sig-line{border-top:1px solid ${p.text}; margin-top:50px; padding-top:8px; font-size:12.5px;}
    @media screen and (max-width:700px){
      .inv-head{flex-wrap:wrap; gap:14px;}
      .zatca-qr{margin-right:0;}
      .zatca-qr img{width:84px; height:84px;}
      .info-grid{grid-template-columns:1fr; gap:10px;}
      .totals{width:100%;}
      table.items{font-size:12px;}
      table.items th, table.items td{padding:7px 8px; font-size:12px;}
      .sig-grid{grid-template-columns:1fr; gap:36px;}
    }
  `;
}
/* رأس مستند HTML كامل جاهز للطباعة (DOCTYPE + head + style) */
function printDocHead(title, {accent, borderColor, amountColor, variant, extraCss = ''} = {}){
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${printDocStyles({accent, borderColor, amountColor, variant})}${extraCss}</style></head>`;
}
/* زر الطباعة/الحفظ الموحّد أسفل كل مستند */
function printDocFooterButton(){
  return `<div class="no-print" style="text-align:center; margin-top:20px;"><button onclick="window.print()" style="padding:10px 24px; background:${PRINT_PALETTE.navy}; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer;">طباعة / حفظ PDF</button></div>`;
}

function openPrintTarget(){
  const overlay = document.createElement('div');
  overlay.id = 'print-preview-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,33,.6); z-index:99999; display:flex; flex-direction:column; align-items:center; padding:18px; box-sizing:border-box;';

  const bar = document.createElement('div');
  bar.style.cssText = 'width:100%; max-width:900px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;';
  bar.innerHTML = `<span style="color:#fff; font-family:Tahoma,Arial,sans-serif; font-size:13px;">معاينة الطباعة — اضغط زر "طباعة / حفظ PDF" داخل المعاينة</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ إغلاق المعاينة';
  closeBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border:none; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  closeBtn.onclick = ()=> overlay.remove();
  bar.appendChild(closeBtn);

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%; max-width:900px; flex:1 1 auto; background:#fff; border:0; border-radius:10px; min-height:0;';

  overlay.appendChild(bar);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);

  const win = iframe.contentWindow;
  win.addEventListener('afterprint', ()=>{ setTimeout(()=> overlay.remove(), 400); });
  return win;
}

onSearchInput('#search', renderTable);
$('#table-page-size')?.addEventListener('change', ()=>{ tableCurrentPage = 1; renderTable(); });
$('#table-page-first')?.addEventListener('click', ()=>{ tableCurrentPage = 1; renderTable(); });
$('#table-page-prev')?.addEventListener('click', ()=>{ tableCurrentPage = Math.max(1, tableCurrentPage-1); renderTable(); });
$('#table-page-next')?.addEventListener('click', ()=>{ tableCurrentPage = tableCurrentPage+1; renderTable(); });
$('#table-page-last')?.addEventListener('click', ()=>{ tableCurrentPage = Infinity; renderTable(); });
$('#filter-course').addEventListener('change', renderTable);
$('#filter-nat').addEventListener('change', renderTable);
$('#filter-status').addEventListener('change', renderTable);
$('#btn-filter-suspended').addEventListener('click', ()=>{
  showSuspendedOnly = !showSuspendedOnly;
  $('#btn-filter-suspended').classList.toggle('btn-gold', showSuspendedOnly);
  $('#btn-filter-suspended').classList.toggle('btn-ghost', !showSuspendedOnly);
  renderTable();
});
$('#btn-filter-unpurchased-bags').addEventListener('click', ()=>{
  showUnpurchasedBagsOnly = !showUnpurchasedBagsOnly;
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-gold', showUnpurchasedBagsOnly);
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-ghost', !showUnpurchasedBagsOnly);
  renderTable();
});
$('#filter-company').addEventListener('change', renderTable);
$('#filter-invoice').addEventListener('change', renderTable);
$('#filter-coursenum').addEventListener('change', renderTable);
$('#filter-refnum').addEventListener('change', renderTable);
$('#cl-date-from').addEventListener('input', renderTable);
$('#cl-date-to').addEventListener('input', renderTable);
$('#cl-paid-min').addEventListener('input', renderTable);
$('#cl-paid-max').addEventListener('input', renderTable);

$('#table-body').addEventListener('click', async e=>{
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  const invId = e.target.dataset.invoice;
  const suspendId = e.target.dataset.suspend;
  const unsuspendId = e.target.dataset.unsuspend;
  const cancelBagId = e.target.dataset.cancelbag;
  const delInvoiceId = e.target.dataset.delinvoice;
  if(invId){ await printInvoice(invId); return; }
  if(delInvoiceId){
    const c = clients.find(x=>x.id===delInvoiceId);
    if(!c || !c.taxInvoiceNo){ showToast('لا توجد فاتورة صادرة لهذا العميل'); return; }
    const invLabel = formatInvoiceNo(c.taxInvoiceNo);
    const reason = await customPrompt(`توثيقاً للمعايير المحاسبية، لا يمكن حذف رقم الفاتورة التسلسلي (${invLabel}) نهائياً أو إعادة استخدامه — سيتم حذف الفاتورة من سجل العميل "${c.name}" فقط مع الاحتفاظ بالرقم والسبب في سجل الفواتير المحذوفة. عند طباعة فاتورة جديدة لهذا العميل لاحقاً سيُمنح رقماً تسلسلياً جديداً.\nيرجى كتابة سبب الحذف (إلزامي):`, {title:'سبب حذف الفاتورة', required:true, placeholder:'اكتب سبب الحذف هنا...'});
    if(reason===null) return;
    if(!reason.trim()){ showToast('سبب الحذف إلزامي — لم يتم الحذف'); return; }
    snapshotState(`حذف فاتورة العميل: ${c.name} (${invLabel})`);
    const removed = softDeleteClientInvoice(c.id, reason.trim());
    if(removed){
      await saveClients();
      await saveDeletedInvoices();
      await logAudit('delete','العملاء', `تم حذف الفاتورة رقم ${removed.invoiceNoLabel} للعميل "${removed.clientName}" — السبب: ${removed.deletedReason}`);
      refreshEverything();
      showToast(`تم حذف الفاتورة ${removed.invoiceNoLabel}`);
    }
    return;
  }
  if(editId) openModal(editId);
  if(cancelBagId){
    const c = clients.find(x=>x.id===cancelBagId);
    if(c && await customConfirm(`تأكيد إلغاء الحقيبة المسجّلة لـ"${c.name}"؟ ستُحذف تماماً من سجل شراء الحقائب المكتملة (إن وُجدت) ومن سجل "اشتروا حقيبتهم الخاصة" (إن كانت كذلك)، ويُمسح رقم الفاتورة وتاريخ الشراء، وتعود حالته إلى "مطلوب شراء" — وإن كانت من المخزون تُعاد تلقائياً لرصيد التمويل.`)){
      snapshotState(`إلغاء حقيبة عميل: ${c.name}`);
      resetClientBagToPending(c);
      await saveClients(); await saveVaultTx(); await saveBagStock(); await saveSettings();
      await logAudit('edit','مخزون الحقائب', `تم إلغاء حقيبة العميل ${c.name} — عادت حالته إلى "مطلوب شراء"`);
      refreshEverything();
      showToast('تم إلغاء الحقيبة');
    }
  }
  if(suspendId){
    const c = clients.find(x=>x.id===suspendId);
    if(c && await customConfirm(`تأكيد إيقاف "${c.name}"؟ سيبقى ظاهراً في شيت العملاء، لكن سيختفي من شيت الدورات ومخزون الحقائب حتى تُلغي الإيقاف عنه.`)){
      snapshotState(`إيقاف عميل: ${c.name}`);
      c.suspended = true;
      await saveClients();
      await logAudit('edit','العملاء', `تم إيقاف العميل ${c.name} — أصبح مخفياً من شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      showToast('تم إيقاف العميل');
    }
  }
  if(unsuspendId){
    const c = clients.find(x=>x.id===unsuspendId);
    if(c){
      snapshotState(`إلغاء إيقاف عميل: ${c.name}`);
      c.suspended = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء إيقاف العميل ${c.name} — عاد للظهور في شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      showToast('تم إلغاء الإيقاف');
    }
  }
  if(delId){
    if(await customConfirm('تأكيد حذف هذا السجل؟ سيُحذف أيضاً أي ترحيل مالي مرتبط به.')){
      const removedClient = clients.find(c=>c.id===delId);
      snapshotState(`حذف عميل: ${removedClient?.name || delId}`);
      clients = clients.filter(c=>c.id!==delId);
      removeClientLedgerEntries(delId);
      await saveClients(); await saveVaultTx();
      await logAudit('delete','العملاء', `تم حذف بيانات العميل: ${removedClient?.name || delId}`);
      renderTable(); renderDashboard(); renderBags();
      showToast('تم حذف السجل');
    }
  }
});

/* ---------------- Modal / form ---------------- */
function openModal(id){
  editingId = id || null;
  $('#modal-title').textContent = id ? 'تعديل بيانات عميل' : 'إضافة عميل جديد';
  populateSelect($('#f-nat'), settings.nationalities, true);
  populateSelect($('#f-course'), settings.courses.map(c=>c.name), true);
  populateSelect($('#f-channel'), settings.channels.map(c=>c.name), true);

  const c = id ? clients.find(x=>x.id===id) : null;
  $('#f-name').value = c?.name || '';
  $('#f-id').value = c?.clientId || '';
  $('#f-phone').value = c?.phone || '';
  $('#f-nat').value = c?.nationality || '';
  $('#f-clienttype').value = c?.clientType || 'center';
  populateClientCompanySelect(c?.companyName || '');
  $('#f-ajal').value = c?.creditDays ?? '';
  $('#f-clienttax').value = c?.clientTaxNumber || '';
  $('#f-course').value = c?.courseType || '';
  $('#f-coursenum').value = c?.courseNumber || '';
  updateClientCourseStatus();
  $('#f-refer').value = c?.referNum || '';
  $('#f-invoice').value = c?.invoice || '';
  $('#f-baginvoice').value = c?.bagInvoice || '';
  $('#f-date').value = c?.date || '';
  $('#f-courseprice').value = c?.coursePrice ?? '';
  $('#f-bagsource').value = c?.bagSource || 'buy';
  $('#f-bagprice').value = c ? (c.bagPrice ?? '') : settings.bagPrice;
  $('#f-discount').value = c?.discount ?? 0;
  $('#f-paid').value = c?.paid ?? 0;
  if(c){
    const grandTotal = paidTotal(c);
    $('#f-paid-total-hint').textContent = `إجمالي المدفوع فعلياً لهذا العميل (شامل أي دفعات لاحقة سُجّلت في الحركات المالية): ${fmt(grandTotal)} ﷼`;
  }else{
    $('#f-paid-total-hint').textContent = 'لتسجيل دفعة إضافية لعميل مسجّل مسبقاً، احفظ العميل أولاً ثم استخدم "+ إضافة دفعة جديدة" أسفل هذا النموذج بدلاً من تعديل هذا الحقل، حتى يبقى سجل كل دفعة بتاريخها.';
  }
  $('#f-channel').value = c?.channel || '';
  $('#f-netinvoice').value = c?.networkInvoice || '';
  populateSelect($('#f-channel2'), settings.channels.map(c=>c.name), true);
  $('#f-split-payment').checked = !!(c && num(c.paid2)>0);
  $('#f-paid2').value = c?.paid2 ?? 0;
  $('#f-channel2').value = c?.channel2 || '';
  $('#f-netinvoice2').value = c?.networkInvoice2 || '';
  toggleSplitPayment();
  $('#f-stage').value = c?.stage || 'جديد';
  $('#f-cancelled').checked = !!c?.cancelled;
  $('#f-notes').value = c?.notes || '';
  toggleBagFields();
  toggleClientNetInvoice();
  toggleClientTypeFields();
  updateComputed();
  editingPaymentTxId = null;
  addingClientPayment = false;
  renderClientPaymentsPanel();
  $('#overlay').classList.add('show'); SoundFX.open();
  $('#f-name').focus();
}
function toggleClientTypeFields(){
  const isCompany = $('#f-clienttype').value === 'company';
  $('#wrap-f-company').style.display = isCompany ? '' : 'none';
  $('#wrap-f-ajal').style.display = isCompany ? '' : 'none';
  $('#wrap-f-company-hint').style.display = 'none';
  if(!isCompany) $('#f-ajal').value = '';
  else updateCompanyHint();
}
$('#f-clienttype').addEventListener('change', toggleClientTypeFields);
function populateClientCompanySelect(selectedValue){
  const sel = $('#f-company');
  const names = companies.map(c=>c.name);
  let optionsHtml = '<option value="">— اختر الشركة —</option>';
  // إن كان العميل مرتبطاً باسم شركة قديم لا يطابق أي شركة في القائمة الرئيسية (تهجئة مختلفة)، أضفه كخيار مميز حتى لا يُفقَد أو يُستبدل بصمت
  if(selectedValue && !names.includes(selectedValue)){
    optionsHtml += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)} (غير مطابق لقائمة الشركات — يرجى المراجعة)</option>`;
  }
  optionsHtml += names.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.innerHTML = optionsHtml;
  sel.value = selectedValue || '';
}
function updateCompanyHint(){
  const name = $('#f-company').value.trim();
  const c = companies.find(x=>x.name===name);
  if(c && c.categories && c.categories.length){
    $('#f-company-hint').textContent = `مبالغ هذه الشركة حسب الفئة: ${companyCategoriesSummaryText(c.categories)} — حدّد فئة هذا المتدرب يدوياً وعدّل الخصم بما يوافقها.`;
    $('#wrap-f-company-hint').style.display = '';
  }else if(c && num(c.agreedAmount)>0){
    $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(num(c.agreedAmount))} ﷼`;
    $('#wrap-f-company-hint').style.display = '';
    applyCompanyAgreedPricing(c);
  }else{
    $('#wrap-f-company-hint').style.display = 'none';
  }
}
/* عند اختيار شركة لها "مبلغ متفق عليه" ثابت لكل متدرب (بدون فئات)، يُحسَب الخصم تلقائياً
   بحيث يصبح "دخل المركز الصافي" (سعر الدورة - الخصم) مساوياً لهذا المبلغ المتفق عليه —
   فقط عند إضافة عميل جديد، حتى لا يُعاد حساب/الكتابة فوق خصم عميل محفوظ مسبقاً بالفعل. */
function applyCompanyAgreedPricing(company){
  if(editingId) return; // لا نُعدّل بيانات عميل محفوظ مسبقاً تلقائياً
  const price = num($('#f-courseprice').value);
  const agreed = num(company.agreedAmount);
  if(price<=0) return;
  const neededDiscount = Math.max(0, Math.round((price - agreed)*100)/100);
  $('#f-discount').value = neededDiscount;
  $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(agreed)} ﷼ — تم تعبئة الخصم تلقائياً (${fmt(neededDiscount)} ﷼) بحيث يصبح دخل المركز الصافي مساوياً لهذا المبلغ. يمكنك تعديل الخصم يدوياً إذا لزم الأمر.`;
  updateComputed();
}
$('#f-company').addEventListener('change', updateCompanyHint);
function toggleClientNetInvoice(){
  const chan = settings.channels.find(c=>c.name===$('#f-channel').value);
  $('#wrap-f-netinvoice').style.display = (chan && chan.dest==='network') ? '' : 'none';
}
$('#f-channel').addEventListener('change', toggleClientNetInvoice);
function toggleSplitPayment(){
  const on = $('#f-split-payment').checked;
  $('#wrap-f-paid2').style.display = on ? '' : 'none';
  $('#wrap-f-channel2').style.display = on ? '' : 'none';
  toggleClientNetInvoice2();
  updateComputed();
}
function toggleClientNetInvoice2(){
  const on = $('#f-split-payment').checked;
  const chan2 = settings.channels.find(c=>c.name===$('#f-channel2').value);
  $('#wrap-f-netinvoice2').style.display = (on && chan2 && chan2.dest==='network') ? '' : 'none';
}
$('#f-split-payment').addEventListener('change', toggleSplitPayment);
$('#f-channel2').addEventListener('change', toggleClientNetInvoice2);
$('#f-paid2').addEventListener('input', updateComputed);
function toggleBagFields(){
  const isOwn = $('#f-bagsource').value === 'own';
  $('#wrap-bagprice').style.display = isOwn ? 'none' : '';
  $('#wrap-baginvoice').style.display = isOwn ? 'none' : '';
  if(isOwn) $('#f-bagprice').value = 0;
  else if(num($('#f-bagprice').value)===0) $('#f-bagprice').value = settings.bagPrice;
  updateComputed();
}
$('#f-bagsource').addEventListener('change', toggleBagFields);
function closeModal(){ $('#overlay').classList.remove('show'); editingId=null; editingPaymentTxId=null; addingClientPayment=false; }
$('#btn-cancel').addEventListener('click', closeModal);
$('#overlay').addEventListener('click', e=>{ if(e.target.id==='overlay') closeModal(); });

/* ---------------- سجل الدفعات المرتبطة بالعميل (عرض فقط) ----------------
   هذا السجل في شيت "العملاء" أصبح للعرض فقط — أي إضافة أو تعديل أو حذف لدفعات
   العميل (غير دفعتَي التسجيل التلقائيتين) تتم حصرياً من تبويب "الحركات المالية". */
function renderClientPaymentsPanel(){
  const wrap = $('#wrap-client-payments');
  if(!wrap) return;
  const c = editingId ? clients.find(x=>x.id===editingId) : null;
  if(!c || !c.clientId){ wrap.style.display='none'; $('#client-payments-list').innerHTML=''; return; }
  wrap.style.display = '';
  const txs = vaultTx.filter(t=>t.type==='in' && t.clientId===c.clientId)
    .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (num(a.seq)-num(b.seq)));
  const list = $('#client-payments-list');

  const rowsHtml = txs.map(t=>{
    const isAuto = !!t.autoClientId;
    return `
    <div class="tag" style="width:100%; justify-content:space-between; border-radius:8px; margin-bottom:6px; flex-wrap:wrap;">
      <span class="mono" style="font-size:12px;">#${t.seq||'—'} · ${t.date||'—'} · ${escapeHtml(t.method||'—')} (${destLabel(t.destination||'vault')}) · <b>${fmt(num(t.amount))}</b> ﷼</span>
      <span class="hint" style="margin:0; font-size:11px;">${isAuto ? 'دفعة التسجيل — عدّلها من حقلي "المبلغ المدفوع"/"طريقة الدفع" أعلاه' : 'للتعديل أو الحذف، استخدم تبويب "الحركات المالية"'}</span>
    </div>`;
  }).join('');

  list.innerHTML = rowsHtml || '<div class="hint" style="margin:0;">لا توجد أي دفعة مسجّلة لهذا العميل بعد.</div>';
}

$('#btn-add').addEventListener('click', ()=>openModal(null));
/* زر تحديث لكامل شيت العملاء: يعيد مزامنة حركات الدفع التلقائية لكل عميل مع بياناته الحالية،
   ويعيد رسم كل الشاشات المرتبطة (الجدول، لوحة التحكم، الفلاتر، التقارير، الدورات، الخزنة) دفعة واحدة */
$('#btn-refresh-clients').addEventListener('click', async ()=>{
  snapshotState('تحديث شامل لشيت العملاء');
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveClients();
  await saveVaultTx();
  await saveSettings();
  renderTable();
  renderDashboard();
  refreshFilterOptions();
  renderReports();
  renderCourses();
  if(typeof renderVault==='function') renderVault();
  await logAudit('edit','العملاء', `تحديث شامل لشيت العملاء: إعادة مزامنة بيانات ${clients.length} عميل وإعادة رسم كل الشاشات المرتبطة`);
  showToast('تم تحديث الشيت بالكامل');
});

$('#f-course').addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits on existing record
  if($('#f-nat').value){
    $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  }else{
    const found = settings.courses.find(c=>c.name===$('#f-course').value);
    if(found && !$('#f-courseprice').value) $('#f-courseprice').value = found.price;
  }
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
function isSaudiNationality(v){ return /^(saudi|سعود)/i.test(String(v||'').trim()); }
function nationalityCoursePrice(nat){ return isSaudiNationality(nat) ? num(settings.priceSaudi) : num(settings.priceNonSaudi); }
function reapplyCompanyPricingIfNeeded(){
  if($('#f-clienttype').value!=='company') return;
  const c = companies.find(x=>x.name===$('#f-company').value.trim());
  if(c && !(c.categories && c.categories.length) && num(c.agreedAmount)>0) applyCompanyAgreedPricing(c);
}
$('#f-nat').addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits على السجل
  if($('#f-nat').value) $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
/* حالة دورة هذا العميل تحديداً (برقم دورته الخاص فقط) — تظهر فقط عند وجود رقم دورة، ولا تعرض أي شيء عن باقي أنواع الدورات */
function updateClientCourseStatus(){
  const cn = $('#f-coursenum').value.trim();
  const wrap = $('#wrap-f-coursestatus');
  const box = $('#f-coursestatus-box');
  if(!cn){ wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  const sess = courseSessions.find(s=>s.courseNumber===cn);
  const date = sess?.date || '';
  if(!date){
    box.innerHTML = `<span class="stamp" style="border-color:var(--text-muted); color:var(--text-muted);">لم يتم تحديد تاريخ الدورة بعد</span>`;
    return;
  }
  const isTaken = date <= todayISO();
  box.innerHTML = isTaken
    ? `<span class="stamp paid">تم أخذ الدورة (${escapeHtml(date)})</span>`
    : `<span class="stamp owe">لم يحن موعد الدورة بعد (${escapeHtml(date)})</span>`;
}
$('#f-coursenum').addEventListener('input', updateClientCourseStatus);
['#f-courseprice','#f-bagprice','#f-discount','#f-paid'].forEach(sel=>{
  $(sel).addEventListener('input', updateComputed);
});
function updateComputed(){
  const income = num($('#f-courseprice').value) - num($('#f-discount').value);
  const bag = $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value);
  const t = income + bag;
  const paidTotalForm = num($('#f-paid').value) + ($('#f-split-payment').checked ? num($('#f-paid2').value) : 0);
  const r = Math.max(0, t - paidTotalForm);
  $('#calc-income').textContent = fmt(income);
  $('#calc-bag').textContent = fmt(bag);
  $('#calc-total').textContent = fmt(t);
  $('#calc-remaining').textContent = fmt(r);
}

$('#client-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const data = {
    name: $('#f-name').value.trim(),
    clientId: $('#f-id').value.trim(),
    phone: $('#f-phone').value.trim(),
    nationality: $('#f-nat').value,
    clientType: $('#f-clienttype').value,
    companyName: $('#f-clienttype').value==='company' ? $('#f-company').value.trim() : '',
    creditDays: $('#f-clienttype').value==='company' ? num($('#f-ajal').value) : '',
    clientTaxNumber: $('#f-clienttax').value.trim(),
    courseType: $('#f-course').value,
    courseNumber: $('#f-coursenum').value.trim(),
    referNum: $('#f-refer').value.trim(),
    invoice: $('#f-invoice').value.trim(),
    bagInvoice: $('#f-baginvoice').value.trim(),
    date: $('#f-date').value,
    coursePrice: num($('#f-courseprice').value),
    bagSource: $('#f-bagsource').value,
    bagPrice: $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value),
    discount: num($('#f-discount').value),
    paid: num($('#f-paid').value),
    channel: $('#f-channel').value,
    networkInvoice: $('#f-netinvoice').value.trim(),
    paid2: $('#f-split-payment').checked ? num($('#f-paid2').value) : 0,
    channel2: $('#f-split-payment').checked ? $('#f-channel2').value : '',
    networkInvoice2: $('#f-split-payment').checked ? $('#f-netinvoice2').value.trim() : '',
    stage: $('#f-stage').value,
    cancelled: $('#f-cancelled').checked,
    notes: $('#f-notes').value.trim(),
  };
  // إذا تم تعيين رقم دورة جديد يدوياً، يُلغى تلقائياً وسم الغياب السابق
  if(editingId){
    const prev = clients.find(x=>x.id===editingId);
    if(prev && prev.absent && data.courseNumber && data.courseNumber!==prev.courseNumber){
      data.absent = false;
    }
  }
  if(!data.clientId){ showToast('رقم الهوية مطلوب — يُستخدم لربط كل العمليات بهذا العميل'); return; }
  if(!/^\d{10}$/.test(data.clientId)){ showToast('رقم الهوية يجب أن يتكون من 10 خانات (أرقام) بالضبط — لا أقل ولا أكثر'); return; }
  if(!data.name){ showToast('الاسم مطلوب'); return; }
  const dupId = clients.find(c=>c.clientId===data.clientId && c.id!==editingId);
  if(dupId){ showToast(`رقم الهوية مستخدم بالفعل لعميل آخر: ${dupId.name}`); return; }
  const wasEdit = !!editingId;
  const prevClientForEvents = editingId ? clients.find(x=>x.id===editingId) : null;
  const prevCourseNumberForEvent = prevClientForEvents ? (prevClientForEvents.courseNumber||'') : '';
  snapshotState(wasEdit ? `تعديل عميل: ${data.name}` : `إضافة عميل: ${data.name}`);
  if(editingId){
    const idx = clients.findIndex(c=>c.id===editingId);
    const prevSource = clients[idx].bagSource;
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock' && !clients[idx].bagPurchaseDate) data.bagPurchaseDate = todayISO();
    // إن كان مصدر حقيبته السابق "من المخزون" وتغيّر الآن لأي مصدر آخر، تُلغى عملية التسليم المسجّلة
    // تلقائياً من سجل مخزون الحقائب حتى تعود الحقيبة لرصيد المخزون المتاح ولا يبقى خصم بلا مقابل
    if(prevSource==='stock' && data.bagSource!=='stock'){
      const stIdx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===clients[idx].id);
      if(stIdx>-1){ bagStock.splice(stIdx,1); recalcBagFundLedger(); await saveBagStock(); }
    }
    clients[idx] = {...clients[idx], ...data};
    if(data.bagSource!=='stock') delete clients[idx].bagPurchaseDate;
    showToast('تم تحديث السجل');
  }else{
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock') data.bagPurchaseDate = data.bagPurchaseDate || todayISO();
    clients.push({id:uid(), createdAt:Date.now(), ...data});
    showToast('تمت إضافة العميل');
  }
  const savedClient = editingId ? clients.find(c=>c.id===editingId) : clients[clients.length-1];
  await saveClients();
  syncClientLedgerEntry(savedClient);
  await syncBagStockIssues();
  await saveVaultTx();
  await saveSettings();
  await logAudit(wasEdit ? 'edit' : 'add', 'العملاء', `${wasEdit ? 'تم تعديل' : 'تمت إضافة'} بيانات العميل: ${savedClient.name}`);
  if(!wasEdit){
    sendPowerAutomateEvent('new_client', {clientId: savedClient.clientId, name: savedClient.name, nationality: savedClient.nationality||'', phone: savedClient.phone||'', courseType: savedClient.courseType||'', courseNumber: savedClient.courseNumber||''});
  }
  if(savedClient.courseNumber && savedClient.courseNumber!==prevCourseNumberForEvent){
    sendPowerAutomateEvent('course_number_updated', {clientId: savedClient.clientId, name: savedClient.name, courseNumber: savedClient.courseNumber, courseType: savedClient.courseType||''});
  }
  closeModal(); renderTable(); renderDashboard(); refreshFilterOptions(); renderCourses(); renderBags();
});

/* ---------------- إضافة عدة عملاء دفعة واحدة (جدول) ---------------- */
let bulkAddRowSeq = 0;
function bulkAddOptionsHtml(values, selected){
  return '<option value=""></option>' + values.map(v=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(v)}</option>`).join('');
}
function bulkAddRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="ba-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="ba-name" data-col="1" placeholder="اسم العميل" style="min-width:130px;"></td>
    <td><input type="text" class="ba-phone" data-col="2" style="min-width:100px;"></td>
    <td><select class="ba-nat" data-col="3" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="ba-course" data-col="4" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="ba-coursenum" data-col="5" style="min-width:90px;"></td>
    <td><input type="date" class="ba-date" data-col="6" value="${todayISO()}" style="min-width:130px;"></td>
    <td><input type="number" class="ba-price" data-col="7" value="${settings.coursePrice||0}" style="min-width:90px;"></td>
    <td><input type="number" class="ba-discount" data-col="8" value="0" style="min-width:80px;"></td>
    <td><input type="number" class="ba-paid" data-col="9" value="0" style="min-width:90px;"></td>
    <td><select class="ba-channel" data-col="10" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="ba-notes" data-col="11" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm ba-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkAddRow(){
  bulkAddRowSeq++;
  $('#bulk-add-table-body').insertAdjacentHTML('beforeend', bulkAddRowHtml(bulkAddRowSeq));
}
function openBulkAddModal(){
  $('#bulk-add-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkAddRow();
  $('#bulk-add-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkAddModal(){ $('#bulk-add-overlay').classList.remove('show'); }
$('#btn-bulk-add').addEventListener('click', openBulkAddModal);
$('#btn-bulk-add-cancel').addEventListener('click', closeBulkAddModal);
$('#bulk-add-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-add-overlay') closeBulkAddModal(); });
$('#btn-bulk-add-row').addEventListener('click', addBulkAddRow);
$('#bulk-add-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('ba-remove-row')){
    const rows = $('#bulk-add-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// يحول تاريخاً مكتوباً بصيغة يوم/شهر/سنة (الشائعة عند النسخ من إكسل) إلى صيغة yyyy-mm-dd التي يفهمها حقل التاريخ
function normalizeDateForBulkPaste(val){
  val = val.trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const m = val.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m){
    const day = m[1].padStart(2,'0'), month = m[2].padStart(2,'0'), year = m[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}
// يختار في القائمة المنسدلة الخيار المطابق (نصاً) لما تم لصقه، متجاهلاً حالة الأحرف والمسافات الزائدة
function setBulkSelectFuzzy(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة: يوزَّع تلقائياً على الصفوف بدءاً من الخلية التي بدأ منها اللصق،
// ويُضيف صفوفاً جديدة تلقائياً إن لم تكفِ الصفوف الحالية لعدد القيم الملصوقة
$('#bulk-add-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return; // لصق خلية واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop(); // إزالة سطر فارغ أخير ناتج عن نسخ إكسل
  const tbody = $('#bulk-add-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkAddRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>11) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzy(field, val);
      else if(field.classList.contains('ba-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-add-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-add-table-body').querySelectorAll('tr')];
  const toAdd = [];
  const errors = [];
  const seenIdsThisBatch = new Set();
  rows.forEach((row, i)=>{
    const clientId = row.querySelector('.ba-id').value.trim();
    const name = row.querySelector('.ba-name').value.trim();
    // صف فارغ بالكامل (لم يُدخَل فيه شيء) يُتجاهل بصمت بدل اعتباره خطأً
    if(!clientId && !name) return;
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!/^\d{10}$/.test(clientId)){ errors.push(`${rowLabel}: رقم الهوية يجب أن يتكون من 10 أرقام بالضبط`); return; }
    if(!name){ errors.push(`${rowLabel}: الاسم مطلوب`); return; }
    if(clients.find(c=>c.clientId===clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مستخدم بالفعل لعميل آخر`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    const bagSource = 'stock';
    const rowDate = row.querySelector('.ba-date').value || todayISO();
    toAdd.push({
      id: uid(), createdAt: Date.now(),
      clientId, name,
      phone: row.querySelector('.ba-phone').value.trim(),
      nationality: row.querySelector('.ba-nat').value,
      clientType: 'center',
      companyName: '', creditDays: '',
      clientTaxNumber: '',
      courseType: row.querySelector('.ba-course').value,
      courseNumber: row.querySelector('.ba-coursenum').value.trim(),
      referNum: '', invoice: '', bagInvoice: '',
      date: rowDate,
      coursePrice: num(row.querySelector('.ba-price').value),
      bagSource, bagPrice: num(settings.bagPrice),
      bagStatus: 'purchased', bagPurchaseDate: rowDate,
      discount: num(row.querySelector('.ba-discount').value),
      paid: num(row.querySelector('.ba-paid').value),
      channel: row.querySelector('.ba-channel').value,
      networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
      stage: 'جديد', cancelled: false,
      notes: row.querySelector('.ba-notes').value.trim()
    });
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!toAdd.length){ showToast('لم تُدخل بيانات أي عميل'); return; }
  snapshotState(`إضافة ${toAdd.length} عميل دفعة واحدة`);
  toAdd.forEach(c=>{ clients.push(c); syncClientLedgerEntry(c); });
  await saveClients();
  await syncBagStockIssues();
  await saveVaultTx();
  await saveSettings();
  await logAudit('add','العملاء', `تمت إضافة ${toAdd.length} عميل دفعة واحدة عبر جدول الإضافة المتعددة: ${toAdd.map(c=>c.name).join('، ')}`);
  closeBulkAddModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderCourses(); renderBags();
});


/* ---------------- تحديث/استيراد بيانات العملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الاستيراد القديم عبر ملفات Excel (البيانات الرئيسية + الخصم + نوع الدورة + الأسماء).
   القاعدة: رقم الهوية إلزامي في كل صف. إن كان موجوداً بالفعل تُحدَّث فقط الأعمدة التي بها قيمة في هذا
   الصف (أي عمود فارغ يبقى كما هو في النظام دون تغيير) — تماماً كمنطق الاستيراد القديم؛ وإن لم يكن
   موجوداً يُضاف كعميل جديد بشرط توفر الاسم أيضاً. هذا يجعل نفس الجدول صالحاً لتحديث الخصم فقط، أو نوع
   الدورة فقط، أو الاسم فقط، أو أي مجموعة أعمدة، دون الحاجة لملء بقية الصف. */
let bulkUpdateRowSeq = 0;
function buFixedOptionsHtml(pairs, selected){
  return '<option value=""></option>' + pairs.map(([v,l])=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(l)}</option>`).join('');
}
function bulkUpdateRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  const ctypeOptions = buFixedOptionsHtml([['center','عميل مركز'],['company','عميل شركات']], '');
  const bagSourceOptions = buFixedOptionsHtml([['stock','من المخزون'],['buy','شراء'],['own','خاصته']], '');
  const cancelledOptions = buFixedOptionsHtml([['no','لا'],['yes','نعم']], '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bu-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="bu-name" data-col="1" style="min-width:130px;"></td>
    <td><input type="text" class="bu-refer" data-col="2" style="min-width:100px;"></td>
    <td><input type="text" class="bu-phone" data-col="3" style="min-width:100px;"></td>
    <td><select class="bu-nat" data-col="4" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="bu-ctype" data-col="5" style="min-width:110px;">${ctypeOptions}</select></td>
    <td><input type="text" class="bu-company" data-col="6" style="min-width:130px;"></td>
    <td><input type="number" class="bu-credit" data-col="7" style="min-width:80px;"></td>
    <td><select class="bu-course" data-col="8" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="bu-coursenum" data-col="9" style="min-width:90px;"></td>
    <td><input type="text" class="bu-invoice" data-col="10" style="min-width:100px;"></td>
    <td><input type="date" class="bu-date" data-col="11" style="min-width:130px;"></td>
    <td><input type="number" class="bu-price" data-col="12" style="min-width:90px;"></td>
    <td><select class="bu-bagsource" data-col="13" style="min-width:110px;">${bagSourceOptions}</select></td>
    <td><input type="number" class="bu-bagprice" data-col="14" style="min-width:90px;"></td>
    <td><input type="text" class="bu-baginvoice" data-col="15" style="min-width:110px;"></td>
    <td><input type="number" class="bu-discount" data-col="16" style="min-width:80px;"></td>
    <td><input type="number" class="bu-paid" data-col="17" style="min-width:90px;"></td>
    <td><select class="bu-channel" data-col="18" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="number" class="bu-paid2" data-col="19" style="min-width:90px;"></td>
    <td><select class="bu-channel2" data-col="20" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="bu-netinvoice" data-col="21" style="min-width:110px;"></td>
    <td><input type="text" class="bu-stage" data-col="22" style="min-width:90px;"></td>
    <td><select class="bu-cancelled" data-col="23" style="min-width:80px;">${cancelledOptions}</select></td>
    <td><input type="text" class="bu-notes" data-col="24" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm bu-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkUpdateRow(){
  bulkUpdateRowSeq++;
  $('#bulk-update-table-body').insertAdjacentHTML('beforeend', bulkUpdateRowHtml(bulkUpdateRowSeq));
}
function openBulkUpdateModal(){
  $('#bulk-update-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkUpdateRow();
  $('#bulk-update-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkUpdateModal(){ $('#bulk-update-overlay').classList.remove('show'); }

/* ---------------- إرسال رسالة واتساب جماعية للعملاء المحددين (wa.me تسلسلي) ---------------- */
function normalizePhoneForWhatsapp(raw){
  if(!raw) return '';
  let digits = String(raw).replace(/[^0-9]/g, '');
  if(!digits) return '';
  if(digits.startsWith('00')) digits = digits.slice(2);
  if(digits.startsWith('0')) digits = '966' + digits.slice(1); // رقم سعودي محلي يبدأ بصفر
  else if(digits.length===9 && digits.startsWith('5')) digits = '966' + digits; // بدون صفر وبدون كود الدولة
  return digits;
}
let bulkMsgQueue = [];
let bulkMsgIndex = 0;
let bulkMsgTemplate = '';

function openBulkMessageModal(){
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); return; }
  const recipients = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  const noPhoneCount = recipients.filter(c=>!normalizePhoneForWhatsapp(c.phone)).length;
  $('#bulk-msg-recipient-count').textContent = recipients.length;
  const warn = $('#bulk-msg-no-phone-warning');
  if(noPhoneCount>0){ warn.style.display=''; $('#bulk-msg-no-phone-count').textContent = noPhoneCount; }
  else { warn.style.display='none'; }
  $('#bulk-msg-text').value = '';
  $('#bulk-msg-setup-view').style.display = '';
  $('#bulk-msg-send-view').style.display = 'none';
  $('#bulk-message-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkMessageModal(){ $('#bulk-message-overlay').classList.remove('show'); }
function renderBulkMsgCurrent(){
  const c = bulkMsgQueue[bulkMsgIndex];
  $('#bulk-msg-current-index').textContent = bulkMsgIndex+1;
  $('#bulk-msg-total-count').textContent = bulkMsgQueue.length;
  $('#bulk-msg-current-name').textContent = c.name || '(بدون اسم)';
  const phone = normalizePhoneForWhatsapp(c.phone);
  $('#bulk-msg-current-phone').textContent = c.phone ? c.phone : '—';
  $('#bulk-msg-skip-hint').style.display = phone ? 'none' : '';
  $('#btn-bulk-message-open-wa').disabled = !phone;
  $('#btn-bulk-message-prev').disabled = bulkMsgIndex===0;
  $('#btn-bulk-message-next').textContent = (bulkMsgIndex===bulkMsgQueue.length-1) ? 'إنهاء ✓' : 'التالي ▶';
}
$('#btn-bulk-send-message').addEventListener('click', openBulkMessageModal);
$('#btn-bulk-message-cancel').addEventListener('click', closeBulkMessageModal);
$('#btn-bulk-message-close').addEventListener('click', closeBulkMessageModal);
$('#bulk-message-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-message-overlay') closeBulkMessageModal(); });
$('#btn-bulk-message-start').addEventListener('click', async ()=>{
  const text = $('#bulk-msg-text').value.trim();
  if(!text){ showToast('اكتب نص الرسالة أولاً'); return; }
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); closeBulkMessageModal(); return; }
  bulkMsgQueue = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  bulkMsgTemplate = text;
  bulkMsgIndex = 0;
  $('#bulk-msg-setup-view').style.display = 'none';
  $('#bulk-msg-send-view').style.display = '';
  renderBulkMsgCurrent();
  await logAudit('other','العملاء', `بدء إرسال رسالة واتساب جماعية لعدد ${bulkMsgQueue.length} عميل`);
});
$('#btn-bulk-message-open-wa').addEventListener('click', ()=>{
  const c = bulkMsgQueue[bulkMsgIndex];
  const phone = normalizePhoneForWhatsapp(c.phone);
  if(!phone) return;
  const personalized = bulkMsgTemplate.replaceAll('{name}', c.name || '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(personalized)}`;
  window.open(url, '_blank');
});
$('#btn-bulk-message-prev').addEventListener('click', ()=>{
  if(bulkMsgIndex>0){ bulkMsgIndex--; renderBulkMsgCurrent(); }
});
$('#btn-bulk-message-next').addEventListener('click', ()=>{
  if(bulkMsgIndex < bulkMsgQueue.length-1){ bulkMsgIndex++; renderBulkMsgCurrent(); }
  else { showToast('تم الانتهاء من قائمة الإرسال'); closeBulkMessageModal(); }
});

$('#btn-bulk-update').addEventListener('click', openBulkUpdateModal);
$('#btn-bulk-update-cancel').addEventListener('click', closeBulkUpdateModal);
$('#bulk-update-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-update-overlay') closeBulkUpdateModal(); });
$('#btn-bulk-update-row').addEventListener('click', addBulkUpdateRow);
$('#bulk-update-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bu-remove-row')){
    const rows = $('#bulk-update-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق منسوخ من إكسل، مع مطابقة نصّية (لا قيمة فقط) لقوائم الاختيار ذات الأكواد الثابتة (نوع العميل/مصدر الحقيبة/ملغى)
function setBulkSelectFuzzyAny(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase() || o.textContent.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
$('#bulk-update-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#bulk-update-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkUpdateRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>24) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzyAny(field, val);
      else if(field.classList.contains('bu-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-update-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-update-table-body').querySelectorAll('tr')];
  const present = v => !(v===undefined || v===null || String(v).trim()==='');
  const errors = [];
  const seenIdsThisBatch = new Set();
  const patches = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value;
    const clientId = val('bu-id').trim();
    const anyValue = [...row.querySelectorAll('input,select')].some(el=> el.value && String(el.value).trim()!=='');
    if(!clientId && !anyValue) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    const name = val('bu-name').trim();
    const existingIdx = clients.findIndex(c=>c.clientId===clientId);
    if(existingIdx>-1){
      const existing = clients[existingIdx];
      const patch = {};
      if(present(name)) patch.name = name;
      if(present(val('bu-refer'))) patch.referNum = val('bu-refer').trim();
      if(present(val('bu-phone'))) patch.phone = val('bu-phone').trim();
      if(present(val('bu-nat'))) patch.nationality = val('bu-nat');
      if(present(val('bu-ctype'))) patch.clientType = val('bu-ctype');
      if(present(val('bu-company'))) patch.companyName = val('bu-company').trim();
      if(present(val('bu-credit'))) patch.creditDays = num(val('bu-credit'));
      if(present(val('bu-course'))) patch.courseType = val('bu-course');
      if(present(val('bu-coursenum'))) patch.courseNumber = val('bu-coursenum').trim();
      if(present(val('bu-invoice'))) patch.invoice = val('bu-invoice').trim();
      if(present(val('bu-date'))) patch.date = val('bu-date');
      if(present(val('bu-price'))) patch.coursePrice = num(val('bu-price'));
      if(present(val('bu-baginvoice'))) patch.bagInvoice = val('bu-baginvoice').trim();
      if(present(val('bu-discount'))) patch.discount = num(val('bu-discount'));
      if(present(val('bu-paid'))) patch.paid = num(val('bu-paid'));
      if(present(val('bu-paid2'))) patch.paid2 = num(val('bu-paid2'));
      if(present(val('bu-channel2'))) patch.channel2 = val('bu-channel2');
      if(present(val('bu-channel'))) patch.channel = val('bu-channel');
      if(present(val('bu-netinvoice'))) patch.networkInvoice = val('bu-netinvoice').trim();
      if(present(val('bu-stage'))) patch.stage = val('bu-stage').trim() || 'جديد';
      if(present(val('bu-cancelled'))) patch.cancelled = val('bu-cancelled')==='yes';
      if(present(val('bu-notes'))) patch.notes = val('bu-notes').trim();
      if(present(val('bu-bagsource'))){
        const bagSourceNew = val('bu-bagsource');
        patch.bagSource = bagSourceNew;
        if(bagSourceNew==='own'){ patch.bagPrice = 0; }
        else if(present(val('bu-bagprice'))){ patch.bagPrice = num(val('bu-bagprice')); }
        if(bagSourceNew!=='buy'){ patch.bagStatus = bagSourceNew==='stock' ? 'purchased' : 'n/a'; }
        else if(!existing.bagStatus || existing.bagSource!=='buy'){ patch.bagStatus = 'pending'; }
        else { patch.bagStatus = existing.bagStatus; }
        const effectiveBagInvoice = present(val('bu-baginvoice')) ? patch.bagInvoice : existing.bagInvoice;
        if(bagSourceNew==='buy' && effectiveBagInvoice){
          patch.bagStatus = 'purchased';
          if(!existing.bagPurchaseDate) patch.bagPurchaseDate = todayISO();
        }
      } else if(present(val('bu-bagprice'))){
        patch.bagPrice = num(val('bu-bagprice'));
      }
      patches.push({mode:'update', idx: existingIdx, patch, oldCourseNumber: existing.courseNumber||''});
    } else {
      if(!name){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بالنظام — الاسم مطلوب لإضافته كعميل جديد`); return; }
      const bagSource = val('bu-bagsource') || 'stock';
      const clientTypeRaw = val('bu-ctype') || 'center';
      const rowData = {
        clientId, name,
        referNum: val('bu-refer').trim(),
        phone: val('bu-phone').trim(),
        nationality: val('bu-nat'),
        clientType: clientTypeRaw,
        companyName: clientTypeRaw==='company' ? val('bu-company').trim() : '',
        creditDays: clientTypeRaw==='company' ? num(val('bu-credit')) : '',
        courseType: val('bu-course'),
        courseNumber: val('bu-coursenum').trim(),
        invoice: val('bu-invoice').trim(),
        date: val('bu-date') || todayISO(),
        coursePrice: num(val('bu-price')),
        bagSource,
        bagPrice: bagSource==='own' ? 0 : num(val('bu-bagprice')),
        bagInvoice: val('bu-baginvoice').trim(),
        discount: num(val('bu-discount')),
        paid: num(val('bu-paid')),
        paid2: num(val('bu-paid2')),
        channel2: val('bu-channel2'),
        channel: val('bu-channel'),
        networkInvoice: val('bu-netinvoice').trim(),
        stage: val('bu-stage').trim() || 'جديد',
        cancelled: val('bu-cancelled')==='yes',
        notes: val('bu-notes').trim(),
      };
      rowData.bagStatus = rowData.bagSource==='buy' ? 'pending' : (rowData.bagSource==='stock' ? 'purchased' : 'n/a');
      if(rowData.bagSource==='buy' && rowData.bagInvoice){
        rowData.bagStatus = 'purchased';
        rowData.bagPurchaseDate = todayISO();
      }
      patches.push({mode:'add', data:{id:uid(), createdAt:Date.now(), ...rowData}});
    }
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!patches.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد بيانات العملاء دفعة واحدة (${patches.length} صف)`);
  let added=0, updated=0;
  const changedRows = [];
  patches.forEach(p=>{
    if(p.mode==='update'){
      clients[p.idx] = {...clients[p.idx], ...p.patch};
      updated++;
      changedRows.push({'الإجراء':'تحديث', ...clientToExportRow(clients[p.idx])});
      if(p.patch.courseNumber && p.patch.courseNumber!==p.oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: clients[p.idx].clientId, name: clients[p.idx].name, courseNumber: clients[p.idx].courseNumber, courseType: clients[p.idx].courseType||''});
      }
    } else {
      clients.push(p.data);
      added++;
      changedRows.push({'الإجراء':'إضافة جديد', ...clientToExportRow(p.data)});
      sendPowerAutomateEvent('new_client', {clientId: p.data.clientId, name: p.data.name, nationality: p.data.nationality||'', phone: p.data.phone||'', courseType: p.data.courseType||'', courseNumber: p.data.courseNumber||''});
      if(p.data.courseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: p.data.clientId, name: p.data.name, courseNumber: p.data.courseNumber, courseType: p.data.courseType||''});
      }
    }
  });
  await saveClients();
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveVaultTx();
  await saveSettings();
  await syncBagStockIssues();
  await logAudit('edit','العملاء', `تحديث/استيراد بيانات العملاء من جدول داخل البرنامج: تمت إضافة ${added} عميل جديد، وتحديث ${updated} عميل موجود`);
  closeBulkUpdateModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
  downloadXlsx(`تقرير_تحديث_العملاء_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم: ${added} جديد، ${updated} محدث`);
});

/* ---------------- حذف عملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الحذف عبر استيراد ملف Excel القديم؛ نفس منطق التأكيد والنسخة الاحتياطية والمزامنة المالية. */
let bulkDeleteRowSeq = 0;
function bulkDeleteRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bd-id" data-col="0" maxlength="10" placeholder="رقم الهوية"></td>
    <td><button type="button" class="btn btn-danger btn-sm bd-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkDeleteRow(){
  bulkDeleteRowSeq++;
  $('#bulk-delete-table-body').insertAdjacentHTML('beforeend', bulkDeleteRowHtml(bulkDeleteRowSeq));
}
function openBulkDeleteModal(){
  $('#bulk-delete-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkDeleteRow();
  $('#bulk-delete-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkDeleteModal(){ $('#bulk-delete-overlay').classList.remove('show'); }
$('#btn-bulk-delete-table').addEventListener('click', openBulkDeleteModal);
$('#btn-bulk-delete-cancel').addEventListener('click', closeBulkDeleteModal);
$('#bulk-delete-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-delete-overlay') closeBulkDeleteModal(); });
$('#btn-bulk-delete-row').addEventListener('click', addBulkDeleteRow);
$('#bulk-delete-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bd-remove-row')){
    const rows = $('#bulk-delete-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bulk-delete-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text) return;
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  if(lines.length<=1 && !lines[0].includes('\t')) return; // لصق قيمة واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  const tbody = $('#bulk-delete-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkDeleteRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('.bd-id');
    if(field) field.value = line.split('\t')[0].trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-delete-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-delete-table-body').querySelectorAll('tr')];
  const idsInBatch = [...new Set(rows.map(r=>r.querySelector('.bd-id').value.trim()).filter(Boolean))];
  if(!idsInBatch.length){ showToast('لم تُدخل أي رقم هوية'); return; }
  const matched = clients.filter(c=>idsInBatch.includes(c.clientId));
  const notFoundCount = idsInBatch.filter(id=>!clients.some(c=>c.clientId===id)).length;
  if(!matched.length){ showToast('لم يتم العثور على أي عميل بأرقام الهوية المدخلة'); return; }
  const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
  const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
  const notFoundMsg = notFoundCount ? `\n(تنبيه: ${notFoundCount} رقم هوية غير موجودين أصلاً بالنظام وسيتم تجاهلهم)` : '';
  if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق. تأكيد حذفهم دفعة واحدة؟ (${namesPreview}${extra})${notFoundMsg}\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف عملاء دفعة واحدة عبر جدول (${matched.length} عميل)`);
  const idsSet = new Set(matched.map(c=>c.id));
  const removedNames = matched.map(c=>c.name);
  clients = clients.filter(c=>!idsSet.has(c.id));
  idsSet.forEach(id=>{ removeClientLedgerEntries(id); selectedClientIds.delete(id); });
  await saveClients(); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${matched.length} عميل عبر جدول داخل البرنامج: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}${notFoundCount?` — تم تجاهل ${notFoundCount} رقم هوية غير موجود بالنظام`:''}`);
  closeBulkDeleteModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${matched.length} عميل${notFoundCount?`، وتجاهل ${notFoundCount} رقم غير موجود`:''}`);
});


/* ---------------- شيت فواتير الدورات (مطابقة الفواتير مع الإيصالات) ---------------- */
/* المبالغ المُدخلة (القيمة الفعلية بالإيصال / قيمة الدورة بالنظام) شاملة ضريبة القيمة المضافة أصلاً،
   لذلك تُستخرج الضريبة من داخل المبلغ (÷1.15) وليس تُضاف فوقه، اتساقاً مع باقي حسابات النظام */
function courseInvoiceVat(value){ const v = num(value); return v - (v/1.15); }
function courseInvoiceClients(){
  return clients.filter(c=> !c.suspended && String(c.invoice||'').trim());
}
function filteredCourseInvoices(){
  const q = ($('#ci-search')?.value || '').trim().toLowerCase();
  const dfrom = $('#ci-date-from')?.value || '';
  const dto = $('#ci-date-to')?.value || '';
  const diffFilter = $('#ci-filter-diff')?.value || '';
  let rows = courseInvoiceClients();
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.invoice].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  if(dfrom) rows = rows.filter(c=> c.receiptIssueDate && c.receiptIssueDate>=dfrom);
  if(dto) rows = rows.filter(c=> c.receiptIssueDate && c.receiptIssueDate<=dto);
  if(diffFilter==='empty'){
    rows = rows.filter(c=> !(num(c.receiptActualValue)>0));
  }else if(diffFilter==='match'){
    rows = rows.filter(c=> num(c.receiptActualValue)>0 && Math.abs(num(c.receiptActualValue) - centerIncome(c)) < 0.01);
  }else if(diffFilter==='diff'){
    rows = rows.filter(c=> num(c.receiptActualValue)>0 && Math.abs(num(c.receiptActualValue) - centerIncome(c)) >= 0.01);
  }
  rows.sort((a,b)=> (b.receiptIssueDate||b.date||'').localeCompare(a.receiptIssueDate||a.date||''));
  return rows;
}
let ciPageState = {page:1, sig:''};
function renderCourseInvoices(){
  const body = $('#ci-table-body');
  if(!body) return;
  const all = courseInvoiceClients().filter(matchInvoiceYear);
  const rows = filteredCourseInvoices().filter(matchInvoiceYear);
  if($('#ci-total-count')) $('#ci-total-count').textContent = all.length;
  if($('#ci-filtered-count')) $('#ci-filtered-count').textContent = rows.length;

  // البطاقات أعلى الشيت تُحتسب دائماً بناءً على الفلتر الحالي (rows) لا على كامل السجلات،
  // بحيث تتفاعل مباشرة مع البحث/التاريخ/فلتر المطابقة كلما تغيّر
  const withValue = rows.filter(c=> num(c.receiptActualValue) > 0);
  const totalActual = withValue.reduce((s,c)=> s+num(c.receiptActualValue), 0);
  const totalVat = withValue.reduce((s,c)=> s+courseInvoiceVat(c.receiptActualValue), 0);
  const totalSystem = withValue.reduce((s,c)=> s+centerIncome(c), 0);
  const totalDiff = totalActual - totalSystem;
  const mismatched = withValue.filter(c=> Math.abs(num(c.receiptActualValue) - centerIncome(c)) >= 0.01).length;

  if($('#ci-cards')) $('#ci-cards').innerHTML = `
    <div class="card"><div class="k">عدد فواتير الدورات (حسب الفلتر الحالي)</div><div class="v">${rows.length}</div></div>
    <div class="card"><div class="k">لم تُدخل قيمتها الفعلية بعد</div><div class="v red">${rows.length - withValue.length}</div></div>
    <div class="card"><div class="k">إجمالي القيمة الفعلية (بالإيصالات)</div><div class="v gold">${fmt(totalActual)}</div></div>
    <div class="card"><div class="k">إجمالي ضريبة القيمة المضافة</div><div class="v teal">${fmt(totalVat)}</div></div>
    <div class="card"><div class="k">إجمالي الفرق (فعلي − نظام)</div><div class="v ${Math.abs(totalDiff)>=0.01?'red':''}">${fmt(totalDiff)}</div></div>
    <div class="card"><div class="k">عدد الفواتير غير المطابقة</div><div class="v ${mismatched?'red':''}">${mismatched}</div></div>
  `;

  const ciPageRows = applyGenericPagination('ci', rows, ciPageState, [
    $('#ci-search')?.value, $('#ci-date-from')?.value, $('#ci-date-to')?.value, $('#ci-filter-diff')?.value
  ]);
  body.innerHTML = rows.length ? ciPageRows.map(c=>{
    const actual = num(c.receiptActualValue);
    const hasValue = actual>0;
    const vat = hasValue ? courseInvoiceVat(actual) : 0;
    const sys = centerIncome(c);
    const actualNoVat = hasValue ? (actual - vat) : null;
    const diff = hasValue ? (actual - sys) : null;
    const diffLabel = diff===null ? '—' : fmt(diff);
    const diffColor = diff===null ? '' : (Math.abs(diff)<0.01 ? 'teal' : 'red');
    return `
    <tr>
      <td>${escapeHtml(c.name||'')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${escapeHtml(c.courseType||'')}</td>
      <td class="mono">${escapeHtml(c.invoice||'—')}</td>
      <td><input type="date" class="mono" data-ci-date="${c.id}" value="${c.receiptIssueDate||''}" style="min-width:140px;"></td>
      <td><input type="number" step="0.01" class="mono" data-ci-value="${c.id}" value="${c.receiptActualValue!==undefined && c.receiptActualValue!==null && c.receiptActualValue!=='' ? c.receiptActualValue : ''}" placeholder="القيمة من الإيصال" style="min-width:130px;"></td>
      <td class="mono">${hasValue ? fmt(vat) : '—'}</td>
      <td class="mono">${fmt(sys)}</td>
      <td class="mono">${actualNoVat===null ? '—' : fmt(actualNoVat)}</td>
      <td class="mono ${diffColor}">${diffLabel}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير دورات مطابقة — تأكد من إدخال "رقم الفاتورة" لكل عميل في شيت العملاء أولاً</td></tr>`;
}
onSearchInput('#ci-search', renderCourseInvoices);
bindGenericPagination('ci', ciPageState, renderCourseInvoices);
$('#ci-date-from')?.addEventListener('input', renderCourseInvoices);
$('#ci-date-to')?.addEventListener('input', renderCourseInvoices);
$('#ci-filter-diff')?.addEventListener('change', renderCourseInvoices);
$('#btn-refresh-course-invoices')?.addEventListener('click', ()=>{ renderCourseInvoices(); showToast('تم تحديث شيت فواتير الدورات'); });
$('#ci-table-body')?.addEventListener('change', async e=>{
  const dateId = e.target.dataset.ciDate;
  const valId = e.target.dataset.ciValue;
  if(dateId){
    const c = clients.find(x=>x.id===dateId);
    if(c){
      snapshotState(`تعديل تاريخ صدور فاتورة الدورة: ${c.name}`);
      c.receiptIssueDate = e.target.value || '';
      await saveClients();
      await logAudit('edit','فواتير الدورات', `تم تعديل تاريخ صدور فاتورة الدورة للعميل: ${c.name} (${c.invoice||''})`);
      renderCourseInvoices();
    }
  }
  if(valId){
    const c = clients.find(x=>x.id===valId);
    if(c){
      snapshotState(`تعديل القيمة الفعلية لفاتورة الدورة: ${c.name}`);
      c.receiptActualValue = e.target.value===''? '' : num(e.target.value);
      await saveClients();
      await logAudit('edit','فواتير الدورات', `تم تعديل القيمة الفعلية (من الإيصال) لفاتورة الدورة للعميل: ${c.name} (${c.invoice||''})`);
      renderCourseInvoices();
    }
  }
});
function courseInvoiceExportRow(c){
  const actual = num(c.receiptActualValue);
  const hasValue = actual>0;
  const vat = hasValue ? courseInvoiceVat(actual) : 0;
  const sys = centerIncome(c);
  const actualNoVat = hasValue ? (actual - vat) : '';
  return {
    'اسم العميل': c.name||'',
    'رقم الهوية': c.clientId||'',
    'الدورة': c.courseType||'',
    'رقم الفاتورة': c.invoice||'',
    'تاريخ صدور الفاتورة': c.receiptIssueDate||'',
    'القيمة الفعلية بالإيصال': hasValue ? actual : '',
    'ضريبة القيمة المضافة (15%)': hasValue ? Math.round(vat*100)/100 : '',
    'قيمة الدورة بالنظام': sys,
    'القيمة بدون الضريبة': hasValue ? Math.round(actualNoVat*100)/100 : '',
    'الفرق': hasValue ? Math.round((actual-sys)*100)/100 : ''
  };
}
$('#btn-export-course-invoices')?.addEventListener('click', ()=>{
  downloadXlsx('فواتير_الدورات.xlsx', 'فواتير الدورات', filteredCourseInvoices().map(courseInvoiceExportRow));
});
$('#btn-template-ci-import')?.addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_فواتير_الدورات.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم الدورة':'CRS-1001', 'رقم الفاتورة':'INV-2001', 'التاريخ':'2026-02-01', 'القيمة الفعلية للايصال':1000}
  ]);
});
$('#btn-import-ci')?.addEventListener('click', ()=> $('#ci-import-input').click());
$('#ci-import-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد فواتير الدورات من Excel');
    let updated=0, skipped=0, invoiceChanged=0;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const courseNumber = String(row['رقم الدورة']||'').trim();
      const invoiceNo = String(row['رقم الفاتورة']||'').trim();
      const rawDate = row['التاريخ'];
      const rawValue = row['القيمة الفعلية للايصال'];
      if(!clientId || (!courseNumber && !invoiceNo && !rawDate && rawValue==='')){ skipped++; continue; }
      // البحث أولاً بمطابقة رقم الهوية + رقم الدورة معاً (لتحديد التسجيل الصحيح عند تعدد دورات نفس العميل)،
      // وإن لم يوجد رقم دورة في الملف أو لم تُطابق، نكتفي بمطابقة رقم الهوية وحده
      let c = null;
      if(courseNumber) c = clients.find(x=>x.clientId===clientId && String(x.courseNumber||'').trim()===courseNumber);
      if(!c) c = clients.find(x=>x.clientId===clientId);
      if(!c){ skipped++; continue; }
      const oldInvoice = c.invoice||'';
      const oldDate = c.receiptIssueDate||'';
      const oldValue = c.receiptActualValue||'';
      // رقم الفاتورة (رقم الإيصال) فقط هو ما يُرحَّل ويُربط مع باقي شيتات النظام — أما التاريخ والقيمة الفعلية
      // فيبقى تحديثهما محصوراً داخل شيت فواتير الدورات نفسه فقط
      if(invoiceNo){
        c.invoice = invoiceNo;
        if(invoiceNo!==oldInvoice) invoiceChanged++;
      }
      const newDate = normalizeExcelDate(rawDate);
      if(newDate) c.receiptIssueDate = newDate;
      if(rawValue!==''){ c.receiptActualValue = num(rawValue); }
      updated++;
      changedRows.push({
        'رقم الهوية':clientId, 'الاسم':c.name, 'رقم الدورة':c.courseNumber||'',
        'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'',
        'تاريخ الفاتورة (قديم)':oldDate, 'تاريخ الفاتورة (جديد)':c.receiptIssueDate||'',
        'القيمة الفعلية (قديمة)':oldValue, 'القيمة الفعلية (جديدة)':c.receiptActualValue||''
      });
    }
    await saveClients();
    await logAudit('edit','فواتير الدورات', `استيراد فواتير الدورات من Excel: تحديث ${updated} سجل${skipped?`، وتخطي ${skipped} صف بدون تطابق`:''}${invoiceChanged?` (تم ترحيل ${invoiceChanged} رقم فاتورة تلقائياً إلى شيت العملاء وربطها بجميع الشيتات)`:''}`);
    if(invoiceChanged && typeof refreshEverything==='function'){
      // رقم الفاتورة تغيّر فعلياً لسجل واحد أو أكثر → يُحدَّث النظام بالكامل (شيت العملاء، لوحة التحكم، الدورات، التقارير...)
      refreshEverything();
    }else{
      // لا يوجد تغيير في أرقام الفواتير (تحديث تاريخ/قيمة فعلية فقط) → يبقى التحديث محصوراً في شيت فواتير الدورات فقط
      renderCourseInvoices();
    }
    // تقرير بالبيانات التي تم تحديثها فعلياً
    downloadXlsx(`تقرير_استيراد_فواتير_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
    showToast(`تم تحديث ${updated} سجل${skipped?`، ${skipped} تم تخطيه`:''}${invoiceChanged?` — ورُبط ${invoiceChanged} رقم فاتورة بجميع الشيتات`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة "رقم الهوية"، "رقم الدورة"، "رقم الفاتورة"، "التاريخ"، "القيمة الفعلية للايصال"');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- رفع فواتير حقيقية (PDF/صور) وقراءتها تلقائياً بالذكاء الاصطناعي ----------------
   يرسل الملفات للخادم (الذي يناديها على Claude API بمفتاحه الخاص المحفوظ على الخادم فقط)،
   ثم يعبّئ النتائج المستخرجة داخل نفس جدول المراجعة المستخدم في "تحديث/استيراد فواتير الدورات (جدول)"
   بدل حفظها مباشرة — بحيث تبقى كل النتائج قابلة للمراجعة والتعديل اليدوي قبل أي حفظ فعلي. */
function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(String(r.result).split(',')[1] || '');
    r.onerror = ()=> reject(new Error('تعذّرت قراءة الملف'));
    r.readAsDataURL(file);
  });
}
$('#btn-ci-ai-upload')?.addEventListener('click', ()=> $('#ci-ai-upload-input').click());
$('#ci-ai-upload-input')?.addEventListener('change', async e=>{
  const files = [...(e.target.files||[])];
  if(!files.length) return;
  if(files.length>30){ showToast('الحد الأقصى 30 ملفاً في المرة الواحدة'); e.target.value=''; return; }
  const btn = $('#btn-ci-ai-upload');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = `⏳ جارِ قراءة ${files.length} ملف...`;
  try{
    const payloadFiles = await Promise.all(files.map(async f=>({
      name: f.name,
      mimeType: f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : ''),
      dataBase64: await fileToBase64(f)
    })));
    const res = await serverFetch('/api/ai/read-invoices', {
      method: 'POST',
      body: JSON.stringify({ files: payloadFiles })
    });
    if(!res.ok){
      const errData = await res.json().catch(()=>({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const results = data.results || [];
    const failed = results.filter(r=>r.error);
    const ok = results.filter(r=>!r.error);
    // تعبئة جدول المراجعة (تحديث/استيراد فواتير الدورات دفعة واحدة) بالنتائج المستخرجة
    $('#ci-bulk-table-body').innerHTML = '';
    if(!ok.length){
      addCiBulkRow();
    } else {
      ok.forEach(r=>{
        ciBulkRowSeq++;
        $('#ci-bulk-table-body').insertAdjacentHTML('beforeend', ciBulkRowHtml(ciBulkRowSeq));
        const row = $('#ci-bulk-table-body').lastElementChild;
        row.querySelector('.cib-id').value = r.nationalId || '';
        row.querySelector('.cib-invoice').value = r.invoiceNo || '';
        row.querySelector('.cib-date').value = r.date || '';
        row.querySelector('.cib-value').value = r.actualValue!=null ? r.actualValue : '';
        if(!r.nationalId){
          row.style.background = 'rgba(220,50,50,0.08)';
          row.title = `تعذّر استخراج رقم الهوية من الملف "${r.fileName}" — أدخله يدوياً`;
        } else if(r.confidence==='low'){
          row.style.background = 'rgba(230,180,30,0.10)';
          row.title = `ثقة منخفضة في دقة القراءة من الملف "${r.fileName}" — راجع القيم قبل الحفظ`;
        }
      });
    }
    $('#ci-bulk-overlay').classList.add('show'); SoundFX.open();
    const msgParts = [`تمت قراءة ${ok.length} من ${results.length} ملف`];
    if(failed.length) msgParts.push(`تعذّرت قراءة ${failed.length}: ${failed.map(f=>f.fileName).join('، ')}`);
    showToast(msgParts.join(' — ') + ' — راجع الجدول وعدّل ما يلزم قبل "حفظ الكل"');
  }catch(err){
    showToast('تعذّر رفع/قراءة الفواتير: ' + (err.message || 'خطأ غير معروف'));
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
    e.target.value = '';
  }
});

/* ---------------- Tax Invoice (PDF via print) ---------------- */
function formatInvoiceNo(n){ return 'INV-' + String(n).padStart(6,'0'); }
async function assignInvoiceNumber(client){
  if(client.taxInvoiceNo) return client.taxInvoiceNo;
  const n = settings.nextInvoiceNo || 1;
  client.taxInvoiceNo = n;
  client.taxInvoiceDate = client.taxInvoiceDate || todayISO();
  settings.nextInvoiceNo = n + 1;
  const idx = clients.findIndex(c=>c.id===client.id);
  if(idx>-1) clients[idx] = client;
  await saveClients();
  await saveSettings();
  return n;
}
// حذف منطقي لفاتورة عميل (Soft Delete): لا يُعاد استخدام الرقم التسلسلي أبداً — الرقم يبقى محجوزاً ومحفوظاً في سجل الفواتير المحذوفة مع السبب،
// وعند طباعة فاتورة جديدة لاحقاً لنفس العميل سيُمنح رقماً تسلسلياً جديداً من settings.nextInvoiceNo (بدون أي قفزة للخلف أو إعادة تدوير).
function softDeleteClientInvoice(clientId, reason){
  const c = clients.find(x=>x.id===clientId);
  if(!c || !c.taxInvoiceNo) return null;
  const removed = {
    id: uid(),
    clientId: c.id,
    clientName: c.name,
    invoiceNo: c.taxInvoiceNo,
    invoiceNoLabel: formatInvoiceNo(c.taxInvoiceNo),
    invoiceDate: c.taxInvoiceDate || '',
    deletedAt: Date.now(),
    deletedBy: currentUser || 'غير معروف',
    deletedReason: reason || ''
  };
  deletedInvoices.push(removed);
  c.taxInvoiceNo = null;
  c.taxInvoiceDate = null;
  const idx = clients.findIndex(x=>x.id===c.id);
  if(idx>-1) clients[idx] = c;
  return removed;
}
/* ================= ZATCA — رمز الاستجابة السريعة (QR) لفاتورة ضريبية مبسّطة — المرحلة الأولى ================
   يبني الحقول الخمسة المطلوبة (اسم البائع، الرقم الضريبي، الطابع الزمني، الإجمالي شامل الضريبة، قيمة الضريبة)
   بترميز TLV (Tag-Length-Value) ثم Base64، وفق ما تتطلبه هيئة الزكاة والضريبة والجمارك لفواتير المرحلة الأولى
   (توليد وعرض فقط — لا يشمل هذا الربط المرحلة الثانية "فاتورة" التي تتطلب توقيعاً رقمياً وخادماً خلفياً). */
function zatcaTlvField(tag, value){
  const bytes = new TextEncoder().encode(String(value||''));
  const out = new Uint8Array(2 + bytes.length);
  out[0] = tag;
  out[1] = bytes.length;
  out.set(bytes, 2);
  return out;
}
function zatcaBuildQrBase64({sellerName, vatNumber, timestampISO, total, vatAmount}){
  const fields = [
    zatcaTlvField(1, sellerName),
    zatcaTlvField(2, vatNumber),
    zatcaTlvField(3, timestampISO),
    zatcaTlvField(4, num(total).toFixed(2)),
    zatcaTlvField(5, num(vatAmount).toFixed(2)),
  ];
  const totalLen = fields.reduce((s,f)=>s+f.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  fields.forEach(f=>{ merged.set(f, offset); offset += f.length; });
  let binary = '';
  merged.forEach(b=> binary += String.fromCharCode(b));
  return btoa(binary);
}
/* يُعيد <img> جاهزة برمز QR، أو نصاً بديلاً بصمت إن تعذّر تحميل مكتبة الترميز (لا اتصال بالإنترنت مثلاً) */
function zatcaQrImgTag(qrPayloadBase64){
  try{
    if(typeof QRious === 'undefined') return '';
    const canvas = document.createElement('canvas');
    new QRious({element: canvas, value: qrPayloadBase64, size: 220, level:'M'});
    return `<div class="zatca-qr"><img src="${canvas.toDataURL('image/png')}"><span>رمز الفاتورة الضريبية (QR)</span></div>`;
  }catch(e){ return ''; }
}
/* يبني حمولة QR كاملة لفاتورة عميل (فاتورة الدورة) */
function zatcaInvoiceQrTag(ci, totalInclVat, vat, issueDate){
  const iso = (()=>{ try{ return new Date(issueDate || Date.now()).toISOString(); }catch(e){ return new Date().toISOString(); } })();
  const payload = zatcaBuildQrBase64({
    sellerName: ci.name, vatNumber: ci.taxNumber, timestampISO: iso,
    total: totalInclVat, vatAmount: vat
  });
  return zatcaQrImgTag(payload);
}

/* ================= إرسال فعلي لهيئة الزكاة والضريبة (فاتورة) — المرحلة الثانية =================
   يُستدعى تلقائياً عند طباعة كل فاتورة/مردود. يفشل بصمت تماماً إن لم يكن الربط
   مفعّلاً بعد (Onboarding) حتى لا يعطّل الطباعة العادية قبل جهوزية الشهادة —
   بمجرد توفر الشهادة سيبدأ العمل تلقائياً بدون أي تعديل إضافي هنا. */
async function zatcaSubmit(path, body){
  try{
    const res = await serverFetch(path, { method:'POST', body: JSON.stringify(body) });
    if(!res.ok) return null;
    return await res.json();
  }catch(e){ return null; }
}
function zatcaLineItem(nameLabel, taxExclusivePrice){
  return { id:'1', name: nameLabel, quantity:1, tax_exclusive_price: Math.max(0, taxExclusivePrice), VAT_percent: 0.15 };
}
/* شارة صغيرة تُدرَج أسفل الفاتورة المطبوعة توضّح حالة الإرسال للهيئة — لا تظهر إطلاقاً
   إن لم تتم أي محاولة إرسال بعد (قبل جهوزية الشهادة)، حتى لا نربك المستخدم بشيء غير مفعّل. */
function zatcaStatusBadge(result){
  if(!result) return '';
  const map = {
    reported: ['✅ أُرسلت إلى هيئة الزكاة والضريبة (فاتورة) بنجاح', '#1a7f37'],
    compliance_check: ['🧪 فحص توافق تجريبي مع الهيئة (وضع الإعداد الأولي)', '#9a6700'],
    warning: ['⚠️ أُرسلت للهيئة مع ملاحظات — راجع سجل الفواتير', '#9a6700'],
    error: ['❌ تعذّر إرسال الفاتورة للهيئة — راجع سجل الفواتير', '#cf222e'],
    not_supported_yet: ['ℹ️ الفواتير الضريبية القياسية (B2B) لعملاء الشركات غير مفعّلة بعد في الربط الإلكتروني', '#57606a'],
  };
  const info = map[result.status];
  if(!info) return '';
  return `<div style="margin-top:8px; font-size:11.5px; color:${info[1]};">${info[0]}</div>`;
}

async function printInvoice(id){
  const c = clients.find(x=>x.id===id);
  if(!c){ showToast('تعذر إيجاد بيانات العميل'); return; }
  const invNo = await assignInvoiceNumber(c);
  const invNoLabel = formatInvoiceNo(invNo);
  await logAudit('edit','العملاء', `تمت طباعة فاتورة رقم ${invNoLabel} للعميل: ${c.name}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const income = centerIncome(c);
  const bag = bagAmount(c);
  const paid = paidTotal(c);
  const rem = remaining(c);
  // قيمة الحقيبة تظهر في الفاتورة فقط إذا كانت قد حُصِّلت بالكامل مع قيمة الدورة معاً
  // (أي أن إجمالي المبلغ المدفوع يغطي قيمة الدورة + قيمة الحقيبة كاملتين). إن لم تُحصَّل معاً، لا تظهر.
  const bagShown = bag>0 && paid >= (income + bag);
  // المبالغ المدخلة في النظام (سعر الدورة/الحقيبة) شاملة ضريبة القيمة المضافة أصلاً
  // لذلك يتم استخراج الضريبة من الإجمالي (فك التضمين) وليس إضافتها فوقه لتجنب احتساب 30%
  const totalInclVat = income + (bagShown ? bag : 0);
  const vat = totalInclVat - (totalInclVat / 1.15);
  const grand = totalInclVat - vat; // القيمة الفعلية بدون الضريبة
  const today = new Date().toLocaleDateString('ar-SA');

  const zatcaResult = await zatcaSubmit('/api/zatca/invoice', {
    environment: 'sandbox',
    clientType: c.clientType==='company' ? 'company' : 'individual',
    sourceRef: String(c.id),
    lineItems: [ zatcaLineItem(`رسوم الدورة التدريبية${c.courseType ? ' — '+c.courseType : ''}${bagShown ? ' + الحقيبة التدريبية' : ''}`, grand) ],
    issueDate: (typeof todayISO==='function' ? todayISO() : new Date().toISOString().slice(0,10)),
    issueTime: new Date().toTimeString().slice(0,8),
  });

  const rowsHtml = `
    <tr><td>رسوم الدورة التدريبية${c.courseType ? ' — '+escapeHtml(c.courseType) : ''}</td><td class="num">${fmt(num(c.coursePrice))}</td></tr>
    ${num(c.discount)>0 ? `<tr><td>الخصم</td><td class="num">-${fmt(num(c.discount))}</td></tr>` : ''}
    ${bagShown ? `<tr><td>قيمة الحقيبة التدريبية</td><td class="num">${fmt(bag)}</td></tr>` : ''}
  `;

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('فاتورة ' + invNoLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      ${zatcaResult && zatcaResult.qr ? zatcaQrImgTag(zatcaResult.qr) : zatcaInvoiceQrTag(ci, totalInclVat, vat, c.taxInvoiceDate || today)}
      <div class="inv-title">
        <h2>فاتورة ضريبية</h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الإصدار: ${escapeHtml(c.taxInvoiceDate || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل</h4>
        <div class="info-row"><span>الاسم:</span><b>${escapeHtml(c.name)}</b></div>
        <div class="info-row"><span>رقم الهوية / الإقامة:</span><b>${escapeHtml(c.clientId||'—')}</b></div>
        <div class="info-row"><span>رقم الجوال:</span><b>${escapeHtml(c.phone||'—')}</b></div>
        <div class="info-row"><span>الجنسية:</span><b>${escapeHtml(c.nationality||'—')}</b></div>
        ${c.clientType==='company' && c.companyName ? `<div class="info-row"><span>اسم الشركة:</span><b>${escapeHtml(c.companyName)}</b></div>` : ''}
        ${(()=>{ if(c.clientType!=='company'||!c.companyName) return ''; const comp = companies.find(x=>x.name===c.companyName); return (comp && comp.taxNumber) ? `<div class="info-row"><span>الرقم الضريبي للشركة:</span><b>${escapeHtml(comp.taxNumber)}</b></div>` : ''; })()}
        ${c.clientType==='company' && num(c.creditDays)>0 ? `<div class="info-row"><span>الأجل:</span><b>${num(c.creditDays)} يوم</b></div>` : ''}
        ${c.clientTaxNumber ? `<div class="info-row"><span>الرقم الضريبي للعميل:</span><b>${escapeHtml(c.clientTaxNumber)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات الدورة</h4>
        <div class="info-row"><span>نوع الدورة:</span><b>${escapeHtml(c.courseType||'—')}</b></div>
        <div class="info-row"><span>رقم الدورة:</span><b>${escapeHtml(c.courseNumber||'—')}</b></div>
        <div class="info-row"><span>تاريخ التسجيل:</span><b>${escapeHtml(formatDateDisplay(c.date)||'—')}</b></div>
        <div class="info-row"><span>تاريخ الدورة الفعلي:</span><b>${escapeHtml(actualCourseDateOf(c)||'—')}</b></div>
        <div class="info-row"><span>رقم فاتورة النظام:</span><b>${escapeHtml(c.invoice||'—')}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(paymentChannelsLabel(c))}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>البيان</th><th style="text-align:left;">المبلغ (ر.س)</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="totals">
      <div class="r"><span>القيمة الفعلية (بدون ضريبة القيمة المضافة)</span><b class="mono">${fmt(grand)}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15% مضمنة ضمن الإجمالي)</span><b class="mono">${fmt(vat)}</b></div>
      <div class="r grand"><span>الإجمالي (شامل الضريبة)</span><b>${fmt(grand+vat)}</b></div>
      <div class="r"><span>المبلغ المدفوع</span><b class="mono">${fmt(paid)}</b></div>
      <div class="r"><span>المتبقي</span><b class="mono">${fmt(rem)}</b></div>
    </div>
    <div style="margin:14px 0 22px; padding:12px 14px; border:1px solid #DDE3EA; border-radius:8px; background:#F7F9FB; font-size:12.5px; text-align:center;">
      <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(grand+vat))}
    </div>
    ${zatcaStatusBadge(zatcaResult)}

    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
  renderTable();
}

/* ---------------- Return Invoice (مردودات المبيعات) ---------------- */
function formatReturnInvoiceNo(n){ return 'RET-' + String(n).padStart(6,'0'); }
async function printReturnInvoice(id){
  const tx = vaultTx.find(x=>x.id===id);
  if(!tx || !tx.isReturn){ showToast('تعذر إيجاد بيانات المردود'); return; }
  if(!tx.returnInvoiceNo){
    tx.returnInvoiceNo = settings.nextReturnInvoiceNo || 1;
    settings.nextReturnInvoiceNo = tx.returnInvoiceNo + 1;
    await saveVaultTx();
    await saveSettings();
  }
  const invNoLabel = formatReturnInvoiceNo(tx.returnInvoiceNo);
  const client = clients.find(c=>c.clientId===tx.clientId);
  await logAudit('edit','الحركات المالية', `تمت طباعة فاتورة استرجاع رقم ${invNoLabel} للعميل: ${tx.clientName||tx.clientId||'—'}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const returnAmountExclVat = num(tx.amount) - (num(tx.amount)/1.15);

  const zatcaResult = await zatcaSubmit('/api/zatca/return', {
    environment: 'sandbox',
    clientType: client?.clientType==='company' ? 'company' : 'individual',
    sourceRef: String(tx.id),
    lineItems: [ zatcaLineItem('مردود مبيعات', returnAmountExclVat) ],
    issueDate: tx.date || (typeof todayISO==='function' ? todayISO() : new Date().toISOString().slice(0,10)),
    issueTime: new Date().toTimeString().slice(0,8),
    canceledInvoiceNumber: client?.taxInvoiceNo ? formatInvoiceNo(client.taxInvoiceNo) : '',
    reason: tx.notes || 'مردود مبيعات',
  });

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('فاتورة استرجاع ' + invNoLabel, {accent: PRINT_PALETTE.red})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      ${zatcaResult && zatcaResult.qr ? zatcaQrImgTag(zatcaResult.qr) : zatcaInvoiceQrTag(ci, num(tx.amount), num(tx.amount) - returnAmountExclVat, tx.date || today)}
      <div class="inv-title">
        <h2>فاتورة استرجاع مبلغ</h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الاسترجاع: ${escapeHtml(tx.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل</h4>
        <div class="info-row"><span>الاسم:</span><b>${escapeHtml(tx.clientName || client?.name || '—')}</b></div>
        <div class="info-row"><span>رقم الهوية / الإقامة:</span><b>${escapeHtml(tx.clientId || '—')}</b></div>
        ${client?.phone ? `<div class="info-row"><span>رقم الجوال:</span><b>${escapeHtml(client.phone)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات المردود</h4>
        <div class="info-row"><span>حساب الصرف:</span><b>${escapeHtml(destLabel(tx.destination||'vault'))}</b></div>
        <div class="info-row"><span>طريقة الاسترجاع:</span><b>${escapeHtml(tx.method || '—')}</b></div>
        <div class="info-row"><span>ملاحظات:</span><b>${escapeHtml(tx.notes || '—')}</b></div>
      </div>
    </div>

    <div class="amount-box">
      <div class="lbl">المبلغ المسترجع للعميل</div>
      <div class="amt">${fmt(num(tx.amount))} ﷼</div>
      <div style="font-size:12.5px; color:#66707E; margin-top:10px; border-top:1px dashed #E9CFC9; padding-top:8px;">
        <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(tx.amount))}
      </div>
    </div>

    <p style="font-size:13px; text-align:center; margin-bottom:0;">
      أقرّ أنا الموقّع أدناه باستلامي المبلغ الموضح أعلاه كمردود مبيعات، وذلك بحضوري الشخصي.
    </p>

    <div class="sig-grid">
      <div class="sig-box">
        <div class="sig-line">توقيع العميل (${escapeHtml(tx.clientName || client?.name || '—')})</div>
      </div>
      <div class="sig-box">
        <div class="sig-line">توقيع المركز / المستلم للتوقيع</div>
      </div>
    </div>

    <div class="footer-note">
      هذه الفاتورة صادرة إلكترونياً من نظام إدارة ${escapeHtml(ci.name)} — رقم الفاتورة تسلسلي ولا يتم التلاعب به، وهذا المردود خاص بهذا العميل فقط.
    </div>
    ${zatcaStatusBadge(zatcaResult)}
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
  renderVault();
}

/* ---------------- Expense Voucher (سند صرف) ---------------- */
function formatVoucherNo(n){ return 'PV-' + String(n).padStart(6,'0'); }
async function printExpenseVoucher(id){
  const tx = vaultTx.find(x=>x.id===id);
  if(!tx || tx.type!=='out'){ showToast('تعذر إيجاد بيانات الحركة'); return; }
  if(!tx.voucherNo){
    tx.voucherNo = settings.nextVoucherNo || 1;
    settings.nextVoucherNo = tx.voucherNo + 1;
    await saveVaultTx();
    await saveSettings();
  }
  const voucherLabel = formatVoucherNo(tx.voucherNo);
  await logAudit('edit','الحركات المالية', `تمت طباعة سند صرف رقم ${voucherLabel} بمبلغ ${fmt(num(tx.amount))}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('سند صرف ' + voucherLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy, amountColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      <div class="inv-title">
        <h2>سند صرف</h2>
        <div class="no">${voucherLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">التاريخ: ${escapeHtml(tx.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيان الصرف</h4>
        <div class="info-row"><span>التصنيف:</span><b>${escapeHtml(tx.category || '—')}</b></div>
        <div class="info-row"><span>الحساب:</span><b>${escapeHtml(destLabel(tx.destination||'vault'))}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(tx.method || '—')}</b></div>
      </div>
      <div class="info-box">
        <h4>بيانات المستلم</h4>
        <div class="info-row"><span>اسم مستلم المبلغ:</span><b>${escapeHtml(tx.recipientName || '—')}</b></div>
        <div class="info-row"><span>ملاحظات:</span><b>${escapeHtml(tx.notes || '—')}</b></div>
      </div>
    </div>

    <div class="amount-box">
      <div class="lbl">المبلغ المصروف</div>
      <div class="amt">${fmt(num(tx.amount))} ﷼</div>
      <div style="font-size:12.5px; color:#66707E; margin-top:10px; border-top:1px dashed #DDE3EA; padding-top:8px;">
        <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(tx.amount))}
      </div>
    </div>

    <div class="sig-grid">
      <div class="sig-box">
        <div class="sig-line">توقيع المحاسب</div>
      </div>
      <div class="sig-box">
        <div class="sig-line">توقيع مستلم المبلغ (${escapeHtml(tx.recipientName || '—')})</div>
      </div>
    </div>

    <div class="footer-note">
      هذا السند صادر إلكترونياً من نظام إدارة ${escapeHtml(ci.name)} — رقم السند تسلسلي ولا يتم التلاعب به.
    </div>
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
  renderVault();
}

/* ---------------- Export ---------------- */
$('#btn-export').addEventListener('click', ()=>{
  const headers = ['رقم الهوية','الاسم','رقم المرجع','الجوال','الجنسية','نوع العميل','اسم الشركة','الأجل (أيام)','الرقم الضريبي للعميل','نوع الدورة','رقم الفاتورة','رقم الفاتورة الضريبية','مصدر الحقيبة','حالة الحقيبة','رقم فاتورة الحقيبة','التاريخ','سعر الدورة','دخل المركز','قيمة الحقيبة','الخصم','الإجمالي','إجمالي المدفوع (شامل كل الدفعات)','المتبقي','طريقة الدفع الأولى','مبلغ الدفعة الأولى','طريقة الدفع الثانية','مبلغ الدفعة الثانية','رقم فاتورة الشبكة','الحالة','ملاحظات'];
  const rows = filteredClients().map(c=>[c.clientId,c.name,c.referNum,c.phone,c.nationality,c.clientType==='company'?'عميل شركات':'عميل مركز',c.companyName||'',c.clientType==='company'?(num(c.creditDays)||''):'',c.clientTaxNumber||'',c.courseType,c.invoice,c.taxInvoiceNo?formatInvoiceNo(c.taxInvoiceNo):'',bagSourceLabel(c),c.bagStatus||'',c.bagInvoice,c.date,c.coursePrice,centerIncome(c),bagAmount(c),c.discount,total(c),paidTotal(c),remaining(c),c.channel,num(c.paid),c.channel2||'',num(c.paid2),c.networkInvoice||'',c.stage,c.notes]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_المركز.csv';
  a.click();
});

/* ---------------- Settings ---------------- */
function renderSettings(){
  $('#set-center-name').value = settings.centerInfo?.name || '';
  $('#set-center-tax').value = settings.centerInfo?.taxNumber || '';
  $('#set-center-phone').value = settings.centerInfo?.phone || '';
  renderBagFinanceLinkToggle();
  $('#set-pa-webhook-url').value = settings.powerAutomate?.webhookUrl || '';
  $('#set-pa-notify-newclient').checked = settings.powerAutomate?.notifyNewClient !== false;
  $('#set-pa-notify-coursenum').checked = settings.powerAutomate?.notifyCourseNumber !== false;
  $('#next-invoice-no').textContent = formatInvoiceNo(settings.nextInvoiceNo || 1);
  $('#set-price-saudi').value = settings.priceSaudi;
  $('#set-price-nonsaudi').value = settings.priceNonSaudi;
  $('#courses-list').innerHTML = settings.courses.map((c,i)=>`
    <div class="tag" style="border-radius:8px; justify-content:space-between; width:100%; margin-bottom:6px;">
      <span>${escapeHtml(c.name)} — <span class="mono">${fmt(c.price)}</span> ﷼</span>
      <button data-rc="${i}">✕</button>
    </div>`).join('');
  $('#nat-list').innerHTML = settings.nationalities.map((n,i)=>`<div class="tag">${escapeHtml(n)}<button data-rn="${i}">✕</button></div>`).join('');
  $('#channel-list').innerHTML = settings.channels.map((c,i)=>`<div class="tag">${escapeHtml(c.name)} <span class="mono" style="color:var(--text-muted); font-size:11px;">(${destLabel(c.dest)})</span><button data-rh="${i}">✕</button></div>`).join('');
  $('#expcat-list').innerHTML = settings.expenseCategories.map((n,i)=>`<div class="tag">${escapeHtml(n)}<button data-re="${i}">✕</button></div>`).join('');
  $('#set-autobackup-enabled').checked = !!settings.autoBackupEnabled;
  $('#set-autobackup-days').value = settings.autoBackupIntervalDays || 7;
  if($('#set-low-balance')) $('#set-low-balance').value = settings.lowBalanceThreshold ?? 5000;
  if($('#set-bag-overdue-days')) $('#set-bag-overdue-days').value = settings.bagOverdueDays ?? 14;
  if($('#set-monthly-wa-number')) $('#set-monthly-wa-number').value = settings.monthlyReportWhatsapp || '';
  if($('#wa3-numbers')) $('#wa3-numbers').value = settings.monthlyPdfReportsWhatsappNumbers || '';
  if($('#vat-wa-numbers')) $('#vat-wa-numbers').value = settings.vatPdfReportWhatsappNumbers || '';
  $('#last-autobackup-hint').textContent = settings.lastAutoBackupAt
    ? `آخر نسخة احتياطية تلقائية: ${new Date(settings.lastAutoBackupAt).toLocaleString('ar-SA')}`
    : 'لم يتم إنشاء أي نسخة احتياطية تلقائية بعد.';
  renderUsersList();
}
const SERVER_ROLE_LABELS = { admin:'مدير', accountant:'محاسب', reception:'استقبال', staff:'موظف عام' };
async function renderUsersList(){
  const el = $('#users-list');
  if(!el) return;
  el.innerHTML = `<div class="hint">جارٍ تحميل المستخدمين من الخادم...</div>`;
  try{
    const res = await fetch(API_BASE + '/api/users', { headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر جلب المستخدمين');
    el.innerHTML = (data.users||[]).map(u=>`
      <div class="tag" style="border-radius:8px; justify-content:space-between; width:100%; margin-bottom:6px;">
        <span>👤 ${escapeHtml(u.display_name||u.username)} (${escapeHtml(u.username)})${u.username===currentUser ? ' — أنت' : ''}
          <span class="mono" style="font-size:10.5px; color:${u.role==='admin'?'var(--gold-dark)':'var(--text-muted)'}; margin-right:6px;">${SERVER_ROLE_LABELS[u.role]||u.role}</span>
        </span>
        <button data-ru="${escapeHtml(u.username)}" ${u.username===currentUser ? 'disabled title="لا يمكنك حذف حسابك الحالي"' : ''}>✕</button>
      </div>`).join('') || `<div class="hint">لا يوجد مستخدمون بعد</div>`;
  }catch(e){
    el.innerHTML = `<div class="hint" style="color:var(--red);">تعذّر تحميل قائمة المستخدمين: ${escapeHtml(e.message||'')}</div>`;
  }
}
/* ---------------- تحديث البرنامج (نسخة سطح المكتب فقط) ---------------- */
/* ---------------- إعادة ضبط البرنامج بالكامل (حذف كل البيانات) ---------------- */
$('#btn-reset-app').addEventListener('click', async ()=>{
  const firstConfirm = await customConfirm('تحذير: سيتم حذف جميع بيانات البرنامج نهائياً في كل الشيتات (العملاء، الدورات، الحقائب، الحركات المالية، الشركات، الإعدادات، المستخدمين، وسجل المراجعة) ولن يمكن التراجع عن ذلك.\n\nهل أنت متأكد أنك تريد المتابعة؟');
  if(!firstConfirm) return;
  const secondConfirm = await customConfirm('تأكيد أخير: سيتم الحذف فوراً بمجرد الضغط على "موافق" ولن تتمكن من التراجع.\n\nهل تريد المتابعة والحذف الآن؟');
  if(!secondConfirm){
    alert('تم إلغاء العملية — لم يُحذف أي شيء.');
    return;
  }
  const statusEl = $('#reset-status');
  statusEl.style.display = 'block';
  statusEl.textContent = 'جارٍ إعادة ضبط المصنع...';
  try{
    // 1) حذف كل مفاتيح البيانات المحفوظة
    const keys = ['clients','settings','bagStock','vaultTx','courseSessions','users','auditLog','companies','companyTransfers','bankStatementRows','vaultDenomTx'];
    const deleteErrors = [];
    for(const k of keys){
      try{ await window.storage.delete(k, false); }catch(e){ deleteErrors.push(`${k}: ${e.message||e}`); }
    }

    // 2) إعادة كل متغيرات البرنامج في الذاكرة إلى حالتها الافتراضية فوراً
    //    (حتى تنعكس إعادة الضبط على كل الشيتات/التبويبات مباشرة دون انتظار إعادة التشغيل)
    clients = [];
    bagStock = [];
    vaultTx = [];
    courseSessions = [];
    companies = [];
    companyTransfers = [];
    auditLog = [];
    bankStatementRows = [];
    vaultDenomTx = [];
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    users = [{username:'admin', password:'admin123', role:'admin', createdAt:Date.now()}];
    undoStack = [];
    redoStack = [];

    const saveErrors = [];
    const saveResults = await Promise.allSettled([
      saveClients(), saveSettings(), saveBagStock(), saveVaultTx(),
      saveCourseSessions(), saveCompanies(), saveCompanyTransfers(),
      saveUsers(), saveAuditLog(), saveBankStatementRows(), saveVaultDenomTx()
    ]);
    saveResults.forEach((r,i)=>{ if(r.status==='rejected') saveErrors.push(String(r.reason)); });

    // 3) إعادة رسم كل الشيتات/التبويبات فوراً حتى تظهر فارغة في كل مكان
    if(typeof refreshFilterOptions==='function') refreshFilterOptions();
    if(typeof refreshAuditFilterOptions==='function') refreshAuditFilterOptions();
    if(typeof refreshMissingCourseOptions==='function') refreshMissingCourseOptions();
    if(typeof refreshMissingNatOptions==='function') refreshMissingNatOptions();
    if(typeof renderDashboard==='function') renderDashboard();
    if(typeof renderTable==='function') renderTable();
    if(typeof renderVault==='function') renderVault();
    if(typeof renderBags==='function') renderBags();
    if(typeof renderCourses==='function') renderCourses();
    if(typeof renderMissingCourse==='function') renderMissingCourse();
    if(typeof renderCompanies==='function') renderCompanies();
    if(typeof renderReports==='function') renderReports();
    if(typeof renderBudget==='function') renderBudget();
    if(typeof renderAuditLog==='function') renderAuditLog();
    if(typeof renderSettings==='function') renderSettings();
    if(typeof renderUsersList==='function') renderUsersList();
    if(typeof updateUndoRedoButtons==='function') updateUndoRedoButtons();

    // تحقّق فعلي من أن الأرصدة صارت صفراً — للتأكد أمام المستخدم أن الحذف تم بالفعل
    const verifyMsg = (typeof balanceOf==='function')
      ? `الأرصدة الآن — الخزنة: ${fmt(balanceOf('vault'))} | البنك: ${fmt(balanceOf('bank'))} | الشبكة: ${fmt(balanceOf('network'))}`
      : '';

    if(deleteErrors.length || saveErrors.length){
      statusEl.textContent = 'حدثت مشكلة أثناء الحذف — راجع الرسالة.';
      alert(`تعذّر إتمام الحذف بشكل كامل:\n${[...deleteErrors, ...saveErrors].join('\n')}\n\nيُرجى إغلاق البرنامج وتشغيله كمسؤول (Run as Administrator) ثم إعادة المحاولة.`);
      return;
    }

    statusEl.textContent = `تمت إعادة ضبط المصنع بنجاح ✅ — ${verifyMsg}`;
    alert(`تم حذف جميع البيانات بنجاح ✅\n${verifyMsg}\n\nسيُعاد تشغيل البرنامج الآن.`);
    // 4) إعادة تحميل كاملة كإجراء احتياطي إضافي حتى لو تعذّر تحديث أي جزء من الواجهة أعلاه
    location.reload();
  }catch(err){
    statusEl.textContent = `حدث خطأ أثناء الحذف: ${err.message || err}`;
    alert(`حدث خطأ أثناء عملية الحذف: ${err.message || err}`);
  }
});
$('#btn-update-app').addEventListener('click', ()=>{
  if(!(window.appUpdater && window.appUpdater.installUpdate)){
    showToast('ميزة التحديث تعمل فقط في نسخة سطح المكتب المثبّتة (وليس في المتصفح)');
    return;
  }
  $('#update-file-input').value = '';
  $('#update-file-input').click();
});
$('#update-file-input').addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  if(!await customConfirm(`سيتم استبدال النسخة الحالية من البرنامج بالملف المختار:\n"${file.name}"\n\nسيُحتفظ بنسخة احتياطية من النسخة الحالية تلقائياً، ولن تتأثر بياناتك المحفوظة. هل تريد المتابعة؟`)){
    e.target.value = '';
    return;
  }
  const statusEl = $('#update-status');
  statusEl.style.display = 'block';
  statusEl.textContent = 'جارٍ قراءة الملف وتثبيت التحديث...';
  try{
    const content = await file.text();
    const result = await window.appUpdater.installUpdate(content);
    if(result && result.ok){
      statusEl.textContent = 'تم تثبيت التحديث بنجاح ✅ — سيتم إعادة تحميل البرنامج الآن...';
      await logAudit('edit','الإعدادات', `تم تحديث ملف البرنامج من الملف: ${file.name}`);
      showToast('تم تثبيت التحديث، جارٍ إعادة التحميل...');
      setTimeout(()=>location.reload(), 1200);
    }else{
      statusEl.textContent = `تعذّر تثبيت التحديث: ${(result && result.error) || 'خطأ غير معروف'}`;
      showToast('تعذّر تثبيت التحديث');
    }
  }catch(err){
    statusEl.textContent = `تعذّر قراءة الملف أو تثبيته: ${err.message || err}`;
    showToast('تعذّر تثبيت التحديث');
  }finally{
    e.target.value = '';
  }
});
/* ---------------- تصدير نسخة من ملف البرنامج نفسه (index.html) ---------------- */
/* هذا تصدير لملف البرنامج (الكود والواجهة) وليس لبيانات العملاء — مفيد لأخذ نسخة أرشيفية من الإصدار الحالي
   أو لتثبيت نفس النسخة يدوياً على جهاز آخر عبر زر "تحديث البرنامج" هناك.
   قبل التصدير، نُنظّف نسخة مؤقتة (clone) من الصفحة الحالية من كل المحتوى المعروض حالياً على الشاشة
   (جداول العملاء، الحركات المالية، إلخ) حتى لا تتضمن نسخة ملف البرنامج المصدَّرة أي بيانات حقيقية للعملاء —
   تماشياً مع مبدأ البرنامج بأن ملف البرنامج نفسه لا يحتوي على أي بيانات مطلقاً. */
const KB_EXPORT_CLEAR_IDS = [
  'acc-balance-check','acc-journal-body','acc-quarterly-table','acc-summary-cards','acc-trial-body',
  'audit-table-body','bag-cards','bag-stock-body','budget-cards','bulk-add-table-body',
  'bulk-update-table-body','bulk-delete-table-body','cs-bulk-table-body','ci-bulk-table-body','refnum-bulk-table-body',
  'bagfund-bulk-table-body','cards',
  'cbp-total','channel-list','ci-cards','client-payments-list','companies-list-body',
  'company-transfers-list','company-transfers-summary','courses-list','courses-sessions-list',
  'companies-stats-cards','companies-unsettled-list',
  'ct-company','ctr-client-info','expcat-list','monthly-summary-body','nat-list','ownbag-total',
  'pending-bags-table','pending-bags-total','period-cards','period-compare-cards','quickstats',
  'table-body','users-list','vault-cards','vault-table-body','voided-table-body',
  'chart-bag-method','chart-channel','chart-course','chart-expense-cat','chart-nat',
  'chart-report-expense','chart-report-revenue-course','chart-vault-method',
  'current-user-label','toast'
];
$('#btn-export-app').addEventListener('click', ()=>{
  try{
    const clone = document.documentElement.cloneNode(true);
    // تفريغ كل الحاويات التي تُعرض فيها بيانات حية (عملاء، حركات مالية، إلخ) في النسخة المُصدَّرة فقط
    KB_EXPORT_CLEAR_IDS.forEach(id=>{
      const el = clone.querySelector('#'+id);
      if(el) el.innerHTML = '';
    });
    // إغلاق أي نوافذ منبثقة كانت مفتوحة وقت التصدير، وإزالة أي نافذة معاينة طباعة مؤقتة
    clone.querySelectorAll('.overlay.show').forEach(ov=> ov.classList.remove('show'));
    const pp = clone.querySelector('#print-preview-overlay'); if(pp) pp.remove();
    const htmlContent = '<!DOCTYPE html>\n' + clone.outerHTML;
    const blob = new Blob([htmlContent], {type:'text/html;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `نسخة_البرنامج_${stampNow()}.html`;
    a.click();
    showToast('تم تصدير نسخة من ملف البرنامج (بدون أي بيانات عملاء)');
  }catch(err){
    showToast(`تعذّر تصدير نسخة البرنامج: ${err.message || err}`);
  }
});
$('#btn-save-centerinfo').addEventListener('click', async ()=>{
  settings.centerInfo = {
    name: $('#set-center-name').value.trim() || DEFAULT_SETTINGS.centerInfo.name,
    taxNumber: $('#set-center-tax').value.trim() || DEFAULT_SETTINGS.centerInfo.taxNumber,
    phone: $('#set-center-phone').value.trim() || DEFAULT_SETTINGS.centerInfo.phone,
  };
  await saveSettings();
  await logAudit('edit','الإعدادات', 'تم تحديث بيانات المركز المستخدمة في الفاتورة');
  showToast('تم حفظ بيانات المركز');
});
$('#btn-save-autobackup').addEventListener('click', async ()=>{
  settings.autoBackupEnabled = $('#set-autobackup-enabled').checked;
  settings.autoBackupIntervalDays = Math.max(1, Number($('#set-autobackup-days').value)||7);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث إعداد النسخ الاحتياطي التلقائي: ${settings.autoBackupEnabled?'مفعّل':'معطّل'} كل ${settings.autoBackupIntervalDays} يوم`);
  showToast('تم حفظ إعداد النسخ الاحتياطي');
});
$('#btn-save-alert-settings')?.addEventListener('click', async ()=>{
  settings.lowBalanceThreshold = Math.max(0, Number($('#set-low-balance').value)||0);
  settings.bagOverdueDays = Math.max(1, Number($('#set-bag-overdue-days').value)||14);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث إعدادات التنبيهات: حد أدنى للرصيد ${fmt(settings.lowBalanceThreshold)}، تنبيه الحقائب بعد ${settings.bagOverdueDays} يوم`);
  showToast('تم حفظ إعدادات التنبيهات');
  renderSmartAlerts();
});
$('#btn-save-monthly-wa')?.addEventListener('click', async ()=>{
  settings.monthlyReportWhatsapp = ($('#set-monthly-wa-number').value||'').replace(/[^\d]/g,'');
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث رقم واتساب التقرير الشهري`);
  showToast('تم حفظ رقم واتساب');
  renderSmartAlerts();
});
$('#btn-save-wa3-numbers')?.addEventListener('click', async ()=>{
  const raw = ($('#wa3-numbers').value||'');
  const cleaned = raw.split(',').map(s=> s.replace(/[^\d]/g,'')).filter(Boolean);
  settings.monthlyPdfReportsWhatsappNumbers = cleaned.join(', ');
  if($('#wa3-numbers')) $('#wa3-numbers').value = settings.monthlyPdfReportsWhatsappNumbers;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث أرقام واتساب مستلمي التقارير الشهرية (${cleaned.length} رقم)`);
  showToast(cleaned.length ? `تم حفظ ${cleaned.length} رقم` : 'تم مسح الأرقام المحفوظة');
});
$('#btn-save-vat-wa-numbers')?.addEventListener('click', async ()=>{
  const raw = ($('#vat-wa-numbers').value||'');
  const cleaned = raw.split(',').map(s=> s.replace(/[^\d]/g,'')).filter(Boolean);
  settings.vatPdfReportWhatsappNumbers = cleaned.join(', ');
  if($('#vat-wa-numbers')) $('#vat-wa-numbers').value = settings.vatPdfReportWhatsappNumbers;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث أرقام واتساب مستلمي الإقرار الضريبي (${cleaned.length} رقم)`);
  showToast(cleaned.length ? `تم حفظ ${cleaned.length} رقم` : 'تم مسح الأرقام المحفوظة');
});
$('#btn-backup-now').addEventListener('click', ()=>{
  downloadFullBackup(false);
  showToast('تم تنزيل النسخة الاحتياطية');
});
$('#btn-restore-backup').addEventListener('click', ()=> $('#restore-backup-input').click());
$('#restore-backup-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(file) await restoreFullBackup(file);
  e.target.value = '';
});
$('#btn-add-user').addEventListener('click', async ()=>{
  const uname = $('#new-user-name').value.trim();
  const upass = $('#new-user-pass').value;
  const urole = $('#new-user-role').value;
  if(!uname || !upass){ showToast('أدخل اسم المستخدم وكلمة المرور'); return; }
  if(upass.length < 6){ showToast('كلمة المرور يجب ألا تقل عن 6 أحرف'); return; }
  try{
    const res = await fetch(API_BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      body: JSON.stringify({ username: uname, password: upass, displayName: uname, role: urole })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر إضافة المستخدم');
    await logAudit('add','المستخدمون', `تمت إضافة/تحديث مستخدم على الخادم: ${uname} (${SERVER_ROLE_LABELS[urole]||urole})`);
    $('#new-user-name').value=''; $('#new-user-pass').value='';
    await renderUsersList();
    showToast('تمت إضافة المستخدم');
  }catch(e){
    showToast(e.message || 'تعذّر إضافة المستخدم');
  }
});
document.addEventListener('click', async e=>{
  if(e.target.dataset.ru!==undefined){
    const username = e.target.dataset.ru;
    if(await customConfirm(`تأكيد حذف المستخدم "${username}"؟ لن يستطيع تسجيل الدخول بعد ذلك.`)){
      try{
        const res = await fetch(API_BASE + '/api/users/' + encodeURIComponent(username), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN }
        });
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || 'تعذّر حذف المستخدم');
        await logAudit('delete','المستخدمون', `تم حذف مستخدم من الخادم: ${username}`);
        await renderUsersList();
        showToast('تم حذف المستخدم');
      }catch(err){
        showToast(err.message || 'تعذّر حذف المستخدم');
      }
    }
  }
});
$('#btn-add-course').addEventListener('click', async ()=>{
  const name = $('#new-course-name').value.trim();
  const price = num($('#new-course-price').value);
  if(!name) return;
  const dup = settings.courses.find(c=> String(c.name||'').trim().toLowerCase() === name.toLowerCase());
  if(dup){
    showToast(`نوع الدورة "${dup.name}" مسجّل بالفعل بنفس الاسم (بغض النظر عن حالة الأحرف) — لن تتم إضافته مرة أخرى لتفادي التكرار`);
    return;
  }
  snapshotState(`إضافة نوع دورة: ${name}`);
  settings.courses.push({name, price});
  $('#new-course-name').value=''; $('#new-course-price').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة نوع دورة: ${name} (${fmt(price)})`);
  renderSettings(); refreshFilterOptions();
});
$('#btn-add-nat').addEventListener('click', async ()=>{
  const v = $('#new-nat').value.trim(); if(!v) return;
  const dup = (settings.nationalities||[]).find(n=> String(n||'').trim().toLowerCase() === v.toLowerCase());
  if(dup){
    showToast(`الجنسية "${dup}" مسجّلة بالفعل بنفس الاسم (بغض النظر عن حالة الأحرف) — لن تتم إضافتها مرة أخرى لتفادي التكرار`);
    return;
  }
  snapshotState(`إضافة جنسية: ${v}`);
  settings.nationalities.push(v); $('#new-nat').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة جنسية: ${v}`);
  renderSettings(); refreshFilterOptions();
});
$('#btn-add-channel').addEventListener('click', async ()=>{
  const v = $('#new-channel').value.trim(); if(!v) return;
  snapshotState(`إضافة طريقة دفع: ${v}`);
  settings.channels.push({name:v, dest:$('#new-channel-dest').value});
  $('#new-channel').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة طريقة دفع: ${v}`);
  renderSettings(); refreshFilterOptions();
});
$('#btn-add-expcat').addEventListener('click', async ()=>{
  const v = $('#new-expcat').value.trim(); if(!v) return;
  snapshotState(`إضافة تصنيف مصروف: ${v}`);
  settings.expenseCategories.push(v); $('#new-expcat').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة تصنيف مصروف: ${v}`);
  renderSettings();
});
document.addEventListener('click', async e=>{
  if(e.target.dataset.rc!==undefined){
    const removed = settings.courses[+e.target.dataset.rc];
    snapshotState(`حذف نوع دورة: ${removed?.name}`);
    settings.courses.splice(+e.target.dataset.rc,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف نوع دورة: ${removed?.name}`);
    renderSettings(); refreshFilterOptions();
  }
  if(e.target.dataset.rn!==undefined){
    const removed = settings.nationalities[+e.target.dataset.rn];
    snapshotState(`حذف جنسية: ${removed}`);
    settings.nationalities.splice(+e.target.dataset.rn,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف جنسية: ${removed}`);
    renderSettings(); refreshFilterOptions();
  }
  if(e.target.dataset.rh!==undefined){
    const removed = settings.channels[+e.target.dataset.rh];
    snapshotState(`حذف طريقة دفع: ${removed?.name}`);
    settings.channels.splice(+e.target.dataset.rh,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف طريقة دفع: ${removed?.name}`);
    renderSettings();
  }
  if(e.target.dataset.re!==undefined){
    const removed = settings.expenseCategories[+e.target.dataset.re];
    snapshotState(`حذف تصنيف مصروف: ${removed}`);
    settings.expenseCategories.splice(+e.target.dataset.re,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف تصنيف مصروف: ${removed}`);
    renderSettings();
  }
});
$('#btn-reset').addEventListener('click', async ()=>{
  if(await customConfirm('سيتم حذف جميع بيانات العملاء نهائياً. متأكد؟')){
    const countBefore = clients.length;
    snapshotState(`حذف جميع بيانات العملاء (${countBefore} سجل)`);
    clients = [];
    await saveClients();
    await logAudit('delete','العملاء', `تم حذف جميع بيانات العملاء دفعة واحدة (${countBefore} سجل)`);
    renderTable(); renderDashboard(); renderBags();
    showToast('تم حذف جميع البيانات');
  }
});
$('#btn-save-bagprice').addEventListener('click', async ()=>{
  const oldPrice = settings.bagPrice;
  settings.bagPrice = num($('#set-bagprice').value);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تم تعديل قيمة الحقيبة من ${fmt(oldPrice)} إلى ${fmt(settings.bagPrice)}`);
  showToast('تم حفظ قيمة الحقيبة');
});

$('#btn-save-nat-prices').addEventListener('click', async ()=>{
  const oldSaudi = settings.priceSaudi, oldNonSaudi = settings.priceNonSaudi;
  settings.priceSaudi = num($('#set-price-saudi').value);
  settings.priceNonSaudi = num($('#set-price-nonsaudi').value);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تم تعديل سعر الدورة حسب الجنسية: السعودي من ${fmt(oldSaudi)} إلى ${fmt(settings.priceSaudi)}، وغير السعودي من ${fmt(oldNonSaudi)} إلى ${fmt(settings.priceNonSaudi)}`);
  showToast('تم حفظ أسعار الدورة حسب الجنسية');
});

/* ---------------- Bags / Inventory ---------------- */
/* إعادة احتساب دفتر تمويل مخزون الحقائب بالكامل من البداية، بحيث تبقى النتائج صحيحة
   حتى لو تم حذف عملية قديمة من المنتصف. السجلات القديمة (بدون type) تُعامل كإضافة
   كمية ثابتة يدوياً كما كانت سابقاً، دون التأثير على الرصيد. */
function recalcBagFundLedger(){
  const price = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  let bags = 0, balance = 0;
  const sorted = bagStock.slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  sorted.forEach(entry=>{
    if(!entry.type){
      bags += num(entry.qty);
      entry.balanceBefore = balance;
      entry.balanceAfter = balance;
      return;
    }
    entry.balanceBefore = balance;
    if(entry.manualQty){
      // عدد الحقائب أُدخل يدوياً من المستخدم كرقم فعلي حقيقي (مثلاً من فاتورة شراء) — يُعتمد كما هو ولا يُعاد
      // اشتقاقه من المبلغ وسعر الحقيبة الحالي، حتى لا يتأثر "المخزون الحالي" بأي تغيير لاحق في السعر بالإعدادات.
      // "سعر الوحدة" هنا يُحسب من المبلغ الفعلي المدخل (إن وُجد) لتبقى "إجمالي المصروف على الحقائب" دقيقة أيضاً،
      // ولا نلمس الرصيد التراكمي (balance) لأن هذه العملية غير مرتبطة بآلية "تجميع مبالغ جزئية حتى تكتمل حقيبة".
      const qtySigned = entry.type==='withdraw' ? -Math.abs(entry.manualQty) : Math.abs(entry.manualQty);
      entry.qty = qtySigned;
      entry.unitPrice = entry.amount ? Math.round((num(entry.amount)/Math.abs(entry.manualQty))*10000)/10000 : price;
      bags += qtySigned;
      entry.balanceAfter = balance;
      return;
    }
    if(entry.type==='withdraw'){
      const totalValue = bags*price + balance - num(entry.amount);
      const newBags = Math.floor(totalValue/price);
      entry.qty = newBags - bags;
      entry.unitPrice = price;
      bags = newBags;
      balance = totalValue - newBags*price;
    }else if(entry.type==='issue'){
      // تسليم حقيبة لعميل من المخزون: ينقص عدد الحقائب المتاحة فقط بمقدار حقيبة واحدة، دون أي أثر على الرصيد المالي
      // أو على "إجمالي المصروف على الحقائب" (قيمتها محتسبة أصلاً ضمن مشتريات المخزون السابقة عبر عمليات الإيداع،
      // وتسليمها لعميل ليس عملية شراء أو صرف مالي جديد)
      entry.qty = -1;
      entry.unitPrice = 0;
      bags -= 1;
      entry.balanceAfter = balance;
      return;
    }else{
      const combined = balance + num(entry.amount);
      const addedBags = Math.floor(combined/price);
      entry.qty = addedBags;
      entry.unitPrice = price;
      bags += addedBags;
      balance = combined - addedBags*price;
    }
    entry.balanceAfter = balance;
  });
  settings.bagFundBalance = Math.round(balance*100)/100;
  return bags;
}
function bagStockTotals(){
  // نحسب صافي حركات التمويل الفعلية فقط (إيداع/سحب) من سجل مخزون الحقائب — أي سجلات "تسليم" (issue)
  // قديمة متبقية من نسخ سابقة يتم تجاهلها هنا، لأن الخصم الفعلي أصبح مرتبطاً ربطاً مباشراً وكاملاً
  // بعدد العملاء الذين حالتهم "bagSource==='stock'" في شيت العملاء نفسه — وهو بالضبط نفس المصدر الذي
  // يُبنى منه "سجل عمليات شراء الحقائب المكتملة للعملاء". بهذا يبقى "المخزون الحالي" مطابقاً دائماً لذلك
  // السجل تلقائياً، بغض النظر عن الشاشة أو الاستيراد الذي سجّل عملية الشراء (شيت العملاء، شيت الدورات
  // عبر خانة الشراء السريعة، الاستيراد الجماعي لبيانات العملاء، استيراد متدربين حوالة شركة... أو أي شاشة مستقبلية)،
  // دون الحاجة لأي مزامنة يدوية أو سجل وسيط.
  const fundingQty = bagStock.reduce((s,x)=> x.type==='issue' ? s : s+num(x.qty), 0);
  const spentBulk = bagStock.reduce((s,x)=> x.type==='issue' ? s : s+num(x.qty)*num(x.unitPrice), 0);
  const issuedToClients = clients.filter(c=>c.bagSource==='stock' && !c.suspended).length;
  const purchasedQty = fundingQty - issuedToClients;
  return {purchasedQty, spentBulk, fundingQty, issuedToClients};
}
function bagStockFiltered(){
  const dfrom = $('#bst-date-from')?.value || '';
  const dto = $('#bst-date-to')?.value || '';
  // نستبعد عمليات "تسليم لعميل من المخزون" (type==='issue') من سجل التمويل نفسه وتصديره ومجموع الفترة:
  // هذا السجل مخصص لحركات التمويل الفعلية (إيداع/سحب) فقط. الخصم الفعلي من "المخزون الحالي" يبقى يعمل
  // كالمعتاد لأنه يُحسب من bagStockTotals() على كامل السجل بدون هذا الفلتر.
  return bagStock.filter(b=>{
    if(b.type==='issue') return false;
    if(dfrom && (!b.date || b.date<dfrom)) return false;
    if(dto && (!b.date || b.date>dto)) return false;
    return true;
  });
}
let pendingBagsPageState = {page:1, sig:''};
let bagStockPageState = {page:1, sig:''};
function renderBagFinanceLinkToggle(){
  const btn = $('#btn-toggle-bagfinancelink');
  const status = $('#bagfinancelink-status');
  if(!btn || !status) return;
  const enabled = settings.bagFinanceLinkEnabled!==false;
  status.textContent = enabled ? '✅ الربط مُفعَّل حالياً' : '⛔ الربط مُلغى حالياً';
  status.style.color = enabled ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)';
  btn.textContent = enabled ? 'إلغاء الربط' : 'تفعيل الربط';
  btn.className = enabled ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
}
$('#btn-toggle-bagfinancelink').addEventListener('click', async ()=>{
  const enabled = settings.bagFinanceLinkEnabled!==false;
  settings.bagFinanceLinkEnabled = !enabled;
  await saveSettings();
  await logAudit('edit','الإعدادات', settings.bagFinanceLinkEnabled
    ? 'تم تفعيل ربط عمليات مخزون الحقائب بالحركات المالية تلقائياً'
    : 'تم إلغاء ربط عمليات مخزون الحقائب بالحركات المالية تلقائياً (العمليات الجديدة لن تُنشئ حركات مالية، والحركات القديمة تبقى كما هي)');
  renderBagFinanceLinkToggle();
  showToast(settings.bagFinanceLinkEnabled ? 'تم تفعيل الربط' : 'تم إلغاء الربط');
});

/* ---------------- ربط Power Automate (Webhooks) ----------------
   إرسال أحداث تلقائياً (POST بصيغة JSON) لرابط HTTP Trigger من Power Automate عند حدوث أحداث معيّنة.
   الإرسال يتم بطريقة "fire-and-forget" (mode:'no-cors') لتفادي مشاكل CORS الشائعة مع روابط Power Automate،
   وبالتالي لا يمكن للبرنامج معرفة نجاح الإرسال من عدمه — يُنصح بمراجعة سجل تشغيل الـ Flow للتأكد. */
async function sendPowerAutomateEvent(eventType, payload){
  const cfg = settings.powerAutomate;
  if(!cfg || !cfg.webhookUrl) return;
  if(eventType==='new_client' && cfg.notifyNewClient===false) return;
  if(eventType==='course_number_updated' && cfg.notifyCourseNumber===false) return;
  try{
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: {'Content-Type':'text/plain'},
      body: JSON.stringify({event: eventType, timestamp: new Date().toISOString(), data: payload})
    });
  }catch(err){
    console.warn('تعذّر إرسال حدث Power Automate:', err);
  }
}
$('#btn-save-pa-webhook').addEventListener('click', async ()=>{
  settings.powerAutomate = {
    webhookUrl: $('#set-pa-webhook-url').value.trim(),
    notifyNewClient: $('#set-pa-notify-newclient').checked,
    notifyCourseNumber: $('#set-pa-notify-coursenum').checked
  };
  await saveSettings();
  await logAudit('edit','الإعدادات', 'تم تحديث إعدادات ربط Power Automate');
  showToast('تم حفظ إعدادات Power Automate');
});
$('#btn-test-pa-webhook').addEventListener('click', async ()=>{
  const url = $('#set-pa-webhook-url').value.trim();
  if(!url){ showToast('أدخل رابط Webhook أولاً'); return; }
  try{
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: {'Content-Type':'text/plain'},
      body: JSON.stringify({event:'test', timestamp: new Date().toISOString(), data:{message:'رسالة اختبار من برنامج المركز'}})
    });
    showToast('تم إرسال طلب الاختبار — تحقّق من سجل تشغيل الـ Flow في Power Automate للتأكد من الاستلام');
  }catch(err){
    showToast('تعذّر إرسال طلب الاختبار — تأكد من صحة الرابط');
  }
});

function renderBags(){
  $('#set-bagprice').value = settings.bagPrice;
  renderBagFinanceLinkToggle();
  if($('#bs-fixed-price')) $('#bs-fixed-price').textContent = fmt(num(settings.bagPrice));
  if($('#bs-current-balance')) $('#bs-current-balance').textContent = fmt(num(settings.bagFundBalance));
  if($('#bs-date') && !$('#bs-date').value) $('#bs-date').value = todayISO();
  // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
  if($('#bs-method')){
    const bsMethodVal = $('#bs-method').value;
    populateSelect($('#bs-method'), settings.channels.map(c=>c.name), false);
    if(settings.channels.some(c=>c.name===bsMethodVal)) $('#bs-method').value = bsMethodVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bs-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }

  const pendingBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended);
  const purchasedBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended);
  const ownBag = clients.filter(c=>c.bagSource==='own' && !c.suspended);
  const {purchasedQty, spentBulk} = bagStockTotals();
  const availableStock = purchasedQty;
  const spentDirect = purchasedBuy.reduce((s,c)=>s+num(c.bagPrice),0);
  const totalSpent = spentBulk + spentDirect;
  const totalCollected = clients.reduce((s,c)=>s+bagAmount(c),0);

  $('#bag-cards').innerHTML = `
    <div class="card">
      <div class="k" style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
        <span>المخزون الحالي</span>
        <button type="button" class="btn btn-ghost btn-sm" data-refresh-bagstock style="padding:1px 8px; font-size:11px; line-height:1.6;" title="إعادة حساب كل أرقام الحقائب من جديد من مصدرها الفعلي">↻ تحديث</button>
      </div>
      <div class="v ${availableStock<0?'red':''}">${availableStock}</div>
    </div>
    <div class="card"><div class="k">حقائب مطلوب شراؤها</div><div class="v red">${pendingBuy.length}</div></div>
    <div class="card"><div class="k">عملاء وفّروا بحقيبتهم الخاصة</div><div class="v teal">${ownBag.length}</div></div>
    <div class="card"><div class="k">إجمالي المصروف على الحقائب</div><div class="v gold">${fmt(totalSpent)}</div></div>
    <div class="card"><div class="k">حصيلة الحقائب من العملاء</div><div class="v">${fmt(totalCollected)}</div></div>
    <div class="card"><div class="k">الفرق (محصّل - مصروف)</div><div class="v ${ (totalCollected-totalSpent) < 0 ? 'red':''}">${fmt(totalCollected-totalSpent)}</div></div>
  `;

  const pendingBagsSearchTerm = ($('#pending-bags-search')?.value || '').trim();
  const pendingBuyFiltered = (pendingBagsSearchTerm
    ? pendingBuy.filter(c=>String(c.clientId||'').includes(pendingBagsSearchTerm))
    : pendingBuy
  ).slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));

  if($('#pending-bags-total')){
    const pendingBuyTotalValue = pendingBuyFiltered.reduce((s,c)=>s+num(c.bagPrice),0);
    $('#pending-bags-total').innerHTML = `العدد: <span style="color:var(--red);">${pendingBuyFiltered.length}</span> — القيمة الإجمالية: <span style="color:var(--red);">${fmt(pendingBuyTotalValue)}</span>`;
  }

  const pendingBagsPageRows = applyGenericPagination('pendingbags', pendingBuyFiltered, pendingBagsPageState, [
    pendingBagsSearchTerm
  ]);
  $('#pending-bags-table').innerHTML = pendingBuyFiltered.length ? `
    <div class="table-scroll">
    <table>
      <thead><tr><th>العميل</th><th>رقم الهوية</th><th>رقم الهاتف</th><th>الرقم المرجعي</th><th>الدورة</th><th>تاريخ التسجيل</th><th>قيمة الحقيبة</th><th></th></tr></thead>
      <tbody>${pendingBagsPageRows.map(c=>`
        <tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="mono">${escapeHtml(c.clientId||'—')}</td>
          <td class="mono">${escapeHtml(c.phone||'—')}</td>
          <td class="mono">${escapeHtml(c.referNum||'—')}</td>
          <td>${escapeHtml(c.courseType||'')}</td>
          <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
          <td class="mono">${fmt(num(c.bagPrice))}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-fromstock="${c.id}">تسليم من المخزون</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>
    </div>` : `<div class="empty-state" style="padding:20px;">لا توجد حقائب معلّقة — كل الحقائب المطلوبة تم شراؤها 👍</div>`;

  const bagStockRows = bagStockFiltered().slice().reverse();
  if($('#bagstock-period-deposit-total')){
    const periodNetQty = bagStockFiltered().reduce((s,b)=>s+num(b.qty),0);
    $('#bagstock-period-deposit-total').textContent = periodNetQty;
  }
  const bagStockPageRows = applyGenericPagination('bagstock', bagStockRows, bagStockPageState, [
    $('#bst-date-from')?.value, $('#bst-date-to')?.value
  ]);
  $('#bag-stock-body').innerHTML = bagStockRows.length ? bagStockPageRows.map(b=>{
    const typeLabel = (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : (b.type==='issue' ? 'تسليم لعميل من المخزون' : 'إضافة يدوية (سجل قديم)'))) + (b.manualQty ? ' (عدد فعلي)' : '');
    const typeColor = b.type==='withdraw' ? 'red' : (b.type==='deposit' ? 'teal' : (b.type==='issue' ? 'red' : ''));
    const qtyDisplay = num(b.qty)>0 ? `+${b.qty}` : `${b.qty}`;
    const amountDisplay = b.amount!==undefined ? fmt(num(b.amount)) : fmt(num(b.qty)*num(b.unitPrice));
    return `
    <tr>
      <td class="mono">${b.date||'—'}</td>
      <td class="${typeColor}">${typeLabel}</td>
      <td class="mono">${amountDisplay}</td>
      <td class="mono ${num(b.qty)<0?'red':''}">${qtyDisplay}</td>
      <td class="mono">${b.balanceAfter!==undefined ? fmt(num(b.balanceAfter)) : '—'}</td>
      <td>${escapeHtml(b.method||'')}</td>
      <td>${escapeHtml(b.notes||'')}</td>
      <td style="white-space:nowrap;">
        ${b.type && b.type!=='issue' ? `<button class="btn btn-ghost btn-sm" data-editstock="${b.id}">${tr('edit')}</button>` : ''}
        <button class="btn btn-danger btn-sm" data-delstock="${b.id}">${tr('delete')}</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد عمليات تمويل مسجّلة</td></tr>`;

  const methodTotals = {};
  bagStock.forEach(b=>{ const k=b.method||'غير محدد'; methodTotals[k]=(methodTotals[k]||0)+num(b.qty)*num(b.unitPrice); });
  purchasedBuy.forEach(c=>{ const k=c.bagPaymentMethod||'غير محدد'; methodTotals[k]=(methodTotals[k]||0)+num(c.bagPrice); });
  drawBars('#chart-bag-method', Object.entries(methodTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));

  renderClientBagPurchases();
  renderOwnBagClients();
}

/* سجل العملاء الذين وفّروا حقيبتهم الخاصة (bagSource === 'own') */
function ownBagClientsFiltered(){
  const q = ($('#ownbag-search')?.value || '').trim().toLowerCase();
  const year = $('#ownbag-year-filter')?.value || '';
  let rows = clients.filter(c=>c.bagSource==='own' && !c.suspended);
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.phone].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  if(year) rows = rows.filter(c=> c.date && c.date.slice(0,4)===year);
  rows.sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  return rows;
}
function populateOwnBagYearFilter(){
  const sel = $('#ownbag-year-filter');
  if(!sel) return;
  const years = new Set();
  clients.forEach(c=>{
    if(c.bagSource==='own' && !c.suspended && c.date && c.date.length>=4) years.add(c.date.slice(0,4));
  });
  const sortedYears = [...years].sort((a,b)=>b.localeCompare(a));
  const current = sel.value;
  sel.innerHTML = '<option value="">كل السنوات</option>' + sortedYears.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(sortedYears.includes(current)) sel.value = current;
}
let ownbagPageState = {page:1, sig:''};
function renderOwnBagClients(){
  const body = $('#own-bag-clients-body');
  if(!body) return;
  populateOwnBagYearFilter();
  const rows = ownBagClientsFiltered();
  if($('#ownbag-total')) $('#ownbag-total').innerHTML = `العدد: <span style="color:var(--teal);">${rows.length}</span>`;
  const pageRows = applyGenericPagination('ownbag', rows, ownbagPageState, [$('#ownbag-search')?.value, $('#ownbag-year-filter')?.value]);
  body.innerHTML = rows.length ? pageRows.map(c=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${escapeHtml(c.nationality||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td>${escapeHtml(c.courseType||'—')}</td>
      <td class="mono">${escapeHtml(c.invoice||'—')}</td>
      <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد عملاء وفّروا حقيبتهم الخاصة</td></tr>`;
}
onSearchInput('#ownbag-search', renderOwnBagClients);
$('#ownbag-year-filter')?.addEventListener('change', renderOwnBagClients);
bindGenericPagination('ownbag', ownbagPageState, renderOwnBagClients);
$('#btn-export-ownbag')?.addEventListener('click', ()=>{
  const headers = ['الاسم','رقم الهوية','الجنسية','رقم الهاتف','الدورة','رقم الفاتورة','تاريخ التسجيل'];
  const rows = ownBagClientsFiltered().map(c=>[c.name,c.clientId,c.nationality,c.phone,c.courseType,c.invoice,c.date]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_حقائبهم_الخاصة.csv';
  a.click();
});

/* سجل موحّد لكل عميل حصل على حقيبته فعلياً — سواء بالشراء المباشر (شيت العملاء) أو بالتسليم من المخزون
   المموَّل (شيت مخزون الحقائب) — يجمعهما في مكان واحد بغض النظر عن أي شيت جاءت منه العملية. */
function clientBagPurchasesFiltered(){
  const q = ($('#cbp-search')?.value || '').trim().toLowerCase();
  const dfrom = $('#cbp-date-from')?.value || '';
  const dto = $('#cbp-date-to')?.value || '';
  const year = $('#cbp-year-filter')?.value || '';
  let rows = clients.filter(c=> ((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended);
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.phone,c.bagInvoice].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  rows = rows.map(c=>({
    c,
    purchaseDate: c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '')
  }));
  if(dfrom) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate>=dfrom);
  if(dto) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate<=dto);
  if(year) rows = rows.filter(r=> r.purchaseDate && r.purchaseDate.slice(0,4)===year);
  rows.sort((a,b)=> (b.purchaseDate||'').localeCompare(a.purchaseDate||''));
  return rows;
}
function populateCbpYearFilter(){
  const sel = $('#cbp-year-filter');
  if(!sel) return;
  const years = new Set();
  clients.forEach(c=>{
    if(!(((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended)) return;
    const d = c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '');
    if(d && d.length>=4) years.add(d.slice(0,4));
  });
  const sortedYears = [...years].sort((a,b)=>b.localeCompare(a));
  const current = sel.value;
  sel.innerHTML = '<option value="">كل السنوات</option>' + sortedYears.map(y=>`<option value="${y}">${y}</option>`).join('');
  if(sortedYears.includes(current)) sel.value = current;
}
let cbpPageState = {page:1, sig:''};
function renderClientBagPurchases(){
  const body = $('#client-bag-purchases-body');
  if(!body) return;
  populateCbpYearFilter();
  const rows = clientBagPurchasesFiltered();
  if($('#cbp-total')){
    const cbpTotalValue = rows.reduce((s,{c})=>s+num(c.bagPrice),0);
    $('#cbp-total').innerHTML = `العدد: <span style="color:var(--gold-dark);">${rows.length}</span> — القيمة الإجمالية: <span style="color:var(--gold-dark);">${fmt(cbpTotalValue)}</span>`;
  }
  const pageRows = applyGenericPagination('cbp', rows, cbpPageState, [
    $('#cbp-search')?.value, $('#cbp-date-from')?.value, $('#cbp-date-to')?.value, $('#cbp-year-filter')?.value
  ]);
  body.innerHTML = rows.length ? pageRows.map(({c,purchaseDate})=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td>${escapeHtml(c.nationality||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td class="mono">${escapeHtml(c.bagInvoice||'—')}</td>
      <td class="mono">${escapeHtml(purchaseDate||'—')}</td>
      <td><span class="stamp ${c.bagSource==='stock' ? 'teal':'paid'}">${c.bagSource==='stock' ? 'من المخزون' : 'شراء مباشر'}</span></td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد عمليات شراء حقائب مكتملة بعد</td></tr>`;
}
onSearchInput('#cbp-search', renderClientBagPurchases);
bindGenericPagination('cbp', cbpPageState, renderClientBagPurchases);
onSearchInput('#pending-bags-search', renderBags);
bindGenericPagination('pendingbags', pendingBagsPageState, renderBags);
bindGenericPagination('bagstock', bagStockPageState, renderBags);
$('#btn-export-pending-bags')?.addEventListener('click', ()=>{
  const pendingBagsSearchTerm = ($('#pending-bags-search')?.value || '').trim();
  const rows = clients.filter(c=>c.bagSource==='buy' && c.bagStatus!=='purchased' && !c.suspended)
    .filter(c=> !pendingBagsSearchTerm || String(c.clientId||'').includes(pendingBagsSearchTerm))
    .slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));
  const headers = ['العميل','رقم الهوية','رقم الهاتف','الرقم المرجعي','الدورة','تاريخ التسجيل','قيمة الحقيبة'];
  const csvRows = rows.map(c=>[c.name,c.clientId,c.phone,c.referNum,c.courseType,c.date,num(c.bagPrice)]);
  const csv = '\uFEFF'+[headers, ...csvRows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'حقائب_يجب_شراؤها.csv';
  a.click();
});
$('#cbp-date-from')?.addEventListener('input', renderClientBagPurchases);
$('#cbp-date-to')?.addEventListener('input', renderClientBagPurchases);
$('#cbp-year-filter')?.addEventListener('change', renderClientBagPurchases);
$('#bst-date-from')?.addEventListener('input', renderBags);
$('#bst-date-to')?.addEventListener('input', renderBags);
$('#btn-export-bagstock')?.addEventListener('click', ()=>{
  const headers = ['التاريخ','النوع','المبلغ','عدد الحقائب (+/-)','الرصيد بعد العملية','طريقة الدفع','ملاحظات'];
  const rows = bagStockFiltered().map(b=>{
    const typeLabel = (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : (b.type==='issue' ? 'تسليم لعميل من المخزون' : 'إضافة يدوية (سجل قديم)'))) + (b.manualQty ? ' (عدد فعلي)' : '');
    const amountDisplay = b.amount!==undefined ? num(b.amount) : num(b.qty)*num(b.unitPrice);
    return [b.date,typeLabel,amountDisplay,b.qty,b.balanceAfter!==undefined?num(b.balanceAfter):'',b.method||'',b.notes||''];
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تمويل_مخزون_الحقائب.csv';
  a.click();
});
$('#btn-export-cbp')?.addEventListener('click', ()=>{
  const headers = ['الاسم','رقم الهوية','الجنسية','رقم الهاتف','رقم فاتورة الحقيبة','تاريخ الشراء','المصدر'];
  const rows = clientBagPurchasesFiltered().map(({c,purchaseDate})=>[c.name,c.clientId,c.nationality,c.phone,c.bagInvoice,purchaseDate,c.bagSource==='stock'?'من المخزون':'شراء مباشر']);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'حقائب_العملاء.csv';
  a.click();
});

function openBagStockEdit(id){
  const entry = bagStock.find(b=>b.id===id);
  if(!entry || !entry.type) return;
  editingBagStockId = id;
  $('#bs-type').value = entry.type;
  $('#bs-date').value = entry.date || todayISO();
  $('#bs-amount').value = entry.amount ?? '';
  $('#bs-qty').value = entry.manualQty ?? '';
  populateSelect($('#bs-method'), settings.channels.map(c=>c.name), false);
  {
    const bsEditVal = entry.method || '';
    if(settings.channels.some(c=>c.name===bsEditVal)) $('#bs-method').value = bsEditVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bs-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }
  $('#bs-notes').value = entry.notes || '';
  $('#btn-add-stock').textContent = 'حفظ التعديل';
  $('#btn-cancel-edit-stock').style.display = '';
  $('#bs-type').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelBagStockEdit(){
  editingBagStockId = null;
  $('#bs-amount').value=''; $('#bs-qty').value=''; $('#bs-notes').value='';
  $('#btn-add-stock').textContent = 'تسجيل العملية';
  $('#btn-cancel-edit-stock').style.display = 'none';
}
$('#btn-cancel-edit-stock').addEventListener('click', cancelBagStockEdit);

$('#btn-add-stock').addEventListener('click', async ()=>{
  const type = $('#bs-type').value; // deposit | withdraw
  const amount = num($('#bs-amount').value);
  if(amount<=0){ showToast('أدخل مبلغاً صحيحاً'); return; }
  const price = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
  const method = $('#bs-method').value;
  const date = $('#bs-date').value || todayISO();
  const notes = $('#bs-notes').value.trim();
  const isEditing = !!editingBagStockId;
  // عدد الحقائب الفعلي (اختياري): إن أُدخل، يُعتمد كما هو كرقم حقيقي ولا يُعاد اشتقاقه من المبلغ/السعر لاحقاً
  const qtyRaw = $('#bs-qty').value.trim();
  const manualQty = qtyRaw ? Math.abs(Math.round(num(qtyRaw))) : undefined;
  if(qtyRaw && (!manualQty || manualQty<=0)){ showToast('عدد الحقائب الفعلي يجب أن يكون رقماً صحيحاً أكبر من صفر'); return; }

  if(type==='withdraw'){
    const currentBags = bagStockTotals().purchasedQty;
    let currentTotalValue = currentBags*price + num(settings.bagFundBalance);
    if(isEditing){
      // عند التعديل، أضف مرة أخرى قيمة العملية القديمة قبل المقارنة (لأنها ستُحذف ثم تُعاد بالقيم الجديدة)
      const oldEntry = bagStock.find(b=>b.id===editingBagStockId);
      if(oldEntry) currentTotalValue += num(oldEntry.qty)*price;
    }
    if(amount > currentTotalValue){
      if(!await customConfirm(`المبلغ المسحوب (${fmt(amount)}) أكبر من إجمالي الرصيد المتاح حالياً لتمويل الحقائب (${fmt(currentTotalValue)}). سيؤدي هذا إلى عجز في مخزون الحقائب. هل تريد المتابعة؟`)) return;
    }
  }

  let addedEntry;
  if(isEditing){
    const idx = bagStock.findIndex(b=>b.id===editingBagStockId);
    if(idx===-1){ showToast('تعذّر إيجاد العملية المطلوب تعديلها'); cancelBagStockEdit(); return; }
    snapshotState(`تعديل عملية في سجل تمويل مخزون الحقائب: ${fmt(amount)} ﷼`);
    // احذف أي حركة خزنة مرتبطة بالعملية القديمة قبل التعديل، وسيُعاد إنشاؤها بالقيم الجديدة أدناه إن لزم
    const oldLinkedTx = vaultTx.find(t=>t.bagStockRef===bagStock[idx].id);
    if(oldLinkedTx){
      if(isDateLocked(oldLinkedTx.date)){ showToast('تعذّر التعديل: الحركة القديمة المرتبطة تقع ضمن فترة محاسبية مُقفلة'); return; }
      const removedOld = softDeleteVaultTx(oldLinkedTx.id, 'استُبدلت تلقائياً بعد تعديل عملية تمويل مخزون الحقائب المرتبطة بها');
      await saveVaultTx();
      await saveDeletedVaultTx();
      await logAudit('delete','الحركات المالية', `تم إلغاء (حذف منطقي) حركة خزنة قديمة رقم تسلسلي #${removedOld.seq||'—'} مرتبطة بعملية تمويل حقائب قبل تعديلها: ${fmt(num(removedOld.amount))} ﷼`);
    }
    bagStock[idx] = { ...bagStock[idx], type, date, amount, method, notes, manualQty };
    addedEntry = bagStock[idx];
  }else{
    snapshotState(type==='withdraw' ? `سحب مبلغ من حساب الحقائب: ${fmt(amount)}` : `إيداع مبلغ في حساب الحقائب: ${fmt(amount)}`);
    bagStock.push({
      id: uid(),
      createdAt: Date.now(),
      type,
      date,
      amount,
      method,
      notes,
      manualQty
    });
    addedEntry = bagStock[bagStock.length-1];
  }
  recalcBagFundLedger();
  await saveBagStock();
  await saveSettings();

  if(type==='withdraw'){
    await logAudit('edit','مخزون الحقائب', `${isEditing?'تم تعديل عملية سحب لتصبح':'تم سحب'} ${fmt(amount)} ﷼ من حساب تمويل الحقائب، ما أدى إلى خصم ${Math.abs(addedEntry.qty)} حقيبة من المخزون (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    // تُرحَّل الحركة إلى "الحركات المالية" كإضافة (وارد) لرصيد الخزنة (كاش) فقط إذا كان السحب "سحب نقدي"
    // (أي أن المبلغ خرج من حساب تمويل الحقائب وعاد كاشاً فعلياً للخزنة). أي طريقة سحب أخرى (سحب من الحساب
    // البنكي مثلاً) لا تُرحَّل لأن المبلغ لم يدخل فعلياً لرصيد الخزنة النقدي.
    if(method==='سحب نقدي' && settings.bagFinanceLinkEnabled!==false){
      const cashInTx = {
        id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
        type: 'in', date, amount, method,
        notes: `سحب نقدي من حساب تمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
        clientId: '', clientName: '', manual: 'سحب نقدي من مخزون الحقائب',
        category: 'تمويل مخزون الحقائب (سحب نقدي)', destination: 'vault', networkInvoice: '',
        bagStockRef: addedEntry.id
      };
      vaultTx.push(cashInTx);
      await saveVaultTx();
      await saveSettings();
      await logAudit('add','الحركات المالية', `تمت إضافة حركة وارد رقم تسلسلي #${cashInTx.seq}: إضافة ${fmt(amount)} ﷼ لرصيد الخزنة (كاش) من سحب نقدي من حساب تمويل مخزون الحقائب`);
    }
  }else{
    if(addedEntry.qty>0){
      await logAudit(isEditing?'edit':'add','مخزون الحقائب', `${isEditing?'تم تعديل عملية إيداع، وأصبحت تضيف':'تمت إضافة'} ${addedEntry.qty} حقيبة للمخزون من إيداع ${fmt(amount)} ﷼ (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    }else{
      await logAudit(isEditing?'edit':'add','مخزون الحقائب', `${isEditing?'تم تعديل عملية إيداع، وأصبح':'تم تسجيل'} إيداع ${fmt(amount)} ﷼ لحساب الحقائب — لم يكتمل بعد لشراء حقيبة كاملة (الرصيد الحالي: ${fmt(settings.bagFundBalance)})`);
    }
    // تُرحَّل الحركة إلى "الحركات المالية" كخصم من رصيد الخزنة (كاش) إذا كان الإيداع "كاش في الحساب البنكي"
    // أو "كاش مباشر" (أي أن المبلغ كان كاشاً خرج فعلياً من الخزنة). أي طريقة دفع أخرى (تحويل بنكي، دعم شركاء
    // أو غيرها) لا تُرحَّل لأن المبلغ لم يخرج فعلياً من رصيد الخزنة النقدي.
    if((method==='إيداع كاش في الحساب البنكي' || method==='كاش مباشر') && settings.bagFinanceLinkEnabled!==false){
      const cashOutTx = {
        id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
        type: 'out', date, amount, method,
        notes: `إيداع نقدي (${method}) لتمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
        clientId: '', clientName: '', manual: '',
        category: 'تمويل مخزون الحقائب (إيداع كاش بالبنك)', destination: 'vault', networkInvoice: '',
        bagStockRef: addedEntry.id
      };
      vaultTx.push(cashOutTx);
      await saveVaultTx();
      await saveSettings();
      await logAudit('add','الحركات المالية', `تمت إضافة حركة صادر رقم تسلسلي #${cashOutTx.seq}: خصم ${fmt(amount)} ﷼ من رصيد الخزنة (كاش) مقابل تمويل مخزون الحقائب (${method})`);
    }
  }
  const wasEditing = isEditing;
  cancelBagStockEdit();
  renderBags();
  showToast(wasEditing ? 'تم حفظ التعديل' : 'تم تسجيل العملية');
});

/* ---------------- إضافة حركات تمويل مخزون الحقائب دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الاستيراد من ملف Excel: نفس منطق الإدخال اليدوي من نموذج "تمويل مخزون الحقائب" أعلاه
   (بما في ذلك ترحيل أي مبلغ كاش فعلي من/إلى "الحركات المالية")، لكن عبر جدول صفوف متعددة داخل البرنامج. */
function bagFundTypeLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='سحب') return 'withdraw';
  return 'deposit';
}
let bagfundBulkRowSeq = 0;
function bagfundBulkRowHtml(rowId){
  const methodOptions = (settings.channels||[]).map(c=>`<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  return `<tr data-row="${rowId}">
    <td><input type="date" class="bfb-date" data-col="0" style="min-width:120px;"></td>
    <td><select class="bfb-type" data-col="1" style="min-width:100px;">
      <option value="deposit">إيداع</option>
      <option value="withdraw">سحب</option>
    </select></td>
    <td><input type="number" step="0.01" min="0" class="bfb-amount" data-col="2" style="min-width:100px;"></td>
    <td><select class="bfb-method" data-col="3" style="min-width:140px;"><option value="">— افتراضي —</option>${methodOptions}</select></td>
    <td><input type="number" step="1" min="0" class="bfb-qty" data-col="4" placeholder="تلقائي" style="min-width:100px;"></td>
    <td><input type="text" class="bfb-notes" data-col="5" style="min-width:150px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm bfb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBagfundBulkRow(){
  bagfundBulkRowSeq++;
  $('#bagfund-bulk-table-body').insertAdjacentHTML('beforeend', bagfundBulkRowHtml(bagfundBulkRowSeq));
}
function openBagfundBulkModal(){
  $('#bagfund-bulk-table-body').innerHTML = '';
  populateSelect($('#bagfund-bulk-default-method'), settings.channels.map(c=>c.name), false);
  const bankCh = (settings.channels||[]).find(c=>c.dest==='bank');
  $('#bagfund-bulk-default-method').value = bankCh ? bankCh.name : (settings.channels[0]?.name||'');
  for(let i=0;i<5;i++) addBagfundBulkRow();
  const firstDate = $('#bagfund-bulk-table-body').querySelector('.bfb-date');
  if(firstDate) firstDate.value = todayISO();
  $('#bagfund-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeBagfundBulkModal(){ $('#bagfund-bulk-overlay').classList.remove('show'); }
$('#btn-open-bagfund-bulk').addEventListener('click', openBagfundBulkModal);
$('#bagfund-bulk-cancel').addEventListener('click', closeBagfundBulkModal);
$('#bagfund-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='bagfund-bulk-overlay') closeBagfundBulkModal(); });
$('#btn-bagfund-bulk-row').addEventListener('click', addBagfundBulkRow);
$('#bagfund-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bfb-remove-row')){
    const rows = $('#bagfund-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bagfund-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#bagfund-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBagfundBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>5) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT'){
        const opt = [...field.options].find(o=>o.value===val.trim() || o.textContent.trim()===val.trim());
        if(opt) field.value = opt.value;
      }else{
        field.value = val.trim();
      }
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bagfund-bulk-save').addEventListener('click', async ()=>{
  const defaultMethod = $('#bagfund-bulk-default-method').value;
  const rows = [...$('#bagfund-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  rows.forEach((row, i)=>{
    const dateVal = row.querySelector('.bfb-date').value.trim();
    const typeVal = row.querySelector('.bfb-type').value;
    const amountVal = num(row.querySelector('.bfb-amount').value);
    const methodVal = row.querySelector('.bfb-method').value.trim();
    const qtyVal = row.querySelector('.bfb-qty').value.trim();
    const notesVal = row.querySelector('.bfb-notes').value.trim();
    if(!dateVal && !amountVal && !notesVal) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(amountVal<=0){ errors.push(`${rowLabel}: المبلغ مطلوب ويجب أن يكون أكبر من صفر`); return; }
    if(!dateVal){ errors.push(`${rowLabel}: التاريخ مطلوب`); return; }
    const method = methodVal || defaultMethod;
    if(!method){ errors.push(`${rowLabel}: طريقة الدفع مطلوبة`); return; }
    const manualQty = qtyVal ? Math.abs(Math.round(num(qtyVal))) : undefined;
    items.push({ date: dateVal, type: typeVal, amount: amountVal, method, notes: notesVal, manualQty });
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`إضافة حركات تمويل مخزون الحقائب من جدول داخل البرنامج (${items.length} صف)`);
  let added=0;
  const changedRows = [];
  for(const {date, type, amount, method, notes, manualQty} of items){
    bagStock.push({ id: uid(), createdAt: Date.now(), type, date, amount, method, notes, manualQty });
    recalcBagFundLedger();
    await saveBagStock();
    await saveSettings();
    const addedEntry = bagStock[bagStock.length-1];

    if(type==='withdraw'){
      if(method==='سحب نقدي' && settings.bagFinanceLinkEnabled!==false){
        const cashInTx = {
          id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
          type: 'in', date, amount, method,
          notes: `سحب نقدي من حساب تمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
          clientId: '', clientName: '', manual: 'سحب نقدي من مخزون الحقائب',
          category: 'تمويل مخزون الحقائب (سحب نقدي)', destination: 'vault', networkInvoice: '',
          bagStockRef: addedEntry.id
        };
        vaultTx.push(cashInTx);
        await saveVaultTx();
        await saveSettings();
      }
    }else{
      if((method==='إيداع كاش في الحساب البنكي' || method==='كاش مباشر') && settings.bagFinanceLinkEnabled!==false){
        const cashOutTx = {
          id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
          type: 'out', date, amount, method,
          notes: `إيداع نقدي (${method}) لتمويل مخزون الحقائب${notes ? ' — '+notes : ''}`,
          clientId: '', clientName: '', manual: '',
          category: 'تمويل مخزون الحقائب (إيداع كاش بالبنك)', destination: 'vault', networkInvoice: '',
          bagStockRef: addedEntry.id
        };
        vaultTx.push(cashOutTx);
        await saveVaultTx();
        await saveSettings();
      }
    }
    added++;
    changedRows.push({'التاريخ':date, 'النوع':type==='withdraw'?'سحب':'إيداع', 'المبلغ':amount, 'طريقة الدفع':method, 'عدد الحقائب الفعلي (كما أُدخل)':manualQty||'', 'عدد الحقائب (+/-)':addedEntry.qty, 'الرصيد بعد العملية':addedEntry.balanceAfter, 'ملاحظات':notes});
  }
  await logAudit('add','مخزون الحقائب', `إضافة حركات تمويل مخزون الحقائب من جدول داخل البرنامج: تمت إضافة ${added} حركة جديدة (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
  renderBags(); renderReports();
  downloadXlsx(`تقرير_إضافة_تمويل_الحقائب_${stampNow()}.xlsx`, 'تقرير الإضافة', changedRows);
  closeBagfundBulkModal();
  showToast(`تمت إضافة ${added} حركة جديدة`);
});

document.addEventListener('click', async e=>{
  if(e.target.closest('[data-refresh-bagstock]')){
    // إعادة حساب كامل: نُزامن أولاً أي بيانات قديمة غير متسقة، ثم نعيد رسم كل بطاقات/جداول الحقائب
    // من مصدرها الفعلي (شيت العملاء + سجل التمويل)، ونعرض الرقم الفعلي الناتج فوراً للمستخدم.
    await syncBagStockIssues();
    renderBags();
    const {purchasedQty} = bagStockTotals();
    showToast(`تم إعادة حساب كل أرقام الحقائب — المخزون الحالي فعلياً: ${purchasedQty}`);
    return;
  }
  if(e.target.dataset.buy){
    bagPurchaseTargetId = e.target.dataset.buy;
    $('#bp-date').value = todayISO();
    $('#bp-invoice').value = '';
    // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
    populateSelect($('#bp-method'), settings.channels.map(c=>c.name), false);
    { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#bp-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
    $('#bag-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.fromstock){
    const idx = clients.findIndex(c=>c.id===e.target.dataset.fromstock);
    if(idx>-1){
      const availableStock = bagStockTotals().purchasedQty;
      if(availableStock<=0){
        if(!await customConfirm(`المخزون الحالي المتاح هو ${availableStock} — لا توجد حقائب كافية بالمخزون. هل تريد المتابعة وتسليم الحقيبة من المخزون على أي حال؟`)) return;
      }
      snapshotState(`تسليم حقيبة من المخزون للعميل: ${clients[idx].name}`);
      clients[idx].bagSource = 'stock';
      clients[idx].bagStatus = 'purchased';
      clients[idx].bagPurchaseDate = clients[idx].bagPurchaseDate || todayISO();
      // نسجّل عملية التسليم كسطر مستقل في سجل عمليات مخزون الحقائب (وليس فقط كحقل في شيت العملاء)،
      // حتى يبقى "المخزون الحالي" مبنياً بالكامل على سجل العمليات نفسه ويمكن تتبعه وحذفه بدقة عند الإلغاء
      bagStock.push({
        id: uid(), type:'issue', qty:-1, unitPrice:0,
        date: clients[idx].bagPurchaseDate,
        createdAt: Date.now(),
        issuedClientId: clients[idx].id, issuedClientName: clients[idx].name,
        notes: `تسليم من المخزون للعميل: ${clients[idx].name}`
      });
      recalcBagFundLedger();
      await saveClients();
      await saveBagStock();
      await saveSettings();
      await logAudit('edit','مخزون الحقائب', `تم تسليم حقيبة من المخزون المتوفر للعميل: ${clients[idx].name} (بدلاً من شراء حقيبة جديدة)`);
      renderBags(); renderTable(); renderCourses(); renderMissingCourse();
      showToast('تم تسليم الحقيبة من المخزون');
    }
  }
  if(e.target.dataset.editstock){
    openBagStockEdit(e.target.dataset.editstock);
  }
  if(e.target.dataset.delstock){
    const removedPreview = bagStock.find(b=>b.id===e.target.dataset.delstock);
    const confirmMsg = removedPreview && removedPreview.type==='issue'
      ? `حذف عملية تسليم الحقيبة للعميل "${removedPreview.issuedClientName||''}"؟ ستعود حالة حقيبته إلى "مطلوب شراء" وتُضاف الحقيبة تلقائياً للمخزون المتاح.`
      : 'حذف هذه العملية من سجل التمويل؟ سيُعاد احتساب رصيد الحقائب والمخزون تلقائياً.';
    if(await customConfirm(confirmMsg)){
      if(editingBagStockId===e.target.dataset.delstock) cancelBagStockEdit();
      const removed = bagStock.find(b=>b.id===e.target.dataset.delstock);
      const removedDesc = removed ? (removed.type==='issue' ? `تسليم حقيبة للعميل: ${removed.issuedClientName||''}` : (removed.amount!==undefined ? `${removed.type==='withdraw'?'سحب':'إيداع'} ${fmt(num(removed.amount))} ﷼` : `${removed.qty||''} حقيبة`)) : '';
      snapshotState(`حذف عملية من سجل تمويل مخزون الحقائب: ${removedDesc}`);
      bagStock = bagStock.filter(b=>b.id!==e.target.dataset.delstock);
      recalcBagFundLedger();
      await saveBagStock();
      await saveSettings();
      // إن كانت عملية "تسليم من المخزون"، تعود حالة حقيبة العميل المرتبط إلى "مطلوب شراء" تلقائياً حتى تبقى بيانات
      // شيت العملاء متسقة مع سجل عمليات المخزون بعد حذف عملية التسليم منه مباشرة
      if(removed && removed.type==='issue' && removed.issuedClientId){
        const linkedClient = clients.find(c=>c.id===removed.issuedClientId);
        if(linkedClient && linkedClient.bagSource==='stock'){
          linkedClient.bagSource = 'buy';
          linkedClient.bagPrice = num(settings.bagPrice) || DEFAULT_SETTINGS.bagPrice;
          linkedClient.bagInvoice = '';
          linkedClient.bagStatus = 'pending';
          delete linkedClient.bagPurchaseDate;
          delete linkedClient.bagPaymentMethod;
          syncClientLedgerEntry(linkedClient);
          await saveClients();
          await saveVaultTx();
        }
      }
      // إذا كانت هذه العملية قد رُحِّلت سابقاً كخصم من الخزنة (كاش) — لأنها كانت إيداعاً كاشاً في البنك —
      // نحذف حركة الخصم المرتبطة بها من "الحركات المالية" أيضاً حتى لا يبقى رصيد الخزنة منقوصاً بلا سبب.
      const linkedTx = removed ? vaultTx.find(t=>t.bagStockRef===removed.id) : null;
      if(linkedTx){
        vaultTx = vaultTx.filter(t=>t.id!==linkedTx.id);
        await saveVaultTx();
        await logAudit('delete','الحركات المالية', `تم حذف حركة صادر مرتبطة بعملية تمويل محذوفة من مخزون الحقائب: خصم ${fmt(num(linkedTx.amount))} ﷼ من الخزنة (كاش)`);
      }
      await logAudit('delete','مخزون الحقائب', `تم حذف عملية من سجل التمويل بتاريخ ${removed?.date}: ${removedDesc} (تمت إعادة احتساب الرصيد والمخزون)`);
      renderBags(); renderTable(); renderCourses(); renderMissingCourse();
    }
  }
});
$('#bp-cancel').addEventListener('click', ()=>{ $('#bag-overlay').classList.remove('show'); bagPurchaseTargetId=null; });
$('#bag-overlay').addEventListener('click', e=>{ if(e.target.id==='bag-overlay'){ $('#bag-overlay').classList.remove('show'); bagPurchaseTargetId=null; } });
$('#bag-purchase-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const idx = clients.findIndex(c=>c.id===bagPurchaseTargetId);
  if(idx>-1){
    snapshotState(`تسجيل شراء حقيبة للعميل: ${clients[idx].name}`);
    clients[idx].bagStatus = 'purchased';
    clients[idx].bagPurchaseDate = $('#bp-date').value;
    clients[idx].bagPaymentMethod = $('#bp-method').value;
    if($('#bp-invoice').value.trim()) clients[idx].bagInvoice = $('#bp-invoice').value.trim();
    await saveClients();
    await logAudit('edit','مخزون الحقائب', `تم تسجيل شراء حقيبة للعميل: ${clients[idx].name}`);
  }
  $('#bag-overlay').classList.remove('show');
  bagPurchaseTargetId = null;
  renderBags(); renderTable(); renderCourses(); renderMissingCourse();
  showToast('تم تسجيل شراء الحقيبة');
});

/* خانة الشراء السريعة بجانب "مطلوب شراء" في شيت العملاء وشيت الدورات (بكل تبويباته):
   عند التأشير عليها يتم تسليم الحقيبة من مخزون الحقائب المتوفر مباشرة (شراء مباشر بفاتورة خاصة أُلغي نهائياً). */
document.addEventListener('change', async e=>{
  if(!e.target.dataset.bagbuy) return;
  const id = e.target.dataset.bagbuy;
  const idx = clients.findIndex(c=>c.id===id);
  e.target.checked = false; // الحالة الفعلية تُقرأ من bagStatus/bagSource بعد إعادة الرسم، وليس من الخانة نفسها
  if(idx===-1) return;
  const availableStock = bagStockTotals().purchasedQty;
  if(availableStock<=0){
    if(!await customConfirm(`المخزون الحالي المتاح هو ${availableStock} — لا توجد حقائب كافية بالمخزون. هل تريد المتابعة وتسليم الحقيبة من المخزون على أي حال؟`)) return;
  }else if(!await customConfirm(`تسليم حقيبة من المخزون المتوفر للعميل "${clients[idx].name}"؟`)){
    return;
  }
  snapshotState(`تسليم حقيبة من المخزون للعميل: ${clients[idx].name}`);
  clients[idx].bagSource = 'stock';
  clients[idx].bagStatus = 'purchased';
  clients[idx].bagPurchaseDate = clients[idx].bagPurchaseDate || todayISO();
  bagStock.push({
    id: uid(), type:'issue', qty:-1, unitPrice:0,
    date: clients[idx].bagPurchaseDate,
    createdAt: Date.now(),
    issuedClientId: clients[idx].id, issuedClientName: clients[idx].name,
    notes: `تسليم من المخزون للعميل: ${clients[idx].name} (من خانة الشراء السريعة)`
  });
  recalcBagFundLedger();
  await saveClients();
  await saveBagStock();
  await saveSettings();
  await logAudit('edit','مخزون الحقائب', `تم تسليم حقيبة من المخزون المتوفر للعميل: ${clients[idx].name} (من خانة الشراء السريعة)`);
  renderBags(); renderTable(); renderCourses(); renderMissingCourse();
  showToast('تم تسليم الحقيبة من المخزون');
});

/* ---------------- استيراد حركات وارد وصادر من Excel إلى الحركات المالية ---------------- */
function destLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='البنك') return 'bank';
  if(v==='الشبكة') return 'network';
  if(v==='الخزنة (كاش)' || v==='الخزنة' || v==='كاش') return 'vault';
  return 'vault';
}
function txTypeLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='وارد' || v==='وارد (إيراد)' || v.toLowerCase()==='in') return 'in';
  if(v==='صادر' || v==='صادر (مصروف)' || v.toLowerCase()==='out') return 'out';
  return '';
}
$('#btn-template-vault-expenses').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_حركات_مالية.xlsx', 'نموذج', [
    {'التاريخ':'2026-01-15', 'نوع الحركة':'وارد', 'المبلغ':1000, 'الحساب/الوجهة':'الخزنة (كاش)', 'طريقة الدفع':'كاش مباشر', 'رقم الهوية':'', 'البيان/الجهة':'دعم شركاء', 'التصنيف':'', 'اسم مستلم المبلغ':'', 'رقم فاتورة الشبكة':'', 'ملاحظات':''},
    {'التاريخ':'2026-01-16', 'نوع الحركة':'صادر', 'المبلغ':500, 'الحساب/الوجهة':'الخزنة (كاش)', 'طريقة الدفع':'كاش مباشر', 'رقم الهوية':'', 'البيان/الجهة':'', 'التصنيف':'إيجار', 'اسم مستلم المبلغ':'', 'رقم المستند':'', 'رقم فاتورة الشبكة':'', 'ملاحظات':''}
  ]);
});
$('#btn-import-vault-expenses').addEventListener('click', ()=> $('#import-vaultexp-input').click());
$('#import-vaultexp-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد حركات وارد وصادر من Excel');
    let addedIn=0, addedOut=0, skipped=0;
    const changedRows = [];
    for(const row of json){
      const amount = num(row['المبلغ']);
      const date = normalizeExcelDate(row['التاريخ']) || todayISO();
      const type = txTypeLabelToValue(row['نوع الحركة']);
      if(amount<=0 || !type){ skipped++; continue; }
      if(isDateLocked(date)){ skipped++; continue; } // تاريخ يقع ضمن فترة محاسبية مُقفلة — يُتخطى الصف
      const destination = destLabelToValue(row['الحساب/الوجهة']);
      const methodRaw2 = String(row['طريقة الدفع']||'').trim();
      const destCh = (settings.channels||[]).find(c=>c.dest===destination);
      const method = methodRaw2 ? canonicalizeChannelName(methodRaw2) : (destCh ? destCh.name : '');
      const notes = String(row['ملاحظات']||'').trim();
      const networkInvoice = destination==='network' ? String(row['رقم فاتورة الشبكة']||'').trim() : '';

      let newTx;
      if(type==='in'){
        const clientId = String(row['رقم الهوية']||'').trim();
        const client = clientId ? clients.find(c=>c.clientId===clientId) : null;
        newTx = {
          id: uid(), seq: allocVaultSeq(), createdAt: Date.now(), type:'in', isReturn:false,
          date, amount, method, notes,
          clientId: client ? clientId : '',
          clientName: client ? client.name : '',
          manual: !client ? String(row['البيان/الجهة']||'').trim() : '',
          category:'', recipientName:'',
          destination, networkInvoice
        };
        addedIn++;
        changedRows.push({'التاريخ':date, 'نوع الحركة':'وارد', 'المبلغ':amount, 'الحساب/الوجهة':destLabel(destination), 'طريقة الدفع':method, 'رقم الهوية':newTx.clientId, 'البيان/الجهة':newTx.manual, 'ملاحظات':notes});
      }else{
        const category = String(row['التصنيف']||'').trim();
        newTx = {
          id: uid(), seq: allocVaultSeq(), createdAt: Date.now(), type:'out', isReturn:false,
          date, amount, method, notes,
          clientId:'', clientName:'', manual:'',
          category,
          recipientName: String(row['اسم مستلم المبلغ']||'').trim(),
          referenceNo: String(row['رقم المستند']||'').trim(),
          destination, networkInvoice
        };
        if(category && !settings.expenseCategories.includes(category)) settings.expenseCategories.push(category);
        addedOut++;
        changedRows.push({'التاريخ':date, 'نوع الحركة':'صادر', 'المبلغ':amount, 'الحساب/الوجهة':destLabel(destination), 'طريقة الدفع':method, 'التصنيف':category, 'اسم مستلم المبلغ':newTx.recipientName, 'رقم فاتورة الشبكة':networkInvoice, 'ملاحظات':notes});
      }
      vaultTx.push(newTx);
    }
    await saveVaultTx();
    await saveSettings();
    const added = addedIn + addedOut;
    await logAudit('add','الحركات المالية', `استيراد حركات وارد وصادر من Excel: تمت إضافة ${addedIn} حركة وارد و${addedOut} حركة صادر${skipped?`، وتخطي ${skipped} صف بدون مبلغ أو نوع حركة صحيح`:''}`);
    renderVault(); renderReports();
    downloadXlsx(`تقرير_استيراد_حركات_مالية_${stampNow()}.xlsx`, 'تقرير الاستيراد', changedRows);
    showToast(`تم الاستيراد: ${addedIn} حركة وارد، ${addedOut} حركة صادر${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود أعمدة "المبلغ" و"نوع الحركة" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- مطابقة كشف الحساب البنكي ---------------- */
// يحاول ربط كل سطر غير مربوط في كشف الحساب المستورد بحركة "بنك" غير مربوطة في الحركات المالية،
// فقط عندما يوجد تطابق فريد (نفس التاريخ + نفس المبلغ + نفس اتجاه الحركة). لا يربط تلقائياً عند وجود أكثر من مرشح.
function autoMatchBankStatement(){
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId).map(r=>r.matchedTxId));
  const bankTx = vaultTx.filter(t=>t.destination==='bank');
  let matchedCount = 0;
  bankStatementRows.forEach(row=>{
    if(row.matchedTxId) return;
    const wantType = row.type==='credit' ? 'in' : 'out';
    const candidates = bankTx.filter(t=>!usedTxIds.has(t.id) && t.type===wantType && t.date===row.date && Math.abs(num(t.amount)-num(row.amount))<0.01);
    if(candidates.length===1){
      row.matchedTxId = candidates[0].id;
      usedTxIds.add(candidates[0].id);
      matchedCount++;
    }
  });
  return matchedCount;
}
// مرشحو الربط اليدوي لسطر معيّن: حركات بنك غير مربوطة، بنفس اتجاه الحركة، مرتّبة بحيث الأقرب بالمبلغ والتاريخ أولاً
function bankReconCandidatesFor(row){
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId && r.id!==row.id).map(r=>r.matchedTxId));
  const wantType = row.type==='credit' ? 'in' : 'out';
  return vaultTx.filter(t=>t.destination==='bank' && t.type===wantType && !usedTxIds.has(t.id))
    .sort((a,b)=>{
      const da = Math.abs(num(a.amount)-num(row.amount)), db = Math.abs(num(b.amount)-num(row.amount));
      if(da!==db) return da-db;
      return String(a.date).localeCompare(String(b.date));
    });
}
function renderBankRecon(){
  const wrap = $('#bankrecon-wrap');
  const summaryEl = $('#bankrecon-summary');
  if(!wrap || !summaryEl) return;
  const usedTxIds = new Set(bankStatementRows.filter(r=>r.matchedTxId).map(r=>r.matchedTxId));
  const bankTx = vaultTx.filter(t=>t.destination==='bank');
  const unmatchedRows = bankStatementRows.filter(r=>!r.matchedTxId);
  const matchedRows = bankStatementRows.filter(r=>r.matchedTxId);
  const unmatchedSystemTx = bankTx.filter(t=>!usedTxIds.has(t.id));
  const stmtNet = bankStatementRows.reduce((s,r)=> s + (r.type==='credit'? num(r.amount) : -num(r.amount)), 0);
  const systemNet = bankTx.reduce((s,t)=> s + (t.type==='in'? num(t.amount) : -num(t.amount)), 0);
  summaryEl.innerHTML = `
    <span>سطور كشف الحساب: <b class="mono">${bankStatementRows.length}</b></span>
    <span>مطابَقة: <b class="mono" style="color:var(--teal);">${matchedRows.length}</b></span>
    <span>غير مطابَقة: <b class="mono" style="color:var(--red);">${unmatchedRows.length}</b></span>
    <span>حركات "البنك" بالنظام غير مطابَقة: <b class="mono" style="color:var(--red);">${unmatchedSystemTx.length}</b></span>
    <span>صافي كشف الحساب: <b class="mono">${fmt(stmtNet)} ﷼</b></span>
    <span>صافي حركات البنك بالنظام: <b class="mono">${fmt(systemNet)} ﷼</b></span>
  `;
  if(!bankStatementRows.length){
    wrap.innerHTML = `<div class="empty-state" style="padding:20px;"><div class="big">🏦</div>لم يتم استيراد كشف حساب بنكي بعد</div>`;
    return;
  }
  const rowHtml = (row, matched)=>{
    const candidates = matched ? [] : bankReconCandidatesFor(row);
    const matchedTx = matched ? vaultTx.find(t=>t.id===row.matchedTxId) : null;
    return `<tr>
      <td class="mono">${row.date||''}</td>
      <td>${escapeHtml(row.description||'')}</td>
      <td>${row.type==='credit'?'إيداع':'سحب'}</td>
      <td class="mono">${fmt(num(row.amount))}</td>
      <td>${escapeHtml(row.reference||'')}</td>
      <td>${matched
        ? `<span class="hint" style="margin:0;">مربوطة بحركة #${matchedTx?matchedTx.seq:'—'} بتاريخ ${matchedTx?matchedTx.date:'—'}</span> <button type="button" class="btn btn-ghost btn-sm" data-unmatch="${row.id}">فك الربط</button>`
        : (candidates.length
            ? `<select data-select-for="${row.id}" style="max-width:220px; display:inline-block;">${candidates.map(c=>`<option value="${c.id}">#${c.seq} — ${c.date} — ${fmt(num(c.amount))} ﷼ — ${escapeHtml(c.clientName||c.manual||c.recipientName||c.category||'')}</option>`).join('')}</select> <button type="button" class="btn btn-gold btn-sm" data-match="${row.id}">ربط</button>`
            : `<span class="hint" style="margin:0;">لا توجد حركة بنك بالنظام بنفس الاتجاه غير مربوطة بعد لمطابقتها</span>`)
      } <button type="button" class="btn btn-ghost btn-sm" data-delrow="${row.id}">حذف السطر</button></td>
    </tr>`;
  };
  let html = `
    <div class="table-scroll">
      <table>
        <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>المرجع</th><th>المطابقة</th></tr></thead>
        <tbody id="bankrecon-stmt-body">
          ${unmatchedRows.map(r=>rowHtml(r,false)).join('') || '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">لا توجد سطور غير مطابَقة 🎉</td></tr>'}
        </tbody>
      </table>
    </div>`;
  if(bankReconShowMatched && matchedRows.length){
    html += `
    <h4 style="margin:14px 0 6px;">الحركات المطابَقة</h4>
    <div class="table-scroll">
      <table>
        <thead><tr><th>التاريخ</th><th>البيان</th><th>النوع</th><th>المبلغ</th><th>المرجع</th><th>المطابقة</th></tr></thead>
        <tbody id="bankrecon-matched-body">
          ${matchedRows.map(r=>rowHtml(r,true)).join('')}
        </tbody>
      </table>
    </div>`;
  }
  if(unmatchedSystemTx.length){
    html += `
    <h4 style="margin:14px 0 6px;">حركات "البنك" بالنظام غير المطابَقة مع كشف الحساب</h4>
    <div class="hint" style="margin-bottom:6px;">هذه حركات مسجّلة في شيت الحركات المالية بحساب "البنك" ولم تُطابَق مع أي سطر من كشف الحساب المستورد — قد تكون لم تظهر بعد في كشف البنك، أو تحتاج مراجعة.</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>الرقم التسلسلي</th><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>العميل / البيان</th></tr></thead>
        <tbody>
          ${unmatchedSystemTx.map(t=>`<tr><td class="mono">#${t.seq||'—'}</td><td class="mono">${t.date}</td><td>${t.type==='in'?'وارد':'صادر'}</td><td class="mono">${fmt(num(t.amount))}</td><td>${escapeHtml(t.clientName||t.manual||t.recipientName||t.category||'')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }
  wrap.innerHTML = html;
}
$('#btn-bankrecon-toggle-matched')?.addEventListener('click', ()=>{ bankReconShowMatched = !bankReconShowMatched; renderBankRecon(); });
$('#btn-template-bankrecon')?.addEventListener('click', ()=>{
  downloadXlsx('نموذج_كشف_حساب_بنكي.xlsx', 'كشف الحساب', [
    {'التاريخ':'2026-01-15', 'البيان':'تحويل وارد', 'نوع الحركة':'إيداع', 'المبلغ':1000, 'المرجع':''},
    {'التاريخ':'2026-01-16', 'البيان':'رسوم بنكية', 'نوع الحركة':'سحب', 'المبلغ':25, 'المرجع':''}
  ]);
});
function bankStmtTypeLabelToValue(l){
  const v = String(l||'').trim();
  if(v==='إيداع' || v==='دائن' || v.toLowerCase()==='credit' || v.toLowerCase()==='in') return 'credit';
  if(v==='سحب' || v==='مدين' || v.toLowerCase()==='debit' || v.toLowerCase()==='out') return 'debit';
  return '';
}
$('#btn-import-bankrecon')?.addEventListener('click', ()=> $('#import-bankrecon-input').click());
$('#import-bankrecon-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    let added=0, skipped=0;
    json.forEach(row=>{
      const amount = num(row['المبلغ']);
      const date = normalizeExcelDate(row['التاريخ']);
      const type = bankStmtTypeLabelToValue(row['نوع الحركة']);
      if(amount<=0 || !date || !type){ skipped++; return; }
      bankStatementRows.push({
        id: uid(), date, amount, type,
        description: String(row['البيان']||'').trim(),
        reference: String(row['المرجع']||'').trim(),
        matchedTxId: '', importedAt: Date.now()
      });
      added++;
    });
    await saveBankStatementRows();
    const autoMatched = autoMatchBankStatement();
    await saveBankStatementRows();
    renderBankRecon();
    showToast(`تم استيراد ${added} سطراً${skipped?`، وتخطي ${skipped} صف بدون تاريخ/مبلغ/نوع حركة صحيح`:''} — تمت مطابقة ${autoMatched} تلقائياً`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود أعمدة "التاريخ" و"المبلغ" و"نوع الحركة" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    e.target.value = '';
  }
});
$('#btn-bankrecon-clear')?.addEventListener('click', async ()=>{
  if(!bankStatementRows.length){ showToast('لا يوجد كشف حساب مستورد أصلاً'); return; }
  if(!await customConfirm('سيتم مسح كل سطور كشف الحساب البنكي المستورد وكل الربط الحالي معها. هذا لا يؤثر على الحركات المالية نفسها. متابعة؟')) return;
  bankStatementRows = [];
  await saveBankStatementRows();
  renderBankRecon();
  showToast('تم مسح كشف الحساب المستورد');
});
document.addEventListener('click', async e=>{
  const matchId = e.target?.dataset?.match;
  const unmatchId = e.target?.dataset?.unmatch;
  const delId = e.target?.dataset?.delrow;
  if(matchId){
    const sel = document.querySelector(`select[data-select-for="${matchId}"]`);
    const txId = sel && sel.value;
    if(!txId){ showToast('اختر حركة من القائمة أولاً'); return; }
    const row = bankStatementRows.find(r=>r.id===matchId);
    if(row){ row.matchedTxId = txId; await saveBankStatementRows(); showToast('تم الربط'); renderBankRecon(); }
  }
  if(unmatchId){
    const row = bankStatementRows.find(r=>r.id===unmatchId);
    if(row){ row.matchedTxId = ''; await saveBankStatementRows(); showToast('تم فك الربط'); renderBankRecon(); }
  }
  if(delId){
    if(!await customConfirm('حذف هذا السطر من كشف الحساب المستورد؟ هذا لا يحذف أي حركة مالية.')) return;
    bankStatementRows = bankStatementRows.filter(r=>r.id!==delId);
    await saveBankStatementRows();
    renderBankRecon();
  }
});

/* ---------------- Vault (الخزنة) ---------------- */
$('#btn-template-bag-invoices').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_فواتير_الحقائب.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم فاتورة الحقيبة':'INV-0001', 'تاريخ شراء الحقيبة':'2026-01-15'}
  ]);
});
$('#btn-import-bag-invoices').addEventListener('click', ()=> $('#import-baginv-input').click());
$('#import-baginv-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد فواتير الحقائب من Excel');
    let updated=0, skipped=0, bagStockChanged=false;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const bagInvoice = String(row['رقم فاتورة الحقيبة']||'').trim();
      const bagDate = normalizeExcelDate(row['تاريخ شراء الحقيبة']);
      if(!clientId || (!bagInvoice && !bagDate)){ skipped++; continue; }
      const c = clients.find(x=>x.clientId===clientId);
      if(!c){ skipped++; continue; }
      const oldInvoice = c.bagInvoice||'', oldDate = c.bagPurchaseDate||'', oldSource = c.bagSource;
      if(bagInvoice) c.bagInvoice = bagInvoice;
      if(bagDate) c.bagPurchaseDate = bagDate;
      // تم إلغاء "الشراء المباشر" نهائياً: استيراد فاتورة/تاريخ شراء لعميل يعني أن حقيبته تُسلَّم من
      // المخزون، لذلك يُحدَّث "مصدر الحقيبة" في شيت العميل تلقائياً إلى "من المخزون" مهما كان مصدرها
      // السابق، ويُضاف سطر "تسليم" مقابل في سجل مخزون الحقائب حتى يبقى الرصيد متسقاً (إن لم يكن مسجَّلاً له بالفعل).
      if(!c.bagPurchaseDate) c.bagPurchaseDate = todayISO();
      c.bagSource = 'stock';
      c.bagStatus = 'purchased';
      if(oldSource!=='stock' || !bagStock.some(b=>b.type==='issue' && b.issuedClientId===c.id)){
        bagStock.push({
          id: uid(), type:'issue', qty:-1, unitPrice:0,
          date: c.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: c.id, issuedClientName: c.name,
          notes: `تسليم من المخزون للعميل: ${c.name} (استيراد فواتير/تواريخ الحقائب)`
        });
        bagStockChanged = true;
      }
      updated++;
      changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name, 'مصدر الحقيبة (قديم)':bagSourceLabel({...c, bagSource:oldSource}), 'مصدر الحقيبة (جديد)':bagSourceLabel(c), 'رقم فاتورة الحقيبة (قديم)':oldInvoice, 'رقم فاتورة الحقيبة (جديد)':c.bagInvoice||'', 'تاريخ الشراء (قديم)':oldDate, 'تاريخ الشراء (جديد)':c.bagPurchaseDate||''});
    }
    if(bagStockChanged) recalcBagFundLedger();
    await saveClients();
    if(bagStockChanged) await saveBagStock();
    await saveSettings();
    await logAudit('edit','مخزون الحقائب', `استيراد أرقام فواتير/تواريخ شراء الحقائب من Excel: تحديث ${updated} عميل (تم تسليم حقائبهم من المخزون تلقائياً)${skipped?`، وتخطي ${skipped} صف`:''}`);
    renderTable(); renderBags();
    // تقرير بالبيانات التي تم تحديثها فعلياً
    downloadXlsx(`تقرير_استيراد_فواتير_الحقائب_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
    showToast(`تم تحديث ${updated} عميل${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من أعمدة "رقم الهوية" و"رقم فاتورة الحقيبة" / "تاريخ شراء الحقيبة"');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- حذف حقائب مجموعة عملاء دفعة واحدة عبر استيراد ملف Excel (بعمود "رقم الهوية") ---------------- */
$('#btn-template-bag-delete-list').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_قائمة_حذف_حقائب.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890'}, {'رقم الهوية':'0987654321'}
  ]);
});
$('#btn-import-bag-delete-list').addEventListener('click', ()=> $('#import-bagdelete-input').click());
$('#import-bagdelete-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const idsInFile = [...new Set(json.map(r=>String(r['رقم الهوية']||'').trim()).filter(Boolean))];
    if(!idsInFile.length){ showToast('لم يتم العثور على عمود "رقم الهوية" في الملف أو أنه فارغ'); return; }
    const notFoundCount = idsInFile.filter(id=>!clients.some(c=>c.clientId===id)).length;
    const alreadyPendingCount = idsInFile.filter(id=>{ const c=clients.find(x=>x.clientId===id); return c && clientBagIsClean(c); }).length;
    const matched = clients.filter(c=>idsInFile.includes(c.clientId) && !clientBagIsClean(c));
    if(!matched.length){ showToast('كل العملاء المطابقين بأرقام الهوية في الملف بحالة "مطلوب شراء" أصلاً — لا يوجد شيء لحذفه'); return; }
    const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
    const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
    const ignoredNotes = [
      notFoundCount ? `${notFoundCount} رقم هوية غير موجود أصلاً في النظام` : '',
      alreadyPendingCount ? `${alreadyPendingCount} عميل بحالة "مطلوب شراء" أصلاً` : ''
    ].filter(Boolean).join(' — ');
    const ignoredMsg = ignoredNotes ? `\n(تنبيه: سيتم تجاهل ${ignoredNotes})` : '';
    if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق لأرقام الهوية في الملف. تأكيد حذف حقائبهم دفعة واحدة؟ سيتم مسحها بالكامل من سجل شراء الحقائب المكتملة ومن سجل "اشتروا حقائبهم الخاصة"، وتعود حالتهم إلى "مطلوب شراء" بقيمة الحقيبة الافتراضية، وتُعاد أي حقيبة من المخزون تلقائياً لرصيد التمويل. (${namesPreview}${extra})${ignoredMsg}\nهذا الإجراء لا يمكن التراجع عنه إلا من نسخة احتياطية.`)){ e.target.value=''; return; }
    snapshotState(`حذف حقائب عبر استيراد Excel (${matched.length} عميل)`);
    const removedNames = matched.map(c=>c.name);
    matched.forEach(c=> resetClientBagToPending(c));
    await saveClients(); await saveVaultTx(); await saveBagStock(); await saveSettings();
    await logAudit('delete','مخزون الحقائب', `تم حذف حقائب ${matched.length} عميل عبر استيراد ملف Excel (عادت حالتهم إلى "مطلوب شراء"): ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}${ignoredNotes?` — تم تجاهل: ${ignoredNotes}`:''}`);
    renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
    if(typeof renderVault==='function') renderVault();
    showToast(`تم حذف حقائب ${matched.length} عميل${(notFoundCount+alreadyPendingCount)?`، وتجاهل ${notFoundCount+alreadyPendingCount} صف`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أنه بصيغة Excel صحيحة وبه عمود "رقم الهوية"');
  }finally{
    e.target.value = '';
  }
});

/* ---------------- تحديد مجموعة عملاء دفعة واحدة كـ"اشتروا حقيبتهم الخاصة" عبر استيراد ملف Excel (بعمود "رقم الهوية") ---------------- */
$('#btn-template-bag-own-list').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_عملاء_حقيبتهم_الخاصة.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890'}, {'رقم الهوية':'0987654321'}
  ]);
});
$('#btn-import-bag-own-list').addEventListener('click', ()=> $('#import-bagown-input').click());
$('#import-bagown-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const idsInFile = [...new Set(json.map(r=>String(r['رقم الهوية']||'').trim()).filter(Boolean))];
    if(!idsInFile.length){ showToast('لم يتم العثور على عمود "رقم الهوية" في الملف أو أنه فارغ'); return; }
    const notFoundCount = idsInFile.filter(id=>!clients.some(c=>c.clientId===id)).length;
    const alreadyOwnCount = idsInFile.filter(id=>{ const c=clients.find(x=>x.clientId===id); return c && c.bagSource==='own'; }).length;
    const matched = clients.filter(c=>idsInFile.includes(c.clientId) && c.bagSource!=='own');
    if(!matched.length){ showToast('كل العملاء المطابقين بأرقام الهوية في الملف مسجَّلين أصلاً كـ"اشتروا حقيبتهم الخاصة" — لا يوجد شيء لتحديثه'); return; }
    const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
    const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
    const ignoredNotes = [
      notFoundCount ? `${notFoundCount} رقم هوية غير موجود أصلاً في النظام` : '',
      alreadyOwnCount ? `${alreadyOwnCount} عميل مسجَّل بالفعل كـ"اشترى حقيبته الخاصة"` : ''
    ].filter(Boolean).join(' — ');
    const ignoredMsg = ignoredNotes ? `\n(تنبيه: سيتم تجاهل ${ignoredNotes})` : '';
    if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق لأرقام الهوية في الملف. تأكيد اعتبار هؤلاء العملاء ممن اشتروا حقيبتهم الخاصة؟ ستُصبح قيمة الحقيبة صفراً لكل منهم فوراً في شيت العملاء، وسيختفون من "حقائب يجب شراؤها" ومن "سجل عمليات شراء الحقائب المكتملة" إن كانوا مسجّلين في أيّ منهما، ولن تُحتسب عليهم أي قيمة حقيبة ضمن حصيلة/تحصيل الحقائب بعد الآن. (${namesPreview}${extra})${ignoredMsg}\nهذا الإجراء لا يمكن التراجع عنه إلا من نسخة احتياطية.`)){ e.target.value=''; return; }
    snapshotState(`استيراد قائمة عملاء اشتروا حقيبتهم الخاصة (${matched.length} عميل)`);
    const namesAll = matched.map(c=>c.name);
    matched.forEach(c=> markClientBagOwn(c));
    await saveClients(); await saveVaultTx();
    await logAudit('edit','مخزون الحقائب', `تم تحديد ${matched.length} عميل كـ"اشتروا حقيبتهم الخاصة" عبر استيراد ملف Excel (أصبحت قيمة حقيبتهم صفراً ولم تعد تُحتسب ضمن تحصيل الحقائب): ${namesAll.slice(0,20).join('، ')}${namesAll.length>20?` وآخرين (${namesAll.length-20})`:''}${ignoredNotes?` — تم تجاهل: ${ignoredNotes}`:''}`);
    renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
    if(typeof renderVault==='function') renderVault();
    showToast(`تم تحديث ${matched.length} عميل${(notFoundCount+alreadyOwnCount)?`، وتجاهل ${notFoundCount+alreadyOwnCount} صف`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أنه بصيغة Excel صحيحة وبه عمود "رقم الهوية"');
  }finally{
    e.target.value = '';
  }
});

function removeClientLedgerEntries(clientRecordId){
  vaultTx = vaultTx.filter(t=>t.autoClientId!==clientRecordId);
}
function syncClientLedgerEntry(client){
  // نحافظ على الرقم التسلسلي الرسمي القديم لهذين القيدين إن كانا موجودين مسبقاً (يُعاد توليدهما عند كل حفظ لبيانات العميل)
  const prevSeqs = {};
  vaultTx.filter(t=>t.autoClientId===client.id).forEach(t=>{ prevSeqs[t.id] = t.seq; });
  removeClientLedgerEntries(client.id);
  if(num(client.paid)>0){
    const chan = settings.channels.find(c=>c.name===client.channel);
    const dest = chan ? chan.dest : 'other';
    // ملاحظة: يتم ترحيل الدفعة دائماً (حتى لو كانت طريقة الدفع "أخرى" مثل طبي/المركز) حتى تُحتسب
    // ضمن "إجمالي المدفوع" لبيانات العميل — لكنها لا تدخل ضمن أرصدة الخزنة/البنك/الشبكة (balanceOf يتجاهل "أخرى").
    vaultTx.push({
      id:'auto_'+client.id,
      seq: prevSeqs['auto_'+client.id] || allocVaultSeq(),
      type:'in',
      date: client.date || todayISO(),
      amount: num(client.paid),
      destination: dest,
      clientId: client.clientId,
      clientName: client.name,
      method: client.channel,
      category:'',
      manual:'',
      networkInvoice: dest==='network' ? (client.networkInvoice||'') : '',
      notes: dest==='other' ? 'ترحيل تلقائي من سجل العميل (تسوية خارج حسابات الخزنة/البنك/الشبكة)' : 'ترحيل تلقائي من سجل العميل' + (num(client.paid2)>0 ? ' — الدفعة الأولى من دفعتين' : ''),
      autoClientId: client.id,
      createdAt: Date.now()
    });
  }
  if(num(client.paid2)>0){
    const chan2 = settings.channels.find(c=>c.name===client.channel2);
    const dest2 = chan2 ? chan2.dest : 'other';
    vaultTx.push({
      id:'auto2_'+client.id,
      seq: prevSeqs['auto2_'+client.id] || allocVaultSeq(),
      type:'in',
      date: client.date || todayISO(),
      amount: num(client.paid2),
      destination: dest2,
      clientId: client.clientId,
      clientName: client.name,
      method: client.channel2,
      category:'',
      manual:'',
      networkInvoice: dest2==='network' ? (client.networkInvoice2||'') : '',
      notes: dest2==='other' ? 'ترحيل تلقائي من سجل العميل (تسوية خارج حسابات الخزنة/البنك/الشبكة)' : 'ترحيل تلقائي من سجل العميل — الدفعة الثانية من دفعتين',
      autoClientId: client.id,
      createdAt: Date.now()
    });
  }
}
/* اتجاه يومي (وارد/صادر/صافي) لنتائج الفلتر الحالي في شاشة الحركات المالية */
function vaultFilteredDailyTrend(rows){
  const map = {};
  rows.forEach(t=>{
    const d = t.date || '—';
    if(!map[d]) map[d] = {in:0, out:0};
    if(t.type==='in') map[d].in += num(t.amount); else map[d].out += num(t.amount);
  });
  const labels = Object.keys(map).sort((a,b)=>a.localeCompare(b));
  const income = labels.map(d=>Math.round(map[d].in*100)/100);
  const expense = labels.map(d=>Math.round(map[d].out*100)/100);
  const net = labels.map((d,i)=>Math.round((income[i]-expense[i])*100)/100);
  return { labels, series:[
    {name:'وارد', color:'var(--teal)', values:income},
    {name:'صادر', color:'var(--red)', values:expense},
    {name:'الصافي', color:'var(--gold-dark)', values:net},
  ]};
}
/* توزيع نتائج الفلتر الحالي حسب طريقة الدفع */
function vaultFilteredMethodTotals(rows){
  const map = {};
  rows.forEach(t=>{ const k = t.method || 'غير محدد'; map[k] = (map[k]||0) + num(t.amount); });
  return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]);
}
/* أرقام الهوية التي تتكرر أكثر من مرة ضمن كل حركات الخزنة/البنك/الشبكة (بغض النظر عن الفلتر الحالي) */
function vaultDuplicateClientIds(){
  const counts = {};
  vaultTx.forEach(t=>{ if(t.clientId) counts[t.clientId] = (counts[t.clientId]||0)+1; });
  const dup = new Set();
  Object.keys(counts).forEach(id=>{ if(counts[id]>1) dup.add(id); });
  return dup;
}
function vaultFilteredRows(){
  const from = $('#v-from').value;
  const to = $('#v-to').value;
  const type = $('#v-filter-type').value;
  const dest = $('#v-filter-dest').value;
  const q = $('#v-search').value.trim().toLowerCase();
  const dupOnly = $('#v-filter-dup')?.checked;
  const dupIds = dupOnly ? vaultDuplicateClientIds() : null;
  const noMethodOnly = $('#v-filter-nomethod')?.checked;
  return vaultTx.filter(t=>{
    if(from && t.date < from) return false;
    if(to && t.date > to) return false;
    if(type && t.type!==type) return false;
    if(dest && (t.destination||'vault')!==dest) return false;
    if(dupOnly && !(t.clientId && dupIds.has(t.clientId))) return false;
    if(noMethodOnly && String(t.method||'').trim()) return false;
    if(q){
      const hay = [t.clientName,t.clientId,t.manual,t.category,t.notes].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
}
function balanceOf(dest){
  return vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='in').reduce((s,t)=>s+num(t.amount),0)
       - vaultTx.filter(t=>(t.destination||'vault')===dest && t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
function seqNumbers(){
  const map = {};
  ['vault','bank','network'].forEach(dest=>{
    const list = vaultTx.filter(t=>(t.destination||'vault')===dest)
      .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (a.createdAt||0)-(b.createdAt||0));
    list.forEach((t,i)=>{ map[t.id] = i+1; });
  });
  return map;
}
let vaultCurrentPage = 1;
let vaultLastFilterSig = '';
let selectedVaultIds = new Set();
let currentPageVaultIds = [];
function currentVaultPageSize(){
  const v = $('#vault-page-size')?.value || '100';
  return v==='all' ? Infinity : Number(v);
}
function renderVault(){
  renderVaultLockStatus();
  if(typeof renderBankRecon==='function') renderBankRecon();
  populateSelect($('#vf-category'), settings.expenseCategories, false);
  const dl = $('#dl-clients');
  dl.innerHTML = clients.filter(c=>c.clientId).map(c=>`<option value="${escapeHtml(c.clientId)}" label="${escapeHtml(c.name)}"></option>`).join('');

  const rows = vaultFilteredRows();
  const periodIn = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const periodOut = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const netOfDestFiltered = dest => rows.filter(t=>(t.destination||'vault')===dest)
    .reduce((s,t)=> s + (t.type==='in' ? num(t.amount) : -num(t.amount)), 0);

  $('#vault-cards').innerHTML = `
    <div class="card"><div class="k">الخزنة (كاش) — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('vault')<0?'red':''}">${fmt(netOfDestFiltered('vault'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('vault'))}</div></div>
    <div class="card"><div class="k">البنك — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('bank')<0?'red':'teal'}">${fmt(netOfDestFiltered('bank'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('bank'))}</div></div>
    <div class="card"><div class="k">الشبكة — حسب الفلتر الحالي</div><div class="v ${netOfDestFiltered('network')<0?'red':'gold'}">${fmt(netOfDestFiltered('network'))}</div><div style="font-size:11px; color:var(--text-muted); margin-top:4px;">الرصيد الفعلي الكلي (بدون فلتر): ${fmt(balanceOf('network'))}</div></div>
    <div class="card"><div class="k">صافي الفترة المحددة (كل الحسابات المفلترة)</div><div class="v">${fmt(periodIn-periodOut)}</div></div>
  `;

  $('#vault-empty').style.display = rows.length ? 'none' : 'block';

  // إعادة الصفحة إلى الأولى تلقائياً كلما تغيّر البحث أو أي فلتر (وليس عند التنقّل بين الصفحات فقط)
  const vaultFilterSig = JSON.stringify([
    $('#v-from')?.value, $('#v-to')?.value, $('#v-filter-type')?.value, $('#v-filter-dest')?.value,
    $('#v-search')?.value, $('#v-filter-dup')?.checked, $('#v-filter-nomethod')?.checked
  ]);
  if(vaultFilterSig !== vaultLastFilterSig){ vaultCurrentPage = 1; vaultLastFilterSig = vaultFilterSig; }

  const vPageSize = currentVaultPageSize();
  const vTotalPages = Number.isFinite(vPageSize) ? Math.max(1, Math.ceil(rows.length/vPageSize)) : 1;
  if(vaultCurrentPage > vTotalPages) vaultCurrentPage = vTotalPages;
  if(vaultCurrentPage < 1) vaultCurrentPage = 1;
  const pageRows = Number.isFinite(vPageSize) ? rows.slice((vaultCurrentPage-1)*vPageSize, vaultCurrentPage*vPageSize) : rows;
  currentPageVaultIds = pageRows.map(t=>t.id);
  // نحذف من التحديد أي حركة لم تعد موجودة أصلاً (أُلغيت من مكان آخر)، حتى لا يبقى تحديد "شبح"
  const allVaultTxIds = new Set(vaultTx.map(t=>t.id));
  [...selectedVaultIds].forEach(id=>{ if(!allVaultTxIds.has(id)) selectedVaultIds.delete(id); });
  renderVaultBulkBar(rows);

  const vPag = $('#vault-table-pagination');
  if(vPag){
    vPag.style.display = rows.length ? '' : 'none';
    const vStartN = rows.length ? (vaultCurrentPage-1)*(Number.isFinite(vPageSize)?vPageSize:rows.length)+1 : 0;
    const vEndN = Number.isFinite(vPageSize) ? Math.min(rows.length, vaultCurrentPage*vPageSize) : rows.length;
    $('#vault-page-info').textContent = rows.length ? `عرض ${vStartN} - ${vEndN} من ${rows.length}` : '';
    $('#vault-page-current').textContent = `صفحة ${vaultCurrentPage} / ${vTotalPages}`;
    $('#vault-page-first').disabled = vaultCurrentPage<=1;
    $('#vault-page-prev').disabled = vaultCurrentPage<=1;
    $('#vault-page-next').disabled = vaultCurrentPage>=vTotalPages;
    $('#vault-page-last').disabled = vaultCurrentPage>=vTotalPages;
  }

  const seq = seqNumbers();
  const dupIdsForHighlight = vaultDuplicateClientIds();
  $('#vault-table-body').innerHTML = pageRows.map(t=>{
    const isDup = !!(t.clientId && dupIdsForHighlight.has(t.clientId));
    return `
    <tr ${isDup?'style="background:rgba(180,72,58,.08);"':''}>
      <td><input type="checkbox" class="row-select-vault" data-id="${t.id}" ${selectedVaultIds.has(t.id)?'checked':''}></td>
      <td class="mono" style="font-weight:700;">#${t.seq||'—'}</td>
      <td class="mono">${destLabel(t.destination||'vault').split(' ')[0]}-${seq[t.id]||'—'}</td>
      <td class="mono">${t.date||'—'}</td>
      <td><span class="stamp paid">${destLabel(t.destination||'vault')}</span></td>
      <td><span class="stamp ${t.type==='in'?'paid':'owe'}">${t.type==='in'?'وارد':(t.isReturn?'مردود مبيعات':'صادر')}</span></td>
      <td class="mono"${isDup?' style="color:var(--red); font-weight:700;" title="رقم هوية مكرر — ظهر أكثر من مرة في حركات الخزنة/البنك/الشبكة"':''}>${escapeHtml(t.clientId||'—')}${isDup?' ⚠️':''}</td>
      <td>${escapeHtml((t.type==='in' || t.isReturn) ? (t.clientName || t.manual || '—') : (t.category||'—'))}</td>
      <td>${escapeHtml(t.type==='out' ? (t.category||'—') : '—')}${(t.type==='out' && t.referenceNo) ? `<br><span style="font-size:11px; color:var(--text-muted);">مستند: ${escapeHtml(t.referenceNo)}</span>` : ''}</td>
      <td>${escapeHtml(t.method||'')}</td>
      <td class="mono">${escapeHtml(t.networkInvoice||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
      <td>${escapeHtml(t.notes||'')}</td>
      <td style="white-space:nowrap;">
        ${(t.type==='in' && t.autoClientId) ? `<span class="hint" style="margin:0; display:inline-block; font-size:11px;">🔗 دفعة تسجيل — التعديل من شيت العملاء</span>` : `<button class="btn btn-ghost btn-sm" data-vedit="${t.id}">${tr('edit')}</button>`}
        ${t.isReturn ? `<button class="btn btn-gold btn-sm" data-vprintreturn="${t.id}">طباعة فاتورة الاسترجاع</button>` : ''}
        ${(t.type==='out' && !t.isReturn) ? `<button class="btn btn-gold btn-sm" data-vvoucher="${t.id}">طباعة سند صرف</button>` : ''}
        <button class="btn btn-danger btn-sm" data-vdel="${t.id}">${tr('delete')}</button>
      </td>
    </tr>`;
  }).join('');


  const catTotals = {};
  rows.filter(t=>t.type==='out').forEach(t=>{ const k=t.category||'أخرى'; catTotals[k]=(catTotals[k]||0)+num(t.amount); });
  drawBars('#chart-expense-cat', Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));

  const dailyTrend = vaultFilteredDailyTrend(rows);
  drawLineChart('#chart-vault-daily', dailyTrend.labels, dailyTrend.series);
  drawBars('#chart-vault-method', vaultFilteredMethodTotals(rows));

  ensureDenomUiBuilt();
  recalcDenomTable();
  renderDenomHistory();
}

/* ---------------- تصنيف الفئات النقدية بالخزنة (سجل حركات دخول/خروج) ----------------
   رصيد كل فئة نقدية = مجموع كل حركات "دخول" ناقص مجموع كل حركات "خروج" لتلك الفئة
   من سجل vaultDenomTx (يشمل أيضاً حركات "تسوية جرد" التي تُنشأ تلقائياً عند تصحيح
   الرصيد من واقع عدّ فعلي). هذا سجل منفصل تماماً عن الحركات المالية ولا يدخل ضمن
   أي رصيد محاسبي — فقط لمتابعة تركيبة النقد الموجود فعلياً بالخزنة والمقارنة
   بإجمالي رصيد "الخزنة (كاش)" الفعلي (balanceOf('vault')). */
const CASH_DENOMINATIONS = [500,200,100,50,20,10,5,2,1,0.5];
function denomBalance(denom){
  return vaultDenomTx.filter(t=>Number(t.denom)===denom && t.type==='in').reduce((s,t)=>s+num(t.count),0)
       - vaultDenomTx.filter(t=>Number(t.denom)===denom && t.type==='out').reduce((s,t)=>s+num(t.count),0);
}
function ensureDenomUiBuilt(){
  const headerRow = $('#cash-count-header-row');
  if(!headerRow || headerRow.dataset.built) return;
  headerRow.dataset.built = '1';
  headerRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<th class="mono">${fmt(d)} ﷼</th>`).join(''));
  const countRow = $('#cash-count-row-count');
  if(countRow) countRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<td class="mono" data-denom-count="${d}">0</td>`).join(''));
  const valueRow = $('#cash-count-row-value');
  if(valueRow) valueRow.insertAdjacentHTML('beforeend', CASH_DENOMINATIONS.map(d=>`<td class="mono" data-denom-value="${d}">0</td>`).join(''));
  const grandTotalCell = $('#cash-count-grand-total');
  if(grandTotalCell) grandTotalCell.setAttribute('colspan', CASH_DENOMINATIONS.length);
  const denomOptionsHtml = CASH_DENOMINATIONS.map(d=>`<option value="${d}">${fmt(d)} ﷼</option>`).join('');
  if($('#denom-adj-denom')) $('#denom-adj-denom').innerHTML = denomOptionsHtml;
  if($('#denom-tx-batch-body')) $('#denom-tx-batch-body').innerHTML = CASH_DENOMINATIONS.map(d=>`
    <tr>
      <td>${fmt(d)} ﷼</td>
      <td><input type="number" min="0" step="1" data-batch-denom-count="${d}" placeholder="0" style="max-width:110px;"></td>
    </tr>
  `).join('');
  if($('#denom-tx-date') && !$('#denom-tx-date').value) $('#denom-tx-date').value = todayISO();
  if($('#denom-adj-date') && !$('#denom-adj-date').value) $('#denom-adj-date').value = todayISO();
  $('#btn-denom-tx-save')?.addEventListener('click', saveDenomTx);
  $('#btn-denom-adj-save')?.addEventListener('click', saveDenomAdjustment);
}
function recalcDenomTable(){
  let total = 0;
  CASH_DENOMINATIONS.forEach(d=>{
    const count = denomBalance(d);
    const value = count*d;
    total += value;
    const countEl = document.querySelector(`[data-denom-count="${d}"]`);
    const valueEl = document.querySelector(`[data-denom-value="${d}"]`);
    if(countEl) countEl.textContent = fmt(count);
    if(valueEl) valueEl.textContent = fmt(value);
  });
  if($('#cash-count-grand-total')) $('#cash-count-grand-total').textContent = fmt(total);
  const vaultBalance = balanceOf('vault');
  const diff = total - vaultBalance;
  const matched = Math.abs(diff) < 0.005;
  const diffColor = matched ? 'var(--teal)' : 'var(--red)';
  const compareEl = $('#cash-count-compare');
  if(compareEl){
    compareEl.innerHTML = `
      <span>رصيد الخزنة (كاش) الفعلي حسب الحركات المالية: <b class="mono">${fmt(vaultBalance)} ﷼</b></span>
      <span>إجمالي تصنيف الفئات الحالي: <b class="mono">${fmt(total)} ﷼</b></span>
      <span>الفرق: <b class="mono" style="color:${diffColor};">${fmt(diff)} ﷼</b> ${matched ? '✓ مطابق' : (diff>0?'(الفئات المسجّلة أكثر من رصيد الخزنة)':'(الفئات المسجّلة أقل من رصيد الخزنة)')}</span>
    `;
  }
  return total;
}
async function saveDenomTx(){
  const type = $('#denom-tx-type')?.value || 'in';
  const date = $('#denom-tx-date')?.value || todayISO();
  const notes = $('#denom-tx-notes')?.value.trim() || '';
  const lines = CASH_DENOMINATIONS.map(d=>{
    const el = document.querySelector(`[data-batch-denom-count="${d}"]`);
    const count = Math.floor(num(el?.value));
    return { denom: d, count };
  }).filter(l=>l.count>0);
  if(!lines.length){
    showToast('أدخل عدداً أكبر من صفر لفئة واحدة على الأقل');
    return;
  }
  const shortages = lines.filter(l=>type==='out' && denomBalance(l.denom) < l.count);
  if(shortages.length){
    const msg = shortages.map(l=>`فئة ${fmt(l.denom)} ﷼ (الرصيد الحالي ${fmt(denomBalance(l.denom))})`).join('، ');
    if(!await customConfirm(`الفئات التالية سيصبح رصيدها سالباً: ${msg}. هل تريد المتابعة؟`)) return;
  }
  const batchId = uid();
  const by = (typeof currentUser!=='undefined' && currentUser) ? currentUser : 'غير معروف';
  const createdAt = Date.now();
  const summary = lines.map(l=>`${fmt(l.denom)}×${l.count}`).join('، ');
  let totalValue = 0;
  lines.forEach(l=>{
    const entry = { id: uid(), batchId, date, denom: l.denom, type, count: l.count, isAdjustment:false, notes, by, createdAt };
    vaultDenomTx.unshift(entry);
    totalValue += l.count * l.denom;
  });
  await saveVaultDenomTx();
  await logAudit('add','الحركات المالية', `تصنيف الفئات: حركة ${type==='in'?'دخول':'خروج'} دفعة واحدة (${summary}) — إجمالي القيمة: ${fmt(totalValue)} ﷼${notes?` — ${notes}`:''}`);
  showToast('تم تنفيذ الحركة');
  CASH_DENOMINATIONS.forEach(d=>{
    const el = document.querySelector(`[data-batch-denom-count="${d}"]`);
    if(el) el.value = '';
  });
  if($('#denom-tx-notes')) $('#denom-tx-notes').value = '';
  recalcDenomTable();
  renderDenomHistory();
}
async function saveDenomAdjustment(){
  const denom = num($('#denom-adj-denom')?.value);
  const actual = Math.floor(num($('#denom-adj-count')?.value));
  const date = $('#denom-adj-date')?.value || todayISO();
  const notes = $('#denom-adj-notes')?.value.trim() || '';
  if(!denom || $('#denom-adj-count')?.value===''){
    showToast('اختر الفئة وأدخل العدد الفعلي الموجود الآن');
    return;
  }
  const current = denomBalance(denom);
  const diff = actual - current;
  if(diff===0){
    showToast(`الرصيد مطابق بالفعل (${fmt(current)}) — لا حاجة لتسوية`);
    return;
  }
  const type = diff>0 ? 'in' : 'out';
  const count = Math.abs(diff);
  const autoNote = `تسوية جرد فعلي: من ${fmt(current)} إلى ${fmt(actual)}${notes?` — ${notes}`:''}`;
  const entry = { id: uid(), date, denom, type, count, isAdjustment:true, notes:autoNote, by: (typeof currentUser!=='undefined' && currentUser) ? currentUser : 'غير معروف', createdAt: Date.now() };
  vaultDenomTx.unshift(entry);
  await saveVaultDenomTx();
  await logAudit('add','الحركات المالية', `تصنيف الفئات: ${autoNote} — فئة ${fmt(denom)} ﷼`);
  showToast('تم تصحيح الرصيد');
  if($('#denom-adj-count')) $('#denom-adj-count').value = '';
  if($('#denom-adj-notes')) $('#denom-adj-notes').value = '';
  recalcDenomTable();
  renderDenomHistory();
}
function renderDenomHistory(){
  const body = $('#cash-count-history-body');
  if(!body) return;
  // جمّع الحركات في صف واحد لكل عملية: الحركات ذات batchId (دُخلت دفعة واحدة عبر النموذج الجديد) تُجمع حسب batchId،
  // والحركات القديمة بدون batchId تُجمع تلقائياً حسب (نفس التاريخ + نفس نوع الحركة دخول/خروج + نفس كونها تسوية جرد أو لا)
  const groups = [];
  const seenBatches = new Set();
  const seenLegacyKeys = new Set();
  vaultDenomTx.forEach(e=>{
    if(e.batchId){
      if(seenBatches.has(e.batchId)) return;
      seenBatches.add(e.batchId);
      const members = vaultDenomTx.filter(x=>x.batchId===e.batchId);
      groups.push({ date:e.date, type:e.type, isAdjustment:e.isAdjustment, notes:e.notes, by:e.by, createdAt:e.createdAt, members, ids: members.map(m=>m.id) });
    } else {
      const key = `${e.date}|${e.type}|${e.isAdjustment?1:0}`;
      if(seenLegacyKeys.has(key)) return;
      seenLegacyKeys.add(key);
      const members = vaultDenomTx.filter(x=>!x.batchId && x.date===e.date && x.type===e.type && !!x.isAdjustment===!!e.isAdjustment);
      const notes = [...new Set(members.map(m=>m.notes).filter(Boolean))].join(' | ');
      const by = [...new Set(members.map(m=>m.by).filter(Boolean))].join('، ');
      groups.push({ date:e.date, type:e.type, isAdjustment:e.isAdjustment, notes, by, createdAt:e.createdAt, members, ids: members.map(m=>m.id) });
    }
  });
  groups.sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
  if($('#cash-count-history-empty')) $('#cash-count-history-empty').style.display = groups.length ? 'none' : 'block';
  body.innerHTML = groups.map(g=>{
    const label = g.isAdjustment ? 'تسوية جرد' : (g.type==='in' ? 'دخول' : 'خروج');
    const color = g.isAdjustment ? 'var(--gold-dark)' : (g.type==='in' ? 'var(--teal)' : 'var(--red)');
    const sign = g.type==='in' ? '+' : '-';
    const denomLabel = g.members.map(m=>`${fmt(num(m.denom))}×${fmt(num(m.count))}`).join('، ');
    const totalCount = g.members.reduce((s,m)=>s+num(m.count),0);
    const totalValue = g.members.reduce((s,m)=>s+num(m.count)*num(m.denom),0);
    return `
    <tr>
      <td class="mono">${escapeHtml(g.date||'')}</td>
      <td>${escapeHtml(denomLabel)}</td>
      <td><span class="stamp" style="background:${color}; color:#fff;">${label}</span></td>
      <td class="mono">${sign}${fmt(totalCount)}</td>
      <td class="mono">${sign}${fmt(totalValue)} ﷼</td>
      <td>${escapeHtml(g.notes||'—')}</td>
      <td>${escapeHtml(g.by||'—')}</td>
      <td><button class="btn btn-ghost btn-sm" data-del-denomtx="${g.ids.join(',')}">🗑</button></td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-del-denomtx]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const ids = btn.dataset.delDenomtx.split(',');
      const msg = ids.length>1 ? 'حذف كل حركات هذا الصف من سجل تصنيف الفئات؟ (لا يؤثر على أي رصيد محاسبي آخر)' : 'حذف هذه الحركة من سجل تصنيف الفئات؟ (لا يؤثر على أي رصيد محاسبي آخر)';
      if(!await customConfirm(msg)) return;
      vaultDenomTx = vaultDenomTx.filter(x=>!ids.includes(x.id));
      await saveVaultDenomTx();
      recalcDenomTable();
      renderDenomHistory();
    });
  });
}
['#v-from','#v-to','#v-filter-type','#v-filter-dest','#v-filter-dup','#v-filter-nomethod'].forEach(sel=>{ $(sel).addEventListener('input', renderVault); $(sel).addEventListener('change', renderVault); });
onSearchInput('#v-search', renderVault);
$('#vault-page-size')?.addEventListener('change', ()=>{ vaultCurrentPage = 1; renderVault(); });
$('#vault-page-first')?.addEventListener('click', ()=>{ vaultCurrentPage = 1; renderVault(); });
$('#vault-page-prev')?.addEventListener('click', ()=>{ vaultCurrentPage = Math.max(1, vaultCurrentPage-1); renderVault(); });
$('#vault-page-next')?.addEventListener('click', ()=>{ vaultCurrentPage = vaultCurrentPage+1; renderVault(); });
$('#vault-page-last')?.addEventListener('click', ()=>{ vaultCurrentPage = Infinity; renderVault(); });

function renderVaultBulkBar(filteredRows){
  const bar = $('#vault-bulk-actions-bar');
  if(!bar) return;
  const count = selectedVaultIds.size;
  bar.style.display = count>0 ? '' : 'none';
  $('#vault-bulk-selected-count').textContent = count;
  $('#vault-bulk-filtered-total').textContent = filteredRows.length;
  const selectAllBox = $('#select-all-vault');
  if(selectAllBox){
    const pageIds = currentPageVaultIds;
    const selectedOnPage = pageIds.filter(id=>selectedVaultIds.has(id)).length;
    selectAllBox.checked = pageIds.length>0 && selectedOnPage===pageIds.length;
    selectAllBox.indeterminate = selectedOnPage>0 && selectedOnPage<pageIds.length;
  }
}
$('#vault-table-body').addEventListener('change', e=>{
  if(e.target.classList.contains('row-select-vault')){
    const id = e.target.dataset.id;
    if(e.target.checked) selectedVaultIds.add(id); else selectedVaultIds.delete(id);
    renderVaultBulkBar(vaultFilteredRows());
  }
});
$('#select-all-vault')?.addEventListener('change', e=>{
  if(e.target.checked) currentPageVaultIds.forEach(id=>selectedVaultIds.add(id));
  else currentPageVaultIds.forEach(id=>selectedVaultIds.delete(id));
  renderVault();
});
$('#btn-vault-select-all-filtered')?.addEventListener('click', ()=>{
  vaultFilteredRows().forEach(t=>selectedVaultIds.add(t.id));
  renderVault();
});
$('#btn-vault-clear-selection')?.addEventListener('click', ()=>{
  selectedVaultIds.clear();
  renderVault();
});
$('#btn-vault-bulk-delete')?.addEventListener('click', async ()=>{
  const allIds = [...selectedVaultIds].filter(id=>vaultTx.some(t=>t.id===id));
  if(!allIds.length){ showToast('لا يوجد حركات محددة'); return; }
  const targets = allIds.map(id=>vaultTx.find(t=>t.id===id));
  const lockedTargets = targets.filter(t=>isDateLocked(t.date));
  const deletableTargets = targets.filter(t=>!isDateLocked(t.date));
  if(!deletableTargets.length){ showToast('كل الحركات المحددة ضمن فترة محاسبية مُقفلة — لا يمكن إلغاء أي منها'); return; }
  const linkedClients = new Map(); // clientId -> {name, hasFirst, hasSecond}
  deletableTargets.forEach(t=>{
    if(t.type==='in' && t.autoClientId){
      const c = clients.find(cl=>cl.id===t.autoClientId);
      if(c){
        const isSecond = String(t.id).startsWith('auto2_');
        const entry = linkedClients.get(c.id) || {name:c.name, first:false, second:false};
        if(isSecond) entry.second = true; else entry.first = true;
        linkedClients.set(c.id, entry);
      }
    }
  });
  const totalAmount = deletableTargets.reduce((s,t)=>s+num(t.amount),0);
  let msg = `سيتم إلغاء ${deletableTargets.length} حركة مالية بإجمالي مبلغ ${fmt(totalAmount)} (حذف منطقي — تُحفظ في سجل الحركات الملغاة، لا حذف نهائي).`;
  if(lockedTargets.length) msg += `\n\nتنبيه: سيتم تجاهل ${lockedTargets.length} حركة من ضمن المحدد لأنها ضمن فترة محاسبية مُقفلة.`;
  if(linkedClients.size) msg += `\n\nتنبيه: من ضمنها دفعات تسجيل مرتبطة بـ ${linkedClients.size} عميل — سيتم تلقائياً تصفير المبلغ المدفوع المقابل (الأول و/أو الثاني) في بيانات كل عميل منهم فور الإلغاء.`;
  const isAdminBulk = currentUserRole==='admin';
  msg += isAdminBulk ? '\n\nيرجى كتابة سبب الإلغاء (اختياري للمدير، وسيُسجَّل لكل الحركات المحددة):' : '\n\nيرجى كتابة سبب الإلغاء (إلزامي، وسيُسجَّل لكل الحركات المحددة):';
  const reason = await customPrompt(msg, {title:'سبب إلغاء المجموعة المحددة', required:!isAdminBulk, placeholder:'اكتب سبب الإلغاء هنا...'});
  if(reason===null) return;
  if(!isAdminBulk && !reason.trim()){ showToast('سبب الإلغاء إلزامي — لم يتم الإلغاء'); return; }
  const bulkReason = reason.trim() || (isAdminBulk ? 'بدون سبب (مدير)' : '');
  snapshotState(`إلغاء جماعي (حذف منطقي) لـ ${deletableTargets.length} حركة مالية بإجمالي ${fmt(totalAmount)}`);
  const affectedClientIds = new Set();
  let removedCount = 0;
  deletableTargets.forEach(t=>{
    const removed = softDeleteVaultTx(t.id, bulkReason);
    if(removed){
      removedCount++;
      if(removed.autoClientId){
        const c = clients.find(cl=>cl.id===removed.autoClientId);
        if(c){
          const isSecond = String(removed.id).startsWith('auto2_');
          if(isSecond){ c.paid2 = 0; } else { c.paid = 0; }
          affectedClientIds.add(c.id);
        }
      }
    }
  });
  await saveVaultTx();
  await saveDeletedVaultTx();
  await logAudit('delete','الحركات المالية', `إلغاء جماعي (حذف منطقي) لـ ${removedCount} حركة بإجمالي ${fmt(totalAmount)}${lockedTargets.length?` (تم تجاهل ${lockedTargets.length} حركة مُقفلة)`:''} — السبب: ${reason.trim()}`);
  if(affectedClientIds.size){
    await saveClients();
    const namesList = [...affectedClientIds].map(id=>clients.find(c=>c.id===id)?.name).filter(Boolean).join('، ');
    await logAudit('edit','العملاء', `تم تصفير دفعات التسجيل المرتبطة تلقائياً لـ ${affectedClientIds.size} عميل بعد إلغاء جماعي لحركاتهم المالية: ${namesList}`);
  }
  selectedVaultIds.clear();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports();
  renderVault();
  showToast(`تم إلغاء ${removedCount} حركة بنجاح${lockedTargets.length?`، وتجاهل ${lockedTargets.length} حركة مُقفلة`:''}`);
});

function toggleVaultFields(){
  const type = $('#vf-type').value;
  const isIn = type==='in';
  const isReturn = type==='return';
  const isOut = type==='out';
  const linked = $('#vf-linked').checked;
  $('#wrap-linked').style.display = isIn ? '' : 'none';
  $('#wrap-clientid').style.display = (isReturn || (isIn && linked)) ? '' : 'none';
  $('#wrap-clientname').style.display = (isReturn || (isIn && linked)) ? '' : 'none';
  $('#wrap-manual').style.display = (isIn && !linked) ? '' : 'none';
  $('#wrap-category').style.display = isOut ? '' : 'none';
  $('#wrap-recipient').style.display = isOut ? '' : 'none';
  $('#wrap-refno').style.display = isOut ? '' : 'none';
  $('#wrap-netinvoice').style.display = $('#vf-destination').value==='network' ? '' : 'none';
  $('#wrap-bagdeposit-toggle').style.display = isOut ? '' : 'none';
  $('#wrap-bagdeposit-qty').style.display = (isOut && $('#vf-bagdeposit').checked) ? '' : 'none';
  if(!isOut) $('#vf-bagdeposit').checked = false;
}
$('#vf-type').addEventListener('change', toggleVaultFields);
$('#vf-linked').addEventListener('change', toggleVaultFields);
$('#vf-destination').addEventListener('change', toggleVaultFields);
$('#vf-bagdeposit').addEventListener('change', toggleVaultFields);

/* ---------------- تصنيف تلقائي للمصروفات بالذكاء الاصطناعي ----------------
   يقرأ اسم مستلم المبلغ + الملاحظات + رقم المستند + المبلغ، ويقترح أنسب تصنيف
   من قائمة التصنيفات المعرَّفة في الإعدادات (أو تصنيف جديد مختصر إن لم يوجد مناسب). */
async function aiClassifyExpense(){
  const btn = $('#btn-ai-classify');
  const statusEl = $('#ai-classify-status');
  const recipient = $('#vf-recipient').value.trim();
  const notes = $('#vf-notes').value.trim();
  const refno = $('#vf-refno').value.trim();
  const amount = $('#vf-amount').value;
  if(!recipient && !notes){
    showToast('أدخل اسم مستلم المبلغ أو ملاحظة أولاً حتى يقدر الذكاء الاصطناعي يقترح تصنيفاً مناسباً');
    return;
  }
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = '⏳ جارِ التصنيف...';
  statusEl.style.display = 'none';
  try{
    const payload = {
      recipientName: recipient || null,
      notes: notes || null,
      documentRef: refno || null,
      amount: amount || null,
      availableCategories: settings.expenseCategories
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'أنت مساعد تصنيف مصروفات لمركز تدريب سعودي. سيصلك اسم مستلم مبلغ و/أو ملاحظة و/أو رقم مستند و/أو مبلغ مصروف. اختر أنسب تصنيف من قائمة "availableCategories" المُرسَلة فقط إن وجد تصنيف مناسب فعلاً. إن لم يوجد أي تصنيف مناسب في القائمة، اقترح اسم تصنيف عربي جديد قصير (كلمة أو كلمتين) يصلح لتكرار هذا النوع من المصروفات مستقبلاً. أجب بصيغة JSON فقط بدون أي نص أو علامات ```json، بالشكل التالي بالضبط: {"category":"...", "isNew": true أو false, "reason":"جملة قصيرة توضح سبب الاختيار"}',
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if(!response.ok){
      throw new Error('HTTP ' + response.status);
    }
    const data = await response.json();
    const rawText = (data.content || []).map(b=>b.text||'').join('').trim();
    const cleaned = rawText.replace(/```json|```/g,'').trim();
    const parsed = JSON.parse(cleaned);
    const suggestedCategory = String(parsed.category||'').trim();
    if(!suggestedCategory) throw new Error('لم يصل تصنيف صالح');
    if(parsed.isNew && !settings.expenseCategories.includes(suggestedCategory)){
      settings.expenseCategories.push(suggestedCategory);
      await saveSettings();
      populateSelect($('#vf-category'), settings.expenseCategories, false);
    }
    if(!settings.expenseCategories.includes(suggestedCategory)){
      // احتياط: لو رجع تصنيف غير موجود ولم يُعلَّم isNew، أضفه بأمان حتى لا يُفقَد الاقتراح
      settings.expenseCategories.push(suggestedCategory);
      await saveSettings();
      populateSelect($('#vf-category'), settings.expenseCategories, false);
    }
    $('#vf-category').value = suggestedCategory;
    statusEl.textContent = `✅ التصنيف المقترح: "${suggestedCategory}"${parsed.reason ? ' — ' + parsed.reason : ''} (يمكنك تغييره يدوياً لو غير مناسب)`;
    statusEl.style.display = '';
  }catch(err){
    showToast('تعذر الحصول على اقتراح تصنيف — تأكد من اتصالك بالإنترنت، أو أضف تصنيفاً يدوياً');
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
$('#btn-ai-classify').addEventListener('click', aiClassifyExpense);

$('#vf-clientid').addEventListener('input', ()=>{
  const c = clients.find(x=>x.clientId===$('#vf-clientid').value.trim());
  $('#vf-clientname').value = c ? c.name : '';
  if(c){
    const chan = settings.channels.find(ch=>ch.name===c.channel);
    if(chan) $('#vf-destination').value = chan.dest==='other' ? 'vault' : chan.dest;
    toggleVaultFields();
  }
});

$('#btn-add-vault').addEventListener('click', ()=>openVaultModal(null));
function openVaultModal(id){
  if(id){
    const lockedTx = vaultTx.find(x=>x.id===id);
    if(lockedTx && lockedTx.type==='in' && lockedTx.autoClientId){
      showToast('هذه دفعة تسجيل تلقائية — عدّلها من شيت العملاء (حقلا "المبلغ المدفوع"/"طريقة الدفع")');
      return;
    }
  }
  if(id && isDateLocked(vaultTx.find(x=>x.id===id)?.date)){ vaultLockToast(); return; }
  editingVaultId = id || null;
  $('#vault-modal-title').textContent = id ? 'تعديل حركة خزنة' : 'حركة خزنة جديدة';
  const t = id ? vaultTx.find(x=>x.id===id) : null;
  $('#vf-type').value = t ? (t.isReturn ? 'return' : t.type) : 'in';
  $('#vf-date').value = t?.date || todayISO();
  $('#vf-amount').value = t?.amount ?? '';
  $('#vf-linked').checked = t ? !!t.clientId : true;
  $('#vf-clientid').value = t?.clientId || '';
  $('#vf-clientname').value = t?.clientName || '';
  $('#vf-manual').value = t?.manual || '';
  populateSelect($('#vf-category'), settings.expenseCategories, false);
  $('#vf-category').value = t?.category || '';
  $('#vf-recipient').value = t?.recipientName || '';
  $('#vf-refno').value = t?.referenceNo || '';
  // طرق الدفع الموحدة (نفس طرق الدفع المُعرَّفة في الإعدادات — يطابق شيت "الحركات المالية")
  populateSelect($('#vf-method'), settings.channels.map(c=>c.name), false);
  {
    const vfMethodVal = t?.method || '';
    if(settings.channels.some(c=>c.name===vfMethodVal)) $('#vf-method').value = vfMethodVal;
    else { const vaultCh = settings.channels.find(c=>c.dest==='vault'); $('#vf-method').value = vaultCh ? vaultCh.name : settings.channels[0]?.name || ''; }
  }
  $('#vf-notes').value = t?.notes || '';
  $('#vf-destination').value = t?.destination || 'vault';
  $('#vf-netinvoice').value = t?.networkInvoice || '';
  $('#vf-bagdeposit').checked = false;
  toggleVaultFields();
  $('#vault-overlay').classList.add('show'); SoundFX.open();
}
$('#vf-cancel').addEventListener('click', ()=>{ $('#vault-overlay').classList.remove('show'); editingVaultId=null; });
$('#vault-overlay').addEventListener('click', e=>{ if(e.target.id==='vault-overlay'){ $('#vault-overlay').classList.remove('show'); editingVaultId=null; } });

$('#vault-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const rawType = $('#vf-type').value;
  const isIn = rawType==='in';
  const isReturn = rawType==='return';
  const isOut = rawType==='out';
  const linked = (isIn && $('#vf-linked').checked) || isReturn;
  const amount = num($('#vf-amount').value);
  const date = $('#vf-date').value || todayISO();
  if(amount<=0){ showToast('أدخل مبلغاً صحيحاً'); return; }
  if(isReturn && !$('#vf-clientid').value.trim()){ showToast('يجب تحديد العميل الذي سيُسترجع له المبلغ'); return; }
  // إلزام الحقول الأساسية حسب نوع الحركة — لا يُحفظ صادر بدون تصنيف، مستلم، ومستند مؤيّد
  if(isOut){
    if(!$('#vf-category').value.trim()){ showToast('يجب اختيار تصنيف المصروف'); return; }
    if(!$('#vf-recipient').value.trim()){ showToast('يجب إدخال اسم مستلم المبلغ'); return; }
    if(!$('#vf-refno').value.trim()){ showToast('يجب إدخال رقم المستند/المرفق المؤيّد لهذا الصادر'); return; }
  }
  if(isIn && !linked && !$('#vf-manual').value.trim()){ showToast('يجب إدخال البيان / الجهة لهذه الحركة الواردة'); return; }
  if(isIn && linked && !$('#vf-clientid').value.trim()){ showToast('يجب إدخال رقم الهوية للعميل المرتبط بالحركة'); return; }
  if(isIn && linked && !clients.find(x=>x.clientId===$('#vf-clientid').value.trim())){ showToast('لا يوجد عميل مسجّل بهذا الرقم — تحقق من رقم الهوية/الإقامة'); return; }
  // قفل الفترات المحاسبية: منع أي إضافة أو تعديل يقع تاريخها ضمن فترة أُقفلت بعد اعتماد قوائمها
  if(isDateLocked(date)){ vaultLockToast(); return; }
  if(editingVaultId){
    const existing = vaultTx.find(x=>x.id===editingVaultId);
    if(existing && isDateLocked(existing.date)){ vaultLockToast(); return; }
  }
  const data = {
    type: isReturn ? 'out' : rawType,
    isReturn,
    date,
    amount,
    method: $('#vf-method').value,
    notes: $('#vf-notes').value.trim(),
    clientId: linked ? $('#vf-clientid').value.trim() : '',
    clientName: linked ? $('#vf-clientname').value.trim() : '',
    manual: (isIn && !linked) ? $('#vf-manual').value.trim() : '',
    category: isReturn ? 'مردودات المبيعات' : (isOut ? $('#vf-category').value : ''),
    recipientName: isOut ? $('#vf-recipient').value.trim() : '',
    referenceNo: isOut ? $('#vf-refno').value.trim() : '',
    destination: $('#vf-destination').value,
    networkInvoice: $('#vf-destination').value==='network' ? $('#vf-netinvoice').value.trim() : ''
  };
  const wasVaultEdit = !!editingVaultId;
  let prevLinkedClientId = '';
  snapshotState(wasVaultEdit ? 'تعديل حركة مالية' : 'إضافة حركة مالية');
  let savedTx;
  if(editingVaultId){
    const idx = vaultTx.findIndex(x=>x.id===editingVaultId);
    // إصلاح: نسخة "قبل" يجب أن تُستثني منها history (وإلا يبقى إشارة لنفس مصفوفة السجل الأصلية،
    // فيتكوّن مرجع دائري عند أول عملية push لاحقة ويفشل JSON.stringify عند أي حفظ أو نسخة احتياطية لاحقاً)
    const { history: _prevHistory, ...before } = vaultTx[idx];
    prevLinkedClientId = before.clientId || '';
    vaultTx[idx] = {...vaultTx[idx], ...data};
    const { history: _afterHistory, ...afterSnap } = vaultTx[idx];
    pushVaultTxHistory(vaultTx[idx], before, afterSnap);
    savedTx = vaultTx[idx];
    showToast('تم تحديث الحركة');
  }else{
    savedTx = {id:uid(), seq: allocVaultSeq(), createdAt:Date.now(), ...data};
    vaultTx.push(savedTx);
    await saveSettings();
    showToast('تمت إضافة الحركة');
  }
  await saveVaultTx();
  const txLabel = isReturn ? 'مردود مبيعات' : (savedTx.type==='in'?'وارد':'صادر');
  const txDesc = `${txLabel} بمبلغ ${fmt(num(savedTx.amount))} (${destLabel(savedTx.destination||'vault')}) - ${savedTx.clientName||savedTx.manual||savedTx.category||''}`;
  await logAudit(wasVaultEdit ? 'edit' : 'add', 'الحركات المالية', `${wasVaultEdit ? 'تم تعديل حركة' : 'تمت إضافة حركة'} رقم تسلسلي #${savedTx.seq||'—'}: ${txDesc}`);

  // عند تسجيل مرتجع (مردود مبيعات) لعميل، يُحوَّل تلقائياً إلى "ملغى" (بالإضافة إلى إيقافه كسابقاً)
  // فيختفي من شيت الدورات ومخزون الحقائب ولا يُحتسب ضمن إجمالي المتبقي على العملاء،
  // تماماً كما لو أُلغي وأُوقِف يدوياً من شيت العملاء
  if(!wasVaultEdit && isReturn){
    const returnedClient = clients.find(x=>x.clientId===data.clientId);
    if(returnedClient && (!returnedClient.cancelled || !returnedClient.suspended)){
      returnedClient.cancelled = true;
      returnedClient.suspended = true;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء تسجيل العميل ${returnedClient.name} تلقائياً بسبب تسجيل مردود مبيعات له — أصبح مخفياً من شيت الدورات ومخزون الحقائب`);
    }
  }

  // إذا فُعّلت خانة "إيداع في حساب/مخزون الحقائب" ضمن مصروف، يُضاف المبلغ لرصيد حساب الحقائب
  // ويُحتسب عدد الحقائب المضافة تلقائياً حسب السعر الثابت للحقيبة (نفس منطق تمويل المخزون)
  if(isOut && !wasVaultEdit && $('#vf-bagdeposit').checked){
    snapshotState(`إيداع في حساب الحقائب عبر حركة مصروف: ${fmt(amount)}`);
    bagStock.push({
      id: uid(),
      createdAt: Date.now(),
      type: 'deposit',
      date: data.date,
      amount,
      method: data.method,
      notes: `مرتبط تلقائياً بحركة مالية (${data.category||'مصروف'})${data.notes ? ' — '+data.notes : ''}`
    });
    recalcBagFundLedger();
    await saveBagStock();
    await saveSettings();
    const addedEntry = bagStock[bagStock.length-1];
    if(addedEntry.qty>0){
      await logAudit('add','مخزون الحقائب', `تمت إضافة ${addedEntry.qty} حقيبة للمخزون تلقائياً من حركة إيداع مالية بقيمة ${fmt(amount)} (الرصيد المتبقي: ${fmt(settings.bagFundBalance)})`);
    }else{
      await logAudit('add','مخزون الحقائب', `تم تسجيل إيداع ${fmt(amount)} ﷼ في حساب الحقائب من حركة مالية — لم يكتمل بعد لشراء حقيبة كاملة (الرصيد الحالي: ${fmt(settings.bagFundBalance)})`);
    }
    renderBags();
  }

  $('#vault-overlay').classList.remove('show'); editingVaultId=null;
  if(!wasVaultEdit && isReturn){
    refreshEverything();
  }else{
    renderVault();
    // المبلغ المدفوع والمتبقي في شيت العملاء يُحسبان مباشرة من الحركات المالية المرتبطة بالعميل،
    // لذا أي إضافة أو تعديل أو تغيير ربط عميل لحركة يجب أن ينعكس فوراً هناك (العميل الجديد والقديم إن اختلفا)
    if(savedTx.clientId || prevLinkedClientId){
      if(typeof renderTable==='function') renderTable();
      if(typeof renderDashboard==='function') renderDashboard();
      if(typeof renderReports==='function') renderReports();
    }
  }

  // طباعة تلقائية عند إضافة حركة جديدة: فاتورة استرجاع للعميل عند المردودات، أو سند صرف عند المصروفات
  if(!wasVaultEdit && isReturn){
    await printReturnInvoice(savedTx.id);
  }else if(!wasVaultEdit && isOut){
    await printExpenseVoucher(savedTx.id);
  }
});

document.addEventListener('click', async e=>{
  if(e.target.dataset.vedit) openVaultModal(e.target.dataset.vedit);
  if(e.target.dataset.vprintreturn) await printReturnInvoice(e.target.dataset.vprintreturn);
  if(e.target.dataset.vvoucher) await printExpenseVoucher(e.target.dataset.vvoucher);
  if(e.target.dataset.vdel){
    const id = e.target.dataset.vdel;
    const target = vaultTx.find(t=>t.id===id);
    if(target && isDateLocked(target.date)){ vaultLockToast(); return; }
    // إن كانت هذه دفعة تسجيل تلقائية مرتبطة بعميل، ننبّه المستخدم أن إلغاءها سيُصفّر الدفعة المقابلة في شيت العملاء تلقائياً
    let linkedClient = null, linkedIsSecond = false;
    if(target && target.type==='in' && target.autoClientId){
      linkedClient = clients.find(c=>c.id===target.autoClientId);
      linkedIsSecond = id.startsWith('auto2_');
    }
    const linkWarning = linkedClient ? `\n\nتنبيه: هذه دفعة تسجيل مرتبطة تلقائياً بالعميل "${linkedClient.name}" — بعد الإلغاء سيتم تلقائياً تصفير ${linkedIsSecond?'"المبلغ المدفوع الثاني"':'"المبلغ المدفوع الأول"'} في بيانات هذا العميل، وسينعكس ذلك فوراً على إجمالي مدفوعاته والمتبقي عليه.` : '';
    const isAdmin = currentUserRole==='admin';
    const reason = await customPrompt(`توثيقاً للمعايير المحاسبية، لا يمكن حذف حركة مالية نهائياً — سيتم إلغاؤها فقط مع الاحتفاظ بها في سجل الحركات الملغاة.${linkWarning}\n${isAdmin ? 'يرجى كتابة سبب الإلغاء (اختياري للمدير):' : 'يرجى كتابة سبب الإلغاء (إلزامي):'}`, {title:'سبب الإلغاء', required:!isAdmin, placeholder:'اكتب سبب الإلغاء هنا...'});
    if(reason===null) return; // المستخدم ألغى العملية
    if(!isAdmin && !reason.trim()){ showToast('سبب الإلغاء إلزامي — لم يتم الحذف'); return; }
    snapshotState(`إلغاء (حذف منطقي) حركة مالية بمبلغ ${target?fmt(num(target.amount)):''}`);
    const removed = softDeleteVaultTx(id, reason.trim() || (isAdmin ? 'بدون سبب (مدير)' : ''));
    await saveVaultTx();
    await saveDeletedVaultTx();
    if(removed){
      const removedLabel = removed.isReturn ? 'مردود مبيعات' : (removed.type==='in'?'وارد':'صادر');
      const txDesc = `${removedLabel} بمبلغ ${fmt(num(removed.amount))} (${destLabel(removed.destination||'vault')}) بتاريخ ${removed.date||'—'} رقم تسلسلي #${removed.seq||'—'} - ${removed.clientName||removed.manual||removed.category||''}`;
      await logAudit('delete','الحركات المالية', `تم إلغاء (حذف منطقي) حركة: ${txDesc} — السبب: ${removed.deletedReason}`);
      // مزامنة تلقائية مع شيت العملاء: إن كانت الحركة الملغاة دفعة تسجيل تلقائية، صفّر الدفعة المقابلة في بيانات العميل
      // حتى لا تُعاد إضافتها لاحقاً عند أي حفظ آخر لبيانات هذا العميل، ويتحدث إجمالي مدفوعاته ومتبقيه فوراً في شيت العملاء
      if(removed.autoClientId){
        const c = clients.find(cl=>cl.id===removed.autoClientId);
        if(c){
          const isSecond = String(removed.id).startsWith('auto2_');
          if(isSecond){ c.paid2 = 0; } else { c.paid = 0; }
          await saveClients();
          await logAudit('edit','العملاء', `تم تصفير ${isSecond?'المبلغ المدفوع الثاني':'المبلغ المدفوع الأول'} للعميل "${c.name}" تلقائياً بعد إلغاء حركته المالية المرتبطة (رقم تسلسلي #${removed.seq||'—'})`);
          renderTable(); renderDashboard(); refreshFilterOptions(); renderReports();
        }
      }
    }
    renderVault();
    // المبلغ المدفوع والمتبقي في شيت العملاء يُحسبان مباشرة من الحركات المالية المرتبطة بالعميل،
    // فأي إلغاء لحركة مرتبطة بعميل (حتى لو لم تكن دفعة تسجيل تلقائية) يجب أن ينعكس فوراً هناك
    if(removed && removed.clientId && !removed.autoClientId){
      renderTable(); renderDashboard(); renderReports();
    }
  }
});

/* ================= قفل الفترة المحاسبية + سجل الحركات الملغاة ================= */
function renderVaultLockStatus(){
  const el = $('#vault-lock-status');
  if(!el) return;
  el.textContent = settings.vaultLockedThrough
    ? `مُقفلة حتى ${settings.vaultLockedThrough} — لا يمكن إضافة/تعديل/حذف أي حركة بتاريخ يقع في هذه الفترة أو قبلها`
    : 'لا يوجد قفل حالياً — كل الفترات مفتوحة للتعديل';
}
$('#btn-vault-lock').addEventListener('click', async ()=>{
  const d = $('#vault-lock-date').value;
  if(!d){ showToast('اختر تاريخاً أولاً'); return; }
  if(settings.vaultLockedThrough && d<=settings.vaultLockedThrough){ showToast('يجب أن يكون تاريخ القفل الجديد بعد تاريخ القفل الحالي'); return; }
  if(!await customConfirm(`سيتم قفل كل الحركات المالية بتاريخ ${d} فأقل نهائياً بعد اعتماد قوائمها — لن يمكن إضافة أو تعديل أو حذف أي حركة ضمن هذه الفترة إلا بفتح القفل استثنائياً. متابعة؟`)) return;
  snapshotState(`قفل الفترة المحاسبية حتى ${d}`);
  settings.vaultLockedThrough = d;
  await saveSettings();
  await logAudit('edit','الحركات المالية', `تم قفل الفترة المحاسبية حتى تاريخ ${d} — لا يمكن تعديل/حذف حركات هذه الفترة`);
  renderVaultLockStatus();
  showToast('تم قفل الفترة');
});
$('#btn-vault-unlock').addEventListener('click', async ()=>{
  if(!settings.vaultLockedThrough){ showToast('لا يوجد قفل حالياً'); return; }
  if(!await customConfirm('فتح القفل صلاحية استثنائية تتيح تعديل/حذف حركات فترة سبق اعتماد قوائمها المالية — تُستخدم فقط لتصحيح خطأ موثّق. هل أنت متأكد؟')) return;
  const oldLock = settings.vaultLockedThrough;
  snapshotState(`فتح قفل الفترة المحاسبية (كانت مقفلة حتى ${oldLock})`);
  settings.vaultLockedThrough = '';
  await saveSettings();
  await logAudit('edit','الحركات المالية', `تم فتح قفل الفترة المحاسبية (كانت مقفلة حتى ${oldLock}) — صلاحية استثنائية`);
  renderVaultLockStatus();
  showToast('تم فتح القفل');
});
let voidedPageState = {page:1, sig:''};
function renderVoidedLog(){
  const rows = deletedVaultTx.slice().sort((a,b)=>(b.deletedAt||0)-(a.deletedAt||0));
  $('#voided-empty').style.display = rows.length ? 'none' : 'block';
  const pageRows = applyGenericPagination('voided', rows, voidedPageState, [rows.length]);
  $('#voided-table-body').innerHTML = pageRows.map(t=>`
    <tr>
      <td class="mono">#${t.seq||'—'}</td>
      <td class="mono">${t.date||'—'}</td>
      <td><span class="stamp ${t.type==='in'?'paid':'owe'}">${t.type==='in'?'وارد':(t.isReturn?'مردود مبيعات':'صادر')}</span></td>
      <td>${destLabel(t.destination||'vault')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
      <td>${escapeHtml(t.clientName||t.manual||t.category||'—')}</td>
      <td>${escapeHtml(t.deletedReason||'—')}</td>
      <td>${escapeHtml(t.deletedBy||'—')}</td>
      <td class="mono">${t.deletedAt ? new Date(t.deletedAt).toLocaleString('ar-SA') : '—'}</td>
    </tr>`).join('');
}
bindGenericPagination('voided', voidedPageState, renderVoidedLog);
$('#btn-show-voided').addEventListener('click', ()=>{ renderVoidedLog(); $('#voided-overlay').classList.add('show'); SoundFX.open(); });
$('#voided-close').addEventListener('click', ()=> $('#voided-overlay').classList.remove('show'));
$('#voided-overlay').addEventListener('click', e=>{ if(e.target.id==='voided-overlay') $('#voided-overlay').classList.remove('show'); });

$('#btn-extract-nomethod').addEventListener('click', ()=>{
  // تفعيل فلتر "بدون طريقة دفع" في الشاشة مع الإبقاء على بقية الفلاتر (التاريخ/الوجهة/النوع/البحث) كما هي
  $('#v-filter-nomethod').checked = true;
  renderVault();
  const rows = vaultFilteredRows();
  if(!rows.length){ showToast('لا توجد حركات بدون طريقة دفع ضمن الفلتر الحالي'); return; }
  const seq = seqNumbers();
  const reportRows = rows.map(t=>({
    'الرقم التسلسلي الرسمي': t.seq||'', 'الرقم': seq[t.id]||'', 'التاريخ': t.date||'',
    'الحساب': destLabel(t.destination||'vault'), 'النوع': t.isReturn?'مردود مبيعات':(t.type==='in'?'وارد':'صادر'),
    'رقم الهوية': t.clientId||'', 'العميل / البيان': (t.type==='in'||t.isReturn)?(t.clientName||t.manual||''):(t.category||''),
    'التصنيف': t.type==='out' ? (t.category||'') : '', 'المبلغ': num(t.amount), 'ملاحظات': t.notes||''
  }));
  downloadXlsx(`حركات_بدون_طريقة_دفع_${stampNow()}.xlsx`, 'بدون طريقة دفع', reportRows);
  showToast(`تم استخراج ${rows.length} حركة بدون طريقة دفع`);
});
$('#btn-export-vault').addEventListener('click', ()=>{
  const rows = vaultFilteredRows();
  const seq = seqNumbers();
  const headers = ['الرقم التسلسلي الرسمي','الرقم','التاريخ','الحساب','النوع','رقم الهوية','العميل/البيان','التصنيف','مستلم المبلغ (للمصروفات)','رقم المستند/المرفق','طريقة الدفع','رقم فاتورة الشبكة','المبلغ','ملاحظات'];
  const data = rows.map(t=>[t.seq||'', seq[t.id]||'', t.date, destLabel(t.destination||'vault'), t.isReturn?'مردود مبيعات':(t.type==='in'?'وارد':'صادر'), t.clientId, (t.type==='in'||t.isReturn)?(t.clientName||t.manual):(t.category), t.category, t.recipientName||'', t.referenceNo||'', t.method, t.networkInvoice||'', t.amount, t.notes]);
  const csv = '\uFEFF'+[headers, ...data].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تقرير_الحركات_المالية.csv';
  a.click();
});

/* ---------------- Audit Log ---------------- */
function refreshAuditFilterOptions(){
  const sections = [...new Set(auditLog.map(a=>a.section))];
  populateSelect($('#audit-filter-section'), sections, true);
}
function auditFilteredRows(){
  const q = $('#audit-search').value.trim().toLowerCase();
  const action = $('#audit-filter-action').value;
  const section = $('#audit-filter-section').value;
  const dfrom = $('#audit-date-from').value;
  const dto = $('#audit-date-to').value;
  return auditLog.filter(a=>{
    if(action && a.action!==action) return false;
    if(section && a.section!==section) return false;
    if(dfrom && a.ts < new Date(dfrom+'T00:00:00').getTime()) return false;
    if(dto && a.ts > new Date(dto+'T23:59:59').getTime()) return false;
    if(q){
      const hay = [a.user,a.section,a.description].join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a,b)=>b.ts-a.ts);
}
function actionLabel(a){ return {add:'إضافة', edit:'تعديل', delete:'حذف'}[a] || a; }
function fmtDateTime(ts){
  const d = new Date(ts);
  return d.toLocaleString('ar-SA', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}
let auditPageState = {page:1, sig:''};
function renderAuditLog(){
  refreshAuditFilterOptions();
  const rows = auditFilteredRows();
  $('#audit-empty').style.display = rows.length ? 'none' : 'block';
  const pageRows = applyGenericPagination('audit', rows, auditPageState, [
    $('#audit-search')?.value, $('#audit-filter-action')?.value, $('#audit-filter-section')?.value,
    $('#audit-date-from')?.value, $('#audit-date-to')?.value
  ]);
  $('#audit-table-body').innerHTML = pageRows.map(a=>`
    <tr>
      <td class="mono">${fmtDateTime(a.ts)}</td>
      <td>${escapeHtml(a.user)}</td>
      <td>${escapeHtml(a.section)}</td>
      <td><span class="stamp ${a.action==='delete'?'owe':'paid'}">${actionLabel(a.action)}</span></td>
      <td>${escapeHtml(a.description)}</td>
    </tr>`).join('');
}
bindGenericPagination('audit', auditPageState, renderAuditLog);
['#audit-filter-action','#audit-filter-section','#audit-date-from','#audit-date-to'].forEach(sel=>{
  $(sel).addEventListener('input', renderAuditLog);
});
onSearchInput('#audit-search', renderAuditLog);
$('#btn-export-audit').addEventListener('click', ()=>{
  const rows = auditFilteredRows();
  const headers = ['التاريخ والوقت','المستخدم','الشيت','العملية','التفاصيل'];
  const data = rows.map(a=>[fmtDateTime(a.ts), a.user, a.section, actionLabel(a.action), a.description]);
  const csv = '\uFEFF'+[headers, ...data].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a2 = document.createElement('a');
  a2.href = URL.createObjectURL(blob);
  a2.download = 'سجل_المراجعة.csv';
  a2.click();
});

/* ---------------- Login / Logout ----------------
   تم حذف شاشة تسجيل الدخول المحلي داخل البرنامج بناءً على طلب المستخدم.
   الدخول الآن يتم فقط عبر شاشة السيرفر المركزي (server-login-screen)، وصلاحيات المستخدم
   (admin/staff) تُشتق مباشرة من هوية المستخدم الذي سجّل دخوله فعليًا على الخادم (SERVER_AUTH_USERNAME/
   SERVER_AUTH_ROLE)، وليس من أول مستخدم في قائمة "المستخدمين" الداخلية للبرنامج. */
function autoSignInLocalUser(){
  currentUser = SERVER_AUTH_USERNAME || 'غير معروف';
  currentUserRole = normalizeRole(SERVER_AUTH_ROLE);
  $('#app-wrap').style.display = 'block';
  $('#current-user-label').textContent = currentUser;
  applyRolePermissions();
}
$('#btn-lang-toggle').addEventListener('click', ()=>{
  applyLanguage(currentLang==='ar' ? 'en' : 'ar');
});
$('#btn-theme-toggle').addEventListener('click', async ()=>{
  settings.darkMode = !settings.darkMode;
  applyTheme(settings.darkMode);
  await saveSettings();
});
$('#btn-sound-toggle').addEventListener('click', async ()=>{
  settings.soundEnabled = !settings.soundEnabled;
  applySoundIcon();
  if(settings.soundEnabled) SoundFX.click();
  await saveSettings();
});
$('#btn-logout').addEventListener('click', async ()=>{
  if(await customConfirm('تأكيد تسجيل الخروج؟')){
    try{
      await fetch(API_BASE + '/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      });
    }catch(e){ /* حتى لو فشل الاتصال، نكمّل تسجيل الخروج محلياً بالأسفل */ }
    currentUser = null;
    currentUserRole = 'staff';
    SERVER_AUTH_TOKEN = null;
    SERVER_AUTH_USERNAME = null;
    SERVER_AUTH_ROLE = null;
    try{
      sessionStorage.removeItem('serverAuthToken');
      sessionStorage.removeItem('serverAuthUsername');
      sessionStorage.removeItem('serverAuthRole');
    }catch(e){}
    $('#app-wrap').style.display = 'none';
    showServerLoginScreen(null);
  }
});

/* ---------------- Reports ---------------- */
function allTimeTotals(){
  const income = vaultTx.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = vaultTx.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const totalRemaining = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  const {purchasedQty, spentBulk} = bagStockTotals();
  const purchasedBuy = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended);
  const spentDirect = purchasedBuy.reduce((s,c)=>s+num(c.bagPrice),0);
  const bagSpent = spentBulk + spentDirect;
  const bagCollected = clients.filter(c=>!c.suspended).reduce((s,c)=>s+bagAmount(c),0);
  return {income, expense, net: income-expense, totalRemaining, bagSpent, bagCollected};
}
function renderBudget(){
  const t = allTimeTotals();
  $('#budget-cards').innerHTML = `
    <div class="card"><div class="k">إجمالي الإيرادات (كل الفترة)</div><div class="v teal">${fmt(t.income)}</div></div>
    <div class="card"><div class="k">إجمالي المصروفات (كل الفترة)</div><div class="v red">${fmt(t.expense)}</div></div>
    <div class="card"><div class="k">صافي الربح / الخسارة</div><div class="v ${t.net<0?'red':'gold'}">${fmt(t.net)}</div></div>
    <div class="card"><div class="k">رصيد الخزنة (كاش)</div><div class="v ${balanceOf('vault')<0?'red':''}">${fmt(balanceOf('vault'))}</div></div>
    <div class="card"><div class="k">رصيد البنك</div><div class="v ${balanceOf('bank')<0?'red':'teal'}">${fmt(balanceOf('bank'))}</div></div>
    <div class="card"><div class="k">رصيد الشبكة</div><div class="v ${balanceOf('network')<0?'red':'gold'}">${fmt(balanceOf('network'))}</div></div>
    <div class="card"><div class="k">إجمالي المتبقي على العملاء (ذمم)</div><div class="v red">${fmt(t.totalRemaining)}</div></div>
    <div class="card"><div class="k">عدد العملاء المسجّلين إجمالاً</div><div class="v">${clients.length}</div></div>
    <div class="card"><div class="k">حصيلة الحقائب من العملاء</div><div class="v">${fmt(t.bagCollected)}</div></div>
    <div class="card"><div class="k">إجمالي المصروف على الحقائب</div><div class="v gold">${fmt(t.bagSpent)}</div></div>
  `;
}
function periodFilteredVaultTx(){
  const from = $('#rp-from').value;
  const to = $('#rp-to').value;
  return vaultTx.filter(t=>{
    if(from && (t.date||'') < from) return false;
    if(to && (t.date||'') > to) return false;
    return true;
  });
}
function clientsInPeriod(){
  const from = $('#rp-from').value;
  const to = $('#rp-to').value;
  return clients.filter(c=>{
    const d = c.date || '';
    if(from && d < from) return false;
    if(to && d > to) return false;
    return true;
  });
}
/* ============ ربحية الدورات حسب النوع (تقديرية) ============ */
function courseProfitabilityData(){
  const activeClients = clients.filter(c=>!c.cancelled && !c.suspended);
  const revByType = {}, countByType = {};
  activeClients.forEach(c=>{
    const t = c.courseType || 'غير محدد';
    revByType[t] = (revByType[t]||0) + centerIncome(c);
    countByType[t] = (countByType[t]||0) + 1;
  });
  const totalRev = Object.values(revByType).reduce((a,b)=>a+b,0);
  const totalExpenses = vaultTx.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  return Object.entries(revByType).map(([type, rev])=>{
    const share = totalRev>0 ? rev/totalRev : 0;
    const allocExpense = totalExpenses * share;
    const profit = rev - allocExpense;
    const margin = rev>0 ? (profit/rev*100) : 0;
    return { type, rev, allocExpense, profit, margin, count: countByType[type]||0 };
  }).sort((a,b)=>b.profit-a.profit);
}
function renderCourseProfitability(){
  const tbody = $('#course-profit-body');
  if(!tbody) return;
  const rows = courseProfitabilityData();
  tbody.innerHTML = rows.map(r=> `<tr>
    <td>${escapeHtml(r.type)}</td>
    <td class="mono">${r.count}</td>
    <td class="mono">${fmt(r.rev)}</td>
    <td class="mono">${fmt(r.allocExpense)}</td>
    <td class="mono" style="color:${r.profit>=0?'var(--teal)':'var(--red)'};">${fmt(r.profit)}</td>
    <td class="mono">${fmt(r.margin)}%</td>
  </tr>`).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد بيانات كافية</td></tr>`;
}

/* ============ تقرير أعمار الديون (Aging / Collections) ============ */
function agingBuckets(){
  const buckets = {b0_30:[], b31_60:[], b61_90:[], b90p:[]};
  clients.filter(c=>!c.suspended && !c.cancelled && remaining(c)>0).forEach(c=>{
    const days = daysSinceDate(c.date);
    const r = remaining(c);
    const entry = {c, r, days};
    if(days<=30) buckets.b0_30.push(entry);
    else if(days<=60) buckets.b31_60.push(entry);
    else if(days<=90) buckets.b61_90.push(entry);
    else buckets.b90p.push(entry);
  });
  return buckets;
}
function renderAgingReport(){
  const cardsEl = $('#aging-summary-cards');
  const tbody = $('#aging-table-body');
  if(!cardsEl && !tbody) return;
  const b = agingBuckets();
  const sumOf = arr => arr.reduce((s,x)=>s+x.r,0);
  if(cardsEl){
    cardsEl.innerHTML = `
      <div class="card"><div class="k">0-30 يوم</div><div class="v">${fmt(sumOf(b.b0_30))}</div></div>
      <div class="card"><div class="k">31-60 يوم</div><div class="v gold">${fmt(sumOf(b.b31_60))}</div></div>
      <div class="card"><div class="k">61-90 يوم</div><div class="v gold">${fmt(sumOf(b.b61_90))}</div></div>
      <div class="card"><div class="k">أكثر من 90 يوم</div><div class="v red">${fmt(sumOf(b.b90p))}</div></div>
    `;
  }
  if(tbody){
    const all = [...b.b0_30, ...b.b31_60, ...b.b61_90, ...b.b90p].sort((x,y)=>y.days-x.days);
    tbody.innerHTML = all.map(x=> `<tr>
      <td>${escapeHtml(x.c.name||'')}</td>
      <td>${escapeHtml(x.c.phone||'')}</td>
      <td>${escapeHtml(x.c.date||'')}</td>
      <td class="mono">${x.days}</td>
      <td class="mono" style="color:${x.days>90?'var(--red)':''};">${fmt(x.r)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد ذمم متبقية 🎉</td></tr>`;
  }
}

/* ============ التقرير الشهري عبر واتساب ============ */
function lastCompleteMonthKey(){
  const d = new Date();
  d.setDate(1); // أول يوم بالشهر الحالي
  d.setDate(0); // آخر يوم بالشهر السابق (الشهر المكتمل)
  return d.toISOString().slice(0,7);
}
function monthSummaryData(key){
  const income = vaultTx.filter(t=>t.type==='in' && (t.date||'').slice(0,7)===key).reduce((s,t)=>s+num(t.amount),0);
  const expense = vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===key).reduce((s,t)=>s+num(t.amount),0);
  const regCount = clients.filter(c=>!c.suspended && (c.date||'').slice(0,7)===key).length;
  const byType = {};
  clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===key).forEach(c=>{
    const t = c.courseType || 'غير محدد';
    byType[t] = (byType[t]||0) + centerIncome(c);
  });
  const topType = Object.entries(byType).sort((a,b)=>b[1]-a[1])[0] || null;
  const totalOutstanding = clients.filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0);
  return { key, income, expense, net: income-expense, regCount, topType, totalOutstanding };
}
function monthSummaryText(key){
  const d = monthSummaryData(key);
  const label = monthLabelAr(key);
  const centerName = (settings.centerInfo && settings.centerInfo.name) || '';
  let text = `📊 ملخص ${label}${centerName?' — '+centerName:''}\n\n`;
  text += `👥 عدد التسجيلات: ${d.regCount}\n`;
  text += `💵 إجمالي الإيرادات: ${fmt(d.income)}\n`;
  text += `💸 إجمالي المصروفات: ${fmt(d.expense)}\n`;
  text += `📈 الصافي: ${fmt(d.net)}\n`;
  if(d.topType) text += `🏆 الأعلى تسجيلاً: ${d.topType[0]}\n`;
  text += `⏳ إجمالي الذمم المتبقية على العملاء (تراكمي حتى الآن): ${fmt(d.totalOutstanding)}\n`;
  return text;
}
function waLink(phone, text){
  const clean = (phone||'').replace(/[^\d]/g,'');
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}
function sendMonthlyReportWhatsapp(key){
  if(!settings.monthlyReportWhatsapp){
    showToast('يرجى إدخال رقم واتساب المستلم من الإعدادات أولاً');
    return;
  }
  const text = monthSummaryText(key);
  window.open(waLink(settings.monthlyReportWhatsapp, text), '_blank');
}
if($('#wa-report-month')) $('#wa-report-month').value = lastCompleteMonthKey();
$('#btn-send-monthly-wa')?.addEventListener('click', ()=>{
  const key = $('#wa-report-month').value;
  if(!key){ showToast('اختر الشهر أولاً'); return; }
  sendMonthlyReportWhatsapp(key);
});

/* ============ 4 تقارير PDF شهرية منفصلة عبر مشاركة الجوال (واتساب) ============
   يولّد كل تقرير كملف PDF حقيقي على جهاز المستخدم (بدون أي سيرفر) عبر html2canvas + jsPDF،
   ثم يفتح قائمة المشاركة الأصلية بالجوال (Web Share API) مع الملفات الأربعة مرفقة تلقائياً.
   ملاحظة مهمة: لا يوجد أي رابط أو API يسمح بإرسال ملفات لواتساب تلقائياً بالكامل من صفحة ويب
   عادية بدون تدخل المستخدم — أقصى شي ممكن هو فتح قائمة المشاركة وعلى المستخدم اختيار واتساب
   والضغط "إرسال". على الأجهزة/المتصفحات التي لا تدعم مشاركة الملفات، تُنزَّل الملفات الأربعة
   مباشرة ليرفقها المستخدم يدوياً. */

/* عرض التقرير داخل iframe مخفي خارج الشاشة لالتقاطه بـ html2canvas دون التأثير على واجهة المستخدم */
function renderReportToOffscreenIframe(fullHtml){
  return new Promise((resolve, reject)=>{
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed; top:-10000px; left:-10000px; width:900px; height:10px; border:0; background:#fff;';
    iframe.onload = ()=> resolve(iframe);
    iframe.onerror = ()=> reject(new Error('تعذّر تحضير التقرير'));
    document.body.appendChild(iframe);
    iframe.srcdoc = fullHtml;
  });
}
/* تحويل محتوى HTML لتقرير (نفس تنسيق تقارير الطباعة الحالية) إلى ملف PDF حقيقي متعدد الصفحات عند اللزوم */
async function htmlBodyToPdfFile(bodyHtml, {title, filename, variant='table'} = {}){
  if(typeof html2canvas==='undefined' || !window.jspdf){
    throw new Error('مكتبة توليد PDF غير متوفرة (تحقق من الاتصال بالإنترنت)');
  }
  const fullHtml = `${printDocHead(title, {variant})}<body>${bodyHtml}</body></html>`;
  const iframe = await renderReportToOffscreenIframe(fullHtml);
  try{
    await new Promise(r=> setTimeout(r, 200)); // مهلة قصيرة لضبط التخطيط قبل الالتقاط
    const doc = iframe.contentDocument;
    const canvas = await html2canvas(doc.body, {
      scale:2, backgroundColor:'#ffffff', useCORS:true,
      windowWidth: doc.documentElement.scrollWidth, windowHeight: doc.documentElement.scrollHeight,
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p','mm','a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = canvas.height * imgWidth / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    let heightLeft = imgHeight, position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while(heightLeft > 0){
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    const blob = pdf.output('blob');
    return new File([blob], filename, {type:'application/pdf'});
  } finally {
    iframe.remove();
  }
}
/* تقرير الإقرار الضريبي كمستند مستقل (بدل الاعتماد على جدول معروض بالشاشة، حتى يعمل لأي شهر مباشرة) */
function vatReturnReportBodyHtml(r, from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid #D8DEE6;':(opts&&opts.muted?'color:#66707E;':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  const summaryHtml = `<table><tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800;">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة${r.returnRows.length?` · ${r.returnRows.length} مردود`:''}</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('إجمالي المبيعات بدون الضريبة (بعد المردودات)', r.salesNet, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات (15%)', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800;">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي المشتريات بدون الضريبة', r.purchasesNet, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات (15%)', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody></table>`;
  return `
    <div class="head">
      <div><h2>الإقرار الضريبي (ضريبة القيمة المضافة)</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">عن الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    ${summaryHtml}
    ${buildVatBoxesTableHtml(r)}
    ${buildVatDetailTablesHtml(r)}`;
}
/* تقرير الحركات المالية الصادرة خلال الشهر، باستثناء ما يخص تمويل/شراء مخزون الحقائب */
function vaultOutReportBodyHtml(from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const rows = vaultTx.filter(t=> t.type==='out' && !t.isReturn && inRange(t.date, from, to) && !String(t.category||'').includes('حقائب'))
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const total = rows.reduce((s,t)=>s+num(t.amount),0);
  const rowsHtml = rows.length ? rows.map(t=>`
    <tr>
      <td class="mono">${escapeHtml(formatDateDisplay(t.date)||t.date||'—')}</td>
      <td>${escapeHtml(t.category||'—')}</td>
      <td>${escapeHtml(t.notes||'—')}</td>
      <td>${escapeHtml(t.method||'—')}</td>
      <td>${escapeHtml(t.recipientName||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
    </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد حركات صادرة في هذا الشهر</td></tr>`;
  return `
    <div class="head">
      <div><h2>الحركات المالية الصادرة</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)} (عدا ما يخص تمويل/شراء الحقائب)</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    <table>
      <thead><tr><th>التاريخ</th><th>التصنيف</th><th>ملاحظات</th><th>طريقة الدفع</th><th>مستلم المبلغ</th><th>المبلغ</th></tr></thead>
      <tbody>
        ${rowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="5">الإجمالي (${rows.length} حركة)</td><td class="mono">${fmt(total)}</td></tr>
      </tbody>
    </table>`;
}
/* تقرير الحقائب المشتراة خلال الشهر: قسمان — حقائب أضافها المركز للمخزون، وحقائب اشتراها العملاء مباشرة */
function bagsPurchasedReportBodyHtml(from, to, monthLabel){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const stockRows = bagStock.filter(b=> b.type!=='issue' && b.date && b.date>=from && b.date<=to)
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const stockQtyTotal = stockRows.reduce((s,b)=> s+num(b.qty), 0);
  const stockTypeLabel = b => (b.type==='withdraw' ? 'سحب' : (b.type==='deposit' ? 'إيداع' : 'إضافة يدوية')) + (b.manualQty ? ' (عدد فعلي)' : '');
  const stockRowsHtml = stockRows.length ? stockRows.map(b=>`
    <tr>
      <td class="mono">${escapeHtml(formatDateDisplay(b.date)||b.date||'—')}</td>
      <td>${escapeHtml(stockTypeLabel(b))}</td>
      <td class="mono">${fmt(num(b.amount!==undefined?b.amount:num(b.qty)*num(b.unitPrice)))}</td>
      <td class="mono">${num(b.qty)>0?'+':''}${num(b.qty)}</td>
      <td>${escapeHtml(b.method||'—')}</td>
    </tr>`).join('') : `<tr><td colspan="5" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد عمليات إضافة لمخزون الحقائب في هذا الشهر</td></tr>`;

  const clientRows = clients.filter(c=> ((c.bagSource==='buy' && c.bagStatus==='purchased') || c.bagSource==='stock') && !c.suspended)
    .map(c=>({ c, purchaseDate: c.bagPurchaseDate || (c.bagSource==='stock' ? c.date : '') }))
    .filter(r=> r.purchaseDate && r.purchaseDate>=from && r.purchaseDate<=to)
    .sort((a,b)=> (a.purchaseDate||'').localeCompare(b.purchaseDate||''));
  const clientValueTotal = clientRows.reduce((s,{c})=>s+num(c.bagPrice),0);
  const clientRowsHtml = clientRows.length ? clientRows.map(({c,purchaseDate})=>`
    <tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td class="mono">${escapeHtml(c.bagInvoice||'—')}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(purchaseDate)||purchaseDate||'—')}</td>
      <td>${c.bagSource==='stock' ? 'من المخزون' : 'شراء مباشر'}</td>
      <td class="mono">${fmt(num(c.bagPrice))}</td>
    </tr>`).join('') : `<tr><td colspan="7" style="text-align:center; color:#8A94A3; padding:16px;">لا توجد حقائب اشتراها عملاء في هذا الشهر</td></tr>`;

  return `
    <div class="head">
      <div><h2>الحقائب المشتراة</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)} — ${escapeHtml(monthLabel)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">الفترة: ${escapeHtml(formatDateDisplay(from))} إلى ${escapeHtml(formatDateDisplay(to))}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    <h3 style="margin:18px 0 8px;">أولاً: حقائب أضافها المركز للمخزون (تمويل/شراء)</h3>
    <table>
      <thead><tr><th>التاريخ</th><th>نوع العملية</th><th>المبلغ</th><th>عدد الحقائب (+/-)</th><th>طريقة الدفع</th></tr></thead>
      <tbody>
        ${stockRowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="3">إجمالي عدد الحقائب المضافة للمخزون</td><td class="mono">${stockQtyTotal>0?'+':''}${stockQtyTotal}</td><td></td></tr>
      </tbody>
    </table>
    <h3 style="margin:22px 0 8px;">ثانياً: عملاء اشتروا حقائبهم (مباشرة أو من المخزون)</h3>
    <table>
      <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>رقم الهاتف</th><th>رقم فاتورة الحقيبة</th><th>تاريخ الشراء</th><th>المصدر</th><th>القيمة</th></tr></thead>
      <tbody>
        ${clientRowsHtml}
        <tr style="font-weight:800; background:#F1F4F7;"><td colspan="6">الإجمالي (${clientRows.length} عميل)</td><td class="mono">${fmt(clientValueTotal)}</td></tr>
      </tbody>
    </table>`;
}
/* ---------- 3 تقارير شهرية (تسجيلات ومبالغ / الحركات الصادرة / الحقائب المشتراة) ---------- */
async function generateAndShareThreeMonthlyReports(yearMonth){
  const statusEl = $('#wa3-report-status');
  const setStatus = msg => { if(statusEl) statusEl.textContent = msg; };
  const [yStr, mStr] = yearMonth.split('-');
  const from = `${yStr}-${mStr}-01`;
  const daysInMonth = new Date(Number(yStr), Number(mStr), 0).getDate();
  const to = `${yStr}-${mStr}-${String(daysInMonth).padStart(2,'0')}`;
  const monthLabel = monthLabelAr(yearMonth);
  const btn = $('#btn-send-3-reports-wa');

  if(typeof html2canvas==='undefined' || !window.jspdf){
    setStatus('❌ لم تُحمَّل مكتبة توليد PDF بعد (تحقق من اتصال الإنترنت وأعد فتح الصفحة).');
    showToast('تعذّر تحميل مكتبة توليد PDF — تحقق من الاتصال بالإنترنت وأعد المحاولة');
    return;
  }
  if(btn) btn.disabled = true;
  setStatus('⏳ جارٍ توليد التقارير الثلاثة... قد يستغرق بضع ثوانٍ');
  showToast('جارٍ توليد التقارير...');
  try{
    const files = [];
    setStatus('⏳ (١/٣) تقرير التسجيلات والمبالغ...');
    files.push(await htmlBodyToPdfFile(monthlyClientsReportBodyHtml(yearMonth), {title:'تقرير شهري — '+monthLabel, filename:`تقرير_شهري_تسجيلات_ومبالغ_${yearMonth}.pdf`}));
    setStatus('⏳ (٢/٣) الحركات المالية الصادرة...');
    files.push(await htmlBodyToPdfFile(vaultOutReportBodyHtml(from, to, monthLabel), {title:'الحركات المالية الصادرة', filename:`الحركات_الصادرة_${yearMonth}.pdf`}));
    setStatus('⏳ (٣/٣) الحقائب المشتراة...');
    files.push(await htmlBodyToPdfFile(bagsPurchasedReportBodyHtml(from, to, monthLabel), {title:'الحقائب المشتراة', filename:`الحقائب_المشتراة_${yearMonth}.pdf`}));

    downloadFilesAndOpenWhatsapp(files, settings.monthlyPdfReportsWhatsappNumbers,
      `تقارير ${monthLabel} — مرفقة 3 ملفات PDF (تسجيلات ومبالغ، الحركات الصادرة، الحقائب المشتراة). يرجى إرفاقها من مجلد التنزيلات.`,
      setStatus, 'الملفات الثلاثة');
  }catch(e){
    console.error(e);
    setStatus('❌ حدث خطأ أثناء توليد التقارير: ' + (e.message||e));
    showToast('تعذّر توليد التقارير، حاول مجدداً');
  } finally {
    if(btn) btn.disabled = false;
  }
}
if($('#wa3-report-month')) $('#wa3-report-month').value = lastCompleteMonthKey();
$('#btn-send-3-reports-wa')?.addEventListener('click', ()=>{
  const val = $('#wa3-report-month').value;
  if(!val){ showToast('اختر الشهر أولاً'); return; }
  generateAndShareThreeMonthlyReports(val);
});

/* ---------- الإقرار الضريبي (ضريبة القيمة المضافة) — تقرير مستقل كل ربع سنة ---------- */
function quarterDateRange(year, quarter){
  const q = Number(quarter);
  const startMonth = (q-1)*3 + 1; // 1,4,7,10
  const endMonth = startMonth + 2; // 3,6,9,12
  const from = `${year}-${String(startMonth).padStart(2,'0')}-01`;
  const daysInEndMonth = new Date(Number(year), endMonth, 0).getDate();
  const to = `${year}-${String(endMonth).padStart(2,'0')}-${String(daysInEndMonth).padStart(2,'0')}`;
  const qLabels = {1:'الربع الأول (يناير–مارس)', 2:'الربع الثاني (أبريل–يونيو)', 3:'الربع الثالث (يوليو–سبتمبر)', 4:'الربع الرابع (أكتوبر–ديسمبر)'};
  return { from, to, label: `${qLabels[q]} ${year}` };
}
async function generateAndShareVatReport(year, quarter){
  const statusEl = $('#vat-report-status');
  const setStatus = msg => { if(statusEl) statusEl.textContent = msg; };
  const { from, to, label } = quarterDateRange(year, quarter);
  const btn = $('#btn-send-vat-report-wa');

  if(typeof html2canvas==='undefined' || !window.jspdf){
    setStatus('❌ لم تُحمَّل مكتبة توليد PDF بعد (تحقق من اتصال الإنترنت وأعد فتح الصفحة).');
    showToast('تعذّر تحميل مكتبة توليد PDF — تحقق من الاتصال بالإنترنت وأعد المحاولة');
    return;
  }
  if(btn) btn.disabled = true;
  setStatus('⏳ جارٍ توليد الإقرار الضريبي...');
  showToast('جارٍ توليد الإقرار الضريبي...');
  try{
    const vatReturn = buildVatReturn(from, to);
    const file = await htmlBodyToPdfFile(vatReturnReportBodyHtml(vatReturn, from, to, label), {title:'الإقرار الضريبي — '+label, filename:`الإقرار_الضريبي_${year}_ر${quarter}.pdf`});
    downloadFilesAndOpenWhatsapp([file], settings.vatPdfReportWhatsappNumbers,
      `الإقرار الضريبي (ضريبة القيمة المضافة) — ${label}. يرجى إرفاق الملف من مجلد التنزيلات.`,
      setStatus, 'ملف الإقرار الضريبي');
  }catch(e){
    console.error(e);
    setStatus('❌ حدث خطأ أثناء توليد الإقرار الضريبي: ' + (e.message||e));
    showToast('تعذّر توليد الإقرار الضريبي، حاول مجدداً');
  } finally {
    if(btn) btn.disabled = false;
  }
}
$('#btn-send-vat-report-wa')?.addEventListener('click', ()=>{
  const year = Number($('#vat-report-year').value);
  const quarter = Number($('#vat-report-quarter').value);
  if(!year || !quarter){ showToast('اختر السنة والربع أولاً'); return; }
  generateAndShareVatReport(year, quarter);
});

/* دالة مشتركة: تنزيل ملف/ملفات PDF على الجهاز، ثم فتح محادثة واتساب لكل رقم محفوظ */
function downloadFilesAndOpenWhatsapp(files, numbersRaw, waText, setStatus, filesLabel){
  files.forEach(f=>{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  showToast(`✅ تم تنزيل ${filesLabel} لجهازك`);
  const numbers = (numbersRaw||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(numbers.length){
    setStatus(`✅ تم تنزيل ${filesLabel}. جارٍ فتح محادثة واتساب لـ ${numbers.length} رقم — أرفق الملفات من مجلد التنزيلات في كل محادثة ثم أرسل.`);
    numbers.forEach((num, i)=>{
      setTimeout(()=>{ window.open(waLink(num, waText), '_blank'); }, i*700);
    });
  } else {
    setStatus(`✅ تم تنزيل ${filesLabel}. لم تُحفظ أي أرقام واتساب — أضف رقماً أو أكثر أعلاه لفتح محادثة واتساب تلقائياً في المرة القادمة، أو افتح واتساب وأرفقها يدوياً الآن.`);
    showToast('لم تُحفظ أي أرقام واتساب — أرفق الملفات المنزَّلة يدوياً في واتساب');
  }
}

/* ============ مقارنة سنة بسنة (Year-over-Year) ============ */
function yoyAvailableYears(){
  const years = new Set();
  clients.forEach(c=>{ const y = (c.date||'').slice(0,4); if(y) years.add(Number(y)); });
  vaultTx.forEach(t=>{ const y = (t.date||'').slice(0,4); if(y) years.add(Number(y)); });
  years.add(new Date().getFullYear());
  return [...years].sort((a,b)=>b-a);
}
function yoyData(year){
  const rows = [];
  for(let m=1;m<=12;m++){
    const key = `${year}-${String(m).padStart(2,'0')}`;
    const prevKey = `${year-1}-${String(m).padStart(2,'0')}`;
    const cur = monthSummaryData(key);
    const prev = monthSummaryData(prevKey);
    const growth = prev.income>0 ? ((cur.income-prev.income)/prev.income*100) : (cur.income>0 ? null : 0);
    rows.push({ label: MONTH_NAMES_AR_SHORT[m-1], curIncome: cur.income, prevIncome: prev.income, growth, curReg: cur.regCount, prevReg: prev.regCount });
  }
  return rows;
}
function renderYoY(){
  const yearSel = $('#yoy-year');
  const tbody = $('#yoy-table-body');
  if(!yearSel || !tbody) return;
  if(!yearSel.dataset.filled){
    yearSel.innerHTML = yoyAvailableYears().map(y=>`<option value="${y}">${y}</option>`).join('');
    yearSel.dataset.filled = '1';
  }
  const year = Number(yearSel.value || new Date().getFullYear());
  const rows = yoyData(year);
  tbody.innerHTML = rows.map(r=> `<tr>
    <td>${r.label}</td>
    <td class="mono">${fmt(r.curIncome)}</td>
    <td class="mono">${fmt(r.prevIncome)}</td>
    <td class="mono" style="color:${r.growth===null?'':(r.growth>=0?'var(--teal)':'var(--red)')};">${r.growth===null?'—':fmt(r.growth)+'%'}</td>
    <td class="mono">${r.curReg}</td>
    <td class="mono">${r.prevReg}</td>
  </tr>`).join('');
}
$('#yoy-year')?.addEventListener('change', renderYoY);
$('#btn-export-yoy')?.addEventListener('click', ()=>{
  const year = Number($('#yoy-year').value || new Date().getFullYear());
  const rows = yoyData(year).map(r=>({
    'الشهر': r.label, [`إيراد ${year}`]: r.curIncome, [`إيراد ${year-1}`]: r.prevIncome,
    'نسبة النمو %': r.growth===null?'':Math.round(r.growth*100)/100,
    [`تسجيلات ${year}`]: r.curReg, [`تسجيلات ${year-1}`]: r.prevReg
  }));
  downloadXlsx(`مقارنة_سنوية_${year}.xlsx`, 'مقارنة سنة بسنة', rows);
});

/* ============ حاسبة نقطة التعادل (Break-even) ============ */
function suggestedFixedCost(){
  const keys = lastNMonthKeys(3);
  const totals = keys.map(k=> vaultTx.filter(t=>t.type==='out' && (t.date||'').slice(0,7)===k).reduce((s,t)=>s+num(t.amount),0));
  return totals.length ? Math.round(totals.reduce((a,b)=>a+b,0)/totals.length) : 0;
}
function avgRevenuePerClient(){
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-90);
  const cutoffStr = cutoff.toISOString().slice(0,10);
  const recent = clients.filter(c=>!c.cancelled && (c.date||'')>=cutoffStr);
  if(!recent.length) return 0;
  const total = recent.reduce((s,c)=>s+centerIncome(c),0);
  return total/recent.length;
}
function renderBreakeven(){
  const cardsEl = $('#breakeven-cards');
  const input = $('#be-fixed-cost');
  if(!cardsEl || !input) return;
  if(!input.dataset.touched){
    input.value = suggestedFixedCost();
  }
  const fixedCost = Math.max(0, Number(input.value)||0);
  const avgRev = avgRevenuePerClient();
  const needed = avgRev>0 ? Math.ceil(fixedCost/avgRev) : 0;
  const thisMonthKey = todayISO().slice(0,7);
  const regThisMonth = clients.filter(c=>!c.cancelled && (c.date||'').slice(0,7)===thisMonthKey).length;
  const remainingNeeded = Math.max(0, needed - regThisMonth);
  cardsEl.innerHTML = `
    <div class="card"><div class="k">متوسط دخل المركز لكل متدرب (آخر 90 يوم)</div><div class="v">${fmt(avgRev)}</div></div>
    <div class="card"><div class="k">عدد المتدربين اللازم شهرياً لتغطية المصاريف</div><div class="v gold">${needed || '—'}</div></div>
    <div class="card"><div class="k">المسجَّلون هذا الشهر حتى الآن</div><div class="v teal">${regThisMonth}</div></div>
    <div class="card"><div class="k">المتبقي للوصول لنقطة التعادل هذا الشهر</div><div class="v ${remainingNeeded>0?'red':'teal'}">${needed ? remainingNeeded : '—'}</div></div>
  `;
}
$('#be-fixed-cost')?.addEventListener('input', e=>{ e.target.dataset.touched='1'; renderBreakeven(); });
$('#btn-suggest-fixed-cost')?.addEventListener('click', ()=>{
  $('#be-fixed-cost').value = suggestedFixedCost();
  $('#be-fixed-cost').dataset.touched='1';
  renderBreakeven();
});

function renderReports(){
  if($('#wa3-report-month') && !$('#wa3-report-month').value) $('#wa3-report-month').value = lastCompleteMonthKey();
  if($('#vat-report-year') && !$('#vat-report-year').value) $('#vat-report-year').value = new Date().getFullYear();
  if($('#vat-report-quarter') && !$('#vat-report-quarter').value) $('#vat-report-quarter').value = String(Math.max(1, Math.ceil((new Date().getMonth()) / 3)) || 1);
  renderBudget();
  renderCourseProfitability();
  renderAgingReport();
  renderYoY();
  renderBreakeven();
  const rows = periodFilteredVaultTx();
  const income = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clientsInPeriod();
  const avgPerClient = cInPeriod.length ? income/cInPeriod.length : 0;
  $('#period-cards').innerHTML = `
    <div class="card"><div class="k">إيرادات الفترة</div><div class="v teal">${fmt(income)}</div></div>
    <div class="card"><div class="k">مصروفات الفترة</div><div class="v red">${fmt(expense)}</div></div>
    <div class="card"><div class="k">صافي الفترة</div><div class="v ${(income-expense)<0?'red':'gold'}">${fmt(income-expense)}</div></div>
    <div class="card"><div class="k">عدد العملاء المسجّلين بالفترة</div><div class="v">${cInPeriod.length}</div></div>
    <div class="card"><div class="k">متوسط الإيراد لكل عميل بالفترة</div><div class="v">${fmt(avgPerClient)}</div></div>
  `;
  // مقارنة بالفترة السابقة مباشرة (بنفس عدد الأيام)
  const cmp = periodComparison();
  const net = income - expense;
  const prevNet = cmp.prevIncome - cmp.prevExpense;
  $('#period-compare-hint').textContent = `مقارنة بالفترة من ${formatDateDisplay(cmp.prevFromISO)} إلى ${formatDateDisplay(cmp.prevToISO)}`;
  $('#period-compare-cards').innerHTML = `
    <div class="card"><div class="k">الإيرادات</div><div class="v teal">${fmt(income)}</div>${changeBadgePositive(pctChange(income, cmp.prevIncome))}</div>
    <div class="card"><div class="k">المصروفات</div><div class="v red">${fmt(expense)}</div>${changeBadgeNegative(pctChange(expense, cmp.prevExpense))}</div>
    <div class="card"><div class="k">الصافي</div><div class="v ${net<0?'red':'gold'}">${fmt(net)}</div>${changeBadgePositive(pctChange(net, prevNet))}</div>
    <div class="card"><div class="k">عدد العملاء</div><div class="v">${cInPeriod.length}</div>${changeBadgePositive(pctChange(cInPeriod.length, cmp.prevClients))}</div>
  `;
  // الاتجاهات الشهرية (آخر 12 شهر) — مستقلة عن فلتر الفترة
  const finTrend = monthlyFinancialTrend(12);
  drawLineChart('#chart-trend-financial', finTrend.labels, finTrend.series);
  const clientsTrend = monthlyRegistrationsTrend(12);
  drawLineChart('#chart-trend-clients', clientsTrend.labels, clientsTrend.series);
  // جدول شهري: عدد المسجّلين والمبالغ المدفوعة (كاش/شبكة/بنك)
  const monthlyTable = monthlyRegistrationsPaymentsTable(12);
  $('#monthly-summary-body').innerHTML = monthlyTable.map(m=>`
    <tr>
      <td>${m.label}</td>
      <td class="mono">${m.regCount}</td>
      <td class="mono">${fmt(m.cash)}</td>
      <td class="mono">${fmt(m.network)}</td>
      <td class="mono">${fmt(m.bank)}</td>
      <td class="mono" style="font-weight:bold;">${fmt(m.total)}</td>
    </tr>`).join('');
  // دخل المركز حسب نوع الدورة (يحترم فلتر الفترة الحالي)
  drawBars('#chart-report-revenue-course', revenueByCourseType());
  const catTotals = {};
  rows.filter(t=>t.type==='out').forEach(t=>{ const k=t.category||'أخرى'; catTotals[k]=(catTotals[k]||0)+num(t.amount); });
  drawBars('#chart-report-expense', Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([k,v])=>[k, Math.round(v*100)/100]));
}
['#rp-from','#rp-to'].forEach(sel=> $(sel).addEventListener('input', renderReports));
$('#btn-export-monthly-summary')?.addEventListener('click', ()=>{
  const monthlyTable = monthlyRegistrationsPaymentsTable(12);
  const headers = ['الشهر','عدد المسجّلين','نقدي (كاش)','شبكة','بنك','إجمالي المدفوع'];
  const rows = monthlyTable.map(m=>[m.label, m.regCount, m.cash, m.network, m.bank, m.total]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'الجدول_الشهري_للتسجيلات_والمدفوعات.csv';
  a.click();
});
$('#btn-export-report').addEventListener('click', ()=>{
  const rows = periodFilteredVaultTx();
  const income = rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0);
  const expense = rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
  const cInPeriod = clientsInPeriod();
  const from = $('#rp-from').value || 'البداية';
  const to = $('#rp-to').value || 'الآن';
  const summary = [
    ['الفترة', `من ${from} إلى ${to}`],
    ['إجمالي الإيرادات', income],
    ['إجمالي المصروفات', expense],
    ['صافي الفترة', income-expense],
    ['عدد العملاء المسجّلين بالفترة', cInPeriod.length],
    ['متوسط الإيراد لكل عميل', cInPeriod.length ? Math.round((income/cInPeriod.length)*100)/100 : 0],
  ];
  const csv = '\uFEFF'+summary.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `تقرير_الفترة_${from}_${to}.csv`;
  a.click();
});

/* ================================================================
   المحاسبة — قوائم مالية على أساس الاستحقاق (دخل / ميزانية / ميزان مراجعة)
   ================================================================ */
function inRange(d, from, to){ d = d||''; if(from && d < from) return false; if(to && d > to) return false; return true; }
function isLoanTx(t){ return !t.clientId && /قرض/i.test(`${t.notes||''} ${t.manual||''} ${t.category||''}`); }
function journalUpTo(asOf){ return journalEntries.filter(j=> !asOf || (j.date||'') <= asOf); }
function journalInRange(from, to){ return journalEntries.filter(j=> inRange(j.date, from, to)); }

/* ---- أرصدة الخزنة/البنك/الشبكة كأرصدة تراكمية حتى تاريخ معيّن ---- */
function balanceOfAsOf(dest, asOf){
  const rows = vaultTx.filter(t=> !asOf || (t.date||'') <= asOf);
  return rows.filter(t=>(t.destination||'vault')===dest && t.type==='in').reduce((s,t)=>s+num(t.amount),0)
       - rows.filter(t=>(t.destination||'vault')===dest && t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
/* ---- ذمم العملاء (مدينون) كأرصدة تراكمية حتى تاريخ معيّن ---- */
function paidTotalAsOf(c, asOf){
  if(!c.clientId) return (!asOf || (c.date||'')<=asOf) ? (num(c.paid)+num(c.paid2)) : 0;
  const txs = vaultInTxIndex().get(c.clientId);
  if(!txs) return 0;
  return txs.reduce((s,t)=> (!asOf || (t.date||'')<=asOf) ? s+num(t.amount) : s, 0);
}
function receivablesAsOf(asOf){
  return clients.filter(c=>!c.suspended && !c.cancelled && (!asOf || (c.date||'')<=asOf))
    .reduce((s,c)=> s + Math.max(0, total(c) - paidTotalAsOf(c, asOf)), 0);
}
/* ---- مخزون الحقائب والتزام أمانة الحقائب تجاه العملاء، كأرصدة تراكمية حتى تاريخ معيّن ---- */
function bagStockQtyAsOf(asOf){
  return bagStock.filter(b=> !asOf || (b.date||'')<=asOf).reduce((s,x)=>s+num(x.qty),0);
}
function bagDeliveredAsOf(asOf){
  const stockIssued = clients.filter(c=>c.bagSource==='stock' && !c.suspended && (!asOf || (c.date||'')<=asOf)).length;
  const spentDirect = clients.filter(c=>c.bagSource==='buy' && c.bagStatus==='purchased' && !c.suspended && (!asOf || (c.date||'')<=asOf))
    .reduce((s,c)=>s+num(c.bagPrice),0);
  return { stockIssued, spentDirect };
}
function bagInventoryValueAsOf(asOf){
  const qty = Math.max(0, bagStockQtyAsOf(asOf));
  return qty * num(settings.bagPrice);
}
function bagCustodyLiabilityAsOf(asOf){
  const bagCollected = clients.filter(c=>!c.suspended && (!asOf || (c.date||'')<=asOf)).reduce((s,c)=>s+bagAmount(c),0);
  const { stockIssued, spentDirect } = bagDeliveredAsOf(asOf);
  return bagCollected - (stockIssued*num(settings.bagPrice) + spentDirect);
}
/* ---- قروض مصنَّفة تلقائياً من الملاحظات ("قرض") ضمن الحركات غير المرتبطة بعميل ---- */
function loansPayableAsOf(asOf){
  const rows = vaultTx.filter(t=> !t.clientId && !t.bagStockRef && isLoanTx(t) && (!asOf || (t.date||'')<=asOf));
  return rows.filter(t=>t.type==='in').reduce((s,t)=>s+num(t.amount),0) - rows.filter(t=>t.type==='out').reduce((s,t)=>s+num(t.amount),0);
}
/* ---- القيود اليدوية: أصول ثابتة / إهلاك / التزامات ---- */
function fixedAssetsTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='fixedasset').reduce((s,j)=>s+num(j.amount),0); }
function depreciationTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0); }
function accruedTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0); }
function otherLiabilityTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='otherliability').reduce((s,j)=>s+num(j.amount),0); }
function readjTotalAsOf(asOf){ return journalUpTo(asOf).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0); }

/* ---- قائمة الدخل التشغيلية عن فترة (from..to)، مبنية على أساس الاستحقاق ---- */
function revenueBreakdown(from, to){
  const rows = clients.filter(c=>!c.cancelled && inRange(c.date, from, to));
  const totals = {};
  rows.forEach(c=>{ const k = c.courseType || 'دخل دورات غير مصنّف'; totals[k] = (totals[k]||0) + centerIncome(c); });
  return totals;
}
function salesReturnsTotal(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to)).reduce((s,t)=>s+num(t.amount),0);
}
function expenseBreakdown(from, to){
  const rows = vaultTx.filter(t=>t.type==='out' && !t.bagStockRef && !t.isReturn && t.category!=='مسحوبات شركاء' && !isLoanTx(t) && inRange(t.date, from, to));
  const totals = {};
  rows.forEach(t=>{ const k = t.category || 'مصروفات أخرى'; totals[k] = (totals[k]||0) + num(t.amount); });
  return totals;
}
function drawingsTotal(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.category==='مسحوبات شركاء' && inRange(t.date, from, to)).reduce((s,t)=>s+num(t.amount),0);
}
function otherContributionsTotal(from, to){
  return vaultTx.filter(t=>t.type==='in' && !t.clientId && !t.bagStockRef && !isLoanTx(t) && inRange(t.date, from, to)).reduce((s,t)=>s+num(t.amount),0);
}
/* صافي الربح/الخسارة عن فترة، شاملاً أي قيود إهلاك أو مستحقات أو تسويات يدوية داخل نفس الفترة */
function netIncomeOf(from, to){
  const rev = Object.values(revenueBreakdown(from,to)).reduce((a,b)=>a+b,0) - salesReturnsTotal(from,to);
  const exp = Object.values(expenseBreakdown(from,to)).reduce((a,b)=>a+b,0);
  const dep = journalInRange(from,to).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0);
  const acc = journalInRange(from,to).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0);
  const rj  = journalInRange(from,to).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0);
  return rev - exp - dep - acc + rj;
}
/* الأرباح المرحلة كرصيد تراكمي حتى تاريخ معيّن (منذ بداية بيانات النظام) */
function retainedEarningsAsOf(asOf){
  return netIncomeOf(null, asOf) - drawingsTotal(null, asOf);
}

/* ---- حدود الفترة المحاسبية المختارة في الشاشة ---- */
function accSelectedRange(){
  const year = $('#acc-year')?.value || String(new Date().getFullYear());
  const period = $('#acc-period')?.value || 'year';
  const map = {
    year: [`${year}-01-01`, `${year}-12-31`],
    q1: [`${year}-01-01`, `${year}-03-31`],
    q2: [`${year}-04-01`, `${year}-06-30`],
    q3: [`${year}-07-01`, `${year}-09-30`],
    q4: [`${year}-10-01`, `${year}-12-31`],
  };
  const [from, to] = map[period] || map.year;
  return { year, period, from, to, asOf: to };
}
function accPeriodLabel(period){
  return {year:'السنة كاملة', q1:'الربع الأول', q2:'الربع الثاني', q3:'الربع الثالث', q4:'الربع الرابع'}[period] || 'السنة كاملة';
}

/* ---- الإقرار الضريبي (ضريبة القيمة المضافة): ضريبة المخرجات من فواتير الدورات + الفواتير اليدوية − مردودات المبيعات، ضريبة المدخلات من المشتريات ---- */
function buildVatReturn(from, to){
  // ضريبة المخرجات: فواتير الدورات (رقم فاتورة + قيمة فعلية بالإيصال، حسب تاريخ صدور الفاتورة) + فواتير المبيعات اليدوية
  const courseRows = courseInvoiceClients().filter(c=>{
    const d = c.receiptIssueDate || '';
    return num(c.receiptActualValue) > 0 && d && d>=from && d<=to;
  }).map(c=>({
    source:'course', date: c.receiptIssueDate, name: c.name||'', clientId: c.clientId||'', invoice: c.invoice||'',
    totalInclVat: num(c.receiptActualValue), vat: courseInvoiceVat(c.receiptActualValue)
  }));
  const manualRows = manualSalesInvoices.filter(m=> m.date && m.date>=from && m.date<=to).map(m=>({
    source:'manual', date: m.date, name: m.name||'', clientId:'', invoice: formatManualSalesInvoiceNo(m.invoiceNo||0),
    totalInclVat: num(m.total), vat: num(m.total) - (num(m.total)/1.15)
  }));
  const salesRows = courseRows.concat(manualRows);
  const salesGross = salesRows.reduce((s,r)=> s+r.totalInclVat, 0);
  const outputVatGross = salesRows.reduce((s,r)=> s+r.vat, 0);

  // مردودات المبيعات (استرجاعات) خلال نفس الفترة
  const returnRows = vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to))
    .map(t=>({ date:t.date, name:t.clientName||t.clientId||'—', amount:num(t.amount), vat: num(t.amount)-(num(t.amount)/1.15) }))
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  const returnsGross = returnRows.reduce((s,r)=> s+r.amount, 0);
  const returnsVat = returnRows.reduce((s,r)=> s+r.vat, 0);

  const outputVat = outputVatGross - returnsVat;
  const salesNet = (salesGross - outputVatGross) - (returnsGross - returnsVat);

  // ضريبة المدخلات: فواتير الشراء حسب تاريخ الشراء
  const purchaseRows = (typeof purchases!=='undefined' ? purchases : []).filter(p=> p.date && p.date>=from && p.date<=to);
  const purchasesNet = purchaseRows.reduce((s,p)=> s+num(p.subtotal), 0);
  const inputVat = purchaseRows.reduce((s,p)=> s+num(p.taxAmount), 0);
  const purchasesGross = purchasesNet + inputVat;

  const netVat = outputVat - inputVat;
  salesRows.sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  purchaseRows.sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  return { salesRows, returnRows, purchaseRows, salesGross, salesNet, outputVat, returnsGross, returnsVat, purchasesGross, purchasesNet, inputVat, netVat };
}
function renderVatReturnTable(from, to){
  const table = $('#acc-vat-table');
  if(!table) return;
  const r = buildVatReturn(from, to);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  table.innerHTML = `<tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة${r.returnRows.length?` · ${r.returnRows.length} مردود`:''}</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('إجمالي المبيعات بدون الضريبة (بعد المردودات)', r.salesNet, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات (15%)', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي المشتريات بدون الضريبة', r.purchasesNet, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات (15%)', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody>`;
}
$('#btn-export-vat')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  const r = buildVatReturn(from, to);
  const summaryRows = [
    {'البند':'إجمالي المبيعات شامل الضريبة', 'القيمة':r.salesGross},
    {'البند':'يُخصم: مردودات مبيعات (شامل الضريبة)', 'القيمة':-r.returnsGross},
    {'البند':'إجمالي المبيعات بدون الضريبة (بعد المردودات)', 'القيمة':r.salesNet},
    {'البند':'صافي ضريبة المخرجات (15%)', 'القيمة':r.outputVat},
    {'البند':'إجمالي المشتريات شامل الضريبة', 'القيمة':r.purchasesGross},
    {'البند':'إجمالي المشتريات بدون الضريبة', 'القيمة':r.purchasesNet},
    {'البند':'إجمالي ضريبة المدخلات (15%)', 'القيمة':r.inputVat},
    {'البند': r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', 'القيمة':Math.abs(r.netVat)},
  ];
  const salesDetailRows = r.salesRows.map(c=>({
    'التاريخ': c.date||'', 'العميل': c.name||'', 'رقم الهوية': c.clientId||'', 'رقم الفاتورة': c.invoice||'', 'المصدر': c.source==='manual'?'يدوي':'فاتورة دورة',
    'القيمة بدون الضريبة': c.totalInclVat - c.vat, 'الضريبة': c.vat, 'الإجمالي': c.totalInclVat,
  }));
  const returnsDetailRows = r.returnRows.map(t=>({
    'التاريخ': t.date||'', 'العميل': t.name||'', 'القيمة بدون الضريبة': t.amount - t.vat, 'الضريبة': t.vat, 'الإجمالي': t.amount,
  }));
  const purchaseDetailRows = r.purchaseRows.map(p=>({
    'التاريخ': p.date||'', 'المورد': p.supplierName||'', 'رقم الفاتورة': p.invoiceNo||'',
    'القيمة بدون الضريبة': num(p.subtotal), 'الضريبة': num(p.taxAmount), 'الإجمالي': num(p.total),
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'ملخص الإقرار');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesDetailRows), 'تفاصيل المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(returnsDetailRows), 'تفاصيل المردودات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(purchaseDetailRows), 'تفاصيل المشتريات');
  XLSX.writeFile(wb, `الإقرار_الضريبي_${from}_${to}.xlsx`);
});
function populateAccYearSelect(){
  const sel = $('#acc-year');
  if(!sel) return;
  const years = collectAllYears();
  const thisYear = String(new Date().getFullYear());
  if(!years.includes(thisYear)) years.unshift(thisYear);
  const keep = sel.value;
  sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value = years.includes(keep) ? keep : (years.includes(String(selectedYearFilter)) ? String(selectedYearFilter) : years[0]);
}

/* ---- بناء الميزانية العمومية الكاملة كأرصدة تراكمية حتى asOf ---- */
function buildBalanceSheet(asOf){
  const cash = balanceOfAsOf('vault', asOf);
  const bank = balanceOfAsOf('bank', asOf);
  const network = balanceOfAsOf('network', asOf);
  const receivables = receivablesAsOf(asOf);
  const bagInventory = bagInventoryValueAsOf(asOf);
  const fixedAssetsGross = fixedAssetsTotalAsOf(asOf);
  const accumDep = depreciationTotalAsOf(asOf);
  const fixedAssetsNet = fixedAssetsGross - accumDep;

  let bagCustody = bagCustodyLiabilityAsOf(asOf);
  let bagCustodyAsset = 0;
  if(bagCustody < 0){ bagCustodyAsset = -bagCustody; bagCustody = 0; } // تسليم أكثر مما حُصِّل (نادر) يُعرض كأصل بدل التزام سالب

  const loans = Math.max(0, loansPayableAsOf(asOf));
  const accrued = accruedTotalAsOf(asOf);
  const otherLiab = otherLiabilityTotalAsOf(asOf);

  const totalAssets = cash + bank + network + receivables + bagInventory + Math.max(0,fixedAssetsNet) + bagCustodyAsset;
  const totalLiabilities = bagCustody + loans + accrued + otherLiab;
  const retainedEarnings = retainedEarningsAsOf(asOf);
  const totalEquity = totalAssets - totalLiabilities;
  const ownerCapital = totalEquity - retainedEarnings;

  return {
    cash, bank, network, receivables, bagInventory, fixedAssetsGross, accumDep, fixedAssetsNet,
    bagCustody, bagCustodyAsset, loans, accrued, otherLiab,
    totalAssets, totalLiabilities, retainedEarnings, ownerCapital, totalEquity
  };
}

/* ---- قائمة التدفقات النقدية (الطريقة المباشرة) من حركات الخزنة/البنك/الشبكة فعلياً خلال الفترة ---- */
function buildCashFlowStatement(from, to){
  const rows = vaultTx.filter(t=> inRange(t.date, from, to) && (t.destination||'vault')!=='other');
  let opIn=0, opReturns=0, opOut=0, finIn=0, finOut=0, invOut=0;
  const isFinancingCat = c => /مسحوبات|شركاء|قرض|رأس ?مال/.test(c||'');
  const isInvestingCat = c => /أصل|أصول/.test(c||'');
  rows.forEach(t=>{
    const amt = num(t.amount);
    if(t.type==='in'){
      if(t.clientId) opIn += amt; else finIn += amt;
    } else if(t.type==='out'){
      if(t.isReturn) opReturns += amt;
      else if(isFinancingCat(t.category)) finOut += amt;
      else if(isInvestingCat(t.category)) invOut += amt;
      else opOut += amt;
    }
  });
  const netOperating = opIn - opReturns - opOut;
  const netInvesting = -invOut;
  const netFinancing = finIn - finOut;
  const netChange = netOperating + netInvesting + netFinancing;
  const priorDay = addDaysISO(from, -1);
  const beginCash = balanceOfAsOf('vault', priorDay) + balanceOfAsOf('bank', priorDay) + balanceOfAsOf('network', priorDay);
  const endCash = balanceOfAsOf('vault', to) + balanceOfAsOf('bank', to) + balanceOfAsOf('network', to);
  return { opIn, opReturns, opOut, netOperating, invOut, netInvesting, finIn, finOut, netFinancing, netChange, beginCash, endCash };
}
function renderCashFlowTable(from, to){
  const table = $('#acc-cashflow-table');
  if(!table) return null;
  const cf = buildCashFlowStatement(from, to);
  table.innerHTML = `<tbody>
    ${accHeaderRow('الأنشطة التشغيلية')}
    ${accRow('مقبوضات من العملاء', cf.opIn, {indent:true})}
    ${accRow('مسترد للعملاء (مردودات مبيعات)', -cf.opReturns, {indent:true})}
    ${accRow('مدفوعات تشغيلية ومشتريات', -cf.opOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة التشغيلية', cf.netOperating, {total:true})}
    ${accHeaderRow('الأنشطة الاستثمارية')}
    ${accRow('شراء أصول ثابتة', -cf.invOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة الاستثمارية', cf.netInvesting, {total:true})}
    ${accHeaderRow('الأنشطة التمويلية')}
    ${accRow('مساهمات / دعم رأس مال / قروض واردة', cf.finIn, {indent:true})}
    ${accRow('مسحوبات شركاء / سداد قروض', -cf.finOut, {indent:true})}
    ${accRow('صافي النقد من الأنشطة التمويلية', cf.netFinancing, {total:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${accRow('صافي التغيّر في النقدية خلال الفترة', cf.netChange, {total:true})}
    ${accRow('رصيد النقدية في بداية الفترة', cf.beginCash, {indent:true})}
    ${accRow('رصيد النقدية في نهاية الفترة (فعلياً)', cf.endCash, {total:true})}
  </tbody>`;
  const expected = cf.beginCash + cf.netChange;
  const diff = cf.endCash - expected;
  const checkEl = $('#acc-cashflow-check');
  if(checkEl){
    checkEl.innerHTML = Math.abs(diff) < 1
      ? `<span style="color:var(--teal); font-weight:700;">✅ متطابقة: بداية الفترة + صافي التغيّر = نهاية الفترة فعلياً</span>`
      : `<span style="color:var(--red); font-weight:700;">⚠️ فرق ${fmt(Math.abs(diff))} ﷼ بين المتوقع والفعلي — راجع حركات الخزنة بدون تصنيف واضح (تصنيف "أخرى" أو معاملات خارج الفترة المحددة).</span>`;
  }
  return cf;
}
$('#btn-export-cashflow')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  renderCashFlowTable(from, to);
  csvDownload(`قائمة_التدفقات_النقدية_${from}_${to}.csv`, tableToRows('#acc-cashflow-table'));
});
$('#btn-print-cashflow')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  renderCashFlowTable(from, to);
  printAccountingReport('قائمة التدفقات النقدية', '#acc-cashflow-table');
});

/* ---- الذمم المدينة والدائنة (أعمار الديون) ---- */
function daysBetweenISO(fromIso, toIso){
  if(!fromIso || !toIso) return 0;
  const a = new Date(fromIso+'T00:00:00'), b = new Date(toIso+'T00:00:00');
  return Math.round((b-a) / 86400000);
}
function agingBucket(days){
  if(days<=30) return '0–30 يوم';
  if(days<=60) return '31–60 يوم';
  if(days<=90) return '61–90 يوم';
  return 'أكثر من 90 يوم';
}
function buildARAging(asOf){
  const rows = clients.filter(c=>!c.suspended && !c.cancelled).map(c=>{
    const bal = Math.max(0, total(c) - paidTotalAsOf(c, asOf));
    if(bal<=0) return null;
    const dueDate = c.clientType==='company' && num(c.creditDays)>0 ? addDaysISO(c.date||asOf, num(c.creditDays)) : (c.date||asOf);
    const days = Math.max(0, daysBetweenISO(dueDate, asOf));
    return { name:c.name||'—', clientId:c.clientId||'—', phone:c.phone||'—', dueDate, days, amount: bal, bucket: agingBucket(days) };
  }).filter(Boolean).sort((a,b)=> b.days - a.days);
  const buckets = {'0–30 يوم':0, '31–60 يوم':0, '61–90 يوم':0, 'أكثر من 90 يوم':0};
  rows.forEach(r=> buckets[r.bucket] += r.amount);
  const total_ = rows.reduce((s,r)=>s+r.amount,0);
  return { rows, buckets, total: total_ };
}
function buildAPAging(asOf){
  const rows = purchases.filter(p=> p.status==='unpaid' && (p.date||'')<=asOf).map(p=>{
    const days = Math.max(0, daysBetweenISO(p.date||asOf, asOf));
    return { supplierName:p.supplierName||'—', invoiceNo:p.invoiceNo||'—', date:p.date||'', days, amount:num(p.total), bucket: agingBucket(days) };
  }).sort((a,b)=> b.days - a.days);
  const buckets = {'0–30 يوم':0, '31–60 يوم':0, '61–90 يوم':0, 'أكثر من 90 يوم':0};
  rows.forEach(r=> buckets[r.bucket] += r.amount);
  const total_ = rows.reduce((s,r)=>s+r.amount,0);
  return { rows, buckets, total: total_ };
}
function agingCardsHtml(data){
  return `
    <div class="card"><div class="k">الإجمالي</div><div class="v">${fmt(data.total)}</div></div>
    <div class="card"><div class="k">0–30 يوم</div><div class="v teal">${fmt(data.buckets['0–30 يوم'])}</div></div>
    <div class="card"><div class="k">31–60 يوم</div><div class="v gold">${fmt(data.buckets['31–60 يوم'])}</div></div>
    <div class="card"><div class="k">61–90 يوم</div><div class="v gold">${fmt(data.buckets['61–90 يوم'])}</div></div>
    <div class="card"><div class="k">أكثر من 90 يوم</div><div class="v red">${fmt(data.buckets['أكثر من 90 يوم'])}</div></div>
  `;
}
function renderARAging(asOf){
  const data = buildARAging(asOf);
  $('#ar-summary-cards') && ($('#ar-summary-cards').innerHTML = agingCardsHtml(data));
  const tbody = $('#ar-table-body');
  if(tbody){
    tbody.innerHTML = data.rows.map(r=> `<tr>
      <td>${escapeHtml(r.name)}</td><td class="mono">${escapeHtml(r.clientId)}</td><td class="mono">${escapeHtml(r.phone)}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(r.dueDate)||r.dueDate||'—')}</td>
      <td class="mono" style="${r.days>90?'color:var(--red); font-weight:700;':''}">${r.days}</td>
      <td class="mono">${fmt(r.amount)}</td><td>${r.bucket}</td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد ذمم مدينة حتى هذا التاريخ</td></tr>`;
  }
  return data;
}
function renderAPAging(asOf){
  const data = buildAPAging(asOf);
  $('#ap-summary-cards') && ($('#ap-summary-cards').innerHTML = agingCardsHtml(data));
  const tbody = $('#ap-table-body');
  if(tbody){
    tbody.innerHTML = data.rows.map(r=> `<tr>
      <td>${escapeHtml(r.supplierName)}</td><td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td class="mono">${escapeHtml(formatDateDisplay(r.date)||r.date||'—')}</td>
      <td class="mono" style="${r.days>90?'color:var(--red); font-weight:700;':''}">${r.days}</td>
      <td class="mono">${fmt(r.amount)}</td><td>${r.bucket}</td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد ذمم دائنة غير مسددة حتى هذا التاريخ</td></tr>`;
  }
  return data;
}
function renderARAPModule(){
  if(!$('#view-accounting')) return;
  if($('#arap-asof') && !$('#arap-asof').value) $('#arap-asof').value = todayISO();
  const asOf = $('#arap-asof')?.value || todayISO();
  renderARAging(asOf);
  renderAPAging(asOf);
}
$('#arap-asof')?.addEventListener('change', renderARAPModule);
$('#btn-export-ar')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  const data = buildARAging(asOf);
  csvDownload(`ذمم_العملاء_المدينة_${asOf}.csv`, [
    ['العميل','رقم الهوية','الجوال','تاريخ الاستحقاق','أيام التأخر','المتبقي','الفئة العمرية'],
    ...data.rows.map(r=>[r.name, r.clientId, r.phone, r.dueDate, r.days, r.amount, r.bucket])
  ]);
});
$('#btn-print-ar')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  renderARAging(asOf);
  printAccountingReport(`ذمم العملاء المدينة كما في ${formatDateDisplay(asOf)||asOf}`, '#ar-table');
});
$('#btn-export-ap')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  const data = buildAPAging(asOf);
  csvDownload(`ذمم_الموردين_الدائنة_${asOf}.csv`, [
    ['المورد','رقم الفاتورة','تاريخ الفاتورة','أيام التأخر','المبلغ','الفئة العمرية'],
    ...data.rows.map(r=>[r.supplierName, r.invoiceNo, r.date, r.days, r.amount, r.bucket])
  ]);
});
$('#btn-print-ap')?.addEventListener('click', ()=>{
  const asOf = $('#arap-asof')?.value || todayISO();
  renderAPAging(asOf);
  printAccountingReport(`ذمم الموردين الدائنة كما في ${formatDateDisplay(asOf)||asOf}`, '#ap-table');
});

function renderAccSummaryCards(bs, ni, rev, exp){
  $('#acc-summary-cards').innerHTML = `
    <div class="card"><div class="k">إجمالي الأصول</div><div class="v teal">${fmt(bs.totalAssets)}</div></div>
    <div class="card"><div class="k">إجمالي الخصوم</div><div class="v red">${fmt(bs.totalLiabilities)}</div></div>
    <div class="card"><div class="k">إجمالي حقوق الملكية</div><div class="v gold">${fmt(bs.totalEquity)}</div></div>
    <div class="card"><div class="k">إيرادات الفترة</div><div class="v teal">${fmt(rev)}</div></div>
    <div class="card"><div class="k">مصروفات الفترة</div><div class="v red">${fmt(exp)}</div></div>
    <div class="card"><div class="k">صافي ربح/خسارة الفترة</div><div class="v ${ni<0?'red':'gold'}">${fmt(ni)}</div></div>
  `;
}

function accRow(label, value, opts){
  opts = opts || {};
  const style = opts.total ? 'font-weight:800; border-top:1px solid var(--border);' : (opts.indent ? 'color:var(--text-muted);' : '');
  const pad = opts.indent ? 'padding-right:22px;' : '';
  return `<tr style="${style}"><td style="${pad}">${escapeHtml(label)}</td><td class="mono" style="text-align:left;">${value===''?'':fmt(value)}</td></tr>`;
}
function accHeaderRow(label){
  return `<tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">${escapeHtml(label)}</td></tr>`;
}

function renderIncomeStatementTable(from, to){
  const revB = revenueBreakdown(from, to);
  const returns = salesReturnsTotal(from, to);
  const grossRevenue = Object.values(revB).reduce((a,b)=>a+b,0);
  const netRevenue = grossRevenue - returns;
  const expB = expenseBreakdown(from, to);
  const totalExpense = Object.values(expB).reduce((a,b)=>a+b,0);
  const dep = journalInRange(from,to).filter(j=>j.type==='depreciation').reduce((s,j)=>s+num(j.amount),0);
  const acc = journalInRange(from,to).filter(j=>j.type==='accrued').reduce((s,j)=>s+num(j.amount),0);
  const rj  = journalInRange(from,to).filter(j=>j.type==='readj').reduce((s,j)=>s+num(j.amount),0);
  const netIncome = netRevenue - totalExpense - dep - acc + rj;

  let html = accHeaderRow('الإيرادات (حسب نوع الدورة، على أساس الاستحقاق)');
  Object.entries(revB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  html += accRow('إجمالي الإيرادات', grossRevenue);
  if(returns>0) html += accRow('يُخصم: مردودات مبيعات', -returns, {indent:true});
  html += accRow('صافي الإيرادات', netRevenue, {total:true});

  html += accHeaderRow('المصروفات التشغيلية (حسب التصنيف)');
  Object.entries(expB).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{ html += accRow(k, v, {indent:true}); });
  if(dep>0) html += accRow('مصروف الإهلاك (قيد يدوي)', dep, {indent:true});
  if(acc>0) html += accRow('مصروف مستحق (قيد يدوي)', acc, {indent:true});
  html += accRow('إجمالي المصروفات', totalExpense+dep+acc, {total:true});

  if(rj) html += accRow('تسويات أخرى على الأرباح (قيد يدوي)', rj);
  html += accHeaderRow('');
  html += accRow('صافي الربح / (الخسارة) عن الفترة', netIncome, {total:true});

  $('#acc-income-table tbody').innerHTML = html;
  return { netRevenue, totalExpense: totalExpense+dep+acc, netIncome, grossRevenue };
}

function renderBalanceSheetTable(asOf, bs){
  let html = accHeaderRow('الأصول المتداولة');
  html += accRow('الخزنة (كاش)', bs.cash, {indent:true});
  html += accRow('البنك', bs.bank, {indent:true});
  html += accRow('الشبكة', bs.network, {indent:true});
  html += accRow('ذمم العملاء (مدينون)', bs.receivables, {indent:true});
  html += accRow('مخزون الحقائب', bs.bagInventory, {indent:true});
  if(bs.bagCustodyAsset>0) html += accRow('سلفة حقائب مسلَّمة تفوق المحصَّل', bs.bagCustodyAsset, {indent:true});
  const currentAssets = bs.cash+bs.bank+bs.network+bs.receivables+bs.bagInventory+bs.bagCustodyAsset;
  html += accRow('إجمالي الأصول المتداولة', currentAssets);

  if(bs.fixedAssetsGross>0){
    html += accHeaderRow('الأصول غير المتداولة');
    html += accRow('الأصول الثابتة (بالتكلفة)', bs.fixedAssetsGross, {indent:true});
    html += accRow('يُخصم: مجمّع الإهلاك', -bs.accumDep, {indent:true});
    html += accRow('صافي الأصول الثابتة', Math.max(0,bs.fixedAssetsNet));
  }
  html += accRow('إجمالي الأصول', bs.totalAssets, {total:true});

  html += accHeaderRow('الخصوم');
  html += accRow('أمانات حقائب لدى العملاء (التزام تسليم)', bs.bagCustody, {indent:true});
  if(bs.loans>0) html += accRow('قروض (مصنّفة تلقائياً من ملاحظات الحركات)', bs.loans, {indent:true});
  if(bs.accrued>0) html += accRow('مصروفات مستحقة (قيد يدوي)', bs.accrued, {indent:true});
  if(bs.otherLiab>0) html += accRow('التزامات / ذمم دائنة أخرى (قيد يدوي)', bs.otherLiab, {indent:true});
  html += accRow('إجمالي الخصوم', bs.totalLiabilities, {total:true});

  html += accHeaderRow('حقوق الملكية');
  html += accRow('الأرباح المرحلة (متراكمة منذ البداية)', bs.retainedEarnings, {indent:true});
  html += accRow('رأس المال ومساهمات أخرى (رصيد متبقٍّ)', bs.ownerCapital, {indent:true});
  html += accRow('إجمالي حقوق الملكية', bs.totalEquity, {total:true});
  html += accRow('إجمالي الخصوم وحقوق الملكية', bs.totalLiabilities+bs.totalEquity, {total:true});

  $('#acc-balance-table tbody').innerHTML = html;
  const diff = Math.round((bs.totalAssets - (bs.totalLiabilities+bs.totalEquity))*100)/100;
  $('#acc-balance-check').innerHTML = Math.abs(diff)<0.02
    ? `<span class="stamp paid">✓ الميزانية متوازنة: الأصول = الخصوم + حقوق الملكية</span>`
    : `<span class="stamp owe">⚠ فرق توازن قدره ${fmt(diff)} ريال — راجع القيود اليدوية</span>`;
}

function renderTrialBalanceTable(asOf, bs, incomeStmt){
  const rows = [
    ['الخزنة (كاش)','أصول', bs.cash, 0],
    ['البنك','أصول', bs.bank, 0],
    ['الشبكة','أصول', bs.network, 0],
    ['ذمم العملاء (مدينون)','أصول', bs.receivables, 0],
    ['مخزون الحقائب','أصول', bs.bagInventory, 0],
    ['الأصول الثابتة (بالتكلفة)','أصول', bs.fixedAssetsGross, 0],
    ['مجمّع الإهلاك (مقابل أصول)','أصول مقابلة', 0, bs.accumDep],
    ['أمانات حقائب لدى العملاء','خصوم', 0, bs.bagCustody],
    ['قروض','خصوم', 0, bs.loans],
    ['مصروفات مستحقة','خصوم', 0, bs.accrued],
    ['التزامات أخرى','خصوم', 0, bs.otherLiab],
    ['الأرباح المرحلة','حقوق ملكية', 0, Math.max(0,bs.retainedEarnings)],
    ['رأس المال ومساهمات أخرى','حقوق ملكية', bs.ownerCapital<0?-bs.ownerCapital:0, bs.ownerCapital>0?bs.ownerCapital:0],
    ['صافي إيرادات الفترة','إيرادات', 0, incomeStmt.netRevenue],
    ['إجمالي مصروفات الفترة','مصروفات', incomeStmt.totalExpense, 0],
  ];
  if(bs.retainedEarnings<0) { rows.find(r=>r[0]==='الأرباح المرحلة')[2] = -bs.retainedEarnings; rows.find(r=>r[0]==='الأرباح المرحلة')[3]=0; }
  let totalDr=0, totalCr=0;
  const bodyHtml = rows.filter(r=>r[2]!==0 || r[3]!==0).map(([name,cat,dr,cr])=>{
    totalDr += dr; totalCr += cr;
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(cat)}</td><td class="mono">${dr?fmt(dr):''}</td><td class="mono">${cr?fmt(cr):''}</td></tr>`;
  }).join('') + `<tr style="font-weight:800; border-top:2px solid var(--border);"><td>الإجمالي</td><td></td><td class="mono">${fmt(totalDr)}</td><td class="mono">${fmt(totalCr)}</td></tr>`;
  $('#acc-trial-body').innerHTML = bodyHtml;
}

function renderQuarterlyTable(year){
  const quarters = ['q1','q2','q3','q4'];
  const ranges = quarters.map(q=>({year, period:q, ...(function(){
    const map = { q1:[`${year}-01-01`,`${year}-03-31`], q2:[`${year}-04-01`,`${year}-06-30`], q3:[`${year}-07-01`,`${year}-09-30`], q4:[`${year}-10-01`,`${year}-12-31`] };
    return {from:map[q][0], to:map[q][1]};
  })()}));
  const data = ranges.map(r=>{
    const revB = revenueBreakdown(r.from, r.to);
    const rev = Object.values(revB).reduce((a,b)=>a+b,0) - salesReturnsTotal(r.from,r.to);
    const expB = expenseBreakdown(r.from, r.to);
    const exp = Object.values(expB).reduce((a,b)=>a+b,0);
    const ni = netIncomeOf(r.from, r.to);
    return { label: accPeriodLabel(r.period), rev, exp, ni };
  });
  const totalRev = data.reduce((s,d)=>s+d.rev,0), totalExp = data.reduce((s,d)=>s+d.exp,0), totalNi = data.reduce((s,d)=>s+d.ni,0);
  let html = `<thead><tr><th>البند</th>${data.map(d=>`<th>${d.label}</th>`).join('')}<th>الإجمالي السنوي</th></tr></thead><tbody>`;
  html += `<tr><td>الإيرادات</td>${data.map(d=>`<td class="mono">${fmt(d.rev)}</td>`).join('')}<td class="mono" style="font-weight:800;">${fmt(totalRev)}</td></tr>`;
  html += `<tr><td>المصروفات</td>${data.map(d=>`<td class="mono">${fmt(d.exp)}</td>`).join('')}<td class="mono" style="font-weight:800;">${fmt(totalExp)}</td></tr>`;
  html += `<tr style="font-weight:800;"><td>صافي الربح/الخسارة</td>${data.map(d=>`<td class="mono ${d.ni<0?'red':''}">${fmt(d.ni)}</td>`).join('')}<td class="mono ${totalNi<0?'red':''}">${fmt(totalNi)}</td></tr>`;
  html += `</tbody>`;
  $('#acc-quarterly-table').innerHTML = html;
  drawLineChart('#chart-acc-quarterly', data.map(d=>d.label), [
    {name:'الإيرادات', color:'var(--teal)', values:data.map(d=>Math.round(d.rev*100)/100)},
    {name:'المصروفات', color:'var(--red)', values:data.map(d=>Math.round(d.exp*100)/100)},
    {name:'الصافي', color:'var(--gold-dark)', values:data.map(d=>Math.round(d.ni*100)/100)},
  ]);
}

function renderJournalTable(){
  const typeLabels = {fixedasset:'إضافة أصل ثابت', depreciation:'قيد إهلاك', accrued:'مصروف مستحق', otherliability:'التزام / ذمم دائنة', readj:'تسوية أرباح مرحلة'};
  const sorted = journalEntries.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  $('#acc-journal-body').innerHTML = sorted.map(j=>`
    <tr>
      <td class="mono">${escapeHtml(j.date||'—')}</td>
      <td><span class="stamp ${j.type==='readj'||j.type==='depreciation'||j.type==='accrued' ? 'owe':'paid'}">${typeLabels[j.type]||j.type}</span></td>
      <td>${escapeHtml(j.description||'—')}${j.linkedDEId ? ' <span class="hint" style="color:var(--teal,#0f8a6b);">🔗 مُرحّل للقيد المزدوج</span>' : ''}</td>
      <td class="mono">${fmt(num(j.amount))}</td>
      <td><button class="btn btn-danger btn-sm" data-jdel="${j.id}">${tr('delete')}</button></td>
    </tr>`).join('');
  $('#acc-journal-empty').style.display = sorted.length ? 'none' : '';
}

function renderAccounting(){
  if(!$('#view-accounting')) return;
  populateAccYearSelect();
  const { year, period, from, to, asOf } = accSelectedRange();
  $('#acc-period-label').textContent = `الفترة المعروضة: من ${formatDateDisplay(from)} إلى ${formatDateDisplay(to)}`;
  const bs = buildBalanceSheet(asOf);
  const incomeStmt = renderIncomeStatementTable(from, to);
  renderAccSummaryCards(bs, incomeStmt.netIncome, incomeStmt.netRevenue, incomeStmt.totalExpense);
  renderBalanceSheetTable(asOf, bs);
  renderVatReturnTable(from, to);
  renderCashFlowTable(from, to);
  renderARAPModule();
  renderTrialBalanceTable(asOf, bs, incomeStmt);
  renderQuarterlyTable(year);
  renderJournalTable();
  renderDoubleEntryModule();
}
['#acc-year','#acc-period'].forEach(sel=>{ if($(sel)) $(sel).addEventListener('change', renderAccounting); });

$('#jf-date') && ($('#jf-date').value = todayISO());
$('#btn-add-journal')?.addEventListener('click', async ()=>{
  const type = $('#jf-type').value;
  const date = $('#jf-date').value || todayISO();
  let amount = num($('#jf-amount').value);
  const description = $('#jf-desc').value.trim();
  if(type!=='readj' && amount<=0){ showToast('أدخل مبلغاً صحيحاً أكبر من صفر'); return; }
  if(type==='readj' && amount===0){ showToast('أدخل قيمة التسوية (يمكن أن تكون سالبة)'); return; }
  if(!description){ showToast('أدخل بياناً موجزاً لهذا القيد'); return; }
  const entry = { id: uid(), createdAt: Date.now(), type, date, amount, description };
  journalEntries.push(entry);
  const posted = autoPostLegacyEntry(entry);
  await saveJournalEntries();
  if(posted) await saveJournalDE();
  await logAudit('add','المحاسبة', `تمت إضافة قيد يدوي (${$('#jf-type').selectedOptions[0].textContent}): ${description} بمبلغ ${fmt(amount)} ﷼${posted ? ' — ورُحّل تلقائياً لدليل الحسابات' : ''}`);
  $('#jf-amount').value=''; $('#jf-desc').value='';
  showToast(posted ? 'تمت إضافة القيد وترحيله تلقائياً للقيد المزدوج' : 'تمت إضافة القيد');
  renderAccounting();
});
$('#acc-journal-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-jdel]');
  if(!btn) return;
  const j = journalEntries.find(x=>x.id===btn.dataset.jdel);
  if(!j) return;
  if(!await customConfirm('هل تريد حذف هذا القيد اليدوي؟ سيُحذف معه القيد المزدوج المرتبط به تلقائياً إن وُجد.')) return;
  if(j.linkedDEId){ journalDE = journalDE.filter(x=>x.id!==j.linkedDEId); await saveJournalDE(); }
  journalEntries = journalEntries.filter(x=>x.id!==j.id);
  await saveJournalEntries();
  await logAudit('delete','المحاسبة', `تم حذف قيد يدوي: ${j.description||''} بمبلغ ${fmt(num(j.amount))} ﷼`);
  renderAccounting();
  showToast('تم حذف القيد');
});

/* ============ دليل الحسابات والقيود اليومية بنظام القيد المزدوج ============ */
const ACCOUNT_TYPES = [
  {value:'asset', label:'أصول'},
  {value:'liability', label:'خصوم'},
  {value:'equity', label:'حقوق ملكية'},
  {value:'revenue', label:'إيرادات'},
  {value:'expense', label:'مصروفات'},
];
function accountTypeLabel(t){ return (ACCOUNT_TYPES.find(x=>x.value===t)||{}).label || t; }
function accountNormalBalance(t){ return (t==='asset'||t==='expense') ? 'debit' : 'credit'; }
function seedChartOfAccountsIfEmpty(){
  if(chartOfAccounts && chartOfAccounts.length) return;
  chartOfAccounts = [
    {id:uid(), code:'1000', name:'النقدية والبنوك', type:'asset'},
    {id:uid(), code:'1100', name:'حسابات مدينة (ذمم العملاء)', type:'asset'},
    {id:uid(), code:'1200', name:'مخزون الحقائب التدريبية', type:'asset'},
    {id:uid(), code:'1500', name:'الأصول الثابتة', type:'asset'},
    {id:uid(), code:'1590', name:'مجمع الإهلاك', type:'asset'},
    {id:uid(), code:'1900', name:'حساب تسويات معلّق (بانتظار التصنيف)', type:'asset'},
    {id:uid(), code:'2000', name:'حسابات دائنة (ذمم الموردين)', type:'liability'},
    {id:uid(), code:'2100', name:'ضريبة القيمة المضافة المستحقة', type:'liability'},
    {id:uid(), code:'2200', name:'مصروفات مستحقة', type:'liability'},
    {id:uid(), code:'2300', name:'قروض', type:'liability'},
    {id:uid(), code:'3000', name:'رأس المال', type:'equity'},
    {id:uid(), code:'3100', name:'الأرباح المرحّلة', type:'equity'},
    {id:uid(), code:'4000', name:'إيرادات الدورات التدريبية', type:'revenue'},
    {id:uid(), code:'4100', name:'إيرادات أخرى', type:'revenue'},
    {id:uid(), code:'5000', name:'مصروفات تشغيلية', type:'expense'},
    {id:uid(), code:'5100', name:'مصروف الإهلاك', type:'expense'},
    {id:uid(), code:'5200', name:'تكلفة الحقائب التدريبية', type:'expense'},
  ];
}
function sortedChartOfAccounts(){ return chartOfAccounts.slice().sort((a,b)=> String(a.code||'').localeCompare(String(b.code||''), 'en')); }
function accountOptionsHtml(selectedId){
  return sortedChartOfAccounts().map(a=> `<option value="${a.id}" ${a.id===selectedId?'selected':''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('');
}
function renderChartOfAccountsTable(){
  const tbody = $('#coa-list-body');
  if(!tbody) return;
  const usedIds = new Set();
  journalDE.forEach(e=> (e.lines||[]).forEach(l=> usedIds.add(l.accountId)));
  tbody.innerHTML = sortedChartOfAccounts().map(a=> `<tr>
    <td class="mono">${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td><td>${accountTypeLabel(a.type)}</td>
    <td><button class="btn btn-ghost btn-sm" data-coa-del="${a.id}" ${usedIds.has(a.id)?'disabled title="لا يمكن حذف حساب مستخدم في قيود يومية"':''}>حذف</button></td>
  </tr>`).join('') || `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد حسابات — أضف أول حساب أعلاه</td></tr>`;
}
function refreshAccountSelectOptions(){
  const glSel = $('#gl-account');
  if(glSel){ const cur = glSel.value; glSel.innerHTML = accountOptionsHtml(); if(cur && chartOfAccounts.some(a=>a.id===cur)) glSel.value = cur; }
  document.querySelectorAll('#de-lines .de-line-account').forEach(sel=>{
    const cur = sel.value; sel.innerHTML = accountOptionsHtml(); if(cur && chartOfAccounts.some(a=>a.id===cur)) sel.value = cur;
  });
}
$('#btn-add-account')?.addEventListener('click', async ()=>{
  const code = $('#coa-code').value.trim();
  const name = $('#coa-name').value.trim();
  const type = $('#coa-type').value;
  if(!code){ showToast('أدخل رمز الحساب'); return; }
  if(!name){ showToast('أدخل اسم الحساب'); return; }
  if(chartOfAccounts.some(a=>a.code===code)){ showToast('يوجد حساب آخر بنفس الرمز'); return; }
  chartOfAccounts.push({ id: uid(), code, name, type });
  await saveChartOfAccounts();
  await logAudit('add','المحاسبة', `تمت إضافة حساب لدليل الحسابات: ${code} — ${name} (${accountTypeLabel(type)})`);
  $('#coa-code').value=''; $('#coa-name').value='';
  showToast('تمت إضافة الحساب');
  renderChartOfAccountsTable();
  refreshAccountSelectOptions();
});
$('#coa-list-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-coa-del]');
  if(!btn || btn.disabled) return;
  const a = chartOfAccounts.find(x=>x.id===btn.dataset.coaDel);
  if(!a) return;
  if(!await customConfirm(`هل تريد حذف الحساب "${a.code} — ${a.name}"؟`)) return;
  chartOfAccounts = chartOfAccounts.filter(x=>x.id!==a.id);
  await saveChartOfAccounts();
  await logAudit('delete','المحاسبة', `تم حذف حساب من دليل الحسابات: ${a.code} — ${a.name}`);
  renderChartOfAccountsTable();
  refreshAccountSelectOptions();
  showToast('تم حذف الحساب');
});

function deLineRowHtml(){
  return `<tr data-de-line>
    <td><select class="de-line-account">${accountOptionsHtml()}</select></td>
    <td><input type="number" step="0.01" class="de-line-debit" placeholder="0"></td>
    <td><input type="number" step="0.01" class="de-line-credit" placeholder="0"></td>
    <td><button type="button" class="btn btn-ghost btn-sm" data-de-removeline>×</button></td>
  </tr>`;
}
function resetDELinesForm(){
  const tbody = $('#de-lines');
  if(!tbody) return;
  tbody.innerHTML = deLineRowHtml() + deLineRowHtml();
  computeDETotals();
}
function computeDETotals(){
  const totalsEl = $('#de-totals');
  let debit=0, credit=0;
  document.querySelectorAll('#de-lines .de-line-debit').forEach(i=> debit += num(i.value));
  document.querySelectorAll('#de-lines .de-line-credit').forEach(i=> credit += num(i.value));
  const diff = debit - credit;
  const balanced = Math.abs(diff) < 0.01 && debit > 0;
  if(totalsEl){
    totalsEl.innerHTML = `<span>إجمالي مدين: <b class="mono">${fmt(debit)}</b> · إجمالي دائن: <b class="mono">${fmt(credit)}</b> · ${balanced ? '<b style="color:var(--teal,#0f8a6b);">✅ القيد متوازن</b>' : `<b style="color:var(--red);">⚠️ غير متوازن (الفرق ${fmt(Math.abs(diff))})</b>`}</span>`;
  }
  return { debit, credit, balanced };
}
$('#de-lines')?.addEventListener('input', e=>{
  if(e.target.classList.contains('de-line-debit') && num(e.target.value)>0){
    const row = e.target.closest('tr'); const c = row?.querySelector('.de-line-credit'); if(c) c.value='';
  }
  if(e.target.classList.contains('de-line-credit') && num(e.target.value)>0){
    const row = e.target.closest('tr'); const d = row?.querySelector('.de-line-debit'); if(d) d.value='';
  }
  computeDETotals();
});
$('#de-lines')?.addEventListener('click', e=>{
  const btn = e.target.closest('[data-de-removeline]');
  if(!btn) return;
  const tbody = $('#de-lines');
  if(tbody.querySelectorAll('tr').length <= 2){ showToast('يجب أن يحتوي القيد على سطرين على الأقل'); return; }
  btn.closest('tr').remove();
  computeDETotals();
});
$('#btn-de-addline')?.addEventListener('click', ()=>{
  $('#de-lines')?.insertAdjacentHTML('beforeend', deLineRowHtml());
});
$('#de-date') && ($('#de-date').value = todayISO());
$('#btn-de-save')?.addEventListener('click', async ()=>{
  if(!chartOfAccounts.length){ showToast('أضف حسابات لدليل الحسابات أولاً'); return; }
  const date = $('#de-date').value || todayISO();
  const description = $('#de-desc').value.trim();
  if(!description){ showToast('أدخل بياناً موجزاً للقيد'); return; }
  const lines = [];
  document.querySelectorAll('#de-lines tr[data-de-line]').forEach(row=>{
    const accountId = row.querySelector('.de-line-account')?.value;
    const debit = num(row.querySelector('.de-line-debit')?.value);
    const credit = num(row.querySelector('.de-line-credit')?.value);
    if(accountId && (debit>0 || credit>0)) lines.push({ accountId, debit, credit });
  });
  if(lines.length < 2){ showToast('أدخل سطرين على الأقل بحساب ومبلغ (مدين أو دائن)'); return; }
  const totalDebit = lines.reduce((s,l)=>s+l.debit,0);
  const totalCredit = lines.reduce((s,l)=>s+l.credit,0);
  if(Math.abs(totalDebit-totalCredit) >= 0.01){ showToast('القيد غير متوازن — يجب أن يتساوى إجمالي المدين مع إجمالي الدائن'); return; }
  journalDE.push({ id: uid(), createdAt: Date.now(), date, description, lines });
  await saveJournalDE();
  await logAudit('add','المحاسبة', `تمت إضافة قيد يومية: ${description} بمبلغ ${fmt(totalDebit)} ﷼ (${lines.length} سطور)`);
  $('#de-desc').value = '';
  resetDELinesForm();
  showToast('تم حفظ القيد اليومية');
  renderDoubleEntryModule();
});
function renderJournalDEList(){
  const tbody = $('#de-entries-body');
  if(!tbody) return;
  const sorted = journalDE.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  tbody.innerHTML = sorted.map(e=>{
    const totalDebit = (e.lines||[]).reduce((s,l)=>s+num(l.debit),0);
    const totalCredit = (e.lines||[]).reduce((s,l)=>s+num(l.credit),0);
    const linesDetail = (e.lines||[]).map(l=>{
      const acc = chartOfAccounts.find(a=>a.id===l.accountId);
      const accLabel = acc ? `${escapeHtml(acc.code)} — ${escapeHtml(acc.name)}` : '—';
      return `${accLabel}: ${l.debit>0?('مدين '+fmt(l.debit)):('دائن '+fmt(l.credit))}`;
    }).join(' · ');
    return `<tr>
      <td class="mono">${escapeHtml(formatDateDisplay(e.date)||e.date||'—')}</td>
      <td>${e.isAuto ? '<span class="hint" style="color:var(--teal,#0f8a6b);">🔗 تلقائي · </span>' : ''}${escapeHtml(e.description||'—')}<div class="hint" style="margin:2px 0 0;">${linesDetail}</div></td>
      <td class="mono">${fmt(totalDebit)}</td>
      <td class="mono">${fmt(totalCredit)}</td>
      <td><button class="btn btn-ghost btn-sm" data-de-del="${e.id}">حذف</button></td>
    </tr>`;
  }).join('');
  $('#de-entries-empty') && ($('#de-entries-empty').style.display = sorted.length ? 'none' : '');
}
$('#de-entries-body')?.addEventListener('click', async e=>{
  const btn = e.target.closest('[data-de-del]');
  if(!btn) return;
  const entry = journalDE.find(x=>x.id===btn.dataset.deDel);
  if(!entry) return;
  if(!await customConfirm('هل تريد حذف هذا القيد اليومية؟')) return;
  journalDE = journalDE.filter(x=>x.id!==entry.id);
  await saveJournalDE();
  if(entry.sourceJournalEntryId){
    const src = journalEntries.find(x=>x.id===entry.sourceJournalEntryId);
    if(src){ delete src.linkedDEId; await saveJournalEntries(); }
  }
  await logAudit('delete','المحاسبة', `تم حذف قيد يومية: ${entry.description||''}`);
  renderDoubleEntryModule();
  showToast('تم حذف القيد');
});
function renderGeneralLedgerDE(){
  const tbody = $('#gl-table-body');
  if(!tbody) return;
  const accountId = $('#gl-account')?.value;
  const from = $('#gl-from')?.value || '';
  const to = $('#gl-to')?.value || '';
  const acc = chartOfAccounts.find(a=>a.id===accountId);
  if(!acc){ tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">أضف حساباً لدليل الحسابات لعرض حركته</td></tr>`; return; }
  const normal = accountNormalBalance(acc.type);
  let rows = [];
  journalDE.forEach(entry=> (entry.lines||[]).forEach(l=>{
    if(l.accountId===accountId) rows.push({ date: entry.date, description: entry.description, debit: num(l.debit), credit: num(l.credit) });
  }));
  rows = rows.filter(r=> inRange(r.date, from, to)).sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')));
  let balance = 0;
  const body = rows.map(r=>{
    balance += normal==='debit' ? (r.debit - r.credit) : (r.credit - r.debit);
    return `<tr>
      <td class="mono">${escapeHtml(formatDateDisplay(r.date)||r.date||'—')}</td>
      <td>${escapeHtml(r.description||'—')}</td>
      <td class="mono">${r.debit?fmt(r.debit):''}</td>
      <td class="mono">${r.credit?fmt(r.credit):''}</td>
      <td class="mono" style="font-weight:700;">${fmt(balance)}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = body || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد حركات على هذا الحساب ضمن الفترة المحددة</td></tr>`;
}
['#gl-account','#gl-from','#gl-to'].forEach(sel=> $(sel)?.addEventListener('change', renderGeneralLedgerDE));
function renderTrialBalanceDE2(){
  const tbody = $('#tb2-table-body');
  if(!tbody) return;
  const asOf = $('#tb2-asof')?.value || '';
  const balances = {};
  journalDE.filter(e=> !asOf || (e.date||'') <= asOf).forEach(e=>{
    (e.lines||[]).forEach(l=>{
      if(!balances[l.accountId]) balances[l.accountId] = {debit:0, credit:0};
      balances[l.accountId].debit += num(l.debit);
      balances[l.accountId].credit += num(l.credit);
    });
  });
  const active = sortedChartOfAccounts().filter(a=> balances[a.id] && (balances[a.id].debit || balances[a.id].credit));
  let totalDebit=0, totalCredit=0;
  const rowsHtml = active.map(a=>{
    const b = balances[a.id];
    const normal = accountNormalBalance(a.type);
    const net = normal==='debit' ? (b.debit-b.credit) : (b.credit-b.debit);
    const debitCol = normal==='debit' ? Math.max(0,net) : Math.max(0,-net);
    const creditCol = normal==='credit' ? Math.max(0,net) : Math.max(0,-net);
    totalDebit += debitCol; totalCredit += creditCol;
    return `<tr>
      <td class="mono">${escapeHtml(a.code)}</td><td>${escapeHtml(a.name)}</td><td>${accountTypeLabel(a.type)}</td>
      <td class="mono">${debitCol?fmt(debitCol):''}</td><td class="mono">${creditCol?fmt(creditCol):''}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = (rowsHtml || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد قيود يومية مسجّلة بعد</td></tr>`)
    + (active.length ? `<tr style="font-weight:800; border-top:2px solid var(--navy);"><td colspan="3">الإجمالي</td><td class="mono">${fmt(totalDebit)}</td><td class="mono">${fmt(totalCredit)}</td></tr>` : '');
}
$('#tb2-asof')?.addEventListener('change', renderTrialBalanceDE2);
function accountByCode(code){ return chartOfAccounts.find(a=>a.code===code); }
const LEGACY_JOURNAL_AUTO_MAP = {
  fixedasset:   { debit:'1500', credit:'1900' }, // إضافة أصل ثابت: مدين الأصول الثابتة / دائن تسويات معلّق (مصدر التمويل غير معروف تلقائياً)
  depreciation: { debit:'5100', credit:'1590' }, // قيد إهلاك: مدين مصروف الإهلاك / دائن مجمع الإهلاك
  accrued:      { debit:'5000', credit:'2200' }, // مصروف مستحق: مدين مصروفات تشغيلية / دائن مصروفات مستحقة
  otherliability:{ debit:'1900', credit:'2000' }, // التزام آخر: مدين تسويات معلّق / دائن حسابات دائنة
};
/* يبني سطور القيد المزدوج المقابل لقيد يدوي قديم (تسوية محاسبية)، أو null إن تعذّر (حسابات ناقصة) */
function buildAutoDELinesForLegacy(j){
  if(j.type==='readj'){
    const susp = accountByCode('1900'), retained = accountByCode('3100');
    if(!susp || !retained) return null;
    const amt = Math.abs(num(j.amount));
    if(amt<=0) return null;
    return num(j.amount) >= 0
      ? [{accountId:susp.id, debit:amt, credit:0}, {accountId:retained.id, debit:0, credit:amt}]
      : [{accountId:retained.id, debit:amt, credit:0}, {accountId:susp.id, debit:0, credit:amt}];
  }
  const map = LEGACY_JOURNAL_AUTO_MAP[j.type];
  if(!map) return null;
  const debitAcc = accountByCode(map.debit), creditAcc = accountByCode(map.credit);
  const amt = num(j.amount);
  if(!debitAcc || !creditAcc || amt<=0) return null;
  return [{accountId:debitAcc.id, debit:amt, credit:0}, {accountId:creditAcc.id, debit:0, credit:amt}];
}
/* يرحّل قيداً يدوياً قديماً (تسوية) تلقائياً إلى قيد يومية مزدوج متوازن، ويربطهما ببعض. يُرجع true إن تم الترحيل */
function autoPostLegacyEntry(j){
  if(j.linkedDEId) return false;
  const lines = buildAutoDELinesForLegacy(j);
  if(!lines) return false;
  const deEntry = { id: uid(), createdAt: Date.now(), date: j.date, description: `[ترحيل تلقائي] ${j.description||''}`, lines, sourceJournalEntryId: j.id, isAuto: true };
  journalDE.push(deEntry);
  j.linkedDEId = deEntry.id;
  return true;
}
$('#btn-migrate-legacy')?.addEventListener('click', async ()=>{
  const pending = journalEntries.filter(j=>!j.linkedDEId);
  if(!pending.length){ showToast('كل القيود اليدوية مُرحّلة بالفعل'); return; }
  let count = 0;
  pending.forEach(j=>{ if(autoPostLegacyEntry(j)) count++; });
  if(!count){ showToast('تعذّر الترحيل — تأكد من وجود الحسابات الافتراضية بدليل الحسابات'); return; }
  await saveJournalEntries();
  await saveJournalDE();
  await logAudit('add','المحاسبة', `تم ترحيل ${count} قيد يدوي تلقائياً إلى القيد المزدوج`);
  showToast(`تم ترحيل ${count} قيد تلقائياً`);
  renderAccounting();
});

/* ---- ترحيل تلقائي لفواتير المشتريات ---- */
function buildDELinesForPurchase(p){
  const expenseAcc = accountByCode('5000'), vatAcc = accountByCode('2100'), cashAcc = accountByCode('1000'), payableAcc = accountByCode('2000');
  if(!expenseAcc || !vatAcc || !cashAcc || !payableAcc) return null;
  const lines = [{accountId:expenseAcc.id, debit:num(p.subtotal), credit:0}];
  if(num(p.taxAmount)>0) lines.push({accountId:vatAcc.id, debit:num(p.taxAmount), credit:0});
  const creditAcc = p.status==='paid' ? cashAcc : payableAcc;
  lines.push({accountId:creditAcc.id, debit:0, credit:num(p.total)});
  return lines;
}
function autoPostPurchase(p){
  if(p.linkedDEId) return false;
  const lines = buildDELinesForPurchase(p);
  if(!lines || num(p.total)<=0) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: p.date, description: `[ترحيل تلقائي] فاتورة شراء ${p.invoiceNo||''} — ${p.supplierName||''}`, lines, sourcePurchaseId: p.id, isAuto: true };
  journalDE.push(entry);
  p.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير المبيعات اليدوية ---- */
function buildDELinesForManualSale(m){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = num(m.total);
  const vat = total - (total/1.15);
  const net = total - vat;
  const lines = [{accountId:arAcc.id, debit:total, credit:0}, {accountId:revAcc.id, debit:0, credit:net}];
  if(vat>0.004) lines.push({accountId:vatAcc.id, debit:0, credit:vat});
  return lines;
}
function autoPostManualSale(m){
  if(m.linkedDEId) return false;
  const lines = buildDELinesForManualSale(m);
  if(!lines || num(m.total)<=0) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: m.date, description: `[ترحيل تلقائي] فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m.invoiceNo||0)}${m.name?(' — '+m.name):''}`, lines, sourceManualSalesId: m.id, isAuto: true };
  journalDE.push(entry);
  m.linkedDEId = entry.id;
  return true;
}

/* ---- ترحيل تلقائي لفواتير الدورات التدريبية (فواتير العملاء) ---- */
function buildDELinesForCourseInvoice(c){
  const arAcc = accountByCode('1100'), revAcc = accountByCode('4000'), vatAcc = accountByCode('2100');
  if(!arAcc || !revAcc || !vatAcc) return null;
  const total = num(c.receiptActualValue);
  const vat = courseInvoiceVat(c.receiptActualValue);
  const net = total - vat;
  const lines = [{accountId:arAcc.id, debit:total, credit:0}, {accountId:revAcc.id, debit:0, credit:net}];
  if(vat>0.004) lines.push({accountId:vatAcc.id, debit:0, credit:vat});
  return lines;
}
function autoPostCourseInvoice(c){
  if(c.courseInvoiceDEId) return false;
  if(!(c.receiptIssueDate && num(c.receiptActualValue)>0)) return false;
  const lines = buildDELinesForCourseInvoice(c);
  if(!lines) return false;
  const entry = { id: uid(), createdAt: Date.now(), date: c.receiptIssueDate, description: `[ترحيل تلقائي] فاتورة دورة ${c.invoice||''} — ${c.name||''}`, lines, sourceClientId: c.id, isAuto: true };
  journalDE.push(entry);
  c.courseInvoiceDEId = entry.id;
  return true;
}

$('#btn-migrate-sales-purchases')?.addEventListener('click', async ()=>{
  let count = 0;
  purchases.filter(p=>!p.linkedDEId).forEach(p=>{ if(autoPostPurchase(p)) count++; });
  manualSalesInvoices.filter(m=>!m.linkedDEId).forEach(m=>{ if(autoPostManualSale(m)) count++; });
  courseInvoiceClients().filter(c=>!c.courseInvoiceDEId).forEach(c=>{ if(autoPostCourseInvoice(c)) count++; });
  if(!count){ showToast('لا توجد فواتير مبيعات أو مشتريات جديدة تحتاج ترحيلاً'); return; }
  await Promise.all([saveJournalDE(), savePurchases(), saveManualSalesInvoices(), saveClients()]);
  await logAudit('add','المحاسبة', `تم ترحيل ${count} فاتورة مبيعات/مشتريات تلقائياً إلى القيد المزدوج`);
  showToast(`تم ترحيل ${count} فاتورة تلقائياً`);
  renderAccounting();
});
function renderDoubleEntryModule(){
  if(!$('#view-accounting')) return;
  renderChartOfAccountsTable();
  if($('#de-lines') && !$('#de-lines').querySelector('tr')) resetDELinesForm();
  computeDETotals();
  renderJournalDEList();
  refreshAccountSelectOptions();
  if($('#gl-account') && !$('#gl-account').value && chartOfAccounts.length) $('#gl-account').value = sortedChartOfAccounts()[0].id;
  renderGeneralLedgerDE();
  if($('#tb2-asof') && !$('#tb2-asof').value) $('#tb2-asof').value = todayISO();
  renderTrialBalanceDE2();
}

function csvDownload(filename, rows){
  const csv = '\uFEFF'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}
function tableToRows(tableSel){
  return Array.from(document.querySelectorAll(tableSel+' tr')).map(tr=> Array.from(tr.querySelectorAll('td,th')).map(td=>td.textContent.trim()));
}
$('#btn-export-income')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  csvDownload(`قائمة_الدخل_${from}_${to}.csv`, tableToRows('#acc-income-table'));
});
$('#btn-export-balance')?.addEventListener('click', ()=>{
  const { asOf } = accSelectedRange();
  csvDownload(`الميزانية_العمومية_حتى_${asOf}.csv`, tableToRows('#acc-balance-table'));
});
$('#btn-export-trial')?.addEventListener('click', ()=>{
  const { asOf } = accSelectedRange();
  const rows = [['الحساب','التصنيف','مدين','دائن'], ...tableToRows('#acc-trial-body')];
  csvDownload(`ميزان_المراجعة_حتى_${asOf}.csv`, rows);
});

/* ---- طباعة PDF لكل تقرير محاسبي على حدا ---- */
function printAccountingReport(title, tableSel, opts){
  opts = opts || {};
  const table = document.querySelector(tableSel);
  if(!table){ showToast('تعذّر إيجاد التقرير للطباعة'); return; }
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const { from, to, asOf, period } = accSelectedRange();
  const periodLine = opts.asOfOnly
    ? `كأرصدة تراكمية حتى: <b>${escapeHtml(formatDateDisplay(asOf))}</b>`
    : `عن الفترة: <b>${escapeHtml(formatDateDisplay(from))}</b> إلى <b>${escapeHtml(formatDateDisplay(to))}</b>`;
  const today = new Date().toLocaleDateString('ar-SA');
  // ننسخ محتوى الجدول كنص/أرقام فقط (بدون أزرار أو عناصر تفاعلية) حتى تخرج الطباعة نظيفة
  const clone = table.cloneNode(true);
  clone.querySelectorAll('button').forEach(b=>b.remove());
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(escapeHtml(title), {variant: 'table'})}
  <body>
    <div class="head">
      <div><h2>${escapeHtml(title)}</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">${periodLine}<br>تاريخ الطباعة: ${escapeHtml(today)}</div>
    ${clone.outerHTML}
    ${opts.extraHtml || ''}
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}
$('#btn-print-income')?.addEventListener('click', ()=> printAccountingReport('قائمة الدخل (الأرباح والخسائر)', '#acc-income-table'));
$('#btn-print-balance')?.addEventListener('click', ()=> printAccountingReport('الميزانية العمومية (قائمة المركز المالي)', '#acc-balance-table', {asOfOnly:true}));
$('#btn-print-quarterly')?.addEventListener('click', ()=> printAccountingReport('مقارنة ربع سنوية للسنة المالية', '#acc-quarterly-table'));
$('#btn-print-trial')?.addEventListener('click', ()=> printAccountingReport('ميزان المراجعة', '#acc-trial-table', {asOfOnly:true}));
/* جداول تفاصيل الفواتير (مبيعات ثم مردودات ثم مشتريات) لطباعة الإقرار الضريبي: رقم الفاتورة، تاريخ الفاتورة، الضريبة، القيمة بدون الضريبة فقط */
function buildVatDetailTablesHtml(r){
  const salesBody = r.salesRows.map(c=>{
    const net = c.totalInclVat - c.vat;
    return `<tr><td class="mono">${escapeHtml(c.invoice||'—')}</td><td class="mono">${escapeHtml(formatDateDisplay(c.date)||'')}</td><td class="mono">${fmt(c.vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(c.totalInclVat)}</td></tr>`;
  }).join('');
  const returnsBody = (r.returnRows||[]).map(t=>{
    const net = t.amount - t.vat;
    return `<tr><td class="mono">—</td><td class="mono">${escapeHtml(formatDateDisplay(t.date)||'')}</td><td class="mono">${fmt(t.vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(t.amount)}</td></tr>`;
  }).join('');
  const purchaseBody = r.purchaseRows.map(p=>{
    const net = num(p.subtotal);
    const vat = num(p.taxAmount);
    const total = num(p.total || (net+vat));
    return `<tr><td class="mono">${escapeHtml(p.invoiceNo||'—')}</td><td class="mono">${escapeHtml(formatDateDisplay(p.date)||'')}</td><td class="mono">${fmt(vat)}</td><td class="mono">${fmt(net)}</td><td class="mono">${fmt(total)}</td></tr>`;
  }).join('');
  const head = `<tr><th>رقم الفاتورة</th><th>تاريخ الفاتورة</th><th>الضريبة</th><th>القيمة بدون الضريبة</th><th>الإجمالي</th></tr>`;
  return `
    <h3 style="margin:22px 0 6px;">تفاصيل فواتير المبيعات (${r.salesRows.length})</h3>
    <table><thead>${head}</thead><tbody>${salesBody || `<tr><td colspan="5" style="text-align:center;">لا توجد فواتير</td></tr>`}</tbody></table>
    ${(r.returnRows && r.returnRows.length) ? `
    <h3 style="margin:22px 0 6px;">تفاصيل مردودات المبيعات (${r.returnRows.length})</h3>
    <table><thead>${head}</thead><tbody>${returnsBody}</tbody></table>` : ''}
    <h3 style="margin:22px 0 6px;">تفاصيل فواتير المشتريات (${r.purchaseRows.length})</h3>
    <table><thead>${head}</thead><tbody>${purchaseBody || `<tr><td colspan="5" style="text-align:center;">لا توجد فواتير</td></tr>`}</tbody></table>
  `;
}
/* جدول صناديق نموذج الإقرار الرسمي كـ HTML جاهز للطباعة (نفس ترتيب بوابة الهيئة) */
function buildVatBoxesTableHtml(r){
  const head = `<tr><th style="width:40px;">#</th><th>البيان</th><th>القيمة (بدون ضريبة)</th><th>الضريبة</th></tr>`;
  const box = (n, label, value, vat, bold)=> `<tr style="${bold?'font-weight:800;':''}">
    <td class="mono">${n}</td><td>${label}</td>
    <td class="mono">${value===null?'—':fmt(value)}</td>
    <td class="mono">${vat===null?'—':fmt(vat)}</td>
  </tr>`;
  return `
    <h3 style="margin:22px 0 6px;">مطابقة صناديق نموذج الإقرار (بوابة الهيئة)</h3>
    <table><thead>${head}</thead><tbody>
      <tr><td colspan="4" style="font-weight:800;">المبيعات</td></tr>
      ${box('1', 'المبيعات المحلية الخاضعة للنسبة الأساسية (15%)', r.salesNet, r.outputVat)}
      ${box('2', 'المبيعات الخاضعة لآلية الاحتساب العكسي المحلي', 0, 0)}
      ${box('3', 'المبيعات المحلية الخاضعة لنسبة الصفر', 0, null)}
      ${box('4', 'الصادرات', 0, null)}
      ${box('5', 'المبيعات المعفاة', 0, null)}
      ${box('—', 'إجمالي المبيعات وضريبة المخرجات', r.salesNet, r.outputVat, true)}
      <tr><td colspan="4" style="font-weight:800;">المشتريات</td></tr>
      ${box('6', 'المشتريات المحلية الخاضعة للنسبة الأساسية (15%)', r.purchasesNet, r.inputVat)}
      ${box('7', 'الواردات الخاضعة للضريبة المدفوعة عند الجمارك', 0, 0)}
      ${box('8', 'الواردات الخاضعة للضريبة بموجب آلية الاحتساب العكسي', 0, 0)}
      ${box('9', 'المشتريات الخاضعة لنسبة الصفر', 0, null)}
      ${box('10', 'المشتريات المعفاة', 0, null)}
      ${box('—', 'إجمالي المشتريات وضريبة المدخلات', r.purchasesNet, r.inputVat, true)}
      ${box('11', r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', null, Math.abs(r.netVat), true)}
    </tbody></table>
  `;
}
$('#btn-print-vat')?.addEventListener('click', ()=>{
  const { from, to } = accSelectedRange();
  const r = buildVatReturn(from, to);
  printAccountingReport('الإقرار الضريبي (ضريبة القيمة المضافة)', '#acc-vat-table', { extraHtml: buildVatBoxesTableHtml(r) + buildVatDetailTablesHtml(r) });
});
$('#btn-export-accounting-full')?.addEventListener('click', ()=>{
  const { year, from, to, asOf } = accSelectedRange();
  const incomeRows = tableToRows('#acc-income-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const balanceRows = tableToRows('#acc-balance-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const cashflowRows = tableToRows('#acc-cashflow-table').map(r=>({'البند':r[0], 'القيمة':r[1]}));
  const trialRows = [['الحساب','التصنيف','مدين','دائن'], ...tableToRows('#acc-trial-body')].map(r=>({'الحساب':r[0],'التصنيف':r[1],'مدين':r[2],'دائن':r[3]}));
  const quarterlyRows = tableToRows('#acc-quarterly-table').map(r=>({'البند':r[0], 'الربع 1':r[1], 'الربع 2':r[2], 'الربع 3':r[3], 'الربع 4':r[4], 'الإجمالي':r[5]}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(incomeRows), 'قائمة الدخل');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(balanceRows), 'الميزانية العمومية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cashflowRows), 'التدفقات النقدية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trialRows), 'ميزان المراجعة');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(quarterlyRows), 'مقارنة ربع سنوية');
  XLSX.writeFile(wb, `التقرير_المحاسبي_${year}_${from}_${to}.xlsx`);
});

/* ============ الموازنة التقديرية والتخطيط المالي (EPM) ============ */
/* ============ الموازنة التقديرية والتخطيط المالي (EPM) ============
   مُعاد بناؤها لتعتمد مباشرة على بيانات البرنامج الفعلية بدل القيود اليومية اليدوية:
   - بنود الإيراد = أنواع الدورات (من settings.courses + أي نوع فعلي مستخدم في العملاء)
     والفعلي = دخل المركز الحقيقي (centerIncome) لعملاء سُجّلوا في ذلك الشهر لهذا النوع.
   - بنود المصروف = تصنيفات المصروفات (settings.expenseCategories)
     والفعلي = مجموع حركات الخزنة الفعلية (vaultTx) من نوع "صرف" لهذا التصنيف في ذلك الشهر. */
function getBudgetEntry(year, kind, key){
  return budgetEntries.find(b=> b.year===year && b.kind===kind && b.key===key);
}
function ensureBudgetEntry(year, kind, key){
  let e = getBudgetEntry(year, kind, key);
  if(!e){
    e = { id: uid(), year, kind, key, months: Array(12).fill(0), updatedBy:null, updatedAt:null };
    budgetEntries.push(e);
  }
  return e;
}
function budgetYearTotal(entry){
  return (entry && entry.months) ? entry.months.reduce((a,b)=>a+num(b),0) : 0;
}
function budgetLineSources(){
  const courseTypes = new Set((settings.courses||[]).map(c=>c.name));
  clients.forEach(c=>{ if(c.courseType) courseTypes.add(c.courseType); });
  const expenseCats = new Set(settings.expenseCategories||[]);
  vaultTx.forEach(t=>{ if(t.type==='out' && t.category) expenseCats.add(t.category); });
  return {
    revenue: [...courseTypes].sort((a,b)=>a.localeCompare(b,'ar')),
    expense: [...expenseCats].sort((a,b)=>a.localeCompare(b,'ar'))
  };
}
function actualForLineMonth(kind, key, year, monthIndex){
  const monthKey = `${year}-${String(monthIndex+1).padStart(2,'0')}`;
  if(kind==='revenue'){
    return clients.filter(c=> !c.cancelled && (c.courseType||'')===key && (c.date||'').slice(0,7)===monthKey)
      .reduce((s,c)=>s+centerIncome(c),0);
  }
  return vaultTx.filter(t=> t.type==='out' && (t.category||'')===key && (t.date||'').slice(0,7)===monthKey)
    .reduce((s,t)=>s+num(t.amount),0);
}
function actualForLineYear(kind, key, year){
  let total = 0;
  for(let m=0;m<12;m++) total += actualForLineMonth(kind, key, year, m);
  return total;
}
function renderEpmBudget(){
  if(!$('#view-budget')) return;
  const year = parseInt($('#budget-year')?.value || new Date().getFullYear(), 10);
  const sources = budgetLineSources();
  const allLines = [
    ...sources.revenue.map(key=>({kind:'revenue', key, label:'إيراد: '+key})),
    ...sources.expense.map(key=>({kind:'expense', key, label:'مصروف: '+key}))
  ];

  const inputBody = $('#budget-input-body');
  if(inputBody){
    inputBody.innerHTML = allLines.map(line=>{
      const entry = ensureBudgetEntry(year, line.kind, line.key);
      const monthInputs = entry.months.map((v,i)=> `<td><input type="number" class="budget-month-input" data-kind="${line.kind}" data-key="${escapeHtml(line.key)}" data-month="${i}" value="${v||''}" style="width:78px;"></td>`).join('');
      return `<tr><td>${escapeHtml(line.label)}</td>${monthInputs}<td class="mono" data-line-total="${line.kind}::${escapeHtml(line.key)}">${fmt(budgetYearTotal(entry))}</td></tr>`;
    }).join('') || `<tr><td colspan="14" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد أنواع دورات أو تصنيفات مصروفات معرَّفة بعد في الإعدادات</td></tr>`;
  }

  const compareBody = $('#budget-compare-body');
  if(compareBody){
    let totalBudgetRev=0, totalActualRev=0, totalBudgetExp=0, totalActualExp=0;
    let worst = null;
    const rows = allLines.map(line=>{
      const entry = getBudgetEntry(year, line.kind, line.key);
      const budget = budgetYearTotal(entry);
      const actual = actualForLineYear(line.kind, line.key, year);
      const variance = actual - budget;
      const pct = budget!==0 ? (actual/budget*100) : (actual!==0 ? null : 100);
      if(line.kind==='revenue'){ totalBudgetRev+=budget; totalActualRev+=actual; }
      else { totalBudgetExp+=budget; totalActualExp+=actual; }
      if(budget!==0 && (!worst || Math.abs(variance) > Math.abs(worst.variance))) worst = { name:line.label, variance };
      const badColor = line.kind==='expense' ? (variance>0) : (variance<0);
      const style = variance===0 ? '' : (badColor ? 'color:var(--red);' : 'color:var(--teal);');
      return `<tr><td>${escapeHtml(line.label)}</td><td class="mono">${fmt(budget)}</td><td class="mono">${fmt(actual)}</td><td class="mono" style="${style}">${fmt(variance)}</td><td class="mono">${pct===null?'—':fmt(pct)+'%'}</td></tr>`;
    }).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:12px;">لا توجد بيانات</td></tr>`;
    compareBody.innerHTML = rows;

    const cardsEl = $('#budget-summary-cards');
    if(cardsEl){
      const revPct = totalBudgetRev!==0 ? (totalActualRev/totalBudgetRev*100) : 0;
      const expPct = totalBudgetExp!==0 ? (totalActualExp/totalBudgetExp*100) : 0;
      cardsEl.innerHTML = `
        <div class="card"><div class="k">نسبة تحقيق الإيرادات المخططة</div><div class="v teal">${fmt(revPct)}%</div></div>
        <div class="card"><div class="k">نسبة تنفيذ المصروفات المخططة</div><div class="v ${expPct>100?'red':'gold'}">${fmt(expPct)}%</div></div>
        <div class="card"><div class="k">صافي المخطط (${year})</div><div class="v gold">${fmt(totalBudgetRev-totalBudgetExp)}</div></div>
        <div class="card"><div class="k">صافي الفعلي (${year})</div><div class="v teal">${fmt(totalActualRev-totalActualExp)}</div></div>
        ${worst ? `<div class="card"><div class="k">أكبر انحراف عن الموازنة</div><div class="v red" style="font-size:14px;">${escapeHtml(worst.name)} (${fmt(worst.variance)})</div></div>` : ''}
      `;
    }
  }
}
$('#budget-year')?.addEventListener('change', renderEpmBudget);
$('#budget-input-body')?.addEventListener('change', async e=>{
  const input = e.target.closest('.budget-month-input');
  if(!input) return;
  const year = parseInt($('#budget-year').value, 10);
  const kind = input.dataset.kind;
  const key = input.dataset.key;
  const monthIdx = parseInt(input.dataset.month, 10);
  const entry = ensureBudgetEntry(year, kind, key);
  entry.months[monthIdx] = num(input.value);
  entry.updatedBy = (typeof currentUser!=='undefined' && currentUser) ? currentUser : 'غير معروف';
  entry.updatedAt = Date.now();
  await saveBudgetEntries();
  await logAudit('edit','الموازنة', `تم تعديل موازنة ${year} — ${kind==='revenue'?'إيراد':'مصروف'} "${key}" — شهر ${monthIdx+1}: ${fmt(entry.months[monthIdx])}`);
  renderEpmBudget();
});
$('#btn-export-budget')?.addEventListener('click', ()=>{
  const year = parseInt($('#budget-year').value, 10);
  const sources = budgetLineSources();
  const allLines = [
    ...sources.revenue.map(key=>({kind:'revenue', key, label:'إيراد: '+key})),
    ...sources.expense.map(key=>({kind:'expense', key, label:'مصروف: '+key}))
  ];
  const rows = allLines.map(line=>{
    const entry = getBudgetEntry(year, line.kind, line.key);
    const budget = budgetYearTotal(entry);
    const actual = actualForLineYear(line.kind, line.key, year);
    return { 'البند': line.label, 'المخطط (سنوي)': budget, 'الفعلي': actual, 'الفرق': actual-budget };
  });
  downloadXlsx(`الموازنة_${year}.xlsx`, 'الموازنة', rows);
});

/* ============ بحث شامل (Global Search) ============ */
function runGlobalSearch(q){
  q = (q||'').trim().toLowerCase();
  if(q.length < 2) return { clients:[], vault:[], purchases:[] };
  const matchClients = clients.filter(c=>
    String(c.name||'').toLowerCase().includes(q) ||
    String(c.phone||'').toLowerCase().includes(q) ||
    String(c.clientId||'').toLowerCase().includes(q) ||
    String(c.invoice||'').toLowerCase().includes(q) ||
    String(c.courseNumber||'').toLowerCase().includes(q) ||
    String(c.referNum||'').toLowerCase().includes(q)
  ).slice(0,8);
  const matchVault = vaultTx.filter(t=>
    String(t.clientName||'').toLowerCase().includes(q) ||
    String(t.notes||'').toLowerCase().includes(q) ||
    String(t.category||'').toLowerCase().includes(q) ||
    String(num(t.amount)).includes(q)
  ).slice(0,8);
  const matchPurchases = purchases.filter(p=>
    String(p.supplierName||'').toLowerCase().includes(q) ||
    String(p.invoiceNo||'').toLowerCase().includes(q) ||
    String(num(p.total)).includes(q)
  ).slice(0,8);
  return { clients: matchClients, vault: matchVault, purchases: matchPurchases };
}
function renderGlobalSearchResults(q){
  const el = $('#global-search-results');
  if(!el) return;
  const { clients: rc, vault: rv, purchases: rp } = runGlobalSearch(q);
  if(q.trim().length < 2){ el.innerHTML = `<div class="hint">اكتب حرفين على الأقل للبحث</div>`; return; }
  if(!rc.length && !rv.length && !rp.length){ el.innerHTML = `<div class="hint">لا توجد نتائج مطابقة</div>`; return; }
  let html = '';
  if(rc.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">العملاء (${rc.length})</h4>`;
    html += rc.map(c=> `<div class="gsr-item" data-gs-client="${c.id}" style="padding:8px; border-bottom:1px solid var(--border); cursor:pointer;">
      <b>${escapeHtml(c.name||'')}</b> — ${escapeHtml(c.phone||'')} <span style="color:var(--text-muted); font-size:12px;">· ${escapeHtml(c.courseType||'')} · ${escapeHtml(c.invoice||'')}</span>
    </div>`).join('');
  }
  if(rv.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">الحركات المالية (${rv.length})</h4>`;
    html += rv.map(t=> `<div class="gsr-item" style="padding:8px; border-bottom:1px solid var(--border);">
      <b>${fmt(num(t.amount))}</b> — ${escapeHtml(t.clientName||t.category||'')} <span style="color:var(--text-muted); font-size:12px;">· ${escapeHtml(t.date||'')} · ${t.type==='in'?'قبض':'صرف'}</span>
    </div>`).join('');
  }
  if(rp.length){
    html += `<h4 style="margin:10px 0 6px; color:var(--navy);">المشتريات (${rp.length})</h4>`;
    html += rp.map(p=> `<div class="gsr-item" style="padding:8px; border-bottom:1px solid var(--border);">
      <b>${escapeHtml(p.supplierName||'')}</b> — ${escapeHtml(p.invoiceNo||'')} <span style="color:var(--text-muted); font-size:12px;">· ${fmt(num(p.total))} · ${escapeHtml(p.date||'')}</span>
    </div>`).join('');
  }
  el.innerHTML = html;
}
function openGlobalSearch(){
  $('#global-search-overlay').classList.add('show');
  $('#global-search-input').value = '';
  $('#global-search-results').innerHTML = '';
  setTimeout(()=> $('#global-search-input')?.focus(), 50);
}
function closeGlobalSearch(){ $('#global-search-overlay').classList.remove('show'); }
$('#btn-global-search')?.addEventListener('click', openGlobalSearch);
$('#btn-close-global-search')?.addEventListener('click', closeGlobalSearch);
$('#global-search-overlay')?.addEventListener('click', e=>{ if(e.target.id==='global-search-overlay') closeGlobalSearch(); });
document.addEventListener('keydown', e=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); openGlobalSearch(); }
  if(e.key==='Escape' && $('#global-search-overlay')?.classList.contains('show')) closeGlobalSearch();
});
$('#global-search-input')?.addEventListener('input', e=> renderGlobalSearchResults(e.target.value));
$('#global-search-results')?.addEventListener('click', e=>{
  const item = e.target.closest('[data-gs-client]');
  if(!item) return;
  const client = clients.find(c=>c.id===item.dataset.gsClient);
  if(!client) return;
  closeGlobalSearch();
  document.querySelector('nav.tabs button[data-view="clients"]')?.click();
  if($('#search')){ $('#search').value = client.clientId || client.name || ''; $('#search').dispatchEvent(new Event('input')); }
});

/* ---------------- Courses / Sessions ---------------- */
function getEffectiveSessions(){
  const byCourseNumber = groupClientsByCourseNumber();
  const findFromClients = (cn, field) => {
    const arr = byCourseNumber.get(cn);
    if(!arr) return '';
    const found = arr.find(c=>c[field]);
    return found ? found[field] : '';
  };
  const list = courseSessions.map(s=>({
    ...s,
    courseType: s.courseType || findFromClients(s.courseNumber, 'courseType'),
    date: s.date || findFromClients(s.courseNumber, 'expectedCourseDate'),
    isDefined:true
  }));
  const definedNums = new Set(courseSessions.map(s=>s.courseNumber));
  const extraNums = new Set();
  clients.forEach(c=>{ if(c.courseNumber && !c.suspended && !definedNums.has(c.courseNumber)) extraNums.add(c.courseNumber); });
  extraNums.forEach(cn=>{
    list.push({id:'auto-'+cn, courseNumber:cn, courseType:findFromClients(cn,'courseType'), date:findFromClients(cn,'expectedCourseDate'), language:'', capacity:null, notes:'', isDefined:false});
  });
  return list;
}
/* تاريخ الدورة الفعلي (متى سيحضر العميل ليأخذ الدورة) — يختلف عن تاريخ التسجيل (متى دفع وسجّل).
   يُقرأ من شيت الدورات (courseSessions) حسب رقم الدورة المرتبط بالعميل. */
function actualCourseDateOf(c){
  if(!c || !c.courseNumber) return '';
  const sess = courseSessions.find(s=>s.courseNumber===c.courseNumber);
  return sess?.date || '';
}
let csUndefinedOnly = false;
function coursesFilteredSessions(){
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;
  const fn = $('#cs-filter-num').value.trim().toLowerCase();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return getEffectiveSessions().filter(s=>{
    if(csUndefinedOnly && s.courseNumber && s.date && s.courseType) return false;
    if(ffrom && (!s.date || s.date<ffrom)) return false;
    if(fto && (!s.date || s.date>fto)) return false;
    if(fn && !String(s.courseNumber||'').toLowerCase().includes(fn)) return false;
    if(fcid){
      const has = clients.some(c=>c.courseNumber===s.courseNumber && String(c.clientId||'').toLowerCase().includes(fcid));
      if(!has) return false;
    }
    return true;
  }).sort((a,b)=> ffrom ? (a.date||'').localeCompare(b.date||'') : (b.date||'').localeCompare(a.date||''));
}
/* تجميع العملاء حسب رقم الدورة مرة واحدة بدل تصفية كامل مصفوفة العملاء لكل دورة على حدة —
   يقلّل زمن رسم شيت الدورات كثيراً عندما يكبر عدد العملاء والدورات */
function groupClientsByCourseNumber(){
  const map = new Map();
  clients.forEach(c=>{
    if(c.suspended || !c.courseNumber) return;
    let arr = map.get(c.courseNumber);
    if(!arr){ arr = []; map.set(c.courseNumber, arr); }
    arr.push(c);
  });
  return map;
}
/* شاشة عرض بالأعداد لشيت الدورات: بطاقات إحصائية سريعة حسب الفلتر الحالي */
function renderCoursesStats(sessions, fcid){
  const el = $('#courses-stats-cards');
  if(!el) return;
  const today = todayISO();
  let totalEnrolled = 0, totalCancelled = 0, totalAbsent = 0, activeCount = 0;
  let upcoming = 0, past = 0, undated = 0;
  let fullSessions = 0, seatsDefined = 0, seatsTaken = 0;
  const byType = {};
  const byCourseNumber = groupClientsByCourseNumber();
  sessions.forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const activeEnrolled = enrolled.filter(c=>!c.cancelled);
    totalEnrolled += enrolled.length;
    totalCancelled += enrolled.filter(c=>c.cancelled).length;
    totalAbsent += enrolled.filter(c=>c.absent).length;
    activeCount += activeEnrolled.length;
    if(!s.date) undated++;
    else if(s.date >= today) upcoming++;
    else past++;
    if(s.capacity){
      seatsDefined += Number(s.capacity)||0;
      seatsTaken += activeEnrolled.length;
      if(activeEnrolled.length >= s.capacity) fullSessions++;
    }
    const t = s.courseType || 'غير محدد';
    byType[t] = (byType[t]||0) + 1;
  });
  const topType = Object.entries(byType).sort((a,b)=>b[1]-a[1])[0];
  const seatsRemaining = Math.max(0, seatsDefined - seatsTaken);
  el.innerHTML = `
    <div class="card"><div class="k">عدد الدورات</div><div class="v">${sessions.length}</div></div>
    <div class="card"><div class="k">إجمالي المسجّلين</div><div class="v gold">${totalEnrolled}</div></div>
    <div class="card"><div class="k">دورات قادمة</div><div class="v">${upcoming}</div></div>
    <div class="card"><div class="k">دورات منتهية</div><div class="v">${past}</div></div>
    <div class="card"><div class="k">دورات بلا تاريخ محدَّد</div><div class="v red">${undated}</div></div>
    <div class="card"><div class="k">دورات مكتملة العدد</div><div class="v red">${fullSessions}</div></div>
    <div class="card"><div class="k">المقاعد المتبقية (للدورات محددة السعة)</div><div class="v">${seatsDefined ? seatsRemaining : '—'}</div></div>
    <div class="card"><div class="k">ملغى / غياب</div><div class="v red">${totalCancelled} / ${totalAbsent}</div></div>
    <div class="card"><div class="k">الأكثر تكراراً</div><div class="v" style="font-size:15px;">${topType ? `${escapeHtml(topType[0])} (${topType[1]})` : '—'}</div></div>
  `;
}
let coursesPageState = {page:1, sig:''};
function renderCourses(){
  refreshMissingCourseOptions();
  renderMissingCourse();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  let sessions = coursesFilteredSessions();
  renderCoursesStats(sessions, fcid);
  const byCourseNumber = groupClientsByCourseNumber();

  if(!sessions.length){
    $('#courses-sessions-list').innerHTML = `<div class="panel"><div class="empty-state"><div class="big">📚</div>لا توجد دورات مطابقة — أضف دورة جديدة أو عدّل الفلاتر</div></div>`;
    const cPag = $('#courses-pagination'); if(cPag) cPag.style.display = 'none';
    return;
  }
  const coursesPageRows = applyGenericPagination('courses', sessions, coursesPageState, [
    $('#cs-filter-from')?.value, $('#cs-filter-to')?.value, $('#cs-filter-num')?.value, fcid
  ]);
  $('#courses-sessions-list').innerHTML = coursesPageRows.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    return `<div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
        <div>
          <h3 style="margin:0 0 4px;">${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||'غير محدد')}</h3>
          <div style="font-size:12.5px; color:var(--text-muted);">التاريخ: ${escapeHtml(s.date||'—')} · اللغة: ${escapeHtml(s.language||'—')} · المدة: ${days} يوم · العدد: <span class="mono">${capLabel}</span>
            ${full ? ' <span class="stamp owe">مكتملة العدد</span>' : ''}
            ${s.isDefined ? '' : ' <span class="stamp owe">غير معرّفة في شيت الدورات</span>'}
          </div>
        </div>
        <div style="white-space:nowrap;">
          ${s.isDefined ? `<button class="btn btn-ghost btn-sm" data-edit-session="${s.id}">${tr('editCourse')}</button>
          <button class="btn btn-danger btn-sm" data-del-session="${s.id}">${tr('delete')}</button>` : ''}
          <button class="btn btn-gold btn-sm" data-print-attendance="${escapeHtml(s.courseNumber)}">${tr('printAttendance')}</button>
        </div>
      </div>
      <div class="table-scroll table-scroll-course">
      <table>
        <thead><tr><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th><th>الحالة</th><th>حالة الحقيبة</th><th></th></tr></thead>
        <tbody>
          ${enrolled.length ? enrolled.map(c=>`
            <tr${c.cancelled?' style="opacity:.5;"':''}>
              <td>${escapeHtml(c.name)}</td>
              <td class="mono">${escapeHtml(c.clientId||'—')}</td>
              <td>${escapeHtml(c.nationality||'')}</td>
              <td>${c.cancelled ? '<span class="stamp owe">ملغى</span>' : (c.absent ? '<span class="stamp owe">غياب</span>' : '<span class="stamp paid">مسجّل</span>')}</td>
              <td><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
              <td style="white-space:nowrap;">
                ${!c.cancelled && !c.absent ? `<button class="btn btn-danger btn-sm" data-mark-absent="${c.id}">${tr('markAbsent')}</button>` : ''}
                ${c.absent ? `<button class="btn btn-ghost btn-sm" data-clear-absent="${c.id}">${tr('clearAbsent')}</button>` : ''}
              </td>
            </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">لا يوجد عملاء مسجّلين برقم هذه الدورة بعد</td></tr>`}
        </tbody>
      </table>
      </div>
    </div>`;
  }).join('');
}
['#cs-filter-from','#cs-filter-to'].forEach(sel=> $(sel).addEventListener('input', renderCourses));
bindGenericPagination('courses', coursesPageState, renderCourses);
onSearchInput('#cs-filter-num', renderCourses);
onSearchInput('#cs-filter-clientid', renderCourses);
onSearchInput('#cs-filter-clientid', renderMissingCourse);
$('#btn-filter-upcoming').addEventListener('click', ()=>{
  $('#cs-filter-from').value = todayISO();
  $('#cs-filter-to').value = '';
  renderCourses();
});
$('#btn-filter-undefined').addEventListener('click', ()=>{
  csUndefinedOnly = !csUndefinedOnly;
  $('#btn-filter-undefined').classList.toggle('btn-primary', csUndefinedOnly);
  $('#btn-filter-undefined').classList.toggle('btn-ghost', !csUndefinedOnly);
  renderCourses();
});
$('#btn-export-courses').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const headers = ['رقم الدورة','نوع الدورة','تاريخ الدورة','اللغة','مدة الدورة (أيام)','السعة','عدد المسجّلين','مكتملة العدد؟',
    'اسم المتدرب','رقم الهوية','رقم المرجعي','الجوال','الجنسية','نوع العميل','اسم الشركة','تاريخ التسجيل','رقم الفاتورة',
    'سعر الدورة','مصدر الحقيبة','قيمة الحقيبة','الخصم','الإجمالي','المدفوع','المتبقي','طريقة الدفع الأولى','طريقة الدفع الثانية',
    'رقم فاتورة الشبكة','حالة الحقيبة','الحالة','ملاحظات'];
  const rows = [];
  const byCourseNumber = groupClientsByCourseNumber();
  coursesFilteredSessions().forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const full = s.capacity && enrolled.length>=s.capacity ? 'نعم' : 'لا';
    if(enrolled.length){
      enrolled.forEach(c=>{
        rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',enrolled.length,full,
          c.name,c.clientId,c.referNum||'',c.phone||'',c.nationality,c.clientType==='company'?'عميل شركات':'عميل مركز',c.companyName||'',
          formatDateDisplay(c.date),c.invoice||'',num(c.coursePrice),bagSourceLabel(c),num(c.bagPrice),num(c.discount),total(c),paidTotal(c),
          remaining(c),c.channel||'',c.channel2||'',c.networkInvoice||'',c.bagStatus||'',c.cancelled?'ملغى':(c.absent?'غياب':'مسجّل'),c.notes||'']);
      });
    } else {
      rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',0,full,
        '','','','','','','','','','','','','','','','','','','','','لا يوجد مسجّلين بعد']);
    }
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'الدورات.csv';
  a.click();
});

/* تقرير شامل قابل للطباعة يضم كل الدورات المطابقة للفلتر الحالي بكل تفاصيلها المتاحة (بيانات الدورة + كل متدرب فيها) */
$('#btn-print-courses-report').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const sessions = coursesFilteredSessions();
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;

  const byCourseNumber = groupClientsByCourseNumber();
  const sectionsHtml = sessions.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    const sessionTotal = enrolled.reduce((sum,c)=>sum+total(c),0);
    const sessionPaid = enrolled.reduce((sum,c)=>sum+paidTotal(c),0);
    const sessionRemaining = enrolled.reduce((sum,c)=>sum+remaining(c),0);
    const rowsHtml = enrolled.length ? enrolled.map((c,i)=>`
      <tr${c.cancelled?' style="opacity:.55;"':''}>
        <td>${i+1}</td>
        <td>${escapeHtml(c.name)}</td>
        <td class="mono">${escapeHtml(c.clientId||'—')}</td>
        <td>${escapeHtml(c.nationality||'—')}</td>
        <td class="mono">${escapeHtml(c.phone||'—')}</td>
        <td class="mono">${escapeHtml(c.invoice||'—')}</td>
        <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
        <td class="mono">${fmt(num(c.coursePrice))}</td>
        <td>${escapeHtml(bagSourceLabel(c))}</td>
        <td class="mono">${fmt(bagAmount(c))}</td>
        <td class="mono">${fmt(num(c.discount))}</td>
        <td class="mono">${fmt(total(c))}</td>
        <td class="mono">${fmt(paidTotal(c))}</td>
        <td class="mono">${fmt(remaining(c))}</td>
        <td>${escapeHtml(paymentChannelsLabel(c))}</td>
        <td>${c.cancelled ? 'ملغى' : (c.absent ? 'غياب' : 'مسجّل')}</td>
        <td>${escapeHtml(c.notes||'—')}</td>
      </tr>`).join('') : `<tr><td colspan="17" style="text-align:center; color:#66707E;">لا يوجد عملاء مسجّلين برقم هذه الدورة بعد</td></tr>`;
    return `
    <div class="session-block">
      <div class="session-head">
        <h3>${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||'غير محدد')}</h3>
        <div class="session-meta">
          <span>التاريخ: <b>${formatDateDisplay(s.date)||'—'}</b></span>
          <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
          <span>المدة: <b>${days} يوم</b></span>
          <span>عدد المسجّلين: <b>${capLabel}</b></span>
          ${full ? '<span class="stamp-full">مكتملة العدد</span>' : ''}
          ${s.isDefined ? '' : '<span class="stamp-undef">غير معرّفة في شيت الدورات</span>'}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th><th>الجوال</th><th>رقم الفاتورة</th><th>تاريخ التسجيل</th>
          <th>سعر الدورة</th><th>مصدر الحقيبة</th><th>قيمة الحقيبة</th><th>الخصم</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th>
          <th>طريقة الدفع</th><th>الحالة</th><th>ملاحظات</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        ${enrolled.length ? `<tfoot><tr>
          <td colspan="11" style="text-align:left; font-weight:bold;">إجمالي الدورة</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionTotal)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionPaid)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionRemaining)}</td>
          <td colspan="3"></td>
        </tr></tfoot>` : ''}
      </table>
    </div>`;
  }).join('');

  const grandEnrolled = sessions.reduce((sum,s)=>{
    let en = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) en = en.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    return sum + en.length;
  },0);

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('تقرير شامل — شيت الدورات', {variant: 'table-center', extraCss: `
    .session-block{margin-bottom:28px; page-break-inside:avoid;}
    .session-head h3{margin:0 0 4px; color:${PRINT_PALETTE.navy};}
    .session-meta{font-size:12.5px; color:${PRINT_PALETTE.muted}; margin-bottom:10px; display:flex; gap:14px; flex-wrap:wrap; align-items:center;}
    .stamp-full, .stamp-undef{background:#FDECEC; color:#B3261E; border-radius:6px; padding:2px 8px; font-size:11.5px;}
    tfoot td{background:#F5F7FA;}
    @media print{ .session-block{page-break-inside:avoid;} }
  `})}
  <body>
    <div class="head">
      <div><h2>تقرير شامل — شيت الدورات</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>تاريخ التقرير: <b>${today}</b></span>
      ${ffrom ? `<span>من تاريخ: <b>${formatDateDisplay(ffrom)}</b></span>` : ''}
      ${fto ? `<span>إلى تاريخ: <b>${formatDateDisplay(fto)}</b></span>` : ''}
      <span>عدد الدورات: <b>${sessions.length}</b></span>
      <span>إجمالي عدد المسجّلين: <b>${grandEnrolled}</b></span>
    </div>
    ${sectionsHtml || '<div style="text-align:center; color:#66707E; padding:40px;">لا توجد دورات مطابقة للفلتر الحالي</div>'}
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
});


/* ---------------- Who hasn't joined a given course type ---------------- */
function refreshMissingCourseOptions(){
  const sel = $('#cs-missing-course');
  const cur = sel.value;
  populateSelect(sel, settings.courses.map(c=>c.name), false);
  sel.insertAdjacentHTML('afterbegin','<option value="">كل أنواع الدورات</option>');
  sel.value = settings.courses.some(c=>c.name===cur) ? cur : '';
  refreshMissingNatOptions();
}
/* ---- فلتر متعدد الجنسيات لتبويب "من سجّل ولم يُحدَّد له رقم دورة بعد" ---- */
let missingNatSelected = new Set();
function refreshMissingNatOptions(){
  const box = $('#cs-missing-nat-options');
  const nats = settings.nationalities || [];
  box.innerHTML = nats.map(n=>`
    <label style="display:flex; align-items:center; gap:6px; padding:4px 2px; font-size:13px; cursor:pointer;">
      <input type="checkbox" class="cs-missing-nat-cb" value="${escapeHtml(n)}" ${missingNatSelected.has(n)?'checked':''}>
      ${escapeHtml(n)}
    </label>`).join('') || '<div style="font-size:12px; color:var(--text-muted);">لا توجد جنسيات معرّفة</div>';
  updateMissingNatButtonLabel();
}
function updateMissingNatButtonLabel(){
  const btn = $('#cs-missing-nat-btn');
  btn.textContent = missingNatSelected.size ? `الجنسية: (${missingNatSelected.size}) ▾` : 'الجنسية: الكل ▾';
}
$('#cs-missing-nat-btn').addEventListener('click', e=>{
  e.stopPropagation();
  const panel = $('#cs-missing-nat-panel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
});
document.addEventListener('click', e=>{
  const wrap = $('#cs-missing-nat-wrap');
  if(wrap && !wrap.contains(e.target)) $('#cs-missing-nat-panel').style.display = 'none';
});
$('#cs-missing-nat-panel').addEventListener('click', e=> e.stopPropagation());
$('#cs-missing-nat-options').addEventListener('change', e=>{
  if(!e.target.classList.contains('cs-missing-nat-cb')) return;
  if(e.target.checked) missingNatSelected.add(e.target.value);
  else missingNatSelected.delete(e.target.value);
  updateMissingNatButtonLabel();
  renderMissingCourse();
});
$('#cs-missing-nat-clear').addEventListener('click', ()=>{
  missingNatSelected.clear();
  refreshMissingNatOptions();
  renderMissingCourse();
});
$('#cs-missing-nat-all').addEventListener('click', ()=>{
  missingNatSelected = new Set(settings.nationalities || []);
  refreshMissingNatOptions();
  renderMissingCourse();
});
function registrationAgeLabel(dateStr){
  if(!dateStr) return '<span class="stamp">—</span>';
  const AGE_THRESHOLD_DAYS = 14; // أكثر من 14 يوم منذ التسجيل يُعتبر "قديم"
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if(isNaN(days)) return '<span class="stamp">—</span>';
  return days > AGE_THRESHOLD_DAYS
    ? `<span class="stamp owe">قديم (${escapeHtml(formatDateDisplay(dateStr))})</span>`
    : `<span class="stamp paid">حديث (${escapeHtml(formatDateDisplay(dateStr))})</span>`;
}
function effectiveExpectedDate(c){ return c.expectedCourseDate || addDaysISO(c.date, 7); }
function missingCourseFiltered(){
  const sel = $('#cs-missing-course');
  const type = sel ? sel.value : '';
  const ffrom = $('#cs-missing-from').value;
  const fto = $('#cs-missing-to').value;
  const efrom = $('#cs-missing-exp-from').value;
  const eto = $('#cs-missing-exp-to').value;
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return clients
    .filter(c=> !c.cancelled && !c.suspended && !String(c.courseNumber||'').trim())
    .filter(c=> !type || c.courseType===type)
    .filter(c=> !missingNatSelected.size || missingNatSelected.has(c.nationality))
    .filter(c=> !ffrom || (c.date && c.date>=ffrom))
    .filter(c=> !fto || (c.date && c.date<=fto))
    .filter(c=> !efrom || effectiveExpectedDate(c)>=efrom)
    .filter(c=> !eto || effectiveExpectedDate(c)<=eto)
    .filter(c=> !fcid || String(c.clientId||'').toLowerCase().includes(fcid))
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
function renderMissingCourse(){
  const sel = $('#cs-missing-course');
  if(!sel) return;
  const type = sel.value;
  const box = $('#cs-missing-list');
  const countEl = $('#cs-missing-count');
  // العميل يظهر إن لم يُحدَّد له رقم دورة بعد؛ اختيار نوع الدورة (إن وُجد) فلتر إضافي اختياري فقط،
  // أما بقية الفلاتر (الجنسية وتاريخ التسجيل وتاريخ الدورة المتوقع ورقم الهوية) فتعمل على كامل الشيت بكل أنواع الدورات
  const missing = missingCourseFiltered();
  countEl.textContent = type
    ? `${missing.length} عميل سجّل في دورة "${type}" ولم يُحدَّد له رقم دورة بعد`
    : `${missing.length} عميل في كل الشيت لم يُحدَّد له رقم دورة بعد`;
  if(!missing.length){
    box.innerHTML = `<div class="empty-state" style="padding:24px 10px;"><div class="big">✅</div>${type ? `لا يوجد — كل من سجّل في دورة "${escapeHtml(type)}" له رقم دورة محدَّد` : 'لا يوجد — كل العملاء لديهم رقم دورة محدَّد'}</div>`;
    return;
  }
  box.innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>الاسم</th><th>تاريخ التسجيل</th><th>نوع الدورة</th><th>رقم الهوية</th><th>الجوال</th><th>الجنسية</th><th>اسم الشركة</th><th>حالة الحقيبة</th><th>تاريخ دورة متوقع</th></tr></thead>
    <tbody>${missing.map(c=>`<tr>
      <td>${escapeHtml(c.name||'—')}</td>
      <td>${registrationAgeLabel(c.date)}</td>
      <td>${escapeHtml(c.courseType||'—')}</td>
      <td class="mono">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono">${escapeHtml(c.phone||'—')}</td>
      <td>${escapeHtml(c.nationality||'')}</td>
      <td>${escapeHtml(c.companyName||'—')}</td>
      <td><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
      <td><input type="date" class="cs-expected-date" data-client-id="${escapeHtml(c.id)}" value="${escapeHtml(effectiveExpectedDate(c))}" title="تاريخ متوقّع لأخذ العميل الدورة — قيمة افتراضية تلقائية يمكن تعديلها"></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
$('#cs-missing-course').addEventListener('change', renderMissingCourse);
$('#btn-export-missing-course')?.addEventListener('click', ()=>{
  const missing = missingCourseFiltered();
  const headers = ['الاسم','تاريخ التسجيل','نوع الدورة','رقم الهوية','الجوال','الجنسية','اسم الشركة','حالة الحقيبة','تاريخ دورة متوقع'];
  const rows = missing.map(c=>[c.name,formatDateDisplay(c.date),c.courseType,c.clientId,c.phone,c.nationality,c.companyName,bagSourceLabel(c),effectiveExpectedDate(c)]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_لم_يحدد_لهم_رقم_دورة.csv';
  a.click();
});
$('#cs-missing-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-list').addEventListener('change', async e=>{
  if(!e.target.classList.contains('cs-expected-date')) return;
  const id = e.target.dataset.clientId;
  const client = clients.find(c=>c.id===id);
  if(!client) return;
  client.expectedCourseDate = e.target.value;
  await saveClients();
  await logAudit('edit','الدورات', `تم تحديد تاريخ دورة متوقع للعميل ${client.name}: ${client.expectedCourseDate || '—'}`);
});

function openSessionModal(id){
  editingSessionId = id || null;
  $('#session-modal-title').textContent = id ? 'تعديل بيانات الدورة' : 'دورة جديدة';
  populateSelect($('#sf-type'), settings.courses.map(c=>c.name), true);
  const s = id ? courseSessions.find(x=>x.id===id) : null;
  $('#sf-num').value = s?.courseNumber || '';
  $('#sf-type').value = s?.courseType || '';
  $('#sf-date').value = s?.date || '';
  $('#sf-lang').value = s?.language || '';
  $('#sf-cap').value = s?.capacity ?? '';
  $('#sf-notes').value = s?.notes || '';
  $('#session-overlay').classList.add('show'); SoundFX.open();
}
function closeSessionModal(){ $('#session-overlay').classList.remove('show'); editingSessionId=null; }
$('#sf-cancel').addEventListener('click', closeSessionModal);
$('#session-overlay').addEventListener('click', e=>{ if(e.target.id==='session-overlay') closeSessionModal(); });
$('#btn-add-session').addEventListener('click', ()=>openSessionModal(null));

$('#session-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const data = {
    courseNumber: $('#sf-num').value.trim(),
    courseType: $('#sf-type').value,
    date: $('#sf-date').value,
    language: $('#sf-lang').value.trim(),
    capacity: $('#sf-cap').value ? num($('#sf-cap').value) : null,
    notes: $('#sf-notes').value.trim(),
  };
  if(!data.courseNumber){ showToast('رقم الدورة مطلوب'); return; }
  const dup = courseSessions.find(s=>s.courseNumber===data.courseNumber && s.id!==editingSessionId);
  if(dup){ showToast('رقم الدورة هذا مستخدم بالفعل لدورة أخرى'); return; }
  const wasEdit = !!editingSessionId;
  snapshotState(wasEdit ? `تعديل دورة: ${data.courseNumber}` : `إضافة دورة: ${data.courseNumber}`);
  if(editingSessionId){
    const idx = courseSessions.findIndex(s=>s.id===editingSessionId);
    const oldNum = courseSessions[idx].courseNumber;
    courseSessions[idx] = {...courseSessions[idx], ...data};
    if(oldNum!==data.courseNumber){
      clients.forEach(c=>{ if(c.courseNumber===oldNum) c.courseNumber = data.courseNumber; });
      await saveClients();
    }
    showToast('تم تحديث بيانات الدورة');
  }else{
    courseSessions.push({id:uid(), createdAt:Date.now(), ...data});
    showToast('تمت إضافة الدورة');
  }
  await saveCourseSessions();
  await logAudit(wasEdit?'edit':'add','الدورات', `${wasEdit?'تم تعديل':'تمت إضافة'} الدورة رقم ${data.courseNumber}`);
  closeSessionModal(); renderCourses(); renderTable();
});

$('#courses-sessions-list').addEventListener('click', async e=>{
  const editS = e.target.dataset.editSession;
  const delS = e.target.dataset.delSession;
  const printA = e.target.dataset.printAttendance;
  const markAbsent = e.target.dataset.markAbsent;
  const clearAbsent = e.target.dataset.clearAbsent;
  if(editS) openSessionModal(editS);
  if(delS){
    if(await customConfirm('تأكيد حذف هذه الدورة من الشيت؟ لن يتم حذف العملاء المسجلين، فقط بيانات الدورة نفسها.')){
      const removed = courseSessions.find(s=>s.id===delS);
      snapshotState(`حذف دورة: ${removed?.courseNumber||delS}`);
      courseSessions = courseSessions.filter(s=>s.id!==delS);
      await saveCourseSessions();
      await logAudit('delete','الدورات', `تم حذف الدورة رقم ${removed?.courseNumber||delS}`);
      renderCourses();
      showToast('تم حذف الدورة');
    }
  }
  if(printA) printAttendance(printA);
  if(markAbsent){
    const c = clients.find(x=>x.id===markAbsent);
    if(c && await customConfirm(`تحديد "${c.name}" كغائب؟ سيتم مسح رقم الدورة الحالي عنه تلقائياً حتى يوضع له رقم دورة جديد.`)){
      snapshotState(`تحديد غياب: ${c.name}`);
      const oldNum = c.courseNumber;
      c.absent = true;
      c.courseNumber = '';
      await saveClients();
      await logAudit('edit','العملاء', `تم تسجيل غياب العميل ${c.name} عن الدورة ${oldNum||''} ومسح رقم الدورة عنه تلقائياً`);
      renderCourses(); renderTable();
      showToast('تم تسجيل الغياب ومسح رقم الدورة');
    }
  }
  if(clearAbsent){
    const c = clients.find(x=>x.id===clearAbsent);
    if(c){
      snapshotState(`إلغاء غياب: ${c.name}`);
      c.absent = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء علامة الغياب عن العميل ${c.name}`);
      renderCourses(); renderTable();
      showToast('تم إلغاء علامة الغياب');
    }
  }
});

function printAttendance(courseNumber){
  const s = getEffectiveSessions().find(x=>x.courseNumber===courseNumber) || {courseNumber, courseType:'', date:'', language:''};
  const enrolled = clients.filter(c=>c.courseNumber===courseNumber && !c.cancelled && !c.suspended);
  const days = courseDurationDays(s.courseType);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const dayCols = days===2
    ? '<th>حضور اليوم الأول</th><th>انصراف اليوم الأول</th><th>حضور اليوم الثاني</th><th>انصراف اليوم الثاني</th><th>ملاحظات</th>'
    : '<th>توقيع الحضور</th><th>توقيع الانصراف</th><th>ملاحظات</th>';
  const colCount = days===2 ? 9 : 7;
  const rowsHtml = enrolled.map((c,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.clientId||'—')}</td><td>${escapeHtml(c.nationality||'')}</td>${days===2?'<td></td><td></td><td></td><td></td>':'<td></td><td></td>'}<td></td></tr>`).join('');
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('كشف حضور وانصراف — ' + escapeHtml(courseNumber), {variant: 'table-center'})}
  <body>
    <div class="head">
      <div><h2>كشف حضور وانصراف</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>رقم الدورة: <b>${escapeHtml(courseNumber)}</b></span>
      <span>نوع الدورة: <b>${escapeHtml(s.courseType||'—')}</b></span>
      <span>تاريخ الدورة: <b>${escapeHtml(s.date||'—')}</b></span>
      <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
      <span>عدد المسجلين: <b>${enrolled.length}</b></span>
    </div>
    <table>
      <thead><tr><th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th>${dayCols}</tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${colCount}">لا يوجد مسجلين</td></tr>`}</tbody>
    </table>
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}

/* عند استيراد/إدخال رقم دورة (أو رقم فاتورة) مرتبط برقم هوية غير موجود إطلاقاً في شيت العملاء ولا بأي مكان
   آخر بالبرنامج، يُضاف تلقائياً كعميل جديد بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل تجاهله
   أو رفض الصف — ويبقى محفوظاً بشكل دائم في شيت العملاء/الدورات حتى لو لم تُستكمل بقية بياناته لاحقاً
   (الاسم، الجوال...)، ولا يُحذف تلقائياً لعدم اكتمال بياناته. */
function addMinimalClientForCourseImport(clientId, courseNumber, courseDate){
  const rowDate = courseDate || todayISO();
  const c = {
    id: uid(), createdAt: Date.now(),
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: courseNumber || '',
    referNum: '', invoice: '', bagInvoice: '',
    date: rowDate,
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية ورقم الدورة فقط عبر استيراد أرقام الدورات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

function addMinimalClientForRefnumImport(clientId, referNum){
  const c = {
    id: uid(), createdAt: Date.now(),
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: referNum || '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط عبر استيراد الرقم المرجعي — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

/* ---- Bulk import: course numbers & course invoice numbers, linked by رقم الهوية ---- */
$('#btn-template-course-numbers').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_أرقام_الدورات.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم الدورة':'CRS-1001', 'تاريخ الدورة':'2026-02-01'}
  ]);
});
$('#btn-import-course-numbers').addEventListener('click', ()=> $('#import-coursenum-input').click());
$('#import-coursenum-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد أرقام الدورات من Excel');
    let updated=0, added=0, skipped=0, sessionsUpdated=0, sessionsAdded=0;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const courseNumber = String(row['رقم الدورة']||'').trim();
      if(!clientId || !courseNumber){ skipped++; continue; }
      const courseDate = normalizeExcelDate(row['تاريخ الدورة']);
      let c = clients.find(x=>x.clientId===clientId);
      let isNew = false;
      if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; added++; }
      const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
      c.courseNumber = courseNumber;
      c.absent = false;
      updated++;
      let sessionNote = '';
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
      changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':courseNumber, 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
      if(courseNumber!==oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
      }
    }
    await saveClients();
    if(added){ await syncBagStockIssues(); await saveVaultTx(); }
    if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
    await logAudit('edit','الدورات', `استيراد أرقام الدورات من Excel: تحديث ${updated} عميل${added?`(منهم ${added} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}${skipped?`، وتخطي ${skipped} صف بدون رقم هوية/دورة`:''}`);
    renderTable(); renderCourses();
    // تقرير بالبيانات التي تم تحديثها فعلياً
    downloadXlsx(`تقرير_استيراد_أرقام_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
    showToast(`تم تحديث ${updated} عميل${added?`، منهم ${added} عميل جديد أُضيف تلقائياً`:''}${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة "رقم الهوية" و"رقم الدورة" (وتاريخ الدورة اختياري)');
  }finally{
    e.target.value = '';
  }
});


/* ---------------- تحديث/استيراد أرقام الدورات وفواتيرها دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد الملفين (أرقام الدورات / أرقام الفواتير) عبر Excel بجدول واحد داخل البرنامج، بنفس منطق
   الربط برقم الهوية والتحديث الجزئي (أي حقل فارغ في الصف يبقى كما هو في النظام دون تغيير). */
let csBulkRowSeq = 0;
function csBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="csb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="csb-invoice" data-col="1" style="min-width:100px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm csb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCsBulkRow(){
  csBulkRowSeq++;
  $('#cs-bulk-table-body').insertAdjacentHTML('beforeend', csBulkRowHtml(csBulkRowSeq));
}
function openCsBulkModal(){
  $('#cs-bulk-table-body').innerHTML = '';
  $('#cs-bulk-coursenum').value = '';
  $('#cs-bulk-date').value = '';
  for(let i=0;i<5;i++) addCsBulkRow();
  $('#cs-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCsBulkModal(){ $('#cs-bulk-overlay').classList.remove('show'); }
$('#btn-cs-bulk').addEventListener('click', openCsBulkModal);
$('#cs-bulk-cancel').addEventListener('click', closeCsBulkModal);
$('#cs-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='cs-bulk-overlay') closeCsBulkModal(); });
$('#btn-cs-bulk-row').addEventListener('click', addCsBulkRow);
$('#cs-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('csb-remove-row')){
    const rows = $('#cs-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#cs-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#cs-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCsBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-cs-bulk-save').addEventListener('click', async ()=>{
  const courseNumber = $('#cs-bulk-coursenum').value.trim();
  const courseDate = $('#cs-bulk-date').value.trim();
  const rows = [...$('#cs-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('csb-id');
    const invoice = val('csb-invoice');
    if(!clientId && !invoice) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice){ errors.push(`${rowLabel}: أدخل رقم الدورة أعلاه أو رقم الفاتورة لهذا الصف`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    // إن لم يكن رقم الهوية موجوداً بشيت العملاء أو بأي مكان آخر بالبرنامج، يُضاف تلقائياً كعميل جديد
    // بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل رفض الصف، ويبقى محفوظاً حتى لو لم تكتمل بياناته لاحقاً.
    if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; newClientsCount++; }
    items.push({clientId, courseNumber, courseDate, invoice, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, sessionsUpdated=0, sessionsAdded=0;
  const changedRows = [];
  items.forEach(({clientId, courseNumber, courseDate, invoice, c, isNew})=>{
    const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
    const oldInvoice = isNew ? '' : (c.invoice||'');
    let sessionNote = '';
    if(courseNumber){
      c.courseNumber = courseNumber;
      c.absent = false;
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
    }
    if(invoice) c.invoice = invoice;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':c.courseNumber||'', 'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'', 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
    if(c.courseNumber && c.courseNumber!==oldCourseNumber){
      sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
    }
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
  await logAudit('edit','الدورات', `تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}`);
  closeCsBulkModal();
  renderTable(); renderCourses();
  // تقرير بالبيانات التي تم تحديثها فعلياً
  downloadXlsx(`تقرير_تحديث_أرقام_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);
});

/* ---------------- استيراد/تحديث الرقم المرجعي دفعة واحدة (جدول داخل البرنامج) ----------------
   الربط برقم الهوية فقط: تحديث جزئي (الرقم المرجعي فقط) لعميل موجود، أو إضافة عميل جديد بالحد الأدنى
   من البيانات (رقم الهوية + الرقم المرجعي) إن لم يكن موجوداً — بنفس منطق استيراد أرقام الدورات. */
let refnumBulkRowSeq = 0;
function refnumBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="rnb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="rnb-refnum" data-col="1" style="min-width:120px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm rnb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addRefnumBulkRow(){
  refnumBulkRowSeq++;
  $('#refnum-bulk-table-body').insertAdjacentHTML('beforeend', refnumBulkRowHtml(refnumBulkRowSeq));
}
function openRefnumBulkModal(){
  $('#refnum-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addRefnumBulkRow();
  $('#refnum-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeRefnumBulkModal(){ $('#refnum-bulk-overlay').classList.remove('show'); }
$('#btn-refnum-bulk').addEventListener('click', openRefnumBulkModal);
$('#refnum-bulk-cancel').addEventListener('click', closeRefnumBulkModal);
$('#refnum-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='refnum-bulk-overlay') closeRefnumBulkModal(); });
$('#btn-refnum-bulk-row').addEventListener('click', addRefnumBulkRow);
$('#refnum-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('rnb-remove-row')){
    const rows = $('#refnum-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#refnum-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#refnum-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addRefnumBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-refnum-bulk-save').addEventListener('click', async ()=>{
  const rows = [...$('#refnum-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('rnb-id');
    const referNum = val('rnb-refnum');
    if(!clientId && !referNum) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!referNum){ errors.push(`${rowLabel}: الرقم المرجعي مطلوب`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForRefnumImport(clientId, referNum); isNew = true; newClientsCount++; }
    items.push({clientId, referNum, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0;
  const changedRows = [];
  items.forEach(({clientId, referNum, c, isNew})=>{
    const oldReferNum = isNew ? '' : (c.referNum||'');
    c.referNum = referNum;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'الرقم المرجعي (قديم)':oldReferNum, 'الرقم المرجعي (جديد)':c.referNum||'', 'ملاحظة الجدول': isNew ? 'عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات' : ''});
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط)`:''}`);
  closeRefnumBulkModal();
  renderTable();
  downloadXlsx(`تقرير_استيراد_الرقم_المرجعي_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);
});

/* ---------------- استيراد عمال الشركات دفعة واحدة (جدول داخل البرنامج فقط — بدون Excel) ----------------
   الربط برقم الهوية فقط: تحديث اسم الشركة (ونوع العميل تلقائياً إلى "عميل شركات") لعميل موجود، أو إضافة
   عميل جديد بالحد الأدنى من البيانات (رقم الهوية + اسم الشركة) إن لم يكن موجوداً — بنفس منطق استيراد
   الرقم المرجعي، لكن عبر جدول لصق داخل البرنامج فقط دون أي رفع لملف Excel. */
function addMinimalClientForCompanyImport(clientId, companyName){
  const c = {
    id: uid(), createdAt: Date.now(),
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'company',
    companyName: companyName || '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية واسم الشركة فقط عبر استيراد عمال الشركات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}
let compWorkersBulkRowSeq = 0;
function compWorkersBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cwb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:150px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cwb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCompWorkersBulkRow(){
  compWorkersBulkRowSeq++;
  $('#compworkers-bulk-table-body').insertAdjacentHTML('beforeend', compWorkersBulkRowHtml(compWorkersBulkRowSeq));
}
function openCompWorkersBulkModal(){
  $('#compworkers-bulk-company').value = '';
  $('#compworkers-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCompWorkersBulkRow();
  $('#compworkers-bulk-overlay').classList.add('show'); SoundFX.open();
  setTimeout(()=>$('#compworkers-bulk-company').focus(), 50);
}
function closeCompWorkersBulkModal(){ $('#compworkers-bulk-overlay').classList.remove('show'); }
$('#btn-compworkers-bulk').addEventListener('click', openCompWorkersBulkModal);
$('#compworkers-bulk-cancel').addEventListener('click', closeCompWorkersBulkModal);
$('#compworkers-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='compworkers-bulk-overlay') closeCompWorkersBulkModal(); });
$('#btn-compworkers-bulk-row').addEventListener('click', addCompWorkersBulkRow);
$('#compworkers-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cwb-remove-row')){
    const rows = $('#compworkers-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق عمود كامل (رقم هوية واحد في كل سطر) منسوخ من إكسل مباشرة داخل الجدول
$('#compworkers-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(l=>l.split('\t')[0]);
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#compworkers-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((val, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCompWorkersBulkRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('[data-col="0"]');
    if(field) field.value = val.trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-compworkers-bulk-save').addEventListener('click', async ()=>{
  const companyName = $('#compworkers-bulk-company').value.trim();
  if(!companyName){ showToast('اكتب اسم الشركة أعلى الجدول أولاً'); $('#compworkers-bulk-company').focus(); return; }
  const rows = [...$('#compworkers-bulk-table-body').querySelectorAll('tr')];
  const items = [];
  const seenIds = new Set();
  let newClientsCount = 0;
  rows.forEach(row=>{
    const clientId = row.querySelector('.cwb-id').value.trim();
    if(!clientId) return; // صف فارغ يُتجاهل بصمت
    if(seenIds.has(clientId)) return; // تكرار داخل نفس الجدول يُتجاهل بصمت
    seenIds.add(clientId);
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForCompanyImport(clientId, companyName); isNew = true; newClientsCount++; }
    items.push({clientId, c, isNew});
  });
  if(!items.length){ showToast('أدخل رقم هوية واحداً على الأقل'); return; }
  snapshotState(`استيراد عمال الشركات من جدول داخل البرنامج (${items.length} صف) — الشركة: ${companyName}`);
  let updated=0;
  items.forEach(({c, isNew})=>{
    c.companyName = companyName;
    if(!isNew) c.clientType = 'company';
    updated++;
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد عمال الشركات من جدول داخل البرنامج للشركة "${companyName}": تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية واسم الشركة فقط)`:''}`);
  closeCompWorkersBulkModal();
  renderTable(); refreshFilterOptions();
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''} — الشركة: ${companyName}`);
});

/* ---------------- تحديث/استيراد فواتير الدورات دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد ملف Excel بنفس منطق الربط برقم الهوية (وبرقم الدورة إن وُجد) والتحديث الجزئي. */
let ciBulkRowSeq = 0;
function ciBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cib-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="cib-coursenum" data-col="1" style="min-width:100px;"></td>
    <td><input type="text" class="cib-invoice" data-col="2" style="min-width:100px;"></td>
    <td><input type="date" class="cib-date" data-col="3" style="min-width:120px;"></td>
    <td><input type="number" step="0.01" class="cib-value" data-col="4" style="min-width:110px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cib-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCiBulkRow(){
  ciBulkRowSeq++;
  $('#ci-bulk-table-body').insertAdjacentHTML('beforeend', ciBulkRowHtml(ciBulkRowSeq));
}
function openCiBulkModal(){
  $('#ci-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCiBulkRow();
  $('#ci-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCiBulkModal(){ $('#ci-bulk-overlay').classList.remove('show'); }
$('#btn-ci-bulk').addEventListener('click', openCiBulkModal);
$('#ci-bulk-cancel').addEventListener('click', closeCiBulkModal);
$('#ci-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='ci-bulk-overlay') closeCiBulkModal(); });
$('#btn-ci-bulk-row').addEventListener('click', addCiBulkRow);
$('#ci-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cib-remove-row')){
    const rows = $('#ci-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#ci-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#ci-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCiBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>4) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.classList.contains('cib-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-ci-bulk-save').addEventListener('click', async ()=>{
  const rows = [...$('#ci-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('cib-id');
    const courseNumber = val('cib-coursenum');
    const invoice = val('cib-invoice');
    const date = val('cib-date');
    const valueRaw = val('cib-value');
    if(!clientId && !courseNumber && !invoice && !date && !valueRaw) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice && !date && valueRaw===''){ errors.push(`${rowLabel}: أدخل رقم الدورة أو رقم الفاتورة أو التاريخ أو القيمة الفعلية`); return; }
    // البحث أولاً بمطابقة رقم الهوية + رقم الدورة معاً (لتحديد التسجيل الصحيح عند تعدد دورات نفس العميل)،
    // وإن لم يوجد رقم دورة في الصف أو لم تُطابق، نكتفي بمطابقة رقم الهوية وحده
    let c = null;
    if(courseNumber) c = clients.find(x=>x.clientId===clientId && String(x.courseNumber||'').trim()===courseNumber);
    if(!c) c = clients.find(x=>x.clientId===clientId);
    if(!c){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بشيت العملاء`); return; }
    items.push({clientId, invoice, date, valueRaw, c});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد فواتير الدورات من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, invoiceChanged=0;
  const changedRows = [];
  items.forEach(({clientId, invoice, date, valueRaw, c})=>{
    const oldInvoice = c.invoice||'';
    const oldDate = c.receiptIssueDate||'';
    const oldValue = c.receiptActualValue||'';
    // رقم الفاتورة (رقم الإيصال) فقط هو ما يُرحَّل ويُربط مع باقي شيتات النظام — أما التاريخ والقيمة الفعلية
    // فيبقى تحديثهما محصوراً داخل شيت فواتير الدورات نفسه فقط
    if(invoice){
      c.invoice = invoice;
      if(invoice!==oldInvoice) invoiceChanged++;
    }
    if(date) c.receiptIssueDate = date;
    if(valueRaw!==''){ c.receiptActualValue = num(valueRaw); }
    updated++;
    changedRows.push({
      'رقم الهوية':clientId, 'الاسم':c.name, 'رقم الدورة':c.courseNumber||'',
      'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'',
      'تاريخ الفاتورة (قديم)':oldDate, 'تاريخ الفاتورة (جديد)':c.receiptIssueDate||'',
      'القيمة الفعلية (قديمة)':oldValue, 'القيمة الفعلية (جديدة)':c.receiptActualValue||''
    });
  });
  await saveClients();
  await logAudit('edit','فواتير الدورات', `تحديث/استيراد فواتير الدورات من جدول داخل البرنامج: تحديث ${updated} سجل${invoiceChanged?` (تم ترحيل ${invoiceChanged} رقم فاتورة تلقائياً إلى شيت العملاء وربطها بجميع الشيتات)`:''}`);
  closeCiBulkModal();
  if(invoiceChanged && typeof refreshEverything==='function'){
    // رقم الفاتورة تغيّر فعلياً لسجل واحد أو أكثر → يُحدَّث النظام بالكامل (شيت العملاء، لوحة التحكم، الدورات، التقارير...)
    refreshEverything();
  }else{
    // لا يوجد تغيير في أرقام الفواتير (تحديث تاريخ/قيمة فعلية فقط) → يبقى التحديث محصوراً في شيت فواتير الدورات فقط
    renderCourseInvoices();
  }
  // تقرير بالبيانات التي تم تحديثها فعلياً
  downloadXlsx(`تقرير_تحديث_فواتير_الدورات_${stampNow()}.xlsx`, 'تقرير التحديث', changedRows);
  showToast(`تم تحديث ${updated} سجل${invoiceChanged?` — ورُبط ${invoiceChanged} رقم فاتورة بجميع الشيتات`:''}`);
});

/* ---------------- Excel Import / Export (linked by رقم الهوية) ---------------- */
function bagSourceToLabel(s){ return s==='own' ? 'خاصته' : s==='stock' ? 'من المخزون' : 'شراء'; }
function bagLabelToSource(l){
  const v = String(l||'').trim();
  if(v==='خاصته') return 'own';
  return 'stock';
}
/* عرض التاريخ بصيغة يوم/شهر/سنة للمستخدم، مع بقاء التخزين الداخلي بصيغة ISO (سنة-شهر-يوم) للفرز والفلترة */
function formatDateDisplay(iso){
  if(!iso) return '';
  const s = String(iso).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}
function normalizeExcelDate(v){
  if(v===undefined || v===null || v==='') return '';
  if(v instanceof Date && !isNaN(v)){
    // نستخدم مكوّنات التاريخ المحلي (وليس toISOString الذي يحوّل إلى UTC)
    // لتجنّب رجوع التاريخ يوماً إلى الخلف (مثال: 18 يتحول خطأً إلى 17)
    const y = v.getFullYear();
    const m = String(v.getMonth()+1).padStart(2,'0');
    const d = String(v.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // تاريخ نصي بصيغة يوم/شهر/سنة (الصيغة الشائعة عند إدخال أو حفظ التاريخ كنص في إكسل بدل خلية تاريخ حقيقية)
  // مثال: عمود "التاريخ" محفوظ كنص "04/06/2026" ولم يُكتشف كخلية تاريخ، فكان يمر بدون تحويل ويظهر لاحقاً بترتيب مقلوب
  const dm = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(dm){
    let day = Number(dm[1]), month = Number(dm[2]);
    const year = dm[3];
    // نفترض دائماً يوم/شهر/سنة (المعتاد محلياً)، ولا نبدّل الترتيب إلا إذا كان الرقم الأول لا يصلح كيوم (أكبر من 31)
    // أو لا يصلح كشهر ثانٍ (أكبر من 12) بينما الثاني يصلح كيوم — عندها تكون الصيغة الأصلية شهر/يوم
    if(!(day>=1 && day<=31) || (month>12 && day<=12)){
      const tmp = day; day = month; month = tmp;
    }
    if(day>=1 && day<=31 && month>=1 && month<=12){
      return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  // Excel serial date number as string
  if(/^\d+(\.\d+)?$/.test(s)){
    const d = XLSX.SSF.parse_date_code(Number(s));
    if(d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  return s;
}
function clientToExportRow(c){
  return {
    'رقم الهوية': c.clientId||'',
    'الاسم': c.name||'',
    'رقم المرجع': c.referNum||'',
    'الجوال': c.phone||'',
    'الجنسية': c.nationality||'',
    'نوع العميل': c.clientType==='company' ? 'عميل شركات' : 'عميل مركز',
    'اسم الشركة': c.companyName||'',
    'الأجل (أيام)': c.clientType==='company' ? (num(c.creditDays)||'') : '',
    'نوع الدورة': c.courseType||'',
    'رقم الدورة': c.courseNumber||'',
    'رقم الفاتورة': c.invoice||'',
    'التاريخ': c.date||'',
    'سعر الدورة': num(c.coursePrice),
    'مصدر الحقيبة': bagSourceToLabel(c.bagSource),
    'قيمة الحقيبة': num(c.bagPrice),
    'رقم فاتورة الحقيبة': c.bagInvoice||'',
    'الخصم': num(c.discount),
    'المدفوع': num(c.paid),
    'طريقة الدفع': c.channel||'',
    'المبلغ (الطريقة الثانية)': num(c.paid2),
    'طريقة الدفع الثانية': c.channel2||'',
    'رقم فاتورة الشبكة': c.networkInvoice||'',
    'الحالة': c.stage||'',
    'ملغى': c.cancelled ? 'نعم' : 'لا',
    'ملاحظات': c.notes||''
  };
}

function transferAllocatedTotal(t){
  return (t.trainees||[]).reduce((s,tr)=>s+num(tr.courseValue)+num(tr.bagValue),0);
}
function updateComputedShare(){
  const amount = num($('#ct-amount')?.value);
  const count = num($('#ct-count')?.value);
  if($('#ct-share')) $('#ct-share').textContent = fmt(count>0 ? amount/count : 0);
}
$('#ct-amount')?.addEventListener('input', updateComputedShare);
$('#ct-count')?.addEventListener('input', updateComputedShare);

/* ---- تقسيم مبلغ الحوالة حسب فئات مختلفة (مثال: مقيمين/سعوديين بأسعار مختلفة) ---- */
let ctGroups = []; // {id, label, count, price} — حالة نموذج "إضافة حوالة جديدة" الحالي فقط (تُصفَّر بعد الحفظ)

function ctGroupIsOtherLabel(label){
  return !!label && label!=='مقيم' && label!=='سعودي';
}
function renderCtGroups(){
  const wrap = $('#ct-groups-list');
  if(!wrap) return;
  wrap.innerHTML = ctGroups.map(g=>{
    const isOther = ctGroupIsOtherLabel(g.label);
    return `
    <div class="formgrid" style="margin-bottom:6px;" data-ctgroup="${g.id}">
      <div class="field">
        <label>اسم الفئة</label>
        <select class="ctg-label-select">
          <option value="مقيم" ${g.label==='مقيم'?'selected':''}>مقيم</option>
          <option value="سعودي" ${g.label==='سعودي'?'selected':''}>سعودي</option>
          <option value="__other__" ${isOther?'selected':''}>أخرى (تحديد)</option>
        </select>
      </div>
      <div class="field ctg-label-other-wrap" style="${isOther?'':'display:none;'}">
        <label>حدد اسم الفئة</label>
        <input type="text" class="ctg-label-other" placeholder="مثال: فلبيني" value="${isOther?escapeHtml(g.label):''}">
      </div>
      <div class="field"><label>العدد</label><input type="number" min="1" step="1" class="ctg-count" value="${g.count||''}"></div>
      <div class="field"><label>سعر الفرد</label><input type="number" min="0" step="0.01" class="ctg-price" value="${g.price||''}"></div>
      <div class="field" style="display:flex; align-items:flex-end; gap:6px;">
        <span class="hint mono" style="white-space:nowrap;">= ${fmt(num(g.count)*num(g.price))} ﷼</span>
        <button type="button" class="btn btn-ghost btn-sm ctg-remove" data-ctgroupremove="${g.id}">حذف الفئة</button>
      </div>
    </div>`;
  }).join('');
  recomputeCtGroups();
}

function recomputeCtGroups(){
  // نقرأ القيم الحالية من الحقول (قد تكون تغيّرت بدون إعادة render كاملة أثناء الكتابة)
  $all('[data-ctgroup]').forEach(row=>{
    const id = row.dataset.ctgroup;
    const g = ctGroups.find(x=>x.id===id);
    if(!g) return;
    const sel = row.querySelector('.ctg-label-select');
    const otherInput = row.querySelector('.ctg-label-other');
    g.label = sel.value==='__other__' ? (otherInput ? otherInput.value.trim() : '') : sel.value;
    g.count = num(row.querySelector('.ctg-count').value);
    g.price = num(row.querySelector('.ctg-price').value);
    const sumSpan = row.querySelector('.hint.mono');
    if(sumSpan) sumSpan.textContent = `= ${fmt(g.count*g.price)} ﷼`;
  });
  const totalAmount = ctGroups.reduce((s,g)=>s+num(g.count)*num(g.price),0);
  const totalCount = ctGroups.reduce((s,g)=>s+num(g.count),0);
  if($('#ct-groups-total')) $('#ct-groups-total').textContent = fmt(totalAmount);
  if($('#ct-groups-count')) $('#ct-groups-count').textContent = totalCount;
  if(ctGroups.length){
    $('#ct-amount').value = totalAmount ? Math.round(totalAmount*100)/100 : '';
    $('#ct-count').value = totalCount || '';
    $('#ct-amount').readOnly = true;
    $('#ct-count').readOnly = true;
    $('#ct-amount').style.background = 'var(--bg-soft,#f0f0f0)';
    $('#ct-count').style.background = 'var(--bg-soft,#f0f0f0)';
  } else {
    $('#ct-amount').readOnly = false;
    $('#ct-count').readOnly = false;
    $('#ct-amount').style.background = '';
    $('#ct-count').style.background = '';
  }
  updateComputedShare();
}

$('#btn-add-ctgroup')?.addEventListener('click', ()=>{
  ctGroups.push({id:uid(), label:'مقيم', count:'', price:''});
  renderCtGroups();
});
document.addEventListener('click', e=>{
  if(e.target.dataset && e.target.dataset.ctgroupremove){
    ctGroups = ctGroups.filter(g=>g.id!==e.target.dataset.ctgroupremove);
    renderCtGroups();
  }
});
document.addEventListener('change', e=>{
  if(e.target.classList && e.target.classList.contains('ctg-label-select')){
    const row = e.target.closest('[data-ctgroup]');
    const id = row && row.dataset.ctgroup;
    const g = ctGroups.find(x=>x.id===id);
    if(g){
      g.label = e.target.value==='__other__' ? '' : e.target.value;
      renderCtGroups();
    }
  }
});
document.addEventListener('input', e=>{
  if(e.target.classList && (e.target.classList.contains('ctg-label-other')||e.target.classList.contains('ctg-count')||e.target.classList.contains('ctg-price'))){
    recomputeCtGroups();
  }
});
function resetCtGroups(){ ctGroups = []; renderCtGroups(); }
function ctGroupsSummaryText(groups){
  return (groups||[]).map(g=>`${g.label||'فئة'}: ${g.count}×${fmt(g.price)}=${fmt(num(g.count)*num(g.price))}`).join(' · ');
}

/* ---- مبالغ متفق عليها مختلفة حسب الفئة عند إضافة شركة جديدة (مثال: مقيم/سعودي بسعر مختلف) ---- */
let cmCats = []; // {id, label, amount} — حالة نموذج "إضافة شركة" الحالي فقط (تُصفَّر بعد الحفظ)

function renderCmCats(){
  const wrap = $('#cm-cats-list');
  if(!wrap) return;
  wrap.innerHTML = cmCats.map(c=>{
    const isOther = ctGroupIsOtherLabel(c.label);
    return `
    <div class="formgrid" style="margin-bottom:6px;" data-cmcat="${c.id}">
      <div class="field">
        <label>الفئة</label>
        <select class="cmc-label-select">
          <option value="مقيم" ${c.label==='مقيم'?'selected':''}>مقيم</option>
          <option value="سعودي" ${c.label==='سعودي'?'selected':''}>سعودي</option>
          <option value="__other__" ${isOther?'selected':''}>أخرى (تحديد)</option>
        </select>
      </div>
      <div class="field cmc-label-other-wrap" style="${isOther?'':'display:none;'}">
        <label>حدد اسم الفئة</label>
        <input type="text" class="cmc-label-other" placeholder="مثال: فلبيني" value="${isOther?escapeHtml(c.label):''}">
      </div>
      <div class="field"><label>المبلغ المتفق عليه لهذه الفئة</label><input type="number" min="0" step="0.01" class="cmc-amount" value="${c.amount||''}"></div>
      <div class="field" style="display:flex; align-items:flex-end;"><button type="button" class="btn btn-ghost btn-sm" data-cmcatremove="${c.id}">حذف الفئة</button></div>
    </div>`;
  }).join('');
}
function recomputeCmCats(){
  $all('[data-cmcat]').forEach(row=>{
    const id = row.dataset.cmcat;
    const c = cmCats.find(x=>x.id===id);
    if(!c) return;
    const sel = row.querySelector('.cmc-label-select');
    const otherInput = row.querySelector('.cmc-label-other');
    c.label = sel.value==='__other__' ? (otherInput ? otherInput.value.trim() : '') : sel.value;
    c.amount = num(row.querySelector('.cmc-amount').value);
  });
}
$('#btn-add-cmcat')?.addEventListener('click', ()=>{
  cmCats.push({id:uid(), label:'مقيم', amount:''});
  renderCmCats();
});
document.addEventListener('click', e=>{
  if(e.target.dataset && e.target.dataset.cmcatremove){
    cmCats = cmCats.filter(c=>c.id!==e.target.dataset.cmcatremove);
    renderCmCats();
  }
});
document.addEventListener('change', e=>{
  if(e.target.classList && e.target.classList.contains('cmc-label-select')){
    const row = e.target.closest('[data-cmcat]');
    const id = row && row.dataset.cmcat;
    const c = cmCats.find(x=>x.id===id);
    if(c){
      c.label = e.target.value==='__other__' ? '' : e.target.value;
      renderCmCats();
    }
  }
});
document.addEventListener('input', e=>{
  if(e.target.classList && (e.target.classList.contains('cmc-label-other')||e.target.classList.contains('cmc-amount'))){
    recomputeCmCats();
  }
});
function resetCmCats(){ cmCats = []; renderCmCats(); }
function companyCategoriesSummaryText(categories){
  return (categories||[]).map(c=>`${c.label||'فئة'}: ${fmt(num(c.amount))} ﷼`).join(' · ');
}

$('#btn-use-company-cats')?.addEventListener('click', ()=>{
  const companyId = $('#ct-company').value;
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('اختر شركة أولاً'); return; }
  if(!company.categories || !company.categories.length){ showToast('لا توجد فئات محفوظة لهذه الشركة — أضفها أولاً من قسم "الشركات المتفق معها"'); return; }
  ctGroups = company.categories.map(c=>({id:uid(), label:c.label, count:'', price:c.amount}));
  renderCtGroups();
  showToast('تم تعبئة الفئات وأسعارها — أكمل العدد لكل فئة');
});

/* ملخص ثابت (غير متأثر بالفلاتر): لكل شركة، إجمالي عدد المتدربين في كل حوالاتها، وكم أخذ الدورة وكم لم يأخذها بعد */
function companiesTakenSummaryHtml(){
  const todayStr = todayISO();
  const map = {};
  companyTransfers.forEach(t=>{
    if(!map[t.companyName]) map[t.companyName] = {total:0, taken:0, notTaken:0};
    (t.trainees||[]).forEach(tr=>{
      const cc = clients.find(x=>x.clientId===tr.clientId);
      const d = cc ? actualCourseDateOf(cc) : '';
      const taken = !!(d && d<=todayStr);
      map[t.companyName].total++;
      if(taken) map[t.companyName].taken++; else map[t.companyName].notTaken++;
    });
  });
  const names = Object.keys(map).sort((a,b)=>a.localeCompare(b,'ar'));
  if(!names.length) return `<div class="hint">لا توجد بيانات متدربين مضافة بعد.</div>`;
  const grand = names.reduce((s,n)=>({total:s.total+map[n].total, taken:s.taken+map[n].taken, notTaken:s.notTaken+map[n].notTaken}), {total:0,taken:0,notTaken:0});
  return `
    <div class="table-scroll table-scroll-compact">
      <table>
        <thead><tr><th>اسم الشركة</th><th>إجمالي المتدربين (كل الحوالات)</th><th>أخذ الدورة</th><th>لم يأخذ الدورة بعد</th></tr></thead>
        <tbody>
          ${names.map(n=>`<tr>
            <td>${escapeHtml(n)}</td>
            <td class="mono">${map[n].total}</td>
            <td class="mono" style="color:var(--teal);">${map[n].taken}</td>
            <td class="mono" style="color:var(--red);">${map[n].notTaken}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="font-weight:bold;">
            <td>الإجمالي الكلي</td>
            <td class="mono">${grand.total}</td>
            <td class="mono" style="color:var(--teal);">${grand.taken}</td>
            <td class="mono" style="color:var(--red);">${grand.notTaken}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}
function companiesFilteredTransfers(){
  const fname = $('#ctf-company')?.value || '';
  const dfrom = $('#ctf-date-from')?.value || '';
  const dto = $('#ctf-date-to')?.value || '';
  const fchannel = $('#ctf-channel')?.value || '';
  const fcid = ($('#ctf-clientid')?.value || '').trim();
  const fcidLower = fcid.toLowerCase();
  const traineeMatches = tr=>{
    if(String(tr.clientId||'').includes(fcid)) return true;
    const c = clients.find(x=>x.clientId===tr.clientId);
    return !!(c && String(c.name||'').toLowerCase().includes(fcidLower));
  };
  return companyTransfers.filter(t=>{
    if(fchannel && (t.channel||'')!==fchannel) return false;
    // فلتر البحث برقم الهوية أو اسم المتدرب يبحث في كل الحوالات وكل الشركات بغض النظر عن فلتر الشركة/التاريخ
    if(fcid) return (t.trainees||[]).some(traineeMatches);
    if(fname && t.companyName!==fname) return false;
    if(dfrom && (!t.date || t.date<dfrom)) return false;
    if(dto && (!t.date || t.date>dto)) return false;
    return true;
  });
}
/* قائمة موحّدة تُسطّح كل الأشخاص/المتدربين التابعين لجميع الشركات (عبر كل حوالاتها) في صف واحد لكل شخص،
   مع فلاتر مستقلة (الشركة، تاريخ الحوالة، طريقة الدفع) وصندوق بحث موحد يبحث في رقم الهوية أو الاسم أو
   اسم الشركة معاً — بغض النظر عن فلاتر سجل الحوالات أعلاه. */
function companiesFilteredPersons(){
  const fname = $('#cpp-company')?.value || '';
  const dfrom = $('#cpp-date-from')?.value || '';
  const dto = $('#cpp-date-to')?.value || '';
  const fchannel = $('#cpp-channel')?.value || '';
  const q = ($('#cpp-search')?.value || '').trim().toLowerCase();
  const rows = [];
  companyTransfers.forEach(t=>{
    if(fname && t.companyName!==fname) return;
    if(dfrom && (!t.date || t.date<dfrom)) return;
    if(dto && (!t.date || t.date>dto)) return;
    if(fchannel && (t.channel||'')!==fchannel) return;
    (t.trainees||[]).forEach(tr=>{
      const c = clients.find(x=>x.clientId===tr.clientId);
      if(q){
        const hay = [tr.clientId, c?c.name:'', t.companyName].join(' ').toLowerCase();
        if(!hay.includes(q)) return;
      }
      rows.push({t, tr, c});
    });
  });
  return rows.sort((a,b)=>(b.t.createdAt||0)-(a.t.createdAt||0) || String(a.tr.clientId||'').localeCompare(String(b.tr.clientId||'')));
}
let cpersonsPageState = {page:1, sig:''};
function renderCompanyPersons(){
  if($('#cpp-company')){
    const cppVal = $('#cpp-company').value;
    populateSelect($('#cpp-company'), companies.map(c=>c.name), false);
    $('#cpp-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
    $('#cpp-company').value = companies.some(c=>c.name===cppVal) ? cppVal : '';
  }
  if($('#cpp-channel')){
    const cppChannelVal = $('#cpp-channel').value;
    populateSelect($('#cpp-channel'), settings.channels.map(c=>c.name), false);
    $('#cpp-channel').insertAdjacentHTML('afterbegin','<option value="">كل طرق الدفع</option>');
    $('#cpp-channel').value = settings.channels.some(c=>c.name===cppChannelVal) ? cppChannelVal : '';
  }
  const rows = companiesFilteredPersons();
  const cnt = $('#cpp-count'); if(cnt) cnt.textContent = rows.length;
  const pageRows = applyGenericPagination('cpersons', rows, cpersonsPageState, [
    $('#cpp-company')?.value, $('#cpp-date-from')?.value, $('#cpp-date-to')?.value, $('#cpp-channel')?.value, $('#cpp-search')?.value
  ]);
  $('#company-persons-list').innerHTML = rows.length ? `
    <div class="table-scroll table-scroll-compact">
    <table>
      <thead><tr><th>رقم الهوية</th><th>الاسم</th><th>الجوال</th><th>الجنسية</th><th>اسم الشركة</th><th>تاريخ الحوالة</th><th>طريقة الدفع</th><th>نوع الدورة</th><th>رقم الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th><th>حالة الترحيل</th></tr></thead>
      <tbody>
        ${pageRows.map(({t,tr,c})=>`<tr>
          <td class="mono">${escapeHtml(tr.clientId)}</td>
          <td>${escapeHtml(c?c.name:'—')}${!c?' <span class="hint" style="display:inline;">(غير موجود بشيت العملاء بعد)</span>':''}</td>
          <td class="mono">${escapeHtml(c?(c.phone||'—'):'—')}</td>
          <td>${escapeHtml(c?(c.nationality||'—'):'—')}</td>
          <td>${escapeHtml(t.companyName||'—')}</td>
          <td class="mono">${escapeHtml(t.date||'—')}</td>
          <td>${escapeHtml(t.channel||'—')}</td>
          <td>${escapeHtml(c?(c.courseType||'—'):'—')}</td>
          <td class="mono">${escapeHtml(c?(c.courseNumber||'—'):'—')}</td>
          <td class="mono">${fmt(num(tr.courseValue))}</td>
          <td class="mono">${fmt(num(tr.bagValue))}</td>
          <td class="mono">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
          <td>${tr.posted ? '<span class="stamp paid">تم الترحيل</span>' : `<span class="stamp owe" title="${escapeHtml(tr.skipReason||'')}">${escapeHtml(tr.skipReason||'لم يُرحَّل')}</span>`}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>` : `<div class="empty-state" style="padding:20px;">لا يوجد أشخاص مطابقون لهذا الفلتر/البحث</div>`;
}
/* عند تفعيل فلتر البحث برقم الهوية أو الاسم، تُقصَر قائمة المتدربين المعروضة داخل كل حوالة على المتدربين المطابقين فقط */
function transferMatchingTrainees(t){
  const fcid = ($('#ctf-clientid')?.value || '').trim();
  const fcidLower = fcid.toLowerCase();
  const all = t.trainees || [];
  if(!fcid) return all;
  return all.filter(tr=>{
    if(String(tr.clientId||'').includes(fcid)) return true;
    const c = clients.find(x=>x.clientId===tr.clientId);
    return !!(c && String(c.name||'').toLowerCase().includes(fcidLower));
  });
}
/* بطاقات إحصائية + تنبيه الحوالات غير مكتملة التسوية (الفرق بين قيمة الحوالة وما خُصِّص فعلياً للمتدربين) */
function companiesStats(){
  const totalCompanies = companies.length;
  const totalTransfers = companyTransfers.length;
  const totalAmount = companyTransfers.reduce((s,t)=>s+num(t.amount),0);
  let unsettledCount = 0, unpostedTrainees = 0, totalTrainees = 0;
  companyTransfers.forEach(t=>{
    const allocated = transferAllocatedTotal(t);
    if(Math.abs(num(t.amount)-allocated) > 0.01) unsettledCount++;
    (t.trainees||[]).forEach(tr=>{ totalTrainees++; if(!tr.posted) unpostedTrainees++; });
  });
  return {totalCompanies, totalTransfers, totalAmount, unsettledCount, unpostedTrainees, totalTrainees};
}
function renderCompaniesStatsCards(){
  const wrap = $('#companies-stats-cards');
  if(!wrap) return;
  const s = companiesStats();
  wrap.innerHTML = `
    <div class="card"><div class="k">عدد الشركات</div><div class="v">${s.totalCompanies}</div></div>
    <div class="card"><div class="k">عدد الحوالات</div><div class="v">${s.totalTransfers}</div></div>
    <div class="card"><div class="k">إجمالي قيمة الحوالات</div><div class="v gold">${fmt(s.totalAmount)}</div></div>
    <div class="card"><div class="k">متدربون بانتظار الترحيل للبنك</div><div class="v ${s.unpostedTrainees?'red':''}">${s.unpostedTrainees} / ${s.totalTrainees}</div></div>
    <div class="card"><div class="k">حوالات غير مكتملة التسوية</div><div class="v ${s.unsettledCount?'red':''}">${s.unsettledCount}</div></div>
  `;
}
function companiesUnsettledRows(){
  return companyTransfers.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const diff = num(t.amount) - allocated;
    return {t, allocated, diff};
  }).filter(r=>Math.abs(r.diff) > 0.01)
    .sort((a,b)=>(b.t.createdAt||0)-(a.t.createdAt||0));
}
function renderCompaniesUnsettledPanel(){
  const panel = $('#companies-unsettled-panel');
  const list = $('#companies-unsettled-list');
  if(!panel || !list) return;
  const rows = companiesUnsettledRows();
  if(!rows.length){ panel.style.display = 'none'; list.innerHTML=''; return; }
  panel.style.display = '';
  list.innerHTML = `
    <div class="table-scroll table-scroll-compact">
      <table>
        <thead><tr><th>الشركة</th><th>تاريخ الحوالة</th><th>قيمة الحوالة</th><th>المخصَّص فعلياً</th><th>الفرق</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r=>`<tr>
            <td>${escapeHtml(r.t.companyName)}</td>
            <td class="mono">${r.t.date||'—'}</td>
            <td class="mono">${fmt(num(r.t.amount))}</td>
            <td class="mono">${fmt(r.allocated)}</td>
            <td class="mono" style="${r.diff!==0?'color:var(--red);':''}">${r.diff>0?'ناقص ':'زائد '}${fmt(Math.abs(r.diff))}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-jumptransfer="${r.t.id}">فتح الحوالة</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
document.addEventListener('click', e=>{
  const btn = e.target.closest('[data-jumptransfer]');
  if(!btn) return;
  const id = btn.dataset.jumptransfer;
  $('#ctf-company').value=''; $('#ctf-date-from').value=''; $('#ctf-date-to').value=''; $('#ctf-clientid').value=''; if($('#ctf-channel')) $('#ctf-channel').value='';
  const sorted = companyTransfers.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const idx = sorted.findIndex(x=>x.id===id);
  const pageSize = genericPageSize('ctransfers');
  ctransfersPageState.sig = JSON.stringify(['','','','','']);
  ctransfersPageState.page = (idx>=0 && Number.isFinite(pageSize)) ? Math.floor(idx/pageSize)+1 : 1;
  renderCompanies();
  setTimeout(()=>{
    const el = document.getElementById('ctrow-'+id);
    if(el){
      el.scrollIntoView({behavior:'smooth', block:'start'});
      el.style.transition = 'box-shadow .3s';
      el.style.boxShadow = '0 0 0 3px var(--red)';
      setTimeout(()=>{ el.style.boxShadow=''; }, 2500);
    }
  }, 60);
});
/* كشف حساب PDF لشركة محددة: يجمع كل حوالاتها ومتدربيها مع إجمالي المخصَّص والمتبقي وحالة الترحيل */
function printCompanyStatement(companyId){
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('تعذّر إيجاد الشركة'); return; }
  const transfers = companyTransfers.filter(t=>t.companyId===companyId).sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');

  const totalAmount = transfers.reduce((s,t)=>s+num(t.amount),0);
  const totalAllocated = transfers.reduce((s,t)=>s+transferAllocatedTotal(t),0);
  const totalRemaining = totalAmount - totalAllocated;
  const allTrainees = [];
  transfers.forEach(t=> (t.trainees||[]).forEach(tr=> allTrainees.push({tr, t})));
  const totalPosted = allTrainees.filter(x=>x.tr.posted).length;

  const transfersRows = transfers.length ? transfers.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const remaining = num(t.amount) - allocated;
    return `<tr>
      <td class="mono">${escapeHtml(t.date||'—')}</td>
      <td>${escapeHtml(t.channel||'—')}</td>
      <td class="mono">${escapeHtml(t.refNum||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
      <td class="mono">${num(t.traineeCount)}</td>
      <td class="mono">${(t.trainees||[]).length}</td>
      <td class="mono">${fmt(allocated)}</td>
      <td class="mono" style="${Math.abs(remaining)>0.01?`color:${PRINT_PALETTE.red};`:''}">${fmt(remaining)}</td>
      <td>${escapeHtml(t.notes||'—')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center; color:${PRINT_PALETTE.muted};">لا توجد حوالات مسجّلة لهذه الشركة</td></tr>`;

  const traineesRows = allTrainees.length ? allTrainees.map(({tr,t})=>{
    const cl = clients.find(x=>x.clientId===tr.clientId);
    return `<tr>
      <td class="mono">${escapeHtml(t.date||'—')}</td>
      <td class="mono">${escapeHtml(tr.clientId||'—')}</td>
      <td>${escapeHtml(cl?cl.name:'—')}</td>
      <td>${escapeHtml(cl?(cl.nationality||'—'):'—')}</td>
      <td>${escapeHtml(cl?(cl.courseType||'—'):'—')}</td>
      <td class="mono">${escapeHtml(cl?(cl.courseNumber||'—'):'—')}</td>
      <td class="mono">${fmt(num(tr.courseValue))}</td>
      <td class="mono">${fmt(num(tr.bagValue))}</td>
      <td class="mono">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center; color:${PRINT_PALETTE.muted};">لا يوجد متدربون مضافون بعد</td></tr>`;

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(`كشف حساب — ${company.name}`, {variant:'table-center', extraCss:`
    .summary-grid{display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:22px;}
    .summary-box{border:1px solid ${PRINT_PALETTE.border}; border-radius:8px; padding:10px 12px; text-align:center;}
    .summary-box .k{font-size:11.5px; color:${PRINT_PALETTE.muted}; margin-bottom:6px;}
    .summary-box .v{font-family:monospace; font-size:17px; font-weight:bold; color:${PRINT_PALETTE.navy};}
    h3{color:${PRINT_PALETTE.navy}; margin:22px 0 8px; font-size:15px;}
    tfoot td{background:${PRINT_PALETTE.surfaceAlt}; font-weight:bold;}
  `})}
  <body>
    <div class="head">
      <div><h2>كشف حساب — ${escapeHtml(company.name)}</h2><div style="font-size:13px; color:${PRINT_PALETTE.muted};">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>تاريخ الكشف: <b>${today}</b></span>
      ${company.taxNumber ? `<span>الرقم الضريبي: <b>${escapeHtml(company.taxNumber)}</b></span>` : ''}
      <span>المبلغ المتفق عليه/متدرب: <b>${(company.categories&&company.categories.length) ? escapeHtml(companyCategoriesSummaryText(company.categories)) : fmt(num(company.agreedAmount))}</b></span>
    </div>
    <div class="summary-grid">
      <div class="summary-box"><div class="k">عدد الحوالات</div><div class="v">${transfers.length}</div></div>
      <div class="summary-box"><div class="k">إجمالي قيمة الحوالات</div><div class="v">${fmt(totalAmount)}</div></div>
      <div class="summary-box"><div class="k">إجمالي المخصَّص فعلياً</div><div class="v">${fmt(totalAllocated)}</div></div>
      <div class="summary-box"><div class="k">المتبقي غير المخصَّص</div><div class="v" style="${Math.abs(totalRemaining)>0.01?`color:${PRINT_PALETTE.red};`:''}">${fmt(totalRemaining)}</div></div>
    </div>
    <h3>سجل الحوالات (${transfers.length})</h3>
    <table>
      <thead><tr><th>تاريخ الحوالة</th><th>طريقة الدفع</th><th>رقم المرجع</th><th>قيمة الحوالة</th><th>العدد المستهدف</th><th>عدد المتدربين المضافين</th><th>المخصَّص فعلياً</th><th>المتبقي</th><th>ملاحظات</th></tr></thead>
      <tbody>${transfersRows}</tbody>
    </table>
    <h3>المتدربون (${allTrainees.length} — تم الترحيل للبنك: ${totalPosted})</h3>
    <table>
      <thead><tr><th>تاريخ الحوالة</th><th>رقم الهوية</th><th>الاسم</th><th>الجنسية</th><th>نوع الدورة</th><th>رقم الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th></tr></thead>
      <tbody>${traineesRows}</tbody>
      ${allTrainees.length ? `<tfoot><tr>
        <td colspan="6" style="text-align:left;">الإجمالي</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.courseValue),0))}</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.bagValue),0))}</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.courseValue)+num(x.tr.bagValue),0))}</td>
      </tr></tfoot>` : ''}
    </table>
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}
let ctransfersPageState = {page:1, sig:''};
function renderCompanies(){
  renderCompaniesStatsCards();
  renderCompaniesUnsettledPanel();
  renderCompanyPersons();
  // ملخص أعداد المتدربين حسب الشركة (إجمالي كل الحوالات، بغض النظر عن أي فلترة)
  $('#company-transfers-summary').innerHTML = companiesTakenSummaryHtml();

  // طرق الدفع المتاحة لاختيار طريقة دفع الحوالة الجديدة (نفس طرق الدفع المُعرَّفة في الإعدادات)
  const ctChannelSel = $('#ct-channel');
  if(ctChannelSel){
    const ctChannelVal = ctChannelSel.value;
    populateSelect(ctChannelSel, settings.channels.map(c=>c.name), false);
    if(settings.channels.some(c=>c.name===ctChannelVal)) ctChannelSel.value = ctChannelVal;
    else { const bankCh = settings.channels.find(c=>c.dest==='bank'); if(bankCh) ctChannelSel.value = bankCh.name; }
  }

  // قائمة الشركات لاختيارها عند إضافة حوالة جديدة
  $('#ct-company').innerHTML = companies.length
    ? companies.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">— أضف شركة أولاً من الأعلى —</option>`;

  // datalist أرقام هويات العملاء (لو زار المستخدم هذا التبويب قبل تبويب الحركات المالية)
  const dlc = $('#dl-clients');
  if(dlc) dlc.innerHTML = clients.filter(c=>c.clientId).map(c=>`<option value="${escapeHtml(c.clientId)}" label="${escapeHtml(c.name)}"></option>`).join('');

  // datalist أسماء الشركات (لنموذج إضافة عميل جديد في شيت العملاء، ولحقل اسم الشركة أعلى جدول استيراد عمال الشركات)
  const dlComp = $('#dl-company-names');
  if(dlComp) dlComp.innerHTML = companies.map(c=>`<option value="${escapeHtml(c.name)}"></option>`).join('');

  // جدول الشركات المتفق معها
  const transfersByCompanyId = new Map();
  companyTransfers.forEach(t=>{
    let arr = transfersByCompanyId.get(t.companyId);
    if(!arr){ arr = []; transfersByCompanyId.set(t.companyId, arr); }
    arr.push(t);
  });
  $('#companies-list-body').innerHTML = companies.length ? companies.map(c=>{
    const transfers = transfersByCompanyId.get(c.id) || [];
    const totalAmount = transfers.reduce((s,t)=>s+num(t.amount),0);
    return `<tr>
      <td>${escapeHtml(c.name)}</td>
      <td class="mono">${escapeHtml(c.taxNumber||'—')}</td>
      <td class="mono">${(c.categories&&c.categories.length) ? escapeHtml(companyCategoriesSummaryText(c.categories)) : fmt(num(c.agreedAmount))}</td>
      <td class="mono">${transfers.length}</td>
      <td class="mono">${fmt(totalAmount)}</td>
      <td>
        <button class="btn btn-gold btn-sm" data-printcompany="${c.id}">🖨️ كشف حساب PDF</button>
        <button class="btn btn-ghost btn-sm" data-importcompanytrainees="${c.id}">📥 استيراد متدربين (كل الحوالات)</button>
        <button class="btn btn-ghost btn-sm" data-editcompany="${c.id}">تعديل</button>
        <button class="btn btn-ghost btn-sm" data-mergecompany="${c.id}">دمج مع شركة أخرى</button>
        <button class="btn btn-ghost btn-sm" data-delcompany="${c.id}">حذف</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد شركات مضافة بعد</td></tr>`;

  updateComputedShare();

  // خيارات فلتر الشركة لسجل الحوالات
  const ctfVal = $('#ctf-company').value;
  populateSelect($('#ctf-company'), companies.map(c=>c.name), false);
  $('#ctf-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
  $('#ctf-company').value = companies.some(c=>c.name===ctfVal) ? ctfVal : '';

  // خيارات فلتر طريقة الدفع لسجل الحوالات
  const ctfChannelVal = $('#ctf-channel')?.value;
  if($('#ctf-channel')){
    populateSelect($('#ctf-channel'), settings.channels.map(c=>c.name), false);
    $('#ctf-channel').insertAdjacentHTML('afterbegin','<option value="">كل طرق الدفع</option>');
    $('#ctf-channel').value = settings.channels.some(c=>c.name===ctfChannelVal) ? ctfChannelVal : '';
  }

  // سجل الحوالات والمتدربين (مفلترة حسب الشركة وتاريخ الحوالة وطريقة الدفع والبحث برقم الهوية/الاسم)
  const filteredTransfers = companiesFilteredTransfers();
  const sortedTransfers = filteredTransfers.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const ctPageRows = applyGenericPagination('ctransfers', sortedTransfers, ctransfersPageState, [
    $('#ctf-company')?.value, $('#ctf-date-from')?.value, $('#ctf-date-to')?.value, $('#ctf-clientid')?.value, $('#ctf-channel')?.value
  ]);
  $('#company-transfers-list').innerHTML = filteredTransfers.length ? ctPageRows.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const remaining = num(t.amount) - allocated;
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    const matchedTrainees = transferMatchingTrainees(t);
    const traineesHtml = matchedTrainees.length ? `
      <div class="table-scroll table-scroll-compact">
      <table style="margin-top:8px;">
        <thead><tr><th>رقم الهوية</th><th>الاسم</th><th>الجوال</th><th>الجنسية</th><th>نوع الدورة</th><th>رقم الدورة</th><th>رقم الفاتورة</th><th>حالة الحقيبة</th><th>تاريخ الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th><th>حالة الترحيل</th><th></th></tr></thead>
        <tbody>
          ${matchedTrainees.map(tr=>{
            const c = clients.find(x=>x.clientId===tr.clientId);
            return `<tr>
              <td class="mono">${escapeHtml(tr.clientId)}</td>
              <td>${escapeHtml(c?c.name:'—')}${!c?' <span class="hint" style="display:inline;">(غير موجود بشيت العملاء بعد)</span>':''}</td>
              <td class="mono">${escapeHtml(c?(c.phone||'—'):'—')}</td>
              <td>${escapeHtml(c?(c.nationality||'—'):'—')}</td>
              <td>${escapeHtml(c?(c.courseType||'—'):'—')}</td>
              <td class="mono">${escapeHtml(c?(c.courseNumber||'—'):'—')}</td>
              <td class="mono">${escapeHtml(c&&c.invoice?c.invoice:'—')}</td>
              <td>${c?escapeHtml(bagSourceLabel(c)):'—'}</td>
              <td class="mono">${escapeHtml(c?(formatDateDisplay(actualCourseDateOf(c))||'—'):'—')}</td>
              <td class="mono">${fmt(num(tr.courseValue))}</td>
              <td class="mono">${fmt(num(tr.bagValue))}</td>
              <td class="mono">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
              <td>${tr.posted ? '<span class="stamp paid">تم الترحيل</span>' : `<span class="stamp owe" title="${escapeHtml(tr.skipReason||'')}">${escapeHtml(tr.skipReason||'لم يُرحَّل')}</span>`}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-edittrainee="${t.id}|${tr.id}">تعديل</button>
                <button class="btn btn-ghost btn-sm" data-deltrainee="${t.id}|${tr.id}">حذف</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>${matchedTrainees.length<(t.trainees||[]).length ? `<div class="hint" style="margin:6px 0 0;">تم إخفاء ${(t.trainees||[]).length-matchedTrainees.length} متدرب لا يطابق فلتر البحث برقم الهوية — من إجمالي ${(t.trainees||[]).length} في هذه الحوالة</div>` : ''}` : ((t.trainees||[]).length ? `<div class="hint" style="margin:8px 0;">لا يوجد متدرب في هذه الحوالة يطابق فلتر البحث برقم الهوية.</div>` : `<div class="hint" style="margin:8px 0;">لا يوجد متدربون مضافون لهذه الحوالة بعد.</div>`);
    const todayStr = todayISO();
    const takenCount = matchedTrainees.filter(tr=>{
      const cc = clients.find(x=>x.clientId===tr.clientId);
      const d = cc ? actualCourseDateOf(cc) : '';
      return d && d<=todayStr;
    }).length;
    const notTakenCount = matchedTrainees.length - takenCount;
    return `
      <div class="panel" id="ctrow-${t.id}" style="margin-bottom:14px; border-right:4px solid var(--gold);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div>
            <b>${escapeHtml(t.companyName)}</b> — <span class="mono">${t.date||'—'}</span>
            ${Math.abs(remaining)>0.01 ? '<span class="stamp owe" style="margin-right:6px;">غير مكتملة التسوية</span>' : '<span class="stamp paid" style="margin-right:6px;">مكتملة التسوية</span>'}
            <div class="hint" style="margin:4px 0 0;">قيمة الحوالة: <b class="mono">${fmt(num(t.amount))}</b> ﷼ · عدد المتدربين المستهدف: <b class="mono">${num(t.traineeCount)}</b> · ${(t.groups&&t.groups.length) ? `تقسيم الفئات: <b>${escapeHtml(ctGroupsSummaryText(t.groups))}</b>` : `نصيب الفرد المحتسب: <b class="mono">${fmt(share)}</b> ﷼`} · طريقة الدفع: <b>${escapeHtml(t.channel||'تحويل بنكي')}</b>${t.refNum?` · رقم المرجع: <b class="mono">${escapeHtml(t.refNum)}</b>`:''}${t.notes?` · ${escapeHtml(t.notes)}`:''}</div>
            <div class="hint" style="margin:4px 0 0;">عدد من أخذ الدورة: <b class="mono" style="color:var(--teal);">${takenCount}</b> · عدد من لم يأخذ الدورة بعد: <b class="mono" style="color:var(--red);">${notTakenCount}</b></div>
            <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; margin-top:6px; font-size:13px;">
              <input type="checkbox" data-transferbagall="${t.id}" ${t.bagForAll?'checked':''} style="width:auto; margin:0;">
              شراء حقيبة لكل متدربي هذه الحوالة (يُقسَّم نصيب كل متدرب تلقائياً إلى قيمة دورة + قيمة حقيبة حسب السعر الافتراضي)
            </label>
          </div>
          <div style="text-align:left;">
            <div>المخصَّص فعلياً: <b class="mono">${fmt(allocated)}</b> ﷼</div>
            <div class="${remaining<0?'red':''}">المتبقي من الحوالة: <b class="mono">${fmt(remaining)}</b> ﷼</div>
          </div>
        </div>
        ${traineesHtml}
        <div style="margin-top:10px;">
          <button class="btn btn-gold btn-sm" data-addtrainee="${t.id}">+ إضافة متدرب</button>
          <button class="btn btn-ghost btn-sm" data-importtrainees="${t.id}">+ استيراد متدربين (Excel)</button>
          <button class="btn btn-ghost btn-sm" data-importtraineestext="${t.id}">+ استيراد متدربين (لصق نص)</button>
          <button class="btn btn-ghost btn-sm" data-edittransfer="${t.id}">تعديل الحوالة</button>
          <button class="btn btn-danger btn-sm" data-deltransfer="${t.id}">حذف الحوالة كاملة</button>
        </div>
      </div>`;
  }).join('') : `<div class="empty-state" style="padding:20px;">لا توجد تحويلات شركات مسجّلة بعد</div>`;
}

['#ctf-company','#ctf-date-from','#ctf-date-to','#ctf-channel'].forEach(sel=> $(sel).addEventListener('input', renderCompanies));
onSearchInput('#ctf-clientid', renderCompanies);
bindGenericPagination('ctransfers', ctransfersPageState, renderCompanies);
['#cpp-company','#cpp-date-from','#cpp-date-to','#cpp-channel'].forEach(sel=> $(sel)?.addEventListener('input', renderCompanyPersons));
onSearchInput('#cpp-search', renderCompanyPersons);
bindGenericPagination('cpersons', cpersonsPageState, renderCompanyPersons);
$('#btn-export-companies').addEventListener('click', ()=>{
  const headers = ['اسم الشركة','تاريخ الحوالة','طريقة الدفع','رقم المرجع','قيمة الحوالة','عدد المتدربين المستهدف','نصيب الفرد','ملاحظات','رقم هوية المتدرب','اسم المتدرب','قيمة الدورة','قيمة الحقيبة','إجمالي المتدرب','حالة الترحيل'];
  const rows = [];
  companiesFilteredTransfers().forEach(t=>{
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    if((t.trainees||[]).length){
      t.trainees.forEach(tr=>{
        const c = clients.find(x=>x.clientId===tr.clientId);
        rows.push([t.companyName,t.date,t.channel||'تحويل بنكي',t.refNum||'',num(t.amount),num(t.traineeCount),share,t.notes||'',tr.clientId,c?c.name:'',num(tr.courseValue),num(tr.bagValue),num(tr.courseValue)+num(tr.bagValue),tr.posted?'تم الترحيل':'لم يُرحَّل']);
      });
    } else {
      rows.push([t.companyName,t.date,t.channel||'تحويل بنكي',t.refNum||'',num(t.amount),num(t.traineeCount),share,t.notes||'','','','','','','']);
    }
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تحويلات_الشركات.csv';
  a.click();
});
$('#btn-export-companies-xlsx').addEventListener('click', ()=>{
  const rows = [];
  companiesFilteredTransfers().forEach(t=>{
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    if((t.trainees||[]).length){
      t.trainees.forEach(tr=>{
        const c = clients.find(x=>x.clientId===tr.clientId);
        rows.push({
          'اسم الشركة': t.companyName, 'تاريخ الحوالة': t.date||'', 'طريقة الدفع': t.channel||'تحويل بنكي', 'رقم المرجع': t.refNum||'',
          'قيمة الحوالة': num(t.amount), 'عدد المتدربين المستهدف': num(t.traineeCount), 'نصيب الفرد': share, 'ملاحظات': t.notes||'',
          'رقم هوية المتدرب': tr.clientId, 'اسم المتدرب': c?c.name:'', 'قيمة الدورة': num(tr.courseValue), 'قيمة الحقيبة': num(tr.bagValue),
          'إجمالي المتدرب': num(tr.courseValue)+num(tr.bagValue), 'حالة الترحيل': tr.posted?'تم الترحيل':'لم يُرحَّل'
        });
      });
    } else {
      rows.push({
        'اسم الشركة': t.companyName, 'تاريخ الحوالة': t.date||'', 'طريقة الدفع': t.channel||'تحويل بنكي', 'رقم المرجع': t.refNum||'',
        'قيمة الحوالة': num(t.amount), 'عدد المتدربين المستهدف': num(t.traineeCount), 'نصيب الفرد': share, 'ملاحظات': t.notes||'',
        'رقم هوية المتدرب': '', 'اسم المتدرب': '', 'قيمة الدورة': '', 'قيمة الحقيبة': '', 'إجمالي المتدرب': '', 'حالة الترحيل': ''
      });
    }
  });
  downloadXlsx('تحويلات_الشركات.xlsx', 'تحويلات الشركات', rows);
});
function resetCompanyForm(){
  editingCompanyId = null;
  $('#cm-name').value=''; $('#cm-amount').value=''; $('#cm-tax').value='';
  resetCmCats();
  $('#btn-add-company').textContent = '+ إضافة شركة';
  $('#btn-cancel-edit-company').style.display = 'none';
}

$('#btn-add-company').addEventListener('click', async ()=>{
  const name = $('#cm-name').value.trim();
  if(!name){ showToast('أدخل اسم الشركة'); return; }
  const dupCompany = companies.find(c=>c.name===name);
  if(dupCompany && dupCompany.id!==editingCompanyId){ showToast('هذه الشركة مضافة مسبقاً'); return; }
  const agreedAmount = num($('#cm-amount').value);
  const taxNumber = $('#cm-tax').value.trim();
  const categoriesUsed = cmCats.filter(c=>c.label && num(c.amount)>0);
  if(cmCats.length && !categoriesUsed.length){ showToast('أكمل بيانات الفئات (الاسم والمبلغ) أو احذفها'); return; }

  if(editingCompanyId){
    const c = companies.find(x=>x.id===editingCompanyId);
    if(!c){ showToast('تعذّر إيجاد الشركة المطلوب تعديلها'); resetCompanyForm(); return; }
    snapshotState(`تعديل بيانات الشركة: ${c.name}`);
    const oldName = c.name;
    c.name = name;
    c.agreedAmount = agreedAmount;
    c.taxNumber = taxNumber;
    if(categoriesUsed.length) c.categories = categoriesUsed.map(cc=>({label:cc.label, amount:num(cc.amount)}));
    else delete c.categories;
    // إن تغيّر اسم الشركة، حدّث الاسم أيضاً في تحويلات الشركة المرتبطة بها وفي بيانات العملاء المرتبطين بها
    if(oldName!==name){
      companyTransfers.forEach(t=>{ if(t.companyId===c.id) t.companyName = name; });
      clients.forEach(cl=>{ if(cl.clientType==='company' && cl.companyName===oldName) cl.companyName = name; });
      await saveCompanyTransfers();
      await saveClients();
    }
    await saveCompanies();
    const catsNote = categoriesUsed.length ? ` — مبالغ حسب الفئة: ${companyCategoriesSummaryText(c.categories)}` : '';
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات الشركة: ${name} (المبلغ المتفق عليه للمتدرب: ${fmt(agreedAmount)}${taxNumber?` — الرقم الضريبي: ${taxNumber}`:''})${catsNote}`);
    resetCompanyForm();
    renderCompanies(); renderTable();
    showToast('تم تحديث بيانات الشركة');
    return;
  }

  snapshotState(`إضافة شركة جديدة: ${name}`);
  const companyRecord = {id:uid(), name, agreedAmount, taxNumber, createdAt:Date.now()};
  if(categoriesUsed.length) companyRecord.categories = categoriesUsed.map(c=>({label:c.label, amount:num(c.amount)}));
  companies.push(companyRecord);
  await saveCompanies();
  const catsNote = categoriesUsed.length ? ` — مبالغ حسب الفئة: ${companyCategoriesSummaryText(companyRecord.categories)}` : '';
  await logAudit('add','تحويلات الشركات', `تمت إضافة شركة جديدة: ${name} (المبلغ المتفق عليه للمتدرب: ${fmt(agreedAmount)}${taxNumber?` — الرقم الضريبي: ${taxNumber}`:''})${catsNote}`);
  resetCompanyForm();
  renderCompanies();
  showToast('تمت إضافة الشركة');
});

$('#btn-cancel-edit-company').addEventListener('click', ()=>{
  resetCompanyForm();
  showToast('تم إلغاء التعديل');
});

$('#btn-add-transfer').addEventListener('click', async ()=>{
  const companyId = $('#ct-company').value;
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('اختر شركة أولاً (أضفها من القائمة أعلاه إن لم تكن موجودة)'); return; }
  const amount = num($('#ct-amount').value);
  const count = num($('#ct-count').value);
  if(amount<=0){ showToast('أدخل قيمة صحيحة للحوالة'); return; }
  if(count<=0){ showToast('أدخل عدد المتدربين المراد تدريبهم'); return; }
  const date = $('#ct-date').value || todayISO();
  const notes = $('#ct-notes').value.trim();
  const refNum = $('#ct-refnum').value.trim();
  const channel = $('#ct-channel').value || (settings.channels.find(ch=>ch.dest==='bank')||{}).name || 'تحويل بنكي';
  const groupsUsed = ctGroups.filter(g=>g.label && num(g.count)>0 && num(g.price)>=0);
  if(ctGroups.length && !groupsUsed.length){ showToast('أكمل بيانات الفئات (الاسم والعدد) أو احذفها للإدخال اليدوي'); return; }
  if(editingTransferId){
    const idx = companyTransfers.findIndex(x=>x.id===editingTransferId);
    if(idx===-1){ showToast('تعذّر إيجاد الحوالة للتعديل — قد تكون حُذفت'); cancelTransferEdit(); return; }
    const tExisting = companyTransfers[idx];
    const lockedLinked = (tExisting.trainees||[]).some(tr=>{
      const vtx = vaultTx.find(v=>v.companyTransferAllocId===tr.id);
      return vtx && isDateLocked(vtx.date);
    });
    if(lockedLinked){ showToast('تعذّر التعديل: توجد حركة مالية مرتبطة بمتدربي هذه الحوالة ضمن فترة محاسبية مُقفلة'); return; }
    snapshotState(`تعديل حوالة الشركة: ${company.name}`);
    const t = companyTransfers[idx];
    t.companyId = companyId; t.companyName = company.name; t.date = date; t.amount = amount;
    t.traineeCount = count; t.notes = notes; t.channel = channel; t.refNum = refNum;
    if(groupsUsed.length) t.groups = groupsUsed.map(g=>({label:g.label, count:num(g.count), price:num(g.price)}));
    else delete t.groups;
    // مزامنة التاريخ وطريقة الدفع مع كل حركة مالية مُرحَّلة فعلياً لمتدربي هذه الحوالة (لأن كل حركة أُنشئت بتاريخ/طريقة دفع الحوالة وقت الترحيل، ولا ترتبط تلقائياً بالحوالة بعد ذلك)
    let cascadedCount = 0;
    (t.trainees||[]).forEach(tr=>{
      const vtx = vaultTx.find(v=>v.companyTransferAllocId===tr.id);
      if(vtx){
        vtx.date = date;
        vtx.method = channel;
        const destCh = settings.channels.find(ch=>ch.name===channel);
        if(destCh) vtx.destination = destCh.dest;
        vtx.notes = `ترحيل تلقائي (مُعدَّل حسب تعديل بيانات الحوالة) من حوالة الشركة "${company.name}" بتاريخ ${date}${num(tr.bagValue)>0?' — يشمل قيمة الحقيبة':''}`;
        cascadedCount++;
      }
    });
    if(cascadedCount) await saveVaultTx();
    await saveCompanyTransfers();
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات حوالة الشركة "${company.name}" بتاريخ ${date} — القيمة الآن ${fmt(amount)} لعدد ${count} متدرب (طريقة الدفع: ${channel})${cascadedCount?` — وتمت مزامنة التاريخ وطريقة الدفع مع ${cascadedCount} حركة مالية مُرحَّلة مسبقاً لمتدربي هذه الحوالة`:''}`);
    cancelTransferEdit();
    renderCompanies();
    showToast('تم حفظ التعديل');
    return;
  }
  snapshotState(`إضافة حوالة جديدة للشركة: ${company.name}`);
  const transferRecord = {id:uid(), createdAt:Date.now(), companyId, companyName:company.name, date, amount, traineeCount:count, notes, channel, refNum, trainees:[]};
  if(groupsUsed.length) transferRecord.groups = groupsUsed.map(g=>({label:g.label, count:num(g.count), price:num(g.price)}));
  companyTransfers.push(transferRecord);
  await saveCompanyTransfers();
  const groupsNote = groupsUsed.length ? ` — مقسّمة حسب فئات: ${ctGroupsSummaryText(transferRecord.groups)}` : '';
  await logAudit('add','تحويلات الشركات', `تمت إضافة حوالة جديدة للشركة "${company.name}" بقيمة ${fmt(amount)} لعدد ${count} متدرب (طريقة الدفع: ${channel})${groupsNote}`);
  $('#ct-amount').value=''; $('#ct-count').value=''; $('#ct-notes').value=''; $('#ct-date').value=''; $('#ct-refnum').value='';
  resetCtGroups();
  renderCompanies();
  showToast('تم حفظ الحوالة');
});

/* تعديل حوالة شركة قائمة: يملأ نموذج "إضافة حوالة جديدة" ببيانات الحوالة المحددة، ويحوّل زر الحفظ لوضع "تعديل" مؤقتاً */
function openTransferEdit(id){
  const t = companyTransfers.find(x=>x.id===id);
  if(!t) return;
  editingTransferId = id;
  $('#ct-company').value = t.companyId;
  $('#ct-date').value = t.date || '';
  $('#ct-notes').value = t.notes || '';
  $('#ct-refnum').value = t.refNum || '';
  ctGroups = (t.groups||[]).map(g=>({id:uid(), label:g.label, count:g.count, price:g.price}));
  if(ctGroups.length){ renderCtGroups(); } else { $('#ct-amount').value = t.amount ?? ''; $('#ct-count').value = t.traineeCount ?? ''; resetCtGroups(); }
  if(settings.channels.some(c=>c.name===t.channel)) $('#ct-channel').value = t.channel;
  else { const fixed = canonicalizeChannelName(t.channel); if(settings.channels.some(c=>c.name===fixed)) $('#ct-channel').value = fixed; }
  updateComputedShare();
  $('#btn-add-transfer').textContent = 'حفظ التعديل';
  $('#btn-cancel-edit-transfer').style.display = '';
  $('#ct-company').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelTransferEdit(){
  editingTransferId = null;
  $('#ct-amount').value=''; $('#ct-count').value=''; $('#ct-notes').value=''; $('#ct-date').value=''; $('#ct-refnum').value='';
  resetCtGroups();
  $('#btn-add-transfer').textContent = 'حفظ الحوالة';
  $('#btn-cancel-edit-transfer').style.display = 'none';
}
$('#btn-cancel-edit-transfer').addEventListener('click', ()=>{ cancelTransferEdit(); showToast('تم إلغاء التعديل'); });

$('#ctr-id').addEventListener('input', ()=>{
  const c = clients.find(x=>x.clientId===$('#ctr-id').value.trim());
  if(c){
    const alreadyPaid = num(c.paid)>0;
    $('#ctr-client-info').innerHTML = `العميل: <b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.phone||'—')} — ${escapeHtml(c.nationality||'—')}` +
      (alreadyPaid ? `<br><span style="color:var(--red);">⚠️ هذا العميل مسجَّل بالفعل ومدفوع عنه في شيت العملاء (${fmt(num(c.paid))} ﷼) — لن يُرحَّل مبلغ جديد للبنك تلقائياً لتجنّب تكرار الأرقام؛ الإضافة هنا للتوثيق فقط.</span>` : '');
    $('#wrap-ctr-newclient').style.display = 'none';
    $('#wrap-ctr-newclient2').style.display = 'none';
  }else{
    $('#ctr-client-info').textContent = 'لم يتم العثور على العميل بعد — إن أكملت الاسم والجنسية أدناه سيُضاف تلقائياً كعميل شركات جديد في شيت العملاء.';
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
  }
});
$('#ctr-cancel').addEventListener('click', ()=>{ $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null; ctEditingTraineeId=null; $('#ctr-id').readOnly=false; });
$('#ctrainee-overlay').addEventListener('click', e=>{ if(e.target.id==='ctrainee-overlay'){ $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null; ctEditingTraineeId=null; $('#ctr-id').readOnly=false; } });

function recalcCtrSplit(){
  const total = num($('#ctr-total').value);
  const bagPrice = num(settings.bagPrice) || 0;
  const bagVal = $('#ctr-bag-purchased').checked ? Math.min(bagPrice, total) : 0;
  $('#ctr-bag').value = bagVal ? Math.round(bagVal*100)/100 : 0;
  $('#ctr-course').value = Math.round((total-bagVal)*100)/100;
}
$('#ctr-total').addEventListener('input', recalcCtrSplit);
$('#ctr-bag-purchased').addEventListener('change', recalcCtrSplit);

$('#ctrainee-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const t = companyTransfers.find(x=>x.id===ctraineeTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); return; }
  const clientId = $('#ctr-id').value.trim();
  if(!clientId){ showToast('أدخل رقم الهوية'); return; }
  const courseValue = num($('#ctr-course').value);
  const bagValue = num($('#ctr-bag').value);
  if(courseValue<=0 && bagValue<=0){ showToast('أدخل قيمة الدورة أو قيمة الحقيبة'); return; }

  if(ctEditingTraineeId){
    const tr = (t.trainees||[]).find(x=>x.id===ctEditingTraineeId);
    if(!tr){ showToast('تعذّر إيجاد المتدرب'); return; }
    snapshotState(`تعديل بيانات متدرب لحوالة الشركة: ${t.companyName}`);
    let client = clients.find(x=>x.clientId===clientId);
    const name = $('#ctr-name').value.trim();
    const nat = $('#ctr-nat').value;
    if(client){
      if(name) client.name = name;
      if(nat) client.nationality = nat;
      // ربط العميل تلقائياً بهذه الشركة حتى يظهر عند الفلترة بها في شيت العملاء
      if(client.companyName!==t.companyName || client.clientType!=='company'){
        client.clientType = 'company';
        client.companyName = t.companyName;
      }
    }else if(name){
      // إن لم يوجد سجل عميل ولكن تم إدخال اسم أثناء التعديل، يُنشأ السجل الآن
      client = {
        id: uid(), createdAt: Date.now(),
        clientId, name, phone:'', nationality: nat||'',
        clientType:'company', companyName: t.companyName, creditDays:'',
        clientTaxNumber:'', courseType:'', courseNumber:'',
        referNum:'', invoice:'', bagInvoice:'',
        date: t.date || todayISO(),
        coursePrice: courseValue, bagSource: bagValue>0?'stock':'own', bagPrice: bagValue,
        bagStatus: bagValue>0?'purchased':'n/a', bagPurchaseDate: bagValue>0?(t.date||todayISO()):undefined, discount:0, paid: courseValue+bagValue,
        channel:(()=>{ const ch = settings.channels.find(c=>c.name===t.channel); return ch ? ch.name : 'تحويل بنكي (شركة)'; })(), networkInvoice:'', paid2:0, channel2:'', networkInvoice2:'',
        stage:'جديد', cancelled:false,
        notes: `أُضيف تلقائياً (أثناء تعديل) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
      };
      clients.push(client);
      if(bagValue>0){
        bagStock.push({
          id: uid(), type:'issue', qty:-1, unitPrice:0,
          date: client.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: client.id, issuedClientName: client.name,
          notes: `تسليم من المخزون للعميل: ${client.name} (استيراد متدربي حوالة الشركة "${t.companyName}")`
        });
        recalcBagFundLedger();
        await saveBagStock();
        await saveSettings();
      }
    }
    if(client) await saveClients();

    tr.courseValue = courseValue;
    tr.bagValue = bagValue;
    // تحديث الترحيل المالي المرتبط في الحركات المالية إن كان قد رُحِّل مسبقاً
    const vtx = vaultTx.find(v=>v.companyTransferAllocId===tr.id);
    if(vtx){
      vtx.amount = courseValue+bagValue;
      vtx.clientName = client ? client.name : vtx.clientName;
      vtx.notes = `ترحيل تلقائي (مُعدَّل) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}${bagValue>0?' — يشمل قيمة الحقيبة':''}`;
      await saveVaultTx();
    }
    await saveCompanyTransfers();
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات متدرب (${clientId}) في حوالة الشركة "${t.companyName}"`);

    $('#ctrainee-overlay').classList.remove('show');
    ctraineeTargetTransferId = null; ctEditingTraineeId = null;
    $('#ctr-id').readOnly = false;
    renderCompanies(); renderVault(); renderTable();
    showToast('تم تحديث بيانات المتدرب');
    return;
  }

  // منع تكرار إضافة نفس المتدرب (بنفس رقم الهوية) في أكثر من حوالة شركة — أو نفس الحوالة مرتين
  const dupTransfer = companyTransfers.find(tt => (tt.trainees||[]).some(tr=>tr.clientId===clientId));
  if(dupTransfer){
    showToast(`هذا المتدرب (${clientId}) مُضاف مسبقاً في حوالة الشركة "${dupTransfer.companyName}" بتاريخ ${dupTransfer.date||'—'} — لا يمكن إضافته لحوالة أخرى لتجنّب التكرار. إن أردت تعديل بياناته استخدم زر "تعديل" في تلك الحوالة.`);
    return;
  }

  snapshotState(`إضافة متدرب لحوالة الشركة: ${t.companyName}`);
  let client = clients.find(x=>x.clientId===clientId);
  const alreadyPostedElsewhere = !!(client && num(client.paid)>0);
  const traineeId = uid();
  let posted = false, skipReason = '';
  const payChannel0 = settings.channels.find(ch=>ch.name===t.channel);
  const payMethod0 = payChannel0 ? payChannel0.name : 'تحويل بنكي (شركة)';

  if(!client){
    // لا يوجد سجل عميل بهذا الرقم بعد — نُنشئ سجلاً كاملاً في شيت العملاء (عميل شركات) حتى يظهر عند الفلترة بالشركة
    client = {
      id: uid(), createdAt: Date.now(),
      clientId, name: $('#ctr-name').value.trim() || `متدرب شركة (${clientId})`,
      phone:'', nationality: $('#ctr-nat').value || '',
      clientType:'company', companyName: t.companyName, creditDays:'',
      clientTaxNumber:'', courseType:'', courseNumber:'',
      referNum:'', invoice:'', bagInvoice:'',
      date: t.date || todayISO(),
      coursePrice: courseValue,
      bagSource: bagValue>0 ? 'stock' : 'own',
      bagPrice: bagValue,
      bagStatus: bagValue>0 ? 'purchased' : 'n/a',
      bagPurchaseDate: bagValue>0 ? (t.date||todayISO()) : undefined,
      discount: 0,
      paid: courseValue+bagValue,
      channel:payMethod0, networkInvoice:'',
      paid2:0, channel2:'', networkInvoice2:'',
      stage:'جديد', cancelled:false,
      notes: `أُضيف تلقائياً من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
    };
    clients.push(client);
    if(bagValue>0){
      bagStock.push({
        id: uid(), type:'issue', qty:-1, unitPrice:0,
        date: client.bagPurchaseDate, createdAt: Date.now(),
        issuedClientId: client.id, issuedClientName: client.name,
        notes: `تسليم من المخزون للعميل: ${client.name} (استيراد متدربي حوالة الشركة "${t.companyName}")`
      });
      recalcBagFundLedger();
      await saveBagStock();
      await saveSettings();
    }
    await saveClients();
  }else if(client.companyName!==t.companyName || client.clientType!=='company'){
    // العميل موجود بالفعل بشيت العملاء (ربما بدون شركة أو تابع لشركة أخرى) — نربطه تلقائياً بهذه الشركة حتى يظهر عند الفلترة بها
    client.clientType = 'company';
    client.companyName = t.companyName;
    await saveClients();
  }

  let matchedExisting = false;
  if(!alreadyPostedElsewhere){
    const totalAmount = courseValue + bagValue;
    if(totalAmount>0){
      const payDest = payChannel0 ? payChannel0.dest : 'bank';
      // مطابقة مسبقة: إن وُجدت حركة مالية موجودة فعلاً بنفس رقم الهوية ونفس القيمة (وغير مرتبطة بترحيل سابق)، تُحدَّث تلقائياً بدل إنشاء حركة مكرّرة
      const existingTx = vaultTx.find(v => v.clientId===clientId && !v.companyTransferAllocId && Math.abs(num(v.amount)-totalAmount)<0.01);
      if(existingTx){
        existingTx.date = t.date || todayISO();
        existingTx.destination = payDest;
        existingTx.method = payMethod0;
        existingTx.clientName = client ? client.name : existingTx.clientName;
        existingTx.notes = `ترحيل تلقائي (مطابقة رقم الهوية والقيمة مع حركة موجودة مسبقاً) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}${bagValue>0?' — يشمل قيمة الحقيبة':''}`;
        existingTx.companyTransferAllocId = traineeId;
        matchedExisting = true;
      }else{
        vaultTx.push({
          id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
          type:'in', date: t.date || todayISO(), amount: totalAmount, destination:payDest,
          clientId, clientName: client ? client.name : '', method:payMethod0,
          category:'', manual: client ? '' : `متدرب شركة: ${clientId}`,
          networkInvoice:'',
          notes: `ترحيل تلقائي من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}${bagValue>0?' — يشمل قيمة الحقيبة':''}`,
          companyTransferAllocId: traineeId
        });
      }
      await saveVaultTx();
      await saveSettings();
      posted = true;
    }
  }else{
    skipReason = 'مدفوع بالفعل عبر شيت العملاء — لم يُرحَّل';
  }

  t.trainees = t.trainees || [];
  t.trainees.push({id:traineeId, clientId, courseValue, bagValue, posted, skipReason});
  await saveCompanyTransfers();
  await logAudit('add','تحويلات الشركات', `تمت إضافة متدرب (${clientId}) لحوالة الشركة "${t.companyName}"${posted?(matchedExisting?' وتم تحديث حركة مالية موجودة مطابقة (رقم الهوية والقيمة) بإجمالي '+fmt(courseValue+bagValue)+' ﷼':' وتم ترحيل إجمالي '+fmt(courseValue+bagValue)+' ﷼'):' (بدون ترحيل جديد — '+skipReason+')'}`);

  $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null;
  renderCompanies(); renderVault(); renderTable();
  showToast(posted ? 'تمت الإضافة والترحيل' : 'تمت الإضافة بدون ترحيل جديد (مدفوع بالفعل)');
});

document.addEventListener('change', async e=>{
  if(!e.target.dataset.transferbagall) return;
  const transferId = e.target.dataset.transferbagall;
  const t = companyTransfers.find(x=>x.id===transferId);
  if(!t) return;
  const checked = e.target.checked;
  const bagPrice = num(settings.bagPrice) || 0;
  snapshotState(`${checked?'تفعيل':'إلغاء'} شراء الحقيبة لكل متدربي حوالة الشركة: ${t.companyName}`);
  t.bagForAll = checked;
  let changed = 0;
  (t.trainees||[]).forEach(tr=>{
    const total = num(tr.courseValue) + num(tr.bagValue);
    const newBag = checked ? Math.min(bagPrice, total) : 0;
    const newCourse = Math.round((total-newBag)*100)/100;
    if(newBag!==num(tr.bagValue) || newCourse!==num(tr.courseValue)){
      tr.bagValue = newBag ? Math.round(newBag*100)/100 : 0;
      tr.courseValue = newCourse;
      changed++;
    }
  });
  await saveCompanyTransfers();
  await logAudit('edit','تحويلات الشركات', `${checked?'تفعيل':'إلغاء'} تقسيم الحقيبة لكل متدربي حوالة الشركة "${t.companyName}" — تم تعديل ${changed} متدرب`);
  renderCompanies();
  showToast(checked ? `تم تقسيم المبلغ لـ${changed} متدرب (قيمة الحقيبة ${fmt(bagPrice)} ﷼ لكل متدرب)` : `تم إلغاء تقسيم الحقيبة لـ${changed} متدرب`);
});

document.addEventListener('click', async e=>{
  if(e.target.dataset.addtrainee){
    ctraineeTargetTransferId = e.target.dataset.addtrainee;
    ctEditingTraineeId = null;
    $('#ctrainee-modal-title').textContent = 'إضافة متدرب للحوالة';
    $('#ctr-id').readOnly = false;
    const t = companyTransfers.find(x=>x.id===ctraineeTargetTransferId);
    const share = (t && num(t.traineeCount)>0) ? num(t.amount)/num(t.traineeCount) : 0;
    $('#ctr-id').value = '';
    $('#ctr-name').value = '';
    populateSelect($('#ctr-nat'), settings.nationalities, true);
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
    $('#ctr-total').value = share ? Math.round(share*100)/100 : '';
    $('#ctr-bag-purchased').checked = !!(t && t.bagForAll);
    recalcCtrSplit();
    $('#ctr-client-info').textContent = 'لم يتم العثور على العميل بعد — إن أكملت الاسم والجنسية أدناه سيُضاف تلقائياً كعميل شركات جديد في شيت العملاء.';
    $('#ctrainee-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.edittrainee){
    const [transferId, traineeId] = e.target.dataset.edittrainee.split('|');
    const t = companyTransfers.find(x=>x.id===transferId);
    const tr = t && (t.trainees||[]).find(x=>x.id===traineeId);
    if(!t || !tr){ showToast('تعذّر تحديد المتدرب'); return; }
    ctraineeTargetTransferId = transferId;
    ctEditingTraineeId = traineeId;
    $('#ctrainee-modal-title').textContent = 'تعديل بيانات متدرب';
    $('#ctr-id').value = tr.clientId;
    $('#ctr-id').readOnly = true; // لا يُسمح بتغيير رقم الهوية أثناء التعديل لتفادي فقدان الربط بالمتدرب
    const c = clients.find(x=>x.clientId===tr.clientId);
    $('#ctr-name').value = c ? c.name : '';
    populateSelect($('#ctr-nat'), settings.nationalities, true);
    $('#ctr-nat').value = c ? (c.nationality||'') : '';
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
    $('#ctr-client-info').textContent = c
      ? `العميل: ${escapeHtml(c.name)} — ${escapeHtml(c.phone||'—')} — ${escapeHtml(c.nationality||'—')}`
      : 'لا يوجد سجل عميل لهذا المتدرب بعد — يمكنك تعبئة الاسم والجنسية لإنشائه الآن.';
    const total = num(tr.courseValue) + num(tr.bagValue);
    $('#ctr-total').value = total ? Math.round(total*100)/100 : '';
    $('#ctr-bag-purchased').checked = num(tr.bagValue)>0;
    $('#ctr-course').value = num(tr.courseValue);
    $('#ctr-bag').value = num(tr.bagValue);
    $('#ctrainee-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.importtrainees){
    ctImportTargetTransferId = e.target.dataset.importtrainees;
    $('#import-trainees-input').click();
  }
  if(e.target.dataset.importtraineestext){
    ctImportTextTargetTransferId = e.target.dataset.importtraineestext;
    openCtitModal();
  }
  if(e.target.dataset.deltrainee){
    const [transferId, traineeId] = e.target.dataset.deltrainee.split('|');
    const t = companyTransfers.find(x=>x.id===transferId);
    if(t && await customConfirm('حذف هذا المتدرب من الحوالة؟ سيُحذف أيضاً أي ترحيل مالي مرتبط به للبنك.')){
      const tr = (t.trainees||[]).find(x=>x.id===traineeId);
      snapshotState(`حذف متدرب من حوالة الشركة: ${t.companyName}`);
      vaultTx = vaultTx.filter(v=>v.companyTransferAllocId!==traineeId);
      t.trainees = (t.trainees||[]).filter(x=>x.id!==traineeId);
      await saveVaultTx();
      await saveCompanyTransfers();
      await logAudit('delete','تحويلات الشركات', `تم حذف متدرب (${tr?tr.clientId:''}) من حوالة الشركة "${t.companyName}"`);
      renderCompanies(); renderVault();
      showToast('تم الحذف');
    }
  }
  if(e.target.dataset.deltransfer){
    const transferId = e.target.dataset.deltransfer;
    const t = companyTransfers.find(x=>x.id===transferId);
    if(t && await customConfirm(`حذف حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''} كاملة مع كل المتدربين المرتبطين بها والترحيلات المالية المرتبطة؟`)){
      snapshotState(`حذف حوالة شركة: ${t.companyName}`);
      const traineeIds = (t.trainees||[]).map(x=>x.id);
      vaultTx = vaultTx.filter(v=>!traineeIds.includes(v.companyTransferAllocId));
      companyTransfers = companyTransfers.filter(x=>x.id!==transferId);
      await saveVaultTx();
      await saveCompanyTransfers();
      await logAudit('delete','تحويلات الشركات', `تم حذف حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''} بقيمة ${fmt(num(t.amount))}`);
      renderCompanies(); renderVault();
      showToast('تم حذف الحوالة');
    }
  }
  if(e.target.dataset.edittransfer){
    openTransferEdit(e.target.dataset.edittransfer);
  }
  if(e.target.dataset.delcompany){
    const id = e.target.dataset.delcompany;
    const c = companies.find(x=>x.id===id);
    const hasTransfers = companyTransfers.some(t=>t.companyId===id);
    if(hasTransfers){ showToast('لا يمكن حذف شركة لديها حوالات مسجّلة — احذف حوالاتها أولاً'); return; }
    if(c && await customConfirm(`حذف الشركة "${c.name}" من القائمة؟`)){
      snapshotState(`حذف شركة: ${c.name}`);
      companies = companies.filter(x=>x.id!==id);
      await saveCompanies();
      await logAudit('delete','تحويلات الشركات', `تم حذف الشركة: ${c.name}`);
      if(editingCompanyId===id) resetCompanyForm();
      renderCompanies();
      showToast('تم الحذف');
    }
  }
  if(e.target.dataset.printcompany){
    printCompanyStatement(e.target.dataset.printcompany);
  }
  if(e.target.dataset.importcompanytrainees){
    const companyId = e.target.dataset.importcompanytrainees;
    const company = companies.find(c=>c.id===companyId);
    if(!company){ showToast('تعذّر إيجاد الشركة'); return; }
    if(!companyTransfers.some(t=>t.companyId===companyId)){ showToast('لا توجد حوالات مسجّلة لهذه الشركة بعد — أضف حوالة أولاً'); return; }
    ctImportCompanyTargetId = companyId;
    $('#import-company-trainees-input').click();
  }
  if(e.target.dataset.mergecompany){
    const sourceId = e.target.dataset.mergecompany;
    const source = companies.find(x=>x.id===sourceId);
    if(!source){ showToast('تعذّر إيجاد الشركة'); return; }
    const otherNames = companies.filter(x=>x.id!==sourceId).map(x=>x.name);
    if(!otherNames.length){ showToast('لا توجد شركة أخرى لدمجها معها'); return; }
    const targetName = await customPrompt(
      `دمج شركة "${source.name}" في شركة أخرى موجودة — سيتم نقل كل حوالاتها ومتدربيها والعملاء المرتبطين بها إلى الشركة الهدف، ثم حذف "${source.name}" نهائياً.\nاكتب الاسم الدقيق للشركة الهدف من هذه القائمة:\n${otherNames.join('، ')}`,
      {title:'دمج شركات مكررة', required:true, placeholder:'اكتب اسم الشركة الهدف بالضبط'}
    );
    if(targetName===null) return;
    const target = companies.find(x=>x.name===targetName.trim());
    if(!target){ showToast('لم يتم العثور على شركة بهذا الاسم بالضبط — تأكد من كتابته كما هو باللائحة'); return; }
    if(target.id===source.id){ showToast('لا يمكن دمج الشركة مع نفسها'); return; }
    const affectedTransfers = companyTransfers.filter(t=>t.companyId===source.id).length;
    const affectedClients = clients.filter(cl=>cl.clientType==='company' && cl.companyName===source.name).length;
    if(!await customConfirm(`تأكيد دمج "${source.name}" في "${target.name}"؟ سيتم نقل ${affectedTransfers} حوالة و${affectedClients} عميل، ثم حذف "${source.name}" نهائياً. هذا الإجراء لا يمكن التراجع عنه.`)) return;
    snapshotState(`دمج شركة: ${source.name} في ${target.name}`);
    let movedTransfers = 0;
    companyTransfers.forEach(t=>{ if(t.companyId===source.id){ t.companyId = target.id; t.companyName = target.name; movedTransfers++; } });
    let movedClients = 0;
    clients.forEach(cl=>{ if(cl.clientType==='company' && cl.companyName===source.name){ cl.companyName = target.name; movedClients++; } });
    // دمج الفئات المتفق عليها من الشركة المصدر إن لم تكن موجودة بنفس الاسم بالشركة الهدف مسبقاً
    if(source.categories && source.categories.length){
      target.categories = target.categories || [];
      source.categories.forEach(sc=>{
        if(!target.categories.some(tc=>tc.label===sc.label)) target.categories.push({label:sc.label, amount:sc.amount});
      });
    }
    companies = companies.filter(x=>x.id!==source.id);
    await saveCompanyTransfers();
    await saveClients();
    await saveCompanies();
    await logAudit('edit','تحويلات الشركات', `تم دمج الشركة "${source.name}" في "${target.name}" — نُقلت ${movedTransfers} حوالة و${movedClients} عميل، وحُذفت "${source.name}" نهائياً`);
    if(editingCompanyId===source.id) resetCompanyForm();
    renderCompanies(); renderTable();
    showToast(`تم الدمج بنجاح: ${movedTransfers} حوالة و${movedClients} عميل انتقلوا لـ"${target.name}"`);
    return;
  }
  if(e.target.dataset.editcompany){
    const id = e.target.dataset.editcompany;
    const c = companies.find(x=>x.id===id);
    if(!c){ showToast('تعذّر إيجاد الشركة'); return; }
    editingCompanyId = id;
    $('#cm-name').value = c.name || '';
    $('#cm-tax').value = c.taxNumber || '';
    $('#cm-amount').value = c.agreedAmount || '';
    cmCats = (c.categories||[]).map(cc=>({id:uid(), label:cc.label, amount:cc.amount}));
    renderCmCats();
    $('#btn-add-company').textContent = 'تحديث بيانات الشركة';
    $('#btn-cancel-edit-company').style.display = '';
    $('#cm-name').scrollIntoView({behavior:'smooth', block:'center'});
    showToast('عدّل البيانات ثم اضغط "تحديث بيانات الشركة"');
  }
});

/* ---------------- استيراد متدربين مجمّع لحوالة شركة (Excel) ---------------- */
$('#btn-template-trainees').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_متدربين_لحوالة_شركة.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'الاسم':'محمد أحمد', 'الجنسية':'Yemeni', 'المبلغ الإجمالي':980, 'شراء الحقيبة':'نعم'},
    {'رقم الهوية':'2345678901', 'الاسم':'', 'الجنسية':'', 'المبلغ الإجمالي':'', 'شراء الحقيبة':''}
  ]);
});
/* منطق مشترك لاستيراد مجمّع لمتدربين لحوالة شركة — يُستخدم من مصدر Excel أو من اللصق النصي المباشر.
   json: مصفوفة صفوف بنفس مفاتيح نموذج الاستيراد: 'رقم الهوية' (إلزامي)، 'المبلغ الإجمالي'، 'الاسم'، 'الجنسية'، 'شراء الحقيبة' */
async function importTraineeRowsIntoTransfer(t, json, snapshotLabel, auditLabel){
  const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
  const bagPrice = num(settings.bagPrice) || 0;
  const payChannel0 = settings.channels.find(ch=>ch.name===t.channel);
  const payDest0 = payChannel0 ? payChannel0.dest : 'bank';
  const payMethod0 = payChannel0 ? payChannel0.name : 'تحويل بنكي (شركة)';

  snapshotState(snapshotLabel);
  t.trainees = t.trainees || [];
  let added=0, skipped=0, postedCount=0, newClients=0, bagsIssuedFromStock=0;
  const changedRows = [];
  for(const row of json){
    const clientId = String(row['رقم الهوية']||'').trim();
    if(!clientId){ skipped++; continue; }
    if(t.trainees.some(x=>x.clientId===clientId)){ skipped++; continue; } // موجود مسبقاً في نفس الحوالة
    if(companyTransfers.some(tt=>tt.id!==t.id && (tt.trainees||[]).some(x=>x.clientId===clientId))){ skipped++; continue; } // موجود مسبقاً في حوالة شركة أخرى — لتجنّب التكرار

    const rawTotal = String(row['المبلغ الإجمالي']||'').trim();
    const total = rawTotal ? num(rawTotal) : share;
    const bagCell = String(row['شراء الحقيبة']||'').trim();
    const wantsBag = bagCell ? /^(نعم|ن|yes|y|1|true)$/i.test(bagCell) : !!t.bagForAll;
    const bagValue = wantsBag ? Math.min(bagPrice, total) : 0;
    const courseValue = Math.round((total-bagValue)*100)/100;
    if(courseValue<=0 && bagValue<=0){ skipped++; continue; }

    let client = clients.find(x=>x.clientId===clientId);
    const alreadyPostedElsewhere = !!(client && num(client.paid)>0);
    const traineeId = uid();
    let posted = false, skipReason = '';

    if(!client){
      // لا يوجد سجل عميل بهذا الرقم بعد — نُنشئ سجلاً كاملاً في شيت العملاء (عميل شركات) حتى يظهر عند الفلترة بالشركة
      client = {
        id: uid(), createdAt: Date.now(),
        clientId, name: String(row['الاسم']||'').trim() || `متدرب شركة (${clientId})`,
        phone:'', nationality: normalizeNationalityValue(row['الجنسية']),
        clientType:'company', companyName: t.companyName, creditDays:'',
        clientTaxNumber:'', courseType:'', courseNumber:'',
        referNum:'', invoice:'', bagInvoice:'',
        date: t.date || todayISO(),
        coursePrice: courseValue,
        bagSource: bagValue>0 ? 'stock' : 'own',
        bagPrice: bagValue,
        bagStatus: bagValue>0 ? 'purchased' : 'n/a',
        bagPurchaseDate: bagValue>0 ? (t.date||todayISO()) : undefined,
        discount: 0,
        paid: courseValue+bagValue,
        channel:payMethod0, networkInvoice:'',
        paid2:0, channel2:'', networkInvoice2:'',
        stage:'جديد', cancelled:false,
        notes: `أُضيف تلقائياً (استيراد مجمّع) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
      };
      clients.push(client);
      newClients++;
      if(bagValue>0){
        bagStock.push({
          id: uid(), type:'issue', qty:-1, unitPrice:0,
          date: client.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: client.id, issuedClientName: client.name,
          notes: `تسليم من المخزون للعميل: ${client.name} (استيراد مجمّع لحوالة الشركة "${t.companyName}")`
        });
        bagsIssuedFromStock++;
      }
    }else if(client.companyName!==t.companyName || client.clientType!=='company'){
      client.clientType = 'company';
      client.companyName = t.companyName;
    }

    if(!alreadyPostedElsewhere){
      const totalAmount = courseValue + bagValue;
      if(totalAmount>0){
        const existingTx = vaultTx.find(v => v.clientId===clientId && !v.companyTransferAllocId && Math.abs(num(v.amount)-totalAmount)<0.01);
        if(existingTx){
          existingTx.date = t.date || todayISO();
          existingTx.destination = payDest0;
          existingTx.method = payMethod0;
          existingTx.clientName = client ? client.name : existingTx.clientName;
          existingTx.notes = `ترحيل تلقائي (مطابقة رقم الهوية والقيمة مع حركة موجودة مسبقاً — استيراد مجمّع) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}${bagValue>0?' — يشمل قيمة الحقيبة':''}`;
          existingTx.companyTransferAllocId = traineeId;
        }else{
          vaultTx.push({
            id: uid(), seq: allocVaultSeq(), createdAt: Date.now(),
            type:'in', date: t.date || todayISO(), amount: totalAmount, destination:payDest0,
            clientId, clientName: client ? client.name : '', method:payMethod0,
            category:'', manual: client ? '' : `متدرب شركة: ${clientId}`,
            networkInvoice:'',
            notes: `ترحيل تلقائي (استيراد مجمّع) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}${bagValue>0?' — يشمل قيمة الحقيبة':''}`,
            companyTransferAllocId: traineeId
          });
        }
        posted = true; postedCount++;
      }
    }else{
      skipReason = 'مدفوع بالفعل عبر شيت العملاء — لم يُرحَّل';
    }

    t.trainees.push({id:traineeId, clientId, courseValue, bagValue, posted, skipReason});
    added++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':client?client.name:'', 'قيمة الدورة':courseValue, 'قيمة الحقيبة':bagValue, 'الإجمالي':courseValue+bagValue, 'حالة الترحيل':posted?'تم الترحيل':(skipReason||'لم يُرحَّل')});
  }
  if(bagsIssuedFromStock>0) recalcBagFundLedger();
  await saveClients();
  await saveVaultTx();
  if(bagsIssuedFromStock>0) await saveBagStock();
  await saveSettings();
  await saveCompanyTransfers();
  await logAudit('add','تحويلات الشركات', `${auditLabel} لحوالة الشركة "${t.companyName}": إضافة ${added} متدرب (${newClients} منهم عملاء جدد في شيت العملاء، وتم ترحيل ${postedCount} للبنك، و${bagsIssuedFromStock} حقيبة سُلِّمت من المخزون)${skipped?`، وتخطي ${skipped} صف`:''}`);
  renderCompanies(); renderVault(); renderTable(); renderBags();
  return {added, skipped, changedRows};
}

/* ---------------- استيراد متدربين على مستوى الشركة كاملة (Excel) — يوزَّع كل صف تلقائياً على أقرب حوالة لديها شواغر (حسب الأقدم أولاً) ---------------- */
async function importTraineeRowsIntoCompany(companyId, json){
  const company = companies.find(c=>c.id===companyId);
  if(!company) return {totalAdded:0, totalSkipped:json.length, overflowCount:0, error:'company-not-found'};
  const transfers = companyTransfers.filter(t=>t.companyId===companyId)
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')) || (a.createdAt||0)-(b.createdAt||0));
  if(!transfers.length) return {totalAdded:0, totalSkipped:json.length, overflowCount:0, error:'no-transfers'};

  // نوزّع كل صف على أول حوالة لديها شاغر (عدد متدربينها الحاليين أقل من العدد المستهدف)، وإلا فعلى أحدث حوالة كتجاوز
  const counts = transfers.map(t=>(t.trainees||[]).length);
  const buckets = transfers.map(()=>[]);
  let overflowCount = 0;
  json.forEach(row=>{
    let idx = transfers.findIndex((t,i)=> counts[i] < num(t.traineeCount));
    if(idx===-1){ idx = transfers.length-1; overflowCount++; }
    buckets[idx].push(row);
    counts[idx]++;
  });

  let totalAdded=0, totalSkipped=0;
  for(let i=0;i<transfers.length;i++){
    if(!buckets[i].length) continue;
    const t = transfers[i];
    const {added, skipped} = await importTraineeRowsIntoTransfer(
      t, buckets[i],
      `استيراد مجمّع لمتدربين لشركة "${company.name}" (حوالة بتاريخ ${t.date||'—'})`,
      `استيراد مجمّع على مستوى الشركة "${company.name}"`
    );
    totalAdded += added; totalSkipped += skipped;
  }
  return {totalAdded, totalSkipped, overflowCount};
}
$('#import-company-trainees-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file || !ctImportCompanyTargetId){ e.target.value=''; return; }
  const company = companies.find(c=>c.id===ctImportCompanyTargetId);
  if(!company){ showToast('تعذّر تحديد الشركة'); e.target.value=''; ctImportCompanyTargetId=null; return; }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const {totalAdded, totalSkipped, overflowCount, error} = await importTraineeRowsIntoCompany(company.id, json);
    if(error==='no-transfers'){ showToast('لا توجد حوالات مسجّلة لهذه الشركة'); }
    else showToast(`تم استيراد ${totalAdded} متدرب ووُزِّعوا تلقائياً على حوالات "${company.name}"${totalSkipped?`، وتخطي ${totalSkipped} صف (مكرّر أو ناقص البيانات)`:''}${overflowCount?`، منهم ${overflowCount} أُضيفوا كتجاوز لأحدث حوالة لأن كل الحوالات وصلت لعددها المستهدف`:''}`);
  }catch(err){
    showToast('تعذّر قراءة الملف — تأكد من الصيغة (نفس نموذج استيراد المتدربين)');
  }finally{
    e.target.value = '';
    ctImportCompanyTargetId = null;
  }
});

$('#import-trainees-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file || !ctImportTargetTransferId){ e.target.value=''; return; }
  const t = companyTransfers.find(x=>x.id===ctImportTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); e.target.value=''; return; }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const {added, skipped, changedRows} = await importTraineeRowsIntoTransfer(
      t, json,
      `استيراد متدربين مجمّع لحوالة الشركة: ${t.companyName}`,
      'استيراد مجمّع لمتدربين (Excel)'
    );
    if(changedRows.length) downloadXlsx(`تقرير_استيراد_متدربين_${stampNow()}.xlsx`, 'تقرير الاستيراد', changedRows);
    showToast(`تم استيراد ${added} متدرب${skipped?`، وتخطي ${skipped} صف (مكرر أو بدون رقم هوية/مبلغ)`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود عمود "رقم الهوية" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    ctImportTargetTransferId = null;
    e.target.value = '';
  }
});

/* ---------------- استيراد متدربين مجمّع لحوالة شركة (جدول خانات مستقلة، بلصق دعم من إكسل) ---------------- */
let ctitRowSeq = 0;
function ctitBagOptionsHtml(selected){
  return `<option value=""></option><option value="نعم"${selected==='نعم'?' selected':''}>نعم</option><option value="لا"${selected==='لا'?' selected':''}>لا</option>`;
}
function ctitRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="ctit-id" data-col="0" placeholder="رقم الهوية/الإقامة" style="min-width:100px;"></td>
    <td><input type="text" class="ctit-name" data-col="1" placeholder="اسم المتدرب" style="min-width:130px;"></td>
    <td><select class="ctit-nat" data-col="2" style="min-width:110px;">${natOptions}</select></td>
    <td><input type="number" step="0.01" class="ctit-amount" data-col="3" placeholder="نصيب افتراضي" style="min-width:100px;"></td>
    <td><select class="ctit-bag" data-col="4" style="min-width:100px;">${ctitBagOptionsHtml('')}</select></td>
    <td><button type="button" class="btn btn-danger btn-sm ctit-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCtitRow(){
  ctitRowSeq++;
  $('#ctit-table-body').insertAdjacentHTML('beforeend', ctitRowHtml(ctitRowSeq));
}
function openCtitModal(){
  $('#ctit-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCtitRow();
  $('#ctimporttext-overlay').classList.add('show'); SoundFX.open();
}
function closeCtitModal(){ $('#ctimporttext-overlay').classList.remove('show'); ctImportTextTargetTransferId=null; }
$('#ctit-cancel').addEventListener('click', closeCtitModal);
$('#ctimporttext-overlay').addEventListener('click', e=>{ if(e.target.id==='ctimporttext-overlay') closeCtitModal(); });
$('#btn-ctit-add-row').addEventListener('click', addCtitRow);
$('#ctit-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('ctit-remove-row')){
    const rows = $('#ctit-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة داخل جدول استيراد المتدربين، بنفس منطق جدول "إضافة عدة عملاء"
$('#ctit-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return; // لصق خلية واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#ctit-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCtitRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>4) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT'){
        if(field.classList.contains('ctit-bag')){
          const v = val.trim();
          field.value = /^(نعم|ن|yes|y|1|true)$/i.test(v) ? 'نعم' : (/^(لا|ل|no|n|0|false)$/i.test(v) ? 'لا' : '');
        }else setBulkSelectFuzzy(field, val);
      }else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-ctit-save').addEventListener('click', async ()=>{
  if(!ctImportTextTargetTransferId){ showToast('تعذّر تحديد الحوالة'); return; }
  const t = companyTransfers.find(x=>x.id===ctImportTextTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); return; }

  const rows = [...$('#ctit-table-body').querySelectorAll('tr')];
  const json = [];
  rows.forEach(row=>{
    const clientId = row.querySelector('.ctit-id').value.trim();
    if(!clientId) return; // صف فارغ يُتجاهل بصمت
    json.push({
      'رقم الهوية': clientId,
      'المبلغ الإجمالي': row.querySelector('.ctit-amount').value.trim(),
      'الاسم': row.querySelector('.ctit-name').value.trim(),
      'الجنسية': row.querySelector('.ctit-nat').value,
      'شراء الحقيبة': row.querySelector('.ctit-bag').value
    });
  });
  if(!json.length){ showToast('أدخل رقم هوية واحداً على الأقل'); return; }

  const {added, skipped} = await importTraineeRowsIntoTransfer(
    t, json,
    `استيراد متدربين (لصق نص) لحوالة الشركة: ${t.companyName}`,
    'استيراد مجمّع لمتدربين (لصق نص مباشرة)'
  );

  closeCtitModal();
  showToast(`تم استيراد ${added} متدرب${skipped?`، وتخطي ${skipped} صف (مكرر أو بدون رقم هوية/مبلغ)`:''}`);
});
/* صوت نقر خفيف موحّد لكل أزرار الحفظ/الإضافة الرئيسية والتبويبات، عبر تفويض حدث واحد بدل ربط كل زر يدوياً */
document.addEventListener('click', e=>{
  const btn = e.target.closest('.btn-primary, .btn-gold, .btn-danger');
  if(btn && !btn.disabled) SoundFX.click();
}, true);

/* ================= المشتريات (موردون + فواتير شراء) ================= */
const PURCHASE_TAX_RATE = 0.15; // ضريبة القيمة المضافة الثابتة على فواتير المشتريات
function purchaseMatchesFilters(p){
  const q = ($('#purchase-search')?.value||'').trim().toLowerCase();
  const supF = $('#purchase-supplier-filter')?.value||'';
  const statusF = $('#purchase-status-filter')?.value||'';
  const from = $('#purchase-date-from')?.value||'';
  const to = $('#purchase-date-to')?.value||'';
  if(supF && p.supplierId!==supF) return false;
  if(statusF && p.status!==statusF) return false;
  if(from && p.date < from) return false;
  if(to && p.date > to) return false;
  if(q){
    const itemsText = (p.items||[]).map(i=>i.name).join(' ').toLowerCase();
    const hay = [p.invoiceNo, p.supplierName, itemsText, p.notes].join(' ').toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}
function supplierTotalsMap(){
  const map = {};
  purchases.forEach(p=>{ map[p.supplierId] = (map[p.supplierId]||0) + num(p.total); });
  return map;
}
function renderPurchaseCards(){
  const now = new Date();
  const ym = now.toISOString().slice(0,7);
  const thisMonth = purchases.filter(p=>(p.date||'').slice(0,7)===ym).reduce((s,p)=>s+num(p.total),0);
  const unpaid = purchases.filter(p=>p.status==='unpaid');
  const unpaidTotal = unpaid.reduce((s,p)=>s+num(p.total),0);
  const allTotal = purchases.reduce((s,p)=>s+num(p.total),0);
  const el = $('#purchase-cards');
  if(!el) return;
  el.innerHTML = `
    <div class="card"><div class="k">مشتريات هذا الشهر</div><div class="v">${fmt(thisMonth)} ﷼</div></div>
    <div class="card"><div class="k">إجمالي المشتريات (كل الفترات)</div><div class="v">${fmt(allTotal)} ﷼</div></div>
    <div class="card"><div class="k">فواتير غير مدفوعة</div><div class="v">${unpaid.length}<span style="font-size:12px; color:var(--text-muted);"> (${fmt(unpaidTotal)} ﷼)</span></div></div>
    <div class="card"><div class="k">عدد الموردين</div><div class="v">${suppliers.length}</div></div>
  `;
}
function renderSuppliersTable(){
  const body = $('#suppliers-body');
  if(!body) return;
  const q = ($('#supplier-search')?.value||'').trim().toLowerCase();
  const totals = supplierTotalsMap();
  const rows = suppliers.filter(s=> !q || (s.name||'').toLowerCase().includes(q) || (s.phone||'').includes(q));
  body.innerHTML = rows.map(s=>`
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td class="mono">${escapeHtml(s.phone||'—')}</td>
      <td>${escapeHtml(s.category||'—')}</td>
      <td class="mono">${fmt(totals[s.id]||0)} ﷼</td>
      <td>${escapeHtml(s.notes||'—')}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-supplier="${s.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-supplier="${s.id}">حذف</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد موردون بعد</td></tr>`;
}
function populatePurchaseSupplierSelects(){
  const opts = suppliers.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const sel = $('#pu-supplier'); if(sel) sel.innerHTML = opts || '<option value="">أضف مورداً أولاً</option>';
  const filt = $('#purchase-supplier-filter');
  if(filt){ const cur = filt.value; filt.innerHTML = '<option value="">كل الموردين</option>' + opts; filt.value = cur; }
}
function renderPurchasesTable(){
  const body = $('#purchases-body');
  if(!body) return;
  const rows = purchases.filter(purchaseMatchesFilters).sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
  body.innerHTML = rows.map(p=>`
    <tr>
      <td class="mono">${escapeHtml(p.date||'—')}</td>
      <td>${escapeHtml(p.supplierName||'—')}</td>
      <td class="mono">${escapeHtml(p.invoiceNo||'—')}</td>
      <td>${p.attachment ? `<button class="btn btn-ghost btn-sm" data-view-attachment="${p.id}">📎 عرض</button>` : `<span style="color:var(--text-muted); font-size:12px;">—</span>`}</td>
      <td><button class="btn btn-ghost btn-sm" data-view-items="${p.id}">عرض (${(p.items||[]).length})</button></td>
      <td class="mono">${fmt(num(p.total))} ﷼</td>
      <td>${escapeHtml(p.method||'—')}</td>
      <td><span class="stamp ${p.status==='paid'?'paid':'owe'}">${p.status==='paid'?'مدفوعة':'غير مدفوعة'}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-purchase="${p.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-purchase="${p.id}">حذف</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مشتريات مطابقة</td></tr>`;
  const total = rows.reduce((s,p)=>s+num(p.total),0);
  const totalEl = $('#purchase-total'); if(totalEl) totalEl.textContent = `الإجمالي (حسب الفلتر): ${fmt(total)} ﷼`;
}
function renderPurchases(){
  if(!$('#view-purchases')) return;
  populatePurchaseSupplierSelects();
  renderPurchaseCards();
  renderSuppliersTable();
  renderPurchasesTable();
}

let editingSupplierId = null;
let editingPurchaseId = null;
let currentPurchaseAttachment = null;

function updatePurchaseAttachmentPreview(){
  const wrap = $('#pu-attachment-preview-wrap');
  const nameEl = $('#pu-attachment-name');
  if(!wrap) return;
  if(currentPurchaseAttachment){
    wrap.style.display = '';
    if(nameEl) nameEl.textContent = currentPurchaseAttachment.name || 'مرفق مرفوع';
  } else {
    wrap.style.display = 'none';
    if(nameEl) nameEl.textContent = '';
  }
}
function openAttachmentViewer(att){
  if(!att || !att.dataUrl){ showToast('لا يوجد مرفق لعرضه'); return; }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,33,.75); z-index:99999; display:flex; flex-direction:column; align-items:center; padding:18px; box-sizing:border-box;';
  const bar = document.createElement('div');
  bar.style.cssText = 'width:100%; max-width:900px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;';
  const label = document.createElement('span');
  label.style.cssText = 'color:#fff; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  label.textContent = att.name || 'مرفق الفاتورة';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px;';
  const dlBtn = document.createElement('a');
  dlBtn.textContent = '⬇ تحميل';
  dlBtn.href = att.dataUrl;
  dlBtn.download = att.name || 'مرفق';
  dlBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px; text-decoration:none;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ إغلاق';
  closeBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border:none; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  closeBtn.onclick = ()=> overlay.remove();
  actions.appendChild(dlBtn); actions.appendChild(closeBtn);
  bar.appendChild(label); bar.appendChild(actions);

  const frameWrap = document.createElement('div');
  frameWrap.style.cssText = 'width:100%; max-width:900px; flex:1; background:#fff; border-radius:10px; overflow:hidden;';
  if((att.type||'').startsWith('image/')){
    frameWrap.innerHTML = `<img src="${att.dataUrl}" style="width:100%; height:100%; object-fit:contain; display:block;">`;
  } else {
    frameWrap.innerHTML = `<iframe src="${att.dataUrl}" style="width:100%; height:100%; border:none;"></iframe>`;
  }

  overlay.appendChild(bar);
  overlay.appendChild(frameWrap);
  document.body.appendChild(overlay);
}
function openPurchaseItemsPopup(id){
  const p = purchases.find(x=>x.id===id);
  if(!p){ showToast('تعذر إيجاد فاتورة الشراء'); return; }
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const rowsHtml = (p.items||[]).map(it=>`
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td class="num">${fmt(num(it.qty))}</td>
      <td class="num">${fmt(num(it.price))}</td>
      <td class="num">${fmt(num(it.qty)*num(it.price))}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" style="text-align:center; color:#888;">لا توجد أصناف</td></tr>`;

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('بيان أصناف — فاتورة شراء ' + (p.invoiceNo||''), {accent: PRINT_PALETTE.navy, borderColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      <div class="inv-title">
        <h2>بيان أصناف فاتورة شراء</h2>
        <div class="no">${escapeHtml(p.invoiceNo || '—')}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">التاريخ: ${escapeHtml(formatDateDisplay(p.date)||p.date||'')}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات المورد</h4>
        <div class="info-row"><span>المورد:</span><b>${escapeHtml(p.supplierName||'—')}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(p.method||'—')}</b></div>
        <div class="info-row"><span>الحالة:</span><b>${p.status==='paid'?'مدفوعة':'غير مدفوعة'}</b></div>
      </div>
      <div class="info-box">
        <h4>ملاحظات</h4>
        <div class="info-row"><span></span><b>${escapeHtml(p.notes||'—')}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>الصنف</th><th style="text-align:left;">الكمية</th><th style="text-align:left;">سعر الوحدة</th><th style="text-align:left;">الإجمالي</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="totals">
      <div class="r"><span>الإجمالي قبل الضريبة</span><b class="mono">${fmt(num(p.subtotal))}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15%)</span><b class="mono">${fmt(num(p.taxAmount))}</b></div>
      <div class="r grand"><span>الإجمالي شامل الضريبة</span><b>${fmt(num(p.total))}</b></div>
    </div>

    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}

function addPurchaseItemRow(item){
  const wrap = $('#pu-items');
  if(!wrap) return;
  const row = document.createElement('div');
  row.className = 'formgrid pu-item-row';
  row.style.cssText = 'grid-template-columns:2fr 1fr 1fr auto; align-items:end; margin-bottom:6px;';
  row.innerHTML = `
    <div class="field"><label>الصنف</label><input type="text" class="pu-item-name" value="${escapeHtml(item?.name||'')}"></div>
    <div class="field"><label>الكمية</label><input type="number" step="0.01" min="0" class="pu-item-qty" value="${item?.qty ?? 1}"></div>
    <div class="field"><label>سعر الوحدة (بدون ضريبة)</label><input type="number" step="0.01" min="0" class="pu-item-price" value="${item?.price ?? 0}"></div>
    <button type="button" class="btn btn-danger btn-sm pu-item-remove" style="height:38px;">✕</button>
  `;
  wrap.appendChild(row);
  row.querySelectorAll('input').forEach(inp=> inp.addEventListener('input', updatePurchaseTotalDisplay));
  row.querySelector('.pu-item-remove').addEventListener('click', ()=>{ row.remove(); updatePurchaseTotalDisplay(); });
}
function updatePurchaseTotalDisplay(){
  let subtotal = 0;
  $all('#pu-items .pu-item-row').forEach(row=>{
    subtotal += num(row.querySelector('.pu-item-qty').value) * num(row.querySelector('.pu-item-price').value);
  });
  const tax = subtotal * PURCHASE_TAX_RATE;
  const total = subtotal + tax;
  const subEl = $('#pu-subtotal-display'); if(subEl) subEl.textContent = fmt(subtotal);
  const taxEl = $('#pu-tax-display'); if(taxEl) taxEl.textContent = fmt(tax);
  const totEl = $('#pu-total-display'); if(totEl) totEl.textContent = fmt(total);
}
function openPurchaseModal(id){
  editingPurchaseId = id || null;
  const p = id ? purchases.find(x=>x.id===id) : null;
  $('#purchase-modal-title').textContent = p ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة';
  $('#pu-items').innerHTML = '';
  if(!suppliers.length){ showToast('أضف مورداً أولاً قبل تسجيل فاتورة شراء'); return; }
  populatePurchaseSupplierSelects();
  populateSelect($('#pu-method'), settings.channels.map(c=>c.name), false);
  $('#pu-supplier').value = p?.supplierId || (suppliers[0]?.id||'');
  $('#pu-date').value = p?.date || todayISO();
  $('#pu-invoiceno').value = p?.invoiceNo || '';
  if(p?.method && settings.channels.some(c=>c.name===p.method)) $('#pu-method').value = p.method;
  $('#pu-status').value = p?.status || 'paid';
  $('#pu-notes').value = p?.notes || '';
  $('#pu-attachment').value = '';
  currentPurchaseAttachment = p?.attachment || null;
  updatePurchaseAttachmentPreview();
  if(p && p.items && p.items.length) p.items.forEach(it=> addPurchaseItemRow(it));
  else addPurchaseItemRow();
  updatePurchaseTotalDisplay();
  $('#purchase-overlay').classList.add('show');
}
$('#btn-add-item-row')?.addEventListener('click', ()=> addPurchaseItemRow());
$('#btn-add-purchase')?.addEventListener('click', ()=> openPurchaseModal(null));
$('#pu-cancel')?.addEventListener('click', ()=> $('#purchase-overlay').classList.remove('show'));

$('#pu-attachment')?.addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const nameOk = /\.(pdf|jpe?g|png|webp)$/i.test(file.name);
  const typeOk = ['application/pdf','image/jpeg','image/png','image/webp','image/jpg'].includes(file.type);
  if(!nameOk && !typeOk){
    showToast('صيغة الملف غير مدعومة — يُسمح فقط بـ PDF أو صورة');
    e.target.value = '';
    return;
  }
  if(file.size > 8*1024*1024){
    showToast('حجم الملف كبير جداً (الحد الأقصى 8 ميجابايت)');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ()=>{
    currentPurchaseAttachment = {name: file.name, type: file.type, dataUrl: reader.result};
    updatePurchaseAttachmentPreview();
  };
  reader.onerror = ()=> showToast('تعذرت قراءة الملف');
  reader.readAsDataURL(file);
});
$('#pu-attachment-remove')?.addEventListener('click', ()=>{
  currentPurchaseAttachment = null;
  $('#pu-attachment').value = '';
  updatePurchaseAttachmentPreview();
});
$('#pu-attachment-view')?.addEventListener('click', ()=> openAttachmentViewer(currentPurchaseAttachment));

$('#btn-add-supplier')?.addEventListener('click', ()=>{
  editingSupplierId = null;
  $('#supplier-modal-title').textContent = 'مورد جديد';
  $('#supplier-form').reset();
  $('#supplier-overlay').classList.add('show');
});
$('#sup-cancel')?.addEventListener('click', ()=> $('#supplier-overlay').classList.remove('show'));

$('#supplier-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const name = $('#sup-name').value.trim();
  if(!name){ showToast('أدخل اسم المورد'); return; }
  const phone = $('#sup-phone').value.trim();
  const category = $('#sup-category').value.trim();
  const notes = $('#sup-notes').value.trim();
  if(editingSupplierId){
    const s = suppliers.find(x=>x.id===editingSupplierId);
    if(s){
      Object.assign(s, {name, phone, category, notes});
      purchases.forEach(p=>{ if(p.supplierId===s.id) p.supplierName = name; });
      await logAudit('edit','المشتريات', `تعديل بيانات المورد: ${name}`);
      await savePurchases();
    }
  } else {
    suppliers.push({id: uid(), name, phone, category, notes, createdAt: Date.now()});
    await logAudit('add','المشتريات', `إضافة مورد جديد: ${name}`);
  }
  await saveSuppliers();
  $('#supplier-overlay').classList.remove('show');
  renderPurchases();
  showToast('تم حفظ بيانات المورد');
});

$('#purchase-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const supplierId = $('#pu-supplier').value;
  const supplier = suppliers.find(s=>s.id===supplierId);
  if(!supplier){ showToast('اختر مورداً صحيحاً'); return; }
  const items = [];
  $all('#pu-items .pu-item-row').forEach(row=>{
    const name = row.querySelector('.pu-item-name').value.trim();
    const qty = num(row.querySelector('.pu-item-qty').value);
    const price = num(row.querySelector('.pu-item-price').value);
    if(name) items.push({name, qty, price});
  });
  if(!items.length){ showToast('أضف صنفاً واحداً على الأقل'); return; }
  const subtotal = items.reduce((s,it)=>s+it.qty*it.price,0);
  const taxAmount = subtotal * PURCHASE_TAX_RATE;
  const total = subtotal + taxAmount;
  const date = $('#pu-date').value || todayISO();
  const method = $('#pu-method').value;
  const status = $('#pu-status').value;
  const invoiceNo = $('#pu-invoiceno').value.trim();
  const notes = $('#pu-notes').value.trim();

  const existing = editingPurchaseId ? purchases.find(x=>x.id===editingPurchaseId) : null;
  if(existing && existing.vaultTxId){
    vaultTx = vaultTx.filter(t=>t.id!==existing.vaultTxId);
  }

  let vaultTxId = '';
  if(status==='paid'){
    const chan = settings.channels.find(c=>c.name===method);
    const dest = chan ? (chan.dest==='other' ? 'vault' : chan.dest) : 'vault';
    vaultTxId = 'purchase_'+(existing?.id || uid());
    vaultTx.push({
      id: vaultTxId,
      seq: allocVaultSeq(),
      type: 'out',
      date,
      amount: total,
      destination: dest,
      clientId: '',
      clientName: '',
      method,
      category: 'مشتريات',
      manual: `فاتورة شراء من ${supplier.name}${invoiceNo?` — رقم ${invoiceNo}`:''}`,
      recipientName: supplier.name,
      referenceNo: invoiceNo,
      networkInvoice: dest==='network' ? invoiceNo : '',
      notes: notes || `مشتريات: ${items.map(i=>i.name).join('، ')} (شامل ضريبة ${fmt(taxAmount)} ﷼)`,
      createdAt: Date.now()
    });
  }

  if(existing){
    Object.assign(existing, {supplierId, supplierName: supplier.name, invoiceNo, date, items, subtotal, taxAmount, total, method, status, notes, vaultTxId, attachment: currentPurchaseAttachment});
    await logAudit('edit','المشتريات', `تعديل فاتورة شراء: ${invoiceNo||'—'} — ${supplier.name} (${fmt(total)} ﷼ شامل الضريبة)`);
  } else {
    const newPurchase = {id: uid(), supplierId, supplierName: supplier.name, invoiceNo, date, items, subtotal, taxAmount, total, method, status, notes, vaultTxId, attachment: currentPurchaseAttachment, createdAt: Date.now()};
    purchases.push(newPurchase);
    autoPostPurchase(newPurchase);
    await saveJournalDE();
    await logAudit('add','المشتريات', `فاتورة شراء جديدة: ${invoiceNo||'—'} — ${supplier.name} (${fmt(total)} ﷼ شامل الضريبة)`);
  }

  await savePurchases();
  await saveVaultTx();
  if(typeof renderVault==='function') renderVault();
  $('#purchase-overlay').classList.remove('show');
  renderPurchases();
  showToast('تم حفظ فاتورة الشراء');
});

$('#btn-export-purchases')?.addEventListener('click', ()=>{
  const rows = purchases.filter(purchaseMatchesFilters).map(p=>({
    'التاريخ': p.date, 'المورد': p.supplierName, 'رقم الفاتورة': p.invoiceNo,
    'الأصناف': (p.items||[]).map(i=>`${i.name} (${i.qty} × ${i.price})`).join(' | '),
    'الإجمالي قبل الضريبة': num(p.subtotal ?? (num(p.total)/(1+PURCHASE_TAX_RATE))),
    'الضريبة (15%)': num(p.taxAmount ?? (num(p.total) - num(p.total)/(1+PURCHASE_TAX_RATE))),
    'الإجمالي شامل الضريبة': num(p.total), 'طريقة الدفع': p.method, 'الحالة': p.status==='paid'?'مدفوعة':'غير مدفوعة',
    'ملاحظات': p.notes||''
  }));
  downloadXlsx(`مشتريات_${stampNow()}.xlsx`, 'المشتريات', rows);
});

$('#supplier-search')?.addEventListener('input', renderSuppliersTable);
['#purchase-search','#purchase-supplier-filter','#purchase-status-filter','#purchase-date-from','#purchase-date-to'].forEach(sel=>{
  $(sel)?.addEventListener('input', renderPurchasesTable);
  $(sel)?.addEventListener('change', renderPurchasesTable);
});

document.addEventListener('click', async e=>{
  const viewItems = e.target.closest('[data-view-items]');
  if(viewItems){ openPurchaseItemsPopup(viewItems.dataset.viewItems); return; }
  const viewAtt = e.target.closest('[data-view-attachment]');
  if(viewAtt){
    const p = purchases.find(x=>x.id===viewAtt.dataset.viewAttachment);
    if(p) openAttachmentViewer(p.attachment);
    return;
  }
  const editSup = e.target.closest('[data-edit-supplier]');
  if(editSup){
    const s = suppliers.find(x=>x.id===editSup.dataset.editSupplier);
    if(s){
      editingSupplierId = s.id;
      $('#supplier-modal-title').textContent = 'تعديل مورد';
      $('#sup-name').value = s.name||'';
      $('#sup-phone').value = s.phone||'';
      $('#sup-category').value = s.category||'';
      $('#sup-notes').value = s.notes||'';
      $('#supplier-overlay').classList.add('show');
    }
    return;
  }
  const delSup = e.target.closest('[data-del-supplier]');
  if(delSup){
    const id = delSup.dataset.delSupplier;
    const s = suppliers.find(x=>x.id===id);
    if(!s) return;
    const usedCount = purchases.filter(p=>p.supplierId===id).length;
    const msg = usedCount
      ? `هذا المورد لديه ${usedCount} فاتورة شراء مسجّلة. حذفه لن يحذف فواتيره لكنها ستبقى بلا مورد مرتبط. متابعة؟`
      : `حذف المورد "${s.name}"؟`;
    if(!await customConfirm(msg)) return;
    suppliers = suppliers.filter(x=>x.id!==id);
    await saveSuppliers();
    await logAudit('delete','المشتريات', `حذف المورد: ${s.name}`);
    renderPurchases();
    showToast('تم حذف المورد');
    return;
  }
  const editP = e.target.closest('[data-edit-purchase]');
  if(editP){ openPurchaseModal(editP.dataset.editPurchase); return; }
  const delP = e.target.closest('[data-del-purchase]');
  if(delP){
    const id = delP.dataset.delPurchase;
    const p = purchases.find(x=>x.id===id);
    if(!p) return;
    if(!await customConfirm(`حذف فاتورة الشراء رقم "${p.invoiceNo||'—'}" من ${p.supplierName}؟${p.vaultTxId ? ' سيتم أيضاً حذف حركة الخزنة المرتبطة بها.' : ''}`)) return;
    if(p.vaultTxId){
      vaultTx = vaultTx.filter(t=>t.id!==p.vaultTxId);
      await saveVaultTx();
      if(typeof renderVault==='function') renderVault();
    }
    purchases = purchases.filter(x=>x.id!==id);
    await savePurchases();
    await logAudit('delete','المشتريات', `حذف فاتورة شراء: ${p.invoiceNo||'—'} — ${p.supplierName}`);
    renderPurchases();
    showToast('تم حذف الفاتورة');
  }
});

async function startApp(){
  await loadData();
  await cleanupDuplicateCourseTypes();
  await cleanupDuplicateNationalities();
  await cleanupDuplicatePaymentMethods();
  initYearFilter();
  refreshFilterOptions();
  renderTable();
  renderDashboard();
  renderSettings();
  renderBags();
  renderCourses();
  renderCourseInvoices();
  renderVault();
  renderAuditLog();
  renderReports();
  renderCompanies();
  renderAccounting();
  renderPurchases();
  applyLanguage(currentLang);
  applyTheme(!!settings.darkMode); applySoundIcon();
  await maybeRunAutoBackup();
  autoSignInLocalUser();
  SoundFX.login();
}

/* ---------------- License gate: يجب التحقق من كود الترخيص قبل تشغيل أي جزء من البرنامج ---------------- */
function showLicenseScreen(errorMsg){
  $('#license-screen').style.display = 'flex';
  if(errorMsg){
    $('#license-error').textContent = errorMsg;
    $('#license-error').style.display = 'block';
  }
}

async function ensureServerLoginThenStart(){
  const saved = (()=>{ try{ return sessionStorage.getItem('serverAuthToken'); }catch(e){ return null; } })();
  if(saved){
    SERVER_AUTH_TOKEN = saved;
    try{
      const res = await fetch(API_BASE + '/api/storage/settings', { headers: { Authorization: 'Bearer ' + saved } });
      if(res.ok){
        try{
          SERVER_AUTH_USERNAME = sessionStorage.getItem('serverAuthUsername') || null;
          SERVER_AUTH_ROLE = normalizeRole(sessionStorage.getItem('serverAuthRole'));
        }catch(e){ SERVER_AUTH_ROLE = 'staff'; }
        $('#server-login-screen').style.display = 'none';
        await startApp();
        return;
      }
    }catch(e){}
    SERVER_AUTH_TOKEN = null;
    try{
      sessionStorage.removeItem('serverAuthToken');
      sessionStorage.removeItem('serverAuthUsername');
      sessionStorage.removeItem('serverAuthRole');
    }catch(e){}
  }
  showServerLoginScreen(null);
}
$('#server-login-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const uname = $('#server-login-user').value.trim();
  const upass = $('#server-login-pass').value;
  $('#server-login-error').style.display = 'none';
  if(btn) btn.disabled = true;
  try{
    await serverLogin(uname, upass);
    $('#server-login-screen').style.display = 'none';
    await startApp();
  }catch(err){
    $('#server-login-error').textContent = err.message || 'تعذّر تسجيل الدخول، تحقق من اسم المستخدم وكلمة المرور';
    $('#server-login-error').style.display = 'block';
  }finally{
    if(btn) btn.disabled = false;
  }
});

let LICENSE_EXPIRY_DATE = null; // تُستخدم في تنبيهات الداشبورد لتذكير المستخدم قبل انتهاء الترخيص
async function activateAndStart(encKeyRaw, expiryDate){
  ENC_KEY = await crypto.subtle.importKey('raw', base64ToBytes(encKeyRaw), {name:'AES-GCM'}, false, ['encrypt','decrypt']);
  if(expiryDate) LICENSE_EXPIRY_DATE = expiryDate;
  $('#license-screen').style.display = 'none';
  await ensureServerLoginThenStart();
}

$('#license-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const input = $('#license-key-input').value.trim();
  $('#license-error').style.display = 'none';
  if(btn) btn.disabled = true;
  try{
    const result = await validateLicenseKey(input);
    if(result.valid){
      const cleaned = input.replace(/[\s-]/g,'').toUpperCase();
      localStorage.setItem(LICENSE_STORAGE_KEY, cleaned);
      await activateAndStart(result.encKeyRaw, result.expiryDate);
    }else{
      $('#license-error').textContent = result.reason || 'كود الترخيص غير صالح';
      $('#license-error').style.display = 'block';
    }
  }finally{
    if(btn) btn.disabled = false;
  }
});

/* ================================================================
   الفوترة الضريبية والزكاة (ZATCA) — تبويب مستقل
   يجمع: فواتير المبيعات (تلقائي من فواتير الدورات + يدوي)، مردودات المبيعات،
   المشتريات، ملخص الإقرار الضريبي، وحساب الزكاة التقديري.
   ================================================================ */
let editingManualSalesId = null;

function formatManualSalesInvoiceNo(n){ return 'MSI-' + String(n).padStart(6,'0'); }

function zatcaSelectedRange(){
  const year = $('#zt-year')?.value || String(new Date().getFullYear());
  const period = $('#zt-period')?.value || 'year';
  const map = {
    year: [`${year}-01-01`, `${year}-12-31`],
    q1: [`${year}-01-01`, `${year}-03-31`],
    q2: [`${year}-04-01`, `${year}-06-30`],
    q3: [`${year}-07-01`, `${year}-09-30`],
    q4: [`${year}-10-01`, `${year}-12-31`],
  };
  const [from, to] = map[period] || map.year;
  return { year, period, from, to, asOf: to };
}
function populateZtYearSelect(){
  const sel = $('#zt-year');
  if(!sel) return;
  const years = typeof collectAllYears==='function' ? collectAllYears() : [String(new Date().getFullYear())];
  const thisYear = String(new Date().getFullYear());
  if(!years.includes(thisYear)) years.unshift(thisYear);
  const keep = sel.value;
  sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join('');
  sel.value = years.includes(keep) ? keep : years[0];
}

function buildZatcaSalesRows(from, to){
  const courseRows = (typeof courseInvoiceClients==='function' ? courseInvoiceClients() : []).filter(c=>{
    const d = c.receiptIssueDate || '';
    return num(c.receiptActualValue) > 0 && d && d>=from && d<=to;
  }).map(c=>({
    refId: c.id, source:'course', date: c.receiptIssueDate, name: c.name || '—',
    invoiceNo: c.invoice || '—', totalInclVat: num(c.receiptActualValue), vat: courseInvoiceVat(c.receiptActualValue)
  }));
  const manualRows = manualSalesInvoices.filter(m=> m.date && m.date>=from && m.date<=to).map(m=>({
    refId: m.id, source:'manual', date: m.date, name: m.name || '—',
    invoiceNo: formatManualSalesInvoiceNo(m.invoiceNo||0), totalInclVat: num(m.total), vat: num(m.total) - (num(m.total)/1.15)
  }));
  return courseRows.concat(manualRows).sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}
function buildZatcaReturnsRows(from, to){
  return vaultTx.filter(t=>t.type==='out' && t.isReturn && inRange(t.date, from, to))
    .map(t=>({ id:t.id, date:t.date, name:t.clientName||t.clientId||'—', amount:num(t.amount), vat: num(t.amount)-(num(t.amount)/1.15) }))
    .sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}
function buildZatcaPurchaseRows(from, to){
  return purchases.filter(p=> p.date && p.date>=from && p.date<=to)
    .map(p=>({id:p.id, date:p.date, supplierName:p.supplierName||'—', invoiceNo:p.invoiceNo||'—', total:num(p.total), vat:num(p.taxAmount)}))
    .sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
}

function renderZtSalesTable(from, to){
  const rows = buildZatcaSalesRows(from, to);
  $('#zt-sales-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td><span class="stamp ${r.source==='course'?'paid':'owe'}">${r.source==='course'?'فاتورة دورة':'يدوية'}</span></td>
      <td class="mono">${fmt(r.totalInclVat)}</td>
      <td class="mono">${fmt(r.vat)}</td>
      <td>
        ${r.source==='course'
          ? `<button class="btn btn-ghost btn-sm" data-zt-print-course="${r.refId}">طباعة</button>`
          : `<button class="btn btn-ghost btn-sm" data-zt-print-manual="${r.refId}">طباعة</button>
             <button class="btn btn-ghost btn-sm" data-zt-edit-manual="${r.refId}">تعديل</button>
             <button class="btn btn-danger btn-sm" data-zt-del-manual="${r.refId}">حذف</button>`}
      </td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مبيعات ضمن هذه الفترة</td></tr>`;
  const totalIncl = rows.reduce((s,r)=>s+r.totalInclVat,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-sales-total').textContent = `عدد الفواتير: ${rows.length} · الإجمالي شامل الضريبة: ${fmt(totalIncl)} ﷼ · إجمالي الضريبة: ${fmt(totalVat)} ﷼`;
}
function renderZtReturnsTable(from, to){
  const rows = buildZatcaReturnsRows(from, to);
  $('#zt-returns-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="mono">${fmt(r.amount)}</td>
      <td class="mono">${fmt(r.vat)}</td>
      <td><button class="btn btn-ghost btn-sm" data-zt-print-return="${r.id}">طباعة</button></td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد مردودات مبيعات ضمن هذه الفترة</td></tr>`;
  const totalAmount = rows.reduce((s,r)=>s+r.amount,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-returns-total').textContent = `عدد المردودات: ${rows.length} · الإجمالي: ${fmt(totalAmount)} ﷼ · الضريبة داخل المردود: ${fmt(totalVat)} ﷼`;
}
function renderZtPurchasesTable(from, to){
  const rows = buildZatcaPurchaseRows(from, to);
  $('#zt-purchases-body').innerHTML = rows.map(r=>`
    <tr>
      <td class="mono">${escapeHtml(r.date||'—')}</td>
      <td>${escapeHtml(r.supplierName)}</td>
      <td class="mono">${escapeHtml(r.invoiceNo)}</td>
      <td class="mono">${fmt(r.total)}</td>
      <td class="mono">${fmt(r.vat)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مشتريات ضمن هذه الفترة</td></tr>`;
  const totalIncl = rows.reduce((s,r)=>s+r.total,0);
  const totalVat = rows.reduce((s,r)=>s+r.vat,0);
  $('#zt-purchases-total').textContent = `عدد الفواتير: ${rows.length} · الإجمالي شامل الضريبة: ${fmt(totalIncl)} ﷼ · إجمالي الضريبة: ${fmt(totalVat)} ﷼`;
}
function buildZatcaVatReturn(from, to){
  const salesRows = buildZatcaSalesRows(from, to);
  const returnRows = buildZatcaReturnsRows(from, to);
  const purchaseRows = buildZatcaPurchaseRows(from, to);
  const salesGross = salesRows.reduce((s,r)=>s+r.totalInclVat,0);
  const outputVatGross = salesRows.reduce((s,r)=>s+r.vat,0);
  const returnsGross = returnRows.reduce((s,r)=>s+r.amount,0);
  const returnsVat = returnRows.reduce((s,r)=>s+r.vat,0);
  const outputVat = outputVatGross - returnsVat;
  const salesNet = (salesGross - outputVatGross) - (returnsGross - returnsVat);
  const purchasesGross = purchaseRows.reduce((s,r)=>s+r.total,0);
  const inputVat = purchaseRows.reduce((s,r)=>s+r.vat,0);
  const purchasesNet = purchasesGross - inputVat;
  const netVat = outputVat - inputVat;
  return { salesRows, returnRows, purchaseRows, salesGross, salesNet, outputVat, returnsGross, returnsVat, purchasesGross, purchasesNet, inputVat, netVat };
}
function renderZtVatTable(from, to){
  const table = $('#zt-vat-table');
  if(!table) return null;
  const r = buildZatcaVatReturn(from, to);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  table.innerHTML = `<tbody>
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المبيعات (ضريبة المخرجات) — ${r.salesRows.length} فاتورة</td></tr>
    ${row('إجمالي المبيعات شامل الضريبة', r.salesGross, {indent:true, muted:true})}
    ${row('يُخصم: مردودات مبيعات (شامل الضريبة)', -r.returnsGross, {indent:true, muted:true})}
    ${row('صافي ضريبة المخرجات', r.outputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px; font-weight:800; color:var(--navy);">المشتريات (ضريبة المدخلات) — ${r.purchaseRows.length} فاتورة</td></tr>
    ${row('إجمالي المشتريات شامل الضريبة', r.purchasesGross, {indent:true, muted:true})}
    ${row('إجمالي ضريبة المدخلات', r.inputVat, {bold:true})}
    <tr><td colspan="2" style="padding-top:14px;"></td></tr>
    ${row(r.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة (لصالحك)', Math.abs(r.netVat), {bold:true})}
  </tbody>`;
  return r;
}
/* جدول مطابقة صناديق نموذج الإقرار الرسمي في بوابة الهيئة (نفس ترتيب النموذج: مبيعات ثم مشتريات ثم صافي الضريبة) */
function renderZtVatBoxesTable(from, to){
  const table = $('#zt-vat-boxes-table');
  if(!table) return;
  const r = buildZatcaVatReturn(from, to);
  const head = `<thead><tr><th style="width:50px;">#</th><th>البيان</th><th style="text-align:left;">القيمة (بدون ضريبة)</th><th style="text-align:left;">الضريبة</th></tr></thead>`;
  const box = (n, label, value, vat, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:2px solid var(--navy);':''}">
    <td class="mono">${n}</td><td>${label}</td>
    <td class="mono" style="text-align:left;">${value===null?'—':fmt(value)}</td>
    <td class="mono" style="text-align:left;">${vat===null?'—':fmt(vat)}</td>
  </tr>`;
  table.innerHTML = `${head}<tbody>
    <tr><td colspan="4" style="padding-top:12px; font-weight:800; color:var(--navy);">المبيعات</td></tr>
    ${box('1', 'المبيعات المحلية الخاضعة للنسبة الأساسية (15%)', r.salesNet, r.outputVat)}
    ${box('2', 'المبيعات الخاضعة لآلية الاحتساب العكسي المحلي', 0, 0)}
    ${box('3', 'المبيعات المحلية الخاضعة لنسبة الصفر', 0, null)}
    ${box('4', 'الصادرات', 0, null)}
    ${box('5', 'المبيعات المعفاة', 0, null)}
    ${box('—', 'إجمالي المبيعات وضريبة المخرجات', r.salesNet, r.outputVat, {bold:true})}
    <tr><td colspan="4" style="padding-top:12px; font-weight:800; color:var(--navy);">المشتريات</td></tr>
    ${box('6', 'المشتريات المحلية الخاضعة للنسبة الأساسية (15%)', r.purchasesNet, r.inputVat)}
    ${box('7', 'الواردات الخاضعة للضريبة المدفوعة عند الجمارك', 0, 0)}
    ${box('8', 'الواردات الخاضعة للضريبة بموجب آلية الاحتساب العكسي', 0, 0)}
    ${box('9', 'المشتريات الخاضعة لنسبة الصفر', 0, null)}
    ${box('10', 'المشتريات المعفاة', 0, null)}
    ${box('—', 'إجمالي المشتريات وضريبة المدخلات', r.purchasesNet, r.inputVat, {bold:true})}
    <tr><td colspan="4" style="padding-top:12px;"></td></tr>
    ${box('11', r.netVat>=0 ? 'صافي ضريبة القيمة المضافة المستحقة للهيئة' : 'صافي ضريبة القيمة المضافة الدائنة (لصالحك)', null, Math.abs(r.netVat), {bold:true})}
  </tbody>`;
}

/* ---- الزكاة (تقديري): وعاء الزكاة ≈ حقوق الملكية + القروض طويلة الأجل − صافي الأصول الثابتة، مع تعديلات يدوية ---- */
function computeZakat(asOf, year){
  const bs = typeof buildBalanceSheet==='function' ? buildBalanceSheet(asOf) : {totalEquity:0, loans:0, fixedAssetsNet:0};
  const adj = zakatAdjustments[year] || {additions:0, deductions:0, rate:0.025, notes:''};
  const additions = num($('#zk-additions')?.value ?? adj.additions);
  const deductions = num($('#zk-deductions')?.value ?? adj.deductions);
  const rate = num($('#zk-rate')?.value ?? adj.rate) || 0.025;
  const base = Math.max(0, bs.totalEquity + Math.max(0,bs.loans) - Math.max(0, bs.fixedAssetsNet) + additions - deductions);
  const due = base * rate;
  return { bs, additions, deductions, rate, base, due };
}
function renderZtZakatTable(asOf, year){
  const adj = zakatAdjustments[year] || {additions:0, deductions:0, rate:0.025, notes:''};
  if($('#zk-additions') && !$('#zk-additions')._touched) $('#zk-additions').value = adj.additions || 0;
  if($('#zk-deductions') && !$('#zk-deductions')._touched) $('#zk-deductions').value = adj.deductions || 0;
  if($('#zk-rate')) $('#zk-rate').value = String(adj.rate || 0.025);
  if($('#zk-notes')) $('#zk-notes').value = adj.notes || '';
  const z = computeZakat(asOf, year);
  const row = (label, value, opts)=> `<tr style="${opts&&opts.bold?'font-weight:800; border-top:1px solid var(--border);':(opts&&opts.muted?'color:var(--text-muted);':'')}"><td style="${opts&&opts.indent?'padding-right:22px;':''}">${label}</td><td class="mono" style="text-align:left;">${fmt(value)}</td></tr>`;
  $('#zt-zakat-table').innerHTML = `<tbody>
    ${row('حقوق الملكية (كما بالميزانية العمومية)', z.bs.totalEquity, {indent:true, muted:true})}
    ${row('يُضاف: القروض طويلة الأجل', Math.max(0,z.bs.loans), {indent:true, muted:true})}
    ${row('يُخصم: صافي الأصول الثابتة', -Math.max(0,z.bs.fixedAssetsNet), {indent:true, muted:true})}
    ${row('يُضاف: إضافات يدوية أخرى', z.additions, {indent:true, muted:true})}
    ${row('يُخصم: خصومات يدوية أخرى', -z.deductions, {indent:true, muted:true})}
    ${row('وعاء الزكاة التقديري', z.base, {bold:true})}
    ${row(`الزكاة المستحقة (${(z.rate*100).toFixed(3)}%)`, z.due, {bold:true})}
  </tbody>`;
}

function renderZtSummaryCards(from, to, asOf, year){
  const vat = buildZatcaVatReturn(from, to);
  const zk = computeZakat(asOf, year);
  $('#zt-summary-cards').innerHTML = `
    <div class="card"><div class="k">مبيعات الفترة (شامل الضريبة)</div><div class="v teal">${fmt(vat.salesGross)}</div></div>
    <div class="card"><div class="k">ضريبة المخرجات (صافي)</div><div class="v">${fmt(vat.outputVat)}</div></div>
    <div class="card"><div class="k">مشتريات الفترة (شامل الضريبة)</div><div class="v">${fmt(vat.purchasesGross)}</div></div>
    <div class="card"><div class="k">ضريبة المدخلات</div><div class="v">${fmt(vat.inputVat)}</div></div>
    <div class="card"><div class="k">${vat.netVat>=0?'صافي الضريبة المستحقة':'صافي الضريبة الدائنة'}</div><div class="v ${vat.netVat>=0?'red':'gold'}">${fmt(Math.abs(vat.netVat))}</div></div>
    <div class="card"><div class="k">الزكاة التقديرية المستحقة</div><div class="v gold">${fmt(zk.due)}</div></div>
  `;
}

function renderZatca(){
  if(!$('#view-zatca')) return;
  refreshZatcaOnboardStatus();
  populateZtYearSelect();
  const { year, period, from, to, asOf } = zatcaSelectedRange();
  $('#zt-period-label').textContent = `الفترة المعروضة: من ${formatDateDisplay(from)} إلى ${formatDateDisplay(to)}`;
  renderZtSummaryCards(from, to, asOf, year);
  renderZtSalesTable(from, to);
  renderZtReturnsTable(from, to);
  renderZtPurchasesTable(from, to);
  renderZtVatTable(from, to);
  renderZtVatBoxesTable(from, to);
  renderZtZakatTable(asOf, year);
}
['#zt-year','#zt-period'].forEach(sel=> $(sel)?.addEventListener('change', renderZatca));
$('#zk-additions')?.addEventListener('input', function(){ this._touched = true; renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year); });
$('#zk-deductions')?.addEventListener('input', function(){ this._touched = true; renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year); });
$('#zk-rate')?.addEventListener('change', ()=> renderZtZakatTable(zatcaSelectedRange().asOf, zatcaSelectedRange().year));
$('#btn-save-zakat')?.addEventListener('click', async ()=>{
  const { year } = zatcaSelectedRange();
  zakatAdjustments[year] = {
    additions: num($('#zk-additions').value),
    deductions: num($('#zk-deductions').value),
    rate: num($('#zk-rate').value) || 0.025,
    notes: $('#zk-notes').value.trim()
  };
  await saveZakatAdjustments();
  await logAudit('edit','الفوترة الضريبية والزكاة', `تم حفظ تعديلات وعاء الزكاة لسنة ${year}`);
  showToast('تم حفظ تعديلات الزكاة لهذه السنة');
  if($('#zk-additions')) $('#zk-additions')._touched = false;
  if($('#zk-deductions')) $('#zk-deductions')._touched = false;
});
$('#btn-goto-purchases')?.addEventListener('click', ()=> $('[data-view="purchases"]')?.click());

/* ---- الربط الفعلي مع منصة فاتورة (المرحلة الثانية): تحميل الحالة + التسجيل ---- */
async function refreshZatcaOnboardStatus(){
  const box = $('#zt-onboard-status');
  if(!box) return;
  try{
    const res = await serverFetch('/api/zatca/status?environment=sandbox');
    if(!res.ok){ box.innerHTML = '⚠️ تعذّر جلب حالة الربط'; return; }
    const s = await res.json();
    if(!s.onboarded){
      box.innerHTML = '⚪ لم يتم التسجيل بعد — عبّي البيانات وأدخل رمز OTP من بوابة فاتورة (Sandbox).';
      $('#zt-onboard-form-wrap').style.display = '';
      $('#zt-onboard-production-wrap').style.display = 'none';
    }else if(!s.hasProductionCsid){
      box.innerHTML = `🧪 تم التسجيل والحصول على شهادة الامتثال (${escapeHtml(s.vatName||'')} — ${escapeHtml(s.vatNumber||'')}) — بانتظار شهادة الإنتاج.`;
      $('#zt-onboard-form-wrap').style.display = 'none';
      $('#zt-onboard-production-wrap').style.display = '';
      if(s.complianceRequestId) _lastZatcaComplianceRequestId = s.complianceRequestId;
    }else{
      box.innerHTML = `✅ الربط مفعّل بالكامل (${escapeHtml(s.vatName||'')} — ${escapeHtml(s.vatNumber||'')}) — الفواتير تُرسل فعلياً عند الطباعة.`;
      $('#zt-onboard-form-wrap').style.display = 'none';
      $('#zt-onboard-production-wrap').style.display = 'none';
    }
  }catch(e){ box.innerHTML = '⚠️ تعذّر جلب حالة الربط'; }
}
let _lastZatcaComplianceRequestId = null;
$('#btn-zatca-onboard')?.addEventListener('click', async ()=>{
  const otp = $('#zo-otp').value.trim();
  const vatName = $('#zo-vatname').value.trim();
  const vatNumber = $('#zo-vatnumber').value.trim();
  if(!otp || !vatName || !vatNumber){ showToast('عبّي الاسم والرقم الضريبي وOTP على الأقل'); return; }
  const btn = $('#btn-zatca-onboard'); btn.disabled = true; btn.textContent = 'جارٍ التسجيل…';
  try{
    const res = await serverFetch('/api/zatca/onboard', { method:'POST', body: JSON.stringify({
      environment: 'sandbox', otp,
      orgProfile: {
        vatName, vatNumber, crnNumber: $('#zo-crn').value.trim(),
        city: $('#zo-city').value.trim(), citySubdivision: $('#zo-subdivision').value.trim(),
        street: $('#zo-street').value.trim(), postalZone: $('#zo-postal').value.trim(),
        branchName: $('#zo-branchname').value.trim(), branchIndustry: $('#zo-branchindustry').value.trim(),
      }
    })});
    const data = await res.json();
    if(!res.ok) throw new Error(data.detail || data.error || 'فشل التسجيل');
    _lastZatcaComplianceRequestId = data.complianceRequestId;
    showToast('تم التسجيل والحصول على شهادة الامتثال بنجاح ✅');
    await logAudit('edit','الفوترة الضريبية والزكاة', 'تم تسجيل EGS والحصول على شهادة امتثال من هيئة فاتورة (Sandbox)');
    await refreshZatcaOnboardStatus();
  }catch(e){
    showToast('فشل التسجيل: ' + (e.message||'خطأ غير معروف'));
  }finally{ btn.disabled = false; btn.textContent = 'تسجيل والحصول على شهادة الامتثال'; }
});
$('#btn-zatca-production')?.addEventListener('click', async ()=>{
  if(!_lastZatcaComplianceRequestId){ showToast('لا يوجد رقم طلب امتثال محفوظ في هذه الجلسة — أعد تسجيل الدخول وحاول مجدداً بعد الطباعة التجريبية'); return; }
  const btn = $('#btn-zatca-production'); btn.disabled = true; btn.textContent = 'جارٍ الطلب…';
  try{
    const res = await serverFetch('/api/zatca/production-csid', { method:'POST', body: JSON.stringify({
      environment: 'sandbox', complianceRequestId: _lastZatcaComplianceRequestId
    })});
    const data = await res.json();
    if(!res.ok) throw new Error(data.detail || data.error || 'فشل الطلب');
    showToast('تم تفعيل الإرسال الفعلي الكامل ✅');
    await logAudit('edit','الفوترة الضريبية والزكاة', 'تم الحصول على شهادة الإنتاج (PCSID) — الإرسال الفعلي مفعّل الآن');
    await refreshZatcaOnboardStatus();
  }catch(e){
    showToast('فشل الطلب: ' + (e.message||'خطأ غير معروف'));
  }finally{ btn.disabled = false; btn.textContent = 'طلب شهادة الإنتاج (PCSID)'; }
});

/* ---- فاتورة مبيعات يدوية: نموذج إضافة/تعديل ---- */
$('#btn-add-manual-sales')?.addEventListener('click', ()=>{
  editingManualSalesId = null;
  $('#manualsales-modal-title').textContent = 'فاتورة مبيعات يدوية جديدة';
  $('#ms-name').value = ''; $('#ms-clientid').value = ''; $('#ms-clienttax').value = '';
  $('#ms-desc').value = ''; $('#ms-date').value = (typeof todayISO==='function' ? todayISO() : new Date().toISOString().slice(0,10));
  $('#ms-total').value = ''; $('#ms-notes').value = '';
  $('#manualsales-overlay').classList.add('show');
});
$('#ms-cancel')?.addEventListener('click', ()=> $('#manualsales-overlay').classList.remove('show'));
$('#ms-save')?.addEventListener('click', async ()=>{
  const total = num($('#ms-total').value);
  const date = $('#ms-date').value;
  if(!date){ showToast('الرجاء اختيار تاريخ الفاتورة'); return; }
  if(total<=0){ showToast('الرجاء إدخال إجمالي صحيح للفاتورة'); return; }
  if(editingManualSalesId){
    const m = manualSalesInvoices.find(x=>x.id===editingManualSalesId);
    if(m){
      Object.assign(m, {
        name: $('#ms-name').value.trim(), clientId: $('#ms-clientid').value.trim(),
        clientTax: $('#ms-clienttax').value.trim(), description: $('#ms-desc').value.trim(),
        date, total, notes: $('#ms-notes').value.trim()
      });
    }
    await logAudit('edit','الفوترة الضريبية والزكاة', `تم تعديل فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(m?.invoiceNo||0)}`);
  } else {
    const invoiceNo = settings.nextManualSalesInvoiceNo || 1;
    settings.nextManualSalesInvoiceNo = invoiceNo + 1;
    await saveSettings();
    const newSale = {
      id: uid(), invoiceNo,
      name: $('#ms-name').value.trim(), clientId: $('#ms-clientid').value.trim(),
      clientTax: $('#ms-clienttax').value.trim(), description: $('#ms-desc').value.trim(),
      date, total, notes: $('#ms-notes').value.trim(), createdAt: Date.now()
    };
    manualSalesInvoices.push(newSale);
    autoPostManualSale(newSale);
    await saveJournalDE();
    await logAudit('add','الفوترة الضريبية والزكاة', `تمت إضافة فاتورة مبيعات يدوية رقم ${formatManualSalesInvoiceNo(invoiceNo)}`);
  }
  await saveManualSalesInvoices();
  $('#manualsales-overlay').classList.remove('show');
  showToast('تم حفظ فاتورة المبيعات');
  renderZatca();
});
document.getElementById('zt-sales-body')?.addEventListener('click', async (e)=>{
  const printC = e.target.closest('[data-zt-print-course]');
  const printM = e.target.closest('[data-zt-print-manual]');
  const editM = e.target.closest('[data-zt-edit-manual]');
  const delM = e.target.closest('[data-zt-del-manual]');
  if(printC){ await printInvoice(printC.dataset.ztPrintCourse); return; }
  if(printM){ await printManualSalesInvoice(printM.dataset.ztPrintManual); return; }
  if(editM){
    const m = manualSalesInvoices.find(x=>x.id===editM.dataset.ztEditManual);
    if(!m) return;
    editingManualSalesId = m.id;
    $('#manualsales-modal-title').textContent = 'تعديل فاتورة مبيعات يدوية';
    $('#ms-name').value = m.name||''; $('#ms-clientid').value = m.clientId||''; $('#ms-clienttax').value = m.clientTax||'';
    $('#ms-desc').value = m.description||''; $('#ms-date').value = m.date||''; $('#ms-total').value = m.total||'';
    $('#ms-notes').value = m.notes||'';
    $('#manualsales-overlay').classList.add('show');
    return;
  }
  if(delM){
    const id = delM.dataset.ztDelManual;
    if(!(await customConfirm('هل تريد حذف فاتورة المبيعات اليدوية هذه؟ لا يمكن التراجع عن هذا الإجراء.'))) return;
    manualSalesInvoices = manualSalesInvoices.filter(x=>x.id!==id);
    await saveManualSalesInvoices();
    await logAudit('delete','الفوترة الضريبية والزكاة', 'تم حذف فاتورة مبيعات يدوية');
    showToast('تم حذف الفاتورة');
    renderZatca();
  }
});
document.getElementById('zt-returns-body')?.addEventListener('click', async (e)=>{
  const btn = e.target.closest('[data-zt-print-return]');
  if(btn) await printReturnInvoice(btn.dataset.ztPrintReturn);
});

/* يطبع فاتورة مبيعات يدوية بنفس تنسيق الفواتير الضريبية مع رمز QR متوافق مع الفوترة الإلكترونية المبسّطة */
async function printManualSalesInvoice(id){
  const m = manualSalesInvoices.find(x=>x.id===id);
  if(!m){ showToast('تعذر إيجاد بيانات الفاتورة'); return; }
  const invNoLabel = formatManualSalesInvoiceNo(m.invoiceNo||0);
  await logAudit('edit','الفوترة الضريبية والزكاة', `تمت طباعة فاتورة مبيعات يدوية رقم ${invNoLabel}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const totalInclVat = num(m.total);
  const vat = totalInclVat - (totalInclVat/1.15);
  const net = totalInclVat - vat;
  const today = new Date().toLocaleDateString('ar-SA');

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('فاتورة ' + invNoLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      ${zatcaInvoiceQrTag(ci, totalInclVat, vat, m.date || today)}
      <div class="inv-title">
        <h2>فاتورة ضريبية مبسّطة</h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الإصدار: ${escapeHtml(m.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل</h4>
        <div class="info-row"><span>الاسم:</span><b>${escapeHtml(m.name||'—')}</b></div>
        ${m.clientId ? `<div class="info-row"><span>رقم الهوية / السجل التجاري:</span><b>${escapeHtml(m.clientId)}</b></div>` : ''}
        ${m.clientTax ? `<div class="info-row"><span>الرقم الضريبي للعميل:</span><b>${escapeHtml(m.clientTax)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات الفاتورة</h4>
        <div class="info-row"><span>البيان:</span><b>${escapeHtml(m.description||'—')}</b></div>
        <div class="info-row"><span>ملاحظات:</span><b>${escapeHtml(m.notes||'—')}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>البيان</th><th style="text-align:left;">المبلغ (ر.س)</th></tr></thead>
      <tbody><tr><td>${escapeHtml(m.description||'مبيعات')}</td><td class="num">${fmt(net)}</td></tr></tbody>
    </table>

    <div class="totals">
      <div class="r"><span>القيمة الفعلية (بدون ضريبة القيمة المضافة)</span><b class="mono">${fmt(net)}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15% مضمنة ضمن الإجمالي)</span><b class="mono">${fmt(vat)}</b></div>
      <div class="r grand"><span>الإجمالي (شامل الضريبة)</span><b>${fmt(totalInclVat)}</b></div>
    </div>
    <div style="margin:14px 0 22px; padding:12px 14px; border:1px solid #DDE3EA; border-radius:8px; background:#F7F9FB; font-size:12.5px; text-align:center;">
      <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(totalInclVat))}
    </div>

    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
  renderZatca();
}

/* ---- تصدير الإقرار الكامل (مبيعات + مردودات + مشتريات + ملخص + زكاة) إلى Excel ---- */
$('#btn-export-zatca')?.addEventListener('click', ()=>{
  const { year, from, to, asOf } = zatcaSelectedRange();
  const vat = buildZatcaVatReturn(from, to);
  const zk = computeZakat(asOf, year);
  const summaryRows = [
    {'البند':'إجمالي المبيعات شامل الضريبة', 'القيمة':vat.salesGross},
    {'البند':'مردودات المبيعات شامل الضريبة', 'القيمة':vat.returnsGross},
    {'البند':'صافي ضريبة المخرجات', 'القيمة':vat.outputVat},
    {'البند':'إجمالي المشتريات شامل الضريبة', 'القيمة':vat.purchasesGross},
    {'البند':'إجمالي ضريبة المدخلات', 'القيمة':vat.inputVat},
    {'البند': vat.netVat>=0 ? 'صافي الضريبة المستحقة للهيئة' : 'صافي الضريبة الدائنة', 'القيمة':Math.abs(vat.netVat)},
    {'البند':'وعاء الزكاة التقديري', 'القيمة':zk.base},
    {'البند':`الزكاة المستحقة (${(zk.rate*100).toFixed(3)}%)`, 'القيمة':zk.due},
  ];
  const salesDetail = vat.salesRows.map(r=>({'التاريخ':r.date||'', 'العميل':r.name||'', 'رقم الفاتورة':r.invoiceNo||'', 'المصدر': r.source==='course'?'فاتورة دورة':'يدوية', 'الإجمالي شامل الضريبة':r.totalInclVat, 'الضريبة':r.vat}));
  const returnsDetail = vat.returnRows.map(r=>({'التاريخ':r.date||'', 'العميل':r.name||'', 'المبلغ':r.amount, 'الضريبة':r.vat}));
  const purchasesDetail = vat.purchaseRows.map(r=>({'التاريخ':r.date||'', 'المورد':r.supplierName||'', 'رقم الفاتورة':r.invoiceNo||'', 'الإجمالي شامل الضريبة':r.total, 'الضريبة':r.vat}));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'الملخص');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesDetail), 'فواتير المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(returnsDetail), 'مردودات المبيعات');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(purchasesDetail), 'المشتريات');
  XLSX.writeFile(wb, `الإقرار_الضريبي_والزكاة_${from}_${to}.xlsx`);
});

/* ---------------- قائمة "العملاء" المنسدلة لأنواع الدورات ----------------
   تظهر بجانب زر "العملاء" في القائمة الجانبية وتسرد أنواع الدورات المعرَّفة في الإعدادات (settings.courses)؛
   الضغط على أي نوع دورة ينقل لتبويب العملاء مباشرة ويطبّق فلتر "نوع الدورة" على هذا النوع تحديداً. */
const clientsFlyoutWrap = $('#nav-clients-flyout');
const clientsCaretBtn = $('#btn-clients-courses-toggle');
const clientsCourseSubmenu = $('#clients-courses-submenu');

function closeClientsCourseSubmenu(){
  clientsCourseSubmenu?.classList.remove('show');
  clientsFlyoutWrap?.classList.remove('open');
  clientsCaretBtn?.setAttribute('aria-expanded','false');
}
function renderClientsCourseSubmenu(){
  if(!clientsCourseSubmenu) return;
  const courses = settings.courses || [];
  let html = `<button type="button" data-course-filter="">كل الدورات</button>`;
  if(courses.length){
    html += courses.map(c=>`<button type="button" data-course-filter="${escapeHtml(c.name)}">${escapeHtml(c.name)}</button>`).join('');
  } else {
    html += `<div class="nav-submenu-empty">لا توجد أنواع دورات معرَّفة بعد</div>`;
  }
  clientsCourseSubmenu.innerHTML = html;
}
clientsCaretBtn?.addEventListener('click', (e)=>{
  e.stopPropagation();
  const wasOpen = clientsCourseSubmenu?.classList.contains('show');
  closeClientsCourseSubmenu();
  if(!wasOpen){
    renderClientsCourseSubmenu();
    clientsCourseSubmenu.classList.add('show');
    clientsFlyoutWrap.classList.add('open');
    clientsCaretBtn.setAttribute('aria-expanded','true');
  }
});
clientsCourseSubmenu?.addEventListener('click', (e)=>{
  const btn = e.target.closest('[data-course-filter]');
  if(!btn) return;
  const courseName = btn.dataset.courseFilter;
  document.querySelector('nav.tabs button[data-view="clients"]')?.click();
  const sel = $('#filter-course');
  if(sel) sel.value = courseName;
  renderTable();
  closeClientsCourseSubmenu();
});
document.addEventListener('click', (e)=>{
  if(clientsCourseSubmenu?.classList.contains('show') && !clientsFlyoutWrap.contains(e.target)) closeClientsCourseSubmenu();
});
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeClientsCourseSubmenu(); });

(async function bootWithLicense(){
  try{
    if(!(window.crypto && window.crypto.subtle)){
      // بيئة لا تدعم Web Crypto: نشغّل البرنامج بدون تشفير بدل تعطيله بالكامل
      $('#license-screen').style.display = 'none';
      await ensureServerLoginThenStart();
      return;
    }
    const storedKey = localStorage.getItem(LICENSE_STORAGE_KEY);
    if(storedKey){
      const result = await validateLicenseKey(storedKey);
      if(result.valid){
        await activateAndStart(result.encKeyRaw, result.expiryDate);
        return;
      }
      showLicenseScreen(result.reason);
      return;
    }
    showLicenseScreen(null);
  }catch(e){
    showLicenseScreen('حدث خطأ غير متوقع أثناء التحقق من الترخيص');
  }
})();

