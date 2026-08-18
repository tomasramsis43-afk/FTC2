/* ============ نظام ترقيم صفحات عام (يُستخدم في كل الشيتات الطويلة) ============
   لكل جدول: state = {page:1, sig:''} خاص به، وبادئة (prefix) فريدة لعناصر الـ HTML:
   #{prefix}-pagination, #{prefix}-page-size, #{prefix}-page-info, #{prefix}-page-current,
   #{prefix}-page-first/prev/next/last */
function genericPageSize(prefix){
  const v = $(`#${prefix}-page-size`)?.value || '50';
  return v==='all' ? Infinity : Number(v);
}
function applyGenericPagination(prefix, rows, state, filterSigParts){
  const sig = JSON.stringify(filterSigParts);
  if(sig !== state.sig){ state.page = 1; state.sig = sig; }
  const pageSize = genericPageSize(prefix);
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(state.page > totalPages) state.page = totalPages;
  if(state.page < 1) state.page = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((state.page-1)*pageSize, state.page*pageSize) : rows;
  const pag = $(`#${prefix}-pagination`);
  if(pag){
    pag.style.display = rows.length ? '' : 'none';
    const startN = rows.length ? (state.page-1)*(Number.isFinite(pageSize)?pageSize:rows.length)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(rows.length, state.page*pageSize) : rows.length;
    const infoEl = $(`#${prefix}-page-info`); if(infoEl) infoEl.textContent = rows.length ? `${tr('showingOfTotal')} ${startN} - ${endN} ${tr('ofWord')} ${rows.length}` : '';
    const curEl = $(`#${prefix}-page-current`); if(curEl) curEl.textContent = `${tr('pageWord')} ${state.page} / ${totalPages}`;
    const fb = $(`#${prefix}-page-first`); if(fb) fb.disabled = state.page<=1;
    const pb = $(`#${prefix}-page-prev`); if(pb) pb.disabled = state.page<=1;
    const nb = $(`#${prefix}-page-next`); if(nb) nb.disabled = state.page>=totalPages;
    const lb = $(`#${prefix}-page-last`); if(lb) lb.disabled = state.page>=totalPages;
  }
  return pageRows;
}
function bindGenericPagination(prefix, state, renderFn){
  $(`#${prefix}-page-size`)?.addEventListener('change', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-first`)?.addEventListener('click', ()=>{ state.page=1; renderFn(); });
  $(`#${prefix}-page-prev`)?.addEventListener('click', ()=>{ state.page=Math.max(1,state.page-1); renderFn(); });
  $(`#${prefix}-page-next`)?.addEventListener('click', ()=>{ state.page=state.page+1; renderFn(); });
  $(`#${prefix}-page-last`)?.addEventListener('click', ()=>{ state.page=Infinity; renderFn(); });
}
function currentTablePageSize(){
  const v = $('#table-page-size')?.value || '100';
  return v==='all' ? Infinity : Number(v);
}
let renderTableSeq = 0; // يمنع تعارض ردود طلبات متتالية سريعة (تغيير صفحة/فلتر قبل وصول رد الطلب السابق)
// الأعمدة المدعومة للفرز من السيرفر (مطابقة لِما يدعمه GET /api/clients بالضبط) — أي فرز
// بعمود آخر (مثل الإجمالي/المدفوع/المتبقي، التي تحتاج حسابات معقّدة) يُبقي الوضع على المسار المحلي.
const SERVER_SORTABLE_CLIENT_COLS = { name:1, date:1, clientId:1, courseType:1, nationality:1 };
function clientsQueryIsSimple(){
  // عزل البيانات: المسار السريع يستعلم مباشرة من السيرفر بكل العملاء بدون فلترة الملكية، فيجب
  // تعطيله لأي مستخدم مقيَّد لإجباره على المسار المحلي الذي يطبّق isOwnRecord() في filteredClients().
  // (هذا فقط يختار أي مسار عرض يُستخدم — لا يُعيد تعيين مصفوفة clients نفسها بأي شكل).
  if(!canSeeAllData()) return false;
  if(showSuspendedOnly || showUnpurchasedBagsOnly) return false;
  if($('#filter-company')?.value) return false;
  if($('#filter-invoice')?.value) return false;
  if($('#filter-coursenum')?.value) return false;
  if($('#filter-refnum')?.value) return false;
  if($('#filter-bag-source')?.value) return false;
  if(($('#cl-paid-min')?.value||'') !== '' || ($('#cl-paid-max')?.value||'') !== '') return false;
  if($('#filter-status')?.value) return false; // مدين/مسدد يحتاج حساب المتبقي الكامل (خصومات، دفعات...)
  if(clientsSortState.key && !SERVER_SORTABLE_CLIENT_COLS[clientsSortState.key]) return false;
  return true;
}
async function renderTable(){
  const mySeq = ++renderTableSeq;
  const filterSig = JSON.stringify([
    $('#search')?.value, $('#filter-course')?.value, $('#filter-nat')?.value, $('#filter-status')?.value,
    $('#filter-company')?.value, $('#filter-invoice')?.value, $('#filter-coursenum')?.value, $('#filter-refnum')?.value, $('#cl-date-from')?.value, $('#cl-date-to')?.value,
    $('#cl-paid-min')?.value, $('#cl-paid-max')?.value, showSuspendedOnly, showUnpurchasedBagsOnly,
    $('#filter-bag-source')?.value
  ]);
  if(filterSig !== tableLastFilterSig){ tableCurrentPage = 1; tableLastFilterSig = filterSig; }
  const pageSize = currentTablePageSize();

  if(clientsQueryIsSimple() && Number.isFinite(pageSize)){
    // المسار السريع: نطلب من السيرفر فقط سجلات الصفحة الحالية (ترقيم/بحث/فلترة حقيقية من قاعدة
    // البيانات)، بدل تحميل ومعالجة وتقطيع آلاف السجلات المحمّلة أصلاً بالمتصفح في كل مرة — أخف
    // وأسرع بكثير على جهاز المستخدم، خصوصاً على الجوال. أي فلتر غير مدعوم بالسيرفر (البند أعلاه)
    // يُبقي العمل بالطريقة المحلية القديمة تماماً كما كانت قبل هذا التحديث دون أي فرق في النتيجة.
    try{
      const params = new URLSearchParams();
      params.set('page', tableCurrentPage);
      params.set('pageSize', pageSize);
      const q = ($('#search')?.value||'').trim(); if(q) params.set('search', q);
      const fc = $('#filter-course')?.value; if(fc && fc!=='__unknown__') params.set('courseType', fc);
      const fn = $('#filter-nat')?.value; if(fn) params.set('nationality', fn);
      const dfrom = $('#cl-date-from')?.value; if(dfrom) params.set('dateFrom', dfrom);
      const dto = $('#cl-date-to')?.value; if(dto) params.set('dateTo', dto);
      if(clientsSortState.key){ params.set('sort', clientsSortState.key); params.set('order', clientsSortState.dir===-1?'desc':'asc'); }
      const res = await serverFetch('/api/clients?'+params.toString());
      if(mySeq !== renderTableSeq) return; // وصل رد لطلب قديم تجاوزه المستخدم فعلاً (غيّر الصفحة/الفلتر) — نتجاهله
      if(!res.ok) throw new Error('server pagination failed');
      const data = await res.json();
      // حماية عامة: لو السيرفر رجّع 0 نتيجة لأي تركيبة فلاتر (بحث/نوع دورة/جنسية/تاريخ)، بينما
      // نفس هذه الفلاتر مطبّقة محلياً على البيانات المحمّلة أصلاً بالمتصفح (clients) تُعطي نتائج
      // فعلية — هذا يعني عدم تطابق بين clients_rows على السيرفر والبيانات الحقيقية (مثال: نوع
      // دورة تمت إعادة تسميته، أو خلل مؤقت في مزامنة clients_rows)، فنتجاهل رد السيرفر المضلِّل
      // ونكمل تلقائياً للمسار المحلي الكامل أدناه (فلترة دقيقة 100% من نفس البيانات) بدل عرض
      // جدول فارغ خطأً للمستخدم رغم وجود بيانات فعلية مطابقة.
      const localMatches = clients.filter(c=>{
        if(q){
          const hay = [c.name, c.clientId, c.referNum, c.invoice].map(v=>String(v||'').toLowerCase());
          if(!hay.some(v=>v.includes(q.toLowerCase()))) return false;
        }
        if(fc==='__unknown__'){ if(c.courseType && c.courseType.trim()) return false; }
        else if(fc && c.courseType!==fc) return false;
        if(fn && c.nationality!==fn) return false;
        if(dfrom && (!c.date || c.date<dfrom)) return false;
        if(dto && (!c.date || c.date>dto)) return false;
        return true;
      }).length;
      if(data.total === 0 && localMatches > 0){
        throw new Error('server returned suspicious empty result');
      }
      renderClientsTableRows(data.rows, data.total, data.total, pageSize);
      return;
    }catch(e){
      // فشل الاتصال بالمسار السريع (مثلاً الخادم نائم لحظياً على الاستضافة المجانية) — نكمل
      // فوراً بالطريقة المحلية القديمة أدناه كخط رجعة آمن، بدون أي رسالة خطأ مزعجة للمستخدم
    }
  }

  // المسار الكامل المحلي (فلاتر/فرز غير مدعوم بالسيرفر، أو تعذّر الاتصال بالمسار السريع أعلاه) —
  // نفس المنطق والنتيجة تماماً كما كانا قبل إضافة الترقيم من السيرفر.
  let rows = filteredClients();
  if(mySeq !== renderTableSeq) return;
  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(rows.length/pageSize)) : 1;
  if(tableCurrentPage > totalPages) tableCurrentPage = totalPages;
  if(tableCurrentPage < 1) tableCurrentPage = 1;
  const pageRows = Number.isFinite(pageSize) ? rows.slice((tableCurrentPage-1)*pageSize, tableCurrentPage*pageSize) : rows;
  renderClientsTableRows(pageRows, rows.length, clients.length, pageSize);
}
// يرسم صفوف الجدول وشريط الترقيم فعلياً — يُستخدَم من كلا مساري renderTable (السيرفر والمحلي)
// حتى لا يتكرر كود بناء HTML للصف في مكانين قد يختلفان عن بعض بمرور الوقت.
function renderClientsTableRows(pageRows, filteredTotal, grandTotal, pageSize){
  const cfc = $('#clients-filtered-count'); if(cfc) cfc.textContent = filteredTotal;
  const ctc = $('#clients-total-count'); if(ctc) ctc.textContent = (canSeeAllData()||currentUserRole==='reception') ? clients.length : clients.filter(c=>isOwnRecord(c)).length;
  // إجمالي المبلغ المدفوع لكل العملاء المطابقين للفلتر الحالي (وليس فقط صفحة الجدول المعروضة حالياً) —
  // يُحسب دائماً محلياً عبر filteredClients() (بدلاً من مسار السيرفر السريع الذي يُرجع صفحة واحدة فقط
  // من الصفوف) لضمان دقة الإجمالي بغض النظر عن أي مسار عُرض به الجدول.
  const cfp = $('#clients-filtered-paid');
  if(cfp) cfp.textContent = fmt(filteredClients().reduce((s,c)=>s+paidTotal(c),0));
  // إجمالي المتبقي على كل العملاء المطابقين للفلتر الحالي (نفس منطق استبعاد الموقوفين/الملغيين
  // المستخدم في حساب "متبقي" بلوحة التحكم)، ليظهر بجانب "إجمالي المدفوع" أعلى جدول العملاء.
  const cfr = $('#clients-filtered-remaining');
  if(cfr) cfr.textContent = fmt(filteredClients().filter(c=>!c.suspended && !c.cancelled).reduce((s,c)=>s+remaining(c),0));

  $('#empty-state').style.display = filteredTotal ? 'none' : 'block';

  const totalPages = Number.isFinite(pageSize) ? Math.max(1, Math.ceil(filteredTotal/pageSize)) : 1;
  const pag = $('#table-pagination');
  if(pag){
    pag.style.display = filteredTotal ? '' : 'none';
    const startN = filteredTotal ? (tableCurrentPage-1)*(Number.isFinite(pageSize)?pageSize:filteredTotal)+1 : 0;
    const endN = Number.isFinite(pageSize) ? Math.min(filteredTotal, tableCurrentPage*pageSize) : filteredTotal;
    $('#table-page-info').textContent = filteredTotal ? `عرض ${startN} - ${endN} من ${filteredTotal}` : '';
    $('#table-page-current').textContent = `صفحة ${tableCurrentPage} / ${totalPages}`;
    $('#table-page-first').disabled = tableCurrentPage<=1;
    $('#table-page-prev').disabled = tableCurrentPage<=1;
    $('#table-page-next').disabled = tableCurrentPage>=totalPages;
    $('#table-page-last').disabled = tableCurrentPage>=totalPages;
  }

  currentPageClientIds = pageRows.map(c=>c.id);
  $('#table-body').innerHTML = pageRows.map(c=>{
    const rem = remaining(c);
    const rowStatusClass = (c.cancelled || c.suspended) ? '' : (rem>0 ? 'owe' : 'paid');
    const recMeta = (typeof clientRecordMeta==='object' && clientRecordMeta) ? clientRecordMeta[c.id] : null;
    const isPendingApproval = !!(recMeta && recMeta.status==='pending');
    const isRejectedApproval = !!(recMeta && recMeta.status==='rejected');
    const nameBadges = `${escapeHtml(c.name)}${c.cancelled ? ' <span class="stamp owe">ملغى</span>' : ''}${c.absent ? ' <span class="stamp owe">غياب</span>' : ''}${c.suspended ? ' <span class="stamp owe">موقوف</span>' : ''}${isPendingApproval ? ' <span class="stamp owe" title="سجّله الاستقبال — بانتظار اعتماد الأدمن، لا يدخل الحسابات/التقارير حتى الاعتماد">⏳ قيد الاعتماد</span>' : ''}${isRejectedApproval ? ' <span class="stamp owe" title="رفضه الأدمن — سيُحذف نهائياً تلقائياً خلال 15 يوماً من الرفض، سجّل عميلاً جديداً لو أردت إعادة المحاولة">⛔ مرفوض من الأدمن</span>' : ''}`;
    return `<tr class="${rowStatusClass}"${(c.cancelled || c.suspended) ? ' style="opacity:.55;"' : ''}>
      <td class="sticky-col sticky-col-1" data-label=""><input type="checkbox" class="row-select-client" data-id="${c.id}" ${selectedClientIds.has(c.id)?'checked':''}></td>
      <td class="sticky-col sticky-col-2 card-full" data-label="الاسم">${nameBadges}</td>
      <td data-label="رقم الهاتف">${phoneCellHtml(c.phone)}</td>
      <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono" data-label="الرقم المرجعي">${escapeHtml(c.referNum||'—')}</td>
      <td data-label="الجنسية">${escapeHtml(c.nationality||'')}</td>
      <td data-label="الدورة">${escapeHtml(c.courseType||'')}</td>
      <td class="mono" data-label="رقم الدورة">${escapeHtml(c.courseNumber||'—')}</td>
      <td class="mono" data-label="رقم الفاتورة">${escapeHtml(c.invoice||'—')}</td>
      <td class="mono" data-label="تاريخ التسجيل">${formatDateDisplay(c.date)||'—'}</td>
      <td class="mono" data-label="الإجمالي">${fmt(total(c))}</td>
      <td class="mono" data-label="المدفوع">${fmt(paidTotal(c))}</td>
      <td class="mono" data-label="المتبقي"><span class="stamp ${rem>0?'owe':'paid'}">${fmt(rem)}</span></td>
      <td data-label="الحقيبة"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}${bagCancelBtnHtml(c)}</td>
      <td data-label="طريقة الدفع"><span class="stamp channel">${escapeHtml(paymentChannelsLabel(c))}</span></td>
      <td class="card-full" data-label="" style="white-space:nowrap;">
        <div class="row-menu">
          <button type="button" class="btn btn-ghost btn-sm row-menu-toggle" title="إجراءات" aria-haspopup="true" aria-expanded="false">⋮</button>
          <div class="row-menu-panel" role="menu">
            ${(isPendingApproval && currentUserRole==='admin') ? `<button class="btn btn-gold btn-sm" data-approve="${c.id}" title="اعتماد هذا العميل ليدخل الحسابات والتقارير كباقي العملاء">✅ اعتماد</button><button class="btn btn-danger btn-sm" data-reject="${c.id}" title="رفض هذا التسجيل المعلّق — يبقى ظاهراً للاستقبال 15 يوماً ثم يُحذف نهائياً تلقائياً">✖ رفض</button>` : ''}
            <button class="btn btn-gold btn-sm" data-invoice="${c.id}">${tr('invoiceBtn')}</button>
            ${c.taxInvoiceNo ? `<button class="btn btn-ghost btn-sm" data-emailinvoice="${c.id}" title="إرسال الفاتورة بالإيميل للعميل">✉️ إرسال بالإيميل</button>` : ''}
            ${(c.taxInvoiceNo && canDeleteClientRecord(c)) ? `<button class="btn btn-danger btn-sm" data-delinvoice="${c.id}" title="حذف الفاتورة الضريبية الصادرة لهذا العميل (حذف منطقي مع الاحتفاظ بالرقم التسلسلي)">حذف الفاتورة</button>` : ''}
            ${canReceptionEditClient(c) ? `<button class="btn btn-ghost btn-sm" data-edit="${c.id}">${tr('edit')}</button>` : `<span class="btn btn-ghost btn-sm" style="opacity:.5;cursor:not-allowed" title="انتهت مهلة التعديل (5 ساعات من التسجيل) — للأدمن فقط الآن">${tr('edit')} 🔒</span>`}
            ${c.suspended
              ? `<button class="btn btn-ghost btn-sm" data-unsuspend="${c.id}" title="إعادة العميل ليظهر في شيت الدورات ومخزون الحقائب">إلغاء الإيقاف</button>`
              : `<button class="btn btn-ghost btn-sm" data-suspend="${c.id}" title="إيقاف العميل مؤقتاً — يبقى في شيت العملاء لكن يختفي من شيت الدورات ومخزون الحقائب">موقوف</button>`}
            ${canDeleteClientRecord(c) ? `<button class="btn btn-danger btn-sm" data-del="${c.id}">${tr('delete')}</button>` : ''}
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
  // نحذف من التحديد أي عميل لم يعد موجوداً أصلاً (حُذف من مكان آخر)، حتى لا يبقى تحديد "شبح"
  const allIds = new Set(clients.map(c=>c.id));
  [...selectedClientIds].forEach(id=>{ if(!allIds.has(id)) selectedClientIds.delete(id); });
  renderBulkSelectionBar({length: filteredTotal});
}

let selectedClientIds = new Set();
let currentPageClientIds = [];
function renderBulkSelectionBar(filteredRows){
  const bar = $('#bulk-actions-bar');
  if(!bar) return;
  const count = selectedClientIds.size;
  bar.style.display = count>0 ? '' : 'none';
  $('#bulk-selected-count').textContent = count;
  $('#bulk-filtered-total').textContent = filteredRows.length;
  const selectAllBox = $('#select-all-clients');
  if(selectAllBox){
    const pageIds = currentPageClientIds;
    const selectedOnPage = pageIds.filter(id=>selectedClientIds.has(id)).length;
    selectAllBox.checked = pageIds.length>0 && selectedOnPage===pageIds.length;
    selectAllBox.indeterminate = selectedOnPage>0 && selectedOnPage<pageIds.length;
  }
}
$('#table-body').addEventListener('change', e=>{
  if(e.target.classList.contains('row-select-client')){
    const id = e.target.dataset.id;
    if(e.target.checked) selectedClientIds.add(id); else selectedClientIds.delete(id);
    renderBulkSelectionBar(filteredClients());
  }
});
$('#select-all-clients').addEventListener('change', e=>{
  if(e.target.checked) currentPageClientIds.forEach(id=>selectedClientIds.add(id));
  else currentPageClientIds.forEach(id=>selectedClientIds.delete(id));
  renderTable();
});
$('#btn-select-all-filtered').addEventListener('click', ()=>{
  filteredClients().forEach(c=>selectedClientIds.add(c.id));
  renderTable();
});
$('#btn-clear-selection').addEventListener('click', ()=>{
  selectedClientIds.clear();
  renderTable();
});
$('#btn-bulk-delete-selected').addEventListener('click', async ()=>{
  const allIds = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(!allIds.length){ showToast('لا يوجد عملاء محددين'); return; }
  const ids = allIds.filter(id=>canDeleteClientRecord(clients.find(c=>c.id===id)));
  const blockedCount = allIds.length - ids.length;
  if(!ids.length){ showToast(blockedCount ? `🔒 كل السجلات المحددة (${blockedCount}) خارج مهلة الحذف المسموح بها أو الحذف معطَّل لصلاحيتك` : 'لا يوجد عملاء محددين'); return; }
  if(blockedCount) showToast(`⚠️ تم استبعاد ${blockedCount} سجل خارج مهلة الحذف المسموح بها`);
  const namesPreview = clients.filter(c=>ids.includes(c.id)).slice(0,5).map(c=>c.name).join('، ');
  const extra = ids.length>5 ? ` وآخرين (${ids.length-5})` : '';
  if(!await customConfirm(`تأكيد حذف ${ids.length} عميل دفعة واحدة؟ (${namesPreview}${extra})\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف مجموعة عملاء دفعة واحدة (${ids.length} عميل)`);
  const removedNames = clients.filter(c=>ids.includes(c.id)).map(c=>c.name);
  clients = clients.filter(c=>!ids.includes(c.id));
  ids.forEach(id=>removeClientLedgerEntries(id));
  await saveClients(true); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${ids.length} عميل دفعة واحدة: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}`);
  selectedClientIds.clear();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${ids.length} عميل بنجاح`);
});
/* escapeHtml معرّفة الآن في core-utils.js (الملف الأول المحمّل) — كانت هنا ويُستدعى منها قبل تحميل هذا الملف */

/* تطبيع رقم جوال العميل ليتوافق مع صيغة واتساب الدولية (يفترض أرقام السعودية عند غياب رمز الدولة) */
function normalizePhoneForWhatsapp(phone){
  let p = String(phone||'').replace(/[^0-9]/g,'');
  if(!p) return '';
  if(p.startsWith('00')) p = p.slice(2);
  if(p.startsWith('0')) p = '966' + p.slice(1);          // 05XXXXXXXX -> 9665XXXXXXXX
  else if(p.length===9 && p.startsWith('5')) p = '966' + p; // 5XXXXXXXX (بدون صفر) -> 9665XXXXXXXX
  if(!/^\d{8,15}$/.test(p)) return '';
  return p;
}
/* رابط "wa.me" لمراسلة العميل مباشرة عبر واتساب، أو نص فارغ إن كان الرقم غير صالح للتطبيع */
function whatsappLink(phone){
  const p = normalizePhoneForWhatsapp(phone);
  return p ? `https://wa.me/${p}` : '';
}
const WA_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="flex:none;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2zm0 18.06h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.34c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.55-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.13-.17.24-.64.8-.78.97-.14.17-.29.19-.53.06-.25-.12-1.04-.38-1.99-1.22-.73-.66-1.23-1.47-1.37-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.17.04-.31-.02-.43-.06-.12-.56-1.35-.77-1.85-.2-.48-.4-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.84-.86 2.05s.88 2.38 1 2.55c.12.17 1.73 2.64 4.2 3.7.59.25 1.05.4 1.41.51.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.08.15-1.18-.06-.1-.23-.16-.48-.28z"/></svg>';
/* يبني HTML لخلية رقم الهاتف كعمود منفصل: نص الرقم عادي، وأيقونة واتساب صغيرة قابلة للنقر
   بجانبه فقط إن أمكن تطبيع الرقم (النقر على الأيقونة نفسها هو ما يفتح واتساب، وليس الرقم) */
function phoneCellHtml(phone){
  if(!phone) return '—';
  const numText = `<span class="mono">${escapeHtml(phone)}</span>`;
  const link = whatsappLink(phone);
  if(!link) return numText;
  return `<a href="${link}" target="_blank" rel="noopener" title="مراسلة العميل عبر واتساب" style="color:#25D366; display:inline-flex; align-items:center;">${WA_ICON}</a> ${numText}`;
}

// بديل عن window.open للطباعة: بعض تطبيقات Electron لا تدعم معاينة الطباعة (Print Preview)
// للنوافذ المفتوحة عبر window.open، فتظهر رسالة "This app doesn't support print preview".
// الحل: إنشاء iframe داخل نفس النافذة الرئيسية وكتابة محتوى الطباعة بداخله،
// فتعمل الطباعة والمعاينة بشكل طبيعي لأن الـ iframe جزء من نفس النافذة المُهيأة للطباعة.
// ملاحظة مهمة: يجب أن يكون الـ iframe *ظاهراً* بحجم حقيقي وليس صفراً/مخفياً،
// لأن محتوى الطباعة يتضمن زر "طباعة / حفظ PDF" ينقر عليه المستخدم يدوياً —
// وإن كان الإطار مخفياً (visibility:hidden) أو بحجم صفر فلن يظهر شيء على الإطلاق
// عند الضغط على زر الطباعة (وهذا كان سبب عدم عمل طباعة كشف الحضور والفاتورة).
