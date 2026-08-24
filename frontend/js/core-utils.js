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
const $ = s => document.querySelector(s);
const $all = s => document.querySelectorAll(s);

/* ------------------------------------------------------------
   منع الضغط المزدوج على أزرار الحفظ/الإرسال غير المتزامنة، وإظهار
   حالة تحميل واضحة (spinner داخل الزر) أثناء التنفيذ. لا يغيّر أي
   منطق — فقط يعطّل الزر مؤقتاً ويعيده لحالته بعد انتهاء العملية.
   الاستخدام: withBtnLoading(btnEl, async () => { ... })
   ------------------------------------------------------------ */
async function withBtnLoading(btn, fn){
  if(!btn) return fn();
  if(btn.classList.contains('is-loading')) return; // منع الضغط المزدوج
  btn.classList.add('is-loading');
  btn.disabled = true;
  try{
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

// ضبط تلقائي للمسافة اللي تلزق عندها القائمة الجانبية (nav.tabs) أسفل الهيدر (header.top)،
// عشان لما تعمل سكرول ميدخلوش في بعض. ارتفاع الهيدر مش ثابت (بيتغيّر حسب quickstats ولفّ
// الأزرار على الشاشات الضيقة)، فبنقيسه فعليًا ونحدّث متغيّر CSS --sidebar-sticky-top بيه.
(function initHeaderSidebarSpacing(){
  function updateSidebarStickyTop(){
    const header = document.querySelector('header.top');
    if(!header) return;
    const cs = getComputedStyle(header);
    const headerTop = parseFloat(cs.top) || 12;      // top: 12px بتاعة الهيدر نفسه
    const marginBottom = parseFloat(cs.marginBottom) || 14;
    const gap = 12; // مسافة فاصلة إضافية بين تحت الهيدر وأول عنصر في القائمة الجانبية
    const total = headerTop + header.offsetHeight + marginBottom + gap;
    document.documentElement.style.setProperty('--sidebar-sticky-top', total + 'px');
  }
  if(typeof ResizeObserver !== 'undefined'){
    const ro = new ResizeObserver(updateSidebarStickyTop);
    document.addEventListener('DOMContentLoaded', () => {
      const header = document.querySelector('header.top');
      if(header) ro.observe(header);
      updateSidebarStickyTop();
    });
  } else {
    window.addEventListener('load', updateSidebarStickyTop);
  }
  window.addEventListener('resize', updateSidebarStickyTop);
  window.addEventListener('load', updateSidebarStickyTop);
  document.addEventListener('DOMContentLoaded', updateSidebarStickyTop);
})();
// هل تبويب معيّن (مثال: 'reports', 'accounting', 'vault') ظاهر فعلاً على الشاشة الآن؟ نستخدمها
// لتجنّب حساب/رسم شاشات كاملة (وأحياناً على كل بيانات البرنامج) وهي مقفولة أصلاً — بما أن كل تبويب
// أصلاً يُعاد رسمه من جديد لحظة فتحه (انظر معالج نقر button[data-view] فى ui-framework.js)، فلا داعي
// لتكرار نفس الحساب كل مرة يُحفظ فيها أي شيء فى أي مكان آخر بالبرنامج بينما هذا التبويب مقفول.
function isViewActive(viewName){
  const el = document.getElementById('view-' + viewName);
  return !!(el && el.classList.contains('active'));
}

const LICENSE_STORAGE_KEY = "appLicenseKeyV1";
// نسخة محلية مخبّأة من آخر تفعيل ناجح (مفتاح التشفير + تاريخ الانتهاء)، تُستخدم فقط
// عند تعذّر الوصول للسيرفر (انقطاع إنترنت) لتشغيل البرنامج بدل حجبه بالكامل، بشرط
// ألا يكون تاريخ انتهاء الترخيص قد مضى فعلياً حسب آخر تحقق ناجح كان معروفاً.
const LICENSE_CACHE_KEY = "appLicenseCacheV1";
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

/* بصمة الجهاز — تُشتق حياً فى كل مرة من خصائص العتاد والمتصفح الفعلية (نوع المعالج/الذاكرة/دقة
   الشاشة/توقيع Canvas وWebGL...)، وليست قيمة تُقرأ من أي تخزين محلي (localStorage/IndexedDB) —
   فمسح كاش المتصفح لا يغيّرها إطلاقاً طالما نفس الجهاز والمتصفح نفسه. تُرسَل للسيرفر مع كل تحقق
   من كود الترخيص (راجع validateLicenseKey أسفل) ليقارنها بالبصمة المرتبطة أصلاً بالترخيص. تُحسب
   مرة واحدة فقط لكل جلسة تشغيل (مخبّأة فى متغيّر بالذاكرة فقط، تُعاد حسابها من الصفر عند أي فتح
   جديد للتطبيق) لتفادي إعادة حساب Canvas/WebGL فى كل استدعاء.
   ملاحظة: هذه بصمة "متصفح تقريبية" وليست MAC Address حقيقياً — المتصفح لا يسمح لأي موقع بقراءة
   عنوان MAC الفعلي للجهاز إطلاقاً (قيد أمني ثابت فى كل المتصفحات)، فهذه أقرب بديل عملي متاح. */
let _deviceFingerprintCache = null;
async function getDeviceFingerprint(){
  if(_deviceFingerprintCache) return _deviceFingerprintCache;
  try{
    const parts = [];
    parts.push(navigator.userAgent || '');
    parts.push(navigator.language || '');
    parts.push(String(navigator.hardwareConcurrency || ''));
    parts.push(String(navigator.deviceMemory || ''));
    parts.push(String(screen.width) + 'x' + String(screen.height) + 'x' + String(screen.colorDepth));
    try{ parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); }catch(e){}
    try{
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('FTC2-device-fp', 2, 2);
      parts.push(canvas.toDataURL());
    }catch(e){}
    try{
      const canvas2 = document.createElement('canvas');
      const gl = canvas2.getContext('webgl') || canvas2.getContext('experimental-webgl');
      if(gl){
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if(dbg){
          parts.push(String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''));
          parts.push(String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''));
        }
      }
    }catch(e){}
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('||')));
    _deviceFingerprintCache = bytesToBase64(new Uint8Array(digest));
  }catch(e){
    _deviceFingerprintCache = 'fp-unavailable';
  }
  return _deviceFingerprintCache;
}

/* يستدعي مسار التحقق على السيرفر بدل حساب أي شيء محلياً. يرجع نفس شكل
   النتيجة المستخدم سابقاً في باقي الكود (valid/reason/clientId/expiryDate/expired)
   بالإضافة إلى encKeyRaw (base64) عند النجاح، ليتم استيرادها كـ CryptoKey. */
async function validateLicenseKey(rawKey){
  try{
    const deviceFingerprint = await getDeviceFingerprint();
    const res = await fetch(API_BASE + '/api/license/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: rawKey, deviceFingerprint }),
    });
    let data = null;
    try{ data = await res.json(); }catch(e){ data = null; }
    // فشل اتصال فعلي بالسيرفر (لا رد صالح إطلاقاً) — نميّزه عن رفض صريح من
    // السيرفر لصلاحية الكود، حتى يمكن لاحقاً الرجوع لآخر تفعيل ناجح محفوظ محلياً
    // بدل إجبار المستخدم على إعادة إدخال الكود لمجرد انقطاع الإنترنت مؤقتاً.
    if(!res.ok || !data) return { valid:false, networkError:true, reason:'تعذّر الاتصال بالسيرفر للتحقق من الترخيص' };
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
    return { valid:false, networkError:true, reason:'تعذّر الاتصال بالسيرفر للتحقق من الترخيص — تفاصيل تقنية: ' + (e && e.message ? e.message : String(e)) };
  }
}

// ضغط نص باستخدام CompressionStream المدمج في المتصفح (متاح في Chrome/Firefox/Safari الحديثة).
// يُقلّل حجم البيانات المرسلة للسيرفر بنسبة 85-92%، وبالتالي يُسرّع الحفظ بشكل كبير جداً.
// يرجع Uint8Array عند النجاح، أو null لو المتصفح لا يدعم CompressionStream (fallback لـ ENC1).
async function _compressToBytes(str) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch (e) { return null; }
}
// فك ضغط مصفوفة بايت مضغوطة بـ gzip → نص أصلي.
async function _decompressBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return new TextDecoder().decode(out);
}

// ENC2: = مضغوط (gzip) ثم مشفّر (AES-256-GCM) — أسرع بكثير للبيانات الكبيرة.
// ENC1: = مشفّر فقط بدون ضغط — يُستخدم fallback لو CompressionStream غير متاح، ولا يزال
//          مدعوماً للقراءة للتوافق مع البيانات القديمة المحفوظة قبل هذا التحديث.
async function encryptValue(plaintext){
  if(!ENC_KEY) return plaintext;
  try{
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // محاولة ضغط قبل التشفير (ENC2) — يُقلّل الحجم المُرسَل 85-92%
    const compressed = await _compressToBytes(plaintext);
    if (compressed) {
      const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, ENC_KEY, compressed);
      const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
      combined.set(iv, 0); combined.set(new Uint8Array(cipherBuf), iv.length);
      return 'ENC2:' + bytesToBase64(combined);
    }
    // fallback: ENC1 بدون ضغط (للمتصفحات القديمة جداً التي لا تدعم CompressionStream)
    const data = new TextEncoder().encode(plaintext);
    const cipherBuf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, ENC_KEY, data);
    const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
    combined.set(iv,0); combined.set(new Uint8Array(cipherBuf), iv.length);
    return 'ENC1:' + bytesToBase64(combined);
  }catch(e){ return plaintext; }
}
async function decryptValue(stored){
  if(typeof stored !== 'string') return stored;
  const isV2 = stored.startsWith('ENC2:');
  const isV1 = stored.startsWith('ENC1:');
  if(!isV2 && !isV1) return stored; // بيانات قديمة أو غير مشفّرة (توافق للخلف)
  if(!ENC_KEY) throw new Error('مفتاح التشفير غير متاح بعد');
  const bytes = base64ToBytes(stored.slice(5));
  const iv = bytes.slice(0,12);
  const data = bytes.slice(12);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, ENC_KEY, data);
  if (isV2) {
    // ENC2: فك الضغط بعد فك التشفير
    return await _decompressBytes(new Uint8Array(plainBuf));
  }
  // ENC1: لا يوجد ضغط — فك التشفير مباشرة
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
/* هروب أحرف HTML — معرّفة هنا (الملف الأول المحمّل) بدل clients-pagination-filters.js لأن
   backup-restore.js وملفات أخرى تستدعيها قبل تحميل ذلك الملف، وكان ذلك يرمي ReferenceError */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
/* معدل ضريبة القيمة المضافة المركزي — كل حسابات الضريبة في النظام (فواتير الدورات، المبيعات
   اليدوية، المشتريات، إقرارات ضريبة القيمة المضافة، بيانات ZATCA) تستخدم هذا الثابت فقط،
   حتى لا يتشتت المعدل بين عدة قيم حرفية (0.15 / ÷1.15) يصعب تحديثها أو عرضة للتناقض.
   المبالغ المخزّنة في النظام شاملة الضريبة أصلاً، لذلك تُستخرج الضريبة من داخل المبلغ وليس
   تُضاف فوقه (راجع تعليقات module-invoices.js). */
const VAT_RATE = 0.15;
// تقريب مالي موحّد لأقرب هللة (خانتين عشريتين) — يُستخدم في كل نقطة تُخزَّن فيها قيمة مالية
// ناتجة عن قسمة/طرح (وليس مُدخلة مباشرة من المستخدم)، لمنع تسرّب كسور الفاصلة العائمة
// (مثل 45.699999999999996) إلى القيود المحاسبية المخزَّنة فعلياً في journalDE. كانت هذه
// الكسور تُقرَّب فقط عند التصدير/العرض في بعض الشاشات، فتبقى مخزَّنة بدقة زائدة في الدفاتر
// نفسها — أرقام لا تُطابق ما هو مطبوع فعلياً على الفاتورة أو الإيصال.
function roundMoney(n){ return Math.round((num(n) + Number.EPSILON) * 100) / 100; }
// يستخرج مبلغ الضريبة من إجمالي شامل الضريبة (gross ÷ 1.15): vat = gross - gross/(1+rate)
// مُقرَّب دائماً لأقرب هللة — القيمة نفسها التي تُطبع على المستندات الرسمية (ZATCA/الفواتير)
function vatFromGross(g){ const v = num(g); return roundMoney(v - (v/(1+VAT_RATE))); }
// يستخرج صافي المبلغ (بدون الضريبة) من إجمالي شامل الضريبة
function netFromGross(g){ return roundMoney(num(g)/(1+VAT_RATE)); }
const _kvVersions = {}; // آخر نسخة (version) معروفة لكل مفتاح، لمنع الكتابة فوق تعديل شخص آخر بصمت

// كاش محلي دائم للقيم المُشفَّرة كما وصلت من السيرفر، مربوط برقم النسخة.
// الهدف: لو نفس الجهاز فتح البرنامج تاني ونسخة البيانات على السيرفر لم تتغيّر،
// نستخدم النسخة المخزّنة محلياً بدل إعادة تحميل نفس البيانات (ممكن تكون مئات
// الكيلوبايتات لمفاتيح زي قوائم العملاء وحركات الخزنة) من الصفر في كل مرة.
//
// يستخدم IndexedDB بدل localStorage: مساحة تخزين أكبر بكثير (localStorage محدود
// عملياً بحوالي 5-10 ميجا لكل موقع وقد يمتلئ بسرعة مع آلاف العملاء والمرفقات)،
// وقراءة/كتابة غير متزامنة لا تُجمّد الواجهة أثناء تحويل نصوص JSON الكبيرة.
// أي بيانات كانت محفوظة سابقاً بـ localStorage (نسخة قديمة من البرنامج) تُنقَل
// تلقائياً إلى IndexedDB أول مرة تُقرأ، ثم تُحذف من localStorage. لو IndexedDB
// غير متاح لأي سبب (متصفح قديم/وضع خاص يمنعه)، نرجع تلقائياً لـ localStorage
// كخط رجعة آمن حتى لا يتعطل البرنامج.
const KV_CACHE_PREFIX = 'ftc2-kv-cache:';
const KV_IDB_NAME = 'ftc2-kv-cache-db';
const KV_IDB_STORE = 'kv';
// مخزن ثانٍ (نفس قاعدة IndexedDB) للتعديلات التي لم تُرفع للسيرفر بعد — يُستخدَم فقط
// عند العمل بدون اتصال إنترنت، حتى لا تُفقد أي بيانات أُدخلت أثناء انقطاع الشبكة.
const KV_IDB_PENDING_STORE = 'pending';
// مخزن ثالث (نفس قاعدة IndexedDB): تعديلات فردية معلّقة لم تُرفع للسيرفر بعد فى نظام "السجلات
// المستقلة" (عميل واحد أو سطر واحد من أي شيت — الخزنة/المخزون/المشتريات...)، بخلاف KV_IDB_PENDING_STORE
// أعلاه المخصَّص فقط للمفاتيح الكاملة القديمة (settings, clients كخط رجعة...). المفتاح المركّب
// "collection::id" (ckey) يمنع تصادم نفس الـid بين تصنيفين مختلفين (مثال: عميل ومصروف بنفس id عرضاً).
// سبب وجود هذا المخزن: قبل إضافته، أي فشل رفع فردي (انقطاع نت لحظي، rate limit، إغلاق الصفحة أثناء
// الحفظ) كان بيضيع نهائياً بمجرد أي ريفرش لاحق — راجع flushPendingRecordWrites فى storage-sync.js.
const RECORD_PENDING_STORE = 'pendingRecords';
// عدّاد متزامن (بلا await) لإجمالي عدد التعديلات فى طابوري IndexedDB (kv + records) معاً — يُحدَّث
// فور اكتمال أي إضافة/حذف/مسح فعلي فى أي منهما (راجع _refreshPendingQueueSyncCount أدناه، ومواضع
// استدعائها فى نهاية _pendingWrite/_pendingDelete/_pendingRecordPut/_pendingRecordDelete/
// _pendingClearAll/_pendingRecordClearAll). الغرض الوحيد منه: تمكين beforeunload فى storage-sync.js
// من التحذير عند إغلاق الصفحة وفى الطابور تعديلات لم تُرفع بعد — حتى لو لم يوجد طلب شبكة "طائر"
// فعلياً فى هذه اللحظة بالذات، لأن beforeunload لا يمكنه انتظار أي قراءة IndexedDB (غير متزامنة)
// وقت الإغلاق نفسه، فنعتمد بدلاً من ذلك على قيمة محدَّثة مسبقاً فى الذاكرة (فارق التحديث ملّي ثوانٍ
// فقط منذ آخر تعديل فعلي، غير ملحوظ عملياً، ولا يشكّل أي خطر إضافي مقارنة بعدم وجود أي تحذير إطلاقاً).
let _pendingQueueSyncCount = 0;
async function _refreshPendingQueueSyncCount(){
  try{
    const [kvCount, recCount] = await Promise.all([
      (typeof _pendingCount==='function') ? _pendingCount() : Promise.resolve(0),
      _pendingRecordCount(),
    ]);
    _pendingQueueSyncCount = (kvCount||0) + (recCount||0);
  }catch(e){ /* نترك القيمة القديمة كما هى عند أي فشل غير متوقع — أفضل من تصفيرها خطأً */ }
}
let _kvIdbPromise = null;
function _openKvIdb(){
  if(_kvIdbPromise) return _kvIdbPromise;
  _kvIdbPromise = new Promise((resolve)=>{
    try{
      if(!window.indexedDB){ resolve(null); return; }
      const req = indexedDB.open(KV_IDB_NAME, 3);
      req.onupgradeneeded = ()=>{
        try{ if(!req.result.objectStoreNames.contains(KV_IDB_STORE)) req.result.createObjectStore(KV_IDB_STORE, { keyPath: 'key' }); }catch(e){ console.error('[Core] IDB createObjectStore kv failed:', e); }
        try{ if(!req.result.objectStoreNames.contains(KV_IDB_PENDING_STORE)) req.result.createObjectStore(KV_IDB_PENDING_STORE, { keyPath: 'key' }); }catch(e){ console.error('[Core] IDB createObjectStore pending failed:', e); }
        try{ if(!req.result.objectStoreNames.contains(RECORD_PENDING_STORE)) req.result.createObjectStore(RECORD_PENDING_STORE, { keyPath: 'ckey' }); }catch(e){ console.error('[Core] IDB createObjectStore pendingRecords failed:', e); }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> resolve(null); // فشل الفتح — سنستخدم localStorage كخط رجعة
    }catch(e){ resolve(null); }
  });
  return _kvIdbPromise;
}
// يخزّن/يحدّث تعديلاً فردياً معلّقاً. payload لعملية upsert: { op:'upsert', enc, clientId? }،
// ولعملية حذف: { op:'delete' }. قيد واحد فقط لكل (collection,id) — آخر تعديل معلّق فقط يهمّ.
function _recordCkey(collection, id){ return collection + '::' + id; }
async function _pendingRecordPut(collection, id, payload){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(RECORD_PENDING_STORE, 'readwrite');
        tx.objectStore(RECORD_PENDING_STORE).put(Object.assign({ ckey: _recordCkey(collection,id), collection, id, queuedAt: Date.now() }, payload));
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[Core] _pendingRecordPut failed:', e); }
  _refreshPendingQueueSyncCount();
}
async function _pendingRecordDelete(collection, id){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(RECORD_PENDING_STORE, 'readwrite');
        tx.objectStore(RECORD_PENDING_STORE).delete(_recordCkey(collection,id));
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[Core] _pendingRecordDelete failed:', e); }
  _refreshPendingQueueSyncCount();
}
async function _pendingRecordReadAll(){
  try{
    const db = await _openKvIdb();
    if(!db) return [];
    return await new Promise((resolve)=>{
      try{
        const tx = db.transaction(RECORD_PENDING_STORE, 'readonly');
        const req = tx.objectStore(RECORD_PENDING_STORE).getAll();
        req.onsuccess = ()=> resolve(req.result || []);
        req.onerror = ()=> resolve([]);
      }catch(e){ resolve([]); }
    });
  }catch(e){ return []; }
}
// يمسح طابور التعديلات المعلّقة بالكامل (عملية واحدة) — يُستخدم بعد "مسح كامل للسيرفر" أثناء
// الاستعادة: أي تعديلات قديمة كانت معلّقة قبل الاستعادة لم تعد صالحة إطلاقاً بعد استبدال كل
// البيانات، فإبقاؤها يعني إعادة رفعها لاحقاً فوق بيانات النسخة المستعادة وفسادها.
async function _pendingRecordClearAll(){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(RECORD_PENDING_STORE, 'readwrite');
        tx.objectStore(RECORD_PENDING_STORE).clear();
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[Core] _pendingRecordClearAll failed:', e); }
  _refreshPendingQueueSyncCount();
}
async function _pendingRecordCount(){
  try{ return (await _pendingRecordReadAll()).length; }catch(e){ return 0; }
}
// يمسح طابور التعديلات المعلّقة القديمة (مخزن kv) بالكامل — يُستخدم مع _pendingRecordClearAll
// أثناء "إعادة ضبط المصنع" حتى لا تُرفع أي تعديلات قديمة معلّقة فوق البيانات الممسوحة لاحقاً.
async function _pendingClearAll(){
  try{
    const db = await _openKvIdb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(KV_IDB_PENDING_STORE, 'readwrite');
        tx.objectStore(KV_IDB_PENDING_STORE).clear();
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> resolve();
      }catch(e){ resolve(); }
    });
  }catch(e){ console.error('[Core] _pendingClearAll failed:', e); }
  _refreshPendingQueueSyncCount();
}
async function _kvCacheRead(key){
  try{
    const db = await _openKvIdb();
    if(db){
      const fromIdb = await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readonly');
          const req = tx.objectStore(KV_IDB_STORE).get(key);
          req.onsuccess = ()=> resolve(req.result || null);
          req.onerror = ()=> resolve(null);
        }catch(e){ resolve(null); }
      });
      if(fromIdb) return { version: fromIdb.version, value: fromIdb.value };
      // لا شيء في IndexedDB — تحقّق من وجود نسخة قديمة بـ localStorage وانقلها مرة واحدة
      const legacy = _kvCacheReadLegacyLS(key);
      if(legacy){ _kvCacheWrite(key, legacy.version, legacy.value).catch((e)=>{ console.error('[Core] Failed to migrate legacy cache to IDB:', e); }); try{ localStorage.removeItem(KV_CACHE_PREFIX + key); }catch(e){ console.error('[Core] Failed to remove legacy LS cache:', e); } return legacy; }
      return null;
    }
    return _kvCacheReadLegacyLS(key);
  }catch(e){ return null; }
}
function _kvCacheReadLegacyLS(key){
  try{
    const raw = localStorage.getItem(KV_CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
// تُرجِع true عند نجاح الكتابة وfalse عند فشلها (IndexedDB معطّل/امتلاء مساحة/خطأ معاملة) — كان
// الفشل يُبتلع بصمت سابقاً فتُصبح القراءة التالية من كاش قديم تُظهر بيانات قديمة وكأنها الحقيقة،
// بل وتُقارَن أرقام نسخها بالسيرفر بشكل خاطئ. المتصلون الحاليون يتجاهلون القيمة الراجعة فلا يتأثرون.
async function _kvCacheWrite(key, version, value){
  try{
    const db = await _openKvIdb();
    if(db){
      return await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readwrite');
          tx.objectStore(KV_IDB_STORE).put({ key, version, value });
          tx.oncomplete = ()=> resolve(true);
          tx.onerror = ()=>{ console.error('[Core] IDB write tx error:', key); resolve(false); };
        }catch(e){ console.error('[Core] IDB write exception:', key, e); resolve(false); }
      });
    }
    try{ localStorage.setItem(KV_CACHE_PREFIX + key, JSON.stringify({ version, value })); return true; }
    catch(e){ console.error('[Core] LS cache write failed:', key, e); return false; }
  }catch(e){ console.error('[Core] _kvCacheWrite failed:', e); return false; }
}
async function _kvCacheDelete(key){
  try{
    const db = await _openKvIdb();
    if(db){
      await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readwrite');
          tx.objectStore(KV_IDB_STORE).delete(key);
          tx.oncomplete = ()=> resolve();
          tx.onerror = ()=> resolve();
        }catch(e){ resolve(); }
      });
    }
  }catch(e){ console.error('[Core] _kvCacheDelete IDB failed:', e); }
  try{ localStorage.removeItem(KV_CACHE_PREFIX + key); }catch(e){ console.error('[Core] _kvCacheDelete LS failed:', e); }
}
// يمسح كامل كاش kv (مخزن 'kv' في IndexedDB + أي بقايا بنفس البادئة في localStorage) — دون أي مساس
// بمخازن "التعديلات المعلّقة" (pending / pendingRecords) لأنها قد تحوي تعديلات محلية لم تُرفع للسيرفر
// بعد ويجب ألا تضيع. يُستخدم بعد استعادة نسخة احتياطية كاملة (راجع restoreFullBackup)، حتى لا يبقى
// في الكاش المحلي أي أثر للبيانات القديمة التي استُبدلت — فلو تُرك، كان أي فتح تالٍ من الكاش يُظهر
// البيانات القديمة وكأنها ما زالت موجودة، وقد تُبنى تعديلات لاحقة فوقها بشكل خاطئ.
async function _kvCacheClearKv(){
  try{
    const db = await _openKvIdb();
    if(db){
      await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readwrite');
          tx.objectStore(KV_IDB_STORE).clear();
          tx.oncomplete = ()=> resolve(true);
          tx.onerror = ()=>{ console.error('[Core] _kvCacheClearKv tx error'); resolve(false); };
        }catch(e){ console.error('[Core] _kvCacheClearKv exception:', e); resolve(false); }
      });
    }
    const keys = [];
    try{ for(let i=0;i<localStorage.length;i++){ const k = localStorage.key(i); if(k && k.startsWith(KV_CACHE_PREFIX)) keys.push(k); } }catch(e){}
    keys.forEach(k=>{ try{ localStorage.removeItem(k); }catch(e){} });
  }catch(e){ console.error('[Core] _kvCacheClearKv failed:', e); }
}

/* ============================================================================
   لقطات محلية مشفّرة لحالة التصنيفات المخزّنة كسجلات مستقلة (collection_records /
   client_records) — تُخزَّن في نفس مخزن kv في IndexedDB لكن بمفاتيح خاصة.
   الهدف: في وضع الفتح السريع (cacheOnly) نعرض آخر بيانات مؤكدة + الـ baseline وأرقام
   النسخ الصحيحة بدل شاشة فارغة (كانت الفارغة تُبنى عليها تعديلات تُكتب لاحقاً فوق
   البيانات الحقيقية — مسار فقدان البيانات الأصلي عند الغلق والفتح). تُحدَّث اللقطة
   عند كل تحميل كامل ناجح وبعد كل حفظ ناجح (مؤجَّل قليلاً لتجنّب تشفير التصنيف كاملاً
   عند كل حفظ سطر واحد).
   ============================================================================ */
const RECORDS_SNAP_PREFIX = 'recordsSnap::';
const CLIENTS_SNAP_PREFIX = 'clientRecordsSnap::';

async function _recordsSnapWrite(key, list, baselinePairs, versionPairs, metaPairs){
  try{
    const payload = JSON.stringify({ t: 1, list, baselinePairs, versionPairs, metaPairs: metaPairs || [], savedAt: Date.now() });
    const enc = await encryptValue(payload);
    return await _kvCacheWrite(key, 0, enc);
  }catch(e){ console.error('[Core] _recordsSnapWrite failed:', key, e); return false; }
}
// يرجع كائن اللقطة { list, baselinePairs, versionPairs } أو null عند عدم وجودها/تلفها
async function _recordsSnapRead(key){
  try{
    const cached = await _kvCacheRead(key);
    if(!cached || cached.value === null || cached.value === undefined) return null;
    const plain = await decryptValue(cached.value);
    const obj = JSON.parse(plain);
    if(!obj || obj.t !== 1 || !Array.isArray(obj.list)) return null;
    if(!Array.isArray(obj.baselinePairs)) obj.baselinePairs = [];
    if(!Array.isArray(obj.versionPairs)) obj.versionPairs = [];
    return obj;
  }catch(e){ console.error('[Core] _recordsSnapRead failed:', key, e); return null; }
}
async function _recordsSnapDelete(key){
  try{ await _kvCacheDelete(key); }catch(e){ console.error('[Core] _recordsSnapDelete failed:', key, e); }
}
// يمسح كل لقطات التصنيفات (لا يمسّ بيانات kv العادية ولا طوابير المعلّقات) — يُستخدم عند
// اكتمال استعادة كاملة موثوقة قبل إعادة فتح البرنامج، حتى لا تبقى لقطة قديمة تُعرض لاحقاً.
async function _recordsSnapClearAll(){
  const keys = [];
  try{
    const db = await _openKvIdb();
    if(db){
      await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readonly');
          const req = tx.objectStore(KV_IDB_STORE).openCursor();
          req.onsuccess = (e)=>{
            const cur = e.target.result;
            if(cur){
              const k = String(cur.key);
              if(k.startsWith(RECORDS_SNAP_PREFIX) || k.startsWith(CLIENTS_SNAP_PREFIX)) keys.push(cur.key);
              cur.continue();
            }
          };
          req.onerror = ()=> resolve();
          tx.oncomplete = ()=> resolve();
        }catch(e){ resolve(); }
      });
    }
  }catch(e){ console.error('[Core] _recordsSnapClearAll cursor failed:', e); }
  for(const k of keys) await _kvCacheDelete(k);
  try{
    const lsKeys = [];
    for(let i=0;i<localStorage.length;i++){ const k = localStorage.key(i); if(k && (k.startsWith(KV_CACHE_PREFIX + RECORDS_SNAP_PREFIX) || k.startsWith(KV_CACHE_PREFIX + CLIENTS_SNAP_PREFIX))) lsKeys.push(k); }
    lsKeys.forEach(k=>{ try{ localStorage.removeItem(k); }catch(e){} });
  }catch(e){}
}

/* ============================================================================
   توسيم خلايا الجداول تلقائياً (data-label) لعرض بطاقات الموبايل
   الجداول (.table-scroll) بتتحول لبطاقات رأسية على الشاشات الصغيرة (CSS)، وكل
   خلية بتحتاج data-label عشان القارئ يعرف كل رقم بيمثل عمود إيه. جزء من الجداول
   في الكود عنده data-label متحط يدوياً بالفعل (وده اللي بيتحترم زي ما هو من غير
   أي تعديل)، والباقي بياخد التسمية تلقائياً من نص رأس العمود (thead th) هنا، عشان
   ما يبقاش محتاج نمر على كل دالة render* في كل موديول ونضيفها يدوياً فى كل <td>. */
function _autoLabelTable(table){
  try{
    const headRow = table.querySelector('thead tr');
    if(!headRow) return;
    const headers = Array.from(headRow.children).map(th=>{
      const clone = th.cloneNode(true);
      clone.querySelectorAll('svg,button').forEach(n=>n.remove());
      return (clone.textContent || '').trim();
    });
    table.querySelectorAll('tbody tr').forEach(tr=>{
      Array.from(tr.children).forEach((td, i)=>{
        // لو الخلية عندها data-label بالفعل (حتى لو فاضي عمداً زي عمود الإجراءات)
        // سيبها زي ما هي — احتراماً لأي توسيم يدوي متحط فعلاً في كود العرض
        if(td.tagName === 'TD' && !td.hasAttribute('data-label') && headers[i]){
          td.setAttribute('data-label', headers[i]);
        }
      });
    });
  }catch(e){ /* silent: تحسين عرض فقط، لا يجب أن يكسر أي شيء */ }
}
function _scanAutoLabelTables(root){
  try{
    const scope = (root && root.querySelectorAll) ? root : document;
    scope.querySelectorAll('.table-scroll table').forEach(_autoLabelTable);
  }catch(e){}
}
(function initAutoLabelObserver(){
  if(typeof document === 'undefined') return;
  const run = ()=>{
    _scanAutoLabelTables(document);
    let scheduled = false;
    const mo = new MutationObserver((mutations)=>{
      if(scheduled) return;
      scheduled = true;
      requestAnimationFrame(()=>{
        scheduled = false;
        for(const m of mutations){
          const target = m.target && m.target.closest ? m.target.closest('.table-scroll') : null;
          if(target){ _scanAutoLabelTables(target); }
        }
      });
    });
    document.querySelectorAll('.table-scroll').forEach(el=>{
      mo.observe(el, { childList:true, subtree:true });
    });
    // شاشات (views) بتتولّد وتُضاف للـ DOM لاحقاً (بعد تسجيل الدخول مثلاً) — إعادة
    // فحص دورية خفيفة تلتقط أي .table-scroll جديد يظهر لاحقاً ولسه مش بيتراقَب
    let lastCount = document.querySelectorAll('.table-scroll').length;
    setInterval(()=>{
      const els = document.querySelectorAll('.table-scroll');
      if(els.length !== lastCount){
        lastCount = els.length;
        els.forEach(el=>{ mo.observe(el, { childList:true, subtree:true }); });
        _scanAutoLabelTables(document);
      }
    }, 2000);
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

/* ============= قائمة "إجراءات أخرى" المنسدلة — تفعيل عام لكل الشاشات ============= */
(function(){
  // كانت كل قائمة position:absolute جوّه .overflow-wrap مباشرة. المشكلة: أغلب الـ .overflow-wrap
  // دي جوّه حاويات (.panel) عندها overflow-x:auto أو عناصر فيها backdrop-filter، وأي حاوية زي
  // دي بتقصّ/تحبس أي عنصر position:absolute (أو حتى position:fixed) بداخلها — فالقائمة كانت
  // بتظهر مقطوعة أو متداخلة مع صناديق الفلاتر (input/select) اللي حواليها بدل ما تطفو فوقها
  // بشكل نضيف، وبالتبعية أزرارها بتبقى مش قابلة للنقر فعليًا. نفس الحل المستخدم فعليًا لقائمة
  // المستخدم (#user-menu-dropdown): ننقل كل قائمة لتبقى ابن مباشر لـ body بعيدًا عن أي حاوية
  // قاصّة، ونحسب موضعها ديناميكيًا بـ position:fixed بالنسبة لزر التفعيل بتاعها.
  const pairs = [];
  document.querySelectorAll('.overflow-wrap').forEach(wrap=>{
    const toggle = wrap.querySelector('[data-overflow-toggle]');
    const menu = wrap.querySelector('.overflow-menu');
    if(!toggle || !menu) return;
    if(menu.parentElement !== document.body) document.body.appendChild(menu);
    pairs.push({ toggle, menu });
  });

  function closeAllMenus(except){
    pairs.forEach(p=>{
      if(p.menu !== except) p.menu.classList.remove('open');
    });
  }

  function positionMenu(toggle, menu){
    const r = toggle.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (r.bottom + 8) + 'px';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
  }

  document.addEventListener('click', function(e){
    const toggle = e.target.closest('[data-overflow-toggle]');
    if(toggle){
      e.preventDefault();
      const pair = pairs.find(p=>p.toggle === toggle);
      const menu = pair ? pair.menu : null;
      if(menu){
        const willOpen = !menu.classList.contains('open');
        closeAllMenus();
        if(willOpen){
          positionMenu(toggle, menu);
          menu.classList.add('open');
        }
      }
      return;
    }
    if(!e.target.closest('.overflow-menu') && !e.target.closest('[data-overflow-toggle]')) closeAllMenus();
  });

  // القائمة بقت ابن مباشر لـ body مش جوّه شريط الأدوات، فلازم نعيد حساب موضعها لو الصفحة
  // اتمررت أو الشاشة اتغير حجمها وهي لسه مفتوحة، عشان تفضل ملزّقة بزرها.
  window.addEventListener('resize', ()=>{
    pairs.forEach(p=>{ if(p.menu.classList.contains('open')) positionMenu(p.toggle, p.menu); });
  });
  window.addEventListener('scroll', ()=>{
    pairs.forEach(p=>{ if(p.menu.classList.contains('open')) positionMenu(p.toggle, p.menu); });
  }, true);

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeAllMenus();
  });
})();


/* ============================================================
   حالات فارغة وحالات خطأ موحّدة (بريف 2026-08 بند 15 و16)
   ------------------------------------------------------------
   دوال مساعدة عامة اختيارية — أي شاشة/موديول تقدر تستخدمها بدل
   كتابة HTML الحالة الفارغة/الخطأ يدوياً من جديد. لا تستبدل أي
   استخدام قائم لـ .empty-state (لسه شغال زي ما هو تماماً).
   ============================================================ */
function renderEmptyState(container, opts){
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if(!el) return;
  const icon = (opts && opts.icon) || '📭';
  const title = (opts && opts.title) || 'لا توجد بيانات بعد';
  const hint = (opts && opts.hint) || '';
  const actionLabel = opts && opts.actionLabel;
  const onAction = opts && opts.onAction;
  const btnId = 'empty-state-action-' + Math.random().toString(36).slice(2, 8);
  el.innerHTML = `
    <div class="empty-state">
      <div class="big">${icon}</div>
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${hint ? `<div class="empty-state-hint">${escapeHtml(hint)}</div>` : ''}
      ${actionLabel ? `<button type="button" class="btn btn-primary btn-sm" id="${btnId}">${escapeHtml(actionLabel)}</button>` : ''}
    </div>`;
  if(actionLabel && typeof onAction === 'function'){
    document.getElementById(btnId)?.addEventListener('click', onAction);
  }
}

function renderErrorState(container, opts){
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if(!el) return;
  const title = (opts && opts.title) || 'حدث خطأ أثناء تحميل البيانات';
  const detail = opts && opts.detail;
  const onRetry = opts && opts.onRetry;
  const btnId = 'error-state-retry-' + Math.random().toString(36).slice(2, 8);
  el.innerHTML = `
    <div class="error-state">
      <div class="big">⚠️</div>
      <div class="error-state-title">${escapeHtml(title)}</div>
      ${typeof onRetry === 'function' ? `<button type="button" class="btn btn-ghost btn-sm" id="${btnId}">إعادة المحاولة</button>` : ''}
      ${detail ? `<details><summary>تفاصيل تقنية (للمسؤول)</summary><div class="error-state-detail">${escapeHtml(String(detail))}</div></details>` : ''}
    </div>`;
  if(typeof onRetry === 'function'){
    document.getElementById(btnId)?.addEventListener('click', onRetry);
  }
}
