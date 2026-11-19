/* ============================================================
   نبض — طي السايدبار من الصفر (إعادة بناء كاملة)
   ------------------------------------------------------------
   - أيقونات ثابتة لا تختفي أبداً عند الطي
   - النص فقط هو الذي يختفي، الأيقونة تبقى يساراً بنفس الحجم
   - حفظ الحالة في localStorage
   ============================================================ */
(function(){
  const STORAGE_KEY = 'ftc2-sidebar-collapsed';
  const nav = document.querySelector('nav.tabs');
  const btn = document.getElementById('btn-sidebar-collapse');
  if(!nav || !btn) return;

  function applyCollapsed(isCollapsed){
    nav.classList.toggle('collapsed', !!isCollapsed);
    // الأيقونات ثابتة — لا نخفيها أبداً، فقط النص
    // التلميح أصبح من مسؤولية sidebar-pro.js (تلميح عائم بموضع ثابت)،
    // لذلك نمنع تلميح المتصفح الافتراضي من الظهور فوقه.
    nav.querySelectorAll('button[data-view]').forEach(b=>{
      const label = b.querySelector('span')?.textContent?.trim();
      if(isCollapsed && label) b.setAttribute('data-nav-tip', label);
      else b.removeAttribute('data-nav-tip');
      b.removeAttribute('title');
    });
    try{ localStorage.setItem(STORAGE_KEY, isCollapsed ? '1' : '0'); }catch(e){}
    window.dispatchEvent(new CustomEvent('ftc2:sidebar-toggled', { detail:{ collapsed: !!isCollapsed } }));
  }

  // حالة أولية
  try{
    const saved = localStorage.getItem(STORAGE_KEY);
    applyCollapsed(saved === '1');
  }catch(e){}

  btn.addEventListener('click', ()=>{
    const isCollapsed = nav.classList.contains('collapsed');
    applyCollapsed(!isCollapsed);
  });
})();
