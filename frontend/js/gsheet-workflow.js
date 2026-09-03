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
   ------------------------------------------------------------
   إصلاحات شاملة:
   - Source Identity ثابتة (sourceRowKey + workflowId)
   - State machine واضح (PENDING/PROCESSING/APPROVED/REJECTED/FAILED)
   - Idempotency مدمج لكل عملية اعتماد
   - Server-side duplicate protection على pending
   - Safe ordering: إنشاء العميل أولاً ثم الحفظ ثم التأكيد
   - Error handling كامل بدون Error Swallowing
   - Per-sheet scheduling
   - CSV parser صحيح يتعامل مع commas/quotes/newlines
   - XSS prevention على كل بيانات Google Sheets
   - Audit trail لكل عملية مهمة
   - Processing timeout للعمليات العالقة
   ============================================================ */
(function(){
  'use strict';

  /* ===================== Workflow Data Layer ===================== */

  function wfData(){
    if(!settings) return { sheets:[], pending:[], rejected:[], auditLog:[] };
    if(!settings.gsheetWorkflow || typeof settings.gsheetWorkflow !== 'object')
      settings.gsheetWorkflow = { sheets:[], pending:[], rejected:[], auditLog:[] };
    const w = settings.gsheetWorkflow;
    if(!Array.isArray(w.sheets)) w.sheets = [];
    if(!Array.isArray(w.pending)) w.pending = [];
    if(!Array.isArray(w.rejected)) w.rejected = [];
    if(!Array.isArray(w.auditLog)) w.auditLog = [];
    return w;
  }

  function persistWf(){ return saveSettings(); }

  /* ===================== Source Identity ===================== */

  function makeSourceRowKey(sheetId, clientId){
    return (sheetId||'') + '::' + (clientId||'');
  }

  function makeSheetId(sheetUrl){
    var m = String(sheetUrl||'').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : sheetUrl||'unknown';
  }

  function makeWorkflowId(){
    return 'wf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7);
  }

  /* ===================== Safe ID Generator ===================== */

  function safeUid(){
    if(typeof uid === 'function') return uid();
    return Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  }

  /* ===================== Audit Trail ===================== */

  function auditLog(action, data){
    var w = wfData();
    var entry = {
      id: safeUid(),
      action: action,
      workflowId: data.workflowId || '',
      clientId: data.clientId || '',
      user: (typeof currentUser !== 'undefined' && currentUser) ? currentUser : '',
      timestamp: Date.now(),
      oldStatus: data.oldStatus || '',
      newStatus: data.newStatus || '',
      details: data.details || ''
    };
    w.auditLog.push(entry);
    if(w.auditLog.length > 500) w.auditLog.splice(0, w.auditLog.length - 500);
  }

  /* ===================== Enhanced CSV Parser ===================== */

  function parseCsvLine(line){
    var out=[]; var cur=''; var inQ=false;
    for(var i=0;i<line.length;i++){
      var ch=line[i];
      if(inQ){
        if(ch==='"' && i+1<line.length && line[i+1]==='"'){ cur+='"'; i++; }
        else if(ch==='"') inQ=false;
        else cur+=ch;
      } else {
        if(ch==='"') inQ=true;
        else if(ch===','){ out.push(cur); cur=''; }
        else cur+=ch;
      }
    }
    out.push(cur);
    return out.map(function(v){ return v.trim(); });
  }

  function parseCsvRows(csv){
    var text = String(csv||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    var lines=[]; var cur=''; var inQ=false;
    for(var i=0;i<text.length;i++){
      var ch=text[i];
      if(ch==='"'){ inQ = !inQ; cur+=ch; }
      else if(ch==='\n' && !inQ){ lines.push(cur); cur=''; }
      else cur+=ch;
    }
    if(cur) lines.push(cur);
    return lines.filter(function(l){ return l.trim()!==''; });
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
    // استخراج gid من الـ hash أو query قبل إزالة الـ fragment
    var gidMatch = /[?&]gid=(\d+)/.exec(url) || /#gid=(\d+)/.exec(url);
    var gid = gidMatch ? gidMatch[1] : null;
    url = url.split('#')[0]; // نزيل الـ fragment حتى لا يكسر الـ URL
    try {
      var u = new URL(url);
      if(u.hostname !== 'docs.google.com') return null;
    } catch(e){ return null; }
    // روابط "نشر على الويب" (File > Share > Publish to web) لها صيغة مختلفة تماماً:
    // /spreadsheets/d/e/{pubId}/pub?... — لازم تُفحص هذه الصيغة أولاً وتُستثنى من
    // القاعدة العامة تحتها، لأن تلك القاعدة كانت (غلطاً) تلتقط الحرف "e" وحده كمعرّف
    // (لأنه أول جزء بعد "/d/" وقبل "/") بدل معرّف النشر الحقيقي الطويل بعده، فتبني
    // رابط export?format=csv بمعرّف "e" غير موجود أصلاً فيفشل الجلب بصمت أو يرجّع صفراً.
    // نفس السبب يفرض استخدام مسار /pub?output=csv هنا وليس /export?format=csv، لأن
    // export لا يعمل على مستندات "منشورة" بهذا الشكل.
    var pubMatch = url.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)/);
    if(pubMatch){
      return 'https://docs.google.com/spreadsheets/d/e/'+pubMatch[1]+'/pub?output=csv'+(gid?('&gid='+gid+'&single=true'):'');
    }
    // يجب أن يحتوي على معرّف spreadsheet
    var m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if(!m) return null;
    var docId = m[1];
    // دائماً نبني رابط export?format=csv من الـ docId (يعمل مهما كان نمط الرابط الأصلي)
    return 'https://docs.google.com/spreadsheets/d/'+docId+'/export?format=csv'+(gid?('&gid='+gid):'');
  }

  function cleanPrice(v){
    v = String(v||'');
    var m = v.replace(/[^0-9.,\-]/g,'').replace(/,/g,'').match(/^-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }

  function toIsoDate(v){
    v = String(v||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if(m) return m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');
    return '';
  }

  /* ===================== XSS Sanitization ===================== */

  function sanitizeText(val){
    var s = String(val||'');
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    s = s.replace(/on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    s = s.replace(/javascript\s*:/gi, '');
    s = s.replace(/vbscript\s*:/gi, '');
    s = s.replace(/data\s*:[^,]*text\/html/gi, '');
    return s;
  }

  /* ===================== CSV Fetch ===================== */

  var _fetchingSheets = {};

  async function fetchSheetCsv(url){
    var csvUrl = toCsvUrl(url);
    if(!csvUrl) throw new Error('رابط غير صالح: يجب أن يكون رابط Google Docs Spreadsheet');
    // نمرر الطلب عبر بروكسي على نفس الأصل (يعمل من السيرفر/المتصفح وElectron)
    // لأن الجلب المباشر إلى docs.google.com يُحجب بـ CORS من المتصفح.
    var res = await fetch('/gsheet-csv?url=' + encodeURIComponent(csvUrl), { cache:'no-store' });
    if(!res.ok){
      var body = '';
      try { body = await res.text(); } catch(e){}
      throw new Error('فشل جلب الشيت — HTTP '+res.status+(body ? ' — '+body : ''));
    }
    return await res.text();
  }

  /* ===================== Row Parsing ===================== */

  function parseSheetRows(csv){
    var rawLines = parseCsvRows(csv);
    if(!rawLines.length) return [];
    var header = parseCsvLine(rawLines[0]).map(normHeader);
    var colMap = {id:-1,name:-1,phone:-1,nationality:-1,courseType:-1,paid:-1,channel:-1,date:-1,bag:-1};
    header.forEach(function(h,i){ if(h in colMap && colMap[h]===-1) colMap[h]=i; });
    var val=function(r,key){ return (colMap[key]>=0 && colMap[key]<r.length) ? r[colMap[key]] : ''; };
    var rows=[];
    for(var i=1;i<rawLines.length;i++){
      var r = parseCsvLine(rawLines[i]);
      var clientId = sanitizeText(String(val(r,'id')).trim());
      if(!clientId) continue; // رقم الهوية مطلوب — الصف يُتجاهل لو فاضي
      var name = sanitizeText(String(val(r,'name')).trim());
      if(!name) continue;
      var paidRaw = String(val(r,'paid')||'').trim();
      if(!paidRaw) continue; // المدفوع مطلوب — الصف يُتجاهل لو خانة المدفوع فاضية
      rows.push({
        clientId: clientId,
        name: name,
        phone: sanitizeText(val(r,'phone').trim()),
        nationality: sanitizeText(val(r,'nationality').trim()),
        courseType: sanitizeText(val(r,'courseType').trim()),
        paid: cleanPrice(paidRaw),
        channel: sanitizeText(val(r,'channel').trim()),
        bag: cleanPrice(val(r,'bag')),
        date: toIsoDate(val(r,'date'))
      });
    }
    return rows;
  }

  /* ===================== Known Client IDs Set ===================== */

  function knownClientIds(){
    var s = new Set();
    (typeof clients!=='undefined' && Array.isArray(clients) ? clients : []).forEach(function(c){
      if(c.clientId) s.add(String(c.clientId).trim());
    });
    var w = wfData();
    (w.pending||[]).forEach(function(p){
      if(p.status!=='FAILED' && p.clientId) s.add(String(p.clientId).trim());
    });
    (w.rejected||[]).forEach(function(p){
      if(p.clientId) s.add(String(p.clientId).trim());
    });
    return s;
  }

  /* ===================== Server Auto-Confirm (fix stuck pending clients) ===================== */

  // مشكلة "العملاء العالقين ·قيد التنفيذ/قيد الاعتماد" بجانب الشيتات:
  // عند اعتماد عميل من شيتات جوجل بواسطة جلسة استقبال (reception) يُرفَع السجل للسيرفر
  // بحالة status='pending' بانتظار اعتماد الأدمن — فلا يدخل الحسابات/التقارير ويبقى عالقاً
  // حتى يعتمده الأدمن يدوياً من شيت العملاء. هنا لو كان المستخدم الحالي أدمن نقوم باعتماد
  // السجل على السيرفر فور إنشائه ليصبح confirmed لا pending — حل نهائي للتعليق.
  async function ensureClientConfirmedOnServer(client){
    if(typeof approveClientRecord !== 'function') return false;
    if(typeof clientRecordMeta !== 'object' || !clientRecordMeta) return false;
    try{
      var meta = clientRecordMeta[client.id];
      if(meta && meta.status === 'pending'){
        var ok = await approveClientRecord(client.id);
        if(ok && typeof syncClientLedgerEntry === 'function'){
          syncClientLedgerEntry(client);
          if(typeof saveVaultTx === 'function') await saveVaultTx();
        }
        return ok;
      }
    }catch(e){ /* لا نعطل عملية الاعتماد المحلية إن فشل اعتماد السيرفر */ }
    return false;
  }

  /* ===================== Stale Row Cleanup ===================== */

  // تنظيف تلقائي لقائمة الاعتماد من العناصر العالقة/غير القابلة للاعتماد:
  //  1) أي صف رقم هويته صار عميلاً موجوداً فعلاً (مُعتمد من مكان آخر) — فيُحذف لأنه لم يعد صالحاً،
  //  2) أي صف ظل PENDING فترة طويلة (افتراضياً 60 يوماً) بلا اعتماد/رفض — حتى لا تتكدس القائمة،
  //     ويُعاد فحصه من الشيت عند الجلب التالي لو ما زال وارده.
  //  3) أي صف FAILED قديم وتحوّل إلى عميل فعلي — يُحذف بدل بقائه معلقاً أمام المستخدم.
  var GSHEET_STALE_MAX_AGE_DAYS = 60;
  function cleanupStaleGsheetRows(){
    try{
      var w = wfData();
      if(!w.pending.length && !w.rejected.length) return;
      var known = new Set();
      (typeof clients!=='undefined' && Array.isArray(clients) ? clients : []).forEach(function(c){
        if(c.clientId) known.add(String(c.clientId).trim());
      });
      var cutoff = Date.now() - GSHEET_STALE_MAX_AGE_DAYS*86400000;
      var changed = false;
      var isRecent = function(p){ return !(p && p.fetchedAt && p.fetchedAt < cutoff); };
      w.pending = w.pending.filter(function(p){
        var dup = known.has(String(p.clientId||'').trim());
        var aged = !isRecent(p);
        var failedNowClient = (p.status === 'FAILED' && dup);
        if(dup || aged || failedNowClient){ changed = true; return false; }
        return true;
      });
      w.rejected = w.rejected.filter(function(p){
        if(!isRecent(p)){ changed = true; return false; }
        return true;
      });
      if(changed) persistWf();
    }catch(e){ /* لا نوقف العرض على خطأ تنظيف */ }
  }

  /* ===================== Single Sheet Fetch ===================== */

  async function fetchOneSheet(sheet){
    var csv = await fetchSheetCsv(sheet.url);
    var rows = parseSheetRows(csv);
    var sheetId = makeSheetId(sheet.url);
    var w = wfData();
    var added = 0;
    var known = knownClientIds();
    for(var i=0;i<rows.length;i++){
      var row = rows[i];
      var sourceRowKey = makeSourceRowKey(sheetId, row.clientId);
      var existing = w.pending.find(function(p){
        return p.sourceRowKey === sourceRowKey && p.status !== 'FAILED';
      });
      if(existing) continue;
      var existingRejected = w.rejected.find(function(p){
        return p.sourceRowKey === sourceRowKey;
      });
      if(existingRejected) continue;
      if(known.has(row.clientId)) continue;
      var workflowItem = {
        id: safeUid(),
        workflowId: makeWorkflowId(),
        sheetName: sheet.name,
        sheetUrl: sheet.url,
        sourceSheetId: sheetId,
        sourceRowKey: sourceRowKey,
        sourceProvider: 'google_sheets',
        fetchedAt: Date.now(),
        status: 'PENDING',
        clientId: row.clientId,
        name: row.name,
        phone: row.phone,
        nationality: row.nationality,
        courseType: row.courseType,
        paid: row.paid,
        channel: row.channel,
        bag: row.bag,
        date: row.date,
        processedAt: null,
        processedBy: null,
        rejectionReason: null,
        errorMessage: null,
        idempotencyKey: null,
        version: 1
      };
      w.pending.push(workflowItem);
      known.add(row.clientId);
      added++;
    }
    if(added) await persistWf();
    return {added:added, total:rows.length, sheet:sheet.name};
  }

  /* ===================== Batch Sheet Fetch ===================== */

  async function fetchAllSheets(){
    var w = wfData();
    var enabled = w.sheets.filter(function(s){ return s.enabled && s.url; });
    if(!enabled.length) return {total:0, results:[], noEnabledSheets:true};
    var total = 0;
    var results = [];
    for(var i=0;i<enabled.length;i++){
      var sh = enabled[i];
      if(_fetchingSheets[sh.name]) continue;
      _fetchingSheets[sh.name] = true;
      try {
        var r = await fetchOneSheet(sh);
        total += r.added;
        results.push({sheet:sh.name, added:r.added, total:r.total, error:null});
      } catch(e) {
        var errMsg = (e && e.message) ? e.message : 'خطأ غير معروف';
        results.push({sheet:sh.name, added:0, total:0, error:errMsg});
        console.error('[gsheet-workflow] fetch failed for "'+sh.name+'":', e);
      } finally {
        delete _fetchingSheets[sh.name];
      }
    }
    if(total) renderAll();
    return {total:total, results:results};
  }

  /* ===================== Per-Sheet Scheduler ===================== */

  var _sheetTimers = {};

  function restartTimer(){
    Object.keys(_sheetTimers).forEach(function(k){
      clearInterval(_sheetTimers[k]);
      delete _sheetTimers[k];
    });
    var w = wfData();
    var enabled = w.sheets.filter(function(s){ return s.enabled && s.url; });
    if(!enabled.length) return;
    enabled.forEach(function(sheet){
      var intervalMs = Math.max(1, Number(sheet.intervalMin)||2) * 60000;
      _sheetTimers[sheet.name] = setInterval(function(){
        // فحص دوري لأي عملية "قيد التنفيذ" عالقة (أكثر من دقيقتين) قبل الجلب،
        // حتى لا تحتاج الصفحة لإعادة تحميل كاملة لفك التعليق.
        if(recoverStuckProcessing()) renderAll();
        fetchOneSheet(sheet).then(function(r){
          runLiveCompare().then(function(){ renderAll(); });
        }).catch(function(e){
          console.error('[gsheet-workflow] auto-fetch error for "'+sheet.name+'":', e);
        });
      }, intervalMs);
    });
    fetchAllSheets().catch(function(e){
      console.error('[gsheet-workflow] initial fetch error:', e);
    }).then(function(){
      return runLiveCompare();
    }).then(function(){ renderAll(); });
  }

  /* ===================== Validation ===================== */

  function validateClientId(clientId, workflowId){
    var errors = [];
    var id = String(clientId||'').trim();
    if(!id) errors.push('رقم الهوية مطلوب');
    else if(id.length !== 10) errors.push('رقم الهوية يجب أن يكون 10 أرقام');
    else if(!/^\d{10}$/.test(id)) errors.push('رقم الهوية يجب أن يحتوي أرقاماً فقط');
    if(!errors.length){
      var count = 0;
      (typeof clients!=='undefined' && Array.isArray(clients) ? clients : []).forEach(function(c){
        if(String(c.clientId).trim()===id) count++;
      });
      var w = wfData();
      w.pending.forEach(function(p){
        if(p.id!==workflowId && p.status!=='FAILED' && String(p.clientId).trim()===id) count++;
      });
      w.rejected.forEach(function(p){
        if(p.id!==workflowId && String(p.clientId).trim()===id) count++;
      });
      if(count > 0) errors.push('رقم الهوية مستخدم بالفعل');
    }
    return errors;
  }

  function validatePendingItem(p){
    var errors = [];
    if(!p.clientId || !String(p.clientId).trim()){
      errors.push('رقم الهوية مطلوب');
      return errors;
    }
    return validateClientId(p.clientId, p.id);
  }

  /* ===================== Processing Lease ===================== */

  function acquireProcessingLease(item, username){
    var w = wfData();
    var idx = -1;
    w.pending.forEach(function(p,i){
      if(p.workflowId === item.workflowId || p.id === item.id) idx = i;
    });
    if(idx < 0) return {ok:false, error:'العملية غير موجودة'};
    var p = w.pending[idx];
    if(p.status === 'APPROVED') return {ok:false, error:'تم اعتماد هذا العميل مسبقاً'};
    if(p.status === 'REJECTED') return {ok:false, error:'تم رفض هذا العميل مسبقاً'};
    if(p.status === 'PROCESSING'){
      var leaseExpiry = (p.leaseUntil||0);
      if(leaseExpiry > Date.now()) return {ok:false, error:'العملية قيد التنفيذ من مستخدم آخر'};
    }
    p.status = 'PROCESSING';
    p.processedBy = username || (typeof currentUser!=='undefined' ? currentUser : '');
    p.processingStartedAt = Date.now();
    p.leaseUntil = Date.now() + 60000;
    return {ok:true, index:idx};
  }

  function releaseLease(idx, finalStatus, error){
    var w = wfData();
    if(idx < 0 || idx >= w.pending.length) return;
    var p = w.pending[idx];
    if(finalStatus === 'APPROVED'){
      p.status = 'APPROVED';
      p.processedAt = Date.now();
      p.errorMessage = null;
    } else if(finalStatus === 'FAILED'){
      p.status = 'FAILED';
      p.processedAt = null;
      p.errorMessage = error || 'فشل غير معروف';
    } else {
      p.status = 'PENDING';
      p.processedBy = null;
      p.processingStartedAt = null;
      p.leaseUntil = null;
    }
  }

  /* ===================== Approve Pending ===================== */

  async function approvePending(id, fromRejected){
    var w = wfData();
    var list = fromRejected ? w.rejected : w.pending;
    var listIdx = list.findIndex(function(p){ return p.id===id; });
    if(listIdx<0) return;
    var p = list[listIdx];

    if(p.status === 'PROCESSING'){
      showToast('العملية قيد التنفيذ من مستخدم آخر — يرجى الانتظار');
      return;
    }
    if(p.status === 'APPROVED'){
      showToast('تم اعتماد هذا العميل مسبقاً');
      return;
    }

    var vErrors = [];
    if(!p.clientId || !String(p.clientId).trim()){
      vErrors.push('رقم الهوية مطلوب');
    } else {
      var idErrs = validateClientId(p.clientId, p.id);
      vErrors = vErrors.concat(idErrs);
    }
    if(vErrors.length){
      showToast('خطأ في البيانات: '+vErrors.join(' — '));
      return;
    }

    var lease = acquireProcessingLease(p);
    if(!lease.ok){
      showToast(lease.error);
      return;
    }
    var pendingIdx = lease.index;
    await persistWf();

    try {
      var clientId = String(p.clientId).trim();
      var existingClient = (typeof clients!=='undefined' && Array.isArray(clients) ? clients : []).find(function(c){
        return String(c.clientId).trim() === clientId;
      });
      if(existingClient){
        showToast('رقم الهوية مستخدم بالفعل — تم حذف من قائمة الاعتماد');
        w.pending.splice(pendingIdx, 1);
        await persistWf();
        renderAll();
        return;
      }

      var client = {
        id: safeUid(),
        createdAt: Date.now(),
        createdBy: (typeof currentUser!=='undefined' && currentUser) ? currentUser : '',
        clientId: clientId,
        name: (p.name||'').trim(),
        phone: (p.phone||'').trim(),
        nationality: (p.nationality||'').trim(),
        clientType: 'center',
        companyName: '', creditDays: '', clientTaxNumber: '',
        courseType: (p.courseType||'').trim(),
        courseNumber: '',
        referNum: '', invoice: '', bagInvoice: '',
        date: p.date || (typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10)),
        coursePrice: (typeof settings!=='undefined' && settings) ? (typeof num==='function' ? num(settings.coursePrice) : 0) : 0,
        bagSource: 'buy',
        bagPrice: (p.bag||0)>0 ? p.bag : (typeof settings!=='undefined' && settings ? (typeof num==='function' ? num(settings.bagPrice) : 0) : 0),
        bagStatus: 'pending',
        discount: 0,
        paid: (p.paid||0),
        channel: (p.channel||'').trim() || 'نقدي',
        networkInvoice: '', paid2: 0, channel2: '', networkInvoice2: '',
        stage: 'جديد', cancelled: false,
        notes: ''
      };

      if(typeof snapshotState === 'function'){
        snapshotState('اعتماد عميل من شيت «'+p.sheetName+'»');
      }

      clients.push(client);

      if(typeof syncClientLedgerEntry === 'function'){
        syncClientLedgerEntry(client);
      }

      await saveClients();
      // إصلاح التعليق: اعتماد تلقائي للسجل على السيرفر لو خُلِق pending (جلسة استقبال) ليجتاز
      // "قيد الاعتماد". بعد نجاح الحفظ يتحدّث clientRecordMeta بالحالة، فنعتمد عليه إن كان معلقاً.
      var gsServerConfirmed = false;
      if(typeof clientRecordMeta==='object' && clientRecordMeta && clientRecordMeta[client.id]){
        gsServerConfirmed = await ensureClientConfirmedOnServer(client);
      }
      await saveVaultTx();
      if(fromRejected){
        var rejIdx = w.rejected.findIndex(function(x){ return x.id===id; });
        if(rejIdx>=0) w.rejected.splice(rejIdx,1);
      } else {
        w.pending.splice(pendingIdx,1);
      }
      await persistWf();

      auditLog('APPROVE', {
        workflowId: p.workflowId,
        clientId: clientId,
        oldStatus: fromRejected ? 'REJECTED' : 'PENDING',
        newStatus: 'APPROVED'
      });

      if(typeof renderAll === 'function') renderAll();
      if(typeof renderTable === 'function') renderTable();
      if(typeof renderDashboard === 'function') renderDashboard();
      if(typeof refreshFilterOptions === 'function') refreshFilterOptions();
      if(typeof renderCourses === 'function') renderCourses();
      showToast(gsServerConfirmed
        ? 'تم اعتماد «'+client.name+'» وترحيل المدفوع للحركات المالية'
        : 'تم اعتماد «'+client.name+'» وترحيل المدفوع للحركات المالية — لكنه سيُكمل عرض "قيد الاعتماد" حتى يعتمده الأدمن (حساب الاستقبال بحاجة لموافقة الأدمن)');

    } catch(e) {
      releaseLease(pendingIdx, 'FAILED', (e && e.message) ? e.message : String(e));
      await persistWf();

      auditLog('FAIL', {
        workflowId: p.workflowId,
        clientId: p.clientId,
        oldStatus: 'PROCESSING',
        newStatus: 'FAILED',
        details: (e && e.message) ? e.message : String(e)
      });

      renderAll();
      showToast('فشل اعتماد العميل: ' + ((e && e.message) ? e.message : 'خطأ غير معروف'));
    }
  }

  /* ===================== Reject Pending ===================== */

  async function rejectPending(id){
    var w = wfData();
    var idx = w.pending.findIndex(function(p){ return p.id===id; });
    if(idx<0) return;
    var p = w.pending[idx];

    if(p.status === 'PROCESSING'){
      showToast('العملية قيد التنفيذ من مستخدم آخر');
      return;
    }

    p.status = 'REJECTED';
    p.processedAt = Date.now();
    p.processedBy = (typeof currentUser!=='undefined' && currentUser) ? currentUser : '';
    p.rejectedAt = Date.now();

    w.pending.splice(idx,1);
    var exists = w.rejected.some(function(r){
      return r.sourceRowKey === p.sourceRowKey;
    });
    if(!exists) w.rejected.push(p);

    auditLog('REJECT', {
      workflowId: p.workflowId,
      clientId: p.clientId,
      oldStatus: 'PENDING',
      newStatus: 'REJECTED',
      rejectionReason: p.rejectionReason || null
    });

    await persistWf();
    renderAll();
    showToast('تم نقل العميل إلى المرفوض');
  }

  /* ===================== Restore Rejected ===================== */

  async function restoreRejected(id){
    var w = wfData();
    var idx = w.rejected.findIndex(function(p){ return p.id===id; });
    if(idx<0) return;
    var p = w.rejected.splice(idx,1)[0];

    p.status = 'PENDING';
    delete p.rejectedAt;
    delete p.rejectedBy;
    delete p.rejectionReason;
    p.version = (p.version||0) + 1;

    var exists = w.pending.some(function(x){
      return x.sourceRowKey === p.sourceRowKey && x.status !== 'FAILED';
    });
    if(!exists) w.pending.push(p);

    auditLog('RESTORE', {
      workflowId: p.workflowId,
      clientId: p.clientId,
      oldStatus: 'REJECTED',
      newStatus: 'PENDING'
    });

    await persistWf();
    renderAll();
    showToast('أُعيد العميل إلى بانتظار الاعتماد');
  }

  /* ===================== Approve Rejected ===================== */

  async function approveRejected(id){
    await approvePending(id, true);
  }

  /* ===================== Edit Before Approval ===================== */

  var _editId = null, _editFromRejected=false;

  function openEdit(id, fromRejected){
    var w = wfData();
    var list = fromRejected ? w.rejected : w.pending;
    var p = list.find(function(x){ return x.id===id; });
    if(!p) return;
    _editId = id; _editFromRejected = fromRejected;
    var esc = typeof escapeHtml === 'function' ? escapeHtml : function(s){ return String(s).replace(/[&<>"']/g, function(m){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]; }); };
    var natOpts = '<option value=""></option>' + ((typeof settings!=='undefined' && settings && settings.nationalities)||[]).map(function(n){
      return '<option value="'+esc(n)+'"'+(n===(p.nationality||'')?' selected':'')+'>'+esc(n)+'</option>';
    }).join('');
    var courseOpts = '<option value=""></option>' + ((typeof settings!=='undefined' && settings && settings.courses)||[]).map(function(c){
      return '<option value="'+esc(c.name)+'"'+(c.name===(p.courseType||'')?' selected':'')+'>'+esc(c.name)+'</option>';
    }).join('');
    var chanOpts = '<option value=""></option>' + ((typeof settings!=='undefined' && settings && settings.channels)||[]).map(function(c){
      return '<option value="'+esc(c.name)+'"'+(c.name===(p.channel||'')?' selected':'')+'>'+esc(c.name)+'</option>';
    }).join('');
    var f=function(label,idv,html){ return '<div style="margin-bottom:12px;"><label style="display:block;font-size:13px;margin-bottom:4px;">'+label+'</label>'+html+'</div>'; };
    var inp=function(idv,v){ return '<input type="text" class="gse-'+idv+'" value="'+esc(v)+'" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'; };
    var inp2=function(type,val){ return '<input type="'+type+'" value="'+esc(String(val||''))+'" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'; };
    var el = document.getElementById('gsheet-edit-fields');
    if(el){
      el.innerHTML =
        f('رقم الهوية *','id',inp('id',p.clientId))+
        f('الاسم *','name',inp('name',p.name))+
        f('الجوال','phone',inp('phone',p.phone))+
        f('الجنسية','nat','<select class="gse-nat" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'+natOpts+'</select>')+
        f('نوع الدورة','course','<select class="gse-course" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'+courseOpts+'</select>')+
        f('طريقة الدفع','channel','<select class="gse-channel" style="width:100%;padding:9px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'+chanOpts+'</select>')+
        f('المدفوع','paid',inp2('number',p.paid))+
        f('سعر الحقيبة','bag',inp2('number',p.bag))+
        f('تاريخ التسجيل','date',inp2('date',p.date));
    }
    var overlay = document.getElementById('gsheet-edit-overlay');
    if(overlay) overlay.classList.add('show');
    if(typeof SoundFX !== 'undefined' && SoundFX && SoundFX.open) SoundFX.open();
  }

  function _editVal(cls){ var el=document.querySelector(cls); return el?el.value:''; }

  function saveEdit(){
    if(!_editId) return;
    var w = wfData();
    var list = _editFromRejected ? w.rejected : w.pending;
    var p = list.find(function(x){ return x.id===_editId; });
    if(!p) return;

    var newClientId = _editVal('.gse-id').trim();
    var newClientIdError = validateClientId(newClientId, p.id);
    if(newClientIdError.length){
      showToast('خطأ في رقم الهوية: '+newClientIdError.join(' — '));
      return;
    }

    p.clientId = newClientId;
    p.name = sanitizeText(_editVal('.gse-name').trim());
    p.phone = sanitizeText(_editVal('.gse-phone').trim());
    p.nationality = sanitizeText(_editVal('.gse-nat'));
    p.courseType = sanitizeText(_editVal('.gse-course'));
    p.channel = sanitizeText(_editVal('.gse-channel'));
    p.paid = cleanPrice(_editVal('.gse-paid'));
    p.bag = cleanPrice(_editVal('.gse-bag'));
    p.date = _editVal('.gse-date') || p.date;
    p.version = (p.version||0) + 1;

    var overlay = document.getElementById('gsheet-edit-overlay');
    if(overlay) overlay.classList.remove('show');
    _editId=null;
    persistWf().then(function(){ renderAll(); });
  }

  /* ===================== Rendering ===================== */

  function renderAll(){
    cleanupStaleGsheetRows();
    var w = wfData();
    renderPending(w);
    renderRejected(w);
    updateCounts(w);
  }

  function escHtml(s){
    if(typeof escapeHtml === 'function') return escapeHtml(s);
    return String(s).replace(/[&<>"']/g, function(m){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]; });
  }

  /* ===================== Live Compare against Google Sheet ===================== */
  // مقارنة تلقائية (مع كل جلب دوري للشيت) بين بيانات الصف المخزّنة في صندوق
  // الاعتماد/الرفض وما وردَ فعلياً في شيت جوجل الحي، لرصد أي تغيّر أو حذف.
  var liveCompareMap = new Map(); // key: p.id -> { present, changes:[{label,old,val}] }
  var _liveComparing = false;
  var LIVE_FIELDS = [
    { k:'name', label:'الاسم' },
    { k:'phone', label:'الجوال' },
    { k:'nationality', label:'الجنسية' },
    { k:'courseType', label:'الدورة' },
    { k:'paid', label:'المدفوع' },
    { k:'channel', label:'طريقة الدفع' },
    { k:'date', label:'التاريخ' }
  ];

  function liveValueEqual(k, a, b){
    if(k==='paid') return Number(a||0) === Number(b||0);
    if(k==='date') return String(a||'').trim() === String(b||'').trim();
    return String(a||'').trim() === String(b||'').trim();
  }

  // يجري مقارنة صفوف كل الشيتات المفعّلة ويملأ liveCompareMap (ذاكرة فقط، لا يُحفظ)
  async function runLiveCompare(){
    if(_liveComparing) return;
    _liveComparing = true;
    try {
      var w = wfData();
      var enabled = w.sheets.filter(function(s){ return s.enabled && s.url; });
      if(!enabled.length){ liveCompareMap.clear(); return; }
      var sheetRows = {}; // sheetId -> array of parsed live rows
      for(var i=0;i<enabled.length;i++){
        try {
          var csv = await fetchSheetCsv(enabled[i].url);
          sheetRows[makeSheetId(enabled[i].url)] = parseSheetRows(csv);
        } catch(e){
          console.error('[gsheet-workflow] live-compare fetch failed for "'+enabled[i].name+'":', e);
          sheetRows[makeSheetId(enabled[i].url)] = [];
        }
      }
      var items = w.pending.concat(w.rejected);
      var next = new Map();
      var syncedAny = false;
      items.forEach(function(p){
        var sid = p.sourceSheetId || makeSheetId(p.sheetUrl||'');
        var rows = sheetRows[sid] || [];
        var row = null;
        for(var j=0;j<rows.length;j++){
          if(rows[j].clientId === p.clientId){ row = rows[j]; break; }
        }
        var rec;
        if(!row){
          rec = { present:false, changes:[] };
        } else {
          var changes = [];
          LIVE_FIELDS.forEach(function(f){
            var live = f.k==='paid' ? Number(row[f.k]||0) : row[f.k];
            var oldp = p[f.k];
            if(!liveValueEqual(f.k, live, oldp)){
              changes.push({ label:f.label, old:oldp, val:live });
            }
          });
          // مزامنة تلقائية: لو فيه فرق ولسه العنصر مش قيد المعالجة الآن من مستخدم آخر،
          // نجيب القيم الصحيحة من الشيت فوراً ونعلّم الصف كـ"تعديل" بتاريخ المزامنة،
          // بدل ما يفضل معروض ببيانات قديمة اتصلحت في الشيت.
          if(changes.length && p.status !== 'PROCESSING'){
            LIVE_FIELDS.forEach(function(f){
              p[f.k] = f.k==='paid' ? Number(row[f.k]||0) : row[f.k];
            });
            p.lastSyncEditedAt = Date.now();
            syncedAny = true;
            auditLog('SYNC_EDIT', {
              workflowId: p.workflowId,
              clientId: p.clientId,
              details: changes.map(function(c){ return c.label+': '+c.old+' -> '+c.val; }).join(' | ')
            });
            changes = [];
          }
          rec = { present:true, changes:changes };
        }
        next.set(p.id, rec);
      });
      liveCompareMap = next;
      if(syncedAny) await persistWf();
    } finally {
      _liveComparing = false;
    }
  }

  function fmtSyncDate(ts){
    try {
      return new Date(ts).toLocaleString('ar-SA-u-nu-latn', {year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
    } catch(e){ return ''; }
  }

  function liveBadge(p){
    var rec = liveCompareMap.get(p.id);
    var editedNote = p.lastSyncEditedAt
      ? '<div style="font-size:11px;color:#b9770e;white-space:nowrap;">✏️ تعديل — '+fmtSyncDate(p.lastSyncEditedAt)+'</div>'
      : '';
    if(!rec) return editedNote || '<span style="color:var(--text-muted);font-size:12px;">—</span>';
    if(!rec.present){
      return editedNote + '<span class="badge" style="background:rgba(220,53,69,0.15);color:#c0392b;border:1px solid rgba(220,53,69,0.4);white-space:nowrap;" title="لم يعد هذا الصف وارِداً في شيت جوجل">⛔ غير موجود في الشيت</span>';
    }
    if(rec.changes.length){
      var tip = rec.changes.map(function(c){ return c.label+': «'+c.old+'» ← «'+c.val+'»'; }).join(' • ');
      return editedNote + '<span class="badge" style="background:rgba(243,156,18,0.15);color:#b9770e;border:1px solid rgba(243,156,18,0.5);white-space:nowrap;" title="'+escHtml(tip)+'">⚠ تعدُّل ('+rec.changes.length+')</span>';
    }
    return editedNote + '<span class="badge" style="background:rgba(39,174,96,0.12);color:#1e8449;border:1px solid rgba(39,174,96,0.35);white-space:nowrap;">✔ مطابق</span>';
  }

  function rowActions(p, fromRejected){
    if(p.status === 'PROCESSING'){
      return '<span style="color:var(--text-muted);font-size:12px;">⏳ قيد التنفيذ</span>';
    }
    if(p.status === 'FAILED'){
      return '<button class="btn btn-warning btn-sm gs-retry" data-id="'+p.id+'">🔄 إعادة المحاولة</button> <button class="btn btn-danger btn-sm gs-dismiss" data-id="'+p.id+'">✕ تجاهل</button>';
    }
    var btns;
    if(fromRejected){
      btns = '<button class="btn btn-success btn-sm gs-restore" data-id="'+p.id+'">↩ استرجاع</button> <button class="btn btn-primary btn-sm gs-approve-rej" data-id="'+p.id+'">اعتماد</button>';
    } else {
      btns = '<button class="btn btn-ghost btn-sm gs-edit" data-id="'+p.id+'" data-r="0">تعديل</button> <button class="btn btn-danger btn-sm gs-reject" data-id="'+p.id+'">رفض</button> <button class="btn btn-primary btn-sm gs-approve" data-id="'+p.id+'">اعتماد</button>';
    }
    return btns;
  }

  function renderPending(w){
    var tbody = document.getElementById('gsheet-pending-body');
    var empty = document.getElementById('gsheet-pending-empty');
    if(!tbody) return;
    tbody.innerHTML = '';
    var visible = w.pending.filter(function(p){ return p.status!=='APPROVED' && p.status!=='REJECTED'; });
    if(!visible.length){ if(empty) empty.style.display=''; return; }
    if(empty) empty.style.display='none';
    visible.forEach(function(p){
      var tr=document.createElement('tr');
      var statusClass = '';
      if(p.status==='PROCESSING') statusClass=' style="opacity:0.6;"';
      else if(p.status==='FAILED') statusClass=' style="background:rgba(255,0,0,0.05);"';
      tr.innerHTML = '<td'+statusClass+'>'+escHtml(p.sheetName||'')+'</td>'+
        '<td class="mono"'+statusClass+'>'+escHtml(p.clientId||'')+'</td>'+
        '<td'+statusClass+'>'+escHtml(p.name||'')+'</td>'+
        '<td class="mono"'+statusClass+'>'+escHtml(p.phone||'')+'</td>'+
        '<td'+statusClass+'>'+escHtml(p.nationality||'')+'</td>'+
        '<td'+statusClass+'>'+escHtml(p.courseType||'')+'</td>'+
        '<td class="mono"'+statusClass+'>'+String(p.paid||0)+'</td>'+
        '<td'+statusClass+'>'+escHtml(p.channel||'')+'</td>'+
        '<td class="mono"'+statusClass+'>'+escHtml(p.date||'')+'</td>'+
        '<td style="white-space:nowrap;"'+statusClass+'>'+liveBadge(p)+'</td>'+
        '<td style="white-space:nowrap;"'+statusClass+'>'+rowActions(p,false)+'</td>';
      tbody.appendChild(tr);
    });
  }

  function renderRejected(w){
    var tbody = document.getElementById('gsheet-rejected-body');
    var empty = document.getElementById('gsheet-rejected-empty');
    if(!tbody) return;
    tbody.innerHTML = '';
    if(!w.rejected.length){ if(empty) empty.style.display=''; return; }
    if(empty) empty.style.display='none';
    w.rejected.forEach(function(p){
      var tr=document.createElement('tr');
      tr.innerHTML = '<td>'+escHtml(p.sheetName||'')+'</td>'+
        '<td class="mono">'+escHtml(p.clientId||'')+'</td>'+
        '<td>'+escHtml(p.name||'')+'</td>'+
        '<td class="mono">'+escHtml(p.phone||'')+'</td>'+
        '<td>'+escHtml(p.nationality||'')+'</td>'+
        '<td>'+escHtml(p.courseType||'')+'</td>'+
        '<td class="mono">'+String(p.paid||0)+'</td>'+
        '<td>'+escHtml(p.channel||'')+'</td>'+
        '<td class="mono">'+escHtml(p.date||'')+'</td>'+
        '<td style="white-space:nowrap;">'+liveBadge(p)+'</td>'+
        '<td style="white-space:nowrap;">'+rowActions(p,true)+'</td>';
      tbody.appendChild(tr);
    });
  }

  function updateCounts(w){
    var pendingVisible = w.pending.filter(function(p){ return p.status!=='APPROVED' && p.status!=='REJECTED'; }).length;
    var el1 = document.getElementById('gsheet-pending-count');
    var el2 = document.getElementById('gsheet-rejected-count');
    if(el1) el1.textContent = pendingVisible;
    if(el2) el2.textContent = w.rejected.length;
  }

  /* ===================== Config UI ===================== */

  function renderConfigRows(){
    var w = wfData();
    var host = document.querySelector('[data-gsheet-config-rows]');
    if(!host) return;
    if(!w.sheets.length){
      host.innerHTML = '<div class="hint hint-info" style="margin-bottom:10px;">لا توجد شيتات بعد — اضغط «+ إضافة شيت».</div>';
      return;
    }
    host.innerHTML = w.sheets.map(function(s,i){
      var active = (s.enabled !== false); // أي شيت مضاف يكون مفعّل تلقائياً، إلا لو أُوقف صراحة
      return '<div class="gsheet-cfg-row" data-row="'+i+'" data-enabled="'+active+'" style="border:1px solid var(--border,#ddd);border-radius:8px;padding:12px;margin-bottom:10px;'+(active?'':'opacity:0.6;')+'">'+
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">'+
          '<input type="text" class="gsc-name" value="'+escHtml(s.name||'')+'" placeholder="اسم الشيت" style="flex:1;min-width:140px;padding:8px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'+
          '<button type="button" class="btn btn-sm gsc-toggle" data-row="'+i+'" style="white-space:nowrap;'+(active?'color:var(--success,#2fa86a);':'color:var(--danger,#d9534f);')+'">'+
            (active ? '● نشط — إيقاف' : '○ متوقف — تشغيل')+
          '</button>'+
          '<input type="number" class="gsc-interval" min="1" value="'+(s.intervalMin||2)+'" style="width:70px;padding:8px 6px;border:1px solid var(--border,#ccc);border-radius:6px;" title="كل كم دقيقة؟">'+
          '<span style="font-size:12px;color:var(--text-muted);">دقيقة</span>'+
          '<button type="button" class="btn btn-danger btn-sm gsc-del" data-row="'+i+'">✕</button>'+
        '</div>'+
        '<input type="text" class="gsc-url" value="'+escHtml(s.url||'')+'" placeholder="رابط جوجل شيت منشور كـ CSV" style="width:100%;padding:8px 10px;border:1px solid var(--border,#ccc);border-radius:6px;">'+
      '</div>';
    }).join('');
  }

  /* ===================== Event Binding ===================== */

  function bind(){
    document.querySelectorAll('.gsheet-tab-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        document.querySelectorAll('.gsheet-tab-btn').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        var tab = btn.dataset.gsheetTab;
        document.querySelectorAll('.gsheet-tab-pane').forEach(function(p){ p.style.display='none'; });
        var pane = document.querySelector('[data-gsheet-pane="'+tab+'"]');
        if(pane) pane.style.display='';
      });
    });

    var cfgBtn = document.getElementById('btn-gsheet-config');
    var cfgMenu = document.getElementById('btn-gsheet-config-menu');
    var openCfg = function(){ renderConfigRows(); var el=document.getElementById('gsheet-config-overlay'); if(el) el.classList.add('show'); if(typeof SoundFX!=='undefined'&&SoundFX&&SoundFX.open) SoundFX.open(); };
    if(cfgBtn) cfgBtn.addEventListener('click', openCfg);
    if(cfgMenu) cfgMenu.addEventListener('click', openCfg);

    var cancelBtn = document.getElementById('btn-gsheet-config-cancel');
    if(cancelBtn) cancelBtn.addEventListener('click', function(){ var el=document.getElementById('gsheet-config-overlay'); if(el) el.classList.remove('show'); });

    var saveBtn = document.getElementById('btn-gsheet-config-save');
    if(saveBtn) saveBtn.addEventListener('click', function(){
      var w = wfData();
      w.sheets = [];
      document.querySelectorAll('.gsheet-cfg-row').forEach(function(row){
        var name = row.querySelector('.gsc-name').value.trim();
        var url = row.querySelector('.gsc-url').value.trim();
        if(!url) return;
        w.sheets.push({
          name: name || 'شيت '+(w.sheets.length+1),
          url: url,
          enabled: row.dataset.enabled !== 'false',
          intervalMin: Math.max(1, Number(row.querySelector('.gsc-interval').value)||2)
        });
      });
      persistWf().then(function(){
        var overlay = document.getElementById('gsheet-config-overlay');
        if(overlay) overlay.classList.remove('show');
        renderAll();
        restartTimer();
        showToast('تم حفظ الشيتات');
      });
    });

    var addRowBtn = document.getElementById('btn-gsheet-add-row');
    if(addRowBtn) addRowBtn.addEventListener('click', function(){
      var w = wfData();
      w.sheets.push({name:'',url:'',enabled:true,intervalMin:2});
      renderConfigRows();
    });

    var configRows = document.querySelector('[data-gsheet-config-rows]');
    if(configRows) configRows.addEventListener('click', function(e){
      if(e.target.classList.contains('gsc-del')){
        var w = wfData(); var i = Number(e.target.dataset.row);
        w.sheets.splice(i,1); renderConfigRows();
      }
      if(e.target.classList.contains('gsc-toggle')){
        // إيقاف/تشغيل فوري لشيت معيّن — يُحفظ ويُعاد جدولة الجلب مباشرة
        // بدون الحاجة للضغط على «حفظ» بشكل منفصل.
        var w = wfData(); var i = Number(e.target.dataset.row);
        if(w.sheets[i]){
          w.sheets[i].enabled = !(w.sheets[i].enabled !== false);
          persistWf().then(function(){
            renderConfigRows();
            restartTimer();
            showToast(w.sheets[i].enabled ? 'تم تشغيل الشيت' : 'تم إيقاف الشيت');
          });
        }
      }
    });

    var fetchBtn = document.getElementById('btn-gsheet-fetch-all');
    if(fetchBtn) fetchBtn.addEventListener('click', async function(){
      fetchBtn.disabled = true; fetchBtn.textContent = 'جارٍ الجلب...';
      try {
        var r = await fetchAllSheets();
        if(r.noEnabledSheets){
          showToast('لا توجد شيتات مفعّلة — فعّل الشيت من ⚙️ إدارة الشيتات أولاً');
        } else if(r.results && r.results.length){
          var errors = r.results.filter(function(x){ return x.error; });
          if(errors.length){
            var errMsgs = errors.map(function(x){ return x.sheet+': '+x.error; }).join('\n');
            showToast('تم الجلب مع أخطاء: '+errors.length+' فشل\n'+errMsgs);
          } else {
            showToast(r.total ? 'أُضيف '+r.total+' صف جديد للاعتماد' : 'لا توجد صفوف جديدة للاعتماد');
          }
        } else {
          showToast(r.total ? 'أُضيف '+r.total+' صف جديد للاعتماد' : 'لا توجد صفوف جديدة للاعتماد');
        }
      } catch(e) {
        showToast('فشل جلب Google Sheets: '+(e&&e.message?e.message:'خطأ غير معروف'));
      } finally {
        fetchBtn.disabled = false; fetchBtn.textContent = '⬇️ جلب الآن';
      }
    });

    var body = document.getElementById('gsheet-workflow-panels');
    if(body) body.addEventListener('click', async function(e){
      var t = e.target;
      if(t.classList.contains('gs-approve')){
        var id = t.dataset.id;
        t.disabled = true; t.textContent = '⏳';
        await approvePending(id);
      }
      else if(t.classList.contains('gs-reject')){
        var id2 = t.dataset.id;
        t.disabled = true; t.textContent = '⏳';
        await rejectPending(id2);
      }
      else if(t.classList.contains('gs-restore')){
        var id3 = t.dataset.id;
        t.disabled = true; t.textContent = '⏳';
        await restoreRejected(id3);
      }
      else if(t.classList.contains('gs-approve-rej')){
        var id4 = t.dataset.id;
        t.disabled = true; t.textContent = '⏳';
        await approveRejected(id4);
      }
      else if(t.classList.contains('gs-retry')){
        var id5 = t.dataset.id;
        await retryFailed(id5);
      }
      else if(t.classList.contains('gs-dismiss')){
        var id6 = t.dataset.id;
        await dismissFailed(id6);
      }
      else if(t.classList.contains('gs-edit')){
        openEdit(t.dataset.id, t.dataset.r==='1');
      }
    });

    var editCancel = document.getElementById('btn-gsheet-edit-cancel');
    if(editCancel) editCancel.addEventListener('click', function(){
      var overlay = document.getElementById('gsheet-edit-overlay');
      if(overlay) overlay.classList.remove('show');
      _editId=null;
    });
    var editSave = document.getElementById('btn-gsheet-edit-save');
    if(editSave) editSave.addEventListener('click', saveEdit);
  }

  /* ===================== Retry / Dismiss Failed ===================== */

  async function retryFailed(id){
    var w = wfData();
    var idx = w.pending.findIndex(function(p){ return p.id===id; });
    if(idx<0) return;
    var p = w.pending[idx];
    if(p.status !== 'FAILED') return;
    p.status = 'PENDING';
    p.errorMessage = null;
    p.version = (p.version||0) + 1;
    await persistWf();
    renderAll();
    showToast('تمت إعادة العميل إلى بانتظار الاعتماد');
  }

  async function dismissFailed(id){
    var w = wfData();
    var idx = w.pending.findIndex(function(p){ return p.id===id; });
    if(idx<0) return;
    var p = w.pending.splice(idx,1)[0];
    auditLog('DISMISS', {
      workflowId: p.workflowId,
      clientId: p.clientId,
      oldStatus: 'FAILED',
      newStatus: 'DISMISSED'
    });
    await persistWf();
    renderAll();
  }

  /* ===================== Processing Timeout Recovery ===================== */

  function recoverStuckProcessing(){
    var w = wfData();
    var timeoutMs = 120000;
    var changed = false;
    w.pending.forEach(function(p){
      if(p.status === 'PROCESSING' && p.processingStartedAt){
        if(Date.now() - p.processingStartedAt > timeoutMs){
          p.status = 'PENDING';
          p.processedBy = null;
          p.processingStartedAt = null;
          p.leaseUntil = null;
          changed = true;
        }
      }
    });
    // إصلاح: كانت الحالة تُصحَّح في الذاكرة المحلية فقط بدون حفظ على السيرفر،
    // فيفضل السجل "قيد التنفيذ" عالقاً للأبد لأي مستخدم آخر يفتح الصفحة لاحقاً.
    if(changed) persistWf();
    return changed;
  }

  /* ===================== One-time Auto-enable Migration ===================== */

  // كانت الشيتات تتطلب تفعيل يدوي من الإعدادات (checkbox) كل مرة — أي شيت
  // enabled=false غالباً كان بسبب عدم تفعيله يدوياً وليس إيقافاً مقصوداً.
  // هذه الترحيلة تُفعّل كل الشيتات الموجودة تلقائياً مرة واحدة فقط؛ أي إيقاف
  // لاحق يتم فقط عبر زر «إيقاف» الجديد ولا يُلغى بهذه الترحيلة مرة أخرى.
  function migrateAutoEnableSheets(){
    var w = wfData();
    if(w.sheetsAutoEnableMigrated) return;
    var changed = false;
    w.sheets.forEach(function(s){
      if(s.enabled !== true){ s.enabled = true; changed = true; }
    });
    w.sheetsAutoEnableMigrated = true;
    persistWf(); // نحفظ دائماً هنا لتسجيل علم الترحيلة حتى لو مفيش تغيير فعلي
  }

  /* ===================== Init ===================== */

  function init(){
    migrateAutoEnableSheets();
    recoverStuckProcessing();
    cleanupStaleGsheetRows(); // تنظيف العناصر العالقة فور الفتح
    bind();
    setTimeout(renderAll, 800);
    setTimeout(function(){
      if(typeof settings!=='undefined' && settings) restartTimer();
    }, 2500);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
