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

  if(html.includes('2643467158') || html.includes('3211374')){
    console.log('[Arkkan] بيانات الحقائب موجودة في HTML!');
  } else {
    console.log('[Arkkan] بيانات الحقائب غير موجودة في HTML - محملة عن طريق JS');
  }

  const allElements = doc.querySelectorAll('*');
  let gridId = null;
  for(const el of allElements){
    const id = (el.id||'').toLowerCase();
    if(id.includes('gridview') || id.includes('gv') || id.includes('disbursed') || id.includes('tblresult')){
      gridId = el.id;
      console.log('[Arkkan] وجدت عنصر:', el.id, 'نوع:', el.tagName, 'صفوف:', el.querySelectorAll('tr').length);
    }
  }

  const scripts = doc.querySelectorAll('script');
  for(const s of scripts){
    const txt = s.textContent || '';
    if(txt.includes('GridView') || txt.includes('disbursed') || txt.includes('TableData') || txt.includes('ajax') || txt.includes('fetch') || txt.includes('XMLHttp')){
      console.log('[Arkkan] Script قد يحمل البيانات:', txt.substring(0,500));
    }
  }

  const postBacks = html.match(/__doPostBack\('([^']+)'/g);
  if(postBacks){
    console.log('[Arkkan] PostBack events:', [...new Set(postBacks)].join(' | '));
  }

  const tables = doc.querySelectorAll('table');
  console.log('[Arkkan] عدد الجداول:', tables.length);
  for(let ti=0; ti<tables.length; ti++){
    const rows = tables[ti].querySelectorAll('tr');
    if(rows.length < 2) continue;
    const firstCell = rows[0]?.textContent?.trim()?.substring(0,60) || '';
    console.log('[Arkkan] جدول #'+ti+' ('+rows.length+' صف):', firstCell);
    if(rows.length >= 3){
      for(let i=0; i<Math.min(2, rows.length); i++){
        console.log('[Arkkan]   صف'+i+' TDs:'+rows[i].querySelectorAll('td').length+':', rows[i].innerHTML.substring(0,500));
      }
    }
  }

  return [];
}

async function importArkkan(from,to, username, password, onProgress){
  onProgress('جاري تسجيل الدخول لأركان...');
  await arkkanLogin(username, password);

  onProgress('جاري سحب الصفحة...');
  const html = await fetch(`/arkkan/Municipal/Disbursed-bags.aspx`, {credentials:'include'}).then(r=>r.text());
  console.log('[Arkkan] حجم الصفحة:', html.length);

  parseArkkanRows(html);

  onProgress('تم التحليل - راجع Console');
  return 0;
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
      }catch(e){ onProgress('خطأ: '+(e.message||e)); showToast('فشل الاستيراد'); console.error(e); }
      finally{ btn.disabled=false; }
    });
    console.log('[Arkkan] زر الاستيراد جاهز');
  }
  bind();
})();
