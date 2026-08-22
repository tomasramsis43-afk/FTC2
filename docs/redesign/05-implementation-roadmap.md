# FTC2 Implementation Roadmap — خارطة التنفيذ

> مبدأ التنفيذ: تزايدي لكل مرحلة — فحص الكود ← تحديد الملفات المتأثرة ← شرح ← تنفيذ ← اختبار ← تحقق أن القديم يعمل.
> الخطوط الحمراء ملزمة: لا كسر للمنطق المحاسبي، Schema، APIs، Auth، صلاحيات، تقارير، تكاملات.

---

## المرحلة 0 — إصلاحات حرجة قبل أي تصميم (أسبوع 1)

| # | المهمة | الملفات | المخاطرة إن أُهملت |
|---|---|---|---|
| 0.1 | **فحص البيانات المُصلّبة في app.html** (267 صف في 5 جداول + بيانات موردون حقيقية): هل هي demo أم بيانات عملاء حقيقية؟ إن كانت حقيقية → تنظيف فوري وإزالتها من Git history قرار منفصل | `app.html` (679–2641) | تسريب PII + وميض بيانات زائف |
| 0.2 | إصلاح البحث المكسور: حذف الربط أو بناء العناصر | `module-accounting.js:869–889` | TypeError عند Ctrl+K |
| 0.3 | حذف معالج `data-view="settlements"` الميت | `undo-redo.js:906` | كود ميت مضلل |
| 0.4 | توثيق قرار: README يُحدَّث ليطابق الواقع (blob→جداول جزئية) | `README.md` | وثائق مضللة |

**معيار القبول:** Ctrl+K لا يرمي خطأ، git status نظيف، تشغيل يدوي للتدفقات الرئيسية سليم.

## المرحلة 1 — Design Tokens Foundation (أسبوع 2)

1. حقن block tokens الجديد + legacy aliases أعلى `styles.css`
2. استبدال القيم الحرفية المتسربة (~24 rgba + `#e0a72f`) بالـ aliases
3. Dark theme: ضبط القيم ضمن نفس البنية (`body.dark-theme`)
4. توحيد الظلال على scale الجديد تدريجيًا (بدون لمس selectors)

**المتأثر:** `styles.css` فقط. **اختبار:** تبديل الثيم، شاشات الدخول الثلاث، موبايل ≤768px.

## المرحلة 2 — App Shell + Navigation (أسبوع 3)

1. Header جديد: هوية نبض SVG، الفترة المالية، حالة الاتصال SSE الحقيقية، قائمة مستخدم
2. Rail أيقوني 64px بدل sidebar 260px + Drawer للدوامات الثلاث
3. Contextual tabs داخل كل دومين — فوق dispatch table القائم دون تغييره
4. Command Center v1 (Ctrl+K): بحث محلي مصنف + أوامر أساسية

**المتأثر:** `app.html` (بنية nav/header فقط)، `styles.css`، ملف shell جديد اختياري `frontend/js/shell.js`. **غير المتأثر:** كل دوال render وdispatch.

## المرحلة 3 — Financial Cockpit (أسبوع 4)

1. Financial Pulse (Net Position + مقارنة)
2. Money Flow visualization من vaultTx
3. Activity Stream من auditLog
4. Alerts مجمّعة من القواعد الحالية
5. Quick Actions 4–6
6. تخصيص widgets محفوظ per-user

**المتأثر:** قسم dashboard في `app.html`، `clients-cfo-dashboard.js` (توسيع لا استبدال)، `shell.js`. **الأداء:** حساب واحد مجمّع، لا طلبات جديدة.

## المرحلة 4 — Workspaces للمودويلات (أسابيع 5–8، بالترتيب)

| التسلسل | الوحدة | الشكل المستهدف | ملاحظة أمان |
|---|---|---|---|
| 4a | العملاء | Customer Workspace | كل عمليات الحفظ تبقى عبر المسارات الحالية نفسها |
| 4b | الخزنة/المالية | Ledger workspace + drawer للحركات | منطق vaultTx لا يُلمس |
| 4c | القيود | Journal Editor بمؤشر التوازن الحي | المنطق في accounting-core.js يبقى كما هو؛ التحسين عرض فقط |
| 4d | المشتريات/الفواتير | Document Workspace معاينة حية | VAT calculation الحالي مقدس |
| 4e | التقارير | Report Studio wrapper | محرك التقارير الحالي يعمل كما هو |

كل خطوة: تنفيذ ← اختبار يدوي للتدفقات ← commit منفصل قابل للتراجع.

## المرحلة 5 — Data Grid + States (أسبوع 9)

- ترقية الجداول إلى Modern Grid فوق البنية الحالية (saved views, column visibility, context menu)
- تطبيق الست حالات الإلزامية على كل مكون
- Virtualization/pagination حيث الحجم يتطلبها

## المرحلة 6 — Onboarding + Polish (أسبوع 10)

- First Run wizard: الشركة/الفترة/العملة/المستخدمين/الحسابات/الضريبة مع Setup Progress
- Motion pass نهائي (احترام reduced-motion)
- مراجعة Contrast AA كاملة
- Demo script جاهز للبيع

## المرحلة 7 — (موازٍ، خارج نطاق التصميم) مخاطر خادمية

تُرفع للقرار المنفصل: TOTP على المسارات البديلة، throttling الناقص، encKey pre-auth، pagination افتراضي، تنظيف magic_link_tokens، إزالة DDL المدمِّر من schema.sql.

---

## تعريف النجاح النهائي

- **Product**: كل شاشة تصلح لعرض تجاري
- **UX**: مهمة شائعة = ≤3 نقرات، والبحث يصل كل شيء
- **Visual**: هوية نبض مميزة لا تُخلط بأي منتج آخر
- **Technical**: صفر انحدار في التدفقات المحاسبية، أداء لا يتراجع
- **Business**: قابل للبيع لمراكز تدريب متعددة بأدوار وفريق
