// ============================================================
// records.repo.js — طبقة الوصول لسجلات العملاء (client_records)
// والسجلات العامة (collection_records) — Data Access Layer
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بنظام "السجلات المستقلة" مُجمَّعة هنا.
// السلوك مطابق 100% لما كان داخل routes/records.js — نقل ميكانيكي فقط
// (بما في ذلك منطق المعاملات في الرفع المجمّع).
// ============================================================
const { pool } = require('../db');

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
  if (Number.isInteger(page) && page >= 1) {
    sql += ` ORDER BY version ASC, id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
    sqlParams.push(pageSize, (page - 1) * pageSize);
  }
  const r = await pool.query(sql, sqlParams);
  return r.rows;
}

// أزواج (id, version) لكل عملاء — للتحقق الدوري الخفيف (delta)
async function clientVersionPairs({ where, params }) {
  const r = await pool.query(`SELECT id, version FROM client_records ${where}`, params);
  return r.rows.map(row => [row.id, Number(row.version)]);
}

// رقم إصدار مجمّع + عدّ — للتحقق السريع من وجود تعديل من جهاز آخر
async function clientAggVersion({ where, params }) {
  const r = await pool.query(`SELECT COALESCE(SUM(version),0)::bigint AS v, COUNT(*)::int AS c FROM client_records ${where}`, params);
  return { version: Number(r.rows[0].v), count: r.rows[0].c };
}

// قائمة (id, client_id) لفحص تكرار أرقام الهوية (يعالج التجزئة في المتصل)
async function clientIdPairs({ where, params }) {
  const r = await pool.query(`SELECT id, client_id FROM client_records WHERE client_id IS NOT NULL AND client_id <> '' ${where}`, params);
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

// حذف عدة عملاء دفعة واحدة (مع شرط عزل)
async function clientBulkDelete(ids, whereClause, params) {
  let sql = 'DELETE FROM client_records WHERE id = ANY($1::text[])';
  const allParams = [ids];
  if (whereClause) { sql += ' ' + whereClause; allParams.push(...params); }
  await pool.query(sql, allParams);
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
  if (Number.isInteger(page) && page >= 1) {
    sql += ` ORDER BY version ASC, id ASC LIMIT $${sqlParams.length + 1} OFFSET $${sqlParams.length + 2}`;
    sqlParams.push(pageSize, (page - 1) * pageSize);
  }
  const r = await pool.query(sql, sqlParams);
  return r.rows;
}

// أزواج (id, version) لتصنيف — للتحقق الدوري (delta)
async function recordVersionPairs(collection, where, params) {
  const sql = `SELECT id, version FROM collection_records WHERE collection = $1 ${where}`;
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

// سجلات معلّقة من كل التصنيفات (للأدمن فقط)
async function pendingRecordsAll() {
  const r = await pool.query(
    `SELECT collection, id, enc, version, origin, status, created_by, updated_by, updated_at
     FROM collection_records
     WHERE origin = 'reception' AND status = 'pending'
     ORDER BY updated_at DESC`
  );
  return r.rows;
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

// حذف عدة سجلات عامة دفعة واحدة (مع شرط عزل)
async function recordBulkDelete(collection, ids, whereClause, params) {
  let sql = 'DELETE FROM collection_records WHERE collection = $1 AND id = ANY($2::text[])';
  const allParams = [collection, ids];
  if (whereClause) { sql += ' ' + whereClause; allParams.push(...params); }
  await pool.query(sql, allParams);
}

// حذف كل سجلات تصنيف (إعادة ضبط مصنع)
async function recordDeleteAll(collection) {
  await pool.query('DELETE FROM collection_records WHERE collection = $1', [collection]);
}

// تنظيف (prune) تصنيفات قابلة للتقليم
async function recordPrune(collection, olderThanDays) {
  const r = await pool.query(
    `DELETE FROM collection_records WHERE collection = $1 AND updated_at < now() - ($2 || ' days')::interval RETURNING id`,
    [collection, olderThanDays]
  );
  return r.rowCount;
}

// معاينة تنظيف (بدون حذف)
async function recordPrunePreview(collection, olderThanDays) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM collection_records WHERE collection = $1 AND updated_at < now() - ($2 || ' days')::interval`,
    [collection, olderThanDays]
  );
  const total = await pool.query('SELECT COUNT(*)::int AS c FROM collection_records WHERE collection = $1', [collection]);
  return { wouldDelete: r.rows[0].c, total: total.rows[0].c };
}

/* ============== رفع مجمّع موحّد (client_records / collection_records) ============== */
// ينفّذ المعاملة كاملة (BEGIN/COMMIT/ROLLBACK) مع جداول مؤقتة وفحص تعارض لكل سجل.
// صُمّم ليتشارك بين نظامي العملاء والتصنيفات.
// requestId اختياري: لو مُقدَّم، يُستخدم كمعرّف دفعة لمنع الإدراج المزدوج عند إعادة الإرسال.
// كل سجل يحصل على request_id فريد = "${requestId}:${recordId}" — لو كان موجوداً مسبقاً
// يُتخطَّى السجل (عدم تكرار تقديم نفس الطلب).
async function bulkMigrate({ tableConfig, records, username, origin, status, guardSql, guardParams, requestId }) {
  const client = await pool.connect();
  try {
    const { clientTable, collection, gated, isClientCollection } = tableConfig;
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

    await step('inc',
      `CREATE TEMP TABLE _inc ON COMMIT DROP AS
       SELECT (t->>'id')::text AS id, (t->>'enc')::text AS enc, COALESCE((t->>'version')::int, 0) AS known_version,
              (t->>'clientId')::text AS client_id${requestId ? `, (t->>'requestId')::text AS request_id` : ''}
       FROM jsonb_array_elements($1::jsonb) AS t`,
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
    await step('conf',
      `CREATE TEMP TABLE _conf ON COMMIT DROP AS
       SELECT cr.id, cr.version AS current_version, cr.enc AS current_enc
       FROM _inc i
       JOIN ${clientTable} cr ON cr.id = i.id${isClientCollection ? '' : ' AND cr.collection = $1'}
       WHERE cr.version <> i.known_version OR NOT (${guardShifted})`,
      confParams
    );

    // إدراج/تحديث غير المتعارضين في بيان واحد
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
       RETURNING id`,
      isClientCollection ? [username, origin, status] : [collection, username, origin, status]
    );

    const succeededIds = new Set(upsertRes.rows.map(r => r.id));
    const allIds = (await step('ids', 'SELECT id FROM _inc')).rows.map(r => r.id);
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
    return { migrated, conflicts: conflictRows.map(r => ({ id: r.id, currentVersion: r.current_version, currentEnc: r.current_enc })) };
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
  clientRecords, clientVersionPairs, clientAggVersion, clientIdPairs,
  clientRecordMetaFor, clientUpsert, clientApprove, clientReject,
  clientDelete, clientBulkDelete, clientDeleteAll, cleanRejectedClientRecords,
  recordsByCollection, recordVersionPairs, pendingRecordsAll, recordMetaFor,
  recordUpsert, recordApprove, recordDelete, recordBulkDelete, recordDeleteAll,
  recordPrune, recordPrunePreview, bulkMigrate, CLIENTS_TABLE_CONFIG, RECORDS_TABLE_CONFIG,
  recordsVersions,
};
