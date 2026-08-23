/* ============================================================
   نبض — Report Studio (غلاف تشغيلي لمحرك التقارير) — Phase 4e
   ------------------------------------------------------------
   معرض بطاقات يفتح التقارير القائمة عبر أزرارها الحقيقية نفسها
   (el.click() على معرفات موجودة) — محرك التقارير والفلاتر
   (فلتر السنة/الفترة) يعملان كما هما بلا أي تغيير.
   ============================================================ */

const REPORT_CATALOG = [
  { icon:'calendar_month', title:'التقرير الشهري الشامل', desc:'ملخص شهر كامل: عملاء، تحصيل، مصروفات — جاهز للطباعة والمشاركة', run:'btn-monthly-report' },
  { icon:'trending_up',    title:'الأرباح والخسائر',      desc:'ربحية المركز لكل فترة مع الإيرادات والمصروفات', run:'btn-export-pnl' },
  { icon:'receipt_long',   title:'ضريبة القيمة المضافة',  desc:'إقرار ضريبة 15% للفترة المختارة', run:'btn-export-vat', print:'btn-print-vat' },
  { icon:'balance',        title:'ميزان المراجعة',        desc:'توازن المدين والدائن لكل حساب', run:'btn-export-trial', print:'btn-print-trial' },
  { icon:'account_balance',title:'الميزانية العمومية',    desc:'المركز المالي: أصول والتزامات وحقوق ملكية', run:'btn-export-balance', print:'btn-print-balance' },
  { icon:'water_drop',     title:'التدفقات النقدية',      desc:'حركة السيولة الداخلة والخارجة', run:'btn-export-cashflow', print:'btn-print-cashflow' },
  { icon:'payments',       title:'الإيرادات التفصيلية',   desc:'تفصيل الإيرادات حسب المصدر والدورة', run:'btn-export-income', print:'btn-print-income' },
  { icon:'stacked_line_chart', title:'الموازنة والتخطيط', desc:'مقارنة المخطط بالفعلي لكل بند', run:'btn-export-budget' },
  { icon:'compare_arrows', title:'المقارنة السنوية',      desc:'هذا العام مقابل الماضي (YoY)', run:'btn-export-yoy' },
  { icon:'hourglass_top',  title:'أعمار الديون — العملاء', desc:'المتأخرات مقسمة بفترات التقادم', run:'btn-export-ar' },
  { icon:'hourglass_bottom', title:'أعمار الديون — الموردون', desc:'المستحق على المركز للموردين', run:'btn-export-ap' },
  { icon:'mail',           title:'إرسال تقرير بالبريد',   desc:'أرسل آخر التقارير لإدارة الحسابات', run:'btn-email-report' }
];

function renderReportStudio(){
  const el = $('#report-studio');
  if(!el || el.dataset.built === '1') return;
  el.dataset.built = '1';
  el.innerHTML = `
    <div class="panel" style="margin-bottom:14px;">
      <h3 style="margin:0 0 4px;">استوديو التقارير</h3>
      <p class="hint" style="margin:0 0 12px;">كل التقارير تعمل على الفترة المحددة في فلتر السنة أعلى الشاشة. اختر تقريراً لتشغيله مباشرة:</p>
      <div class="studio-grid">
        ${REPORT_CATALOG.map((r, i) => `
          <div class="studio-card" data-rs-idx="${i}" tabindex="0" role="button" aria-label="${escapeHtml(r.title)}">
            <span class="msi studio-ico">${r.icon}</span>
            <div class="studio-body">
              <b>${escapeHtml(r.title)}</b>
              <small>${escapeHtml(r.desc)}</small>
              <div class="studio-actions">
                ${r.print ? `<button type="button" class="btn btn-ghost btn-sm" data-rs-run="${r.print}">طباعة</button>` : ''}
                <button type="button" class="btn btn-gold btn-sm" data-rs-run="${r.run}">${r.print ? 'تصدير' : 'تشغيل'}</button>
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

document.addEventListener('click', e => {
  const runBtn = e.target.closest('[data-rs-run]');
  if(runBtn){
    e.stopPropagation();
    document.getElementById(runBtn.dataset.rsRun)?.click();
    return;
  }
  const card = e.target.closest('.studio-card');
  if(card && !e.target.closest('button')){
    const r = REPORT_CATALOG[Number(card.dataset.rsIdx)];
    if(r) document.getElementById(r.run)?.click();
  }
});
document.addEventListener('keydown', e => {
  if((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('studio-card')){
    e.preventDefault();
    const r = REPORT_CATALOG[Number(e.target.dataset.rsIdx)];
    if(r) document.getElementById(r.run)?.click();
  }
});

renderReportStudio();