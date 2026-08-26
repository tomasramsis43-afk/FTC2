// مساعد مشترك لمنطق عزل الاستقبال — مستخرج من records.js لتقليل حجمه (1235→~900) بدون كسر
function clientRecordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: `WHERE origin = $1 AND created_by = $2 AND (status <> 'rejected' OR rejected_at > now() - INTERVAL '15 days')`, params: ['reception', username] };
  return { where: 'WHERE status = $1', params: ['confirmed'] };
}
function recordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: 'AND origin = $2 AND created_by = $3', params: ['reception', username] };
  return { where: 'AND status = $1', params: ['confirmed'] };
}
const APPROVAL_GATED_COLLECTIONS = ['vaultTx', 'bagStock', 'courseSessions'];
const ALLOWED_COLLECTIONS = [
  'bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','deletedInvoices',
  'courseSessions','auditLog','companies','companyTransfers','journalEntries','chartOfAccounts',
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices','scheduledVaultTx',
  'followUpTasks',
];
module.exports = { clientRecordsVisibilitySql, recordsVisibilitySql, APPROVAL_GATED_COLLECTIONS, ALLOWED_COLLECTIONS };
