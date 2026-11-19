/* ============================================================================
   ملخّص التعديلات اليومي بالإيميل
   ----------------------------------------------------------------------------
   كل عمليات الإضافة/التعديل/الحذف في البرنامج تُسجَّل عبر دالة logAudit()
   (المستخدم + القسم + الوصف). هنا نُضيف هذه العمليات إلى طابور محلي على هذا
   الجهاز (localStorage)، ثم نُرسل إيميلاً واحداً ملخّصاً كل يوم في الوقت المحدد.

   - الإرسال يتم من نفس حساب Google المربوط في قسم النسخ الاحتياطي (main.js)
     عبر المسار المحلي POST /gdrive/send-mail، ويتطلب صلاحية gmail.send.
   - يعمل ما دام البرنامج مفتوحاً (نفس منطق النسخ الاحتياطي المجدول).
   ============================================================================ */

const ACTIVITY_DIGEST_QUEUE_KEY = 'ftc2_activity_digest_queue_v1';
const ACTIVITY_DIGEST_LASTSENT_KEY = 'ftc2_activity_digest_lastsent_v1';
const ACTIVITY_DIGEST_MAX_QUEUE = 5000;
const ACTIVITY_DIGEST_TICK_MS = 60 * 1000;      // فحص كل دقيقة
const ACTIVITY_DIGEST_RETRY_MS = 10 * 60 * 1000; // إعادة محاولة بعد فشل الإرسال

let _activityDigestTimer = null;
let _activityDigestBusy = false;
let _activityDigestRetryAt = 0;

function adEl(id){ return document.getElementById(id); }

function adPad2(n){ return (n < 10 ? '0' : '') + n; }

function adTodayStr(d){
  d = d || new Date();
  return d.getFullYear() + '-' + adPad2(d.getMonth() + 1) + '-' + adPad2(d.getDate());
}

function adNowMinutes(){
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function adNormalizeTime(value){
  const m = String(value == null ? '' : value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return '';
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if(isNaN(h) || isNaN(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return '';
  return adPad2(h) + ':' + adPad2(mi);
}

function adTimeToMinutes(value){
  const t = adNormalizeTime(value);
  if(!t) return -1;
  const parts = t.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/* --------------------------------- الطابور --------------------------------- */

function adLoadQueue(){
  try{
    const raw = localStorage.getItem(ACTIVITY_DIGEST_QUEUE_KEY);
    if(!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}

function adSaveQueue(arr){
  try{ localStorage.setItem(ACTIVITY_DIGEST_QUEUE_KEY, JSON.stringify(arr || [])); }catch(e){}
}

function adLoadLastSent(){
  try{
    const raw = localStorage.getItem(ACTIVITY_DIGEST_LASTSENT_KEY);
    if(!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  }catch(e){ return null; }
}

function adSaveLastSent(dateStr){
  try{ localStorage.setItem(ACTIVITY_DIGEST_LASTSENT_KEY, JSON.stringify({ date: dateStr, at: new Date().toISOString() })); }catch(e){}
}

function adEnabled(){
  return (typeof settings !== 'undefined' && settings) ? !!settings.activityDigestEnabled : false;
}

// تُستدعى من logAudit() بعد كل عملية مسجّلة — نُضيفها للطابور فقط إذا كان الإرسال مفعّلاً.
function activityDigestEnqueue(entry){
  try{
    if(!adEnabled()) return;
    const q = adLoadQueue();
    q.push({
      ts: (entry && entry.ts) || Date.now(),
      user: String((entry && entry.user) || 'غير معروف'),
      action: String((entry && entry.action) || 'other'),
      section: String((entry && entry.section) || ''),
      description: String((entry && entry.description) || ''),
    });
    while(q.length > ACTIVITY_DIGEST_MAX_QUEUE) q.shift();
    adSaveQueue(q);
  }catch(e){}
}

/* ------------------------------ بناء رسالة الإيميل ------------------------------ */

const AD_ACTION_LABELS = { add: 'إضافة', edit: 'تعديل', delete: 'حذف', other: 'أخرى' };

function adEsc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function activityDigestBuildHtmlBody(entries){
  const rows = (entries || []).map(function(e){
    let t = '';
    try{ t = new Date(e.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }); }catch(err){}
    return '<tr>' +
      '<td style="border:1px solid #e5e7eb;padding:6px;white-space:nowrap;">' + adEsc(t) + '</td>' +
      '<td style="border:1px solid #e5e7eb;padding:6px;white-space:nowrap;">' + adEsc(e.user) + '</td>' +
      '<td style="border:1px solid #e5e7eb;padding:6px;white-space:nowrap;">' + adEsc(AD_ACTION_LABELS[e.action] || e.action) + '</td>' +
      '<td style="border:1px solid #e5e7eb;padding:6px;white-space:nowrap;">' + adEsc(e.section) + '</td>' +
      '<td style="border:1px solid #e5e7eb;padding:6px;">' + adEsc(e.description) + '</td>' +
      '</tr>';
  }).join('');
  return '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:Tahoma,Segoe UI,Arial,sans-serif;direction:rtl;color:#111827;background:#ffffff;padding:8px;">' +
    '<h2 style="margin:0 0 6px;font-size:18px;">📋 ملخّص التعديلات اليومي — FTC2</h2>' +
    '<p style="margin:0 0 14px;color:#4b5563;font-size:13px;">التاريخ: ' + adEsc(adTodayStr()) + ' — عدد العمليات: ' + entries.length + '</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:12.5px;"><thead><tr style="background:#f3f4f6;">' +
    '<th style="border:1px solid #e5e7eb;padding:6px;text-align:right;">الوقت</th>' +
    '<th style="border:1px solid #e5e7eb;padding:6px;text-align:right;">المستخدم</th>' +
    '<th style="border:1px solid #e5e7eb;padding:6px;text-align:right;">العملية</th>' +
    '<th style="border:1px solid #e5e7eb;padding:6px;text-align:right;">القسم</th>' +
    '<th style="border:1px solid #e5e7eb;padding:6px;text-align:right;">التفاصيل</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p style="margin-top:16px;color:#9ca3af;font-size:11.5px;">رسالة آلية من برنامج FTC2 لإدارة العملاء — لا تردّ على هذه الرسالة.</p>' +
    '</body></html>';
}

/* --------------------------------- الإرسال --------------------------------- */

async function activityDigestSend(manual){
  if(_activityDigestBusy){
    if(manual && typeof showToast === 'function') showToast('جارٍ الإرسال بالفعل...');
    return false;
  }
  const to = (typeof settings !== 'undefined' && settings) ? String(settings.activityDigestTo || '').trim() : '';
  if(!to){
    if(manual && typeof showToast === 'function') showToast('حدّد بريد المستلم ثم احفظ الإعدادات');
    return false;
  }
  const queue = adLoadQueue();
  if(!queue.length){
    if(manual && typeof showToast === 'function') showToast('لا توجد تعديلات لإرسالها حالياً');
    return 'empty';
  }
  _activityDigestBusy = true;
  try{
    const subject = 'FTC2 — ملخّص التعديلات (' + queue.length + ' عملية) — ' + adTodayStr();
    const html = activityDigestBuildHtmlBody(queue);
    await gdriveApi('/gdrive/send-mail', { method: 'POST', body: JSON.stringify({ to: to, subject: subject, html: html }) });
    adSaveQueue([]);
    adSaveLastSent(adTodayStr());
    if(typeof showToast === 'function') showToast('تم إرسال ملخّص التعديلات إلى ' + to + ' ✅');
    activityDigestRenderStatus();
    return true;
  }catch(e){
    _activityDigestRetryAt = Date.now() + ACTIVITY_DIGEST_RETRY_MS;
    if(manual && typeof showToast === 'function') showToast('تعذّر إرسال الإيميل: ' + ((e && e.message) || ''));
    activityDigestRenderStatus();
    return false;
  }finally{
    _activityDigestBusy = false;
  }
}

async function activityDigestTick(){
  try{
    if(!adEnabled()) return;
    if(typeof SERVER_AUTH_TOKEN === 'undefined' || !SERVER_AUTH_TOKEN) return; // يتطلب تسجيل دخول
    if(!window.__ftc2DataReady) return;                                       // انتظر اكتمال تحميل البيانات
    if(_activityDigestBusy) return;
    if(Date.now() < _activityDigestRetryAt) return;
    const due = adTimeToMinutes(settings.activityDigestTime || '20:00');
    if(due < 0) return;
    if(adNowMinutes() < due) return;
    const last = adLoadLastSent();
    if(last && last.date === adTodayStr()) return; // أُرسل اليوم
    const queue = adLoadQueue();
    if(!queue.length){
      // لا توجد عمليات اليوم — نُسجّل أن موعد اليوم مضى حتى لا يُرسل لاحقاً،
      // وأي تعديلات جديدة بعد ذلك تُرسَل غداً.
      adSaveLastSent(adTodayStr());
      activityDigestRenderStatus();
      return;
    }
    await activityDigestSend(false);
  }catch(e){ /* silent */ }
}

/* --------------------------------- الواجهة --------------------------------- */

async function activityDigestRenderPanel(){
  if(typeof settings === 'undefined' || !settings) return;
  const en = adEl('activity-digest-enabled');
  if(en) en.checked = !!settings.activityDigestEnabled;
  const to = adEl('activity-digest-to');
  if(to && document.activeElement !== to) to.value = settings.activityDigestTo || '';
  const tm = adEl('activity-digest-time');
  if(tm && document.activeElement !== tm) tm.value = adNormalizeTime(settings.activityDigestTime) || '20:00';
  try{ if(typeof gdriveRefreshStatus === 'function') await gdriveRefreshStatus(); }catch(e){}
  activityDigestRenderStatus();
}

function activityDigestRenderStatus(){
  const el = adEl('activity-digest-status');
  const hint = adEl('activity-digest-mail-hint');
  const enabled = adEnabled();
  const to = (typeof settings !== 'undefined' && settings) ? String(settings.activityDigestTo || '').trim() : '';
  const canSend = (typeof gdriveCanSendMail === 'function') ? gdriveCanSendMail() : false;

  if(hint) hint.style.display = canSend ? 'none' : '';

  if(!el) return;
  if(!enabled){
    el.textContent = '⏸️ الإرسال معطّل — فعّل الخيار وحدّد البريد والوقت ثم اضغط "حفظ الإعدادات".';
    return;
  }
  if(!to){
    el.textContent = '⚠️ الإرسال مفعّل لكن لم تحدّد بريد المستلم بعد.';
    return;
  }
  let txt = '✅ الإرسال مفعّل — يومياً الساعة ' + (adNormalizeTime(settings.activityDigestTime) || '20:00') + ' إلى: ' + to;
  txt += ' — عمليات بانتظار الإرسال: ' + adLoadQueue().length;
  const lastMeta = adLoadLastSent();
  if(lastMeta && lastMeta.at){
    let atLabel = lastMeta.date || '';
    try{ atLabel = new Date(lastMeta.at).toLocaleString('ar-EG'); }catch(e){}
    txt += ' — آخر إرسال: ' + atLabel;
  }
  el.textContent = txt;
}

async function activityDigestSave(){
  if(typeof settings === 'undefined' || !settings) return;
  const enEl = adEl('activity-digest-enabled');
  const toEl = adEl('activity-digest-to');
  const tmEl = adEl('activity-digest-time');
  const enabled = !!(enEl && enEl.checked);
  const to = toEl ? String(toEl.value || '').trim() : '';
  const time = adNormalizeTime(tmEl ? tmEl.value : '') || '20:00';
  settings.activityDigestEnabled = enabled;
  settings.activityDigestTo = to;
  settings.activityDigestTime = time;
  try{
    if(typeof saveSettings === 'function') await saveSettings();
    if(typeof showToast === 'function') showToast('تم حفظ إعدادات ملخّص الإيميل ✅');
  }catch(e){
    if(typeof showToast === 'function') showToast('تعذّر حفظ الإعدادات');
  }
  activityDigestRenderStatus();
}

async function activityDigestClear(){
  const q = adLoadQueue();
  if(!q.length){
    if(typeof showToast === 'function') showToast('الطابور فارغ بالفعل');
    return;
  }
  let ok = true;
  if(typeof customConfirm === 'function'){
    ok = await customConfirm('تفريغ طابور الملخّص؟ لن تُرسَل العمليات المتراكمة حالياً (' + q.length + ' عملية).');
  }
  if(!ok) return;
  adSaveQueue([]);
  activityDigestRenderStatus();
  if(typeof showToast === 'function') showToast('تم تفريغ طابور الملخّص 🗑️');
}

function initActivityDigest(){
  const bs = adEl('btn-activity-digest-save');
  if(bs) bs.addEventListener('click', activityDigestSave);
  const bn = adEl('btn-activity-digest-send-now');
  if(bn) bn.addEventListener('click', function(){ activityDigestSend(true); });
  const bc = adEl('btn-activity-digest-clear');
  if(bc) bc.addEventListener('click', activityDigestClear);
  const bconnect = adEl('btn-activity-digest-connect');
  if(bconnect) bconnect.addEventListener('click', function(){ if(typeof gdriveConnect === 'function') gdriveConnect(); });

  if(_activityDigestTimer) clearInterval(_activityDigestTimer);
  _activityDigestTimer = setInterval(activityDigestTick, ACTIVITY_DIGEST_TICK_MS);
  try{ activityDigestRenderStatus(); }catch(e){}
}

window.activityDigestEnqueue = activityDigestEnqueue;
window.activityDigestRenderPanel = activityDigestRenderPanel;

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', initActivityDigest);
} else {
  initActivityDigest();
}
