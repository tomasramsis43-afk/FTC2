/* ============================================================
   arkkan-sync-ui.js — واجهة مزامنة بيانات أركان داخل البرنامج
   ------------------------------------------------------------
   يتواصل مع مسارات الخادم نفسها (/api/arkkan/status و /api/arkkan/fetch)
   التي تجلب البيانات من أركان عبر متصفح مخفي داخل الخادم —
   بلا أي برنامج منفصل، وبضغطة زرار واحدة داخل البرنامج.
   ============================================================ */

/* ── الحقول التي نجلبها من أركان (حقول "كارت العميل") ──
   نعرض في مزامنة أركان فقط العملاء الناقص فيهم أي حقل من هذه السبعة. */
const ARKKAN_FIELDS = ['invoice','courseNumber','date','coursePrice','bagInvoice','bagPurchaseDate','startDate'];
const ARKKAN_FIELD_LABELS = {
  invoice:      'رقم الفاتورة',
  courseNumber: 'رقم الدورة',
  date:         'تاريخ الفاتورة',
  coursePrice:  'قيمة الفاتورة',
  bagInvoice:   'رقم إيصال الحقيبة',
  bagPurchaseDate: 'تاريخ الحقيبة',
  startDate:    'تاريخ الدورة'
};

/* تاريخ الدورة من تبويب الدورات: تاريخ الجلسة المسجّلة بنفس رقم الدورة،
   أو تاريخ الدورة المتوقعة المسجّل على العميل — حتى لا يظهر العميل
   ناقص "تاريخ الدورة" رغم أن جدول الدورات يعرفه. */
function arkkanCourseDate(c){
  if (Array.isArray(courseSessions)) {
    const s = courseSessions.find(x => x.courseNumber === c.courseNumber && x.date);
    if (s && s.date) return s.date; // بصيغة YYYY-MM-DD
  }
  return c.expectedCourseDate || '';
}

function arkkanFieldMissing(c, f) {
  if (f === 'startDate') return !(c.startDate || arkkanCourseDate(c));
  const v = c[f];
  if (v === undefined || v === null || v === '') return true;
  if (f === 'coursePrice') return (Number(v) || 0) === 0; // قيمة صفر = لم تُسجَّل
  return false;
}
function arkkanMissingFields(c) {
  return ARKKAN_FIELDS.filter(f => arkkanFieldMissing(c, f));
}
function clientIsMissingArkkanData(c) {
  return arkkanMissingFields(c).length > 0;
}

/* العميل يُعالج في مزامنة أركان فقط لو ليه رقم مرجعي (salt service: جلب البيانات
   بدون رقم مرجعي لا يحدد العميل بدقة) — بمجرد إضافة رقم مرجعي يظهر تلقائياً */
function clientEligibleForArkkan(c) {
  return !!(c.clientId && String(c.referNum || '').trim());
}

function arkkanAuthHeaders() {
  return SERVER_AUTH_TOKEN ? { 'Authorization': 'Bearer ' + SERVER_AUTH_TOKEN } : {};
}

/* تاريخ أركان (2026/07/21) → صيغة input type=date (2026-07-21) */
function arkkanToInputDate(v) {
  if (!v) return '';
  const m = String(v).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (!m) return v;
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function arkkanCheckReady() {
  try {
    const r = await fetch(API_BASE + '/api/arkkan/status', {
      headers: arkkanAuthHeaders(),
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch { return { ready: false, playwrightInstalled: false }; }
}

async function arkkanFetchOne(clientId, referNum = '') {
  const r = await fetch(API_BASE + '/api/arkkan/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...arkkanAuthHeaders() },
    body: JSON.stringify({ clientId, referNum }),
    signal: AbortSignal.timeout(95000)
  });
  if (!r.ok) {
    let msg = 'فشل السيرفر (' + r.status + ')';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

/* ══════════════════════════════════════════════
   1) جلب بيانات العميل من أركان + حفظ تلقائي
   يُستدعى من زرار "جلب من أركان" في كرت العميل (ملف العميل)
   — بلا فتح نموذج التعديل: يجلب الناقص ويحفظه في البيانات فوراً.
   ══════════════════════════════════════════════ */

/* تحويل قيمة مالية قادمة من أركان إلى رقم نظيف */
function arkkanNumPrice(v){ return parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '')) || v; }

/* يبني التصحيح من بيانات أركان إلى العميل — يملأ الحقول الناقصة فقط.
   لا يمس أياً من التواريخ (تاريخ التسجيل/الفاتورة/الدورة/الحقيبة) ولا
   المبالغ المسجّلة (المدفوع الفعلي في الكرت / قيمة الإيصال الفعلية).
   الحقول المُلئّة: رقم الفاتورة، رقم الدورة، قيمة الفاتورة، رقم إيصال الحقيبة. */
function arkkanPatchFromData(c, data){
  const patch = {};
  if (!c.invoice && data.invoice) patch.invoice = data.invoice;
  if (!c.courseNumber && data.courseNumber) patch.courseNumber = data.courseNumber;
  if (!c.bagInvoice && data.bagInvoice) patch.bagInvoice = data.bagInvoice;
  if ((c.coursePrice === undefined || c.coursePrice === '' || c.coursePrice === 0) && data.coursePrice)
    patch.coursePrice = arkkanNumPrice(data.coursePrice);
  // تاريخ الدورة يُجلب من تبويب الدورات (محلياً) لا من أركان
  if (!c.startDate) { const cd = arkkanCourseDate(c); if (cd) patch.startDate = cd; }
  return patch;
}

/* يجلب بيانات العميل من أركان وقدّمها على الحقول الناقصة واحد لواحد
   (نفس منطق المزامنة)، ثم يحفظ الكائن في الخادم تلقائياً. */
async function arkkanFetchAndAutoUpdate(clientId, referNum = '') {
  const data = await arkkanFetchOne(clientId, referNum); // يرمي خطأ لو فشل
  const idx = clients.findIndex(x => x.clientId === clientId);
  if (idx === -1) throw new Error('العميل غير موجود في القائمة');

  const c = clients[idx];
  const patch = arkkanPatchFromData(c, data);

  if (Object.keys(patch).length > 0) {
    Object.assign(clients[idx], patch);
    if (typeof saveClients === 'function') await saveClients();
  }
  return { updated: Object.keys(patch).length, client: clients[idx] };
}

/* معالج زر "جلب من أركان" الموجود في كرت العميل */
async function arkkanFetchCardButton(id, btn) {
  const c = clients.find(x => x.id === id);
  if (!c) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  if (!c.clientId) { showToast('لا يوجد رقم هوية لهذا العميل', 'error'); return; }

  btn.disabled = true;
  const oldLabel = btn.innerHTML;
  btn.textContent = '⏳ جاري الجلب والحفظ...';

  try {
    const res = await arkkanFetchAndAutoUpdate(c.clientId, c.referNum || '');
    if (res.updated > 0) {
      showToast(`✅ تم جلب وحفظ ${res.updated} حقل من أركان`, 'success');
      if (typeof openClientWorkspace === 'function') openClientWorkspace(c.id); // تحديث الكارت فوراً
    } else {
      showToast('بيانات الكارت مكتملة بالفعل من أركان — لا جديد', 'info');
    }
  } catch (err) {
    showToast('خطأ جلب بيانات أركان: ' + String(err.message).slice(0, 90), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldLabel;
  }
}

/* ══════════════════════════════════════════════
   2) صفحة المزامنة الكاملة (Bulk Sync)
   ══════════════════════════════════════════════ */
let _arkkanBulkRunning = false;
let _arkkanBulkStop = false;

function renderArkkanSyncTable() {
  const tbody = $('#arkkan-sync-tbody');
  if (!tbody) return;
  const missing = (clients || []).filter(c => clientEligibleForArkkan(c) && clientIsMissingArkkanData(c));
  const counter = $('#arkkan-bulk-counter');
  if (counter) counter.textContent = `عملاء ناقصي البيانات (بشرط وجود رقم مرجعي): ${missing.length}`;

  tbody.innerHTML = missing.map(c => `
    <tr id="arkkan-row-${escapeHtml(c.clientId)}">
      <td>${escapeHtml(c.clientId)}</td>
      <td>${escapeHtml(c.name || '—')}</td>
      <td class="col-invoice">${escapeHtml(c.invoice || '—')}</td>
      <td class="col-coursenum">${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-date">${escapeHtml(c.date || '—')}</td>
      <td class="col-courseprice">${escapeHtml(String(c.coursePrice ?? '—'))}</td>
      <td class="col-startdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      <td class="col-baginvoice">${escapeHtml(c.bagInvoice || '—')}</td>
      <td class="col-bagdate">${escapeHtml(c.bagPurchaseDate || '—')}</td>
      <td class="col-missing" style="color:#c26511;">${escapeHtml(arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، '))}</td>
      <td id="arkkan-status-${escapeHtml(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
}

async function arkkanUpdateStatus() {
  const el = $('#arkkan-agent-status');
  const btn = $('#btn-arkkan-bulk-start');
  if (!el) return;
  el.className = 'hint hint-info';
  el.innerHTML = '⏳ جاري التحقق من الجاهزية...';

  const st = await arkkanCheckReady();
  if (st.ready) {
    el.className = 'hint hint-success';
    el.innerHTML = '✅ الخادم جاهز — المتصفح المخفي يعمل وسيجلب البيانات مباشرة.';
    if (btn) btn.disabled = false;
  } else if (st.playwrightInstalled === false) {
    el.className = 'hint hint-error';
    el.innerHTML = `❌ مكتبة playwright غير مثبتة في السيرفر. شغّل في مجلد الخادم:<br>
      <code style="font-size:11px; user-select:all;">npm install playwright && npx playwright install chromium</code>`;
    if (btn) btn.disabled = true;
  } else {
    el.className = 'hint hint-info';
    el.innerHTML = '⏳ المتصفح المخفي قيد التجهيز (يستغرق ثوانٍ عادة) — أعد المحاولة بعد لحظات، أو اضغط "بدء المزامنة".';
    if (btn) btn.disabled = false; // fetch يجهّز تلقائياً
  }
}

async function arkkanBulkSync() {
  if (_arkkanBulkRunning) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }

  _arkkanBulkRunning = true;
  _arkkanBulkStop = false;

  const startBtn = $('#btn-arkkan-bulk-start');
  const stopBtn = $('#btn-arkkan-bulk-stop');
  const progress = $('#arkkan-progress-bar');
  const wrap = $('#arkkan-progress-bar-wrap');
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = '';
  if (wrap) wrap.style.display = '';

  const missing = (clients || []).filter(c => clientEligibleForArkkan(c) && clientIsMissingArkkanData(c));
  let done = 0, updated = 0, failed = 0;

  showToast(`بدأت المزامنة: ${missing.length} عميل — سيستغرق وقتاً حسب عدد العملاء`, 'info');

  for (const c of missing) {
    if (_arkkanBulkStop) break;

    const statusEl = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

    try {
      if (!_arkkanBulkRunning) break;
      const data = await arkkanFetchOne(c.clientId, c.referNum || '');
      const patch = arkkanPatchFromData(c, data);

      if (Object.keys(patch).length > 0) {
        const idx = clients.findIndex(x => x.clientId === c.clientId);
        if (idx !== -1) Object.assign(clients[idx], patch);
        if (typeof saveClients === 'function') await saveClients();
        updated++;
        arkkanRefreshRowCells(clients[clients.findIndex(x => x.clientId === c.clientId)] || c);
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;
      } else {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
      }
    } catch (err) {
      failed++;
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
    }

    done++;
    if (progress) progress.style.width = `${Math.round(done / Math.max(missing.length, 1) * 100)}%`;
    const counter = $('#arkkan-bulk-counter');
    if (counter) counter.textContent = `✅ ${updated} محدّث · ❌ ${failed} فشل · ${done}/${missing.length}`;

    if (!_arkkanBulkStop) await new Promise(r => setTimeout(r, 2500));
  }

  _arkkanBulkRunning = false;
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
  if (wrap) wrap.style.display = 'none';
  renderArkkanSyncTable();
  showToast(`اكتملت المزامنة: ${updated} محدّث، ${failed} فشل`, updated > 0 ? 'success' : 'info');
}

/* أداة تأمين لأي id في محدد CSS */
function cssEscapeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/* تحديث خلايا صف العميل بالبيانات الحالية (بعد كل جلب ناجح) */
function arkkanRefreshRowCells(c) {
  const row = document.querySelector(`#arkkan-row-${cssEscapeId(c.clientId)}`);
  if (!row) return;
  const set = (sel, val) => { const el = row.querySelector(sel); if (el) el.textContent = val || '—'; };
  set('.col-invoice', c.invoice);
  set('.col-coursenum', c.courseNumber);
  set('.col-date', c.date);
  set('.col-courseprice', c.coursePrice);
  set('.col-startdate', c.startDate || arkkanCourseDate(c));
  set('.col-baginvoice', c.bagInvoice);
  set('.col-bagdate', c.bagPurchaseDate);
  const missEl = row.querySelector('.col-missing');
  if (missEl) missEl.textContent = arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، ');
}

/* عند فتح تبويب مزامنة أركان: نعرض الجدول ونحدّث الحالة */
document.addEventListener('click', () => {
  if (document.querySelector('#view-arkkan-sync')?.classList?.contains('active')) {
    renderArkkanSyncTable();
  }
});

document.addEventListener('click', e => {
  if (e.target.closest('#btn-arkkan-check-agent')) { arkkanUpdateStatus(); return; }
  if (e.target.closest('#btn-arkkan-bulk-start')) { arkkanBulkSync(); return; }
  if (e.target.closest('#btn-arkkan-bulk-stop')) { _arkkanBulkStop = true; return; }
});

/* ربط زر التبويب بالرسم (نفس نمط بقية الشاشات) */
function initArkkanSyncView() {
  const navBtn = document.querySelector('nav.tabs button[data-view="arkkan-sync"]');
  if (navBtn) {
    navBtn.addEventListener('click', () => {
      renderArkkanSyncTable();
      arkkanUpdateStatus();
    });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initArkkanSyncView);
else initArkkanSyncView();