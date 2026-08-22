# FTC2 Design System Proposal — مقترح نظام التصميم "نبض DS"

> مبدأ أساسي: إعادة تسمية وتنظيم فوق البنية القائمة — **بدون كسر أي selector يعتمد عليه JS الحالي**.

---

## 1. Tokens — طبقتان: Legacy Alias ثم النظام الجديد

### الخطوة الأولى الإلزامية: إصلاح الأسماء المضللة
الأسماء الحالية خطرة (`--navy` برتقالي! `--gold` فيروزي!). الحل: **إبقاء الأسماء القديمة كأسماء مستعارة** تشير للجديدة:

```css
:root {
  /* ── Brand ── */
  --brand-primary:        #d9832f;   /* كان --navy (خطأ تسمية) */
  --brand-primary-strong: #b3661e;   /* كان --navy-dark */
  --brand-primary-bright: #f0a857;
  --brand-secondary:      #1fa98a;   /* كان --gold و--teal */
  --brand-secondary-dark: #167a64;
  --brand-secondary-bright:#2fd9b0;

  /* ── Surfaces (Light) ── */
  --bg:               #f6f7f9;
  --surface:          rgba(255,255,255,.92);
  --surface-solid:    #ffffff;
  --surface-raised:   #eef1f5;
  --border:           #e3e7ec;

  /* ── Text ── */
  --text-primary:   #201a2e;         /* كان --text */
  --text-secondary: #6c6478;         /* كان --text-muted */

  /* ── Semantic ── */
  --success: #1fa98a;
  --warning: #e0a72f;                /* كان hardcoded بلا token */
  --danger:  #e0505e;
  --info:    #4a7dd9;                /* جديد */

  /* ── Radius scale (جديد — بدل radius واحد 20px وقيم فعلية 5–22px) ── */
  --radius-xs: 6px; --radius-sm: 10px; --radius-md: 14px;
  --radius-lg: 18px; --radius-xl: 22px; --radius-full: 999px;
  --radius: var(--radius-lg);        /* alias توافق */

  /* ── Spacing scale (جديد — قاعدة 4px) ── */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px;

  /* ── Elevation (موحّدة بدل عشرات الظلال ad-hoc) ── */
  --shadow-xs: 0 1px 2px rgba(32,26,46,.06);
  --shadow-sm: 0 2px 8px rgba(32,26,46,.08);
  --shadow-md: 0 8px 24px -8px rgba(32,26,46,.16);
  --shadow-lg: 0 16px 40px -12px rgba(32,26,46,.22);
  --shadow-brand: 0 12px 28px -14px rgba(217,131,47,.45);

  /* Legacy aliases — تحافظ على عمل كل CSS/JS القديم */
  --navy: var(--brand-primary);       --navy-dark: var(--brand-primary-strong);
  --gold: var(--brand-secondary);     --gold-dark: var(--brand-secondary-dark);
  --teal: var(--brand-secondary);     --red: var(--danger);
}
```

### Dark Theme — تصميم مستقل لا انقلاب ألوان
يبقى على `body.dark-theme` (توافقًا مع JS)، لكن يُعاد ضبطه كواجهة Premium:
خلفية `#0f1326`، سطح `#151a2c/#1a2038`، نص `#f2f3fa`، كهرماني مضيء `#f0a857`، فيروزي `#2fd9b0` — مع قاعدة جديدة: **الظلال في الداكن تصبح حواف إضاءة** (border-top خفيف + ظل أعمق).

## 2. Typography System

| الاستخدام | الخط | الوزن | الحجم |
|---|---|---|---|
| Display (Net Position) | Cairo | 800–900 | clamp(28–44px) |
| عناوين الصفحات | Cairo | 700–800 | 20–24px |
| Body عربي | Tajawal | 400–500 | 14–15px |
| **كل الأرقام المالية** | IBM Plex Mono | 500–700 | مطابق السياق |
| Icons | Material Symbols | 400 (FILL عند active) | 18–24px |

مقاييس: 12 / 13 / 14 / 15 / 17 / 20 / 24 / 32 / 44. line-height عربي ≥1.6 للفقرات.

## 3. Component Language

كل مكون يُعرَّف مرة واحدة في قسم موحد (إنهاء دين الطبقات الثلاث):

- **Buttons**: primary (كهرماني متدرج + shadow-brand)، secondary (فيروزي)، ghost، danger، icon-btn. حالات: hover/active/focus-ring/is-loading/disabled — كلها إلزامية
- **Inputs**: label فوق، focus ring كهرماني 2px، helper text، error state أحمر مع رسالة، .computed box للقيم المحسوبة
- **Data Grid**: sticky header، أعمدة ثابتة، sort/filter/group، saved views، context menu، export — مبني فوق الجدول الحالي تدريجيًا
- **Cards**: KPI card بشريط لكنة تلقائي (:has موجود)، panel بعنوان وأيقونة
- **Overlays**: modal (blur موحد 20px)، drawer جانبي (جديد — للتفاصيل بدل شاشات جديدة)، command palette، toast
- **Badges**: stamp paid/due/pending بألوان semantic فقط
- **States الستة إلزامية لكل مكوّن**: loading (skeleton) / empty / error / success / disabled / skeleton

## 4. Motion Language

| الحركة | المدة | Easing |
|---|---|---|
| تبديل View | 240ms | cubic-bezier(.2,.8,.2,1) |
| Modal/Drawer دخول | 180ms | نفس المنحنى |
| Toast | 160ms in / 200ms out | ease-out |
| Hover lift | 120ms | ease-out |
| Skeleton shimmer | 1.4s loop | linear |

قاعدة: لا حركة >300ms، لا حركة دائرية infinite إلا skeleton وspinners. احترام prefers-reduced-motion (الموجود) يُعمَّم لكل جديد.

## 5. Data Visualization Language

- **الاتجاه**: سهم ▲▼ + نسبة مئوية بلون success/danger — إلزامي بجانب كل رقم مقارَن
- **Money In**: فيروزي · **Money Out**: كهرماني · **Net**: أخضر/أحمر حسب الإشارة
- Sparklines للاتجاهات داخل KPI cards (CSS موجودة تُعمَّم)
- Charts فقط حين تساعد قرارًا — لا زينة
- الأرقام دائمًا Mono مع فواصل آلاف وعلامة ﷼

## 6. Accessibility

- Contrast AA إلزامي على كل تركيبة token جديدة (فحص آلي لاحقًا)
- Focus-visible ring موحد 2px كهرماني بلا قتل outline
- Touch targets ≥40px (القاعدة موجودة ≤600px — تُعمَّم)
- RTL بالخصائص المنطقية فقط (النهج الحالي ممتاز ويستمر)
- LTR English عبر `[dir="ltr"]` overrides على مستوى tokens الاتجاهية فقط

## 7. خطة الترحيل الآمنة

1. حقن block الـ tokens الجديد + aliases في أعلى styles.css
2. استبدال القيم الحرفية المتسربة (~24 rgba + warning) بالـ aliases
3. نقل قواعد PRO overrides إلى داخل أقسام المكونات (توحيدها)
4. كل شاشة تُعاد هيكلتها تُنظَّف من inline styles العشوائي إلى classes
