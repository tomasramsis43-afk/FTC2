-- ============================================================
-- قاعدة البيانات المركزية لبرنامج إدارة المركز
-- ============================================================
-- جدول المستخدمين المصرّح لهم بالدخول على الخادم (مستقل عن نظام
-- "المستخدمين" الداخلي في البرنامج نفسه — هذا الجدول يتحكم بمن يصل
-- إلى البيانات على الإطلاق، والنظام الداخلي يتحكم بصلاحيات كل
-- مستخدم داخل البرنامج بعد الدخول).
CREATE TABLE IF NOT EXISTS server_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- صلاحية المستخدم (admin = صلاحيات كاملة، staff = صلاحيات محدودة). تُضاف بأمان
-- على الجداول الموجودة مسبقاً؛ الافتراضي "staff" (الأضيق) حتى لا يُمنح أي حساب
-- قديم صلاحيات كاملة تلقائياً بمجرد إضافة العمود.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'staff';

-- عدّاد يُستخدم لإبطال كل توكنات JWT الحالية لهذا المستخدم فوراً (تسجيل خروج
-- حقيقي من طرف الخادم، أو عند تغيير كلمة المرور/الصلاحية من طرف admin) بدل
-- انتظار انتهاء صلاحية التوكن (30 يوماً). كل توكن يحمل القيمة وقت إصداره،
-- وأي زيادة في هذا العمود تُبطل فوراً كل التوكنات الأقدم لنفس المستخدم.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- تعطيل/تفعيل حساب المستخدم من طرف المدير (بدون حذفه نهائياً). الحساب المعطّل
-- يُرفض فوراً عند تسجيل الدخول، وأي جلسة مفتوحة له تُقطع فوراً أيضاً (راجع
-- requireAuth في auth.js) دون انتظار انتهاء صلاحية التوكن. الافتراضي "مفعّل"
-- حتى لا يتأثر أي حساب موجود مسبقاً بمجرد إضافة العمود.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- مخزن مفاتيح/قيم يطابق تماماً واجهة window.storage الحالية في البرنامج
-- (كل مفتاح = مصفوفة/كائن JSON واحد مشفّر بالكامل من طرف المتصفح،
-- الخادم لا يفكّ أي تشفير ولا يفهم محتوى القيمة، فقط يخزّنها).
-- عمود version يُستخدم للتحقق من عدم التعارض عند حفظ متزامن من أكثر
-- من جهاز لنفس المفتاح (Optimistic Concurrency Control).
CREATE TABLE IF NOT EXISTS kv_store (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

-- ============================================================
-- ربط هيئة الزكاة والضريبة والجمارك (فاتورة — المرحلة الثانية)
-- ============================================================

-- بيانات الاعتماد الناتجة عن التسجيل مع الهيئة (CSID). صف واحد فقط عادةً
-- (WHERE is_active = true)، يُحدَّث عند كل تجديد/إصدار شهادة جديدة.
-- المفتاح الخاص والأسرار هنا حسّاسة جداً — هذا الجدول لا يُقرأ أبداً من
-- الواجهة الأمامية، فقط من كود الخادم وقت بناء/توقيع/إرسال الفواتير.
CREATE TABLE IF NOT EXISTS zatca_credentials (
  id                  SERIAL PRIMARY KEY,
  environment         TEXT NOT NULL,              -- 'sandbox' | 'simulation' | 'production'
  private_key_pem     TEXT,                        -- (اختياري الآن، الحالة الكاملة داخل egs_info) مفتاح secp256k1 الخاص
  compliance_csid     TEXT,                        -- Binary Security Token (compliance)
  compliance_secret   TEXT,
  production_csid     TEXT,                        -- Binary Security Token (production/PCSID)
  production_secret   TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- الحالة الكاملة لوحدة EGS (بصيغة EGSUnitInfo التي تتوقعها مكتبة zatca-xml-js) —
-- نخزّنها ككائن JSON واحد بدل تفريقها على أعمدة، لتفادي أي عدم تطابق بسيط بين
-- تسمياتنا وتسميات المكتبة. الأعمدة أعلاه تبقى للاستعلام السريع فقط.
ALTER TABLE zatca_credentials ADD COLUMN IF NOT EXISTS egs_info JSONB;
ALTER TABLE zatca_credentials ALTER COLUMN private_key_pem DROP NOT NULL;

-- سجل كل فاتورة إلكترونية (مبيعات أو إشعار دائن/مردود) تم بناؤها وإرسالها،
-- بما يحقق سلسلة تجزئة الفواتير (كل فاتورة ترتبط بهاش الفاتورة السابقة لها،
-- وهو شرط أساسي من الهيئة). invoice_counter تسلسلي صارم لا يجوز أن يتكرر
-- أو يُحذف صف بعد إرساله بنجاح.
CREATE TABLE IF NOT EXISTS zatca_invoice_log (
  id                SERIAL PRIMARY KEY,
  invoice_uuid      TEXT UNIQUE NOT NULL,
  invoice_type      TEXT NOT NULL,        -- 'standard' (B2B) | 'simplified' (B2C)
  document_type     TEXT NOT NULL,        -- 'invoice' | 'credit_note' (مردود مبيعات) | 'debit_note'
  source_ref        TEXT,                 -- ربط بمعرّف العميل/الحركة داخل التطبيق (clientId أو vaultTx id)
  invoice_counter   INTEGER NOT NULL,     -- ICV تسلسلي عام لكل الفواتير
  previous_hash     TEXT NOT NULL,        -- PIH: هاش الفاتورة السابقة في السلسلة
  invoice_hash      TEXT NOT NULL,        -- هاش هذه الفاتورة (يصبح previous_hash للفاتورة التالية)
  xml               TEXT,                 -- UBL 2.1 XML قبل التوقيع
  signed_xml        TEXT,                 -- XML بعد التوقيع الرقمي (XAdES) — ما يُرسل فعلياً
  qr_base64         TEXT,                 -- حمولة QR النهائية (9 حقول TLV)
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|cleared|reported|warning|error
  zatca_response     JSONB,                -- استجابة الهيئة كاملة (لأغراض التدقيق)
  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zatca_invoice_log_counter ON zatca_invoice_log(invoice_counter);
CREATE INDEX IF NOT EXISTS idx_zatca_invoice_log_source ON zatca_invoice_log(source_ref);

-- ============================================================
-- جدول العملاء كصفوف حقيقية مفهرسة (Pagination من السيرفر)
-- ============================================================
-- المصدر الأساسي لبيانات العملاء يبقى مفتاح kv_store('clients') كما هو تماماً
-- (كل الشاشات الأخرى — اللوحة، التقارير، المحاسبة، مطابقة الشركات... — تقرأ منه
-- بلا أي تغيير). هذا الجدول نسخة "مفهرسة" منه فقط، تُحدَّث تلقائياً في كل مرة
-- يُحفظ فيها مفتاح clients عبر PUT /api/storage/clients (نفس مسار الحفظ الحالي
-- بدون أي تعديل في الواجهة الأمامية لبقية الشاشات)، وتُستخدم حصراً من نقطة
-- النهاية الجديدة GET /api/clients لعرض/بحث/ترقيم شاشة "جدول العملاء" فقط،
-- بدل تحميل كل الـ5000+ سجل للمتصفح وتقطيعها بجافاسكربت في كل مرة.
CREATE TABLE IF NOT EXISTS clients_rows (
  id            TEXT PRIMARY KEY,
  data          JSONB NOT NULL,
  name          TEXT,
  client_id     TEXT,
  refer_num     TEXT,
  nationality   TEXT,
  course_type   TEXT,
  course_number TEXT,
  invoice_no    TEXT,
  reg_date      TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_rows_name ON clients_rows(name);
CREATE INDEX IF NOT EXISTS idx_clients_rows_client_id ON clients_rows(client_id);
CREATE INDEX IF NOT EXISTS idx_clients_rows_course_type ON clients_rows(course_type);
CREATE INDEX IF NOT EXISTS idx_clients_rows_nationality ON clients_rows(nationality);
CREATE INDEX IF NOT EXISTS idx_clients_rows_reg_date ON clients_rows(reg_date);

-- ملاحظة: كان هنا سابقاً جدول purchase_invoices منفصل، لكن تبيّن أن المشتريات
-- مُدارة بالفعل بالكامل عبر kv_store (window.storage) كباقي بيانات التطبيق —
-- فحُذف الجدول المنفصل لتفادي ازدواجية مصدر البيانات (تم الحذف فعلياً؛ إن
-- احتجت جدولاً بهذا الاسم لغرض آخر مستقبلاً، تأكد من عدم وجود أي DROP قديم
-- في هذا الملف قد يحذفه صامتاً في كل مرة يُشغَّل فيها السيرفر).

-- تخزين كل عميل "لوحده" كسجل مستقل، بدل الاعتماد فقط على مفتاح kv_store('clients') الذي يخزّن
-- كل العملاء ككتلة واحدة مشفّرة بمفتاح تشفير واحد على مستوى المصفوفة كلها. المشكلة العملية فى ذلك
-- (حتى بعد ضغط البيانات ENC2): أي إضافة/تعديل/حذف لعميل واحد كان لازم يعيد رفع كل المصفوفة (كل
-- الآلاف من العملاء) من جديد كل مرة، لأن التشفير مطبَّق على النص كله دفعة واحدة فمينفعش نعدّل جزء
-- منه لوحده. الحل: يُشفَّر كل عميل بمفرده على جهاز المستخدم (enc يبقى نصاً معتماً كالمعتاد تماماً،
-- السيرفر لا يفك تشفيره إطلاقاً ولا يعرف محتواه) ويُخزَّن هنا كصف مستقل، فيصبح تسجيل/تعديل/حذف
-- عميل واحد = صف واحد يتغيّر فقط، بغض النظر عن إجمالي عدد العملاء المسجَّلين.
CREATE TABLE IF NOT EXISTS client_records (
  id            TEXT PRIMARY KEY,
  enc           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);
-- عزل بيانات الاستقبال: كل عميل يُسجَّله مستخدم بدور 'reception' يُوسَم origin='reception'
-- ويبدأ status='pending' (مسودة معلّقة لا تظهر لغير الاستقبال/الأدمن ولا تدخل أي حسابات/تقارير/VAT)
-- لحد ما الأدمن "يعتمدها" (status يتحول confirmed) فتصبح عميلاً عادياً ظاهراً للجميع كباقي العملاء.
-- أي عميل أضافه أدمن/محاسب/موظف عام يبقى origin='general', status='confirmed' كالسابق تماماً (بلا أي تغيير).
ALTER TABLE client_records ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'general';
ALTER TABLE client_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
CREATE INDEX IF NOT EXISTS idx_client_records_origin_status ON client_records(origin, status);
-- عزل كل مستخدم استقبال عن الآخر: created_by يُسجَّل مرة واحدة فقط عند إنشاء السجل ولا يتغيّر
-- بعدها أبداً (بعكس updated_by الذي يتحدّث مع كل تعديل)، فيبقى دائماً هوية صاحب السجل الأصلي
-- حتى لو حرّره الأدمن لاحقاً. للسجلات القديمة قبل هذا العمود نملأها افتراضياً من updated_by.
ALTER TABLE client_records ADD COLUMN IF NOT EXISTS created_by TEXT;
UPDATE client_records SET created_by = updated_by WHERE created_by IS NULL;
-- رقم الهوية بنص صريح (غير مشفّر) لغرض واحد فقط: كشف التكرار عبر كل مستخدمي النظام (بما فيهم
-- الاستقبال المعزول عادةً عن رؤية باقي البيانات) قبل الحفظ، دون كشف أي بيانات أخرى عن العميل
-- (الاسم/الهاتف/المبالغ...) تبقى بالكامل داخل enc المشفّر كما هي تماماً بلا أي تغيير.
ALTER TABLE client_records ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_client_records_client_id ON client_records(client_id);

-- ============================================================
-- تخزين عام لأي تصنيف بيانات كسجلات مستقلة (سجل واحد = صف واحد)
-- ============================================================
-- نفس فكرة client_records بالضبط لكن قابلة لإعادة الاستخدام لأي شيت آخر (الخزنة، المخزون،
-- المحاسبة، الشركات، المشتريات...) بدل تكرار جدول مستقل لكل شيت. عمود collection يفصل بيانات
-- كل شيت عن الآخر (مثال: 'vaultTx', 'bagStock', 'companies'...). enc مشفّر بالكامل من المتصفح
-- تماماً كباقي أنظمة التخزين — السيرفر لا يفك أي تشفير ولا يفهم المحتوى، فقط يخزّنه.
CREATE TABLE IF NOT EXISTS collection_records (
  collection    TEXT NOT NULL,
  id            TEXT NOT NULL,
  enc           TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT,
  PRIMARY KEY (collection, id)
);
-- ملاحظة: لا حاجة لإندكس منفصل على عمود collection وحده — المفتاح الأساسي المركّب
-- PRIMARY KEY (collection, id) يغطي بالفعل أي استعلام WHERE collection = X (العمود القائد
-- فى الإندكس المركّب)، فأي إندكس إضافي عليه وحده تكرار بلا فائدة حقيقية.
DROP INDEX IF EXISTS idx_collection_records_collection;

-- عزل بيانات الاستقبال في السجلات العامة: نفس نمط client_records تماماً. أي سجل يسجّله
-- مستخدم بدور 'reception' في تصنيفات التشغيل (الخزنة/المخزون/الدورات) يُوسَم origin='reception'
-- ويبدأ status='pending' (مسودة معلّقة لا تظهر لغير صاحبه/الأدمن ولا تدخل أي مزامنة أو حساب
-- أو تقرير لأي دور آخر) حتى يعتمدها الأدمن (status -> confirmed). السجلات العامة كلها تبقى
-- confirmed تماماً كما كانت — بلا أي تغيير في سلوكها الحالي.
ALTER TABLE collection_records ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'general';
ALTER TABLE collection_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE collection_records ADD COLUMN IF NOT EXISTS created_by TEXT;
-- created_by يُسجَّل مرة واحدة عند إنشاء السجل ولا يتغيّر لاحقاً (عزل مستخدمي الاستقبال عن
-- بعضهم مهما عُدِّل السجل أو اُعتمد) — القيم القديمة تُملأ من آخر من حدّث السجل كما هو متاح.
UPDATE collection_records SET created_by = updated_by WHERE created_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_collection_records_origin_status ON collection_records(origin, status);

-- سجل عمليات تسجيل الدخول الناجحة إلى الخادم (متى، من أي عنوان IP) — يُستخدم
-- في شاشة الإعدادات لمتابعة نشاط الحسابات (سجل الدخول والجلسات).
CREATE TABLE IF NOT EXISTS login_history (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL,
  role         TEXT,
  ip_address   TEXT,
  device_info  TEXT,
  logged_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE login_history ADD COLUMN IF NOT EXISTS device_info TEXT;
-- محاولات الدخول الفاشلة (اسم مستخدم خطأ/كلمة مرور خطأ/حساب معطّل) — لرصد أنماط brute-force
-- أو محاولات دخول غير مصرّح بها لم تكتشفها rate limiting وحدها (مثال: محاولات متفرقة بطيئة).
ALTER TABLE login_history ADD COLUMN IF NOT EXISTS success BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_login_history_username ON login_history(username);
CREATE INDEX IF NOT EXISTS idx_login_history_logged_in_at ON login_history(logged_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_history_failed ON login_history(logged_in_at DESC) WHERE success = false;

-- نسخ احتياطية كاملة مُجدوَلة: "enc" هو نفس محتوى gatherFullBackupData() فى الواجهة، بعد تشفيره
-- بمفتاح المستخدم (نفس آلية encryptValue المستخدمة لكل بيانات البرنامج) — السيرفر لا يرى ولا
-- يقدر يفك أي بيانات فعلية هنا أبداً، فقط يخزّن الكتلة المشفّرة كما هي.
CREATE TABLE IF NOT EXISTS app_backups (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'auto', -- 'auto' أو 'manual'
  enc          TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_backups_created_at ON app_backups(created_at DESC);

-- المصادقة الثنائية (TOTP) — متاحة لأي مستخدم لكن الاستخدام الفعلي حالياً مقتصر على الأدمن.
-- totp_secret مخزّن base32 خام (نفس ما تتطلبه تطبيقات المصادقة العادية Google/Microsoft Authenticator)؛
-- لا يُعتبر سراً حساساً بنفس درجة كلمة المرور (لا يُستخدم بمفرده للدخول)، فلا حاجة لتشفيره إضافياً.
-- pending_secret يُستخدم أثناء خطوة الإعداد فقط (قبل تأكيد أول كود بنجاح)، ثم يُنقل إلى totp_secret.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT; -- JSON: مصفوفة { hash, usedAt } لأكواد احتياطية أحادية الاستخدام

-- قفل تلقائي مؤقت للحساب بعد محاولات دخول فاشلة متتالية (بغض النظر عن الـ IP، على عكس rate
-- limiting الحالي الذي يعمل بالـ IP فقط) — يحمي من محاولة تخمين موزّعة على عدة أجهزة/شبكات.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
-- آخر مرة راجع فيها هذا المستخدم (أدمن) شاشة "سجل الدخول" — تُستخدم لتنبيهه فور تسجيل الدخول
-- التالي لو ظهر نشاط مشبوه جديد لم يشاهده بعد، بدل انتظار فتحه شاشة الإعدادات بنفسه.
ALTER TABLE server_users ADD COLUMN IF NOT EXISTS last_login_history_seen_at TIMESTAMPTZ;
