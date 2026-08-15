const express = require('express');
const router = express.Router();
const { pool } = require('./db');
const { requireAuth, requireRole } = require('./auth');

/* مشروع تقييد صلاحيات kv_store حسب الدور — تدريجي وليس دفعة واحدة، لأن أغلب
   المفاتيح مُحمَّلة فعلياً من كل الأدوار عبر مسارات كود مشتركة (مثال: ملخص لوحة
   التحكم المتاحة للاستقبال كان يعتمد على بيانات الخزنة رغم أن تبويب "الخزنة"
   نفسه محجوب عنهم — تم فصل هذا في الواجهة، راجع renderCfoDashboard). كل مفتاح
   يُضاف هنا فقط بعد فحص فعلي (grep شامل على كل دوال render في ملفات frontend/js)
   يتأكد أنه غير مُستخدَم من أي شاشة متاحة للأدوار الممنوعة منه.

   المصدر الفعلي لصلاحيات كل دور (staff/accountant/reception) هو جدول role_permissions
   (غير مشفّر، راجع تعليقه فى schema.sql) — يُحمَّل فى ROLE_PERMISSIONS_CACHE عند الإقلاع
   ويُحدَّث فوراً عند أي حفظ من شاشة الإعدادات → "صلاحيات الأدوار" عبر PUT /api/role-permissions
   أدناه، فيسري فرض القيد الفعلي على الـ API لحظياً بدل انتظار تعديل الكود يدوياً كما كان الحال
   سابقاً (كانت هذه القائمة ثابتة بالكود وتختلف عن settings.rolePermissions القابلة للتعديل من
   الواجهة، فيبقى تعديل الأدمن للصلاحيات مجرد إخفاء/إظهار تبويب بصري بلا أي أثر حقيقي على الـ API). */
let ROLE_PERMISSIONS_CACHE = { admin: null, staff: null, accountant: [], reception: [] };
// نُبقيها هنا فقط كقيمة أولية تُستخدم لتعبئة الجدول أول مرة لو كان فارغاً (تركيب جديد للسيرفر)،
// مطابقة تماماً لآخر افتراضي كانت الواجهة تستخدمه (راجع DEFAULT_SETTINGS.rolePermissions فى
// theme-settings.js) — بعدها الجدول نفسه هو المرجع الوحيد ولا علاقة لهذا الثابت بأي تنفيذ لاحق.
const ROLE_PERMISSIONS_SEED_DEFAULTS = {
  staff: ['dashboard', 'clients', 'companies', 'courses', 'courseinvoices', 'vault', 'settlements', 'bags', 'purchases', 'reports'],
  accountant: ['dashboard', 'clients', 'vault', 'settlements', 'accounting', 'budget', 'reports', 'purchases', 'companies'],
  reception: ['clients'],
};
async function loadRolePermissionsCache() {
  const r = await pool.query('SELECT role, views FROM role_permissions');
  if (r.rows.length === 0) {
    // أول تشغيل للسيرفر بعد إضافة الجدول: نزرعه بالافتراضي الحالي حتى لا يفقد أي عميل صلاحياته
    // الفعلية فجأة (لو تُرك فارغاً، roleCanAccessView كانت سترفض كل شيء لغير admin افتراضياً أدناه).
    for (const role of Object.keys(ROLE_PERMISSIONS_SEED_DEFAULTS)) {
      await pool.query(
        `INSERT INTO role_permissions (role, views, updated_by) VALUES ($1, $2, 'system-seed')
         ON CONFLICT (role) DO NOTHING`,
        [role, JSON.stringify(ROLE_PERMISSIONS_SEED_DEFAULTS[role])]
      );
    }
    return loadRolePermissionsCache();
  }
  const cache = { admin: null, staff: [], accountant: [], reception: [] };
  for (const row of r.rows) cache[row.role] = Array.isArray(row.views) ? row.views : [];
  ROLE_PERMISSIONS_CACHE = cache;
}
const RESTRICTED_STAFF_VIEWS = ['settings', 'audit', 'accounting', 'zatca', 'budget'];
function roleCanAccessView(role, view) {
  if (role === 'admin') return true;
  const allow = ROLE_PERMISSIONS_CACHE[role];
  if (Array.isArray(allow)) return allow.includes(view);
  return !RESTRICTED_STAFF_VIEWS.includes(view); // دور غير معروف: قائمة حظر احترازية قديمة كخط دفاع أخير
}
const EDITABLE_ROLE_PERMISSION_ROLES = ['staff', 'accountant', 'reception'];
// نفس ALL_VIEWS المعروضة فى شاشة الإعدادات (theme-settings.js) — نتحقق منها هنا حتى لا يستطيع
// أي admin (أو طلب مُعدَّل يدوياً) حفظ اسم شاشة وهمي أو مسافات فارغة فى الجدول بالغلط.
const ALL_KNOWN_VIEWS = ['dashboard', 'clients', 'companies', 'courses', 'courseinvoices', 'vault', 'settlements', 'bags', 'purchases', 'zatca', 'reports', 'accounting', 'budget', 'audit', 'settings'];
// GET /api/role-permissions -> { reception:[...], staff:[...], accountant:[...] } — نفس القيم
// المُفروضة فعلياً على الـ API، تُستخدم لتعبئة جدول "صلاحيات الأدوار" فى شاشة الإعدادات كمصدر
// حقيقة وحيد بدل الاعتماد على settings.rolePermissions المشفّرة المحلية فقط.
router.get('/api/role-permissions', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const out = {};
    EDITABLE_ROLE_PERMISSION_ROLES.forEach(role => { out[role] = ROLE_PERMISSIONS_CACHE[role] || []; });
    res.json({ rolePermissions: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب صلاحيات الأدوار' });
  }
});
// PUT /api/role-permissions  body: { reception:[...], staff:[...], accountant:[...] } -> نفس الشكل
// يستبدل صلاحيات كل دور بالكامل (لا يدمج جزئياً) ويُحدِّث الكاش فوراً — الأدمن فقط.
router.put('/api/role-permissions', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const toSave = {};
    for (const role of EDITABLE_ROLE_PERMISSION_ROLES) {
      const views = body[role];
      if (!Array.isArray(views) || views.some(v => typeof v !== 'string' || !ALL_KNOWN_VIEWS.includes(v))) {
        return res.status(400).json({ error: `صلاحيات الدور '${role}' غير صالحة` });
      }
      toSave[role] = [...new Set(views)];
    }
    // الحفظ في معاملة واحدة: كانت 3 تحديثات منفصلة (لا transaction) — لو فشل الثاني/الثالث
    // تُترك قاعدة البيانات بصلاحيات نصف مطبّقة (دور محدّث ودوران قديمان) مع ذاكرة تخزين مؤقت
    // مُعاد تحميلها من تلك الحالة المختلطة، وأي أدمنين يحفظان معاً قد ينتج حالة نهائية متشابكة.
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      for (const role of EDITABLE_ROLE_PERMISSION_ROLES) {
        await tx.query(
          `INSERT INTO role_permissions (role, views, updated_by, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (role) DO UPDATE SET views = EXCLUDED.views, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [role, JSON.stringify(toSave[role]), req.user.username]
        );
      }
      await tx.query('COMMIT');
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      tx.release();
    }
    await loadRolePermissionsCache();
    res.json({ rolePermissions: toSave });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ صلاحيات الأدوار' });
  }
});
// key -> null: مقصور على admin دائماً (بلا علاقة بأي "شاشة"، مثال: users نظام قديم).
// key -> اسم شاشة: يُطبَّق عليه roleCanAccessView بنفس منطق الواجهة.
const RESTRICTED_STORAGE_KEYS = {
  users: null,
  companyTransfers: 'companies',
  // تحقّقتُ عبر فحص كل دالة render تستخدم كل مفتاح من هذه: كلها مقصورة فعلياً
  // على شاشتها (لا تُستخدم إطلاقاً من أي شاشة متاحة لـ'استقبال'، وهو الدور
  // الوحيد الأضيق صلاحية هنا؛ منطق roleCanAccessView يغطي 'موظف عام' تلقائياً
  // عبر RESTRICTED_STAFF_VIEWS بما يطابق الواجهة تماماً).
  journalEntries: 'accounting',
  chartOfAccounts: 'accounting',
  journalDE: 'accounting',
  manualSalesInvoices: 'accounting',
  budgetEntries: 'budget',
  suppliers: 'purchases',
  zakatAdjustments: 'zatca',
  // تحقّقت أن الاتنين دول مقصورين فعلياً على شاشة 'الخزنة' (renderVault/renderBankRecon)
  // ولا يُستخدمان من أي شاشة متاحة للاستقبال — بخلاف vaultTx وdeletedVaultTx وdeletedInvoices
  // اللي فحصتها ولقيتها متشابكة فعلياً مع ميزات شرعية في شاشتي 'العملاء' و'الحقائب'.
  vaultDenomTx: 'vault',
  bankStatementRows: 'vault',
  // سجل التدقيق محتواه حساس (من؟ ماذا؟ متى؟) ويُقرأ فقط من شاشة 'التدقيق' المغلقة عن كل الأدوار
  // غير الأدمن (راجع RESTRICTED_STAFF_VIEWS/ROLE_PERMISSIONS) — فيُقيَّد هنا على نفس الشاشة بدل
  // بقائه مفتوحاً كتصنيف بيانات عادي لأي دور مصادق يفتح /api/records/auditLog مباشرة.
  auditLog: 'audit',
};
function restrictKeyToAdmin(req, res, next) {
  const key = req.params.key;
  // 'clients' مفتاح قديم (كتلة واحدة لكل عملاء الشركة) قبل ميلاد نظام client_records. لسه مستخدَم
  // كخط رجعة فقط عند انقطاع الاتصال أو أول تحميل قبل تأكيد المزامنة (راجع saveClients فى
  // ui-framework.js). بعد عزل كل مستخدم استقبال عن الآخر، مصفوفة "clients" فى ذاكرة أي مستخدم
  // استقبال بقت تحتوي بياناته الشخصية فقط (مش كل مستخدمي الاستقبال زي الأول) — فلو خط الرجعة ده
  // اشتغل واستبدل الكتلة المشتركة الكاملة (كل عملاء الشركة) بمصفوفة مستخدم استقبال واحد الصغيرة،
  // هيمحو بيانات باقي الشركة. نمنع دور 'reception' نهائياً من الكتابة/القراءة على هذا المفتاح
  // تحديداً (بخلاف كل الأدوار الأخرى التي تبقى كما كانت)، فيعتمد فقط على مسار client_records الآمن.
  if (key === 'clients' && req.user.role === 'reception') {
    return res.status(403).json({ error: 'ليست لديك صلاحية الوصول لهذا المفتاح' });
  }
  if (!(key in RESTRICTED_STORAGE_KEYS)) return next();
  const view = RESTRICTED_STORAGE_KEYS[key];
  const allowed = view === null ? req.user.role === 'admin' : roleCanAccessView(req.user.role, view);
  if (!allowed) return res.status(403).json({ error: 'ليست لديك صلاحية كافية للوصول لهذه البيانات' });
  next();
}

// GET /api/storage/:key  -> { key, value, version }
// يدعم If-None-Match: لو الجهاز عنده نفس النسخة (version) بالفعل، نرد 304 بدون
// إعادة إرسال القيمة كاملة (ممكن تكون مئات الكيلوبايتات لمفاتيح زي قوائم العملاء
// أو حركات الخزنة)، فنوفر نقل البيانات في كل مرة يفتح فيها المستخدم البرنامج
// ولم يتغيّر شيء منذ آخر زيارة.
// GET /api/clients?page=&pageSize=&search=&nationality=&courseType=&dateFrom=&dateTo=&sort=&order=
// ترقيم/بحث/فلترة حقيقية من قاعدة البيانات (بدون تحميل كل العملاء للمتصفح)، تُستخدم فقط من
// شاشة "جدول العملاء" نفسها للحالات الشائعة (تصفح + بحث بالاسم/الهوية + فلترة بالجنسية/الدورة/التاريخ).
// فلاتر المبالغ (مدين/مسدد) والفرز بالمبالغ غير مدعومة هنا عمداً لأنها تعتمد على حسابات معقّدة

module.exports = {
  router,
  loadRolePermissionsCache,
  roleCanAccessView,
  restrictKeyToAdmin,
};
