/* ---------------- شيت فواتير الدورات (مطابقة الفواتير مع الإيصالات) ---------------- */
/* المبالغ المُدخلة (القيمة الفعلية بالإيصال / قيمة الدورة بالنظام) شاملة ضريبة القيمة المضافة أصلاً،
   لذلك تُستخرج الضريبة من داخل المبلغ (÷1.15) وليس تُضاف فوقه، اتساقاً مع باقي حسابات النظام */
function courseInvoiceVat(value){ return vatFromGross(value); }
function courseInvoiceClients(){
  // القاعدة الافتراضية: العميل يظهر في هذا الشيت تلقائياً بمجرد حصوله على "رقم دورة" — قبل
  // حتى إدخال رقم الفاتورة — حتى يمكن متابعته من هنا فوراً، ثم تُحدَّث بياناته (رقم الفاتورة،
  // تاريخ الصدور، القيمة الفعلية...) من شيت العملاء أو من هذا الشيت نفسه لاحقاً.
  // الاستثناء: عميل مُلغى أو موقوف — لا يُرحَّل تلقائياً بمجرد رقم الدورة فقط، لكن لو كان له
  // بالفعل رقم فاتورة مُدخَل مسبقاً (كان مرحّلاً وهو نشط ثم أُلغي/أُوقف لاحقاً) يبقى ظاهراً هنا
  // حتى لا تُفقد متابعة فاتورته، مع توسيمه بوضوح (ملغي/موقوف) بجانب اسمه في الجدول.
  return clients.filter(c=>{
    const hasCourseNumber = String(c.courseNumber||'').trim();
    const hasInvoice = String(c.invoice||'').trim();
    if(c.cancelled || c.suspended) return !!hasInvoice;
    return !!hasCourseNumber;
  });
}
function filteredCourseInvoices(){
  const q = ($('#ci-search')?.value || '').trim().toLowerCase();
  const dfrom = $('#ci-date-from')?.value || '';
  const dto = $('#ci-date-to')?.value || '';
  const diffFilterVals = selectedFilterValues($('#ci-filter-diff'));
  let rows = courseInvoiceClients();
  if(q){
    rows = rows.filter(c=> [c.name,c.clientId,c.invoice].some(v=> String(v||'').toLowerCase().includes(q)));
  }
  if(dfrom) rows = rows.filter(c=> c.receiptIssueDate && c.receiptIssueDate>=dfrom);
  if(dto) rows = rows.filter(c=> c.receiptIssueDate && c.receiptIssueDate<=dto);
  if(diffFilterVals.length){
    rows = rows.filter(c=>{
      const empty = !(num(c.receiptActualValue)>0);
      const match = num(c.receiptActualValue)>0 && Math.abs(num(c.receiptActualValue) - centerIncome(c)) < 0.01;
      const diff = num(c.receiptActualValue)>0 && Math.abs(num(c.receiptActualValue) - centerIncome(c)) >= 0.01;
      return (diffFilterVals.includes('empty') && empty) || (diffFilterVals.includes('match') && match) || (diffFilterVals.includes('diff') && diff);
    });
  }
  rows.sort((a,b)=> (b.receiptIssueDate||b.date||'').localeCompare(a.receiptIssueDate||a.date||''));
  return applyCiColumnSort(rows);
}
/* ---------------- ترتيب بالنقر على رأس العمود (فواتير الدورات) ---------------- */
let ciSortState = { key: null, dir: 1 };
const CI_SORT_GETTERS = {
  name: c => (c.name||'').toLowerCase(),
  clientId: c => (c.clientId||'').toLowerCase(),
  courseType: c => (c.courseType||'').toLowerCase(),
  invoice: c => (c.invoice||'').toLowerCase(),
  date: c => c.receiptIssueDate || c.date || '',
  actual: c => num(c.receiptActualValue),
  vat: c => num(c.receiptActualValue)>0 ? courseInvoiceVat(num(c.receiptActualValue)) : -Infinity,
  system: c => centerIncome(c),
  noVat: c => num(c.receiptActualValue)>0 ? (num(c.receiptActualValue) - courseInvoiceVat(num(c.receiptActualValue))) : -Infinity,
  diff: c => num(c.receiptActualValue)>0 ? (num(c.receiptActualValue) - centerIncome(c)) : -Infinity,
};
function applyCiColumnSort(rows){
  const getter = ciSortState.key && CI_SORT_GETTERS[ciSortState.key];
  if(!getter) return rows;
  return [...rows].sort((a,b)=>{
    const va = getter(a), vb = getter(b);
    if(typeof va === 'number' && typeof vb === 'number') return (va-vb)*ciSortState.dir;
    return String(va).localeCompare(String(vb),'ar') * ciSortState.dir;
  });
}
document.querySelectorAll('#view-courseinvoices thead th.sortable').forEach(th=>{
  th.addEventListener('click', ()=>{
    const key = th.dataset.sort;
    if(ciSortState.key === key){ ciSortState.dir *= -1; }
    else{ ciSortState.key = key; ciSortState.dir = 1; }
    document.querySelectorAll('#view-courseinvoices thead th.sortable').forEach(t=>t.setAttribute('aria-sort','none'));
    th.setAttribute('aria-sort', ciSortState.dir===1 ? 'ascending' : 'descending');
    renderCourseInvoices();
  });
});
let ciPageState = {page:1, sig:''};
function renderCourseInvoices(){
  const body = $('#ci-table-body');
  if(!body) return;
  const all = courseInvoiceClients().filter(matchInvoiceYear);
  const rows = filteredCourseInvoices().filter(matchInvoiceYear);
  if($('#ci-total-count')) $('#ci-total-count').textContent = all.length;
  if($('#ci-filtered-count')) $('#ci-filtered-count').textContent = rows.length;

  // البطاقات أعلى الشيت تُحتسب دائماً بناءً على الفلتر الحالي (rows) لا على كامل السجلات،
  // بحيث تتفاعل مباشرة مع البحث/التاريخ/فلتر المطابقة كلما تغيّر
  const withValue = rows.filter(c=> num(c.receiptActualValue) > 0);
  const totalActual = withValue.reduce((s,c)=> s+num(c.receiptActualValue), 0);
  const totalVat = withValue.reduce((s,c)=> s+courseInvoiceVat(c.receiptActualValue), 0);
  const totalSystem = withValue.reduce((s,c)=> s+centerIncome(c), 0);
  const totalDiff = totalActual - totalSystem;
  const mismatched = withValue.filter(c=> Math.abs(num(c.receiptActualValue) - centerIncome(c)) >= 0.01).length;

  if($('#ci-cards')) $('#ci-cards').innerHTML = `
    <div class="card"><div class="k">عدد فواتير الدورات (حسب الفلتر الحالي)</div><div class="v">${rows.length}</div></div>
    <div class="card"><div class="k">لم تُدخل قيمتها الفعلية بعد</div><div class="v red">${rows.length - withValue.length}</div></div>
    <div class="card"><div class="k">إجمالي القيمة الفعلية (بالإيصالات)</div><div class="v gold">${fmt(totalActual)}</div></div>
    <div class="card"><div class="k">إجمالي ضريبة القيمة المضافة</div><div class="v teal">${fmt(totalVat)}</div></div>
    <div class="card"><div class="k">إجمالي الفرق (فعلي − نظام)</div><div class="v ${Math.abs(totalDiff)>=0.01?'red':''}">${fmt(totalDiff)}</div></div>
    <div class="card"><div class="k">عدد الفواتير غير المطابقة</div><div class="v ${mismatched?'red':''}">${mismatched}</div></div>
  `;

  const ciPageRows = applyGenericPagination('ci', rows, ciPageState, [
    $('#ci-search')?.value, $('#ci-date-from')?.value, $('#ci-date-to')?.value, selectedFilterValues($('#ci-filter-diff'))
  ]);
  body.innerHTML = rows.length ? ciPageRows.map(c=>{
    const actual = num(c.receiptActualValue);
    const hasValue = actual>0;
    const vat = hasValue ? courseInvoiceVat(actual) : 0;
    const sys = centerIncome(c);
    const actualNoVat = hasValue ? (actual - vat) : null;
    const diff = hasValue ? (actual - sys) : null;
    const diffLabel = diff===null ? '—' : fmt(diff);
    const diffColor = diff===null ? '' : (Math.abs(diff)<0.01 ? 'teal' : 'red');
    return `
    <tr>
      <td class="sticky-col sticky-col-2" data-label="العميل">${escapeHtml(c.name||'')}${c.cancelled ? ' <span class="cw-badge danger">ملغي</span>' : (c.suspended ? ' <span class="cw-badge muted">موقوف</span>' : '')}</td>
      <td class="mono" data-label="رقم الهوية">${escapeHtml(c.clientId||'—')}</td>
      <td data-label="الدورة">${escapeHtml(c.courseType||'')}</td>
      <td class="mono" data-label="رقم الفاتورة">${escapeHtml(c.invoice||'—')}</td>
      <td data-label="تاريخ الصدور"><input type="date" class="mono" data-ci-date="${c.id}" value="${c.receiptIssueDate||''}" style="min-width:140px;"></td>
      <td data-label="القيمة الفعلية"><input type="number" step="0.01" class="mono" data-ci-value="${c.id}" value="${c.receiptActualValue!==undefined && c.receiptActualValue!==null && c.receiptActualValue!=='' ? c.receiptActualValue : ''}" placeholder="القيمة من الإيصال" style="min-width:130px;"></td>
      <td class="mono" data-label="الضريبة">${hasValue ? fmt(vat) : '—'}</td>
      <td class="mono" data-label="قيمة النظام">${fmt(sys)}</td>
      <td class="mono" data-label="بدون ضريبة">${actualNoVat===null ? '—' : fmt(actualNoVat)}</td>
      <td class="mono ${diffColor}" data-label="الفرق">${diffLabel}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:20px;">لا توجد فواتير دورات مطابقة — تأكد من تسجيل "رقم الدورة" لكل عميل من شيت العملاء أولاً</td></tr>`;
}
onSearchInput('#ci-search', renderCourseInvoices);
bindGenericPagination('ci', ciPageState, renderCourseInvoices);
$('#ci-date-from')?.addEventListener('input', renderCourseInvoices);
$('#ci-date-to')?.addEventListener('input', renderCourseInvoices);
$('#ci-filter-diff')?.addEventListener('change', renderCourseInvoices);
$('#btn-refresh-course-invoices')?.addEventListener('click', ()=>{ renderCourseInvoices(); showToast('تم تحديث شيت فواتير الدورات'); });
$('#ci-table-body')?.addEventListener('change', async e=>{
  const dateId = e.target.dataset.ciDate;
  const valId = e.target.dataset.ciValue;
  if(dateId){
    const c = clients.find(x=>x.id===dateId);
    if(c){
      snapshotState(`تعديل تاريخ صدور فاتورة الدورة: ${c.name}`);
      c.receiptIssueDate = e.target.value || '';
      const posted = typeof autoPostCourseInvoice==='function' && autoPostCourseInvoice(c);
      await saveClients();
      if(posted) await saveJournalDE();
      await logAudit('edit','فواتير الدورات', `تم تعديل تاريخ صدور فاتورة الدورة للعميل: ${c.name} (${c.invoice||''})${posted?' — ورُحّلت تلقائياً للقيد المزدوج':''}`);
      renderCourseInvoices();
    }
  }
  if(valId){
    const c = clients.find(x=>x.id===valId);
    if(c){
      snapshotState(`تعديل القيمة الفعلية لفاتورة الدورة: ${c.name}`);
      c.receiptActualValue = e.target.value===''? '' : num(e.target.value);
      const posted = typeof autoPostCourseInvoice==='function' && autoPostCourseInvoice(c);
      await saveClients();
      if(posted) await saveJournalDE();
      await logAudit('edit','فواتير الدورات', `تم تعديل القيمة الفعلية (من الإيصال) لفاتورة الدورة للعميل: ${c.name} (${c.invoice||''})${posted?' — ورُحّلت تلقائياً للقيد المزدوج':''}`);
      renderCourseInvoices();
    }
  }
});
function courseInvoiceExportRow(c){
  const actual = num(c.receiptActualValue);
  const hasValue = actual>0;
  const vat = hasValue ? courseInvoiceVat(actual) : 0;
  const sys = centerIncome(c);
  const actualNoVat = hasValue ? (actual - vat) : '';
  return {
    'اسم العميل': c.name||'' ,
    'الحالة': c.cancelled ? 'ملغي' : (c.suspended ? 'موقوف' : ''),
    'رقم الهوية': c.clientId||'',
    'الدورة': c.courseType||'',
    'رقم الفاتورة': c.invoice||'',
    'تاريخ صدور الفاتورة': c.receiptIssueDate||'',
    'القيمة الفعلية بالإيصال': hasValue ? actual : '',
    'ضريبة القيمة المضافة (15%)': hasValue ? Math.round(vat*100)/100 : '',
    'قيمة الدورة بالنظام': sys,
    'القيمة بدون الضريبة': hasValue ? Math.round(actualNoVat*100)/100 : '',
    'الفرق': hasValue ? Math.round((actual-sys)*100)/100 : ''
  };
}
$('#btn-export-course-invoices')?.addEventListener('click', ()=>{
  downloadXlsx('فواتير_الدورات.xlsx', 'فواتير الدورات', filteredCourseInvoices().map(courseInvoiceExportRow));
});
$('#btn-template-ci-import')?.addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_فواتير_الدورات.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم الدورة':'CRS-1001', 'رقم الفاتورة':'INV-2001', 'التاريخ':'2026-02-01', 'القيمة الفعلية للايصال':1000}
  ]);
});
$('#btn-import-ci')?.addEventListener('click', ()=> $('#ci-import-input').click());
$('#ci-import-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد فواتير الدورات من Excel');
    let updated=0, skipped=0, invoiceChanged=0, postedCount=0;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const courseNumber = String(row['رقم الدورة']||'').trim();
      const invoiceNo = String(row['رقم الفاتورة']||'').trim();
      const rawDate = row['التاريخ'];
      const rawValue = row['القيمة الفعلية للايصال'];
      if(!clientId || (!courseNumber && !invoiceNo && !rawDate && rawValue==='')){ skipped++; continue; }
      // البحث أولاً بمطابقة رقم الهوية + رقم الدورة معاً (لتحديد التسجيل الصحيح عند تعدد دورات نفس العميل)،
      // وإن لم يوجد رقم دورة في الملف أو لم تُطابق، نكتفي بمطابقة رقم الهوية وحده
      let c = null;
      if(courseNumber) c = clients.find(x=>x.clientId===clientId && String(x.courseNumber||'').trim()===courseNumber);
      if(!c) c = clients.find(x=>x.clientId===clientId);
      if(!c){ skipped++; continue; }
      const oldInvoice = c.invoice||'';
      const oldDate = c.receiptIssueDate||'';
      const oldValue = c.receiptActualValue||'';
      // رقم الفاتورة (رقم الإيصال) فقط هو ما يُرحَّل ويُربط مع باقي شيتات النظام — أما التاريخ والقيمة الفعلية
      // فيبقى تحديثهما محصوراً داخل شيت فواتير الدورات نفسه فقط
      if(invoiceNo){
        c.invoice = invoiceNo;
        if(invoiceNo!==oldInvoice) invoiceChanged++;
      }
      const newDate = normalizeExcelDate(rawDate);
      if(newDate) c.receiptIssueDate = newDate;
      if(rawValue!==''){ c.receiptActualValue = num(rawValue); }
      if(typeof autoPostCourseInvoice==='function' && autoPostCourseInvoice(c)) postedCount++;
      updated++;
      changedRows.push({
        'رقم الهوية':clientId, 'الاسم':c.name, 'رقم الدورة':c.courseNumber||'',
        'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'',
        'تاريخ الفاتورة (قديم)':oldDate, 'تاريخ الفاتورة (جديد)':c.receiptIssueDate||'',
        'القيمة الفعلية (قديمة)':oldValue, 'القيمة الفعلية (جديدة)':c.receiptActualValue||''
      });
    }
    await saveClients();
    if(postedCount>0) await saveJournalDE();
    await logAudit('edit','فواتير الدورات', `استيراد فواتير الدورات من Excel: تحديث ${updated} سجل${skipped?`، وتخطي ${skipped} صف بدون تطابق`:''}${invoiceChanged?` (تم ترحيل ${invoiceChanged} رقم فاتورة تلقائياً إلى شيت العملاء وربطها بجميع الشيتات)`:''}${postedCount?` — ورُحّلت ${postedCount} فاتورة تلقائياً للقيد المزدوج`:''}`);
    if(invoiceChanged && typeof refreshEverything==='function'){
      // رقم الفاتورة تغيّر فعلياً لسجل واحد أو أكثر → يُحدَّث النظام بالكامل (شيت العملاء، لوحة التحكم، الدورات، التقارير...)
      refreshEverything();
    }else{
      // لا يوجد تغيير في أرقام الفواتير (تحديث تاريخ/قيمة فعلية فقط) → يبقى التحديث محصوراً في شيت فواتير الدورات فقط
      renderCourseInvoices();
    }
    showToast(`تم تحديث ${updated} سجل${skipped?`، ${skipped} تم تخطيه`:''}${invoiceChanged?` — ورُبط ${invoiceChanged} رقم فاتورة بجميع الشيتات`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة "رقم الهوية"، "رقم الدورة"، "رقم الفاتورة"، "التاريخ"، "القيمة الفعلية للايصال"');
  }finally{
    e.target.value = '';
  }
});

// تحويل File إلى base64 (بدون بادئة data:...) — دالة عامة يستخدمها رفع الفواتير بالذكاء
// الاصطناعي أدناه، وإرفاق الفاتورة بالإيميل، وmodule-reports.js أيضاً.
function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(String(r.result).split(',')[1] || '');
    r.onerror = ()=> reject(new Error('تعذّرت قراءة الملف'));
    r.readAsDataURL(file);
  });
}

/* ---------------- رفع فواتير حقيقية (PDF/صور) وقراءتها تلقائياً بالذكاء الاصطناعي ----------------
   يرسل الملفات للخادم (الذي يناديها على Claude API بمفتاحه الخاص المحفوظ على الخادم فقط)،
   ثم يعبّئ النتائج المستخرجة داخل نفس جدول المراجعة المستخدم في "تحديث/استيراد فواتير الدورات (جدول)"
   بدل حفظها مباشرة — بحيث تبقى كل النتائج قابلة للمراجعة والتعديل اليدوي قبل أي حفظ فعلي. */
$('#btn-ci-ai-upload')?.addEventListener('click', ()=> $('#ci-ai-upload-input').click());
$('#ci-ai-upload-input')?.addEventListener('change', async e=>{
  const files = [...(e.target.files||[])];
  if(!files.length) return;
  if(files.length>30){ showToast('الحد الأقصى 30 ملفاً في المرة الواحدة'); e.target.value=''; return; }
  const btn = $('#btn-ci-ai-upload');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = `⏳ جارِ قراءة ${files.length} ملف...`;
  try{
    const payloadFiles = await Promise.all(files.map(async f=>({
      name: f.name,
      mimeType: f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : ''),
      dataBase64: await fileToBase64(f)
    })));
    const res = await serverFetch('/api/ai/read-invoices', {
      method: 'POST',
      body: JSON.stringify({ files: payloadFiles })
    });
    if(!res.ok){
      const errData = await res.json().catch(()=>({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const results = data.results || [];
    const failed = results.filter(r=>r.error);
    const ok = results.filter(r=>!r.error);
    // تعبئة جدول المراجعة (تحديث/استيراد فواتير الدورات دفعة واحدة) بالنتائج المستخرجة
    $('#ci-bulk-table-body').innerHTML = '';
    if(!ok.length){
      addCiBulkRow();
    } else {
      ok.forEach(r=>{
        ciBulkRowSeq++;
        $('#ci-bulk-table-body').insertAdjacentHTML('beforeend', ciBulkRowHtml(ciBulkRowSeq));
        const row = $('#ci-bulk-table-body').lastElementChild;
        row.querySelector('.cib-id').value = r.nationalId || '';
        row.querySelector('.cib-invoice').value = r.invoiceNo || '';
        row.querySelector('.cib-date').value = r.date || '';
        row.querySelector('.cib-value').value = r.actualValue!=null ? r.actualValue : '';
        if(!r.nationalId){
          row.style.background = 'rgba(220,50,50,0.08)';
          row.title = `تعذّر استخراج رقم الهوية من الملف "${r.fileName}" — أدخله يدوياً`;
        } else if(r.confidence==='low'){
          row.style.background = 'rgba(230,180,30,0.10)';
          row.title = `ثقة منخفضة في دقة القراءة من الملف "${r.fileName}" — راجع القيم قبل الحفظ`;
        }
      });
    }
    $('#ci-bulk-overlay').classList.add('show'); SoundFX.open();
    const msgParts = [`تمت قراءة ${ok.length} من ${results.length} ملف`];
    if(failed.length) msgParts.push(`تعذّرت قراءة ${failed.length}: ${failed.map(f=>f.fileName).join('، ')}`);
    showToast(msgParts.join(' — ') + ' — راجع الجدول وعدّل ما يلزم قبل "حفظ الكل"');
  }catch(err){
    showToast('تعذّر رفع/قراءة الفواتير: ' + (err.message || 'خطأ غير معروف'));
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
    e.target.value = '';
  }
});

/* ---------------- Tax Invoice (PDF via print) ---------------- */
function formatInvoiceNo(n){ return 'INV-' + String(n).padStart(6,'0'); }
async function assignInvoiceNumber(client){
  if(client.taxInvoiceNo) return client.taxInvoiceNo;
  // نضمن ألا يتكرر الرقم حتى لو كان settings.nextInvoiceNo متأخراً عن أرقام مستخدمة فعلاً
  // (استيراد بيانات قديمة أو مزامنة من جهاز آخر لم يُحدِّث العداد): نأخذ أعلى رقم مستخدم +1.
  const maxUsed = clients.reduce((mx,c)=> Math.max(mx, num(c.taxInvoiceNo)||0), 0);
  const n = Math.max(settings.nextInvoiceNo || 1, maxUsed + 1);
  client.taxInvoiceNo = n;
  client.taxInvoiceDate = client.taxInvoiceDate || todayISO();
  settings.nextInvoiceNo = Math.max(n + 1, settings.nextInvoiceNo || 1);
  const idx = clients.findIndex(c=>c.id===client.id);
  if(idx>-1) clients[idx] = client;
  await saveClients();
  await saveSettings();
  return n;
}
// حذف منطقي لفاتورة عميل (Soft Delete): لا يُعاد استخدام الرقم التسلسلي أبداً — الرقم يبقى محجوزاً ومحفوظاً في سجل الفواتير المحذوفة مع السبب،
// وعند طباعة فاتورة جديدة لاحقاً لنفس العميل سيُمنح رقماً تسلسلياً جديداً من settings.nextInvoiceNo (بدون أي قفزة للخلف أو إعادة تدوير).
function softDeleteClientInvoice(clientId, reason){
  const c = clients.find(x=>x.id===clientId);
  if(!c || !c.taxInvoiceNo) return null;
  const removed = {
    id: uid(),
    clientId: c.id,
    clientName: c.name,
    invoiceNo: c.taxInvoiceNo,
    invoiceNoLabel: formatInvoiceNo(c.taxInvoiceNo),
    invoiceDate: c.taxInvoiceDate || '',
    deletedAt: Date.now(),
    deletedBy: currentUser || 'غير معروف',
    deletedReason: reason || ''
  };
  deletedInvoices.push(removed);
  c.taxInvoiceNo = null;
  c.taxInvoiceDate = null;
  const idx = clients.findIndex(x=>x.id===c.id);
  if(idx>-1) clients[idx] = c;
  return removed;
}
async function printInvoice(id){
  const c = clients.find(x=>x.id===id);
  if(!c){ showToast('تعذر إيجاد بيانات العميل'); return; }
  const invNo = await assignInvoiceNumber(c);
  const invNoLabel = formatInvoiceNo(invNo);
  await logAudit('edit','العملاء', `تمت طباعة فاتورة رقم ${invNoLabel} للعميل: ${c.name}`);

  const income = centerIncome(c);
  const bag = bagAmount(c);
  const paid = paidTotal(c);
  const rem = remaining(c);
  // قيمة الحقيبة تظهر في الفاتورة فقط إذا كانت قد حُصِّلت بالكامل مع قيمة الدورة معاً
  // (أي أن إجمالي المبلغ المدفوع يغطي قيمة الدورة + قيمة الحقيبة كاملتين). إن لم تُحصَّل معاً، لا تظهر.
  const bagShown = bag>0 && paid >= (income + bag);
  // المبالغ المدخلة في النظام (سعر الدورة/الحقيبة) شاملة ضريبة القيمة المضافة أصلاً
  // لذلك يتم استخراج الضريبة من الإجمالي (فك التضمين) وليس إضافتها فوقه لتجنب احتساب 30%
  const totalInclVat = income + (bagShown ? bag : 0);
  const vat = vatFromGross(totalInclVat);
  const grand = totalInclVat - vat; // القيمة الفعلية بدون الضريبة

  // جسم الفاتورة (نفس قالب الطباعة) — يُستخدم للطباعة ولرفقه كملف PDF في الإيميل.
  const invoiceBodyHtml = buildInvoiceBodyHtml(c, invNoLabel, {income, bag, bagShown, paid, rem, totalInclVat, vat, grand});

  const win = openPrintTarget();
  win.document.write(`${printDocHead(invNoLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy})}<body>${invoiceBodyHtml}${printDocFooterButton()}</body></html>`);
  finishPrintDoc(win);
  renderTable();
  // إرسال تلقائي فور إصدار الفاتورة لو للعميل إيميل محفوظ — best-effort بالكامل (فشل الإرسال
  // لا يوقف الطباعة، ولا يُظهر خطأً مزعجاً؛ تنبيه بسيط فقط عبر showToast لو فشل).
  if(c.email){
    sendInvoiceEmailNow(c, invNoLabel, {grand, vat, paid, rem}, {silent:true});
  }
}

/* يبني جسم (body) فاتورة العميل بنفس قالب الطباعة — يُستخدم للطباعة ولرفقه كملف PDF
   في الإيميل بدل إرسال البيانات كنص داخل جسم الرسالة. */
function buildInvoiceBodyHtml(c, invNoLabel, {income, bag, bagShown, paid, rem, totalInclVat, vat, grand}){
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const rowsHtml = `
    <tr><td>رسوم الدورة التدريبية${c.courseType ? ' — '+escapeHtml(c.courseType) : ''}</td><td class="num">${fmt(num(c.coursePrice))}</td></tr>
    ${num(c.discount)>0 ? `<tr><td>الخصم</td><td class="num">-${fmt(num(c.discount))}</td></tr>` : ''}
    ${bagShown ? `<tr><td>قيمة الحقيبة التدريبية</td><td class="num">${fmt(bag)}</td></tr>` : ''}
  `;
  return `
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
        <h2>فاتورة مبسطة</h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الإصدار: ${escapeHtml(c.taxInvoiceDate || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل</h4>
        <div class="info-row"><span>الاسم:</span><b>${escapeHtml(c.name)}</b></div>
        <div class="info-row"><span>رقم الهوية / الإقامة:</span><b>${escapeHtml(c.clientId||'—')}</b></div>
        <div class="info-row"><span>رقم الجوال:</span><b>${escapeHtml(c.phone||'—')}</b></div>
        <div class="info-row"><span>الجنسية:</span><b>${escapeHtml(c.nationality||'—')}</b></div>
        ${c.clientType==='company' && c.companyName ? `<div class="info-row"><span>اسم الشركة:</span><b>${escapeHtml(c.companyName)}</b></div>` : ''}
        ${(()=>{ if(c.clientType!=='company'||!c.companyName) return ''; const comp = companies.find(x=>x.name===c.companyName); return (comp && comp.taxNumber) ? `<div class="info-row"><span>الرقم الضريبي للشركة:</span><b>${escapeHtml(comp.taxNumber)}</b></div>` : ''; })()}
        ${c.clientType==='company' && num(c.creditDays)>0 ? `<div class="info-row"><span>الأجل:</span><b>${num(c.creditDays)} يوم</b></div>` : ''}
        ${c.clientTaxNumber ? `<div class="info-row"><span>الرقم الضريبي للعميل:</span><b>${escapeHtml(c.clientTaxNumber)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات الدورة</h4>
        <div class="info-row"><span>نوع الدورة:</span><b>${escapeHtml(c.courseType||'—')}</b></div>
        <div class="info-row"><span>رقم الدورة:</span><b>${escapeHtml(c.courseNumber||'—')}</b></div>
        <div class="info-row"><span>تاريخ التسجيل:</span><b>${escapeHtml(formatDateDisplay(c.date)||'—')}</b></div>
        <div class="info-row"><span>تاريخ الدورة الفعلي:</span><b>${escapeHtml(actualCourseDateOf(c)||'—')}</b></div>
        <div class="info-row"><span>رقم فاتورة النظام:</span><b>${escapeHtml(c.invoice||'—')}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(paymentChannelsLabel(c))}</b></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>البيان</th><th style="text-align:left;">المبلغ (ر.س)</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    <div class="totals">
      <div class="r"><span>القيمة الفعلية (بدون ضريبة القيمة المضافة)</span><b class="mono">${fmt(grand)}</b></div>
      <div class="r"><span>ضريبة القيمة المضافة (15% مضمنة ضمن الإجمالي)</span><b class="mono">${fmt(vat)}</b></div>
      <div class="r grand"><span>الإجمالي (شامل الضريبة)</span><b>${fmt(grand+vat)}</b></div>
      <div class="r"><span>المبلغ المدفوع</span><b class="mono">${fmt(paid)}</b></div>
      <div class="r"><span>المتبقي</span><b class="mono">${fmt(rem)}</b></div>
    </div>
    <div style="margin:14px 0 22px; padding:12px 14px; border:1px solid #DDE3EA; border-radius:8px; background:#F7F9FB; font-size:12.5px; text-align:center;">
      <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(grand+vat))}
    </div>`;
}

// إرسال الفاتورة بالإيميل فعلياً عبر السيرفر. جسم الإيميل بسيط (تحية + إشارة للمرفق) لضمان
// توافقه مع عملاء البريد المختلفة، والفاتورة نفسها تُرفق كملف PDF (نفس قالب الطباعة) بدل
// إرسال البيانات كنص داخل جسم الرسالة. silent=true تُستخدم للإرسال التلقائي بعد الطباعة مباشرة
// (رسالة نجاح خفيفة فقط، بدون إزعاج فى حال الفشل). إن فشل توليد الـ PDF نُرسل الإيميل بدونه.
async function sendInvoiceEmailNow(c, invNoLabel, totals, {silent=false}={}){
  const {grand, vat, paid, rem} = totals;
  // إعادة حساب نفس قيم الفاتورة المطبوعة لبناء جسمها (نفس القالب) في الإيميل.
  const income = centerIncome(c);
  const bag = bagAmount(c);
  const bagShown = bag>0 && paid >= (income + bag);
  const totalInclVat = income + (bagShown ? bag : 0);
  const invoiceBodyHtml = buildInvoiceBodyHtml(c, invNoLabel, {income, bag, bagShown, paid, rem, totalInclVat, vat, grand});
  // توليد ملف PDF للفاتورة (نفس قالب الطباعة) لرفقه بالمرفقات بدل إرسال البيانات كنص فقط.
  let attachment = null;
  try{
    const pdfFile = await htmlBodyToPdfFile(invoiceBodyHtml, {
      title: 'فاتورة ' + invNoLabel,
      filename: 'فاتورة_' + invNoLabel.replace(/[^\w\u0600-\u06FF-]+/g,'_') + '.pdf',
      variant: 'full',
      accent: PRINT_PALETTE.gold,
      borderColor: PRINT_PALETTE.navy,
    });
    attachment = { b64: await fileToBase64(pdfFile), name: pdfFile.name, type: pdfFile.type };
  }catch(e){
    console.error('تعذّر توليد PDF الفاتورة للإيميل:', e);
  }
  const bodyHtml = `
    <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif; line-height:1.9; color:#222;">
      <p>مرحباً ${escapeHtml(c.name)}،</p>
      ${attachment
        ? `<p>مرفق فاتورتكم رقم <b>${invNoLabel}</b> كملف PDF في هذا البريد.</p>`
        : `<p>إليكم بيانات فاتورتكم رقم <b>${invNoLabel}</b>:</p>
           <table style="border-collapse:collapse; width:100%; max-width:420px;">
             <tr><td style="padding:6px 0;">القيمة (بدون ضريبة)</td><td style="padding:6px 0; text-align:left;"><b>${fmt(grand)}</b> ﷼</td></tr>
             <tr><td style="padding:6px 0;">ضريبة القيمة المضافة</td><td style="padding:6px 0; text-align:left;"><b>${fmt(vat)}</b> ﷼</td></tr>
             <tr style="border-top:1px solid #ddd;"><td style="padding:6px 0;">الإجمالي</td><td style="padding:6px 0; text-align:left;"><b>${fmt(grand+vat)}</b> ﷼</td></tr>
             <tr><td style="padding:6px 0;">المدفوع</td><td style="padding:6px 0; text-align:left;">${fmt(paid)} ﷼</td></tr>
             <tr><td style="padding:6px 0;">المتبقي</td><td style="padding:6px 0; text-align:left;">${fmt(rem)} ﷼</td></tr>
           </table>`}
      <p style="color:#888; font-size:13px; margin-top:16px;">شكراً لتعاملكم معنا.</p>
    </div>`;
  const payload = { to: c.email, clientName: c.name, invoiceNo: invNoLabel, bodyHtml };
  if(attachment) Object.assign(payload, { attachmentBase64: attachment.b64, attachmentName: attachment.name, attachmentType: attachment.type });
  try{
    const res = await serverFetch('/api/email/invoice', {
      method:'POST',
      body: JSON.stringify(payload),
    });
    if(res.ok){
      showToast(`تم إرسال الفاتورة بالإيميل إلى ${c.email}${attachment ? ' (مع مرفق PDF)' : ''}`);
      await logAudit('edit','العملاء', `تم إرسال فاتورة رقم ${invNoLabel} بالإيميل للعميل: ${c.name} (${c.email})${attachment ? ' مع مرفق PDF' : ''}`);
    }else{
      const data = await res.json().catch(()=>({}));
      if(!silent) showToast(`تعذّر إرسال الفاتورة بالإيميل: ${data.error || 'خطأ غير معروف'}`);
    }
  }catch(e){
    console.error('فشل إرسال إيميل الفاتورة:', e);
    if(!silent) showToast('تعذّر إرسال الفاتورة بالإيميل — تحقق من الاتصال');
  }
}

// زرار الإرسال اليدوي: لو العميل معندوش إيميل محفوظ، نطلبه مرة واحدة (بدون حفظه فى بيانات
// العميل — ده يتم فقط من فورم تعديل العميل نفسه)، وإلا نُرسل مباشرة على الإيميل المحفوظ.
async function sendInvoiceEmailManual(c){
  if(!c.taxInvoiceNo){ showToast('لا توجد فاتورة صادرة لهذا العميل بعد'); return; }
  let email = c.email;
  if(!email){
    email = await customPrompt(`لا يوجد إيميل محفوظ للعميل "${c.name}". اكتب الإيميل لإرسال الفاتورة إليه (لحفظه بشكل دائم، عدّل بيانات العميل):`, {title:'إرسال الفاتورة بالإيميل', required:true, placeholder:'example@mail.com'});
    if(!email) return;
    email = email.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showToast('صيغة الإيميل غير صحيحة'); return; }
  }
  const invNoLabel = formatInvoiceNo(c.taxInvoiceNo);
  const income = centerIncome(c);
  const bag = bagAmount(c);
  const paid = paidTotal(c);
  const rem = remaining(c);
  const bagShown = bag>0 && paid >= (income + bag);
  const totalInclVat = income + (bagShown ? bag : 0);
  const vat = vatFromGross(totalInclVat);
  const grand = totalInclVat - vat;
  await sendInvoiceEmailNow({...c, email}, invNoLabel, {grand, vat, paid, rem}, {silent:false});
}

/* ---------------- Return Invoice (مردودات المبيعات) ---------------- */
function formatReturnInvoiceNo(n){ return 'RET-' + String(n).padStart(6,'0'); }
async function printReturnInvoice(id){
  const tx = vaultTx.find(x=>x.id===id);
  if(!tx || !tx.isReturn){ showToast('تعذر إيجاد بيانات المردود'); return; }
  // ترجمة إنجليزية لحساب الصرف (قيمة ثابتة معروفة داخل النظام)
  const destLabelEn = d => ({vault:'Vault (Cash)', bank:'Bank', network:'Network', other:'Other'}[d] || 'Other');
  // ترجمة إنجليزية "أفضل محاولة" لطريقة الاسترجاع — القيمة تأتي من قنوات دفع قابلة للتخصيص من الإعدادات
  // فلا يوجد تعداد ثابت لها؛ إن لم تُطابق القاموس، تُعرض بالعربي فقط بدون افتراض ترجمة خاطئة
  const methodLabelEn = m => {
    const map = {'نقد':'Cash', 'كاش':'Cash', 'شبكة':'Network', 'تحويل بنكي':'Bank Transfer', 'تحويل':'Bank Transfer', 'فيزا':'Card', 'بطاقة':'Card', 'ماستر كارد':'Card', 'مدى':'Mada Card', 'STC Pay':'STC Pay', 'أبل باي':'Apple Pay'};
    return map[String(m||'').trim()] || '';
  };
  if(!tx.returnInvoiceNo){
    // نفس حماية تكرار الأرقام: نأخذ أعلى رقم مردود مستخدم فعلاً +1 (مزامنة/استيراد قديم)
    const maxUsed = vaultTx.reduce((mx,t)=> Math.max(mx, num(t.returnInvoiceNo)||0), 0);
    tx.returnInvoiceNo = Math.max(settings.nextReturnInvoiceNo || 1, maxUsed + 1);
    settings.nextReturnInvoiceNo = Math.max(tx.returnInvoiceNo + 1, settings.nextReturnInvoiceNo || 1);
    await saveVaultTx();
    await saveSettings();
  }
  const invNoLabel = formatReturnInvoiceNo(tx.returnInvoiceNo);
  const client = clients.find(c=>c.clientId===tx.clientId);
  await logAudit('edit','الحركات المالية', `تمت طباعة فاتورة استرجاع رقم ${invNoLabel} للعميل: ${tx.clientName||tx.clientId||'—'}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(invNoLabel, {accent: PRINT_PALETTE.red})}
  <body>
    <div class="inv-head">
      <div style="display:flex; gap:14px; align-items:center;">
        <img class="logo" src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
        <div>
          <p class="center-name">${escapeHtml(ci.name)}</p>
          <div class="center-meta">
            الرقم الضريبي / Tax No.: ${escapeHtml(ci.taxNumber)}<br>
            الهاتف / Phone: ${escapeHtml(ci.phone)}
          </div>
        </div>
      </div>
      <div class="inv-title">
        <h2>فاتورة استرجاع مبلغ<br><span style="font-size:14px;">Return Invoice</span></h2>
        <div class="no">${invNoLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">تاريخ الاسترجاع / Return Date: ${escapeHtml(tx.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات العميل / Client Information</h4>
        <div class="info-row"><span>الاسم / Name:</span><b>${escapeHtml(tx.clientName || client?.name || '—')}</b></div>
        <div class="info-row"><span>رقم الهوية / الإقامة<br>ID / Iqama No.:</span><b>${escapeHtml(tx.clientId || '—')}</b></div>
        ${client?.phone ? `<div class="info-row"><span>رقم الجوال / Mobile:</span><b>${escapeHtml(client.phone)}</b></div>` : ''}
      </div>
      <div class="info-box">
        <h4>بيانات المردود / Return Details</h4>
        ${client?.invoice ? `<div class="info-row"><span>رقم فاتورة الدورة<br>Course Invoice No.:</span><b>${escapeHtml(client.invoice)}</b></div>` : ''}
        ${client?.receiptIssueDate ? `<div class="info-row"><span>تاريخ فاتورة الدورة<br>Course Invoice Date:</span><b>${escapeHtml(formatDateDisplay(client.receiptIssueDate))}</b></div>` : ''}
        <div class="info-row"><span>حساب الصرف / Payment Account:</span><b>${escapeHtml(destLabel(tx.destination||'vault'))} / ${escapeHtml(destLabelEn(tx.destination||'vault'))}</b></div>
        <div class="info-row"><span>طريقة الاسترجاع / Return Method:</span><b>${escapeHtml(tx.method || '—')}${methodLabelEn(tx.method) ? ' / ' + escapeHtml(methodLabelEn(tx.method)) : ''}</b></div>
        <div class="info-row"><span>ملاحظات / Notes:</span><b>${escapeHtml(tx.notes || '—')}</b></div>
      </div>
    </div>

    <div class="amount-box">
      <div class="lbl">المبلغ المسترجع للعميل / Amount Refunded to Client</div>
      <div class="amt">${fmt(num(tx.amount))} ﷼</div>
      <div style="font-size:12.5px; color:#66707E; margin-top:10px; border-top:1px dashed #E9CFC9; padding-top:8px;">
        <b>المبلغ كتابةً / Amount in Words:</b> ${escapeHtml(numberToArabicWords(tx.amount))}
      </div>
    </div>

    <p style="font-size:13px; text-align:center; margin-bottom:0;">
      أقرّ أنا الموقّع أدناه باستلامي المبلغ الموضح أعلاه كمردود مبيعات، وذلك بحضوري الشخصي.<br>
      <span style="font-size:11.5px; color:#66707E;">I, the undersigned, acknowledge receipt of the above amount as a sales return, in person.</span>
    </p>

    <div class="sig-grid">
      <div class="sig-box">
        <div class="sig-line">توقيع العميل أو من ينوب عنه (${escapeHtml(tx.clientName || client?.name || '—')})<br><span style="font-size:11px; color:#66707E;">Client Signature or Representative</span></div>
      </div>
      <div class="sig-box">
        <div class="sig-line">توقيع المركز / المستلم للتوقيع<br><span style="font-size:11px; color:#66707E;">Center Signature / Receiver</span></div>
      </div>
    </div>

    <div class="footer-note">
      هذه الفاتورة صادرة إلكترونياً من نظام إدارة ${escapeHtml(ci.name)} — رقم الفاتورة تسلسلي ولا يتم التلاعب به، وهذا المردود خاص بهذا العميل فقط.<br>
      <span style="font-size:10.5px;">This invoice is issued electronically by ${escapeHtml(ci.name)} management system — the invoice number is sequential and non-editable, and this return applies to this client only.</span>
    </div>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
  renderVault();
}

/* ---------------- Expense Voucher (سند صرف) ---------------- */
function formatVoucherNo(n){ return 'PV-' + String(n).padStart(6,'0'); }
async function printExpenseVoucher(id){
  const tx = vaultTx.find(x=>x.id===id);
  if(!tx || tx.type!=='out'){ showToast('تعذر إيجاد بيانات الحركة'); return; }
  if(!tx.voucherNo){
    tx.voucherNo = settings.nextVoucherNo || 1;
    settings.nextVoucherNo = tx.voucherNo + 1;
    await saveVaultTx();
    await saveSettings();
  }
  const voucherLabel = formatVoucherNo(tx.voucherNo);
  await logAudit('edit','الحركات المالية', `تمت طباعة سند صرف رقم ${voucherLabel} بمبلغ ${fmt(num(tx.amount))}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(voucherLabel, {accent: PRINT_PALETTE.gold, borderColor: PRINT_PALETTE.navy, amountColor: PRINT_PALETTE.navy})}
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
        <h2>سند صرف</h2>
        <div class="no">${voucherLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">التاريخ: ${escapeHtml(tx.date || today)}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيان الصرف</h4>
        <div class="info-row"><span>التصنيف:</span><b>${escapeHtml(tx.category || '—')}</b></div>
        <div class="info-row"><span>الحساب:</span><b>${escapeHtml(destLabel(tx.destination||'vault'))}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(tx.method || '—')}</b></div>
      </div>
      <div class="info-box">
        <h4>بيانات المستلم</h4>
        <div class="info-row"><span>اسم مستلم المبلغ:</span><b>${escapeHtml(tx.recipientName || '—')}</b></div>
        <div class="info-row"><span>ملاحظات:</span><b>${escapeHtml(tx.notes || '—')}</b></div>
      </div>
    </div>

    <div class="amount-box">
      <div class="lbl">المبلغ المصروف</div>
      <div class="amt">${fmt(num(tx.amount))} ﷼</div>
      <div style="font-size:12.5px; color:#66707E; margin-top:10px; border-top:1px dashed #DDE3EA; padding-top:8px;">
        <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(tx.amount))}
      </div>
    </div>

    <div class="sig-grid">
      <div class="sig-box">
        <div class="sig-line">توقيع المحاسب</div>
      </div>
      <div class="sig-box">
        <div class="sig-line">توقيع مستلم المبلغ (${escapeHtml(tx.recipientName || '—')})</div>
      </div>
    </div>

    <div class="footer-note">
      هذا السند صادر إلكترونياً من نظام إدارة ${escapeHtml(ci.name)} — رقم السند تسلسلي ولا يتم التلاعب به.
    </div>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
  renderVault();
}

/* ---------------- Receipt Voucher (سند قبض — لكل وارد للخزنة/لأي عميل) ---------------- */
function formatReceiptNo(n){ return 'RV-' + String(n).padStart(6,'0'); }
async function printReceiptVoucher(id){
  const tx = vaultTx.find(x=>x.id===id);
  if(!tx || tx.type!=='in'){ showToast('تعذر إيجاد بيانات الحركة الواردة'); return; }
  if((tx.destination||'vault')!=='vault'){ showToast('سند القبض متاح لحركات الكاش فقط'); return; }
  if(!tx.receiptNo){
    tx.receiptNo = settings.nextReceiptNo || 1;
    settings.nextReceiptNo = tx.receiptNo + 1;
    await saveVaultTx();
    await saveSettings();
  }
  const receiptLabel = formatReceiptNo(tx.receiptNo);
  await logAudit('edit','الحركات المالية', `تمت طباعة سند قبض رقم ${receiptLabel} بمبلغ ${fmt(num(tx.amount))}`);

  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');

  const destName = destLabel(tx.destination||'vault');
  // شركة تدفع نقداً: اسم الدافع = اسم الشركة، والتفصيل = كل متدرب باسمه ورقم هويته ومبلغه
  const companyTransfer = tx.companyTransferId && typeof companyTransfers !== 'undefined' ? companyTransfers.find(x=>x.id===tx.companyTransferId) : null;
  const isCompanyCash = !!(companyTransfer && (tx.destination||'vault')==='vault');
  const rawPayerName = tx.clientName || tx.manual || tx.clientId || '—';
  const payerName = isCompanyCash ? (companyTransfer.companyName || companyTransfer.company || rawPayerName) : rawPayerName;
  const payerIdLine = isCompanyCash ? '' : (tx.clientId ? `<div class="info-row"><span>رقم الهوية:</span><b>${escapeHtml(tx.clientId)}</b></div>` : '');
  let traineesTableHtml = '';
  if(isCompanyCash && companyTransfer.trainees && companyTransfer.trainees.length){
    const rows = companyTransfer.trainees.map((trn, idx)=>{
      const c = typeof clients !== 'undefined' ? clients.find(x=>x.clientId===trn.clientId) : null;
      const name = c ? c.name : (trn.clientName || '—');
      const perAmount = fmt(num(trn.courseValue) + num(trn.bagValue));
      return `<tr><td class="mono" style="text-align:center;">${idx+1}</td><td>${escapeHtml(name)}</td><td class="mono">${escapeHtml(trn.clientId||'—')}</td><td class="mono" style="text-align:left;">${perAmount} ﷼</td></tr>`;
    }).join('');
    const totalFromTrainees = companyTransfer.trainees.reduce((s,x)=>s+num(x.courseValue)+num(x.bagValue),0);
    traineesTableHtml = `
    <div style="margin-top:14px;">
      <h4 style="margin:0 0 8px; font-size:13px; color:${PRINT_PALETTE.navy};">تفصيل المتدربين — الدافع: ${escapeHtml(payerName)}</h4>
      <table style="width:100%; border-collapse:collapse; font-size:12.5px;">
        <thead><tr><th style="width:40px; text-align:center;">م</th><th style="text-align:right;">اسم المتدرب</th><th style="text-align:right;">رقم الهوية</th><th style="text-align:left;">المبلغ</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="3" style="text-align:left; font-weight:700; background:${PRINT_PALETTE.surfaceAlt};">الإجمالي (${companyTransfer.trainees.length} متدرب)</td><td class="mono" style="text-align:left; font-weight:700; background:${PRINT_PALETTE.surfaceAlt};">${fmt(totalFromTrainees)} ﷼</td></tr></tfoot>
      </table>
    </div>`;
  }

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead(receiptLabel, {accent: PRINT_PALETTE.teal || PRINT_PALETTE.navy, borderColor: PRINT_PALETTE.navy, amountColor: PRINT_PALETTE.teal || PRINT_PALETTE.navy})}
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
        <h2>سند قبض</h2>
        <div class="no">${receiptLabel}</div>
        <div style="font-size:12px; color:#66707E; margin-top:4px;">التاريخ: ${escapeHtml(tx.date || today)}</div>
        <div style="font-size:11px; color:#66707E;">الرقم التسلسلي: #${escapeHtml(String(tx.seq||'—'))}</div>
      </div>
    </div>

    <div class="info-grid">
      <div class="info-box">
        <h4>بيانات الدافع</h4>
        <div class="info-row"><span>اسم الدافع / العميل:</span><b>${escapeHtml(payerName)}</b></div>
        ${payerIdLine}
      </div>
      <div class="info-box">
        <h4>بيانات القبض</h4>
        <div class="info-row"><span>الحساب:</span><b>${escapeHtml(destName)}</b></div>
        <div class="info-row"><span>طريقة الدفع:</span><b>${escapeHtml(tx.method || '—')}</b></div>
        ${tx.networkInvoice ? `<div class="info-row"><span>رقم فاتورة الشبكة:</span><b>${escapeHtml(tx.networkInvoice)}</b></div>` : ''}
        <div class="info-row"><span>تاريخ الحركة:</span><b>${escapeHtml(tx.date || '—')}</b></div>
      </div>
    </div>
    ${traineesTableHtml}

    <div class="amount-box">
      <div class="lbl">المبلغ المقبوض</div>
      <div class="amt">${fmt(num(tx.amount))} ﷼</div>
      <div style="font-size:12.5px; color:#66707E; margin-top:10px; border-top:1px dashed #DDE3EA; padding-top:8px;">
        <b>المبلغ كتابةً:</b> ${escapeHtml(numberToArabicWords(tx.amount))}
      </div>
    </div>

    <div style="text-align:center; margin-top:18px; padding-top:12px; border-top:1px dashed #DDE3EA; font-size:13px; color:#66707E;">
      لا تحتاج إلى اعتماد المحاسب — صادر من نظام مركز فهد للتدريب
    </div>

    <div class="footer-note">
      هذا السند صادر إلكترونياً من نظام إدارة ${escapeHtml(ci.name)} — رقم السند تسلسلي ولا يتم التلاعب به.
    </div>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
  renderVault();
}

/* ---------------- Export ---------------- */
$('#btn-export')?.addEventListener('click', ()=>{
  const headers = ['رقم الهوية','الاسم','رقم المرجع','الجوال','الجنسية','نوع العميل','اسم الشركة','الأجل (أيام)','الرقم الضريبي للعميل','نوع الدورة','رقم الفاتورة','رقم الفاتورة الضريبية','مصدر الحقيبة','حالة الحقيبة','رقم فاتورة الحقيبة','التاريخ','سعر الدورة','دخل المركز','قيمة الحقيبة','الخصم','الإجمالي','إجمالي المدفوع (شامل كل الدفعات)','المتبقي','طريقة الدفع الأولى','مبلغ الدفعة الأولى','طريقة الدفع الثانية','مبلغ الدفعة الثانية','رقم فاتورة الشبكة','الحالة','ملاحظات'];
  const rows = filteredClients().map(c=>[c.clientId,c.name,c.referNum,c.phone,c.nationality,c.clientType==='company'?'عميل شركات':'عميل مركز',c.companyName||'',c.clientType==='company'?(num(c.creditDays)||''):'',c.clientTaxNumber||'',c.courseType,c.invoice,c.taxInvoiceNo?formatInvoiceNo(c.taxInvoiceNo):'',bagSourceLabel(c),c.bagStatus||'',c.bagInvoice,c.date,c.coursePrice,centerIncome(c),bagAmount(c),c.discount,total(c),paidTotal(c),remaining(c),c.channel,num(c.paid),c.channel2||'',num(c.paid2),c.networkInvoice||'',c.stage,c.notes]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_المركز.csv';
  a.click();
});

/* ---------------- Settings ---------------- */
function renderSettings(){
  $('#set-center-name').value = settings.centerInfo?.name || '';
  $('#set-center-tax').value = settings.centerInfo?.taxNumber || '';
  $('#set-center-phone').value = settings.centerInfo?.phone || '';
  renderBagFinanceLinkToggle();
  $('#set-pa-webhook-url').value = settings.powerAutomate?.webhookUrl || '';
  $('#set-pa-notify-newclient').checked = settings.powerAutomate?.notifyNewClient !== false;
  $('#set-pa-notify-coursenum').checked = settings.powerAutomate?.notifyCourseNumber !== false;
  $('#next-invoice-no').textContent = formatInvoiceNo(settings.nextInvoiceNo || 1);
  $('#set-price-saudi').value = settings.priceSaudi;
  $('#set-price-nonsaudi').value = settings.priceNonSaudi;
  $('#courses-list').innerHTML = settings.courses.map((c,i)=>`
    <div class="tag" style="border-radius:8px; justify-content:space-between; width:100%; margin-bottom:6px;">
      <span>${escapeHtml(c.name)} — <span class="mono">${fmt(c.price)}</span> ﷼</span>
      <button data-rc="${i}">✕</button>
    </div>`).join('');
  $('#nat-list').innerHTML = settings.nationalities.map((n,i)=>`<div class="tag">${escapeHtml(n)}<button data-rn="${i}">✕</button></div>`).join('');
  $('#channel-list').innerHTML = settings.channels.map((c,i)=>`<div class="tag">${escapeHtml(c.name)} <span class="mono" style="color:var(--text-muted); font-size:11px;">(${destLabel(c.dest)})</span><button data-rh="${i}">✕</button></div>`).join('');
  $('#expcat-list').innerHTML = settings.expenseCategories.map((n,i)=>`<div class="tag">${escapeHtml(n)}<button data-re="${i}">✕</button></div>`).join('');
  $('#set-autobackup-enabled').checked = !!settings.autoBackupEnabled;
  $('#set-autobackup-days').value = settings.autoBackupIntervalDays || 7;
  if($('#set-low-balance')) $('#set-low-balance').value = settings.lowBalanceThreshold ?? 5000;
  if($('#set-bag-overdue-days')) $('#set-bag-overdue-days').value = settings.bagOverdueDays ?? 14;
  if($('#set-monthly-wa-number')) $('#set-monthly-wa-number').value = settings.monthlyReportWhatsapp || '';
  if($('#wa3-numbers')) $('#wa3-numbers').value = settings.monthlyPdfReportsWhatsappNumbers || '';
  if($('#vat-wa-numbers')) $('#vat-wa-numbers').value = settings.vatPdfReportWhatsappNumbers || '';
  if($('#set-report-email-to')) $('#set-report-email-to').value = settings.reportEmailTo || '';
  if($('#set-report-email-cc')) $('#set-report-email-cc').value = settings.reportEmailCC || '';
  $('#last-autobackup-hint').textContent = settings.lastAutoBackupAt
    ? `آخر نسخة احتياطية تلقائية: ${new Date(settings.lastAutoBackupAt).toLocaleString('ar-SA-u-nu-latn')}`
    : 'لم يتم إنشاء أي نسخة احتياطية تلقائية بعد.';
  renderThemeSchemePanel();
  renderUsersList();
  renderServerSyncPanel();
  renderPinLockPanel();
  renderRolePermissionsPanel();
  renderReceptionRestrictionsPanel();
  renderPruneRecordsPanel();
  renderTfaPanel();
  loadWebauthnDevicesList();
}
const SERVER_ROLE_LABELS = { admin:'مدير', accountant:'محاسب', reception:'استقبال', staff:'موظف عام' };
async function renderUsersList(){
  const el = $('#users-list');
  if(!el) return;
  el.innerHTML = `<div class="hint">جارٍ تحميل المستخدمين من الخادم...</div>`;
  try{
    const res = await fetch(API_BASE + '/api/users', { headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر جلب المستخدمين');
    el.innerHTML = (data.users||[]).map(u=>{
      const disabled = u.is_active === false;
      return `
      <div class="tag" style="border-radius:8px; justify-content:space-between; width:100%; margin-bottom:6px; ${disabled ? 'opacity:0.6;' : ''}">
        <span>👤 ${escapeHtml(u.display_name||u.username)} (${escapeHtml(u.username)})${u.username===currentUser ? ' — أنت' : ''}
          <span class="mono" style="font-size:10.5px; color:${u.role==='admin'?'var(--gold-dark)':'var(--text-muted)'}; margin-right:6px;">${SERVER_ROLE_LABELS[u.role]||u.role}</span>
          ${disabled ? '<span class="mono" style="font-size:10.5px; color:var(--red); margin-right:6px;">⛔ معطّل</span>' : ''}
          ${u.email ? `<span class="mono" style="font-size:10.5px; color:var(--text-muted); margin-right:6px;">✉️ ${escapeHtml(u.email)}</span>` : ''}
        </span>
        <span style="display:flex; gap:6px;">
          <button data-rt="${escapeHtml(u.username)}" data-rt-active="${disabled ? '0' : '1'}" class="btn btn-sm ${disabled ? '' : 'btn-danger'}" ${u.username===currentUser ? 'disabled title="لا يمكنك تعطيل حسابك الحالي"' : ''}>${disabled ? '✅ تفعيل' : '⛔ تعطيل'}</button>
          <button data-ru="${escapeHtml(u.username)}" ${u.username===currentUser ? 'disabled title="لا يمكنك حذف حسابك الحالي"' : ''}>✕</button>
        </span>
      </div>`;
    }).join('') || `<div class="hint">لا يوجد مستخدمون بعد</div>`;
  }catch(e){
    el.innerHTML = `<div class="hint" style="color:var(--red);">تعذّر تحميل قائمة المستخدمين: ${escapeHtml(e.message||'')}</div>`;
  }
}
/* ---------------- صلاحيات الأدوار (جدول مصفوفة قابل للتعديل من الإعدادات) ----------------
   المصدر الحقيقي الآن جدول role_permissions فى السيرفر (غير مشفّر، يقرأه السيرفر نفسه لفرض
   القيد الفعلي على الـ API — راجع GET/PUT /api/role-permissions فى server.js)، وليس
   settings.rolePermissions المشفّرة كما كان سابقاً (كانت مجرد إخفاء/إظهار تبويب بصري بلا أثر
   حقيقي). settings.rolePermissions ما زالت تُحدَّث كنسخة محلية احتياطية للعرض السريع/وضع عدم
   الاتصال فقط، لكنها لم تعد المرجع. */
async function renderRolePermissionsPanel(){
  const wrap = $('#role-permissions-table-wrap');
  if(!wrap) return;
  let rp = settings.rolePermissions || DEFAULT_SETTINGS.rolePermissions;
  let offlineNotice = '';
  try{
    const res = await fetch(API_BASE + '/api/role-permissions', { headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر جلب صلاحيات الأدوار من الخادم');
    rp = data.rolePermissions;
    settings.rolePermissions = rp; // مزامنة النسخة المحلية الاحتياطية مع مصدر الحقيقة الفعلي
  }catch(e){
    offlineNotice = `<div class="hint" style="color:var(--red); margin-bottom:8px;">تعذّر تحميل الصلاحيات الفعلية من الخادم (${escapeHtml(e.message||'')})؛ المعروض تالياً نسخة محلية قديمة وقد لا تطابق ما هو مُطبَّق فعلياً على الخادم.</div>`;
  }
  wrap.innerHTML = offlineNotice + `
    <table>
      <thead><tr><th>القسم</th>${EDITABLE_ROLES.map(r=>`<th>${escapeHtml(r.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${ALL_VIEWS.map(v=>`<tr>
          <td>${escapeHtml(v.label)}</td>
          ${EDITABLE_ROLES.map(r=>`<td style="text-align:center;"><input type="checkbox" data-rp-role="${r.id}" data-rp-view="${v.id}" ${(rp[r.id]||[]).includes(v.id)?'checked':''}></td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>`;
}
if($('#btn-save-role-permissions')) $('#btn-save-role-permissions').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-role-permissions'), async ()=>{
  const newRp = {};
  EDITABLE_ROLES.forEach(r=>{ newRp[r.id] = []; });
  $all('#role-permissions-table-wrap input[type=checkbox]').forEach(cb=>{
    if(cb.checked) newRp[cb.dataset.rpRole].push(cb.dataset.rpView);
  });
  const emptyRoles = EDITABLE_ROLES.filter(r=>!newRp[r.id].length).map(r=>r.label);
  if(emptyRoles.length && !await customConfirm(`الأدوار التالية لن يكون لها أي قسم ظاهر إطلاقاً: ${emptyRoles.join('، ')}. متابعة؟`)) return;
  try{
    // نحفظ أولاً فى الجدول الفعلي الذي يفرضه السيرفر — لو فشل (اتصال/صلاحية) نوقف هنا ولا نوهم
    // المستخدم بأن الصلاحيات تغيّرت فعلياً بمجرد حفظها محلياً فى settings المشفّرة.
    const res = await fetch(API_BASE + '/api/role-permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      body: JSON.stringify(newRp),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر حفظ صلاحيات الأدوار على الخادم');
  }catch(e){
    showToast('تعذّر حفظ الصلاحيات على الخادم: ' + (e.message||''));
    return;
  }
  settings.rolePermissions = newRp; // نسخة محلية احتياطية فقط، بعد نجاح الحفظ الفعلي على الخادم
  await saveSettings();
  await logAudit('edit','الإعدادات','تم تعديل صلاحيات الأدوار (أي أقسام تظهر لكل دور، ويُفرض فعلياً على الخادم)');
  applyRolePermissions();
  showToast('تم حفظ الصلاحيات');

  });});
/* ---------------- قيود دور الاستقبال (مهلة التعديل/الحذف بالساعات، قابلة للتغيير في أي وقت) ---------------- */
function renderReceptionRestrictionsPanel(){
  const hoursInput = $('#rp-reception-window-hours');
  const editCb = $('#rp-reception-allow-edit');
  const delCb = $('#rp-reception-allow-delete');
  if(!hoursInput || !editCb || !delCb) return;
  hoursInput.value = (typeof settings.receptionEditDeleteWindowHours==='number') ? settings.receptionEditDeleteWindowHours : DEFAULT_SETTINGS.receptionEditDeleteWindowHours;
  editCb.checked = settings.receptionAllowEdit !== false;
  delCb.checked = settings.receptionAllowDelete !== false;
}
if($('#btn-save-reception-restrictions')) $('#btn-save-reception-restrictions').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-reception-restrictions'), async ()=>{
  const hoursRaw = num($('#rp-reception-window-hours').value);
  const hours = (isFinite(hoursRaw) && hoursRaw>=0) ? hoursRaw : 5;
  settings.receptionEditDeleteWindowHours = hours;
  settings.receptionAllowEdit = !!$('#rp-reception-allow-edit').checked;
  settings.receptionAllowDelete = !!$('#rp-reception-allow-delete').checked;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تم تعديل قيود دور الاستقبال: المهلة ${hours} ساعة، التعديل ${settings.receptionAllowEdit?'مسموح':'ممنوع'}، الحذف ${settings.receptionAllowDelete?'مسموح':'ممنوع'}`);
  renderReceptionRestrictionsPanel();
  showToast('تم حفظ قيود الاستقبال');
  renderTable();

  });});
/* ---------------- تنظيف السجلات القديمة (سجل المراجعة/المحذوفات) — أدمن فقط، يدوي بالكامل ---------------- */
const PRUNE_RECORDS_CONFIG = [
  { key: 'auditLog', label: 'سجل المراجعة (auditLog)', defaultDays: 730, warning: null },
  { key: 'deletedVaultTx', label: 'حركات خزنة محذوفة (deletedVaultTx)', defaultDays: 365, warning: null },
  { key: 'deletedInvoices', label: 'فواتير محذوفة (deletedInvoices)', defaultDays: 2190, warning: '⚠️ يجب الاحتفاظ بالفواتير 6 سنوات على الأقل بموجب لوائح ضريبة القيمة المضافة/ZATCA — راجع محاسبك قبل تقصير هذه المدة.' },
];
function renderPruneRecordsPanel(){
  const wrap = $('#prune-records-rows');
  if(!wrap) return;
  wrap.innerHTML = PRUNE_RECORDS_CONFIG.map(cfg => `
    <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; padding:10px 0; border-bottom:1px solid var(--border);">
      <span style="min-width:210px;">${escapeHtml(cfg.label)}</span>
      <label style="display:flex; align-items:center; gap:6px; font-size:13px;">الاحتفاظ بآخر
        <input type="number" min="90" step="1" value="${cfg.defaultDays}" data-prune-days="${cfg.key}" style="width:90px;"> يوم
      </label>
      <button class="btn btn-ghost btn-sm" data-prune-preview="${cfg.key}">👁️ معاينة</button>
      <button class="btn btn-danger btn-sm" data-prune-run="${cfg.key}">🗑️ حذف نهائي</button>
      <span class="mono" id="prune-result-${cfg.key}" style="font-size:12.5px; color:var(--text-muted);"></span>
      ${cfg.warning ? `<div class="hint" style="width:100%; font-size:12.5px; color:var(--red);">${escapeHtml(cfg.warning)}</div>` : ''}
    </div>`).join('');
}
async function prunePreview(collection, days){
  const el = $(`#prune-result-${collection}`);
  if(el) el.textContent = 'جارٍ الحساب...';
  try{
    const res = await fetch(`${API_BASE}/api/records/${encodeURIComponent(collection)}/prune-preview?olderThanDays=${encodeURIComponent(days)}`, {
      headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّرت المعاينة');
    if(el) el.textContent = `سيُحذف ${data.wouldDelete} من إجمالي ${data.total} سجل`;
  }catch(e){ if(el) el.textContent = '⚠️ ' + e.message; }
}
async function pruneExecute(collection, days){
  const label = (PRUNE_RECORDS_CONFIG.find(c=>c.key===collection)||{}).label || collection;
  if(!await customConfirm(`سيتم حذف كل سجلات "${label}" الأقدم من ${days} يوماً نهائياً ولا يمكن التراجع عن هذا. متابعة؟`)) return;
  const el = $(`#prune-result-${collection}`);
  if(el) el.textContent = 'جارٍ الحذف...';
  try{
    const res = await fetch(`${API_BASE}/api/records/${encodeURIComponent(collection)}/prune`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      body: JSON.stringify({ olderThanDays: Number(days) }),
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر الحذف');
    if(el) el.textContent = `✅ تم حذف ${data.deleted} سجل`;
    await logAudit('delete','الإعدادات', `تم تنظيف ${data.deleted} سجل قديم من "${label}" (أقدم من ${days} يوماً)`);
    showToast(`تم حذف ${data.deleted} سجل من "${label}"`);
  }catch(e){ if(el) el.textContent = '⚠️ ' + e.message; }
}
document.addEventListener('click', (e)=>{
  const pb = e.target.closest('[data-prune-preview]');
  if(pb){ const key = pb.dataset.prunePreview; const days = $(`[data-prune-days="${key}"]`).value; prunePreview(key, days); return; }
  const rb = e.target.closest('[data-prune-run]');
  if(rb){ const key = rb.dataset.pruneRun; const days = $(`[data-prune-days="${key}"]`).value; pruneExecute(key, days); return; }
});

/* ---------------- المصادقة الثنائية (TOTP) — إعداد/تفعيل/إلغاء من شاشة الإعدادات ---------------- */
async function renderTfaPanel(){
  const badge = $('#tfa-status-badge');
  const controls = $('#tfa-controls');
  if(!badge || !controls) return;
  let enabled = false;
  try{
    const res = await serverFetch('/api/2fa/status');
    const data = await res.json();
    enabled = !!data.enabled;
  }catch(e){ badge.textContent = 'تعذّر التحقق من الحالة'; return; }
  badge.className = 'hint';
  badge.style.color = enabled ? 'var(--success)' : '';
  badge.textContent = enabled ? '✅ المصادقة الثنائية مفعّلة حالياً' : '⭕ المصادقة الثنائية غير مفعّلة';
  if(enabled){
    controls.innerHTML = `<button class="btn btn-danger btn-sm" id="btn-tfa-disable">إلغاء تفعيل المصادقة الثنائية</button>`;
    $('#btn-tfa-disable')?.addEventListener('click', async ()=>{
      const password = prompt('لتأكيد إلغاء المصادقة الثنائية، أدخل كلمة مرور حسابك الحالية:');
      if(!password) return;
      try{
        const res = await serverFetch('/api/2fa/disable', { method:'POST', body: JSON.stringify({ password }) });
        const data = await res.json();
        if(!res.ok) throw new Error(data.error||'فشل الإلغاء');
        showToast('تم إلغاء تفعيل المصادقة الثنائية');
        renderTfaPanel();
      }catch(e){ showToast(''+e.message); }
    });
  } else {
    controls.innerHTML = `<button class="btn btn-gold btn-sm" id="btn-tfa-enable">تفعيل المصادقة الثنائية الآن</button>`;
    $('#btn-tfa-enable')?.addEventListener('click', startTfaSetup);
  }
}
/* ---------------- الدخول بالبصمة / Face ID — عرض الأجهزة المسجَّلة وتسجيل جهاز جديد ---------------- */
async function loadWebauthnDevicesList(){
  const listEl = $('#webauthn-devices-list');
  const registerBtn = $('#btn-webauthn-register');
  if(!listEl) return;
  if(registerBtn && !registerBtn.dataset.bound){
    registerBtn.dataset.bound = '1';
    registerBtn.addEventListener('click', async ()=>{
      registerBtn.disabled = true;
      try{ await webauthnRegisterThisDevice(); } finally { registerBtn.disabled = false; }
    });
  }
  if(!webauthnSupported()){
    listEl.innerHTML = `<div class="hint hint-info">هذا المتصفح/الجهاز لا يدعم الدخول بالبصمة.</div>`;
    if(registerBtn) registerBtn.style.display = 'none';
    return;
  }
  try{
    const res = await serverFetch('/api/auth/webauthn/credentials');
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر جلب القائمة');
    const rows = data.credentials || [];
    if(!rows.length){
      listEl.innerHTML = `<div class="hint hint-info">لا يوجد أي جهاز مسجَّل بعد للدخول بالبصمة.</div>`;
      return;
    }
    listEl.innerHTML = rows.map(r => `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; margin-bottom:6px;">
        <div>
          <div style="font-weight:600;">${escapeHtml(r.nickname || 'جهاز غير مسمّى')}</div>
          <div style="font-size:12px; color:var(--text-muted);">
            سُجِّل: ${new Date(r.created_at).toLocaleString('ar-SA-u-nu-latn')}
            ${r.last_used_at ? ' — آخر استخدام: ' + new Date(r.last_used_at).toLocaleString('ar-SA-u-nu-latn') : ''}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" data-webauthn-remove="${r.id}">🗑️ إزالة</button>
      </div>`).join('');
  }catch(e){
    console.error('[WebAuthn] فشل تحميل قائمة الأجهزة:', e);
    listEl.innerHTML = `<div class="hint" style="color:var(--danger,#dc2626);">تعذّر تحميل قائمة الأجهزة المسجّلة</div>`;
  }
}
if($('#webauthn-devices-list')) $('#webauthn-devices-list').addEventListener('click', async e=>{
  const btn = e.target.closest('[data-webauthn-remove]');
  if(!btn) return;
  if(!await customConfirm('إزالة هذا الجهاز من قائمة الدخول بالبصمة؟ لن تقدر تدخل به بالبصمة بعد كده إلا لو سجّلته من جديد.')) return;
  try{
    const res = await serverFetch('/api/auth/webauthn/credentials/' + encodeURIComponent(btn.dataset.webauthnRemove), { method:'DELETE' });
    if(!res.ok){ const d = await res.json(); throw new Error(d.error || 'فشل الحذف'); }
    showToast('تم إزالة الجهاز');
    loadWebauthnDevicesList();
  }catch(e){ showToast('' + e.message); }
});

async function startTfaSetup(){
  const controls = $('#tfa-controls');
  try{
    const res = await serverFetch('/api/2fa/setup', { method:'POST' });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error||'فشل بدء الإعداد');
    controls.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px; max-width:340px;">
        <div>امسح هذا الكود بتطبيق مصادقة (Google Authenticator / Microsoft Authenticator / أي تطبيق TOTP مشابه):</div>
        <canvas id="tfa-qr-canvas"></canvas>
        <div class="hint hint-info">أو أدخل هذا المفتاح يدوياً فى التطبيق: <code class="mono">${escapeHtml(data.secret)}</code></div>
        <label>أدخل الكود المكوّن من 6 أرقام الذي يظهر فى التطبيق للتأكيد:</label>
        <input type="text" id="tfa-verify-code" inputmode="numeric" placeholder="123456" style="max-width:160px;">
        <button class="btn btn-gold btn-sm" id="btn-tfa-confirm">تأكيد وتفعيل</button>
      </div>`;
    if(typeof QRious !== 'undefined'){
      new QRious({ element: $('#tfa-qr-canvas'), value: data.otpauthUrl, size: 200, level:'M' });
    }
    $('#btn-tfa-confirm')?.addEventListener('click', async ()=>{
      const totpCode = $('#tfa-verify-code').value.trim();
      if(!totpCode){ showToast('أدخل الكود أولاً'); return; }
      try{
        const res2 = await serverFetch('/api/2fa/verify-setup', { method:'POST', body: JSON.stringify({ totpCode }) });
        const data2 = await res2.json();
        if(!res2.ok) throw new Error(data2.error||'كود غير صحيح');
        controls.innerHTML = `
          <div class="hint" style="font-weight:600; color:var(--success);">✅ تم تفعيل المصادقة الثنائية بنجاح</div>
          <div style="margin-top:8px;">احتفظ بهذه الأكواد الاحتياطية فى مكان آمن — كل كود يُستخدم مرة واحدة فقط، وتظهر هنا الآن فقط ولن تظهر مرة أخرى أبداً:</div>
          <div class="mono" style="background:var(--surface-alt); padding:10px; border-radius:8px; margin-top:6px; line-height:2;">
            ${data2.backupCodes.map(c=>escapeHtml(c)).join(' &nbsp; ')}
          </div>`;
        showToast('تم تفعيل المصادقة الثنائية');
      }catch(e){ showToast(''+e.message); }
    });
  }catch(e){ showToast(''+e.message); }
}

function formatDeviceInfo(ua){
  if(!ua) return '—';
  // تحليل مبسّط لسلسلة الـ User-Agent لعرض اسم مفهوم للجهاز/المتصفح بدل السلسلة الخام،
  // بدون الحاجة لمكتبة خارجية (الواجهة كلها ملفات ثابتة بدون خطوة بناء/npm).
  let os = 'نظام غير معروف';
  if(/Windows/i.test(ua)) os = 'Windows';
  else if(/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if(/Mac OS X/i.test(ua)) os = 'macOS';
  else if(/Android/i.test(ua)) os = 'Android';
  else if(/Linux/i.test(ua)) os = 'Linux';

  let browser = 'متصفح غير معروف';
  if(/Edg\//i.test(ua)) browser = 'Edge';
  else if(/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if(/Chrome\//i.test(ua)) browser = 'Chrome';
  else if(/CriOS\//i.test(ua)) browser = 'Chrome';
  else if(/Firefox\//i.test(ua)) browser = 'Firefox';
  else if(/Safari\//i.test(ua)) browser = 'Safari';

  const type = /Mobile|iPhone|Android/i.test(ua) ? '📱' : (/iPad|Tablet/i.test(ua) ? '📱' : '💻');
  return `${type} ${os} · ${browser}`;
}
async function renderLoginHistory(){
  const el = $('#login-history-list');
  if(!el) return;
  el.innerHTML = `<div class="hint">جارٍ تحميل سجل الدخول من الخادم...</div>`;
  try{
    const res = await fetch(API_BASE + '/api/login-history', { headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN } });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر جلب سجل الدخول');
    const history = data.history || [];
    const suspiciousActivity = data.suspiciousActivity || [];
    if(!history.length){ el.innerHTML = `<div class="hint">لا يوجد سجل دخول بعد</div>`; return; }
    const uniqueUsers = [...new Set(history.map(h=>h.username))];
    const suspiciousBanner = suspiciousActivity.length ? `
      <div style="background:#FEF2F2; border:1px solid #FCA5A5; border-radius:8px; padding:10px 14px; margin-bottom:12px; color:#991B1B;">
        ⚠️ نشاط مشبوه: محاولات دخول فاشلة متكررة خلال آخر ساعة —
        ${suspiciousActivity.map(s=>`<b>${escapeHtml(s.username)}</b> (${s.failed_count} محاولة من ${escapeHtml(s.ip_address||'—')})`).join('، ')}
      </div>` : '';
    el.innerHTML = `
      ${suspiciousBanner}
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        ${uniqueUsers.map(u=>`<button class="btn btn-danger btn-sm" data-forcelogout="${escapeHtml(u)}" ${u===currentUser?'disabled title="لا يمكنك إنهاء جلستك الحالية من هنا"':''}>🔒 إنهاء جلسات "${escapeHtml(u)}"</button>`).join('')}
      </div>
      <div class="table-scroll table-scroll-compact cards-mobile">
      <table>
        <thead><tr><th>الحالة</th><th>اسم المستخدم</th><th>الصلاحية</th><th>الوقت</th><th>الجهاز</th><th>عنوان IP</th></tr></thead>
        <tbody>
          ${history.map(h=>`<tr ${h.success===false?'style="background:#FEF2F2;"':''}>
            <td data-label="الحالة">${h.success===false?'❌ فشلت':'✅ ناجحة'}</td>
            <td data-label="اسم المستخدم">${escapeHtml(h.username)}${h.username===currentUser?' — أنت':''}</td>
            <td data-label="الصلاحية">${escapeHtml(SERVER_ROLE_LABELS[h.role]||h.role||'—')}</td>
            <td class="mono" data-label="الوقت">${new Date(h.logged_in_at).toLocaleString('ar-SA-u-nu-latn')}</td>
            <td data-label="الجهاز" title="${escapeHtml(h.device_info||'')}">${escapeHtml(formatDeviceInfo(h.device_info))}</td>
            <td class="mono" data-label="عنوان IP">${escapeHtml(h.ip_address||'—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  }catch(e){
    el.innerHTML = `<div class="hint" style="color:var(--red);">تعذّر تحميل سجل الدخول: ${escapeHtml(e.message||'')}</div>`;
  }
}
if($('#btn-refresh-login-history')) $('#btn-refresh-login-history').addEventListener('click', renderLoginHistory);
if($('#login-history-list')) $('#login-history-list').addEventListener('click', async e=>{
  const btn = e.target.closest('[data-forcelogout]');
  if(!btn) return;
  const username = btn.dataset.forcelogout;
  if(!await customConfirm(`سيتم تسجيل خروج فوري لـ "${username}" من كل الأجهزة والجلسات المفتوحة حالياً، وسيحتاج يسجّل دخول من جديد. متابعة؟`)) return;
  try{
    const res = await fetch(API_BASE + '/api/users/' + encodeURIComponent(username) + '/force-logout', {
      method:'POST', headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN }
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر إنهاء الجلسات');
    await logAudit('edit','الإعدادات', `تم إنهاء جلسات المستخدم "${username}" من كل الأجهزة يدوياً`);
    showToast(`تم تسجيل خروج "${username}" من كل الأجهزة`);
  }catch(e){
    showToast('تعذّر إنهاء الجلسات: ' + (e.message||''));
  }
});
/* ---------------- إعادة ضبط البرنامج بالكامل (حذف كل البيانات) ---------------- */
$('#btn-reset-app')?.addEventListener('click', async ()=>{
  const firstConfirm = await customConfirm('تحذير: سيتم حذف جميع بيانات البرنامج نهائياً في كل الشيتات (العملاء، الدورات، الحقائب، الحركات المالية، الشركات، القيود والحسابات المحاسبية، الموازنة، الموردين، المشتريات، فواتير المبيعات اليدوية، تعديلات الزكاة، المستخدمين، وسجل المراجعة) من الجهاز ومن السيرفر، وستُحذف أيضاً كل النسخ الاحتياطية المحفوظة على السيرفر — ولن يمكن التراجع عن ذلك بأي شكل.\n\nالإعدادات فقط ستبقى كما هي دون أي تغيير.\n\nهل أنت متأكد أنك تريد المتابعة؟');
  if(!firstConfirm) return;
  const secondConfirm = await customConfirm('تأكيد أخير: سيتم الحذف فوراً بمجرد الضغط على "موافق" ولن تتمكن من التراجع — لا توجد أي طريقة لاسترجاع البيانات بعد ذلك.\n\nهل تريد المتابعة والحذف الآن؟');
  if(!secondConfirm){
    alert('تم إلغاء العملية — لم يُحذف أي شيء.');
    return;
  }
  const statusEl = $('#reset-status');
  statusEl.style.display = 'block';
  statusEl.textContent = 'جارٍ إعادة ضبط المصنع...';
  try{
    // 1) حذف كل مفاتيح البيانات المحفوظة (بلوكات kv_store القديمة/المتبقية + zakatAdjustments الذي لا يزال عليها فعلياً)
    //    — بدون لمس مفتاح "settings" إطلاقاً (يُحتفظ بالإعدادات كما هي محلياً وعلى السيرفر).
    const keys = ['clients','bagStock','vaultTx','courseSessions','users','auditLog','companies','companyTransfers',
      'bankStatementRows','vaultDenomTx','deletedInvoices','journalEntries','chartOfAccounts','journalDE','budgetEntries',
      'suppliers','purchases','manualSalesInvoices','zakatAdjustments'];
    const deleteErrors = [];
    for(const k of keys){
      try{ await window.storage.delete(k, false); }catch(e){ deleteErrors.push(`${k}: ${e.message||e}`); }
    }
    // التصنيفات دي كلها مُخزَّنة الآن كسجلات مستقلة (collection_records) — حذف دفعة واحدة لكل
    // تصنيف عبر النقطة المخصصة لذلك بدل الاعتماد على مقارنة baseline سجل سجل (أبطأ وغير مضمون).
    const migratedCollections = ['bagStock','vaultTx','deletedVaultTx','vaultDenomTx','bankStatementRows','courseSessions',
      'auditLog','companies','companyTransfers','deletedInvoices','journalEntries','chartOfAccounts','journalDE',
      'budgetEntries','suppliers','purchases','manualSalesInvoices','scheduledVaultTx','followUpTasks'];
    for(const c of migratedCollections){
      try{
        await serverFetch(`/api/records/${encodeURIComponent(c)}`, { method: 'DELETE' });
        _collectionSyncBaseline[c] = new Map();
        _recordVersions[c] = new Map(); // إصلاح: كانت أرقام النسخ القديمة (قبل الحذف) تبقى فى الذاكرة
        // ولا تُصفَّر هنا رغم تصفير baseline، فيُرسِلها الحفظ التالي (مثال: استعادة نسخة احتياطية
        // مباشرة بعد ضبط المصنع) للسيرفر، الذي يرفضها بخطأ 409 "تعارض" رغم عدم وجود أي تعارض حقيقي
        // (السجل غير موجود من الأساس بعد الحذف) — وهذا بالضبط سبب رفض إضافة بعض المعاملات.
      }catch(e){ deleteErrors.push(`${c} (سجلات مستقلة): ${e.message||e}`); }
    }
    // إصلاح: حذف سجلات العملاء (client_records) كان مفقوداً هنا بالكامل رغم وجود نقطة سيرفر مخصّصة
    // لذلك تحديداً (DELETE /api/client-records) — ما كان يعني أن "ضبط المصنع" لا يحذف بيانات
    // العملاء فعلياً من قاعدة البيانات إطلاقاً رغم أن رسالة التأكيد تَعِد المستخدم بحذفها.
    try{
      await serverFetch('/api/client-records', { method: 'DELETE' });
    }catch(e){ deleteErrors.push(`سجلات العملاء: ${e.message||e}`); }
    // تصفير كامل لحالة تتبّع مزامنة العملاء محلياً (نفس سبب تصفير _recordVersions أعلاه بالضبط)
    Object.keys(_clientRecordVersions).forEach(k=> delete _clientRecordVersions[k]);
    clientRecordMeta = {};
    recordMeta = {};
    _clientRecordsAggVersion = null;
    _clientsSyncBaseline = new Map();

    // 1.5) "بدون رجعة": حذف كل النسخ الاحتياطية الكاملة المخزنة على السيرفر (يدوية + تلقائية)
    //      — أي مسار لاسترجاع البيانات القديمة يُغلق نهائياً.
    try{
      const backupsList = await listServerBackups();
      for(const b of backupsList){
        try{ await deleteServerBackup(b.id); }catch(e){ deleteErrors.push(`نسخة سيرفر ${b.id}: ${e.message||e}`); }
      }
    }catch(e){ deleteErrors.push('قائمة نسخ السيرفر: ' + (e.message||e)); }
    // مسح كل الآثار المحلية القابلة لإعادة إنشاء البيانات: لقطات الفتح السريع، طوابير
    // التعديلات المعلّقة (قد تحوي نسخاً قديمة تُرفع لاحقاً فوق البيانات الممسوحة)، وعلامات
    // إعادة المزامنة المعلّقة من استعادة سابقة.
    try{ await _recordsSnapClearAll(); }catch(e){ deleteErrors.push('اللقطات المحلية: ' + (e.message||e)); }
    try{ await _pendingRecordClearAll(); }catch(e){ deleteErrors.push('طابور المعلّقات: ' + (e.message||e)); }
    try{ await _pendingClearAll(); }catch(e){ deleteErrors.push('طابور المعلّقات: ' + (e.message||e)); }
    try{ localStorage.removeItem(RESTORE_RESYNC_FLAG_KEY); }catch(e){}
    try{ localStorage.removeItem(RESTORE_OLD_SNAPSHOT_KEY); }catch(e){}

    // 2) إعادة كل متغيرات البرنامج في الذاكرة إلى حالتها الافتراضية فوراً — الإعدادات تبقى كما هي
    //    (حتى تنعكس إعادة الضبط على كل الشيتات/التبويبات مباشرة دون انتظار إعادة التشغيل)
    clients = [];
    bagStock = [];
    vaultTx = [];
    deletedVaultTx = [];
    vaultDenomTx = [];
    scheduledVaultTx = [];
    followUpTasks = [];
    courseSessions = [];
    companies = [];
    companyTransfers = [];
    auditLog = [];
    bankStatementRows = [];
    deletedInvoices = [];
    journalEntries = [];
    chartOfAccounts = [];
    journalDE = [];
    budgetEntries = [];
    suppliers = [];
    purchases = [];
    manualSalesInvoices = [];
    zakatAdjustments = {};
    users = [{username:'admin', password:'admin123', role:'admin', createdAt:Date.now()}];
    undoStack = [];
    redoStack = [];
    seedChartOfAccountsIfEmpty();

    const saveErrors = [];
    const saveResults = await Promise.allSettled([
      saveClients(), saveBagStock(), saveVaultTx(), saveDeletedVaultTx(), saveVaultDenomTx(),
      saveCourseSessions(), saveCompanies(), saveCompanyTransfers(),
      saveUsers(), saveAuditLog(), saveBankStatementRows(), saveDeletedInvoices(),
      saveJournalEntries(), saveChartOfAccounts(), saveJournalDE(), saveBudgetEntries(),
      saveSuppliers(), savePurchases(), saveManualSalesInvoices(), saveZakatAdjustments()
    ]);
    saveResults.forEach((r,i)=>{ if(r.status==='rejected') saveErrors.push(String(r.reason)); });

    // 3) إعادة رسم كل الشيتات/التبويبات فوراً حتى تظهر فارغة في كل مكان
    if(typeof refreshFilterOptions==='function') refreshFilterOptions();
    if(typeof refreshAuditFilterOptions==='function') refreshAuditFilterOptions();
    if(typeof refreshMissingCourseOptions==='function') refreshMissingCourseOptions();
    if(typeof refreshMissingNatOptions==='function') refreshMissingNatOptions();
    if(typeof renderDashboard==='function') renderDashboard();
    if(typeof renderTable==='function') renderTable();
    if(typeof renderVault==='function') renderVault();
    if(typeof renderBags==='function') renderBags();
    if(typeof renderCourses==='function') renderCourses();
    if(typeof renderMissingCourse==='function') renderMissingCourse();
    if(typeof renderCompanies==='function') renderCompanies();
    if(typeof renderReports==='function') renderReports();
    if(typeof renderBudget==='function') renderBudget();
    if(typeof renderAuditLog==='function') renderAuditLog();
    if(typeof renderSettings==='function') renderSettings();
    if(typeof renderUsersList==='function') renderUsersList();
    if(typeof updateUndoRedoButtons==='function') updateUndoRedoButtons();
    applyThemeColors();

    // تحقّق فعلي من أن الأرصدة صارت صفراً — للتأكد أمام المستخدم أن الحذف تم بالفعل
    const verifyMsg = (typeof balanceOf==='function')
      ? `الأرصدة الآن — الخزنة: ${fmt(balanceOf('vault'))} | البنك: ${fmt(balanceOf('bank'))} | الشبكة: ${fmt(balanceOf('network'))}`
      : '';

    if(deleteErrors.length || saveErrors.length){
      statusEl.textContent = 'حدثت مشكلة أثناء الحذف — راجع الرسالة.';
      alert(`تعذّر إتمام الحذف بشكل كامل:\n${[...deleteErrors, ...saveErrors].join('\n')}\n\nيُرجى إغلاق البرنامج وتشغيله كمسؤول (Run as Administrator) ثم إعادة المحاولة.`);
      return;
    }

    statusEl.textContent = `تمت إعادة ضبط المصنع بنجاح ✅ — ${verifyMsg}`;
    alert(`تم حذف جميع البيانات نهائياً (بدون إمكانية الرجوع) ✅ — الإعدادات بقيت كما هي.\n${verifyMsg}\n\nسيُعاد تشغيل البرنامج الآن.`);
    // 4) إعادة تحميل كاملة كإجراء احتياطي إضافي حتى لو تعذّر تحديث أي جزء من الواجهة أعلاه
    location.reload();
  }catch(err){
    statusEl.textContent = `حدث خطأ أثناء الحذف: ${err.message || err}`;
    alert(`حدث خطأ أثناء عملية الحذف: ${err.message || err}`);
  }
});
$('#btn-update-app')?.addEventListener('click', ()=>{
  if(!(window.appUpdater && window.appUpdater.installUpdate)){
    showToast('ميزة التحديث تعمل فقط في نسخة سطح المكتب المثبّتة (وليس في المتصفح)');
    return;
  }
  $('#update-file-input').value = '';
  $('#update-file-input').click();
});
$('#update-file-input')?.addEventListener('change', async (e)=>{
  const file = e.target.files && e.target.files[0];
  if(!file) return;
  if(!await customConfirm(`سيتم استبدال النسخة الحالية من البرنامج بالملف المختار:\n"${file.name}"\n\nسيُحتفظ بنسخة احتياطية من النسخة الحالية تلقائياً، ولن تتأثر بياناتك المحفوظة. هل تريد المتابعة؟`)){
    e.target.value = '';
    return;
  }
  const statusEl = $('#update-status');
  statusEl.style.display = 'block';
  statusEl.textContent = 'جارٍ قراءة الملف وتثبيت التحديث...';
  try{
    const content = await file.text();
    const result = await window.appUpdater.installUpdate(content);
    if(result && result.ok){
      statusEl.textContent = 'تم تثبيت التحديث بنجاح ✅ — سيتم إعادة تحميل البرنامج الآن...';
      await logAudit('edit','الإعدادات', `تم تحديث ملف البرنامج من الملف: ${file.name}`);
      showToast('تم تثبيت التحديث، جارٍ إعادة التحميل...');
      setTimeout(()=>location.reload(), 1200);
    }else{
      statusEl.textContent = `تعذّر تثبيت التحديث: ${(result && result.error) || 'خطأ غير معروف'}`;
      showToast('تعذّر تثبيت التحديث');
    }
  }catch(err){
    statusEl.textContent = `تعذّر قراءة الملف أو تثبيته: ${err.message || err}`;
    showToast('تعذّر تثبيت التحديث');
  }finally{
    e.target.value = '';
  }
});
/* ---------------- تصدير نسخة من ملف البرنامج نفسه (index.html) ---------------- */
/* هذا تصدير لملف البرنامج (الكود والواجهة) وليس لبيانات العملاء — مفيد لأخذ نسخة أرشيفية من الإصدار الحالي
   أو لتثبيت نفس النسخة يدوياً على جهاز آخر عبر زر "تحديث البرنامج" هناك.
   قبل التصدير، نُنظّف نسخة مؤقتة (clone) من الصفحة الحالية من كل المحتوى المعروض حالياً على الشاشة
   (جداول العملاء، الحركات المالية، إلخ) حتى لا تتضمن نسخة ملف البرنامج المصدَّرة أي بيانات حقيقية للعملاء —
   تماشياً مع مبدأ البرنامج بأن ملف البرنامج نفسه لا يحتوي على أي بيانات مطلقاً. */
const KB_EXPORT_CLEAR_IDS = [
  'acc-balance-check','acc-journal-body','acc-quarterly-table','acc-summary-cards','acc-trial-body',
  'audit-table-body','bag-cards','bag-stock-body','budget-cards','bulk-add-table-body',
  'bulk-update-table-body','bulk-delete-table-body','cs-bulk-table-body','ci-bulk-table-body','refnum-bulk-table-body',
  'bagfund-bulk-table-body','cards',
  'cbp-total','channel-list','ci-cards','client-payments-list','companies-list-body',
  'company-transfers-list','company-transfers-summary','courses-list','courses-sessions-list',
  'companies-stats-cards','companies-unsettled-list',
  'ct-company','ctr-client-info','expcat-list','monthly-summary-body','nat-list','ownbag-total',
  'pending-bags-table','pending-bags-total','period-cards','period-compare-cards','quickstats',
  'table-body','users-list','vault-cards','vault-table-body','voided-table-body',
  'chart-bag-method','chart-channel','chart-course','chart-expense-cat','chart-nat',
  'chart-report-expense','chart-report-revenue-course','chart-vault-method',
  'current-user-label','toast'
];
$('#btn-export-app')?.addEventListener('click', ()=>{
  try{
    const clone = document.documentElement.cloneNode(true);
    // تفريغ كل الحاويات التي تُعرض فيها بيانات حية (عملاء، حركات مالية، إلخ) في النسخة المُصدَّرة فقط
    KB_EXPORT_CLEAR_IDS.forEach(id=>{
      const el = clone.querySelector('#'+id);
      if(el) el.innerHTML = '';
    });
    // إغلاق أي نوافذ منبثقة كانت مفتوحة وقت التصدير، وإزالة أي نافذة معاينة طباعة مؤقتة
    clone.querySelectorAll('.overlay.show').forEach(ov=> ov.classList.remove('show'));
    const pp = clone.querySelector('#print-preview-overlay'); if(pp) pp.remove();
    const htmlContent = '<!DOCTYPE html>\n' + clone.outerHTML;
    const blob = new Blob([htmlContent], {type:'text/html;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `نسخة_البرنامج_${stampNow()}.html`;
    a.click();
    showToast('تم تصدير نسخة من ملف البرنامج (بدون أي بيانات عملاء)');
  }catch(err){
    showToast(`تعذّر تصدير نسخة البرنامج: ${err.message || err}`);
  }
});
$('#btn-save-centerinfo')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-centerinfo'), async ()=>{
  settings.centerInfo = {
    name: $('#set-center-name').value.trim() || DEFAULT_SETTINGS.centerInfo.name,
    taxNumber: $('#set-center-tax').value.trim() || DEFAULT_SETTINGS.centerInfo.taxNumber,
    phone: $('#set-center-phone').value.trim() || DEFAULT_SETTINGS.centerInfo.phone,
  };
  await saveSettings();
  await logAudit('edit','الإعدادات', 'تم تحديث بيانات المركز المستخدمة في الفاتورة');
  showToast('تم حفظ بيانات المركز');

  });});
$('#btn-save-autobackup')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-autobackup'), async ()=>{
  settings.autoBackupEnabled = $('#set-autobackup-enabled').checked;
  settings.autoBackupIntervalDays = Math.max(1, Number($('#set-autobackup-days').value)||7);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث إعداد النسخ الاحتياطي التلقائي: ${settings.autoBackupEnabled?'مفعّل':'معطّل'} كل ${settings.autoBackupIntervalDays} يوم`);
  showToast('تم حفظ إعداد النسخ الاحتياطي');

  });});
$('#btn-save-alert-settings')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-alert-settings'), async ()=>{
  settings.lowBalanceThreshold = Math.max(0, Number($('#set-low-balance').value)||0);
  settings.bagOverdueDays = Math.max(1, Number($('#set-bag-overdue-days').value)||14);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث إعدادات التنبيهات: حد أدنى للرصيد ${fmt(settings.lowBalanceThreshold)}، تنبيه الحقائب بعد ${settings.bagOverdueDays} يوم`);
  showToast('تم حفظ إعدادات التنبيهات');
  renderSmartAlerts();

  });});
$('#btn-save-monthly-wa')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-monthly-wa'), async ()=>{
  settings.monthlyReportWhatsapp = ($('#set-monthly-wa-number').value||'').replace(/[^\d]/g,'');
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث رقم واتساب التقرير الشهري`);
  showToast('تم حفظ رقم واتساب');
  renderSmartAlerts();

  });});
$('#btn-save-wa3-numbers')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-wa3-numbers'), async ()=>{
  const raw = ($('#wa3-numbers').value||'');
  const cleaned = raw.split(',').map(s=> s.replace(/[^\d]/g,'')).filter(Boolean);
  settings.monthlyPdfReportsWhatsappNumbers = cleaned.join(', ');
  if($('#wa3-numbers')) $('#wa3-numbers').value = settings.monthlyPdfReportsWhatsappNumbers;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث أرقام واتساب مستلمي التقارير الشهرية (${cleaned.length} رقم)`);
  showToast(cleaned.length ? `تم حفظ ${cleaned.length} رقم` : 'تم مسح الأرقام المحفوظة');

  });});
$('#btn-save-vat-wa-numbers')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-vat-wa-numbers'), async ()=>{
  const raw = ($('#vat-wa-numbers').value||'');
  const cleaned = raw.split(',').map(s=> s.replace(/[^\d]/g,'')).filter(Boolean);
  settings.vatPdfReportWhatsappNumbers = cleaned.join(', ');
  if($('#vat-wa-numbers')) $('#vat-wa-numbers').value = settings.vatPdfReportWhatsappNumbers;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث أرقام واتساب مستلمي الإقرار الضريبي (${cleaned.length} رقم)`);
  showToast(cleaned.length ? `تم حفظ ${cleaned.length} رقم` : 'تم مسح الأرقام المحفوظة');

  });});
$('#btn-save-report-email')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-report-email'), async ()=>{
  const to = ($('#set-report-email-to').value||'').trim();
  const ccRaw = ($('#set-report-email-cc').value||'');
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(to && !EMAIL_RE.test(to)){ showToast('صيغة البريد الرئيسي غير صحيحة'); return; }
  const ccList = ccRaw.split(',').map(s=>s.trim()).filter(Boolean);
  if(ccList.some(e=>!EMAIL_RE.test(e))){ showToast('صيغة أحد إيميلات CC غير صحيحة'); return; }
  settings.reportEmailTo = to;
  settings.reportEmailCC = ccList.join(', ');
  if($('#set-report-email-to')) $('#set-report-email-to').value = settings.reportEmailTo;
  if($('#set-report-email-cc')) $('#set-report-email-cc').value = settings.reportEmailCC;
  await saveSettings();
  await logAudit('edit','الإعدادات', `تحديث إعدادات إيميل التقارير: To=${to||'—'}${ccList.length ? `, CC=${ccList.join(', ')}` : ''}`);
  showToast('تم حفظ إعدادات الإيميل');

  });});
$('#btn-backup-now')?.addEventListener('click', ()=>{
  downloadFullBackup(false);
  showToast('تم تنزيل النسخة الاحتياطية');
});
$('#btn-backup-server-now')?.addEventListener('click', async ()=>{
  const btn = $('#btn-backup-server-now'); btn.disabled = true; btn.textContent = 'جارٍ الرفع…';
  try{
    const ok = await uploadBackupToServer('manual');
    showToast(ok ? 'تم رفع نسخة احتياطية للسيرفر' : 'تعذّر رفع النسخة الاحتياطية');
    if(ok) await renderServerBackupsList();
  }finally{ btn.disabled = false; btn.textContent = '☁️ نسخ احتياطي على السيرفر الآن'; }
});
async function renderServerBackupsList(){
  const wrap = $('#server-backups-list');
  if(!wrap) return;
  wrap.innerHTML = '<div class="hint hint-info">جارٍ التحميل...</div>';
  const rows = await listServerBackups();
  if(!rows.length){ wrap.innerHTML = '<div class="hint hint-info">لا توجد نسخ محفوظة على السيرفر بعد</div>'; return; }
  wrap.innerHTML = `<div class="table-scroll table-scroll-compact cards-mobile"><table><thead><tr>
    <th>التاريخ</th><th>النوع</th><th>الحجم</th><th>بواسطة</th><th></th></tr></thead><tbody>
    ${rows.map(r=>`<tr>
      <td class="mono" data-label="التاريخ">${new Date(r.created_at).toLocaleString('ar-SA-u-nu-latn')}</td>
      <td data-label="النوع">${r.kind==='manual'?'يدوية':'تلقائية'}</td>
      <td class="mono" data-label="الحجم">${((r.size_bytes||0)/1024).toFixed(0)} كيلوبايت</td>
      <td data-label="بواسطة">${escapeHtml(r.created_by||'—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" data-dl-backup="${r.id}">⬇️ تنزيل</button>
        <button class="btn btn-danger btn-sm" data-del-backup="${r.id}">🗑️</button>
      </td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
$('#btn-refresh-server-backups')?.addEventListener('click', renderServerBackupsList);
document.addEventListener('click', async (e)=>{
  const dl = e.target.closest('[data-dl-backup]');
  if(dl){ try{ await downloadServerBackup(dl.dataset.dlBackup); }catch(err){ showToast('تعذّر تنزيل النسخة: '+(err.message||'')); } return; }
  const del = e.target.closest('[data-del-backup]');
  if(del){
    if(!await customConfirm('حذف هذه النسخة الاحتياطية نهائياً؟')) return;
    try{ await deleteServerBackup(del.dataset.delBackup); await renderServerBackupsList(); }
    catch(err){ showToast('تعذّر حذف النسخة: '+(err.message||'')); }
  }
});
$('#btn-restore-backup')?.addEventListener('click', ()=> $('#restore-backup-input')?.click());
$('#restore-backup-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(file) await restoreFullBackup(file);
  e.target.value = '';
});
$('#btn-restore-bagstock')?.addEventListener('click', ()=> $('#restore-bagstock-input')?.click());
$('#restore-bagstock-input')?.addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(file) await restoreBagStockOnly(file);
  e.target.value = '';
});
$('#btn-add-user')?.addEventListener('click', async ()=>{
  const uname = $('#new-user-name').value.trim();
  const upass = $('#new-user-pass').value;
  const urole = $('#new-user-role').value;
  const uemail = $('#new-user-email') ? $('#new-user-email').value.trim() : '';
  if(!uname || !upass){ showToast('أدخل اسم المستخدم وكلمة المرور'); return; }
  if(upass.length < 6){ showToast('كلمة المرور يجب ألا تقل عن 6 أحرف'); return; }
  try{
    const res = await fetch(API_BASE + '/api/users', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + SERVER_AUTH_TOKEN },
      body: JSON.stringify({ username: uname, password: upass, displayName: uname, role: urole, email: uemail || undefined })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'تعذّر إضافة المستخدم');
    await logAudit('add','المستخدمون', `تمت إضافة/تحديث مستخدم على الخادم: ${uname} (${SERVER_ROLE_LABELS[urole]||urole})`);
    $('#new-user-name').value=''; $('#new-user-pass').value=''; if($('#new-user-email')) $('#new-user-email').value='';
    await renderUsersList();
    showToast('تمت إضافة المستخدم');
  }catch(e){
    showToast(e.message || 'تعذّر إضافة المستخدم');
  }
});
document.addEventListener('click', async e=>{
  if(e.target.dataset.rt!==undefined){
    const username = e.target.dataset.rt;
    const willActivate = e.target.dataset.rtActive === '0';
    const msg = willActivate
      ? `تأكيد تفعيل حساب "${username}" مجدداً؟ سيتمكن من تسجيل الدخول من جديد.`
      : `تأكيد تعطيل حساب "${username}"؟ لن يستطيع تسجيل الدخول بعد الآن، وسيُنهى أي جلسة مفتوحة له فوراً.`;
    if(await customConfirm(msg)){
      try{
        const res = await fetch(API_BASE + '/api/users/' + encodeURIComponent(username) + '/toggle-active', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN }
        });
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || 'تعذّر تغيير حالة المستخدم');
        await logAudit('edit','المستخدمون', `تم ${data.isActive ? 'تفعيل' : 'تعطيل'} حساب المستخدم "${username}"`);
        await renderUsersList();
        showToast(data.isActive ? `تم تفعيل حساب "${username}"` : `تم تعطيل حساب "${username}"`);
      }catch(err){
        showToast(err.message || 'تعذّر تغيير حالة المستخدم');
      }
    }
    return;
  }
  if(e.target.dataset.ru!==undefined){
    const username = e.target.dataset.ru;
    if(await customConfirm(`تأكيد حذف المستخدم "${username}"؟ لن يستطيع تسجيل الدخول بعد ذلك.`)){
      try{
        const res = await fetch(API_BASE + '/api/users/' + encodeURIComponent(username), {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + SERVER_AUTH_TOKEN }
        });
        const data = await res.json();
        if(!res.ok) throw new Error(data.error || 'تعذّر حذف المستخدم');
        await logAudit('delete','المستخدمون', `تم حذف مستخدم من الخادم: ${username}`);
        await renderUsersList();
        showToast('تم حذف المستخدم');
      }catch(err){
        showToast(err.message || 'تعذّر حذف المستخدم');
      }
    }
  }
});
$('#btn-add-course')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-add-course'), async ()=>{
  const name = $('#new-course-name').value.trim();
  const price = num($('#new-course-price').value);
  if(!name) return;
  const dup = settings.courses.find(c=> String(c.name||'').trim().toLowerCase() === name.toLowerCase());
  if(dup){
    showToast(`نوع الدورة "${dup.name}" مسجّل بالفعل بنفس الاسم (بغض النظر عن حالة الأحرف) — لن تتم إضافته مرة أخرى لتفادي التكرار`);
    return;
  }
  snapshotState(`إضافة نوع دورة: ${name}`);
  settings.courses.push({name, price});
  $('#new-course-name').value=''; $('#new-course-price').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة نوع دورة: ${name} (${fmt(price)})`);
  renderSettings(); refreshFilterOptions();

  });});
$('#btn-add-nat')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-add-nat'), async ()=>{
  const v = $('#new-nat').value.trim(); if(!v) return;
  const dup = (settings.nationalities||[]).find(n=> String(n||'').trim().toLowerCase() === v.toLowerCase());
  if(dup){
    showToast(`الجنسية "${dup}" مسجّلة بالفعل بنفس الاسم (بغض النظر عن حالة الأحرف) — لن تتم إضافتها مرة أخرى لتفادي التكرار`);
    return;
  }
  snapshotState(`إضافة جنسية: ${v}`);
  settings.nationalities.push(v); $('#new-nat').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة جنسية: ${v}`);
  renderSettings(); refreshFilterOptions();

  });});
$('#btn-add-channel')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-add-channel'), async ()=>{
  const v = $('#new-channel').value.trim(); if(!v) return;
  snapshotState(`إضافة طريقة دفع: ${v}`);
  settings.channels.push({name:v, dest:$('#new-channel-dest').value});
  $('#new-channel').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة طريقة دفع: ${v}`);
  renderSettings(); refreshFilterOptions();

  });});
$('#btn-add-expcat')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-add-expcat'), async ()=>{
  const v = $('#new-expcat').value.trim(); if(!v) return;
  snapshotState(`إضافة تصنيف مصروف: ${v}`);
  settings.expenseCategories.push(v); $('#new-expcat').value='';
  await saveSettings();
  await logAudit('add','الإعدادات', `تمت إضافة تصنيف مصروف: ${v}`);
  renderSettings();

  });});
document.addEventListener('click', async e=>{
  if(e.target.dataset.rc!==undefined){
    const removed = settings.courses[+e.target.dataset.rc];
    snapshotState(`حذف نوع دورة: ${removed?.name}`);
    settings.courses.splice(+e.target.dataset.rc,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف نوع دورة: ${removed?.name}`);
    renderSettings(); refreshFilterOptions();
  }
  if(e.target.dataset.rn!==undefined){
    const removed = settings.nationalities[+e.target.dataset.rn];
    snapshotState(`حذف جنسية: ${removed}`);
    settings.nationalities.splice(+e.target.dataset.rn,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف جنسية: ${removed}`);
    renderSettings(); refreshFilterOptions();
  }
  if(e.target.dataset.rh!==undefined){
    const removed = settings.channels[+e.target.dataset.rh];
    snapshotState(`حذف طريقة دفع: ${removed?.name}`);
    settings.channels.splice(+e.target.dataset.rh,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف طريقة دفع: ${removed?.name}`);
    renderSettings();
  }
  if(e.target.dataset.re!==undefined){
    const removed = settings.expenseCategories[+e.target.dataset.re];
    snapshotState(`حذف تصنيف مصروف: ${removed}`);
    settings.expenseCategories.splice(+e.target.dataset.re,1); await saveSettings();
    await logAudit('delete','الإعدادات', `تم حذف تصنيف مصروف: ${removed}`);
    renderSettings();
  }
});
$('#btn-reset')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-reset'), async ()=>{
  if(await customConfirm('سيتم حذف جميع بيانات العملاء نهائياً. متأكد؟')){
    const countBefore = clients.length;
    snapshotState(`حذف جميع بيانات العملاء (${countBefore} سجل)`);
    clients = [];
    await saveClients(true);
    await logAudit('delete','العملاء', `تم حذف جميع بيانات العملاء دفعة واحدة (${countBefore} سجل)`);
    renderTable(); renderDashboard(); renderBags();
    showToast('تم حذف جميع البيانات');
  }

  });});
$('#btn-save-bagprice')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-bagprice'), async ()=>{
  const oldPrice = settings.bagPrice;
  settings.bagPrice = num($('#set-bagprice').value);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تم تعديل قيمة الحقيبة من ${fmt(oldPrice)} إلى ${fmt(settings.bagPrice)}`);
  showToast('تم حفظ قيمة الحقيبة');

  });});

$('#btn-save-nat-prices')?.addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-save-nat-prices'), async ()=>{
  const oldSaudi = settings.priceSaudi, oldNonSaudi = settings.priceNonSaudi;
  settings.priceSaudi = num($('#set-price-saudi').value);
  settings.priceNonSaudi = num($('#set-price-nonsaudi').value);
  await saveSettings();
  await logAudit('edit','الإعدادات', `تم تعديل سعر الدورة حسب الجنسية: السعودي من ${fmt(oldSaudi)} إلى ${fmt(settings.priceSaudi)}، وغير السعودي من ${fmt(oldNonSaudi)} إلى ${fmt(settings.priceNonSaudi)}`);
  showToast('تم حفظ أسعار الدورة حسب الجنسية');

  });});

