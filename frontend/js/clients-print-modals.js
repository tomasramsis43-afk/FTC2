/* ============================================================
   قالب موحّد لمستندات الطباعة (فواتير/سندات/تقارير/كشوف)
   بدل تكرار نفس قواعد CSS يدوياً في كل دالة طباعة على حدة —
   أي تعديل على شكل الطباعة (لون، خط، مسافات) يتم هنا فقط ويظهر في كل المستندات.
   ============================================================ */
const PRINT_PALETTE = { navy:'#374151', gold:'#6B7280', red:'#52525B', text:'#1B1F26', muted:'#6B7280', border:'#E4E6EB', surfaceAlt:'#F7F8FA' };

function printDocStyles({accent = PRINT_PALETTE.navy, borderColor, amountColor, variant = 'full'} = {}){
  const p = PRINT_PALETTE;
  borderColor = borderColor || accent;
  amountColor = amountColor || accent;
  const base = `
    body{font-family:'Tahoma','Arial',sans-serif; color:${p.text}; margin:0; padding:${variant==='table'?'24px':'28px'};}
    .footer-note{margin-top:30px; font-size:11.5px; color:${p.muted}; text-align:center; border-top:1px solid ${p.border}; padding-top:12px;}
    @media print{ .no-print{display:none;} body{padding:10px;} }
    /* ---------- عرض المستند على شاشة جوال (لا يؤثر على الطباعة الفعلية) ----------
       المستند مصمم أصلاً لمقاس ورق A4، فبدون هذا الجزء يظهر مصغّراً جداً أو
       يتطلب تكبيراً يدوياً داخل معاينة الطباعة على الموبايل. */
    @media screen and (max-width:700px){
      body{padding:14px; overflow-x:auto;}
      table{width:max-content; min-width:100%;}
      th, td{white-space:nowrap;}
    }
  `;
  if(variant==='table' || variant==='table-center'){
    const cellAlign = variant==='table-center' ? 'center' : 'right';
    return base + `
    .head{display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid ${borderColor}; padding-bottom:14px; margin-bottom:16px;}
    .head img{width:70px; height:70px; border-radius:50%; object-fit:cover;}
    h2{color:${borderColor}; margin:0 0 4px;}
    .meta{font-size:13px; color:${p.muted}; margin-bottom:18px; display:flex; gap:18px; flex-wrap:wrap;}
    table{width:100%; border-collapse:collapse; font-size:12.5px;}
    th,td{border:1px solid ${p.border}; padding:8px; text-align:${cellAlign};}
    ${cellAlign==='right' ? 'td.mono, td:last-child{text-align:left; font-family:monospace;}' : ''}
    th{background:${p.surfaceAlt}; text-align:${cellAlign==='right'?'right':'center'};}
    `;
  }
  const amountBg = accent===p.red ? '#FBEEEA' : p.surfaceAlt;
  const amountBorder = accent===p.red ? '#E9CFC9' : p.border;
  return base + `
    .inv-head{display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid ${borderColor}; box-shadow:0 3px 0 ${p.gold}; padding-bottom:16px; margin-bottom:20px;}
    .inv-head .logo{width:90px; height:90px; border-radius:50%; object-fit:cover;}
    .inv-head .center-name{font-size:19px; font-weight:bold; color:${p.navy}; margin:0 0 4px;}
    .inv-head .center-meta{font-size:12.5px; color:${p.muted}; line-height:1.7;}
    .inv-title{text-align:left;}
    .inv-title h2{margin:0; color:${accent}; font-size:22px;}
    .inv-title .no{font-family:monospace; font-size:14px; margin-top:4px;}
    .info-grid{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:22px; font-size:13px;}
    .info-box{border:1px solid ${p.border}; border-radius:8px; padding:12px 14px;}
    .info-box h4{margin:0 0 8px; font-size:12.5px; color:${p.muted};}
    .info-row{display:flex; justify-content:space-between; padding:3px 0;}
    table.items{width:100%; border-collapse:collapse; margin-bottom:18px;}
    table.items th{background:${p.surfaceAlt}; text-align:right; padding:9px 12px; font-size:12.5px; color:${p.navy};}
    table.items td{padding:9px 12px; border-bottom:1px solid ${p.border}; font-size:13px;}
    table.items td.num{text-align:left; font-family:monospace;}
    .totals{width:320px; margin-right:auto; margin-left:0; font-size:13.5px;}
    .totals .r{display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid ${p.surfaceAlt};}
    .totals .grand{font-weight:bold; color:${p.navy}; font-size:15px; border-top:2px solid ${p.navy}; margin-top:4px; padding-top:8px;}
    .amount-box{background:${amountBg}; border:1px solid ${amountBorder}; border-radius:8px; padding:16px; text-align:center; margin-bottom:22px;}
    .amount-box .lbl{font-size:12.5px; color:${p.muted}; margin-bottom:6px;}
    .amount-box .amt{font-size:26px; font-weight:bold; color:${amountColor}; font-family:monospace;}
    .sig-grid{display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:50px;}
    .sig-box{text-align:center;}
    .sig-line{border-top:1px solid ${p.text}; margin-top:50px; padding-top:8px; font-size:12.5px;}
    @media screen and (max-width:700px){
      .inv-head{flex-wrap:wrap; gap:14px;}
      .info-grid{grid-template-columns:1fr; gap:10px;}
      .totals{width:100%;}
      table.items{font-size:12px;}
      table.items th, table.items td{padding:7px 8px; font-size:12px;}
      .sig-grid{grid-template-columns:1fr; gap:36px;}
    }
  `;
}
/* رأس مستند HTML كامل جاهز للطباعة (DOCTYPE + head + style) */
function printDocHead(title, {accent, borderColor, amountColor, variant, extraCss = ''} = {}){
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${printDocStyles({accent, borderColor, amountColor, variant})}${extraCss}</style></head>`;
}
/* زر الطباعة/الحفظ الموحّد أسفل كل مستند */
function printDocFooterButton(){
  return `<div class="no-print" style="text-align:center; margin-top:20px;"><button id="doc-print-btn" type="button" style="padding:10px 24px; background:${PRINT_PALETTE.navy}; color:#fff; border:none; border-radius:8px; font-size:14px; cursor:pointer;">طباعة / حفظ PDF</button></div>`;
}

function openPrintTarget(){
  // منع تكرار معرّف الـ overlay عند فتح معاينة قبل إغلاق السابقة (طباعة سريعة لمستندين):
  // يبقى id='print-preview-overlay' فريداً فعلاً في الدوم، وإلا كان getElementById في أماكن أخرى
  // (undo-redo / module-invoices) يلتقط المثيل الأول فقط ويُزيح/يغلق المعاينة الخطأ.
  const prevOverlay = document.getElementById('print-preview-overlay');
  if(prevOverlay) prevOverlay.remove();
  const overlay = document.createElement('div');
  overlay.id = 'print-preview-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,33,.6); z-index:99999; display:flex; flex-direction:column; align-items:center; padding:18px; box-sizing:border-box;';

  const bar = document.createElement('div');
  bar.style.cssText = 'width:100%; max-width:900px; display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;';
  bar.innerHTML = `<span style="color:#fff; font-family:Tahoma,Arial,sans-serif; font-size:13px;">معاينة الطباعة — اضغط زر "طباعة / حفظ PDF" داخل المعاينة</span>`;
  const closeBtn = document.createElement('button');
  if(closeBtn){
    closeBtn.textContent = '✕ إغلاق المعاينة';
    closeBtn.style.cssText = 'padding:8px 16px; background:#fff; color:#1B242E; border:none; border-radius:8px; cursor:pointer; font-family:Tahoma,Arial,sans-serif; font-size:13px;';
    closeBtn.onclick = ()=> overlay && overlay.remove();
    if(bar) bar.appendChild(closeBtn);
  }

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%; max-width:900px; flex:1 1 auto; background:#fff; border:0; border-radius:10px; min-height:0;';

  if(overlay && bar) overlay.appendChild(bar);
  if(overlay && iframe) overlay.appendChild(iframe);
  if(document.body && overlay) document.body.appendChild(overlay);

  const win = iframe ? iframe.contentWindow : null;
  if(win) win.addEventListener('afterprint', ()=>{ setTimeout(()=> overlay && overlay.remove(), 400); });
  return win;
}
// يُستدعى بدل win.document.close() مباشرة في كل دوال الطباعة: يغلق الكتابة للمستند ثم يربط
// زر "طباعة / حفظ PDF" فوراً (document.write متزامن، فالزر موجود فعلياً في الدوم في هذه اللحظة —
// لا داعي لانتظار حدث 'load' الذي قد يكون أُطلق بالفعل على الإطار الفارغ قبل كتابة المحتوى).
function finishPrintDoc(win){
  win.document.close();
  const isElectron = /Electron/.test(navigator.userAgent);
  const btn = win.document.getElementById('doc-print-btn');
  if(btn){
    btn.addEventListener('click', ()=>{
      setTimeout(()=>{
        try{ win.focus(); }catch(e){}
        // في Electron: حاول طباعة الـ iframe أولاً، وإن فشل اطبع النافذة الأم
        // كحل أخير: افتح المستند في تبويب جديد للطباعة (يعمل في كل المتصفحات)
        const tryPrint = ()=>{
          try{
            if(isElectron && win && win.print){
              win.print();
              return true;
            }
            if(win && win.print){
              win.print();
              return true;
            }
          }catch(e){}
          try{ window.print(); return true; }catch(e){}
          return false;
        };
        if(!tryPrint()){
          // fallback: افتح المحتوى في نافذة جديدة
          const html = win.document.documentElement.outerHTML;
          const w = window.open('', '_blank');
          if(w){
            w.document.write(html);
            w.document.close();
            w.focus();
            setTimeout(()=>{ try{ w.print(); }catch(e){} }, 200);
          }
        }
      }, 180);
    });
    // تم إلغاء التفعيل التلقائي لزر الطباعة (كان يضغط الزر تلقائياً بعد نصف ثانية فيفتح
    // نافذة طباعة الويندوز من غير ما يطلب المستخدم ده). دلوقتي المعاينة بس تظهر، والطباعة
    // الفعلية متبقاش تحصل إلا لما المستخدم يدوس زر "طباعة / حفظ PDF" بنفسه.
  }
}

// كل ربط ابتدائي هنا محمي فردياً بـ try/catch: قبل هذا التعديل كان ربط زرّي
// #filter-course/#filter-nat بلا "?." (بخلاف كل الأزرار المجاورة لهما) — فلو تأخر
// وجود العنصر فى الـ DOM لأي سبب (فرق توقيت تحميل بسيط، مثلاً فى نسخة سطح المكتب)
// كان الاستثناء الناتج (TypeError: Cannot read properties of null) يوقف تنفيذ باقي
// السكريبت بالكامل من هذه النقطة فصاعداً — بما فيه كل الروابط اللاحقة فى نفس الملف
// (نموذج حفظ العميل، إلخ)، بينما أزرار الترقيم فوقها كانت تفلت لأنها اتنفذت قبلها.
// الحماية الفردية هنا تمنع فشل ربط واحد من إسقاط أي ربط آخر بعده.
[
  ()=> onSearchInput('#search', renderTable),
  ()=> $('#table-page-size')?.addEventListener('change', ()=>{ tableCurrentPage = 1; renderTable(); }),
  ()=> $('#table-page-first')?.addEventListener('click', ()=>{ tableCurrentPage = 1; renderTable(); }),
  ()=> $('#table-page-prev')?.addEventListener('click', ()=>{ tableCurrentPage = Math.max(1, tableCurrentPage-1); renderTable(); }),
  ()=> $('#table-page-next')?.addEventListener('click', ()=>{ tableCurrentPage = tableCurrentPage+1; renderTable(); }),
  ()=> $('#table-page-last')?.addEventListener('click', ()=>{ tableCurrentPage = Infinity; renderTable(); }),
  ()=> $('#filter-course')?.addEventListener('change', renderTable),
  ()=> $('#filter-nat')?.addEventListener('change', renderTable),
  ()=> $('#filter-reception')?.addEventListener('change', renderTable),
].forEach(fn=>{ try{ fn(); }catch(e){ console.error('فشل فى ربط عنصر تحكم فى شيت العملاء عند التحميل:', e); } });
$('#filter-status')?.addEventListener('change', renderTable);
$('#btn-filter-suspended')?.addEventListener('click', ()=>{
  showSuspendedOnly = !showSuspendedOnly;
  $('#btn-filter-suspended').classList.toggle('btn-gold', showSuspendedOnly);
  $('#btn-filter-suspended').classList.toggle('btn-ghost', !showSuspendedOnly);
  renderTable();
});
$('#btn-filter-unpurchased-bags')?.addEventListener('click', ()=>{
  showUnpurchasedBagsOnly = !showUnpurchasedBagsOnly;
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-gold', showUnpurchasedBagsOnly);
  $('#btn-filter-unpurchased-bags').classList.toggle('btn-ghost', !showUnpurchasedBagsOnly);
  renderTable();
});
$('#filter-company')?.addEventListener('change', renderTable);
$('#filter-invoice')?.addEventListener('change', renderTable);
$('#filter-coursenum')?.addEventListener('change', renderTable);
$('#filter-refnum')?.addEventListener('change', renderTable);
$('#filter-bag-source')?.addEventListener('change', renderTable);
// حقول تاريخ/مبالغ الفلترة تعيد بناء جدول العملاء كاملاً (ويمسح آلاف العملاء) — نأخّر حتى
// اكتمال الكتابة بدل كل حرف، مع بقاء التحديث النهائي فورياً عند الانتهاء من الكتابة.
const _debouncedClDateFilter = debounce(renderTable);
$('#cl-date-from')?.addEventListener('input', _debouncedClDateFilter);
$('#cl-date-to')?.addEventListener('input', _debouncedClDateFilter);
$('#cl-paid-min')?.addEventListener('input', _debouncedClDateFilter);
$('#cl-paid-max')?.addEventListener('input', _debouncedClDateFilter);

/* ---------------- طي/توسيع الفلاتر المتقدمة (جدول العملاء) ----------------
   الحقول نفسها (filter-course، filter-nat...) لم تتغيّر مكانها في الـ DOM ولا
   معالجات renderTable المرتبطة بها أعلاه — فقط نُخفي/نُظهر الحاوية الأم، ونضيف
   عدّاداً صغيراً يوضّح كم فلتراً متقدماً مفعّلاً حالياً حتى لو كانت القائمة مطوية. */
const ADVANCED_FILTER_IDS = ['filter-course','filter-nat','filter-company','filter-invoice','filter-coursenum','filter-refnum','filter-bag-source','filter-reception','cl-date-from','cl-date-to','cl-paid-min','cl-paid-max'];
function updateAdvancedFiltersBadge(){
  const badge = $('#advanced-filters-count');
  if(!badge) return;
  const activeCount = ADVANCED_FILTER_IDS.filter(id=>{ const el=document.getElementById(id); return el && el.value; }).length;
  badge.textContent = activeCount;
  badge.style.display = activeCount ? '' : 'none';
}
$('#btn-toggle-advanced-filters')?.addEventListener('click', ()=>{
  const panel = $('#advanced-filters-panel');
  const btn = $('#btn-toggle-advanced-filters');
  if(!panel || !btn) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  btn.setAttribute('aria-expanded', String(!isOpen));
});
$('#btn-clear-advanced-filters')?.addEventListener('click', ()=>{
  ADVANCED_FILTER_IDS.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    if(el.tagName === 'SELECT'){
      // إلغاء تحديد كل الخيارات (يعادل "الكل") بدل selectedIndex=0، لأن خيارات مثل
      // "بدون جنسية"/"بدون نوع دورة" تُضاف ديناميكياً في أول القائمة (afterbegin) فتصبح
      // هي index 0 فعلياً وقت التشغيل، فكانت "مسح الفلاتر" تحدّدها هي بدل "الكل"
      Array.from(el.options).forEach(o=> o.selected = false);
      refreshMultiSelectFilterUI(el);
    } else el.value = '';
  });
  // نفس دقة زر "مسح كل الفلاتر" العام: البقية لم تكن تُمسح في أيامها (بحث، حالة، موظف
  // استقبال، تبديل الموقوفين/الحقائب غير المشتراة، وفلتر السنة العلوي) فيظل الجدول مفلتراً
  // جزئياً رغم الضغط على "مسح"، فيُحسب أن الزر معطل. filter-reception أصبح جزءاً من
  // ADVANCED_FILTER_IDS أعلاه (كان داخل نفس اللوحة المطوية لكن غير محسوب فى عدّاد "فلاتر
  // متقدمة" — فيبقى مفعَّلاً بصمت والعدّاد يقول 0)، فمسحه أصبح ضمن اللوب الرئيسي تلقائياً.
  // filter-status يبقى هنا لوحده لأنه خارج اللوحة المطوية أصلاً (ظاهر دائماً فى الشريط الرئيسي).
  const searchEl = document.getElementById('search'); if(searchEl) searchEl.value = '';
  { const el = document.getElementById('filter-status');
    if(el){ Array.from(el.options).forEach(o=> o.selected = false); refreshMultiSelectFilterUI(el); } }
  showSuspendedOnly = false;
  $('#btn-filter-suspended')?.classList.remove('btn-gold');
  $('#btn-filter-suspended')?.classList.add('btn-ghost');
  showUnpurchasedBagsOnly = false;
  $('#btn-filter-unpurchased-bags')?.classList.remove('btn-gold');
  $('#btn-filter-unpurchased-bags')?.classList.add('btn-ghost');
  // ملاحظة: فلتر السنة العلوي (selectedYearFilter، بجانب زر تسجيل الخروج) مقصود عدم لمسه هنا —
  // كان مسح الفلاتر المتقدمة يعيده إلى "all" ويستدعي applyYearFilterToAllViews التي تعيد رسم كل
  // شيتات البرنامج (الداشبورد، الخزنة، الدورات...) لا شيت العملاء فقط. الزر الآن يقتصر أثره على
  // شيت العملاء وحده كما هو مقصود منه؛ حقلا cl-date-from/cl-date-to أعلاه يُمسحان محلياً فقط
  // (ضمن ADVANCED_FILTER_IDS) دون المساس بفلتر السنة نفسه أو بأي شيت آخر.
  updateAdvancedFiltersBadge();
  renderTable();
});
ADVANCED_FILTER_IDS.forEach(id=>{
  const el = document.getElementById(id);
  if(el) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', updateAdvancedFiltersBadge);
});
updateAdvancedFiltersBadge();
 
   // --- Invoice number click handling انتقل إلى receipts-auto-sync.js ---
   // (نقر رقم الفاتورة يفتح نافذة العرض/الطباعة مباشرة عبر مستمع واحد في طور الالتقاط)
  document.addEventListener('click', async e=>{
  const editId = e.target.dataset.edit;
  const delId = e.target.dataset.del;
  const invId = e.target.dataset.invoice;
  const suspendId = e.target.dataset.suspend;
  const unsuspendId = e.target.dataset.unsuspend;
  const cancelBagId = e.target.dataset.cancelbag;
  const delInvoiceId = e.target.dataset.delinvoice;
  const approveId = e.target.dataset.approve;
  const rejectId = e.target.dataset.reject;
  if(approveId){
    const c = clients.find(x=>x.id===approveId);
    if(await customConfirm(`تأكيد اعتماد العميل "${c?.name||''}"؟ سيدخل فوراً هو وكل ما يرتبط به من حركات مالية/حقائب معلّقة في الحسابات والداشبورد والتقارير كباقي العملاء (اعتماد تسلسلي واحد).`)){
      // نجلب أحدث قائمة السجلات المعلّقة أولاً لضمان اكتشاف كل الحركات المرتبطة بهذا العميل
      // (حركة الخزنة التلقائية autoClientId، وتسليم الحقيبة issuedClientId) قبل اعتمادها معه.
      if(typeof refreshPendingApprovals==='function') await refreshPendingApprovals();
      const ok = await approveClientRecord(approveId);
      if(ok){
        // بعد اعتماد الأدمن للعميل تُنشأ حركات الخزنة التلقائية (auto_/auto2_) من الصفر —
        // لم تكن موجودة قبل الاعتماد (syncClientLedgerEntry يمنع إنشاءها لسجل معلّق).
        // أي قيود قديمة معلّقة لعملاء قدامى (سجّلها الاستقبال بنظام ما قبل هذا التعديل) تُحذف
        // نهائياً هنا ولا تُعتمد إطلاقاً (رفض القيود القديمة)، ثم يُعاد إنشاؤها كقيود معتمدة
        // جديدة — لأن السيرفر لا يغيّر origin/status عند تعديل سجل موجود (PUT upsert)، فالحذف
        // ثم الإضافة هو الطريقة الوحيدة لتصبح القيود معتمدة فعلياً بمعرّفاتها نفسها.
        const c = clients.find(x=>x.id===approveId);
        if(c && typeof syncClientLedgerEntry==='function'){
          // نَجمع معرّفات القيود القديمة من المصفوفة المحلية (vaultTx) ومن قائمة المعلّقات
          // المحدثة (pendingApprovals — سجلات السيرفر الفعلية حتى لو لم تكن محمّلة محلياً)،
          // ونحذفها كلها من السيرفر بدل اعتمادها — ثم يُعاد إنشاؤها معتمدة من الصفر أدناه.
          const legacyIds = new Set();
          vaultTx.forEach(t=>{ if(t.autoClientId===approveId) legacyIds.add(t.id); });
          (typeof pendingApprovals==='object' && Array.isArray(pendingApprovals) ? pendingApprovals : []).forEach(p=>{
            if(p.collection==='vaultTx' && p.obj && p.obj.autoClientId===approveId) legacyIds.add(p.id);
          });
          for(const legacyId of legacyIds){ if(typeof deleteOneRecordGeneric==='function') await deleteOneRecordGeneric('vaultTx', legacyId); }
          syncClientLedgerEntry(c);
          await saveVaultTx();
        }
        // بعد إعادة إنشاء القيود (القديمة حُذفت واستُبدلت بمعتمدة جديدة) نُحدّث قائمة المعلّقات
        // حتى لا يحاول الاعتماد التسلسلي أدناه اعتماد قيود أُزيلت/استُبدلت للتو (فشل وهمي).
        if(typeof refreshPendingApprovals==='function') await refreshPendingApprovals();
        const cascade = (typeof cascadeLinkedPendingRecords==='function') ? await cascadeLinkedPendingRecords(approveId, true) : {count:0, ok:0, fail:0};
        await logAudit('edit','العملاء', `تم اعتماد تسجيل الاستقبال للعميل "${c?.name||approveId}"${cascade.count ? ` مع ${cascade.ok} عملية مرتبطة (حركات مالية/حقائب)${cascade.fail ? ` — تعذّر اعتماد ${cascade.fail}` : ''}` : ''}`);
        refreshEverything();
        if(typeof refreshPendingApprovals==='function') refreshPendingApprovals();
        invoiceShowToast(cascade.count ? `✅ تم اعتماد العميل مع ${cascade.ok} عملية مرتبطة` : '✅ تم اعتماد العميل');
      }else{
        invoiceShowToast('تعذّر الاعتماد — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(rejectId){
    const c = clients.find(x=>x.id===rejectId);
    if(await customConfirm(`تأكيد رفض تسجيل "${c?.name||''}"؟ سيختفي من عندك وتُحذف كل الحركات المالية/الحقائب المعلّقة المرتبطة به نهائياً، لكنه يبقى ظاهراً لموظف الاستقبال الذي سجّله لمدة 15 يوماً قبل حذفه نهائياً (رفض تسلسلي واحد).`)){
      if(typeof refreshPendingApprovals==='function') await refreshPendingApprovals();
      const ok = await rejectClientRecordSoft(rejectId);
      if(ok===true){
        clients = clients.filter(x=>x.id!==rejectId);
        const cascade = (typeof cascadeLinkedPendingRecords==='function') ? await cascadeLinkedPendingRecords(rejectId, false) : {count:0, ok:0, fail:0};
        await logAudit('delete','العملاء', `تم رفض تسجيل الاستقبال المعلّق للعميل "${c?.name||rejectId}" (يبقى ظاهراً للاستقبال 15 يوماً)${cascade.count ? ` مع ${cascade.ok} عملية مرتبطة (حركات مالية/حقائب)${cascade.fail ? ` — تعذّر حذف ${cascade.fail}` : ''}` : ''}`);
        refreshEverything();
        if(typeof refreshPendingApprovals==='function') refreshPendingApprovals();
        invoiceShowToast(cascade.count ? `تم رفض التسجيل مع ${cascade.ok} عملية مرتبطة` : 'تم رفض التسجيل');
      }else{
        invoiceShowToast('تعذّر الرفض — تحقق من الاتصال وحاول مجدداً');
      }
    }
    return;
  }
  if(invId){
    const invMeta = (typeof clientRecordMeta==='object' && clientRecordMeta) ? clientRecordMeta[invId] : null;
    // الاستقبال مسموح له تحديداً بطباعة الفاتورة حتى قبل اعتماد الأدمن لتسجيل العميل (بناءً على طلب
    // صريح) — باقي الأدوار (أدمن/محاسب/موظف عام) تبقى ممنوعة حتى الاعتماد كما كانت دائماً.
    if(invMeta && invMeta.status==='pending' && currentUserRole!=='reception'){
      invoiceShowToast('⏳ لا يمكن إصدار فاتورة ضريبية رسمية لهذا العميل قبل اعتماد الأدمن لتسجيله');
      return;
    }
    await printInvoice(invId); return;
  }
  if(delInvoiceId){
    const c = clients.find(x=>x.id===delInvoiceId);
    if(!canDeleteClientRecord(c)){ invoiceShowToast('غير مسموح لصلاحيتك بحذف بيانات هذا العميل الآن (خارج المهلة المسموح بها أو الحذف معطَّل)'); return; }
    if(!c || !c.taxInvoiceNo){ invoiceShowToast('لا توجد فاتورة صادرة لهذا العميل'); return; }
    const invLabel = formatInvoiceNo(c.taxInvoiceNo);
    const reason = await customPrompt(`توثيقاً للمعايير المحاسبية، لا يمكن حذف رقم الفاتورة التسلسلي (${invLabel}) نهائياً أو إعادة استخدامه — سيتم حذف الفاتورة من سجل العميل "${c.name}" فقط مع الاحتفاظ بالرقم والسبب في سجل الفواتير المحذوفة. عند طباعة فاتورة جديدة لهذا العميل لاحقاً سيُمنح رقماً تسلسلياً جديداً.\nيرجى كتابة سبب الحذف (إلزامي):`, {title:'سبب حذف الفاتورة', required:true, placeholder:'اكتب سبب الحذف هنا...'});
    if(reason===null) return;
    if(!reason.trim()){ invoiceShowToast('سبب الحذف إلزامي — لم يتم الحذف'); return; }
    snapshotState(`حذف فاتورة العميل: ${c.name} (${invLabel})`);
    const removed = softDeleteClientInvoice(c.id, reason.trim());
    if(removed){
      await saveClients();
      await saveDeletedInvoices();
      await logAudit('delete','العملاء', `تم حذف الفاتورة رقم ${removed.invoiceNoLabel} للعميل "${removed.clientName}" — السبب: ${removed.deletedReason}`);
      refreshEverything();
      invoiceShowToast(`تم حذف الفاتورة ${removed.invoiceNoLabel}`);
    }
    return;
  }
  if(editId){
    const targetClient = clients.find(x=>x.id===editId);
    if(!canReceptionEditClient(targetClient)){
      invoiceShowToast('⏱️ انتهت مهلة تعديل هذا العميل (5 ساعات من وقت تسجيله) — يمكن للأدمن فقط تعديله الآن');
    }else{
      openModal(editId);
    }
  }
  if(cancelBagId){
    const c = clients.find(x=>x.id===cancelBagId);
    if(c && await customConfirm(`تأكيد إلغاء الحقيبة المسجّلة لـ"${c.name}"؟ ستُحذف تماماً من سجل شراء الحقائب المكتملة (إن وُجدت) ومن سجل "اشتروا حقيبتهم الخاصة" (إن كانت كذلك)، ويُمسح رقم الفاتورة وتاريخ الشراء، وتعود حالته إلى "مطلوب شراء" — وإن كانت من المخزون تُعاد تلقائياً لرصيد التمويل.`)){
      snapshotState(`إلغاء حقيبة عميل: ${c.name}`);
      resetClientBagToPending(c);
      await saveClients(); await saveVaultTx(); await saveBagStock(); await saveSettings();
      await logAudit('edit','مخزون الحقائب', `تم إلغاء حقيبة العميل ${c.name} — عادت حالته إلى "مطلوب شراء"`);
      refreshEverything();
      invoiceShowToast('تم إلغاء الحقيبة');
    }
  }
  if(suspendId){
    const c = clients.find(x=>x.id===suspendId);
    if(c && await customConfirm(`تأكيد إيقاف "${c.name}"؟ سيبقى ظاهراً في شيت العملاء، لكن سيختفي من شيت الدورات ومخزون الحقائب حتى تُلغي الإيقاف عنه.`)){
      snapshotState(`إيقاف عميل: ${c.name}`);
      c.suspended = true;
      await saveClients();
      await logAudit('edit','العملاء', `تم إيقاف العميل ${c.name} — أصبح مخفياً من شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      invoiceShowToast('تم إيقاف العميل');
    }
  }
  if(unsuspendId){
    const c = clients.find(x=>x.id===unsuspendId);
    if(c){
      snapshotState(`إلغاء إيقاف عميل: ${c.name}`);
      c.suspended = false;
      await saveClients();
      await logAudit('edit','العملاء', `تم إلغاء إيقاف العميل ${c.name} — عاد للظهور في شيت الدورات ومخزون الحقائب`);
      refreshEverything();
      invoiceShowToast('تم إلغاء الإيقاف');
    }
  }
  if(delId){
    if(!canDeleteClientRecord(clients.find(c=>c.id===delId))){ invoiceShowToast('غير مسموح لصلاحيتك بحذف هذا العميل الآن (خارج المهلة المسموح بها أو الحذف معطَّل)'); return; }
    if(await customConfirm('تأكيد حذف هذا السجل؟ سيُحذف أيضاً أي ترحيل مالي مرتبط به.')){
      const removedClient = clients.find(c=>c.id===delId);
      snapshotState(`حذف عميل: ${removedClient?.name || delId}`);
      clients = clients.filter(c=>c.id!==delId);
      removeClientLedgerEntries(delId);
      // عرض فوري (نفس مبدأ الإضافة أعلاه): العميل اتشال بالفعل من المصفوفة المحلية، فنحدّث
      // الشاشة على طول بدل انتظار رفع الحذف للسيرفر + حفظ الخزنة + سجل التدقيق.
      renderTable(); renderDashboard(); renderBags();
      invoiceShowToast('تم حذف السجل');
      (async ()=>{
        await saveClients(); await saveVaultTx();
        await logAudit('delete','العملاء', `تم حذف بيانات العميل: ${removedClient?.name || delId}`);
        // تم تعطيل إيميل "حذف عميل" بناءً على طلب صريح — يبقى الإيميل فقط على إضافة عميل
        // جديد + الحركات المالية + التقارير. لم يُحذف الكود، فقط عُطِّل.
        // notifyAdminAlert(
        //   `تم حذف عميل: ${removedClient?.name || delId}`,
        //   `<p>تم حذف بيانات العميل <b>${escapeHtml(removedClient?.name || delId)}</b> بواسطة <b>${escapeHtml(currentUser || 'غير معروف')}</b>.</p>`
        // );
        renderTable(); renderDashboard(); renderBags();
      })().catch(e=>console.error('فشل فى إكمال حذف العميل فى الخلفية:', e));
    }
  }
});

/* ---------------- قائمة إجراءات الصف (⋮) في أي جدول (عملاء / حركات مالية...) ----------------
   القائمة الفعلية المعروضة للمستخدم ليست القائمة المدمجة داخل صف الجدول (تلك تبقى مخفية
   دائماً وتُستخدم فقط كـ"قالب" نسخ منه)، بل عنصر واحد مشترك (#global-row-menu-panel) يُضاف
   مباشرة إلى نهاية <body> (portal) عند كل فتح. هذا يضمن ظهورها دائماً فوق كل نصوص/خطوط/صفوف
   الجدول ولا تُغطّى بها أبداً، لأنها فعلياً لم تعد جزءاً من شجرة DOM الخاصة بالجدول (ولا من أي
   Stacking Context أو منطقة overflow داخله) وقت ظهورها — بدل الاعتماد فقط على z-index/position:fixed
   داخل مكانها الأصلي وسط صفوف الجدول.
   نستمر في حساب الموضع عبر JS (getBoundingClientRect) بدل الاعتماد على مكانها الأصلي، لأن
   الجدول داخل .table-scroll (overflow:auto) وأي قائمة عادية كانت ستُقطَع عند حواف منطقة التمرير. */
let openRowMenuPanel = null;
let openRowMenuToggle = null;
function getGlobalRowMenuPanel(){
  let el = document.getElementById('global-row-menu-panel');
  if(!el){
    el = document.createElement('div');
    el.id = 'global-row-menu-panel';
    el.className = 'row-menu-panel';
    el.setAttribute('role','menu');
    document.body.appendChild(el);
  }
  return el;
}
function closeRowMenu(){
  if(openRowMenuPanel){
    openRowMenuPanel.classList.remove('show');
    openRowMenuPanel.innerHTML = '';
    if(openRowMenuToggle) openRowMenuToggle.setAttribute('aria-expanded','false');
    openRowMenuPanel = null;
    openRowMenuToggle = null;
  }
}
document.addEventListener('click', e=>{
  const toggle = e.target.closest('.row-menu-toggle');
  if(!toggle) return;
  e.stopPropagation();
  const sourcePanel = toggle.nextElementSibling; // القالب المخفي الخاص بهذا الصف تحديداً
  if(!sourcePanel || !sourcePanel.classList.contains('row-menu-panel')) return;
  if(openRowMenuToggle === toggle){ closeRowMenu(); return; }
  closeRowMenu();
  const panel = getGlobalRowMenuPanel();
  panel.innerHTML = sourcePanel.innerHTML; // ننسخ أزرار هذا الصف (وبياناتها data-edit/data-del...) لحظياً
  const r = toggle.getBoundingClientRect();
  // نقيس أبعاد القائمة الحقيقية أولاً وهي مخفية (visibility:hidden لا تؤثر على القياس
  // خلافاً لـ display:none)، بدل تقدير المكان ثم تصحيحه بعد الظهور — كان هذا يسبب
  // ظهور القائمة متراكبة فوق صف خاطئ أو مقطوعة الأزرار في الصفوف القريبة من أعلى الجدول.
  panel.style.visibility = 'hidden';
  panel.style.top = '0px';
  panel.style.left = '0px';
  panel.classList.add('show');
  const pw = panel.offsetWidth || 180;
  const ph = panel.offsetHeight || 160;
  const spaceBelow = window.innerHeight - r.bottom;
  const spaceAbove = r.top;
  const openUp = spaceBelow < (ph + 12) && spaceAbove > spaceBelow;
  const top = openUp
    ? Math.max(8, r.top - ph - 4)
    : Math.min(r.bottom + 4, window.innerHeight - ph - 8);
  // نُحاصر القائمة أفقياً داخل حدود صندوق الجدول نفسه (.panel/.table-scroll) وليس عرض
  // النافذة كله — كانت القائمة أحياناً تمتد لليسار خارج حدود الصندوق (فوق الخلفية/الشريط
  // الجانبي) لأن الحساب كان يعتمد على window.innerWidth فقط، بغض النظر عن عرض الجدول الفعلي.
  const container = toggle.closest('.panel') || toggle.closest('.table-scroll');
  const cRect = container ? container.getBoundingClientRect() : null;
  const minLeft = cRect ? cRect.left + 6 : 8;
  const maxLeft = cRect ? Math.max(minLeft, cRect.right - pw - 6) : window.innerWidth - pw - 8;
  const left = Math.max(minLeft, Math.min(r.right - pw, maxLeft));
  panel.style.top = Math.max(8, top) + 'px';
  panel.style.left = left + 'px';
  panel.style.visibility = '';
  toggle.setAttribute('aria-expanded','true');
  openRowMenuPanel = panel;
  openRowMenuToggle = toggle;
});
// إغلاق القائمة المفتوحة عند اختيار أي إجراء من داخلها، أو عند أي نقر خارجها،
// أو عند التمرير/تصغير النافذة/الضغط على Esc.
document.addEventListener('click', e=>{
  if(!openRowMenuPanel) return;
  if(e.target.closest('.row-menu-toggle')) return;
  const insidePanel = e.target.closest('#global-row-menu-panel');
  if(insidePanel){
    // القائمة نفسها لم تعد تُزال تلقائياً بإعادة رسم الجدول (لأنها الآن خارج شجرته)،
    // لذا نُغلقها يدوياً بعد تنفيذ أي زر إجراء بداخلها ليطابق السلوك السابق.
    if(e.target.closest('button')) setTimeout(closeRowMenu, 0);
    return;
  }
  closeRowMenu();
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeRowMenu(); });
window.addEventListener('scroll', closeRowMenu, true);
window.addEventListener('resize', closeRowMenu);

/* ---------------- Modal / form ---------------- */
function openModal(id){
  editingId = id || null;
  $('#modal-title').textContent = id ? 'تعديل بيانات عميل' : 'إضافة عميل جديد';
  populateSelect($('#f-nat'), settings.nationalities, true);
  populateSelect($('#f-course'), settings.courses.map(c=>c.name), true);
  populateSelect($('#f-channel'), settings.channels.map(c=>c.name), true);

  const c = id ? clients.find(x=>x.id===id) : null;
  $('#f-name').value = c?.name || '';
  $('#f-id').value = c?.clientId || '';
  $('#f-phone').value = c?.phone || '';
  $('#f-email').value = c?.email || '';
  $('#f-nat').value = c?.nationality || '';
  $('#f-clienttype').value = c?.clientType || 'center';
  populateClientCompanySelect(c?.companyName || '');
  $('#f-ajal').value = c?.creditDays ?? '';
  $('#f-clienttax').value = c?.clientTaxNumber || '';
  $('#f-course').value = c?.courseType || '';
  $('#f-coursenum').value = c?.courseNumber || '';
  updateClientCourseStatus();
  $('#f-refer').value = c?.referNum || '';
  $('#f-invoice').value = c?.invoice || '';
  $('#f-baginvoice').value = c?.bagInvoice || '';
  $('#f-date').value = c?.date || todayISO();
  $('#f-courseprice').value = c?.coursePrice ?? '';
  $('#f-bagsource').value = c?.bagSource || 'buy';
  $('#f-bagowndate').value = c?.bagOwnDate || c?.bagPurchaseDate || '';
  // مستخدم الاستقبال ممنوع من شراء/تسليم أي حقيبة: نعطّل خيار "تسليم من المخزون المتوفر"
  // (وهو ما يُعتبر شراء/صرف فوري لحقيبة من المخزون) ونجبر مصدر الحقيبة على "مطلوب الشراء"
  // إن كان محدَّداً على "من المخزون" — يبقى بإمكانه فقط اختيار "مطلوب الشراء" أو "حقيبة العميل الخاصة".
  const bagStockOpt = $('#f-bagsource').querySelector('option[value="stock"]');
  if(bagStockOpt) bagStockOpt.disabled = (currentUserRole === 'reception');
  if(currentUserRole === 'reception' && $('#f-bagsource').value === 'stock'){
    $('#f-bagsource').value = 'buy';
  }
  $('#f-bagprice').value = c ? (c.bagPrice ?? '') : settings.bagPrice;
  // الخصم المحفوظ على العميل قد يشمل خصم عرض أو أكثر. نفصل الجزء اليدوي في حقل «خصم إضافي»
  // ونعرض العروض المحفوظة على العميل كخيارات محددة مسبقاً حتى لا يُحسب أي جزء مرتين.
  const _storedOffers = typeof appliedOffersOf === 'function' ? appliedOffersOf(c) : [];
  const _storedOffer = _storedOffers.reduce((s,o)=> s + num(o.amount), 0);
  const _storedTotalDiscount = c ? Math.max(0, num(c.discount)) : 0;
  const _manualDiscount = typeof splitClientDiscount === 'function'
    ? splitClientDiscount(_storedTotalDiscount, _storedOffer).manual
    : Math.max(0, Math.round((_storedTotalDiscount - _storedOffer) * 100) / 100);
  $('#f-discount').value = _manualDiscount;
  if(typeof renderClientOfferChoices === 'function') renderClientOfferChoices(c);
  $('#f-paid').value = c?.paid ?? 0;
  if(c){
    const grandTotal = paidTotal(c);
    $('#f-paid-total-hint').textContent = `إجمالي المدفوع فعلياً لهذا العميل (شامل أي دفعات لاحقة سُجّلت في الحركات المالية): ${fmt(grandTotal)} ﷼`;
  }else{
    $('#f-paid-total-hint').textContent = 'لتسجيل دفعة إضافية لعميل مسجّل مسبقاً، احفظ العميل أولاً ثم استخدم "+ إضافة دفعة جديدة" أسفل هذا النموذج بدلاً من تعديل هذا الحقل، حتى يبقى سجل كل دفعة بتاريخها.';
  }
  $('#f-channel').value = c?.channel || '';
  $('#f-netinvoice').value = c?.networkInvoice || '';
  populateSelect($('#f-channel2'), settings.channels.map(c=>c.name), true);
  $('#f-split-payment').checked = !!(c && num(c.paid2)>0);
  $('#f-paid2').value = c?.paid2 ?? 0;
  $('#f-channel2').value = c?.channel2 || '';
  $('#f-netinvoice2').value = c?.networkInvoice2 || '';
  toggleSplitPayment();
  $('#f-stage').value = c?.stage || 'جديد';
  $('#f-cancelled').checked = !!c?.cancelled;
  $('#f-notes').value = c?.notes || '';
  toggleBagFields();
  toggleClientNetInvoice();
  toggleClientTypeFields();
  updateComputed();
  editingPaymentTxId = null;
  addingClientPayment = false;
  renderClientPaymentsPanel();
  renderClientTimeline();
  checkClientDuplicate();
  $('#overlay').classList.add('show'); SoundFX.open();
  $('#f-name').focus();
}
/* تنبيه فوري (غير مانع) عند تطابق رقم الهوية أو الجوال مع عميل موجود مسبقاً،
   لمنع تسجيل نفس المتدرب مرتين بالخطأ. لا يمنع الحفظ — فقط يُنبّه الموظف
   ليتحقق يدوياً (قد يكون تسجيل مشروع لدورة ثانية بنفس الهوية). */
function checkClientDuplicate(){
  const box = $('#client-duplicate-warning');
  if(!box) return;
  const idVal = $('#f-id').value.trim();
  const phoneVal = $('#f-phone').value.trim();
  const dupId = idVal && clients.find(c => c.clientId === idVal && c.id !== editingId);
  const dupPhone = phoneVal && clients.find(c => c.phone === phoneVal && c.id !== editingId);
  if(dupId || dupPhone){
    const parts = [];
    if(dupId) parts.push(`رقم الهوية (${escapeHtml(idVal)}) مسجّل مسبقاً باسم "${escapeHtml(dupId.name || '')}"`);
    if(dupPhone && dupPhone !== dupId) parts.push(`رقم الجوال (${escapeHtml(phoneVal)}) مسجّل مسبقاً باسم "${escapeHtml(dupPhone.name || '')}"`);
    box.innerHTML = `<strong>تنبيه ازدواجية:</strong> ${parts.join('، ')}. تحقق قبل الحفظ.`;
    box.style.display = '';
  }else{
    box.style.display = 'none';
  }
}
$('#f-id')?.addEventListener('input', checkClientDuplicate);
$('#f-phone')?.addEventListener('input', checkClientDuplicate);
function toggleClientTypeFields(){
  const isCompany = $('#f-clienttype').value === 'company';
  $('#wrap-f-company').style.display = isCompany ? '' : 'none';
  $('#wrap-f-ajal').style.display = isCompany ? '' : 'none';
  $('#wrap-f-company-hint').style.display = 'none';
  if(!isCompany) $('#f-ajal').value = '';
  else updateCompanyHint();
}
$('#f-clienttype')?.addEventListener('change', toggleClientTypeFields);
function populateClientCompanySelect(selectedValue){
  const sel = $('#f-company');
  const names = companies.map(c=>c.name);
  let optionsHtml = '<option value="">— اختر الشركة —</option>';
  // إن كان العميل مرتبطاً باسم شركة قديم لا يطابق أي شركة في القائمة الرئيسية (تهجئة مختلفة)، أضفه كخيار مميز حتى لا يُفقَد أو يُستبدل بصمت
  if(selectedValue && !names.includes(selectedValue)){
    optionsHtml += `<option value="${escapeHtml(selectedValue)}">${escapeHtml(selectedValue)} (غير مطابق لقائمة الشركات — يرجى المراجعة)</option>`;
  }
  optionsHtml += names.map(n=>`<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.innerHTML = optionsHtml;
  sel.value = selectedValue || '';
}
function updateCompanyHint(){
  const name = $('#f-company').value.trim();
  const c = companies.find(x=>x.name===name);
  if(c && c.categories && c.categories.length){
    $('#f-company-hint').textContent = `مبالغ هذه الشركة حسب الفئة: ${companyCategoriesSummaryText(c.categories)} — حدّد فئة هذا المتدرب يدوياً وعدّل الخصم بما يوافقها.`;
    $('#wrap-f-company-hint').style.display = '';
  }else if(c && num(c.agreedAmount)>0){
    $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(num(c.agreedAmount))} ﷼`;
    $('#wrap-f-company-hint').style.display = '';
    applyCompanyAgreedPricing(c);
  }else{
    $('#wrap-f-company-hint').style.display = 'none';
  }
}
/* عند اختيار شركة لها "مبلغ متفق عليه" ثابت لكل متدرب (بدون فئات)، يُحسَب الخصم تلقائياً
   بحيث يصبح "دخل المركز الصافي" (سعر الدورة - الخصم) مساوياً لهذا المبلغ المتفق عليه —
   فقط عند إضافة عميل جديد، حتى لا يُعاد حساب/الكتابة فوق خصم عميل محفوظ مسبقاً بالفعل. */
function applyCompanyAgreedPricing(company){
  if(editingId) return; // لا نُعدّل بيانات عميل محفوظ مسبقاً تلقائياً
  const price = num($('#f-courseprice').value);
  const agreed = num(company.agreedAmount);
  if(price<=0) return;
  // إن كانت علامة عرض الخصم مفعّلة، يُحسب الجزء اليدوي بعد استبعاد قيمة العرض حتى يبقى
  // صافي دخل المركز مساوياً للمبلغ المتفق عليه تماماً (بدل خصم مزدوج).
  const offerAmt = typeof currentOfferAmount === 'function' ? currentOfferAmount(price) : 0;
  const neededDiscount = Math.max(0, Math.round((price - agreed - offerAmt)*100)/100);
  $('#f-discount').value = neededDiscount;
  $('#f-company-hint').textContent = `المبلغ المتفق عليه لهذه الشركة (لكل متدرب بعد الخصم): ${fmt(agreed)} ﷼ — تم تعبئة الخصم تلقائياً (${fmt(neededDiscount)} ﷼${offerAmt>0 ? ` + عرض ${fmt(offerAmt)} ﷼` : ''}) بحيث يصبح دخل المركز الصافي مساوياً لهذا المبلغ. يمكنك تعديل الخصم يدوياً إذا لزم الأمر.`;
  updateComputed();
}
$('#f-company')?.addEventListener('change', updateCompanyHint);
function toggleClientNetInvoice(){
  const chan = settings.channels.find(c=>c.name===$('#f-channel').value);
  $('#wrap-f-netinvoice').style.display = (chan && (chan.dest==='network'||chan.dest==='network2')) ? '' : 'none';
}
$('#f-channel')?.addEventListener('change', toggleClientNetInvoice);
function toggleSplitPayment(){
  const on = $('#f-split-payment').checked;
  $('#wrap-f-paid2').style.display = on ? '' : 'none';
  $('#wrap-f-channel2').style.display = on ? '' : 'none';
  toggleClientNetInvoice2();
  updateComputed();
}
function toggleClientNetInvoice2(){
  const on = $('#f-split-payment').checked;
  const chan2 = settings.channels.find(c=>c.name===$('#f-channel2').value);
  $('#wrap-f-netinvoice2').style.display = (on && chan2 && (chan2.dest==='network'||chan2.dest==='network2')) ? '' : 'none';
}
$('#f-split-payment')?.addEventListener('change', toggleSplitPayment);
$('#f-channel2')?.addEventListener('change', toggleClientNetInvoice2);
$('#f-paid2')?.addEventListener('input', updateComputed);
function toggleBagFields(){
  const isOwn = $('#f-bagsource').value === 'own';
  $('#wrap-bagprice').style.display = isOwn ? 'none' : '';
  $('#wrap-baginvoice').style.display = '';
  $('#wrap-bagowndate').style.display = isOwn ? '' : 'none';
  if(isOwn) $('#f-bagprice').value = 0;
  else if(num($('#f-bagprice').value)===0) $('#f-bagprice').value = settings.bagPrice;
  updateComputed();
}
$('#f-bagsource')?.addEventListener('change', toggleBagFields);
function closeModal(){ $('#overlay').classList.remove('show'); editingId=null; editingPaymentTxId=null; addingClientPayment=false; }
$('#btn-cancel')?.addEventListener('click', closeModal);
$('#overlay')?.addEventListener('click', e=>{ if(e.target.id==='overlay') closeModal(); });

/* ---------------- سجل الدفعات المرتبطة بالعميل (عرض فقط) ----------------
   هذا السجل في شيت "العملاء" أصبح للعرض فقط — أي إضافة لدفعة جديدة تتم من تبويب
   "الحركات المالية". دفعتا التسجيل التلقائيتان يمكن تعديلهما من هنا (حقول المبلغ/طريقة
   الدفع) أو من "الحركات المالية" مباشرة، مع مزامنة تلقائية بين الاتجاهين. */
function renderClientPaymentsPanel(){
  const wrap = $('#wrap-client-payments');
  if(!wrap) return;
  const c = editingId ? clients.find(x=>x.id===editingId) : null;
  if(!c || !c.clientId){ wrap.style.display='none'; $('#client-payments-list').innerHTML=''; return; }
  wrap.style.display = '';
  const txs = vaultTx.filter(t=>t.type==='in' && t.clientId===c.clientId)
    .sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (num(a.seq)-num(b.seq)));
  const list = $('#client-payments-list');

  const rowsHtml = txs.map(t=>{
    const isAuto = !!t.autoClientId;
    return `
    <div class="tag" style="width:100%; justify-content:space-between; border-radius:8px; margin-bottom:6px; flex-wrap:wrap;">
      <span class="mono" style="font-size:12px;">#${t.seq||'—'} · ${t.date||'—'} · ${escapeHtml(t.method||'—')} (${destLabel(t.destination||'vault')}) · <b>${fmt(num(t.amount))}</b> ﷼</span>
      <span class="hint" style="margin:0; font-size:11px;">${isAuto ? 'دفعة التسجيل — عدّلها من حقلي "المبلغ المدفوع"/"طريقة الدفع" أعلاه أو مباشرة من تبويب "الحركات المالية"' : 'للتعديل أو الحذف، استخدم تبويب "الحركات المالية"'}</span>
    </div>`;
  }).join('');

  list.innerHTML = rowsHtml || '<div class="hint" style="margin:0;">لا توجد أي دفعة مسجّلة لهذا العميل بعد.</div>';
}

/* ---------------- الملف الزمني الكامل للعميل (عرض فقط) ----------------
   يجمع كل الأحداث المرتبطة بالعميل بترتيب زمني تصاعدي: التسجيل، الدفعات،
   صرف الحقيبة من المخزون، فواتير المبيعات اليدوية، وجلسات دورته (حسب رقم الدورة). */
const TIMELINE_COLORS = { reg:'var(--navy)', pay:'var(--teal)', bag:'var(--gold-dark)', invoice:'var(--red)', session:'#8B5CF6' };
const TIMELINE_TYPE_LABELS = { reg:'التسجيل', pay:'دفعة', bag:'حقيبة', invoice:'فاتورة', session:'جلسة دورة' };
function clientTimelineEvents(c){
  const events = [];
  if(c.date) events.push({ date: c.date, seq2: 0, type: 'reg',
    title: 'تسجيل العميل',
    text: `نوع الدورة: ${escapeHtml(c.courseType||'—')} · رقم الدورة: ${escapeHtml(c.courseNumber||'—')} · الحالة: ${escapeHtml(c.stage||'—')}${c.cancelled?' · ملغي (كنسل)':''}` });
  vaultTx.filter(t=>t.clientId===c.clientId).forEach(t=> events.push({ date: t.date||'', seq2: num(t.seq)||0, type: 'pay',
    title: `دفعة ${t.seq ? '#'+t.seq : ''}`.trim(),
    text: `<b>${fmt(num(t.amount))}</b> ﷼ · ${escapeHtml(t.method||'—')} (${destLabel(t.destination||'vault')})${t.autoClientId?' · دفعة التسجيل':''}` }));
  bagStock.filter(b=>b.type==='issue' && b.issuedClientId===c.id).forEach(b=> events.push({ date: b.date||'', seq2: num(b.createdAt)||0, type: 'bag',
    title: 'صرف حقيبة من المخزون',
    text: `الكمية: ${num(b.qty)} · سعر الوحدة: ${fmt(num(b.unitPrice))} ﷼${b.notes?' · '+escapeHtml(b.notes):''}` }));
  manualSalesInvoices.filter(m=>m.clientId===c.clientId).forEach(m=> events.push({ date: m.date||'', seq2: num(m.createdAt)||0, type: 'invoice',
    title: `فاتورة مبيعات يدوية ${m.invoiceNo ? '#'+m.invoiceNo : ''}`.trim(),
    text: `<b>${fmt(num(m.total))}</b> ﷼${m.description?' · '+escapeHtml(m.description):''}` }));
  if(c.courseNumber){
    courseSessions.filter(s=>s.courseNumber===c.courseNumber).forEach(s=> events.push({ date: s.date||'', seq2: num(s.createdAt)||0, type: 'session',
      title: `جلسة دورة ${escapeHtml(s.courseNumber||'')}`,
      text: `${escapeHtml(s.courseType||'')}${s.capacity?' · السعة: '+s.capacity:''}${s.notes?' · '+escapeHtml(s.notes):''}` }));
  }
  return events.sort((a,b)=> (a.date||'').localeCompare(b.date||'') || (num(a.seq2)-num(b.seq2)));
}
function renderClientTimeline(){
  const wrap = $('#wrap-client-timeline');
  if(!wrap) return;
  const c = editingId ? clients.find(x=>x.id===editingId) : null;
  if(!c || !c.clientId){ wrap.style.display='none'; $('#client-timeline-list').innerHTML=''; return; }
  wrap.style.display = '';
  const events = clientTimelineEvents(c);
  const list = $('#client-timeline-list');
  if(!events.length){ list.innerHTML = '<div class="hint" style="margin:0;">لا توجد أحداث مسجّلة لهذا العميل بعد.</div>'; return; }
  list.innerHTML = events.map(e=>{
    const color = TIMELINE_COLORS[e.type] || 'var(--text-muted)';
    return `
    <div style="position:relative; padding:0 16px 14px 0; margin-right:6px; border-right:2px solid var(--border);">
      <span style="position:absolute; right:-6px; top:3px; width:10px; height:10px; border-radius:50%; background:${color}; border:2px solid var(--bg);"></span>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-size:12px; font-weight:700; color:${color};">${e.title}</span>
        <span class="hint" style="margin:0; font-size:11px;">${escapeHtml(TIMELINE_TYPE_LABELS[e.type]||e.type)}</span>
      </div>
      <div style="font-size:12px; color:var(--text-muted); margin:2px 0;">${escapeHtml(e.date||'بدون تاريخ')}</div>
      <div style="font-size:13px; color:var(--text);">${e.text}</div>
    </div>`;
  }).join('');
}


$('#btn-add')?.addEventListener('click', ()=>openModal(null));
/* زر تحديث لكامل شيت العملاء: يعيد مزامنة حركات الدفع التلقائية لكل عميل مع بياناته الحالية،
   ويعيد رسم كل الشاشات المرتبطة (الجدول، لوحة التحكم، الفلاتر، التقارير، الدورات، الخزنة) دفعة واحدة */
$('#btn-refresh-clients')?.addEventListener('click', async ()=>{
  snapshotState('تحديث شامل لشيت العملاء');
  clients.forEach(c=> syncClientLedgerEntry(c));
  await saveClients();
  await saveVaultTx();
  await saveSettings();
  renderTable();
  renderDashboard();
  refreshFilterOptions();
  renderReports();
  renderCourses();
  if(typeof renderVault==='function') renderVault();
  await logAudit('edit','العملاء', `تحديث شامل لشيت العملاء: إعادة مزامنة بيانات ${clients.length} عميل وإعادة رسم كل الشاشات المرتبطة`);
  invoiceShowToast('تم تحديث الشيت بالكامل');
});

$('#f-course')?.addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits on existing record
  if($('#f-nat').value){
    $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  }else{
    const found = settings.courses.find(c=>c.name===$('#f-course').value);
    if(found && !$('#f-courseprice').value) $('#f-courseprice').value = found.price;
  }
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
function isSaudiNationality(v){ return /^(saudi|سعود)/i.test(String(v||'').trim()); }
function nationalityCoursePrice(nat){ return isSaudiNationality(nat) ? num(settings.priceSaudi) : num(settings.priceNonSaudi); }
function reapplyCompanyPricingIfNeeded(){
  if($('#f-clienttype').value!=='company') return;
  const c = companies.find(x=>x.name===$('#f-company').value.trim());
  if(c && !(c.categories && c.categories.length) && num(c.agreedAmount)>0) applyCompanyAgreedPricing(c);
}
$('#f-nat')?.addEventListener('change', ()=>{
  if(editingId) return; // don't override manual edits على السجل
  if($('#f-nat').value) $('#f-courseprice').value = nationalityCoursePrice($('#f-nat').value);
  reapplyCompanyPricingIfNeeded();
  updateComputed();
});
/* حالة دورة هذا العميل تحديداً (برقم دورته الخاص فقط) — تظهر فقط عند وجود رقم دورة، ولا تعرض أي شيء عن باقي أنواع الدورات */
function updateClientCourseStatus(){
  const cn = $('#f-coursenum').value.trim();
  const wrap = $('#wrap-f-coursestatus');
  const box = $('#f-coursestatus-box');
  if(!cn){ wrap.style.display = 'none'; box.innerHTML = ''; return; }
  wrap.style.display = 'block';
  const sess = courseSessions.find(s=>s.courseNumber===cn);
  const date = sess?.date || '';
  if(!date){
    box.innerHTML = `<span class="stamp" style="border-color:var(--text-muted); color:var(--text-muted);">لم يتم تحديد تاريخ الدورة بعد</span>`;
    return;
  }
  const isTaken = date <= todayISO();
  box.innerHTML = isTaken
    ? `<span class="stamp paid">تم أخذ الدورة (${escapeHtml(date)})</span>`
    : `<span class="stamp owe">لم يحن موعد الدورة بعد (${escapeHtml(date)})</span>`;
}
$('#f-coursenum')?.addEventListener('input', updateClientCourseStatus);
['#f-courseprice','#f-bagprice','#f-discount','#f-paid'].forEach(sel=>{
  $(sel).addEventListener('input', updateComputed);
});
/* ---------------- عروض الخصم (اختياري، أكثر من عرض) ----------------
   «سعر الحقيبة لا يتغير»: خصم العروض يُطرح من قيمة التدريب (سعر الدورة) فقط، والحقيبة
   تبقى تمريرية بسعرها كما هي. العروض المختارة تُحفظ على العميل نفسه وقت التسجيل، فتظل
   قيمتها ثابتة حتى لو تغيّرت إعدادات العروض لاحقاً.
   الاختيار يُدار بحالة مستقلة (_selectedOfferKeys) وليس بالاعتماد على DOM فقط، حتى يبقى
   اختيار أكثر من عرض محفوظاً مهما أُعيد حساب الإجماليات أو إعادة رسم الخانات. */
let _offerChoices = [];
let _selectedOfferKeys = new Set();
function offerChoiceHtml(o, opts){
  const checked = !!opts.checked;
  const locked = !!opts.locked;
  const disabled = !!opts.disabled;
  const name = escapeHtml(o.name || 'عرض');
  const type = o.type === 'percent' ? 'percent' : 'amount';
  const value = num(o.value);
  const amount = locked ? num(o.amount) : offerDiscountAmountFor(opts.price, type, value);
  const valueLabel = type === 'percent' ? fmt(value) + '%' : fmt(value) + ' ﷼';
  const note = locked ? ' <span style="font-size:11px; color:var(--text-muted);">— محفوظ</span>'
    : (value <= 0 ? ' <span style="font-size:11px; color:var(--warning,#b45309);">— بدون قيمة (عدّله من الإعدادات)</span>' : '');
  return `<label style="display:flex; align-items:center; gap:6px; font-size:12.5px; background:var(--surface-alt,#f7f8fa); padding:6px 10px; border-radius:8px; border:1px solid var(--border); cursor:${disabled ? 'not-allowed' : 'pointer'};${disabled ? ' opacity:.6;' : ''}">
    <input type="checkbox" class="f-offer-check" style="width:auto;" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}
      data-offer-key="${escapeHtml(String(opts.key || o.id || ''))}"
      data-offer-id="${escapeHtml(String(o.id || ''))}"
      data-offer-name="${name}"
      data-offer-type="${type}"
      data-offer-value="${value}"
      data-offer-amount="${amount}"
      ${locked ? 'data-locked="1"' : ''}>
    <span><b>${name}</b> <span style="color:var(--text-muted);">(${valueLabel})</span>${note}</span>
  </label>`;
}
/* يبني خيارات العروض داخل نموذج العميل: العروض المحفوظة على العميل أولاً (كما هي)،
   ثم بقية العروض الفعّالة حالياً. هكذا لا يتغير خصم عميل قديم عند تعديل العروض. */
function renderClientOfferChoices(c){
  const box = $('#f-offers-list');
  if(!box) return;
  const price = num($('#f-courseprice').value);
  const saved = typeof appliedOffersOf === 'function' ? appliedOffersOf(c) : [];
  const sig = o => `${String(o.name || '').trim()}|${o.type === 'percent' ? 'percent' : 'amount'}|${num(o.value)}`;
  _offerChoices = [];
  _selectedOfferKeys = new Set();
  saved.forEach((o, i)=>{
    const key = 'saved:' + i + ':' + String(o.id || '');
    const type = o.type === 'percent' ? 'percent' : 'amount';
    _offerChoices.push({
      key, id: String(o.id || ''), name: o.name || 'عرض', type,
      value: num(o.value), amount: num(o.amount), locked: true, disabled: false,
    });
    _selectedOfferKeys.add(key);
  });
  const active = typeof settingsOffers === 'function' ? settingsOffers().filter(o => o.active !== false) : [];
  active.forEach((o, i)=>{
    const id = String(o.id || ('cfg-' + i));
    if(saved.some(a => (a.id && String(a.id) === id) || sig(a) === sig(o))) return;
    const type = o.type === 'percent' ? 'percent' : 'amount';
    const value = num(o.value);
    const key = 'cfg:' + i + ':' + id;
    _offerChoices.push({
      key, id, name: o.name || 'عرض', type, value,
      amount: offerDiscountAmountFor(price, type, value),
      locked: false, disabled: value <= 0,
    });
  });
  box.innerHTML = _offerChoices.length
    ? _offerChoices.map(o => offerChoiceHtml(o, {
        key: o.key, checked: _selectedOfferKeys.has(o.key), locked: o.locked, disabled: o.disabled, price,
      })).join('')
    : '<span class="hint" style="margin:0;">لا توجد عروض مُعرَّفة حالياً — أضفها من الإعدادات ← «عروض الخصم».</span>';
  syncOfferChecks();
  refreshOfferUi();
}
/* يطابق علامات الاختيار الظاهرة مع الحالة المحفوظة (يمنع أي فقدان للاختيار عند إعادة الحساب). */
function syncOfferChecks(){
  document.querySelectorAll('#f-offers-list .f-offer-check').forEach(cb=>{
    const key = cb.dataset.offerKey || '';
    cb.checked = !cb.disabled && _selectedOfferKeys.has(key);
  });
}
function selectedAppliedOffers(price){
  const p = Math.max(0, num(price));
  const list = [];
  _offerChoices.forEach(o=>{
    if(!_selectedOfferKeys.has(o.key) || o.disabled) return;
    const amount = o.locked ? num(o.amount) : offerDiscountAmountFor(p, o.type, o.value);
    if(amount <= 0) return;
    list.push({
      id: o.id, name: o.name, type: o.type, value: o.value,
      amount: Math.round(amount * 100) / 100,
    });
  });
  return list;
}
function currentOfferAmount(price){
  const p = Math.max(0, num(price));
  const sum = selectedAppliedOffers(p).reduce((s,o)=> s + num(o.amount), 0);
  return Math.min(p, Math.round(sum * 100) / 100);
}
function refreshOfferUi(){
  const hint = $('#f-offer-hint');
  if(!hint) return;
  const price = num($('#f-courseprice').value);
  const selected = selectedAppliedOffers(price);
  const selectable = _offerChoices.filter(o => !o.disabled);
  const countEl = $('#f-offers-count');
  if(countEl){
    countEl.textContent = _offerChoices.length
      ? `المختار: ${selected.length} من ${selectable.length} عرض متاح`
      : '';
  }
  if(selected.length){
    hint.textContent = `الخصم المطبَّق: ${fmt(currentOfferAmount(price))} ﷼ من قيمة التدريب فقط (${selected.map(o=>`${o.name}: ${fmt(o.amount)}`).join(' + ')}) — سعر الحقيبة لا يتغير.`;
    return;
  }
  if(selectable.length){
    hint.textContent = `يمكنك اختيار أكثر من عرض معاً — تُجمع قيمتها وتُخصم من قيمة التدريب فقط، وسعر الحقيبة لا يتغير.`;
    return;
  }
  if(_offerChoices.length){
    hint.textContent = 'كل العروض المعرّفة قيمتها صفر حالياً — عدّل قيمتها من الإعدادات ← «عروض الخصم».';
    return;
  }
  hint.textContent = 'لا توجد عروض مُعرَّفة حالياً — أضفها من الإعدادات ← «عروض الخصم».';
}
$('#f-offers-list')?.addEventListener('change', e=>{
  const cb = e.target && e.target.closest ? e.target.closest('.f-offer-check') : null;
  if(!cb) return;
  const key = cb.dataset.offerKey || '';
  if(!key) return;
  if(cb.checked) _selectedOfferKeys.add(key);
  else _selectedOfferKeys.delete(key);
  updateComputed();
});
$('#f-offers-all')?.addEventListener('click', ()=>{
  _offerChoices.forEach(o=>{ if(!o.disabled) _selectedOfferKeys.add(o.key); });
  syncOfferChecks();
  updateComputed();
});
$('#f-offers-none')?.addEventListener('click', ()=>{
  _selectedOfferKeys.clear();
  syncOfferChecks();
  updateComputed();
});
function updateComputed(){
  syncOfferChecks();
  const price = num($('#f-courseprice').value);
  const manualDiscount = Math.max(0, num($('#f-discount').value));
  const offerAmount = currentOfferAmount(price);
  // إجمالي الخصم لا يتجاوز قيمة التدريب نفسها؛ الحقيبة تُحسب منفصلة ولا يُمسّ سعرها.
  const discountTotal = typeof combineClientDiscount === 'function'
    ? combineClientDiscount(price, manualDiscount, offerAmount)
    : Math.min(price, Math.round((manualDiscount + offerAmount) * 100) / 100);
  const income = price - discountTotal;
  const bag = $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value);
  const t = income + bag;
  const paidTotalForm = num($('#f-paid').value) + ($('#f-split-payment').checked ? num($('#f-paid2').value) : 0);
  const r = Math.max(0, t - paidTotalForm);
  $('#calc-income').textContent = fmt(income);
  $('#calc-bag').textContent = fmt(bag);
  $('#calc-total').textContent = fmt(t);
  $('#calc-remaining').textContent = fmt(r);
  const offerRow = $('#calc-offer-row');
  if(offerRow) offerRow.style.display = offerAmount > 0 ? '' : 'none';
  if($('#calc-offer')) $('#calc-offer').textContent = fmt(offerAmount);
  if($('#calc-discount-total')) $('#calc-discount-total').textContent = fmt(discountTotal);
  refreshOfferUi();
}

// عند اكتشاف رقم هوية مكرر (سواء محلياً أو عبر فحص السيرفر)، العميل الآخر صاحب نفس الرقم قد
// يكون مخفياً عن المستخدم حالياً لسبب بسيط جداً: فلتر السنة أعلى الشاشة مضبوط على سنة غير سنة
// تسجيله، أو أحد الفلاتر المتقدمة (جنسية/شركة/حالة حقيبة...) مفعَّل، أو خانة البحث بها نص قديم —
// فيظهر للمستخدم وكأن "العميل مش موجود" رغم أنه فعلاً مسجَّل. هذه الدالة تنقل المستخدم تلقائياً
// لشاشة العملاء، تمسح كل الفلاتر (بما فيها فلتر السنة) وتبحث برقم الهوية مباشرة، حتى يظهر العميل
// الآخر أمامه فوراً بدل رسالة تحذير فقط بلا أي وسيلة عملية للعثور عليه.
async function revealDuplicateClient(clientIdValue, knownName){
  closeModal();
  document.querySelector('nav.tabs button[data-view="clients"]')?.click();
  selectedYearFilter = 'all';
  try{ localStorage.setItem('selectedYearFilter','all'); }catch(e){ /* غير حرج */ }
  const yearSel = $('#year-filter'); if(yearSel) yearSel.value = 'all';
  if(typeof applyYearFilterToAllViews==='function') applyYearFilterToAllViews();
  const textLikeIds = ['cl-date-from','cl-date-to','cl-paid-min','cl-paid-max'];
  textLikeIds.forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  const selectIds = ['filter-course','filter-nat','filter-status','filter-company','filter-invoice','filter-coursenum','filter-refnum','filter-bag-source','filter-reception'];
  // إلغاء تحديد كل الخيارات (يعادل "الكل") بدل selectedIndex=0 — بعض الفلاتر (مثل الجنسية)
  // لها خيار خاص إضافي (بدون جنسية) يُضاف ديناميكياً في أول القائمة، فكان selectedIndex=0
  // يحدّده هو خطأً بدل "الكل" (نفس إصلاح زر "مسح الفلاتر المتقدمة" أدناه).
  selectIds.forEach(id=>{ const el=document.getElementById(id); if(el){ Array.from(el.options).forEach(o=> o.selected=false); if(typeof refreshMultiSelectFilterUI==='function') refreshMultiSelectFilterUI(el); } });
  showSuspendedOnly = false;
  $('#btn-filter-suspended')?.classList.remove('btn-gold');
  $('#btn-filter-suspended')?.classList.add('btn-ghost');
  showUnpurchasedBagsOnly = false;
  $('#btn-filter-unpurchased-bags')?.classList.remove('btn-gold');
  $('#btn-filter-unpurchased-bags')?.classList.add('btn-ghost');
  const searchEl = $('#search'); if(searchEl) searchEl.value = clientIdValue;
  if(typeof updateAdvancedFiltersBadge==='function') updateAdvancedFiltersBadge();
  if(typeof renderTable==='function') await renderTable();
  invoiceShowToast(knownName
    ? `⚠️ رقم الهوية مستخدم بالفعل لعميل آخر: ${knownName} — تم عرضه أدناه`
    : `⚠️ رقم الهوية مستخدم بالفعل لعميل آخر فى النظام — تم مسح كل الفلاتر (بما فيها فلتر السنة) والبحث عنه أدناه`);
}

$('#client-form')?.addEventListener('submit', async e=>{
  e.preventDefault();
  // (تحديث): أُزيل انتظار _clientsFirstRealSyncDone هنا عمداً بناءً على طلب صريح — بدل تعطيل
  // الشاشة وإجبار المستخدم على الانتظار لحد ما تتأكد نسخة العملاء من السيرفر (كان يمكن أن يمتد
  // لغاية 60 ثانية لو السيرفر "نائم" ويحتاج يصحى، راجع تعليق serverFetch)، نسجّل العميل فورًا فى
  // الذاكرة ونعرضه على الشاشة على طول. الحفظ الفعلي للسيرفر يحدث بعد ذلك (راجع أسفل: لعميل جديد
  // تحديداً حفظ سجل واحد مباشر آمن دائماً بدل رفع كل قائمة العملاء)، ولو تعذّر الاتصال فعلياً وقتها
  // يُسجَّل تلقائياً فى طابور "المعلّقات" (pendingRecords) ويُعاد رفعه تلقائياً أول ما الاتصال يرجع
  // أو أول ما المزامنة الخلفية تكتمل — بنفس الآلية المستخدمة بالفعل لكل انقطاع اتصال فى البرنامج.
  if(editingId && !canReceptionEditClient(clients.find(x=>x.id===editingId))){
    invoiceShowToast('⏱️ انتهت مهلة تعديل هذا العميل (5 ساعات من وقت تسجيله) — يمكن للأدمن فقط تعديله الآن');
    closeModal();
    return;
  }
  const _formPrice = num($('#f-courseprice').value);
  const _formManualDiscount = Math.max(0, num($('#f-discount').value));
  const _formSelectedOffers = selectedAppliedOffers(_formPrice);
  const _formOfferAmount = Math.min(_formPrice, Math.round(_formSelectedOffers.reduce((s,o)=> s + num(o.amount), 0) * 100) / 100);
  // الخصم المحفوظ في c.discount هو الإجمالي (يدوي + عرض) ليبقى متوافقاً مع كل التقارير
  // والفواتير القديمة، بينما يُحفظ جزء العرض منفصلاً للعرض وإعادة الفتح لاحقاً.
  const _formDiscountTotal = typeof combineClientDiscount === 'function'
    ? combineClientDiscount(_formPrice, _formManualDiscount, _formOfferAmount)
    : Math.min(_formPrice, Math.round((_formManualDiscount + _formOfferAmount) * 100) / 100);
  const data = {
    name: $('#f-name').value.trim(),
    clientId: $('#f-id').value.trim(),
    phone: $('#f-phone').value.trim(),
    email: $('#f-email').value.trim(),
    nationality: $('#f-nat').value,
    clientType: $('#f-clienttype').value,
    companyName: $('#f-clienttype').value==='company' ? $('#f-company').value.trim() : '',
    creditDays: $('#f-clienttype').value==='company' ? num($('#f-ajal').value) : '',
    clientTaxNumber: $('#f-clienttax').value.trim(),
    courseType: $('#f-course').value,
    courseNumber: $('#f-coursenum').value.trim(),
    referNum: $('#f-refer').value.trim(),
    invoice: $('#f-invoice').value.trim(),
    bagInvoice: $('#f-baginvoice').value.trim(),
    date: $('#f-date').value,
    coursePrice: num($('#f-courseprice').value),
    bagSource: $('#f-bagsource').value,
    bagOwnDate: $('#f-bagsource').value==='own' ? ($('#f-bagowndate').value || '') : undefined,
    bagPrice: $('#f-bagsource').value==='own' ? 0 : num($('#f-bagprice').value),
    discount: _formDiscountTotal,
    paid: num($('#f-paid').value),
    channel: $('#f-channel').value,
    networkInvoice: $('#f-netinvoice').value.trim(),
    paid2: $('#f-split-payment').checked ? num($('#f-paid2').value) : 0,
    channel2: $('#f-split-payment').checked ? $('#f-channel2').value : '',
    networkInvoice2: $('#f-split-payment').checked ? $('#f-netinvoice2').value.trim() : '',
    stage: $('#f-stage').value,
    cancelled: $('#f-cancelled').checked,
    notes: $('#f-notes').value.trim(),
  };
  // بيانات عروض الخصم: تُحفظ قائمة العروض المختارة بقيمها لحظة التسجيل (snapshot)،
  // بينما c.discount يبقى الإجمالي (يدوي + عروض) لتوافق كل التقارير والفواتير.
  data.appliedOffers = _formOfferAmount > 0
    ? _formSelectedOffers.map(o=> ({ id:o.id, name:o.name, type:o.type, value:o.value, amount:o.amount }))
    : [];
  data.offerApplied = _formOfferAmount > 0;
  data.offerDiscountAmount = _formOfferAmount;
  data.offerNameSnapshot = _formOfferAmount > 0 ? _formSelectedOffers.map(o=>o.name).join(' + ') : '';
  data.offerDiscountType = _formOfferAmount > 0
    ? (_formSelectedOffers.length === 1 ? _formSelectedOffers[0].type : 'mix')
    : '';
  data.offerDiscountValue = (_formOfferAmount > 0 && _formSelectedOffers.length === 1)
    ? num(_formSelectedOffers[0].value)
    : 0;
  // حماية إضافية: مستخدم الاستقبال ممنوع تماماً من شراء/تسليم أي حقيبة من المخزون،
  // حتى لو وصل حقل مصدر الحقيبة بقيمة 'stock' بأي طريقة — تُعاد دائماً إلى "مطلوب الشراء".
  if(currentUserRole === 'reception' && data.bagSource === 'stock'){
    data.bagSource = 'buy';
  }
  // إذا تم تعيين رقم دورة جديد يدوياً، يُلغى تلقائياً وسم الغياب السابق
  if(editingId){
    const prev = clients.find(x=>x.id===editingId);
    if(prev && prev.absent && data.courseNumber && data.courseNumber!==prev.courseNumber){
      data.absent = false;
    }
  }
  if(!data.clientId){ invoiceShowToast('رقم الهوية مطلوب — يُستخدم لربط كل العمليات بهذا العميل'); return; }
  if(!/^\d{10}$/.test(data.clientId)){ invoiceShowToast('رقم الهوية يجب أن يتكون من 10 خانات (أرقام) بالضبط — لا أقل ولا أكثر'); return; }
  if(!data.name){ invoiceShowToast('الاسم مطلوب'); return; }
  const dupId = clients.find(c=>c.clientId===data.clientId && c.id!==editingId);
  if(dupId){ await revealDuplicateClient(data.clientId, dupId.name); return; }
  // فحص إضافي عبر الخادم (لا يعتمد على قائمة العملاء المحمَّلة محلياً فقط): مهم خصوصاً لمستخدم
  // الاستقبال المعزول عادةً عن رؤية باقي عملاء الشركة — بدون هذا الفحص قد يسجّل رقم هوية مكرر
  // بالفعل عند مستخدم استقبال آخر أو ضمن العملاء العامين دون أن يعرف النظام محلياً. مهلة 8 ثوانٍ
  // فقط (بدل الافتراضي 60 ثانية) — لو السيرفر بطيء/نائم وقتها، لا يجوز تعليق تسجيل عميل جديد
  // كل هذه المدة لمجرد فحص احتياطي إضافي؛ نتراجع تلقائياً للفحص المحلي فقط (allIds=null).
  // الفحص عبر الخادم يُنفَّذ فقط لو العميل جديد، أو رقم هويته اتغيّر فعلاً أثناء التعديل. لو بنعدّل عميل موجود
  // ورقم هويته ما اتغيّرش، مفيش مبرر نسأل السيرفر عن "تكرار" أصلاً: أي صف تاني على السيرفر بنفس الرقم (سجل
  // قديم/شبح) كان يخلّي الفحص يرفض أي تعديل حتى لو على حقل مختلف تماماً (اسم/هاتف/ملاحظات...).
  const prevClientForDupCheck = editingId ? clients.find(x=>x.id===editingId) : null;
  const clientIdChanged = !prevClientForDupCheck || String(prevClientForDupCheck.clientId||'').trim() !== data.clientId;
  const allIds = clientIdChanged ? await fetchAllClientIds(8000) : null;
  if(allIds){
    const existingRecordId = allIds.get(await sha256Hex(data.clientId));
    if(existingRecordId && existingRecordId !== editingId){
      await revealDuplicateClient(data.clientId, null); return;
    }
  }
  const wasEdit = !!editingId;
  const prevClientForEvents = editingId ? clients.find(x=>x.id===editingId) : null;
  snapshotState(wasEdit ? `تعديل عميل: ${data.name}` : `إضافة عميل: ${data.name}`);
  if(editingId){
    const idx = clients.findIndex(c=>c.id===editingId);
    const prevSource = clients[idx].bagSource;
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock' && !clients[idx].bagPurchaseDate) data.bagPurchaseDate = todayISO();
    // إن كان مصدر حقيبته السابق "من المخزون" وتغيّر الآن لأي مصدر آخر، تُلغى عملية التسليم المسجّلة
    // تلقائياً من سجل مخزون الحقائب حتى تعود الحقيبة لرصيد المخزون المتاح ولا يبقى خصم بلا مقابل
    if(prevSource==='stock' && data.bagSource!=='stock'){
      const stIdx = bagStock.findIndex(b=>b.type==='issue' && b.issuedClientId===clients[idx].id);
      if(stIdx>-1){ bagStock.splice(stIdx,1); recalcBagFundLedger(); await saveBagStock(); }
    }
    clients[idx] = {...clients[idx], ...data};
    if(data.bagSource!=='stock') delete clients[idx].bagPurchaseDate;
    invoiceShowToast('تم تحديث السجل');
  }else{
    data.bagStatus = data.bagSource==='stock' ? 'purchased' : (data.bagSource==='buy' ? 'pending' : 'n/a');
    if(data.bagSource==='stock') data.bagPurchaseDate = data.bagPurchaseDate || todayISO();
    clients.push({id:uid(), createdAt:Date.now(), createdBy: currentUser, ...data});
    invoiceShowToast('تمت إضافة العميل');
  }
  const savedClient = editingId ? clients.find(c=>c.id===editingId) : clients[clients.length-1];
  // ---- عرض فوري (Optimistic UI): العميل بالفعل موجود فى المصفوفة المحلية من فوق، فنعرضه على
  // الشاشة الآن مباشرة بدل ما ننتظر سلسلة طلبات الحفظ للسيرفر (رفع السجل/الحقائب/الخزنة/الإعدادات/
  // سجل التدقيق) اللي كانت تُنفَّذ الواحدة وراء التانية (await متتالية) وتؤخر ظهور العميل فعلياً على
  // شاشة الاستقبال نفسه اللي أضافه لثوانٍ طويلة لو السيرفر بطيء/نائم (استضافة مجانية). كل خطوات
  // الحفظ تحتها فعلاً محمية بطابور "معلّقات" (pendingRecords) تلقائي لو فشل الاتصال، فتأجيلها للخلفية
  // لا يضيف أي خطر فقدان بيانات جديد.
  // دورة تلقائية: لو رقم الدورة جديد (مفيش دورة بنفس الرقم بعد فى شيت الدورات)، تُفتح دورة
  // حقيقية محفوظة فوراً باسم وتاريخ هذا العميل — بدل الاكتفاء بجلسة وهمية مؤقتة وقت العرض فقط.
  const _sessionCreatedOnSave = typeof ensureCourseSessionForClient === 'function' && ensureCourseSessionForClient(savedClient);
  closeModal();
  // كل استدعاءات إعادة الرسم هنا محمية فرداً بـ try/catch: فشل رسم شاشة واحدة (مثلاً لو ملف
  // الوحدة الخاص بها لسه ما وصلش/اتحمّلش وقت التنفيذ) ما ينبغيش يوقف باقي الشاشات ولا الأهم —
  // سلسلة الحفظ/المزامنة الفعلية تحت (IIFE غير المتزامن) — كان خطأ واحد هنا (مثلاً
  // ReferenceError: renderCourses is not defined) يوقف تنفيذ الدالة كلها فيمنع وصول العميل
  // المحفوظ فعلاً محلياً إلى خطوات الرفع/المزامنة مع السيرفر تماماً.
  [renderTable, renderDashboard, refreshFilterOptions, renderCourses, renderBags].forEach(fn=>{
    try{ if(typeof fn==='function') fn(); }catch(e){ console.error('فشل فى إعادة رسم شاشة بعد حفظ العميل:', e); }
  });
  (async ()=>{
    if(_sessionCreatedOnSave && typeof saveCourseSessions==='function') await saveCourseSessions();
    if(!wasEdit && !_clientsSyncBaseline){
      // مزامنة العملاء الحقيقية الأولى لسه ماكملتش هذه الجلسة (سيرفر بطيء/نائم لتوّه) — بدل
      // استدعاء saveClients() العام (الذي كان سيرفع -فى غياب baseline مؤكد- كل قائمة العملاء
      // المحلية دفعة واحدة اعتماداً على لقطة قد تكون قديمة)، نحفظ هذا العميل الجديد تحديداً فقط
      // كسجل واحد مباشر: آمن دائماً لأن معرّفه (id) جديد فعلاً برقم نسخة صفر، ولا يوجد أي خطر من
      // تعارضه مع بيانات موجودة على السيرفر. لو تعذّر الاتصال فعلياً، يُسجَّل تلقائياً فى طابور
      // "المعلّقات" (pendingRecords) ويُعاد رفعه أول ما الاتصال يرجع أو أول ما المزامنة الخلفية تكتمل.
      const ok = await saveOneClientRecord(savedClient, JSON.stringify(savedClient));
      if(ok){
        if(!_clientsSyncBaseline) _clientsSyncBaseline = new Map();
        _clientsSyncBaseline.set(savedClient.id, JSON.stringify(savedClient));
      }
      if(typeof _scheduleClientsSnapPersist==='function') _scheduleClientsSnapPersist();
    }else{
      await saveClients();
    }
    // نستدعي syncClientLedgerEntry فقط لو تغيّر حقل مالي فعلاً (المدفوع/طريقة الدفع/التاريخ/الفاتورة)
    // حتى لا تُعاد كتابة الحركات المالية عند أي تعديل بسيط غير مالي (اسم/جنسية/هاتف ...)
    const FINANCIAL_FIELDS = ['paid','paid2','channel','channel2','date','networkInvoice','networkInvoice2','companyTransferAllocated','companyTransferId'];
    const prevForLedger = wasEdit ? (prevClientForEvents || {}) : {};
    const ledgerChanged = !wasEdit || FINANCIAL_FIELDS.some(f => String(savedClient[f]||'') !== String(prevForLedger[f]||''));
    if(ledgerChanged) syncClientLedgerEntry(savedClient);
    await syncBagStockIssues();
    if(ledgerChanged) await saveVaultTx();
    await saveSettings();
    await logAudit(wasEdit ? 'edit' : 'add', 'العملاء', `${wasEdit ? 'تم تعديل' : 'تمت إضافة'} بيانات العميل: ${savedClient.name}`);
    // إعادة رسم نهائية بعد اكتمال الحفظ الفعلي: تعكس أي تحديث وصل من السيرفر فى هذه الأثناء
    // (حالة الاعتماد status/origin، تصحيح مخزون الحقائب، قيود الخزنة التلقائية...).
    // نفس الحماية الفردية بـ try/catch كأعلى الدالة: فشل رسم شاشة واحدة لا يمنع باقي خطوات
    // ما بعد الحفظ (الإشعارات وغيرها) من الاستمرار.
    [renderTable, renderDashboard, refreshFilterOptions, renderCourses, renderBags].forEach(fn=>{
      try{ if(typeof fn==='function') fn(); }catch(e){ console.error('فشل فى إعادة رسم شاشة بعد حفظ العميل:', e); }
    });
  })().catch(e=>console.error('فشل فى إكمال حفظ العميل فى الخلفية:', e));
});

/* ---------------- إضافة عدة عملاء دفعة واحدة (جدول) ---------------- */
let bulkAddRowSeq = 0;
function bulkAddOptionsHtml(values, selected){
  return '<option value=""></option>' + values.map(v=>`<option value="${escapeHtml(v)}"${v===selected?' selected':''}>${escapeHtml(v)}</option>`).join('');
}

function invoiceShowToast(message, type = 'info', duration = 3000) {
  // استخدام نظام التوست الموجود في البرنامج
  if (typeof window.showToast === 'function' && window.showToast !== invoiceShowToast) {
    return window.showToast(message, type, duration);
  }
  // Fallback بسيط
  console.log(`[${type}] ${message}`);
  return { close: () => {} };
}
