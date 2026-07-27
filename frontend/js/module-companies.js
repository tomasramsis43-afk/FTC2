
function transferAllocatedTotal(t){
  return (t.trainees||[]).reduce((s,tr)=>s+num(tr.courseValue)+num(tr.bagValue),0);
}
function updateComputedShare(){
  const amount = num($('#ct-amount')?.value);
  const count = num($('#ct-count')?.value);
  if($('#ct-share')) $('#ct-share').textContent = fmt(count>0 ? amount/count : 0);
}
$('#ct-amount')?.addEventListener('input', updateComputedShare);
$('#ct-count')?.addEventListener('input', updateComputedShare);

/* ---- تقسيم مبلغ الحوالة حسب فئات مختلفة (مثال: مقيمين/سعوديين بأسعار مختلفة) ---- */
let ctGroups = []; // {id, label, count, price} — حالة نموذج "إضافة حوالة جديدة" الحالي فقط (تُصفَّر بعد الحفظ)

function ctGroupIsOtherLabel(label){
  return !!label && label!=='مقيم' && label!=='سعودي';
}
function renderCtGroups(){
  const wrap = $('#ct-groups-list');
  if(!wrap) return;
  wrap.innerHTML = ctGroups.map(g=>{
    const isOther = ctGroupIsOtherLabel(g.label);
    return `
    <div class="formgrid" style="margin-bottom:6px;" data-ctgroup="${g.id}">
      <div class="field">
        <label>اسم الفئة</label>
        <select class="ctg-label-select">
          <option value="مقيم" ${g.label==='مقيم'?'selected':''}>مقيم</option>
          <option value="سعودي" ${g.label==='سعودي'?'selected':''}>سعودي</option>
          <option value="__other__" ${isOther?'selected':''}>أخرى (تحديد)</option>
        </select>
      </div>
      <div class="field ctg-label-other-wrap" style="${isOther?'':'display:none;'}">
        <label>حدد اسم الفئة</label>
        <input type="text" class="ctg-label-other" placeholder="مثال: فلبيني" value="${isOther?escapeHtml(g.label):''}">
      </div>
      <div class="field"><label>العدد</label><input type="number" min="1" step="1" class="ctg-count" value="${g.count||''}"></div>
      <div class="field"><label>سعر الفرد</label><input type="number" min="0" step="0.01" class="ctg-price" value="${g.price||''}"></div>
      <div class="field" style="display:flex; align-items:flex-end; gap:6px;">
        <span class="hint mono" style="white-space:nowrap;">= ${fmt(num(g.count)*num(g.price))} ﷼</span>
        <button type="button" class="btn btn-ghost btn-sm ctg-remove" data-ctgroupremove="${g.id}">حذف الفئة</button>
      </div>
    </div>`;
  }).join('');
  recomputeCtGroups();
}

function recomputeCtGroups(){
  // نقرأ القيم الحالية من الحقول (قد تكون تغيّرت بدون إعادة render كاملة أثناء الكتابة)
  $all('[data-ctgroup]').forEach(row=>{
    const id = row.dataset.ctgroup;
    const g = ctGroups.find(x=>x.id===id);
    if(!g) return;
    const sel = row.querySelector('.ctg-label-select');
    const otherInput = row.querySelector('.ctg-label-other');
    g.label = sel.value==='__other__' ? (otherInput ? otherInput.value.trim() : '') : sel.value;
    g.count = num(row.querySelector('.ctg-count').value);
    g.price = num(row.querySelector('.ctg-price').value);
    const sumSpan = row.querySelector('.hint.mono');
    if(sumSpan) sumSpan.textContent = `= ${fmt(g.count*g.price)} ﷼`;
  });
  const totalAmount = ctGroups.reduce((s,g)=>s+num(g.count)*num(g.price),0);
  const totalCount = ctGroups.reduce((s,g)=>s+num(g.count),0);
  if($('#ct-groups-total')) $('#ct-groups-total').textContent = fmt(totalAmount);
  if($('#ct-groups-count')) $('#ct-groups-count').textContent = totalCount;
  if(ctGroups.length){
    $('#ct-amount').value = totalAmount ? Math.round(totalAmount*100)/100 : '';
    $('#ct-count').value = totalCount || '';
    $('#ct-amount').readOnly = true;
    $('#ct-count').readOnly = true;
    $('#ct-amount').style.background = 'var(--bg-soft,#f0f0f0)';
    $('#ct-count').style.background = 'var(--bg-soft,#f0f0f0)';
  } else {
    $('#ct-amount').readOnly = false;
    $('#ct-count').readOnly = false;
    $('#ct-amount').style.background = '';
    $('#ct-count').style.background = '';
  }
  updateComputedShare();
}

$('#btn-add-ctgroup')?.addEventListener('click', ()=>{
  ctGroups.push({id:uid(), label:'مقيم', count:'', price:''});
  renderCtGroups();
});
document.addEventListener('click', e=>{
  if(e.target.dataset && e.target.dataset.ctgroupremove){
    ctGroups = ctGroups.filter(g=>g.id!==e.target.dataset.ctgroupremove);
    renderCtGroups();
  }
});
document.addEventListener('change', e=>{
  if(e.target.classList && e.target.classList.contains('ctg-label-select')){
    const row = e.target.closest('[data-ctgroup]');
    const id = row && row.dataset.ctgroup;
    const g = ctGroups.find(x=>x.id===id);
    if(g){
      g.label = e.target.value==='__other__' ? '' : e.target.value;
      renderCtGroups();
    }
  }
});
document.addEventListener('input', e=>{
  if(e.target.classList && (e.target.classList.contains('ctg-label-other')||e.target.classList.contains('ctg-count')||e.target.classList.contains('ctg-price'))){
    recomputeCtGroups();
  }
});
function resetCtGroups(){ ctGroups = []; renderCtGroups(); }
function ctGroupsSummaryText(groups){
  return (groups||[]).map(g=>`${g.label||'فئة'}: ${g.count}×${fmt(g.price)}=${fmt(num(g.count)*num(g.price))}`).join(' · ');
}

/* ---- مبالغ متفق عليها مختلفة حسب الفئة عند إضافة شركة جديدة (مثال: مقيم/سعودي بسعر مختلف) ---- */
let cmCats = []; // {id, label, amount} — حالة نموذج "إضافة شركة" الحالي فقط (تُصفَّر بعد الحفظ)

function renderCmCats(){
  const wrap = $('#cm-cats-list');
  if(!wrap) return;
  wrap.innerHTML = cmCats.map(c=>{
    const isOther = ctGroupIsOtherLabel(c.label);
    return `
    <div class="formgrid" style="margin-bottom:6px;" data-cmcat="${c.id}">
      <div class="field">
        <label>الفئة</label>
        <select class="cmc-label-select">
          <option value="مقيم" ${c.label==='مقيم'?'selected':''}>مقيم</option>
          <option value="سعودي" ${c.label==='سعودي'?'selected':''}>سعودي</option>
          <option value="__other__" ${isOther?'selected':''}>أخرى (تحديد)</option>
        </select>
      </div>
      <div class="field cmc-label-other-wrap" style="${isOther?'':'display:none;'}">
        <label>حدد اسم الفئة</label>
        <input type="text" class="cmc-label-other" placeholder="مثال: فلبيني" value="${isOther?escapeHtml(c.label):''}">
      </div>
      <div class="field"><label>المبلغ المتفق عليه لهذه الفئة</label><input type="number" min="0" step="0.01" class="cmc-amount" value="${c.amount||''}"></div>
      <div class="field" style="display:flex; align-items:flex-end;"><button type="button" class="btn btn-ghost btn-sm" data-cmcatremove="${c.id}">حذف الفئة</button></div>
    </div>`;
  }).join('');
}
function recomputeCmCats(){
  $all('[data-cmcat]').forEach(row=>{
    const id = row.dataset.cmcat;
    const c = cmCats.find(x=>x.id===id);
    if(!c) return;
    const sel = row.querySelector('.cmc-label-select');
    const otherInput = row.querySelector('.cmc-label-other');
    c.label = sel.value==='__other__' ? (otherInput ? otherInput.value.trim() : '') : sel.value;
    c.amount = num(row.querySelector('.cmc-amount').value);
  });
}
$('#btn-add-cmcat')?.addEventListener('click', ()=>{
  cmCats.push({id:uid(), label:'مقيم', amount:''});
  renderCmCats();
});
document.addEventListener('click', e=>{
  if(e.target.dataset && e.target.dataset.cmcatremove){
    cmCats = cmCats.filter(c=>c.id!==e.target.dataset.cmcatremove);
    renderCmCats();
  }
});
document.addEventListener('change', e=>{
  if(e.target.classList && e.target.classList.contains('cmc-label-select')){
    const row = e.target.closest('[data-cmcat]');
    const id = row && row.dataset.cmcat;
    const c = cmCats.find(x=>x.id===id);
    if(c){
      c.label = e.target.value==='__other__' ? '' : e.target.value;
      renderCmCats();
    }
  }
});
document.addEventListener('input', e=>{
  if(e.target.classList && (e.target.classList.contains('cmc-label-other')||e.target.classList.contains('cmc-amount'))){
    recomputeCmCats();
  }
});
function resetCmCats(){ cmCats = []; renderCmCats(); }
function companyCategoriesSummaryText(categories){
  return (categories||[]).map(c=>`${c.label||'فئة'}: ${fmt(num(c.amount))} ﷼`).join(' · ');
}

$('#btn-use-company-cats')?.addEventListener('click', ()=>{
  const companyId = $('#ct-company').value;
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('اختر شركة أولاً'); return; }
  if(!company.categories || !company.categories.length){ showToast('لا توجد فئات محفوظة لهذه الشركة — أضفها أولاً من قسم "الشركات المتفق معها"'); return; }
  ctGroups = company.categories.map(c=>({id:uid(), label:c.label, count:'', price:c.amount}));
  renderCtGroups();
  showToast('تم تعبئة الفئات وأسعارها — أكمل العدد لكل فئة');
});

/* ملخص ثابت (غير متأثر بالفلاتر): لكل شركة، إجمالي عدد المتدربين في كل حوالاتها، وكم أخذ الدورة وكم لم يأخذها بعد */
function companiesTakenSummaryHtml(){
  const todayStr = todayISO();
  const map = {};
  companyTransfers.forEach(t=>{
    if(!map[t.companyName]) map[t.companyName] = {total:0, taken:0, notTaken:0};
    (t.trainees||[]).forEach(tr=>{
      const cc = clients.find(x=>x.clientId===tr.clientId);
      const d = cc ? actualCourseDateOf(cc) : '';
      const taken = !!(d && d<=todayStr);
      map[t.companyName].total++;
      if(taken) map[t.companyName].taken++; else map[t.companyName].notTaken++;
    });
  });
  const names = Object.keys(map).sort((a,b)=>a.localeCompare(b,'ar'));
  if(!names.length) return `<div class="hint">لا توجد بيانات متدربين مضافة بعد.</div>`;
  const grand = names.reduce((s,n)=>({total:s.total+map[n].total, taken:s.taken+map[n].taken, notTaken:s.notTaken+map[n].notTaken}), {total:0,taken:0,notTaken:0});
  return `
    <div class="table-scroll table-scroll-compact">
      <table>
        <thead><tr><th>اسم الشركة</th><th>إجمالي المتدربين (كل الحوالات)</th><th>أخذ الدورة</th><th>لم يأخذ الدورة بعد</th></tr></thead>
        <tbody>
          ${names.map(n=>`<tr>
            <td>${escapeHtml(n)}</td>
            <td class="mono">${map[n].total}</td>
            <td class="mono" style="color:var(--teal);">${map[n].taken}</td>
            <td class="mono" style="color:var(--red);">${map[n].notTaken}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="font-weight:bold;">
            <td>الإجمالي الكلي</td>
            <td class="mono">${grand.total}</td>
            <td class="mono" style="color:var(--teal);">${grand.taken}</td>
            <td class="mono" style="color:var(--red);">${grand.notTaken}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}
function companiesFilteredTransfers(){
  const fname = $('#ctf-company')?.value || '';
  const dfrom = $('#ctf-date-from')?.value || '';
  const dto = $('#ctf-date-to')?.value || '';
  const fchannel = $('#ctf-channel')?.value || '';
  const fcid = ($('#ctf-clientid')?.value || '').trim();
  const fcidLower = fcid.toLowerCase();
  const traineeMatches = tr=>{
    if(String(tr.clientId||'').includes(fcid)) return true;
    const c = clients.find(x=>x.clientId===tr.clientId);
    return !!(c && String(c.name||'').toLowerCase().includes(fcidLower));
  };
  return companyTransfers.filter(t=>{
    if(fchannel && (t.channel||'')!==fchannel) return false;
    // فلتر البحث برقم الهوية أو اسم المتدرب يبحث في كل الحوالات وكل الشركات بغض النظر عن فلتر الشركة/التاريخ
    if(fcid) return (t.trainees||[]).some(traineeMatches);
    if(fname && t.companyName!==fname) return false;
    if(dfrom && (!t.date || t.date<dfrom)) return false;
    if(dto && (!t.date || t.date>dto)) return false;
    return true;
  });
}
/* قائمة موحّدة تُسطّح كل الأشخاص/المتدربين التابعين لجميع الشركات (عبر كل حوالاتها) في صف واحد لكل شخص،
   مع فلاتر مستقلة (الشركة، تاريخ الحوالة، طريقة الدفع) وصندوق بحث موحد يبحث في رقم الهوية أو الاسم أو
   اسم الشركة معاً — بغض النظر عن فلاتر سجل الحوالات أعلاه. */
function companiesFilteredPersons(){
  const fname = $('#cpp-company')?.value || '';
  const dfrom = $('#cpp-date-from')?.value || '';
  const dto = $('#cpp-date-to')?.value || '';
  const fchannel = $('#cpp-channel')?.value || '';
  const q = ($('#cpp-search')?.value || '').trim().toLowerCase();
  const rows = [];
  companyTransfers.forEach(t=>{
    if(fname && t.companyName!==fname) return;
    if(dfrom && (!t.date || t.date<dfrom)) return;
    if(dto && (!t.date || t.date>dto)) return;
    if(fchannel && (t.channel||'')!==fchannel) return;
    (t.trainees||[]).forEach(tr=>{
      const c = clients.find(x=>x.clientId===tr.clientId);
      if(q){
        const hay = [tr.clientId, c?c.name:'', t.companyName].join(' ').toLowerCase();
        if(!hay.includes(q)) return;
      }
      rows.push({t, tr, c});
    });
  });
  return rows.sort((a,b)=>(b.t.createdAt||0)-(a.t.createdAt||0) || String(a.tr.clientId||'').localeCompare(String(b.tr.clientId||'')));
}
let cpersonsPageState = {page:1, sig:''};
function renderCompanyPersons(){
  if($('#cpp-company')){
    const cppVal = $('#cpp-company').value;
    populateSelect($('#cpp-company'), companies.map(c=>c.name), false);
    $('#cpp-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
    $('#cpp-company').value = companies.some(c=>c.name===cppVal) ? cppVal : '';
  }
  if($('#cpp-channel')){
    const cppChannelVal = $('#cpp-channel').value;
    populateSelect($('#cpp-channel'), settings.channels.map(c=>c.name), false);
    $('#cpp-channel').insertAdjacentHTML('afterbegin','<option value="">كل طرق الدفع</option>');
    $('#cpp-channel').value = settings.channels.some(c=>c.name===cppChannelVal) ? cppChannelVal : '';
  }
  const rows = companiesFilteredPersons();
  const cnt = $('#cpp-count'); if(cnt) cnt.textContent = rows.length;
  const pageRows = applyGenericPagination('cpersons', rows, cpersonsPageState, [
    $('#cpp-company')?.value, $('#cpp-date-from')?.value, $('#cpp-date-to')?.value, $('#cpp-channel')?.value, $('#cpp-search')?.value
  ]);
  $('#company-persons-list').innerHTML = rows.length ? `
    <div class="table-scroll table-scroll-compact">
    <table>
      <thead><tr><th class="sticky-col sticky-col-1">رقم الهوية</th><th>الاسم</th><th>الجوال</th><th>الجنسية</th><th>اسم الشركة</th><th>تاريخ الحوالة</th><th>طريقة الدفع</th><th>نوع الدورة</th><th>رقم الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th><th>الحالة</th></tr></thead>
      <tbody>
        ${pageRows.map(({t,tr,c})=>`<tr>
          <td class="mono sticky-col sticky-col-1">${escapeHtml(tr.clientId)}</td>
          <td>${escapeHtml(c?c.name:'—')}${!c?' <span class="hint" style="display:inline;">(غير موجود بشيت العملاء بعد)</span>':''}</td>
          <td class="mono">${escapeHtml(c?(c.phone||'—'):'—')}</td>
          <td>${escapeHtml(c?(c.nationality||'—'):'—')}</td>
          <td>${escapeHtml(t.companyName||'—')}</td>
          <td class="mono">${escapeHtml(t.date||'—')}</td>
          <td>${escapeHtml(t.channel||'—')}</td>
          <td>${escapeHtml(c?(c.courseType||'—'):'—')}</td>
          <td class="mono">${escapeHtml(c?(c.courseNumber||'—'):'—')}</td>
          <td class="mono">${fmt(num(tr.courseValue))}</td>
          <td class="mono">${fmt(num(tr.bagValue))}</td>
          <td class="mono">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
          <td>${c ? '<span class="stamp paid">مرتبط بشيت العملاء</span>' : `<span class="stamp owe">غير موجود بشيت العملاء بعد</span> <button class="btn btn-gold btn-sm" data-linktrainee="${t.id}|${tr.id}">ربط</button>`}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>` : `<div class="empty-state" style="padding:20px;">لا يوجد أشخاص مطابقون لهذا الفلتر/البحث</div>`;
}
/* عند تفعيل فلتر البحث برقم الهوية أو الاسم، تُقصَر قائمة المتدربين المعروضة داخل كل حوالة على المتدربين المطابقين فقط */
function transferMatchingTrainees(t){
  const fcid = ($('#ctf-clientid')?.value || '').trim();
  const fcidLower = fcid.toLowerCase();
  const all = t.trainees || [];
  if(!fcid) return all;
  return all.filter(tr=>{
    if(String(tr.clientId||'').includes(fcid)) return true;
    const c = clients.find(x=>x.clientId===tr.clientId);
    return !!(c && String(c.name||'').toLowerCase().includes(fcidLower));
  });
}
/* يبني جدول توزيع المتدربين لحوالة معيّنة (قابل لإعادة الاستخدام) — نفس أزرار تعديل/حذف المتدرب المستخدَمة في شاشة تحويلات الشركات */
function renderTraineesTableHtml(t, trainees){
  if(!trainees.length) return `<div class="empty-state" style="padding:16px;">لا يوجد متدربون مسجّلون بعد تحت هذه الحوالة</div>`;
  return `
    <div class="table-scroll table-scroll-compact cards-mobile">
    <table style="margin-top:8px;">
      <thead><tr><th>رقم الهوية</th><th>الاسم</th><th>الجوال</th><th>الجنسية</th><th>نوع الدورة</th><th>رقم الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th><th>الحالة</th><th></th></tr></thead>
      <tbody>
        ${trainees.map(tr=>{
          const c = clients.find(x=>x.clientId===tr.clientId);
          return `<tr>
            <td class="mono" data-label="رقم الهوية">${escapeHtml(tr.clientId)}</td>
            <td data-label="الاسم">${escapeHtml(c?c.name:'—')}${!c?' <span class="hint" style="display:inline;">(غير موجود بشيت العملاء بعد)</span>':''}</td>
            <td class="mono" data-label="الجوال">${escapeHtml(c?(c.phone||'—'):'—')}</td>
            <td data-label="الجنسية">${escapeHtml(c?(c.nationality||'—'):'—')}</td>
            <td data-label="نوع الدورة">${escapeHtml(c?(c.courseType||'—'):'—')}</td>
            <td class="mono" data-label="رقم الدورة">${escapeHtml(c?(c.courseNumber||'—'):'—')}</td>
            <td class="mono" data-label="قيمة الدورة">${fmt(num(tr.courseValue))}</td>
            <td class="mono" data-label="قيمة الحقيبة">${fmt(num(tr.bagValue))}</td>
            <td class="mono" data-label="الإجمالي">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
            <td data-label="الحالة">${c ? '<span class="stamp paid">مرتبط بشيت العملاء</span>' : `<span class="stamp owe">غير موجود بعد</span> <button class="btn btn-gold btn-sm" data-linktrainee="${t.id}|${tr.id}">ربط</button>`}</td>
            <td class="card-full" data-label="">
              <button class="btn btn-ghost btn-sm" data-edittrainee="${t.id}|${tr.id}">تعديل</button>
              <button class="btn btn-ghost btn-sm" data-deltrainee="${t.id}|${tr.id}">حذف</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    </div>`;
}
/* يفتح نافذة تفصيلية من شيت الحركات المالية تعرض توزيع المتدربين تحت قيد الحوالة الواحد */
function openVaultCompanyTransferDetail(transferId){
  const t = companyTransfers.find(x=>x.id===transferId);
  if(!t){ showToast('تعذّر إيجاد بيانات هذه الحوالة'); return; }
  const allocated = transferAllocatedTotal(t);
  const remaining = num(t.amount) - allocated;
  $('#vct-title').textContent = `حوالة الشركة "${t.companyName}" — بتاريخ ${t.date||'—'}`;
  $('#vct-summary').innerHTML = `القيمة الإجمالية: <b>${fmt(num(t.amount))}</b> ﷼ — المخصَّص للمتدربين حالياً: <b>${fmt(allocated)}</b> ﷼ — المتبقي: <b>${fmt(remaining)}</b> ﷼ — عدد المتدربين المسجَّلين: <b>${(t.trainees||[]).length}</b> من أصل ${num(t.traineeCount)} مستهدف`;
  $('#vct-table-wrap').innerHTML = renderTraineesTableHtml(t, t.trainees||[]);
  $('#vault-company-transfer-overlay').classList.add('show');
}
$('#vct-close')?.addEventListener('click', ()=> $('#vault-company-transfer-overlay').classList.remove('show'));
/* بطاقات إحصائية + تنبيه الحوالات غير مكتملة التسوية (الفرق بين قيمة الحوالة وما خُصِّص فعلياً للمتدربين) */
function companiesStats(){
  const totalCompanies = companies.length;
  const totalTransfers = companyTransfers.length;
  const totalAmount = companyTransfers.reduce((s,t)=>s+num(t.amount),0);
  let unsettledCount = 0, totalTrainees = 0;
  companyTransfers.forEach(t=>{
    const allocated = transferAllocatedTotal(t);
    if(Math.abs(num(t.amount)-allocated) > 0.01) unsettledCount++;
    totalTrainees += (t.trainees||[]).length;
  });
  return {totalCompanies, totalTransfers, totalAmount, unsettledCount, totalTrainees};
}
function renderCompaniesStatsCards(){
  const wrap = $('#companies-stats-cards');
  if(!wrap) return;
  const s = companiesStats();
  wrap.innerHTML = `
    <div class="card"><div class="k">عدد الشركات</div><div class="v">${s.totalCompanies}</div></div>
    <div class="card"><div class="k">عدد الحوالات</div><div class="v">${s.totalTransfers}</div></div>
    <div class="card"><div class="k">إجمالي قيمة الحوالات</div><div class="v gold">${fmt(s.totalAmount)}</div></div>
    <div class="card"><div class="k">إجمالي المتدربين المسجَّلين</div><div class="v">${s.totalTrainees}</div></div>
    <div class="card"><div class="k">حوالات غير مكتملة التسوية</div><div class="v ${s.unsettledCount?'red':''}">${s.unsettledCount}</div></div>
  `;
}
function companiesUnsettledRows(){
  return companyTransfers.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const diff = num(t.amount) - allocated;
    return {t, allocated, diff};
  }).filter(r=>Math.abs(r.diff) > 0.01)
    .sort((a,b)=>(b.t.createdAt||0)-(a.t.createdAt||0));
}
function renderCompaniesUnsettledPanel(){
  const panel = $('#companies-unsettled-panel');
  const list = $('#companies-unsettled-list');
  if(!panel || !list) return;
  const rows = companiesUnsettledRows();
  if(!rows.length){ panel.style.display = 'none'; list.innerHTML=''; return; }
  panel.style.display = '';
  list.innerHTML = `
    <div class="table-scroll table-scroll-compact">
      <table>
        <thead><tr><th>الشركة</th><th>تاريخ الحوالة</th><th>قيمة الحوالة</th><th>المخصَّص فعلياً</th><th>الفرق</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r=>`<tr>
            <td>${escapeHtml(r.t.companyName)}</td>
            <td class="mono">${r.t.date||'—'}</td>
            <td class="mono">${fmt(num(r.t.amount))}</td>
            <td class="mono">${fmt(r.allocated)}</td>
            <td class="mono" style="${r.diff!==0?'color:var(--red);':''}">${r.diff>0?'ناقص ':'زائد '}${fmt(Math.abs(r.diff))}</td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-jumptransfer="${r.t.id}">فتح الحوالة</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}
document.addEventListener('click', e=>{
  const btn = e.target.closest('[data-jumptransfer]');
  if(!btn) return;
  const id = btn.dataset.jumptransfer;
  $('#ctf-company').value=''; $('#ctf-date-from').value=''; $('#ctf-date-to').value=''; $('#ctf-clientid').value=''; if($('#ctf-channel')) $('#ctf-channel').value='';
  const sorted = companyTransfers.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const idx = sorted.findIndex(x=>x.id===id);
  const pageSize = genericPageSize('ctransfers');
  ctransfersPageState.sig = JSON.stringify(['','','','','']);
  ctransfersPageState.page = (idx>=0 && Number.isFinite(pageSize)) ? Math.floor(idx/pageSize)+1 : 1;
  renderCompanies();
  setTimeout(()=>{
    const el = document.getElementById('ctrow-'+id);
    if(el){
      el.scrollIntoView({behavior:'smooth', block:'start'});
      el.style.transition = 'box-shadow .3s';
      el.style.boxShadow = '0 0 0 3px var(--red)';
      setTimeout(()=>{ el.style.boxShadow=''; }, 2500);
    }
  }, 60);
});
/* كشف حساب PDF لشركة محددة: يجمع كل حوالاتها ومتدربيها مع إجمالي المخصَّص والمتبقي */
function printCompanyStatement(companyId){
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('تعذّر إيجاد الشركة'); return; }
  const transfers = companyTransfers.filter(t=>t.companyId===companyId).sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA');

  const totalAmount = transfers.reduce((s,t)=>s+num(t.amount),0);
  const totalAllocated = transfers.reduce((s,t)=>s+transferAllocatedTotal(t),0);
  const totalRemaining = totalAmount - totalAllocated;
  const allTrainees = [];
  transfers.forEach(t=> (t.trainees||[]).forEach(tr=> allTrainees.push({tr, t})));
  const totalLinked = allTrainees.filter(x=>clients.some(c=>c.clientId===x.tr.clientId)).length;

  const transfersRows = transfers.length ? transfers.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const remaining = num(t.amount) - allocated;
    return `<tr>
      <td class="mono">${escapeHtml(t.date||'—')}</td>
      <td>${escapeHtml(t.channel||'—')}</td>
      <td class="mono">${escapeHtml(t.refNum||'—')}</td>
      <td class="mono">${fmt(num(t.amount))}</td>
      <td class="mono">${num(t.traineeCount)}</td>
      <td class="mono">${(t.trainees||[]).length}</td>
      <td class="mono">${fmt(allocated)}</td>
      <td class="mono" style="${Math.abs(remaining)>0.01?`color:${PRINT_PALETTE.red};`:''}">${fmt(remaining)}</td>
      <td>${escapeHtml(t.notes||'—')}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center; color:${PRINT_PALETTE.muted};">لا توجد حوالات مسجّلة لهذه الشركة</td></tr>`;

  const traineesRows = allTrainees.length ? allTrainees.map(({tr,t})=>{
    const cl = clients.find(x=>x.clientId===tr.clientId);
    return `<tr>
      <td class="mono">${escapeHtml(t.date||'—')}</td>
      <td class="mono">${escapeHtml(tr.clientId||'—')}</td>
      <td>${escapeHtml(cl?cl.name:'—')}</td>
      <td>${escapeHtml(cl?(cl.nationality||'—'):'—')}</td>
      <td>${escapeHtml(cl?(cl.courseType||'—'):'—')}</td>
      <td class="mono">${escapeHtml(cl?(cl.courseNumber||'—'):'—')}</td>
      <td class="mono">${fmt(num(tr.courseValue))}</td>
      <td class="mono">${fmt(num(tr.bagValue))}</td>
      <td class="mono">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" style="text-align:center; color:${PRINT_PALETTE.muted};">لا يوجد متدربون مضافون بعد</td></tr>`;

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(`كشف حساب — ${company.name}`, {variant:'table-center', extraCss:`
    .summary-grid{display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:22px;}
    .summary-box{border:1px solid ${PRINT_PALETTE.border}; border-radius:8px; padding:10px 12px; text-align:center;}
    .summary-box .k{font-size:11.5px; color:${PRINT_PALETTE.muted}; margin-bottom:6px;}
    .summary-box .v{font-family:monospace; font-size:17px; font-weight:bold; color:${PRINT_PALETTE.navy};}
    h3{color:${PRINT_PALETTE.navy}; margin:22px 0 8px; font-size:15px;}
    tfoot td{background:${PRINT_PALETTE.surfaceAlt}; font-weight:bold;}
  `})}
  <body>
    <div class="head">
      <div><h2>كشف حساب — ${escapeHtml(company.name)}</h2><div style="font-size:13px; color:${PRINT_PALETTE.muted};">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>تاريخ الكشف: <b>${today}</b></span>
      ${company.taxNumber ? `<span>الرقم الضريبي: <b>${escapeHtml(company.taxNumber)}</b></span>` : ''}
      <span>المبلغ المتفق عليه/متدرب: <b>${(company.categories&&company.categories.length) ? escapeHtml(companyCategoriesSummaryText(company.categories)) : fmt(num(company.agreedAmount))}</b></span>
    </div>
    <div class="summary-grid">
      <div class="summary-box"><div class="k">عدد الحوالات</div><div class="v">${transfers.length}</div></div>
      <div class="summary-box"><div class="k">إجمالي قيمة الحوالات</div><div class="v">${fmt(totalAmount)}</div></div>
      <div class="summary-box"><div class="k">إجمالي المخصَّص فعلياً</div><div class="v">${fmt(totalAllocated)}</div></div>
      <div class="summary-box"><div class="k">المتبقي غير المخصَّص</div><div class="v" style="${Math.abs(totalRemaining)>0.01?`color:${PRINT_PALETTE.red};`:''}">${fmt(totalRemaining)}</div></div>
    </div>
    <h3>سجل الحوالات (${transfers.length})</h3>
    <table>
      <thead><tr><th>تاريخ الحوالة</th><th>طريقة الدفع</th><th>رقم المرجع</th><th>قيمة الحوالة</th><th>العدد المستهدف</th><th>عدد المتدربين المضافين</th><th>المخصَّص فعلياً</th><th>المتبقي</th><th>ملاحظات</th></tr></thead>
      <tbody>${transfersRows}</tbody>
    </table>
    <h3>المتدربون (${allTrainees.length} — مرتبط بشيت العملاء: ${totalLinked})</h3>
    <table>
      <thead><tr><th>تاريخ الحوالة</th><th>رقم الهوية</th><th>الاسم</th><th>الجنسية</th><th>نوع الدورة</th><th>رقم الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th></tr></thead>
      <tbody>${traineesRows}</tbody>
      ${allTrainees.length ? `<tfoot><tr>
        <td colspan="6" style="text-align:left;">الإجمالي</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.courseValue),0))}</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.bagValue),0))}</td>
        <td class="mono">${fmt(allTrainees.reduce((s,x)=>s+num(x.tr.courseValue)+num(x.tr.bagValue),0))}</td>
      </tr></tfoot>` : ''}
    </table>
    ${printDocFooterButton()}
  </body></html>`);
  win.document.close();
}
let ctransfersPageState = {page:1, sig:''};
function renderCompanies(){
  renderCompaniesStatsCards();
  renderCompaniesUnsettledPanel();
  renderCompanyPersons();
  // ملخص أعداد المتدربين حسب الشركة (إجمالي كل الحوالات، بغض النظر عن أي فلترة)
  $('#company-transfers-summary').innerHTML = companiesTakenSummaryHtml();

  // طرق الدفع المتاحة لاختيار طريقة دفع الحوالة الجديدة (نفس طرق الدفع المُعرَّفة في الإعدادات)
  const ctChannelSel = $('#ct-channel');
  if(ctChannelSel){
    const ctChannelVal = ctChannelSel.value;
    populateSelect(ctChannelSel, settings.channels.map(c=>c.name), false);
    if(settings.channels.some(c=>c.name===ctChannelVal)) ctChannelSel.value = ctChannelVal;
    else { const bankCh = settings.channels.find(c=>c.dest==='bank'); if(bankCh) ctChannelSel.value = bankCh.name; }
  }

  // قائمة الشركات لاختيارها عند إضافة حوالة جديدة
  $('#ct-company').innerHTML = companies.length
    ? companies.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
    : `<option value="">— أضف شركة أولاً من الأعلى —</option>`;

  // datalist أرقام هويات العملاء (لو زار المستخدم هذا التبويب قبل تبويب الحركات المالية)
  const dlc = $('#dl-clients');
  if(dlc) dlc.innerHTML = clients.filter(c=>c.clientId).map(c=>`<option value="${escapeHtml(c.clientId)}" label="${escapeHtml(c.name)}"></option>`).join('');

  // datalist أسماء الشركات (لنموذج إضافة عميل جديد في شيت العملاء، ولحقل اسم الشركة أعلى جدول استيراد عمال الشركات)
  const dlComp = $('#dl-company-names');
  if(dlComp) dlComp.innerHTML = companies.map(c=>`<option value="${escapeHtml(c.name)}"></option>`).join('');

  // جدول الشركات المتفق معها
  const transfersByCompanyId = new Map();
  companyTransfers.forEach(t=>{
    let arr = transfersByCompanyId.get(t.companyId);
    if(!arr){ arr = []; transfersByCompanyId.set(t.companyId, arr); }
    arr.push(t);
  });
  $('#companies-list-body').innerHTML = companies.length ? companies.map(c=>{
    const transfers = transfersByCompanyId.get(c.id) || [];
    const totalAmount = transfers.reduce((s,t)=>s+num(t.amount),0);
    return `<tr>
      <td data-label="اسم الشركة">${escapeHtml(c.name)}</td>
      <td class="mono" data-label="الرقم الضريبي">${escapeHtml(c.taxNumber||'—')}</td>
      <td class="mono" data-label="المبلغ المتفق">${(c.categories&&c.categories.length) ? escapeHtml(companyCategoriesSummaryText(c.categories)) : fmt(num(c.agreedAmount))}</td>
      <td class="mono" data-label="عدد الحوالات">${transfers.length}</td>
      <td class="mono" data-label="إجمالي الحوالات">${fmt(totalAmount)}</td>
      <td class="card-full" data-label="">
        <button class="btn btn-gold btn-sm" data-printcompany="${c.id}">🖨️ كشف حساب PDF</button>
        <button class="btn btn-ghost btn-sm" data-importcompanytrainees="${c.id}">📥 استيراد متدربين (كل الحوالات)</button>
        <button class="btn btn-ghost btn-sm" data-editcompany="${c.id}">تعديل</button>
        <button class="btn btn-ghost btn-sm" data-mergecompany="${c.id}">دمج مع شركة أخرى</button>
        <button class="btn btn-ghost btn-sm" data-delcompany="${c.id}">حذف</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:16px;">لا توجد شركات مضافة بعد</td></tr>`;

  updateComputedShare();

  // خيارات فلتر الشركة لسجل الحوالات
  const ctfVal = $('#ctf-company').value;
  populateSelect($('#ctf-company'), companies.map(c=>c.name), false);
  $('#ctf-company').insertAdjacentHTML('afterbegin','<option value="">كل الشركات</option>');
  $('#ctf-company').value = companies.some(c=>c.name===ctfVal) ? ctfVal : '';

  // خيارات فلتر طريقة الدفع لسجل الحوالات
  const ctfChannelVal = $('#ctf-channel')?.value;
  if($('#ctf-channel')){
    populateSelect($('#ctf-channel'), settings.channels.map(c=>c.name), false);
    $('#ctf-channel').insertAdjacentHTML('afterbegin','<option value="">كل طرق الدفع</option>');
    $('#ctf-channel').value = settings.channels.some(c=>c.name===ctfChannelVal) ? ctfChannelVal : '';
  }

  // سجل الحوالات والمتدربين (مفلترة حسب الشركة وتاريخ الحوالة وطريقة الدفع والبحث برقم الهوية/الاسم)
  const filteredTransfers = companiesFilteredTransfers();
  const sortedTransfers = filteredTransfers.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const ctPageRows = applyGenericPagination('ctransfers', sortedTransfers, ctransfersPageState, [
    $('#ctf-company')?.value, $('#ctf-date-from')?.value, $('#ctf-date-to')?.value, $('#ctf-clientid')?.value, $('#ctf-channel')?.value
  ]);
  $('#company-transfers-list').innerHTML = filteredTransfers.length ? ctPageRows.map(t=>{
    const allocated = transferAllocatedTotal(t);
    const remaining = num(t.amount) - allocated;
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    const matchedTrainees = transferMatchingTrainees(t);
    const traineesHtml = matchedTrainees.length ? `
      <div class="table-scroll table-scroll-compact cards-mobile">
      <table style="margin-top:8px;">
        <thead><tr><th>رقم الهوية</th><th>الاسم</th><th>الجوال</th><th>الجنسية</th><th>نوع الدورة</th><th>رقم الدورة</th><th>رقم الفاتورة</th><th>حالة الحقيبة</th><th>تاريخ الدورة</th><th>قيمة الدورة</th><th>قيمة الحقيبة</th><th>الإجمالي</th><th>الحالة</th><th></th></tr></thead>
        <tbody>
          ${matchedTrainees.map(tr=>{
            const c = clients.find(x=>x.clientId===tr.clientId);
            return `<tr>
              <td class="mono" data-label="رقم الهوية">${escapeHtml(tr.clientId)}</td>
              <td data-label="الاسم">${escapeHtml(c?c.name:'—')}${!c?' <span class="hint" style="display:inline;">(غير موجود بشيت العملاء بعد)</span>':''}</td>
              <td class="mono" data-label="الجوال">${escapeHtml(c?(c.phone||'—'):'—')}</td>
              <td data-label="الجنسية">${escapeHtml(c?(c.nationality||'—'):'—')}</td>
              <td data-label="نوع الدورة">${escapeHtml(c?(c.courseType||'—'):'—')}</td>
              <td class="mono" data-label="رقم الدورة">${escapeHtml(c?(c.courseNumber||'—'):'—')}</td>
              <td class="mono" data-label="رقم الفاتورة">${escapeHtml(c&&c.invoice?c.invoice:'—')}</td>
              <td data-label="حالة الحقيبة">${c?escapeHtml(bagSourceLabel(c)):'—'}</td>
              <td class="mono" data-label="تاريخ الدورة">${escapeHtml(c?(formatDateDisplay(actualCourseDateOf(c))||'—'):'—')}</td>
              <td class="mono" data-label="قيمة الدورة">${fmt(num(tr.courseValue))}</td>
              <td class="mono" data-label="قيمة الحقيبة">${fmt(num(tr.bagValue))}</td>
              <td class="mono" data-label="الإجمالي">${fmt(num(tr.courseValue)+num(tr.bagValue))}</td>
              <td data-label="الحالة">${c ? '<span class="stamp paid">مرتبط بشيت العملاء</span>' : `<span class="stamp owe">غير موجود بعد</span> <button class="btn btn-gold btn-sm" data-linktrainee="${t.id}|${tr.id}">ربط</button>`}</td>
              <td class="card-full" data-label="">
                <button class="btn btn-ghost btn-sm" data-edittrainee="${t.id}|${tr.id}">تعديل</button>
                <button class="btn btn-ghost btn-sm" data-deltrainee="${t.id}|${tr.id}">حذف</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>${matchedTrainees.length<(t.trainees||[]).length ? `<div class="hint" style="margin:6px 0 0;">تم إخفاء ${(t.trainees||[]).length-matchedTrainees.length} متدرب لا يطابق فلتر البحث برقم الهوية — من إجمالي ${(t.trainees||[]).length} في هذه الحوالة</div>` : ''}` : ((t.trainees||[]).length ? `<div class="hint" style="margin:8px 0;">لا يوجد متدرب في هذه الحوالة يطابق فلتر البحث برقم الهوية.</div>` : `<div class="hint" style="margin:8px 0;">لا يوجد متدربون مضافون لهذه الحوالة بعد.</div>`);
    const todayStr = todayISO();
    const takenCount = matchedTrainees.filter(tr=>{
      const cc = clients.find(x=>x.clientId===tr.clientId);
      const d = cc ? actualCourseDateOf(cc) : '';
      return d && d<=todayStr;
    }).length;
    const notTakenCount = matchedTrainees.length - takenCount;
    return `
      <div class="panel" id="ctrow-${t.id}" style="margin-bottom:14px; border-right:4px solid var(--gold);">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
          <div>
            <b>${escapeHtml(t.companyName)}</b> — <span class="mono">${t.date||'—'}</span>
            ${Math.abs(remaining)>0.01 ? '<span class="stamp owe" style="margin-right:6px;">غير مكتملة التسوية</span>' : '<span class="stamp paid" style="margin-right:6px;">مكتملة التسوية</span>'}
            <div class="hint" style="margin:4px 0 0;">قيمة الحوالة: <b class="mono">${fmt(num(t.amount))}</b> ﷼ · عدد المتدربين المستهدف: <b class="mono">${num(t.traineeCount)}</b> · ${(t.groups&&t.groups.length) ? `تقسيم الفئات: <b>${escapeHtml(ctGroupsSummaryText(t.groups))}</b>` : `نصيب الفرد المحتسب: <b class="mono">${fmt(share)}</b> ﷼`} · طريقة الدفع: <b>${escapeHtml(t.channel||'تحويل بنكي')}</b>${t.refNum?` · رقم المرجع: <b class="mono">${escapeHtml(t.refNum)}</b>`:''}${t.notes?` · ${escapeHtml(t.notes)}`:''}</div>
            <div class="hint" style="margin:4px 0 0;">عدد من أخذ الدورة: <b class="mono" style="color:var(--teal);">${takenCount}</b> · عدد من لم يأخذ الدورة بعد: <b class="mono" style="color:var(--red);">${notTakenCount}</b></div>
            <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer; margin-top:6px; font-size:13px;">
              <input type="checkbox" data-transferbagall="${t.id}" ${t.bagForAll?'checked':''} style="width:auto; margin:0;">
              شراء حقيبة لكل متدربي هذه الحوالة (يُقسَّم نصيب كل متدرب تلقائياً إلى قيمة دورة + قيمة حقيبة حسب السعر الافتراضي)
            </label>
          </div>
          <div style="text-align:left;">
            <div>المخصَّص فعلياً: <b class="mono">${fmt(allocated)}</b> ﷼</div>
            <div class="${remaining<0?'red':''}">المتبقي من الحوالة: <b class="mono">${fmt(remaining)}</b> ﷼</div>
          </div>
        </div>
        ${traineesHtml}
        <div style="margin-top:10px;">
          <button class="btn btn-gold btn-sm" data-addtrainee="${t.id}">+ إضافة متدرب</button>
          <button class="btn btn-ghost btn-sm" data-importtrainees="${t.id}">+ استيراد متدربين (Excel)</button>
          <button class="btn btn-ghost btn-sm" data-importtraineestext="${t.id}">+ استيراد متدربين (لصق نص)</button>
          <button class="btn btn-ghost btn-sm" data-edittransfer="${t.id}">تعديل الحوالة</button>
          <button class="btn btn-danger btn-sm" data-deltransfer="${t.id}">حذف الحوالة كاملة</button>
        </div>
      </div>`;
  }).join('') : `<div class="empty-state" style="padding:20px;">لا توجد تحويلات شركات مسجّلة بعد</div>`;
}

['#ctf-company','#ctf-date-from','#ctf-date-to','#ctf-channel'].forEach(sel=> $(sel).addEventListener('input', renderCompanies));
onSearchInput('#ctf-clientid', renderCompanies);
bindGenericPagination('ctransfers', ctransfersPageState, renderCompanies);
['#cpp-company','#cpp-date-from','#cpp-date-to','#cpp-channel'].forEach(sel=> $(sel)?.addEventListener('input', renderCompanyPersons));
onSearchInput('#cpp-search', renderCompanyPersons);
bindGenericPagination('cpersons', cpersonsPageState, renderCompanyPersons);
$('#btn-export-companies').addEventListener('click', ()=>{
  const headers = ['اسم الشركة','تاريخ الحوالة','طريقة الدفع','رقم المرجع','قيمة الحوالة','عدد المتدربين المستهدف','نصيب الفرد','ملاحظات','رقم هوية المتدرب','اسم المتدرب','قيمة الدورة','قيمة الحقيبة','إجمالي المتدرب','الحالة'];
  const rows = [];
  companiesFilteredTransfers().forEach(t=>{
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    if((t.trainees||[]).length){
      t.trainees.forEach(tr=>{
        const c = clients.find(x=>x.clientId===tr.clientId);
        rows.push([t.companyName,t.date,t.channel||'تحويل بنكي',t.refNum||'',num(t.amount),num(t.traineeCount),share,t.notes||'',tr.clientId,c?c.name:'',num(tr.courseValue),num(tr.bagValue),num(tr.courseValue)+num(tr.bagValue),c?'مرتبط بشيت العملاء':'غير موجود بعد']);
      });
    } else {
      rows.push([t.companyName,t.date,t.channel||'تحويل بنكي',t.refNum||'',num(t.amount),num(t.traineeCount),share,t.notes||'','','','','','','']);
    }
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'تحويلات_الشركات.csv';
  a.click();
});
$('#btn-export-companies-xlsx').addEventListener('click', ()=>{
  const rows = [];
  companiesFilteredTransfers().forEach(t=>{
    const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
    if((t.trainees||[]).length){
      t.trainees.forEach(tr=>{
        const c = clients.find(x=>x.clientId===tr.clientId);
        rows.push({
          'اسم الشركة': t.companyName, 'تاريخ الحوالة': t.date||'', 'طريقة الدفع': t.channel||'تحويل بنكي', 'رقم المرجع': t.refNum||'',
          'قيمة الحوالة': num(t.amount), 'عدد المتدربين المستهدف': num(t.traineeCount), 'نصيب الفرد': share, 'ملاحظات': t.notes||'',
          'رقم هوية المتدرب': tr.clientId, 'اسم المتدرب': c?c.name:'', 'قيمة الدورة': num(tr.courseValue), 'قيمة الحقيبة': num(tr.bagValue),
          'إجمالي المتدرب': num(tr.courseValue)+num(tr.bagValue), 'الحالة': c?'مرتبط بشيت العملاء':'غير موجود بعد'
        });
      });
    } else {
      rows.push({
        'اسم الشركة': t.companyName, 'تاريخ الحوالة': t.date||'', 'طريقة الدفع': t.channel||'تحويل بنكي', 'رقم المرجع': t.refNum||'',
        'قيمة الحوالة': num(t.amount), 'عدد المتدربين المستهدف': num(t.traineeCount), 'نصيب الفرد': share, 'ملاحظات': t.notes||'',
        'رقم هوية المتدرب': '', 'اسم المتدرب': '', 'قيمة الدورة': '', 'قيمة الحقيبة': '', 'إجمالي المتدرب': '', 'الحالة': ''
      });
    }
  });
  downloadXlsx('تحويلات_الشركات.xlsx', 'تحويلات الشركات', rows);
});
function resetCompanyForm(){
  editingCompanyId = null;
  $('#cm-name').value=''; $('#cm-amount').value=''; $('#cm-tax').value='';
  resetCmCats();
  $('#btn-add-company').textContent = '+ إضافة شركة';
  $('#btn-cancel-edit-company').style.display = 'none';
}

$('#btn-add-company').addEventListener('click', async ()=>{
  const name = $('#cm-name').value.trim();
  if(!name){ showToast('أدخل اسم الشركة'); return; }
  const dupCompany = companies.find(c=>c.name===name);
  if(dupCompany && dupCompany.id!==editingCompanyId){ showToast('هذه الشركة مضافة مسبقاً'); return; }
  const agreedAmount = num($('#cm-amount').value);
  const taxNumber = $('#cm-tax').value.trim();
  const categoriesUsed = cmCats.filter(c=>c.label && num(c.amount)>0);
  if(cmCats.length && !categoriesUsed.length){ showToast('أكمل بيانات الفئات (الاسم والمبلغ) أو احذفها'); return; }

  if(editingCompanyId){
    const c = companies.find(x=>x.id===editingCompanyId);
    if(!c){ showToast('تعذّر إيجاد الشركة المطلوب تعديلها'); resetCompanyForm(); return; }
    snapshotState(`تعديل بيانات الشركة: ${c.name}`);
    const oldName = c.name;
    c.name = name;
    c.agreedAmount = agreedAmount;
    c.taxNumber = taxNumber;
    if(categoriesUsed.length) c.categories = categoriesUsed.map(cc=>({label:cc.label, amount:num(cc.amount)}));
    else delete c.categories;
    // إن تغيّر اسم الشركة، حدّث الاسم أيضاً في تحويلات الشركة المرتبطة بها وفي بيانات العملاء المرتبطين بها
    if(oldName!==name){
      companyTransfers.forEach(t=>{ if(t.companyId===c.id) t.companyName = name; });
      clients.forEach(cl=>{ if(cl.clientType==='company' && cl.companyName===oldName) cl.companyName = name; });
      await saveCompanyTransfers();
      await saveClients();
    }
    await saveCompanies();
    const catsNote = categoriesUsed.length ? ` — مبالغ حسب الفئة: ${companyCategoriesSummaryText(c.categories)}` : '';
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات الشركة: ${name} (المبلغ المتفق عليه للمتدرب: ${fmt(agreedAmount)}${taxNumber?` — الرقم الضريبي: ${taxNumber}`:''})${catsNote}`);
    resetCompanyForm();
    renderCompanies(); renderTable();
    showToast('تم تحديث بيانات الشركة');
    return;
  }

  snapshotState(`إضافة شركة جديدة: ${name}`);
  const companyRecord = {id:uid(), name, agreedAmount, taxNumber, createdAt:Date.now(), createdBy: currentUser};
  if(categoriesUsed.length) companyRecord.categories = categoriesUsed.map(c=>({label:c.label, amount:num(c.amount)}));
  companies.push(companyRecord);
  await saveCompanies();
  const catsNote = categoriesUsed.length ? ` — مبالغ حسب الفئة: ${companyCategoriesSummaryText(companyRecord.categories)}` : '';
  await logAudit('add','تحويلات الشركات', `تمت إضافة شركة جديدة: ${name} (المبلغ المتفق عليه للمتدرب: ${fmt(agreedAmount)}${taxNumber?` — الرقم الضريبي: ${taxNumber}`:''})${catsNote}`);
  resetCompanyForm();
  renderCompanies();
  showToast('تمت إضافة الشركة');
});

$('#btn-cancel-edit-company').addEventListener('click', ()=>{
  resetCompanyForm();
  showToast('تم إلغاء التعديل');
});

$('#btn-add-transfer').addEventListener('click', async ()=>{
  const companyId = $('#ct-company').value;
  const company = companies.find(c=>c.id===companyId);
  if(!company){ showToast('اختر شركة أولاً (أضفها من القائمة أعلاه إن لم تكن موجودة)'); return; }
  const amount = num($('#ct-amount').value);
  const count = num($('#ct-count').value);
  if(amount<=0){ showToast('أدخل قيمة صحيحة للحوالة'); return; }
  if(count<=0){ showToast('أدخل عدد المتدربين المراد تدريبهم'); return; }
  const date = $('#ct-date').value || todayISO();
  const notes = $('#ct-notes').value.trim();
  const refNum = $('#ct-refnum').value.trim();
  const channel = $('#ct-channel').value || (settings.channels.find(ch=>ch.dest==='bank')||{}).name || 'تحويل بنكي';
  const groupsUsed = ctGroups.filter(g=>g.label && num(g.count)>0 && num(g.price)>=0);
  if(ctGroups.length && !groupsUsed.length){ showToast('أكمل بيانات الفئات (الاسم والعدد) أو احذفها للإدخال اليدوي'); return; }
  if(editingTransferId){
    const idx = companyTransfers.findIndex(x=>x.id===editingTransferId);
    if(idx===-1){ showToast('تعذّر إيجاد الحوالة للتعديل — قد تكون حُذفت'); cancelTransferEdit(); return; }
    const tExisting = companyTransfers[idx];
    const existingLump = vaultTx.find(v=>v.companyTransferId===tExisting.id);
    if(existingLump && isDateLocked(existingLump.date)){ showToast('تعذّر التعديل: الحركة المالية المرتبطة بهذه الحوالة ضمن فترة محاسبية مُقفلة'); return; }
    snapshotState(`تعديل حوالة الشركة: ${company.name}`);
    const t = companyTransfers[idx];
    t.companyId = companyId; t.companyName = company.name; t.date = date; t.amount = amount;
    t.traineeCount = count; t.notes = notes; t.channel = channel; t.refNum = refNum;
    if(groupsUsed.length) t.groups = groupsUsed.map(g=>({label:g.label, count:num(g.count), price:num(g.price)}));
    else delete t.groups;
    // مزامنة التاريخ والمبلغ وطريقة الدفع مع القيد المالي الواحد المرتبط بهذه الحوالة بالكامل (بدل تعديل قيود متعددة سابقاً)
    let cascaded = false;
    if(existingLump){
      existingLump.date = date;
      existingLump.amount = amount;
      existingLump.method = channel;
      const destCh = settings.channels.find(ch=>ch.name===channel);
      if(destCh) existingLump.destination = destCh.dest;
      existingLump.notes = `حوالة شركة "${company.name}"${refNum?` — مرجع: ${refNum}`:''} (مُعدَّلة)`;
      cascaded = true;
    }
    if(cascaded) await saveVaultTx();
    await saveCompanyTransfers();
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات حوالة الشركة "${company.name}" بتاريخ ${date} — القيمة الآن ${fmt(amount)} لعدد ${count} متدرب (طريقة الدفع: ${channel})${cascaded?' — وتمت مزامنة القيد المالي الواحد المرتبط بهذه الحوالة':''}`);
    cancelTransferEdit();
    renderCompanies();
    showToast('تم حفظ التعديل');
    return;
  }
  snapshotState(`إضافة حوالة جديدة للشركة: ${company.name}`);
  const transferRecord = {id:uid(), createdAt:Date.now(), createdBy: currentUser, companyId, companyName:company.name, date, amount, traineeCount:count, notes, channel, refNum, trainees:[]};
  if(groupsUsed.length) transferRecord.groups = groupsUsed.map(g=>({label:g.label, count:num(g.count), price:num(g.price)}));
  companyTransfers.push(transferRecord);
  // قيد مالي واحد فوري بكامل مبلغ الحوالة — المبلغ مُستلَم فعلياً بالكامل من الشركة سواء وُزِّع على المتدربين الآن أو لاحقاً
  const destCh0 = settings.channels.find(ch=>ch.name===channel);
  const dest0 = destCh0 ? destCh0.dest : 'bank';
  vaultTx.push({
    id: uid(), seq: allocVaultSeq(dest0), createdAt: Date.now(),
    type:'in', date, amount, destination: dest0,
    clientName:'', method: channel, category:'', manual:'', networkInvoice:'',
    notes: `حوالة شركة "${company.name}"${refNum?` — مرجع: ${refNum}`:''}`,
    companyTransferId: transferRecord.id
  });
  await saveVaultTx();
  await saveCompanyTransfers();
  const groupsNote = groupsUsed.length ? ` — مقسّمة حسب فئات: ${ctGroupsSummaryText(transferRecord.groups)}` : '';
  await logAudit('add','تحويلات الشركات', `تمت إضافة حوالة جديدة للشركة "${company.name}" بقيمة ${fmt(amount)} لعدد ${count} متدرب (طريقة الدفع: ${channel}) — وتم تسجيل قيد مالي فوري بكامل المبلغ${groupsNote}`);
  $('#ct-amount').value=''; $('#ct-count').value=''; $('#ct-notes').value=''; $('#ct-date').value=''; $('#ct-refnum').value='';
  resetCtGroups();
  renderCompanies(); renderVault();
  showToast('تم حفظ الحوالة');
});


/* تعديل حوالة شركة قائمة: يملأ نموذج "إضافة حوالة جديدة" ببيانات الحوالة المحددة، ويحوّل زر الحفظ لوضع "تعديل" مؤقتاً */
function openTransferEdit(id){
  const t = companyTransfers.find(x=>x.id===id);
  if(!t) return;
  editingTransferId = id;
  $('#ct-company').value = t.companyId;
  $('#ct-date').value = t.date || '';
  $('#ct-notes').value = t.notes || '';
  $('#ct-refnum').value = t.refNum || '';
  ctGroups = (t.groups||[]).map(g=>({id:uid(), label:g.label, count:g.count, price:g.price}));
  if(ctGroups.length){ renderCtGroups(); } else { $('#ct-amount').value = t.amount ?? ''; $('#ct-count').value = t.traineeCount ?? ''; resetCtGroups(); }
  if(settings.channels.some(c=>c.name===t.channel)) $('#ct-channel').value = t.channel;
  else { const fixed = canonicalizeChannelName(t.channel); if(settings.channels.some(c=>c.name===fixed)) $('#ct-channel').value = fixed; }
  updateComputedShare();
  $('#btn-add-transfer').textContent = 'حفظ التعديل';
  $('#btn-cancel-edit-transfer').style.display = '';
  $('#ct-company').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
}
function cancelTransferEdit(){
  editingTransferId = null;
  $('#ct-amount').value=''; $('#ct-count').value=''; $('#ct-notes').value=''; $('#ct-date').value=''; $('#ct-refnum').value='';
  resetCtGroups();
  $('#btn-add-transfer').textContent = 'حفظ الحوالة';
  $('#btn-cancel-edit-transfer').style.display = 'none';
}
$('#btn-cancel-edit-transfer').addEventListener('click', ()=>{ cancelTransferEdit(); showToast('تم إلغاء التعديل'); });

$('#ctr-id').addEventListener('input', ()=>{
  const c = clients.find(x=>x.clientId===$('#ctr-id').value.trim());
  if(c){
    const alreadyPaid = num(c.paid)>0;
    $('#ctr-client-info').innerHTML = `العميل: <b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.phone||'—')} — ${escapeHtml(c.nationality||'—')}` +
      (alreadyPaid ? `<br><span style="color:var(--red);">⚠️ هذا العميل مسجَّل بالفعل ومدفوع عنه في شيت العملاء (${fmt(num(c.paid))} ﷼) — لن يُرحَّل مبلغ جديد للبنك تلقائياً لتجنّب تكرار الأرقام؛ الإضافة هنا للتوثيق فقط.</span>` : '');
    $('#wrap-ctr-newclient').style.display = 'none';
    $('#wrap-ctr-newclient2').style.display = 'none';
  }else{
    $('#ctr-client-info').textContent = 'لم يتم العثور على العميل بعد — إن أكملت الاسم والجنسية أدناه سيُضاف تلقائياً كعميل شركات جديد في شيت العملاء.';
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
  }
});
$('#ctr-cancel').addEventListener('click', ()=>{ $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null; ctEditingTraineeId=null; $('#ctr-id').readOnly=false; });
$('#ctrainee-overlay').addEventListener('click', e=>{ if(e.target.id==='ctrainee-overlay'){ $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null; ctEditingTraineeId=null; $('#ctr-id').readOnly=false; } });

function recalcCtrSplit(){
  const total = num($('#ctr-total').value);
  const bagPrice = num(settings.bagPrice) || 0;
  const bagVal = $('#ctr-bag-purchased').checked ? Math.min(bagPrice, total) : 0;
  $('#ctr-bag').value = bagVal ? Math.round(bagVal*100)/100 : 0;
  $('#ctr-course').value = Math.round((total-bagVal)*100)/100;
}
$('#ctr-total').addEventListener('input', recalcCtrSplit);
$('#ctr-bag-purchased').addEventListener('change', recalcCtrSplit);

$('#ctrainee-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const t = companyTransfers.find(x=>x.id===ctraineeTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); return; }
  const clientId = $('#ctr-id').value.trim();
  if(!clientId){ showToast('أدخل رقم الهوية'); return; }
  if(!/^\d{10}$/.test(clientId)){ showToast('رقم الهوية يجب أن يتكون من 10 أرقام بالضبط (نفس تنسيق شيت العملاء) — تأكّد منه حتى يرتبط بسجل العميل الصحيح'); return; }
  const courseValue = num($('#ctr-course').value);
  const bagValue = num($('#ctr-bag').value);
  const invoiceNo = $('#ctr-invoice').value.trim();
  if(courseValue<=0 && bagValue<=0){ showToast('أدخل قيمة الدورة أو قيمة الحقيبة'); return; }

  if(ctEditingTraineeId){
    const tr = (t.trainees||[]).find(x=>x.id===ctEditingTraineeId);
    if(!tr){ showToast('تعذّر إيجاد المتدرب'); return; }
    snapshotState(`تعديل بيانات متدرب لحوالة الشركة: ${t.companyName}`);
    let client = clients.find(x=>x.clientId===clientId);
    const name = $('#ctr-name').value.trim();
    const nat = $('#ctr-nat').value;
    if(client){
      if(name) client.name = name;
      if(nat) client.nationality = nat;
      // ربط العميل تلقائياً بهذه الشركة حتى يظهر عند الفلترة بها في شيت العملاء
      if(client.companyName!==t.companyName || client.clientType!=='company'){
        client.clientType = 'company';
        client.companyName = t.companyName;
      }
      // ترحيل قيمة تخصيصه في الحوالة إلى قيمة الدورة/المدفوع في سجله بشيت العملاء
      if(invoiceNo) client.invoice = invoiceNo;
      syncClientValueFromTraineeAllocation(client, courseValue, bagValue, t);
    }else if(name){
      // إن لم يوجد سجل عميل ولكن تم إدخال اسم أثناء التعديل، يُنشأ السجل الآن
      client = {
        id: uid(), createdAt: Date.now(), createdBy: currentUser,
        clientId, name, phone:'', nationality: nat||'',
        clientType:'company', companyName: t.companyName, creditDays:'',
        clientTaxNumber:'', courseType:'', courseNumber:'',
        referNum:'', invoice: invoiceNo, bagInvoice:'',
        date: t.date || todayISO(),
        coursePrice: courseValue, bagSource: bagValue>0?'stock':'own', bagPrice: bagValue,
        bagStatus: bagValue>0?'purchased':'n/a', bagPurchaseDate: bagValue>0?(t.date||todayISO()):undefined, discount:0, paid: courseValue+bagValue,
        companyTransferAllocated: true,
        channel:(()=>{ const ch = settings.channels.find(c=>c.name===t.channel); return ch ? ch.name : 'تحويل بنكي (شركة)'; })(), networkInvoice:'', paid2:0, channel2:'', networkInvoice2:'',
        stage:'جديد', cancelled:false,
        notes: `أُضيف تلقائياً (أثناء تعديل) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
      };
      clients.push(client);
      if(bagValue>0){
        bagStock.push({
          id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
          date: client.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: client.id, issuedClientName: client.name,
          notes: `تسليم من المخزون للعميل: ${client.name} (استيراد متدربي حوالة الشركة "${t.companyName}")`
        });
        recalcBagFundLedger();
        await saveBagStock();
        await saveSettings();
      }
    }
    if(client){ await saveClients(); await saveVaultTx(); }

    tr.courseValue = courseValue;
    tr.bagValue = bagValue;
    await saveCompanyTransfers();
    await logAudit('edit','تحويلات الشركات', `تم تعديل بيانات متدرب (${clientId}) في حوالة الشركة "${t.companyName}"`);

    $('#ctrainee-overlay').classList.remove('show');
    ctraineeTargetTransferId = null; ctEditingTraineeId = null;
    $('#ctr-id').readOnly = false;
    renderCompanies(); renderVault(); renderTable();
    if($('#vault-company-transfer-overlay').classList.contains('show')) openVaultCompanyTransferDetail(t.id);
    showToast('تم تحديث بيانات المتدرب');
    return;
  }

  // منع تكرار إضافة نفس المتدرب (بنفس رقم الهوية) في أكثر من حوالة شركة — أو نفس الحوالة مرتين
  const dupTransfer = companyTransfers.find(tt => (tt.trainees||[]).some(tr=>tr.clientId===clientId));
  if(dupTransfer){
    showToast(`هذا المتدرب (${clientId}) مُضاف مسبقاً في حوالة الشركة "${dupTransfer.companyName}" بتاريخ ${dupTransfer.date||'—'} — لا يمكن إضافته لحوالة أخرى لتجنّب التكرار. إن أردت تعديل بياناته استخدم زر "تعديل" في تلك الحوالة.`);
    return;
  }

  snapshotState(`إضافة متدرب لحوالة الشركة: ${t.companyName}`);
  let client = clients.find(x=>x.clientId===clientId);
  const traineeId = uid();
  const payChannel0 = settings.channels.find(ch=>ch.name===t.channel);
  const payMethod0 = payChannel0 ? payChannel0.name : 'تحويل بنكي (شركة)';

  if(!client){
    // لا يوجد سجل عميل بهذا الرقم بعد — نُنشئ سجلاً كاملاً في شيت العملاء (عميل شركات) حتى يظهر عند الفلترة بالشركة
    client = {
      id: uid(), createdAt: Date.now(), createdBy: currentUser,
      clientId, name: $('#ctr-name').value.trim() || `متدرب شركة (${clientId})`,
      phone:'', nationality: $('#ctr-nat').value || '',
      clientType:'company', companyName: t.companyName, creditDays:'',
      clientTaxNumber:'', courseType:'', courseNumber:'',
      referNum:'', invoice: invoiceNo, bagInvoice:'',
      date: t.date || todayISO(),
      coursePrice: courseValue,
      bagSource: bagValue>0 ? 'stock' : 'own',
      bagPrice: bagValue,
      bagStatus: bagValue>0 ? 'purchased' : 'n/a',
      bagPurchaseDate: bagValue>0 ? (t.date||todayISO()) : undefined,
      discount: 0,
      paid: courseValue+bagValue,
      companyTransferAllocated: true,
      channel:payMethod0, networkInvoice:'',
      paid2:0, channel2:'', networkInvoice2:'',
      stage:'جديد', cancelled:false,
      notes: `أُضيف تلقائياً من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
    };
    clients.push(client);
    if(bagValue>0){
      bagStock.push({
        id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
        date: client.bagPurchaseDate, createdAt: Date.now(),
        issuedClientId: client.id, issuedClientName: client.name,
        notes: `تسليم من المخزون للعميل: ${client.name} (استيراد متدربي حوالة الشركة "${t.companyName}")`
      });
      recalcBagFundLedger();
      await saveBagStock();
      await saveSettings();
    }
    await saveClients();
  }else{
    // العميل موجود بالفعل بشيت العملاء — نربطه تلقائياً بهذه الشركة إن لزم، ونرحّل قيمة تخصيصه بالحوالة لسجله
    if(client.companyName!==t.companyName || client.clientType!=='company'){
      client.clientType = 'company';
      client.companyName = t.companyName;
    }
    if(invoiceNo) client.invoice = invoiceNo;
    syncClientValueFromTraineeAllocation(client, courseValue, bagValue, t);
    await saveClients();
    await saveVaultTx();
  }

  t.trainees = t.trainees || [];
  t.trainees.push({id:traineeId, clientId, courseValue, bagValue, createdBy: currentUser});
  await saveCompanyTransfers();
  await logAudit('add','تحويلات الشركات', `تمت إضافة متدرب (${clientId}) لحوالة الشركة "${t.companyName}" بإجمالي ${fmt(courseValue+bagValue)} ﷼ (ضمن القيد المالي الواحد المسجَّل للحوالة)`);

  $('#ctrainee-overlay').classList.remove('show'); ctraineeTargetTransferId=null;
  renderCompanies(); renderVault(); renderTable();
  if($('#vault-company-transfer-overlay').classList.contains('show')) openVaultCompanyTransferDetail(t.id);
  showToast('تمت إضافة المتدرب');
});

document.addEventListener('change', async e=>{
  if(!e.target.dataset.transferbagall) return;
  const transferId = e.target.dataset.transferbagall;
  const t = companyTransfers.find(x=>x.id===transferId);
  if(!t) return;
  const checked = e.target.checked;
  const bagPrice = num(settings.bagPrice) || 0;
  snapshotState(`${checked?'تفعيل':'إلغاء'} شراء الحقيبة لكل متدربي حوالة الشركة: ${t.companyName}`);
  t.bagForAll = checked;
  let changed = 0;
  let clientsChanged = false;
  (t.trainees||[]).forEach(tr=>{
    const total = num(tr.courseValue) + num(tr.bagValue);
    const newBag = checked ? Math.min(bagPrice, total) : 0;
    const newCourse = Math.round((total-newBag)*100)/100;
    if(newBag!==num(tr.bagValue) || newCourse!==num(tr.courseValue)){
      tr.bagValue = newBag ? Math.round(newBag*100)/100 : 0;
      tr.courseValue = newCourse;
      changed++;
      const client = clients.find(x=>x.clientId===tr.clientId);
      if(client){ syncClientValueFromTraineeAllocation(client, tr.courseValue, tr.bagValue, t); clientsChanged = true; }
    }
  });
  if(clientsChanged){ await saveClients(); await saveVaultTx(); }
  await saveCompanyTransfers();
  await logAudit('edit','تحويلات الشركات', `${checked?'تفعيل':'إلغاء'} تقسيم الحقيبة لكل متدربي حوالة الشركة "${t.companyName}" — تم تعديل ${changed} متدرب`);
  renderCompanies();
  showToast(checked ? `تم تقسيم المبلغ لـ${changed} متدرب (قيمة الحقيبة ${fmt(bagPrice)} ﷼ لكل متدرب)` : `تم إلغاء تقسيم الحقيبة لـ${changed} متدرب`);
});

document.addEventListener('click', async e=>{
  if(e.target.dataset.addtrainee){
    ctraineeTargetTransferId = e.target.dataset.addtrainee;
    ctEditingTraineeId = null;
    $('#ctrainee-modal-title').textContent = 'إضافة متدرب للحوالة';
    $('#ctr-id').readOnly = false;
    const t = companyTransfers.find(x=>x.id===ctraineeTargetTransferId);
    const share = (t && num(t.traineeCount)>0) ? num(t.amount)/num(t.traineeCount) : 0;
    $('#ctr-id').value = '';
    $('#ctr-name').value = '';
    $('#ctr-invoice').value = '';
    populateSelect($('#ctr-nat'), settings.nationalities, true);
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
    $('#ctr-total').value = share ? Math.round(share*100)/100 : '';
    $('#ctr-bag-purchased').checked = !!(t && t.bagForAll);
    recalcCtrSplit();
    $('#ctr-client-info').textContent = 'لم يتم العثور على العميل بعد — إن أكملت الاسم والجنسية أدناه سيُضاف تلقائياً كعميل شركات جديد في شيت العملاء.';
    $('#ctrainee-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.viewcompanytransfer){
    openVaultCompanyTransferDetail(e.target.dataset.viewcompanytransfer);
  }
  if(e.target.dataset.edittrainee){
    const [transferId, traineeId] = e.target.dataset.edittrainee.split('|');
    const t = companyTransfers.find(x=>x.id===transferId);
    const tr = t && (t.trainees||[]).find(x=>x.id===traineeId);
    if(!t || !tr){ showToast('تعذّر تحديد المتدرب'); return; }
    ctraineeTargetTransferId = transferId;
    ctEditingTraineeId = traineeId;
    $('#ctrainee-modal-title').textContent = 'تعديل بيانات متدرب';
    $('#ctr-id').value = tr.clientId;
    $('#ctr-id').readOnly = true; // لا يُسمح بتغيير رقم الهوية أثناء التعديل لتفادي فقدان الربط بالمتدرب
    const c = clients.find(x=>x.clientId===tr.clientId);
    $('#ctr-name').value = c ? c.name : '';
    populateSelect($('#ctr-nat'), settings.nationalities, true);
    $('#ctr-nat').value = c ? (c.nationality||'') : '';
    $('#ctr-invoice').value = c ? (c.invoice||'') : '';
    $('#wrap-ctr-newclient').style.display = '';
    $('#wrap-ctr-newclient2').style.display = '';
    $('#ctr-client-info').textContent = c
      ? `العميل: ${escapeHtml(c.name)} — ${escapeHtml(c.phone||'—')} — ${escapeHtml(c.nationality||'—')}`
      : 'لا يوجد سجل عميل لهذا المتدرب بعد — يمكنك تعبئة الاسم والجنسية لإنشائه الآن.';
    const total = num(tr.courseValue) + num(tr.bagValue);
    $('#ctr-total').value = total ? Math.round(total*100)/100 : '';
    $('#ctr-bag-purchased').checked = num(tr.bagValue)>0;
    $('#ctr-course').value = num(tr.courseValue);
    $('#ctr-bag').value = num(tr.bagValue);
    $('#ctrainee-overlay').classList.add('show'); SoundFX.open();
  }
  if(e.target.dataset.importtrainees){
    ctImportTargetTransferId = e.target.dataset.importtrainees;
    $('#import-trainees-input').click();
  }
  if(e.target.dataset.importtraineestext){
    ctImportTextTargetTransferId = e.target.dataset.importtraineestext;
    openCtitModal();
  }
  if(e.target.dataset.deltrainee){
    const [transferId, traineeId] = e.target.dataset.deltrainee.split('|');
    const t = companyTransfers.find(x=>x.id===transferId);
    if(t && await customConfirm('حذف هذا المتدرب من الحوالة؟ (لن يؤثر على القيد المالي الإجمالي للحوالة نفسها).')){
      const tr = (t.trainees||[]).find(x=>x.id===traineeId);
      snapshotState(`حذف متدرب من حوالة الشركة: ${t.companyName}`);
      t.trainees = (t.trainees||[]).filter(x=>x.id!==traineeId);
      let unlinked = false;
      if(tr) unlinked = await unlinkClientFromCompanyTransferIfOrphaned(tr.clientId, t.id);
      if(unlinked) await saveClients();
      await saveCompanyTransfers();
      await logAudit('delete','تحويلات الشركات', `تم حذف متدرب (${tr?tr.clientId:''}) من حوالة الشركة "${t.companyName}"${unlinked?' — وتم تصفير قيمة تخصيصه في شيت العملاء لعدم ارتباطه بأي حوالة أخرى':''}`);
      renderCompanies();
      if($('#vault-company-transfer-overlay').classList.contains('show')) openVaultCompanyTransferDetail(t.id);
      showToast('تم الحذف');
    }
  }
  if(e.target.dataset.linktrainee){
    const [transferId, traineeId] = e.target.dataset.linktrainee.split('|');
    await linkSingleTraineeToClient(transferId, traineeId);
  }
  if(e.target.id==='btn-link-unlinked-persons'){
    await linkAllUnlinkedTrainees();
  }
  if(e.target.dataset.deltransfer){
    const transferId = e.target.dataset.deltransfer;
    const t = companyTransfers.find(x=>x.id===transferId);
    if(t && await customConfirm(`حذف حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''} كاملة مع كل المتدربين المرتبطين بها والقيد المالي المرتبط؟`)){
      snapshotState(`حذف حوالة شركة: ${t.companyName}`);
      let unlinkedCount = 0;
      for(const tr of (t.trainees||[])){
        if(await unlinkClientFromCompanyTransferIfOrphaned(tr.clientId, transferId)) unlinkedCount++;
      }
      if(unlinkedCount) await saveClients();
      vaultTx = vaultTx.filter(v=>v.companyTransferId!==transferId);
      companyTransfers = companyTransfers.filter(x=>x.id!==transferId);
      await saveVaultTx();
      await saveCompanyTransfers();
      await logAudit('delete','تحويلات الشركات', `تم حذف حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''} بقيمة ${fmt(num(t.amount))}${unlinkedCount?` — وتم تصفير تخصيص ${unlinkedCount} متدرب في شيت العملاء لعدم ارتباطهم بأي حوالة أخرى`:''}`);
      renderCompanies(); renderVault();
      showToast('تم حذف الحوالة');
    }
  }
  if(e.target.dataset.edittransfer){
    openTransferEdit(e.target.dataset.edittransfer);
  }
  if(e.target.dataset.delcompany){
    const id = e.target.dataset.delcompany;
    const c = companies.find(x=>x.id===id);
    const hasTransfers = companyTransfers.some(t=>t.companyId===id);
    if(hasTransfers){ showToast('لا يمكن حذف شركة لديها حوالات مسجّلة — احذف حوالاتها أولاً'); return; }
    if(c && await customConfirm(`حذف الشركة "${c.name}" من القائمة؟`)){
      snapshotState(`حذف شركة: ${c.name}`);
      companies = companies.filter(x=>x.id!==id);
      await saveCompanies();
      await logAudit('delete','تحويلات الشركات', `تم حذف الشركة: ${c.name}`);
      if(editingCompanyId===id) resetCompanyForm();
      renderCompanies();
      showToast('تم الحذف');
    }
  }
  if(e.target.dataset.printcompany){
    printCompanyStatement(e.target.dataset.printcompany);
  }
  if(e.target.dataset.importcompanytrainees){
    const companyId = e.target.dataset.importcompanytrainees;
    const company = companies.find(c=>c.id===companyId);
    if(!company){ showToast('تعذّر إيجاد الشركة'); return; }
    if(!companyTransfers.some(t=>t.companyId===companyId)){ showToast('لا توجد حوالات مسجّلة لهذه الشركة بعد — أضف حوالة أولاً'); return; }
    ctImportCompanyTargetId = companyId;
    $('#import-company-trainees-input').click();
  }
  if(e.target.dataset.mergecompany){
    const sourceId = e.target.dataset.mergecompany;
    const source = companies.find(x=>x.id===sourceId);
    if(!source){ showToast('تعذّر إيجاد الشركة'); return; }
    const otherNames = companies.filter(x=>x.id!==sourceId).map(x=>x.name);
    if(!otherNames.length){ showToast('لا توجد شركة أخرى لدمجها معها'); return; }
    const targetName = await customPrompt(
      `دمج شركة "${source.name}" في شركة أخرى موجودة — سيتم نقل كل حوالاتها ومتدربيها والعملاء المرتبطين بها إلى الشركة الهدف، ثم حذف "${source.name}" نهائياً.\nاكتب الاسم الدقيق للشركة الهدف من هذه القائمة:\n${otherNames.join('، ')}`,
      {title:'دمج شركات مكررة', required:true, placeholder:'اكتب اسم الشركة الهدف بالضبط'}
    );
    if(targetName===null) return;
    const target = companies.find(x=>x.name===targetName.trim());
    if(!target){ showToast('لم يتم العثور على شركة بهذا الاسم بالضبط — تأكد من كتابته كما هو باللائحة'); return; }
    if(target.id===source.id){ showToast('لا يمكن دمج الشركة مع نفسها'); return; }
    const affectedTransfers = companyTransfers.filter(t=>t.companyId===source.id).length;
    const affectedClients = clients.filter(cl=>cl.clientType==='company' && cl.companyName===source.name).length;
    if(!await customConfirm(`تأكيد دمج "${source.name}" في "${target.name}"؟ سيتم نقل ${affectedTransfers} حوالة و${affectedClients} عميل، ثم حذف "${source.name}" نهائياً. هذا الإجراء لا يمكن التراجع عنه.`)) return;
    snapshotState(`دمج شركة: ${source.name} في ${target.name}`);
    let movedTransfers = 0;
    companyTransfers.forEach(t=>{ if(t.companyId===source.id){ t.companyId = target.id; t.companyName = target.name; movedTransfers++; } });
    let movedClients = 0;
    clients.forEach(cl=>{ if(cl.clientType==='company' && cl.companyName===source.name){ cl.companyName = target.name; movedClients++; } });
    // دمج الفئات المتفق عليها من الشركة المصدر إن لم تكن موجودة بنفس الاسم بالشركة الهدف مسبقاً
    if(source.categories && source.categories.length){
      target.categories = target.categories || [];
      source.categories.forEach(sc=>{
        if(!target.categories.some(tc=>tc.label===sc.label)) target.categories.push({label:sc.label, amount:sc.amount});
      });
    }
    companies = companies.filter(x=>x.id!==source.id);
    await saveCompanyTransfers();
    await saveClients();
    await saveCompanies();
    await logAudit('edit','تحويلات الشركات', `تم دمج الشركة "${source.name}" في "${target.name}" — نُقلت ${movedTransfers} حوالة و${movedClients} عميل، وحُذفت "${source.name}" نهائياً`);
    if(editingCompanyId===source.id) resetCompanyForm();
    renderCompanies(); renderTable();
    showToast(`تم الدمج بنجاح: ${movedTransfers} حوالة و${movedClients} عميل انتقلوا لـ"${target.name}"`);
    return;
  }
  if(e.target.dataset.editcompany){
    const id = e.target.dataset.editcompany;
    const c = companies.find(x=>x.id===id);
    if(!c){ showToast('تعذّر إيجاد الشركة'); return; }
    editingCompanyId = id;
    $('#cm-name').value = c.name || '';
    $('#cm-tax').value = c.taxNumber || '';
    $('#cm-amount').value = c.agreedAmount || '';
    cmCats = (c.categories||[]).map(cc=>({id:uid(), label:cc.label, amount:cc.amount}));
    renderCmCats();
    $('#btn-add-company').textContent = 'تحديث بيانات الشركة';
    $('#btn-cancel-edit-company').style.display = '';
    $('#cm-name').scrollIntoView({behavior:'smooth', block:'center'});
    showToast('عدّل البيانات ثم اضغط "تحديث بيانات الشركة"');
  }
});

/* ---------------- ربط متدرب حالي (موجود ضمن حوالة شركة) بشيت العملاء إن لم يكن مرتبطاً ----------------
   يُستخدم لإصلاح حوالات قديمة أُضيف لها متدربون قبل ربطهم تلقائياً بشيت العملاء، أو أي حالة أخرى
   تسبّب فيها فقدان الربط. يُنشئ سجل عميل كامل بنفس منطق الإنشاء التلقائي المستخدَم عند إضافة متدرب جديد. */
/* يرحّل قيمة تخصيص متدرب (قيمة الدورة/الحقيبة) من حوالة الشركة إلى سجله في شيت العملاء —
   يُستبدل دائماً بقيمة تخصيصه في الحوالة (المصدر الرسمي لهذه القيمة)، بدون إنشاء أي قيد مالي/خزنة
   جديد (المبلغ مُرحَّل بالفعل لمرة واحدة ضمن القيد الموحّد لكامل الحوالة). نُعلِّم السجل بعلامة
   companyTransferAllocated=true حتى لا تُنشئ آلية "الترحيل التلقائي لقيد العميل" (syncClientLedgerEntry)
   قيداً إضافياً مكرراً بنفس المبلغ عند أي حفظ/تحديث لاحق لهذا العميل (تحديث شامل، تعديل، استيراد...). */
function syncClientValueFromTraineeAllocation(client, courseValue, bagValue, transfer){
  if(!client) return;
  client.coursePrice = num(courseValue);
  client.bagPrice = num(bagValue);
  client.paid = num(courseValue) + num(bagValue);
  client.companyTransferAllocated = true;
  // طريقة الدفع تُرحَّل دائماً من طريقة الدفع المُحدَّدة لحوالة الشركة نفسها (transfer.channel)،
  // بدل تركها بدون قيمة — وهو سبب ظهور عمود "طريقة الدفع" فارغاً في شيت العملاء لمتدربي الشركات:
  // القيد المالي الفعلي أصبح قيداً موحّداً واحداً للحوالة كاملة (companyTransferId) وليس قيداً
  // فردياً لكل متدرب، فلم تعد paymentChannelsLabel() تجده عند البحث في الحركات المالية بحسب رقم
  // هوية العميل، وكانت تعتمد حينها على client.channel الذي لم يكن يُضبَط هنا إطلاقاً.
  if(transfer){
    const ch = settings.channels.find(c=>c.name===transfer.channel);
    client.channel = ch ? ch.name : (transfer.channel || 'تحويل بنكي (شركة)');
  }
  // إن كان هذا العميل مسجَّلاً بالفعل قبل انضمامه لحوالة الشركة (وله قيد فردي تلقائي قديم في الحركات
  // المالية بمبلغ مختلف)، يجب حذف هذا القيد فوراً هنا، وليس الانتظار لدالة التنظيف عند التحميل التالي
  // فقط — وإلا يظهر للمستخدم "قيد مكرر" (القيد الفردي القديم + قيد الحوالة الموحّد) حتى يُعاد تحميل الصفحة.
  removeClientLedgerEntries(client.id);
}
/* ================= إصلاح: إلغاء ربط عميل بحوالة شركة عند حذف متدربه منها (أو حذف الحوالة كلها) =================
   عند حذف متدرب من حوالة، أو حذف الحوالة بالكامل، كان سجل العميل في شيت العملاء يبقى بلا تغيير:
   لا يزال companyTransferAllocated=true وقيمه (coursePrice/bagPrice/paid) هي نفس القيم القديمة —
   رغم أن المبلغ لم يعد مُرحَّلاً له من أي حوالة فعلية. النتيجة: العميل يظهر "مسدَّد بالكامل" (متبقي=0)
   رغم أن ماله لم يعد موجوداً ضمن أي قيد مالي حقيقي مرتبط به — وهو عكس مشكلة "متبقي عليه" الأصلية،
   لكن بنفس الجذر (تضارب بين حالة العميل وحالة الحوالة الفعلية).
   الحل: بعد الحذف، نتحقق: هل هذا العميل لا يزال ضمن متدربي أي حوالة شركة أخرى؟ إن لم يكن، تُصفَّر
   قيمه المُزامَنة من الحوالة، وتُلغى عملية تسليم الحقيبة من المخزون المرتبطة به إن وُجدت (حتى ترجع
   الحقيبة لرصيد المخزون المتاح ولا يبقى خصم بلا مقابل)، حتى يعود العميل لحالة طبيعية يمكن تسجيل
   مدفوعاته فيها يدوياً من جديد إن لزم. */
async function unlinkClientFromCompanyTransferIfOrphaned(clientId, excludeTransferId){
  const stillLinked = companyTransfers.some(tt => tt.id!==excludeTransferId && (tt.trainees||[]).some(tr=>tr.clientId===clientId));
  if(stillLinked) return false;
  const client = clients.find(c=>c.clientId===clientId);
  if(!client || !client.companyTransferAllocated) return false;
  if(client.bagSource==='stock'){
    const stIdx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===client.id);
    if(stIdx>-1){ bagStock.splice(stIdx,1); recalcBagFundLedger(); await saveBagStock(); }
  }
  client.companyTransferAllocated = false;
  client.coursePrice = 0; client.bagPrice = 0; client.paid = 0;
  client.bagSource = 'own'; client.bagStatus = 'n/a';
  delete client.bagPurchaseDate;
  return true;
}
function createClientForUnlinkedTrainee(t, tr){
  const payChannel0 = settings.channels.find(ch=>ch.name===t.channel);
  const payMethod0 = payChannel0 ? payChannel0.name : 'تحويل بنكي (شركة)';
  const bagValue = num(tr.bagValue);
  const client = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId: tr.clientId, name: `متدرب شركة (${tr.clientId})`,
    phone:'', nationality:'',
    clientType:'company', companyName: t.companyName, creditDays:'',
    clientTaxNumber:'', courseType:'', courseNumber:'',
    referNum:'', invoice:'', bagInvoice:'',
    date: t.date || todayISO(),
    coursePrice: num(tr.courseValue),
    bagSource: bagValue>0 ? 'stock' : 'own',
    bagPrice: bagValue,
    bagStatus: bagValue>0 ? 'purchased' : 'n/a',
    bagPurchaseDate: bagValue>0 ? (t.date||todayISO()) : undefined,
    discount: 0,
    paid: num(tr.courseValue)+bagValue,
    companyTransferAllocated: true,
    channel: payMethod0, networkInvoice:'',
    paid2:0, channel2:'', networkInvoice2:'',
    stage:'جديد', cancelled:false,
    notes: `تم ربطه يدوياً بشيت العملاء من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
  };
  clients.push(client);
  if(bagValue>0){
    bagStock.push({
      id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
      date: client.bagPurchaseDate, createdAt: Date.now(),
      issuedClientId: client.id, issuedClientName: client.name,
      notes: `تسليم من المخزون للعميل: ${client.name} (ربط يدوي من حوالة الشركة "${t.companyName}")`
    });
  }
  return client;
}
async function linkSingleTraineeToClient(transferId, traineeId){
  const t = companyTransfers.find(x=>x.id===transferId);
  const tr = t && (t.trainees||[]).find(x=>x.id===traineeId);
  if(!t || !tr){ showToast('تعذّر تحديد المتدرب'); return; }
  if(clients.some(c=>c.clientId===tr.clientId)){ showToast('هذا المتدرب مرتبط بالفعل بشيت العملاء'); return; }
  snapshotState(`ربط متدرب بشيت العملاء: ${tr.clientId}`);
  const client = createClientForUnlinkedTrainee(t, tr);
  if(num(tr.bagValue)>0){ recalcBagFundLedger(); await saveBagStock(); await saveSettings(); }
  await saveClients();
  await logAudit('add','تحويلات الشركات', `تم ربط المتدرب (${tr.clientId}) بشيت العملاء يدوياً من حوالة الشركة "${t.companyName}" — تم إنشاء سجل عميل باسم مؤقت (${client.name}) يمكن تعديله من شيت العملاء`);
  renderCompanies(); renderTable();
  if($('#vault-company-transfer-overlay').classList.contains('show')) openVaultCompanyTransferDetail(t.id);
  showToast('تم الربط بشيت العملاء');
}
async function linkAllUnlinkedTrainees(){
  const targets = [];
  companyTransfers.forEach(t=> (t.trainees||[]).forEach(tr=>{ if(!clients.some(c=>c.clientId===tr.clientId)) targets.push({t,tr}); }));
  if(!targets.length){ showToast('كل المتدربين مرتبطون بالفعل بشيت العملاء'); return; }
  if(!await customConfirm(`سيتم إنشاء ${targets.length} سجل عميل جديد في شيت العملاء (بأسماء مؤقتة قابلة للتعديل لاحقاً) لكل متدرب غير مرتبط حالياً. متابعة؟`)) return;
  snapshotState(`ربط ${targets.length} متدرب غير مرتبط بشيت العملاء دفعة واحدة`);
  let bagAdded = false;
  targets.forEach(({t,tr})=>{ createClientForUnlinkedTrainee(t,tr); if(num(tr.bagValue)>0) bagAdded=true; });
  if(bagAdded){ recalcBagFundLedger(); await saveBagStock(); await saveSettings(); }
  await saveClients();
  await logAudit('add','تحويلات الشركات', `تم ربط ${targets.length} متدرب دفعة واحدة بشيت العملاء (من مختلف حوالات الشركات) — بأسماء مؤقتة قابلة للتعديل`);
  renderCompanies(); renderTable();
  showToast(`تم ربط ${targets.length} متدرب بشيت العملاء`);
}

/* ---------------- استيراد متدربين مجمّع لحوالة شركة (Excel) ---------------- */
$('#btn-template-trainees').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_متدربين_لحوالة_شركة.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'الاسم':'محمد أحمد', 'الجنسية':'Yemeni', 'المبلغ الإجمالي':980, 'رقم الفاتورة':'', 'شراء الحقيبة':'نعم'},
    {'رقم الهوية':'2345678901', 'الاسم':'', 'الجنسية':'', 'المبلغ الإجمالي':'', 'رقم الفاتورة':'', 'شراء الحقيبة':''}
  ]);
});
/* منطق مشترك لاستيراد مجمّع لمتدربين لحوالة شركة — يُستخدم من مصدر Excel أو من اللصق النصي المباشر.
   json: مصفوفة صفوف بنفس مفاتيح نموذج الاستيراد: 'رقم الهوية' (إلزامي)، 'المبلغ الإجمالي'، 'الاسم'، 'الجنسية'، 'شراء الحقيبة' */
async function importTraineeRowsIntoTransfer(t, json, snapshotLabel, auditLabel){
  const share = num(t.traineeCount)>0 ? num(t.amount)/num(t.traineeCount) : 0;
  const bagPrice = num(settings.bagPrice) || 0;
  const payChannel0 = settings.channels.find(ch=>ch.name===t.channel);
  const payMethod0 = payChannel0 ? payChannel0.name : 'تحويل بنكي (شركة)';

  snapshotState(snapshotLabel);
  t.trainees = t.trainees || [];
  let added=0, skipped=0, newClients=0, bagsIssuedFromStock=0;
  const changedRows = [];
  for(const row of json){
    const clientId = String(row['رقم الهوية']||'').trim();
    if(!clientId){ skipped++; continue; }
    if(!/^\d{10}$/.test(clientId)){ skipped++; continue; } // رقم هوية غير صحيح الصيغة (يجب أن يكون 10 أرقام بالضبط) — يُتخطى لتجنّب إنشاء سجل عميل مكرر/غير مرتبط
    if(t.trainees.some(x=>x.clientId===clientId)){ skipped++; continue; } // موجود مسبقاً في نفس الحوالة
    if(companyTransfers.some(tt=>tt.id!==t.id && (tt.trainees||[]).some(x=>x.clientId===clientId))){ skipped++; continue; } // موجود مسبقاً في حوالة شركة أخرى — لتجنّب التكرار

    const rawTotal = String(row['المبلغ الإجمالي']||'').trim();
    const total = rawTotal ? num(rawTotal) : share;
    const bagCell = String(row['شراء الحقيبة']||'').trim();
    const wantsBag = bagCell ? /^(نعم|ن|yes|y|1|true)$/i.test(bagCell) : !!t.bagForAll;
    const bagValue = wantsBag ? Math.min(bagPrice, total) : 0;
    const courseValue = Math.round((total-bagValue)*100)/100;
    if(courseValue<=0 && bagValue<=0){ skipped++; continue; }
    const invoiceNo = String(row['رقم الفاتورة']||'').trim();

    let client = clients.find(x=>x.clientId===clientId);
    const traineeId = uid();

    if(!client){
      // لا يوجد سجل عميل بهذا الرقم بعد — نُنشئ سجلاً كاملاً في شيت العملاء (عميل شركات) حتى يظهر عند الفلترة بالشركة
      client = {
        id: uid(), createdAt: Date.now(), createdBy: currentUser,
        clientId, name: String(row['الاسم']||'').trim() || `متدرب شركة (${clientId})`,
        phone:'', nationality: normalizeNationalityValue(row['الجنسية']),
        clientType:'company', companyName: t.companyName, creditDays:'',
        clientTaxNumber:'', courseType:'', courseNumber:'',
        referNum:'', invoice: invoiceNo, bagInvoice:'',
        date: t.date || todayISO(),
        coursePrice: courseValue,
        bagSource: bagValue>0 ? 'stock' : 'own',
        bagPrice: bagValue,
        bagStatus: bagValue>0 ? 'purchased' : 'n/a',
        bagPurchaseDate: bagValue>0 ? (t.date||todayISO()) : undefined,
        discount: 0,
        paid: courseValue+bagValue,
        companyTransferAllocated: true,
        channel:payMethod0, networkInvoice:'',
        paid2:0, channel2:'', networkInvoice2:'',
        stage:'جديد', cancelled:false,
        notes: `أُضيف تلقائياً (استيراد مجمّع) من حوالة الشركة "${t.companyName}" بتاريخ ${t.date||''}`
      };
      clients.push(client);
      newClients++;
      if(bagValue>0){
        bagStock.push({
          id: uid(), createdBy: currentUser, type:'issue', qty:-1, unitPrice:0,
          date: client.bagPurchaseDate, createdAt: Date.now(),
          issuedClientId: client.id, issuedClientName: client.name,
          notes: `تسليم من المخزون للعميل: ${client.name} (استيراد مجمّع لحوالة الشركة "${t.companyName}")`
        });
        bagsIssuedFromStock++;
      }
    }else{
      if(client.companyName!==t.companyName || client.clientType!=='company'){
        client.clientType = 'company';
        client.companyName = t.companyName;
      }
      if(invoiceNo) client.invoice = invoiceNo;
      syncClientValueFromTraineeAllocation(client, courseValue, bagValue, t);
    }

    t.trainees.push({id:traineeId, clientId, courseValue, bagValue, createdBy: currentUser});
    added++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':client?client.name:'', 'قيمة الدورة':courseValue, 'قيمة الحقيبة':bagValue, 'الإجمالي':courseValue+bagValue});
  }
  if(bagsIssuedFromStock>0) recalcBagFundLedger();
  await saveClients();
  await saveVaultTx();
  if(bagsIssuedFromStock>0) await saveBagStock();
  await saveSettings();
  await saveCompanyTransfers();
  await logAudit('add','تحويلات الشركات', `${auditLabel} لحوالة الشركة "${t.companyName}": إضافة ${added} متدرب (${newClients} منهم عملاء جدد في شيت العملاء، و${bagsIssuedFromStock} حقيبة سُلِّمت من المخزون) ضمن القيد المالي الواحد للحوالة${skipped?`، وتخطي ${skipped} صف`:''}`);
  renderCompanies(); renderVault(); renderTable(); renderBags();
  return {added, skipped, changedRows};
}

/* ---------------- استيراد متدربين على مستوى الشركة كاملة (Excel) — يوزَّع كل صف تلقائياً على أقرب حوالة لديها شواغر (حسب الأقدم أولاً) ---------------- */
async function importTraineeRowsIntoCompany(companyId, json){
  const company = companies.find(c=>c.id===companyId);
  if(!company) return {totalAdded:0, totalSkipped:json.length, overflowCount:0, error:'company-not-found'};
  const transfers = companyTransfers.filter(t=>t.companyId===companyId)
    .sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')) || (a.createdAt||0)-(b.createdAt||0));
  if(!transfers.length) return {totalAdded:0, totalSkipped:json.length, overflowCount:0, error:'no-transfers'};

  // نوزّع كل صف على أول حوالة لديها شاغر (عدد متدربينها الحاليين أقل من العدد المستهدف)، وإلا فعلى أحدث حوالة كتجاوز
  const counts = transfers.map(t=>(t.trainees||[]).length);
  const buckets = transfers.map(()=>[]);
  let overflowCount = 0;
  json.forEach(row=>{
    let idx = transfers.findIndex((t,i)=> counts[i] < num(t.traineeCount));
    if(idx===-1){ idx = transfers.length-1; overflowCount++; }
    buckets[idx].push(row);
    counts[idx]++;
  });

  let totalAdded=0, totalSkipped=0;
  for(let i=0;i<transfers.length;i++){
    if(!buckets[i].length) continue;
    const t = transfers[i];
    const {added, skipped} = await importTraineeRowsIntoTransfer(
      t, buckets[i],
      `استيراد مجمّع لمتدربين لشركة "${company.name}" (حوالة بتاريخ ${t.date||'—'})`,
      `استيراد مجمّع على مستوى الشركة "${company.name}"`
    );
    totalAdded += added; totalSkipped += skipped;
  }
  return {totalAdded, totalSkipped, overflowCount};
}
$('#import-company-trainees-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file || !ctImportCompanyTargetId){ e.target.value=''; return; }
  const company = companies.find(c=>c.id===ctImportCompanyTargetId);
  if(!company){ showToast('تعذّر تحديد الشركة'); e.target.value=''; ctImportCompanyTargetId=null; return; }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const {totalAdded, totalSkipped, overflowCount, error} = await importTraineeRowsIntoCompany(company.id, json);
    if(error==='no-transfers'){ showToast('لا توجد حوالات مسجّلة لهذه الشركة'); }
    else showToast(`تم استيراد ${totalAdded} متدرب ووُزِّعوا تلقائياً على حوالات "${company.name}"${totalSkipped?`، وتخطي ${totalSkipped} صف (مكرّر أو ناقص البيانات)`:''}${overflowCount?`، منهم ${overflowCount} أُضيفوا كتجاوز لأحدث حوالة لأن كل الحوالات وصلت لعددها المستهدف`:''}`);
  }catch(err){
    showToast('تعذّر قراءة الملف — تأكد من الصيغة (نفس نموذج استيراد المتدربين)');
  }finally{
    e.target.value = '';
    ctImportCompanyTargetId = null;
  }
});

$('#import-trainees-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file || !ctImportTargetTransferId){ e.target.value=''; return; }
  const t = companyTransfers.find(x=>x.id===ctImportTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); e.target.value=''; return; }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    const {added, skipped, changedRows} = await importTraineeRowsIntoTransfer(
      t, json,
      `استيراد متدربين مجمّع لحوالة الشركة: ${t.companyName}`,
      'استيراد مجمّع لمتدربين (Excel)'
    );
    if(changedRows.length) downloadXlsx(`تقرير_استيراد_متدربين_${stampNow()}.xlsx`, 'تقرير الاستيراد', changedRows);
    showToast(`تم استيراد ${added} متدرب${skipped?`، وتخطي ${skipped} صف (مكرر أو بدون رقم هوية/مبلغ)`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد من وجود عمود "رقم الهوية" على الأقل وأنه بصيغة Excel صحيحة');
  }finally{
    ctImportTargetTransferId = null;
    e.target.value = '';
  }
});

/* ---------------- استيراد متدربين مجمّع لحوالة شركة (جدول خانات مستقلة، بلصق دعم من إكسل) ---------------- */
let ctitRowSeq = 0;
function ctitBagOptionsHtml(selected){
  return `<option value=""></option><option value="نعم"${selected==='نعم'?' selected':''}>نعم</option><option value="لا"${selected==='لا'?' selected':''}>لا</option>`;
}
function ctitRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="ctit-id" data-col="0" placeholder="رقم الهوية/الإقامة" style="min-width:100px;"></td>
    <td><input type="text" class="ctit-name" data-col="1" placeholder="اسم المتدرب" style="min-width:130px;"></td>
    <td><select class="ctit-nat" data-col="2" style="min-width:110px;">${natOptions}</select></td>
    <td><input type="number" step="0.01" class="ctit-amount" data-col="3" placeholder="نصيب افتراضي" style="min-width:100px;"></td>
    <td><input type="text" class="ctit-invoice" data-col="4" placeholder="اختياري" style="min-width:100px;"></td>
    <td><select class="ctit-bag" data-col="5" style="min-width:100px;">${ctitBagOptionsHtml('')}</select></td>
    <td><button type="button" class="btn btn-danger btn-sm ctit-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCtitRow(){
  ctitRowSeq++;
  $('#ctit-table-body').insertAdjacentHTML('beforeend', ctitRowHtml(ctitRowSeq));
}
function openCtitModal(){
  $('#ctit-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCtitRow();
  $('#ctimporttext-overlay').classList.add('show'); SoundFX.open();
}
function closeCtitModal(){ $('#ctimporttext-overlay').classList.remove('show'); ctImportTextTargetTransferId=null; }
$('#ctit-cancel').addEventListener('click', closeCtitModal);
$('#ctimporttext-overlay').addEventListener('click', e=>{ if(e.target.id==='ctimporttext-overlay') closeCtitModal(); });
$('#btn-ctit-add-row').addEventListener('click', addCtitRow);
$('#ctit-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('ctit-remove-row')){
    const rows = $('#ctit-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة داخل جدول استيراد المتدربين، بنفس منطق جدول "إضافة عدة عملاء"
$('#ctit-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return; // لصق خلية واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#ctit-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCtitRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>5) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT'){
        if(field.classList.contains('ctit-bag')){
          const v = val.trim();
          field.value = /^(نعم|ن|yes|y|1|true)$/i.test(v) ? 'نعم' : (/^(لا|ل|no|n|0|false)$/i.test(v) ? 'لا' : '');
        }else setBulkSelectFuzzy(field, val);
      }else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-ctit-save').addEventListener('click', async ()=>{
  if(!ctImportTextTargetTransferId){ showToast('تعذّر تحديد الحوالة'); return; }
  const t = companyTransfers.find(x=>x.id===ctImportTextTargetTransferId);
  if(!t){ showToast('تعذّر تحديد الحوالة'); return; }

  const rows = [...$('#ctit-table-body').querySelectorAll('tr')];
  const json = [];
  rows.forEach(row=>{
    const clientId = row.querySelector('.ctit-id').value.trim();
    if(!clientId) return; // صف فارغ يُتجاهل بصمت
    json.push({
      'رقم الهوية': clientId,
      'المبلغ الإجمالي': row.querySelector('.ctit-amount').value.trim(),
      'الاسم': row.querySelector('.ctit-name').value.trim(),
      'الجنسية': row.querySelector('.ctit-nat').value,
      'رقم الفاتورة': row.querySelector('.ctit-invoice').value.trim(),
      'شراء الحقيبة': row.querySelector('.ctit-bag').value
    });
  });
  if(!json.length){ showToast('أدخل رقم هوية واحداً على الأقل'); return; }

  const {added, skipped} = await importTraineeRowsIntoTransfer(
    t, json,
    `استيراد متدربين (لصق نص) لحوالة الشركة: ${t.companyName}`,
    'استيراد مجمّع لمتدربين (لصق نص مباشرة)'
  );

  closeCtitModal();
  showToast(`تم استيراد ${added} متدرب${skipped?`، وتخطي ${skipped} صف (مكرر أو بدون رقم هوية/مبلغ)`:''}`);
});
/* صوت نقر خفيف موحّد لكل أزرار الحفظ/الإضافة الرئيسية والتبويبات، عبر تفويض حدث واحد بدل ربط كل زر يدوياً */
document.addEventListener('click', e=>{
  const btn = e.target.closest('.btn-primary, .btn-gold, .btn-danger');
  if(btn && !btn.disabled) SoundFX.click();
}, true);

