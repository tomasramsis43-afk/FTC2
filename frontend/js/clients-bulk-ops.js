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
    <td><input type="text" class="ba-date" data-col="6" value="${todayISO()}" placeholder="YYYY-MM-DD" inputmode="numeric" style="min-width:130px;"></td>
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
$('#btn-bulk-add')?.addEventListener('click', openBulkAddModal);
$('#btn-bulk-add-cancel')?.addEventListener('click', closeBulkAddModal);
$('#bulk-add-overlay')?.addEventListener('click', e=>{ if(e.target.id==='bulk-add-overlay') closeBulkAddModal(); });
$('#btn-bulk-add-row')?.addEventListener('click', addBulkAddRow);
$('#bulk-add-table-body')?.addEventListener('click', e=>{
  if(e.target.classList.contains('ba-remove-row')){
    const rows = $('#bulk-add-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// أرقام عربية/فارسية → إنجليزية (بعض نسخ إكسل تنتج أرقاماً عربية لا يقبلها <input type=number/date>)
function normalizeBulkDigits(val){
  return String(val==null ? '' : val)
    .replace(/[٠-٩]/g, d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}
function bulkISODate(y, m, d){
  if(!(y>=1900 && y<=2200 && m>=1 && m<=12 && d>=1 && d<=31)) return null;
  const dt = new Date(Date.UTC(y, m-1, d));
  if(dt.getUTCFullYear()!==y || dt.getUTCMonth()!==m-1 || dt.getUTCDate()!==d) return null;
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
// أسماء الشهور بالإنجليزية والعربية — بعض نسخ إكسل تنتج تاريخاً نصياً مثل 16-Nov-2026 أو 16 نوفمبر 2026
const BULK_MONTHS = {
  jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4, may:5,
  jun:6, june:6, jul:7, july:7, aug:8, august:8, sep:9, sept:9, september:9,
  oct:10, october:10, nov:11, november:11, dec:12, december:12,
  'يناير':1, 'فبراير':2, 'مارس':3, 'أبريل':4, 'ابريل':4, 'مايو':5, 'يونيو':6,
  'يوليو':7, 'أغسطس':8, 'اغسطس':8, 'سبتمبر':9, 'أكتوبر':10, 'اكتوبر':10,
  'نوفمبر':11, 'ديسمبر':12
};
// يحول تاريخاً منسوخاً من إكسل إلى yyyy-mm-dd الذي يفهمه حقل التاريخ.
// يقبل: 2026-11-16 / 16/11/2026 / 11/16/2026 (أمريكي) / 16-Nov-2026 /
// 16 نوفمبر 2026 / 20261116 / الرقم التسلسلي لتواريخ إكسل (45678) /
// وأي منها مصحوباً بوقت أو بلاحقة «م» أو «هـ».
function normalizeDateForBulkPaste(val){
  let s = normalizeBulkDigits(val)
    .replace(/[\u200b-\u200f\u202a-\u202e\u061c]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if(!s) return null;
  // إزالة الوقت في النهاية: 16/11/2026 12:00:00 ص / 2026-11-16 00:00
  s = s.replace(/\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|ص|م))?$/i, '').trim();
  // إزالة لاحقة الميلادي/الهجري إن وُجدت
  s = s.replace(/\s*(?:م|هـ|ه)$/,'').trim();
  if(!s) return null;
  // ISO مع وقت
  if(/^\d{4}-\d{1,2}-\d{1,2}[T\s]/.test(s)) s = s.slice(0,10);

  // تاريخ بأسماء الشهور: 16 Nov 2026 / Nov 16, 2026 / 16 نوفمبر 2026
  const words = s.replace(/,/g,' ').replace(/\s+/g,' ').trim();
  let wm = words.match(/^(\d{1,2})[\s\-.]+([A-Za-z\u0600-\u06FF]+)[\s\-.]+(\d{2,4})$/);
  if(wm){
    const mon = BULK_MONTHS[wm[2].toLowerCase()];
    if(mon){
      let year = +wm[3];
      if(String(wm[3]).length===2) year += 2000;
      return bulkISODate(year, mon, +wm[1]);
    }
  }
  wm = words.match(/^([A-Za-z\u0600-\u06FF]+)[\s\-.]+(\d{1,2})[\s\-.]+(\d{2,4})$/);
  if(wm){
    const mon = BULK_MONTHS[wm[1].toLowerCase()];
    if(mon){
      let year = +wm[3];
      if(String(wm[3]).length===2) year += 2000;
      return bulkISODate(year, mon, +wm[2]);
    }
  }

  // تاريخ رقمي بفواصل / - .
  let m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/);
  if(m){
    let a = +m[1], b = +m[2], y = +m[3];
    if(m[1].length===4) return bulkISODate(a, b, y);       // yyyy/m/d
    if(String(m[3]).length===2) y += 2000;                  // dd/mm/yy
    let day, month;
    if(a>12 && b<=12){ day=a; month=b; }                    // dd/mm/yyyy
    else if(b>12 && a<=12){ day=b; month=a; }               // mm/dd/yyyy
    else { day=a; month=b; }                                // افتراضي: يوم/شهر
    return bulkISODate(y, month, day);
  }
  // yyyyMMdd
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if(m) return bulkISODate(+m[1], +m[2], +m[3]);
  // ddMMyyyy
  m = s.match(/^(\d{2})(\d{2})(\d{4})$/);
  if(m) return bulkISODate(+m[3], +m[2], +m[1]);

  // الرقم التسلسلي لتواريخ إكسل (يبدأ من 1899-12-30)
  if(/^\d+(?:\.\d+)?$/.test(s)){
    const n = parseFloat(s);
    if(n>=20000 && n<=80000){
      const dt = new Date(Date.UTC(1899,11,30) + Math.round(n)*86400000);
      return bulkISODate(dt.getUTCFullYear(), dt.getUTCMonth()+1, dt.getUTCDate());
    }
  }
  return null;
}
// أرقام مالية منسوخة من إكسل: "1,234.50 ر.س" أو "١٢٣٤٫٥" → "1234.50"
function normalizeBulkNumber(val){
  let s = normalizeBulkDigits(val).trim();
  if(!s) return '';
  s = s.replace(/[\u066C\u060C,\u00A0\s]/g,'').replace(/\u066B/g,'.').replace(/[^0-9.\-]/g,'');
  const neg = s.startsWith('-');
  s = s.replace(/-/g,'').replace(/\.+$/,'');
  const parts = s.split('.');
  if(parts.length>2) s = parts.slice(0,-1).join('') + '.' + parts[parts.length-1];
  else s = (parts[0] || '') + (parts.length>1 ? '.' + parts[1] : '');
  if(!s || s==='.') return '';
  return (neg ? '-' : '') + s;
}
// يختار في القائمة المنسدلة الخيار المطابق (نصاً) لما تم لصقه، متجاهلاً حالة الأحرف والمسافات الزائدة
function setBulkSelectFuzzy(select, val){
  val = val.trim();
  if(!val){ select.value=''; return; }
  const opt = [...select.options].find(o=> o.value.trim().toLowerCase()===val.toLowerCase());
  if(opt) select.value = opt.value;
}
// يضع قيمة ملصوقة في أي خلية (نص / رقم / تاريخ / قائمة) بنفس السلوك في كل الجداول الداخلية.
// يرجع false فقط لو كانت القيمة تاريخاً غير مفهوم.
function applyBulkPasteValue(field, raw){
  const val = raw==null ? '' : String(raw);
  if(field.tagName==='SELECT'){ setBulkSelectFuzzyAny(field, val); return true; }
  if(field.classList.contains('ba-date') || field.classList.contains('bu-date')){
    if(!val.trim()){
      field.value=''; field.style.borderColor=''; field.title=''; return true;
    }
    const norm = normalizeDateForBulkPaste(val);
    if(norm){
      field.value = norm; field.style.borderColor=''; field.title=''; return true;
    }
    // قيمة غير مفهومة: نضعها كما هي في الخانة (خانة التاريخ أصبحت نصية) حتى يراها المستخدم
    // ويصحّحها، مع إبرازها بالأحمر. الحفظ سيرفضها برسالة واضحة بدل تجاهلها بصمت.
    field.value = val.trim();
    field.style.borderColor = '#f87171';
    field.title = 'قيمة غير مفهومة: ' + val.trim();
    return false;
  }
  if(field.type==='number'){ field.value = normalizeBulkNumber(val); return true; }
  field.value = val.trim();
  return true;
}
// لصق خلية واحدة أو عدة خلايا في جداول الإدخال الداخلية (إضافة/تحديث العملاء).
// كان اللصق متوقفاً في خانات التاريخ لأن <input type=date> يرفض النص المنسوخ،
// وفي خانات الأرقام لأنها ترفض الفواصل/رموز العملة — الآن تُطبَّع القيم قبل وضعها.
function bindBulkTablePaste(tbodyId, maxCol, addRow){
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  tbody.addEventListener('paste', e=>{
    const target = e.target;
    if(!target || target.dataset.col===undefined) return;
    const clip = e.clipboardData || window.clipboardData;
    if(!clip) return;
    const text = clip.getData('text');
    if(text==null || text==='') return;
    const isMatrix = text.indexOf('\n')>-1 || text.indexOf('\t')>-1;
    if(!isMatrix){
      // خلية واحدة: نتدخل فقط في الحقول التي لا تقبل اللصق المباشر (تاريخ/رقم/قائمة).
      // حقول النص العادية نتركها للسلوك الافتراضي حتى لا يضيع موضع المؤشر.
      if(target.tagName==='SELECT' || target.classList.contains('ba-date') || target.classList.contains('bu-date') || target.type==='number'){
        e.preventDefault();
        const ok = applyBulkPasteValue(target, text);
        if(!ok) showToast(`تاريخ غير مفهوم: «${text.trim().slice(0,30)}» — استخدم YYYY-MM-DD أو DD/MM/YYYY`, 'error');
        else if(target.tagName==='SELECT' && !target.value && text.trim()) showToast(`القيمة «${text.trim()}» غير موجودة في القائمة`, 'error');
      }
      return;
    }
    e.preventDefault();
    let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
    if(lines.length && lines[lines.length-1]==='') lines.pop(); // سطر فارغ أخير من نسخ إكسل
    const startRow = [...tbody.children].indexOf(target.closest('tr'));
    if(startRow<0) return;
    const startCol = parseInt(target.dataset.col, 10);
    let badDates = 0, unmatched = 0, goodDates = 0;
    const badSamples = [];
    lines.forEach((line, i)=>{
      const rowIdx = startRow + i;
      while(tbody.children.length <= rowIdx) addRow();
      const row = tbody.children[rowIdx];
      if(!row) return;
      line.split('\t').forEach((val, j)=>{
        const col = startCol + j;
        if(col>maxCol) return;
        const field = row.querySelector(`[data-col="${col}"]`);
        if(!field) return;
        const ok = applyBulkPasteValue(field, val);
        if(!ok){
          badDates++;
          if(val.trim() && badSamples.length<3) badSamples.push(val.trim().slice(0,25));
        }
        else if(field.tagName==='SELECT' && !field.value && val.trim()) unmatched++;
        else if((field.classList.contains('ba-date') || field.classList.contains('bu-date')) && val.trim()) goodDates++;
      });
    });
    let msg = `تم لصق ${lines.length} صف`;
    if(goodDates) msg += ` — تواريخ صحيحة: ${goodDates}`;
    if(badDates) msg += ` — ${badDates} تاريخ غير مفهوم${badSamples.length ? `: «${badSamples.join(' / ')}»` : ''}`;
    if(unmatched) msg += ` — ${unmatched} قيمة غير مطابقة للقوائم`;
    showToast(msg, (badDates||unmatched) ? 'info' : 'success');
  });
}
// نسخ من الجدول الداخلي: خلية القائمة تنسخ نصها الظاهر، والتاريخ ينسخ yyyy-mm-dd،
// وأي خلية أخرى تنسخ قيمتها كاملة لو لم يحدد المستخدم جزءاً منها.
function bindBulkTableCopy(tbodyId){
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  tbody.addEventListener('copy', e=>{
    const target = e.target;
    if(!target || target.dataset.col===undefined) return;
    const clip = e.clipboardData || window.clipboardData;
    if(!clip) return;
    let text = null;
    if(target.tagName==='SELECT'){
      const opt = target.selectedOptions && target.selectedOptions[0];
      text = opt && opt.value ? opt.textContent.trim() : '';
    } else if(target.classList.contains('ba-date') || target.classList.contains('bu-date')){
      text = target.value || '';
    } else if(target.tagName==='INPUT'){
      const start = target.selectionStart, end = target.selectionEnd;
      if(start==null || start===end) text = target.value;
    }
    if(text===null) return; // فيه تحديد جزء من النص — نترك النسخ الافتراضي
    e.preventDefault();
    if(e.clipboardData) e.clipboardData.setData('text/plain', text);
    else if(window.clipboardData) window.clipboardData.setData('Text', text);
  });
}
// تحويل خانات التاريخ النصية إلى yyyy-mm-dd عند مغادرة الخلية، مع إبراز القيمة غير المفهومة
function bindBulkTableDates(tbodyId){
  const tbody = document.getElementById(tbodyId);
  if(!tbody) return;
  tbody.addEventListener('blur', e=>{
    const el = e.target;
    if(!el || !(el.classList.contains('ba-date') || el.classList.contains('bu-date'))) return;
    const raw = el.value.trim();
    if(!raw){ el.style.borderColor=''; el.title=''; return; }
    const norm = normalizeDateForBulkPaste(raw);
    if(norm){ el.value = norm; el.style.borderColor=''; el.title=''; }
    else { el.style.borderColor = '#f87171'; el.title = 'قيمة غير مفهومة: ' + raw; }
  }, true);
}
// دعم لصق عمود (أو عدة أعمدة/صفوف) منسوخ من إكسل مباشرة: يوزَّع تلقائياً على الصفوف بدءاً من الخلية التي بدأ منها اللصق،
// ويُضيف صفوفاً جديدة تلقائياً إن لم تكفِ الصفوف الحالية لعدد القيم الملصوقة
bindBulkTablePaste('bulk-add-table-body', 11, addBulkAddRow);
bindBulkTableCopy('bulk-add-table-body');
bindBulkTableDates('bulk-add-table-body');
$('#btn-bulk-add-save')?.addEventListener('click', async ()=>{
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
    const rawDate = row.querySelector('.ba-date').value.trim();
    const rowDate = rawDate ? normalizeDateForBulkPaste(rawDate) : todayISO();
    if(rawDate && !rowDate){ errors.push(`${rowLabel}: تاريخ غير مفهوم «${rawDate}» — استخدم 2026-11-16 أو 16/11/2026`); return; }
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


/* ملاحظة: منطق جلب/اعتماد/رفض شيتات جوجل انتقل إلى ملف gsheet-workflow.js المنفصل — راجع هناك. */

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
    <td><input type="text" class="bu-date" data-col="11" placeholder="YYYY-MM-DD" inputmode="numeric" style="min-width:130px;"></td>
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

$('#btn-bulk-update')?.addEventListener('click', openBulkUpdateModal);
$('#btn-bulk-update-cancel')?.addEventListener('click', closeBulkUpdateModal);
$('#bulk-update-overlay')?.addEventListener('click', e=>{ if(e.target.id==='bulk-update-overlay') closeBulkUpdateModal(); });
$('#btn-bulk-update-row')?.addEventListener('click', addBulkUpdateRow);
$('#bulk-update-table-body')?.addEventListener('click', e=>{
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
bindBulkTablePaste('bulk-update-table-body', 24, addBulkUpdateRow);
bindBulkTableCopy('bulk-update-table-body');
bindBulkTableDates('bulk-update-table-body');
async function saveBulkUpdateAll(){
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
    const rawDate = val('bu-date').trim();
    const normDate = rawDate ? normalizeDateForBulkPaste(rawDate) : '';
    if(rawDate && !normDate){ errors.push(`${rowLabel}: تاريخ غير مفهوم «${rawDate}» — استخدم 2026-11-16 أو 16/11/2026`); return; }
    const existingIdx = clients.findIndex(c=>c.clientId===clientId);
    if(existingIdx>-1){
      const existing = clients[existingIdx];
      if(!canEditClientForUser(existing)){
        errors.push(`${rowLabel}: رقم ${clientId} سجل عميل أنشأه غيرك (أو خارج شروط التعديل) — لا تملك صلاحية تعديله`);
        return;
      }
      const patch = {};
      if(present(name)) patch.name = name;
      if(present(val('bu-refer'))) patch.referNum = val('bu-refer').trim();
      if(present(val('bu-phone'))) patch.phone = val('bu-phone').trim();
      if(present(val('bu-nat'))) patch.nationality = val('bu-nat');
      if(present(val('bu-ctype'))) patch.clientType = val('bu-ctype');
      if(present(val('bu-company'))) patch.companyName = val('bu-company').trim();
      if(present(val('bu-credit'))) patch.creditDays = num(val('bu-credit'));
      if(present(val('bu-course'))) patch.courseType = val('bu-course');
      if(present(val('bu-coursenum'))){ patch.courseNumber = val('bu-coursenum').trim(); if(patch.courseNumber) patch.noCourseNumber = false; }
      if(present(val('bu-invoice'))) patch.invoice = val('bu-invoice').trim();
      if(rawDate) patch.date = normDate;
      if(present(val('bu-price'))) patch.coursePrice = num(val('bu-price'));
      if(present(val('bu-baginvoice'))) patch.bagInvoice = val('bu-baginvoice').trim();
      if(present(val('bu-discount'))){
        // تعديل الخصم يدوياً من الجدول الجماعي يعني أن القيمة المدخلة هي إجمالي الخصم —
        // لذا تُلغى بيانات العرض القديمة حتى لا يظهر جزء عرض وهمي في كرت العميل.
        patch.discount = num(val('bu-discount'));
        patch.appliedOffers = [];
        patch.offerApplied = false;
        patch.offerDiscountAmount = 0;
        patch.offerNameSnapshot = '';
        patch.offerDiscountType = '';
        patch.offerDiscountValue = 0;
      }
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
        date: normDate || todayISO(),
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
    } else {
      clients.push(p.data);
      added++;
      changedRows.push({'الإجراء':'إضافة جديد', ...clientToExportRow(p.data)});
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
}
$('#btn-bulk-update-save')?.addEventListener('click', saveBulkUpdateAll);

/* ═══════════════════ استيراد عملاء من شيت Excel ═══════════════════
   زر في شاشة العملاء (⋮ إجراءات أخرى) يقرأ ملف Excel (xlsx/xls/csv) whose
   first sheet uses the same headers as the bulk-update template, fills the
   bulk-update table, and saves everything through the existing upsert logic. */
const CLIENTS_EXCEL_HEADER_MAP = {
  'رقم الهوية *': 'bu-id',
  'رقم الهوية': 'bu-id',
  'الاسم (إلزامي لعميل جديد)': 'bu-name',
  'الاسم': 'bu-name',
  'رقم المرجع': 'bu-refer',
  'الجوال': 'bu-phone',
  'الجنسية': 'bu-nat',
  'نوع العميل': 'bu-ctype',
  'اسم الشركة': 'bu-company',
  'الأجل (أيام)': 'bu-credit',
  'نوع الدورة': 'bu-course',
  'رقم الدورة': 'bu-coursenum',
  'رقم الفاتورة': 'bu-invoice',
  'التاريخ': 'bu-date',
  'سعر الدورة': 'bu-price',
  'مصدر الحقيبة': 'bu-bagsource',
  'قيمة الحقيبة': 'bu-bagprice',
  'رقم فاتورة الحقيبة': 'bu-baginvoice',
  'الخصم': 'bu-discount',
  'المدفوع': 'bu-paid',
  'طريقة الدفع': 'bu-channel',
  'المبلغ (طريقة ٢)': 'bu-paid2',
  'المبلغ (طريقة 2)': 'bu-paid2',
  'طريقة الدفع الثانية': 'bu-channel2',
  'رقم فاتورة الشبكة': 'bu-netinvoice',
  'الحالة': 'bu-stage',
  'ملغى': 'bu-cancelled',
  'ملاحظات': 'bu-notes',
};
function excelCellToString(v){
  if(v===null || v===undefined) return '';
  if(v instanceof Date){
    const y = v.getFullYear();
    const m = String(v.getMonth()+1).padStart(2,'0');
    const d = String(v.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}
$('#btn-import-clients-excel')?.addEventListener('click', ()=> $('#import-clients-excel-input')?.click());
$('#import-clients-excel-input')?.addEventListener('change', async e=>{
  const file = e.target.files && e.target.files[0];
  if(!file){ return; }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    if(!wb || !wb.SheetNames || !wb.SheetNames.length){ showToast('تعذّرت قراءة الملف — تأكد أنه ملف Excel صالح'); return; }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    if(!json || !json.length){ showToast('الملف فارغ — لا توجد بيانات لاستيرادها'); return; }
    // build table rows from Excel
    $('#bulk-update-table-body').innerHTML = '';
    let imported = 0;
    for(const row of json){
      const values = Object.values(row).map(v=>String(v==null?'':v).trim());
      if(values.every(v=>v==='')) continue; // skip fully blank lines
      addBulkUpdateRow();
      const tr = $('#bulk-update-table-body').lastElementChild;
      if(!tr) continue;
      for(const key of Object.keys(row)){
        const cls = CLIENTS_EXCEL_HEADER_MAP[String(key).trim()];
        if(!cls) continue;
        const el = tr.querySelector('.'+cls);
        if(!el) continue;
        const v = excelCellToString(row[key]);
        if(el.tagName === 'SELECT'){
          if(typeof setBulkSelectFuzzyAny === 'function') setBulkSelectFuzzyAny(el, v);
          else el.value = v;
        } else {
          el.value = v;
        }
      }
      imported++;
    }
    if(!imported){ showToast('لا توجد صفوف بيانات في الملف'); closeBulkUpdateModal(); return; }
    // save through the existing upsert logic
    await saveBulkUpdateAll();
  }catch(err){
    console.error(err);
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة مطابقة لقالب استيراد العملاء');
  }finally{
    e.target.value = '';
  }
});
/* ═══════════════════ قالب Excel للاستيراد (زر داخل النافذة) ═══════════════════
   يولّد ملف .xlsx بنفس ترتيب أعمدة جدول «تحديث/استيراد بيانات العملاء» أعلاه
   (25 عموداً) + ورقة تعليمات + ورقة قوائم تُبنى من إعدادات البرنامج الحالية.
   الهدف: المستخدم يملأ الملف على راحته ثم ينسخ من A2 ويلصق في أول خلية
   في عمود «رقم الهوية» — فلا يخطئ في ترتيب الأعمدة ولا في القيم المقبولة. */
var BULK_UPDATE_TEMPLATE_HEADERS = [
  'رقم الهوية *', 'الاسم (إلزامي لعميل جديد)', 'رقم المرجع', 'الجوال', 'الجنسية',
  'نوع العميل', 'اسم الشركة', 'الأجل (أيام)', 'نوع الدورة', 'رقم الدورة',
  'رقم الفاتورة', 'التاريخ', 'سعر الدورة', 'مصدر الحقيبة', 'قيمة الحقيبة',
  'رقم فاتورة الحقيبة', 'الخصم', 'المدفوع', 'طريقة الدفع', 'المبلغ (طريقة ٢)',
  'طريقة الدفع الثانية', 'رقم فاتورة الشبكة', 'الحالة', 'ملغى', 'ملاحظات'
];

function bulkUpdateTemplateExampleRows(){
  return [
    ['1234567890', 'محمد أحمد علي', '55001', '0551234567', 'Saudi',
      'عميل مركز', '', '', 'Food safety', 'C-2026-01',
      'INV-1001', '2026-11-16', 1500, 'من المخزون', 456.55,
      '', 100, 900, 'نقدي', '',
      '', '', 'جديد', 'لا', 'مثال عميل جديد — امسح الصف قبل الاستخدام'],
    ['1234567890', '', '', '0559998888', '',
      '', '', '', '', '',
      '', '', '', '', '',
      '', 200, 800, '', '',
      '', '', '', '', 'مثال تحديث: الجوال والخصم والمدفوع فقط'],
    ['1234567890', '', '', '', '',
      'عميل شركات', 'شركة النور', 30, 'Barber', 'C-2026-02',
      '', '', '', '', '',
      '', '', '', '', '',
      '', '', '', '', 'مثال تحديث: نوع الدورة ورقمها ونوع عميل شركات']
  ];
}

function bulkUpdateTemplateInstructions(){
  return [
    ['دليل استخدام قالب استيراد العملاء في FTC2'],
    [''],
    ['1) املأ البيانات بدءاً من الصف 2 في ورقة «العملاء». لا تغيّر ترتيب الأعمدة ولا تحذف أي عمود.'],
    ['2) العمود الأول (رقم الهوية) إلزامي في كل صف — 10 أرقام، بدون مسافات.'],
    ['3) بعد الانتهاء: انسخ من A2 إلى آخر صف/عمود (أو انسخ عموداً واحداً فقط إن أردت تحديث حقل واحد).'],
    ['4) داخل البرنامج: شاشة العملاء ← ⋮ إجراءات أخرى ← «📋 تحديث/استيراد بيانات العملاء (جدول)».'],
    ['5) اضغط على أول خلية في عمود «رقم الهوية» ثم Ctrl+V — الصفوف تتوزّع تلقائياً وتُضاف صفوف جديدة عند الحاجة.'],
    ['6) اضغط «حفظ الكل».'],
    [''],
    ['قواعد مهمة:'],
    ['• العمود الفارغ = «لا تغيير» في النظام. مفيد جداً لتحديث عمود واحد فقط.'],
    ['• رقم الهوية موجود مسبقاً ← تُحدَّث الأعمدة التي بها قيمة فقط.'],
    ['• رقم الهوية غير موجود ← يُضاف عميل جديد بشرط وجود الاسم في نفس الصف.'],
    ['• لا تكرّر رقم الهوية مرتين في نفس الدفعة (الحفظ يتوقف برسالة خطأ).'],
    ['• أي خطأ في أي صف يمنع حفظ الدفعة بالكامل — صحّح الصف المشار إليه في الرسالة.'],
    ['• التاريخ: 2026-11-16 أو 16/11/2026 (يوم/شهر/سنة).'],
    ['• الخصم في هذا الجدول = إجمالي الخصم، ويلغي أي عرض/خصم تلقائي مسجّل للعميل.'],
    ['• «صفر» قيمة فعلية تُكتب في النظام (0)، أما الخلية الفارغة فلا تغيّر شيئاً.'],
    [''],
    ['القيم المسموحة (يجب أن تطابق نصاً — راجع ورقة «القوائم» المبنية من إعداداتك الحالية):'],
    ['• نوع العميل: عميل مركز / عميل شركات'],
    ['• مصدر الحقيبة: من المخزون / شراء / خاصته'],
    ['• ملغى: لا / نعم'],
    ['• نوع الدورة والجنسية وطريقة الدفع: انسخ القيمة الحرفية من قوائم البرنامج.'],
    [''],
    ['ملاحظات:'],
    ['• قبل الحفظ الكبير خُد نسخة احتياطية، أو استخدم Ctrl+Z داخل البرنامج للتراجع.'],
    ['• استيراد أرقام الدورات والفواتير فقط له زر منفصل: «📋 تحديث/استيراد أرقام الدورات والفواتير (جدول)».'],
    ['• لاستيراد عدد كبير: قسّمه على دفعات أسهل للمراجعة والتراجع.']
  ];
}

function bulkUpdateTemplateLists(){
  var nats = (settings && Array.isArray(settings.nationalities)) ? settings.nationalities.slice() : [];
  var courses = (settings && Array.isArray(settings.courses)) ? settings.courses.map(function(c){ return c.name; }) : [];
  var channels = (settings && Array.isArray(settings.channels)) ? settings.channels.map(function(c){ return c.name; }) : [];
  var cols = [
    ['نوع العميل', ['عميل مركز', 'عميل شركات']],
    ['مصدر الحقيبة', ['من المخزون', 'شراء', 'خاصته']],
    ['ملغى', ['لا', 'نعم']],
    ['الجنسية', nats],
    ['نوع الدورة', courses],
    ['طريقة الدفع', channels]
  ];
  var maxLen = Math.max.apply(null, cols.map(function(c){ return c[1].length; }));
  var aoa = [cols.map(function(c){ return c[0]; })];
  for (var i = 0; i < maxLen; i++) {
    aoa.push(cols.map(function(c){ return c[1][i] || ''; }));
  }
  return aoa;
}

function downloadBulkUpdateExcelTemplate(){
  if (typeof XLSX === 'undefined') { showToast('مكتبة Excel غير محمّلة — أعد فتح البرنامج', 'error'); return; }
  try {
    var wb = XLSX.utils.book_new();

    var ws = XLSX.utils.aoa_to_sheet([BULK_UPDATE_TEMPLATE_HEADERS].concat(bulkUpdateTemplateExampleRows()));
    ws['!cols'] = BULK_UPDATE_TEMPLATE_HEADERS.map(function(h, i){
      return { wch: i === 1 || i === 6 ? 26 : (i === 24 ? 42 : 16) };
    });
    XLSX.utils.book_append_sheet(wb, ws, 'العملاء');

    var ws2 = XLSX.utils.aoa_to_sheet(bulkUpdateTemplateInstructions());
    ws2['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'تعليمات');

    var ws3 = XLSX.utils.aoa_to_sheet(bulkUpdateTemplateLists());
    ws3['!cols'] = [{ wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 16 }, { wch: 22 }, { wch: 24 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'القوائم');

    XLSX.writeFile(wb, 'قالب_استيراد_العملاء_FTC2.xlsx');
    showToast('تم تنزيل القالب — املأه ثم انسخ من A2 والصق في عمود «رقم الهوية»', 'success');
  } catch (e) {
    showToast('تعذّر إنشاء القالب: ' + (e && e.message ? e.message : e), 'error');
  }
}

$('#btn-bulk-update-template')?.addEventListener('click', downloadBulkUpdateExcelTemplate);

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
$('#btn-bulk-delete-table')?.addEventListener('click', openBulkDeleteModal);
$('#btn-bulk-delete-cancel')?.addEventListener('click', closeBulkDeleteModal);
$('#bulk-delete-overlay')?.addEventListener('click', e=>{ if(e.target.id==='bulk-delete-overlay') closeBulkDeleteModal(); });
$('#btn-bulk-delete-row')?.addEventListener('click', addBulkDeleteRow);
$('#bulk-delete-table-body')?.addEventListener('click', e=>{
  if(e.target.classList.contains('bd-remove-row')){
    const rows = $('#bulk-delete-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#bulk-delete-table-body')?.addEventListener('paste', e=>{
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
$('#btn-bulk-delete-save')?.addEventListener('click', async ()=>{
  const rows = [...$('#bulk-delete-table-body').querySelectorAll('tr')];
  const idsInBatch = [...new Set(rows.map(r=>r.querySelector('.bd-id').value.trim()).filter(Boolean))];
  if(!idsInBatch.length){ showToast('لم تُدخل أي رقم هوية'); return; }
  const matchedAll = clients.filter(c=>idsInBatch.includes(c.clientId));
  const notFoundCount = idsInBatch.filter(id=>!clients.some(c=>c.clientId===id)).length;
  if(!matchedAll.length){ showToast('لم يتم العثور على أي عميل بأرقام الهوية المدخلة'); return; }
  const matched = matchedAll.filter(c=>canDeleteClientForUser(c));
  const blockedCount = matchedAll.length - matched.length;
  if(!matched.length){ showToast(`كل السجلات المطابقة (${matchedAll.length}) لا تملك صلاحية حذفها (خارج مهلة الحذف/الشروط، أو سجل أنشأه غيرك لا يظهر لك)`); return; }
  if(blockedCount) showToast(`تم استبعاد ${blockedCount} سجل لا تملك صلاحية حذفه (خارج مهلة/شروط الحذف أو سجل أنشأه غيرك)`);
  const namesPreview = matched.slice(0,5).map(c=>c.name).join('، ');
  const extra = matched.length>5 ? ` وآخرين (${matched.length-5})` : '';
  const notFoundMsg = notFoundCount ? `\n(تنبيه: ${notFoundCount} رقم هوية غير موجودين أصلاً بالنظام وسيتم تجاهلهم)` : '';
  if(!await customConfirm(`تم العثور على ${matched.length} عميل مطابق. تأكيد حذفهم دفعة واحدة؟ (${namesPreview}${extra})${notFoundMsg}\nسيُحذف أيضاً أي ترحيل مالي تلقائي مرتبط بكل عميل منهم. هذا الإجراء لا يمكن التراجع عنه.`)) return;
  // نفس منع الحذف أثناء نافذة المزامنة الأولى — راجع التعليق فى submit handler الرئيسي فى بداية الملف
  if(!(await waitForClientsFirstRealSync())){ showToast('⏳ لسه جارٍ التأكد من آخر نسخة محدَّثة من بيانات العملاء مع السيرفر — حاول تاني بعد ثانية واحدة'); return; }
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


