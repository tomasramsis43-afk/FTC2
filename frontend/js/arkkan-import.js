/* ============ Arkkan Import - استيراد الحقائب المصروفة من منصة أركان ============ */
async function arkkanLogin(username, password){
  // نحصل على صفحة الدخول أولاً لأخذ VIEWSTATE
  const loginHtml = await fetch('/arkkan/Municipal/Disbursed-bags.aspx', {credentials:'include'}).then(r=>r.text());
  const vs = (loginHtml.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
  const vsg = (loginHtml.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
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
  const rows = [...doc.querySelectorAll('table tr')].slice(1); // تجاوز الهيدر
  const out=[];
  for(const tr of rows){
    const tds=[...tr.querySelectorAll('td')];
    if(tds.length < 6) continue;
    const printLink = tr.querySelector("a[href*='sanad']");
    if(!printLink) continue;
    out.push({
      receiptNo: tds[1]?.textContent.trim()||'',
      bagType: tds[3]?.textContent.trim()||'',
      date: tds[4]?.textContent.trim().split('/').reverse().join('-'), // 25/08/2026 -> 2026-08-25
      clientName: tds[5]?.textContent.trim()||'',
      clientId: tds[6]?.textContent.trim()||'',
      printHref: printLink.getAttribute('href')
    });
  }
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
    if(!rows.length) break;
    // فلترة التاريخ محلياً
    const filtered = rows.filter(r=>{
      if(from && r.date < from) return false;
      if(to && r.date > to) return false;
      return true;
    });
    all.push(...filtered);
    // الانتقال للصفحة التالية عبر __doPostBack إن وجد، ونستخدم رد هذا الطلب
    // نفسه كصفحة تالية بدل إعادة GET لصفحة 1 (كان هذا هو سبب توقف الاستيراد
    // فعلياً عند الصفحة الأولى دائماً، حتى مع بيانات دخول صحيحة).
    const m = html.match(/__doPostBack\('([^']+)','[^']*Next[^']*'\)/);
    if(!m) break;
    const vs = (html.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
    const vsg = (html.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
    const body = new URLSearchParams({__VIEWSTATE:vs, __VIEWSTATEGENERATOR:vsg, __EVENTTARGET:m[1], __EVENTARGUMENT:''});
    html = await fetch('/arkkan/Municipal/Disbursed-bags.aspx',{method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()}).then(r=>r.text());
    page++;
    if(page>20) break;
  }
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
