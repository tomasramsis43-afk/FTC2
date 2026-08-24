/* ============================================================
   نبض — Ledger Workspace (تفاصيل الحركة المالية) — Phase 4b + سند قبض
   ------------------------------------------------------------
   درج جانبي يعرض تفاصيل حركة الخزنة/البنك/الشبكة كاملة مع سياق
   الرصيد وحالة الاحتساب، وأزرار تعيد فتح المسارات القائمة نفسها:
   openVaultModal(id) للتعديل، وتفويض data-vdel / data-vvoucher /
   data-vreceipt / data-vprintreturn للحذف والطباعة — صفر منطق كتابة جديد.
   الفتح: زر "التفاصيل" من قائمة صف الحركة (النقر المزدوج محجوز
   أصلاً للتحرير السريع للخلايا).
   ============================================================ */

function vwTypeBadge(t){
  if(t.type === 'in') return '<span class="stamp paid">وارد</span>';
  if(t.isReturn) return '<span class="stamp owe">مردود مبيعات</span>';
  return '<span class="stamp owe">صادر</span>';
}

function vwStatusNotes(t){
  const notes = [];
  if(!vaultTxCountsTowardBalance(t)){
    notes.push('<span class="cw-badge warn" title="لم تُسوَّ بعد — لا تُحتسب ضمن رصيد الخزنة حتى تُسوَّى من صندوق تسويات الاستقبال">غير محتسبة في الرصيد</span>');
  }
  const meta = (typeof recordMeta === 'object' && recordMeta && recordMeta.vaultTx) ? recordMeta.vaultTx[t.id] : null;
  if(meta && meta.status === 'pending'){
    notes.push('<span class="cw-badge warn">قيد اعتماد الأدمن</span>');
  }
  if(typeof vaultAnomalyIds === 'function' && vaultAnomalyIds().has(t.id)){
    notes.push('<span class="cw-badge warn">مبلغ غير معتاد إحصائياً</span>');
  }
  if(t.clientId && typeof vaultDuplicateClientIds === 'function' && vaultDuplicateClientIds().has(t.clientId)){
    notes.push('<span class="cw-badge danger">رقم هوية مكرر في الحركات</span>');
  }
  return notes.join(' ');
}

function openVaultWorkspace(id){
  const t = vaultTx.find(x => x.id === id);
  if(!t) return;
  const ov = $('#vault-workspace-overlay');
  if(!ov) return;

  $('#vw-title').innerHTML = `${vwTypeBadge(t)} <b style="font-size:15px;">${fmt(num(t.amount))}</b> · ${destLabel(t.destination || 'vault')} · #${t.seq || '—'}`;
  $('#vw-badges').innerHTML = vwStatusNotes(t);

  const row = (k, v) => (v !== undefined && v !== null && String(v) !== '') ? `<div class="cw-item"><small>${k}</small><b>${v}</b></div>` : '';
  const isAutoClient = t.type === 'in' && t.autoClientId;
  const isCompany = t.type === 'in' && t.companyTransferId;

  const bodyHtml = `
    <div class="cw-section">
      <h4>بيانات الحركة</h4>
      <div class="cw-grid">
        ${row('التاريخ', escapeHtml(t.date || ''))}
        ${row('الحساب', escapeHtml(destLabel(t.destination || 'vault')))}
        ${row('النوع', vwTypeBadge(t))}
        ${row('المبلغ', fmt(num(t.amount)))}
        ${row('طريقة الدفع', escapeHtml(t.method || ''))}
        ${row('رقم فاتورة الشبكة', escapeHtml(t.networkInvoice || ''))}
        ${row('المستند', escapeHtml(t.referenceNo || ''))}
        ${row('المستلم', escapeHtml(t.recipientName || ''))}
        ${(t.type === 'out' && !t.isReturn) ? row('التصنيف', escapeHtml(t.category || '')) : ''}
        ${row('العميل', (t.clientName ? escapeHtml(t.clientName) : '') + (t.clientId ? ` <span style="color:var(--text-muted); font-weight:400;">(${escapeHtml(t.clientId)})</span>` : ''))}
        ${row('البيان اليدوي', escapeHtml(t.manual || ''))}
      </div>
      ${t.notes ? `<div class="cw-item" style="margin-top:7px; width:100%;"><small>ملاحظات</small><b>${escapeHtml(t.notes)}</b></div>` : ''}
    </div>

    <div class="cw-section">
      <h4>سياق الرصيد</h4>
      <div class="cw-fin-row">
        <div><small>رصيد ${escapeHtml(destLabel(t.destination || 'vault'))} حالياً</small><b>${fmt(balanceOf(t.destination || 'vault'))}</b></div>
        <div class="${t.type === 'in' ? 'ok' : 'due'}"><small>أثر هذه الحركة</small><b>${t.type === 'in' ? '+' : '-'}${fmt(num(t.amount))}</b></div>
        <div><small>حالة الاحتساب</small><b>${vaultTxCountsTowardBalance(t) ? 'داخل الرصيد' : 'خارجه (معلّقة)'}</b></div>
      </div>
      ${isAutoClient ? '<div class="hint" style="margin-top:8px;">🔗 دفعة تسجيل مرتبطة بعميل — التعديل يتم من شيت العملاء وليس من هنا</div>' : ''}
      ${isCompany ? '<div class="hint" style="margin-top:8px;">👥 دفعة تحويل شركة — راجع تفاصيل المتدربين من زر الشاشة</div>' : ''}
    </div>`;
  $('#vw-body').innerHTML = bodyHtml;

  /* ---- الإجراءات: نفس شروط قائمة الصف بالضبط + سند قبض لكل وارد ---- */
  const foot = $('#vw-foot');
  if(isAutoClient){
    foot.innerHTML = `<button type="button" class="btn btn-gold btn-sm" id="vw-receipt">🧾 سند قبض</button>`;
  } else if(isCompany){
    foot.innerHTML = `<button type="button" class="btn btn-gold btn-sm" id="vw-receipt">🧾 سند قبض</button>`;
  } else {
    const acts = [`<button type="button" class="btn btn-gold btn-sm" id="vw-edit">تعديل</button>`];
    if(t.isReturn) acts.push(`<button type="button" class="btn btn-gold btn-sm" id="vw-printreturn">طباعة فاتورة الاسترجاع</button>`);
    if(t.type === 'out' && !t.isReturn) acts.push(`<button type="button" class="btn btn-gold btn-sm" id="vw-voucher">طباعة سند صرف</button>`);
    if(t.type === 'in') acts.push(`<button type="button" class="btn btn-gold btn-sm" id="vw-receipt">🧾 سند قبض</button>`);
    acts.push(`<button type="button" class="btn btn-danger btn-sm" id="vw-del">حذف</button>`);
    foot.innerHTML = acts.join('');
  }
  const synth = attr => {
    closeVaultWorkspace();
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute(attr, id);
    b.style.display = 'none';
    document.body.appendChild(b);
    b.click();
    b.remove();
  };
  $('#vw-edit')?.addEventListener('click', () => { closeVaultWorkspace(); openVaultModal(id); });
  $('#vw-printreturn')?.addEventListener('click', () => synth('data-vprintreturn'));
  $('#vw-voucher')?.addEventListener('click', () => synth('data-vvoucher'));
  $('#vw-receipt')?.addEventListener('click', () => synth('data-vreceipt'));
  $('#vw-del')?.addEventListener('click', () => synth('data-vdel'));

  ov.classList.add('show');
}

function closeVaultWorkspace(){
  $('#vault-workspace-overlay')?.classList.remove('show');
}

document.addEventListener('click', e => {
  const wid = e.target.dataset ? e.target.dataset.vws : null;
  if(wid){ openVaultWorkspace(wid); return; }
  if(e.target.id === 'btn-vw-close'){ closeVaultWorkspace(); return; }
  if(e.target.id === 'vault-workspace-overlay') closeVaultWorkspace();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && $('#vault-workspace-overlay')?.classList.contains('show')) closeVaultWorkspace();
});