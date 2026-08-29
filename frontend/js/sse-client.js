/* ---------------- استقبال الأحداث اللحظية (SSE) ----------------
   اتصال مفتوح مع /api/events/stream: أي تعديل/حذف/اعتماد يحدث من مستخدم آخر (استقبال أو أدمن)
   يصل هنا فوراً كإشعار خفيف "حدث تغيير"، فنشغّل backgroundSyncCheck() فى نفس اللحظة بدل انتظار
   الفحص الدوري كل دقيقتين (module-purchases.js). الفحص الدوري نفسه يبقى كما هو دون أي تعديل،
   فيعمل كخط رجعة تلقائي فى حال انقطع اتصال SSE مؤقتاً (EventSource يعيد المحاولة بنفسه، لكن
   لو تعذّر الاتصال بالكامل لفترة، الفحص الدوري يضمن عدم بقاء الشاشة قديمة لأكثر من دقيقتين). */
let _sseConnection = null;
let _sseDebounceTimer = null;
let _visibilityDebounceTimer = null;

// تجميع عدة أحداث متقاربة (مثال: استيراد جماعي يولّد عشرات إشعارات التغيير خلال ثوانٍ) فى فحص
// مزامنة واحد بدل فحص منفصل لكل حدث — فرق التأخير (300ms) لا يُلاحَظ من المستخدم إطلاقاً.
function _onRealtimeRecordChanged(){
  clearTimeout(_sseDebounceTimer);
  _sseDebounceTimer = setTimeout(()=>{
    if(typeof backgroundSyncCheck === 'function') backgroundSyncCheck().catch(()=>{});
  }, 300);
}

function connectRealtimeEvents(){
  try{
    if(!SERVER_AUTH_TOKEN) return; // وضع العمل من الجهاز فقط (بلا سيرفر) — لا شيء نتصل به
    disconnectRealtimeEvents(); // إغلاق أي اتصال سابق قبل فتح واحد جديد (تفادي اتصالات مكرّرة)
    _sseConnection = new EventSource(API_BASE + '/api/events/stream?token=' + encodeURIComponent(SERVER_AUTH_TOKEN));
    _sseConnection.addEventListener('record-changed', _onRealtimeRecordChanged);
    // لا حاجة لمعالجة onerror يدوياً: EventSource يعيد الاتصال تلقائياً بنفسه بعد أي انقطاع
    // (بروتوكول SSE قياسي)، والفحص الدوري كل دقيقتين يبقى شغّالاً كخط رجعة أثناء أي انقطاع مؤقت.
  }catch(e){ console.error('[SSE] فشل فتح اتصال البث اللحظي:', e); }
}

function disconnectRealtimeEvents(){
  try{ if(_sseConnection) _sseConnection.close(); }catch(e){}
  _sseConnection = null;
}

// ثغرة كانت موجودة: لو تاب المستخدم فضل مفتوح بعيداً عن الشاشة لفترة (مثال: أدمن سايب الجهاز)
// واتقطع اتصال SSE فى الخلفية (نوم السيرفر على استضافة مجانية بعد خمول، أو أي انقطاع شبكة
// مؤقت)، كان المستخدم يرجع للتاب فيلاقي شاشة قديمة، ولا يعرف إلا لو استنى للفحص الدوري
// (دقيقتين) أو عمل تحديث يدوي بنفسه. الحل: أول ما التاب يرجع مرئياً (visibilitychange)، نُشغّل
// فحص مزامنة فوري فى نفس اللحظة — وأيضاً نتأكد أن اتصال SSE نفسه ما زال مفتوحاً (لو أُغلق تماماً
// دون أن يعيد EventSource فتحه لأي سبب) ونعيد فتحه احتياطاً.
// 
// تحسين: أضفنا debounce (500ms) على restore من minimize — المتصفح يحتاج وقت صغير ليستعيد تركيزه
// الكامل قبل تشغيل مزامنة ثقيلة (renderAllViewsAfterLoad)، وإلا يحدث lag ملحوظ أول ثانية.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState !== 'visible') return;
  
  clearTimeout(_visibilityDebounceTimer);
  _visibilityDebounceTimer = setTimeout(() => {
    if(typeof backgroundSyncCheck === 'function') backgroundSyncCheck().catch(()=>{});
    if(SERVER_AUTH_TOKEN && (!_sseConnection || _sseConnection.readyState === EventSource.CLOSED)){
      connectRealtimeEvents();
    }
  }, 500);
});
