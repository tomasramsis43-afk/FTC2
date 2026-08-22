/* ============================================================================
   FTC2 — Health Education UI integration
   ---------------------------------------------------------------------------
   Adds the business distinction:
     - course duration = actual training duration
     - health education validity = 3 calendar years
   The UI derives validity from the actual course date already used by FTC2;
   no existing client record is overwritten.
   ============================================================================ */
(function(global){
  'use strict';

  const WARN_DAYS = 90;

  function isoToday(){
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function expiryFromStart(start){
    if(!start) return '';
    const d = new Date(String(start).slice(0,10) + 'T00:00:00');
    if(Number.isNaN(d.getTime())) return '';
    d.setFullYear(d.getFullYear()+3);
    d.setDate(d.getDate()-1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function daysBetween(a,b){
    const x = new Date(a+'T00:00:00');
    const y = new Date(b+'T00:00:00');
    return Math.floor((y-x)/86400000);
  }

  function getValidity(start){
    const expiry = expiryFromStart(start);
    if(!expiry) return {start:'', expiry:'', status:'unknown', days:null};
    const days = daysBetween(isoToday(), expiry);
    let status = 'valid';
    if(days < 0) status = 'expired';
    else if(days <= WARN_DAYS) status = 'expiring';
    return {start:String(start).slice(0,10), expiry, status, days};
  }

  function statusText(v){
    if(v.status==='expired') return 'منتهي — يحتاج دورة جديدة';
    if(v.status==='expiring') return `ينتهي قريباً — متبقي ${v.days} يوم`;
    if(v.status==='valid') return `ساري — متبقي ${v.days} يوم`;
    return 'غير محدد';
  }

  function statusClass(v){
    if(v.status==='expired' || v.status==='expiring') return 'owe';
    if(v.status==='valid') return 'paid';
    return '';
  }

  function findCourseDate(client){
    try{
      if(typeof actualCourseDateOf === 'function') return actualCourseDateOf(client) || '';
      if(client && client.courseNumber && Array.isArray(global.courseSessions)){
        const s = global.courseSessions.find(x=>x.courseNumber===client.courseNumber);
        return s?.date || client.expectedCourseDate || '';
      }
    }catch(e){ console.warn('[HealthEducationUI] course date lookup failed', e); }
    return client?.expectedCourseDate || '';
  }

  function enhance(){
    const root = document.getElementById('courses-sessions-list');
    if(!root || !Array.isArray(global.clients)) return;

    root.querySelectorAll('tbody tr').forEach(row=>{
      if(row.dataset.healthEducationEnhanced==='1') return;
      const idCell = row.querySelector('td.mono');
      if(!idCell) return;
      const clientId = (idCell.textContent || '').trim();
      if(!clientId || clientId==='—') return;
      const client = global.clients.find(c=>String(c.clientId||'').trim()===clientId);
      if(!client) return;

      const start = findCourseDate(client);
      const v = getValidity(start);
      const cell = document.createElement('td');
      cell.setAttribute('data-label','صلاحية التثقيف الصحي');
      if(!v.start){
        cell.innerHTML = '<span class="stamp">غير محدد</span>';
      }else{
        cell.innerHTML = `<span class="stamp ${statusClass(v)}" title="بداية الصلاحية: ${v.start} | نهاية الصلاحية: ${v.expiry}">${statusText(v)}</span>`;
      }

      const bagCell = row.querySelector('td[data-label*="الحقيبة"], td:nth-last-child(2)');
      if(bagCell) row.insertBefore(cell, bagCell);
      else row.appendChild(cell);
      row.dataset.healthEducationEnhanced='1';
    });

    // Add the column heading once per rendered course table.
    root.querySelectorAll('table thead tr').forEach(head=>{
      if(head.dataset.healthEducationHeader==='1') return;
      const th = document.createElement('th');
      th.textContent = 'صلاحية التثقيف الصحي';
      const bagTh = Array.from(head.children).find(x=>String(x.textContent||'').includes('الحقيبة'));
      if(bagTh) head.insertBefore(th, bagTh);
      else head.appendChild(th);
      head.dataset.healthEducationHeader='1';
    });
  }

  function init(){
    const root = document.getElementById('courses-sessions-list');
    if(!root) return;
    const observer = new MutationObserver(()=>enhance());
    observer.observe(root,{childList:true,subtree:true});
    enhance();
    global.FTCHealthEducationUI = Object.freeze({enhance,getValidity,expiryFromStart});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})(window);
