/* ============================================================
   نبض Shell — طبقة الهيكل العام (App Shell Layer)
   ------------------------------------------------------------
   مسؤوليات هذه الطبقة فقط (لا تلمس أي منطق أعمال):
   1) وضع Rail افتراضي لأول تجربة (قبل تحميل theme-settings الذي يقرأ التفضيل)
   2) تلميحات أدوات لأزرار التنقل عند الطي
   3) شريحة "الفترة المالية" في الهيدر (تتبع فلتر السنة الموجود)
   4) مؤشر حالة البث اللحظي SSE (قراءة فقط من sse-client دون تعديله)
   5) إخفاء عناوين المجموعات التي أخفتها الصلاحيات كل أزرارها
   ملاحظة: تُحمَّل قبل theme-settings.js عمداً (انظر ترتيب السكربتات في app.html).
   ============================================================ */

/* ── 1) تم حذفه — سيُعاد بناؤه من الصفر في كود الطي الجديد (sidebar-collapse.js) ── */

/* إغلاق أي Drawer مفتوح بمفتاح Esc (بريف 2026-08 بند 12) — مقصور على
   عناصر .drawer-overlay فقط حتى لا يغيّر سلوك أي مودال آخر في المشروع. */
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.overlay.drawer-overlay.show').forEach(function (ov) {
    ov.classList.remove('show');
  });
});

/* اختصارات "G ثم حرف" للتنقل السريع (بريف 2026-08 بند 29):
   G→D لوحة القيادة، G→C العملاء، G→R التقارير.
   لا تعمل أثناء الكتابة في أي حقل، ولا مع فتح أي مودال/درج/بحث شامل،
   حتى لا تتعارض مع حرف "g" أو "d" أو "c" أو "r" العادي أثناء الكتابة. */
(function () {
  'use strict';
  var GO_MAP = { d: 'dashboard', c: 'clients', r: 'reports' };
  var awaitingSecondKey = false;
  var awaitTimer = null;

  function isTypingContext(target) {
    if (!target) return false;
    var tag = (target.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }
  function isAnyOverlayOpen() {
    return !!document.querySelector('.overlay.show');
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingContext(e.target) || isAnyOverlayOpen()) return;

    var key = e.key.toLowerCase();

    if (awaitingSecondKey) {
      awaitingSecondKey = false;
      clearTimeout(awaitTimer);
      var view = GO_MAP[key];
      if (view) {
        e.preventDefault();
        document.querySelector('nav.tabs button[data-view="' + view + '"]')?.click();
      }
      return;
    }

    if (key === 'g') {
      awaitingSecondKey = true;
      clearTimeout(awaitTimer);
      /* لو ما جاش حرف تاني خلال ثانيتين، نلغي الانتظار حتى لا يبقى "معلّقاً" بصمت */
      awaitTimer = setTimeout(function () { awaitingSecondKey = false; }, 2000);
    }
  });
})();

(function () {
  'use strict';

  /* ── أدوات صغيرة ── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  /* ── 2) تلميحات أزرار التنقل (تظهر أساساً في وضع Rail المطوي) ── */
  function initNavTooltips() {
    $all('nav.tabs button[data-view]').forEach(function (btn) {
      var span = btn.querySelector('span');
      var label = span ? span.textContent.trim() : '';
      if (label && !btn.hasAttribute('data-tooltip')) btn.setAttribute('data-tooltip', label);
    });
  }

  /* ── 3) شريحة الفترة المالية — مصدر الحقيقة هو فلتر السنة القائم ── */
  function updatePeriodChip() {
    var chip = $('#fiscal-period-chip');
    var yearFilter = $('#year-filter');
    if (!chip || !yearFilter) return;
    var v = yearFilter.value;
    chip.textContent = (v && v !== 'all') ? ('الفترة: سنة ' + v) : 'الفترة: كل الفترات';
  }
  function initPeriodChip() {
    updatePeriodChip();
    var yearFilter = $('#year-filter');
    if (yearFilter) yearFilter.addEventListener('change', updatePeriodChip);
  }

  /* ── 4) مؤشر حالة البث اللحظي (قراءة فقط — لا نعدل sse-client إطلاقاً) ── */
  var _sseTick = null;
  function updateSseStatus() {
    var wrap = $('#sse-status-wrap');
    if (!wrap) return;
    // وضع العمل من الجهاز فقط (بلا خادم): لا معنى لمؤشر بث
    if (typeof SERVER_AUTH_TOKEN === 'undefined' || !SERVER_AUTH_TOKEN) { wrap.style.display = 'none'; return; }
    var conn = (typeof _sseConnection !== 'undefined') ? _sseConnection : null;
    var dot = $('#sse-status-dot'), label = $('#sse-status-label');
    if (!dot || !label) return;
    var state = conn ? conn.readyState : -1; // -1 لا اتصال، 0 اتصال، 1 مفتوح، 2 مغلق
    if (state === 1) {
      wrap.style.display = ''; dot.className = 'sse-dot live';
      label.textContent = 'مباشر';
      wrap.title = 'متصل بالبث اللحظي — أي تحديث من مستخدم آخر يظهر فوراً';
    } else if (state === 0) {
      wrap.style.display = ''; dot.className = 'sse-dot connecting';
      label.textContent = 'اتصال…';
      wrap.title = 'جارٍ فتح قناة البث اللحظي';
    } else {
      wrap.style.display = ''; dot.className = 'sse-dot off';
      label.textContent = 'مزامنة دورية';
      wrap.title = 'البث اللحظي غير متصل حالياً — يعمل الفحص الدوري (كل دقيقتين) كخط رجعة تلقائي، وسيعاد الاتصال عند العودة للتاب';
    }
  }
  function initSseStatus() {
    updateSseStatus();
    if (_sseTick) clearInterval(_sseTick);
    _sseTick = setInterval(updateSseStatus, 4000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') setTimeout(updateSseStatus, 1200);
    });
  }

  /* ── 5) إخفاء عناوين المجموعات الفارغة (بعد تطبيق صلاحيات الأدوار عليها) ── */
  function hideEmptyNavGroups() {
    var labels = $all('nav.tabs .nav-section-label');
    labels.forEach(function (lab) {
      var el = lab.nextElementSibling, hasVisible = false;
      while (el && !el.classList.contains('nav-section-label')) {
        if (el.tagName === 'BUTTON' && el.style.display !== 'none') { hasVisible = true; break; }
        el = el.nextElementSibling;
      }
      lab.classList.toggle('nav-section-hidden', !hasVisible);
    });
  }
  function patchRolePermissionsHook() {
    // نلفّ الدالة الأصلية لنضيف تنظيف المجموعات بعد كل تطبيق صلاحيات (دون تغيير ملفها)
    if (typeof window.applyRolePermissions === 'function' && !window.__nabdRpPatched) {
      var orig = window.applyRolePermissions;
      window.applyRolePermissions = function () {
        var r = orig.apply(this, arguments);
        requestAnimationFrame(hideEmptyNavGroups);
        return r;
      };
      window.__nabdRpPatched = true;
    }
    hideEmptyNavGroups();
  }

  /* ── الإقلاع ── */
  function initShell() {
    try { initNavTooltips(); } catch (e) {}
    try { initPeriodChip(); } catch (e) {}
    try { initSseStatus(); } catch (e) {}
    try { patchRolePermissionsHook(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initShell);
  else initShell();
})();
