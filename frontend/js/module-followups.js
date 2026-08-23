/* ============================================================
   نبض Follow-ups — مركز المتابعة والتذكيرات
   ------------------------------------------------------------
   ميزة جديدة (Product Innovation Audit): لوحة مهام يدوية بسيطة
   بلوحة التحكم — يضيف المستخدم تذكيراً حراً (نص + تاريخ استحقاق
   اختياري + ربط اختياري بعميل)، ويتابعه لاحقاً حسب حالته: متأخرة/
   اليوم/قادمة/مكتملة. مستقلة تماماً عن التنبيهات الذكية التلقائية
   (renderSmartAlerts فى clients-alerts-overview.js) التي تبقى بلا
   أي تفاعل يدوي — هذه اللوحة مخصّصة للمهام التي يقررها المستخدم
   بنفسه ويريد تتبعها (مثال: "أتابع تليفونياً مع فلان الأسبوع الجاي"،
   "أراجع فاتورة كذا بعد استلام التحويل").
   التخزين: تصنيف سجلات مستقلة جديد (followUpTasks) بنفس آلية
   scheduledVaultTx/auditLog بالضبط (راجع loadGeneric/saveCollectionGeneric
   فى permissions-sound.js) — لا تعديل على أي بنية بيانات قائمة.
   الصلاحية: نفس صلاحية لوحة التحكم نفسها (canAccessView('dashboard'))،
   بلا شاشة صلاحيات جديدة ولا مسار API جديد.
   ============================================================ */

let followUpFilter = 'active'; // active | overdue | today | upcoming | done | all

/* حالة مهمة واحدة: overdue (متأخرة) / today (اليوم) / upcoming (قادمة) / done (مكتملة) / open (بلا موعد) */
function followUpStatusInfo(t){
  if(t.status === 'done') return { cls:'done', label:'مكتملة' };
  if(!t.dueDate) return { cls:'open', label:'بلا موعد' };
  const today = todayISO();
  if(t.dueDate < today) return { cls:'overdue', label:'متأخرة' };
  if(t.dueDate === today) return { cls:'today', label:'اليوم' };
  return { cls:'upcoming', label:'قادمة' };
}

function followUpCounts(){
  const c = { overdue:0, today:0, upcoming:0, open:0, done:0 };
  (typeof followUpTasks !== 'undefined' ? followUpTasks : []).forEach(t=>{
    if(t.status === 'done'){ c.done++; return; }
    c.open++;
    const info = followUpStatusInfo(t);
    if(info.cls === 'overdue') c.overdue++;
    else if(info.cls === 'today') c.today++;
    else if(info.cls === 'upcoming') c.upcoming++;
  });
  return c;
}

function followUpStampClass(cls){
  if(cls === 'overdue') return 'owe';
  if(cls === 'today') return 'channel';
  return 'paid';
}

function renderFollowUpsPanel(){
  const el = $('#followups-panel');
  if(!el) return;
  if(typeof canAccessView === 'function' && !canAccessView('dashboard')){ el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';

  const counts = followUpCounts();
  const urgent = counts.overdue + counts.today;
  const badge = urgent ? `<span class="stamp owe" style="margin-inline-start:8px;">${urgent} تحتاج متابعة اليوم</span>` : '';

  let list = (typeof followUpTasks !== 'undefined' ? followUpTasks : []).slice().sort((a,b)=>{
    if((a.status==='done') !== (b.status==='done')) return a.status==='done' ? 1 : -1;
    return String(a.dueDate||'9999-99-99') < String(b.dueDate||'9999-99-99') ? -1 : 1;
  });
  if(followUpFilter !== 'all'){
    list = list.filter(t=>{
      if(followUpFilter === 'done') return t.status === 'done';
      if(t.status === 'done') return false;
      if(followUpFilter === 'active') return true;
      return followUpStatusInfo(t).cls === followUpFilter;
    });
  }

  const tabs = [
    ['active','مفتوحة'], ['overdue','متأخرة'], ['today','اليوم'], ['upcoming','قادمة'], ['done','مكتملة'], ['all','الكل']
  ];

  const clientList = (typeof clients !== 'undefined' ? clients : []).slice(0, 800);
  const clientOptions = clientList.map(c=> `<option value="${escapeHtml(c.name||'')}">`).join('');

  el.innerHTML = `
    <div class="panel" id="followups-inner">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;">
        <h3 style="margin:0;">🔔 المتابعة والتذكيرات${badge}</h3>
        <span class="hint" style="margin:0; font-size:12px; color:var(--text-muted);">مهام يدوية تضيفها بنفسك لمتابعة أي شيء لاحقاً</span>
      </div>
      <form id="followup-add-form" style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
        <input type="text" id="followup-text" placeholder="نص التذكير — مثال: متابعة سداد باقي المبلغ" style="flex:2; min-width:220px;" maxlength="300" required>
        <input type="date" id="followup-date" style="max-width:160px;">
        <input type="text" id="followup-client" list="followup-clients-list" placeholder="ربط بعميل (اختياري)" style="max-width:200px;" maxlength="120">
        <datalist id="followup-clients-list">${clientOptions}</datalist>
        <button type="submit" class="btn btn-gold btn-sm">+ إضافة تذكير</button>
      </form>
      <div class="toolbar" style="gap:6px; margin-bottom:10px; flex-wrap:wrap;">
        ${tabs.map(([k,l])=> `<button type="button" class="btn btn-ghost btn-sm${followUpFilter===k?' active':''}" data-followuptab="${k}">${l}</button>`).join('')}
      </div>
      <div id="followup-list">
        ${list.length ? list.map(t=>{
          const info = followUpStatusInfo(t);
          return `<div class="computed" style="display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
            <input type="checkbox" data-followupdone="${t.id}" ${t.status==='done'?'checked':''} title="تمييز كمكتملة">
            <span style="flex:1; min-width:160px; ${t.status==='done'?'text-decoration:line-through; color:var(--text-muted);':''}">${escapeHtml(t.text||'')}${t.clientName?` <span style="color:var(--text-muted); font-size:12px;">— ${escapeHtml(t.clientName)}</span>`:''}</span>
            ${t.dueDate ? `<span class="stamp ${followUpStampClass(info.cls)}">${escapeHtml(info.label)} · ${escapeHtml(t.dueDate)}</span>` : ''}
            <button type="button" class="btn btn-danger btn-sm" data-followupdel="${t.id}">حذف</button>
          </div>`;
        }).join('') : `<div class="hint" style="color:var(--text-muted); font-size:13px;">لا توجد تذكيرات في هذا التصنيف</div>`}
      </div>
    </div>`;
}

document.addEventListener('submit', async e=>{
  if(e.target?.id !== 'followup-add-form') return;
  e.preventDefault();
  const textEl = document.getElementById('followup-text');
  const text = (textEl?.value || '').trim();
  if(!text){ showToast('اكتب نص التذكير'); return; }
  const dueDate = document.getElementById('followup-date')?.value || '';
  const clientTyped = (document.getElementById('followup-client')?.value || '').trim();
  let clientId = '', clientName = '';
  if(clientTyped && typeof clients !== 'undefined'){
    const match = clients.find(c=> (c.name||'').trim() === clientTyped);
    if(match){ clientId = match.id; clientName = match.name; }
    else clientName = clientTyped;
  }
  if(typeof followUpTasks === 'undefined') return;
  followUpTasks.push({
    id: uid(), text, dueDate, clientId, clientName,
    status: 'open', createdBy: (typeof currentUser !== 'undefined' ? currentUser : '—') || '—',
    createdAt: Date.now(), doneAt: null
  });
  await saveFollowUpTasks();
  showToast('تم إضافة التذكير');
  renderFollowUpsPanel();
});

document.addEventListener('click', async e=>{
  const tab = e.target?.dataset?.followuptab;
  if(tab){ followUpFilter = tab; renderFollowUpsPanel(); return; }

  const delId = e.target?.dataset?.followupdel;
  if(delId){
    if(typeof customConfirm === 'function' && !(await customConfirm('حذف هذا التذكير نهائياً؟'))) return;
    followUpTasks = followUpTasks.filter(t=> t.id !== delId);
    await saveFollowUpTasks();
    renderFollowUpsPanel();
  }
});

document.addEventListener('change', async e=>{
  const doneId = e.target?.dataset?.followupdone;
  if(!doneId) return;
  const t = (typeof followUpTasks !== 'undefined' ? followUpTasks : []).find(x=> x.id === doneId);
  if(!t) return;
  t.status = e.target.checked ? 'done' : 'open';
  t.doneAt = e.target.checked ? Date.now() : null;
  await saveFollowUpTasks();
  renderFollowUpsPanel();
});
