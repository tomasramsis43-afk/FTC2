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
let _kvIdbPromise = null;
function _openKvIdb(){
  if(_kvIdbPromise) return _kvIdbPromise;
  _kvIdbPromise = new Promise((resolve)=>{
    try{
      if(!window.indexedDB){ resolve(null); return; }
      const req = indexedDB.open(KV_IDB_NAME, 2);
      req.onupgradeneeded = ()=>{
        try{ if(!req.result.objectStoreNames.contains(KV_IDB_STORE)) req.result.createObjectStore(KV_IDB_STORE, { keyPath: 'key' }); }catch(e){}
        try{ if(!req.result.objectStoreNames.contains(KV_IDB_PENDING_STORE)) req.result.createObjectStore(KV_IDB_PENDING_STORE, { keyPath: 'key' }); }catch(e){}
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> resolve(null); // فشل الفتح — سنستخدم localStorage كخط رجعة
    }catch(e){ resolve(null); }
  });
  return _kvIdbPromise;
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
      if(legacy){ _kvCacheWrite(key, legacy.version, legacy.value).catch(()=>{}); try{ localStorage.removeItem(KV_CACHE_PREFIX + key); }catch(e){} return legacy; }
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
async function _kvCacheWrite(key, version, value){
  try{
    const db = await _openKvIdb();
    if(db){
      await new Promise((resolve)=>{
        try{
          const tx = db.transaction(KV_IDB_STORE, 'readwrite');
          tx.objectStore(KV_IDB_STORE).put({ key, version, value });
          tx.oncomplete = ()=> resolve();
          tx.onerror = ()=> resolve();
        }catch(e){ resolve(); }
      });
      return;
    }
    localStorage.setItem(KV_CACHE_PREFIX + key, JSON.stringify({ version, value }));
  }catch(e){ /* تجاهل امتلاء المساحة أو أي خطأ تخزين */ }
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
  }catch(e){}
  try{ localStorage.removeItem(KV_CACHE_PREFIX + key); }catch(e){}
}

