/* ============================================================
   receipts-auto-sync.js — إيصالات أركان: ربط برقم الفاتورة،
   تنزيل تلقائي واحد وراء واحد، فهرس محلي، وشاشة عرض/طباعة.
   ------------------------------------------------------------
   • المصدر الأول للعرض هو النسخة المحفوظة على الجهاز.
   • عند ظهور رقم فاتورة جديد: يُضاف للطابور تلقائياً.
   • التحميل القديم له زر بدء/إيقاف مستقل.
   • العامل الواحد (Concurrency = 1) يمنع أي تحميل متوازٍ.
   ============================================================ */

const RECEIPT_FAILS_KEY = 'ftc2.receipts.failures.v1';
const RECEIPT_KNOWN_KEY = 'ftc2.receipts.knownInvoices.v1';
const RECEIPT_COOLDOWN_MS = 2500;
const RECEIPT_SCAN_INTERVAL_MS = 15000;

let _receiptsIndexMap = null;      // Map<invoiceKey, entry> — للأرقام الفريدة فقط (بلا لبس بين عملاء)
let _receiptsIndexEntries = [];
let _receiptsByClientInvoice = null; // Map<'clientId|invoiceKey', entry>
let _receiptsByClientCourse = null;  // Map<'clientId|courseKey', entry> — ملفات قديمة باسم رقم الدورة
let _receiptsIndexAt = 0;
let _receiptsIndexLoading = null;

const _receiptJobs = new Map();    // '<invoiceKey>@<clientId>' -> job
const _receiptQueue = [];
let _receiptWorkerRunning = false;
let _receiptPaused = false;
let _receiptCurrentJob = null;
let _receiptBacklogRunning = false;
let _receiptScanTimer = null;
let _receiptInitDone = false;
let _receiptViewer = null;
let _receiptMissingCache = { at: 0, count: 0 };

/* ────────────────────────── أدوات عامة ────────────────────────── */

function receiptInvoiceKey(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    // نفس تطبيع الخلفية: تجاهل الفواصل الشكلية فقط، مع الإبقاء على الأرقام والحروف.
    .replace(/[^0-9A-Za-z\u0621-\u064A]/g, '')
    .toUpperCase();
}

function receiptEscape(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value == null ? '' : value);
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function receiptSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function receiptToast(message, type, duration) {
  if (typeof showToast === 'function') return showToast(message, type || 'info', duration);
  if (typeof window.showToast === 'function') return window.showToast(message, type || 'info', duration);
  console.log('[receipts]', message);
  return { close: () => {} };
}

function receiptDesktopApi() {
  return (window.desktopAPI && typeof window.desktopAPI.getReceiptsIndex === 'function') ? window.desktopAPI : null;
}

/* ───────────────────── حفظ حالة الفشل/المعرفة ───────────────────── */

function _receiptReadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch (e) { return fallback; }
}

function _receiptWriteJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function receiptFailures() {
  return _receiptReadJson(RECEIPT_FAILS_KEY, {});
}

/* مفتاح الفشل مقيد بالعميل مثل الفهرس: فشل إيصال عميل لا يمنع عميلاً آخر
   يحمل نفس رقم الفاتورة من المحاولة. */
function _receiptFailureId(invoice, clientOrId) {
  const key = receiptInvoiceKey(invoice);
  if (!key) return '';
  const cid = String(
    (clientOrId && typeof clientOrId === 'object')
      ? (clientOrId.clientId || '')
      : (clientOrId || '')
  ).trim();
  return cid ? key + '@' + cid : key;
}

function receiptFailureFor(invoice, clientOrId) {
  const id = _receiptFailureId(invoice, clientOrId);
  if (!id) return null;
  const fails = receiptFailures();
  if (fails[id]) return fails[id];
  // توافق للخلف: السجلات القديمة كانت بمفتاح رقم الفاتورة وحده.
  const key = receiptInvoiceKey(invoice);
  if (key && fails[key]) return fails[key];
  // بلا عميل محدد: أي فشل لنفس رقم الفاتورة (لأي عميل) يكفي لعرض حالة «فشل».
  if (key && id === key) {
    const prefix = key + '@';
    const hit = Object.keys(fails).find(k => k.startsWith(prefix));
    if (hit) return fails[hit];
  }
  return null;
}

function receiptSetFailure(invoice, error, retryAfterSeconds, clientOrId) {
  const id = _receiptFailureId(invoice, clientOrId);
  if (!id) return;
  const fails = receiptFailures();
  const old = fails[id] || { tries: 0 };
  const tries = (Number(old.tries) || 0) + 1;
  const waitMs = retryAfterSeconds
    ? Math.max(5, Number(retryAfterSeconds) || 30) * 1000
    : Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, Math.min(tries - 1, 5)));
  fails[id] = {
    tries,
    at: Date.now(),
    nextAt: Date.now() + waitMs,
    error: String(error || '').slice(0, 300),
  };
  _receiptWriteJson(RECEIPT_FAILS_KEY, fails);
}

function receiptClearFailure(invoice, clientOrId) {
  const id = _receiptFailureId(invoice, clientOrId);
  if (!id) return;
  const fails = receiptFailures();
  let changed = false;
  if (fails[id]) { delete fails[id]; changed = true; }
  // المفتاح القديم (رقم الفاتورة وحده) يُزال أيضاً حتى لا يظل حاجزاً بعد النجاح.
  const key = receiptInvoiceKey(invoice);
  if (key && fails[key]) { delete fails[key]; changed = true; }
  if (changed) _receiptWriteJson(RECEIPT_FAILS_KEY, fails);
}

function receiptFailureBlocked(invoice, clientOrId) {
  const f = receiptFailureFor(invoice, clientOrId);
  return !!(f && Number(f.nextAt) > Date.now());
}

function _receiptKnownMap() {
  const raw = _receiptReadJson(RECEIPT_KNOWN_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function _receiptKnownId(client) {
  const key = receiptInvoiceKey(client && client.invoice);
  if (!key) return '';
  const cid = String((client && client.clientId) || '').trim();
  return cid ? key + '@' + cid : key;
}

/* توافق للخلف: النسخة السابقة كانت تحفظ رقم الفاتورة وحده دون هوية العميل. */
function _receiptIsKnown(known, client) {
  const id = _receiptKnownId(client);
  if (!id) return false;
  if (known[id]) return true;
  return !!known[receiptInvoiceKey(client && client.invoice)];
}

function _receiptMarkInvoicesKnown(list) {
  const known = _receiptKnownMap();
  let changed = false;
  for (const c of list || []) {
    const id = _receiptKnownId(c);
    if (!id) continue;
    if (!known[id]) { known[id] = Date.now(); changed = true; }
  }
  if (changed) _receiptWriteJson(RECEIPT_KNOWN_KEY, known);
  return changed;
}

/* ────────────────────────── الفهرس المحلي ────────────────────────── */

async function receiptsLoadIndex(force) {
  const api = receiptDesktopApi();
  if (!api) {
    _receiptsIndexMap = new Map();
    _receiptsByClientInvoice = new Map();
    _receiptsByClientCourse = new Map();
    _receiptsIndexEntries = [];
    _receiptsIndexAt = Date.now();
    return _receiptsIndexMap;
  }
  if (!force && _receiptsIndexMap && (Date.now() - _receiptsIndexAt) < 15000) return _receiptsIndexMap;
  if (!force && _receiptsIndexLoading) return _receiptsIndexLoading;

  _receiptsIndexLoading = (async () => {
    try {
      const res = await api.getReceiptsIndex();
      const items = res && Array.isArray(res.items) ? res.items : [];
      _receiptsIndexEntries = items.slice();
      _rebuildReceiptIndexMaps(items);
      _receiptsIndexAt = Date.now();
    } catch (e) {
      _receiptsIndexMap = _receiptsIndexMap || new Map();
      _receiptsByClientInvoice = _receiptsByClientInvoice || new Map();
      _receiptsByClientCourse = _receiptsByClientCourse || new Map();
      _receiptsIndexEntries = _receiptsIndexEntries || [];
    } finally {
      _receiptsIndexLoading = null;
    }
    return _receiptsIndexMap;
  })();
  return _receiptsIndexLoading;
}

/* الأفضلية عند وجود أكثر من نسخة لنفس المفتاح: الموثوق (رقم فاتورة حقيقي) ثم الدورة ثم الأحدث. */
function _receiptEntryBetter(a, b) {
  if (!b) return true;
  const score = e => (e && e.authoritative ? 4 : 0) + (e && e.kind === 'course' ? 2 : 0);
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa > sb;
  return String((a && a.savedAt) || '') > String((b && b.savedAt) || '');
}

function _receiptClientKey(clientOrId, invoiceKey) {
  const cid = String(
    (clientOrId && typeof clientOrId === 'object')
      ? (clientOrId.clientId || '')
      : (clientOrId || '')
  ).trim();
  return cid ? (cid + '|' + invoiceKey) : '';
}

function _rebuildReceiptIndexMaps(items) {
  const map = new Map();                 // الأرقام غير المشتركة فقط
  const byClient = new Map();
  const byClientCourse = new Map();
  const owners = new Map();              // invoiceKey|kind -> Set(clientId)

  for (const item of items) {
    if (!item) continue;
    const key = receiptInvoiceKey(item.invoiceNo || item.invoiceKey);
    if (!key) continue;
    const cid = String(item.clientId || '');
    const kind = item.kind === 'bag' ? 'bag' : 'course';
    const ownersKey = key + '|' + kind;
    if (!owners.has(ownersKey)) owners.set(ownersKey, new Set());
    owners.get(ownersKey).add(cid);

    if (cid) {
      const ck = cid + '|' + key;
      if (_receiptEntryBetter(item, byClient.get(ck))) byClient.set(ck, item);
      if (kind === 'course' && item.courseNumber) {
        const courseKey = receiptInvoiceKey(item.courseNumber);
        if (courseKey) {
          const cck = cid + '|' + courseKey;
          if (_receiptEntryBetter(item, byClientCourse.get(cck))) byClientCourse.set(cck, item);
        }
      }
    }
  }

  for (const item of items) {
    if (!item) continue;
    const key = receiptInvoiceKey(item.invoiceNo || item.invoiceKey);
    if (!key) continue;
    const kind = item.kind === 'bag' ? 'bag' : 'course';
    // أرقام الدورات القديمة ليست أرقام فواتير — لا تُستخدم في البحث العام أبداً.
    if (item.legacyCourseToken) continue;
    const ownerSet = owners.get(key + '|' + kind) || new Set();
    // رقم يستخدمه أكثر من عميل لا يصلح للبحث العام، لكنه صالح داخل نطاق عميله.
    if (ownerSet.size > 1) continue;
    const old = map.get(key);
    // لو نفس الرقم مستخدم لدورة وحقيبة، الدورة هي الافتراضية عند الضغط على رقم الفاتورة.
    if (!old || (old.kind !== 'course' && item.kind === 'course')) map.set(key, item);
  }

  _receiptsIndexMap = map;
  _receiptsByClientInvoice = byClient;
  _receiptsByClientCourse = byClientCourse;
}

/* البحث المحلي: إن مُرِّر العميل تكون المطابقة على ملفاته هو فقط (رقم الفاتورة ثم رقم الدورة). */
function receiptsLocalEntry(invoice, clientOrId) {
  const key = receiptInvoiceKey(invoice);
  if (!key) return null;
  const cidKey = _receiptClientKey(clientOrId, key);
  if (cidKey) {
    const hit = _receiptsByClientInvoice && _receiptsByClientInvoice.get(cidKey);
    if (hit) return hit;
    // الرجوع لرقم الدورة مسموح فقط عندما يكون المطلوب هو فاتورة هذا العميل نفسها
    // (أو رقم دورته)، لا لأي رقم آخر مثل رقم إيصال حقيبة.
    const courseKey = receiptInvoiceKey(
      clientOrId && typeof clientOrId === 'object' ? clientOrId.courseNumber : ''
    );
    const ownInvoiceKey = receiptInvoiceKey(clientOrId && typeof clientOrId === 'object' ? clientOrId.invoice : '');
    const allowCourseFallback = courseKey && (key === courseKey || (ownInvoiceKey && key === ownInvoiceKey));
    if (allowCourseFallback) {
      const legacy = _receiptsByClientCourse &&
        _receiptsByClientCourse.get(String(clientOrId.clientId).trim() + '|' + courseKey);
      if (legacy) return legacy;
    }
    return null;
  }
  return (_receiptsIndexMap && _receiptsIndexMap.get(key)) || null;
}

function receiptsIndexPut(entry) {
  if (!entry) return;
  const key = receiptInvoiceKey(entry.invoiceNo || entry.invoiceKey);
  if (!key) return;
  if (!Array.isArray(_receiptsIndexEntries)) _receiptsIndexEntries = [];
  const cid = String(entry.clientId || '');
  const idx = _receiptsIndexEntries.findIndex(x =>
    receiptInvoiceKey(x && x.invoiceNo) === key &&
    x.kind === entry.kind &&
    String(x.clientId || '') === cid);
  if (idx >= 0) _receiptsIndexEntries[idx] = entry; else _receiptsIndexEntries.unshift(entry);
  // إعادة بناء الخرائط من القائمة الموحّدة: يضمن أن السلوك بعد الحفظ مطابق تماماً
  // للسلوك بعد إعادة تحميل الفهرس من القرص (بما فيه تعليم الأرقام المشتركة).
  _rebuildReceiptIndexMaps(_receiptsIndexEntries);
  _receiptsIndexAt = Date.now();
  _receiptMissingCache = { at: 0, count: 0 }; // إعادة حساب «الناقص» بعد أي حفظ
  _receiptsMissingClientsCache = { at: 0, fully: 0, any: 0 };
}

function receiptsStatusFor(invoice, clientOrId) {
  const key = receiptInvoiceKey(invoice);
  if (!key) return 'missing';
  if (receiptsLocalEntry(key, clientOrId)) return 'saved';
  if (_receiptCurrentJob && _receiptCurrentJob.key === key &&
    (!_receiptCurrentJob.client || !clientOrId ||
      String(_receiptCurrentJob.client.clientId) === String(typeof clientOrId === 'object' ? clientOrId.clientId : clientOrId))) return 'pending';
  if (_receiptJobFor(key, clientOrId)) return 'pending';
  if (receiptFailureBlocked(key, clientOrId)) return 'failed';
  return 'missing';
}

const RECEIPT_STATUS_TITLES = {
  saved: 'الإيصال محفوظ على هذا الجهاز — اضغط للعرض والطباعة',
  pending: 'الإيصال في طابور التحميل — اضغط للمتابعة',
  failed: 'تعذّر تحميل الإيصال سابقاً — اضغط للمحاولة/معرفة السبب',
  missing: 'الإيصال غير محمّل محلياً — اضغط للتحميل والعرض',
};

function receiptsIndicatorHtml(invoice, clientOrId) {
  const key = receiptInvoiceKey(invoice);
  if (!key) return '';
  const status = receiptsStatusFor(key, clientOrId);
  const isObj = clientOrId && typeof clientOrId === 'object';
  const cid = isObj ? String(clientOrId.clientId || '') : String(clientOrId || '');
  const course = isObj ? String(clientOrId.courseNumber || '') : '';
  return `<span class="receipt-indicator receipt-indicator-${status}" data-receipt-indicator="${receiptEscape(key)}" data-receipt-client="${receiptEscape(cid)}" data-receipt-invoice="${receiptEscape(key)}" data-receipt-course="${receiptEscape(course)}" title="${receiptEscape(RECEIPT_STATUS_TITLES[status] || '')}"></span>`;
}

function receiptsRefreshIndicators(invoice, clientOrId) {
  const key = receiptInvoiceKey(invoice);
  const isObj = clientOrId && typeof clientOrId === 'object';
  const focusCid = isObj ? String(clientOrId.clientId || '') : String(clientOrId || '');
  const client = isObj ? clientOrId : null;
  document.querySelectorAll('[data-receipt-indicator]').forEach(el => {
    if (key && el.getAttribute('data-receipt-indicator') !== key) return;
    const cid = el.getAttribute('data-receipt-client') || '';
    if (focusCid && cid && cid !== focusCid) return;
    // نحدد حالة كل صف بعميله هو — لا بحالة رقم الفاتورة مجرداً.
    const rowClient = client && String(client.clientId) === cid
      ? client
      : {
        clientId: cid,
        courseNumber: el.getAttribute('data-receipt-course') || '',
        invoice: el.getAttribute('data-receipt-invoice') || '',
      };
    const status = key
      ? receiptsStatusFor(key, rowClient)
      : receiptsStatusFor(el.getAttribute('data-receipt-indicator'), rowClient);
    el.classList.remove('receipt-indicator-saved', 'receipt-indicator-pending', 'receipt-indicator-failed', 'receipt-indicator-missing');
    el.classList.add('receipt-indicator-' + status);
    el.title = RECEIPT_STATUS_TITLES[status] || '';
  });
}

/* ────────────────────────── الطابور ────────────────────────── */

function _receiptTypedClient(client) {
  const invoice = String(client.invoice || '');
  // النوع يُستنتج من شكل الرقم عند غياب تحديد صريح (نفس منطق الوكيل):
  // فواتير الدورات تبدأ بحروف، وفواتير الحقائب أرقام فقط.
  const kind = (client.kind === 'bag' || client.kind === 'course')
    ? client.kind
    : (/^[A-Za-z]/.test(invoice.trim()) ? 'course' : 'bag');
  return {
    id: client.id,
    clientId: String(client.clientId || ''),
    name: client.name || '',
    invoice,
    kind,
    referNum: String(client.referNum || ''),
    courseNumber: String(client.courseNumber || ''),
    date: client.date || '',
  };
}

/* نسخة «عميل فاتورة» لفاتورة محددة: فاتورة الدورة (c.invoice) أو فاتورة الحقيبة (c.bagInvoice).
   كل فاتورة تُطلب منفصلة وتحمل نوعها الصريح حتى لا يُنسب إيصال حقيبة إلى فاتورة دورة أو العكس. */
function receiptInvoiceClient(client, kind) {
  if (!client) return null;
  if (kind === 'bag') {
    const bagInvoice = String(client.bagInvoice || '').trim();
    if (!bagInvoice) return null;
    return Object.assign({}, client, { invoice: bagInvoice, kind: 'bag', courseNumber: '' });
  }
  const invoice = String(client.invoice || '').trim();
  if (!invoice) return null;
  const inferredKind = /^[A-Za-z]/.test(invoice) ? 'course' : 'bag';
  return Object.assign({}, client, {
    invoice,
    kind: inferredKind,
    // الفاتورة الرقمية (حقيبة) لا تحمل رقم دورة، حتى لا يُطابق إيصال دورة بالخطأ.
    courseNumber: inferredKind === 'bag' ? '' : String(client.courseNumber || ''),
  });
}

/* كل فواتير العملاء (دورة + حقيبة) كعناصر مستقلة — مصدر موحّد للفحص التلقائي وقائمة القديم. */
function receiptInvoiceClients(list) {
  const out = [];
  for (const c of list || []) {
    if (!c || !c.clientId) continue;
    const course = receiptInvoiceClient(c, 'course');
    if (course) out.push(course);
    const bag = receiptInvoiceClient(c, 'bag');
    if (bag) out.push(bag);
  }
  return out;
}

function receiptsEnqueue(client, options) {
  const opts = options || {};
  const c = _receiptTypedClient(client || {});
  const key = receiptInvoiceKey(c.invoice);
  if (!key) return { queued: false, reason: 'no-invoice', promise: Promise.resolve(null) };
  if (!c.clientId) return { queued: false, reason: 'no-client-id', promise: Promise.resolve(null) };

  // البحث مقيد بالعميل: لا نعتبر إيصال عميل آخر (بنفس الرقم) موجوداً محلياً.
  const existing = receiptsLocalEntry(key, c);
  if (existing && !opts.force) {
    return { queued: false, reason: 'local', promise: Promise.resolve(existing) };
  }
  const jobId = key + '@' + c.clientId;
  const already = _receiptJobs.get(jobId);
  if (already) {
    // نقر المستخدم على رقم الفاتورة يرفع الطلب المنتظر إلى مقدمة الطابور ويتجاوز الإيقاف،
    // حتى لا يُلغى بضغط «إيقاف القديم» ولو كان قد أُضيف تلقائياً قبل لحظات.
    if (opts.priority) {
      already.priority = true;
      already.ignorePause = true;
      already.source = 'click';
      const idx = _receiptQueue.indexOf(already);
      if (idx > 0) {
        _receiptQueue.splice(idx, 1);
        _receiptQueue.unshift(already);
      }
    }
    if (opts.force) already.force = true;
    receiptsUpdateUI();
    return { queued: false, reason: 'already', promise: already.promise };
  }

  let resolveJob, rejectJob;
  const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
  // الطلبات التلقائية/الجماعية لا ينتظرها أحد؛ هذا المعالج يمنع تحذير الرفض غير المعالَج
  // بينما يظل بإمكان من ينتظر نفس الوعد (نقر رقم الفاتورة) التقاط الخطأ طبيعياً.
  promise.catch(() => {});
  const job = {
    key,
    id: jobId,
    client: c,
    source: opts.source || 'auto',
    priority: !!opts.priority,
    ignorePause: !!opts.ignorePause,
    force: !!opts.force,
    promise,
    resolve: resolveJob,
    reject: rejectJob,
  };
  _receiptJobs.set(jobId, job);
  if (opts.priority) _receiptQueue.unshift(job);
  else _receiptQueue.push(job);
  receiptsRefreshIndicators(key, c);
  receiptsUpdateUI();
  receiptsStartWorker();
  return { queued: true, reason: 'queued', promise, job };
}

function _receiptPendingCount() {
  return _receiptQueue.length + (_receiptCurrentJob ? 1 : 0);
}

/* إضافة مجموعة إيصالات (المحددون في شيت العملاء) إلى نفس الطابور الواحد.
   لكل عميل: إيصال فاتورة الدورة وإيصال فاتورة الحقيبة (إن وُجد أي منهما). */
function receiptsEnqueueMany(list, options) {
  const opts = options || {};
  let queued = 0, local = 0, skipped = 0;
  for (const client of list || []) {
    if (!client || !client.clientId) { skipped++; continue; }
    const invoices = receiptInvoiceClients([client]);
    if (!invoices.length) { skipped++; continue; }
    for (const inv of invoices) {
      const r = receiptsEnqueue(inv, { source: opts.source || 'bulk', force: !!opts.force });
      if (r.queued || r.reason === 'already') queued++;
      else if (r.reason === 'local') local++;
      else skipped++;
    }
  }
  if (queued) {
    _receiptPaused = false;
    receiptsStartWorker();
  }
  receiptsUpdateUI();
  return { queued, local, skipped };
}

async function receiptsStartWorker() {
  if (_receiptWorkerRunning) return;
  _receiptWorkerRunning = true;
  try {
    while (true) {
      let job = null;
      if (_receiptQueue.length) {
        // الطلبات اليدوية (الضغط على رقم الفاتورة) تتجاوز الإيقاف المؤقت.
        const manualIdx = _receiptQueue.findIndex(j => j.ignorePause);
        if (manualIdx >= 0) job = _receiptQueue.splice(manualIdx, 1)[0];
        else if (!_receiptPaused) job = _receiptQueue.shift();
      }
      if (!job) break;

      _receiptCurrentJob = job;
      receiptsUpdateUI();
      receiptsRefreshIndicators(job.key, job.client);
      try {
        const entry = await receiptsFetchAndSave(job.client, { force: job.force });
        receiptClearFailure(job.key, job.client);
        _receiptMarkInvoicesKnown([job.client]);
        receiptsIndexPut(entry);
        job.resolve(entry);
        try {
          window.dispatchEvent(new CustomEvent('ftc2:receipt-saved', { detail: { entry, client: job.client } }));
        } catch (e) {}
      } catch (err) {
        const message = String((err && err.message) || err || 'تعذّر تحميل الإيصال');
        receiptSetFailure(job.key, message, err && err.retryAfter, job.client);
        job.reject(err instanceof Error ? err : new Error(message));
      } finally {
        _receiptCurrentJob = null;
        _receiptJobs.delete(job.id || job.key);
        receiptsUpdateUI();
        receiptsRefreshIndicators(job.key, job.client);
      }

      if (_receiptQueue.length || _receiptPaused) {
        await receiptSleep(RECEIPT_COOLDOWN_MS);
      }
    }
  } finally {
    _receiptWorkerRunning = false;
    _receiptCurrentJob = null;
    receiptsUpdateUI();
    // لو وصل طلب جديد أثناء إنهاء العامل (سباق نادر) نعيد تشغيله.
    if (_receiptQueue.length && (!_receiptPaused || _receiptQueue.some(j => j.ignorePause))) {
      setTimeout(() => { if (!_receiptWorkerRunning) receiptsStartWorker(); }, 300);
    }
  }
}

function receiptPauseQueue() {
  _receiptPaused = true;
  _receiptBacklogRunning = false;
  receiptsUpdateUI();
  receiptToast(_receiptCurrentJob
    ? '⏸️ سيتم إيقاف الجلب بعد انتهاء الإيصال الحالي'
    : '⏸️ تم إيقاف جلب الإيصالات', 'info', 4000);
}

function receiptResumeQueue() {
  _receiptPaused = false;
  receiptsUpdateUI();
  receiptsStartWorker();
  receiptToast('▶️ تم تشغيل جلب الإيصالات', 'success', 3000);
}

function _receiptJobFor(key, clientOrId) {
  const cid = String(
    (clientOrId && typeof clientOrId === 'object')
      ? (clientOrId.clientId || '')
      : (clientOrId || '')
  ).trim();
  if (cid) return _receiptJobs.get(key + '@' + cid) || null;
  // بلا عميل محدد: أي طلب لنفس الرقم يُعتبر قيد التنفيذ.
  for (const job of _receiptJobs.values()) if (job.key === key) return job;
  return null;
}

function receiptBacklogCandidates() {
  return receiptInvoiceClients(Array.isArray(clients) ? clients : [])
    .filter(c => c.clientId && !receiptsLocalEntry(c.invoice, c))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

function receiptsMissingCount() {
  const now = Date.now();
  if (now - _receiptMissingCache.at < 5000) return _receiptMissingCache.count;
  const count = receiptBacklogCandidates().length;
  _receiptMissingCache = { at: now, count };
  return count;
}

function receiptsStartBacklog() {
  if (!Array.isArray(clients)) { receiptToast('بيانات العملاء لم تُحمّل بعد', 'info'); return; }
  // ضغط المستخدم صراحةً = إعادة محاولة كاملة: نمسح كل سجلات الفشل (بما فيها القديمة
  // بمفتاح رقم الفاتورة وحده) حتى لا يبقى أي إيصال محجوباً بفشل سابق.
  const fails = receiptFailures();
  if (Object.keys(fails).length) _receiptWriteJson(RECEIPT_FAILS_KEY, {});
  _receiptMissingCache = { at: 0, count: 0 };
  _receiptsMissingClientsCache = { at: 0, fully: 0, any: 0 };

  const list = receiptBacklogCandidates();
  if (!list.length) {
    receiptsRefreshIndicators();
    receiptsUpdateUI();
    receiptToast('✅ لا توجد إيصالات قديمة ناقصة للتحميل', 'success', 4000);
    return;
  }
  _receiptPaused = false;
  let queued = 0;
  for (const c of list) {
    const r = receiptsEnqueue(c, { source: 'backlog' });
    if (r.queued) queued++;
  }
  _receiptBacklogRunning = true;
  receiptsUpdateUI();
  receiptsStartWorker();
  receiptToast(`📥 بدأ تحميل ${queued || list.length} إيصالاً قديماً — واحداً وراء الآخر`, 'info', 5000);
}

function receiptsStopBacklog() {
  _receiptBacklogRunning = false;
  // إزالة طلبات القديم المنتظرة فقط، مع ترك الطلبات الجديدة/اليدوية.
  for (let i = _receiptQueue.length - 1; i >= 0; i--) {
    if (_receiptQueue[i].source === 'backlog') {
      const [job] = _receiptQueue.splice(i, 1);
      _receiptJobs.delete(job.id || job.key);
      try { job.reject(new Error('تم إيقاف تحميل الإيصالات القديمة')); } catch (e) {}
    }
  }
  receiptsUpdateUI();
  receiptsRefreshIndicators();
  receiptToast('⏹ تم إيقاف طابور الإيصالات القديمة — الجديد يظل يعمل تلقائياً', 'info', 4000);
}

/* ═══════════════ قائمة العملاء الناقص إيصالاتهم (بما فيهم القدامى) ═══════════════
   تعتمد على فهرس الإيصالات المحلي (كل ملف محفوظ على هذا الجهاز). تظهر القائمة
   افتراضياً كل من ينقصه إيصال — ولو كان لديه إيصال واحد محفوظ — مع بيان الناقص.
   العميل القديم الذي لم يُدخَل له رقم فاتورة يُعرض برقم دورته (رقم الدورة هو
   المعرّف الوحيد المتاح لمطابقة إيصالاته القديمة في أركان). */
let _receiptsMissingClientsCache = { at: 0, fully: 0, any: 0 };

function _receiptsClientInvoices(c) {
  const invoices = receiptInvoiceClients([c]);
  if (invoices.length) return invoices;
  // عميل قديم بلا رقم فاتورة: رقم الدورة هو الوسيلة الوحيدة لمطابقة إيصالاته.
  const courseNo = String(c.courseNumber || '').trim();
  if (!courseNo) return [];
  return [Object.assign({}, c, {
    invoice: courseNo,
    kind: 'course',
    courseNumber: courseNo,
    legacyCourseOnly: true,
  })];
}

function receiptsMissingClients(onlyNone) {
  const list = Array.isArray(clients) ? clients : [];
  const out = [];
  for (const c of list) {
    if (!c || !c.clientId) continue;
    const invoices = _receiptsClientInvoices(c);
    if (!invoices.length) continue;
    const missing = invoices.filter(inv => !receiptsLocalEntry(inv.invoice, inv));
    if (!missing.length) continue;
    if (onlyNone && missing.length !== invoices.length) continue;
    out.push({ client: c, invoices, missing });
  }
  return out;
}

function receiptsMissingClientStats() {
  const now = Date.now();
  if (now - _receiptsMissingClientsCache.at < 5000) return _receiptsMissingClientsCache;
  const any = receiptsMissingClients(false);
  const fully = any.filter(r => r.missing.length === r.invoices.length).length;
  _receiptsMissingClientsCache = { at: now, fully, any: any.length };
  return _receiptsMissingClientsCache;
}

function _receiptsMissingEls() {
  return {
    overlay: document.getElementById('receipts-missing-overlay'),
    summary: document.getElementById('receipts-missing-summary'),
    search: document.getElementById('receipts-missing-search'),
    onlyNone: document.getElementById('receipts-missing-only-none'),
    sort: document.getElementById('receipts-missing-sort'),
    list: document.getElementById('receipts-missing-list'),
    download: document.getElementById('receipts-missing-download'),
  };
}

function _receiptsMissingSortRows(rows, mode) {
  const byDate = (a, b) => String(a.client.date || '').localeCompare(String(b.client.date || ''));
  const byName = (a, b) => String(a.client.name || '').localeCompare(String(b.client.name || ''), 'ar');
  if (mode === 'date-asc') return rows.sort((a, b) => byDate(a, b) || byName(a, b));
  if (mode === 'name') return rows.sort((a, b) => byName(a, b) || byDate(b, a));
  return rows.sort((a, b) => byDate(b, a) || byName(a, b));
}

function _receiptsMissingMatches(client, needle) {
  if (!needle) return true;
  const parts = [client.name, client.clientId, client.phone, client.invoice, client.bagInvoice, client.courseNumber, client.courseType, client.referNum];
  return parts.some(v => String(v == null ? '' : v).toLowerCase().includes(needle));
}

function _receiptsMissingInvoiceCell(value, missing, isCourseNo) {
  const inv = String(value || '').trim();
  if (!inv) return '<span class="receipts-missing-none">—</span>';
  const label = receiptEscape(inv) +
    (isCourseNo ? ' <span class="receipts-missing-sub">(رقم دورة)</span>' : '');
  return missing
    ? `<span class="receipts-missing-bad" title="${isCourseNo ? 'لا يوجد إيصال محفوظ لهذه الدورة' : 'غير محفوظ على هذا الجهاز'}">❌ ${label}</span>`
    : `<span class="receipts-missing-ok" title="${isCourseNo ? 'إيصال هذه الدورة محفوظ على هذا الجهاز' : 'محفوظ على هذا الجهاز'}">✅ ${label}</span>`;
}

function receiptsMissingRender() {
  const els = _receiptsMissingEls();
  if (!els.list) return;
  const onlyNone = !!(els.onlyNone && els.onlyNone.checked);
  const needle = String(els.search && els.search.value || '').trim().toLowerCase();
  const sortMode = String(els.sort && els.sort.value || 'date-desc');
  const rows = _receiptsMissingSortRows(
    receiptsMissingClients(onlyNone).filter(r => _receiptsMissingMatches(r.client, needle)),
    sortMode
  );

  const missingInvoices = rows.reduce((sum, r) => sum + r.missing.length, 0);
  const fullyMissing = rows.filter(r => r.missing.length === r.invoices.length).length;
  const legacyRows = rows.filter(r => r.invoices.some(i => i.legacyCourseOnly)).length;
  if (els.summary) {
    els.summary.innerHTML =
      `👥 العملاء الناقص إيصالاتهم: <b>${rows.length}</b>` +
      ` · بلا أي إيصال محفوظ: <b>${fullyMissing}</b>` +
      ` · إيصالات ناقصة: <b>${missingInvoices}</b>` +
      (legacyRows ? ` · بلا رقم فاتورة (رقم الدورة فقط): <b>${legacyRows}</b>` : '') +
      `<br><span style="font-size:11.5px; color:var(--text-muted);">المصدر: فهرس الإيصالات المحفوظة على هذا الجهاز (${_receiptsIndexEntries.length} ملف). ` +
      `${onlyNone ? 'تُعرض فقط الحالات التي لا يوجد لها أي إيصال محفوظ.' : 'تشمل القائمة كل من ينقصه إيصال — حتى لو كان لديه إيصال واحد محفوظ (دورة أو حقيبة).'} ` +
      `العملاء القدامى بلا رقم فاتورة يظهرون برقم الدورة، ويُطابَق إيصالهم من أرشيف أركان برقم الدورة نفسه.</span>`;
  }

  if (!rows.length) {
    els.list.innerHTML = `<div class="receipts-missing-empty">${onlyNone
      ? '✅ لا يوجد أي عميل بلا إيصالات محفوظة — كل الفواتير المسجّلة لها إيصالات على هذا الجهاز.'
      : '✅ لا يوجد عملاء ناقصو إيصالات ضمن البحث الحالي.'}</div>`;
  } else {
    // حماية للأداء: لو القائمة ضخمة (آلاف العملاء القدامى) نرسم أول 800 صف فقط،
    // والبحث يضيّق النتيجة. زر التحميل الجماعي يظل يشمل كل القائمة المفلترة.
    const MAX_RENDER = 800;
    const shown = rows.slice(0, MAX_RENDER);
    const body = shown.map((r, i) => {
      const c = r.client;
      const courseInv = r.invoices.find(inv => inv.kind !== 'bag') || null;
      const bagInv = r.invoices.find(inv => inv.kind === 'bag') || null;
      const courseMissing = !!courseInv && r.missing.indexOf(courseInv) >= 0;
      const bagMissing = !!bagInv && r.missing.indexOf(bagInv) >= 0;
      const status = r.missing.map(m => m.kind === 'bag' ? 'حقيبة' : 'دورة').join(' + ');
      const courseNo = courseInv ? courseInv.invoice : '';
      return `<tr>
        <td class="mono">${i + 1}</td>
        <td>
          <div class="receipts-missing-name">${receiptEscape(c.name || '')}</div>
          <div class="receipts-missing-sub">${receiptEscape(c.courseType || '')}${c.courseNumber ? ' · ' + receiptEscape(c.courseNumber) : ''}</div>
        </td>
        <td class="mono">${receiptEscape(c.clientId || '—')}</td>
        <td class="mono" dir="ltr">${receiptEscape(c.phone || '—')}</td>
        <td><span class="receipts-missing-bad" style="white-space:nowrap;">${receiptEscape(status)}</span></td>
        <td class="receipts-missing-inv">${_receiptsMissingInvoiceCell(courseNo, courseMissing, !!(courseInv && courseInv.legacyCourseOnly))}</td>
        <td class="receipts-missing-inv">${_receiptsMissingInvoiceCell(bagInv ? bagInv.invoice : '', bagMissing, false)}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn btn-ghost btn-sm receipts-missing-dl receipts-missing-arkkan" data-receipts-missing-arkkan="${receiptEscape(String(c.id || ''))}" title="نفس زر كرت العميل: جلب بيانات هذا العميل من منصة أركان (والرقم المرجعي إن كان ناقصاً) وحفظها تلقائياً">⏬ جلب من أركان</button>
          <button type="button" class="btn btn-ghost btn-sm receipts-missing-dl" data-receipts-missing-dl="${receiptEscape(String(c.id || ''))}" title="تحميل الإيصالات الناقصة لهذا العميل">📥</button>
        </td>
      </tr>`;
    }).join('');
    els.list.innerHTML = `<table>
      <thead><tr>
        <th style="width:44px;">#</th>
        <th>العميل / الدورة</th>
        <th>رقم الهوية</th>
        <th>الهاتف</th>
        <th>الناقص</th>
        <th>فاتورة الدورة</th>
        <th>فاتورة الحقيبة</th>
        <th style="width:112px;"></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>` + (rows.length > shown.length
      ? `<div class="receipts-missing-empty" style="padding:10px 12px;">عرض أول <b>${shown.length}</b> من <b>${rows.length}</b> عميل — استخدم البحث لتضييق النتيجة. زر «تحميل إيصالات القائمة المعروضة» يشمل كل الـ ${rows.length}.</div>`
      : '');
  }
  if (els.download) els.download.disabled = rows.length === 0;
}

function _receiptsMissingEnqueueClients(list) {
  let queued = 0, local = 0, skipped = 0;
  for (const row of list || []) {
    for (const inv of row.missing) {
      if (receiptsLocalEntry(inv.invoice, inv)) { local++; continue; }
      const r = receiptsEnqueue(inv, { source: 'missing-list', priority: true, ignorePause: true });
      if (r.queued || r.reason === 'already') queued++;
      else if (r.reason === 'local') local++;
      else skipped++;
    }
  }
  return { queued, local, skipped };
}

function _receiptsMissingCurrentRows() {
  const els = _receiptsMissingEls();
  const onlyNone = !!(els.onlyNone && els.onlyNone.checked);
  const needle = String(els.search && els.search.value || '').trim().toLowerCase();
  return receiptsMissingClients(onlyNone).filter(r => _receiptsMissingMatches(r.client, needle));
}

async function receiptsOpenMissingList() {
  const els = _receiptsMissingEls();
  if (!els.overlay) return;
  els.overlay.classList.add('show');
  receiptsMissingRender();
  try { await receiptsLoadIndex(); } catch (e) { /* نعرض ما هو متاح */ }
  if (els.overlay && els.overlay.classList.contains('show')) receiptsMissingRender();
}

function receiptsCloseMissingList() {
  const els = _receiptsMissingEls();
  if (els.overlay) els.overlay.classList.remove('show');
}

function receiptsBindMissingListUI() {
  _receiptBindButton('btn-receipts-missing-clients', () => receiptsOpenMissingList());
  const els = _receiptsMissingEls();
  if (els.overlay && els.overlay.dataset.receiptBound !== '1') {
    els.overlay.dataset.receiptBound = '1';
    els.overlay.addEventListener('click', e => {
      if (e.target === els.overlay || e.target.closest('[data-receipts-missing-close]')) receiptsCloseMissingList();
    });
  }
  if (els.search && els.search.dataset.receiptBound !== '1') {
    els.search.dataset.receiptBound = '1';
    els.search.addEventListener('input', () => receiptsMissingRender());
  }
  if (els.onlyNone && els.onlyNone.dataset.receiptBound !== '1') {
    els.onlyNone.dataset.receiptBound = '1';
    els.onlyNone.addEventListener('change', () => receiptsMissingRender());
  }
  if (els.sort && els.sort.dataset.receiptBound !== '1') {
    els.sort.dataset.receiptBound = '1';
    els.sort.addEventListener('change', () => receiptsMissingRender());
  }
  if (els.list && els.list.dataset.receiptBound !== '1') {
    els.list.dataset.receiptBound = '1';
    els.list.addEventListener('click', async e => {
      const arkkanBtn = e.target.closest('[data-receipts-missing-arkkan]');
      if (arkkanBtn) {
        const id = String(arkkanBtn.getAttribute('data-receipts-missing-arkkan') || '');
        if (!id) return;
        if (typeof arkkanFetchCardButton !== 'function') {
          receiptToast('ميزة الجلب من أركان غير متاحة في هذه النسخة', 'error', 3500);
          return;
        }
        try {
          // نفس معالج زر كرت العميل تماماً (يجلب الرقم المرجعي أولاً لو ناقص ثم يقارن ويحفظ)
          await arkkanFetchCardButton(id, arkkanBtn);
        } finally {
          // قد يكون رقم الفاتورة/الدورة امتلأ من أركان — نعيد حساب القائمة والعدّاد
          _receiptsMissingClientsCache = { at: 0, fully: 0, any: 0 };
          receiptsMissingRender();
          try { receiptsUpdateUI(); } catch (err) {}
        }
        return;
      }
      const btn = e.target.closest('[data-receipts-missing-dl]');
      if (!btn) return;
      const id = String(btn.getAttribute('data-receipts-missing-dl') || '');
      const row = _receiptsMissingCurrentRows().find(r => String(r.client.id || '') === id);
      if (!row) return;
      const r = _receiptsMissingEnqueueClients([row]);
      if (r.queued) receiptToast(`📥 أُضيف ${r.queued} إيصالاً لطابور التحميل — واحداً وراء الآخر`, 'info', 3500);
      else if (r.local) receiptToast('✅ الإيصالات صارت محفوظة بالفعل', 'success', 3000);
      else receiptToast('تعذّر إضافة الإيصال للطابور — تحقق من رقم الفاتورة', 'error', 3500);
      receiptsMissingRender();
    });
  }
  if (els.download && els.download.dataset.receiptBound !== '1') {
    els.download.dataset.receiptBound = '1';
    els.download.addEventListener('click', () => {
      const rows = _receiptsMissingCurrentRows();
      if (!rows.length) { receiptToast('لا يوجد عملاء في القائمة', 'info', 3000); return; }
      const r = _receiptsMissingEnqueueClients(rows);
      if (r.queued) receiptToast(`📥 بدأ تحميل ${r.queued} إيصالاً — واحداً وراء الآخر`, 'info', 4500);
      else receiptToast('✅ كل إيصالات القائمة محفوظة بالفعل', 'success', 3500);
      receiptsMissingRender();
    });
  }
  if (!window.__receiptsMissingKeyBound) {
    window.__receiptsMissingKeyBound = true;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const ov = document.getElementById('receipts-missing-overlay');
      if (ov && ov.classList.contains('show')) receiptsCloseMissingList();
    });
    window.addEventListener('ftc2:receipt-saved', () => {
      const ov = document.getElementById('receipts-missing-overlay');
      if (ov && ov.classList.contains('show')) receiptsMissingRender();
    });
  }
}

/* ───────────────────── جلب إيصال واحد وحفظه ───────────────────── */

function receiptsPickMatchingReceipt(list, client) {
  const key = receiptInvoiceKey(client.invoice);
  const wantedKind = client.kind === 'bag' ? 'bag' : 'course';
  // لا نخلط الأنواع: إيصال حقيبة لا يُطابق فاتورة دورة، والعكس.
  const sameKind = (list || []).filter(r => r && (r.kind === 'bag' ? 'bag' : 'course') === wantedKind);
  let match = sameKind.find(r => receiptInvoiceKey(r.invoice) === key);
  if (match) return match;
  if (wantedKind !== 'course') return null;

  // احتياط دقيق: نفس رقم الدورة، وفقط لو كان الإيصال بلا رقم فاتورة أو الرقم غير مقروء.
  const courseNo = String(client.courseNumber || '').trim().toUpperCase();
  if (courseNo) {
    match = sameKind.find(r => String(r.courseNumber || '').trim().toUpperCase() === courseNo &&
      !receiptInvoiceKey(r.invoice));
    if (match) return match;
  }
  return null;
}

async function receiptsFetchAndSave(client, options) {
  const opts = options || {};
  if (!client || !client.clientId) throw new Error('رقم هوية العميل مطلوب للجلب من أركان');
  if (!client.invoice) throw new Error('لا يوجد رقم فاتورة لهذا العميل');
  const api = receiptDesktopApi();
  if (!api || typeof api.saveReceipt !== 'function') {
    throw new Error('حفظ الإيصالات المحلي متاح فقط من تطبيق سطح المكتب');
  }
  if (typeof arkkanEnsureAgentReady === 'function') await arkkanEnsureAgentReady();

  const base = (typeof ARKKAN_API_BASE !== 'undefined') ? ARKKAN_API_BASE : 'http://localhost:9955';
  const invoiceToken = String(client.invoice || '').trim();
  const body = {
    clientId: client.clientId,
    referNum: client.referNum || '',
    // جلب إيصال واحد فقط: نمرّر رقم الفاتورة المطلوبة ونوعها ورقم الدورة
    // ليفتح الوكيل صف الإيصال الصحيح ويتوقف فور المطابقة — بلا جلب جماعي.
    invoiceNo: invoiceToken,
    kind: client.kind || (/^[A-Za-z]/.test(invoiceToken) ? 'course' : 'bag'),
    courseNumber: String(client.courseNumber || '').trim(),
    forceRefresh: !!opts.force,
  };
  let res;
  try {
    res = await fetch(base + '/api/arkkan/receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    // لو الواجهة تُخدم من نفس الخادم المحلي، جرّب المسار النسبي كخط رجعة.
    res = await fetch('/api/arkkan/receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  }

  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch (e) {}
    const msg = (payload && payload.error) || ('فشل الوكيل المحلي — HTTP ' + res.status);
    const err = new Error(msg);
    if (res.status === 429) {
      err.retryAfter = Number(payload && payload.retryAfter) || 60;
      err.message = msg + ' — سيُعاد المحاولة تلقائياً بعد ' + err.retryAfter + ' ثانية';
    }
    throw err;
  }

  const data = await res.json();
  const list = Array.isArray(data.receipts) ? data.receipts : [];
  const receipt = receiptsPickMatchingReceipt(list, client);
  if (!receipt || !receipt.base64) {
    const scanned = Number(data && data.scanned) || 0;
    const available = list
      .filter(r => r && r.invoice)
      .map(r => r.invoice)
      .slice(0, 6)
      .join('، ');
    throw new Error(`لا يوجد إيصال مطابق لرقم الفاتورة ${client.invoice}` +
      (available ? ` — الأرقام المتاحة في أركان: ${available}`
        : scanned ? ` — فُحص ${scanned} إيصالاً في أركان واحداً واحداً بلا مطابقة`
          : ' — لم يُعثر على إيصال بهذا الرقم في أركان'));
  }

  const saved = await api.saveReceipt({
    clientId: client.clientId,
    clientName: client.name || '',
    clientRecordId: client.id || '',
    invoiceNo: client.invoice,
    kind: receipt.kind || client.kind || 'course',
    courseNumber: receipt.courseNumber || client.courseNumber || '',
    date: receipt.date || '',
    mime: receipt.mime || 'application/pdf',
    base64: receipt.base64,
    ext: receipt.ext || (receipt.mime === 'image/png' ? 'png' : 'pdf'),
  });
  if (!saved || !saved.ok) throw new Error((saved && saved.error) || 'تعذّر حفظ الإيصال على الجهاز');

  const entry = saved.entry || {
    invoiceNo: client.invoice,
    invoiceKey: receiptInvoiceKey(client.invoice),
    clientId: client.clientId,
    clientRecordId: client.id || '',
    clientName: client.name || '',
    kind: receipt.kind || client.kind || 'course',
    courseNumber: receipt.courseNumber || '',
    date: receipt.date || '',
    fileName: saved.fileName || '',
    path: saved.path || '',
    mime: receipt.mime || 'application/pdf',
    ext: receipt.ext || 'pdf',
    size: 0,
    savedAt: new Date().toISOString(),
  };
  // تسجيل في سجل التحميلات (لواجهة الإعدادات) — مجرد عدّاد، لا يؤثر على الحفظ المحلي.
  try {
    if (typeof arkkanReceiptsLogLoad === 'function' && typeof arkkanReceiptsLogMark === 'function') {
      await arkkanReceiptsLogLoad();
      arkkanReceiptsLogMark(entry.fileName || (entry.clientId + '_' + entry.invoiceNo));
      if (typeof arkkanReceiptsMarkClientDone === 'function') arkkanReceiptsMarkClientDone(entry.clientId);
    }
  } catch (e) {}

  return entry;
}

/* ───────────────────── الفحص التلقائي للجديد ───────────────────── */

function receiptsAutoScanSchedule(reason, delay) {
  if (_receiptScanTimer) clearTimeout(_receiptScanTimer);
  _receiptScanTimer = setTimeout(() => {
    _receiptScanTimer = null;
    receiptsAutoScan(reason).catch(() => {});
  }, Number.isFinite(delay) ? delay : 1200);
}

async function receiptsAutoScan(reason) {
  if (!window.__ftc2DataReady) return;
  if (!Array.isArray(clients) || !clients.length) return;
  await receiptsLoadIndex(false);
  if (settings && settings.arkkanAutoFetchEnabled === false) {
    receiptsUpdateUI();
    return;
  }

  const known = _receiptKnownMap();
  const invoiceClients = receiptInvoiceClients(clients);
  const initialized = !!known.__initialized;
  if (!initialized) {
    // أول تشغيل للميزة: الموجود حالياً = أرشيف قديم، لا نحمّله تلقائياً.
    // يظل متاحاً بزر «تحميل الإيصالات القديمة».
    known.__initialized = Date.now();
    for (const c of invoiceClients) {
      const id = _receiptKnownId(c);
      if (id) known[id] = Date.now();
    }
    known.__bagSeeded = known.__bagSeeded || Date.now();
    _receiptWriteJson(RECEIPT_KNOWN_KEY, known);
    receiptsUpdateUI();
    return;
  }

  let changed = false;
  // ترقية ربط شيت فواتير الحقائب: كل فواتير الحقائب الموجودة مسبقاً تُعتبر أرشيفاً قديماً
  // ولا تُحمَّل تلقائياً — تُسجَّل «معروفة» مرة واحدة فقط، وأي رقم حقيبة جديد بعدها يُحمَّل تلقائياً.
  if (!known.__bagSeeded) {
    known.__bagSeeded = Date.now();
    for (const c of invoiceClients) {
      if (c.kind !== 'bag') continue;
      const id = _receiptKnownId(c);
      if (id && !known[id]) known[id] = Date.now();
    }
    changed = true;
  }

  let queued = 0;
  for (const c of invoiceClients) {
    const id = _receiptKnownId(c);
    if (!id || _receiptIsKnown(known, c)) continue;
    // محفوظ محلياً بالفعل: نعتبره معروفاً بلا أي تحميل.
    if (receiptsLocalEntry(c.invoice, c)) {
      known[id] = Date.now();
      changed = true;
      continue;
    }
    // فشل سابق ما زال داخل مهلة الانتظار — لا نغرق الوكيل بمحاولات متكررة.
    if (receiptFailureBlocked(c.invoice, c)) continue;
    // لا نعلّمه «معروفاً» إلا بعد نجاح الحفظ (في العامل)، حتى يُعاد تلقائياً
    // لو فشل تحميله مؤقتاً — بدل أن يضيع الرقم الجديد بلا إيصال.
    const r = receiptsEnqueue(c, { source: 'auto' });
    if (r.queued) queued++;
  }
  if (changed) _receiptWriteJson(RECEIPT_KNOWN_KEY, known);
  receiptsUpdateUI();
  if (queued) {
    receiptToast(`🆕 ظهر ${queued} رقم فاتورة جديد — بدأ تحميله تلقائياً واحداً وراء الآخر`, 'info', 4500);
    receiptsStartWorker();
  }
}

/* ───────────────────── شاشة العرض والطباعة ───────────────────── */

function _receiptViewerEls() {
  return {
    overlay: document.getElementById('receipt-viewer-overlay'),
    title: document.getElementById('receipt-viewer-title'),
    meta: document.getElementById('receipt-viewer-meta'),
    status: document.getElementById('receipt-viewer-status'),
    frame: document.getElementById('receipt-viewer-frame'),
    image: document.getElementById('receipt-viewer-image'),
    print: document.getElementById('receipt-viewer-print'),
    folder: document.getElementById('receipt-viewer-folder'),
    exportBtn: document.getElementById('receipt-viewer-export'),
    redownload: document.getElementById('receipt-viewer-redownload'),
    close: document.getElementById('receipt-viewer-close'),
  };
}

function receiptsCloseViewer() {
  const els = _receiptViewerEls();
  _receiptViewer = null;
  if (els.overlay) els.overlay.classList.remove('show');
  if (els.frame) els.frame.removeAttribute('src');
  if (els.image) { els.image.removeAttribute('src'); els.image.style.display = 'none'; }
}

/* ───────────── مساعدات إرسال الإيصالات عبر واتساب ─────────────
   واتساب لا يسمح لأي تطبيق بإرفاق ملف تلقائياً، لذلك نحفظ نسخ PDF في
   مجلد يختاره المستخدم ثم نفتح محادثة واتساب لكل عميل ليرفق ملفه. */
function _receiptWaPhone(phone) {
  let d = String(phone || '')
    .replace(/[٠-٩]/g, ch => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, ch => String(ch.charCodeAt(0) - 0x06F0))
    .replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) return d;
  if (d.startsWith('0') && d.length >= 9) return '966' + d.slice(1);
  if (d.length === 9 && d.startsWith('5')) return '966' + d;
  return d;
}

function _receiptWaUrl(phone, text) {
  const d = _receiptWaPhone(phone);
  return `https://wa.me/${d}?text=${encodeURIComponent(text || '')}`;
}

function _receiptOpenWhatsapp(url) {
  try {
    const w = window.open(url, '_blank', 'noopener');
    // في Electron يُفتح الرابط في المتصفح الخارجي عبر setWindowOpenHandler،
    // ويرجع null — لا نستخدم location.href حتى لا تُستبدل واجهة البرنامج.
    if (!w && !window.desktopAPI) { try { window.location.href = url; } catch (e) {} }
  } catch (e) {
    console.error('تعذّر فتح واتساب:', e);
  }
}

function _receiptFileUrl(client, entry) {
  const shownInvoice = String((client && client.invoice) || (entry && entry.invoiceNo) || '');
  return '/receipts-file?invoice=' + encodeURIComponent((entry && entry.invoiceNo) || shownInvoice) +
    '&clientId=' + encodeURIComponent((entry && entry.clientId) || (client && client.clientId) || '') +
    '&course=' + encodeURIComponent((entry && entry.courseNumber) || (client && client.courseNumber) || '') +
    '&v=' + encodeURIComponent((entry && entry.savedAt) || Date.now());
}

function _receiptViewerMeta(client, entry) {
  const kind = entry && entry.kind === 'bag' ? 'حقيبة' : 'دورة';
  const clientInvoice = String((client && client.invoice) || '');
  const fileInvoice = String((entry && entry.invoiceNo) || '');
  const parts = [
    `العميل: <b>${receiptEscape(client.name || '—')}</b>`,
    `الفاتورة: <b class="mono">${receiptEscape(clientInvoice || fileInvoice || '—')}</b>`,
    `النوع: ${kind}`,
  ];
  // الملفات القديمة مسماة برقم الدورة — نوضح ذلك بدل خلط الرقمين.
  if (fileInvoice && receiptInvoiceKey(fileInvoice) !== receiptInvoiceKey(clientInvoice)) {
    parts.push(`مرجع الملف: <b class="mono">${receiptEscape(fileInvoice)}</b>`);
  }
  if (entry && entry.courseNumber) parts.push(`رقم الدورة: <b class="mono">${receiptEscape(entry.courseNumber)}</b>`);
  if (entry && entry.date) parts.push(`التاريخ: ${receiptEscape(entry.date)}`);
  if (entry && entry.savedAt) {
    try { parts.push(`حُفظ: ${new Date(entry.savedAt).toLocaleString('ar-SA-u-nu-latn')}`); } catch (e) {}
  }
  return parts.join(' · ');
}

function _receiptShowViewerLoading(message) {
  const els = _receiptViewerEls();
  if (!els.overlay) return;
  els.overlay.classList.add('show');
  if (els.frame) { els.frame.removeAttribute('src'); els.frame.style.display = 'none'; }
  if (els.image) { els.image.removeAttribute('src'); els.image.style.display = 'none'; }
  if (els.status) {
    els.status.style.display = '';
    els.status.innerHTML = `<div class="receipt-viewer-loading"><span class="receipt-spinner"></span><div>${receiptEscape(message || 'جارٍ تحميل الإيصال...')}</div></div>`;
  }
  if (els.print) els.print.disabled = true;
  if (els.folder) els.folder.disabled = true;
  if (els.exportBtn) els.exportBtn.disabled = true;
  if (els.redownload) els.redownload.disabled = true;
}

function _receiptShowViewerEntry(client, entry) {
  const els = _receiptViewerEls();
  if (!els.overlay) return;
  _receiptViewer = { client, entry };
  const shownInvoice = String(client.invoice || (entry && entry.invoiceNo) || '');
  if (els.title) els.title.textContent = 'إيصال أركان — ' + shownInvoice;
  if (els.meta) els.meta.innerHTML = _receiptViewerMeta(client, entry);
  if (els.status) { els.status.style.display = 'none'; els.status.innerHTML = ''; }

  // نمرر رقم الملف ورقم الدورة أيضاً: الملفات القديمة تحمل رقم الدورة في اسمها لا رقم الفاتورة.
  const url = _receiptFileUrl(client, entry);
  const isImage = entry && (entry.mime || '').startsWith('image/');
  if (isImage) {
    if (els.frame) { els.frame.removeAttribute('src'); els.frame.style.display = 'none'; }
    if (els.image) { els.image.src = url; els.image.style.display = 'block'; }
  } else {
    if (els.image) { els.image.removeAttribute('src'); els.image.style.display = 'none'; }
    if (els.frame) { els.frame.style.display = 'block'; els.frame.src = url; }
  }

  if (els.print) els.print.disabled = false;
  if (els.folder) els.folder.disabled = false;
  if (els.exportBtn) els.exportBtn.disabled = false;
  if (els.redownload) els.redownload.disabled = false;
  els.overlay.classList.add('show');
  receiptsRefreshIndicators(client.invoice, client);
}

function _receiptShowViewerError(client, error) {
  const els = _receiptViewerEls();
  if (!els.overlay) return;
  if (els.frame) { els.frame.removeAttribute('src'); els.frame.style.display = 'none'; }
  if (els.image) { els.image.removeAttribute('src'); els.image.style.display = 'none'; }
  if (els.status) {
    els.status.style.display = '';
    els.status.innerHTML = `<div class="receipt-viewer-error">
      <div class="receipt-viewer-error-icon">⚠️</div>
      <div style="font-weight:700;margin-bottom:4px;">تعذّر تحميل الإيصال</div>
      <div style="font-size:12.5px;line-height:1.7;">${receiptEscape(String((error && error.message) || error || 'خطأ غير معروف'))}</div>
      <button type="button" class="btn btn-gold btn-sm" id="receipt-viewer-retry" style="margin-top:10px;">🔄 إعادة المحاولة</button>
    </div>`;
    const retry = document.getElementById('receipt-viewer-retry');
    if (retry) retry.addEventListener('click', () => _receiptViewerRetry(true));
  }
  if (els.print) els.print.disabled = true;
  if (els.folder) els.folder.disabled = false;
  if (els.exportBtn) els.exportBtn.disabled = true;
  if (els.redownload) els.redownload.disabled = false;
  els.overlay.classList.add('show');
}

async function receiptsOpenViewer(clientRecordId, invoiceNo, kind) {
  const base = (Array.isArray(clients) ? clients : []).find(c => String(c.id) === String(clientRecordId));
  if (!base) { receiptToast('العميل غير موجود', 'error'); return; }
  const invoice = String(invoiceNo || base.invoice || '').trim();
  if (!invoice) { receiptToast('لا يوجد رقم فاتورة لهذا العميل', 'info'); return; }
  // فاتورة الحقيبة تُفتح بنوعها الصريح حتى لا تُطابق إيصال دورة بنفس الرقم.
  const resolvedKind = (kind === 'bag' || kind === 'course')
    ? kind
    : (/^[A-Za-z]/.test(invoice) ? 'course' : 'bag');
  const client = Object.assign({}, base, {
    invoice,
    kind: resolvedKind,
    // إيصال الحقيبة لا يُطابق أبداً ملفاً قديماً محفوظاً برقم الدورة.
    courseNumber: resolvedKind === 'bag' ? '' : String(base.courseNumber || ''),
  });

  const api = receiptDesktopApi();
  if (!api) { return receiptsOpenBrowserFallback(client, invoice); }

  _receiptViewer = { client, entry: null };
  const els = _receiptViewerEls();
  if (els.title) els.title.textContent = 'إيصال أركان — ' + invoice;
  if (els.meta) els.meta.innerHTML = _receiptViewerMeta(client, null);
  _receiptShowViewerLoading('جارٍ البحث عن نسخة محفوظة على الجهاز...');

  await receiptsLoadIndex(true);
  const local = receiptsLocalEntry(invoice, client);
  if (local) { _receiptShowViewerEntry(client, local); return; }

  const result = receiptsEnqueue(client, { source: 'click', priority: true, ignorePause: true });
  if (result.reason === 'no-client-id') { _receiptShowViewerError(client, new Error('لا يوجد رقم هوية لهذا العميل — لا يمكن الجلب من أركان')); return; }
  if (result.reason === 'no-invoice') { _receiptShowViewerError(client, new Error('لا يوجد رقم فاتورة لهذا العميل')); return; }
  if (result.reason === 'local' && result.promise) {
    const entry = await result.promise;
    if (_receiptViewer && String(_receiptViewer.client.id) === String(client.id)) _receiptShowViewerEntry(client, entry);
    return;
  }

  _receiptShowViewerLoading('الإيصال غير محفوظ — جارٍ تحميله من أركان ضمن الطابور (واحد وراء الآخر)...');
  try {
    const entry = await result.promise;
    if (_receiptViewer && String(_receiptViewer.client.id) === String(client.id)) {
      _receiptShowViewerEntry(client, entry);
      receiptToast('✅ تم حفظ الإيصال محلياً', 'success');
    }
  } catch (e) {
    if (_receiptViewer && String(_receiptViewer.client.id) === String(client.id)) _receiptShowViewerError(client, e);
  }
}

/* نسخة المتصفح/PWA: لا يوجد حفظ محلي — نعرض الإيصال في تبويب جديد مباشرة */
async function receiptsOpenBrowserFallback(client, invoice) {
  const loading = receiptToast('⏳ جارٍ جلب الإيصال من أركان...', 'info', 0);
  try {
    if (typeof arkkanEnsureAgentReady === 'function') {
      try { await arkkanEnsureAgentReady(); } catch (e) {}
    }
    const base = (typeof ARKKAN_API_BASE !== 'undefined') ? ARKKAN_API_BASE : 'http://localhost:9955';
    const invoiceToken = String(client.invoice || invoice || '').trim();
    const body = {
      clientId: client.clientId,
      referNum: client.referNum || '',
      invoiceNo: invoiceToken,
      kind: client.kind || (/^[A-Za-z]/.test(invoiceToken) ? 'course' : 'bag'),
      courseNumber: String(client.courseNumber || '').trim(),
      forceRefresh: false,
    };
    let res;
    try {
      res = await fetch(base + '/api/arkkan/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    } catch (e) {
      res = await fetch('/api/arkkan/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    }
    if (!res.ok) throw new Error('فشل الوكيل المحلي — HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.receipts) ? data.receipts : [];
    const receipt = receiptsPickMatchingReceipt(list, client);
    if (!receipt || !receipt.base64) {
      throw new Error('لا يوجد إيصال مطابق لرقم الفاتورة ' + invoice);
    }
    const url = 'data:' + (receipt.mime || 'application/pdf') + ';base64,' + receipt.base64;
    const win = window.open(url, '_blank');
    if (!win) throw new Error('تم منع النوافذ المنبثقة — يرجى السماح بها لعرض الإيصال');
    receiptToast('📄 تم فتح الإيصال في تبويب جديد — يمكنك طباعته أو حفظه من هناك', 'success', 5000);
  } catch (e) {
    receiptToast('❌ ' + String((e && e.message) || e), 'error', 7000);
  } finally {
    if (loading && typeof loading.close === 'function') loading.close();
  }
}

async function _receiptViewerRetry(force) {
  const viewer = _receiptViewer;
  if (!viewer || !viewer.client) return;
  const client = viewer.client;
  _receiptShowViewerLoading(force ? 'جارٍ إعادة التحميل من أركان...' : 'جارٍ التحميل...');
  const result = receiptsEnqueue(client, { source: 'click', priority: true, ignorePause: true, force: !!force });
  try {
    const entry = await result.promise;
    if (_receiptViewer && String(_receiptViewer.client.id) === String(client.id)) _receiptShowViewerEntry(client, entry);
  } catch (e) {
    if (_receiptViewer && String(_receiptViewer.client.id) === String(client.id)) _receiptShowViewerError(client, e);
  }
}

/* ────────────────────────── واجهة الحالة ────────────────────────── */

function _receiptStatusText() {
  if (_receiptCurrentJob) {
    const c = _receiptCurrentJob.client;
    const name = c && c.name ? c.name : (c && c.clientId) || '';
    const rest = Math.max(0, _receiptQueue.length);
    return `⏳ جارٍ تحميل إيصال: ${name} (${_receiptCurrentJob.key}) — متبقي ${rest}`;
  }
  if (_receiptPaused) {
    return _receiptQueue.length
      ? `⏸️ الجلب متوقف — ${_receiptQueue.length} إيصال في الانتظار`
      : '⏸️ جلب الإيصالات متوقف';
  }
  if (_receiptQueue.length) return `⏳ ${_receiptQueue.length} إيصال في الانتظار — سيبدأ واحداً وراء الآخر`;
  return '';
}

function receiptsUpdateUI() {
  const text = _receiptStatusText();
  const active = !!text;
  const toolbarStatus = document.getElementById('receipts-queue-status');
  if (toolbarStatus) {
    toolbarStatus.textContent = text;
    toolbarStatus.style.display = active ? '' : 'none';
  }

  const missing = receiptsMissingCount();
  const backlogBtns = [document.getElementById('btn-receipts-backlog'), document.getElementById('btn-receipts-backlog-settings')];
  backlogBtns.forEach(btn => {
    if (!btn) return;
    btn.disabled = missing === 0 && !_receiptBacklogRunning;
    btn.innerHTML = missing > 0
      ? `📥 تحميل الإيصالات القديمة (${missing})`
      : '📥 تحميل الإيصالات القديمة';
  });

  const missingClients = receiptsMissingClientStats();
  const missingClientsBtn = document.getElementById('btn-receipts-missing-clients');
  if (missingClientsBtn) {
    missingClientsBtn.disabled = missingClients.fully === 0 && missingClients.any === 0;
    missingClientsBtn.innerHTML = missingClients.any > 0
      ? `👥 بلا إيصالات (${missingClients.any})`
      : '👥 بلا إيصالات';
  }

  const toggleBtns = [document.getElementById('btn-receipts-toggle'), document.getElementById('btn-receipts-pause-settings')];
  toggleBtns.forEach(btn => {
    if (!btn) return;
    if (btn.id === 'btn-receipts-pause-settings') {
      btn.disabled = _receiptPaused;
      return;
    }
    btn.innerHTML = _receiptPaused ? '▶️ تشغيل الجلب' : '⏸️ إيقاف الجلب';
    btn.classList.toggle('btn-gold', _receiptPaused);
    btn.classList.toggle('btn-ghost', !_receiptPaused);
  });

  const resumeBtn = document.getElementById('btn-receipts-resume-settings');
  if (resumeBtn) resumeBtn.disabled = !_receiptPaused;

  const settingsStatus = document.getElementById('arkkan-receipts-queue-status');
  if (settingsStatus) {
    const savedCount = _receiptsIndexEntries.length;
    settingsStatus.innerHTML = `${text ? receiptEscape(text) + '<br>' : ''}` +
      `📁 إيصالات محفوظة على الجهاز: <b>${savedCount}</b>` +
      (missing ? ` · ⏳ ناقص: <b>${missing}</b>` : ' · ✅ لا يوجد ناقص');
  }
  receiptsRefreshIndicators();
}

/* ────────────────────────── التهيئة ────────────────────────── */

function _receiptBindButton(id, handler) {
  const el = document.getElementById(id);
  if (!el || el.dataset.receiptBound === '1') return;
  el.dataset.receiptBound = '1';
  el.addEventListener('click', handler);
}

function receiptsBindUI() {
  _receiptBindButton('btn-receipts-backlog', () => receiptsStartBacklog());
  _receiptBindButton('btn-receipts-backlog-settings', () => receiptsStartBacklog());
  _receiptBindButton('btn-receipts-toggle', () => (_receiptPaused ? receiptResumeQueue() : receiptPauseQueue()));
  _receiptBindButton('btn-receipts-pause-settings', () => receiptPauseQueue());
  _receiptBindButton('btn-receipts-resume-settings', () => receiptResumeQueue());
  _receiptBindButton('btn-receipts-stop-backlog-settings', () => receiptsStopBacklog());
  receiptsBindMissingListUI();

  const overlay = document.getElementById('receipt-viewer-overlay');
  if (overlay && overlay.dataset.receiptBound !== '1') {
    overlay.dataset.receiptBound = '1';
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-receipt-close]')) receiptsCloseViewer();
    });
  }

  const closeBtn = document.getElementById('receipt-viewer-close');
  if (closeBtn && closeBtn.dataset.receiptBound !== '1') {
    closeBtn.dataset.receiptBound = '1';
    closeBtn.addEventListener('click', receiptsCloseViewer);
  }

  const printBtn = document.getElementById('receipt-viewer-print');
  if (printBtn && printBtn.dataset.receiptBound !== '1') {
    printBtn.dataset.receiptBound = '1';
    printBtn.addEventListener('click', async () => {
      const v = _receiptViewer;
      if (!v || !v.entry) return;
      printBtn.disabled = true;
      try {
        const r = await receiptDesktopApi().printReceipt({
          invoiceNo: v.entry.invoiceNo,
          clientId: v.entry.clientId,
          printOptions: receiptsPrintSettings(),
        });
        if (r && r.ok) receiptToast('🖨️ تم إرسال الإيصال للطباعة', 'success');
        else if (r && /إلغاء/.test(String(r.error || ''))) receiptToast('تم إلغاء الطباعة', 'info');
        else receiptToast('تعذّرت الطباعة: ' + ((r && r.error) || 'خطأ غير معروف'), 'error');
      } catch (e) {
        receiptToast('تعذّرت الطباعة: ' + String(e.message || e), 'error');
      } finally { printBtn.disabled = false; }
    });
  }

  const folderBtn = document.getElementById('receipt-viewer-folder');
  if (folderBtn && folderBtn.dataset.receiptBound !== '1') {
    folderBtn.dataset.receiptBound = '1';
    folderBtn.addEventListener('click', async () => {
      const v = _receiptViewer;
      const clientId = (v && v.entry && v.entry.clientId) || (v && v.client && v.client.clientId) || '';
      const invoiceNo = v && v.entry ? v.entry.invoiceNo : '';
      const r = await receiptDesktopApi().openReceiptsFolder(clientId, invoiceNo);
      if (!r || !r.ok) receiptToast('تعذّر فتح المجلد: ' + ((r && r.error) || ''), 'error');
    });
  }

  const exportBtn = document.getElementById('receipt-viewer-export');
  if (exportBtn && exportBtn.dataset.receiptBound !== '1') {
    exportBtn.dataset.receiptBound = '1';
    exportBtn.addEventListener('click', async () => {
      const v = _receiptViewer;
      if (!v || !v.entry) return;
      const r = await receiptDesktopApi().exportReceipt({ invoiceNo: v.entry.invoiceNo, clientId: v.entry.clientId });
      if (r && r.ok) receiptToast('📥 تم حفظ نسخة: ' + r.path, 'success', 5000);
      else if (r && !r.canceled) receiptToast('تعذّر حفظ النسخة: ' + ((r && r.error) || ''), 'error');
    });
  }

  const redownloadBtn = document.getElementById('receipt-viewer-redownload');
  if (redownloadBtn && redownloadBtn.dataset.receiptBound !== '1') {
    redownloadBtn.dataset.receiptBound = '1';
    redownloadBtn.addEventListener('click', () => _receiptViewerRetry(true));
  }

  if (!window.__receiptsViewerKeyBound) {
    window.__receiptsViewerKeyBound = true;
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _receiptViewer) receiptsCloseViewer();
    });
  }

  // زر «طباعة إيصالات المحدد» + نافذتها
  receiptsBindBatchPrintUI();
}

/* ─────────── طباعة دفعة إيصالات (دورة + حقيبة) لعدة عملاء بضغطة واحدة ───────────
   الطابعة تُختار مرة واحدة في نافذة داخل البرنامج، ثم تُطبع الإيصالات تباعاً
   بلا أي نافذة إضافية (طباعة صامتة على نفس الطابعة). */
let _receiptBatchRunning = false;
let _receiptBatchOffProgress = null;
let _receiptBatchPlan = { items: [], found: [], missing: [] };
/* نطاق الطباعة: null = العملاء المحددون بالشيت، أو { clients, title, subtitle } لدورة معيّنة. */
let _receiptBatchScope = null;

function _receiptBatchEls() {
  return {
    overlay: document.getElementById('receipt-batch-print-overlay'),
    summary: document.getElementById('receipt-batch-summary'),
    kindCourse: document.getElementById('receipt-batch-kind-course'),
    kindBag: document.getElementById('receipt-batch-kind-bag'),
    printer: document.getElementById('receipt-batch-printer'),
    refreshPrinters: document.getElementById('receipt-batch-refresh-printers'),
    copies: document.getElementById('receipt-batch-copies'),
    paper: document.getElementById('receipt-batch-paper'),
    margin: document.getElementById('receipt-batch-margin'),
    scale: document.getElementById('receipt-batch-scale'),
    scaleValue: document.getElementById('receipt-batch-scale-value'),
    preview: document.getElementById('receipt-batch-preview'),
    note: document.getElementById('receipt-batch-note'),
    progress: document.getElementById('receipt-batch-progress'),
    barFill: document.getElementById('receipt-batch-bar-fill'),
    progressText: document.getElementById('receipt-batch-progress-text'),
    result: document.getElementById('receipt-batch-result'),
    start: document.getElementById('receipt-batch-start'),
    stop: document.getElementById('receipt-batch-stop'),
    whatsapp: document.getElementById('receipt-batch-whatsapp'),
  };
}

/* ── إعدادات مقاس الطباعة: تُحفظ على الجهاز وتُستخدم في الطباعة المفردة والدفعة ──
   percent = 100 يعني «أكبر حجم ممكن مع بقاء الإيصال كاملاً داخل حدود الطباعة»،
   وليس 100% من الحجم الأصلي — حتى لا تُقصّ الحواف على الطابعات الليزرية. */
const RECEIPT_PRINT_SETTINGS_KEY = 'ftc2.receiptPrintSettings.v1';
const RECEIPT_PRINT_DEFAULTS = { paper: 'A4', marginMm: 6, percent: 100 };

function receiptsPrintSettings() {
  let saved = {};
  try {
    const raw = localStorage.getItem(RECEIPT_PRINT_SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (e) { saved = {}; }
  const paper = ['A4', 'A5', 'Letter', 'Legal'].includes(saved.paper) ? saved.paper : RECEIPT_PRINT_DEFAULTS.paper;
  const m = Number(saved.marginMm);
  const marginMm = Number.isFinite(m) && m >= 0 && m <= 20 ? m : RECEIPT_PRINT_DEFAULTS.marginMm;
  const p = Number(saved.percent);
  const percent = Number.isFinite(p) && p >= 30 && p <= 100 ? p : RECEIPT_PRINT_DEFAULTS.percent;
  return { paper, marginMm, percent };
}

function receiptsSavePrintSettings(settings) {
  const s = Object.assign({}, receiptsPrintSettings(), settings || {});
  try { localStorage.setItem(RECEIPT_PRINT_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  return s;
}

function _receiptBatchPrintOptions() {
  const els = _receiptBatchEls();
  return receiptsSavePrintSettings({
    paper: els.paper ? String(els.paper.value || 'A4') : undefined,
    marginMm: els.margin ? Number(els.margin.value) : undefined,
    percent: els.scale ? Number(els.scale.value) : undefined,
  });
}

function _receiptBatchApplyPrintSettings() {
  const els = _receiptBatchEls();
  const s = receiptsPrintSettings();
  if (els.paper) els.paper.value = s.paper;
  if (els.margin) els.margin.value = String(s.marginMm);
  if (els.scale) els.scale.value = String(s.percent);
  _receiptBatchUpdateScaleLabel();
}

function _receiptBatchUpdateScaleLabel() {
  const els = _receiptBatchEls();
  if (!els.scale) return;
  const pct = Math.max(30, Math.min(100, Number(els.scale.value) || 100));
  if (els.scaleValue) els.scaleValue.textContent = pct + '%';
}

function receiptsBatchSelectedClients() {
  const ids = (typeof selectedClientIds !== 'undefined' && selectedClientIds) ? Array.from(selectedClientIds) : [];
  if (!ids.length) return [];
  const all = Array.isArray(clients) ? clients : [];
  const set = new Set(ids.map(String));
  return all.filter(c => set.has(String(c.id)));
}

/* عملاء النطاق الحالي: دورة معيّنة (من شيت الدورات) أو المحددون بالشيت. */
function receiptsBatchScopeClients() {
  if (_receiptBatchScope && Array.isArray(_receiptBatchScope.clients)) return _receiptBatchScope.clients;
  return receiptsBatchSelectedClients();
}

function _receiptBatchBuildItems(list) {
  const els = _receiptBatchEls();
  const wantCourse = !!(els.kindCourse && els.kindCourse.checked);
  const wantBag = !!(els.kindBag && els.kindBag.checked);
  const items = [];
  let noCourseInvoice = 0, noBagInvoice = 0;
  for (const c of list) {
    if (wantCourse) {
      const inv = String(c.invoice || '').trim();
      if (inv) items.push({ clientId: String(c.clientId || ''), clientRecordId: String(c.id || ''), name: String(c.name || ''), invoiceNo: inv, kind: 'course' });
      else noCourseInvoice++;
    }
    if (wantBag) {
      const inv = String(c.bagInvoice || '').trim();
      if (inv) items.push({ clientId: String(c.clientId || ''), clientRecordId: String(c.id || ''), name: String(c.name || ''), invoiceNo: inv, kind: 'bag' });
      else noBagInvoice++;
    }
  }
  return { items, noCourseInvoice, noBagInvoice };
}

function _receiptBatchProgress(index, total, text) {
  const els = _receiptBatchEls();
  const pct = total > 0 ? Math.min(100, Math.round((index / total) * 100)) : 0;
  if (els.barFill) els.barFill.style.width = pct + '%';
  if (els.progressText) els.progressText.textContent = text || '';
}

async function _receiptBatchRefreshPlan() {
  const els = _receiptBatchEls();
  const api = receiptDesktopApi();
  const list = receiptsBatchScopeClients();
  const scopeLabel = _receiptBatchScope ? 'عملاء الدورة' : 'عملاء محددون';
  if (!els.summary) return;
  if (!list.length) {
    els.summary.innerHTML = 'لا يوجد عملاء في هذا النطاق.';
    if (els.start) els.start.disabled = true;
    if (els.whatsapp) els.whatsapp.disabled = true;
    return;
  }
  const built = _receiptBatchBuildItems(list);
  if (!built.items.length) {
    els.summary.innerHTML = `👥 ${scopeLabel}: <b>${list.length}</b><br>⚠️ لا توجد إيصالات قابلة للطباعة — تحقق من أرقام الفواتير/إيصالات الحقائب.`;
    if (els.start) els.start.disabled = true;
    if (els.whatsapp) els.whatsapp.disabled = true;
    _receiptBatchPlan = { items: [], found: [], missing: [] };
    return;
  }
  els.summary.innerHTML = '⏳ جارٍ التحقق من الإيصالات المحفوظة على الجهاز...';
  if (els.start) els.start.disabled = true;
  if (els.whatsapp) els.whatsapp.disabled = true;

  let rows = built.items.map(x => Object.assign({}, x, { found: false }));
  try {
    const res = await api.resolveReceiptBatch({ items: built.items });
    if (res && res.ok && Array.isArray(res.items)) rows = res.items;
  } catch (e) {}

  const found = rows.filter(r => r.found);
  const missing = rows.filter(r => !r.found);
  _receiptBatchPlan = { items: rows, found, missing };
  const kinds = {};
  found.forEach(r => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });

  let html = `👥 ${scopeLabel}: <b>${list.length}</b> · إيصالات مطلوبة: <b>${rows.length}</b>`;
  html += `<br>✅ محفوظة على الجهاز: <b>${found.length}</b>`;
  if (found.length) html += ` <span style="color:var(--text-muted);">(دورة ${kinds.course || 0} · حقيبة ${kinds.bag || 0})</span>`;
  if (missing.length) html += `<br>⚠️ غير محفوظة (ستُستثنى من الطباعة): <b>${missing.length}</b>`;
  if (built.noCourseInvoice) html += `<br><span style="color:var(--text-muted);">بلا رقم فاتورة دورة: ${built.noCourseInvoice}</span>`;
  if (built.noBagInvoice) html += `<br><span style="color:var(--text-muted);">بلا رقم إيصال حقيبة: ${built.noBagInvoice}</span>`;
  els.summary.innerHTML = html;

  if (els.note) {
    _receiptBatchUpdateNote();
  }
  if (els.start) els.start.disabled = found.length === 0;
  if (els.whatsapp) els.whatsapp.disabled = found.length === 0;
}

function _receiptBatchUpdateNote() {
  const els = _receiptBatchEls();
  if (!els.note) return;
  const found = (_receiptBatchPlan && _receiptBatchPlan.found ? _receiptBatchPlan.found.length : 0);
  const printer = els.printer ? String(els.printer.value || '') : '';
  const virtual = /pdf|onenote|xps|fax|document writer/i.test(printer);
  const emptyHint = _receiptBatchScope
    ? `لا يوجد إيصال محفوظ على الجهاز لهؤلاء المسجّلين — حمّلها من كرت العميل أو من زر «📥 إيصالات للمحدد» في شيت العملاء.`
    : `لا يوجد إيصال محفوظ على الجهاز لهذا التحديد — استخدم «📥 إيصالات للمحدد» لتحميلها أولاً.`;
  let html = found
    ? `الترتيب: لكل عميل <b>إيصال الدورة</b> ثم <b>إيصال الحقيبة</b> — كل إيصال في صفحة/ورقة مستقلة.`
    : emptyHint;
  if (found && virtual) {
    html += `<br>⚠️ الطابعة المختارة طابعة افتراضية (PDF/OneNote) — قد تطلب اسم ملف لكل إيصال. اختر طابعة ورقية للطباعة الصامتة.`;
  }
  const ps = receiptsPrintSettings();
  html += `<br>📐 ورق <b>${receiptEscape(ps.paper)}</b> · هامش أمان <b>${receiptEscape(String(ps.marginMm))} مم</b> · حجم <b>${receiptEscape(String(ps.percent))}%</b>`;
  if (found) {
    html += `<br>📲 زر «إرسال واتساب» يحفظ نسخ PDF (دورة/حقيبة) في مجلد تختاره، ثم يفتح محادثة واتساب لكل عميل لإرفاق ملفه.`;
  }
  els.note.innerHTML = html;
}

async function _receiptBatchLoadPrinters() {
  const els = _receiptBatchEls();
  const api = receiptDesktopApi();
  if (!els.printer || !api || typeof api.listPrinters !== 'function') return;
  const prev = els.printer.value;
  els.printer.innerHTML = '<option value="">جارٍ تحميل الطابعات...</option>';
  try {
    const r = await api.listPrinters();
    const list = (r && r.ok && Array.isArray(r.printers)) ? r.printers : [];
    if (!list.length) {
      els.printer.innerHTML = '<option value="">لا توجد طابعات مثبتة على الجهاز</option>';
      return;
    }
    els.printer.innerHTML = list.map(p => {
      const label = (p.displayName || p.name) + (p.isDefault ? ' (افتراضية)' : '');
      return `<option value="${receiptEscape(p.name)}"${p.isDefault ? ' selected' : ''}>${receiptEscape(label)}</option>`;
    }).join('');
    if (prev && list.some(p => p.name === prev)) els.printer.value = prev;
    _receiptBatchUpdateNote();
  } catch (e) {
    els.printer.innerHTML = '<option value="">تعذّر تحميل الطابعات</option>';
  }
}

async function receiptsOpenBatchPrint(scope) {
  const els = _receiptBatchEls();
  if (!els.overlay) return;
  _receiptBatchScope = (scope && Array.isArray(scope.clients))
    ? { clients: scope.clients, title: String(scope.title || ''), subtitle: String(scope.subtitle || '') }
    : null;
  const list = receiptsBatchScopeClients();
  if (!list.length) {
    receiptToast(_receiptBatchScope ? 'لا يوجد عملاء في هذه الدورة' : 'لا يوجد عملاء محددين', 'info');
    return;
  }
  if (!receiptDesktopApi()) { receiptToast('طباعة الدفعات متاحة فقط من تطبيق سطح المكتب', 'info'); return; }
  const titleEl = document.getElementById('receipt-batch-title');
  if (titleEl) {
    titleEl.textContent = (_receiptBatchScope && _receiptBatchScope.title)
      ? '🖨️ ' + _receiptBatchScope.title
      : '🖨️ طباعة إيصالات المحدد';
  }
  _receiptBatchPlan = { items: [], found: [], missing: [] };
  if (els.result) { els.result.style.display = 'none'; els.result.innerHTML = ''; }
  if (els.progress) els.progress.style.display = 'none';
  if (els.start) els.start.disabled = true;
  if (els.whatsapp) els.whatsapp.disabled = true;
  if (els.stop) els.stop.style.display = 'none';
  _receiptBatchApplyPrintSettings();
  els.overlay.classList.add('show');
  _receiptBatchLoadPrinters();
  await _receiptBatchRefreshPlan();
  // سطر توضيحي لنطاق الدورة (عدد المسجّلين وأصحاب الفواتير)
  if (_receiptBatchScope && _receiptBatchScope.subtitle && els.summary) {
    els.summary.innerHTML += `<br><span style="color:var(--text-muted);font-size:12px;">${receiptEscape(_receiptBatchScope.subtitle)}</span>`;
  }
}

async function _receiptBatchStop() {
  const api = receiptDesktopApi();
  if (api && typeof api.cancelReceiptBatch === 'function') {
    try { await api.cancelReceiptBatch(); } catch (e) {}
  }
  receiptToast('⏹ سيتم إيقاف الطباعة بعد الإيصال الحالي', 'info');
}

async function receiptsBatchClose() {
  if (_receiptBatchRunning) await _receiptBatchStop();
  const els = _receiptBatchEls();
  if (els.overlay) els.overlay.classList.remove('show');
}

function _receiptBatchKindLabel(kind) { return kind === 'bag' ? 'حقيبة' : 'دورة'; }

function _receiptBatchClientFor(item) {
  const scoped = (_receiptBatchScope && Array.isArray(_receiptBatchScope.clients)) ? _receiptBatchScope.clients : [];
  const all = Array.isArray(clients) ? clients : [];
  const pool = scoped.concat(all);
  return pool.find(c => String(c.id) === String(item.clientRecordId)) ||
    pool.find(c => String(c.clientId) === String(item.clientId)) || null;
}

function _receiptBatchShowResult(res, attempted) {
  const els = _receiptBatchEls();
  if (!els.result) return;
  const missing = Array.isArray(res && res.missing) ? res.missing.slice() : [];
  // إضافة ما كان ناقصاً قبل بدء الطباعة (لم يُرسل للطباعة أصلاً)
  const preMissing = (_receiptBatchPlan.missing || []).filter(m => !missing.some(x => x.clientRecordId === m.clientRecordId && x.kind === m.kind && x.invoiceNo === m.invoiceNo));
  const allMissing = preMissing.concat(missing);
  const failed = Array.isArray(res && res.failed) ? res.failed : [];

  let html = '';
  if (!res || res.ok === false) {
    html += `<div class="receipt-batch-err">❌ تعذّرت الطباعة: ${receiptEscape((res && res.error) || 'خطأ غير معروف')}</div>`;
  } else {
    html += `<div class="receipt-batch-ok">✅ أُرسل للطباعة: ${Number(res.printed) || 0} إيصالاً</div>`;
    if (res.canceled) html += `<div class="receipt-batch-warn">⏹ أُوقفت الطباعة — لم تُطبع بقية الإيصالات</div>`;
    if (failed.length) {
      html += `<div class="receipt-batch-err">⚠️ فشل ${failed.length} إيصالاً:</div>`;
      html += `<div class="receipt-batch-missing-list">` + failed.slice(0, 40).map(f => {
        const c = _receiptBatchClientFor(f);
        return `${receiptEscape((c && c.name) || '—')} — ${_receiptBatchKindLabel(f.kind)} ${receiptEscape(f.invoiceNo)}: ${receiptEscape(f.error || '')}`;
      }).join('<br>') + `</div>`;
    }
    if (allMissing.length) {
      html += `<div class="receipt-batch-warn">⚠️ غير محفوظ على الجهاز: ${allMissing.length} إيصالاً</div>`;
      html += `<div class="receipt-batch-missing-list">` + allMissing.slice(0, 60).map(m => {
        const c = _receiptBatchClientFor(m);
        return `${receiptEscape((c && c.name) || m.name || '—')} — ${_receiptBatchKindLabel(m.kind)} ${receiptEscape(m.invoiceNo)}`;
      }).join('<br>') + (allMissing.length > 60 ? `<br>… و${allMissing.length - 60} أخرى` : '') + `</div>`;
      html += `<button type="button" class="btn btn-ghost btn-sm" data-batch-download-missing>📥 تحميل الناقص من أركان</button>`;
    }
    if (!failed.length && !allMissing.length && !res.canceled) {
      html += `<div style="color:var(--text-muted);">كل الإيصالات المطلوبة أُرسلت للطباعة بنجاح.</div>`;
    }
  }
  els.result.innerHTML = html;
  els.result.style.display = '';
  els.result.dataset.attempted = String((attempted || []).length);
}

async function _receiptBatchDownloadMissing() {
  const els = _receiptBatchEls();
  const plan = _receiptBatchPlan || {};
  const missing = (plan.missing || []).slice();
  if (!missing.length) { receiptToast('لا يوجد إيصال ناقص لتحميله', 'info'); return; }
  if (typeof receiptsEnqueueMany !== 'function') { receiptToast('طابور الإيصالات لم يكتمل تحميله بعد', 'error'); return; }
  const seen = new Set();
  const list = [];
  for (const m of missing) {
    const c = _receiptBatchClientFor(m);
    if (!c || seen.has(String(c.id))) continue;
    seen.add(String(c.id));
    list.push(c);
  }
  if (!list.length) { receiptToast('تعذّر تحديد العملاء الناقصة إيصالاتهم', 'error'); return; }
  const r = receiptsEnqueueMany(list, { source: 'backlog', force: false });
  if (r && r.queued) receiptToast(`📥 أُضيف ${r.queued} إيصالاً لطابور التحميل — أعد فتح النافذة بعد انتهائه للطباعة`, 'info', 6000);
  else receiptToast('لا توجد إيصالات جديدة قابلة للتحميل لهؤلاء العملاء', 'info');
  if (els.result) els.result.style.display = 'none';
}

async function _receiptBatchStart() {
  const els = _receiptBatchEls();
  const api = receiptDesktopApi();
  if (!api || _receiptBatchRunning) return;
  const found = (_receiptBatchPlan.found || []);
  if (!found.length) { receiptToast('لا توجد إيصالات محفوظة للطباعة', 'info'); return; }
  const deviceName = els.printer ? String(els.printer.value || '') : '';
  if (!deviceName) { receiptToast('اختر الطابعة أولاً', 'error'); return; }
  const copies = Math.min(20, Math.max(1, parseInt(els.copies && els.copies.value, 10) || 1));

  _receiptBatchRunning = true;
  if (els.start) els.start.disabled = true;
  if (els.whatsapp) els.whatsapp.disabled = true;
  if (els.stop) els.stop.style.display = '';
  if (els.result) { els.result.style.display = 'none'; els.result.innerHTML = ''; }
  if (els.progress) els.progress.style.display = '';
  _receiptBatchProgress(0, found.length, `جارٍ بدء الطباعة على: ${deviceName}`);

  if (_receiptBatchOffProgress) { try { _receiptBatchOffProgress(); } catch (e) {} _receiptBatchOffProgress = null; }
  if (typeof api.onReceiptBatchProgress === 'function') {
    _receiptBatchOffProgress = api.onReceiptBatchProgress(data => {
      if (!data) return;
      const idx = Number(data.index) || 0;
      const total = Number(data.total) || found.length;
      _receiptBatchProgress(idx, total, `${idx} / ${total} — ${_receiptBatchKindLabel(data.kind)} ${data.invoiceNo || ''}`);
    });
  }

  let res = null;
  const printOptions = _receiptBatchPrintOptions();
  try {
    res = await api.printReceiptBatch({
      items: found.map(r => ({ invoiceNo: r.invoiceNo, clientId: r.clientId, clientRecordId: r.clientRecordId, name: r.name, kind: r.kind })),
      deviceName,
      copies,
      printOptions,
    });
  } catch (e) {
    res = { ok: false, error: String(e.message || e) };
  }

  _receiptBatchRunning = false;
  if (els.start) els.start.disabled = false;
  if (els.whatsapp) els.whatsapp.disabled = false;
  if (els.stop) els.stop.style.display = 'none';
  if (_receiptBatchOffProgress) { try { _receiptBatchOffProgress(); } catch (e) {} _receiptBatchOffProgress = null; }
  _receiptBatchProgress(found.length, found.length, 'انتهت الطباعة');
  _receiptBatchShowResult(res, found);
  if (res && res.ok && Number(res.printed) > 0) {
    receiptToast(`🖨️ تم إرسال ${res.printed} إيصالاً للطباعة`, 'success', 5000);
  } else if (res && res.ok === false) {
    receiptToast('❌ ' + String(res.error || 'تعذّرت الطباعة'), 'error', 6000);
  }
}

/* ─────────── إرسال إيصالات الدفعة (دورة/حقيبة) PDF عبر واتساب ───────────
   واتساب لا يسمح لأي تطبيق بإرفاق ملف تلقائياً، لذلك:
   1) نجهّز نسخة PDF من كل إيصال ونحفظها في مجلد واحد يختاره المستخدم.
   2) نفتح محادثة واتساب لكل عميل برسالة جاهزة (رقم الإيصال ونوعه).
   3) يرفق المستخدم ملفه من المجلد في المحادثة ويضغط إرسال. */
let _receiptBatchWaRunning = false;
let _receiptBatchWaLast = [];

function _receiptBatchPhoneFor(item) {
  const c = _receiptBatchClientFor(item);
  // الأولوية لرقم الشيت الحالي، ثم الرقم القادم من الإيصال/الخطة.
  const raw = (c && (c.phone || c.whatsapp || c.mobile || c.phoneNumber)) || (item && item.phone) || '';
  return _receiptWaPhone(raw);
}

/* يجمع إيصالات نفس العميل في مجموعة واحدة: محادثة واتساب واحدة لكل عميل. */
function _receiptBatchWaGroups(saved) {
  const groups = [];
  const index = new Map();
  for (const s of (saved || [])) {
    const key = String((s && (s.clientRecordId || s.clientId)) || (s && s.invoiceNo) || '');
    let g = index.get(key);
    if (!g) {
      g = {
        key,
        clientRecordId: (s && s.clientRecordId) || '',
        clientId: (s && s.clientId) || '',
        name: (s && s.name) || '',
        items: [],
      };
      index.set(key, g);
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
}

function _receiptBatchWaMessage(items) {
  const list = Array.isArray(items) ? items : [items];
  const first = list[0] || {};
  const c = _receiptBatchClientFor(first);
  const center = (typeof settings !== 'undefined' && settings && settings.centerInfo && settings.centerInfo.name) || '';
  const kinds = Array.from(new Set(list.map(x => (x && x.kind === 'bag') ? 'الحقيبة' : 'الدورة')));
  const title = kinds.length > 1 ? 'إيصالات الدورة والحقيبة' : `إيصال ${kinds[0] || 'الدورة'}`;
  const lines = [`${title}${c && c.name ? ' — ' + c.name : ''}`, center];
  list.forEach(x => {
    lines.push(`${x && x.kind === 'bag' ? 'رقم إيصال الحقيبة' : 'رقم الفاتورة'}: ${(x && x.invoiceNo) || '—'}`);
  });
  lines.push(`عدد الملفات: ${list.length} — ملفات PDF محفوظة على الجهاز ويُرفق كل منها في المحادثة.`);
  return lines.filter(Boolean).join('\n');
}

function _receiptBatchShowWaResult(res, attempted, opened, noPhoneGroups) {
  const els = _receiptBatchEls();
  if (!els.result) return;
  const saved = Array.isArray(res && res.saved) ? res.saved : [];
  const failed = Array.isArray(res && res.failed) ? res.failed : [];
  const missing = Array.isArray(res && res.missing) ? res.missing : [];
  const groups = _receiptBatchWaGroups(saved);
  _receiptBatchWaLast = groups;

  let html = '';
  if (!res || res.ok === false) {
    html += `<div class="receipt-batch-err">❌ تعذّر تجهيز الإيصالات: ${receiptEscape((res && res.error) || 'خطأ غير معروف')}</div>`;
  } else {
    html += `<div class="receipt-batch-ok">✅ حُفظ ${saved.length} إيصالاً PDF في: <span class="mono">${receiptEscape(res.dir || '')}</span></div>`;
    html += `<div style="color:var(--text-muted);font-size:12px;">تم فتح ${Number(opened) || 0} محادثة واتساب — أرفق ملفات كل عميل من المجلد أعلاه ثم اضغط إرسال داخل واتساب.</div>`;
    if (groups.length) {
      html += `<div class="receipt-batch-missing-list">` + groups.slice(0, 60).map((g, i) => {
        const c = _receiptBatchClientFor(g.items[0]);
        const parts = g.items.map(x => `${_receiptBatchKindLabel(x.kind)} ${receiptEscape(x.invoiceNo || '')}`).join(' + ');
        const label = `${receiptEscape((c && c.name) || g.name || '—')} — ${parts}`;
        return _receiptBatchPhoneFor(g.items[0])
          ? `${label} · <a href="#" data-batch-wa-index="${i}">📲 فتح واتساب</a>`
          : `${label} · <span style="color:var(--red);">بلا رقم جوال</span>`;
      }).join('<br>') + (groups.length > 60 ? `<br>… و${groups.length - 60} أخرى` : '') + `</div>`;
    }
    if (noPhoneGroups && noPhoneGroups.length) {
      html += `<div class="receipt-batch-warn">⚠️ ${noPhoneGroups.length} عميل بلا رقم جوال صالح — حُفظت الملفات لكن لم تُفتح لهم محادثة.</div>`;
    }
    if (failed.length) {
      html += `<div class="receipt-batch-err">⚠️ تعذّر تجهيز ${failed.length} إيصالاً:</div>`;
      html += `<div class="receipt-batch-missing-list">` + failed.slice(0, 40).map(f => {
        const c = _receiptBatchClientFor(f);
        return `${receiptEscape((c && c.name) || f.name || '—')} — ${_receiptBatchKindLabel(f.kind)} ${receiptEscape(f.invoiceNo || '')}: ${receiptEscape(f.error || '')}`;
      }).join('<br>') + `</div>`;
    }
    if (missing.length) {
      html += `<div class="receipt-batch-warn">⚠️ غير محفوظ على الجهاز: ${missing.length} إيصالاً</div>`;
    }
  }
  els.result.innerHTML = html;
  els.result.style.display = '';
  els.result.dataset.attempted = String((attempted || []).length);
}

async function _receiptBatchWhatsapp() {
  const els = _receiptBatchEls();
  const api = receiptDesktopApi();
  if (!api || typeof api.exportReceiptBatch !== 'function') {
    receiptToast('إرسال الإيصالات عبر واتساب متاح داخل تطبيق سطح المكتب فقط', 'error', 6000);
    return;
  }
  if (_receiptBatchWaRunning || _receiptBatchRunning) return;
  // منع تكرار الضغط أثناء نافذة التأكيد أو التجهيز.
  _receiptBatchWaRunning = true;
  if (els.whatsapp) els.whatsapp.disabled = true;

  if (!(_receiptBatchPlan && (_receiptBatchPlan.found || []).length)) await _receiptBatchRefreshPlan();
  const found = (_receiptBatchPlan && _receiptBatchPlan.found) ? _receiptBatchPlan.found.slice() : [];
  if (!found.length) {
    _receiptBatchWaRunning = false;
    if (els.whatsapp) els.whatsapp.disabled = true;
    receiptToast('لا توجد إيصالات محفوظة على الجهاز لإرسالها', 'info', 5000);
    return;
  }

  const noPhone = _receiptBatchWaGroups(found).filter(g => !_receiptBatchPhoneFor(g.items[0]));
  const summary = [
    `سيتم حفظ ${found.length} إيصالاً (دورة/حقيبة) بصيغة PDF في مجلد تختاره، ثم فتح محادثة واتساب لكل عميل برسالة جاهزة.`,
    'واتساب لا يسمح بإرفاق الملف تلقائياً — ستُرفق الملفات من المجلد داخل كل محادثة.',
    noPhone.length ? `⚠️ ${noPhone.length} عميل بلا رقم جوال صالح — لن تُفتح لهم محادثة.` : '',
  ].filter(Boolean).join('\n');
  const confirmed = (typeof customConfirm === 'function')
    ? await customConfirm(summary, 'إرسال الإيصالات عبر واتساب')
    : true;
  if (!confirmed) {
    _receiptBatchWaRunning = false;
    if (els.whatsapp) els.whatsapp.disabled = false;
    return;
  }

  if (els.start) els.start.disabled = true;
  if (els.result) { els.result.style.display = 'none'; els.result.innerHTML = ''; }
  if (els.progress) els.progress.style.display = '';
  _receiptBatchProgress(0, found.length, '⏳ جارٍ تجهيز نسخ PDF...');

  let res = null;
  try {
    res = await api.exportReceiptBatch({
      items: found.map(r => ({ invoiceNo: r.invoiceNo, clientId: r.clientId, clientRecordId: r.clientRecordId, name: r.name, kind: r.kind })),
      printOptions: _receiptBatchPrintOptions(),
    });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }

  _receiptBatchWaRunning = false;
  if (els.whatsapp) els.whatsapp.disabled = false;
  if (els.start) els.start.disabled = false;

  if (!res || res.ok === false) {
    if (els.progress) els.progress.style.display = 'none';
    if (res && res.canceled) { receiptToast('تم إلغاء إرسال الإيصالات', 'info'); return; }
    receiptToast('❌ تعذّر تجهيز الإيصالات: ' + ((res && res.error) || 'خطأ غير معروف'), 'error', 7000);
    _receiptBatchShowWaResult({ ok: false, error: (res && res.error) || '' }, found, 0, []);
    return;
  }

  const saved = Array.isArray(res.saved) ? res.saved : [];
  const groups = _receiptBatchWaGroups(saved);
  _receiptBatchProgress(saved.length, found.length, `✅ تم تجهيز ${saved.length} إيصالاً — جارٍ فتح محادثات واتساب...`);

  let opened = 0;
  const noPhoneGroups = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const phone = _receiptBatchPhoneFor(g.items[0]);
    if (!phone) { noPhoneGroups.push(g); continue; }
    _receiptOpenWhatsapp(_receiptWaUrl(phone, _receiptBatchWaMessage(g.items)));
    opened++;
    _receiptBatchProgress(i + 1, groups.length, `📲 ${opened} / ${groups.length} — فتح محادثة واتساب...`);
    await receiptSleep(700);
  }

  if (els.progress) els.progress.style.display = 'none';
  _receiptBatchShowWaResult(res, found, opened, noPhoneGroups);
  receiptToast(`📲 حُفظ ${saved.length} إيصالاً PDF وفُتحت ${opened} محادثة واتساب`, 'success', 7000);
}

/* معاينة نسخة الطباعة الفعلية لأول إيصال في الدفعة (بنفس مقاس الورق والهامش والحجم)
   حتى يرى المستخدم النتيجة على الشاشة قبل حرق الورق. */
async function _receiptBatchPreview() {
  const api = receiptDesktopApi();
  if (!api || typeof api.previewReceiptPrint !== 'function') { receiptToast('المعاينة غير متاحة في هذا الإصدار', 'error'); return; }
  const found = (_receiptBatchPlan && _receiptBatchPlan.found) ? _receiptBatchPlan.found : [];
  if (!found.length) { receiptToast('لا يوجد إيصال محفوظ للمعاينة', 'info'); return; }
  const first = found[0];
  const c = _receiptBatchClientFor(first);
  const printOptions = _receiptBatchPrintOptions();
  receiptToast('⏳ جارٍ تجهيز نسخة الطباعة...', 'info', 2500);
  try {
    const r = await api.previewReceiptPrint({ invoiceNo: first.invoiceNo, clientId: first.clientId, kind: first.kind, printOptions });
    if (r && r.ok) {
      receiptToast(`👁️ معاينة ${_receiptBatchKindLabel(first.kind)} ${first.invoiceNo}${c && c.name ? ' — ' + c.name : ''} — هذه هي النسخة التي ستُطبع فعلياً`, 'success', 6000);
    } else {
      receiptToast('تعذّرت المعاينة: ' + ((r && r.error) || 'خطأ غير معروف'), 'error', 5000);
    }
  } catch (e) {
    receiptToast('تعذّرت المعاينة: ' + String(e.message || e), 'error', 5000);
  }
}

function receiptsBindBatchPrintUI() {
  _receiptBindButton('btn-bulk-receipts-print', () => receiptsOpenBatchPrint());
  const els = _receiptBatchEls();
  if (!els.overlay) return;

  if (els.overlay.dataset.receiptBound !== '1') {
    els.overlay.dataset.receiptBound = '1';
    els.overlay.addEventListener('click', e => {
      if (e.target === els.overlay || e.target.closest('[data-batch-print-close]')) receiptsBatchClose();
    });
    els.overlay.addEventListener('click', e => {
      if (e.target.closest('[data-batch-download-missing]')) _receiptBatchDownloadMissing();
    });
  }
  if (els.start && els.start.dataset.receiptBound !== '1') {
    els.start.dataset.receiptBound = '1';
    els.start.addEventListener('click', _receiptBatchStart);
  }
  if (els.stop && els.stop.dataset.receiptBound !== '1') {
    els.stop.dataset.receiptBound = '1';
    els.stop.addEventListener('click', _receiptBatchStop);
  }
  if (els.refreshPrinters && els.refreshPrinters.dataset.receiptBound !== '1') {
    els.refreshPrinters.dataset.receiptBound = '1';
    els.refreshPrinters.addEventListener('click', _receiptBatchLoadPrinters);
  }
  if (els.printer && els.printer.dataset.receiptBound !== '1') {
    els.printer.dataset.receiptBound = '1';
    els.printer.addEventListener('change', _receiptBatchUpdateNote);
  }
  [els.paper, els.margin].forEach(el => {
    if (!el || el.dataset.receiptBound === '1') return;
    el.dataset.receiptBound = '1';
    el.addEventListener('change', () => {
      _receiptBatchPrintOptions();
      _receiptBatchUpdateNote();
    });
  });
  if (els.scale && els.scale.dataset.receiptBound !== '1') {
    els.scale.dataset.receiptBound = '1';
    els.scale.addEventListener('input', _receiptBatchUpdateScaleLabel);
    els.scale.addEventListener('change', () => { _receiptBatchPrintOptions(); });
  }
  if (els.preview && els.preview.dataset.receiptBound !== '1') {
    els.preview.dataset.receiptBound = '1';
    els.preview.addEventListener('click', _receiptBatchPreview);
  }
  if (els.whatsapp && els.whatsapp.dataset.receiptBound !== '1') {
    els.whatsapp.dataset.receiptBound = '1';
    els.whatsapp.addEventListener('click', _receiptBatchWhatsapp);
  }
  if (els.result && els.result.dataset.receiptBound !== '1') {
    els.result.dataset.receiptBound = '1';
    els.result.addEventListener('click', e => {
      const a = e.target.closest('[data-batch-wa-index]');
      if (!a) return;
      e.preventDefault();
      const s = _receiptBatchWaLast[Number(a.getAttribute('data-batch-wa-index'))];
      if (!s || !s.items || !s.items.length) return;
      const phone = _receiptBatchPhoneFor(s.items[0]);
      if (!phone) { receiptToast('لا يوجد رقم جوال صالح لهذا العميل', 'info'); return; }
      _receiptOpenWhatsapp(_receiptWaUrl(phone, _receiptBatchWaMessage(s.items)));
    });
  }
  [els.kindCourse, els.kindBag].forEach(el => {
    if (!el || el.dataset.receiptBound === '1') return;
    el.dataset.receiptBound = '1';
    el.addEventListener('change', () => {
      if (_receiptBatchRunning) return;
      const c = els.kindCourse, b = els.kindBag;
      if (c && b && !c.checked && !b.checked) { c.checked = true; }
      _receiptBatchRefreshPlan();
    });
  });
  if (!window.__receiptsBatchKeyBound) {
    window.__receiptsBatchKeyBound = true;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (els.overlay.classList.contains('show')) receiptsBatchClose();
    });
  }
}

function receiptsAutoInit() {
  if (_receiptInitDone) return;
  _receiptInitDone = true;
  receiptsBindUI();
  receiptsLoadIndex(true)
    .then(() => {
      receiptsUpdateUI();
      receiptsAutoScanSchedule('init', 1800);
    })
    .catch(() => {});
  setInterval(() => receiptsAutoScanSchedule('interval', 800), RECEIPT_SCAN_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') receiptsAutoScanSchedule('visibility', 1000);
  });
  window.addEventListener('online', () => {
    if (!_receiptPaused) receiptsStartWorker();
  });
}

/* ── استماع موحّد لنقر رقم الفاتورة (قبل أي معالج قديم) ── */
(function bindInvoiceViewerClick() {
  if (window.__receiptInvoiceClickBound) return;
  window.__receiptInvoiceClickBound = true;
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-invoice-toggle]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    receiptsOpenViewer(btn.getAttribute('data-invoice-toggle'), btn.getAttribute('data-invoice'), btn.getAttribute('data-invoice-kind'));
  }, true);
})();

/* ── توافقية مع النداءات القديمة إن وُجدت ── */
function handleInvoiceAction(action, clientId, invoiceNo) {
  if (action === 'print' || action === 'preview' || action === 'refresh' || action === 'download') {
    return receiptsOpenViewer(clientId, invoiceNo);
  }
  return Promise.resolve();
}
