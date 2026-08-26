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
  return res.text();
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
  await arkkanLogin(username, password);
  let all=[];
  let page=1;
  while(true){
    onProgress(`جاري سحب الصفحة ${page}...`);
    // فلترة التاريخ عبر query string إن وجدت، وإلا نسحب كل الصفحات ونفلتر محلياً
    const html = await fetch(`/arkkan/Municipal/Disbursed-bags.aspx`, {credentials:'include'}).then(r=>r.text());
    const rows = parseArkkanRows(html);
    if(!rows.length) break;
    // فلترة التاريخ محلياً
    const filtered = rows.filter(r=>{
      if(from && r.date < from) return false;
      if(to && r.date > to) return false;
      return true;
    });
    all.push(...filtered);
    // هل يوجد زر التالي؟
    const hasNext = html.includes('>') && html.includes('التالي');
    // للتبسيط: نسحب عبر __doPostBack للصفحة التالية إن وجد
    const m = html.match(/__doPostBack\('([^']+)','[^']*Next[^']*'\)/);
    if(!m) break;
    // تنفيذ الانتقال للصفحة التالية
    const vs = (html.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
    const vsg = (html.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
    const body = new URLSearchParams({__VIEWSTATE:vs, __VIEWSTATEGENERATOR:vsg, __EVENTTARGET:m[1], __EVENTARGUMENT:''});
    await fetch('/arkkan/Municipal/Disbursed-bags.aspx',{method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()});
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

// ربط زر الواجهة
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.getElementById('btn-arkkan-import');
  if(!btn) return;
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
});
