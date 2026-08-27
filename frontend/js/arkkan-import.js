/* ============ Arkkan Import - استيراد الحقائب المصروفة من منصة أركان ============ */
async function arkkanLogin(username, password){
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
  const tables = doc.querySelectorAll('table');
  console.log('[Arkkan Parser] عدد الجداول:', tables.length);

  let biggestTable = null;
  let maxRows = 0;
  for(const t of tables){
    const rows = t.querySelectorAll('tr');
    console.log('[Arkkan Parser] جدول فيه', rows.length, 'صف');
    if(rows.length > maxRows){
      maxRows = rows.length;
      biggestTable = t;
    }
  }

  if(!biggestTable || maxRows < 2){
    console.log('[Arkkan Parser] لا يوجد جدول بياناتي، أول 2000 حرف:', html.substring(0,2000));
    return [];
  }

  console.log('[Arkkan Parser] === أكبر جدول ('+maxRows+' صف) - HTML أول صفين: ===');
  const bigRows = biggestTable.querySelectorAll('tr');
  for(let i=0; i<Math.min(3, bigRows.length); i++){
    console.log('[Arkkan Parser] صف', i, ':', bigRows[i].innerHTML.substring(0,1500));
  }

  const out=[];
  for(let i=0; i<bigRows.length; i++){
    const tr = bigRows[i];
    const tds=[...tr.querySelectorAll('td')];
    if(tds.length < 3) continue;
    const texts = tds.map(td=>td.textContent.trim());
    const links=[...tr.querySelectorAll('a')];
    const printLink = links.find(a=>{
      const h=(a.getAttribute('href')||'').toLowerCase();
      return h.includes('sanad')||h.includes('print')||h.includes('detail')||h.includes('request');
    });
    if(i<5) console.log('[Arkkan Parser] صف', i, '- TDs:', tds.length, '- texts:', texts.join(' | '));
    out.push({
      receiptNo: texts[1]||texts[0]||'',
      bagType: texts[3]||texts[2]||'',
      date: (texts[4]||texts[3]||'').split('/').reverse().join('-'),
      clientName: texts[5]||texts[4]||'',
      clientId: texts[6]||texts[5]||texts[0]||'',
      printHref: printLink?printLink.getAttribute('href'):'',
      _debug: texts.join(' | ')
    });
  }
  console.log('[Arkkan Parser] تم استخراج', out.length, 'سجل من أكبر جدول');
  if(out.length) console.log('[Arkkan Parser] أول سجل:', out[0]._debug);
  return out;
}

async function importArkkan(from,to, username, password, onProgress){
  onProgress('جاري تسجيل الدخول لأركان...');
  const loginResp = await arkkanLogin(username, password);
  console.log('[Arkkan] حجم استجابة الدخول:', loginResp.length);
  console.log('[Arkkan] أول 1000 حرف:', loginResp.substring(0,1000));

  let all=[];
  let page=1;
  while(true){
    onProgress(`جاري سحب الصفحة ${page}...`);
    const html = await fetch(`/arkkan/Municipal/Disbursed-bags.aspx`, {credentials:'include'}).then(r=>r.text());
    console.log('[Arkkan] حجم الصفحة', page, ':', html.length);
    if(page===1) console.log('[Arkkan] أول 2000 حرف من الصفحة:', html.substring(0,2000));

    const rows = parseArkkanRows(html);
    if(!rows.length){
      onProgress('لم يتم العثور على صفوف - راجع Console للتفاصيل');
      break;
    }
    const filtered = rows.filter(r=>{
      if(from && r.date < from) return false;
      if(to && r.date > to) return false;
      return true;
    });
    all.push(...filtered);
    const m = html.match(/__doPostBack\('([^']+)','[^']*Next[^']*'\)/);
    if(!m) break;
    const vs = (html.match(/name="__VIEWSTATE" value="([^"]+)"/)||[])[1]||'';
    const vsg = (html.match(/name="__VIEWSTATEGENERATOR" value="([^"]+)"/)||[])[1]||'';
    const body = new URLSearchParams({__VIEWSTATE:vs, __VIEWSTATEGENERATOR:vsg, __EVENTTARGET:m[1], __EVENTARGUMENT:''});
    await fetch('/arkkan/Municipal/Disbursed-bags.aspx',{method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:body.toString()});
    page++;
    if(page>20) break;
  }
  onProgress(`تم سحب ${all.length} سجل، جاري التحويل...`);
  const bagPrice = num(settings.bagPrice)||456.55;
  let imported=0;
  for(const r of all){
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
      if(log) log.textContent='';
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
