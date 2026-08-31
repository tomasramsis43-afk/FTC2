// ============================================================
// webauthn.repo.js — طبقة الوصول لبيانات البصمات/أجهزة الدخول
// (webauthn_credentials)
// ------------------------------------------------------------
// سلوك مطابق لما كان داخل routes/webauthn.js — نقل ميكانيكي فقط.
// ============================================================
const { pool } = require('../db');

async function listCredentialIds(username) {
  const r = await pool.query('SELECT credential_id FROM webauthn_credentials WHERE username = $1', [username]);
  return r.rows;
}
async function insertCredential({ username, credentialId, publicKeyB64, counter, deviceType, backedUp, transportsJson, nickname }) {
  await pool.query(
    `INSERT INTO webauthn_credentials (username, credential_id, public_key, counter, device_type, backed_up, transports, nickname)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [username, credentialId, publicKeyB64, counter, deviceType, backedUp, transportsJson, nickname]
  );
}
async function listCredentials(username) {
  const r = await pool.query(
    'SELECT id, nickname, device_type, created_at, last_used_at FROM webauthn_credentials WHERE username = $1 ORDER BY created_at DESC',
    [username]
  );
  return r.rows;
}
async function deleteCredential(id, username) {
  await pool.query('DELETE FROM webauthn_credentials WHERE id = $1 AND username = $2', [id, username]);
}
async function findByCredentialId(credentialId) {
  const r = await pool.query(
    'SELECT id, username, credential_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id = $1',
    [credentialId]
  );
  return r.rows[0] || null;
}
async function updateCounter(id, newCounter) {
  await pool.query(
    'UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE id = $2',
    [newCounter, id]
  );
}

module.exports = {
  listCredentialIds, insertCredential, listCredentials, deleteCredential,
  findByCredentialId, updateCounter,
};