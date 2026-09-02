function bulkAddRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="ba-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="ba-name" data-col="1" placeholder="اسم العميل" style="min-width:130px;"></td>
    <td><input type="text" class="ba-phone" data-col="2" style="min-width:100px;"></td>
    <td><select class="ba-nat" data-col="3" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="ba-course" data-col="4" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="ba-coursenum" data-col="5" style="min-width:90px;"></td>
    <td><input type="date" class="ba-date" data-col="6" value="${todayISO()}" style="min-width:130px;"></td>
    <td><input type="number" class="ba-price" data-col="7" value="${settings.coursePrice||0}" style="min-width:90px;"></td>
    <td><input type="number" class="ba-discount" data-col="8" value="0" style="min-width:80px;"></td>
    <td><input type="number" class="ba-paid" data-col="9" value="0" style="min-width:90px;"></td>
    <td><select class="ba-channel" data-col="10" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="ba-notes" data-col="11" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm ba-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkAddRow(){
  bulkAddRowSeq++;
  $('#bulk-add-table-body').insertAdjacentHTML('beforeend', bulkAddRowHtml(bulkAddRowSeq));
}
function openBulkAddModal(){
  $('#bulk-add-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkAddRow();
  $('#bulk-add-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkAddModal(){ $('#bulk-add-overlay').classList.remove('show'); }
$('#btn-bulk-add').addEventListener('click', openBulkAddModal);
$('#btn-bulk-add-cancel').addEventListener('click', closeBulkAddModal);
$('#bulk-add-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-add-overlay') closeBulkAddModal(); });
$('#btn-bulk-add-row').addEventListener('click', addBulkAddRow);
$('#bulk-add-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('ba-remove-row')){
    const rows = $('#bulk-add-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// يحول تاريخاً مكتوباً بصيغة يوم/شهر/سنة (الشائعة عند النسخ من إكسل) إلى صيغة yyyy-mm-dd التي يفهمها حقل التاريخ
function normalizeDateForBulkPaste(val){
  val = val.trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const m = val.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m){
    const day = m[1].padStart(2,'0'), month = m[2].padStart(2,'0'), year = m[3];
    return `${year}-${month}-${day}`;
  }
  return null;
}
// يختار في القائمة المنسدلة الخيار المطابق (نصاً) لما تم لصقه، متجاهلاً حالة الأحرف والمسافات الزائدة
function setBulkSelectFuzzy(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة: يوزَّع تلقائياً على الصفوف بدءاً من الخلية التي بدأ منها اللصق،
// ويُضيف صفوفاً جديدة تلقائياً إن لم تكفِ الصفوف الحالية لعدد القيم الملصوقة
$('#bulk-add-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return; // لصق خلية واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop(); // إزالة سطر فارغ أخير ناتج عن نسخ إكسل
  const tbody = $('#bulk-add-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkAddRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>11) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzy(field, val);
      else if(field.classList.contains('ba-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-add-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-add-table-body').querySelectorAll('tr')];
  const toAdd = [];
  const errors = [];
  const seenIdsThisBatch = new Set();
  rows.forEach((row, i)=>{
    const clientId = row.querySelector('.ba-id').value.trim();
    const name = row.querySelector('.ba-name').value.trim();
    // صف فارغ بالكامل (لم يُدخَل فيه شيء) يُتجاهل بصمت بدل اعتباره خطأً
    if(!clientId && !name) return;
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!/^\d{10}$/.test(clientId)){ errors.push(`${rowLabel}: رقم الهوية يجب أن يتكون من 10 أرقام بالضبط`); return; }
    if(!name){ errors.push(`${rowLabel}: الاسم مطلوب`); return; }
    if(clients.find(c=>c.clientId===clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مستخدم بالفعل لعميل آخر`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    // ملحوظة: كان هذا الصف يضع تلقائياً bagSource='stock' + bagStatus='purchased' لكل عميل
    // يُضاف عبر هذا الجدول، أي أن البرنامج كان "يشتري"/يسلّم حقيبة من المخزون فوراً لكل عميل
    // دون أي اختيار من المستخدم. تم إلغاء هذا السلوك التلقائي بناءً على طلب صريح: الحقيبة الآن
    // تُسجَّل بحالة "مطلوب الشراء" (نفس افتراضي نموذج الإضافة الفردية)، ولا تُخصم أي حقيبة من
    // المخزون ولا يُسجَّل أي شراء إلا يدوياً لاحقاً من شيت العملاء أو مخزون الحقائب.
    const bagSource = 'buy';
    const rowDate = row.querySelector('.ba-date').value || todayISO();
    toAdd.push({
      id: uid(), createdAt: Date.now(), createdBy: currentUser,
      clientId, name,
      phone: row.querySelector('.ba-phone').value.trim(),
      nationality: row.querySelector('.ba-nat').value,
      clientType: 'center',
      companyName: '', creditDays: '',
      clientTaxNumber: '',
      courseType: row.querySelector('.ba-course').value,
      courseNumber: row.querySelector('.ba-coursenum').value.trim(),
      referNum: '', invoice: '', bagInvoice: '',
      date: rowDate,
      coursePrice: num(row.querySelector('.ba-price').value),
      bagSource, bagPrice: num(settings.bagPrice),
      bagStatus: 'pending',
      discount: num(row.querySelector('.ba-discount').value),
      paid: num(row.querySelector('.ba-paid').value),
      channel: row.querySelector('.ba-channel').value,
      networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
      stage: 'جديد', cancelled: false,
      notes: row.querySelector('.ba-notes').value.trim()
    });
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!toAdd.length){ showToast('لم تُدخل بيانات أي عميل'); return; }
  // (تحديث): أُزيل انتظار _clientsFirstRealSyncDone هنا عمداً بناءً على طلب صريح — راجع تعليق
  // submit handler الرئيسي أعلاه لنفس المنطق بالتفصيل.
  // فحص إضافي عبر الخادم عن أرقام هوية مكررة موجودة فعلاً فى النظام ولا تظهر فى القائمة المحمَّلة
  // محلياً (نفس سبب الفحص المضاف فى النموذج الفردي أعلاه — مهم خصوصاً لمستخدم الاستقبال المعزول).
  // مهلة 8 ثوانٍ فقط بدل الافتراضي 60 ثانية — راجع تعليق fetchAllClientIds فى النموذج الفردي.
  const allIdsBulk = await fetchAllClientIds(8000);
  if(allIdsBulk){
    const hashes = await Promise.all(toAdd.map(c=>sha256Hex(c.clientId).catch(()=>null)));
    const dupRows = toAdd.filter((c,i)=>hashes[i] && allIdsBulk.has(hashes[i]));
    if(dupRows.length){
      showToast(`رقم الهوية مستخدم بالفعل فى النظام: ${dupRows.map(c=>c.clientId).join('، ')}`);
      return;
    }
  }
  snapshotState(`إضافة ${toAdd.length} عميل دفعة واحدة`);
  toAdd.forEach(c=>{ clients.push(c); syncClientLedgerEntry(c); });
  if(!_clientsSyncBaseline){
    // مزامنة العملاء الحقيقية الأولى لسه ماكملتش هذه الجلسة — نرفع فقط العملاء الجدد المضافين هنا
    // تحديداً كسجلات مباشرة (آمنة دائماً لأن معرّفاتهم جديدة فعلاً) بدل استدعاء saveClients() الذي
    // كان سيرفع كل قائمة العملاء المحلية دفعة واحدة اعتماداً على لقطة قد تكون قديمة.
    try{
      const conflictIds = await bulkUploadClientRecords(toAdd);
      const conflictSet = new Set(conflictIds);
      if(!_clientsSyncBaseline) _clientsSyncBaseline = new Map();
      for(const c of toAdd){ if(!conflictSet.has(c.id)) _clientsSyncBaseline.set(c.id, JSON.stringify(c)); }
    }catch(e){ /* فشل اتصال فعلي — bulkUploadClientRecords سجّلت كل عميل فى طابور المعلّقات بالفعل */ }
    if(typeof _scheduleClientsSnapPersist==='function') _scheduleClientsSnapPersist();
  }else{
    await saveClients();
  }
  await syncBagStockIssues();
  await saveVaultTx();
  await saveSettings();
  await logAudit('add','العملاء', `تمت إضافة ${toAdd.length} عميل دفعة واحدة عبر جدول الإضافة المتعددة: ${toAdd.map(c=>c.name).join('، ')}`);
  closeBulkAddModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderCourses(); renderBags();
});


/* ---------------- جلب العملاء الجدد من جوجل شيت (CSV منشور) ----------------
   المستخدم ينشر جوجل شيت كـ CSV (File > Share > Publish to web > CSV) ثم يلصق الرابط.
   صفوف الشيت المتوقعة (بأي ترتيب، تُطابَق حسب الترويسة إن وُجدت): الاسم، رقم الهوية،
   الجوال/الهاتف، الجنسية، المدفوع/قيمة المدفوع، طريقة الدفع. */
function _normHeader(h){
  h = h.trim().toLowerCase();
  if(/^\ufeff/.test(h)) h = h.replace(/^\ufeff/, '');
  // تجميع المرادفات الشائعة لكل عمود
  if(/اسم/.test(h)) return 'name';
  if(/هوية/.test(h) || /رقم.*بطاقة/.test(h) || /بطاقة/.test(h)) return 'id';
  if(/جوال/.test(h) || /هاتف/.test(h) || /موبايل/.test(h) || /phone/.test(h) || /mobile/.test(h)) return 'phone';
  if(/جنسية/.test(h) || /national/.test(h)) return 'nationality';
  if(/مدفوع/.test(h) || /دفع.*قيمة/.test(h) || /paid/.test(h) ||/amount/.test(h)) return 'paid';
  if(/طريقة/.test(h) || /طريقة الدفع/.test(h) || /channel/.test(h) || /method/.test(h)) return 'channel';
  if(/دورة/.test(h) && !/رقم/.test(h)) return 'courseType';
  if(/رقم الدورة/.test(h)) return 'courseNum';
  return h;
}
function _parseCsvLine(line){
  const out = []; let cur = '', inQ = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(inQ){
      if(ch==='"' && line[i+1]==='"'){ cur += '"'; i++; }
      else if(ch==='"') inQ = false;
      else cur += ch;
    }else{
      if(ch==='"') inQ = true;
      else if(ch===','){ out.push(cur); cur=''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(v=>v.trim());
}
function _gsheetNormalizeDate(v){
  v = String(v||'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return null;
}
async function _fetchGoogleSheetCsv(url){
  // يقبل صيغ متعددة لرابط الشيت وينتجه كرابط تصدير CSV إن لم يكن كذلك أصلاً
  let finalUrl = url.trim();
  if(!/^https?:\/\//i.test(finalUrl)) return {error:'رابط غير صالح'};
  const exportMatch = finalUrl.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\/export\?format=csv/);
  const gidMatch = /[?&]gid=(\d+)/.exec(finalUrl);
  const editMatch = finalUrl.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\/edit/);
  if(!exportMatch && editMatch){
    finalUrl = `https://docs.google.com/spreadsheets/d/${editMatch[1]}/export?format=csv${gidMatch?('&gid='+gidMatch[1]):''}`;
  }
  const res = await fetch(finalUrl, {cache:'no-store'});
  if(!res.ok) throw new Error(`تعذّر الجلب (HTTP ${res.status})`);
  return await res.text();
}
// يحلل نص CSV ويعيد {colMap, dataRows} أو {error}
function _parseGSheetCsvText(csv){
  const lines = String(csv||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim()!=='');
  if(lines.length < 2) return {error:'الشيت فارغ أو لا يحتوي بيانات'};
  const header = _parseCsvLine(lines[0]).map(_normHeader);
  const colMap = {name:-1,id:-1,phone:-1,nationality:-1,paid:-1,channel:-1,courseType:-1,courseNum:-1};
  header.forEach((h,i)=>{ if(colMap[h]!==undefined && colMap[h]===-1) colMap[h]=i; });
  const dataRows = lines.slice(1).map(_parseCsvLine).filter(r=>r.some(c=>c!==''));
  if(!dataRows.length) return {error:'لا توجد صفوف بيانات'};
  return {colMap, dataRows};
}
function _sheetValue(r, colMap, key){ const i = colMap[key]; return (i>=0 && i<r.length) ? r[i] : ''; }
// يحوّل صفاً من الشيت إلى كائن عميل جاهز للإضافة — نفس بناء كائن الإضافة المتعددة
function _buildClientFromSheetRow(r, colMap){
  return {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId: _sheetValue(r,colMap,'id'),
    name: _sheetValue(r,colMap,'name'),
    phone: _sheetValue(r,colMap,'phone'),
    nationality: _sheetValue(r,colMap,'nationality'),
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: _sheetValue(r,colMap,'courseType'),
    courseNumber: _sheetValue(r,colMap,'courseNum'),
    referNum: '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: num(settings.coursePrice),
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending',
    discount: 0,
    paid: num(_sheetValue(r,colMap,'paid')),
    channel: _sheetValue(r,colMap,'channel'),
    networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: ''
  };
}
// يملأ جدول الإضافة المتعددة بصفوف الشيت (للاستخدام اليدوي داخل النافذة)
function _fillBulkAddTable(colMap, dataRows, mode){
  const tbody = $('#bulk-add-table-body');
  if(mode==='fill') tbody.innerHTML = '';
  dataRows.forEach(r=>{
    if(mode!=='fill' && !r.some(v=>v.trim?.())) return;
    tbody.insertAdjacentHTML('beforeend', bulkAddRowHtml(++bulkAddRowSeq));
    const row = tbody.lastElementChild;
    row.querySelector('.ba-id').value = _sheetValue(r,colMap,'id');
    row.querySelector('.ba-name').value = _sheetValue(r,colMap,'name');
    row.querySelector('.ba-phone').value = _sheetValue(r,colMap,'phone');
    setBulkSelectFuzzy(row.querySelector('.ba-nat'), _sheetValue(r,colMap,'nationality'));
    setBulkSelectFuzzy(row.querySelector('.ba-course'), _sheetValue(r,colMap,'courseType'));
    row.querySelector('.ba-coursenum').value = _sheetValue(r,colMap,'courseNum');
    const paid = num(_sheetValue(r,colMap,'paid'));
    if(paid>0) row.querySelector('.ba-paid').value = paid;
    setBulkSelectFuzzy(row.querySelector('.ba-channel'), _sheetValue(r,colMap,'channel'));
  });
}
// يضيف فعلياً العملاء الجدد (الذين رقم هويتهم غير موجود أصلافياً) عبر نفس مسار حفظ الإضافة المتعددة.
// يرجع {added, skipped}.
async function _importSheetClients(colMap, dataRows){
  const added = [], skipped = [];
  const seen = new Set();
  for(const r of dataRows){
    const clientId = _sheetValue(r,colMap,'id').trim();
    const name = _sheetValue(r,colMap,'name').trim();
    if(!/^\d{10}$/.test(clientId) || !name) continue;
    if(clients.some(c=>c.clientId===clientId) || seen.has(clientId)){ skipped.push(clientId); continue; }
    seen.add(clientId);
    added.push(_buildClientFromSheetRow(r, colMap));
  }
  if(!added.length) return {added, skipped};
  const allIds = await fetchAllClientIds(8000).catch(()=>null);
  if(allIds){
    const hashes = await Promise.all(added.map(c=>sha256Hex(c.clientId).catch(()=>null)));
    const newly = added.filter((c,i)=>!(hashes[i] && allIds.has(hashes[i])));
    const dupIds = added.filter((c,i)=>hashes[i] && allIds.has(hashes[i])).map(c=>c.clientId);
    dupIds.forEach(id=>skipped.push(id));
    added.splice(0, added.length); added.push(...newly);
  }
  if(!added.length) return {added, skipped};
  snapshotState(`إضافة ${added.length} عميل من جوجل شيت تلقائياً`);
  added.forEach(c=>{ clients.push(c); syncClientLedgerEntry(c); });
  if(!_clientsSyncBaseline){
    try{
      const conflictIds = await bulkUploadClientRecords(added);
      const conflictSet = new Set(conflictIds);
      if(!_clientsSyncBaseline) _clientsSyncBaseline = new Map();
      for(const c of added){ if(!conflictSet.has(c.id)) _clientsSyncBaseline.set(c.id, JSON.stringify(c)); }
    }catch(e){}
    if(typeof _scheduleClientsSnapPersist==='function') _scheduleClientsSnapPersist();
  }else{
    await saveClients();
  }
  return {added, skipped};
}
$('#btn-gsheet-fetch').addEventListener('click', async ()=>{
  const urlInput = $('#gsheet-csv-url');
  const url = (urlInput.value||'').trim();
  if(!url){ showToast('أدخل رابط جوجل شيت منشور كـ CSV أولاً'); return; }
  const mode = 'fill';
  const btn = $('#btn-gsheet-fetch');
  const orig = btn.textContent; btn.disabled = true; btn.textContent = 'جارٍ الجلب...';
  try{
    const csv = await _fetchGoogleSheetCsv(url);
    const parsed = _parseGSheetCsvText(csv);
    if(parsed.error){ showToast(parsed.error); return; }
    _fillBulkAddTable(parsed.colMap, parsed.dataRows, mode);
    showToast(`تم جلب ${parsed.dataRows.length} عميل من جوجل شيت (جاهزون للحفظ)`);
  }catch(err){
    showToast('فشل جلب الشيت: ' + (err.message || err));
  }finally{
    btn.disabled = false; btn.textContent = orig;
  }
});

/* ---------------- الجلب التلقائي الدوري للعملاء من جوجل شيت ----------------
   عند تفعيل الإعداد (settings.gsheetSync) يجلب البرنامج الشيت كل بضع دقائق ويضيف
   تلقائياً أي عملاء جدد (حسب رقم الهوية) دون تدخل — ويحفظهم فوراً عبر نفس مسار
   الإضافة المتعددة. لا يمسّ العملاء الموجودين ولا يعدّل بياناتهم. */
let _gsheetAutoInterval = null;
function _loadGSheetSyncCfg(){
  const s = (settings && settings.gsheetSync) || {};
  return { enabled: !!s.enabled, url: String(s.url||'').trim(), intervalMin: Math.max(1, Number(s.intervalMin)||2) };
}
async function _runGSheetAutoSyncOnce(){
  const cfg = _loadGSheetSyncCfg();
  if(!cfg.enabled || !cfg.url) return;
  if(typeof clients === 'undefined' || !Array.isArray(clients) || !clients.length) return;
  try{
    const csv = await _fetchGoogleSheetCsv(cfg.url);
    const parsed = _parseGSheetCsvText(csv);
    if(parsed.error) return;
    const { added } = await _importSheetClients(parsed.colMap, parsed.dataRows);
    if(added.length){
      renderTable && renderTable(); renderDashboard && renderDashboard();
      refreshFilterOptions && refreshFilterOptions(); renderCourses && renderCourses();
      showToast(`تمت إضافة ${added.length} عميل جديد تلقائياً من جوجل شيت`);
    }
  }catch(e){
    // إخفاء أخطاء الجلب الدوري — سنعيد المحاولة في الدورة القادمة
  }
}
function _startGSheetAutoSync(){
  if(_gsheetAutoInterval) clearInterval(_gsheetAutoInterval);
  _gsheetAutoInterval = setInterval(_runGSheetAutoSyncOnce, 60000 * _loadGSheetSyncCfg().intervalMin);
  _runGSheetAutoSyncOnce();
}
// بدء الجلب التلقائي عند اكتمال تحميل بيانات العملاء
const _startGsAuto = ()=>_startGSheetAutoSync();
window.__startGSheetAutoSync = _startGSheetAutoSync;
// نستمع لبدء محاولة المزامنة الأولى الحقيقية (يُطلقها نظام التحميل) — إن لم يتوفر نبدأ بأمان لاحقاً
setTimeout(()=>{ try{ _startGsAuto(); }catch(e){} }, 3000);

/* ---------------- إدارة إعدادات الجلب التلقائي (حفظ/تحميل/عرض الحالة) ---------------- */
function _refreshGSheetStatus(){
  const el = $('#gsheet-status');
  if(!el) return;
  const cfg = _loadGSheetSyncCfg();
  el.textContent = cfg.enabled && cfg.url
    ? `التلقائي مفعّل (كل ${cfg.intervalMin} دقيقة)`
    : 'التلقائي غير مفعّل';
}
function _loadGSheetCfgIntoUI(){
  const cfg = _loadGSheetSyncCfg();
  const urlEl = $('#gsheet-csv-url');
  if(urlEl && cfg.url) urlEl.value = cfg.url;
  const en = $('#gsheet-auto-enabled'); if(en) en.checked = !!cfg.enabled;
  const iv = $('#gsheet-auto-interval'); if(iv) iv.value = cfg.intervalMin;
  _refreshGSheetStatus();
}
$('#btn-gsheet-save-cfg').addEventListener('click', async ()=>{
  const cfg = _loadGSheetSyncCfg();
  cfg.url = ($('#gsheet-csv-url').value||'').trim();
  if(!cfg.url){ showToast('أدخل رابط جوجل شيت منشور كـ CSV أولاً'); return; }
  cfg.enabled = !!$('#gsheet-auto-enabled').checked;
  cfg.intervalMin = Math.max(1, Number($('#gsheet-auto-interval').value)||2);
  settings.gsheetSync = cfg;
  await saveSettings();
  _startGSheetAutoSync();
  _refreshGSheetStatus();
  showToast(cfg.enabled ? `تم تفعيل الجلب التلقائي كل ${cfg.intervalMin} دقيقة` : 'تم تعطيل الجلب التلقائي');
});
// تزويد واجهة الإعدادات بالقيم الحالية عند فتح نافذة الإضافة المتعددة
const _origOpenBulkAdd = openBulkAddModal;
openBulkAddModal = function(){
  _origOpenBulkAdd.apply(this, arguments);
  _loadGSheetCfgIntoUI();
};

/* ---------------- تحديث/استيراد بيانات العملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الاستيراد القديم عبر ملفات Excel (البيانات الرئيسية + الخصم + نوع الدورة + الأسماء).
   القاعدة: رقم الهوية إلزامي في كل صف. إن كان موجوداً بالفعل تُحدَّث فقط الأعمدة التي بها قيمة في هذا
   الصف (أي عمود فارغ يبقى كما هو في النظام دون تغيير) — تماماً كمنطق الاستيراد القديم؛ وإن لم يكن
   موجوداً يُضاف كعميل جديد بشرط توفر الاسم أيضاً. هذا يجعل نفس الجدول صالحاً لتحديث الخصم فقط، أو نوع
   الدورة فقط، أو الاسم فقط، أو أي مجموعة أعمدة، دون الحاجة لملء بقية الصف. */
let bulkUpdateRowSeq = 0;
function buFixedOptionsHtml(pairs, selected){
  return '<option value=""></option>' + pairs.map(([v,l])=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(l)}</option>`).join('');
}
function bulkUpdateRowHtml(rowId){
  const natOptions = bulkAddOptionsHtml(settings.nationalities, '');
  const courseOptions = bulkAddOptionsHtml(settings.courses.map(c=>c.name), '');
  const channelOptions = bulkAddOptionsHtml(settings.channels.map(c=>c.name), '');
  const ctypeOptions = buFixedOptionsHtml([['center','عميل مركز'],['company','عميل شركات']], '');
  // مستخدم الاستقبال ممنوع تماماً من شراء/تسليم أي حقيبة من المخزون — لا يُعرَض له خيار "من المخزون" أصلاً
  const bagSourceOptions = currentUserRole==='reception'
    ? buFixedOptionsHtml([['buy','شراء'],['own','خاصته']], '')
    : buFixedOptionsHtml([['stock','من المخزون'],['buy','شراء'],['own','خاصته']], '');
  const cancelledOptions = buFixedOptionsHtml([['no','لا'],['yes','نعم']], '');
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bu-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="bu-name" data-col="1" style="min-width:130px;"></td>
    <td><input type="text" class="bu-refer" data-col="2" style="min-width:100px;"></td>
    <td><input type="text" class="bu-phone" data-col="3" style="min-width:100px;"></td>
    <td><select class="bu-nat" data-col="4" style="min-width:110px;">${natOptions}</select></td>
    <td><select class="bu-ctype" data-col="5" style="min-width:110px;">${ctypeOptions}</select></td>
    <td><input type="text" class="bu-company" data-col="6" style="min-width:130px;"></td>
    <td><input type="number" class="bu-credit" data-col="7" style="min-width:80px;"></td>
    <td><select class="bu-course" data-col="8" style="min-width:130px;">${courseOptions}</select></td>
    <td><input type="text" class="bu-coursenum" data-col="9" style="min-width:90px;"></td>
    <td><input type="text" class="bu-invoice" data-col="10" style="min-width:100px;"></td>
    <td><input type="date" class="bu-date" data-col="11" style="min-width:130px;"></td>
    <td><input type="number" class="bu-price" data-col="12" style="min-width:90px;"></td>
    <td><select class="bu-bagsource" data-col="13" style="min-width:110px;">${bagSourceOptions}</select></td>
    <td><input type="number" class="bu-bagprice" data-col="14" style="min-width:90px;"></td>
    <td><input type="text" class="bu-baginvoice" data-col="15" style="min-width:110px;"></td>
    <td><input type="number" class="bu-discount" data-col="16" style="min-width:80px;"></td>
    <td><input type="number" class="bu-paid" data-col="17" style="min-width:90px;"></td>
    <td><select class="bu-channel" data-col="18" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="number" class="bu-paid2" data-col="19" style="min-width:90px;"></td>
    <td><select class="bu-channel2" data-col="20" style="min-width:120px;">${channelOptions}</select></td>
    <td><input type="text" class="bu-netinvoice" data-col="21" style="min-width:110px;"></td>
    <td><input type="text" class="bu-stage" data-col="22" style="min-width:90px;"></td>
    <td><select class="bu-cancelled" data-col="23" style="min-width:80px;">${cancelledOptions}</select></td>
    <td><input type="text" class="bu-notes" data-col="24" style="min-width:130px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm bu-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkUpdateRow(){
  bulkUpdateRowSeq++;
  $('#bulk-update-table-body').insertAdjacentHTML('beforeend', bulkUpdateRowHtml(bulkUpdateRowSeq));
}
function openBulkUpdateModal(){
  $('#bulk-update-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkUpdateRow();
  $('#bulk-update-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkUpdateModal(){ $('#bulk-update-overlay').classList.remove('show'); }

/* ---------------- إرسال رسالة واتساب جماعية للعملاء المحددين (wa.me تسلسلي) ---------------- */
/* تستخدم دالة normalizePhoneForWhatsapp الموحّدة المعرَّفة أعلى الملف (تشمل التحقق من صحة طول الرقم) */
let bulkMsgQueue = [];
let bulkMsgIndex = 0;
let bulkMsgTemplate = '';

function openBulkMessageModal(){
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); return; }
  const recipients = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  const noPhoneCount = recipients.filter(c=>!normalizePhoneForWhatsapp(c.phone)).length;
  $('#bulk-msg-recipient-count').textContent = recipients.length;
  const warn = $('#bulk-msg-no-phone-warning');
  if(noPhoneCount>0){ warn.style.display=''; $('#bulk-msg-no-phone-count').textContent = noPhoneCount; }
  else { warn.style.display='none'; }
  $('#bulk-msg-text').value = '';
  $('#bulk-msg-setup-view').style.display = '';
  $('#bulk-msg-send-view').style.display = 'none';
  $('#bulk-message-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkMessageModal(){ $('#bulk-message-overlay').classList.remove('show'); }
function renderBulkMsgCurrent(){
  const c = bulkMsgQueue[bulkMsgIndex];
  $('#bulk-msg-current-index').textContent = bulkMsgIndex+1;
  $('#bulk-msg-total-count').textContent = bulkMsgQueue.length;
  $('#bulk-msg-current-name').textContent = c.name || '(بدون اسم)';
  const phone = normalizePhoneForWhatsapp(c.phone);
  $('#bulk-msg-current-phone').textContent = c.phone ? c.phone : '—';
  $('#bulk-msg-skip-hint').style.display = phone ? 'none' : '';
  $('#btn-bulk-message-open-wa').disabled = !phone;
  $('#btn-bulk-message-prev').disabled = bulkMsgIndex===0;
  $('#btn-bulk-message-next').textContent = (bulkMsgIndex===bulkMsgQueue.length-1) ? 'إنهاء ✓' : 'التالي ▶';
}
$('#btn-bulk-send-message').addEventListener('click', openBulkMessageModal);
$('#btn-bulk-message-cancel').addEventListener('click', closeBulkMessageModal);
$('#btn-bulk-message-close').addEventListener('click', closeBulkMessageModal);
$('#bulk-message-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-message-overlay') closeBulkMessageModal(); });
$('#btn-bulk-message-start').addEventListener('click', async ()=>{
  const text = $('#bulk-msg-text').value.trim();
  if(!text){ showToast('اكتب نص الرسالة أولاً'); return; }
  const ids = [...selectedClientIds].filter(id=>clients.some(c=>c.id===id));
  if(ids.length===0){ showToast('لم يتم تحديد أي عميل'); closeBulkMessageModal(); return; }
  bulkMsgQueue = ids.map(id=>clients.find(c=>c.id===id)).filter(Boolean);
  bulkMsgTemplate = text;
  bulkMsgIndex = 0;
  $('#bulk-msg-setup-view').style.display = 'none';
  $('#bulk-msg-send-view').style.display = '';
  renderBulkMsgCurrent();
  await logAudit('other','العملاء', `بدء إرسال رسالة واتساب جماعية لعدد ${bulkMsgQueue.length} عميل`);
});
$('#btn-bulk-message-open-wa').addEventListener('click', ()=>{
  const c = bulkMsgQueue[bulkMsgIndex];
  const phone = normalizePhoneForWhatsapp(c.phone);
  if(!phone) return;
  const personalized = bulkMsgTemplate.replaceAll('{name}', c.name || '');
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(personalized)}`;
  window.open(url, '_blank');
});
$('#btn-bulk-message-prev').addEventListener('click', ()=>{
  if(bulkMsgIndex>0){ bulkMsgIndex--; renderBulkMsgCurrent(); }
});
$('#btn-bulk-message-next').addEventListener('click', ()=>{
  if(bulkMsgIndex < bulkMsgQueue.length-1){ bulkMsgIndex++; renderBulkMsgCurrent(); }
  else { showToast('تم الانتهاء من قائمة الإرسال'); closeBulkMessageModal(); }
});

$('#btn-bulk-update').addEventListener('click', openBulkUpdateModal);
$('#btn-bulk-update-cancel').addEventListener('click', closeBulkUpdateModal);
$('#bulk-update-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-update-overlay') closeBulkUpdateModal(); });
$('#btn-bulk-update-row').addEventListener('click', addBulkUpdateRow);
$('#bulk-update-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bu-remove-row')){
    const rows = $('#bulk-update-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق منسوخ من إكسل، مع مطابقة نصّية (لا قيمة فقط) لقوائم الاختيار ذات الأكواد الثابتة (نوع العميل/مصدر الحقيبة/ملغى)
function setBulkSelectFuzzyAny(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase() || o.textContent.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
$('#bulk-update-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#bulk-update-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkUpdateRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>24) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.tagName==='SELECT') setBulkSelectFuzzyAny(field, val);
      else if(field.classList.contains('bu-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-update-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-update-table-body').querySelectorAll('tr')];
  const present = v => !(v===undefined || v===null || String(v).trim()==='');
  const errors = [];
  const seenIdsThisBatch = new Set();
  const patches = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value;
    const clientId = val('bu-id').trim();
    const anyValue = [...row.querySelectorAll('input,select')].some(el=> el.value && String(el.value).trim()!=='');
    if(!clientId && !anyValue) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(seenIdsThisBatch.has(clientId)){ errors.push(`${rowLabel}: رقم الهوية ${clientId} مكرر داخل هذا الجدول`); return; }
    seenIdsThisBatch.add(clientId);
    const name = val('bu-name').trim();
    const existingIdx = clients.findIndex(c=>c.clientId===clientId);
    if(existingIdx>-1){
      const existing = clients[existingIdx];
      const patch = {};
      if(present(name)) patch.name = name;
      if(present(val('bu-refer'))) patch.referNum = val('bu-refer').trim();
      if(present(val('bu-phone'))) patch.phone = val('bu-phone').trim();
      if(present(val('bu-nat'))) patch.nationality = val('bu-nat');
      if(present(val('bu-ctype'))) patch.clientType = val('bu-ctype');
      if(present(val('bu-company'))) patch.companyName = val('bu-company').trim();
      if(present(val('bu-credit'))) patch.creditDays = num(val('bu-credit'));
      if(present(val('bu-course'))) patch.courseType = val('bu-course');
      if(present(val('bu-coursenum'))) patch.courseNumber = val('bu-coursenum').trim();
      if(present(val('bu-invoice'))) patch.invoice = val('bu-invoice').trim();
      if(present(val('bu-date'))) patch.date = val('bu-date');
      if(present(val('bu-price'))) patch.coursePrice = num(val('bu-price'));
      if(present(val('bu-baginvoice'))) patch.bagInvoice = val('bu-baginvoice').trim();
      if(present(val('bu-discount'))) patch.discount = num(val('bu-discount'));
      if(present(val('bu-paid'))) patch.paid = num(val('bu-paid'));
      if(present(val('bu-paid2'))) patch.paid2 = num(val('bu-paid2'));
      if(present(val('bu-channel2'))) patch.channel2 = val('bu-channel2');
      if(present(val('bu-channel'))) patch.channel = val('bu-channel');
      if(present(val('bu-netinvoice'))) patch.networkInvoice = val('bu-netinvoice').trim();
      if(present(val('bu-stage'))) patch.stage = val('bu-stage').trim() || 'جديد';
      if(present(val('bu-cancelled'))) patch.cancelled = val('bu-cancelled')==='yes';
      if(present(val('bu-notes'))) patch.notes = val('bu-notes').trim();
      if(present(val('bu-bagsource'))){
        // مستخدم الاستقبال ممنوع تماماً من شراء/تسليم أي حقيبة من المخزون
        const bagSourceNew = (currentUserRole==='reception' && val('bu-bagsource')==='stock') ? 'buy' : val('bu-bagsource');
        patch.bagSource = bagSourceNew;
        if(bagSourceNew==='own'){ patch.bagPrice = 0; }
        else if(present(val('bu-bagprice'))){ patch.bagPrice = num(val('bu-bagprice')); }
        if(bagSourceNew!=='buy'){ patch.bagStatus = bagSourceNew==='stock' ? 'purchased' : 'n/a'; }
        else if(!existing.bagStatus || existing.bagSource!=='buy'){ patch.bagStatus = 'pending'; }
        else { patch.bagStatus = existing.bagStatus; }
        const effectiveBagInvoice = present(val('bu-baginvoice')) ? patch.bagInvoice : existing.bagInvoice;
        if(bagSourceNew==='buy' && effectiveBagInvoice){
          patch.bagStatus = 'purchased';
          if(!existing.bagPurchaseDate) patch.bagPurchaseDate = todayISO();
        }
      } else if(present(val('bu-bagprice'))){
        patch.bagPrice = num(val('bu-bagprice'));
      }
      patches.push({mode:'update', idx: existingIdx, patch, oldCourseNumber: existing.courseNumber||''});
    } else {
      if(!name){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بالنظام — الاسم مطلوب لإضافته كعميل جديد`); return; }
      // مستخدم الاستقبال ممنوع تماماً من شراء/تسليم أي حقيبة من المخزون
      let bagSource = val('bu-bagsource') || 'stock';
      if(currentUserRole==='reception' && bagSource==='stock') bagSource = 'buy';
      const clientTypeRaw = val('bu-ctype') || 'center';
      const rowData = {
        clientId, name,
        referNum: val('bu-refer').trim(),
        phone: val('bu-phone').trim(),
        nationality: val('bu-nat'),
        clientType: clientTypeRaw,
        companyName: clientTypeRaw==='company' ? val('bu-company').trim() : '',
        creditDays: clientTypeRaw==='company' ? num(val('bu-credit')) : '',
        courseType: val('bu-course'),
        courseNumber: val('bu-coursenum').trim(),
        invoice: val('bu-invoice').trim(),
        date: val('bu-date') || todayISO(),
        coursePrice: num(val('bu-price')),
        bagSource,
        bagPrice: bagSource==='own' ? 0 : num(val('bu-bagprice')),
        bagInvoice: val('bu-baginvoice').trim(),
        discount: num(val('bu-discount')),
        paid: num(val('bu-paid')),
        paid2: num(val('bu-paid2')),
        channel2: val('bu-channel2'),
        channel: val('bu-channel'),
        networkInvoice: val('bu-netinvoice').trim(),
        stage: val('bu-stage').trim() || 'جديد',
        cancelled: val('bu-cancelled')==='yes',
        notes: val('bu-notes').trim(),
      };
      rowData.bagStatus = rowData.bagSource==='buy' ? 'pending' : (rowData.bagSource==='stock' ? 'purchased' : 'n/a');
      if(rowData.bagSource==='buy' && rowData.bagInvoice){
        rowData.bagStatus = 'purchased';
        rowData.bagPurchaseDate = todayISO();
      }
      patches.push({mode:'add', data:{id:uid(), createdAt:Date.now(), createdBy: currentUser, ...rowData}});
    }
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!patches.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  // نفس منع الحفظ أثناء نافذة المزامنة الأولى — راجع التعليق فى submit handler الرئيسي فى بداية الملف
  if(!(await waitForClientsFirstRealSync())){ showToast('⏳ لسه جارٍ التأكد من آخر نسخة محدَّثة من بيانات العملاء مع السيرفر — حاول تاني بعد ثانية واحدة'); return; }
  snapshotState(`تحديث/استيراد بيانات العملاء دفعة واحدة (${patches.length} صف)`);
  let added=0, updated=0;
  const changedRows = [];
  patches.forEach(p=>{
    if(p.mode==='update'){
      clients[p.idx] = {...clients[p.idx], ...p.patch};
      updated++;
      changedRows.push({'الإجراء':'تحديث', ...clientToExportRow(clients[p.idx])});
      if(p.patch.courseNumber && p.patch.courseNumber!==p.oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: clients[p.idx].clientId, name: clients[p.idx].name, courseNumber: clients[p.idx].courseNumber, courseType: clients[p.idx].courseType||''});
      }
    } else {
      clients.push(p.data);
      added++;
      changedRows.push({'الإجراء':'إضافة جديد', ...clientToExportRow(p.data)});
      sendPowerAutomateEvent('new_client', {clientId: p.data.clientId, name: p.data.name, nationality: p.data.nationality||'', phone: p.data.phone||'', courseType: p.data.courseType||'', courseNumber: p.data.courseNumber||''});
      if(p.data.courseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: p.data.clientId, name: p.data.name, courseNumber: p.data.courseNumber, courseType: p.data.courseType||''});
      }
    }
  });
  // دورة تلقائية: أي رقم دورة جديد ضمن هذه الدفعة (مفيش دورة بنفس الرقم بعد) يفتح دورة حقيقية محفوظة.
  let _sessionCreatedInBulk = false;
  patches.forEach(p=>{
    const c = p.mode==='update' ? clients[p.idx] : p.data;
    if(typeof ensureCourseSessionForClient==='function' && ensureCourseSessionForClient(c)) _sessionCreatedInBulk = true;
  });
  await saveClients();
  if(_sessionCreatedInBulk && typeof saveCourseSessions==='function') await saveCourseSessions();
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveVaultTx();
  await saveSettings();
  await syncBagStockIssues();
  await logAudit('edit','العملاء', `تحديث/استيراد بيانات العملاء من جدول داخل البرنامج: تمت إضافة ${added} عميل جديد، وتحديث ${updated} عميل موجود`);
  closeBulkUpdateModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderBags();
  showToast(`تم: ${added} جديد، ${updated} محدث`);
});

/* ---------------- حذف عملاء دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل الحذف عبر استيراد ملف Excel القديم؛ نفس منطق التأكيد والنسخة الاحتياطية والمزامنة المالية. */
let bulkDeleteRowSeq = 0;
function bulkDeleteRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="bd-id" data-col="0" maxlength="10" placeholder="رقم الهوية"></td>
    <td><button type="button" class="btn btn-danger btn-sm bd-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addBulkDeleteRow(){
  bulkDeleteRowSeq++;
  $('#bulk-delete-table-body').insertAdjacentHTML('beforeend', bulkDeleteRowHtml(bulkDeleteRowSeq));
}
function openBulkDeleteModal(){
  $('#bulk-delete-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addBulkDeleteRow();
  $('#bulk-delete-overlay').classList.add('show'); SoundFX.open();
}
function closeBulkDeleteModal(){ $('#bulk-delete-overlay').classList.remove('show'); }
$('#btn-bulk-delete-table').addEventListener('click', openBulkDeleteModal);
$('#btn-bulk-delete-cancel').addEventListener('click', closeBulkDeleteModal);
$('#bulk-delete-overlay').addEventListener('click', e=>{ if(e.target.id==='bulk-delete-overlay') closeBulkDeleteModal(); });
$('#btn-bulk-delete-row').addEventListener('click', addBulkDeleteRow);
$('#bulk-delete-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('bd-remove-row')){
    const rows = $('#bulk-delete-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bulk-delete-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text) return;
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  if(lines.length<=1 && !lines[0].includes('\t')) return; // لصق قيمة واحدة عادية — نترك السلوك الافتراضي
  e.preventDefault();
  const tbody = $('#bulk-delete-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addBulkDeleteRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('.bd-id');
    if(field) field.value = line.split('\t')[0].trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-bulk-delete-save').addEventListener('click', async ()=>{
  const rows = [...$('#bulk-delete-table-body').querySelectorAll('tr')];
  const idsInBatch = [...new Set(rows.map(r=>r.querySelector('.bd-id').value.trim()).filter(Boolean))];
  if(!idsInBatch.length){ showToast('لم تُدخل أي رقم هوية'); return; }
  const matchedAll = clients.filter(c=>idsInBatch.includes(c.clientId));
  const notFoundCount = idsInBatch.filter(id=>!clients.some(c=>c.clientId===id)).length;
  if(!matchedAll.length){ showToast('لم يتم العثور على أي عميل بأرقام الهوية المدخلة'); return; }
  const matched = matchedAll.filter(c=>canDeleteClientRecord(c));
  const blockedCount = matchedAll.length - matched.length;
  if(!matched.length){ showToast(`كل السجلات المطابقة (${matchedAll.length}) خارج مهلة الحذف المسموح بها أو الحذف معطَّل لصلاحيتك`); return; }
  if(blockedCount) showToast(`تم استبعاد ${blockedCount} سجل خارج مهلة الحذف المسموح بها`);
  const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
  const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
  const notFoundMsg = notFoundCount ? `\n(تنبيه: ${notFoundCount} رقم هوية غير موجودين أصلاً بالنظام وسيتم تجاهلهم)` : '';
  if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق. تأكيد حذفهم دفعة واحدة؟ (${namesPreview}${extra})${notFoundMsg}\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  snapshotState(`حذف عملاء دفعة واحدة عبر جدول (${matched.length} عميل)`);
  const idsSet = new Set(matched.map(c=>c.id));
  const removedNames = matched.map(c=>c.name);
  clients = clients.filter(c=>!idsSet.has(c.id));
  idsSet.forEach(id=>{ removeClientLedgerEntries(id); selectedClientIds.delete(id); });
  await saveClients(true); await saveVaultTx();
  await logAudit('delete','العملاء', `تم حذف ${matched.length} عميل عبر جدول داخل البرنامج: ${removedNames.slice(0,20).join('، ')}${removedNames.length>20?` وآخرين (${removedNames.length-20})`:''}${notFoundCount?` — تم تجاهل ${notFoundCount} رقم هوية غير موجود بالنظام`:''}`);
  closeBulkDeleteModal();
  renderTable(); renderDashboard(); refreshFilterOptions(); renderReports(); renderCourses(); renderBags();
  if(typeof renderVault==='function') renderVault();
  showToast(`تم حذف ${matched.length} عميل${notFoundCount?`، وتجاهل ${notFoundCount} رقم غير موجود`:''}`);
});


