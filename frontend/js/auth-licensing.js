/* رسالة ترحيب حسب توقيت اليوم الحالي على جهاز المستخدم (وقت محلي، بدون أي اتصال بالسيرفر) */
function arabicTimeGreeting(){
  const hour = new Date().getHours();
  if(hour >= 5 && hour < 12) return 'صباح الخير';
  if(hour >= 12 && hour < 17) return 'نهارك سعيد';
  if(hour >= 17 && hour < 22) return 'مساء الخير';
  return 'تصبح على خير'; // دخول في وقت متأخر من الليل
}

/* ---------------- الدخول بالبصمة / Face ID (WebAuthn) ----------------
   يعتمد على واجهة navigator.credentials القياسية فى المتصفح مباشرة (بدون مكتبة خارجية على
   الفرونت إند) — البصمة نفسها لا تغادر الجهاز أبداً، السيرفر يتعامل فقط مع "مفتاح عام" لكل جهاز. */
function webauthnSupported(){
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create && navigator.credentials.get);
}
function bufferToBase64url(buffer){
  const bytes = new Uint8Array(buffer);
  let str = '';
  for(const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToBuffer(base64url){
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const str = atob(base64 + pad);
  const bytes = new Uint8Array(str.length);
  for(let i=0; i<str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes.buffer;
}

/* تسجيل هذا الجهاز (يتطلب أن يكون المستخدم قد سجّل دخوله عادياً بالفعل) — يُستدعى من زر
   "تسجيل هذا الجهاز" فى شاشة الإعدادات (panel-webauthn). */
async function webauthnRegisterThisDevice(){
  if(!webauthnSupported()){ showToast('⚠️ هذا المتصفح/الجهاز لا يدعم الدخول بالبصمة'); return; }
  try{
    const optsRes = await serverFetch('/api/auth/webauthn/register-options', { method:'POST' });
    const options = await optsRes.json();
    if(!optsRes.ok) throw new Error(options.error || 'تعذّر بدء التسجيل');
    options.challenge = base64urlToBuffer(options.challenge);
    options.user.id = base64urlToBuffer(options.user.id);
    if(Array.isArray(options.excludeCredentials)){
      options.excludeCredentials = options.excludeCredentials.map(c => ({...c, id: base64urlToBuffer(c.id)}));
    }
    const credential = await navigator.credentials.create({ publicKey: options });
    const attestation = credential.response;
    const deviceLabel = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'هذا الجهاز';
    const payload = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        attestationObject: bufferToBase64url(attestation.attestationObject),
        clientDataJSON: bufferToBase64url(attestation.clientDataJSON),
        transports: attestation.getTransports ? attestation.getTransports() : [],
      },
      clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      nickname: deviceLabel,
    };
    const verifyRes = await serverFetch('/api/auth/webauthn/register-verify', { method:'POST', body: JSON.stringify(payload) });
    const verifyData = await verifyRes.json();
    if(!verifyRes.ok) throw new Error(verifyData.error || 'تعذّر إتمام التسجيل');
    showToast('تم تسجيل هذا الجهاز بنجاح ✅ — تقدر تدخل بالبصمة من المرة الجاية');
    if(typeof loadWebauthnDevicesList === 'function') loadWebauthnDevicesList();
  }catch(e){
    console.error('[WebAuthn] فشل تسجيل الجهاز:', e);
    // المستخدم لغى نافذة البصمة نفسها (NotAllowedError) — ليست حالة خطأ حقيقية تستحق تنبيهاً مزعجاً.
    if(e.name !== 'NotAllowedError') showToast('⚠️ تعذّر تسجيل الجهاز: ' + (e.message || 'خطأ غير متوقع'));
  }
}

/* الدخول ببصمة/Face ID مسجَّلة مسبقاً على هذا الجهاز، بدل كلمة المرور — يُستدعى من زر
   "دخول بالبصمة" فى شاشة الدخول نفسها. يُرجع نفس شكل بيانات serverLogin() عند النجاح. */
async function webauthnLogin(username){
  if(!username) throw new Error('أدخل اسم المستخدم أولاً');
  const optsRes = await fetch(API_BASE + '/api/auth/webauthn/login-options', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username }),
  });
  const options = await optsRes.json();
  if(!optsRes.ok) throw new Error(options.error || 'لا توجد بصمة مسجّلة لهذا الحساب على هذا الجهاز');
  options.challenge = base64urlToBuffer(options.challenge);
  if(Array.isArray(options.allowCredentials)){
    options.allowCredentials = options.allowCredentials.map(c => ({...c, id: base64urlToBuffer(c.id)}));
  }
  const assertion = await navigator.credentials.get({ publicKey: options });
  const authResp = assertion.response;
  const responsePayload = {
    id: assertion.id,
    rawId: bufferToBase64url(assertion.rawId),
    type: assertion.type,
    response: {
      authenticatorData: bufferToBase64url(authResp.authenticatorData),
      clientDataJSON: bufferToBase64url(authResp.clientDataJSON),
      signature: bufferToBase64url(authResp.signature),
      userHandle: authResp.userHandle ? bufferToBase64url(authResp.userHandle) : undefined,
    },
    clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {},
  };
  const verifyRes = await fetch(API_BASE + '/api/auth/webauthn/login-verify', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ username, response: responsePayload }),
  });
  const data = await verifyRes.json();
  if(!verifyRes.ok) throw new Error(data.error || 'تعذّر الدخول بالبصمة');
  SERVER_AUTH_TOKEN = data.token;
  SERVER_AUTH_USERNAME = data.username || username;
  SERVER_AUTH_ROLE = normalizeRole(data.role);
  try{
    sessionStorage.setItem('serverAuthToken', data.token);
    sessionStorage.setItem('serverAuthUsername', SERVER_AUTH_USERNAME);
    sessionStorage.setItem('serverAuthRole', SERVER_AUTH_ROLE);
  }catch(e){ console.error('[Auth] Failed to store session token:', e); }
  return data;
}

/* ---------------- شاشة الدخول على الخادم المركزي (منفصلة عن نظام المستخدمين الداخلي للبرنامج) ---------------- */
function showServerLoginScreen(errorMsg){
  const el = document.getElementById('server-login-screen');
  if(!el) return;
  el.style.display = 'flex';
  const errEl = document.getElementById('server-login-error');
  if(errorMsg){ errEl.textContent = errorMsg; errEl.style.display = 'block'; }
  else { errEl.style.display = 'none'; }
}
async function serverLogin(username, password, totpCode){
  let res;
  try{
    res = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(totpCode ? { username, password, totpCode } : { username, password }),
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
  // كلمة المرور صحيحة لكن هذا الحساب مفعّل عنده مصادقة ثنائية ولسه محتاجين الكود — مش خطأ،
  // نرجّع علامة صريحة للنموذج يعرض حقل الكود ويعيد المحاولة بدل اعتبارها فشل دخول.
  if(data.requires2FA){
    const need2fa = new Error('أدخل كود المصادقة الثنائية');
    need2fa.requires2FA = true;
    throw need2fa;
  }
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
  }catch(e){ console.error('[Auth] Failed to store session token:', e); }
  // نحفظ (بشكل غير قابل للعكس) تجزئة لكلمة المرور محلياً على هذا الجهاز فقط، حتى يمكن لاحقاً
  // فتح البرنامج بلا إنترنت إطلاقاً بنفس اسم المستخدم/كلمة المرور — راجع tryOfflineLogin أسفله.
  // تعمل في الخلفية (fire-and-forget) لتجنب تأخير ظهور الواجهة بـ PBKDF2 بـ 100000 تكرار.
  cacheOfflineLogin(SERVER_AUTH_USERNAME, password, SERVER_AUTH_ROLE).catch(e => console.error('[Auth] Failed to cache offline login:', e));
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
  }catch(e){ console.error('[Auth] Failed to cache offline login:', e); }
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



