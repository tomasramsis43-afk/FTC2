/* ================= المشتريات (موردون + فواتير شراء) ================= */
// معدل الضريبة مركزي في core-utils.js (VAT_RATE) — أي تعديل على المعدل يُطبَّق هنا تلقائياً
function purchaseTax(subtotal){ return subtotal * VAT_RATE; }
function purchaseMatchesFilters(p){
  const q = ($('#purchase-search')?.value||'').trim().toLowerCase();
  const supVals = selectedFilterValues($('#purchase-supplier-filter'));
  const statusVals = selectedFilterValues($('#purchase-status-filter'));
  const from = $('#purchase-date-from')?.value||'';
  const to = $('#purchase-date-to')?.value||'';
  if(supVals.length && !supVals.includes(p.supplierId)) return false;
  if(statusVals.length && !statusVals.includes(p.status)) return false;
  if(from && p.date < from) return false;
  if(to && p.date > to) return false;
  if(q){
    const itemsText = (p.items||[]).map(i=>i.name).join(' ').toLowerCase();
    const hay = [p.invoiceNo, p.supplierName, itemsText, p.notes].join(' ').toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}
function supplierTotalsMap(){
  const map = {};
  purchases.forEach(p=>{ map[p.supplierId] = (map[p.supplierId]||0) + num(p.total); });
  return map;
}
function renderPurchaseCards(){
  // الشهر الحالي بالتوقيت المحلي — toISOString() كان يزيحه لـ UTC (+3 بالسعودية) فيُخطئ
  // تصنيف مشتريات أول ساعات الشهر إلى الشهر السابق.
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const thisMonth = purchases.filter(p=>(p.date||'').slice(0,7)===ym).reduce((s,p)=>s+num(p.total),0);
  const unpaid = purchases.filter(p=>p.status==='unpaid');
  const unpaidTotal = unpaid.reduce((s,p)=>s+num(p.total),0);
  const allTotal = purchases.reduce((s,p)=>s+num(p.total),0);
  const el = $('#purchase-cards');
  if(!el) return;
  el.innerHTML = `
    <div class="card"><div class="k">مشتريات هذا الشهر</div><div class="v">${fmt(thisMonth)} ﷼</div></div>
    <div class="card"><div class="k">إجمالي المشتريات (كل الفترات)</div><div class="v">${fmt(allTotal)} ﷼</div></div>
    <div class="card"><div class="k">فواتير غير مدفوعة</div><div class="v">${unpaid.length}<span style="font-size:12px; color:var(--text-muted);"> (${fmt(unpaidTotal)} ﷼)</span></div></div>
    <div class="card"><div class="k">عدد الموردين</div><div class="v">${suppliers.length}</div></div>
  `;
}
function renderSuppliersTable(){
  const body = $('#suppliers-body');
  if(!body) return;
  const q = ($('#supplier-search')?.value||'').trim().toLowerCase();
  const totals = supplierTotalsMap();
  const rows = suppliers.filter(s=> !q || (s.name||'').toLowerCase().includes(q) || (s.phone||'').includes(q));
  body.innerHTML = rows.map(s=>`
    <tr>
      <td data-label="اسم المورد">${escapeHtml(s.name)}</td>
      <td class="mono" data-label="الجوال">${escapeHtml(s.phone||'—')}</td>
      <td data-label="التصنيف">${escapeHtml(s.category||'—')}</td>
      <td class="mono" data-label="إجمالي المشتريات">${fmt(totals[s.id]||0)} ﷼</td>
      <td data-label="ملاحظات">${escapeHtml(s.notes||'—')}</td>
      <td class="card-full" data-label="">
        <button class="btn btn-ghost btn-sm" data-edit-supplier="${s.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-supplier="${s.id}">حذف</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">لا يوجد موردون بعد</td></tr>`;
}
function populatePurchaseSupplierSelects(){
  const opts = suppliers.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const sel = $('#pu-supplier'); if(sel) sel.innerHTML = opts || '<option value="">أضف مورداً أولاً</option>';
  const filt = $('#purchase-supplier-filter');
  if(filt){
    const prevVals = selectedFilterValues(filt);
    filt.innerHTML = '<option value="">كل الموردين</option>' + opts;
    Array.from(filt.options).forEach(o=> o.selected = prevVals.includes(o.value));
    refreshMultiSelectFilterUI(filt);
  }
}
function renderPurchasesTable(){
  const body = $('#purchases-body');
  if(!body) return;
  const rows = purchases.filter(purchaseMatchesFilters).sort((a,b)=> (b.date||'').localeCompare(a.date||'') || (b.createdAt||0)-(a.createdAt||0));
  body.innerHTML = rows.map(p=>`
    <tr>
      <td class="mono" data-label="التاريخ">${escapeHtml(p.date||'—')}</td>
      <td data-label="المورد">${escapeHtml(p.supplierName||'—')}</td>
      <td class="mono" data-label="رقم الفاتورة">${escapeHtml(p.invoiceNo||'—')}</td>
      <td data-label="المرفق">${p.attachment ? `<button class="btn btn-ghost btn-sm" data-view-attachment="${p.id}">📎 عرض</button>` : `<span style="color:var(--text-muted); font-size:12px;">—</span>`}</td>
      <td data-label="الأصناف"><button class="btn btn-ghost btn-sm" data-view-items="${p.id}">عرض (${(p.items||[]).length})</button></td>
      <td class="mono" data-label="الإجمالي">${fmt(num(p.total))} ﷼</td>
      <td data-label="طريقة الدفع">${escapeHtml(p.method||'—')}</td>
      <td data-label="الحالة"><span class="stamp ${p.status==='paid'?'paid':'owe'}">${p.status==='paid'?'مدفوعة':'غير مدفوعة'}</span></td>
      <td class="card-full" data-label="">
        <button class="btn btn-ghost btn-sm" data-edit-purchase="${p.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-purchase="${p.id}">حذف</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير مشتريات مطابقة</td></tr>`;
  const total = rows.reduce((s,p)=>s+num(p.total),0);
  const totalEl = $('#purchase-total'); if(totalEl) totalEl.textContent = `الإجمالي (حسب الفلتر): ${fmt(total)} ﷼`;
}
function renderPurchases(){
  if(!$('#view-purchases')) return;
  populatePurchaseSupplierSelects();
  renderPurchaseCards();
  renderSuppliersTable();
  renderPurchasesTable();
}

let editingSupplierId = null;
let editingPurchaseId = null;
let currentPurchaseAttachment = null;

function updatePurchaseAttachmentPreview(){
  const wrap = $('#pu-attachment-preview-wrap');
  const nameEl = $('#pu-attachment-name');
  if(!wrap) return;
  if(currentPurchaseAttachment){
    wrap.style.display = '';
    if(nameEl) nameEl.textContent = currentPurchaseAttachment.name || 'مرفق مرفوع';
  } else {
    wrap.style.display = 'none';
    if(nameEl) nameEl.textContent = '';
  }
}
function openAttachmentViewer(att){
  if(!att || !att.dataUrl){ showToast('لا يوجد مرفق لعرضه'); return; }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,33,.75); z-index:99999; display:flex; flex-direction:column; align-items:center; padding:18px; box-sizing:border-box;';
  const bar = document.createElement('div');
  bar.style.cssText = 'width:100%; max-width:900px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;';
  const label = document.createElement('span');
  label.style.cssText = 'color:#fff; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  label.textContent = att.name || 'مرفق الفاتورة';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px;';
  const dlBtn = document.createElement('a');
  dlBtn.textContent = '⬇ تحميل';
  dlBtn.href = att.dataUrl;
  dlBtn.download = att.name || 'مرفق';
  dlBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px; text-decoration:none;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ إغلاق';
  closeBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border:none; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
  closeBtn.onclick = ()=> overlay.remove();
  actions.appendChild(dlBtn); actions.appendChild(closeBtn);
  bar.appendChild(label); bar.appendChild(actions);

  const frameWrap = document.createElement('div');
  frameWrap.style.cssText = 'width:100%; max-width:900px; flex:1; background:#fff; border-radius:10px; overflow:hidden;';
  if((att.type||'').startsWith('image/')){
    frameWrap.innerHTML = `<img src="${att.dataUrl}" style="width:100%; height:100%; object-fit:contain; display:block;">`;
  } else {
    frameWrap.innerHTML = `<iframe src="${att.dataUrl}" style="width:100%; height:100%; border:none;"></iframe>`;
  }

  overlay.appendChild(bar);
  overlay.appendChild(frameWrap);
  document.body.appendChild(overlay);
}
function openPurchaseItemsPopup(id){
  const p = purchases.find(x=>x.id===id);
  if(!p){ showToast('تعذر إيجاد فاتورة الشراء'); return; }
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const rowsHtml = (p.items||[]).map(it=>`
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td class="num">${fmt(num(it.qty))}</td>
      <td class="num">${fmt(num(it.price))}</td>
      <td class="num">${fmt(num(it.qty)*num(it.price))}</td>
    </tr>
  `).join('') || `<tr><td colspan="4" style="text-align:center; color:#888;">لا توجد أصناف</td></tr>`;

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(p.invoiceNo || 'فاتورة-شراء', {accent: PRINT_PALETTE.navy, borderColor: PRINT_PALETTE.navy})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      <div class="inv-title">
        <h2>بيان أصناف فاتورة شراء</h2>
        <div class="no">${escapeHtml(p.invoiceNo || '—')}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">التاريخ: ${escapeHtml(formatDateDisplay(p.date)||p.date||'')}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات المورد</h4>
        <div class="info-row"><span>المورد:</span><b>${escapeHtml(p.supplierName||'—')}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(p.method||'—')}</b></div>
        <div class="info-row"><span>الحالة:</span><b>${p.status==='paid'?'مدفوعة':'غير مدفوعة'}</b></div>
      </div>
      <div class="info-box">
        <h4>ملاحظات</h4>
        <div class="info-row"><span></span><b>${escapeHtml(p.notes||'—')}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>الصنف</th><th style="text-align:left;">الكمية</th><th style="text-align:left;">سعر الوحدة</th><th style="text-align:left;">الإجمالي</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="totals">
      <div class="r"><span>الإجمالي قبل الضريبة</span><b class="mono">${fmt(num(p.subtotal))}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15%)</span><b class="mono">${fmt(num(p.taxAmount))}</b></div>
      <div class="r grand"><span>الإجمالي شامل الضريبة</span><b>${fmt(num(p.total))}</b></div>
    </div>

    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}

function addPurchaseItemRow(item){
  const wrap = $('#pu-items');
  if(!wrap) return;
  const row = document.createElement('div');
  row.className = 'formgrid pu-item-row';
  row.style.cssText = 'grid-template-columns:2fr 1fr 1fr auto; align-items:end; margin-bottom:6px;';
  row.innerHTML = `
    <div class="field"><label>الصنف</label><input type="text" class="pu-item-name" value="${escapeHtml(item?.name||'')}"></div>
    <div class="field"><label>الكمية</label><input type="number" step="0.01" min="0" class="pu-item-qty" value="${item?.qty ?? 1}"></div>
    <div class="field"><label>سعر الوحدة (بدون ضريبة)</label><input type="number" step="0.01" min="0" class="pu-item-price" value="${item?.price ?? 0}"></div>
    <button type="button" class="btn btn-danger btn-sm pu-item-remove" style="height:38px;">✕</button>
  `;
  wrap.appendChild(row);
  row.querySelectorAll('input').forEach(inp=> inp.addEventListener('input', updatePurchaseTotalDisplay));
  row.querySelector('.pu-item-remove').addEventListener('click', ()=>{ row.remove(); updatePurchaseTotalDisplay(); });
}
function updatePurchaseTotalDisplay(){
  let subtotal = 0;
  $all('#pu-items .pu-item-row').forEach(row=>{
    subtotal += num(row.querySelector('.pu-item-qty').value) * num(row.querySelector('.pu-item-price').value);
  });
  const tax = purchaseTax(subtotal);
  const total = subtotal + tax;
  const subEl = $('#pu-subtotal-display'); if(subEl) subEl.textContent = fmt(subtotal);
  const taxEl = $('#pu-tax-display'); if(taxEl) taxEl.textContent = fmt(tax);
  const totEl = $('#pu-total-display'); if(totEl) totEl.textContent = fmt(total);
  /* المعاينة الحية للمستند (Phase 4d) — عرض فقط؛ نفس الأرقام المحسوبة أعلاه حرفياً */
  renderPurchaseDocPreview(subtotal, tax, total);
}
/* معاينة حية بشكل مستند الشراء داخل النموذج — تقرأ الحقول كما هي ولا تغير شيئاً.
   VAT يُقرأ من ناتج purchaseTax نفسه (لا إعادة حساب ثانية). */
function renderPurchaseDocPreview(subtotal, tax, total){
  const el = $('#pu-doc-preview');
  if(!el || el.style.display === 'none') return;
  const ci = (typeof settings !== 'undefined' && settings.centerInfo) ? settings.centerInfo : {};
  const supSel = $('#pu-supplier');
  const supName = supSel?.selectedOptions?.[0]?.textContent || '—';
  const method = $('#pu-method')?.value || '';
  const statusMap = { paid: 'مدفوعة', unpaid: 'غير مدفوعة', partial: 'سداد جزئي' };
  const status = statusMap[$('#pu-status')?.value] || $('#pu-status')?.value || '';
  const items = $all('#pu-items .pu-item-row').map(row=>({
    name: row.querySelector('.pu-item-name').value,
    qty: num(row.querySelector('.pu-item-qty').value),
    price: num(row.querySelector('.pu-item-price').value)
  })).filter(it => it.name || it.qty || it.price);
  el.innerHTML = `
    <div class="doc-paper">
      <div class="doc-head">
        <div>
          <div class="doc-center">${escapeHtml(ci.name || 'المركز')}</div>
          <div class="doc-sub">${escapeHtml(ci.phone || '')}</div>
        </div>
        <div class="doc-meta">
          <div class="doc-title">فاتورة مشتريات</div>
          <small>رقم: ${escapeHtml($('#pu-invoiceno')?.value || '—')}</small>
          <small>التاريخ: ${escapeHtml($('#pu-date')?.value || '—')}</small>
        </div>
      </div>
      <div class="doc-parties">
        <span>المورد: <b>${escapeHtml(supName)}</b></span>
        <span>طريقة الدفع: <b>${escapeHtml(method || '—')}</b></span>
        <span>الحالة: <b>${escapeHtml(status)}</b></span>
      </div>
      <table class="doc-table">
        <thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
        <tbody>
          ${items.length ? items.map(it => `<tr>
            <td>${escapeHtml(it.name || '—')}</td>
            <td class="mono">${it.qty || 0}</td>
            <td class="mono">${fmt(it.price)}</td>
            <td class="mono">${fmt(it.qty * it.price)}</td>
          </tr>`).join('') : '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">أضف أصنافاً لتظهر في المعاينة</td></tr>'}
        </tbody>
      </table>
      <div class="doc-totals">
        <span>قبل الضريبة <b>${fmt(subtotal)} ﷼</b></span>
        <span>ض.ق.م (15%) <b>${fmt(tax)} ﷼</b></span>
        <span class="doc-grand">الإجمالي <b>${fmt(total)} ﷼</b></span>
      </div>
      ${$('#pu-notes')?.value ? `<div class="doc-notes">ملاحظات: ${escapeHtml($('#pu-notes').value)}</div>` : ''}
      ${ci.name ? '' : '<div class="hint" style="margin-top:6px;">أضف بيانات المركز من الإعدادات لتظهر في رأس المستند</div>'}
    </div>`;
}
$('#pu-toggle-preview')?.addEventListener('click', ()=>{
  const el = $('#pu-doc-preview');
  if(!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
  if(el.style.display === '') updatePurchaseTotalDisplay();
});
$('#purchase-form')?.addEventListener('input', ()=>{
  if($('#pu-doc-preview')?.style.display === '') updatePurchaseTotalDisplay();
});
function openPurchaseModal(id){
  editingPurchaseId = id || null;
  const p = id ? purchases.find(x=>x.id===id) : null;
  $('#purchase-modal-title').textContent = p ? 'تعديل فاتورة شراء' : 'فاتورة شراء جديدة';
  $('#pu-items').innerHTML = '';
  if(!suppliers.length){ showToast('أضف مورداً أولاً قبل تسجيل فاتورة شراء'); return; }
  populatePurchaseSupplierSelects();
  populateSelect($('#pu-method'), settings.channels.map(c=>c.name), false);
  $('#pu-supplier').value = p?.supplierId || (suppliers[0]?.id||'');
  $('#pu-date').value = p?.date || todayISO();
  $('#pu-invoiceno').value = p?.invoiceNo || '';
  if(p?.method && settings.channels.some(c=>c.name===p.method)) $('#pu-method').value = p.method;
  $('#pu-status').value = p?.status || 'paid';
  $('#pu-notes').value = p?.notes || '';
  $('#pu-attachment').value = '';
  currentPurchaseAttachment = p?.attachment || null;
  updatePurchaseAttachmentPreview();
  if(p && p.items && p.items.length) p.items.forEach(it=> addPurchaseItemRow(it));
  else addPurchaseItemRow();
  updatePurchaseTotalDisplay();
  $('#purchase-overlay').classList.add('show');
}
$('#btn-add-item-row')?.addEventListener('click', ()=> addPurchaseItemRow());
$('#btn-add-purchase')?.addEventListener('click', ()=> openPurchaseModal(null));
$('#pu-cancel')?.addEventListener('click', ()=> $('#purchase-overlay').classList.remove('show'));

/* ---------------- ضغط صور المرفقات قبل التخزين ----------------
   صور الكاميرا من الموبايل عادة توصل 3-8 ميجابايت وتُخزَّن كاملة كـ base64 داخل
   سجل الفاتورة (يُحمَّل كل مرة يُفتح فيها الشيت). هذه الدالة تُعيد رسم أي صورة على
   canvas بأقصى بُعد 1600px وجودة JPEG 0.72 قبل التخزين. لا تُطبَّق على:
   - ملفات PDF (لا يمكن ضغطها بنفس الطريقة)
   - الصور الصغيرة أصلاً (أقل من 400KB وأبعادها أقل من 1600px) — تُخزَّن كما هي
   وفي حال فشل الضغط لأي سبب (متصفح قديم، صورة تالفة...)، نرجع تلقائياً لتخزين
   الملف الأصلي كاملاً حتى لا يفقد المستخدم مرفقه.
   ترجع Promise<{name, type, dataUrl}>. */
function compressImageFile(file){
  return new Promise((resolve)=>{
    const fallback = ()=>{
      const reader = new FileReader();
      reader.onload = ()=> resolve({name: file.name, type: file.type, dataUrl: reader.result});
      reader.onerror = ()=> resolve(null);
      reader.readAsDataURL(file);
    };
    if(file.type === 'application/pdf' || file.type === 'image/gif'){ fallback(); return; }
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = ()=>{
      URL.revokeObjectURL(objectUrl);
      const maxDim = 1600;
      const needsResize = img.width > maxDim || img.height > maxDim;
      if(file.size < 400*1024 && !needsResize){ fallback(); return; }
      try{
        let w = img.width, h = img.height;
        if(needsResize){
          if(w > h){ h = Math.round(h * (maxDim/w)); w = maxDim; }
          else{ w = Math.round(w * (maxDim/h)); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        if(!dataUrl || dataUrl.length < 50){ fallback(); return; }
        const newName = file.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg';
        resolve({name: newName, type: 'image/jpeg', dataUrl});
      }catch(e){ fallback(); }
    };
    img.onerror = ()=>{ URL.revokeObjectURL(objectUrl); fallback(); };
    img.src = objectUrl;
  });
}

$('#pu-attachment')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  const nameOk = /\.(pdf|jpe?g|png|webp)$/i.test(file.name);
  const typeOk = ['application/pdf','image/jpeg','image/png','image/webp','image/jpg'].includes(file.type);
  if(!nameOk && !typeOk){
    showToast('صيغة الملف غير مدعومة — يُسمح فقط بـ PDF أو صورة');
    e.target.value = '';
    return;
  }
  if(file.size > 8*1024*1024){
    showToast('حجم الملف كبير جداً (الحد الأقصى 8 ميجابايت)');
    e.target.value = '';
    return;
  }
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name);
  if(isImage){
    const result = await compressImageFile(file);
    if(result){ currentPurchaseAttachment = result; updatePurchaseAttachmentPreview(); return; }
  }
  const reader = new FileReader();
  reader.onload = ()=>{
    currentPurchaseAttachment = {name: file.name, type: file.type, dataUrl: reader.result};
    updatePurchaseAttachmentPreview();
  };
  reader.onerror = ()=> showToast('تعذرت قراءة الملف');
  reader.readAsDataURL(file);
});
$('#pu-attachment-remove')?.addEventListener('click', ()=>{
  currentPurchaseAttachment = null;
  $('#pu-attachment').value = '';
  updatePurchaseAttachmentPreview();
});
$('#pu-attachment-view')?.addEventListener('click', async ()=>{
  if(!currentPurchaseAttachment) return;
  if(currentPurchaseAttachment.dataUrl){ openAttachmentViewer(currentPurchaseAttachment); return; }
  // مرفق فاتورة موجودة مسبقاً ولم يُستبدَل — بياناته الفعلية غير محمّلة بالذاكرة (وضع توفير البيانات)،
  // نجيبها الآن فقط عند الحاجة الفعلية للعرض
  if(!editingPurchaseId) return;
  const r = await window.storage.get('purchase-attachment:'+editingPurchaseId, false);
  if(r && r.value) openAttachmentViewer(JSON.parse(r.value));
  else showToast('تعذّر تحميل المرفق');
});

$('#btn-add-supplier')?.addEventListener('click', ()=>{
  editingSupplierId = null;
  $('#supplier-modal-title').textContent = 'مورد جديد';
  $('#supplier-form').reset();
  $('#supplier-overlay').classList.add('show');
});
$('#sup-cancel')?.addEventListener('click', ()=> $('#supplier-overlay').classList.remove('show'));

$('#supplier-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const name = $('#sup-name').value.trim();
  if(!name){ showToast('أدخل اسم المورد'); return; }
  const phone = $('#sup-phone').value.trim();
  const category = $('#sup-category').value.trim();
  const notes = $('#sup-notes').value.trim();
  await withBtnLoading(e.target.querySelector('[type="submit"]'), async ()=>{
    if(editingSupplierId){
      const s = suppliers.find(x=>x.id===editingSupplierId);
      if(s){
        Object.assign(s, {name, phone, category, notes});
        purchases.forEach(p=>{ if(p.supplierId===s.id) p.supplierName = name; });
        await logAudit('edit','المشتريات', `تعديل بيانات المورد: ${name}`);
        await savePurchases();
      }
    } else {
      suppliers.push({id: uid(), name, phone, category, notes, createdAt: Date.now(), createdBy: currentUser});
      await logAudit('add','المشتريات', `إضافة مورد جديد: ${name}`);
    }
    await saveSuppliers();
    $('#supplier-overlay').classList.remove('show');
    renderPurchases();
    showToast('تم حفظ بيانات المورد');
  });
});

let _purchaseFormBusy = false;
$('#purchase-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  if(_purchaseFormBusy) return; // منع الضغط المزدوج أثناء حفظ سابق لم ينتهِ بعد
  _purchaseFormBusy = true;
  const _puSubmitBtn = e.target.querySelector('[type="submit"]');
  if(_puSubmitBtn) _puSubmitBtn.classList.add('is-loading');
  try{
  const supplierId = $('#pu-supplier').value;
  const supplier = suppliers.find(s=>s.id===supplierId);
  if(!supplier){ showToast('اختر مورداً صحيحاً'); return; }
  const items = [];
  $all('#pu-items .pu-item-row').forEach(row=>{
    const name = row.querySelector('.pu-item-name').value.trim();
    const qty = num(row.querySelector('.pu-item-qty').value);
    const price = num(row.querySelector('.pu-item-price').value);
    if(name) items.push({name, qty, price});
  });
  if(!items.length){ showToast('أضف صنفاً واحداً على الأقل'); return; }
  const badItem = items.find(it=> num(it.qty)<0 || num(it.price)<0);
  if(badItem){
    showToast(`الكمية والسعر يجب ألا يكونا سالبين — تحقق من صنف "${badItem.name}"`);
    return;
  }
  const subtotal = items.reduce((s,it)=>s+it.qty*it.price,0);
  const taxAmount = purchaseTax(subtotal);
  const total = subtotal + taxAmount;
  const date = $('#pu-date').value || todayISO();
  const method = $('#pu-method').value;
  const status = $('#pu-status').value;
  const invoiceNo = $('#pu-invoiceno').value.trim();
  const notes = $('#pu-notes').value.trim();

  const existing = editingPurchaseId ? purchases.find(x=>x.id===editingPurchaseId) : null;
  if(existing && existing.vaultTxId){
    vaultTx = vaultTx.filter(t=>t.id!==existing.vaultTxId);
  }

  let vaultTxId = '';
  if(status==='paid'){
    const chan = settings.channels.find(c=>c.name===method);
    const dest = chan ? (chan.dest==='other' ? 'vault' : chan.dest) : 'vault';
    vaultTxId = 'purchase_'+(existing?.id || uid());
    vaultTx.push({
      id: vaultTxId,
      seq: allocVaultSeq(dest),
      type: 'out',
      date,
      amount: total,
      destination: dest,
      clientId: '',
      clientName: '',
      method,
      category: 'مشتريات',
      manual: `فاتورة شراء من ${supplier.name}${invoiceNo?` — رقم ${invoiceNo}`:''}`,
      recipientName: supplier.name,
      referenceNo: invoiceNo,
      networkInvoice: (dest==='network'||dest==='network2') ? invoiceNo : '',
      notes: notes || `مشتريات: ${items.map(i=>i.name).join('، ')} (شامل ضريبة ${fmt(taxAmount)} ﷼)`,
      createdAt: Date.now()
    });
  }

  const purchaseId = existing ? existing.id : uid();
  // نخزّن المرفق الفعلي (dataUrl) في مفتاح kv منفصل خاص بكل فاتورة (purchase-attachment:ID)، ونُبقي في
  // سجل الفاتورة نفسه بيانات وصفية بسيطة فقط (الاسم والنوع) — بدل تضمين الصورة كاملة داخل مصفوفة
  // المشتريات الضخمة التي تتحمّل كاملة مع أي فتح لشيت المشتريات (كانت السبب الأكبر في استهلاك البيانات).
  let attachmentMeta = null;
  if(currentPurchaseAttachment && currentPurchaseAttachment.dataUrl){
    // مرفق جديد أو مُستبدَل فعلياً بهذا الحفظ
    await window.storage.set('purchase-attachment:'+purchaseId, JSON.stringify({
      name: currentPurchaseAttachment.name, type: currentPurchaseAttachment.type, dataUrl: currentPurchaseAttachment.dataUrl
    }), false);
    attachmentMeta = {name: currentPurchaseAttachment.name, type: currentPurchaseAttachment.type};
  } else if(currentPurchaseAttachment){
    // بيانات وصفية فقط بدون dataUrl — يعني مرفق فاتورة موجودة لم يُستبدَل، أبقِه كما هو بدون إعادة حفظ
    attachmentMeta = {name: currentPurchaseAttachment.name, type: currentPurchaseAttachment.type};
  } else if(existing && existing.attachment){
    // كان للفاتورة مرفق وأُزيل الآن
    await window.storage.delete('purchase-attachment:'+purchaseId, false);
  }

  if(existing){
    Object.assign(existing, {supplierId, supplierName: supplier.name, invoiceNo, date, items, subtotal, taxAmount, total, method, status, notes, vaultTxId, attachment: attachmentMeta});
    // تعديل فاتورة موجودة: القيد المزدوج المُرحَّل سابقاً أصبح قديماً (المبالغ/التاريخ تغيّرت) —
    // نحذفه ونعيد ترحيله من القيم الجديدة بدل تركه يعرض المبالغ القديمة في دفتر الأستاذ.
    if(typeof saveJournalDE==='function' && journalDE.some(e=>e.sourcePurchaseId===existing.id)){
      journalDE = journalDE.filter(e=>e.sourcePurchaseId!==existing.id);
      existing.linkedDEId = null;
    }
    autoPostPurchase(existing);
    await saveJournalDE();
    await logAudit('edit','المشتريات', `تعديل فاتورة شراء: ${invoiceNo||'—'} — ${supplier.name} (${fmt(total)} ﷼ شامل الضريبة)`);
  } else {
    const newPurchase = {id: purchaseId, supplierId, supplierName: supplier.name, invoiceNo, date, items, subtotal, taxAmount, total, method, status, notes, vaultTxId, attachment: attachmentMeta, createdAt: Date.now(), createdBy: currentUser};
    purchases.push(newPurchase);
    autoPostPurchase(newPurchase);
    await saveJournalDE();
    await logAudit('add','المشتريات', `فاتورة شراء جديدة: ${invoiceNo||'—'} — ${supplier.name} (${fmt(total)} ﷼ شامل الضريبة)`);
    // ملحوظة: أُلغي تنبيه الإيميل هنا عمداً — تنبيهات الإيميل الفورية مقتصرة الآن على:
    // إضافة عميل جديد / حذف عميل / تعديل قيمة مدفوعات عميل فقط (راجع clients-print-modals.js).
  }

  await savePurchases();
  await saveVaultTx();
  if(typeof renderVault==='function') renderVault();
  $('#purchase-overlay').classList.remove('show');
  renderPurchases();
  showToast('تم حفظ فاتورة الشراء');
  }finally{
    _purchaseFormBusy = false;
    if(_puSubmitBtn) _puSubmitBtn.classList.remove('is-loading');
  }
});

$('#btn-export-purchases')?.addEventListener('click', ()=>{
  const rows = purchases.filter(purchaseMatchesFilters).map(p=>({
    'التاريخ': p.date, 'المورد': p.supplierName, 'رقم الفاتورة': p.invoiceNo,
    'الأصناف': (p.items||[]).map(i=>`${i.name} (${i.qty} × ${i.price})`).join(' | '),
    'الإجمالي قبل الضريبة': num(p.subtotal ?? netFromGross(p.total)),
    'الضريبة (15%)': num(p.taxAmount ?? vatFromGross(p.total)),
    'الإجمالي شامل الضريبة': num(p.total), 'طريقة الدفع': p.method, 'الحالة': p.status==='paid'?'مدفوعة':'غير مدفوعة',
    'ملاحظات': p.notes||''
  }));
  downloadXlsx(`مشتريات_${stampNow()}.xlsx`, 'المشتريات', rows);
});

$('#supplier-search')?.addEventListener('input', renderSuppliersTable);
['#purchase-search','#purchase-supplier-filter','#purchase-status-filter','#purchase-date-from','#purchase-date-to'].forEach(sel=>{
  $(sel)?.addEventListener('input', renderPurchasesTable);
  $(sel)?.addEventListener('change', renderPurchasesTable);
});

document.addEventListener('click', async e=>{
  const viewItems = e.target.closest('[data-view-items]');
  if(viewItems){ openPurchaseItemsPopup(viewItems.dataset.viewItems); return; }
  const viewAtt = e.target.closest('[data-view-attachment]');
  if(viewAtt){
    const p = purchases.find(x=>x.id===viewAtt.dataset.viewAttachment);
    if(p && p.attachment){
      // المرفق الفعلي (dataUrl) مخزَّن في مفتاح منفصل خاص بهذه الفاتورة (وليس ضمن مصفوفة المشتريات)
      // حتى لا تتحمّل كل صور كل الفواتير مع كل فتح لشيت المشتريات — نجيبه الآن فقط عند طلب العرض فعلياً
      const r = await window.storage.get('purchase-attachment:'+p.id, false);
      if(r && r.value) openAttachmentViewer(JSON.parse(r.value));
      else showToast('تعذّر تحميل المرفق');
    }
    return;
  }
  const editSup = e.target.closest('[data-edit-supplier]');
  if(editSup){
    const s = suppliers.find(x=>x.id===editSup.dataset.editSupplier);
    if(s){
      editingSupplierId = s.id;
      $('#supplier-modal-title').textContent = 'تعديل مورد';
      $('#sup-name').value = s.name||'';
      $('#sup-phone').value = s.phone||'';
      $('#sup-category').value = s.category||'';
      $('#sup-notes').value = s.notes||'';
      $('#supplier-overlay').classList.add('show');
    }
    return;
  }
  const delSup = e.target.closest('[data-del-supplier]');
  if(delSup){
    const id = delSup.dataset.delSupplier;
    const s = suppliers.find(x=>x.id===id);
    if(!s) return;
    const usedCount = purchases.filter(p=>p.supplierId===id).length;
    const msg = usedCount
      ? `هذا المورد لديه ${usedCount} فاتورة شراء مسجّلة. حذفه لن يحذف فواتيره لكنها ستبقى بلا مورد مرتبط. متابعة؟`
      : `حذف المورد "${s.name}"؟`;
    if(!await customConfirm(msg)) return;
    suppliers = suppliers.filter(x=>x.id!==id);
    await saveSuppliers();
    await logAudit('delete','المشتريات', `حذف المورد: ${s.name}`);
    renderPurchases();
    showToast('تم حذف المورد');
    return;
  }
  const editP = e.target.closest('[data-edit-purchase]');
  if(editP){ openPurchaseModal(editP.dataset.editPurchase); return; }
  const delP = e.target.closest('[data-del-purchase]');
  if(delP){
    const id = delP.dataset.delPurchase;
    const p = purchases.find(x=>x.id===id);
    if(!p) return;
    if(!await customConfirm(`حذف فاتورة الشراء رقم "${p.invoiceNo||'—'}" من ${p.supplierName}؟${p.vaultTxId ? ' سيتم أيضاً حذف حركة الخزنة المرتبطة بها.' : ''}`)) return;
    if(p.vaultTxId){
      vaultTx = vaultTx.filter(t=>t.id!==p.vaultTxId);
      await saveVaultTx();
      if(typeof renderVault==='function') renderVault();
    }
    purchases = purchases.filter(x=>x.id!==id);
    await savePurchases();
    // حذف القيد المزدوج المُرحَّل لهذه الفاتورة تلقائياً (لو وُجد) — بدل تركه يتيماً يظهر
    // في دليل الحسابات كأثر وحيد لوثيقة محذوفة. راجع cleanupOrphanedJournalDE في module-accounting.js.
    if(typeof saveJournalDE==='function' && journalDE.some(e=>e.sourcePurchaseId===id)){
      journalDE = journalDE.filter(e=>e.sourcePurchaseId!==id);
      await saveJournalDE();
    }
    if(p.attachment){ try{ await window.storage.delete('purchase-attachment:'+id, false); }catch(err){ console.error('[Purchases] Failed to delete attachment on purchase delete:', err); } }
    await logAudit('delete','المشتريات', `حذف فاتورة شراء: ${p.invoiceNo||'—'} — ${p.supplierName}`);
    renderPurchases();
    showToast('تم حذف الفاتورة');
  }
});

