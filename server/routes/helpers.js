// مساعد مشترك لمنطق عزل الاستقبال — مستخرج من records.js لتقليل حجمه (1235→~900) بدون كسر
function clientRecordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: `WHERE origin = $1 AND created_by = $2 AND (status <> 'rejected' OR rejected_at > now() - INTERVAL '15 days')`, params: ['reception', username] };
  return { where: 'WHERE status = $1', params: ['confirmed'] };
}
function recordsVisibilitySql(role, username) {
  if (role === 'admin') return { where: '', params: [] };
  if (role === 'reception') return { where: 'AND origin = $2 AND created_by = $3', params: ['reception', username] };
  // ملحوظة: هذا الفرع (كل الأدوار غير admin/reception، أي accountant/staff) كان يستخدم $1 هنا،
  // لكن كل الاستدعاءات (recordsByCollection و recordVersionPairs) تُلحق هذا الشرط بعد شرط
  // `WHERE collection = $1` — فـ$1 محجوز بالفعل لاسم التصنيف، وقيمة الحالة (confirmed) يجب أن
  // ترتبط بـ$2. كان هذا يسبب فشل 500 قاتل لكل مستخدم بدور accountant أو staff عند أي محاولة
  // جلب بيانات (bind message supplies 2 parameters, but prepared statement requires 1) —
  // يعطّل المزامنة بالكامل لهذين الدورين.
  return { where: 'AND status = $2', params: ['confirmed'] };
}
const APPROVAL_GATED_COLLECTIONS = ['vaultTx', 'bagStock', 'courseSessions'];
const ALLOWED_COLLECTIONS = [
  'bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','deletedInvoices',
  'courseSessions','auditLog','companies','companyTransfers','journalEntries','chartOfAccounts',
  'journalDE','budgetEntries','suppliers','purchases','manualSalesInvoices','scheduledVaultTx',
  'followUpTasks',
];
module.exports = { clientRecordsVisibilitySql, recordsVisibilitySql, APPROVAL_GATED_COLLECTIONS, ALLOWED_COLLECTIONS };
