/* ============================================================
   arkkan-sync-ui.js — واجهة مزامنة أركان داخل FTC2
   ============================================================
   يتواصل مع arkkan-agent.js الشغّال محلياً على localhost:9955
   ويستخدم نظام تحديث العملاء الموجود في FTC2 مباشرة.
   ============================================================ */

const ARKKAN_AGENT = 'http://localhost:9955';

// ── الحقول التي نجلبها من أركان ──
const ARKKAN_FIELDS = ['invoice','courseNumber','date','coursePrice','bagInvoice','bagPurchaseDate','startDate'];

function clientIsMissingArkkanData(c) {
  return ARKKAN_FIELDS.some(f => !c[f]);
}

// ══════════════════════════════════════════════
//  فحص اتصال الـ Agent
// ══════════════════════════════════════════════
async function arkkanCheckAgent() {
  try {
    const r = await fetch(`${ARKKAN_AGENT}/ping`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function arkkanUpdateAgentStatus() {
  const el = $('#arkkan-agent-status');
  const btn = $('#btn-arkkan-bulk-start');
  if (!el) return;
  const ok = await arkkanCheckAgent();
  if (ok) {
    el.className = 'hint hint-success';
    el.innerHTML = '✅ العميل المحلي (arkkan-agent) يعمل وجاهز للمزامنة.';
    if (btn) btn.disabled = false;
  } else {
    el.className = 'hint hint-error';
    el.innerHTML = `❌ العميل المحلي غير متصل — شغّل <b>arkkan-agent.js</b> على جهازك أولاً:<br>
      <code style="font-size:11px; user-select:all;">node arkkan-agent.js</code>`;
    if (btn) btn.disabled = true;
  }
}

// ══════════════════════════════════════════════
//  جلب بيانات عميل واحد من الـ Agent
// ══════════════════════════════════════════════
async function arkkanFetchOne(clientId, referNum = '') {
  const r = await fetch(`${ARKKAN_AGENT}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, referNum }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`Agent error: ${r.status}`);
  return r.json();
}

// ══════════════════════════════════════════════
//  زرار "جلب من أركان" في نموذج العميل
// ══════════════════════════════════════════════
document.addEventListener('click', async e => {
  if (!e.target.closest('#btn-arkkan-fetch')) return;
  const btn = $('#btn-arkkan-fetch');
  const clientId = $('#f-id')?.value?.trim();
  if (!clientId) { showToast('أدخل رقم الهوية أولاً', 'error'); return; }

  const agentOk = await arkkanCheckAgent();
  if (!agentOk) {
    showToast('arkkan-agent غير متصل — شغّله على جهازك أولاً', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ جاري الجلب...';

  try {
    const referNum = $('#f-refer')?.value?.trim() || '';
    const data = await arkkanFetchOne(clientId, referNum);

    let filled = 0;
    // نملأ فقط الحقول الفاضية
    if (!$('#f-invoice')?.value && data.invoice)         { $('#f-invoice').value = data.invoice; filled++; }
    if (!$('#f-coursenum')?.value && data.courseNumber)  { $('#f-coursenum').value = data.courseNumber; filled++; }
    if (!$('#f-date')?.value && data.date)               { $('#f-date').value = data.date; filled++; }
    if (!$('#f-courseprice')?.value && data.coursePrice) { $('#f-courseprice').value = data.coursePrice; filled++; }
    if (!$('#f-baginvoice')?.value && data.bagInvoice)   { $('#f-baginvoice').value = data.bagInvoice; filled++; }

    // تحديث حقل تاريخ الحقيبة لو موجود
    if (data.bagPurchaseDate) {
      const idx = clients.findIndex(c => c.clientId === clientId);
      if (idx !== -1 && !clients[idx].bagPurchaseDate) {
        clients[idx].bagPurchaseDate = data.bagPurchaseDate;
      }
    }

    if (filled > 0) {
      showToast(`✅ تم جلب ${filled} حقل من أركان`, 'success');
    } else {
      showToast('لم تُجلب بيانات جديدة (قد تكون مكتملة أصلاً)', 'info');
    }
  } catch (err) {
    showToast(`خطأ في جلب البيانات: ${err.message.slice(0, 80)}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M18 2v4h4"/></svg> جلب من أركان`;
  }
});

// ══════════════════════════════════════════════
//  صفحة المزامنة الكاملة (Bulk Sync)
// ══════════════════════════════════════════════
let _arkkanBulkRunning = false;
let _arkkanBulkStop    = false;

function renderArkkanSyncTable() {
  const tbody = $('#arkkan-sync-tbody');
  if (!tbody) return;
  const missing = (clients || []).filter(c => c.clientId && clientIsMissingArkkanData(c));
  const counter = $('#arkkan-bulk-counter');
  if (counter) counter.textContent = `عملاء ناقصين: ${missing.length}`;

  tbody.innerHTML = missing.map(c => `
    <tr id="arkkan-row-${c.clientId}">
      <td>${escapeHtml(c.clientId)}</td>
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.invoice || '—')}</td>
      <td>${escapeHtml(c.courseNumber || '—')}</td>
      <td>${escapeHtml(c.date || '—')}</td>
      <td>${escapeHtml(String(c.coursePrice || '—'))}</td>
      <td>${escapeHtml(c.bagInvoice || '—')}</td>
      <td>${escapeHtml(c.bagPurchaseDate || '—')}</td>
      <td id="arkkan-status-${c.clientId}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
}

async function arkkanBulkSync() {
  if (_arkkanBulkRunning) return;
  _arkkanBulkRunning = true;
  _arkkanBulkStop    = false;

  const startBtn = $('#btn-arkkan-bulk-start');
  const stopBtn  = $('#btn-arkkan-bulk-stop');
  const progress = $('#arkkan-progress-bar');
  const wrap     = $('#arkkan-progress-bar-wrap');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn)  stopBtn.style.display  = '';
  if (wrap)     wrap.style.display     = '';

  const missing = (clients || []).filter(c => c.clientId && clientIsMissingArkkanData(c));
  let done = 0, updated = 0, failed = 0;

  for (const c of missing) {
    if (_arkkanBulkStop) break;

    const statusEl = $(`#arkkan-status-${c.clientId}`);
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

    try {
      const data = await arkkanFetchOne(c.clientId, c.referNum || '');
      const patch = {};
      if (!c.invoice        && data.invoice)        patch.invoice        = data.invoice;
      if (!c.courseNumber   && data.courseNumber)   patch.courseNumber   = data.courseNumber;
      if (!c.date           && data.date)           patch.date           = data.date;
      if (!c.coursePrice    && data.coursePrice)    patch.coursePrice    = parseFloat(data.coursePrice) || data.coursePrice;
      if (!c.bagInvoice     && data.bagInvoice)     patch.bagInvoice     = data.bagInvoice;
      if (!c.bagPurchaseDate&& data.bagPurchaseDate)patch.bagPurchaseDate= data.bagPurchaseDate;
      if (!c.startDate      && data.startDate)      patch.startDate      = data.startDate;

      if (Object.keys(patch).length > 0) {
        // تحديث في الـ clients array المحلي
        const idx = clients.findIndex(x => x.clientId === c.clientId);
        if (idx !== -1) Object.assign(clients[idx], patch);

        // حفظ في FTC2 بالطريقة المعتادة (نفس saveClient)
        if (typeof saveClientById === 'function') {
          await saveClientById(c.clientId);
        }

        updated++;
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;

        // تحديث الصف في الجدول
        const row = $(`#arkkan-row-${c.clientId}`);
        if (row) {
          row.cells[2].textContent = clients[clients.findIndex(x => x.clientId === c.clientId)]?.invoice || '—';
          row.cells[3].textContent = clients[clients.findIndex(x => x.clientId === c.clientId)]?.courseNumber || '—';
          row.cells[4].textContent = clients[clients.findIndex(x => x.clientId === c.clientId)]?.date || '—';
        }
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
      }
    } catch (err) {
      failed++;
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
    }

    done++;
    if (progress) progress.style.width = `${Math.round(done / missing.length * 100)}%`;
    const counter = $('#arkkan-bulk-counter');
    if (counter) counter.textContent = `✅ ${updated} محدّث · ❌ ${failed} فشل · ${done}/${missing.length}`;

    // تأخير بين كل عميل
    if (!_arkkanBulkStop) await new Promise(r => setTimeout(r, 2500));
  }

  _arkkanBulkRunning = false;
  if (startBtn) startBtn.style.display = '';
  if (stopBtn)  stopBtn.style.display  = 'none';
  showToast(`اكتملت المزامنة: ${updated} محدّث، ${failed} فشل`, updated > 0 ? 'success' : 'info');
}

// ══════════════════════════════════════════════
//  ربط الأحداث
// ══════════════════════════════════════════════
document.addEventListener('click', e => {
  if (e.target.closest('#btn-arkkan-check-agent'))  { arkkanUpdateAgentStatus(); return; }
  if (e.target.closest('#btn-arkkan-bulk-start'))   { arkkanBulkSync(); return; }
  if (e.target.closest('#btn-arkkan-bulk-stop'))    { _arkkanBulkStop = true; return; }
});

// تحديث الجدول عند تغيّر بيانات العملاء
const _origRenderForArkkan = typeof renderTable === 'function' ? renderTable : null;
function refreshArkkanView() {
  if ($('#view-arkkan-sync')?.classList.contains('active')) {
    renderArkkanSyncTable();
  }
}

// عند فتح تبويب مزامنة أركان
document.addEventListener('viewChanged', e => {
  if (e?.detail?.view === 'arkkan-sync') {
    renderArkkanSyncTable();
    arkkanUpdateAgentStatus();
  }
});

// ── saveClientById: يستدعي saveClients() العادية بعد تحديث الـ clients array ──
async function saveClientById(clientId) {
  // saveClients() بتحفظ الـ array كاملة — كافية هنا
  if (typeof saveClients === 'function') {
    await saveClients();
  }
}
