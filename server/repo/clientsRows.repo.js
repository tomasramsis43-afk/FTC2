// ============================================================
// clientsRows.repo.js — طبقة الوصول لجدول clients_rows (المفهرس)
// ------------------------------------------------------------
// clients_rows **ليس مصدر الحقيقة**: مصدر الحقيقة هو client_records
// (سجل مستقل لكل عميل) و kv_store('clients') (الكتلة القديمة التراثية).
// clients_rows فهرس عرض/بحث مشتق بالكامل، يُستخدم حصراً من GET /api/clients
// لعرض/بحث/ترقيم شاشة "جدول العملاء".
// ============================================================
const { pool } = require('../db');

const CLIENTS_ROWS_CHUNK_SIZE = 300;

// مفتاح قفل تزامن ثابت (Advisory Lock) يحمي تعديلات clients_rows من التداخل بين عدة
// مثيلات/عمليات على نفس قاعدة البيانات. أي قيمة int صحيحة ثابتة لكل المثيلات تصلح —
// يجب ألا تتغيّر أبداً وإلا انقسم القفل. `pg_advisory_xact_lock` يرتبط بمعاملة
// (يُحرَّر تلقائياً عند COMMIT/ROLLBACK)، فلا خطر من نسيان تحريره.
const SYNC_LOCK_KEY = 4_210_001;

// تنفيذ استعلام عبر "اتصال معيّن" ببديل متوافق (يُستخدم داخل معاملة/قفل)
async function execOn(client, queryText, params) {
  // عند عدم توفر client (استدعاء خارجي مستقل) نعمل عبر الـ pool كالسابق
  return client ? client.query(queryText, params) : pool.query(queryText, params);
}

// UPSERT دفعة من صفوف العملاء إلى clients_rows — داخل معاملة (عبر client) إن وُجد، أو مستقل
// (عبر pool) إن استُدعي مباشرةً. يتجاوز id المكرر بدل إيقاف الكل.
// كل صف قد يحمل __srcVersion (نسخة client_records التي بُني منها) ⇒ تُخزَّن في src_version
// وتُستعمل لاحقاً في فحص التطابق الرخيص (integrityCheck) بلا أي إعادة كتابة.
async function upsertChunkOn(chunk, client) {
  const values = [];
  const placeholders = chunk.map((c, idx) => {
    const base = idx * 11;
    values.push(c.id, JSON.stringify(c), c.name || '', c.clientId || '', c.referNum || '',
      c.nationality || '', c.courseType || '', c.courseNumber || '', c.invoice || '', c.date || '',
      Number.isInteger(c.__srcVersion) ? c.__srcVersion : null);
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`;
  }).join(',');
  await execOn(client,
    `INSERT INTO clients_rows (id, data, name, client_id, refer_num, nationality, course_type, course_number, invoice_no, reg_date, src_version)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data, name = EXCLUDED.name, client_id = EXCLUDED.client_id,
       refer_num = EXCLUDED.refer_num, nationality = EXCLUDED.nationality,
       course_type = EXCLUDED.course_type, course_number = EXCLUDED.course_number,
       invoice_no = EXCLUDED.invoice_no, reg_date = EXCLUDED.reg_date, src_version = EXCLUDED.src_version, updated_at = now()`,
    values
  );
}

// استدعاء مستقل خارجي (يكتب rows الفهرس بعد حفظ/ترحيل عملاء من routes/records.js).
// يكتسب نفس قفل التزامن أيضاً، وإلا تداخل مع syncAll/حذف جارٍ: مزامنة prunable قد
// تحذف صفاً يكتبه هذا الاستدعاء الآن ⇒ اختفاء عميل من الفهرس رغم وجوده في المصدر.
// القاعدة: أي كتابة على clients_rows تمرّ بمعاملة تحمل القفل، مهما كان حجمها.
async function upsertChunk(chunk) {
  if (!Array.isArray(chunk) || !chunk.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    for (let start = 0; start < chunk.length; start += CLIENTS_ROWS_CHUNK_SIZE) {
      await upsertChunkOn(chunk.slice(start, start + CLIENTS_ROWS_CHUNK_SIZE), client);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================
// المزامنة الكاملة (من كتلة kv_store التراثية)
// ------------------------------------------------------------
// opts.prune = true  → تُحذف صفوف clients_rows غير الموجودة في الكتلة.
//   تُستخدم **فقط** في PUT /api/storage/clients، حيث الكتلة نفسها هي المصدر
//   الحاكم في تلك اللحظة (ترحيل/استعادة) ⇒ الحذف هنا صحيح.
// opts.prune = false → دمج فقط، بلا أي حذف. هذه هي القيمة الافتراضية المستخدمة
//   عند الإقلاع، لأن kv_store('clients') **جمّد** منذ النظام الجديد ولم يعد
//   يُكتب إطلاقاً: أي عميل أُضيف بعد الترحيل موجود في client_records وحده
//   (وكذلك صفّه في clients_rows عبر التحديث التزايدي) وغير موجود في الكتلة
//   القديمة. الحذف هنا كان **يمسح فهرس كل العملاء الجدد عند كل إعادة تشغيل**
//   (فقد بيانات ظاهر + إعادة كتابة كاملة للجدول كل مرة).
// ============================================================
async function syncAll(value, opts = {}) {
  const { prune = false } = opts;
  let arr;
  try { arr = JSON.parse(value || '[]'); } catch (e) { return { failedRows: 0, rows: 0 }; }
  if (!Array.isArray(arr)) return { failedRows: 0, rows: 0 };
  const valid = arr.filter(c => c && c.id);
  const allIds = valid.map(c => c.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // كسب قفل التزامن — يمنع أي مثيل/عملية أخرى من تعديل clients_rows بالتوازي
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);

    let failedRows = 0;
    for (let start = 0; start < valid.length; start += CLIENTS_ROWS_CHUNK_SIZE) {
      const chunk = valid.slice(start, start + CLIENTS_ROWS_CHUNK_SIZE);
      try {
        await upsertChunkOn(chunk, client);
      } catch (e) {
        for (const c of chunk) {
          try { await upsertChunkOn([c], client); }
          catch (e2) { failedRows++; }
        }
      }
    }
    // حذف الصفوف القديمة غير الموجودة في الكتلة الحالية — اختياري (انظر شرح prune أعلاه)
    if (prune) {
      try {
        if (allIds.length) {
          await client.query(`DELETE FROM clients_rows WHERE id != ALL($1)`, [allIds]);
        } else if (arr.length === 0) {
          await client.query('DELETE FROM clients_rows');
        }
      } catch (e) {
        // لا نحذف شيئاً عند خطأ عابر حفاظاً على البيانات المفهرسة السابقة
      }
    }

    await client.query('COMMIT'); // تحرير القفل تلقائياً عند نهاية المعاملة
    return { failedRows, rows: valid.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); // تحرير القفل تلقائياً
    throw e;
  } finally {
    client.release();
  }
}

// عدّ صفوف clients_rows
async function count() {
  const cnt = await pool.query('SELECT COUNT(*) FROM clients_rows');
  return Number(cnt.rows[0].count);
}

// ============================================================
// فحص التطابق: قراءة فقط، بلا كتابة
// ------------------------------------------------------------
// يقارن حجم الفهرس مع مصدر الحقيقة (client_records) **ويصلح orphan فقط**.
// orphan = صف في clients_rows لا وجود له في client_records ⇒ تصحيح آمن تماماً
// (السجل محذوف من المصدر، فبقاؤه في الفهرس خطأ مؤكد). أي نقص في الاتجاه
// الآخر (عميل موجود في المصدر وغائب عن الفهرس) لا يمكن بناؤه هنا إطلاقاً:
// الفهرس يحتاج نسخة العميل **بنص صريح** يرسلها المتصفح فقط، والسيرفر لا يملك
// مفتاح فك التشفير — لذلك يُبلَّغ عن 숫مه بدل محاولة إصلاحه عشوائياً.
// ============================================================
async function integrityCheck() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM client_records)::int                       AS source_rows,
      (SELECT COUNT(*) FROM clients_rows)::int                         AS index_rows,
      (SELECT COUNT(*) FROM clients_rows c
         WHERE NOT EXISTS (SELECT 1 FROM client_records cr WHERE cr.id = c.id))::int AS orphans
  `);
  return {
    sourceRows: r.rows[0].source_rows,
    indexRows: r.rows[0].index_rows,
    orphans: r.rows[0].orphans,
  };
}

// حذف orphan فقط (تحت نفس قفل التزامن) — لا يمسّ أي صف له مقابل في المصدر
async function deleteOrphans() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    const r = await client.query(
      `DELETE FROM clients_rows c
       WHERE NOT EXISTS (SELECT 1 FROM client_records cr WHERE cr.id = c.id)`
    );
    await client.query('COMMIT');
    return r.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ختم src_version لكل صفوف الفهرس من نسخة client_records الحالية (استعلام واحد،
// بلا N رحلة ذهاب/إياب) — يُستخدم بعد ترحيل أولي كامل حتى يصبح الفحص الرخيص
// دقيقاً بدل وصف كل الصفوف كقديمة بسبب NULL.
async function stampSrcVersions() {
  const r = await pool.query(
    `UPDATE clients_rows c SET src_version = cr.version
     FROM client_records cr WHERE cr.id = c.id AND (c.src_version IS DISTINCT FROM cr.version)`
  );
  return r.rowCount;
}

// حذف صفوف محدَّدة بالـ id (حذف/حذف جماعي لعميل عبر النظام الحديث client_records) — تحت نفس
// قفل التزامن لمنع التداخل مع syncAll/upsertChunk جارية من مثيل آخر. يُستدعى best-effort من
// routes/records.js فور نجاح الحذف الفعلي فى client_records، حتى لا يبقى العميل المحذوف ظاهراً
// فى شاشة جدول العملاء المرقّمة (GET /api/clients) رغم حذفه فعلياً.
async function deleteIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    await client.query('DELETE FROM clients_rows WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// حذف كل الصفوف (عند حذف مفتاح clients) — تحت نفس قفل التزامن لمنع التداخل مع
// مزامنة syncAll جارية من مثيل آخر على نفس قاعدة البيانات (سباق DELETE مقابل INSERT).
async function deleteAll() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    await client.query('DELETE FROM clients_rows');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// استعلام مرقّم/مفتاحي لشاشة جدول العملاء (GET /api/clients)
// تأخذ شروط الرؤية/البحث مبنية بالفعل في المسار، وتنفّذ COUNT + SELECT مع keyset أو OFFSET.
// i = فهرس المعامل التالي المتاح بعد معاملات where (يبدأ من 1 ثم يزيد لها).
// ملاحظة الحقول: نرجع `data` فقط في المسار بلا cursor + نحتاج sortCol/id لحساب nextCursor،
// أما في مسار الـ keyset فالصفحة التالية تعتمد على الـ cursor المُرسل من العميل لا على
// ترتيب الصف ⇒ نكتفي بـ data وحدها (توفير عمودين لكل صف في كل صفحة، ومفيد مع صفحات
// آلاف الصفوف حيث data نفسه نص كبير).
async function queryPage({ whereSql, params, sortCol, order, cursorSql, cursorParams, pageSize, offset, i }) {
  const totalR = await pool.query(`SELECT COUNT(*) FROM clients_rows ${whereSql}`, params);
  let rowsR;
  if (cursorSql) {
    const limitIdx = i + cursorParams.length;
    rowsR = await pool.query(
      `SELECT data FROM clients_rows ${whereSql}${cursorSql} ORDER BY ${sortCol} ${order} NULLS LAST, id ASC LIMIT $${limitIdx}`,
      [...params, ...cursorParams, pageSize]
    );
  } else {
    rowsR = await pool.query(
      `SELECT data FROM clients_rows ${whereSql} ORDER BY ${sortCol} ${order} NULLS LAST, id ASC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, pageSize, offset]
    );
  }
  return { rows: rowsR.rows, total: Number(totalR.rows[0].count) };
}

module.exports = {
  upsertChunk, syncAll, count, deleteAll, deleteIds, queryPage,
  integrityCheck, deleteOrphans, stampSrcVersions,
  CLIENTS_ROWS_CHUNK_SIZE,
};
