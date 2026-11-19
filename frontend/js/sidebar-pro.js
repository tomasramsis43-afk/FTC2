/* ============================================================
   نبض — المرحلة 6: السايدبار الذكي
   ------------------------------------------------------------
   - مجموعات تنقل قابلة للطي مع تذكّر الحالة
   - مؤشرات حية (مستحقات العملاء / فواتير غير مطابقة / مخزون الحقائب)
   - تلميح عائم عند طي الشريط إلى أيقونات فقط
   - شريط سفلي: الإعدادات + المظهر + حالة الاتصال
   - اختصارات Alt + رقم لأول تسعة أقسام ظاهرة
   كل الإضافات هنا، دون تغيير بنية أزرار data-view القائمة.
   ============================================================ */
(function(){
  'use strict';

  var nav = document.querySelector('nav.tabs');
  if(!nav) return;

  var GROUPS_KEY = 'ftc2-nav-groups-collapsed';
  var collapsedGroups = {};
  try{
    collapsedGroups = JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') || {};
  }catch(e){ collapsedGroups = {}; }

  /* ---------------- 1) المجموعات القابلة للطي ---------------- */
  var groups = new Map();   // key -> { head, items }
  var groupOrder = [];

  nav.querySelectorAll('.nav-section-label').forEach(function(head, idx){
    var labelEl = head.querySelector('span');
    var label = (labelEl && labelEl.textContent ? labelEl.textContent : '').trim();
    var key = 'group-' + (idx + 1);

    head.dataset.navGroup = key;
    head.classList.add('nav-group-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'true');
    if(label) head.setAttribute('aria-label', 'طي/توسيع مجموعة ' + label);

    if(!head.querySelector('.nav-group-chev')){
      var chev = document.createElement('span');
      chev.className = 'nav-group-chev';
      chev.setAttribute('aria-hidden', 'true');
      chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
      head.appendChild(chev);
    }

    var items = [];
    var node = head.nextElementSibling;
    while(node && !node.classList.contains('nav-section-label') && !node.classList.contains('nav-dock')){
      if(node.matches && node.matches('button[data-view]')){
        node.dataset.navGroup = key;
        items.push(node);
      }
      node = node.nextElementSibling;
    }

    groups.set(key, { head: head, items: items });
    groupOrder.push(key);
  });

  function setGroupCollapsed(key, isCollapsed, persist){
    var g = groups.get(key);
    if(!g) return;
    g.items.forEach(function(b){
      b.classList.toggle('nav-group-hidden', !!isCollapsed);
    });
    g.head.classList.toggle('is-collapsed', !!isCollapsed);
    g.head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if(isCollapsed){
      g.head.classList.toggle('has-active', g.items.some(function(b){
        return b.classList.contains('active');
      }));
    }else{
      g.head.classList.remove('has-active');
    }
    if(persist){
      collapsedGroups[key] = !!isCollapsed;
      try{ localStorage.setItem(GROUPS_KEY, JSON.stringify(collapsedGroups)); }catch(e){}
    }
  }

  function refreshGroupActive(){
    groups.forEach(function(g){
      g.head.classList.toggle('has-active', g.head.classList.contains('is-collapsed') && g.items.some(function(b){
        return b.classList.contains('active');
      }));
    });
  }

  groupOrder.forEach(function(key){
    setGroupCollapsed(key, collapsedGroups[key] === true, false);
  });

  function expandGroupOf(btn){
    if(!btn || !btn.dataset.navGroup) return;
    if(btn.classList.contains('nav-group-hidden')){
      setGroupCollapsed(btn.dataset.navGroup, false, true);
    }
  }

  // أي تنقل — بما فيه التنقل البرمجي (مثل fallback الصلاحيات) — يفتح مجموعة العنصر
  nav.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('button[data-view]') : null;
    if(btn) expandGroupOf(btn);
    hideTip();
    setTimeout(refreshGroupActive, 0);
  }, true);

  groupOrder.forEach(function(key){
    var g = groups.get(key);
    g.head.addEventListener('click', function(){
      if(nav.classList.contains('collapsed')) return; // في وضع الأيقونات: الفواصل للعرض فقط
      setGroupCollapsed(key, !g.head.classList.contains('is-collapsed'), true);
      hideTip();
    });
    g.head.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        g.head.click();
      }
    });
  });

  // أزل تلميحات المتصفح الافتراضية (page-heads يضيف title عند الإقلاع)
  function stripNativeTitles(){
    nav.querySelectorAll('button[title], .nav-group-head[title]').forEach(function(b){
      b.removeAttribute('title');
    });
  }
  stripNativeTitles();

  /* ---------------- 2) تلميح عائم في وضع الأيقونات ---------------- */
  var tipEl = null;
  var tipTimer = null;

  function ensureTip(){
    if(tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'nav-rail-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function labelOf(btn){
    return (btn.dataset.navTip ||
      (btn.querySelector('span:not(.nav-badge)') || {}).textContent ||
      btn.getAttribute('aria-label') || '').trim();
  }

  function showTip(btn){
    if(!nav.classList.contains('collapsed')) return;
    if(window.matchMedia && window.matchMedia('(max-width: 900px)').matches) return;
    var label = labelOf(btn);
    if(!label) return;

    var badge = btn.querySelector('.nav-badge');
    var extra = badge && badge.dataset.tip ? badge.dataset.tip : '';
    var tip = ensureTip();
    tip.textContent = extra ? (label + ' · ' + extra) : label;
    if(btn.dataset.navShortcut) tip.textContent += '  ·  ' + btn.dataset.navShortcut;

    // قياس ثم تموضع بجانب الأيقونة داخل الشاشة دائماً
    tip.style.left = '-9999px';
    tip.style.top = '0px';
    tip.classList.add('show');

    var r = btn.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var gap = 10;
    var left = r.left - tw - gap;
    if(left < 8) left = r.right + gap;
    if(left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    var top = r.top + (r.height - th) / 2;
    top = Math.max(8, Math.min(top, window.innerHeight - th - 8));

    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip(){
    clearTimeout(tipTimer);
    if(tipEl) tipEl.classList.remove('show');
  }

  function hoverTarget(e){
    return e.target.closest ? e.target.closest('button[data-view], .nav-dock button') : null;
  }

  nav.addEventListener('mouseover', function(e){
    var btn = hoverTarget(e);
    if(!btn || !nav.contains(btn)) return;
    if(e.relatedTarget && btn.contains(e.relatedTarget)) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function(){ showTip(btn); }, 120);
  });
  nav.addEventListener('mouseout', function(e){
    var btn = hoverTarget(e);
    if(!btn) return;
    if(e.relatedTarget && btn.contains(e.relatedTarget)) return;
    hideTip();
  });
  nav.addEventListener('focusin', function(e){
    var btn = hoverTarget(e);
    if(btn) showTip(btn);
  });
  nav.addEventListener('focusout', hideTip);
  nav.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);
  window.addEventListener('ftc2:sidebar-toggled', hideTip);

  if(window.MutationObserver){
    new MutationObserver(function(){
      hideTip();
      if(nav.classList.contains('collapsed')) stripNativeTitles();
    }).observe(nav, { attributes: true, attributeFilter: ['class'] });
  }

  /* ---------------- 3) المؤشرات الحية ---------------- */
  function safe(fn, fallback){
    try{ return fn(); }catch(e){ return fallback; }
  }

  function setBadge(view, value, opts){
    var btn = nav.querySelector('button[data-view="' + view + '"]');
    if(!btn) return;
    opts = opts || {};
    var badge = btn.querySelector('.nav-badge');
    var show = value !== null && value !== undefined && value !== '' &&
      !(opts.hideZero && !value);

    if(!show){
      if(badge) badge.remove();
      return;
    }
    if(!badge){
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.setAttribute('aria-hidden', 'true');
      btn.appendChild(badge);
    }
    badge.textContent = (opts.max && Number(value) > opts.max) ? (opts.max + '+') : String(value);
    badge.className = 'nav-badge' + (opts.tone ? ' is-' + opts.tone : '');
    if(opts.tip) badge.dataset.tip = opts.tip;
    else delete badge.dataset.tip;
  }

  function updateBadges(){
    // العملاء الذين عليهم مبالغ متبقية (نستثني الموقوفين/الملغين)
    var dueClients = safe(function(){
      return clients.filter(function(c){
        return !c.suspended && !c.cancelled && remaining(c) > 0.005;
      }).length;
    }, 0);
    setBadge('clients', dueClients, {
      hideZero: true,
      max: 99,
      tip: dueClients ? (dueClients + ' عميل عليهم مبالغ متبقية') : ''
    });

    // فواتير الدورات غير المطابقة (القيمة الفعلية بالإيصال ≠ قيمة النظام)
    var mismatched = safe(function(){
      return courseInvoiceClients().filter(function(c){
        var actual = num(c.receiptActualValue);
        return actual > 0 && Math.abs(actual - centerIncome(c)) >= 0.01;
      }).length;
    }, 0);
    setBadge('courseinvoices', mismatched, {
      tone: 'warn',
      hideZero: true,
      max: 99,
      tip: mismatched ? (mismatched + ' فاتورة غير مطابقة') : ''
    });

    // القطع المتاحة حالياً في مخزون الحقائب
    var stock = safe(function(){ return bagStockTotals().purchasedQty; }, null);
    if(stock !== null && isFinite(stock)){
      stock = Math.max(0, Math.round(stock));
      setBadge('bags', stock, {
        tone: stock > 0 ? 'muted' : 'warn',
        max: 999,
        tip: stock > 0 ? (stock + ' قطعة متاحة في المخزون') : 'المخزون فارغ'
      });
    }
  }

  var badgeTimer = null;
  function scheduleBadges(){
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(updateBadges, 500);
  }

  // التحديث في نقاط طبيعية بدل الاستعلام المستمر
  [1200, 4000, 9000].forEach(function(ms){ setTimeout(updateBadges, ms); });
  setInterval(updateBadges, 60000);
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden) scheduleBadges();
  });
  window.addEventListener('focus', scheduleBadges);
  window.addEventListener('storage', scheduleBadges);
  window.addEventListener('ftc2:receipt-saved', scheduleBadges);

  // بعد أي تنقل قد تتغيّر البيانات المعروضة
  nav.addEventListener('click', scheduleBadges);

  /* ---------------- 4) الشريط السفلي ---------------- */
  var dockTheme = document.getElementById('btn-dock-theme');
  if(dockTheme){
    dockTheme.addEventListener('click', function(){
      var mainThemeBtn = document.getElementById('btn-theme-toggle');
      if(mainThemeBtn) mainThemeBtn.click();
    });
    // تعكس أيقونة الشمس/القمر حسب الثيم الحالي
    function syncDockTheme(){
      var dark = document.body.classList.contains('dark-theme');
      dockTheme.setAttribute('aria-pressed', dark ? 'true' : 'false');
      dockTheme.dataset.navTip = dark ? 'المظهر الفاتح' : 'المظهر الداكن';
    }
    syncDockTheme();
    if(window.MutationObserver){
      new MutationObserver(syncDockTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  var dockStatus = document.getElementById('nav-dock-status');
  function updateOnline(){
    if(!dockStatus) return;
    var online = navigator.onLine;
    dockStatus.classList.toggle('is-offline', !online);
    var txt = dockStatus.querySelector('span');
    if(txt) txt.textContent = online ? 'متصل' : 'غير متصل';
    dockStatus.title = online ? 'الاتصال بالشبكة يعمل' : 'لا يوجد اتصال بالشبكة';
    dockStatus.dataset.navTip = txt ? txt.textContent : '';
  }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  /* ---------------- 5) اختصارات Alt + رقم ---------------- */
  function visibleNavButtons(){
    return Array.prototype.filter.call(
      nav.querySelectorAll('button[data-view]'),
      function(b){
        if(b.classList.contains('nav-group-hidden')) return false;
        var cs = window.getComputedStyle(b);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && b.offsetParent !== null;
      }
    );
  }

  window.addEventListener('keydown', function(e){
    if(!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
    if(!m) return;

    var t = e.target;
    var tag = (t && t.tagName ? t.tagName : '').toLowerCase();
    if(tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;

    var overlay = document.getElementById('overlay');
    if(overlay && window.getComputedStyle(overlay).display !== 'none') return;

    var btn = visibleNavButtons()[parseInt(m[1], 10) - 1];
    if(!btn) return;
    e.preventDefault();
    btn.click();
  });

  // رقم مختصر يظهر داخل تلميح وضع الأيقونات
  function annotateShortcuts(){
    visibleNavButtons().forEach(function(b, i){
      if(i < 9) b.dataset.navShortcut = 'Alt+' + (i + 1);
      else delete b.dataset.navShortcut;
    });
  }
  annotateShortcuts();
  nav.addEventListener('click', function(){ setTimeout(annotateShortcuts, 50); });
  if(window.MutationObserver){
    new MutationObserver(function(){ setTimeout(annotateShortcuts, 30); })
      .observe(nav, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
})();
