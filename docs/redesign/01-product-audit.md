# FTC2 Product Audit — التحليل الشامل للمنتج الحالي

> تاريخ التحليل: 2026-08-22 · على أساس origin/main @ dd47cb3
> النطاق: frontend/ + server/ + electron-desktop/ (~19,000 سطر JS + 3,596 سطر CSS + app.html ~4,650 سطر)

---

## 1. ما هو FTC2 فعليًا؟

ليس برنامج محاسبة عام — هو **نظام تشغيل متكامل لمركز تدريب سعودي** يدمج:

- **CRM للمتدربين** (العميل = وطني من 10 أرقام، مفتاح الربط الشامل)
- **دورة تدريبية كاملة**: كتالوج الدورات، الجلسات، الحقائب التدريبية كمخزون
- **رعاية شركات B2B** (اتفاقيات أسعار، آجال ائتمان، أرقام ضريبية)
- **نواة مالية**: خزنة + شبكة (treasury)، فواتير بيع يدوية، مشتريات وموردون بضريبة 15%، قيود مزدوجة، موازنة
- **امتثال ZATCA** (فواتير مبسطة B2C — Sandbox فقط حاليًا)
- تقارير مالية وتشغيلية، تدقيق كامل، Undo/Redo، نسخ احتياطي

**الهوية الحالية:** «نبض / NABD» — لوحة كهرمانية `#d9832f` + فيروزي `#1fa98a` على sidebar نيلي داكن دائمًا.

---

## 2. البنية التقنية (Architecture)

### الواجهة الأمامية
| العنصر | الوصف |
|---|---|
| `app.html` | مونوليث 4,642 سطر (~518KB) يحوي كل الـ views والـ modals |
| `styles.css` | 3,596 سطر، ثلاث طبقات متراكبة: base → NABD PRO overrides → utilities |
| 26 ملف JS | بدون bundler ولا ES modules — كل شيء global scope، تحميل متسلسل ينتهي بـ boot.js |
| PWA | manifest + service worker + sw-register |
| Desktop | Electron wrapper (`ftc2-desktop` v1.0.6, NSIS installer) |

### الخادم
- Node.js + Express 4 + PostgreSQL (استضافة Render)، Helmet/CSP، compression
- **نموذج بيانات هجين**: kv_store blobs (إرث localStorage) تتطور لجداول حقيقية (`client_records`) مع مرايا مزامنة
- تشفير من الطرف الآخر: AES-256-GCM بالمتصفح، الصفر-معرفة (zero-knowledge) بمفتاح مشتق من ترخيص
- Concurrency تفاؤلية: 409 + currentVersion على كل مسارات الكتابة
- SSE للتحديث اللحظي (إشارة تغيير فقط، لا بيانات حساسة عبر القناة)
- Auth بخمس طرق: كلمة مرور+TOTP، Magic Link، WebAuthn، QR Login، Offline — مع token_version للإبطال الفوري
- Rate limiting بخمس حاويات (auth/license/storage/ai/email)

### نقاط القوة المعمارية (لا تُكسر أبدًا)
1. **سلامة مالية صارمة**: مدفوعات التسجيل على سجل العميل، كل ما عداه في vaultTx يُعدَّل حصريًا عبر Finance، مخزون الحقائب ledger مستقل، قيود مزدوجة مع cleanupOrphanedJournalDE
2. **حمايات عميقة**: كشف تكرار الوطني (محلي + خادم SHA-256)، undo snapshots قبل كل mutation، audit log شامل، طابور إعادة إرسال offline
3. **عزل الأدوار**: الاستقبال محاصر (نافذة تعديل 5 ساعات، فرض مصدر الحقيبة "buy"، مجموعة عملاء معزولة) — مطبق خادميًا حتى مستوى الصف

---

## 3. جرد الوحدات (Modules Inventory)

| View | الملفات الرئيسية | الوظيفة |
|---|---|---|
| dashboard | clients-cfo-dashboard.js (864 سطر) | لوحة CFO، مؤشرات سريعة |
| clients | clients-* (5 ملفات، ~2,600 سطر) | CRM: تسجيل، بحث، فلترة، عمليات جماعية، طباعة، Timeline |
| companies | module-companies.js (1,772) | رعاية الشركات والاتفاقيات |
| courses | module-courses.js (1,197) | الدورات والجلسات والسعة |
| courseinvoices | — (بيانات مُصلّبة في HTML!) | فواتير الدورات |
| vault | module-finance.js (~123KB!) | الخزنة والشبكة، حركات مالية، تصنيف AI لمصروف |
| bags | module-bags.js (1,372) + bag-workflow.js | مخزون الحقائب وصرفها |
| purchases | module-purchases.js (1,196) ⚠️ يستضيف تسلسل الإقلاع! | المشتريات والموردون، VAT تلقائي 15% |
| reports | module-reports.js (~118KB) | التقارير المالية والتشغيلية |
| accounting | module-accounting.js (966) + accounting-core.js | القيود، دليل الحسابات، ميزان المراجعة |
| budget | داخل accounting | الموازنة |
| audit | — | سجل التدقيق |
| settings | theme-settings.js (~121KB) يشمل i18n! | ~30 لوحة إعدادات |

**ملاحظة معمارية حرجة:** منطق الأعمال موزع بشكل غير متوقع (module-purchases يستضيف `startApp`، theme-settings يستضيف `applyLanguage`) — أي إعادة هيكلة يجب أن تكون سطحية أولًا.

## 4. التنقل الحالي (Navigation)

- Sidebar ثابت 260px بـ 13 زرًا مسطحًا (Alt+1..9, Alt+0 اختصارات)
- Settings خارج الـ sidebar (عبر قائمة المستخدم فقط)
- تبديل Views عبر dispatch table في undo-redo.js مع بوابة صلاحيات `canAccessView()`
- **معيب**: زر بحث شامل `#btn-global-search` مربوط بـ Ctrl+K لكن عناصره الثلاثة (#global-search-overlay/input/results) **غير موجودة في أي ملف** → TypeError عند النقر (module-accounting.js:870)
- **ميت**: معالج `data-view="settlements"` في undo-redo.js:906 لعرض غير موجود

## 5. جرد Components الحالي

- **Buttons**: btn-primary (تدرج كهرماني), btn-gold (فيروزي), btn-ghost, btn-danger, icon-btn, FAB, is-loading spinner
- **Cards**: .card KPI بشريط جانبي ملون تلقائي عبر :has()، .panel بعنوان وشريط، .cfo-panel بلكنة لكل لوحة
- **Tables**: sticky header + عمودان ثابتان، sorting بـ aria-sort، density mode، تحويل صفوف→بطاقات ≤680px
- **Forms**: .field مع focus ring، formgrid 2-col، حقول inline-edit بالجدول، checkboxes مخصصة
- **Overlays**: modal زجاجي blur(24px)، overlay معتم blur(6px)، overflow-menu، row-menu-panel، toast سفلي
- **States**: skeleton shimmer، empty-state، tooltips CSS خالصة، boot spinner

## 6. المخاطر التقنية (Technical Risks)

### حرجة
| # | الخطر | الموضع |
|---|---|---|
| T1 | **بيانات مُصلّبة داخل app.html**: 267 صف `<tr>` في 5 جداول (ci-table-body, bag-purchases, own-bag-clients, suppliers, purchases) + أرقام موردون حقيقية واسم مرفق حقيقي داخل نموذج الشراء — انحراف بين Markup والحالة الحية، وربما بيانات عملاء حقيقية مكشوفة في الريبو | app.html:679–2641 |
| T2 | **بحث شامل مكسور** (TypeError عند Ctrl+K) | module-accounting.js:869–889 |
| T3 | **افتراض instance واحد**: خرائط SSE وجلسات QR وتحديات WebAuthn وعدادات rate-limit كلها in-memory | sse.js:11, qr-login.js:16, webauthn.js:24 |
| T4 | **TOTP يُتجاوز في المسارات البديلة** (magic link/WebAuthn/QR تصدر JWT كاملة بدون عامل ثانٍ) | magic-link.js:82–98 إلخ |

### متوسطة
- JWT في query string لمسار SSE (يسجل في proxy logs)
- نقاط auth عامة بلا throttling (magic-link verify, webauthn options, QR create/status)
- encKey الترخيص يُعاد لأي حامل كود صالح قبل تسجيل الدخول؛ لا دوران للمفتاح
- هاش SHA-256 بلا salt للأرقام الوطنية مكشوف حتى للاستقبال (هجوم قاموس سهل على 10 أرقام)
- DDL مدمِّر عند الإقلاع (DELETE USING على zatca_invoice_log في schema.sql نفسه)
- حدود body ضخمة (25MB عام / 40MB AI)
- لا pagination افتراضي على `/api/client-records` و `/api/records/:collection`
- نمو غير محدود: auditLog, deletedVaultTx, deletedInvoices, magic_link_tokens
- اعتماد خارجي ipwho.is على مسار الدخول
- README قديم (يقول blob واحد؛ الواقع تطوّر لجداول جزئية)

## 7. مشاكل UX الحالية

1. **13 تبويبًا مسطحًا** بلا تجميع سياقي — المستخدم الجديد يتوه
2. **Dashboard تقليدي** بطاقات KPI متشابهة بدل هرمية بصرية
3. **البحث الشامل معطل** رغم وجود الزر والاختصار — وعد غير مُنفذ
4. **الفورم الطويل**: تسجيل العميل modal واحد ضخم يجمع كل شيء
5. **quickstats مُفرَّغ عمدًا** (clients-alerts-overview.js يفرغه) — مساحة ميتة في الهيدر
6. **الطباعة معزولة عن التصميم** (print styles داخل JS strings) — لا انسجام بصري
7. بيانات مُصلّبة قد تظهر وميضًا زائفًا قبل أول render

## 8. المشاكل البصرية (Visual Problems)

1. **أسماء Tokens مضللة خطيرًا**: `--navy` برتقالي! `--gold` فيروزي! `--auth-cyan` كهرماني! — أي كود جديد سيخطئ
2. **لا مقياس spacing ولا radius**: radius واحد 20px بين الفعلية 5–22px، ظلال ad-hoc عشرات
3. **دين دمج الطبقات الثلاث**: نفس المكون مصمم في موضعين (base ثم PRO override) — الفائز بالصدفة
4. ألوان hardcoded تتسرب (~24 rgba حرفية، warning `#e0a72f` بلا token)
5. Glassmorphism بلا نظام (16 استخدامًا بقيم مختلفة) رغم وجود kill-switch أداء ممتاز ≤768px
6. تناقض .stamp (حد فيروزي مع نص --gold-dark)

## 9. الفرص (Opportunities)

1. **هوية نبض أصيلة**: الاسم نفسه = استعارة "النبض المالي" — أصل براند نادر يجب بناء المنتج حوله
2. **اللوحة الكهرمانية/الفيروزية مميزة أصلًا** — ليست زرقاء تقليدية؛ نحتاج تنظيمها كـ Token System لا استبدالها
3. Ctrl+K موجود في ذاكرة المستخدمين — بناء Command Center حقيقي فوقه
4. بنية Views جاهزة لإعادة تجميعها سياقيًا دون كسر routers
5. سلامة مالية موجودة تسمح بميزات cockpit متقدمة (Cash Position حقيقية وليست ديكورًا)
6. reduced-motion وRTL logical properties وkill-switch أداء — قاعدة accessibility ممتازة للتوسع
7. سوق مستهدف واضح (مراكز تدريب سعودية) يتيح رسائل تسويقية دقيقة

---
**الحكم العام:** المنتج وظيفيًا ناضج ومحمي باكراهية، بصريًا فوق المتوسط بعد re-skin نبض، لكن يعاني من دين تسمية/طبقات CSS، وتنقل مسطح، وبحث مكسور، وبيانات مُصلّبة خطرة. قابل لإعادة التقديم كمنتج Premium عبر إعادة تصميم تدريجية لا تعيد كتابة المنطق.
