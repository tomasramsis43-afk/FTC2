/* ============================================================
   نبض — Customer Workspace (ملف العميل) — Phase 4a
   ------------------------------------------------------------
   درج جانبي يعرض ملف العميل الكامل (هوية/مالية/دورة/حركات مرتبطة)
   فوق جدول العملاء القائم دون أي تغيير في مسارات الحفظ أو الحذف:
   - كل الأرقام تُحسب بدوال موجودة (total/paidTotal/remaining)
   - كل الإجراءات تفتح النماذج الحالية نفسها (openModal / تفويض
     data-invoice القائم / openVaultModal) — لا منطق جديد للكتابة
   الفتح: زر "فتح الملف" من قائمة الصف، أو نقر مزدوج على الصف.
   ============================================================ */

function cwStatusBadges(c){
  const badges = [];
  if(typeof pendingClientIdSet === 'function' && pendingClientIdSet().has(c.id)){
    badges.push('<span class="cw-badge warn">بانتظار اعتماد</span>');
  }
  if(c.suspended) badges.push('<span class="cw-badge muted">موقوف</span>');
  if(c.cancelled) badges.push('<span class="cw-badge danger">ملغي</span>');
  return badges.join('');
}

/* آخر الحركات المالية المرتبطة بالعميل (قراءة فقط):
   حركات تلقائية مربوطة بالمعرف + اليدوية المسجلة باسمه */
function cwRelatedMovements(c){
  return vaultTx
    .filter(t => t.autoClientId === c.id || String(t.clientName || '') === String(c.name || ''))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 6);
}

/* سجل نشاط هذا العميل تحديداً (قراءة فقط): نفلتر auditLog العام بمطابقة نصية
   لاسمه أو رقم هويته داخل وصف كل عملية — نفس أسلوب الربط النصي المستخدم أصلاً
   فى أماكن أخرى بالمشروع (مثال: module-companies.js) لعدم وجود clientId مُهيكل
   داخل بنية auditLog الحالية. صفر بيانات وهمية — كل سطر هنا عملية حقيقية مسجّلة. */
function cwClientActivity(c){
  if(typeof auditLog === 'undefined' || !Array.isArray(auditLog)) return [];
  const needles = [c.name, c.clientId].filter(Boolean).map(String);
  if(!needles.length) return [];
  return auditLog
    .filter(a => needles.some(n => String(a.description||'').includes(n)))
    .sort((a,b)=> b.ts - a.ts)
    .slice(0, 25);
}

function cwActivityHtml(c){
  const rows = cwClientActivity(c);
  if(!rows.length){
    return '<div class="hint">لا يوجد نشاط مسجَّل لهذا العميل بعد.</div>';
  }
  return '<div class="cw-activity">' + rows.map(a => `
    <div class="cw-activity-row ${escapeHtml(a.action||'')}">
      <span class="cw-act-dot"></span>
      <div>
        <div>${a.user ? '<b>'+escapeHtml(a.user)+'</b> ' : ''}${escapeHtml(a.description||a.section||'')}</div>
        <div class="cw-act-meta">${formatDateDisplay ? (new Date(a.ts)).toLocaleString('ar-SA') : ''}${a.section ? ' · '+escapeHtml(a.section) : ''}</div>
      </div>
    </div>`).join('') + '</div>';
}

const CW_TABS = [
  { id: 'overview', label: 'نظرة عامة' },
  { id: 'data', label: 'البيانات' },
  { id: 'activity', label: 'النشاط' },
];

function cwSwitchTab(tabId){
  $all('.cw-tab').forEach(b => b.classList.toggle('active', b.dataset.cwTab === tabId));
  $all('.cw-tabpanel').forEach(p => p.classList.toggle('active', p.dataset.cwPanel === tabId));
}

function openClientWorkspace(id){
  const c = clients.find(x => x.id === id);
  if(!c) return;
  const ov = $('#client-workspace-overlay');
  if(!ov) return;

  $('#cw-name').textContent = c.name || 'بدون اسم';
  $('#cw-badges').innerHTML = cwStatusBadges(c);

  /* ---- الملخص المالي (تبويب نظرة عامة) ---- */
  const tt = total(c), pd = paidTotal(c), rem = Math.max(tt - pd, 0);
  const pct = tt > 0 ? Math.min(100, Math.round((pd / tt) * 100)) : (pd > 0 ? 100 : 0);
  const finHtml = `
    <div class="cw-section">
      <h4>الوضع المالي</h4>
      <div class="cw-fin-row">
        <div><small>الإجمالي</small><b>${fmt(tt)}</b></div>
        <div class="ok"><small>المدفوع</small><b>${fmt(pd)}</b></div>
        <div class="${rem > 0 ? 'due' : 'ok'}"><small>المتبقي</small><b>${fmt(rem)}</b></div>
      </div>
      <div class="cw-bar"><i style="width:${pct}%"></i></div>
      <div class="cw-bar-cap">سُدد ${pct}% من إجمالي المستحق${c.creditDays ? ` · آجل ${escapeHtml(String(c.creditDays))} يوم` : ''}${c.clientTaxNumber ? ` · الرقم الضريبي: ${escapeHtml(c.clientTaxNumber)}` : ''}</div>
    </div>`;

  /* ---- الحركات المرتبطة (قراءة فقط) — تبويب نظرة عامة ---- */
  const moves = cwRelatedMovements(c);
  const movesHtml = `
    <div class="cw-section">
      <h4>آخر الحركات المالية المرتبطة</h4>
      ${moves.length ? `<div class="cw-moves">${moves.map(t => `
        <div class="cw-move">
          <span class="stamp ${t.type === 'in' ? 'paid' : 'owe'}">${t.type === 'in' ? 'قبض' : 'صرف'}</span>
          <b>${fmt(num(t.amount))}</b>
          <span class="cw-move-meta">${formatDateDisplay(t.date) || ''} ${t.notes ? '· ' + escapeHtml(String(t.notes)).slice(0, 40) : ''}</span>
        </div>`).join('')}</div>`
      : '<div class="hint">لا توجد حركات مالية مرتبطة بهذا العميل بعد</div>'}
    </div>`;

  /* ---- بطاقات البيانات (تبويب البيانات) ---- */
  const row = (k, v) => v ? `<div class="cw-item"><small>${k}</small><b>${v}</b></div>` : '';
  const infoHtml = `
    <div class="cw-section">
      <h4>بيانات العميل</h4>
      <div class="cw-grid">
        ${row('رقم الهوية', escapeHtml(c.clientId || ''))}
        ${row('الجوال', phoneCellHtml ? phoneCellHtml(c.phone) : escapeHtml(c.phone || ''))}
        ${row('الجنسية', escapeHtml(c.nationality || ''))}
        ${row('تاريخ التسجيل', formatDateDisplay(c.date) || '')}
        ${row('الرقم المرجعي', escapeHtml(c.referNum || ''))}
        ${row('الشركة', escapeHtml(c.companyName || ''))}
        ${row('قناة الدفع', typeof paymentChannelsLabel === 'function' ? escapeHtml(paymentChannelsLabel(c)) : '')}
        ${row('البريد', escapeHtml(c.email || ''))}
      </div>
    </div>
    <div class="cw-section">
      <h4>الدورة والحقائب</h4>
      <div class="cw-grid">
        ${row('الدورة', escapeHtml(c.courseType || ''))}
        ${row('رقم الدورة', escapeHtml(c.courseNumber || ''))}
        ${row('رقم الفاتورة', escapeHtml(c.invoice || ''))}
        ${row('الحقيبة', typeof bagSourceLabel === 'function' ? bagSourceLabel(c) : escapeHtml(c.bagSource || ''))}
        ${(c.bagPrice != null && c.bagPrice !== '') ? row('سعر الحقيبة', fmt(num(c.bagPrice))) : ''}
        ${(c.discount != null && Number(c.discount) !== 0) ? row('الخصم', fmt(num(c.discount))) : ''}
      </div>
    </div>`;

  /* ---- تبويب النشاط ---- */
  const activityHtml = `<div class="cw-section">${cwActivityHtml(c)}</div>`;

  $('#cw-tabs').innerHTML = CW_TABS.map((t, i) =>
    `<button type="button" class="cw-tab${i===0?' active':''}" data-cw-tab="${t.id}">${t.label}</button>`
  ).join('');

  $('#cw-body').innerHTML = `
    <div class="cw-tabpanel active" data-cw-panel="overview">${finHtml}${movesHtml}</div>
    <div class="cw-tabpanel" data-cw-panel="data">${infoHtml}</div>
    <div class="cw-tabpanel" data-cw-panel="activity">${activityHtml}</div>
  `;

  $('#cw-tabs').querySelectorAll('.cw-tab').forEach(btn => {
    btn.addEventListener('click', () => cwSwitchTab(btn.dataset.cwTab));
  });

  /* ---- الإجراءات: نفس فتحات النماذج القائمة بالضبط ---- */
  const foot = $('#cw-foot');
  const acts = [];
  if(typeof canReceptionEditClient !== 'function' || canReceptionEditClient(c)){
    acts.push(`<button type="button" class="btn btn-gold btn-sm" id="cw-edit">تعديل البيانات</button>`);
  }
  acts.push(`<button type="button" class="btn btn-ghost btn-sm" id="cw-invoice">الفاتورة</button>`);
  if(canAccessView('vault') && typeof openVaultModal === 'function'){
    acts.push(`<button type="button" class="btn btn-ghost btn-sm" id="cw-vault">حركة مالية</button>`);
  }
  foot.innerHTML = acts.join('');

  $('#cw-edit')?.addEventListener('click', () => { closeClientWorkspace(); openModal(c.id); });
  $('#cw-invoice')?.addEventListener('click', () => {
    // نعيد استخدام معالج الفاتورة القائم كما هو (تفويض document على data-invoice)
    closeClientWorkspace();
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-invoice', c.id);
    b.style.display = 'none';
    document.body.appendChild(b);
    b.click();
    b.remove();
  });
  $('#cw-vault')?.addEventListener('click', () => { closeClientWorkspace(); openVaultModal(null); });

  ov.classList.add('show');
}

function closeClientWorkspace(){
  $('#client-workspace-overlay')?.classList.remove('show');
}

/* --- الربط: زر قائمة الصف + نقر مزدوج + إغلاق --- */
document.addEventListener('click', e => {
  const wid = e.target.dataset ? e.target.dataset.workspace : null;
  if(wid){ openClientWorkspace(wid); return; }
  if(e.target.id === 'btn-cw-close'){ closeClientWorkspace(); return; }
  if(e.target.id === 'client-workspace-overlay') closeClientWorkspace();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && $('#client-workspace-overlay')?.classList.contains('show')) closeClientWorkspace();
});
$('#table-body')?.addEventListener('dblclick', e => {
  const tr = e.target.closest('tr');
  if(!tr) return;
  const chk = tr.querySelector('.row-select-client');
  if(chk && chk.dataset.id) openClientWorkspace(chk.dataset.id);
});