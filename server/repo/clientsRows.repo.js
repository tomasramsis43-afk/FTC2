// ============================================================
// clientsRows.repo.js — طبقة الوصول لجدول clients_rows (المفهرس)
// ------------------------------------------------------------
// نسخة "مفهرسة" من بيانات العملاء تُستخدم حصراً لعرض/بحث/ترقيم
// شاشة جدول العملاء. سلوك مطابق لما كان داخل routes/records.js.
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

// UPSERT دفعة من صفوف العملاء إلى clients_rows — داخل معاملة (عبر client) إن وُجد،
// أو مستقل (عبر pool) إن استُدعي مباشرةً. يتجاوز id المكرر بدل إيقاف الكل.
async function upsertChunkOn(chunk, client) {
  const values = [];
  const placeholders = chunk.map((c, idx) => {
    const base = idx * 10;
    values.push(c.id, JSON.stringify(c), c.name || '', c.clientId || '', c.referNum || '',
      c.nationality || '', c.courseType || '', c.courseNumber || '', c.invoice || '', c.date || '');
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
  }).join(',');
  await execOn(client,
    `INSERT INTO clients_rows (id, data, name, client_id, refer_num, nationality, course_type, course_number, invoice_no, reg_date)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data, name = EXCLUDED.name, client_id = EXCLUDED.client_id,
       refer_num = EXCLUDED.refer_num, nationality = EXCLUDED.nationality,
       course_type = EXCLUDED.course_type, course_number = EXCLUDED.course_number,
       invoice_no = EXCLUDED.invoice_no, reg_date = EXCLUDED.reg_date, updated_at = now()`,
    values
  );
}

// نفس الدالة لكن باستدعاء مباشر عبر الـ pool (متوافق مع الواجهة القديمة للاستخدام المستقل)
async function upsertChunk(chunk) {
  return upsertChunkOn(chunk, null);
}

// مزامنة كاملة من عيّنة العملاء (JSON) إلى clients_rows
// ترجع عدد الصفوف التي تعذّر مزامنتها (لتسجيل وتحليل)، 0 يعني نجاح كامل
// كل العملية (UPSERT + DELETE) تجري داخل معاملة واحدة تحمل قفل تزامن Advisory —
// حتى لا يتسبّب مثيلان يعملان على نفس قاعدة البيانات في تداخل DELETE مع INSERT
// يُفقد صفوفاً (كان هذا محمياً محلياً فقط عبر طابور داخل ذاكرة العملية في sync.js،
// وهو لا يحمي بين مثيلات مختلفة). القفل يضمن أن مثيلاً واحداً يعدّل clients_rows
// في أي لحظة، والباقي ينتظر حتى ينتهي تماماً.
async function syncAll(value) {
  let arr;
  try { arr = JSON.parse(value || '[]'); } catch (e) { return 0; }
  if (!Array.isArray(arr)) return 0;
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
    // حذف الصفوف القديمة غير الموجودة في المصفوفة الحالية (داخل نفس المعاملة/القفل)
    try {
      if (allIds.length) {
        await client.query(`DELETE FROM clients_rows WHERE id != ALL($1)`, [allIds]);
      } else if (arr.length === 0) {
        await client.query('DELETE FROM clients_rows');
      }
    } catch (e) {
      // لا نحذف شيئاً عند خطأ عابر حفاظاً على البيانات المفهرسة السابقة
    }

    await client.query('COMMIT'); // تحرير القفل تلقائياً عند نهاية المعاملة
    return failedRows;
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
async function queryPage({ whereSql, params, sortCol, order, cursorSql, cursorParams, pageSize, offset, i }) {
  const totalR = await pool.query(`SELECT COUNT(*) FROM clients_rows ${whereSql}`, params);
  let rowsR;
  if (cursorSql) {
    const limitIdx = i + cursorParams.length;
    rowsR = await pool.query(
      `SELECT data, ${sortCol} as sc, id FROM clients_rows ${whereSql}${cursorSql} ORDER BY ${sortCol} ${order} NULLS LAST, id ASC LIMIT $${limitIdx}`,
      [...params, ...cursorParams, pageSize]
    );
  } else {
    rowsR = await pool.query(
      `SELECT data FROM clients_rows ${whereSql} ORDER BY ${sortCol} ${order} NULLS LAST LIMIT $${i} OFFSET $${i + 1}`,
      [...params, pageSize, offset]
    );
  }
  return { rows: rowsR.rows, total: Number(totalR.rows[0].count) };
}

module.exports = { upsertChunk, syncAll, count, deleteAll, queryPage, CLIENTS_ROWS_CHUNK_SIZE };
