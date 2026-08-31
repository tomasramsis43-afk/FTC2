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
  // تاريخ الحقيبة يُملأ فقط لو كان فاضياً — لا يمس أي تاريخ مسجّل مسبقاً
  if (!c.bagPurchaseDate && data.bagPurchaseDate) patch.bagPurchaseDate = data.bagPurchaseDate;
  // قيمة الفاتورة تُحدَّث دائماً من القيمة الفعلية بالإيصال (data.coursePrice)
  // عند كل جلب/مزامنة — نُحدّث شيت العملاء (coursePrice) وشيت فواتير الدورات
  // (receiptActualValue) معاً للقيمة الفعلية الأخيرة، بلا شرط "فاضية".
  if (data.coursePrice) {
    patch.coursePrice = arkkanNumPrice(data.coursePrice);
    patch.receiptActualValue = arkkanNumPrice(data.coursePrice);
  }
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
    // لو رحّلنا receiptActualValue من أركان → نطلق القيد المزدوج تلقائياً
    if (patch.receiptActualValue !== undefined && typeof autoPostCourseInvoice === 'function')
      autoPostCourseInvoice(clients[idx]);
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

/* زر "جلب" بجانب صف واحد في شيت المزامنة: يجلب بيانات هذا العميل فقط
   ويملأ الناقص ويحفظ — دون الحاجة للمزامنة الكاملة لكل العملاء. */
async function arkkanSyncOne(clientId, btn) {
  const c = clients.find(x => x.clientId === clientId);
  if (!c) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }

  const statusEl = $(`#arkkan-status-${cssEscapeId(clientId)}`);
  const oldLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '⏳';
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

  try {
    const data = await arkkanFetchOne(clientId, c.referNum || '');
    const patch = arkkanPatchFromData(c, data);
    if (Object.keys(patch).length > 0) {
      Object.assign(c, patch); // c هو نفس الكائن داخل clients
      if (typeof saveClients === 'function') await saveClients();
      arkkanRefreshRowCells(c);
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;
      showToast(`✅ تم جلب وحفظ ${Object.keys(patch).length} حقل من أركان`, 'success');
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
      showToast('لا توجد بيانات جديدة ناقصة لهذا العميل', 'info');
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
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

/* عملاء ناقصي البيانات المؤهلون — مرتبين من الأحدث تسجيلاً (c.date) إلى الأقدم */
function arkkanMissingClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && clientIsMissingArkkanData(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

function renderArkkanSyncTable() {
  const tbody = $('#arkkan-sync-tbody');
  if (!tbody) return;
  const missing = arkkanMissingClients();
  const counter = $('#arkkan-bulk-counter');
  if (counter) counter.textContent = `عملاء ناقصي البيانات (بشرط وجود رقم مرجعي): ${missing.length}`;

  tbody.innerHTML = missing.map(c => `
    <tr id="arkkan-row-${escapeHtml(c.clientId)}">
      <td>${escapeHtml(c.clientId)}</td>
      <td>${escapeHtml(c.name || '—')}</td>
      <td class="col-invoice">${escapeHtml(c.invoice || '—')}</td>
      <td class="col-coursenum">${escapeHtml(c.courseNumber || '—')}</td>
      <td class="col-date">${escapeHtml(c.date || '—')}</td>
      <td class="col-courseprice">${escapeHtml(String(c.receiptActualValue !== undefined && c.receiptActualValue !== null && c.receiptActualValue !== '' ? c.receiptActualValue : (c.coursePrice ?? '—')))}</td>
      <td class="col-startdate">${escapeHtml(c.startDate || arkkanCourseDate(c) || '—')}</td>
      <td class="col-baginvoice">${escapeHtml(c.bagInvoice || '—')}</td>
      <td class="col-bagdate">${escapeHtml(c.bagPurchaseDate || '—')}</td>
      <td class="col-missing" style="color:#c26511;">${escapeHtml(arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، '))}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;" title="جلب بيانات هذا العميل فقط من أركان (بدون المزامنة الكاملة)">جلب</button></td>
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
    const mem = st.memory;
    let memTxt = '';
    if (mem) {
      const freePct = mem.totalMB ? Math.round((mem.freeMB / mem.totalMB) * 100) : 0;
      const low = freePct < 12;
      const workersTxt = st.workers && st.maxWorkers ? ` · عوامل التوازي: ${st.workers}/${st.maxWorkers}` : '';
      memTxt = ` · ذاكرة السيرفر: ${mem.freeMB}MB حر من ${mem.totalMB}MB (${freePct}%)${low ? ' <span style="color:#e84118;">— منخفضة، الجلب سيعمل بعامل واحد حفاظاً على الاستقرار</span>' : ''}${workersTxt}`;
    }
    el.innerHTML = '✅ الخادم جاهز — المتصفح المخفي يعمل وسيجلب البيانات مباشرة.' + memTxt;
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

  const all = arkkanMissingClients();
  /* استئناف: من فُحصوا حديثاً وبياناتهم لسه ناقصة لا نعيد سؤال أركان عنهم — يكمّل من حيث توقف */
  const missing = all.filter(c => {
    const m = c.arkkanDataCheck;
    return !(m && Date.now() - m < arkkanResumeMs());
  });
  const total = missing.length;
  const skipped0 = all.length - total;
  let done = 0, updated = 0, failed = 0;

  showToast(`بدأت المزامنة: ${total} عميل${skipped0 ? ` (تخطّي ${skipped0} فُحصوا حديثاً)` : ''} — سيستغرق وقتاً حسب عدد العملاء`, 'info');

  /* إظهار حالة المتخطّين في جدولهم فوراً */
  for (const c of all) {
    if (missing.includes(c)) continue;
    const el = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
    if (el) el.innerHTML = '<span style="color:var(--text-muted);">⏭️ فُحص حديثاً — تخطٍّ</span>';
  }

  /* حفظ متسلسل دائماً (حتى مع توازي الجلب) حتى لا تتداخل كتابة العملاء
     بين عدة طلبات في نفس اللحظة (خاصة قبل تثبيت الـ baseline). */
  let saveChain = Promise.resolve();
  const queueSave = () => {
    const p = saveChain.then(() => (typeof saveClients === 'function' ? saveClients() : null));
    saveChain = p.then(() => {}, () => {});
    return p;
  };

  /* طلبات متوازية — تستفيد من صفحات أركان المتعددة على السيرفر (ARKKAN_CONCURRENCY)؛
     عدّلها: window.ARKKAN_BULK_CONCURRENCY = 1. */
  const POOL = Math.max(1, Math.min(4, parseInt(window.ARKKAN_BULK_CONCURRENCY || '2', 10) || 2));
  let workerIdx = 0;

  const processOne = async () => {
    while (!_arkkanBulkStop) {
      const ci = workerIdx++;
      if (ci >= total) return;
      const c = missing[ci];

      const statusEl = $(`#arkkan-status-${cssEscapeId(c.clientId)}`);
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--gold);">⏳ جاري الجلب...</span>';

      try {
        if (!_arkkanBulkRunning) break;
        const data = await arkkanFetchOne(c.clientId, c.referNum || '');
        const patch = arkkanPatchFromData(c, data);

        if (Object.keys(patch).length > 0) {
          const idx = clients.findIndex(x => x.clientId === c.clientId);
          if (idx !== -1) {
            Object.assign(clients[idx], patch);
            clients[idx].arkkanDataCheck = Date.now();
          }
          await queueSave();
          updated++;
          arkkanRefreshRowCells(clients[clients.findIndex(x => x.clientId === c.clientId)] || c);
          if (statusEl) statusEl.innerHTML = `<span style="color:var(--success, green);">✅ تم (${Object.keys(patch).length} حقل)</span>`;
        } else {
          /* سجّل الفحص على العميل حتى لا يُعاد سؤاله في نفس الفترة
             (يُحفظ في الحفظة الختامية بعد انتهاء التشغيل) */
          const idx0 = clients.findIndex(x => x.clientId === c.clientId);
          if (idx0 !== -1) clients[idx0].arkkanDataCheck = Date.now();
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">لا جديد</span>';
        }
      } catch (err) {
        failed++;
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">❌ فشل</span>`;
      }

      done++;
      if (progress) progress.style.width = `${Math.round(done / Math.max(total, 1) * 100)}%`;
      const counter = $('#arkkan-bulk-counter');
      if (counter) counter.textContent = `✅ ${updated} محدّث · ❌ ${failed} فشل · ${done}/${total}`;
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, total) }, () => processOne()));
  await queueSave(); // حفظ علامات الفحص المتبقية (لا جديد)

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

/* ══════════════════════════════════════════════
   3) نتائج الاختبارات (الرسوب والنجاح)
   صندوق مستقل أسفل صندوق المزامنة — يجلب من أركان آخر 4
   محاولات اختبار لكل عميل (بعدة إعادة) + تاريخ آخر اختبار.
   ══════════════════════════════════════════════ */

async function arkkanExamFetchOne(clientId, referNum = '') {
  const r = await fetch(API_BASE + '/api/arkkan/exams', {
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

/* يبني التصحيح من بيانات نتائج الاختبار إلى العميل */
function arkkanPatchExamsFromData(c, data) {
  return {
    examAttempts: Array.isArray(data.attempts) ? data.attempts : [],
    examLastDate: data.lastDate || '',
    examResult: data.lastResult || ''
  };
}

/* العميل ناجح = نتيجة آخر اختبار "ناجح" → اكتمل جلبه وينتقل إلى صندوق النجاح */
function arkkanExamPassed(c) {
  return String(c.examResult || '').includes('ناجح');
}

/* العميل راسب = آخر محاولة (examResult) أو أي محاولة مخزّنة "راسب" → ينتقل إلى صندوق الراسبين.
   بعض العملاء القدامى محفوظ عندهم "راسب" في المحاولات دون examResult — نكشفه من المحاولات أيضاً */
function arkkanExamFailed(c) {
  if (arkkanExamPassed(c)) return false;
  if (String(c.examResult || '').includes('راسب')) return true;
  return (Array.isArray(c.examAttempts) ? c.examAttempts : [])
    .some(a => String((a && a.r) || '').includes('راسب'));
}

/* صندوق النتائج الرئيسي: بلا نتيجة وبلا تاريخ اختبار (لم يُسجّل له أي اختبار بعد) */
function arkkanExamClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && !arkkanExamPassed(c) && !arkkanExamFailed(c) && !(c.examLastDate || '').trim())
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* صندوق "يحتاج إلى اختبار": لديه تاريخ آخر اختبار لكن كل النتائج فاضية
   (لا نجاح ولا رسوب سابق) — يُعيد الاختبار حتى تظهر نتيجة */
function arkkanExamNeedingClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && !arkkanExamPassed(c) && !arkkanExamFailed(c) && !!(c.examLastDate || '').trim())
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* عملاء صندوق النجاح: من أكملوا بالنجاح (لا يُعرض لهم جلب أصلاً) */
function arkkanExamPassedClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && arkkanExamPassed(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* عملاء صندوق الراسبين: صندوق مستقل يجلب لنفسه، وإذا نجحوا ينتقلون للنجاح */
function arkkanExamFailedClients() {
  return (clients || [])
    .filter(c => clientEligibleForArkkan(c) && arkkanExamFailed(c))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}

/* خلية نتيجة: ناجح أخضر / راسب أحمر */
function arkkanExamCell(v) {
  const s = String(v || '').trim();
  if (!s) return '<span style="color:var(--text-muted);">—</span>';
  const color = s.includes('ناجح') ? 'var(--success, green)' : s.includes('راسب') ? 'var(--danger, red)' : 'inherit';
  return `<span style="color:${color}; font-weight:600;">${escapeHtml(s)}</span>`;
}

/* آخر اختبار تم للعميل: يقرأ examResult (آخر نتيجة)، ولو فاضي يرجع لأول محاولة مخزّنة
   لها نتيجة ناجح/راسب — نفس معيار التصنيف المستخدم في صناديق نتائج الاختبارات */
function arkkanExamStatusOf(c) {
  const er = String(c.examResult || '').trim();
  if (er) return { r: er, d: c.examLastDate || '' };
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  const last = att.slice().reverse().find(a => a && String(a.r || '').trim() && (String(a.r).includes('ناجح') || String(a.r).includes('راسب')));
  if (last) return { r: last.r, d: last.d || '' };
  return null;
}

/* شارة حالة آخر اختبار (ناجح أخضر / راسب أحمر) تُعرض في شيت العملاء وفي كرت العميل */
function arkkanExamBadgeHtml(c) {
  const s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  if (!s) return '';
  const r = String(s.r).trim();
  const tip = `آخر اختبار تم: ${r}${s.d ? ' — بتاريخ ' + s.d : ''}`;
  if (r.includes('ناجح')) return `<span class="stamp paid" title="${escapeHtml(tip)}">ناجح ✓</span>`;
  if (r.includes('راسب')) return `<span class="stamp owe" title="${escapeHtml(tip)}">راسب</span>`;
  return '';
}

/* محتوى قسم "نتيجة الاختبار" داخل كرت العميل — آخر نتيجة + التاريخ + المحاولات الأخيرة */
function arkkanExamCardContent(c) {
  const s = typeof arkkanExamStatusOf === 'function' ? arkkanExamStatusOf(c) : null;
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  const last = s ? String(s.r).trim() : '';
  const badge = last.includes('ناجح')
    ? '<span class="stamp paid">ناجح ✓</span>'
    : last.includes('راسب')
      ? '<span class="stamp owe">راسب</span>'
      : `<span class="stamp" style="color:var(--text-muted);">${escapeHtml(last || 'لم يُختبَر بعد')}</span>`;
  const d = (s && s.d) || c.examLastDate || '';
  const dateTxt = d ? (typeof formatDateDisplay === 'function' ? formatDateDisplay(d) : escapeHtml(d)) : '—';
  const attempts = att.length
    ? `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">` + att.slice(0, 4).map((a, i) => {
        const r = String((a && a.r) || '—').trim();
        const cls = r.includes('ناجح') ? 'paid' : r.includes('راسب') ? 'owe' : '';
        return `<span class="stamp ${cls}" title="محاولة ${i + 1} — ${escapeHtml((a && a.d) || '')}">م${i + 1}: ${escapeHtml(r)}</span>`;
      }).join('') + `</div>`
    : '';
  return `<div class="cw-grid">
      <div class="cw-item"><small>آخر نتيجة</small><b>${badge}</b></div>
      <div class="cw-item"><small>تاريخ آخر اختبار</small><b>${dateTxt}</b></div>
    </div>${attempts}`;
}

function renderArkkanExamsTable() {
  const tbody = $('#arkkan-exams-tbody');
  const nbody = $('#arkkan-exams-needing-tbody');
  const pbody = $('#arkkan-exams-passed-tbody');
  const fbody = $('#arkkan-exams-failed-tbody');
  const noResult = arkkanExamClients();          // صندوق النتائج: بلا نتيجة وبلا تاريخ اختبار
  const needing = arkkanExamNeedingClients();    // يحتاج إلى اختبار: تاريخ اختبار وكل النتائج فاضية
  const passed = arkkanExamPassedClients();      // صندوق النجاح
  const failed = arkkanExamFailedClients();      // صندوق الراسبين (مستقل بجلبه)

  const counter = $('#arkkan-exams-counter');
  if (counter) counter.textContent = `بلا نتيجة ولا تاريخ اختبار بعد: ${noResult.length}`;
  const ncounter = $('#arkkan-exams-needing-counter');
  if (ncounter) ncounter.textContent = `بلا نتيجة (لديهم تاريخ اختبار فقط): ${needing.length}`;
  const pcounter = $('#arkkan-exams-passed-counter');
  if (pcounter) pcounter.textContent = `الناجحون (اكتمل جلب نتائجهم): ${passed.length}`;
  const fcounter = $('#arkkan-exams-failed-counter');
  if (fcounter) fcounter.textContent = `الراسبون (صندوق مستقل — يجلب لنفسه): ${failed.length}`;

  const cells = c => {
    const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
    return [0, 1, 2, 3].map(i =>
      `<td class="col-exam-attempt">${att[i] ? arkkanExamCell(att[i].r) : '<span style="color:var(--text-muted);">—</span>'}</td>`
    ).join('');
  };

  if (tbody) {
    tbody.innerHTML = noResult.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      ${cells(c)}
      <td class="col-examdate">${escapeHtml(c.examLastDate || '—')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }

  if (nbody) {
    nbody.innerHTML = needing.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      ${cells(c)}
      <td class="col-examdate">${escapeHtml(c.examLastDate || '—')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }

  if (pbody) {
    pbody.innerHTML = passed.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      ${cells(c)}
      <td class="col-examdate">${escapeHtml(c.examLastDate || '—')}</td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--success, green); font-weight:600;">ناجح ✓</span></td>
    </tr>`).join('');
  }

  if (fbody) {
    fbody.innerHTML = failed.map(c => `
    <tr id="arkkan-exam-row-${cssEscapeId(c.clientId)}">
      <td>${escapeHtml(c.name || '—')}</td>
      <td>${escapeHtml(c.clientId)}</td>
      ${cells(c)}
      <td class="col-examdate">${escapeHtml(c.examLastDate || '—')}</td>
      <td><button type="button" class="btn btn-ghost btn-sm" data-arkkan-exam-one="${escapeHtml(c.clientId)}" style="padding:2px 12px; font-size:12px;">جلب</button></td>
      <td id="arkkan-exam-status-${cssEscapeId(c.clientId)}"><span style="color:var(--text-muted);">في الانتظار</span></td>
    </tr>`).join('');
  }
}

function arkkanRefreshExamCells(c) {
  const row = document.querySelector(`#arkkan-exam-row-${cssEscapeId(c.clientId)}`);
  if (!row) return;
  const att = Array.isArray(c.examAttempts) ? c.examAttempts : [];
  [...row.querySelectorAll('.col-exam-attempt')].forEach((el, i) => {
    el.innerHTML = att[i] ? arkkanExamCell(att[i].r) : '<span style="color:var(--text-muted);">—</span>';
  });
  const de = row.querySelector('.col-examdate');
  if (de) de.textContent = c.examLastDate || '—';
}

async function arkkanExamSyncOne(clientId, btn) {
  const c = (clients || []).find(x => String(x.clientId) === String(clientId));
  if (!c) return;
  if (arkkanExamPassed(c)) { showToast('العميل ناجح — نتائجه مكتملة في صندوق النجاح', 'info'); return; }
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
  try {
    const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
    const patch = arkkanPatchExamsFromData(c, data);
    const idx = clients.findIndex(x => String(x.clientId) === String(clientId));
    if (idx !== -1) Object.assign(clients[idx], patch);
    if (typeof saveClients === 'function') await saveClients();
    _examSession[String(clientId)] = arkkanExamSig(clients[idx] || c);
    const passed = idx !== -1 && arkkanExamPassed(clients[idx]);
    // إعادة الرسم: الناجح ينتقل إلى صندوق النجاح ويختفي من قائمة الجلب
    renderArkkanExamsTable();
    const st = $(`#arkkan-exam-status-${cssEscapeId(clientId)}`);
    if (st) st.innerHTML = passed
      ? '<span style="color:var(--success, green);">✅ ناجح — انتقل إلى صندوق النجاح</span>'
      : '<span style="color:var(--success, green);">✅ تم</span>';
  } catch (err) {
    const st = $(`#arkkan-exam-status-${cssEscapeId(clientId)}`);
    if (st) st.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">ظإî ${escapeHtml(err.message.slice(0, 60))}</span>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'جلب'; }
  }
}

/* مذكّرة الجلسة: آخر نتيجة جلب لكل عميل — عند إعادة الجلب لا يُعاد جلب من لم تتغير بياناته */
const _examSession = {};
function arkkanExamSig(c) {
  return JSON.stringify([
    Array.isArray(c.examAttempts) ? c.examAttempts : [],
    c.examLastDate || '',
    c.examResult || ''
  ]);
}

/* نافذة الاستئناف: علامة فحص محفوظة على العميل نفسه (arkkanExamCheck / arkkanDataCheck)
   تجعل إعادة تشغيل الجلب/المزامنة تتخطى من فُحصوا حديثاً وبياناتهم ثابتة — حتى بعد
   تحديث الصفحة أو إغلاقها — فيكمل من حيث توقف بدل إعادة الجلب من الصفر.
   المدة قابلة للضبط من حقل "فترة تخطي الفحص المُعاد (ساعات)" في هذا التبويب
   وتُحفظ في settings.arkkanResumeHours — أو يدوياً عبر window.ARKKAN_RESUME_HOURS؛
   الافتراضي 24 ساعة. */
function arkkanResumeMs() {
  let h = settings && settings.arkkanResumeHours;
  if (!(Number(h) > 0)) h = parseInt(window.ARKKAN_RESUME_HOURS || '24', 10) || 24;
  return Number(h) * 3600 * 1000;
}

/* مزامنة حقل "فترة تخطي الفحص المُعاد" في التبويب مع الإعداد المحفوظ */
function arkkanResumeFieldSync() {
  const el = $('#set-arkkan-resume-hours');
  if (!el) return;
  const h = settings && settings.arkkanResumeHours;
  const v = Number(h) > 0 ? Number(h) : (parseInt(window.ARKKAN_RESUME_HOURS || '24', 10) || 24);
  if (String(el.value) !== String(v)) el.value = v;
}

/* نافذة استئناف المقارنة مع أركان — عدد ساعات مستقل تماماً عن نافذة الجلب:
   علامة arkkanCompareCheck تُحفظ على العميل بعد فحصه بالمقارنة وتجعله يُتخطى
   خلال هذه النافذة عند إعادة تشغيل مقارنة موقوفة (فيكمل من حيث توقف).
   تُضبط من حقل "فترة تخطي المقارنة المُعاد" في التبويب وتُحفظ في
   settings.arkkanCompareResumeHours — أو بـ window.ARKKAN_COMPARE_RESUME_HOURS؛
   الافتراضي 24 ساعة. */
function arkkanCompareResumeMs() {
  let h = settings && settings.arkkanCompareResumeHours;
  if (!(Number(h) > 0)) h = parseInt(window.ARKKAN_COMPARE_RESUME_HOURS || '24', 10) || 24;
  return Number(h) * 3600 * 1000;
}

/* مزامنة حقل "فترة تخطي المقارنة المُعاد" في التبويب مع الإعداد المحفوظ */
function arkkanCompareResumeFieldSync() {
  const el = $('#set-arkkan-compare-resume-hours');
  if (!el) return;
  const h = settings && settings.arkkanCompareResumeHours;
  const v = Number(h) > 0 ? Number(h) : (parseInt(window.ARKKAN_COMPARE_RESUME_HOURS || '24', 10) || 24);
  if (String(el.value) !== String(v)) el.value = v;
}

async function arkkanExamSyncCard(clientId, btn) {
  const c = (clients || []).find(x => String(x.clientId) === String(clientId));
  if (!c) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ المزامنة...'; }
  try {
    const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
    const patch = arkkanPatchExamsFromData(c, data);
    const idx = clients.findIndex(x => String(x.clientId) === String(clientId));
    if (idx !== -1) Object.assign(clients[idx], patch);
    if (typeof saveClients === 'function') await saveClients();
    _examSession[String(clientId)] = arkkanExamSig(clients[idx] || c);
    const exam = arkkanExamStatusOf(clients[idx] || c);
    const has = exam && String(exam.r).trim();
    const msg = has
      ? (String(exam.r).includes('ناجح')
        ? '✅ النتيجة محفّزة: ناجح'
        : String(exam.r).includes('راسب') ? 'النتيجة محدّثة: راسب' : 'تم تحديث النتيجة: ' + String(exam.r))
      : 'تمت المزامنة — لا توجد نتيجة اختبار مسجّلة بعد';
    // تحديث شارة الاسم في شيت العملاء وصناديق النتائج فوراً
    if (typeof renderTable === 'function') renderTable();
    if (typeof renderArkkanExamsTable === 'function') renderArkkanExamsTable();
    const cse = $('#cw-exam-section .cw-exam-content');
    if (cse && typeof arkkanExamCardContent === 'function') cse.innerHTML = arkkanExamCardContent(clients[idx] || c);
    showToast(msg, has ? 'success' : 'info');
  } catch (err) {
    showToast('فشل جلب النتيجة: ' + (err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 مزامنة النتيجة'; }
  }
}

/* حالة كل جلب جماعي منفصلة (صندوق النتائج / صندوق الراسبين) */
const _examBulkStates = {};
function examBulkState(name) {
  return _examBulkStates[name] || (_examBulkStates[name] = { running: false, stop: false });
}

/* مشغّل صندوق عام — جلب (fetch) أو مقارنة (compare) — كل صندوق بعناصره وصفوفه.
   المقارنة: تراجع كل عميل من أركان، توازن المخزَّن بالمستخرج، وتحفظ أي اختلاف تلقائياً */
async function arkkanExamBoxRun({ name, getRows, startSel, stopSel, progressSel, counterSel, doneMsg, mode }) {
  const compare = mode === 'compare';
  const st = examBulkState(name);
  if (st.running) return;
  if (!SERVER_AUTH_TOKEN) { showToast('لا يوجد اتصال بالخادم حالياً', 'error'); return; }

  st.running = true;
  st.stop = false;

  const startBtn = $(startSel);
  const stopBtn = $(stopSel);
  const progress = $(progressSel);
  const wrap = $(progressSel.replace('progress', 'progress-wrap'));
  if (startBtn) startBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = '';
  if (wrap) wrap.style.display = '';

  /* استئناف حقيقي: نستبعد المفحوصين حديثاً *قبل* بدء اللوب (نفس نمط arkkanBulkSync) —
     فلو وقّفت الصندوق وشغّلته تاني، العدّاد وشريط التقدّم يعكسان المتبقي الفعلي فقط،
     بدل ما يعيدا عرض/عدّ كل الصفوف من الأول وهو بيتخطاها بسرعة من جوه اللوب. */
  const rowsAll = getRows();
  const rows = rowsAll.filter(c => {
    const k = String(c.clientId);
    const cur = (clients || []).find(x => String(x.clientId) === k) || c;
    if (compare) {
      const cmpChk = cur && cur.arkkanCompareCheck;
      return !(cmpChk && Date.now() - cmpChk < arkkanCompareResumeMs());
    }
    const sigNow = arkkanExamSig(cur);
    const chk = cur && cur.arkkanExamCheck;
    const resumeSkip = chk && chk.s === sigNow && Date.now() - (chk.t || 0) < arkkanResumeMs();
    return !(resumeSkip || _examSession[k] === sigNow);
  });
  const rowsTotal = rows.length;
  const skipped0 = rowsAll.length - rowsTotal;
  let done = 0, updated = 0, same = 0, failed = 0, skipped = 0;

  showToast((compare ? `بدأت المقارنة مع أركان: ${rowsTotal} عميل` : `بدأ الجلب: ${rowsTotal} عميل`)
    + (skipped0 ? ` (تخطّي ${skipped0} فُحصوا حديثاً)` : ''), 'info');

  const diffText = (cur, srcResult) => {
    const os = arkkanExamStatusOf(cur);
    const oldTxt = os && String(os.r).trim() ? String(os.r) : 'بدون';
    const newTxt = String(srcResult || '').trim() ? String(srcResult) : 'بدون';
    return [oldTxt, newTxt];
  };

  /* حفظ متسلسل دائماً (حتى مع توازي الجلب): يمنع تنافس عاملين على كتابة نسخ
     كاملة من قائمة العملاء في نفس اللحظة (خاصة قبل تثبيت الـ baseline). */
  let saveChain = Promise.resolve();
  const queueSave = () => {
    const p = saveChain.then(() => (typeof saveClients === 'function' ? saveClients() : null));
    saveChain = p.then(() => {}, () => {});
    return p;
  };

  /* طلبات متوازية — تستفيد من صفحات أركان المتعددة على السيرفر (ARKKAN_CONCURRENCY)؛
     عدّلها من أداة المطوّر برقم مختلف: window.ARKKAN_BULK_CONCURRENCY = 1. */
  const POOL = Math.max(1, Math.min(4, parseInt(window.ARKKAN_BULK_CONCURRENCY || '2', 10) || 2));
  let workerIdx = 0;

  const processOne = async () => {
    while (!st.stop) {
      const ci = workerIdx++;
      if (ci >= rowsTotal) return;
      const c = rows[ci];

      const k = String(c.clientId);
      const cur = (clients || []).find(x => String(x.clientId) === k) || c;
      const statusId = `#arkkan-exam-status-${cssEscapeId(k)}`;
      const stEl = $(statusId);

      /* الفلترة الأساسية (المفحوص حديثاً حسب arkkanExamCheck/arkkanCompareCheck) حدثت
         *قبل* بدء اللوب أعلاه. هذا الفحص هنا شبكة أمان فقط لحالة نادرة: عميل تغيّر
         توقيعه (sig) في نفس الجلسة بفعل معالجة صف آخر قبل ما يوصله الدور. */
      const sigNow = arkkanExamSig(cur);

      const skipEl =
        compare
          ? '<span style="color:var(--text-muted);">⏭️ فُورن حديثاً — تخطٍّ</span>'
          : '<span style="color:var(--text-muted);">⏭️ تم سابقاً — بلا تغيير</span>';
      const skipAndContinue = () => {
        skipped++;
        if (stEl) stEl.innerHTML = skipEl;
        done++;
        if (progress) progress.style.width = `${Math.round(done / Math.max(rowsTotal, 1) * 100)}%`;
        const counterEl = $(counterSel);
        if (counterEl) counterEl.textContent = compare
          ? `⏭️ ${skipped} · ⤭ ${same} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`
          : `⤭ ${skipped} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`;
      };
      if (!compare && _examSession[k] === sigNow) { skipAndContinue(); continue; }
      if (!compare && _examSession[k]) delete _examSession[k];

      if (stEl) stEl.innerHTML = '<span style="color:var(--gold);">⏳...</span>';

      const saveIfDiff = async (data, patch) => {
        const idx = clients.findIndex(x => String(x.clientId) === String(c.clientId));
        const sigNew = arkkanExamSig(Object.assign({}, cur, patch));
        if (arkkanExamSig(cur) === sigNew) {
          same++;
          /* مطابق بدون تغيير: نسجّل الفحص على المقارنة حتى لا يُعاد في نافذة
             التخطي الخاصة بها أثناء إعادة تشغيل مقارنة موقوفة (يُحفظ الختامي) */
          const idx0 = clients.findIndex(x => String(x.clientId) === String(c.clientId));
          if (idx0 !== -1) clients[idx0].arkkanCompareCheck = Date.now();
          _examSession[k] = sigNew;
          return null; // مطابق بدون تغيير
        }
        const [oldTxt, newTxt] = diffText(cur, data.lastResult);
        if (idx !== -1) {
          Object.assign(clients[idx], patch);
          clients[idx].arkkanCompareCheck = Date.now();
        }
        await queueSave();
        updated++;
        _examSession[k] = arkkanExamSig(clients[idx] || c);
        arkkanRefreshExamCells(clients[idx] || c);
        return [oldTxt, newTxt];
      };

      try {
        const data = await arkkanExamFetchOne(c.clientId, c.referNum || '');
        const patch = arkkanPatchExamsFromData(c, data);
        if (compare) {
          const diff = await saveIfDiff(data, patch);
          if (stEl) stEl.innerHTML = diff
            ? `<span style="color:#8e44ad;" title="قبل: ${escapeHtml(diff[0])} · بعد: ${escapeHtml(diff[1])}">✅ محدَّث: ${escapeHtml(diff[0])} → ${escapeHtml(diff[1])}</span>`
            : '<span style="color:var(--text-muted);">⏭️ مطابق للمخزَّن</span>';
        } else {
          const idx = clients.findIndex(x => String(x.clientId) === String(c.clientId));
          if (idx !== -1) {
            Object.assign(clients[idx], patch);
            clients[idx].arkkanExamCheck = { s: arkkanExamSig(clients[idx]), t: Date.now() };
          }
          await queueSave();
          updated++;
          _examSession[k] = arkkanExamSig(clients[idx] || c);
          arkkanRefreshExamCells(clients[clients.findIndex(x => String(x.clientId) === String(c.clientId))] || c);
          const passed = idx !== -1 && arkkanExamPassed(clients[idx]);
          if (stEl) stEl.innerHTML = passed
            ? '<span style="color:var(--success, green);">✅ ناجح</span>'
            : '<span style="color:var(--success, green);">ظ£à</span>';
        }
      } catch (err) {
        /* فشل عابر (بطء شبكة/تحميل) — محاولة واحدة تلقائية قبل اعتبار العميل فاشلاً */
        let ok = false;
        try {
          if (stEl) stEl.innerHTML = '<span style="color:var(--gold);">⏳ محاولة ثانية...</span>';
          const data2 = await arkkanExamFetchOne(c.clientId, c.referNum || '');
          const patch2 = arkkanPatchExamsFromData(c, data2);
          if (compare) {
            const diff2 = await saveIfDiff(data2, patch2);
            if (stEl) stEl.innerHTML = diff2
              ? `<span style="color:#8e44ad;">✅ محدَّث (من المحاولة الثانية)</span>`
              : '<span style="color:var(--text-muted);">⏭️ مطابق (من المحاولة الثانية)</span>';
          } else {
            const idx2 = clients.findIndex(x => String(x.clientId) === String(c.clientId));
            if (idx2 !== -1) {
              Object.assign(clients[idx2], patch2);
              clients[idx2].arkkanExamCheck = { s: arkkanExamSig(clients[idx2]), t: Date.now() };
            }
            await queueSave();
            _examSession[k] = arkkanExamSig(clients[idx2] || c);
            updated++;
            arkkanRefreshExamCells(clients[clients.findIndex(x => String(x.clientId) === String(c.clientId))] || c);
            const passed2 = idx2 !== -1 && arkkanExamPassed(clients[idx2]);
            if (stEl) stEl.innerHTML = passed2
              ? '<span style="color:var(--success, green);">✅ ناجح</span>'
              : '<span style="color:var(--success, green);">✅ (من المحاولة الثانية)</span>';
          }
          ok = true;
        } catch (err2) { /* يبقى الخطأ الأخير */ }
        if (!ok) {
          failed++;
          delete _examSession[k];
          if (stEl) stEl.innerHTML = `<span style="color:var(--danger, red);" title="${escapeHtml(err.message)}">ظإî</span>`;
        }
      }

      done++;
      if (progress) progress.style.width = `${Math.round(done / Math.max(rowsTotal, 1) * 100)}%`;
      const counter = $(counterSel);
      if (counter) counter.textContent = compare
        ? `⤭ ${same} مطابق · ✅ ${updated} محدَّث · ❌ ${failed} فشل · ${done}/${rowsTotal}`
        : `⤭ ${skipped} · ✅ ${updated} · ❌ ${failed} · ${done}/${rowsTotal}`;
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL, rowsTotal) }, () => processOne()));
  await queueSave(); // حفظ علامات التخطي المتبقية (مطابق/فُحص حديثاً)

  st.running = false;
  if (startBtn) startBtn.style.display = '';
  if (stopBtn) stopBtn.style.display = 'none';
  if (wrap) wrap.style.display = 'none';
  renderArkkanExamsTable();
  showToast(compare
    ? `${doneMsg}: ${updated} حُدِّثت تلقائياً، ${same} مطابق، ${failed} فشل${skipped ? `، ${skipped} تجاوز (فُورن حديثاً)` : ''}`
    : `${doneMsg}: ${updated} محدّث، ${failed} فشل، ${skipped} تخطّي (بلا تغيير)`, updated > 0 ? 'success' : 'info');
}

/* الجلب الجماعي = تشغيل الصندوق بوضع الجلب */
function arkkanExamBulkRun(opts) { return arkkanExamBoxRun(Object.assign({ mode: 'fetch' }, opts)); }

/* جلب جماعي في صندوق النتائج الرئيسي: بلا نتيجة بعد */
function arkkanExamsBulk() {
  return arkkanExamBulkRun({
    name: 'exams',
    getRows: arkkanExamClients,
    startSel: '#btn-arkkan-exams-start',
    stopSel: '#btn-arkkan-exams-stop',
    progressSel: '#arkkan-exams-progress',
    counterSel: '#arkkan-exams-counter',
    doneMsg: 'اكتمل جلب نتائج الاختبارات'
  });
}

/* جلب جماعي في صندوق الراسبين: مستقل، لو نجح عميل ينتقل لصندوق النجاح */
function arkkanExamsFailedBulk() {
  return arkkanExamBulkRun({
    name: 'failed',
    getRows: arkkanExamFailedClients,
    startSel: '#btn-arkkan-exams-failed-start',
    stopSel: '#btn-arkkan-exams-failed-stop',
    progressSel: '#arkkan-exams-failed-progress',
    counterSel: '#arkkan-exams-failed-counter',
    doneMsg: 'اكتمل جلب نتائج الراسبين'
  });
}

/* جلب جماعي في صندوق "يحتاج إلى اختبار": مستقل — بظهور نتيجة ينتقل للصندوق المناسب */
function arkkanExamsNeedingBulk() {
  return arkkanExamBulkRun({
    name: 'needing',
    getRows: arkkanExamNeedingClients,
    startSel: '#btn-arkkan-exams-needing-start',
    stopSel: '#btn-arkkan-exams-needing-stop',
    progressSel: '#arkkan-exams-needing-progress',
    counterSel: '#arkkan-exams-needing-counter',
    doneMsg: 'اكتمل جلب نتائج المحتاجين للاختبار'
  });
}

/* ═══════ مقارنة كل صندوق مع أركان: يراجع البيانات ويحفظ الاختلافات تلقائياً ═══════ */
function arkkanExamCompareRun({ name, getRows, startSel, stopSel, progressSel, counterSel, doneMsg }) {
  return arkkanExamBoxRun({ name, getRows, startSel, stopSel, progressSel, counterSel, doneMsg, mode: 'compare' });
}
function arkkanExamsCompare() {
  return arkkanExamCompareRun({
    name: 'exams', getRows: arkkanExamClients,
    startSel: '#btn-arkkan-exams-compare', stopSel: '#btn-arkkan-exams-stop',
    progressSel: '#arkkan-exams-progress', counterSel: '#arkkan-exams-counter',
    doneMsg: 'اكتملت مقارنة نتائج الاختبارات مع أركان'
  });
}
function arkkanExamsNeedingCompare() {
  return arkkanExamCompareRun({
    name: 'needing', getRows: arkkanExamNeedingClients,
    startSel: '#btn-arkkan-exams-needing-compare', stopSel: '#btn-arkkan-exams-needing-stop',
    progressSel: '#arkkan-exams-needing-progress', counterSel: '#arkkan-exams-needing-counter',
    doneMsg: 'اكتملت مقارنة المحتاجين للاختبار'
  });
}
function arkkanExamsPassedCompare() {
  return arkkanExamCompareRun({
    name: 'passed', getRows: arkkanExamPassedClients,
    startSel: '#btn-arkkan-exams-passed-compare', stopSel: '#btn-arkkan-exams-passed-stop',
    progressSel: '#arkkan-exams-passed-progress', counterSel: '#arkkan-exams-passed-counter',
    doneMsg: 'اكتملت مقارنة الناجحين'
  });
}
function arkkanExamsFailedCompare() {
  return arkkanExamCompareRun({
    name: 'failed', getRows: arkkanExamFailedClients,
    startSel: '#btn-arkkan-exams-failed-compare', stopSel: '#btn-arkkan-exams-failed-stop',
    progressSel: '#arkkan-exams-failed-progress', counterSel: '#arkkan-exams-failed-counter',
    doneMsg: 'اكتملت مقارنة الراسبين'
  });
}

/* تحديث خلايا صف العميل بالبيانات الحالية (بعد كل جلب ناجح) */
function arkkanRefreshRowCells(c) {
  const row = document.querySelector(`#arkkan-row-${cssEscapeId(c.clientId)}`);
  if (!row) return;
  const set = (sel, val) => { const el = row.querySelector(sel); if (el) el.textContent = val || '—'; };
  set('.col-invoice', c.invoice);
  set('.col-coursenum', c.courseNumber);
  set('.col-date', c.date);
  set('.col-courseprice', c.receiptActualValue !== undefined && c.receiptActualValue !== null && c.receiptActualValue !== '' ? c.receiptActualValue : c.coursePrice);
  set('.col-startdate', c.startDate || arkkanCourseDate(c));
  set('.col-baginvoice', c.bagInvoice);
  set('.col-bagdate', c.bagPurchaseDate);
  const missEl = row.querySelector('.col-missing');
  if (missEl) missEl.textContent = arkkanMissingFields(c).map(f => ARKKAN_FIELD_LABELS[f]).join('، ');
}

/* ══════════════════════════════════════════════
   7) مقارنة بيانات الاختبارات مع أركان — زرار في كل صندوق
   يراجع كل عميل: يجلب نتيجته من أركان ويقارنها بالمخزَّنة —
   أي اختلاف يُحفَظ تلقائياً ويُوضَّح أمام كل عميل (قبل ← بعد)
   ══════════════════════════════════════════════ */

/* عند فتح تبويب مزامنة أركان: نعرض الجدولين ونحدّث الحالة */
document.addEventListener('click', () => {
  if (document.querySelector('#view-arkkan-sync')?.classList?.contains('active')) {
    arkkanResumeFieldSync();
    arkkanCompareResumeFieldSync();
    renderArkkanSyncTable();
    renderArkkanExamsTable();
  }
});

document.addEventListener('click', e => {
  if (e.target.closest('[data-arkkan-one]')) { arkkanSyncOne(e.target.closest('[data-arkkan-one]').dataset.arkkanOne, e.target.closest('[data-arkkan-one]')); return; }
  if (e.target.closest('[data-arkkan-exam-one]')) { arkkanExamSyncOne(e.target.closest('[data-arkkan-exam-one]').dataset.arkkanExamOne, e.target.closest('[data-arkkan-exam-one]')); return; }
  if (e.target.closest('#btn-arkkan-check-agent')) { arkkanUpdateStatus(); return; }
  if (e.target.closest('#btn-arkkan-bulk-start')) { arkkanBulkSync(); return; }
  if (e.target.closest('#btn-arkkan-bulk-stop')) { _arkkanBulkStop = true; return; }
  if (e.target.closest('#btn-arkkan-exams-start')) { arkkanExamsBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-stop')) { examBulkState('exams').stop = true; return; }
  if (e.target.closest('#btn-arkkan-exams-failed-start')) { arkkanExamsFailedBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-failed-stop')) { examBulkState('failed').stop = true; return; }
  if (e.target.closest('#btn-arkkan-exams-needing-start')) { arkkanExamsNeedingBulk(); return; }
  if (e.target.closest('#btn-arkkan-exams-needing-stop')) { examBulkState('needing').stop = true; return; }
  if (e.target.closest('#btn-arkkan-exams-compare')) { arkkanExamsCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-needing-compare')) { arkkanExamsNeedingCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-passed-compare')) { arkkanExamsPassedCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-failed-compare')) { arkkanExamsFailedCompare(); return; }
  if (e.target.closest('#btn-arkkan-exams-passed-stop')) { examBulkState('passed').stop = true; return; }
});

/* ربط زر التبويب بالرسم (نفس نمط بقية الشاشات) */
function initArkkanSyncView() {
  const navBtn = document.querySelector('nav.tabs button[data-view="arkkan-sync"]');
  if (navBtn) {
    navBtn.addEventListener('click', () => {
      arkkanResumeFieldSync();
      arkkanCompareResumeFieldSync();
      renderArkkanSyncTable();
      renderArkkanExamsTable();
      arkkanUpdateStatus();
    });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initArkkanSyncView);
else initArkkanSyncView();

/* حفظ فترتي التخطي (جلب / مقارنة) من حقليهما عند تغيير أي منهما */
document.addEventListener('change', async e => {
  const id = e.target && e.target.id;
  if (id === 'set-arkkan-resume-hours' || id === 'set-arkkan-compare-resume-hours') {
    const isCompare = id === 'set-arkkan-compare-resume-hours';
    const key = isCompare ? 'arkkanCompareResumeHours' : 'arkkanResumeHours';
    const v = Math.max(1, Math.min(720, parseInt(e.target.value, 10) || 24));
    if (!settings || typeof DEFAULT_SETTINGS === 'undefined') settings = { arkkanResumeHours: 24 };
    settings[key] = v;
    try { await saveSettings(); } catch {}
    (isCompare ? arkkanCompareResumeFieldSync : arkkanResumeFieldSync)();
    showToast(`${isCompare ? 'فترة تخطي المقارنة المُعاد' : 'فترة تخطي الفحص المُعاد'} = ${v} ساعة — يُطبق من التشغيل القادم`, 'info');
  }
});
