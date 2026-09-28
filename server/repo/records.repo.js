// ============================================================
// records.repo.js — طبقة الوصول لسجلات العملاء (client_records)
// والسجلات العامة (collection_records) — Data Access Layer
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بنظام "السجلات المستقلة" مُجمَّعة هنا.
// السلوك مطابق 100% لما كان داخل routes/records.js — نقل ميكانيكي فقط
// (بما في ذلك منطق المعاملات في الرفع المجمّع).
// ============================================================
const { pool } = require('../db');

// حارس أمان لاتساق SQL: يتأكد أن كل placeholder (مثل $2, $3) في whereClause له قيمة مقابلة
// في params — أي أن عدد الـ placeholders المميزة يساوي عدد القيم الممررة. يمنع في مرحلة
// التطوير (قبل ضرب قاعدة البيانات) الصنف كاملاً من الأخطاء التي كانت تتحول إلى خطأ PG خام
// 500 — مثال حقيقي: حذف جماعي لموظف عام كان يمرر whereClause 'AND status = $2 AND
// created_by = $3' مع `params` بقيمة واحدة فقط، فيفشل كل طلب بخطأ "مؤشر معامل خارج المدى".
// نعدد المؤشرات المميزة (وليس الفهرس الأقصى) لأن $1 يستخدمه القائد الرئيسي في السؤال،
// فيكتب whereClause عادة من $2 فصاعداً عبر مصفوفة فارغة/بسيطة.
function validateWhereParams(whereClause, params) {
  if (!whereClause) return;
  const indices = whereClause.match(/\$([1-9]\d*)/g) || [];
  const expectedCount = new Set(indices).size;
  const given = Array.isArray(params) ? params.length : 0;
  if (expectedCount !== given) {
    throw new Error(
      `تضارب في عدد مؤشرات SQL (${expectedCount}) مع عدد القيم الممررة (${given}) في whereClause: ${whereClause}`
    );
}
}

/* ========================== client_records ========================== */

// جلب كل السجلات (مع فلترة رؤية + ترقيم اختياري + جلب فروق ids=)
async function clientRecords({ where, params, page, pageSize, ids }) {
  let sql = `SELECT id, enc, version, origin, status FROM client_records ${where}`;
  const sqlParams = [...params];
  let hasWhere = /\bwhere\b/i.test(where);
  if (Array.isArray(ids) && ids.length) {
    sql += ` ${hasWhere ? 'AND' : 'WHERE'} id = ANY($${sqlParams.length + 1}::text[])`;
    sqlParams.push(ids);
    hasWhere = true;
  }
  // الترتيب موحّد بين مسار الترقيم ومسار الجلب الكامل (ORDER BY id ASC) عن قصد:
  //  1) الاتساق: لو اختلف الترتيب بين page وغير page لتغيّر محتوى الصفحة نفسها باختلاف
  //     طريقة الجلب، فتفقد الواجهة سجلات أو تكررها عند المزج بين المسارين.
  //  2) الثبات: id مفتاح أساسي لا يتغيّر أبداً، بينما version يتغيّر مع كل تعديل على السجل،
  //     فترتيب الصفحات على version يجعل حدود الصفحات "تنزلق" أثناء الترقيم (تكرار/سقوط صفوف).
  //  3) بلا فهرس جديد: id هو PRIMARY KEY أصلاً، فالفهرس موجود بالفعل — لا نضيف فهرساً جديداً
  //     لمجرد دعم الترقيم (زيادة فهرس = مساحة + تكلفة كتابة على كل UPDATE لـ version).
  if (Number.isInteger(page) && page >= 1) {
    sql += ` ORDER BY id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
    sqlParams.push(pageSize, (page - 1) * pageSize);
  } else {
    // ترتيب ثابت ومحدد لكل جلبات الصفحات الكاملة وجلب الفروق ids= — بلا ORDER BY كان ترتيب
    // الصفوف من قاعدة البيانات ترتيبًا فيزيائيًا (heap order) غير مضمون، فيتغير نفس السجل
    // موقعه من جلسة لجلسة بعد أي UPDATE/DELETE/VACUUM — سبب "الترتيب بيتغيّر لوحده".
    sql += ` ORDER BY id ASC`;
  }
  const r = await pool.query(sql, sqlParams);
  return r.rows;
}

// أزواج (id, version) لكل عملاء — للتحقق الدوري الخفيف (delta)
async function clientVersionPairs({ where, params }) {
  const r = await pool.query(`SELECT id, version FROM client_records ${where} ORDER BY id ASC`, params);
  return r.rows.map(row => [row.id, Number(row.version)]);
}

// رقم إصدار مجمّع + عدّ — للتحقق السريع من وجود تعديل من جهاز آخر
async function clientAggVersion({ where, params }) {
  const r = await pool.query(`SELECT COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM client_records ${where}`, params);
  return { version: Number(r.rows[0].v), count: r.rows[0].c };
}

// قائمة (id, client_id) لفحص تكرار أرقام الهوية (يعالج التجزئة في المتصل)
// ملحوظة: هذا الاستعلام له شرط WHERE ثابت خاص به (client_id IS NOT NULL...)، بينما `where`
// القادم من clientRecordsVisibilitySql هو شرط WHERE كامل (يبدأ بـ"WHERE") مُعدّ أصلاً للإلصاق
// مباشرة بعد "FROM client_records" بلا أي شرط سابق (راجع clientRecords/clientVersionPairs
// أعلاه). إلحاقه هنا كما هو كان ينتج "WHERE ... WHERE ..." (شرطان متتاليان) فيفشل الاستعلام
// بخطأ SQL قاتل (500) لأي دور غير admin (حيث where فارغ فقط فى حالة admin). الإصلاح: تحويل
// "WHERE" فى البداية إلى "AND" ليُلحق بشرط الجدول الموجود مسبقاً بدل تكراره.
async function clientIdPairs({ where, params }) {
  const andFragment = where ? where.replace(/^\s*WHERE\s+/i, 'AND ') : '';
  const r = await pool.query(`SELECT id, client_id FROM client_records WHERE client_id IS NOT NULL AND client_id <> '' ${andFragment}`, params);
  return r.rows;
}

// جلب سجل عميل واحد (لحماية العزل قبل التعديل/الحذف)
async function clientRecordMetaFor(id) {
  const r = await pool.query('SELECT origin, created_by, status, version, enc FROM client_records WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// حفظ/تعديل عميل واحد بنمط Optimistic Concurrency
// يرجع { updated, version, origin, status, current? } — updated=false عند تعارض
async function clientUpsert({ id, enc, knownVersion, username, origin, status, clientId }) {
  const upsert = await pool.query(
    `INSERT INTO client_records (id, enc, version, updated_by, origin, status, created_by, client_id)
     VALUES ($1, $2, 1, $3, $5, $6, $3, $7)
     ON CONFLICT (id) DO UPDATE SET
       enc = EXCLUDED.enc, version = client_records.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by, client_id = EXCLUDED.client_id
     WHERE client_records.version = $4
     RETURNING version, origin, status`,
    [id, enc, username, knownVersion, origin, status, clientId]
  );
  if (upsert.rows[0]) {
    return { updated: true, ...upsert.rows[0] };
  }
  const current = await pool.query('SELECT version, enc FROM client_records WHERE id = $1', [id]);
  return {
    updated: false,
    currentVersion: current.rows[0] ? current.rows[0].version : 0,
    currentEnc: current.rows[0] ? current.rows[0].enc : null,
  };
}

// اعتماد سجل استقبال معلّق
async function clientApprove(id) {
  const r = await pool.query(
    `UPDATE client_records SET status = 'confirmed', version = version + 1, updated_at = now()
     WHERE id = $1 AND origin = 'reception' AND status = 'pending'
     RETURNING id, version`,
    [id]
  );
  return r.rows[0] || null;
}

// رفض سجل استقبال معلّق (soft — يبقى rejected لمدة 15 يوماً)
async function clientReject(id) {
  const r = await pool.query(
    `UPDATE client_records SET status = 'rejected', rejected_at = now(), version = version + 1, updated_at = now()
     WHERE id = $1 AND origin = 'reception' AND status = 'pending'
     RETURNING id, version`,
    [id]
  );
  return r.rows[0] || null;
}

// حذف نهائي لسجلات العملاء المرفوضة بعد تجاوز مهلة الـ15 يوماً (job تنظيف دوري من server.js)
async function cleanRejectedClientRecords() {
  const r = await pool.query(`DELETE FROM client_records WHERE status = 'rejected' AND rejected_at < now() - INTERVAL '15 days'`);
  return r.rowCount;
}

// حذف عميل واحد (مع شرط عزل حسب الدور — يتم تمريره باسمول عبر whereClause)
async function clientDelete(id, whereClause, params) {
  let sql = 'DELETE FROM client_records WHERE id = $1';
  const allParams = [id];
  if (whereClause) { sql += ' ' + whereClause; allParams.push(...params); }
  await pool.query(sql, allParams);
}

// حذف ذرّي بفحص نسخة لغير منفصل (check-then-act داخل معاملة واحدة FOR UPDATE):
// يُقفَل صف السجل أولاً، يُقارَن رقمة النسخة المتوقَّعة (إن وُجدت) بنفس القفل، ثم يُختبر
// شرط السماح (allowFor) على بيانات الصف المقفول — فتُحسم تعارضات PUT/DELETE المتزامنة
// (TOCTOU) نهائياً: لا يمكن بعد الآن أن يحذف طلبٌ سجلاً "على أساس نسخة 5" بينما نسخة 6
// تُحفظ من جهاز آخر في نفس اللحظة (كان الفرق بين الفحص والحذف نافذةً يضيع فيها التحديث الأخير).
// النتائج:
//   { deleted:true }                            → حُذف فعلياً
//   { deleted:false, notFound:true }            → لا يوجد (يُعامَل كنجاح: حذف متكرر آمن)
//   { deleted:false, conflict:true, currentVersion } → تغيّر بعد آخر مشاهدة (409)
//   { deleted:false, forbidden:true }           → لا يملك المرسل حق حذفه (403)
async function deleteAtomic({ isClient, id, collection, expectedVersion, allowFor }) {
  const table = isClient ? 'client_records' : 'collection_records';
  const whereId = isClient ? 'id = $1' : 'collection = $1 AND id = $2';
  const idParams = isClient ? [id] : [collection, id];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT origin, status, created_by, version, enc FROM ${table} WHERE ${whereId} FOR UPDATE`,
      idParams
    );
    const row = sel.rows[0] || null;
    if (!row) {
      await client.query('COMMIT');
      return { deleted: false, notFound: true, currentVersion: null, currentEnc: null };
    }
    const currentVersion = Number(row.version);
    if (expectedVersion !== undefined && Number.isFinite(expectedVersion) && currentVersion !== expectedVersion) {
      await client.query('COMMIT');
      return { deleted: false, conflict: true, currentVersion, currentEnc: row.enc };
    }
    if (typeof allowFor === 'function' && !allowFor(row)) {
      await client.query('COMMIT');
      return { deleted: false, forbidden: true, currentVersion, currentEnc: row.enc };
    }
    await client.query(`DELETE FROM ${table} WHERE ${whereId}`, idParams);
    await client.query('COMMIT');
    return { deleted: true, currentVersion, currentEnc: row.enc };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// حذف عدة عملاء دفعة واحدة (مع شرط عزل) — يرجع عدد الصفوف المحذوفة فعلياً بعد تطبيق شرط العزل
async function clientBulkDelete(ids, whereClause, params) {
  let sql = 'DELETE FROM client_records WHERE id = ANY($1::text[])';
  const allParams = [ids];
  if (whereClause) {
    validateWhereParams(whereClause, params);
    sql += ' ' + whereClause; allParams.push(...params);
  }
  const r = await pool.query(sql, allParams);
  return r.rowCount || 0;
}

// حذف كل سجلات العملاء (إعادة ضبط مصنع)
async function clientDeleteAll() {
  await pool.query('DELETE FROM client_records');
}

/* ========================== collection_records ========================== */

// جلب سجلات تصنيف (مع فلترة رؤية + ترقيم + جلب فروق ids=)
async function recordsByCollection({ collection, where, params, page, pageSize, ids }) {
  let sql = `SELECT id, enc, version, origin, status FROM collection_records WHERE collection = $1 ${where}`;
  const sqlParams = [collection, ...params];
  if (Array.isArray(ids) && ids.length) {
    sql += ` AND id = ANY($${sqlParams.length + 1}::text[])`;
    sqlParams.push(ids);
  }
  // نفس مبدأ clientRecords أعلاه: ترتيب موحّد وثابت على id بين مسار الترقيم ومسار الجلب الكامل،
  // لئلا تنزلق حدود الصفحات (id ثابت، version يتغيّر مع كل تعديل) أو تختلف النتيجة بين المسارين.
  // composite PK (collection, id) يخدم هذا الترتيب مباشرةً — بلا فهرس جديد.
  if (Number.isInteger(page) && page >= 1) {
    sql += ` ORDER BY id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
    sqlParams.push(pageSize, (page - 1) * pageSize);
  } else {
    // نفس مبدأ الترتيب الثابت في clientRecords — راجع التعليق هناك
    sql += ` ORDER BY id ASC`;
  }
  const r = await pool.query(sql, sqlParams);
  return r.rows;
}

// أزواج (id, version) لتصنيف — للتحقق الدوري (delta)
async function recordVersionPairs(collection, where, params) {
  const sql = `SELECT id, version FROM collection_records WHERE collection = $1 ${where} ORDER BY id ASC`;
  const allParams = [collection, ...params];
  const r = await pool.query(sql, allParams);
  return r.rows.map(row => [row.id, Number(row.version)]);
}

// رقم إصدار مجمّع لكل التصنيفات (WHERE اختياري حسب دور المستخدم) — لمزامنة الدورات الخفيفة
async function recordsVersions(whereClause, params) {
  let sql = 'SELECT collection, COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM collection_records';
  if (whereClause) sql += ` WHERE ${whereClause}`;
  sql += ' GROUP BY collection';
  const r = await pool.query(sql, params);
  return r.rows;
}

// سجلات معلّقة من كل التصنيفات (للأدمن فقط).
// حدّ أعلى صريح: بدونه كان استعلام واحد بلا LIMIT يُعيد كل السجلات المعلّقة لكل
// التصنيفات دفعة واحدة (payload غير محدود ⇒ ذاكرة سيرفر + استجابة ضخمة). الحد
// مريح جداً (٢٠٠٠) عملياً، ومعه total/truncated في الرد ليبقى الأدمن على علم إن
// كان هناك المزيد بدل أن يظن أن القائمة كاملة.
async function pendingRecordsAll(limit = 2000) {
  const r = await pool.query(
    `SELECT collection, id, enc, version, origin, status, created_by, updated_by, updated_at
     FROM collection_records
     WHERE origin = 'reception' AND status = 'pending'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit]
  );
  const totalR = await pool.query(
    `SELECT COUNT(*)::int AS c FROM collection_records WHERE origin = 'reception' AND status = 'pending'`
  );
  return { rows: r.rows, total: totalR.rows[0].c };
}

// جلب سجل عام واحد (لحماية العزل)
async function recordMetaFor(collection, id) {
  const r = await pool.query(
    'SELECT origin, created_by, status, version, enc FROM collection_records WHERE collection = $1 AND id = $2',
    [collection, id]
  );
  return r.rows[0] || null;
}

// حفظ/تعديل سجل عام بنمط Optimistic Concurrency
async function recordUpsert({ collection, id, enc, knownVersion, username, origin, status }) {
  const upsert = await pool.query(
    `INSERT INTO collection_records (collection, id, enc, version, updated_by, origin, status, created_by)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $4)
     ON CONFLICT (collection, id) DO UPDATE SET
       enc = EXCLUDED.enc, version = collection_records.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by
     WHERE collection_records.version = $7
     RETURNING version, origin, status`,
    [collection, id, enc, username, origin, status, knownVersion]
  );
  if (upsert.rows[0]) {
    return { updated: true, ...upsert.rows[0] };
  }
  const current = await pool.query(
    'SELECT version, enc FROM collection_records WHERE collection = $1 AND id = $2',
    [collection, id]
  );
  return {
    updated: false,
    currentVersion: current.rows[0] ? current.rows[0].version : 0,
    currentEnc: current.rows[0] ? current.rows[0].enc : null,
  };
}

// اعتماد سجل عام معلّق
async function recordApprove(collection, id) {
  const r = await pool.query(
    `UPDATE collection_records SET status = 'confirmed', version = version + 1, updated_at = now()
     WHERE collection = $1 AND id = $2 AND origin = 'reception' AND status = 'pending'
     RETURNING id, version`,
    [collection, id]
  );
  return r.rows[0] || null;
}

// حذف سجل عام واحد (مع شرط عزل)
async function recordDelete(collection, id, whereClause, params) {
  let sql = 'DELETE FROM collection_records WHERE collection = $1 AND id = $2';
  const allParams = [collection, id];
  if (whereClause) { sql += ' ' + whereClause; allParams.push(...params); }
  await pool.query(sql, allParams);
}

// حذف عدة سجلات عامة دفعة واحدة (مع شرط عزل) — يرجع عدد الصفوف المحذوفة فعلياً بعد تطبيق شرط العزل
async function recordBulkDelete(collection, ids, whereClause, params) {
  let sql = 'DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[])';
  const allParams = [collection, ids];
  if (whereClause) {
    validateWhereParams(whereClause, params);
    sql += ' ' + whereClause; allParams.push(...params);
  }
  const r = await pool.query(sql, allParams);
  return r.rowCount || 0;
}

// حذف كل سجلات تصنيف (إعادة ضبط مصنع)
async function recordDeleteAll(collection) {
  await pool.query('DELETE FROM collection_records WHERE collection = $1', [collection]);
}

// تنظيف (prune) تصنيفات قابلة للتقليم
// بدون RETURNING: المسار كان يُبني مصفوفة JS بكل معرّف محذوف (آلاف النصوص) بلا أي
// استخدام — الطريق يستهلك rowCount أصلاً. الحذف نفسه ينفَّذ على دفعات (5000 صف)
// في حلقة حتى يكتمل ⇒ النتيجة النهائية مطابقة تماماً للحذف المفرد (بلا اقتطاع) مع
// تفادي حجز اتصال واحد طويلاً يخرج به الاستعلام عن statement_timeout.
const PRUNE_BATCH = 5000;
async function recordPrune(collection, olderThanDays) {
  let total = 0;
  for (;;) {
    const r = await pool.query(
      `DELETE FROM collection_records WHERE id IN (
         SELECT id FROM collection_records
         WHERE collection = $1 AND updated_at < now() - ($2 || ' days')::interval
         LIMIT ${PRUNE_BATCH}
       )`,
      [collection, olderThanDays]
    );
    total += r.rowCount;
    if (r.rowCount < PRUNE_BATCH) break;
  }
  return total;
}

// معاينة تنظيف (بدون حذف) — عدّان في استعلام واحد بدل استعلامين منفصلين
async function recordPrunePreview(collection, olderThanDays) {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE updated_at < now() - ($2 || ' days')::interval)::int AS would_delete,
       COUNT(*)::int AS total
     FROM collection_records WHERE collection = $1`,
    [collection, olderThanDays]
  );
  return { wouldDelete: r.rows[0].would_delete, total: r.rows[0].total };
}

/* ============== رفع مجمّع موحّد (client_records / collection_records) ============== */
// ينفّذ المعاملة كاملة (BEGIN/COMMIT/ROLLBACK) مع جداول مؤقتة وفحص تعارض لكل سجل.
// صُمّم ليتشارك بين نظامي العملاء والتصنيفات.
// requestId اختياري: لو مُقدَّم، يُستخدم كمعرّف دفعة لمنع الإدراج المزدوج عند إعادة الإرسال.
// كل سجل يحصل على request_id فريد = "${requestId}:${recordId}" — لو كان موجوداً مسبقاً
// يُتخطَّى السجل (عدم تكرار تقديم نفس الطلب).
//
// ===== إصلاح الأداء الحاسم: الفهارس على الجداول المؤقتة =====
// كان _inc و _conf يُنشآن بـ CREATE TEMP TABLE ... AS SELECT (بلا أي فهرس)، بينما
// الاستعلامات تعتمد عليهما في موضعين بمقارنة لكل صف:
//   · NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
//   · ON CONFLICT ... WHERE client_records.version = (SELECT i2.known_version FROM _inc i2 WHERE i2.id = EXCLUDED.id)
// الاستعلام الفرعي (subquery) لا يمكن أن يُنفَّذ كـ hash join أبداً، فيصبح **مسحاً
// تسلسلياً كاملاً للجدول المؤقت لكل صف** = O(N²). عند 5000 سجل = ~25 مليون مقارنة
// داخل معاملة واحدة تُحتجز على اتصال الـ pool طوال الوقت (وهذا بالضبط ما يُرهق
// Postgres المجاني ويُسقطها statement_timeout).
// الحل: إنشاء الجدولين بأعمدة حقيقية + PRIMARY KEY على id (فهرس btree)، فيتحوّل
// كل بحث إلى O(log N) probe وتبقى العملية O(N log N) بنفس عدد الاستعلامات تماماً.
// نفس الإصلاح خفّض تكلفة الـ DELETE في مسار الـ idempotency والـ JOIN نفسه.
async function bulkMigrate({ tableConfig, records, username, origin, status, guardSql, guardParams, requestId }) {
  const client = await pool.connect();
  try {
    const { clientTable, collection, gated, isClientCollection } = tableConfig;
    // نفس الحمولة بالضبط التي كانت تُبنى قبل (المعرّف/enc/نسخة معروفة/[رقم هوية]/[requestId])
    // — الفرق الوحيد أنها الآن تُدرَج في جدول حقيقي مفهرس بدل جدول مُشتق بلا فهرس.
    const payload = JSON.stringify(records.map(r => {
      const base = {
        id: String(r.id),
        enc: String(r.enc),
        version: Number.isInteger(r.version) ? r.version : 0,
      };
      if (isClientCollection || r.clientId !== undefined) base.clientId = (typeof r.clientId === 'string' && r.clientId.trim()) ? r.clientId.trim() : null;
      if (requestId) base.requestId = `${requestId}:${r.id}`;
      return base;
    }));

    await client.query('BEGIN');
    const step = async (label, sql, params) => {
      try { return await client.query(sql, params); }
      catch (e) { e.message = `[${label}] ` + e.message; throw e; }
    };

    // جدول مؤقت بمفتاح أساسي على id ⇒ فهرس btree جاهز لكل بحث id لاحق.
    // ON COMMIT DROP ⇒ نفس السلوك القديم (يختفي مع المعاملة) بلا أيDROP صريح.
    await step('inc', `CREATE TEMP TABLE _inc (
      id            text PRIMARY KEY,
      enc           text NOT NULL,
      known_version int,
      client_id     text,
      request_id    text
    ) ON COMMIT DROP`);

    // تكرار نفس الـ id داخل الدفعة الواحدة: نحتفظ بـ**أول** نسخة (نفس نتيجة السلوك
    // السابق تماماً: الصف الأول كان يُدرَج/يُحدَّث، وأي تكرار بعده كان يفشل شرط
    // version فِيُتخطّى — إذاً الأول يفوز). ORDINALITY يضمن ترتيباً حتمياً واضحاً.
    await step('inc-fill',
      `INSERT INTO _inc (id, enc, known_version, client_id, request_id)
       SELECT DISTINCT ON ((t.v->>'id')::text)
              (t.v->>'id')::text, (t.v->>'enc')::text,
              COALESCE((t.v->>'version')::int, 0), (t.v->>'clientId')::text, (t.v->>'requestId')::text
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(v, ord)
       ORDER BY (t.v->>'id')::text, t.ord`,
      [payload]
    );

    // منع الإدراج المزدوج: لو request_id موجود مسبقاً فى الجدول الهدف، نُزيل السجل من القائمة
    // قبل فحص التعارض حتى لا يُعاد إدخاله. هذا يمنع تكرار نفس الطلب عند إعادة الإرسال (Network Retry).
    if (requestId) {
      await step('idem',
        `DELETE FROM _inc i WHERE i.request_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM ${clientTable} cr WHERE cr.request_id = i.request_id${isClientCollection ? '' : ' AND cr.collection = $1'}
         )`,
        isClientCollection ? [] : [collection]
      );
    }

    // التعارضات = صفوف موجودة تختلف نسختها OR يرفضها حارس العزل.
    // في حالة التصنيفات، $1 محجوز لـ collection داخل JOIN، لذا نزيح أرقام معاملات guard
    // ($1→$2, $2→$3) بنفس طريقة الكود الأصلي لتجنب التصادم.
    const confParams = isClientCollection
      ? guardParams
      : [collection, ...guardParams];
    const guardShifted = isClientCollection
      ? guardSql
      : guardSql.replace(/\$2/g, '__TMP_DOLLAR2__').replace(/\$1/g, '$2').replace(/__TMP_DOLLAR2__/g, '$3');
    await step('conf', `CREATE TEMP TABLE _conf (
      id             text PRIMARY KEY,
      current_version int,
      current_enc    text
    ) ON COMMIT DROP`);
    await step('conf-fill',
      `INSERT INTO _conf (id, current_version, current_enc)
       SELECT cr.id, cr.version, cr.enc
       FROM _inc i
       JOIN ${clientTable} cr ON cr.id = i.id${isClientCollection ? '' : ' AND cr.collection = $1'}
       WHERE cr.version <> i.known_version OR NOT (${guardShifted})`,
      confParams
    );

    // إدراج/تحديث غير المتعارضين في بيان واحد
    // RETURNING id + version معاً (بلا تكلفة إضافية) — نحتاج النسخة الجديدة لكل سجل
    // لمزامنة فهرس العرض clients_rows (وهو فهرس مشتق من client_records لا غير).
    const upsertRes = await step('upsert',
      `INSERT INTO ${clientTable} (${isClientCollection ? 'id, enc, version, updated_by, origin, status, created_by, client_id' : 'collection, id, enc, version, updated_by, origin, status, created_by'}${requestId ? ', request_id' : ''})
       SELECT ${isClientCollection ? 'i.id, i.enc, 1, $1, $2, $3, $1, i.client_id' : '$1, i.id, i.enc, 1, $2, $3, $4, $2'}${requestId ? ', i.request_id' : ''}
       FROM _inc i
       WHERE NOT EXISTS (SELECT 1 FROM _conf c WHERE c.id = i.id)
       ORDER BY i.id
       ON CONFLICT ${isClientCollection ? '(id)' : '(collection, id)'} DO UPDATE SET
         enc = EXCLUDED.enc, version = ${isClientCollection ? 'client_records' : 'collection_records'}.version + 1,
         updated_at = now(), updated_by = EXCLUDED.updated_by${isClientCollection ? ', client_id = EXCLUDED.client_id' : ''}${requestId ? ', request_id = EXCLUDED.request_id' : ''}
       WHERE ${isClientCollection ? 'client_records' : 'collection_records'}.version = (SELECT i2.known_version FROM _inc i2 WHERE i2.id = EXCLUDED.id)
       RETURNING id, version`,
      isClientCollection ? [username, origin, status] : [collection, username, origin, status]
    );

    const succeededIds = new Set(upsertRes.rows.map(r => r.id));
    const newVersions = {};
    upsertRes.rows.forEach(r => { newVersions[r.id] = Number(r.version); });
    // قائمة المُعرّفات المرسلة معروفة أصلاً في JS — لم يعد我们需要 رحلة إضافية
    // (SELECT id FROM _inc) لقراءة جدول مؤقت، فنوفّر استعلاماً كاملاً من كل دفعة رفع.
    const allIds = [...new Set(records.map(r => String(r.id)))];
    const conflictedIds = allIds.filter(id => !succeededIds.has(id));

    let conflictRows = [];
    if (conflictedIds.length) {
      const cr = await step('conf-final',
        `SELECT id, version, enc FROM ${clientTable} WHERE id = ANY($1::text[])${isClientCollection ? '' : ' AND collection = $2'}`,
        isClientCollection ? [conflictedIds] : [conflictedIds, collection]
      );
      conflictRows = cr.rows.map(r => ({ id: r.id, current_version: r.version, current_enc: r.enc }));
    }

    const migrated = records.length - conflictRows.length;
    await client.query('COMMIT');
    return {
      migrated,
      conflicts: conflictRows.map(r => ({ id: r.id, currentVersion: r.current_version, currentEnc: r.current_enc })),
      newVersions,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// تكوين جدول نظام العملاء للرفع المجمّع
const CLIENTS_TABLE_CONFIG = {
  clientTable: 'client_records',
  isClientCollection: true,
};

// تكوين جدول نظام التصنيفات العامة للرفع المجمّع
const RECORDS_TABLE_CONFIG = (collection) => ({
  clientTable: 'collection_records',
  collection,
  isClientCollection: false,
});

module.exports = {
  validateWhereParams,
  clientRecords, clientVersionPairs, clientAggVersion, clientIdPairs,
  clientRecordMetaFor, clientUpsert, clientApprove, clientReject,
  clientDelete, clientBulkDelete, clientDeleteAll, cleanRejectedClientRecords,
  recordsByCollection, recordVersionPairs, pendingRecordsAll, recordMetaFor,
  recordUpsert, recordApprove, recordDelete, recordBulkDelete, recordDeleteAll,
  recordPrune, recordPrunePreview, bulkMigrate, CLIENTS_TABLE_CONFIG, RECORDS_TABLE_CONFIG,
  recordsVersions, deleteAtomic,
};
