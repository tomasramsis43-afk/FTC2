// ============================================================
// migrations/index.js — مشغّل الترحيلات (Migration Runner)
// ------------------------------------------------------------
// قاعدة المشروع: لا DDL تدميري (DROP/TRUNCATE) على قاعدة الإنتاج أبداً
// عند تشغيل السيرفر. كل تغيير في البنية = Migration صريحة، مُسجَّلة في
// جدول _schema_migrations، وقابلة لإعادة التشغيل (idempotent)، ومقسّمة
// إلى نوعين:
//   · safe: true  (افتراضي) — تُنفَّذ تلقائياً عند الإقلاع بعد ensureSchema.
//                  تغييرات غير مدمّرة فقط (بناء/إعادة بناء فهارس، أعمدة جديدة).
//   · safe: false — مدمّرة (DROP). لا تُنفَّذ إطلاقاً إلا بأمر صريح:
//                  node server/migrations/run.js --allow-destructive
//                  (ولا بدّ من نسخة احتياطية قبلها — غير قابلة للتراجع)
// قفل تزامن (advisory lock) يمنع مثيلَين من تطبيق نفس المigration معاً.
// ============================================================
const { pool } = require('../db');

// ---- قائمة الترحيلات (ترتيبها = ترتيب التنفيذ، ومعرّفها ثابت لا يُعاد استخدامه) ----
const MIGRATIONS = [
  {
    id: '2026-01-01-zatca-drop-legacy-tables',
    safe: false,
    title: 'حذف جدولا ZATCA الباقيا من الإصدار القديم ( zatca_invoice_log / zatca_credentials )',
    up: async (c) => {
      // الميزة أُزيلت كلياً من الكود والواجهة؛ لا يوجد أي مسار يقرأ/يكتب هذين الجدولين.
      // كان الحذف يجري تلقائياً في كل إقلاع عبر schema.sql — سلوك تدميري صامت.
      // هنا صار صريحاً، يدوياً، وقابلاً للتدقيق.
      await c.query('DROP TABLE IF EXISTS zatca_invoice_log');
      await c.query('DROP TABLE IF EXISTS zatca_credentials');
    },
  },
  {
    id: '2026-01-02-clients-rows-index-cleanup',
    safe: true,
    title: 'تنظيف فهارس clients_rows: حذف فهرس GIN غير القابل للاستخدام + تحويل name إلى (name, id)',
    up: async (c) => {
      // (أ) GIN على التعبير المركّب (name || ' ' || client_id || ' ' || refer_num || ' ' || invoice_no).
      // لا يمكن أن يخدمه أي استعلام في المشروع: الاستعلام الوحيد (GET /api/clients) يختبر
      // كل عمود على حدة (name ILIKE ... OR client_id ILIKE ...)، وبوستجرس لا يحوّل شرط عمود
      // إلى شرط تعبير مركّب. ⇒ فهرس مكلف (GIN على 4 حقول نصية) بلا أي فائدة.
      await c.query('DROP INDEX IF EXISTS idx_clients_rows_search_trgm');
      // (ب) استبدال فهرس name البسيط بمركّب (name, id): نفس العمود القائد ⇒ ORDER BY name
      // يبقى مخدوماً تماماً، ويزيد خدمة الـ keyset pagination على (name, id) بلا زيادة عدد الفهارس.
      await c.query('CREATE INDEX IF NOT EXISTS idx_clients_rows_name_id ON clients_rows (name, id)');
      await c.query('DROP INDEX IF EXISTS idx_clients_rows_name');
    },
  },
  {
    id: '2026-01-03-drop-unused-redundant-indexes',
    safe: true,
    title: 'حذف الفهارس التي لا يخدمها أي استعلام فعلي (login_history.username, magic_link_tokens.username, collection_records.collection)',
    up: async (c) => {
      // login_history: كل استعلاماته الفعلية تشترط success مع username ⇒ عمود username
      // محجوب أصلاً ببادئة الفهارس المركّبة الثلاثة الموجودة. فهرس مستقل = كتابة
      // زائدة في كل عملية تسجيل دخول + مساحة بلا فائدة.
      await c.query('DROP INDEX IF EXISTS idx_login_history_username');
      // magic_link_tokens: (username) بادئة (username, token_hash) ⇒ تكرار صِرف.
      await c.query('DROP INDEX IF EXISTS idx_magic_link_tokens_username');
      // collection_records: عمود collection عمود قيادي في PRIMARY KEY (collection, id)
      // ⇒ يغطي أي WHERE collection = X. (كان DROP يُنفَّذ في كل إقلاع من schema.sql.)
      await c.query('DROP INDEX IF EXISTS idx_collection_records_collection');
    },
  },
  {
    id: '2026-01-04-backfill-created-by',
    safe: true,
    title: 'تعبئة created_by من updated_by للسجلات القديمة (مرة واحدة بدل UPDATE كامل عند كل إقلاع)',
    up: async (c) => {
      // كان UPDATE ... WHERE created_by IS NULL يتكرّر في كل إقلاع على الجدولين كاملين
      // (مسح + توليد صفوف MVCC جديدة إن طابق أي صف). الآن مرّة واحدة عبر الـ migration،
      // وقابل لإعادة التشغيل بلا أثر (الشرط يمنع تكرار العمل).
      await c.query('UPDATE client_records SET created_by = updated_by WHERE created_by IS NULL');
      await c.query('UPDATE collection_records SET created_by = updated_by WHERE created_by IS NULL');
    },
  },
  {
    id: '2026-01-05-login-history-index-refine',
    safe: true,
    title: 'إضافة success كعمود قيادي لفهرسي device/ip في login_history (تسريع فحص الأجهزة والعناوين)',
    up: async (c) => {
      // الاستعلامان يفترضان success = true دائماً:
      //   deviceSeen: WHERE username=$1 AND success=true AND device_info=$2
      //   ipSeen    : WHERE username=$1 AND success=true AND ip_address=$2
      // جعل success في العمود الثاني يحوّل الشرط إلى prefix match (أسرع + أصغر select).
      // يُعاد البناء لأن الأسماء مطابقة لما في schema.sql بعد التغيير.
      await c.query('DROP INDEX IF EXISTS idx_login_history_user_device');
      await c.query('CREATE INDEX IF NOT EXISTS idx_login_history_user_device ON login_history(username, success, device_info)');
      await c.query('DROP INDEX IF EXISTS idx_login_history_user_ip');
      await c.query('CREATE INDEX IF NOT EXISTS idx_login_history_user_ip ON login_history(username, success, ip_address)');
    },
  },
  {
    id: '2026-01-06-clients-rows-src-version',
    safe: true,
    title: 'إضافة src_version إلى clients_rows (نسخة المصدر التي بُني منها الصف) لفحص التطابق بلا إعادة كتابة',
    up: async (c) => {
      // بدون هذا العمود لا يمكن معرفة ما إذا كان صف الفهرس قديم مقارنةً بـ client_records،
      // فالطريقة الوحيدة كانت إعادة كتابة كل الفهرس عند كل إقلاع (O(N) كتابة + WAL + DELETE).
      await c.query('ALTER TABLE clients_rows ADD COLUMN IF NOT EXISTS src_version INTEGER');
    },
  },
  {
    id: '2026-01-07-app-backups-deterministic-order',
    safe: true,
    title: 'إعادة بناء فهرس ترتيب النسخ الاحتياطية ليكسر التعادل بـ id (created_at DESC, id DESC)',
    up: async (c) => {
      // لازم إعادة البناء صراحةً: CREATE INDEX IF NOT EXISTS في schema.sql *لا* يغيّر
      // تعريف فهرس موجود بنفس الاسم، فتبقى القواعد القديمة على قواعد الإنتاج.
      // سبب التغيير: نسختان بنفس الثانية ⇒ ORDER BY created_at غير حتمي ⇒ التقليم
      // كان يحذف أحياناً نسخة أقدم من اللازم ويبقي أحدث.
      // آمن تماماً: فهرس غير فريد على جدول ≤30 صف ⇒ لا فقدان بيانات، والقفل لحظي.
      await c.query('DROP INDEX IF EXISTS idx_app_backups_created_at');
      await c.query('CREATE INDEX IF NOT EXISTS idx_app_backups_created_at ON app_backups(created_at DESC, id DESC)');
    },
  },
];

const LOCK_KEY = 7_310_922; // ثابت ولا يتغيّر أبداً (وإلا انقسم القفل بين النسخ)

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      id         TEXT PRIMARY KEY,
      title      TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function appliedIds(client) {
  const r = await client.query('SELECT id FROM _schema_migrations');
  return new Set(r.rows.map(x => x.id));
}

/**
 * تشغيل الترحيلات المعلّقة.
 * @param {{ allowDestructive?: boolean, only?: string, log?: (msg:string)=>void }} opts
 * @returns {Promise<{ applied: string[], skipped: string[], failed: any[] }>}
 */
async function runMigrations(opts = {}) {
  const { allowDestructive = false, only = null, log = (m) => console.log(m) } = opts;
  const result = { applied: [], skipped: [], failed: [] };
  const client = await pool.connect();
  try {
    await ensureMigrationsTable();
    // قفل حصري: يمنع مثيلَين من تطبيق نفس الـ migration بالتوازي (الاكتشاف النشط = Duplicate key)
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    const done = await appliedIds(client);

    for (const m of MIGRATIONS) {
      if (only && m.id !== only) continue;
      if (done.has(m.id)) continue;
      if (!m.safe && !allowDestructive) {
        result.skipped.push(m.id);
        log(`⏭️  تم تخطّي migration تدميري (يحتاج إذناً صريحاً): ${m.id}`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await m.up(client);
        await client.query('INSERT INTO _schema_migrations (id, title) VALUES ($1, $2)', [m.id, m.title || null]);
        await client.query('COMMIT');
        result.applied.push(m.id);
        log(`✅ migration: ${m.id} — ${m.title || ''}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        result.failed.push({ id: m.id, error: e.message });
        log(`❌ فشل migration ${m.id}: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return result;
}

module.exports = { runMigrations, MIGRATIONS, ensureMigrationsTable };
