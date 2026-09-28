/* ---------------- بث الأحداث اللحظية (Server-Sent Events) ----------------
   قناة اتجاه واحد (سيرفر → متصفح) تبقى مفتوحة طوال الجلسة، تُستخدم لإشعار كل الأجهزة
   المتصلة فوراً بأي تعديل/حذف/اعتماد يحدث من أي مستخدم آخر (استقبال أو أدمن)، بدل انتظار
   الفحص الدوري كل دقيقتين (backgroundSyncCheck فى الواجهة). لا تُنقَل أي بيانات فعلية عبر
   هذه القناة — فقط إشارة خفيفة "حدث تغيير فى كذا"، والفرونت هو من يقرر بعدها ماذا يجلب
   فعلياً عبر نفس نقاط الوصول المعتادة (التي تفرض صلاحيات الرؤية أصلاً). هذا يبسّط الأمر:
   لا حاجة لتصفية حسب الدور هنا فى السيرفر، لأن أي بيانات فعلية تُجلَب لاحقاً بنفس الحراسة
   الموجودة أصلاً على /api/client-records و /api/records/:collection.

   ── ملاحظة الذاكرة ──
   كل اتصال مفتوح يحمل مقبس (socket) في ذاكرة السيرفر طوال بقائه مفتوحاً. بلا سقف، تكفي
   موجة من الروابط/المتصفحات القديمة (أو اتصال مفتوح بلا قراءة) لرفع استهلاك الذاكرة حتى
   إسقاط النسخة — وهو أخطر ما يواجه استضافة مجانية محدودة الذاكرة. لذلك ثلاثة ضوابط:
     ١) سقف صريح لعدد الاتصالات المفتوحة (يُرفض الزائد بـ 503 قبل فتح الترويسات).
     ٢) طرد المستهلكين البطيئين (backpressure) بدل استمرار التراكم بلا فائدة.
     ٣) تنظيف دوري للوصلات الميتة التي لا يُبلّغ عنها req 'close' (انقطاع شبكة صامت).
   الثلاثة آمنة وظيفياً: الواجهة تعيد فتح القناة تلقائياً (EventSource) وتعمل مزامنة
   كاملة بالفرق عند إعادة الاتصال، فلا يُفقد أي تعديل. */

// clientId -> { res, user: { username, role }, slowHits }
const clients = new Map();
let nextId = 1;

// سقف الاتصالات المفتوحة في الوقت نفسه — قابل للضبط، والافتراضي متحفّظ
// (الاستخدام الفعلي عشرات الاتصال لا مئات؛ 500 يبقى تحت أي حدّ استضافة معقول).
const MAX_CLIENTS = Number(process.env.SSE_MAX_CLIENTS || 500);
// عدد المرات المتتالية التي يبقى فيها مخزن الإرسال ممتلئاً قبل طرد المستهلك البطيء.
const SLOW_CLIENT_MAX_HITS = 3;

/** هل بقي مكان لاتصال جديد؟ (يُفحص قبل writeHead ليمكن ردّ 503 بشكل صحيح). */
function canAcceptClient() {
  return clients.size < MAX_CLIENTS;
}

function currentCount() {
  return clients.size;
}

function addClient(res, user) {
  // حارس ثانٍ (المسار يفحص canAcceptClient قبل فتح الترويسات) — لا نتجاوز السقف أبداً.
  if (clients.size >= MAX_CLIENTS) return null;
  const id = nextId++;
  clients.set(id, { res, user, slowHits: 0 });
  return id;
}

function removeClient(id) {
  clients.delete(id);
}

/**
 * كتابة إلى اتصال مع مراقبة الضغط (backpressure).
 * res.write() يرجع false حين يمتلئ مخزن Node الداخلي، أي أن العميل لم يقرأ.
 * الاستمرار في الكتابة عندها = ذاكرة تنمو بلا سقف (كل رسالة تنضاف للطابور). فنعدّ
 * الضغط، وبعد عدة نبضات متتالية نطرد الاتصال البطيء: الواجهة تعيد فتحه تلقائياً وتزامن
 * بالفرق، فلا تضيع أي رسالة (هي إشارة "تغيّر شيء" لا بيانات).
 * @returns {boolean} false إذا طُرد الاتصال
 */
function writeTo(id, c, chunk) {
  // اتصال ميت لم يُبلّغ عنه req 'close' (انقطاع شبكة صامت) — لا نكتب له ولا نبقيه في الذاكرة.
  if (c.res.writableEnded || c.res.destroyed) {
    clients.delete(id);
    return false;
  }
  let ok;
  try {
    ok = c.res.write(chunk);
  } catch (e) {
    clients.delete(id);
    return false;
  }
  if (ok) {
    c.slowHits = 0;
    return true;
  }
  c.slowHits = (c.slowHits || 0) + 1;
  if (c.slowHits >= SLOW_CLIENT_MAX_HITS) {
    try { c.res.destroy(); } catch (e) { /* مقبس مغلق أصلاً */ }
    clients.delete(id);
    return false;
  }
  return true;
}

// بث حدث تغيير سجل لكل المستخدمين المتصلين حالياً (كل الأدوار)، ما عدا صاحب العملية نفسه
// (actorUsername) لو مُرِّر — جهازه هو بالفعل حدّث حالته محلياً بنجاح طلبه هو، فلا داعي
// لإشعاره بتغييره هو لنفسه.
function broadcastRecordChanged({ collection, actorUsername } = {}) {
  const payload = JSON.stringify({ collection: collection || null, ts: Date.now() });
  for (const [id, c] of clients) {
    if (actorUsername && c.user.username === actorUsername) continue;
    writeTo(id, c, `event: record-changed\ndata: ${payload}\n\n`);
  }
}

// نبضة حياة دورية لكل الاتصالات المفتوحة: تمنع أي وسيط شبكي (بما فى ذلك Render نفسها) من
// اعتبار الاتصال خاملاً وقطعه بصمت بعد بضع دقائق بلا أي بيانات متبادلة عبره.
// وهي أيضاً回合ية التنظيف: أي اتصال ميت/مُبطأ يُكشف هنا ويُزال من الخريطة بدل البقاء
// في الذاكرة بلا فائدة.
setInterval(() => {
  for (const [id, c] of clients) {
    writeTo(id, c, ': ping\n\n');
  }
}, 30000);

module.exports = {
  addClient, removeClient, broadcastRecordChanged, clients,
  canAcceptClient, currentCount, MAX_CLIENTS,
};
