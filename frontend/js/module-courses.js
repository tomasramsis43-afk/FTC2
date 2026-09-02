/* ================= الدورات والجلسات (Courses / Sessions) =================
   استُخرج هذا الملف من module-accounting.js — المحتوى هنا خاص بالدورات/الجلسات
   وبنماذج الاستيراد الجماعي المرتبطة بها (لا علاقة له بالمحاسبة/القيود المزدوجة)،
   وكان مختلطاً تاريخياً داخل نفس الملف. لا تغيير فى أي منطق، نقل فقط. */

/* ---------------- Courses / Sessions ---------------- */
function getEffectiveSessions(){
  const byCourseNumber = groupClientsByCourseNumber();
  const findFromClients = (cn, field) => {
    const arr = byCourseNumber.get(cn);
    if(!arr) return '';
    const found = arr.find(c=>c[field]);
    return found ? found[field] : '';
  };
  // تاريخ الدورة الاحتياطي: نفضّل expectedCourseDate (تاريخ متوقع مسجَّل يدوياً من شيت الدورات)،
  // فلو غير متاح نرجع لـ startDate (تاريخ بداية الدورة القادم من مزامنة أركان) — قبل هذا التعديل
  // كان startDate يُتجاهل تماماً هنا فيختفي تاريخ الدورة من هذا الشيت رغم وصوله فعلياً من أركان.
  const fallbackDate = cn => findFromClients(cn, 'expectedCourseDate') || findFromClients(cn, 'startDate');
  const list = courseSessions.map(s=>({
    ...s,
    courseType: s.courseType || findFromClients(s.courseNumber, 'courseType'),
    date: s.date || fallbackDate(s.courseNumber),
    isDefined:true
  }));
  const definedNums = new Set(courseSessions.map(s=>s.courseNumber));
  const extraNums = new Set();
  clients.forEach(c=>{ if(c.courseNumber && !c.suspended && !definedNums.has(c.courseNumber)) extraNums.add(c.courseNumber); });
  extraNums.forEach(cn=>{
    list.push({id:'auto-'+cn, courseNumber:cn, courseType:findFromClients(cn,'courseType'), date:fallbackDate(cn), language:'', capacity:null, notes:'', isDefined:false});
  });
  return list;
}
/* تاريخ الدورة الفعلي (متى سيحضر العميل ليأخذ الدورة) — يختلف عن تاريخ التسجيل (متى دفع وسجّل).
   يُقرأ من شيت الدورات (courseSessions) حسب رقم الدورة المرتبط بالعميل. */
function actualCourseDateOf(c){
  if(!c || !c.courseNumber) return '';
  const sess = courseSessions.find(s=>s.courseNumber===c.courseNumber);
  return sess?.date || '';
}
let csUndefinedOnly = false;
function coursesFilteredSessions(){
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;
  const fn = $('#cs-filter-num').value.trim().toLowerCase();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return getEffectiveSessions().filter(s=>{
    if(csUndefinedOnly && s.courseNumber && s.date && s.courseType) return false;
    if(ffrom && (!s.date || s.date<ffrom)) return false;
    if(fto && (!s.date || s.date>fto)) return false;
    if(fn && !String(s.courseNumber||'').toLowerCase().includes(fn)) return false;
    if(fcid){
      const has = clients.some(c=>c.courseNumber===s.courseNumber && String(c.clientId||'').toLowerCase().includes(fcid));
      if(!has) return false;
    }
    return true;
  }).sort((a,b)=> ffrom ? (a.date||'').localeCompare(b.date||'') : (b.date||'').localeCompare(a.date||''));
}
/* تجميع العملاء حسب رقم الدورة مرة واحدة بدل تصفية كامل مصفوفة العملاء لكل دورة على حدة —
   يقلّل زمن رسم شيت الدورات كثيراً عندما يكبر عدد العملاء والدورات */
function groupClientsByCourseNumber(){
  const map = new Map();
  clients.forEach(c=>{
    if(c.suspended || !c.courseNumber) return;
    let arr = map.get(c.courseNumber);
    if(!arr){ arr = []; map.set(c.courseNumber, arr); }
    arr.push(c);
  });
  return map;
}
/* شاشة عرض بالأعداد لشيت الدورات: بطاقات إحصائية سريعة حسب الفلتر الحالي */
function renderCoursesStats(sessions, fcid){
  const el = $('#courses-stats-cards');
  if(!el) return;
  const today = todayISO();
  let totalEnrolled = 0, totalCancelled = 0, totalAbsent = 0, activeCount = 0;
  let upcoming = 0, past = 0, undated = 0;
  let fullSessions = 0, seatsDefined = 0, seatsTaken = 0;
  const byType = {};
  const byCourseNumber = groupClientsByCourseNumber();
  sessions.forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const activeEnrolled = enrolled.filter(c=>!c.cancelled);
    totalEnrolled += enrolled.length;
    totalCancelled += enrolled.filter(c=>c.cancelled).length;
    totalAbsent += enrolled.filter(c=>c.absent).length;
    activeCount += activeEnrolled.length;
    if(!s.date) undated++;
    else if(s.date >= today) upcoming++;
    else past++;
    if(s.capacity){
      seatsDefined += Number(s.capacity)||0;
      seatsTaken += activeEnrolled.length;
      if(activeEnrolled.length >= s.capacity) fullSessions++;
    }
    const t = s.courseType || tr('notSpecified');
    byType[t] = (byType[t]||0) + 1;
  });
  const topType = Object.entries(byType).sort((a,b)=>b[1]-a[1])[0];
  const seatsRemaining = Math.max(0, seatsDefined - seatsTaken);
  el.innerHTML = `
    <div class="card"><div class="k">${tr('coursesCountLabel')}</div><div class="v">${sessions.length}</div></div>
    <div class="card"><div class="k">${tr('totalRegisteredLabel')}</div><div class="v gold">${totalEnrolled}</div></div>
    <div class="card"><div class="k">${tr('upcomingCoursesLabel')}</div><div class="v">${upcoming}</div></div>
    <div class="card"><div class="k">${tr('finishedCoursesLabel')}</div><div class="v">${past}</div></div>
    <div class="card"><div class="k">${tr('noDateCoursesLabel')}</div><div class="v red">${undated}</div></div>
    <div class="card"><div class="k">${tr('fullCoursesLabel')}</div><div class="v red">${fullSessions}</div></div>
    <div class="card"><div class="k">${tr('remainingSeatsLabel')}</div><div class="v">${seatsDefined ? seatsRemaining : '—'}</div></div>
    <div class="card"><div class="k">${tr('cancelledAbsentLabel')}</div><div class="v red">${totalCancelled} / ${totalAbsent}</div></div>
    <div class="card"><div class="k">${tr('mostFrequentLabel')}</div><div class="v" style="font-size:15px;">${topType ? `${escapeHtml(topType[0])} (${topType[1]})` : '—'}</div></div>
  `;
}
let coursesPageState = {page:1, sig:''};
function renderCourses(){
  refreshMissingCourseOptions();
  renderMissingCourse();
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  let sessions = coursesFilteredSessions();
  renderCoursesStats(sessions, fcid);
  const byCourseNumber = groupClientsByCourseNumber();

  if(!sessions.length){
    $('#courses-sessions-list').innerHTML = `<div class="panel"><div class="empty-state"><div class="big">📚</div>${tr('noMatchingCoursesMsg')}</div></div>`;
    const cPag = $('#courses-pagination'); if(cPag) cPag.style.display = 'none';
    return;
  }
  const coursesPageRows = applyGenericPagination('courses', sessions, coursesPageState, [
    $('#cs-filter-from')?.value, $('#cs-filter-to')?.value, $('#cs-filter-num')?.value, fcid
  ]);
  $('#courses-sessions-list').innerHTML = coursesPageRows.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    const activeEnrolled = enrolled.filter(c=>!c.cancelled);
    const courseRevenue = activeEnrolled.reduce((sum,c)=>sum+total(c),0);
    const coursePaid = activeEnrolled.reduce((sum,c)=>sum+paidTotal(c),0);
    const courseDue = Math.max(0, courseRevenue - coursePaid);
    const sMeta = (typeof recordMeta==='object' && recordMeta && recordMeta.courseSessions) ? recordMeta.courseSessions[s.id] : null;
    const isSPending = !!(sMeta && sMeta.status==='pending');
    return `<div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
        <div>
          <h3 style="margin:0 0 4px;">${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||tr('notSpecified'))}${isSPending ? ' <span class="stamp owe" title="سجّلها الاستقبال — بانتظار اعتماد الأدمن، لا تظهر للأدوار الأخرى حتى الاعتماد">⏳ قيد الاعتماد</span>' : ''}</h3>
          <div style="font-size:12.5px; color:var(--text-muted);">${tr('courseDateLabel')}: ${escapeHtml(s.date||'—')} · ${tr('languageLabel')}: ${escapeHtml(s.language||'—')} · ${tr('durationLabel')}: ${days} ${tr('dayWord')} · ${tr('countLabel')} <span class="mono">${capLabel}</span>
            ${full ? ` <span class="stamp owe">${tr('fullCoursesLabel')}</span>` : ''}
            ${s.isDefined ? '' : ` <span class="stamp owe">${tr('undefinedInCourseSheet')}</span>`}
          </div>
          ${activeEnrolled.length ? `<div style="font-size:12px; margin-top:5px; display:flex; gap:12px; flex-wrap:wrap;">
            <span>الإيرادات: <b class="mono">${fmt(courseRevenue)}</b></span>
            <span style="color:var(--success, var(--teal));">المحصّل: <b class="mono">${fmt(coursePaid)}</b></span>
            ${courseDue > 0 ? `<span style="color:var(--danger, var(--red));">المتبقي: <b class="mono">${fmt(courseDue)}</b></span>` : ''}
          </div>` : ''}
        </div>
        <div style="white-space:nowrap;">
          ${(isSPending && currentUserRole==='admin') ? `<button class="btn btn-gold btn-sm" data-approve-session="${s.id}" title="اعتماد هذه الدورة لتظهر للجميع وتدخل في الشيتات">✅ اعتماد</button><button class="btn btn-danger btn-sm" data-reject-session="${s.id}" title="رفض وحذف هذا التسجيل المعلّق نهائياً">✖ رفض</button>` : ''}
          ${s.isDefined ? `<button class="btn btn-ghost btn-sm" data-edit-session="${s.id}">${tr('editCourse')}</button>
          <button class="btn btn-danger btn-sm" data-del-session="${s.id}">${tr('delete')}</button>` : ''}
          <button class="btn btn-gold btn-sm" data-print-attendance="${escapeHtml(s.courseNumber)}">${tr('printAttendance')}</button>
        </div>
      </div>
      <div class="table-scroll table-scroll-course cards-mobile">
      <table>
        <thead><tr><th>${tr('thName')}</th><th>${tr('thId')}</th><th>${tr('thNat')}</th><th>${tr('statusCol')}</th><th>${tr('bagStatusCol')}</th><th></th></tr></thead>
        <tbody>
          ${enrolled.length ? enrolled.map(c=>`
            <tr${c.cancelled?' style="opacity:.5;"':''}>
              <td data-label="${tr('thName')}">${escapeHtml(c.name)}</td>
              <td class="mono" data-label="${tr('thId')}">${escapeHtml(c.clientId||'—')}</td>
              <td data-label="${tr('thNat')}">${escapeHtml(c.nationality||'')}</td>
              <td data-label="${tr('statusCol')}">${c.cancelled ? `<span class="stamp owe">${tr('cancelledStamp')}</span>` : (c.absent ? `<span class="stamp owe">${tr('absentStamp')}</span>` : `<span class="stamp paid">${tr('registeredStamp')}</span>`)}</td>
              <td data-label="${tr('bagStatusCol')}"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
              <td class="card-full" data-label="" style="white-space:nowrap;">
                ${!c.cancelled && !c.absent ? `<button class="btn btn-danger btn-sm" data-mark-absent="${c.id}">${tr('markAbsent')}</button>` : ''}
                ${c.absent ? `<button class="btn btn-ghost btn-sm" data-clear-absent="${c.id}">${tr('clearAbsent')}</button>` : ''}
              </td>
            </tr>`).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">${tr('noEnrolledYet')}</td></tr>`}
        </tbody>
      </table>
      </div>
    </div>`;
  }).join('');
}
['#cs-filter-from','#cs-filter-to'].forEach(sel=> $(sel).addEventListener('input', renderCourses));
bindGenericPagination('courses', coursesPageState, renderCourses);
onSearchInput('#cs-filter-num', renderCourses);
onSearchInput('#cs-filter-clientid', renderCourses);
onSearchInput('#cs-filter-clientid', renderMissingCourse);
$('#btn-filter-upcoming').addEventListener('click', ()=>{
  $('#cs-filter-from').value = todayISO();
  $('#cs-filter-to').value = '';
  renderCourses();
});
$('#btn-filter-undefined').addEventListener('click', ()=>{
  csUndefinedOnly = !csUndefinedOnly;
  $('#btn-filter-undefined').classList.toggle('btn-primary', csUndefinedOnly);
  $('#btn-filter-undefined').classList.toggle('btn-ghost', !csUndefinedOnly);
  renderCourses();
});
$('#btn-export-courses').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const headers = ['رقم الدورة','نوع الدورة','تاريخ الدورة','اللغة','مدة الدورة (أيام)','السعة','عدد المسجّلين','مكتملة العدد؟',
    'اسم المتدرب','رقم الهوية','رقم المرجعي','الجوال','الجنسية','نوع العميل','اسم الشركة','تاريخ التسجيل','رقم الفاتورة',
    'سعر الدورة','مصدر الحقيبة','قيمة الحقيبة','الخصم','الإجمالي','المدفوع','المتبقي','طريقة الدفع الأولى','طريقة الدفع الثانية',
    'رقم فاتورة الشبكة','حالة الحقيبة','الحالة','ملاحظات'];
  const rows = [];
  const byCourseNumber = groupClientsByCourseNumber();
  coursesFilteredSessions().forEach(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const full = s.capacity && enrolled.length>=s.capacity ? 'نعم' : 'لا';
    if(enrolled.length){
      enrolled.forEach(c=>{
        rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',enrolled.length,full,
          c.name,c.clientId,c.referNum||'',c.phone||'',c.nationality,c.clientType==='company'?'عميل شركات':'عميل مركز',c.companyName||'',
          formatDateDisplay(c.date),c.invoice||'',num(c.coursePrice),bagSourceLabel(c),num(c.bagPrice),num(c.discount),total(c),paidTotal(c),
          remaining(c),c.channel||'',c.channel2||'',c.networkInvoice||'',c.bagStatus||'',c.cancelled?'ملغى':(c.absent?'غياب':'مسجّل'),c.notes||'']);
      });
    } else {
      rows.push([s.courseNumber,s.courseType,formatDateDisplay(s.date),s.language,days,s.capacity||'',0,full,
        '','','','','','','','','','','','','','','','','','','','','لا يوجد مسجّلين بعد']);
    }
  });
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'الدورات.csv';
  a.click();
});

/* تقرير شامل قابل للطباعة يضم كل الدورات المطابقة للفلتر الحالي بكل تفاصيلها المتاحة (بيانات الدورة + كل متدرب فيها) */
$('#btn-print-courses-report').addEventListener('click', ()=>{
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  const sessions = coursesFilteredSessions();
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const today = new Date().toLocaleDateString('ar-SA-u-nu-latn');
  const ffrom = $('#cs-filter-from').value;
  const fto = $('#cs-filter-to').value;

  const byCourseNumber = groupClientsByCourseNumber();
  const sectionsHtml = sessions.map(s=>{
    let enrolled = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) enrolled = enrolled.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    const days = courseDurationDays(s.courseType);
    const capLabel = s.capacity ? `${enrolled.length} / ${s.capacity}` : `${enrolled.length}`;
    const full = s.capacity && enrolled.length>=s.capacity;
    const sessionTotal = enrolled.reduce((sum,c)=>sum+total(c),0);
    const sessionPaid = enrolled.reduce((sum,c)=>sum+paidTotal(c),0);
    const sessionRemaining = enrolled.reduce((sum,c)=>sum+remaining(c),0);
    const rowsHtml = enrolled.length ? enrolled.map((c,i)=>`
      <tr${c.cancelled?' style="opacity:.55;"':''}>
        <td>${i+1}</td>
        <td>${escapeHtml(c.name)}</td>
        <td class="mono">${escapeHtml(c.clientId||'—')}</td>
        <td>${escapeHtml(c.nationality||'—')}</td>
        <td class="mono">${escapeHtml(c.phone||'—')}</td>
        <td class="mono">${escapeHtml(c.invoice||'—')}</td>
        <td class="mono">${formatDateDisplay(c.date)||'—'}</td>
        <td class="mono">${fmt(num(c.coursePrice))}</td>
        <td>${escapeHtml(bagSourceLabel(c))}</td>
        <td class="mono">${fmt(bagAmount(c))}</td>
        <td class="mono">${fmt(num(c.discount))}</td>
        <td class="mono">${fmt(total(c))}</td>
        <td class="mono">${fmt(paidTotal(c))}</td>
        <td class="mono">${fmt(remaining(c))}</td>
        <td>${escapeHtml(paymentChannelsLabel(c))}</td>
        <td>${c.cancelled ? 'ملغى' : (c.absent ? 'غياب' : 'مسجّل')}</td>
        <td>${escapeHtml(c.notes||'—')}</td>
      </tr>`).join('') : `<tr><td colspan="17" style="text-align:center; color:#66707E;">لا يوجد عملاء مسجّلين برقم هذه الدورة بعد</td></tr>`;
    return `
    <div class="session-block">
      <div class="session-head">
        <h3>${escapeHtml(s.courseNumber||'—')} — ${escapeHtml(s.courseType||'غير محدد')}</h3>
        <div class="session-meta">
          <span>التاريخ: <b>${formatDateDisplay(s.date)||'—'}</b></span>
          <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
          <span>المدة: <b>${days} يوم</b></span>
          <span>عدد المسجّلين: <b>${capLabel}</b></span>
          ${full ? '<span class="stamp-full">مكتملة العدد</span>' : ''}
          ${s.isDefined ? '' : '<span class="stamp-undef">غير معرّفة في شيت الدورات</span>'}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th><th>الجوال</th><th>رقم الفاتورة</th><th>تاريخ التسجيل</th>
          <th>سعر الدورة</th><th>مصدر الحقيبة</th><th>قيمة الحقيبة</th><th>الخصم</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th>
          <th>طريقة الدفع</th><th>الحالة</th><th>ملاحظات</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        ${enrolled.length ? `<tfoot><tr>
          <td colspan="11" style="text-align:left; font-weight:bold;">إجمالي الدورة</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionTotal)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionPaid)}</td>
          <td class="mono" style="font-weight:bold;">${fmt(sessionRemaining)}</td>
          <td colspan="3"></td>
        </tr></tfoot>` : ''}
      </table>
    </div>`;
  }).join('');

  const grandEnrolled = sessions.reduce((sum,s)=>{
    let en = byCourseNumber.get(s.courseNumber) || [];
    if(fcid) en = en.filter(c=>String(c.clientId||'').toLowerCase().includes(fcid));
    return sum + en.length;
  },0);

  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('تقرير شامل — شيت الدورات', {variant: 'table-center', extraCss: `
    .session-block{margin-bottom:28px; page-break-inside:avoid;}
    .session-head h3{margin:0 0 4px; color:${PRINT_PALETTE.navy};}
    .session-meta{font-size:12.5px; color:${PRINT_PALETTE.muted}; margin-bottom:10px; display:flex; gap:14px; flex-wrap:wrap; align-items:center;}
    .stamp-full, .stamp-undef{background:#FDECEC; color:#B3261E; border-radius:6px; padding:2px 8px; font-size:11.5px;}
    tfoot td{background:#F5F7FA;}
    @media print{ .session-block{page-break-inside:avoid;} }
  `})}
  <body>
    <div class="head">
      <div><h2>تقرير شامل — شيت الدورات</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>تاريخ التقرير: <b>${today}</b></span>
      ${ffrom ? `<span>من تاريخ: <b>${formatDateDisplay(ffrom)}</b></span>` : ''}
      ${fto ? `<span>إلى تاريخ: <b>${formatDateDisplay(fto)}</b></span>` : ''}
      <span>عدد الدورات: <b>${sessions.length}</b></span>
      <span>إجمالي عدد المسجّلين: <b>${grandEnrolled}</b></span>
    </div>
    ${sectionsHtml || '<div style="text-align:center; color:#66707E; padding:40px;">لا توجد دورات مطابقة للفلتر الحالي</div>'}
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
});


/* ---------------- Who hasn't joined a given course type ---------------- */
function refreshMissingCourseOptions(){
  const sel = $('#cs-missing-course');
  repopulateFilterSelectPreserve(sel, settings.courses.map(c=>c.name), 'كل أنواع الدورات');
  refreshMissingNatOptions();
}
/* ---- فلتر متعدد الجنسيات لتبويب "من سجّل ولم يُحدَّد له رقم دورة بعد" ---- */
let missingNatSelected = new Set();
function refreshMissingNatOptions(){
  const box = $('#cs-missing-nat-options');
  const nats = settings.nationalities || [];
  box.innerHTML = nats.map(n=>`
    <label style="display:flex; align-items:center; gap:6px; padding:4px 2px; font-size:13px; cursor:pointer;">
      <input type="checkbox" class="cs-missing-nat-cb" value="${escapeHtml(n)}" ${missingNatSelected.has(n)?'checked':''}>
      ${escapeHtml(n)}
    </label>`).join('') || `<div style="font-size:12px; color:var(--text-muted);">${tr('noNationalitiesDefined')}</div>`;
  updateMissingNatButtonLabel();
}
function updateMissingNatButtonLabel(){
  const btn = $('#cs-missing-nat-btn');
  btn.textContent = missingNatSelected.size ? `${tr('nationalityLabelPrefix')}${missingNatSelected.size}${tr('nationalityLabelSuffix')}` : tr('nationalityAllLabel');
}
$('#cs-missing-nat-btn').addEventListener('click', e=>{
  e.stopPropagation();
  const panel = $('#cs-missing-nat-panel');
  panel.style.display = panel.style.display==='none' ? 'block' : 'none';
});
document.addEventListener('click', e=>{
  const wrap = $('#cs-missing-nat-wrap');
  if(wrap && !wrap.contains(e.target)) $('#cs-missing-nat-panel').style.display = 'none';
});
$('#cs-missing-nat-panel').addEventListener('click', e=> e.stopPropagation());
$('#cs-missing-nat-options').addEventListener('change', e=>{
  if(!e.target.classList.contains('cs-missing-nat-cb')) return;
  if(e.target.checked) missingNatSelected.add(e.target.value);
  else missingNatSelected.delete(e.target.value);
  updateMissingNatButtonLabel();
  renderMissingCourse();
});
$('#cs-missing-nat-clear').addEventListener('click', ()=>{
  missingNatSelected.clear();
  refreshMissingNatOptions();
  renderMissingCourse();
});
$('#cs-missing-nat-all').addEventListener('click', ()=>{
  missingNatSelected = new Set(settings.nationalities || []);
  refreshMissingNatOptions();
  renderMissingCourse();
});
function registrationAgeLabel(dateStr){
  if(!dateStr) return '<span class="stamp">—</span>';
  const AGE_THRESHOLD_DAYS = 14; // أكثر من 14 يوم منذ التسجيل يُعتبر "قديم"
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if(isNaN(days)) return '<span class="stamp">—</span>';
  return days > AGE_THRESHOLD_DAYS
    ? `<span class="stamp owe">قديم (${escapeHtml(formatDateDisplay(dateStr))})</span>`
    : `<span class="stamp paid">حديث (${escapeHtml(formatDateDisplay(dateStr))})</span>`;
}
function effectiveExpectedDate(c){ return c.expectedCourseDate || addDaysISO(c.date, 7); }
function missingCourseFiltered(){
  const typeVals = selectedFilterValues($('#cs-missing-course'));
  const ffrom = $('#cs-missing-from').value;
  const fto = $('#cs-missing-to').value;
  const efrom = $('#cs-missing-exp-from').value;
  const eto = $('#cs-missing-exp-to').value;
  const fcid = $('#cs-filter-clientid').value.trim().toLowerCase();
  return clients
    .filter(c=> !c.cancelled && !c.suspended && !String(c.courseNumber||'').trim())
    .filter(c=> !typeVals.length || typeVals.includes(c.courseType))
    .filter(c=> !missingNatSelected.size || missingNatSelected.has(c.nationality))
    .filter(c=> !ffrom || (c.date && c.date>=ffrom))
    .filter(c=> !fto || (c.date && c.date<=fto))
    .filter(c=> !efrom || effectiveExpectedDate(c)>=efrom)
    .filter(c=> !eto || effectiveExpectedDate(c)<=eto)
    .filter(c=> !fcid || String(c.clientId||'').toLowerCase().includes(fcid))
    .sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
function renderMissingCourse(){
  const sel = $('#cs-missing-course');
  if(!sel) return;
  const typeVals = selectedFilterValues(sel);
  const typeLabel = typeVals.join('، ');
  const box = $('#cs-missing-list');
  const countEl = $('#cs-missing-count');
  // العميل يظهر إن لم يُحدَّد له رقم دورة بعد؛ اختيار نوع الدورة (إن وُجد) فلتر إضافي اختياري فقط،
  // أما بقية الفلاتر (الجنسية وتاريخ التسجيل وتاريخ الدورة المتوقع ورقم الهوية) فتعمل على كامل الشيت بكل أنواع الدورات
  const missing = missingCourseFiltered();
  countEl.textContent = typeVals.length
    ? `${missing.length} ${tr('missingCourseCountTypeMid')} "${typeLabel}" ${tr('missingCourseCountTypeSuffix')}`
    : `${missing.length} ${tr('missingCourseCountAllSuffix')}`;
  if(!missing.length){
    box.innerHTML = `<div class="empty-state" style="padding:24px 10px;"><div class="big">✅</div>${typeVals.length ? `${tr('allDoneTypePrefix')} "${escapeHtml(typeLabel)}" ${tr('allDoneTypeSuffix')}` : tr('allDoneAllMsg')}</div>`;
    return;
  }
  box.innerHTML = `<div class="table-scroll cards-mobile"><table>
    <thead><tr><th>${tr('thName')}</th><th>${tr('thRegDate')}</th><th>${tr('thCourse')}</th><th>${tr('thId')}</th><th>${tr('thPhone')}</th><th>${tr('thNat')}</th><th>${tr('compFieldName')}</th><th>${tr('bagStatusCol')}</th><th>${tr('expectedCourseDateCol')}</th></tr></thead>
    <tbody>${missing.map(c=>`<tr>
      <td data-label="${tr('thName')}">${escapeHtml(c.name||'—')}</td>
      <td data-label="${tr('thRegDate')}">${registrationAgeLabel(c.date)}</td>
      <td data-label="${tr('thCourse')}">${escapeHtml(c.courseType||'—')}</td>
      <td class="mono" data-label="${tr('thId')}">${escapeHtml(c.clientId||'—')}</td>
      <td class="mono" data-label="${tr('thPhone')}">${escapeHtml(c.phone||'—')}</td>
      <td data-label="${tr('thNat')}">${escapeHtml(c.nationality||'')}</td>
      <td data-label="${tr('compFieldName')}">${escapeHtml(c.companyName||'—')}</td>
      <td data-label="${tr('bagStatusCol')}"><span class="stamp ${c.bagSource==='buy' && c.bagStatus!=='purchased' ? 'owe':'paid'}">${bagSourceLabel(c)}</span>${bagBuyCheckboxHtml(c)}</td>
      <td class="card-full" data-label="${tr('expectedCourseDateCol')}"><input type="date" class="cs-expected-date" data-client-id="${escapeHtml(c.id)}" value="${escapeHtml(effectiveExpectedDate(c))}" title="${tr('expectedDateTitle')}"></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}
$('#cs-missing-course').addEventListener('change', renderMissingCourse);
$('#btn-export-missing-course')?.addEventListener('click', ()=>{
  const missing = missingCourseFiltered();
  const headers = ['الاسم','تاريخ التسجيل','نوع الدورة','رقم الهوية','الجوال','الجنسية','اسم الشركة','حالة الحقيبة','تاريخ دورة متوقع'];
  const rows = missing.map(c=>[c.name,formatDateDisplay(c.date),c.courseType,c.clientId,c.phone,c.nationality,c.companyName,bagSourceLabel(c),effectiveExpectedDate(c)]);
  const csv = '\uFEFF'+[headers, ...rows].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'عملاء_لم_يحدد_لهم_رقم_دورة.csv';
  a.click();
});
$('#cs-missing-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-from').addEventListener('input', renderMissingCourse);
$('#cs-missing-exp-to').addEventListener('input', renderMissingCourse);
$('#cs-missing-list').addEventListener('change', async e=>{
  if(!e.target.classList.contains('cs-expected-date')) return;
  const id = e.target.dataset.clientId;
  const client = clients.find(c=>c.id===id);
  if(!client) return;
  client.expectedCourseDate = e.target.value;
  await saveClients();
  await logAudit('edit','الدورات', `تم تحديد تاريخ دورة متوقع للعميل ${client.name}: ${client.expectedCourseDate || '—'}`);
});

function openSessionModal(id){
  editingSessionId = id || null;
  $('#session-modal-title').textContent = id ? tr('editSessionModalTitle') : tr('newSessionModalTitle');
  populateSelect($('#sf-type'), settings.courses.map(c=>c.name), true);
  const s = id ? courseSessions.find(x=>x.id===id) : null;
  $('#sf-num').value = s?.courseNumber || '';
  $('#sf-type').value = s?.courseType || '';
  $('#sf-date').value = s?.date || '';
  $('#sf-lang').value = s?.language || '';
  $('#sf-cap').value = s?.capacity ?? '';
  $('#sf-notes').value = s?.notes || '';
  $('#session-overlay').classList.add('show'); SoundFX.open();
}
function closeSessionModal(){ $('#session-overlay').classList.remove('show'); editingSessionId=null; }
$('#sf-cancel').addEventListener('click', closeSessionModal);
$('#session-overlay').addEventListener('click', e=>{ if(e.target.id==='session-overlay') closeSessionModal(); });
$('#btn-add-session').addEventListener('click', ()=>openSessionModal(null));

let _sessionFormBusy = false;
$('#session-form').addEventListener('submit', async e=>{
  e.preventDefault();
  if(_sessionFormBusy) return;
  _sessionFormBusy = true;
  const _sfSubmitBtn = e.target.querySelector('[type="submit"]');
  if(_sfSubmitBtn) _sfSubmitBtn.classList.add('is-loading');
  try{
  const data = {
    courseNumber: $('#sf-num').value.trim(),
    courseType: $('#sf-type').value,
    date: $('#sf-date').value,
    language: $('#sf-lang').value.trim(),
    capacity: $('#sf-cap').value ? num($('#sf-cap').value) : null,
    notes: $('#sf-notes').value.trim(),
  };
  if(!data.courseNumber){ showToast('رقم الدورة مطلوب'); return; }
  const dup = courseSessions.find(s=>s.courseNumber===data.courseNumber && s.id!==editingSessionId);
  if(dup){ showToast('رقم الدورة هذا مستخدم بالفعل لدورة أخرى'); return; }
  const wasEdit = !!editingSessionId;
  snapshotState(wasEdit ? `تعديل دورة: ${data.courseNumber}` : `إضافة دورة: ${data.courseNumber}`);
  if(editingSessionId){
    const idx = courseSessions.findIndex(s=>s.id===editingSessionId);
    const oldNum = courseSessions[idx].courseNumber;
    courseSessions[idx] = {...courseSessions[idx], ...data};
    if(oldNum!==data.courseNumber){
      clients.forEach(c=>{ if(c.courseNumber===oldNum) c.courseNumber = data.courseNumber; });
      await saveClients();
    }
    showToast('تم تحديث بيانات الدورة');
  }else{
    courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, ...data});
    showToast('تمت إضافة الدورة');
  }
  await saveCourseSessions();
  await logAudit(wasEdit?'edit':'add','الدورات', `${wasEdit?'تم تعديل':'تمت إضافة'} الدورة رقم ${data.courseNumber}`);
  closeSessionModal(); renderCourses(); renderTable();
  }finally{
    _sessionFormBusy = false;
    if(_sfSubmitBtn) _sfSubmitBtn.classList.remove('is-loading');
  }
});

$('#courses-sessions-list').addEventListener('click', async e=>{
  const editS = e.target.dataset.editSession;
  const delS = e.target.dataset.delSession;
  const printA = e.target.dataset.printAttendance;
  const markAbsent = e.target.dataset.markAbsent;
  const clearAbsent = e.target.dataset.clearAbsent;
  if(editS) openSessionModal(editS);
  if(e.target.dataset.approveSession){
    const id = e.target.dataset.approveSession;
    const s = courseSessions.find(x=>x.id===id);
    if(await customConfirm(`اعتماد دورة الاستقبال "${s?.courseNumber||id}"؟ ستظهر للجميع وتدخل في الشيتات والتقارير كباقي الدورات.`)){
      const ok = await approveRecordGeneric('courseSessions', id);
      if(ok){
        await logAudit('edit','الدورات', `تم اعتماد تسجيل الاستقبال للدورة رقم ${s?.courseNumber||id}`);
        refreshEverything();
        showToast('تم اعتماد الدورة');
      }else{
        showToast('تعذّر الاعتماد — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(e.target.dataset.rejectSession){
    const id = e.target.dataset.rejectSession;
    const s = courseSessions.find(x=>x.id===id);
    if(await customConfirm(`رفض وحذف تسجيل الاستقبال المعلّق للدورة "${s?.courseNumber||id}" نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)){
      const ok = await deleteOneRecordGeneric('courseSessions', id);
      if(ok!==false){
        courseSessions = courseSessions.filter(x=>x.id!==id);
        await logAudit('delete','الدورات', `تم رفض وحذف تسجيل الاستقبال المعلّق للدورة رقم ${s?.courseNumber||id}`);
        refreshEverything();
        showToast('تم رفض التسجيل وحذفه');
      }else{
        showToast('تعذّر الحذف — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(delS){
    if(await customConfirm('تأكيد حذف هذه الدورة من الشيت؟ لن يتم حذف العملاء المسجلين، فقط بيانات الدورة نفسها.')){
      const removed = courseSessions.find(s=>s.id===delS);
      snapshotState(`حذف دورة: ${removed?.courseNumber||delS}`);
      courseSessions = courseSessions.filter(s=>s.id!==delS);
      await saveCourseSessions();
      await logAudit('delete','الدورات', `تم حذف الدورة رقم ${removed?.courseNumber||delS}`);
      renderCourses();
      showToast('تم حذف الدورة');
    }
  }
  if(printA) printAttendance(printA);
  if(markAbsent){
    const c = clients.find(x=>x.id===markAbsent);
    if(c && await customConfirm(`تحديد "${c.name}" كغائب؟ سيتم مسح رقم الدورة الحالي عنه تلقائياً حتى يوضع له رقم دورة جديد.`)){
      snapshotState(`تحديد غياب: ${c.name}`);
      const oldNum = c.courseNumber;
      c.absent = true;
      c.courseNumber = '';
      await saveClients();
      await logAudit('edit','العملاء', `تم تسجيل غياب العميل ${c.name} عن الدورة ${oldNum||''} ومسح رقم الدورة عنه تلقائياً`);
      renderCourses(); renderTable();
      showToast('تم تسجيل الغياب ومسح رقم الدورة');
    }
  }
  if(clearAbsent){
    const c = clients.find(x=>x.id===clearAbsent);
    if(c){
      snapshotState(`إلغاء غياب: ${c.name}`);
      c.absent = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء علامة الغياب عن العميل ${c.name}`);
      renderCourses(); renderTable();
      showToast('تم إلغاء علامة الغياب');
    }
  }
});

function printAttendance(courseNumber){
  const s = getEffectiveSessions().find(x=>x.courseNumber===courseNumber) || {courseNumber, courseType:'', date:'', language:''};
  const enrolled = clients.filter(c=>c.courseNumber===courseNumber && !c.cancelled && !c.suspended);
  const days = courseDurationDays(s.courseType);
  const ci = settings.centerInfo || DEFAULT_SETTINGS.centerInfo;
  const dayCols = days===2
    ? '<th>حضور اليوم الأول</th><th>انصراف اليوم الأول</th><th>حضور اليوم الثاني</th><th>انصراف اليوم الثاني</th><th>ملاحظات</th>'
    : '<th>توقيع الحضور</th><th>توقيع الانصراف</th><th>ملاحظات</th>';
  const colCount = days===2 ? 9 : 7;
  const rowsHtml = enrolled.map((c,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.clientId||'—')}</td><td>${escapeHtml(c.nationality||'')}</td>${days===2?'<td></td><td></td><td></td><td></td>':'<td></td><td></td>'}<td></td></tr>`).join('');
  const win = openPrintTarget();
  win.document.write(`
  ${printDocHead('كشف حضور وانصراف — ' + escapeHtml(courseNumber), {variant: 'table-center'})}
  <body>
    <div class="head">
      <div><h2>كشف حضور وانصراف</h2><div style="font-size:13px; color:#66707E;">${escapeHtml(ci.name)}</div></div>
      <img src="data:image/jpeg;base64,${CENTER_LOGO_B64}">
    </div>
    <div class="meta">
      <span>رقم الدورة: <b>${escapeHtml(courseNumber)}</b></span>
      <span>نوع الدورة: <b>${escapeHtml(s.courseType||'—')}</b></span>
      <span>تاريخ الدورة: <b>${escapeHtml(s.date||'—')}</b></span>
      <span>اللغة: <b>${escapeHtml(s.language||'—')}</b></span>
      <span>عدد المسجلين: <b>${enrolled.length}</b></span>
    </div>
    <table>
      <thead><tr><th>م</th><th>الاسم</th><th>رقم الهوية</th><th>الجنسية</th>${dayCols}</tr></thead>
      <tbody>${rowsHtml || `<tr><td colspan="${colCount}">لا يوجد مسجلين</td></tr>`}</tbody>
    </table>
    ${printDocFooterButton()}
  </body></html>`);
  finishPrintDoc(win);
}

/* عند استيراد/إدخال رقم دورة (أو رقم فاتورة) مرتبط برقم هوية غير موجود إطلاقاً في شيت العملاء ولا بأي مكان
   آخر بالبرنامج، يُضاف تلقائياً كعميل جديد بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل تجاهله
   أو رفض الصف — ويبقى محفوظاً بشكل دائم في شيت العملاء/الدورات حتى لو لم تُستكمل بقية بياناته لاحقاً
   (الاسم، الجوال...)، ولا يُحذف تلقائياً لعدم اكتمال بياناته. */
function addMinimalClientForCourseImport(clientId, courseNumber, courseDate){
  const rowDate = courseDate || todayISO();
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: courseNumber || '',
    referNum: '', invoice: '', bagInvoice: '',
    date: rowDate,
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية ورقم الدورة فقط عبر استيراد أرقام الدورات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

function addMinimalClientForRefnumImport(clientId, referNum){
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'center',
    companyName: '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: referNum || '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط عبر استيراد الرقم المرجعي — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}

/* ---- Bulk import: course numbers & course invoice numbers, linked by رقم الهوية ---- */
$('#btn-template-course-numbers').addEventListener('click', ()=>{
  downloadXlsx('نموذج_استيراد_أرقام_الدورات.xlsx', 'نموذج', [
    {'رقم الهوية':'1234567890', 'رقم الدورة':'CRS-1001', 'تاريخ الدورة':'2026-02-01'}
  ]);
});
$('#btn-import-course-numbers').addEventListener('click', ()=> $('#import-coursenum-input').click());
$('#import-coursenum-input').addEventListener('change', async e=>{
  const file = e.target.files[0];
  if(!file) return;
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array', cellDates:true});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet, {defval:''});
    snapshotState('استيراد أرقام الدورات من Excel');
    let updated=0, added=0, skipped=0, sessionsUpdated=0, sessionsAdded=0;
    const changedRows = [];
    for(const row of json){
      const clientId = String(row['رقم الهوية']||'').trim();
      const courseNumber = String(row['رقم الدورة']||'').trim();
      if(!clientId || !courseNumber){ skipped++; continue; }
      const courseDate = normalizeExcelDate(row['تاريخ الدورة']);
      let c = clients.find(x=>x.clientId===clientId);
      let isNew = false;
      if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; added++; }
      const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
      c.courseNumber = courseNumber;
      c.absent = false;
      updated++;
      let sessionNote = '';
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
      changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':courseNumber, 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
      if(courseNumber!==oldCourseNumber){
        sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
      }
    }
    await saveClients();
    if(added){ await syncBagStockIssues(); await saveVaultTx(); }
    if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
    await logAudit('edit','الدورات', `استيراد أرقام الدورات من Excel: تحديث ${updated} عميل${added?`(منهم ${added} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}${skipped?`، وتخطي ${skipped} صف بدون رقم هوية/دورة`:''}`);
    renderTable(); renderCourses();
    showToast(`تم تحديث ${updated} عميل${added?`، منهم ${added} عميل جديد أُضيف تلقائياً`:''}${skipped?`، ${skipped} تم تخطيه`:''}`);
  }catch(err){
    showToast('تعذّرت قراءة الملف — تأكد أن الأعمدة "رقم الهوية" و"رقم الدورة" (وتاريخ الدورة اختياري)');
  }finally{
    e.target.value = '';
  }
});


/* ---------------- تحديث/استيراد أرقام الدورات وفواتيرها دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد الملفين (أرقام الدورات / أرقام الفواتير) عبر Excel بجدول واحد داخل البرنامج، بنفس منطق
   الربط برقم الهوية والتحديث الجزئي (أي حقل فارغ في الصف يبقى كما هو في النظام دون تغيير). */
let csBulkRowSeq = 0;
function csBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="csb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="csb-invoice" data-col="1" style="min-width:100px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm csb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCsBulkRow(){
  csBulkRowSeq++;
  $('#cs-bulk-table-body').insertAdjacentHTML('beforeend', csBulkRowHtml(csBulkRowSeq));
}
function openCsBulkModal(){
  $('#cs-bulk-table-body').innerHTML = '';
  $('#cs-bulk-coursenum').value = '';
  $('#cs-bulk-date').value = '';
  for(let i=0;i<5;i++) addCsBulkRow();
  $('#cs-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCsBulkModal(){ $('#cs-bulk-overlay').classList.remove('show'); }
$('#btn-cs-bulk').addEventListener('click', openCsBulkModal);
$('#cs-bulk-cancel').addEventListener('click', closeCsBulkModal);
$('#cs-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='cs-bulk-overlay') closeCsBulkModal(); });
$('#btn-cs-bulk-row').addEventListener('click', addCsBulkRow);
$('#cs-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('csb-remove-row')){
    const rows = $('#cs-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#cs-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#cs-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCsBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-cs-bulk-save').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-cs-bulk-save'), async ()=>{
  const courseNumber = $('#cs-bulk-coursenum').value.trim();
  const courseDate = $('#cs-bulk-date').value.trim();
  const rows = [...$('#cs-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('csb-id');
    const invoice = val('csb-invoice');
    if(!clientId && !invoice) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice){ errors.push(`${rowLabel}: أدخل رقم الدورة أعلاه أو رقم الفاتورة لهذا الصف`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    // إن لم يكن رقم الهوية موجوداً بشيت العملاء أو بأي مكان آخر بالبرنامج، يُضاف تلقائياً كعميل جديد
    // بالحد الأدنى من البيانات (رقم الهوية + رقم الدورة) بدل رفض الصف، ويبقى محفوظاً حتى لو لم تكتمل بياناته لاحقاً.
    if(!c){ c = addMinimalClientForCourseImport(clientId, courseNumber, courseDate); isNew = true; newClientsCount++; }
    items.push({clientId, courseNumber, courseDate, invoice, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, sessionsUpdated=0, sessionsAdded=0;
  const changedRows = [];
  items.forEach(({clientId, courseNumber, courseDate, invoice, c, isNew})=>{
    const oldCourseNumber = isNew ? '' : (c.courseNumber||'');
    const oldInvoice = isNew ? '' : (c.invoice||'');
    let sessionNote = '';
    if(courseNumber){
      c.courseNumber = courseNumber;
      c.absent = false;
      if(courseDate){
        const sess = courseSessions.find(s=>s.courseNumber===courseNumber);
        if(sess){
          if(sess.date!==courseDate){ sess.date = courseDate; sessionsUpdated++; sessionNote = 'تحديث تاريخ الدورة'; }
        }else{
          courseSessions.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, courseNumber, courseType:c.courseType||'', date:courseDate, language:'', capacity:null, notes:''});
          sessionsAdded++;
          sessionNote = 'إضافة دورة جديدة';
        }
      }
    }
    if(invoice) c.invoice = invoice;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'رقم الدورة (قديم)':oldCourseNumber, 'رقم الدورة (جديد)':c.courseNumber||'', 'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'', 'ملاحظة الجدول': isNew ? `عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات${sessionNote?' — '+sessionNote:''}` : sessionNote});
    if(c.courseNumber && c.courseNumber!==oldCourseNumber){
      sendPowerAutomateEvent('course_number_updated', {clientId: c.clientId, name: c.name, courseNumber: c.courseNumber, courseType: c.courseType||''});
    }
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  if(sessionsUpdated || sessionsAdded) await saveCourseSessions();
  await logAudit('edit','الدورات', `تحديث/استيراد أرقام الدورات وفواتيرها من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والدورة فقط)`:''}${sessionsAdded||sessionsUpdated?`، وتحديث تاريخ ${sessionsUpdated} دورة وإضافة ${sessionsAdded} دورة جديدة`:''}`);
  closeCsBulkModal();
  renderTable(); renderCourses();
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);

  });});

/* ---------------- استيراد/تحديث الرقم المرجعي دفعة واحدة (جدول داخل البرنامج) ----------------
   الربط برقم الهوية فقط: تحديث جزئي (الرقم المرجعي فقط) لعميل موجود، أو إضافة عميل جديد بالحد الأدنى
   من البيانات (رقم الهوية + الرقم المرجعي) إن لم يكن موجوداً — بنفس منطق استيراد أرقام الدورات. */
let refnumBulkRowSeq = 0;
function refnumBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="rnb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="rnb-refnum" data-col="1" style="min-width:120px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm rnb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addRefnumBulkRow(){
  refnumBulkRowSeq++;
  $('#refnum-bulk-table-body').insertAdjacentHTML('beforeend', refnumBulkRowHtml(refnumBulkRowSeq));
}
function openRefnumBulkModal(){
  $('#refnum-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addRefnumBulkRow();
  $('#refnum-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeRefnumBulkModal(){ $('#refnum-bulk-overlay').classList.remove('show'); }
$('#btn-refnum-bulk').addEventListener('click', openRefnumBulkModal);
$('#refnum-bulk-cancel').addEventListener('click', closeRefnumBulkModal);
$('#refnum-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='refnum-bulk-overlay') closeRefnumBulkModal(); });
$('#btn-refnum-bulk-row').addEventListener('click', addRefnumBulkRow);
$('#refnum-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('rnb-remove-row')){
    const rows = $('#refnum-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#refnum-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#refnum-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addRefnumBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>1) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-refnum-bulk-save').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-refnum-bulk-save'), async ()=>{
  const rows = [...$('#refnum-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  let newClientsCount = 0;
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('rnb-id');
    const referNum = val('rnb-refnum');
    if(!clientId && !referNum) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!referNum){ errors.push(`${rowLabel}: الرقم المرجعي مطلوب`); return; }
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForRefnumImport(clientId, referNum); isNew = true; newClientsCount++; }
    items.push({clientId, referNum, c, isNew});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0;
  const changedRows = [];
  items.forEach(({clientId, referNum, c, isNew})=>{
    const oldReferNum = isNew ? '' : (c.referNum||'');
    c.referNum = referNum;
    updated++;
    changedRows.push({'رقم الهوية':clientId, 'الاسم':c.name||'(غير مكتمل — أُضيف تلقائياً)', 'الرقم المرجعي (قديم)':oldReferNum, 'الرقم المرجعي (جديد)':c.referNum||'', 'ملاحظة الجدول': isNew ? 'عميل جديد أُضيف تلقائياً بالحد الأدنى من البيانات' : ''});
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد/تحديث الرقم المرجعي من جدول داخل البرنامج: تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية والرقم المرجعي فقط)`:''}`);
  closeRefnumBulkModal();
  renderTable();
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''}`);

  });});

/* ---------------- استيراد عمال الشركات دفعة واحدة (جدول داخل البرنامج فقط — بدون Excel) ----------------
   الربط برقم الهوية فقط: تحديث اسم الشركة (ونوع العميل تلقائياً إلى "عميل شركات") لعميل موجود، أو إضافة
   عميل جديد بالحد الأدنى من البيانات (رقم الهوية + اسم الشركة) إن لم يكن موجوداً — بنفس منطق استيراد
   الرقم المرجعي، لكن عبر جدول لصق داخل البرنامج فقط دون أي رفع لملف Excel. */
function addMinimalClientForCompanyImport(clientId, companyName){
  const c = {
    id: uid(), createdAt: Date.now(), createdBy: currentUser,
    clientId, name: '',
    phone: '', nationality: '',
    clientType: 'company',
    companyName: companyName || '', creditDays: '',
    clientTaxNumber: '',
    courseType: '',
    courseNumber: '',
    referNum: '', invoice: '', bagInvoice: '',
    date: todayISO(),
    coursePrice: 0,
    bagSource: 'buy', bagPrice: num(settings.bagPrice),
    bagStatus: 'pending', bagPurchaseDate: '',
    discount: 0, paid: 0,
    channel: '', networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
    stage: 'جديد', cancelled: false,
    notes: 'أُضيف تلقائياً برقم الهوية واسم الشركة فقط عبر استيراد عمال الشركات — بيانات غير مكتملة، لن يُحذف تلقائياً'
  };
  clients.push(c);
  syncClientLedgerEntry(c);
  return c;
}
let compWorkersBulkRowSeq = 0;
function compWorkersBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cwb-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:150px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cwb-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCompWorkersBulkRow(){
  compWorkersBulkRowSeq++;
  $('#compworkers-bulk-table-body').insertAdjacentHTML('beforeend', compWorkersBulkRowHtml(compWorkersBulkRowSeq));
}
function openCompWorkersBulkModal(){
  $('#compworkers-bulk-company').value = '';
  $('#compworkers-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCompWorkersBulkRow();
  $('#compworkers-bulk-overlay').classList.add('show'); SoundFX.open();
  setTimeout(()=>$('#compworkers-bulk-company').focus(), 50);
}
function closeCompWorkersBulkModal(){ $('#compworkers-bulk-overlay').classList.remove('show'); }
$('#btn-compworkers-bulk').addEventListener('click', openCompWorkersBulkModal);
$('#compworkers-bulk-cancel').addEventListener('click', closeCompWorkersBulkModal);
$('#compworkers-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='compworkers-bulk-overlay') closeCompWorkersBulkModal(); });
$('#btn-compworkers-bulk-row').addEventListener('click', addCompWorkersBulkRow);
$('#compworkers-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cwb-remove-row')){
    const rows = $('#compworkers-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
// دعم لصق عمود كامل (رقم هوية واحد في كل سطر) منسوخ من إكسل مباشرة داخل الجدول
$('#compworkers-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(l=>l.split('\t')[0]);
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#compworkers-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  lines.forEach((val, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCompWorkersBulkRow();
    const row = tbody.children[rowIdx];
    const field = row.querySelector('[data-col="0"]');
    if(field) field.value = val.trim();
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-compworkers-bulk-save').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-compworkers-bulk-save'), async ()=>{
  const companyName = $('#compworkers-bulk-company').value.trim();
  if(!companyName){ showToast('اكتب اسم الشركة أعلى الجدول أولاً'); $('#compworkers-bulk-company').focus(); return; }
  const rows = [...$('#compworkers-bulk-table-body').querySelectorAll('tr')];
  const items = [];
  const seenIds = new Set();
  let newClientsCount = 0;
  rows.forEach(row=>{
    const clientId = row.querySelector('.cwb-id').value.trim();
    if(!clientId) return; // صف فارغ يُتجاهل بصمت
    if(seenIds.has(clientId)) return; // تكرار داخل نفس الجدول يُتجاهل بصمت
    seenIds.add(clientId);
    let c = clients.find(x=>x.clientId===clientId);
    let isNew = false;
    if(!c){ c = addMinimalClientForCompanyImport(clientId, companyName); isNew = true; newClientsCount++; }
    items.push({clientId, c, isNew});
  });
  if(!items.length){ showToast('أدخل رقم هوية واحداً على الأقل'); return; }
  snapshotState(`استيراد عمال الشركات من جدول داخل البرنامج (${items.length} صف) — الشركة: ${companyName}`);
  let updated=0;
  items.forEach(({c, isNew})=>{
    c.companyName = companyName;
    if(!isNew) c.clientType = 'company';
    updated++;
  });
  await saveClients();
  if(newClientsCount){ await syncBagStockIssues(); await saveVaultTx(); }
  await logAudit('edit','العملاء', `استيراد عمال الشركات من جدول داخل البرنامج للشركة "${companyName}": تحديث ${updated} عميل${newClientsCount?`(منهم ${newClientsCount} عميل جديد أُضيف تلقائياً برقم الهوية واسم الشركة فقط)`:''}`);
  closeCompWorkersBulkModal();
  renderTable(); refreshFilterOptions();
  showToast(`تم تحديث ${updated} عميل${newClientsCount?`، منهم ${newClientsCount} عميل جديد أُضيف تلقائياً`:''} — الشركة: ${companyName}`);

  });});

/* ---------------- تحديث/استيراد فواتير الدورات دفعة واحدة (جدول داخل البرنامج) ----------------
   يحل محل استيراد ملف Excel بنفس منطق الربط برقم الهوية (وبرقم الدورة إن وُجد) والتحديث الجزئي. */
let ciBulkRowSeq = 0;
function ciBulkRowHtml(rowId){
  return `<tr data-row="${rowId}">
    <td><input type="text" class="cib-id" data-col="0" maxlength="10" placeholder="10 أرقام" style="min-width:100px;"></td>
    <td><input type="text" class="cib-coursenum" data-col="1" style="min-width:100px;"></td>
    <td><input type="text" class="cib-invoice" data-col="2" style="min-width:100px;"></td>
    <td><input type="date" class="cib-date" data-col="3" style="min-width:120px;"></td>
    <td><input type="number" step="0.01" class="cib-value" data-col="4" style="min-width:110px;"></td>
    <td><button type="button" class="btn btn-danger btn-sm cib-remove-row" title="حذف الصف">✕</button></td>
  </tr>`;
}
function addCiBulkRow(){
  ciBulkRowSeq++;
  $('#ci-bulk-table-body').insertAdjacentHTML('beforeend', ciBulkRowHtml(ciBulkRowSeq));
}
function openCiBulkModal(){
  $('#ci-bulk-table-body').innerHTML = '';
  for(let i=0;i<5;i++) addCiBulkRow();
  $('#ci-bulk-overlay').classList.add('show'); SoundFX.open();
}
function closeCiBulkModal(){ $('#ci-bulk-overlay').classList.remove('show'); }
$('#btn-ci-bulk').addEventListener('click', openCiBulkModal);
$('#ci-bulk-cancel').addEventListener('click', closeCiBulkModal);
$('#ci-bulk-overlay').addEventListener('click', e=>{ if(e.target.id==='ci-bulk-overlay') closeCiBulkModal(); });
$('#btn-ci-bulk-row').addEventListener('click', addCiBulkRow);
$('#ci-bulk-table-body').addEventListener('click', e=>{
  if(e.target.classList.contains('cib-remove-row')){
    const rows = $('#ci-bulk-table-body').querySelectorAll('tr');
    if(rows.length<=1){ showToast('يجب أن يبقى صف واحد على الأقل'); return; }
    e.target.closest('tr').remove();
  }
});
$('#ci-bulk-table-body').addEventListener('paste', e=>{
  const target = e.target;
  if(!target || target.dataset.col===undefined) return;
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if(!text || (!text.includes('\n') && !text.includes('\t'))) return;
  e.preventDefault();
  let lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if(lines.length && lines[lines.length-1]==='') lines.pop();
  const tbody = $('#ci-bulk-table-body');
  const startRow = [...tbody.children].indexOf(target.closest('tr'));
  const startCol = parseInt(target.dataset.col, 10);
  lines.forEach((line, i)=>{
    const rowIdx = startRow + i;
    while(tbody.children.length <= rowIdx) addCiBulkRow();
    const row = tbody.children[rowIdx];
    line.split('\t').forEach((val, j)=>{
      const col = startCol + j;
      if(col>4) return;
      const field = row.querySelector(`[data-col="${col}"]`);
      if(!field) return;
      if(field.classList.contains('cib-date')){ const norm = normalizeDateForBulkPaste(val); if(norm) field.value = norm; }
      else field.value = val.trim();
    });
  });
  showToast(`تم لصق ${lines.length} صف`);
});
$('#btn-ci-bulk-save').addEventListener('click', async ()=>{
  await withBtnLoading($('#btn-ci-bulk-save'), async ()=>{
  const rows = [...$('#ci-bulk-table-body').querySelectorAll('tr')];
  const errors = [];
  const items = [];
  rows.forEach((row, i)=>{
    const val = cls => row.querySelector(`.${cls}`).value.trim();
    const clientId = val('cib-id');
    const courseNumber = val('cib-coursenum');
    const invoice = val('cib-invoice');
    const date = val('cib-date');
    const valueRaw = val('cib-value');
    if(!clientId && !courseNumber && !invoice && !date && !valueRaw) return; // صف فارغ بالكامل يُتجاهل بصمت
    const rowLabel = `الصف ${i+1}`;
    if(!clientId){ errors.push(`${rowLabel}: رقم الهوية مطلوب`); return; }
    if(!courseNumber && !invoice && !date && valueRaw===''){ errors.push(`${rowLabel}: أدخل رقم الدورة أو رقم الفاتورة أو التاريخ أو القيمة الفعلية`); return; }
    // البحث أولاً بمطابقة رقم الهوية + رقم الدورة معاً (لتحديد التسجيل الصحيح عند تعدد دورات نفس العميل)،
    // وإن لم يوجد رقم دورة في الصف أو لم تُطابق، نكتفي بمطابقة رقم الهوية وحده
    let c = null;
    if(courseNumber) c = clients.find(x=>x.clientId===clientId && String(x.courseNumber||'').trim()===courseNumber);
    if(!c) c = clients.find(x=>x.clientId===clientId);
    if(!c){ errors.push(`${rowLabel}: رقم الهوية ${clientId} غير موجود بشيت العملاء`); return; }
    items.push({clientId, invoice, date, valueRaw, c});
  });
  if(errors.length){ showToast(errors[0] + (errors.length>1 ? ` (و${errors.length-1} خطأ آخر)` : '')); return; }
  if(!items.length){ showToast('لم تُدخل بيانات أي صف'); return; }
  snapshotState(`تحديث/استيراد فواتير الدورات من جدول داخل البرنامج (${items.length} صف)`);
  let updated=0, invoiceChanged=0, postedCount=0;
  const changedRows = [];
  items.forEach(({clientId, invoice, date, valueRaw, c})=>{
    const oldInvoice = c.invoice||'';
    const oldDate = c.receiptIssueDate||'';
    const oldValue = c.receiptActualValue||'';
    // رقم الفاتورة (رقم الإيصال) فقط هو ما يُرحَّل ويُربط مع باقي شيتات النظام — أما التاريخ والقيمة الفعلية
    // فيبقى تحديثهما محصوراً داخل شيت فواتير الدورات نفسه فقط
    if(invoice){
      c.invoice = invoice;
      if(invoice!==oldInvoice) invoiceChanged++;
    }
    if(date) c.receiptIssueDate = date;
    if(valueRaw!==''){ c.receiptActualValue = num(valueRaw); }
    if(typeof autoPostCourseInvoice==='function' && autoPostCourseInvoice(c)) postedCount++;
    updated++;
    changedRows.push({
      'رقم الهوية':clientId, 'الاسم':c.name, 'رقم الدورة':c.courseNumber||'',
      'رقم الفاتورة (قديم)':oldInvoice, 'رقم الفاتورة (جديد)':c.invoice||'',
      'تاريخ الفاتورة (قديم)':oldDate, 'تاريخ الفاتورة (جديد)':c.receiptIssueDate||'',
      'القيمة الفعلية (قديمة)':oldValue, 'القيمة الفعلية (جديدة)':c.receiptActualValue||''
    });
  });
  await saveClients();
  if(postedCount>0) await saveJournalDE();
  await logAudit('edit','فواتير الدورات', `تحديث/استيراد فواتير الدورات من جدول داخل البرنامج: تحديث ${updated} سجل${invoiceChanged?` (تم ترحيل ${invoiceChanged} رقم فاتورة تلقائياً إلى شيت العملاء وربطها بجميع الشيتات)`:''}${postedCount?` — ورُحّلت ${postedCount} فاتورة تلقائياً للقيد المزدوج`:''}`);
  closeCiBulkModal();
  if(invoiceChanged && typeof refreshEverything==='function'){
    // رقم الفاتورة تغيّر فعلياً لسجل واحد أو أكثر → يُحدَّث النظام بالكامل (شيت العملاء، لوحة التحكم، الدورات، التقارير...)
    refreshEverything();
  }else{
    // لا يوجد تغيير في أرقام الفواتير (تحديث تاريخ/قيمة فعلية فقط) → يبقى التحديث محصوراً في شيت فواتير الدورات فقط
    renderCourseInvoices();
  }
  showToast(`تم تحديث ${updated} سجل${invoiceChanged?` — ورُبط ${invoiceChanged} رقم فاتورة بجميع الشيتات`:''}`);

  });});

