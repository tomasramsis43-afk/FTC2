/* ============================================================
   مركز الإشعارات (Notification Center) — بريف 2026-08 بند 17
   ------------------------------------------------------------
   يعيد استخدام auditLog + PULSE_ACT_META (المصدر الحقيقي الموجود
   بالفعل لسجل النشاط في نبض القيادة) — لا بيانات وهمية إطلاقاً.
   لا يلمس أي منطق أعمال؛ طبقة عرض فقط فوق بيانات قائمة.
   يُحمَّل بعد permissions-sound.js (auditLog) وcockpit-pulse.js
   (PULSE_ACT_META) عمداً — انظر ترتيب السكربتات في app.html.
   ============================================================ */
(function () {
  'use strict';

  var LAST_SEEN_KEY = 'ftc2-notif-last-seen-ts';

  function $(sel, root) { return (root || document).querySelector(sel); }

  function relTime(ts) {
    if (typeof window.pulseRelTime === 'function') return window.pulseRelTime(ts);
    var diff = Math.max(0, Date.now() - Number(ts || 0));
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'الآن';
    if (m < 60) return 'قبل ' + m + ' د';
    var h = Math.floor(m / 60);
    if (h < 24) return 'قبل ' + h + ' س';
    return 'قبل ' + Math.floor(h / 24) + ' يوم';
  }

  function getLastSeen() {
    try { return Number(localStorage.getItem(LAST_SEEN_KEY) || 0); } catch (e) { return 0; }
  }
  function setLastSeen(ts) {
    try { localStorage.setItem(LAST_SEEN_KEY, String(ts)); } catch (e) { /* تخزين محلي غير متاح */ }
  }

  function getItems() {
    if (typeof window.auditLog === 'undefined' || !Array.isArray(window.auditLog)) return [];
    if (typeof window.canAccessView === 'function' && !window.canAccessView('audit')) return [];
    return window.auditLog.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 20);
  }

  function metaFor(action) {
    var table = window.PULSE_ACT_META || {};
    return table[action] || { label: action || 'عملية', color: 'var(--text-muted)', icon: 'circle' };
  }

  function renderPanel() {
    var body = $('#notif-panel-body');
    var badge = $('#notif-badge');
    if (!body) return;
    var items = getItems();
    var lastSeen = getLastSeen();
    var unread = items.filter(function (it) { return Number(it.ts) > lastSeen; }).length;

    if (badge) {
      if (unread > 0) { badge.style.display = ''; badge.textContent = unread > 99 ? '99+' : String(unread); }
      else { badge.style.display = 'none'; }
    }

    if (!items.length) {
      body.innerHTML = '<div class="notif-panel-empty">لا توجد إشعارات بعد.<br>ستظهر هنا العمليات الجديدة فور حدوثها.</div>';
      return;
    }

    body.innerHTML = items.map(function (it) {
      var meta = metaFor(it.action);
      var text = (it.user ? '<b>' + escHtml(it.user) + '</b> ' : '') + escHtml(meta.label) +
        (it.description || it.section ? ' — ' + escHtml(String(it.description || it.section || '')) : '');
      return '<div class="notif-row">' +
        '<span class="notif-ico msi" style="color:' + meta.color + '; background:color-mix(in srgb, ' + meta.color + ' 16%, transparent);">' + meta.icon + '</span>' +
        '<div class="notif-body">' +
        '<div class="notif-text">' + text + '</div>' +
        '<div class="notif-time">' + relTime(it.ts) + (it.section ? ' · ' + escHtml(it.section) : '') + '</div>' +
        '</div></div>';
    }).join('');
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function openPanel() {
    var panel = $('#notif-panel');
    var btn = $('#btn-notifications');
    if (!panel) return;
    renderPanel();
    panel.classList.add('show');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    var panel = $('#notif-panel');
    var btn = $('#btn-notifications');
    if (panel) panel.classList.remove('show');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function isOpen() {
    var panel = $('#notif-panel');
    return !!(panel && panel.classList.contains('show'));
  }

  function refreshBadgeOnly() {
    var badge = $('#notif-badge');
    if (!badge) return;
    var items = getItems();
    var lastSeen = getLastSeen();
    var unread = items.filter(function (it) { return Number(it.ts) > lastSeen; }).length;
    if (unread > 0) { badge.style.display = ''; badge.textContent = unread > 99 ? '99+' : String(unread); }
    else { badge.style.display = 'none'; }
  }

  function init() {
    var btn = $('#btn-notifications');
    var wrap = $('#notif-wrap');
    var markAllBtn = $('#btn-notif-mark-all');
    if (!btn || !wrap) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isOpen()) closePanel(); else openPanel();
    });

    document.addEventListener('click', function (e) {
      if (isOpen() && !wrap.contains(e.target)) closePanel();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) closePanel();
    });

    if (markAllBtn) {
      markAllBtn.addEventListener('click', function () {
        setLastSeen(Date.now());
        refreshBadgeOnly();
        renderPanel();
      });
    }

    refreshBadgeOnly();
    /* تحديث الشارة دوريًا (خفيف — عملية محلية بدون طلب شبكة) */
    setInterval(refreshBadgeOnly, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
