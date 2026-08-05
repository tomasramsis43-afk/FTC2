// ============================================================
// الدفع الإلكتروني (Moyasar) — إنشاء روابط دفع مستضافة + استقبال webhook
// ============================================================
// ⚠️ هذا الملف يبني على توثيق Moyasar كما هو معروف وقت كتابة هذا الكود.
// تحقق دائماً من https://docs.moyasar.com قبل الإطلاق الفعلي، فأسماء الحقول
// أو مسارات الـ API قد تتغيّر — خصوصاً آلية التحقق من توقيع الـ webhook أدناه.
//
// الفكرة: نستخدم "Moyasar Invoices API" بدل بناء فورم دفع بأنفسنا — بيرجع
// رابط صفحة دفع مستضافة عند Moyasar نفسها (Hosted Checkout)، فبيانات الكارت
// الحساسة (PCI DSS) ماتلمسش سيرفرنا إطلاقاً.

const { pool } = require('./db');
const crypto = require('crypto');

const MOYASAR_SECRET_KEY = process.env.MOYASAR_SECRET_KEY;
const MOYASAR_WEBHOOK_SECRET = process.env.MOYASAR_WEBHOOK_SECRET;
// رابط السيرفر العام (بدون / في النهاية) — يُستخدم لبناء callback_url اللي
// Moyasar بترجّع المستخدم له بعد الدفع (نجاح أو فشل).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function assertConfigured() {
  if (!MOYASAR_SECRET_KEY) {
    const e = new Error('MOYASAR_SECRET_KEY غير مضبوط في متغيّرات البيئة');
    e.isValidation = true;
    throw e;
  }
  if (!PUBLIC_BASE_URL) {
    const e = new Error('PUBLIC_BASE_URL غير مضبوط في متغيّرات البيئة');
    e.isValidation = true;
    throw e;
  }
}

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * ينشئ رابط دفع جديد ويسجّله في online_payments بحالة 'created'، ثم يناديه
 * فعلياً من Moyasar وينشئ الفاتورة، ويحدّث الصف بـ gateway_id وrapt checkout_url.
 * clientRef/clientLabel اختياريان (لربط الدفعة بعميل معيّن لاحقاً عند التطبيق).
 */
async function createPaymentLink({ clientRef, clientLabel, amount, description, createdBy }) {
  assertConfigured();
  const amt = Number(amount);
  if (!amt || amt <= 0) {
    const e = new Error('المبلغ غير صالح');
    e.isValidation = true;
    throw e;
  }
  const id = genId();
  const callbackUrl = `${PUBLIC_BASE_URL}/api/payments/${id}/return`;

  const res = await fetch('https://api.moyasar.com/v1/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Basic auth: secret_key كـ username وكلمة مرور فارغة (نمط Moyasar المعتاد).
      Authorization: 'Basic ' + Buffer.from(`${MOYASAR_SECRET_KEY}:`).toString('base64'),
    },
    body: JSON.stringify({
      amount: Math.round(amt * 100), // Moyasar يتعامل بالهللة (أصغر وحدة عملة)
      currency: 'SAR',
      description: description || 'دفعة عبر الإنترنت',
      callback_url: callbackUrl,
      metadata: { internal_id: id, client_ref: clientRef || '' },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const e = new Error(data?.message || 'تعذّر إنشاء رابط الدفع عند البوابة');
    e.detail = data;
    throw e;
  }

  await pool.query(
    `INSERT INTO online_payments
       (id, client_ref, client_label, amount, currency, description, gateway, gateway_id, checkout_url, status, created_by)
     VALUES ($1,$2,$3,$4,'SAR',$5,'moyasar',$6,$7,'created',$8)`,
    [id, clientRef || null, clientLabel || null, amt, description || null, data.id, data.url, createdBy || null]
  );

  return { id, checkoutUrl: data.url, gatewayId: data.id };
}

/** يتحقق من صحة التوقيع/السر المرسل مع webhook Moyasar قبل الوثوق بأي بيانات فيه. */
function verifyWebhookSecret(payload) {
  if (!MOYASAR_WEBHOOK_SECRET) return false;
  // Moyasar يرسل secret_token في جسم الـ webhook نفسه، تضبطه أنت مسبقاً من
  // لوحة التحكم عند تفعيل الـ webhook — قارنه بأمان (timing-safe) مع القيمة عندنا.
  const sent = String(payload?.secret_token || '');
  const expected = String(MOYASAR_WEBHOOK_SECRET);
  if (sent.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

/** يعالج حدث webhook قادم من Moyasar (دفعة نجحت/فشلت) ويحدّث حالة الصف عندنا. */
async function handleWebhookEvent(payload) {
  if (!verifyWebhookSecret(payload)) {
    const e = new Error('webhook secret غير صحيح');
    e.isValidation = true;
    throw e;
  }
  const data = payload?.data || {};
  const internalId = data?.metadata?.internal_id;
  const gatewayId = data?.id;
  if (!internalId && !gatewayId) return { updated: false };

  // status عند Moyasar للفاتورة/العملية: 'paid' يعني نجح الدفع فعلاً.
  const paid = data?.status === 'paid';
  const result = await pool.query(
    `UPDATE online_payments
       SET status = CASE WHEN $3 THEN 'paid' ELSE 'failed' END,
           raw_event = $4,
           paid_at = CASE WHEN $3 THEN now() ELSE paid_at END
     WHERE id = $1 OR gateway_id = $2
     RETURNING id`,
    [internalId || null, gatewayId || null, paid, JSON.stringify(payload)]
  );
  return { updated: result.rowCount > 0 };
}

/** الدفعات اللي نجحت ("paid") ولسه محدش طبّقها كقيد داخل التطبيق. */
async function listPending() {
  const r = await pool.query(
    `SELECT id, client_ref, client_label, amount, currency, description,
            gateway, gateway_id, status, created_at, paid_at
     FROM online_payments
     WHERE status = 'paid' AND applied_at IS NULL
     ORDER BY paid_at ASC
     LIMIT 200`
  );
  return r.rows;
}

/** يعلّم دفعة بأنها اتطبّقت فعلياً كقيد محلي (حتى لا تُطبَّق مرتين من جهازين). */
async function markApplied(id, appliedBy) {
  const r = await pool.query(
    `UPDATE online_payments
       SET status = 'applied', applied_at = now(), applied_by = $2
     WHERE id = $1 AND status = 'paid'
     RETURNING id`,
    [id, appliedBy || null]
  );
  return r.rowCount > 0;
}

async function getPayment(id) {
  const r = await pool.query(`SELECT * FROM online_payments WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

module.exports = { createPaymentLink, handleWebhookEvent, listPending, markApplied, getPayment };
