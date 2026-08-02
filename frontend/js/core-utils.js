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

async function _recordsSnapWrite(key, list, baselinePairs, versionPairs){
  try{
    const payload = JSON.stringify({ t: 1, list, baselinePairs, versionPairs, savedAt: Date.now() });
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

