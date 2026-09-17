/* ================= طيّ/فتح الصناديق (كل .panel له عنوان فى البرنامج) =================
   يضيف سهم صغير عند طرف عنوان كل صندوق (Panel) عنده عنوان واضح (h1-h4)، سواء كان
   العنوان أول عنصر مباشر فى الصندوق أو جوه أول صف (زي صناديق فيها عنوان + أزرار بجانبه).
   بالضغط على السهم: يتم إخفاء كل محتوى الصندوق ما عدا صف العنوان (طي)، أو إظهاره تاني (فتح).
   الصناديق اللي مفيهاش عنوان (زي شيت العملاء وشيت الفواتير وسجل العمليات — جداول بيانات خام)
   بتتسيب من غير سهم عمداً، لأن طيّها مالوش معنى.
   حالة الطي بتتحفظ فى localStorage لكل صندوق (بمفتاحه id لو موجود، وإلا برقم ترتيبه فى
   الصفحة) عشان تفضل زي ما سابها المستخدم بين فتحة وفتحة. */
function initCollapsiblePanels(root){
  const scope = root || document;
  scope.querySelectorAll('.panel').forEach((panel, idx)=>{
    if(panel.dataset.collapseInit) return; // مضاف قبل كده — منعاً للتكرار
    if(panel.classList.contains('no-collapse')) return; // مخصص للاستبعاد الصريح لو احتجنا
    const first = panel.firstElementChild;
    if(!first) return;
    const isHeadingTag = /^H[1-4]$/.test(first.tagName);
    const heading = isHeadingTag ? first : first.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
    if(!heading) return; // صندوق بيانات خام من غير عنوان — من غير سهم عمداً

    panel.dataset.collapseInit = '1';
    const headerHost = isHeadingTag ? first : first; // العنصر اللي هيتضاف له السهم (العنوان نفسه أو الصف اللي فيه)
    headerHost.classList.add('panel-collapsible-header');

    const arrow = document.createElement('span');
    arrow.className = 'panel-toggle-arrow';
    arrow.textContent = '▾';
    arrow.setAttribute('role', 'button');
    arrow.setAttribute('tabindex', '0');
    arrow.title = 'طيّ/فتح الصندوق';
    headerHost.appendChild(arrow);

    const storageKey = 'panelCollapsed:' + (panel.id || ('idx-' + idx));
    try{ if(localStorage.getItem(storageKey) === '1') panel.classList.add('panel-collapsed'); }catch(e){}

    const toggle = ()=>{
      panel.classList.toggle('panel-collapsed');
      try{ localStorage.setItem(storageKey, panel.classList.contains('panel-collapsed') ? '1' : '0'); }catch(e){}
    };
    arrow.addEventListener('click', e=>{ e.stopPropagation(); toggle(); });
    arrow.addEventListener('keydown', e=>{
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggle(); }
    });
  });
}
document.addEventListener('DOMContentLoaded', ()=> initCollapsiblePanels());
// شبكة أمان: أي صندوق بيتضاف/يتحدّث بعد التحميل الأول (بعد جلب بيانات مثلاً) بياخد سهمه برضه
setTimeout(()=> initCollapsiblePanels(), 1500);
