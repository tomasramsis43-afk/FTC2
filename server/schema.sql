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
