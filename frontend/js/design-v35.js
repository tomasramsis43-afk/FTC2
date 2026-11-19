/* ============================================================================
   FTC2 — Dashboard V35 · طبقة التفاعل والحركة (إضافية بالكامل)
   لا تعدّل أي منطق موجود: تضيف فقط مؤشرات حركة، تظليل الهيدر عند التمرير،
   وتلميحات لأزرار القائمة الجانبية عند طيّها.
   ============================================================================ */
(function () {
  'use strict';
  if (window.__ftcV35Loaded) return;
  window.__ftcV35Loaded = true;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function isRTL() {
    return (document.documentElement.getAttribute('dir') || 'rtl') !== 'ltr';
  }

  /* شريط تقدم رفيع عند تبديل القسم */
  var barTimer = null;
  function flashProgress() {
    if (reduced) return;
    var old = document.getElementById('v35-progress');
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.id = 'v35-progress';
    document.body.appendChild(bar);
    clearTimeout(barTimer);
    barTimer = setTimeout(function () {
      bar.style.transition = 'opacity .25s ease';
      bar.style.opacity = '0';
      setTimeout(function () { bar.remove(); }, 320);
    }, 420);
  }

  /* إعادة تشغيل حركة الظهور للقسم النشط */
  function replayView(el) {
    if (!el || reduced) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }

  /* تلميحات القائمة الجانبية عند الطي */
  function syncSidebarTitles() {
    var nav = document.querySelector('nav.tabs');
    if (!nav) return;
    var collapsed = nav.classList.contains('collapsed');
    Array.prototype.forEach.call(nav.querySelectorAll('button[data-view]'), function (btn) {
      var label = btn.querySelector('span');
      if (!label) return;
      if (collapsed && !btn.getAttribute('data-v35-title')) {
        btn.setAttribute('data-v35-title', label.textContent.trim());
        btn.setAttribute('title', label.textContent.trim());
      } else if (!collapsed && btn.getAttribute('data-v35-title')) {
        btn.removeAttribute('data-v35-title');
        var t = btn.getAttribute('title') || '';
        if (t === btn.getAttribute('data-v35-title')) btn.removeAttribute('title');
      }
    });
  }

  /* تظليل الهيدر عند التمرير */
  function initHeaderScroll() {
    var header = document.querySelector('header.top');
    if (!header) return;
    var onScroll = function () {
      header.classList.toggle('v35-scrolled', (window.scrollY || 0) > 6);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* مراقبة تبديل الأقسام */
  function initViewObserver() {
    var main = document.querySelector('.main-content');
    if (!main) return;
    var lastActive = null;
    var onActive = function (view) {
      if (!view || view === lastActive) return;
      lastActive = view;
      flashProgress();
      replayView(view);
      try {
        window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
      } catch (e) { window.scrollTo(0, 0); }
    };
    var current = main.querySelector('.view.active');
    if (current) lastActive = current;

    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (t && t.classList && t.classList.contains('view') && t.classList.contains('active')) {
          onActive(t);
        }
      }
    });
    Array.prototype.forEach.call(main.querySelectorAll('.view'), function (v) {
      mo.observe(v, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* مراقبة طي/توسيع القائمة */
  function initSidebarObserver() {
    var nav = document.querySelector('nav.tabs');
    if (!nav) return;
    new MutationObserver(syncSidebarTitles).observe(nav, { attributes: true, attributeFilter: ['class'] });
    syncSidebarTitles();
  }

  /* تفعيل لمسة زجاجية على بطاقات KPI أثناء التحميل */
  function initSkeleton() {
    var dash = document.getElementById('dash2-kpis');
    if (!dash) return;
    if (!dash.children.length) {
      dash.innerHTML = '<div class="v35-skel-card"></div><div class="v35-skel-card"></div><div class="v35-skel-card"></div><div class="v35-skel-card"></div>';
      var guard = setInterval(function () {
        if (!dash.querySelector('.v35-skel-card')) { clearInterval(guard); return; }
        if (dash.querySelector('.dash2-kpi, button')) { clearInterval(guard); }
      }, 400);
      /* شبكة أمان: لا نترك هياكل تحميل وهمية في حال تعذّر رسم لوحة التحكم */
      setTimeout(function () {
        clearInterval(guard);
        if (dash.querySelector('.v35-skel-card') && !dash.querySelector('.dash2-kpi, button')) {
          dash.innerHTML = '';
        }
      }, 8000);
    }
  }

  function init() {
    document.body.classList.add('v35');
    if (!document.body) return;
    initHeaderScroll();
    initViewObserver();
    initSidebarObserver();
    initSkeleton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
