/* ============ Arkkan Import - استيراد الحقائب المصروفة من منصة أركان ============ */
async function scrapeArkkan(username, password, onProgress){
  onProgress('جاري فتح صفحة أركان في نافذة مخفية...');
  const resp = await fetch('/arkkan/scrape', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username, password})
  });
  if(!resp.ok){
    const err = await resp.json().catch(()=>({error:'خطأ غير معروف'}));
    throw new Error(err.error || 'فشل الاتصال ببروكسي أركان');
  }
  const data = await resp.json();
  return data.rows || [];
}

async function importArkkan(from, to, username, password, onProgress){
  onProgress('جاري استخراج البيانات من أركان...');
  const rows = await scrapeArkkan(username, password, onProgress);
  console.log('[Arkkan] عدد الصفوف المستخرجة:', rows.length);
  if(rows.length) console.log('[Arkkan] أول صف:', rows[0]);

  const filtered = rows.filter(r => {
    const dateText = r[3] || '';
    const dateNorm = dateText.split('/').reverse().join('-');
    if(from && dateNorm < from) return false;
    if(to && dateNorm > to) return false;
    return true;
  });

  onProgress(`تم استخراج ${rows.length} سجل، بعد الفلترة ${filtered.length} سجل`);

  const bagPrice = num(settings.bagPrice) || 456.55;
  let imported = 0;
  for(const r of filtered){
    const clientId = r[0] || '';
    const clientName = r[1] || '';
    const bagType = r[2] || '';
    const dateRaw = r[3] || '';
    const date = dateRaw.split('/').reverse().join('-');
    const receiptNo = r[5] || '';

    let c = clients.find(x => x.clientId === clientId);
    if(!c){
      c = {id:uid(), clientId, name:clientName, date, courseType:bagType, bagSource:'stock', bagStatus:'purchased', bagPrice, bagInvoice:receiptNo, bagPurchaseDate:date};
      clients.push(c);
    } else {
      c.bagSource = 'stock'; c.bagStatus = 'purchased'; c.bagPrice = bagPrice; c.bagInvoice = receiptNo; c.bagPurchaseDate = date; c.courseType = bagType;
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
      btn.disabled = true;
      if(log) log.textContent = '';
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
