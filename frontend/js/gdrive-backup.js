/* ============================================================================
   النسخ الاحتياطي والاستعادة عبر Google Drive
   ----------------------------------------------------------------------------
   الواجهة لا تتحدث مع Google مباشرة — كل عمليات OAuth2 والرفع/التحميل تتم في
   عملية Electron الرئيسية (main.js) وتُعرض هنا عبر مسارات HTTP محلية على نفس
   السيرفر المحلي (127.0.0.1:17532) تحت /gdrive/*. لذلك لا نحتاج أي مكتبة
   إضافية ولا أي preload/contextBridge.

   تدفّق الربط: نطلب من الخادم بدء المصادقة فيفتح متصفح النظام على صفحة Google،
   وبعد موافقة المستخدم يعيد Google التوجيه إلى /gdrive/callback على نفس السيرفر
   فيتبادل الكود بتوكن ويحفظه. نكتفي هنا بالاستطلاع (polling) على /gdrive/status
   حتى يظهر connected=true.
   ============================================================================ */

let _gdriveConfig = { clientId: '', redirectUri: '', hasSecret: false };
let _gdriveStatus = { configured: false, connected: false, user: null };
let _gdrivePollTimer = null;

function gdriveEl(id){ return document.getElementById(id); }

async function gdriveApi(path, opts){
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts || {}));
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if(data && data.ok === false) throw new Error(data.error || 'تعذّر تنفيذ العملية');
  if(!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data || {};
}

/* إرسال بريد عبر نفس طريقة ملخّص التعديلات (حساب Gmail المربوط في main.js).
   تُستخدم لكل تقارير/فواتير البرنامج. تقبل to/cc مصفوفة أو نصاً، وattachments مصفوفة
   عناصر بالشكل { name, type, base64 }. */
async function sendAppEmail({ to, cc, subject, html, attachments }){
  const toStr = Array.isArray(to) ? to.filter(Boolean).join(', ') : String(to == null ? '' : to).trim();
  if(!toStr) throw new Error('لا يوجد مستلم للبريد');
  const ccStr = Array.isArray(cc) ? cc.filter(Boolean).join(', ') : String(cc == null ? '' : cc).trim();
  const list = Array.isArray(attachments)
    ? attachments.filter(a=>a && a.base64).map(a=>({ name: a.name, type: a.type, base64: a.base64 }))
    : [];
  return await gdriveApi('/gdrive/send-mail', {
    method: 'POST',
    body: JSON.stringify({ to: toStr, cc: ccStr, subject: subject || '', html: html || '', attachments: list }),
  });
}
window.sendAppEmail = sendAppEmail;

/* ---------------------------- حالة الاتصال والواجهة ---------------------------- */

function gdriveSetBadge(kind, text){
  const badge = gdriveEl('gdrive-status-badge');
  if(!badge) return;
  badge.textContent = text;
  badge.className = 'hint ' + (kind === 'ok' ? 'hint-ok' : kind === 'warn' ? 'hint-warn' : 'hint-info');
  if(kind === 'ok'){ badge.style.borderColor = 'rgba(34,197,94,.5)'; badge.style.color = '#16a34a'; }
  else { badge.style.borderColor = ''; badge.style.color = ''; }
}

function gdriveUpdateButtons(){
  const btnBackup = gdriveEl('btn-gdrive-backup-now');
  const btnConnect = gdriveEl('btn-gdrive-connect');
  const btnDisconnect = gdriveEl('btn-gdrive-disconnect');
  const connected = !!_gdriveStatus.connected;
  if(btnBackup) btnBackup.disabled = !connected;
  if(btnConnect){
    // زر الربط يظهر فقط عندما يكون الحساب مهيّأ (clientId + secret) وغير مربوط بعد.
    btnConnect.style.display = (!connected && _gdriveConfig.clientId && _gdriveConfig.hasSecret) ? '' : 'none';
  }
  if(btnDisconnect) btnDisconnect.style.display = connected ? '' : 'none';
}

function gdriveRenderStatusBadge(){
  if(_gdriveStatus.connected){
    const who = _gdriveStatus.user && (_gdriveStatus.user.emailAddress || _gdriveStatus.user.displayName);
    gdriveSetBadge('ok', '✅ متصل بحساب Google Drive' + (who ? ' — ' + who : ''));
  } else if(_gdriveConfig.clientId && _gdriveConfig.hasSecret){
    gdriveSetBadge('warn', '⚙️ الإعدادات محفوظة — اضغط "ربط الحساب" لإتمام الربط');
  } else {
    gdriveSetBadge('info', '🔒 غير مهيّأ — أدخل بيانات اعتماد Google Cloud من "إعداد بيانات الاعتماد" أدناه');
  }
  gdriveUpdateButtons();
}

/* ---------------------------------- الإعدادات ---------------------------------- */

async function gdriveRenderPanel(){
  // مزامنة مفتاح النسخ التلقائي مع الإعدادات
  const chk = gdriveEl('set-gdrive-autobackup-enabled');
  if(chk) chk.checked = !!settings.gdriveAutoBackupEnabled;
  try{ gdriveRenderSchedule(); }catch(e){ /* الإعدادات قد لا تكون جاهزة بعد */ }
  const uriEl = gdriveEl('gdrive-redirect-uri');
  if(uriEl && _gdriveConfig.redirectUri) uriEl.textContent = _gdriveConfig.redirectUri;
  try{
    _gdriveConfig = await gdriveApi('/gdrive/config');
    if(uriEl && _gdriveConfig.redirectUri) uriEl.textContent = _gdriveConfig.redirectUri;
    const cid = gdriveEl('gdrive-client-id');
    if(cid && _gdriveConfig.clientId) cid.value = _gdriveConfig.clientId;
    // كلمة السر لا تُعاد من الخادم أبداً — نكتفي بإظهار تلميح أنها محفوظة
    const sec = gdriveEl('gdrive-client-secret');
    if(sec){
      sec.placeholder = _gdriveConfig.hasSecret ? '•••••• محفوظ — اتركه فارغاً للإبقاء عليه' : 'Client Secret';
    }
  }catch(e){ /* لا نعطّل الواجهة إن فشل جلب الإعدادات */ }
  await gdriveRefreshStatus();
  if(_gdriveStatus.connected){ gdriveRenderList().catch(()=>{}); }
}

async function gdriveRefreshStatus(){
  try{
    const data = await gdriveApi('/gdrive/status');
    _gdriveStatus = { configured: !!data.configured, connected: !!data.connected, user: data.user || null, canSendMail: !!data.canSendMail };
  }catch(e){
    _gdriveStatus = { configured: !!(_gdriveConfig.clientId && _gdriveConfig.hasSecret), connected: false, user: null, canSendMail: false };
  }
  gdriveRenderStatusBadge();
  return _gdriveStatus;
}

// هل يملك الحساب المربوط صلاحية إرسال البريد؟ (تُمنح عند إعادة الربط)
function gdriveCanSendMail(){ return !!(_gdriveStatus && _gdriveStatus.canSendMail); }

async function gdriveSaveConfig(){
  const btn = gdriveEl('btn-gdrive-save-config');
  const clientId = (gdriveEl('gdrive-client-id')?.value || '').trim();
  const clientSecret = (gdriveEl('gdrive-client-secret')?.value || '').trim();
  if(!clientId){ showToast('أدخل Client ID'); return; }
  if(!clientSecret && !_gdriveConfig.hasSecret){ showToast('أدخل Client Secret'); return; }
  if(btn){ btn.disabled = true; btn.textContent = 'جارٍ الحفظ…'; }
  try{
    await gdriveApi('/gdrive/config', {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const sec = gdriveEl('gdrive-client-secret');
    if(sec) sec.value = '';
    _gdriveConfig = await gdriveApi('/gdrive/config');
    showToast('تم حفظ إعدادات Google Drive');
    await gdriveRefreshStatus();
  }catch(e){
    showToast('تعذّر الحفظ: ' + (e.message || ''));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = 'حفظ إعدادات الاعتماد'; }
  }
}

/* ---------------------------------- الربط ---------------------------------- */

function gdriveStopPolling(){
  if(_gdrivePollTimer){ clearInterval(_gdrivePollTimer); _gdrivePollTimer = null; }
}

async function gdriveConnect(){
  const btn = gdriveEl('btn-gdrive-connect');
  if(btn){ btn.disabled = true; btn.textContent = 'جارٍ فتح المتصفح…'; }
  try{
    await gdriveApi('/gdrive/auth/start', { method: 'POST' });
    gdriveSetBadge('warn', '⏳ اكمل تسجيل الدخول والموافقة في المتصفح الذي فُتح...');
    showToast('فُتح المتصفح — سجّل الدخول ووافق على الوصول، وسيكتمل الربط تلقائياً');
    // استطلاع حالة الاتصال حتى انتهاء تدفّق OAuth في المتصفح
    gdriveStopPolling();
    let attempts = 0;
    _gdrivePollTimer = setInterval(async ()=>{
      attempts++;
      const st = await gdriveRefreshStatus();
      if(st.connected){
        gdriveStopPolling();
        showToast('تم ربط Google Drive بنجاح ✅');
        logAuditSafe('edit', 'الإعدادات', 'ربط حساب Google Drive للنسخ الاحتياطي');
        gdriveRenderList().catch(()=>{});
        try{ if(typeof activityDigestRenderPanel === 'function') activityDigestRenderPanel(); }catch(e){}
      } else if(attempts >= 90){ // ~3 دقائق
        gdriveStopPolling();
        gdriveSetBadge('warn', '⌛ لم يكتمل الربط — أعد المحاولة واضغط "ربط الحساب"');
      }
    }, 2000);
  }catch(e){
    showToast('تعذّر بدء الربط: ' + (e.message || ''));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '🔗 ربط الحساب'; }
  }
}

async function gdriveDisconnect(){
  if(!await customConfirm('قطع الربط مع Google Drive؟ لن تُحذف النسخ المحفوظة على درايف، لكن ستحتاج لإعادة الربط لاستخدامها.')) return;
  try{
    await gdriveApi('/gdrive/disconnect', { method: 'POST' });
    _gdriveStatus = { configured: !!( _gdriveConfig.clientId && _gdriveConfig.hasSecret), connected: false, user: null };
    gdriveRenderStatusBadge();
    const wrap = gdriveEl('gdrive-backups-list');
    if(wrap) wrap.innerHTML = '<div class="hint hint-info">تم قطع الربط — أعد الربط لعرض النسخ</div>';
    showToast('تم قطع الربط مع Google Drive');
    logAuditSafe('edit', 'الإعدادات', 'قطع الربط مع Google Drive');
  }catch(e){
    showToast('تعذّر قطع الربط: ' + (e.message || ''));
  }
}

/* ------------------------------ الرفع والاستعادة ------------------------------ */

// بصمة SHA-256 لمحتوى النسخة — تُستخدم لمقارنة النسخة الحالية بآخر نسخة رُفعت فعلاً.
async function gdriveContentHash(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// نسخة منظّمة للبصمة: نحذف الحقول التي يكتبها البرنامج نفسه عند كل نسخة
// (وقت الإنشاء، وقت آخر تشغيل مجدول، البصمة نفسها) حتى لا تبدو البيانات
// "متغيّرة" بسبب هذه الحقول فقط، فتُرفع نسخة مكررة بلا أي تعديل حقيقي.
function gdriveHashPayload(data){
  let clone;
  try{ clone = JSON.parse(JSON.stringify(data)); }catch(e){ clone = data; }
  if(clone && typeof clone === 'object'){
    delete clone._createdAt;
    // سجل التدقيق يتغيّر مع كل تسجيل دخول/نسخة احتياطية/عملية، وليس بيانات أعمال.
    // لو حسبناه داخل البصمة لبدت النسخة "متغيّرة" كل مرة بسبب سطر التدقيق نفسه،
    // ولرفع البرنامج نسخة مكررة عند كل تشغيل مجدول. أي تعديل حقيقي على البيانات
    // سيغيّر مجموعته الخاصة (clients / vaultTx / ...) وسيُكتشف رغم استبعاد سجل التدقيق.
    delete clone.auditLog;
    if(clone.settings && typeof clone.settings === 'object'){
      delete clone.settings.gdriveScheduleLastRun;
      delete clone.settings.gdriveScheduleLastRunAt;
      delete clone.settings.gdriveScheduleLastUploadedHash;
      delete clone.settings.lastAutoBackupAt;
      // علامة تظهر مرة واحدة شهرياً عند فتح البرنامج — ليست تعديل بيانات.
      delete clone.settings.lastMonthlyReportPromptMonth;
    }
  }
  return JSON.stringify(clone);
}

// يرفع نسخة كاملة إلى Google Drive. المحتوى يُرسل كنص JSON كامل إلى الخادم المحلي
// الذي يرفعه لدرايف. نُرجع { ok, skipped, reason }:
//   ok=true, skipped=true  → لم يُرفع شيء لأن المحتوى مطابق لآخر نسخة مرفوعة.
//   ok=true, skipped=false → تم الرفع فعلاً.
//   ok=false               → فشل الرفع (اتصال/مصادقة…).
// الرفع التلقائي فقط هو الذي يتخطى النسخ غير المتغيرة؛ النسخ اليدوي يرفع دائماً.
async function uploadFullBackupToGDrive(kind){
  try{
    if(!_gdriveStatus.connected) await gdriveRefreshStatus();
    if(!_gdriveStatus.connected){
      if(kind === 'manual') showToast('اربط حساب Google Drive أولاً من الإعدادات');
      return { ok: false, skipped: false, reason: 'not_connected' };
    }
    const data = gatherFullBackupData();
    const content = JSON.stringify(data, null, 2);
    const hash = await gdriveContentHash(gdriveHashPayload(data));
    // فحص التغيير للنسخ التلقائي فقط (المجدول + التلقائي الدوري)
    if(kind === 'auto' && settings && settings.gdriveScheduleLastUploadedHash === hash){
      return { ok: true, skipped: true, reason: 'unchanged', hash };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tag = kind === 'auto' ? '_تلقائية' : '';
    const fileName = `نسخة_احتياطية_كاملة${tag}_${stamp}.json`;
    await gdriveApi('/gdrive/backups', {
      method: 'POST',
      body: JSON.stringify({ content, fileName }),
    });
    // نحفظ بصمة المحتوى الذي رُفع فعلاً — بها نعرف في المرة القادمة هل تغيّر شيء.
    try{
      if(typeof settings !== 'undefined' && settings){
        settings.gdriveScheduleLastUploadedHash = hash;
        if(typeof saveSettings === 'function') await saveSettings();
      }
    }catch(e){ /* لا نُفشل الرفع بسبب تعذّر حفظ البصمة */ }
    return { ok: true, skipped: false, hash };
  }catch(e){
    console.error('uploadFullBackupToGDrive', e);
    if(kind === 'manual') showToast('تعذّر الرفع إلى Google Drive: ' + (e.message || ''));
    return { ok: false, skipped: false, reason: 'error', error: e };
  }
}

async function gdriveBackupNow(){
  const btn = gdriveEl('btn-gdrive-backup-now');
  if(btn){ btn.disabled = true; btn.textContent = 'جارٍ الرفع…'; }
  try{
    const result = await uploadFullBackupToGDrive('manual');
    if(result && result.ok){
      showToast('تم رفع نسخة احتياطية كاملة إلى Google Drive ☁️');
      logAuditSafe('edit', 'الإعدادات', 'نسخة احتياطية يدوية على Google Drive');
      try{ await gdriveRenderList(); }catch(e){}
    }
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '☁️ نسخ احتياطي على Google Drive الآن'; }
    gdriveUpdateButtons();
  }
}

async function gdriveRenderList(){
  const wrap = gdriveEl('gdrive-backups-list');
  if(!wrap) return;
  if(!_gdriveStatus.connected){ return; }
  wrap.innerHTML = '<div class="hint hint-info">جارٍ التحميل...</div>';
  let files = [];
  try{
    const data = await gdriveApi('/gdrive/backups');
    files = data.files || [];
  }catch(e){
    wrap.innerHTML = `<div class="hint hint-warn">تعذّر جلب القائمة: ${escapeHtml(e.message || '')}</div>`;
    return;
  }
  if(!files.length){
    wrap.innerHTML = '<div class="hint hint-info">لا توجد نسخ محفوظة على Google Drive بعد — اضغط "نسخ احتياطي على Google Drive الآن"</div>';
    return;
  }
  wrap.innerHTML = `<div class="table-scroll table-scroll-compact cards-mobile"><table><thead><tr>
    <th>التاريخ</th><th>الاسم</th><th>الحجم</th><th></th></tr></thead><tbody>
    ${files.map(f=>`<tr>
      <td class="mono" data-label="التاريخ">${new Date(f.createdTime || f.modifiedTime || Date.now()).toLocaleString('ar-SA-u-nu-latn')}</td>
      <td data-label="الاسم" style="max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(f.name || '')}</td>
      <td class="mono" data-label="الحجم">${f.size ? (f.size/1024).toFixed(0) + ' كيلوبايت' : '—'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-gold btn-sm" data-gdrive-restore="${escapeHtml(f.id)}">🔄 استعادة</button>
        <button class="btn btn-ghost btn-sm" data-gdrive-download="${escapeHtml(f.id)}">⬇️ تنزيل</button>
        <button class="btn btn-danger btn-sm" data-gdrive-delete="${escapeHtml(f.id)}">🗑️</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

async function gdriveFetchBackupContent(id){
  const data = await gdriveApi('/gdrive/backups/' + encodeURIComponent(id));
  if(typeof data.content !== 'string' || !data.content) throw new Error('النسخة فارغة أو غير صالحة');
  return data.content;
}

async function gdriveDownloadBackup(id, name){
  try{
    showToast('جارٍ تنزيل النسخة من Google Drive...');
    const content = await gdriveFetchBackupContent(id);
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (name || 'نسخة_احتياطية_جوجل') + '.json';
    a.click();
    showToast('تم تنزيل النسخة الاحتياطية');
  }catch(e){
    showToast('تعذّر التنزيل: ' + (e.message || ''));
  }
}

// استعادة كاملة من نسخة محفوظة على Google Drive — تُنزّل المحتوى ثم تمرّ عبر نفس مسار
// الاستعادة المحلي restoreFullBackup (الذي يعرض تأكيداً ويمسح السيرفر/البيانات ثم يعيد الرفع).
// نُمرّر كائناً فيه text() فقط لأن restoreFullBackup يقرأ الملف بهذه الطريقة حصراً.
async function gdriveRestoreBackup(id){
  try{
    showToast('جارٍ تنزيل النسخة من Google Drive...');
    const content = await gdriveFetchBackupContent(id);
    await restoreFullBackup({ text: async () => content });
  }catch(e){
    showToast('تعذّر جلب النسخة: ' + (e.message || ''));
  }
}

async function gdriveDeleteBackup(id){
  if(!await customConfirm('حذف هذه النسخة الاحتياطية نهائياً من Google Drive؟')) return;
  try{
    await gdriveApi('/gdrive/backups/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('تم حذف النسخة من Google Drive');
    await gdriveRenderList();
  }catch(e){
    showToast('تعذّر الحذف: ' + (e.message || ''));
  }
}

/* ------------------------ النسخ التلقائي المجدول ------------------------ */
/*
 * يأخذ البرنامج نسخة كاملة ويرفعها إلى Google Drive في الأوقات التي يحدّدها
 * المستخدم (افتراضياً 08:00 و 17:00). يعمل هذا المنظّم ما دام البرنامج مفتوحاً
 * (لا يعمل والبرنامج مغلق — لا يوجد تشغيل خلفي). لا يتطلب أي مهمة مجدولة في
 * ويندوز ولا أي صلاحيات إضافية.
 *
 * التتبّع: settings.gdriveScheduleTimes     = ['08:00','17:00']
 *           settings.gdriveScheduleEnabled   = true/false
 *          settings.gdriveScheduleLastRun   = { '08:00': 'YYYY-MM-DD', ... }
 *          settings.gdriveScheduleLastRunAt = ISO لآخر تشغيل ناجح (للعرض)
 */

const GDRIVE_DEFAULT_SCHEDULE_TIMES = ['08:00', '17:00'];
let _gdriveSchedulerTimer = null;
let _gdriveScheduledBusy = false;
let _gdriveNextAttemptAt = 0;

function gdriveTodayStr(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function gdriveNowMinutes(){
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function gdriveTimeToMinutes(t){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
  if(!m) return -1;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if(h < 0 || h > 23 || mi < 0 || mi > 59) return -1;
  return h * 60 + mi;
}

function gdriveNormalizeTime(t){
  const mins = gdriveTimeToMinutes(t);
  if(mins < 0) return null;
  const p = n => String(n).padStart(2, '0');
  return p(Math.floor(mins / 60)) + ':' + p(mins % 60);
}

function gdriveGetScheduleTimes(){
  let arr = (typeof settings !== 'undefined' && Array.isArray(settings.gdriveScheduleTimes))
    ? settings.gdriveScheduleTimes : GDRIVE_DEFAULT_SCHEDULE_TIMES.slice();
  arr = arr.map(gdriveNormalizeTime).filter(Boolean);
  if(!arr.length) arr = GDRIVE_DEFAULT_SCHEDULE_TIMES.slice();
  const seen = new Set();
  arr = arr.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
  arr.sort((a, b) => a.localeCompare(b));
  return arr;
}

function gdriveRenderSchedule(){
  if(typeof settings === 'undefined') return;
  const box = gdriveEl('gdrive-schedule-times');
  const chk = gdriveEl('gdrive-schedule-enabled');
  if(chk) chk.checked = !!settings.gdriveScheduleEnabled;
  if(box){
    const times = gdriveGetScheduleTimes();
    box.innerHTML = times.map(t => `
      <div style="display:flex; align-items:center; gap:8px;">
        <input type="time" class="gdrive-schedule-time" value="${t}" style="width:auto; min-width:130px;">
        <button class="btn btn-danger btn-sm" type="button" data-gdrive-remove-time title="حذف هذا الوقت">🗑️</button>
      </div>`).join('');
  }
  gdriveRenderScheduleStatus();
}

function gdriveRenderScheduleStatus(){
  const el = gdriveEl('gdrive-schedule-status');
  if(!el || typeof settings === 'undefined') return;
  if(!settings.gdriveScheduleEnabled){
    el.textContent = 'النسخ التلقائي المجدول متوقف — فعّله أعلاه وحدّد الأوقات.';
    return;
  }
  const times = gdriveGetScheduleTimes();
  let txt = '⏰ الأوقات المفعّلة: ' + times.join(' ، ');
  const lastAt = settings.gdriveScheduleLastRunAt;
  if(lastAt){
    try{ txt += ' — آخر نسخة مجدولة: ' + new Date(lastAt).toLocaleString('ar-SA-u-nu-latn'); }
    catch(e){ txt += ' — آخر نسخة مجدولة: ' + lastAt; }
  } else {
    txt += ' — لم تُنفَّذ أي نسخة مجدولة بعد';
  }
  el.textContent = txt;
}

function gdriveAddTimeRow(value){
  const box = gdriveEl('gdrive-schedule-times');
  if(!box) return;
  const t = gdriveNormalizeTime(value) || '12:00';
  const div = document.createElement('div');
  div.style.cssText = 'display:flex; align-items:center; gap:8px;';
  div.innerHTML = `<input type="time" class="gdrive-schedule-time" value="${t}" style="width:auto; min-width:130px;">
    <button class="btn btn-danger btn-sm" type="button" data-gdrive-remove-time title="حذف هذا الوقت">🗑️</button>`;
  box.appendChild(div);
}

async function gdriveSaveSchedule(){
  const box = gdriveEl('gdrive-schedule-times');
  const enabled = !!gdriveEl('gdrive-schedule-enabled')?.checked;
  let times = [];
  if(box){
    box.querySelectorAll('input.gdrive-schedule-time').forEach(inp => {
      const t = gdriveNormalizeTime(inp.value);
      if(t) times.push(t);
    });
  }
  const seen = new Set();
  times = times.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
  times.sort((a, b) => a.localeCompare(b));
  if(!times.length) times = GDRIVE_DEFAULT_SCHEDULE_TIMES.slice();
  settings.gdriveScheduleTimes = times;
  settings.gdriveScheduleEnabled = enabled;
  if(!settings.gdriveScheduleLastRun || typeof settings.gdriveScheduleLastRun !== 'object') settings.gdriveScheduleLastRun = {};
  // عند الحفظ لا نُشغّل فوراً الأوقات التي مضت من هذا اليوم — نعلّمها كمنتهية اليوم
  // حتى لا يبدأ رفع كبير مباشرةً بمجرد التفعيل. (أما عند إعادة تشغيل البرنامج فيبقى
  // الاستدراك مفعّلاً للأوقات التي لم تُنفَّذ اليوم.)
  const today = gdriveTodayStr();
  const nowMin = gdriveNowMinutes();
  times.forEach(t => { const tm = gdriveTimeToMinutes(t); if(tm >= 0 && nowMin >= tm) settings.gdriveScheduleLastRun[t] = today; });
  try{
    await saveSettings();
    gdriveRenderSchedule();
    showToast(enabled ? 'تم حفظ جدول النسخ التلقائي ✅' : 'تم إيقاف النسخ التلقائي المجدول');
  }catch(e){
    showToast('تعذّر حفظ الجدول');
  }
}

async function gdriveRunScheduledBackup(time, today){
  _gdriveScheduledBusy = true;
  try{
    showToast('⏰ بدء النسخة الاحتياطية المجدولة على Google Drive...');
    const result = await uploadFullBackupToGDrive('auto');
    if(result && result.ok && result.skipped){
      // لا تعديل منذ آخر نسخة مرفوعة — نتخطى الرفع ونعلّم هذا الوقت كمنتهٍ اليوم
      if(!settings.gdriveScheduleLastRun || typeof settings.gdriveScheduleLastRun !== 'object') settings.gdriveScheduleLastRun = {};
      settings.gdriveScheduleLastRun[time] = today;
      try{ await saveSettings(); }catch(e){}
      showToast('⏰ لا يوجد تغيير منذ آخر نسخة — تم تخطي الرفع (' + time + ')');
      logAuditSafe('edit', 'الإعدادات', 'تخطي نسخة مجدولة على Google Drive بلا تغيير (' + time + ')');
      gdriveRenderScheduleStatus();
      return;
    }
    if(result && result.ok){
      if(!settings.gdriveScheduleLastRun || typeof settings.gdriveScheduleLastRun !== 'object') settings.gdriveScheduleLastRun = {};
      settings.gdriveScheduleLastRun[time] = today;
      settings.gdriveScheduleLastRunAt = new Date().toISOString();
      try{ await saveSettings(); }catch(e){}
      showToast('✅ تم رفع النسخة الاحتياطية المجدولة (' + time + ') إلى Google Drive');
      logAuditSafe('edit', 'الإعدادات', 'نسخة احتياطية مجدولة على Google Drive (' + time + ')');
      if(_gdriveStatus.connected){ gdriveRenderList().catch(()=>{}); }
    }else{
      // فشل الرفع (غالباً انقطاع الإنترنت) — نعيد المحاولة بعد فترة دون إغراق الإشعارات
      _gdriveNextAttemptAt = Date.now() + 5 * 60 * 1000;
      showToast('⚠️ تعذّر رفع النسخة المجدولة — سيُعاد المحاولة تلقائياً بعد قليل');
    }
    gdriveRenderScheduleStatus();
  }catch(e){
    console.error('[GDrive scheduled backup]', e);
    _gdriveNextAttemptAt = Date.now() + 5 * 60 * 1000;
  }finally{
    _gdriveScheduledBusy = false;
  }
}

async function gdriveSchedulerTick(){
  try{
    if(typeof settings === 'undefined' || !settings.gdriveScheduleEnabled) return;
    if(typeof SERVER_AUTH_TOKEN === 'undefined' || !SERVER_AUTH_TOKEN) return; // يتطلب تسجيل الدخول
    try{ if(!window.__ftc2DataReady) return; }catch(e){ return; } // انتظر اكتمال تحميل البيانات
    if(_gdriveScheduledBusy) return;
    if(Date.now() < _gdriveNextAttemptAt) return;
    const times = gdriveGetScheduleTimes();
    if(!times.length) return;
    const today = gdriveTodayStr();
    if(!settings.gdriveScheduleLastRun || typeof settings.gdriveScheduleLastRun !== 'object') settings.gdriveScheduleLastRun = {};
    const nowMin = gdriveNowMinutes();
    for(const t of times){
      const tm = gdriveTimeToMinutes(t);
      if(tm < 0) continue;
      if(nowMin < tm) continue;                        // لم يحن الوقت بعد
      if(settings.gdriveScheduleLastRun[t] === today) continue; // نُفِّذ اليوم
      await gdriveRunScheduledBackup(t, today);
      return;
    }
  }catch(e){ console.error('[GDrive scheduler]', e); }
}

function gdriveStartScheduler(){
  try{ gdriveRenderSchedule(); }catch(e){}
  if(_gdriveSchedulerTimer) clearInterval(_gdriveSchedulerTimer);
  // فحص كل 30 ثانية لالتقاط لحظة عبور الوقت المحدد
  _gdriveSchedulerTimer = setInterval(gdriveSchedulerTick, 30 * 1000);
}

/* ------------------------------ ربط الأحداث ------------------------------ */

// تسجيل تدقيق اختياري — لا نُفشل العملية إن لم تكن logAudit متاحة أو فشلت.
function logAuditSafe(action, entity, details){
  try{
    if(typeof logAudit === 'function') logAudit(action, entity, details).catch(()=>{});
  }catch(e){ /* تجاهل */ }
}

function initGDriveUI(){
  gdriveEl('btn-gdrive-save-config')?.addEventListener('click', gdriveSaveConfig);
  gdriveEl('btn-gdrive-connect')?.addEventListener('click', gdriveConnect);
  gdriveEl('btn-gdrive-disconnect')?.addEventListener('click', gdriveDisconnect);
  gdriveEl('btn-gdrive-backup-now')?.addEventListener('click', gdriveBackupNow);
  gdriveEl('btn-gdrive-refresh')?.addEventListener('click', ()=>{ gdriveRenderList().catch(()=>{}); });
  gdriveEl('set-gdrive-autobackup-enabled')?.addEventListener('change', async (e)=>{
    settings.gdriveAutoBackupEnabled = !!e.target.checked;
    try{ await saveSettings(); showToast('تم حفظ إعداد النسخ التلقائي على Google Drive'); }
    catch(err){ showToast('تعذّر حفظ الإعداد'); }
  });
  // جدول النسخ التلقائي
  gdriveEl('btn-gdrive-add-time')?.addEventListener('click', ()=> gdriveAddTimeRow('12:00'));
  gdriveEl('btn-gdrive-save-schedule')?.addEventListener('click', ()=> gdriveSaveSchedule());
  document.addEventListener('click', (e)=>{
    const rst = e.target.closest('[data-gdrive-restore]');
    if(rst){ gdriveRestoreBackup(rst.dataset.gdriveRestore); return; }
    const dl = e.target.closest('[data-gdrive-download]');
    if(dl){
      const name = dl.closest('tr')?.querySelector('td[data-label="الاسم"]')?.textContent?.trim();
      gdriveDownloadBackup(dl.dataset.gdriveDownload, name);
      return;
    }
    const del = e.target.closest('[data-gdrive-delete]');
    if(del){ gdriveDeleteBackup(del.dataset.gdriveDelete); return; }
    const rem = e.target.closest('[data-gdrive-remove-time]');
    if(rem){
      const box = gdriveEl('gdrive-schedule-times');
      const rows = box ? box.querySelectorAll('div') : [];
      if(rows.length <= 1){ showToast('يجب أن يبقى وقت واحد على الأقل'); return; }
      rem.closest('div')?.remove();
    }
  });
  // تحميل أولي لحالة الربط (بعد أن تصبح الإعدادات الحقيقية جاهزة)
  gdriveRenderPanel().catch(()=>{});
  // بدء مراقب النسخ التلقائي المجدول
  gdriveStartScheduler();
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initGDriveUI);
}else{
  initGDriveUI();
}
