/* ---------------- بث الأحداث اللحظية (Server-Sent Events) ----------------
   قناة اتجاه واحد (سيرفر → متصفح) تبقى مفتوحة طوال الجلسة، تُستخدم لإشعار كل الأجهزة
   المتصلة فوراً بأي تعديل/حذف/اعتماد يحدث من أي مستخدم آخر (استقبال أو أدمن)، بدل انتظار
   الفحص الدوري كل دقيقتين (backgroundSyncCheck فى الواجهة). لا تُنقَل أي بيانات فعلية عبر
   هذه القناة — فقط إشارة خفيفة "حدث تغيير فى كذا"، والفرونت هو من يقرر بعدها ماذا يجلب
   فعلياً عبر نفس نقاط الوصول المعتادة (التي تفرض صلاحيات الرؤية أصلاً). هذا يبسّط الأمر:
   لا حاجة لتصفية حسب الدور هنا فى السيرفر، لأن أي بيانات فعلية تُجلَب لاحقاً بنفس الحراسة
   الموجودة أصلاً على /api/client-records و /api/records/:collection. */

// clientId -> { res, user: { username, role } }
const clients = new Map();
let nextId = 1;

function addClient(res, user) {
  const id = nextId++;
  clients.set(id, { res, user });
  return id;
}

function removeClient(id) {
  clients.delete(id);
}

// بث حدث تغيير سجل لكل المستخدمين المتصلين حالياً (كل الأدوار)، ما عدا صاحب العملية نفسه
// (actorUsername) لو مُرِّر — جهازه هو بالفعل حدّث حالته محلياً بنجاح طلبه هو، فلا داعي
// لإشعاره بتغييره هو لنفسه.
function broadcastRecordChanged({ collection, actorUsername } = {}) {
  const payload = JSON.stringify({ collection: collection || null, ts: Date.now() });
  for (const [id, c] of clients) {
    if (actorUsername && c.user.username === actorUsername) continue;
    try {
      c.res.write(`event: record-changed\ndata: ${payload}\n\n`);
    } catch (e) {
      clients.delete(id);
    }
  }
}

// نبضة حياة دورية لكل الاتصالات المفتوحة: تمنع أي وسيط شبكي (بما فى ذلك Render نفسها) من
// اعتبار الاتصال خاملاً وقطعه بصمت بعد بضع دقائق بلا أي بيانات متبادلة عبره.
setInterval(() => {
  for (const [id, c] of clients) {
    try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(id); }
  }
}, 30000);

module.exports = { addClient, removeClient, broadcastRecordChanged, clients };
