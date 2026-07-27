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
  let res;
  try{
    res = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }catch(e){
    // فشل اتصال فعلي بالسيرفر (لا رد إطلاقاً) — نميّزه هنا بعلامة صريحة حتى لا يُعامَل كخطأ
    // "بيانات دخول غير صحيحة"، فيمكن لاحقاً تجربة الدخول بالوضع المحلي بدلاً منه.
    const netErr = new Error('تعذّر الاتصال بالسيرفر لتسجيل الدخول');
    netErr.networkError = true;
    throw netErr;
  }
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
  // نحفظ (بشكل غير قابل للعكس) تجزئة لكلمة المرور محلياً على هذا الجهاز فقط، حتى يمكن لاحقاً
  // فتح البرنامج بلا إنترنت إطلاقاً بنفس اسم المستخدم/كلمة المرور — راجع tryOfflineLogin أسفله.
  await cacheOfflineLogin(SERVER_AUTH_USERNAME, password, SERVER_AUTH_ROLE);
  return data;
}

/* ---------------- الدخول بلا إنترنت إطلاقاً (لمرة أولى أو بعد إغلاق التطبيق بالكامل) ----------------
   لا نخزّن كلمة المرور نفسها أبداً ولا حتى التوكن الحقيقي، فقط تجزئة (PBKDF2) مربوطة بملح عشوائي
   خاص بكل مستخدم، محفوظة في localStorage على نفس الجهاز فقط. لا تُصلِح أي جلسة أُنشئت على جهاز آخر،
   ولا تمنح أي صلاحية لم يسبق فعلاً التحقق منها من السيرفر لهذا المستخدم بالذات على هذا الجهاز تحديداً. */
const OFFLINE_LOGIN_CACHE_KEY = 'ftcOfflineLoginCacheV1';
async function hashPasswordForOfflineCache(password, saltBytes){
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), {name:'PBKDF2'}, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt: saltBytes, iterations: 100000, hash:'SHA-256'}, keyMaterial, 256);
  return bytesToBase64(new Uint8Array(bits));
}
async function cacheOfflineLogin(username, password, role){
  try{
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await hashPasswordForOfflineCache(password, salt);
    const store = (()=>{ try{ return JSON.parse(localStorage.getItem(OFFLINE_LOGIN_CACHE_KEY)||'{}'); }catch(e){ return {}; } })();
    store[String(username||'').toLowerCase()] = { role, saltB64: bytesToBase64(salt), hashB64: hash, cachedAt: Date.now() };
    localStorage.setItem(OFFLINE_LOGIN_CACHE_KEY, JSON.stringify(store));
  }catch(e){}
}
async function tryOfflineLogin(username, password){
  try{
    const store = JSON.parse(localStorage.getItem(OFFLINE_LOGIN_CACHE_KEY)||'{}');
    const entry = store[String(username||'').toLowerCase()];
    if(!entry) return null;
    const hash = await hashPasswordForOfflineCache(password, base64ToBytes(entry.saltB64));
    if(hash !== entry.hashB64) return null;
    return { username, role: entry.role };
  }catch(e){ return null; }
}



