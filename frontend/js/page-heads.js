/* ============================================================
   FTC2 — Page headers (Phase 2)
   - Collapses long view descriptions to two lines with a
     «المزيد / أقل» toggle, so every screen opens calm and quiet.
   - Adds accessible labels/tooltips to the sidebar rail.
   ============================================================ */
(function () {
  'use strict';

  var MIN_COLLAPSE_CHARS = 110;

  function makeToggle(sub) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-head-toggle';
    btn.textContent = 'المزيد';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () {
      var open = sub.classList.toggle('is-expanded');
      btn.textContent = open ? 'أقل' : 'المزيد';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    return btn;
  }

  function enhance(head) {
    if (head.dataset.phReady === '1') return;

    var sub = head.querySelector('.page-head-sub') || head.querySelector(':scope > p');
    if (!sub) return;
    if (window.getComputedStyle(sub).display === 'none') return;

    var text = (sub.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_COLLAPSE_CHARS) return;

    var btn = sub.nextElementSibling;
    if (!btn || !btn.classList.contains('page-head-toggle')) {
      btn = makeToggle(sub);
      sub.insertAdjacentElement('afterend', btn);
    }

    sub.classList.add('is-clamped');
    sub.classList.remove('is-expanded');
    btn.textContent = 'المزيد';
    btn.setAttribute('aria-expanded', 'false');

    // Keep the toggle only when the text actually overflows two lines.
    window.requestAnimationFrame(function () {
      var overflow = sub.scrollHeight > sub.clientHeight + 2;
      if (!overflow) {
        sub.classList.remove('is-clamped');
        btn.remove();
      } else {
        head.dataset.phReady = '1';
      }
    });
  }

  function enhanceActiveView() {
    var heads = document.querySelectorAll('section.view.active .page-head');
    for (var i = 0; i < heads.length; i += 1) enhance(heads[i]);
  }

  function labelSidebar() {
    var buttons = document.querySelectorAll('nav.tabs button[data-view]');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      var label = btn.querySelector('span');
      if (!label) continue;
      var text = (label.textContent || '').trim();
      if (!text) continue;
      if (!btn.title) btn.title = text;
      if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', text);
    }
  }

  function init() {
    labelSidebar();
    enhanceActiveView();

    var sections = document.querySelectorAll('section.view');
    if (window.MutationObserver) {
      var observer = new MutationObserver(function () {
        enhanceActiveView();
      });
      for (var i = 0; i < sections.length; i += 1) {
        observer.observe(sections[i], { attributes: true, attributeFilter: ['class'] });
      }
      var appWrap = document.getElementById('app-wrap');
      if (appWrap) {
        observer.observe(appWrap, { attributes: true, attributeFilter: ['style', 'class'] });
      }
    }

    // The shell boots hidden behind the login screen; re-measure when it appears.
    if (window.ResizeObserver) {
      var resizeObserver = new ResizeObserver(function (entries) {
        for (var j = 0; j < entries.length; j += 1) {
          if (entries[j].contentRect.height > 0) enhance(entries[j].target);
        }
      });
      var allHeads = document.querySelectorAll('.page-head');
      for (var k = 0; k < allHeads.length; k += 1) resizeObserver.observe(allHeads[k]);
    }

    // Re-check after the app finishes booting (views may be rendered late).
    window.setTimeout(enhanceActiveView, 800);
    window.setTimeout(enhanceActiveView, 2200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
