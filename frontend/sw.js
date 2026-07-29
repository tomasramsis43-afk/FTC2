/**
 * Service Worker - FTC Application
 * Handles caching, offline support, and background synchronization
 */

const CACHE_VERSION = 'ftc-cache-v5';
const RUNTIME_CACHE = 'ftc-runtime-v5';
// ملفات JS لا تُضاف هنا — يتم تحديثها تلقائياً عبر networkFirstStrategy
// (شبكة أولاً) في كل تشغيل، وتُحفظ في RUNTIME_CACHE للاستخدام أوفلاين.
// إضافتها للـ pre-cache تجعل المتصفح يستخدم النسخ القديمة حتى يتغير
// CACHE_VERSION يدوياً بعد كل تحديث — وهو مصدر مشاكل ظهور نسخ قديمة.
const STATIC_ASSETS = [
  '/app.html',
  '/styles.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

// تثبيت Service Worker وحفظ الموارد الثابتة
self.addEventListener('install', event => {
  console.log('[ServiceWorker] Installing...');
  
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      console.log('[ServiceWorker] Caching static assets');
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.log('[ServiceWorker] Cache addAll error:', err);
      });
    })
  );

  self.skipWaiting();
});

// تنظيف نسخ Service Worker القديمة
self.addEventListener('activate', event => {
  console.log('[ServiceWorker] Activating...');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_VERSION && cacheName !== RUNTIME_CACHE) {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );

  self.clients.claim();
});

// استراتيجية Fetch: Network First, then Cache
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // تجاهل الطلبات غير HTTP/HTTPS
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // تحديد استراتيجية التخزين حسب نوع الملف
  if (request.method === 'GET') {
    // للـ HTML و CSS و JS - استخدم Network First
    if (url.pathname.endsWith('.html') || 
        url.pathname.endsWith('.css') || 
        url.pathname.endsWith('.js')) {
      event.respondWith(networkFirstStrategy(request));
    }
    // للصور والـ fonts - استخدم Cache First
    else if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/)) {
      event.respondWith(cacheFirstStrategy(request));
    }
    // للـ API requests - استخدم Network First مع Fallback
    else if (url.pathname.includes('/api/')) {
      event.respondWith(networkWithCacheFallback(request));
    }
    // للباقي - استخدم Stale While Revalidate
    else {
      event.respondWith(staleWhileRevalidate(request));
    }
  }
});

/**
 * استراتيجية Network First
 * جرّب الشبكة أولاً، وإذا فشلت استخدم الـ Cache
 */
async function networkFirstStrategy(request) {
  try {
    const response = await fetch(request);
    
    // حفظ في الـ Cache
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    console.log('[ServiceWorker] Network failed, using cache:', request.url);
    
    // جرّب الـ Cache
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }
    
    // إذا فشل كل شيء، أرجع صفحة خطأ
    return new Response('Offline - Resource not available', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
}

/**
 * استراتيجية Cache First
 * استخدم الـ Cache أولاً، وإذا لم توجد جرّب الشبكة
 */
async function cacheFirstStrategy(request) {
  const cached = await caches.match(request);
  
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    
    // حفظ في الـ Cache
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    console.log('[ServiceWorker] Cache miss and offline:', request.url);
    return new Response('Resource not found', { status: 404 });
  }
}

/**
 * استراتيجية Network مع Cache Fallback
 * للـ API requests - جرّب الشبكة أولاً
 */
async function networkWithCacheFallback(request) {
  try {
    const response = await fetch(request);
    
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    
    if (cached) {
      return cached;
    }
    
    return new Response(
      JSON.stringify({ 
        error: 'Network request failed and no cache available',
        offline: true 
      }),
      { 
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * استراتيجية Stale While Revalidate
 * أرجع الـ Cache فوراً، وحدّث في الخلفية
 */
async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      // لازم الاستنساخ يحصل فوراً وبشكل متزامن هنا، قبل أي عملية async (زي caches.open)
      // وقبل ما نرجّع response للمتصفح. كانت النسخة القديمة بتستدعي response.clone() جوه
      // .then() منفصل تاني (بعد caches.open غير المنتظرة/unawaited) — وبما إن الدالة دي
      // بترجّع response فوراً بعدها، المتصفح ممكن يبدأ فعلياً في قراءة/استهلاك محتواها
      // قبل ما الـ .then() المتأخر ده يوصل لسطر response.clone()، فيطلع الخطأ:
      // "Failed to execute 'clone' on 'Response': Response body is already used".
      const responseClone = response.clone();
      caches.open(RUNTIME_CACHE).then(c => c.put(request, responseClone));
    }
    return response;
  });

  return cached || fetchPromise;
}

/**
 * Background Sync - مزامنة الخلفية
 * تحديث البيانات عند العودة للاتصال
 */
self.addEventListener('sync', event => {
  console.log('[ServiceWorker] Background sync:', event.tag);
  
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    // جلب البيانات المعلقة من IndexedDB
    const pendingData = await getPendingSync();
    
    // إرسالها إلى الخادم
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingData)
    });

    if (response.ok) {
      // حذف البيانات المعلقة
      await clearPendingSync();
      
      // إخطار الـ Clients بنجاح المزامنة
      const clients = await self.clients.matchAll();
      clients.forEach(client => {
        client.postMessage({
          type: 'SYNC_SUCCESS',
          data: pendingData
        });
      });
    }
  } catch (error) {
    console.error('[ServiceWorker] Sync failed:', error);
    throw error;
  }
}

const SW_IDB_NAME = 'ftc2-kv-cache-db';
const SW_IDB_PENDING_STORE = 'pending';

function _swOpenDb(){
  return new Promise((resolve)=>{
    try{
      if(!self.indexedDB){ resolve(null); return; }
      const req = indexedDB.open(SW_IDB_NAME, 2);
      req.onupgradeneeded = ()=>{
        try{
          const db = req.result;
          if(!db.objectStoreNames.contains(SW_IDB_PENDING_STORE)){
            db.createObjectStore(SW_IDB_PENDING_STORE, { keyPath: 'key' });
          }
        }catch(e){ console.error('[ServiceWorker] IDB upgrade error:', e); }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> { console.error('[ServiceWorker] IDB open error:', req.error); resolve(null); };
    }catch(e){ console.error('[ServiceWorker] IDB open exception:', e); resolve(null); }
  });
}

async function getPendingSync(){
  try{
    const db = await _swOpenDb();
    if(!db) return [];
    return await new Promise((resolve)=>{
      try{
        const tx = db.transaction(SW_IDB_PENDING_STORE, 'readonly');
        const store = tx.objectStore(SW_IDB_PENDING_STORE);
        const req = store.getAll();
        req.onsuccess = ()=> resolve(req.result || []);
        req.onerror = ()=> { console.error('[ServiceWorker] getPendingSync read error:', req.error); resolve([]); };
      }catch(e){ console.error('[ServiceWorker] getPendingSync exception:', e); resolve([]); }
    });
  }catch(e){ console.error('[ServiceWorker] getPendingSync outer exception:', e); return []; }
}

async function clearPendingSync(){
  try{
    const db = await _swOpenDb();
    if(!db) return;
    await new Promise((resolve)=>{
      try{
        const tx = db.transaction(SW_IDB_PENDING_STORE, 'readwrite');
        const store = tx.objectStore(SW_IDB_PENDING_STORE);
        store.clear();
        tx.oncomplete = ()=> resolve();
        tx.onerror = ()=> { console.error('[ServiceWorker] clearPendingSync error:', tx.error); resolve(); };
      }catch(e){ console.error('[ServiceWorker] clearPendingSync exception:', e); resolve(); }
    });
  }catch(e){ console.error('[ServiceWorker] clearPendingSync outer exception:', e); }
}

/**
 * Push Notifications
 */
self.addEventListener('push', event => {
  console.log('[ServiceWorker] Push notification received');
  
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body || 'New notification',
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'notification',
    requireInteraction: data.requireInteraction || false,
    actions: data.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'FTC', options)
  );
});

/**
 * Notification Click
 */
self.addEventListener('notificationclick', event => {
  console.log('[ServiceWorker] Notification clicked');
  
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      // ابحث عن نافذة مفتوحة
      for (let client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      
      // افتح نافذة جديدة
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

/**
 * Message Handling - للاتصال بين Page و Service Worker
 */
self.addEventListener('message', event => {
  console.log('[ServiceWorker] Message received:', event.data);
  
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(RUNTIME_CACHE);
  }
  
  if (event.data.type === 'GET_CACHE_SIZE') {
    getCacheSize().then(size => {
      event.ports[0].postMessage({ cacheSize: size });
    });
  }
});

async function getCacheSize() {
  const cacheNames = await caches.keys();
  let totalSize = 0;
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const requests = await cache.keys();
    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) continue;
      // Content-Length أسرع — وإلا نقرأ كنص ونحسب بايت (تفادياً لتحميل blob كامل في الذاكرة)
      const cl = response.headers.get('content-length');
      if (cl) {
        totalSize += parseInt(cl, 10) || 0;
      } else {
        try {
          const text = await response.clone().text();
          totalSize += new TextEncoder().encode(text).length;
        } catch (e) { /* تجاهل ملفات لا يمكن قراءتها */ }
      }
    }
  }
  return totalSize;
}

/**
 * Online/Offline events
 */
self.addEventListener('online', () => {
  console.log('[ServiceWorker] Online');
  
  // محاولة مزامنة البيانات
  if (self.registration.sync) {
    self.registration.sync.register('sync-data');
  }
});

self.addEventListener('offline', () => {
  console.log('[ServiceWorker] Offline');
});

// قياس أداء الـ Service Worker
console.log('[ServiceWorker] Loaded and ready to serve!');
