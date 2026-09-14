/* ---------------- استقبال الأحداث اللحظية (SSE) ----------------
   اتصال مفتوح مع /api/events/stream: أي تعديل/حذف/اعتماد يحدث من مستخدم آخر (استقبال أو أدمن)
   يصل هنا فوراً كإشعار خفيف "حدث تغيير"، فنشغّل backgroundSyncCheck() فى نفس اللحظة بدل انتظار
   الفحص الدوري كل دقيقتين (module-purchases.js). الفحص الدوري نفسه يبقى كما هو دون أي تعديل،
   فيعمل كخط رجعة تلقائي فى حال انقطع اتصال SSE مؤقتاً — ثم يُعاد فتح الاتصال تلقائياً أيضاً
   بفاصل متنامٍ (2 ثانية → 60 ثانية كحد أقصى) مهما طال الانقطاع.
   ملاحظة أمنية: نستخدم fetch بدل EventSource لأن الأخير لا يسمح بترويسات مخصّصة أبداً، فكان
   توكن الجلسة يُمرَّر عبر query string ويظهر تسجيله عند أي وسيط شبكي — الآن يُرسل عبر ترويسة
   Authorization القياسية مثل بقية طلبات البرنامج، فلا يظهر توكن الجلسة في أي عنوان URL إطلاقاً. */
let _sseAbort = null;
let _sseDebounceTimer = null;
let _visibilityDebounceTimer = null;
let _sseRetryTimer = null;
let _sseRetryDelay = 2000;
let _sseActive = false;

// تجميع عدة أحداث متقاربة (مثال: استيراد جماعي يولّد عشرات إشعارات التغيير خلال ثوانٍ) فى فحص
// مزامنة واحد بدل فحص منفصل لكل حدث — فرق التأخير (300ms) لا يُلاحَظ من المستخدم إطلاقاً.
function _onRealtimeRecordChanged(){
  clearTimeout(_sseDebounceTimer);
  _sseDebounceTimer = setTimeout(()=>{
    if(typeof backgroundSyncCheck === 'function') backgroundSyncCheck().catch(()=>{});
  }, 300);
}

function _scheduleReconnect(){
  clearTimeout(_sseRetryTimer);
  _sseRetryTimer = setTimeout(()=>{ _openSseStream().catch(()=>{}); }, _sseRetryDelay);
  _sseRetryDelay = Math.min(60000, _sseRetryDelay * 2);
}

// حلقة قراءة تيار SSE عبر fetch: تُصدِّر الترويسة القياسية Authorization وتفكّ كتل الأحداث المفصولة
// بـ "\n\n" (كل كتلة: سطور، منها النوع `event: record-changed` وبيانات `data:` ونبضات القلب `: ping`
// التي نتجاهلها). عند انتهاء أو انقطاع التيار نُجدوِل إعادة الاتصال بفاصل متنامٍ ما لم يكن إغلاقاً
// متعمداً (disconnectRealtimeEvents عرّضنا AbortController للإلغاء).
async function _openSseStream(){
  if(!SERVER_AUTH_TOKEN) return; // وضع العمل من الجهاز فقط (بلا سيرفر) — لا شيء نتصل به
  const ctrl = new AbortController();
  _sseAbort = ctrl;
  _sseActive = true;
  try{
    const res = await fetch(API_BASE + '/api/events/stream', {
      headers: { 'Authorization': 'Bearer ' + SERVER_AUTH_TOKEN, 'Accept': 'text/event-stream' },
      signal: ctrl.signal,
    });
    if(!res.ok || !res.body) throw new Error('SSE handshake failed: ' + res.status);
    _sseRetryDelay = 2000; // اتصال ناجح — إعادة المحاولة القادمة (لو حصل انقطاع) تبدأ من البداية
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for(;;){
      const { done, value } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while((sep = buffer.indexOf('\n\n')) !== -1){
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let isRecordChanged = false;
        for(const line of block.split('\n')){
          if(line.startsWith('event:') || line.startsWith('event :')){
            if(line.slice(line.indexOf(':') + 1).trim() === 'record-changed') isRecordChanged = true;
          }
        }
        if(isRecordChanged) _onRealtimeRecordChanged();
      }
    }
  }catch(e){
    if(ctrl.signal.aborted) return; // إغلاق متعمد — لا نعيد الاتصال
  }
  _sseActive = false;
  _sseAbort = null;
  if(!ctrl.signal.aborted) _scheduleReconnect();
}

function connectRealtimeEvents(){
  try{
    if(!SERVER_AUTH_TOKEN) return;
    disconnectRealtimeEvents(); // إغلاق أي اتصال سابق قبل فتح واحد جديد (تفادي اتصالات مكرّرة)
    _openSseStream().catch(()=>{});
  }catch(e){ console.error('[SSE] فشل فتح اتصال البث اللحظي:', e); }
}

function disconnectRealtimeEvents(){
  clearTimeout(_sseRetryTimer);
  _sseRetryDelay = 2000;
  if(_sseAbort){ _sseAbort.abort(); _sseAbort = null; }
  _sseActive = false;
}

// ثغرة كانت موجودة: لو تاب المستخدم فضل مفتوح بعيداً عن الشاشة لفترة (مثال: أدمن سايب الجهاز)
// واتقطع اتصال SSE فى الخلفية (نوم السيرفر على استضافة مجانية بعد خمول، أو أي انقطاع شبكة
// مؤقت)، كان المستخدم يرجع للتاب فيلاقي شاشة قديمة، ولا يعرف إلا لو استنى للفحص الدوري
// (دقيقتين) أو عمل تحديث يدوي بنفسه. الحل: أول ما التاب يرجع مرئياً (visibilitychange)، نُشغّل
// فحص مزامنة فوري فى نفس اللحظة — وأيضاً نتأكد أن اتصال SSE نفسه ما زال مفتوحاً (لو أُغلق تماماً
// لأي سبب) ونعيد فتحه احتياطاً.
//
// تحسين: أضفنا debounce (500ms) على restore من minimize — المتصفح يحتاج وقت صغير ليستعيد تركيزه
// الكامل قبل تشغيل مزامنة ثقيلة (renderAllViewsAfterLoad)، وإلا يحدث lag ملحوظ أول ثانية.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible') return;

  clearTimeout(_visibilityDebounceTimer);
  _visibilityDebounceTimer = setTimeout(() => {
    if(typeof backgroundSyncCheck === 'function') backgroundSyncCheck().catch(()=>{});
    if(SERVER_AUTH_TOKEN && !_sseActive){
      connectRealtimeEvents();
    }
  }, 500);
});