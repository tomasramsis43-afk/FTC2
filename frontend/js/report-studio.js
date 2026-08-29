/* ============================================================
   نبض — Report Studio (غلاف تشغيلي لمحرك التقارير) — Phase 4e
   ------------------------------------------------------------
   معرض بطاقات يفتح التقارير القائمة عبر أزرارها الحقيقية نفسها
   (el.click() على معرفات موجودة) — محرك التقارير والفلاتر
   (فلتر السنة/الفترة) يعملان كما هما بلا أي تغيير.
   الأيقونات: SVG inline — لا تعتمد على أي خط خارجي (Material Symbols محذوف)
   ============================================================ */

const REPORT_ICONS = {
  calendar_month: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>`,
  trending_up:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 7-8"/><path d="M14 8h6v6"/></svg>`,
  receipt_long:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>`,
  balance:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 6l7-3 7 3"/><path d="M5 6l-2 6c0 2 2 3 4 3s4-1 4-3L5 6z"/><path d="M19 6l-2 6c0 2 2 3 4 3s4-1 4-3L19 6z"/></svg>`,
  account_balance:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 4l9 6.5"/><rect x="5" y="11" width="3" height="7"/><rect x="10.5" y="11" width="3" height="7"/><rect x="16" y="11" width="3" height="7"/><path d="M3 18h18"/></svg>`,
  water_drop:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C12 2 5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13z"/></svg>`,
  payments:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M2 10h20"/><circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none"/></svg>`,
  stacked_line_chart:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l4-4 4 2 4-5 4 3"/><path d="M3 12l4-3 4 2 4-4 4 2"/><path d="M3 21h18"/></svg>`,
  compare_arrows: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V8m0 0L4 11m3-3l3 3"/><path d="M17 8v8m0 0l3-3m-3 3l-3-3"/></svg>`,
  hourglass_top:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14M5 21h14"/><path d="M5 3c0 7 14 7 14 0"/><path d="M5 21c0-7 14-7 14 0"/></svg>`,
  hourglass_bottom:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14M5 21h14"/><path d="M5 3c0 7 14 7 14 0"/><path d="M5 21c0-7 14-7 14 0"/><path d="M8 21c0-4 8-4 8 0"/></svg>`,
  mail:           `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 7 10-7"/></svg>`,
};

const REPORT_CATALOG = [
  { icon:'calendar_month',    title:'التقرير الشهري الشامل',      desc:'ملخص شهر كامل: عملاء، تحصيل، مصروفات — جاهز للطباعة والمشاركة', run:'btn-monthly-report' },
  { icon:'trending_up',       title:'الأرباح والخسائر',           desc:'ربحية المركز لكل فترة مع الإيرادات والمصروفات', run:'btn-export-pnl' },
  { icon:'receipt_long',      title:'ضريبة القيمة المضافة',       desc:'إقرار ضريبة 15% للفترة المختارة', run:'btn-export-vat', print:'btn-print-vat' },
  { icon:'balance',           title:'ميزان المراجعة',             desc:'توازن المدين والدائن لكل حساب', run:'btn-export-trial', print:'btn-print-trial' },
  { icon:'account_balance',   title:'الميزانية العمومية',         desc:'المركز المالي: أصول والتزامات وحقوق ملكية', run:'btn-export-balance', print:'btn-print-balance' },
  { icon:'water_drop',        title:'التدفقات النقدية',           desc:'حركة السيولة الداخلة والخارجة', run:'btn-export-cashflow', print:'btn-print-cashflow' },
  { icon:'payments',          title:'الإيرادات التفصيلية',        desc:'تفصيل الإيرادات حسب المصدر والدورة', run:'btn-export-income', print:'btn-print-income' },
  { icon:'stacked_line_chart',title:'الموازنة والتخطيط',          desc:'مقارنة المخطط بالفعلي لكل بند', run:'btn-export-budget' },
  { icon:'compare_arrows',    title:'المقارنة السنوية',           desc:'هذا العام مقابل الماضي (YoY)', run:'btn-export-yoy' },
  { icon:'hourglass_top',     title:'أعمار الديون — العملاء',    desc:'المتأخرات مقسمة بفترات التقادم', run:'btn-export-ar' },
  { icon:'hourglass_bottom',  title:'أعمار الديون — الموردون',   desc:'المستحق على المركز للموردين', run:'btn-export-ap' },
  { icon:'mail',              title:'إرسال تقرير بالبريد',        desc:'أرسل آخر التقارير لإدارة الحسابات', run:'btn-email-report' }
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
            <span class="studio-ico">${REPORT_ICONS[r.icon] || ''}</span>
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
