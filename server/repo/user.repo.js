// ============================================================
// user.repo.js — طبقة الوصول لجدول server_users (Data Access Layer)
// ------------------------------------------------------------
// كل استعلامات SQL المتعلقة بمستخدمي النظام مُجمَّعة هنا.
// سلوك مطابق لما كان داخل auth.js/routes/auth.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

// جلب مستخدم لدوره/إصدار توكنه/حالة تفعيله — يستخدمه requireAuth للتحقق من التوكن
async function getUserAuth(id) {
  const r = await pool.query('SELECT role, token_version, is_active FROM server_users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// استهلاك كود احتياطي ذرياً (SELECT ... FOR UPDATE + UPDATE) ضد TOCTOU
async function consumeBackupCodeAtomic(userId, consumeFn) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const locked = await tx.query('SELECT totp_backup_codes FROM server_users WHERE id = $1 FOR UPDATE', [userId]);
    const storedJson = locked.rows[0] ? locked.rows[0].totp_backup_codes : null;
    const result = await consumeFn(storedJson);
    if (result.ok) {
      await tx.query('UPDATE server_users SET totp_backup_codes = $1 WHERE id = $2', [result.remaining, userId]);
    }
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

module.exports = { getUserAuth, consumeBackupCodeAtomic };
