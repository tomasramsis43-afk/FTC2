/* ============================================================
   مساعدات "النبض" المشتركة (زمن نسبي / آخر N يوم / تسميات أنواع النشاط)
   ------------------------------------------------------------
   كان هذا الملف يرسم لوحة "نبض Cockpit" (تدفق نقدي 30 يوماً + سجل النشاط + إجراءات سريعة)
   في لوحة التحكم القديمة. اللوحة استُبدلت بـ js/dashboard-v2.js وبقيت هنا الدوال المساعدة فقط
   لأن ملفات أخرى (مركز الإشعارات وغيره) تعتمد عليها.
   ============================================================ */
/* زمن نسبي عربي مبسط */
function pulseRelTime(ts){
  const diff = Date.now() - Number(ts || 0);
  if(diff < 60000) return 'الآن';
  const m = Math.floor(diff / 60000);
  if(m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if(h < 24) return `قبل ${h} ${h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : h + ' ساعات'}`;
  const d = Math.floor(h / 24);
  if(d < 30) return `قبل ${d} ${d === 1 ? 'يوم' : d === 2 ? 'يومين' : d + ' أيام'}`;
  return new Date(Number(ts)).toLocaleDateString('ar');
}

/* آخر N يوم بصيغة YYYY-MM-DD (الأقدم أولاً) */
function pulseLastNDates(n){
  const out = [];
  const t = new Date();
  for(let i = n - 1; i >= 0; i--){
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

const PULSE_ACT_META = {
  add:    { label:'إضافة', color:'var(--success)', icon:'add_circle' },
  edit:   { label:'تعديل', color:'var(--warning, #e0a72f)', icon:'edit' },
  delete: { label:'حذف',  color:'var(--danger)', icon:'do_not_disturb_on' }
};
