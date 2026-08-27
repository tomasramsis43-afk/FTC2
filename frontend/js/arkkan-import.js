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
  console.log('[Arkkan] عدد الجداول:', tables.length);

  for(let ti=0; ti<tables.length; ti++){
    const t = tables[ti];
    const rows = t.querySelectorAll('tr');
    if(rows.length < 2) continue;
    const firstTdText = rows[0]?.querySelector('td')?.textContent?.trim()?.substring(0,80) || '';
    console.log('[Arkkan] جدول #'+ti+' ('+rows.length+' صف):', firstTdText);
    if(rows.length >= 3 && rows.length <= 25){
      for(let i=0; i<Math.min(2, rows.length); i++){
        console.log('[Arkkan]   صف'+i+':', rows[i].innerHTML.substring(0,800));
      }
    }
  }

  const forms = doc.querySelectorAll('form');
  console.log('[Arkkan] عدد الفورمات:', forms.length);
  const doPostBack = html.match(/__doPostBack/g);
  console.log('[Arkkan] عدد __doPostBack:', doPostBack ? doPostBack.length : 0);

  const gridViews = doc.querySelectorAll('[id*="GridView"], [id*="gridview"], [id*="gv"], [id*="tbl"]');
  console.log('[Arkkan] جداول GridView:', gridViews.length);
  for(const gv of gridViews){
    console.log('[Arkkan] GridView id:', gv.id, 'صفوف:', gv.querySelectorAll('tr').length);
  }

  return [];
}

async function importArkkan(from,to, username, password, onProgress){
  onProgress('جاري تسجيل الدخول لأركان...');
  const loginResp = await arkkanLogin(username, password);
  console.log('[Arkkan] حجم استجابة الدخول:', loginResp.length);

  onProgress('جاري سحب الصفحة...');
  const html = await fetch(`/arkkan/Municipal/Disbursed-bags.aspx`, {credentials:'include'}).then(r=>r.text());
  console.log('[Arkkan] حجم الصفحة:', html.length);

  parseArkkanRows(html);

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  console.log('[Arkkan] عنوان الصفحة:', titleMatch ? titleMatch[1] : 'غير معروف');

  const h1 = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi);
  if(h1) console.log('[Arkkan] عناوين:', h1.slice(0,5).join(' | '));

  onProgress('تم تحليل الصفحة - راجع Console للتفاصيل');
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
