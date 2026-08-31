// ============================================================
// clientsRows.repo.js — طبقة الوصول لجدول clients_rows (المفهرس)
// ------------------------------------------------------------
// نسخة "مفهرسة" من بيانات العملاء تُستخدم حصراً لعرض/بحث/ترقيم
// شاشة جدول العملاء. سلوك مطابق لما كان داخل routes/records.js.
// ============================================================
const { pool } = require('../db');

const CLIENTS_ROWS_CHUNK_SIZE = 300;

// UPSERT دفعة من صفوف العملاء إلى clients_rows (تتجاوز id المكرر بدل إيقاف الكل)
async function upsertChunk(chunk) {
  const values = [];
  const placeholders = chunk.map((c, idx) => {
    const base = idx * 10;
    values.push(c.id, JSON.stringify(c), c.name || '', c.clientId || '', c.referNum || '',
      c.nationality || '', c.courseType || '', c.courseNumber || '', c.invoice || '', c.date || '');
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
  }).join(',');
  await pool.query(
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

// مزامنة كاملة من عيّنة العملاء (JSON) إلى clients_rows
// ترجع عدد الصفوف التي تعذّر مزامنتها (لتسجيل وتحليل)، 0 يعني نجاح كامل
async function syncAll(value) {
  let arr;
  try { arr = JSON.parse(value || '[]'); } catch (e) { return 0; }
  if (!Array.isArray(arr)) return 0;
  const valid = arr.filter(c => c && c.id);
  const allIds = valid.map(c => c.id);
  let failedRows = 0;
  for (let start = 0; start < valid.length; start += CLIENTS_ROWS_CHUNK_SIZE) {
    const chunk = valid.slice(start, start + CLIENTS_ROWS_CHUNK_SIZE);
    try {
      await upsertChunk(chunk);
    } catch (e) {
      for (const c of chunk) {
        try { await upsertChunk([c]); }
        catch (e2) { failedRows++; }
      }
    }
  }
  try {
    if (allIds.length) {
      await pool.query(`DELETE FROM clients_rows WHERE id != ALL($1)`, [allIds]);
    } else if (arr.length === 0) {
      await pool.query('DELETE FROM clients_rows');
    }
  } catch (e) {
    // لا نحذف شيئاً عند خطأ عابر حفاظاً على البيانات المفهرسة السابقة
  }
  return failedRows;
}

// عدّ صفوف clients_rows
async function count() {
  const cnt = await pool.query('SELECT COUNT(*) FROM clients_rows');
  return Number(cnt.rows[0].count);
}

// حذف كل الصفوف (عند حذف مفتاح clients)
async function deleteAll() {
  await pool.query('DELETE FROM clients_rows');
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
