/* ============================================================
   نبض — Grid Enhancements (Phase 5)
   ------------------------------------------------------------
   ترقيات شبكة فوق البنية القائمة دون لمس منطق الجداول:
     1) إظهار/إخفاء أعمدة جدول العملاء (محفوظ محلياً)
     2) عروض فلاتر محفوظة (Saved Views) لشاشة العملاء
     3) قائمة سياق بالنقر الأيمن تعيد استخدام قائمة الصف العالمية
   التطبيق كله عبر ضبط قيم الحقول وإطلاق أحداث input/change — أي أن
   خط المعالجة القائم (renderTable والفلاتر المتقدمة) هو المنفذ فعلياً.
   ============================================================ */

(function(){
  'use strict';

  /* ---------- أدوات ---------- */
  const $id = id => document.getElementById(id);

  /* ========================================================
     1) إظهار/إخفاء الأعمدة — جدول العملاء
     ======================================================== */
  // الأعمدة القابلة للإخفاء فقط؛ checkbox(0) والاسم(1) والإجراءات(15) محمية
  const CLIENT_COLS = [
    { idx: 2,  label: 'الجوال' },
    { idx: 3,  label: 'رقم الهوية' },
    { idx: 4,  label: 'الرقم المرجعي' },
    { idx: 5,  label: 'الجنسية' },
    { idx: 6,  label: 'الدورة' },
    { idx: 7,  label: 'رقم الدورة' },
    { idx: 8,  label: 'رقم الفاتورة' },
    { idx: 9,  label: 'تاريخ التسجيل' },
    { idx: 10, label: 'الإجمالي' },
    { idx: 11, label: 'المدفوع' },
    { idx: 12, label: 'المتبقي' },
    { idx: 13, label: 'الحقيبة' },
    { idx: 14, label: 'قناة الدفع' }
  ];
  const COLS_KEY = 'nabd-grid-clients-hidden';
  let hiddenCols = [];
  try { hiddenCols = JSON.parse(localStorage.getItem(COLS_KEY) || '[]'); } catch(e) { hiddenCols = []; }
  hiddenCols = hiddenCols.filter(n => CLIENT_COLS.some(c => c.idx === n));

  function applyHiddenCols(){
    const tbody = $id('table-body');
    if(!tbody) return;
    const table = tbody.closest('table');
    if(!table) return;
    table.classList.add('clients-grid');
    CLIENT_COLS.forEach(c => table.classList.toggle(`hide-col-${c.idx}`, hiddenCols.includes(c.idx)));
  }

  function buildGridToolbar(){
    const tbody = $id('table-body');
    if(!tbody) return;
    const scroll = tbody.closest('.table-scroll');
    if(!scroll || $id('grid-toolbar-clients')) return;

    const bar = document.createElement('div');
    bar.className = 'grid-toolbar';
    bar.id = 'grid-toolbar-clients';
    bar.innerHTML = `
      <div class="gv-saved" id="saved-views-bar"></div>
      <div class="gv-right">
        <button type="button" class="btn btn-ghost btn-sm" id="btn-save-view">💾 حفظ العرض</button>
        <div class="cols-wrap">
          <button type="button" class="btn btn-ghost btn-sm" id="btn-cols-toggle">▦ الأعمدة</button>
          <div class="cols-panel" id="cols-panel" role="menu">
            ${CLIENT_COLS.map(c => `
              <label class="cols-item"><input type="checkbox" data-col="${c.idx}" ${hiddenCols.includes(c.idx) ? '' : 'checked'}> ${c.label}</label>
            `).join('')}
          </div>
        </div>
      </div>`;
    scroll.insertAdjacentElement('beforebegin', bar);
    applyHiddenCols();

    /* فتح/إغلاق لوحة الأعمدة */
    $id('btn-cols-toggle').addEventListener('click', e => {
      e.stopPropagation();
      $id('cols-panel').classList.toggle('show');
    });
    document.addEventListener('click', e => {
      if(!e.target.closest('.cols-wrap')) $id('cols-panel')?.classList.remove('show');
    });
    $id('cols-panel').addEventListener('change', e => {
      const idx = Number(e.target.dataset.col);
      if(Number.isNaN(idx)) return;
      if(e.target.checked) hiddenCols = hiddenCols.filter(n => n !== idx);
      else if(!hiddenCols.includes(idx)) hiddenCols.push(idx);
      try { localStorage.setItem(COLS_KEY, JSON.stringify(hiddenCols)); } catch(err) {}
      applyHiddenCols();
    });

    /* ========================================================
       2) العروض المحفوظة
       ======================================================== */
    const VIEW_FIELDS = ['search','filter-course','filter-nat','filter-status','filter-company',
      'filter-invoice','filter-coursenum','filter-refnum','cl-date-from','cl-date-to',
      'cl-paid-min','cl-paid-max','filter-bag-source'];
    const VIEWS_KEY = 'nabd-saved-views-clients';

    const loadViews = () => {
      try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]'); } catch(e){ return []; }
    };
    const persistViews = v => {
      try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)); } catch(err) {}
    };

    function currentFiltersSignature(){
      const parts = VIEW_FIELDS.map(f => $id(f)?.value || '').filter(Boolean);
      return parts.length ? parts.join(' · ') : '';
    }

    function renderSavedViews(){
      const box = $id('saved-views-bar');
      if(!box) return;
      const views = loadViews();
      box.innerHTML = `
        <span class="gv-label">عروض:</span>
        ${(views.length ? views : []).map((v, i) => `
          <span class="sv-chip" title="اضغط لتطبيق العرض">
            <button type="button" class="sv-name" data-sv-apply="${i}">${escapeHtml(v.name)}</button>
            <button type="button" class="sv-del" data-sv-del="${i}" title="حذف العرض">×</button>
          </span>`).join('')}
        ${views.length ? '' : '<span class="hint" style="margin:0;">اضبط الفلاتر ثم اضغط «حفظ العرض» لاستعادتها لاحقاً بنقرة</span>'}`;
    }

    function applyView(view){
      VIEW_FIELDS.forEach(f => {
        const el = $id(f);
        if(!el) return;
        el.value = view.values[f] || '';
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input'));
      });
      if(typeof showToast === 'function') showToast(`تم تطبيق العرض: ${view.name}`);
    }

    $id('btn-save-view').addEventListener('click', () => {
      const sig = currentFiltersSignature();
      if(!sig){
        if(typeof showToast === 'function') showToast('لا توجد فلاتر مطبقة لحفظها');
        return;
      }
      const views = loadViews();
      let name = sig.length > 26 ? sig.slice(0, 26) + '…' : sig;
      if(views.some(v => v.name === name)) name = `${name} (${views.length + 1})`;
      const values = {};
      VIEW_FIELDS.forEach(f => values[f] = $id(f)?.value || '');
      views.push({ name, values });
      persistViews(views);
      renderSavedViews();
      if(typeof showToast === 'function') showToast(`تم حفظ العرض: ${name}`);
    });

    $id('saved-views-bar').addEventListener('click', e => {
      const del = e.target.dataset.svDel;
      if(del !== undefined && del !== ''){
        const views = loadViews();
        views.splice(Number(del), 1);
        persistViews(views);
        renderSavedViews();
        return;
      }
      const ap = e.target.dataset.svApply;
      if(ap !== undefined && ap !== ''){
        const view = loadViews()[Number(ap)];
        if(view) applyView(view);
      }
    });

    renderSavedViews();
  }

  /* ========================================================
     3) قائمة السياق (زر يمين) — نفس قائمة الصف العالمية
     ======================================================== */
  function bindContextMenus(){
    ['#table-body', '#vault-table-body'].forEach(sel => {
      const tb = document.querySelector(sel);
      if(!tb) return;
      tb.addEventListener('contextmenu', e => {
        const tr = e.target.closest('tr');
        if(!tr) return;
        const toggle = tr.querySelector('.row-menu-toggle');
        if(!toggle) return;
        e.preventDefault();
        toggle.click();
      });
    });
  }

  /* ========================================================
     الإقلاع — بعد اكتمال DOM (سكربت defer)
     ======================================================== */
  try { buildGridToolbar(); } catch(e) {}
  try { bindContextMenus(); } catch(e) {}
})();