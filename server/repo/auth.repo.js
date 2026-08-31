// ============================================================
// auth.repo.js — طبقة الوصول لبيانات المصادقة والمستخدمين وسجل الدخول
// (server_users, login_history, license_bindings, magic_link_tokens)
// ------------------------------------------------------------
// كل استعلامات SQL الخاصة بمسارات المصادقة/المستخدمين مُجمَّعة هنا.
// سلوك مطابق لما كان داخل routes/auth.js وroutes/magic-link.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

/* ========================== 2FA ========================== */
async function setTotpPendingSecret(username, secret) {
  await pool.query('UPDATE server_users SET totp_pending_secret = $1 WHERE username = $2', [secret, username]);
}
async function getTotpPendingSecret(username) {
  const r = await pool.query('SELECT totp_pending_secret FROM server_users WHERE username = $1', [username]);
  return r.rows[0]?.totp_pending_secret || null;
}
async function enableTotp(username, secret, backupCodesJson) {
  await pool.query(
    `UPDATE server_users SET totp_secret = $1, totp_pending_secret = NULL, totp_enabled = true,
     totp_backup_codes = $2, token_version = token_version + 1 WHERE username = $3`,
    [secret, backupCodesJson, username]
  );
}
async function getPasswordHash(username) {
  const r = await pool.query('SELECT password_hash FROM server_users WHERE username = $1', [username]);
  return r.rows[0]?.password_hash || null;
}
async function disableTotp(username) {
  await pool.query(
    `UPDATE server_users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = false,
     totp_backup_codes = NULL WHERE username = $1`,
    [username]
  );
}
async function getTotpEnabled(username) {
  const r = await pool.query('SELECT totp_enabled FROM server_users WHERE username = $1', [username]);
  return !!(r.rows[0] && r.rows[0].totp_enabled);
}

/* ========================== سجل الدخول (login_history) ========================== */
async function recordLogin(entry) {
  await pool.query(
    'INSERT INTO login_history (username, role, ip_address, device_info, success, country, city) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [entry.username, entry.role ?? null, entry.ip, entry.device, entry.success ?? true, entry.country || null, entry.city || null]
  );
}
async function lastSuccessfulLogin(username) {
  const r = await pool.query(
    `SELECT logged_in_at, ip_address, device_info FROM login_history
     WHERE username = $1 AND success = true
     ORDER BY logged_in_at DESC LIMIT 1`,
    [username]
  );
  return r.rows[0] || null;
}
async function deviceSeen(username, deviceInfo) {
  const r = await pool.query(
    `SELECT 1 FROM login_history WHERE username = $1 AND success = true AND device_info = $2 LIMIT 1`,
    [username, deviceInfo]
  );
  return r.rows.length > 0;
}
async function ipSeen(username, ip) {
  const r = await pool.query(
    `SELECT 1 FROM login_history WHERE username = $1 AND success = true AND ip_address = $2 LIMIT 1`,
    [username, ip]
  );
  return r.rows.length > 0;
}
async function usualCountry(username) {
  const r = await pool.query(
    `SELECT country FROM login_history WHERE username=$1 AND success=true AND country IS NOT NULL GROUP BY country ORDER BY COUNT(*) DESC LIMIT 1`,
    [username]
  );
  return r.rows[0]?.country || null;
}
async function loginHistory(limit = 300) {
  const r = await pool.query(
    'SELECT username, role, ip_address, device_info, logged_in_at, success FROM login_history ORDER BY logged_in_at DESC LIMIT $1',
    [limit]
  );
  return r.rows;
}
async function suspiciousActivitySince(since) {
  const r = await pool.query(
    `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
     FROM login_history
     WHERE success = false AND logged_in_at > $1
     GROUP BY username, ip_address
     HAVING COUNT(*) >= 3
     ORDER BY failed_count DESC`,
    [since]
  );
  return r.rows;
}
async function suspiciousLastHour() {
  const r = await pool.query(
    `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
     FROM login_history
     WHERE success = false AND logged_in_at > now() - INTERVAL '1 hour'
     GROUP BY username, ip_address
     HAVING COUNT(*) >= 3
     ORDER BY failed_count DESC`
  );
  return r.rows;
}

/* ========================== المستخدمون (server_users) ========================== */
async function findByUsername(username) {
  const r = await pool.query(
    'SELECT id, username, password_hash, role, display_name, email, token_version, is_active, failed_login_count, locked_until, totp_enabled, totp_secret, totp_backup_codes, last_login_history_seen_at FROM server_users WHERE username = $1',
    [username.trim()]
  );
  return r.rows[0] || null;
}
async function listUsers() {
  const r = await pool.query(
    'SELECT id, username, display_name, role, is_active, email, created_at FROM server_users ORDER BY created_at ASC'
  );
  return r.rows;
}
async function listReceptionUsers() {
  const r = await pool.query(
    "SELECT username, display_name FROM server_users WHERE role = 'reception' ORDER BY created_at ASC"
  );
  return r.rows;
}
async function createOrUpdateUser({ username, hash, displayName, role, email }) {
  const r = await pool.query(
    `INSERT INTO server_users (username, password_hash, display_name, role, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = COALESCE(EXCLUDED.display_name, server_users.display_name),
       role = EXCLUDED.role,
       email = COALESCE(EXCLUDED.email, server_users.email),
       token_version = server_users.token_version + 1
     RETURNING id, username, display_name, role, email, created_at`,
    [username.trim(), hash, displayName || username.trim(), role, email]
  );
  return r.rows[0];
}
async function deleteUser(username) {
  await pool.query('DELETE FROM server_users WHERE username = $1', [username]);
}
async function logoutUser(id) {
  await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE id = $1', [id]);
}
async function forceLogout(username) {
  const r = await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE username = $1 RETURNING username', [username]);
  return r.rows[0] || null;
}
async function toggleActive(username) {
  const r = await pool.query(
    `UPDATE server_users
     SET is_active = NOT is_active, token_version = token_version + 1
     WHERE username = $1
     RETURNING username, is_active`,
    [username]
  );
  return r.rows[0] || null;
}
async function markHistorySeen(username) {
  await pool.query('UPDATE server_users SET last_login_history_seen_at = now() WHERE username = $1', [username]);
}
async function markHistorySeenById(id) {
  await pool.query('UPDATE server_users SET last_login_history_seen_at = now() WHERE id = $1', [id]);
}
async function incrementFailedLogin(id) {
  await pool.query(
    `UPDATE server_users SET
       failed_login_count = CASE WHEN failed_login_count + 1 >= 5 THEN 0 ELSE failed_login_count + 1 END,
       locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + INTERVAL '15 minutes' ELSE locked_until END
     WHERE id = $1`,
    [id]
  );
}
async function resetFailedLogin(id) {
  await pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [id]);
}

/* ========================== ربط الترخيص (license_bindings / license_activity) ========================== */
async function getLicenseBinding(clientId) {
  const r = await pool.query('SELECT bound_ip, bound_fingerprint FROM license_bindings WHERE client_id = $1', [clientId]);
  return r.rows[0] || null;
}
async function updateLicenseBindingLastSeen(clientId, ip, fp) {
  await pool.query(
    'UPDATE license_bindings SET last_ip = $2, last_fingerprint = $3, last_seen_at = now() WHERE client_id = $1',
    [clientId, ip, fp]
  );
}
async function insertLicenseBinding(clientId, ip, fp) {
  await pool.query(
    `INSERT INTO license_bindings (client_id, bound_ip, bound_fingerprint, last_ip, last_fingerprint)
     VALUES ($1, $2, $3, $2, $3)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId, ip, fp]
  );
}
async function recordLicenseActivity({ clientId, ip, fp, country, city, isNewIp, isNewDevice }) {
  await pool.query(
    `INSERT INTO license_activity (client_id, ip_address, device_fingerprint, country, city, is_new_ip, is_new_device)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [clientId, ip, fp, country || null, city || null, isNewIp, isNewDevice]
  );
}

/* ========================== روابط الدخول عبر الإيميل (magic_link_tokens) ========================== */
async function insertMagicLink(username, tokenHash, expiresAt) {
  await pool.query(
    'INSERT INTO magic_link_tokens (username, token_hash, expires_at) VALUES ($1, $2, $3)',
    [username, tokenHash, expiresAt]
  );
}
async function findValidMagicLink(username, tokenHash) {
  const r = await pool.query(
    `SELECT * FROM magic_link_tokens
     WHERE username = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [username, tokenHash]
  );
  return r.rows[0] || null;
}
async function claimMagicLink(id) {
  const r = await pool.query('UPDATE magic_link_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [id]);
  return r.rowCount > 0;
}
async function releaseMagicLink(id) {
  await pool.query('UPDATE magic_link_tokens SET used_at = NULL WHERE id = $1', [id]);
}

/* ========================== مهام التنظيف الدورية (من server.js) ========================== */
async function cleanLoginHistory() {
  const r = await pool.query(`DELETE FROM login_history WHERE logged_in_at < now() - INTERVAL '90 days'`);
  return r.rowCount;
}
async function cleanMagicLinkTokens() {
  const r = await pool.query(`DELETE FROM magic_link_tokens WHERE created_at < now() - INTERVAL '7 days'`);
  return r.rowCount;
}

// نسخ/تحديث حساب من سكربت الإعداد seed-user.js — بدون إبطال الجلسات الحالية (token_version لا يزيد)
async function seedUpsertUser({ username, hash, displayName, role }) {
  await pool.query(
    `INSERT INTO server_users (username, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = COALESCE(EXCLUDED.display_name, server_users.display_name),
       role = EXCLUDED.role`,
    [username.trim(), hash, displayName || username.trim(), role]
  );
}

module.exports = {
  setTotpPendingSecret, getTotpPendingSecret, enableTotp, getPasswordHash, disableTotp, getTotpEnabled,
  recordLogin, lastSuccessfulLogin, deviceSeen, ipSeen, usualCountry, loginHistory,
  suspiciousActivitySince, suspiciousLastHour,
  findByUsername, listUsers, listReceptionUsers, createOrUpdateUser, deleteUser,
  logoutUser, forceLogout, toggleActive, markHistorySeen, markHistorySeenById,
  incrementFailedLogin, resetFailedLogin,
  getLicenseBinding, updateLicenseBindingLastSeen, insertLicenseBinding, recordLicenseActivity,
  insertMagicLink, findValidMagicLink, claimMagicLink, releaseMagicLink,
  cleanLoginHistory, cleanMagicLinkTokens, seedUpsertUser,
};
