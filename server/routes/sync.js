/**
 * sync.js — نظام المزامنة الجديد (كتابة من الصفر)
 *
 * المبادئ:
 * 1. السيرفر هو مصدر الحقيقة دائماً
 * 2. last-write-wins بالـ updated_at timestamp
 * 3. لا مسح نهائي أبداً — فقط upsert
 * 4. كل عملية atomic على مستوى السجل الواحد
 * 5. bulk endpoints لتقليل عدد الطلبات
 */

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const ALLOWED = new Set([
  'bagStock','vaultTx','vaultDenomTx','bankStatementRows','courseSessions',
  'auditLog','companies','companyTransfers','journalEntries','chartOfAccounts',
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices',
  'scheduledVaultTx','followUpTasks','deletedVaultTx','deletedInvoices',
]);

function badCollection(res, c) {
  return res.status(400).json({ error: `collection غير مسموح: ${c}` });
}

/* ─────────────────────────────────────────────────────────────
   GET /api/sync/:collection
   جلب كل سجلات collection — يُعيد [{id, enc, updated_at, version}]
   يدعم ?since=ISO_TIMESTAMP لجلب التغييرات فقط (delta sync)
───────────────────────────────────────────────────────────── */
router.get('/api/sync/:collection', requireAuth, async (req, res) => {
  const col = req.params.collection;
  if (!ALLOWED.has(col)) return badCollection(res, col);
  try {
    const since = req.query.since;
    let rows;
    if (since) {
      rows = await pool.query(
        `SELECT id, enc, version, updated_at
         FROM collection_records
         WHERE collection = $1 AND updated_at > $2
         ORDER BY updated_at ASC`,
        [col, since]
      );
    } else {
      rows = await pool.query(
        `SELECT id, enc, version, updated_at
         FROM collection_records
         WHERE collection = $1
         ORDER BY updated_at ASC`,
        [col]
      );
    }
    res.json({ collection: col, records: rows.rows, ts: new Date().toISOString() });
  } catch (e) {
    console.error(`[sync] GET ${col}:`, e.message);
    res.status(500).json({ error: 'خطأ في جلب البيانات' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/sync/:collection/meta
   أرقام النسخ فقط — خفيف لفحص ما تغيّر
   يُعيد [{id, version, updated_at}]
───────────────────────────────────────────────────────────── */
router.get('/api/sync/:collection/meta', requireAuth, async (req, res) => {
  const col = req.params.collection;
  if (!ALLOWED.has(col)) return badCollection(res, col);
  try {
    const rows = await pool.query(
      `SELECT id, version, updated_at FROM collection_records WHERE collection = $1`,
      [col]
    );
    res.json({ collection: col, meta: rows.rows });
  } catch (e) {
    res.status(500).json({ error: 'خطأ' });
  }
});

/* ─────────────────────────────────────────────────────────────
   PUT /api/sync/:collection/:id
   حفظ سجل واحد — upsert بـ last-write-wins
   body: { enc: string, clientUpdatedAt?: ISO }
   يُعيد: { id, version, updated_at, conflict: bool }
───────────────────────────────────────────────────────────── */
router.put('/api/sync/:collection/:id', requireAuth, async (req, res) => {
  const col = req.params.collection;
  const id  = req.params.id;
  if (!ALLOWED.has(col)) return badCollection(res, col);
  const { enc, clientUpdatedAt } = req.body || {};
  if (!enc) return res.status(400).json({ error: 'enc مطلوب' });

  try {
    const result = await pool.query(
      `INSERT INTO collection_records (collection, id, enc, version, updated_at, updated_by)
       VALUES ($1, $2, $3, 1, now(), $4)
       ON CONFLICT (collection, id) DO UPDATE
         SET enc        = EXCLUDED.enc,
             version    = collection_records.version + 1,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING id, version, updated_at`,
      [col, id, enc, req.user.username]
    );
    const row = result.rows[0];
    res.json({ id: row.id, version: row.version, updated_at: row.updated_at, conflict: false });
  } catch (e) {
    console.error(`[sync] PUT ${col}/${id}:`, e.message);
    res.status(500).json({ error: 'خطأ في الحفظ' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/sync/:collection/bulk
   رفع دفعة من السجلات دفعة واحدة — الأكفأ
   body: { records: [{id, enc}] }
   يُعيد: { saved: number, results: [{id, version, updated_at}] }
───────────────────────────────────────────────────────────── */
router.post('/api/sync/:collection/bulk', requireAuth, async (req, res) => {
  const col = req.params.collection;
  if (!ALLOWED.has(col)) return badCollection(res, col);
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0)
    return res.json({ saved: 0, results: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const results = [];
    // رفع كل سجل على حدة داخل transaction واحدة
    for (const rec of records) {
      if (!rec.id || !rec.enc) continue;
      const r = await client.query(
        `INSERT INTO collection_records (collection, id, enc, version, updated_at, updated_by)
         VALUES ($1, $2, $3, 1, now(), $4)
         ON CONFLICT (collection, id) DO UPDATE
           SET enc        = EXCLUDED.enc,
               version    = collection_records.version + 1,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING id, version, updated_at`,
        [col, rec.id, rec.enc, req.user.username]
      );
      if (r.rows[0]) results.push(r.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ saved: results.length, results });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`[sync] bulk ${col}:`, e.message);
    res.status(500).json({ error: 'خطأ في الحفظ الجماعي' });
  } finally {
    client.release();
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /api/sync/:collection/:id
   حذف سجل واحد
───────────────────────────────────────────────────────────── */
router.delete('/api/sync/:collection/:id', requireAuth, async (req, res) => {
  const col = req.params.collection;
  const id  = req.params.id;
  if (!ALLOWED.has(col)) return badCollection(res, col);
  try {
    await pool.query(
      `DELETE FROM collection_records WHERE collection = $1 AND id = $2`,
      [col, id]
    );
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في الحذف' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/sync/clients
   جلب كل سجلات العملاء [{id, enc, version, updated_at}]
   يدعم ?since=ISO_TIMESTAMP
───────────────────────────────────────────────────────────── */
router.get('/api/sync/clients', requireAuth, async (req, res) => {
  try {
    const since = req.query.since;
    let rows;
    if (since) {
      rows = await pool.query(
        `SELECT id, enc, version, updated_at FROM client_records
         WHERE updated_at > $1 ORDER BY updated_at ASC`,
        [since]
      );
    } else {
      rows = await pool.query(
        `SELECT id, enc, version, updated_at FROM client_records
         ORDER BY updated_at ASC`
      );
    }
    res.json({ records: rows.rows, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'خطأ في جلب العملاء' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/sync/clients/bulk
   رفع دفعة من العملاء
───────────────────────────────────────────────────────────── */
router.post('/api/sync/clients/bulk', requireAuth, async (req, res) => {
  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0)
    return res.json({ saved: 0, results: [] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const rec of records) {
      if (!rec.id || !rec.enc) continue;
      const r = await client.query(
        `INSERT INTO client_records (id, enc, version, updated_at, updated_by, client_id)
         VALUES ($1, $2, 1, now(), $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET enc        = EXCLUDED.enc,
               version    = client_records.version + 1,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by,
               client_id  = COALESCE(EXCLUDED.client_id, client_records.client_id)
         RETURNING id, version, updated_at`,
        [rec.id, rec.enc, req.user.username, rec.clientId || null]
      );
      if (r.rows[0]) results.push(r.rows[0]);
    }
    await client.query('COMMIT');
    res.json({ saved: results.length, results });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sync] clients bulk:', e.message);
    res.status(500).json({ error: 'خطأ في رفع العملاء' });
  } finally {
    client.release();
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /api/sync/status
   حالة المزامنة العامة — عدد السجلات لكل collection
───────────────────────────────────────────────────────────── */
router.get('/api/sync/status', requireAuth, async (req, res) => {
  try {
    const colCounts = await pool.query(
      `SELECT collection, COUNT(*) as count, MAX(updated_at) as last_updated
       FROM collection_records GROUP BY collection`
    );
    const clientCount = await pool.query(
      `SELECT COUNT(*) as count, MAX(updated_at) as last_updated FROM client_records`
    );
    const counts = {};
    for (const row of colCounts.rows) {
      counts[row.collection] = { count: parseInt(row.count), last_updated: row.last_updated };
    }
    counts['clients'] = {
      count: parseInt(clientCount.rows[0].count),
      last_updated: clientCount.rows[0].last_updated
    };
    res.json({ collections: counts, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'خطأ' });
  }
});

module.exports = router;
