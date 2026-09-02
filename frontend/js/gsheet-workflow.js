/* ============================================================
   gsheet-workflow.js — استيراد واعتماد/رفض عملاء شيتات جوجل
   ------------------------------------------------------------
   سير العمل:
   1) المستخدم يضيف روابط شيتات جوجل (منشورة كـ CSV) عبر نافذة
      "إدارة شيتات جوجل" (زر في إجراءات أخرى أو داخل لوحة العملاء).
   2) كل شيت يُجلَب دورياً (كل شيت له مدة مستقلة) والصفوف الجديدة
      (بها رقم هوية لم يُعتمد ولم يُرفض من قبل) تظهر في تبويب
      "بانتظار الاعتماد" تحت صندوق العملاء، مع اسم الشيت المصدر.
   3) الاعتماد: نقل العميل إلى شيت العملاء + ترحيل المدفوع تلقائياً
      إلى شيت الحركات المالية عبر syncClientLedgerEntry.
   4) الرفض: يُحفظ في قائمة المرفوض (لا يُحذف من الشيت) ولا يعود
      تلقائياً. يمكن استرجاعه وتعديله ثم اعتماده من تبويب المرفوض.
   ============================================================ */
(function(){
  'use strict';

  function wfData(){
    if(!settings) return { sheets:[], pending:[], rejected:[] };
    if(!settings.gsheetWorkflow || typeof settings.gsheetWorkflow !== 'object')
      settings.gsheetWorkflow = { sheets:[], pending:[], rejected:[] };
    const w = settings.gsheetWorkflow;
    if(!Array.isArray(w.sheets)) w.sheets = [];
    if(!Array.isArray(w.pending)) w.pending = [];
    if(!Array.isArray(w.rejected)) w.rejected = [];
    return w;
  }
  function persistWf(){
    return saveSettings();
  }

  /* -------- أدوات CSV (مستقلة عن بقية الملفات) -------- */
  function parseCsvLine(line){
    const out=[]; let cur='', inQ=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(inQ){ if(ch==='"' && line[i+1]==='"'){ cur+='"'; i++; } else if(ch==='"') inQ=false; else cur+=ch; }
      else { if(ch==='"') inQ=true; else if(ch===','){ out.push(cur); cur=''; } else cur+=ch; }
    }
    out.push(cur);
    return out.map(v=>v.trim());
  }
  function normHeader(h){
    h = String(h||'').trim().toLowerCase().replace(/^\ufeff/,'');
    if(/اسم/.test(h)) return 'name';
    if(/هوية/.test(h)) return 'id';
    if(/جوال/.test(h) || /هاتف/.test(h) || /موبايل/.test(h) || /phone/.test(h) || /mobile/.test(h)) return 'phone';
    if(/جنسية/.test(h) || /national/.test(h)) return 'nationality';
    if(/مدفوع/.test(h) || /paid/.test(h) || /amount/.test(h)) return 'paid';
    if(/طريقة/.test(h) || /channel/.test(h) || /method/.test(h)) return 'channel';
    if(/دورة/.test(h) && !/رقم/.test(h)) return 'courseType';
    if(/تاريخ/.test(h)) return 'date';
    if(/الحقيبة/.test(h) || /bag/.test(h)) return 'bag';
    return h;
  }
  function toCsvUrl(url){
    url = String(url||'').trim();
    if(!/^https?:\/\//i.test(url)) return null;
    const gid = /[?&]gid=(\d+)/.exec(url);
    const ed = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)\/edit$/);
    if(ed) return `https://docs.google.com/spreadsheets/d/${ed[1]}/export?format=csv${gid?('&gid='+gid[1]):''}`;
    return url; // يُفترض أنه رابط /export?format=csv أو /pub?output=csv
  }
  function cleanPrice(v){
    v = String(v||'');
    const m = v.replace(/[^0-9.,\-]/g,'').replace(/,/g,'').match(/^-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  function toIsoDate(v){
    v = String(v||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if(m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`; // يوم/شهر/سنة
    return '';
  }

  async function fetchSheetCsv(url){
    // في نسخة سطح المكتب (Electron) نمر عبر البروكسي المحلي /gsheet-csv لتفادي CORS
    // (جوجل لا يرسل Access-Control-Allow-Origin). في المتصفح نستخدم جوجل مباشرة.
    const isDesktop = /^http:\/\/127\.0\.0\.1/.test(location.origin) || /^http:\/\/localhost/.test(location.origin);
    if(isDesktop){
      const res = await fetch('/gsheet-csv?url=' + encodeURIComponent(toCsvUrl(url)), { cache:'no-store' });
      if(!res.ok) throw new Error('HTTP '+res.status);
      return await res.text();
    }
    const res = await fetch(toCsvUrl(url), { cache:'no-store' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    return await res.text();
  }

  /* -------- تحليل صفوف شيت (بنموذج موحّد) -------- */
  // يعيد مصفوفة صفوف، كل صف {clientId, name, phone, nationality, courseType, paid, channel, date, bag}
  function parseSheetRows(csv){
    const lines = String(csv||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim()!=='');
    if(!lines.length) return [];
    const header = lines[0].split(',').map(normHeader);
    const colMap = {id:-1,name:-1,phone:-1,nationality:-1,courseType:-1,paid:-1,channel:-1,date:-1,bag:-1};
    header.forEach((h,i)=>{ if(h in colMap && colMap[h]===-1) colMap[h]=i; });
    const val=(r,key)=> (colMap[key]>=0 && colMap[key]<r.length) ? r[colMap[key]] : '';
    const rows=[];
    for(let i=1;i<lines.length;i++){
      const r = parseCsvLine(lines[i]);
      const clientId = String(val(r,'id')).trim();
      if(!/^\d{10}$/.test(clientId)) continue; // نتجاهل الفراغ/غير الصحيح
      const name = String(val(r,'name')).trim();
      if(!name) continue;
      rows.push({
        clientId,
        name,
        phone: val(r,'phone').trim(),
        nationality: val(r,'nationality').trim(),
        courseType: val(r,'courseType').trim(),
        paid: cleanPrice(val(r,'paid')),
        channel: val(r,'channel').trim(),
        bag: cleanPrice(val(r,'bag')),
        date: toIsoDate(val(r,'date'))
      });
    }
    return rows;
  }

  /* -------- مساعدات الحالة -------- */
  function knownClientIds(){
    const s = new Set();
    (clients||[]).forEach(c=>{ if(c.clientId) s.add(String(c.clientId).trim()); });
    (wfData().pending||[]).forEach(p=>{ if(p.clientId) s.add(String(p.clientId).trim()); });
    (wfData().rejected||[]).forEach(p=>{ if(p.clientId) s.add(String(p.clientId).trim()); });
    return s;
  }

  /* -------- الجلب من شيت واحد وإضافة الجدد لـ pending -------- */
  async function fetchOneSheet(sheet){
    const csv = await fetchSheetCsv(sheet.url);
    const rows = parseSheetRows(csv);
    if(!rows.length) return {added:0, sheet:sheet.name};
    const known = knownClientIds();
    const w = wfData();
    let added = 0;
    for(const row of rows){
      if(known.has(row.clientId)) continue;
      known.add(row.clientId);
      w.pending.push({
        id: uid(),
        sheetName: sheet.name,
        sheetUrl: sheet.url,
        fetchedAt: Date.now(),
        clientId: row.clientId,
        name: row.name,
        phone: row.phone,
        nationality: row.nationality,
        courseType: row.courseType,
        paid: row.paid,
        channel: row.channel,
        bag: row.bag,
        date: row.date
      });
      added++;
    }
    if(added) await persistWf();
    return {added, sheet: sheet.name};
  }

  /* -------- جلب كل الشيتات -------- */
  async function fetchAllSheets(){
    const w = wfData();
    const enabled = w.sheets.filter(s=>s.enabled && s.url);
    if(!enabled.length) return {total:0};
    let total = 0;
    for(const sh of enabled){
      try{ const r = await fetchOneSheet(sh); total += r.added; }
      catch(e){ /* نكمل البقية */ }
    }
    if(total) renderAll();
    return {total};
  }

  /* -------- الاعتماد -------- */
  async function approvePending(id){
    const w = wfData();
    const idx = w.pending.findIndex(p=>p.id===id);
    if(idx<0) return;
    const p = w.pending[idx];
    if(clients.some(c=>String(c.clientId).trim()===String(p.clientId).trim())){
      showToast('رقم الهوية مستخدم بالفعل — يُحذف من قائمة الاعتماد');
      w.pending.splice(idx,1); await persistWf(); renderAll(); return;
    }
    const client = {
      id: uid(), createdAt: Date.now(), createdBy: currentUser,
      clientId: String(p.clientId).trim(),
      name: (p.name||'').trim(),
      phone: (p.phone||'').trim(),
      nationality: (p.nationality||'').trim(),
      clientType: 'center',
      companyName: '', creditDays: '', clientTaxNumber: '',
      courseType: (p.courseType||'').trim(),
      courseNumber: '',
      referNum: '', invoice: '', bagInvoice: '',
      date: p.date || todayISO(),
      coursePrice: num(settings.coursePrice),
      bagSource: p.bag>0 ? 'buy' : 'buy',
      bagPrice: p.bag>0 ? p.bag : num(settings.bagPrice),
      bagStatus: 'pending',
      discount: 0,
      paid: (p.paid||0),
      channel: (p.channel||'').trim() || 'نقدي',
      networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
      stage: 'جديد', cancelled: false,
      notes: ''
    };
    snapshotState(`اعتماد عميل من شيت «${p.sheetName}»`);
    clients.push(client);
    syncClientLedgerEntry(client); // ترحيل الدفعة للحركات المالية تلقائياً
    w.pending.splice(idx,1);
    try{ await saveClients(); }catch(e){}
    try{ await saveVaultTx(); }catch(e){}
    await persistWf();
    renderAll();
    renderTable && renderTable(); renderDashboard && renderDashboard();
    refreshFilterOptions && refreshFilterOptions(); renderCourses && renderCourses();
    showToast(`تم اعتماد «${client.name}» وترحيل المدفوع للحركات المالية`);
  }

  /* -------- الرفض / الاسترجاع -------- */
  function rejectPending(id){
    const w = wfData();
    const idx = w.pending.findIndex(p=>p.id===id);
    if(idx<0) return;
    const p = w.pending.splice(idx,1)[0];
    p.rejectedAt = Date.now();
    if(!w.rejected.some(r=>String(r.clientId).trim()===String(p.clientId).trim())) w.rejected.push(p);
    persistWf().then(()=>{ renderAll(); showToast('تم نقل العميل إلى المرفوض'); });
  }
  function restoreRejected(id){
    const w = wfData();
    const idx = w.rejected.findIndex(p=>p.id===id);
    if(idx<0) return;
    const p = w.rejected.splice(idx,1)[0];
    delete p.rejectedAt;
    if(!w.pending.some(x=>x.id===p.id)) w.pending.push(p);
    persistWf().then(()=>{ renderAll(); showToast('أُعيد العميل إلى بانتظار الاعتماد'); });
  }
  async function approveRejected(id){
    const w = wfData();
    const idx = w.rejected.findIndex(p=>p.id===id);
    if(idx<0) return;
    const p = w.rejected[idx];
    const client = {
      id: uid(), createdAt: Date.now(), createdBy: currentUser,
      clientId: String(p.clientId).trim(),
      name: (p.name||'').trim(),
      phone: (p.phone||'').trim(),
      nationality: (p.nationality||'').trim(),
      clientType: 'center',
      companyName: '', creditDays: '', clientTaxNumber: '',
      courseType: (p.courseType||'').trim(),
      courseNumber: '',
      referNum: '', invoice: '', bagInvoice: '',
      date: p.date || todayISO(),
      coursePrice: num(settings.coursePrice),
      bagSource: 'buy',
      bagPrice: (p.bag||0)>0 ? p.bag : num(settings.bagPrice),
      bagStatus: 'pending',
      discount: 0,
      paid: (p.paid||0),
      channel: (p.channel||'').trim() || 'نقدي',
      networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
      stage: 'جديد', cancelled: false,
      notes: ''
    };
    snapshotState(`اعتماد عميل من المرفوض «${p.sheetName}»`);
    clients.push(client);
    syncClientLedgerEntry(client);
    w.rejected.splice(idx,1);
    try{ await saveClients(); }catch(e){}
    try{ await saveVaultTx(); }catch(e){}
    await persistWf();
    renderAll();
    renderTable && renderTable(); renderDashboard && renderDashboard();
    refreshFilterOptions && refreshFilterOptions(); renderCourses && renderCourses();
    showToast(`تم اعتماد «${client.name}»`);
  }

  /* -------- تحرير مرشّح قبل الاعتماد -------- */
  let _editId = null, _editFromRejected=false;
  function openEdit(id, fromRejected){
    const w = wfData();
    const list = fromRejected ? w.rejected : w.pending;
    const p = list.find(x=>x.id===id);
    if(!p) return;
    _editId = id; _editFromRejected = fromRejected;
    const natOpts = '<option value=""></option>' + (settings.nationalities||[]).map(n=>`<option value="${escapeHtml(n)}"${n===(p.nationality||'')?' selected':''}>${escapeHtml(n)}</option>`).join('');
    const courseOpts = '<option value=""></option>' + (settings.courses||[]).map(c=>`<option value="${escapeHtml(c.name)}"${c.name===(p.courseType||'')?' selected':''}>${escapeHtml(c.name)}</option>`).join('');
    const chanOpts = '<option value=""></option>' + (settings.channels||[]).map(c=>`<option value="${escapeHtml(c.name)}"${c.name===(p.channel||'')?' selected':''}>${escapeHtml(c.name)}</option>`).join('');
    const f = (label,idv,html)=>`<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;margin-bottom:4px;">${label}</label>${html}</div>`;
    const inp = (idv,v)=>`<input type="text" class="gse-${idv}" value="${escapeHtml(v)}" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">`;
    const inp2 = (type,val)=>`<input type="${type}" value="${escapeHtml(String(val))}" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">`;
    $('#gsheet-edit-fields').innerHTML =
      f('رقم الهوية *','id',inp('id',p.clientId))+
      f('الاسم *','name',inp('name',p.name))+
      f('الجوال','phone',inp('phone',p.phone))+
      f('الجنسية','nat',`<select class="gse-nat" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">${natOpts}</select>`)+
      f('نوع الدورة','course',`<select class="gse-course" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">${courseOpts}</select>`)+
      f('طريقة الدفع','channel',`<select class="gse-channel" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">${chanOpts}</select>`)+
      f('المدفوع','paid',inp2('number',p.paid))+
      f('سعر الحقيبة','bag',inp2('number',p.bag))+
      f('تاريخ التسجيل','date',inp2('date',p.date));
    $('#gsheet-edit-overlay').classList.add('show'); SoundFX && SoundFX.open();
  }
  function _editVal(cls){ const el=document.querySelector(cls); return el?el.value:''; }
  function saveEdit(){
    if(!_editId) return;
    const w = wfData();
    const list = _editFromRejected ? w.rejected : w.pending;
    const p = list.find(x=>x.id===_editId);
    if(!p) return;
    p.clientId = _editVal('.gse-id').trim();
    p.name = _editVal('.gse-name').trim();
    p.phone = _editVal('.gse-phone').trim();
    p.nationality = _editVal('.gse-nat');
    p.courseType = _editVal('.gse-course');
    p.channel = _editVal('.gse-channel');
    p.paid = cleanPrice(_editVal('.gse-paid'));
    p.bag = cleanPrice(_editVal('.gse-bag'));
    p.date = _editVal('.gse-date') || p.date;
    $('#gsheet-edit-overlay').classList.remove('show');
    _editId=null;
    persistWf().then(()=>renderAll());
  }

  /* -------- العرض -------- */
  function renderAll(){
    const w = wfData();
    renderPending(w);
    renderRejected(w);
    updateCounts(w);
  }
  function rowActions(p, fromRejected){
    const btns = fromRejected
      ? `<button class="btn btn-success btn-sm gs-restore" data-id="${p.id}">↩ استرجاع</button> <button class="btn btn-primary btn-sm gs-approve-rej" data-id="${p.id}">اعتماد</button>`
      : `<button class="btn btn-ghost btn-sm gs-edit" data-id="${p.id}" data-r="0">تعديل</button> <button class="btn btn-danger btn-sm gs-reject" data-id="${p.id}">رفض</button> <button class="btn btn-primary btn-sm gs-approve" data-id="${p.id}">اعتماد</button>`;
    return btns;
  }
  function renderPending(w){
    const tbody = $('#gsheet-pending-body'); const empty = $('#gsheet-pending-empty');
    tbody.innerHTML = '';
    if(!w.pending.length){ empty.style.display=''; return; }
    empty.style.display='none';
    w.pending.forEach(p=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(p.sheetName||'')}</td>`+
        `<td class="mono">${escapeHtml(p.clientId||'')}</td>`+
        `<td>${escapeHtml(p.name||'')}</td>`+
        `<td class="mono">${escapeHtml(p.phone||'')}</td>`+
        `<td>${escapeHtml(p.nationality||'')}</td>`+
        `<td>${escapeHtml(p.courseType||'')}</td>`+
        `<td class="mono">${String(p.paid||0)}</td>`+
        `<td>${escapeHtml(p.channel||'')}</td>`+
        `<td class="mono">${escapeHtml(p.date||'')}</td>`+
        `<td style="white-space:nowrap;">${rowActions(p,false)}</td>`;
      tbody.appendChild(tr);
    });
  }
  function renderRejected(w){
    const tbody = $('#gsheet-rejected-body'); const empty = $('#gsheet-rejected-empty');
    tbody.innerHTML = '';
    if(!w.rejected.length){ empty.style.display=''; return; }
    empty.style.display='none';
    w.rejected.forEach(p=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(p.sheetName||'')}</td>`+
        `<td class="mono">${escapeHtml(p.clientId||'')}</td>`+
        `<td>${escapeHtml(p.name||'')}</td>`+
        `<td class="mono">${escapeHtml(p.phone||'')}</td>`+
        `<td>${escapeHtml(p.nationality||'')}</td>`+
        `<td>${escapeHtml(p.courseType||'')}</td>`+
        `<td class="mono">${String(p.paid||0)}</td>`+
        `<td>${escapeHtml(p.channel||'')}</td>`+
        `<td class="mono">${escapeHtml(p.date||'')}</td>`+
        `<td style="white-space:nowrap;">${rowActions(p,true)}</td>`;
      tbody.appendChild(tr);
    });
  }
  function updateCounts(w){
    $('#gsheet-pending-count').textContent = w.pending.length;
    $('#gsheet-rejected-count').textContent = w.rejected.length;
  }

  /* -------- نافذة إدارة الشيتات -------- */
  function renderConfigRows(){
    const w = wfData();
    const host = document.querySelector('[data-gsheet-config-rows]');
    if(!host) return;
    if(!w.sheets.length){
      host.innerHTML = '<div class="hint hint-info" style="margin-bottom:10px;">لا توجد شيتات بعد — اضغط «+ إضافة شيت».</div>';
      return;
    }
    host.innerHTML = w.sheets.map((s,i)=>`
      <div class="gsheet-cfg-row" data-row="${i}" style="border:1px solid var(--border,#ddd);border-radius:8px;padding:12px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <input type="text" class="gsc-name" value="${escapeHtml(s.name||'')}" placeholder="اسم الشيت" style="flex:1;min-width:140px;padding:8px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;white-space:nowrap;"><input type="checkbox" class="gsc-enabled" ${s.enabled?'checked':''}> مفعّل</label>
          <input type="number" class="gsc-interval" min="1" value="${s.intervalMin||2}" style="width:70px;padding:8px 6px;border:1px solid var(--border,#ccc);border-radius:6px;" title="كل كم دقيقة؟">
          <span style="font-size:12px;color:var(--text-muted);">دقيقة</span>
          <button type="button" class="btn btn-danger btn-sm gsc-del" data-row="${i}">✕</button>
        </div>
        <input type="text" class="gsc-url" value="${escapeHtml(s.url||'')}" placeholder="رابط جوجل شيت منشور كـ CSV" style="width:100%;padding:8px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">
      </div>`).join('');
  }

  /* -------- ربط الأحداث -------- */
  function bind(){
    // تبويبات
    document.querySelectorAll('.gsheet-tab-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.querySelectorAll('.gsheet-tab-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.gsheetTab;
        document.querySelectorAll('.gsheet-tab-pane').forEach(p=>p.style.display='none');
        const pane = document.querySelector(`[data-gsheet-pane="${tab}"]`);
        if(pane) pane.style.display='';
      });
    });
    // لوحة الشيتات
    const cfgBtn = $('#btn-gsheet-config'), cfgMenu = $('#btn-gsheet-config-menu');
    const openCfg = ()=>{ renderConfigRows(); $('#gsheet-config-overlay').classList.add('show'); SoundFX && SoundFX.open(); };
    cfgBtn && cfgBtn.addEventListener('click', openCfg);
    cfgMenu && cfgMenu.addEventListener('click', openCfg);
    $('#btn-gsheet-config-cancel') && $('#btn-gsheet-config-cancel').addEventListener('click', ()=>$('#gsheet-config-overlay').classList.remove('show'));
    $('#btn-gsheet-config-save') && $('#btn-gsheet-config-save').addEventListener('click', ()=>{
      const w = wfData();
      w.sheets = [];
      document.querySelectorAll('.gsheet-cfg-row').forEach(row=>{
        const name = row.querySelector('.gsc-name').value.trim();
        const url = row.querySelector('.gsc-url').value.trim();
        if(!url) return;
        w.sheets.push({
          name: name || 'شيت '+(w.sheets.length+1),
          url,
          enabled: row.querySelector('.gsc-enabled').checked,
          intervalMin: Math.max(1, Number(row.querySelector('.gsc-interval').value)||2)
        });
      });
      persistWf().then(()=>{ $('#gsheet-config-overlay').classList.remove('show'); renderAll(); restartTimer(); showToast('تم حفظ الشيتات'); });
    });
    $('#btn-gsheet-add-row') && $('#btn-gsheet-add-row').addEventListener('click', ()=>{
      const host = document.querySelector('[data-gsheet-config-rows]');
      const w = wfData();
      w.sheets.push({name:'',url:'',enabled:false,intervalMin:2});
      renderConfigRows();
      // Shift focus is not needed
    });
    document.querySelector('[data-gsheet-config-rows]') && document.querySelector('[data-gsheet-config-rows]').addEventListener('click', e=>{
      if(e.target.classList.contains('gsc-del')){
        const w = wfData(); const i = Number(e.target.dataset.row);
        w.sheets.splice(i,1); renderConfigRows();
      }
    });
    // جلب الآن
    const fetchBtn = $('#btn-gsheet-fetch-all');
    fetchBtn && fetchBtn.addEventListener('click', async ()=>{
      fetchBtn.disabled = true; fetchBtn.textContent = 'جارٍ الجلب...';
      const r = await fetchAllSheets().catch(()=>({total:0}));
      fetchBtn.disabled = false; fetchBtn.textContent = '⬇️ جلب الآن';
      showToast(r.total ? `أُضيف ${r.total} صف جديد للاعتماد` : 'لا توجد صفوف جديدة للاعتماد');
    });
    // أزرار الصفوف (delegation على اللوحة)
    const body = document.getElementById('gsheet-workflow-panels');
    body && body.addEventListener('click', e=>{
      const t = e.target;
      if(t.classList.contains('gs-approve')) approvePending(t.dataset.id);
      else if(t.classList.contains('gs-reject')) rejectPending(t.dataset.id);
      else if(t.classList.contains('gs-restore')) restoreRejected(t.dataset.id);
      else if(t.classList.contains('gs-approve-rej')) approveRejected(t.dataset.id);
      else if(t.classList.contains('gs-edit')) openEdit(t.dataset.id, t.dataset.r==='1');
    });
    // نافذة التعديل
    $('#btn-gsheet-edit-cancel') && $('#btn-gsheet-edit-cancel').addEventListener('click', ()=>{ $('#gsheet-edit-overlay').classList.remove('show'); _editId=null; });
    $('#btn-gsheet-edit-save') && $('#btn-gsheet-edit-save').addEventListener('click', saveEdit);
  }

  /* -------- مؤقّت الجلب الدوري -------- */
  let _timer = null;
  function restartTimer(){
    if(_timer) clearInterval(_timer);
    const w = wfData();
    if(!w.sheets.length) return;
    // نأخذ أصغر مدة فواصل بين الشيتات المفعّلة (بحد أدنى دقيقة واحدة)
    const enabled = w.sheets.filter(s=>s.enabled);
    if(!enabled.length) return;
    let min = 5;
    enabled.forEach(s=>{ const v=Number(s.intervalMin)||2; if(v<min) min=v; });
    min = Math.max(1, min);
    _timer = setInterval(()=>{ if(typeof clients!=='undefined' && Array.isArray(clients) && clients.length) fetchAllSheets().catch(()=>{}); }, 60000*min);
    if(typeof clients!=='undefined' && Array.isArray(clients) && clients.length) fetchAllSheets().catch(()=>{});
  }

  // إعادة العرض عند ظهر اللوحة
  function init(){
    bind();
    setTimeout(renderAll, 800);
    setTimeout(()=>{ if(typeof settings!=='undefined' && settings) restartTimer(); }, 2500);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
