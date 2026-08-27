/* ============ Arkkan Import - استيراد الحقائب المصروفة من منصة أركان ============ */
async function arkkanLogin(username, password){
  // نحصل على صفحة الدخول أولاً لأخذ VIEWSTATE
  const loginHtml = await fetch('/arkkan/Municipal/Disbursed-bags.aspx', {credentials:'include'}).then(r=>r.text());
  console.log('[Arkkan] صفحة الدخول المحملة،طول:', loginHtml.length);
  const vs = (loginHtml.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
  const vsg = (loginHtml.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
  if(!vs) console.warn('[Arkkan] تحذير: __VIEWSTATE فارغ — قد يفشل الدخول');
  const body = new URLSearchParams({
    __VIEWSTATE: vs,
    __VIEWSTATEGENERATOR: vsg,
    UsernameLog: username,
    Password: password,
    __EVENTTARGET: 'btn_submitEnter',
    __EVENTARGUMENT: ''
  });
  const res = await fetch('/arkkan/Municipal/Disbursed-bags.aspx', {
    method:'POST',
    credentials:'include',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body: body.toString()
  });
  const html = await res.text();
  console.log('[Arkkan] رد تسجيل الدخول،طول:', html.length, 'حالة HTTP:', res.status);
  // تحقق فعلي من نجاح الدخول: طالما حقل الباسورد أو زر الدخول لا يزال ظاهراً
  // في الرد فهذا يعني أننا ما زلنا على صفحة تسجيل الدخول (بيانات خاطئة، أو
  // تغيّرت أسماء الحقول في أركان) — بدون هذا التحقق كانت العملية تفشل بصمت
  // وتُرجع صفر سجلات دون أي رسالة توضح السبب الحقيقي.
  if (/name="Password"/i.test(html) || /id="UsernameLog"/i.test(html)) {
    throw new Error('فشل تسجيل الدخول لأركان — تأكد من اليوزر والباسورد');
  }
  return html;
}

function parseArkkanRows(html){
  const doc = new DOMParser().parseFromString(html,'text/html');
  const tables = doc.querySelectorAll('table');
  console.log('[Arkkan] عدد الجداول في الصفحة:', tables.length);
  const rows = [...doc.querySelectorAll('table tr')].slice(1); // تجاوز الهيدر
  console.log('[Arkkan] عدد صفوف الجدول (باستثناء الهيدر):', rows.length);
  const out=[];
  let skippedNoSanad = 0, skippedFewTds = 0;
  for(const tr of rows){
    const tds=[...tr.querySelectorAll('td')];
    if(tds.length < 6) { skippedFewTds++; continue; }
    const printLink = tr.querySelector("a[href*='sanad']");
    if(!printLink) { skippedNoSanad++; continue; }
    const rawDate = tds[4]?.textContent.trim()||'';
    // تحويل DD/MM/YYYY → YYYY-MM-DD مع التحقق من الصيغة — لو التاريخ بصيغة غير متوقعة يُترك فارغاً بدل إدخال قيمة خاطئة
    const dateParts = rawDate.split('/');
    const date = (dateParts.length === 3 && /^\d{1,2}$/.test(dateParts[0]) && /^\d{1,2}$/.test(dateParts[1]) && /^\d{4}$/.test(dateParts[2]))
      ? `${dateParts[2]}-${dateParts[1].padStart(2,'0')}-${dateParts[0].padStart(2,'0')}`
      : '';
    out.push({
      receiptNo: tds[1]?.textContent.trim()||'',
      bagType: tds[3]?.textContent.trim()||'',
      date,
      clientName: tds[5]?.textContent.trim()||'',
      clientId: tds[6]?.textContent.trim()||'',
      printHref: printLink.getAttribute('href')
    });
  }
  if(skippedNoSanad) console.log('[Arkkan] تم تجاوز', skippedNoSanad, 'صف بدون رابط sanad');
  if(skippedFewTds) console.log('[Arkkan] تم تجاوز', skippedFewTds, 'صف بأقل من 6 خلايا');
  console.log('[Arkkan] صفوف صالحة بعد التحليل:', out.length);
  return out;
}

async function importArkkan(from,to, username, password, onProgress){
  onProgress('جاري تسجيل الدخول لأركان...');
  // صفحة الدخول الناجحة هي نفسها صفحة النتائج (صفحة 1) في هذا الموقع، فنعيد
  // استخدام ردّها مباشرة بدل عمل GET إضافي كان يعيد صفحة الدخول من جديد
  // (الجلسة عبر الكوكيز فقط، وGET بلا كوكيز مُعاد استخدامها بشكل صحيح كان
  // يبدو وكأنه يعمل، لكن الخطأ الحقيقي هو أن حلقة التنقل بين الصفحات أدناه
  // كانت تتجاهل رد "الصفحة التالية" وتُعيد طلب الصفحة الأولى في كل تكرار).
  let html = await arkkanLogin(username, password);
  let all=[];
  let page=1;
  while(true){
    onProgress(`جاري سحب الصفحة ${page}...`);
    const rows = parseArkkanRows(html);
    if(!rows.length){
      console.warn('[Arkkan] الصفحة', page, 'لم تحتوي على صفوف صالحة — طول HTML:', html.length);
      // في الصفحة الأولى: نحاول الصفحة التالية بدل التوقف الفوري
      // (قد تكون صفحة الدخول لا تحتوي جدول لكن الصفحات التالية تحتوي)
      if(page === 1){
        const m1 = html.match(/__doPostBack\('([^']+)','[^']*'\)/);
        if(!m1){ onProgress('الصفحة الأولى فارغة ولا توجد صفحات تالية — تحقق من بيانات الدخول أو من بنية صفحة أركان'); break; }
        // ننتقل للصفحة التالية بدل التوقف
      } else {
        break;
      }
    } else {
      // فلترة التاريخ محلياً
      const filtered = rows.filter(r=>{
        if(from && r.date && r.date < from) return false;
        if(to && r.date && r.date > to) return false;
        return true;
      });
      console.log('[Arkkan] الصفحة', page, ':', rows.length, 'صف →', filtered.length, 'بعد فلترة التاريخ');
      all.push(...filtered);
    }
    // الانتقال للصفحة التالية عبر __doPostBack إن وجد
    // يدعم كل من English (Next) و Arabic (التالي) وأي نمط __doPostBack تقليدي
    const m = html.match(/__doPostBack\('([^']+)','([^']*Next[^']*|[^']*التالي[^']*|[^']*Page\$[^']*|[^']*page\$[^']*|[^']*\$_next[^']*|[^']*\$Next[^']*)'\)/i);
    if(!m){
      // محاولة أبسط: أي __doPostBack يحتوي على 'Page$' أو 'page$'
      const mFallback = html.match(/__doPostBack\('([^']+)','([^']*Page\$[^']*|[^']*\$lbnNext[^']*|[^']*\$btnNext[^']*|[^']*\$btnNextPage[^']*)'\)/i);
      if(!mFallback){
        console.log('[Arkkan] لا يوجد زر "التالي" — اكتملت الصفحات عند الصفحة', page);
        break;
      }
      onProgress(`جاري سحب الصفحة ${page+1}...`);
      const vs = (html.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
      const vsg = (html.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
      const body = new URLSearchParams({__VIEWSTATE:vs, __VIEWSTATEGENERATOR:vsg, __EVENTTARGET:mFallback[1], __EVENTARGUMENT:''});
      html = await fetch('/arkkan/Municipal/Disbursed-bags.aspx',{method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()}).then(r=>r.text());
    } else {
      onProgress(`جاري سحب الصفحة ${page+1}...`);
      const vs = (html.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
      const vsg = (html.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
      const body = new URLSearchParams({__VIEWSTATE:vs, __VIEWSTATEGENERATOR:vsg, __EVENTTARGET:m[1], __EVENTARGUMENT:''});
      html = await fetch('/arkkan/Municipal/Disbursed-bags.aspx',{method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()}).then(r=>r.text());
    }
    page++;
    if(page>20) break;
  }
  console.log('[Arkkan] إجمالي السجلات المستخرجة:', all.length);
  onProgress(`تم سحب ${all.length} سجل، جاري التحويل...`);
  // تحويل لصيغة FTC2
  const bagPrice = num(settings.bagPrice)||456.55;
  let imported=0;
  for(const r of all){
    // هل العميل موجود؟
    let c = clients.find(x=>x.clientId===r.clientId);
    if(!c){
      c={id:uid(), clientId:r.clientId, name:r.clientName, date:r.date, courseType:r.bagType, bagSource:'stock', bagStatus:'purchased', bagPrice, bagInvoice:r.receiptNo, bagPurchaseDate:r.date};
      clients.push(c);
    } else {
      c.bagSource='stock'; c.bagStatus='purchased'; c.bagPrice=bagPrice; c.bagInvoice=r.receiptNo; c.bagPurchaseDate=r.date;
    }
    imported++;
  }
  onProgress(`تم تحويل ${imported} سجل، جاري الحفظ...`);
  await saveClients();
  await saveBagStock();
  renderBags();
  onProgress(`تم استيراد ${imported} حقيبة بنجاح`);
  return imported;
}

// ربط زر الواجهة (محمّل ديناميكياً عبر boot.js بعد DOMContentLoaded)
(function bindArkkanButton(){
  function bind(){
    const btn = document.getElementById('btn-arkkan-import');
    if(!btn){ setTimeout(bind,500); return; }
    btn.addEventListener('click', async ()=>{
      const user = document.getElementById('arkkan-user')?.value.trim();
      const pass = document.getElementById('arkkan-pass')?.value;
      const from = document.getElementById('arkkan-from')?.value;
      const to = document.getElementById('arkkan-to')?.value;
      const status = document.getElementById('arkkan-status');
      const log = document.getElementById('arkkan-log');
      if(!user || !pass){ alert('أدخل يوزر وباسورد أركان'); return; }
      btn.disabled=true;
      const onProgress = (msg)=>{ if(status) status.textContent=msg; if(log) log.textContent += msg+'\n'; console.log('[Arkkan]',msg); };
      try{
        await importArkkan(from,to,user,pass,onProgress);
        showToast('تم الاستيراد من أركان');
      }catch(e){ onProgress('خطأ: '+(e.message||e)); showToast('فشل الاستيراد'); console.error(e); }
      finally{ btn.disabled=false; }
    });
    console.log('[Arkkan] زر الاستيراد جاهز');
  }
  bind();
})();
