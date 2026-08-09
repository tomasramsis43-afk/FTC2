/* ---------------- استقبال الأحداث اللحظية (SSE) ----------------
   اتصال مفتوح مع /api/events/stream: أي تعديل/حذف/اعتماد يحدث من مستخدم آخر (استقبال أو أدمن)
   يصل هنا فوراً كإشعار خفيف "حدث تغيير"، فنشغّل backgroundSyncCheck() فى نفس اللحظة بدل انتظار
   الفحص الدوري كل دقيقتين (module-purchases.js). الفحص الدوري نفسه يبقى كما هو دون أي تعديل،
   فيعمل كخط رجعة تلقائي فى حال انقطع اتصال SSE مؤقتاً (EventSource يعيد المحاولة بنفسه، لكن
   لو تعذّر الاتصال بالكامل لفترة، الفحص الدوري يضمن عدم بقاء الشاشة قديمة لأكثر من دقيقتين). */
let _sseConnection = null;
let _sseDebounceTimer = null;

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
