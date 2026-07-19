/**
 * Service Worker - FTC Application
 * Handles caching, offline support, and background synchronization
 */

const CACHE_VERSION = 'ftc-cache-v1';
const RUNTIME_CACHE = 'ftc-runtime-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app-optimized.html',
  '/styles.css',
  '/app-performance.js',
  '/app.js'
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
      const cache = caches.open(RUNTIME_CACHE);
      cache.then(c => c.put(request, response.clone()));
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

async function getPendingSync() {
  // محاكاة جلب البيانات المعلقة من قاعدة البيانات
  return [];
}

async function clearPendingSync() {
  // محاكاة حذف البيانات المعلقة
}

/**
 * Push Notifications
 */
self.addEventListener('push', event => {
  console.log('[ServiceWorker] Push notification received');
  
  const data = event.data ? event.data.json() : {};
  
  const options = {
    body: data.body || 'New notification',
    icon: data.icon || '/icon-192x192.png',
    badge: '/badge-72x72.png',
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
    const keys = await cache.keys();
    
    for (const request of keys) {
      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        totalSize += blob.size;
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
