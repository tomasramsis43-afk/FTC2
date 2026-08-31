/**
 * sync-engine.js — محرك المزامنة الجديد
 *
 * المبادئ:
 * 1. السيرفر مصدر الحقيقة دائماً
 * 2. last-write-wins بالـ updated_at
 * 3. Queue محلي للعمليات الـ offline
 * 4. Retry تلقائي بـ exponential backoff
 * 5. لا مسح للسيرفر أبداً
 * 6. كل collection مستقلة تماماً
 */

const SyncEngine = (() => {

  /* ── إعدادات ── */
  const API_BASE       = window.SERVER_URL || '';
  const QUEUE_KEY      = 'sync_queue_v1';
  const LAST_SYNC_KEY  = 'sync_last_ts_v1';
  const MAX_RETRY      = 5;
  const BATCH_SIZE     = 50; // عدد السجلات في كل bulk request
  const RETRY_DELAYS   = [2000, 5000, 15000, 30000, 60000]; // exponential backoff

  /* ── حالة داخلية ── */
  let _queue       = [];   // [{id, collection, enc, clientId?, op:'upsert'|'delete', retries, ts}]
  let _isFlushing  = false;
  let _flushTimer  = null;
  let _online      = navigator.onLine;
  let _listeners   = {};   // {collection: [callback]}

  /* ── مساعدات ── */
  function getAuthHeaders() {
    const token = localStorage.getItem('ftc_jwt') || sessionStorage.getItem('ftc_jwt') || '';
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
      ...opts,
      headers: { ...getAuthHeaders(), ...(opts.headers || {}) },
    });
    return res;
  }

  function emit(event, data) {
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch(e) {} });
  }

  /* ── Queue persistence ── */
  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(_queue)); } catch(e) {}
  }

  function loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      _queue = raw ? JSON.parse(raw) : [];
    } catch(e) { _queue = []; }
  }

  function setLastSyncTs(collection, ts) {
    try {
      const all = JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || '{}');
      all[collection] = ts;
      localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(all));
    } catch(e) {}
  }

  function getLastSyncTs(collection) {
    try {
      const all = JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || '{}');
      return all[collection] || null;
    } catch(e) { return null; }
  }

  /* ── إضافة عملية للـ queue ── */
  function enqueue(collection, id, enc, op = 'upsert', clientId = null) {
    // لو نفس السجل موجود في الـ queue، نحدّثه بدل إضافة نسخة تانية
    const existingIdx = _queue.findIndex(q => q.collection === collection && q.id === id);
    const entry = { id, collection, enc, op, clientId, retries: 0, ts: Date.now() };
    if (existingIdx >= 0) {
      _queue[existingIdx] = { ..._queue[existingIdx], ...entry };
    } else {
      _queue.push(entry);
    }
    saveQueue();
    scheduleFlush();
  }

  /* ── جدولة الـ flush ── */
  function scheduleFlush(delay = 300) {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(flush, delay);
  }

  /* ── flush: رفع كل الـ queue للسيرفر ── */
  async function flush() {
    if (_isFlushing || !_online || _queue.length === 0) return;
    _isFlushing = true;

    try {
      // نجمّع السجلات بالـ collection
      const byCollection = {};
      const deleteOps = [];

      for (const item of _queue) {
        if (item.op === 'delete') {
          deleteOps.push(item);
        } else {
          if (!byCollection[item.collection]) byCollection[item.collection] = [];
          byCollection[item.collection].push(item);
        }
      }

      const successIds = new Set();

      // رفع كل collection على حدة بـ bulk
      for (const [col, items] of Object.entries(byCollection)) {
        const endpoint = col === 'clients' ? '/api/sync/clients/bulk' : `/api/sync/${col}/bulk`;

        // تقسيم لـ batches عشان مانرهقش السيرفر
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const records = batch.map(item => ({
            id: item.id,
            enc: item.enc,
            ...(item.clientId ? { clientId: item.clientId } : {})
          }));

          try {
            const res = await apiFetch(endpoint, {
              method: 'POST',
              body: JSON.stringify({ records }),
            });

            if (res.ok) {
              batch.forEach(item => successIds.add(`${item.collection}:${item.id}`));
              emit('batch-saved', { collection: col, count: batch.length });
            } else {
              // فشل — زوّد retry count
              batch.forEach(item => {
                const idx = _queue.findIndex(q => q.collection === item.collection && q.id === item.id);
                if (idx >= 0) _queue[idx].retries = (_queue[idx].retries || 0) + 1;
              });
            }
          } catch(e) {
            console.warn(`[SyncEngine] batch failed ${col}:`, e.message);
          }
        }
      }

      // معالجة الحذف
      for (const item of deleteOps) {
        try {
          const endpoint = item.collection === 'clients'
            ? `/api/sync/clients/${item.id}`
            : `/api/sync/${item.collection}/${item.id}`;
          const res = await apiFetch(endpoint, { method: 'DELETE' });
          if (res.ok) successIds.add(`${item.collection}:${item.id}`);
        } catch(e) {}
      }

      // شيل العمليات الناجحة من الـ queue
      _queue = _queue.filter(item => {
        const key = `${item.collection}:${item.id}`;
        if (successIds.has(key)) return false;
        // شيل اللي تجاوز الـ max retry
        if ((item.retries || 0) >= MAX_RETRY) {
          console.error(`[SyncEngine] تجاوز الحد الأقصى للمحاولات:`, item);
          emit('max-retry-exceeded', item);
          return false;
        }
        return true;
      });

      saveQueue();

      if (_queue.length > 0) {
        // في عمليات فاشلة — حاول تاني بعد delay
        scheduleFlush(RETRY_DELAYS[Math.min(2, _queue[0]?.retries || 0)]);
      }

      emit('flush-complete', { remaining: _queue.length });

    } catch(e) {
      console.error('[SyncEngine] flush error:', e);
    } finally {
      _isFlushing = false;
    }
  }

  /* ── Pull: جلب التغييرات من السيرفر ── */
  async function pull(collection, { full = false } = {}) {
    const since = full ? null : getLastSyncTs(collection);
    const endpoint = collection === 'clients'
      ? `/api/sync/clients${since ? `?since=${encodeURIComponent(since)}` : ''}`
      : `/api/sync/${collection}${since ? `?since=${encodeURIComponent(since)}` : ''}`;

    try {
      const res = await apiFetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const records = data.records || [];

      if (records.length > 0) {
        emit('pull-data', { collection, records, full: !since });
        // حفظ آخر timestamp
        const lastTs = records[records.length - 1].updated_at;
        if (lastTs) setLastSyncTs(collection, lastTs);
      }

      return records;
    } catch(e) {
      console.warn(`[SyncEngine] pull ${collection}:`, e.message);
      return [];
    }
  }

  /* ── Pull all: جلب كل collections ── */
  async function pullAll(collections, { full = false, onProgress } = {}) {
    const results = {};
    let done = 0;
    for (const col of collections) {
      results[col] = await pull(col, { full });
      done++;
      if (onProgress) onProgress({ collection: col, done, total: collections.length });
    }
    return results;
  }

  /* ── Push: إضافة/تعديل سجل ── */
  function push(collection, id, enc, clientId = null) {
    enqueue(collection, id, enc, 'upsert', clientId);
  }

  /* ── Delete: حذف سجل ── */
  function remove(collection, id) {
    // شيل من الـ queue لو لسه ما اترفعش
    _queue = _queue.filter(q => !(q.collection === collection && q.id === id));
    enqueue(collection, id, null, 'delete');
  }

  /* ── Full restore: رفع كل البيانات بعد استعادة ── */
  async function pushAll(collectionsData, { onProgress } = {}) {
    const keys = Object.keys(collectionsData);
    let done = 0;
    const results = {};

    for (const col of keys) {
      const items = collectionsData[col] || [];
      if (items.length === 0) { done++; continue; }

      const endpoint = col === 'clients' ? '/api/sync/clients/bulk' : `/api/sync/${col}/bulk`;
      let saved = 0;

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        try {
          const res = await apiFetch(endpoint, {
            method: 'POST',
            body: JSON.stringify({ records: batch }),
          });
          if (res.ok) {
            const data = await res.json();
            saved += data.saved || 0;
          }
        } catch(e) {
          console.warn(`[SyncEngine] pushAll batch ${col}:`, e.message);
        }
      }

      results[col] = saved;
      done++;
      if (onProgress) onProgress({ collection: col, done, total: keys.length, pct: Math.round((done / keys.length) * 100) });
    }

    return results;
  }

  /* ── الاستماع للأحداث ── */
  function on(event, callback) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(callback);
    return () => { _listeners[event] = _listeners[event].filter(fn => fn !== callback); };
  }

  /* ── معلومات الـ queue ── */
  function queueInfo() {
    return {
      pending: _queue.length,
      collections: [...new Set(_queue.map(q => q.collection))],
    };
  }

  /* ── تهيئة النظام ── */
  function init() {
    loadQueue();

    window.addEventListener('online', () => {
      _online = true;
      emit('online');
      scheduleFlush(500);
    });

    window.addEventListener('offline', () => {
      _online = false;
      emit('offline');
    });

    // flush كل دقيقتين للتأكد
    setInterval(() => {
      if (_online && _queue.length > 0) flush();
    }, 120_000);

    // flush الـ queue القديم عند البداية
    if (_queue.length > 0 && _online) scheduleFlush(2000);
  }

  /* ── Public API ── */
  return { init, push, remove, pull, pullAll, pushAll, flush, on, queueInfo, getLastSyncTs, setLastSyncTs };

})();

// تهيئة تلقائية
SyncEngine.init();
