/*
  إضافة مستخدم جديد يقدر يسجّل دخول على الخادم المركزي.
  الاستخدام:
    node seed-user.js "اسم_المستخدم" "كلمة_المرور" "الاسم الظاهر (اختياري)" "الصلاحية (اختياري)"
  الصلاحيات المتاحة: admin (كامل) / accountant (محاسب: الأقسام المالية فقط) /
                     reception (استقبال: تسجيل بيانات فقط) / staff (عام: كل شيء ما عدا الإعدادات والمحاسبة)
  مثال (محاسب):
    node seed-user.js sara "ChangeMe#2026" "سارة أحمد" accountant
  مثال (استقبال):
    node seed-user.js omar "ChangeMe#2026" "عمر خالد" reception
  مثال (حساب مدير):
    node seed-user.js admin_user "ChooseYourOwnStrongPassword!" "اسم المدير" admin
  ⚠️ لا تكتب كلمة مرور حقيقية في هذا الملف أو في أي تعليق/مثال — الملف موجود داخل الريبو
  ويمكن لأي شخص يطّلع على الكود (أو على سجل Git التاريخي) أن يراها.
  إذا كان اسم المستخدم موجوداً مسبقاً، يتم تحديث كلمة المرور والصلاحية.
  إذا لم تُحدَّد الصلاحية، أو كانت قيمة غير معروفة، يُعيَّن المستخدم كـ "staff" (الأضيق) تلقائياً كإجراء أمان احترازي.
*/
require('dotenv').config();
const { pool, ensureSchema } = require('./db');
const { hashPassword } = require('./auth');

const VALID_ROLES = ['admin', 'accountant', 'reception', 'staff'];

async function main() {
  const [username, password, displayName, roleArg] = process.argv.slice(2);
  if (!username || !password) {
    console.error('الاستخدام: node seed-user.js <username> <password> ["الاسم الظاهر"] [admin|accountant|reception|staff]');
    process.exit(1);
  }
  const role = VALID_ROLES.includes(roleArg) ? roleArg : 'staff';
  await ensureSchema();
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO server_users (username, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = COALESCE(EXCLUDED.display_name, server_users.display_name),
       role = EXCLUDED.role`,
    [username.trim(), hash, displayName || username.trim(), role]
  );
  console.log(`✅ تم إنشاء/تحديث المستخدم: ${username} (الصلاحية: ${role})`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
