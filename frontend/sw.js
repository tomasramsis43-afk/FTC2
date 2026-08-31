/**
 * Service Worker - FTC Application
 * Handles caching, offline support, and background synchronization
 */

const CACHE_VERSION = 'ftc-cache-v13';
const RUNTIME_CACHE = 'ftc-runtime-v12';
// ملحوظة معمارية (تحديث): كانت ملفات JS/CSS/HTML تُستثنى من الكاش الفوري عمداً (راجع الشرح
// القديم أسفل هذا السطر) لضمان وصول التحديثات فوراً. لكن هذا كان يفرض round-trip كامل للسيرفر
// لكل ملف (22+ ملف JS) في كل فتحة للبرنامج حتى لو لم يتغيّر أي شيء فعلياً — بطيء خصوصاً على
// اتصال بطيء/بعيد جغرافياً عن السيرفر. الحل: تحوّلت لاستراتيجية Stale-While-Revalidate (تحت)
// لهذه الملفات — تُقدَّم فوراً من الكاش (سرعة فورية) بينما تُحدَّث فى الخلفية بالتوازي. ضمان وصول
// التحديثات لا يعتمد أصلاً على Network-First بل على آلية منفصلة موجودة سلفاً فى sw-register.js:
// أي نشر جديد يستوجب رفع رقم هذين الثابتين (v8 -> v9...)، فيصبح اسم RUNTIME_CACHE مختلفاً تماماً
// (كاش فارغ لا يحتوي أي نسخة قديمة مطلقاً)، ويُفعَّل الـ SW الجديد فوراً (skipWaiting)، فيُطلق
// حدث controllerchange الذي يعيد تحميل الصفحة تلقائياً مرة واحدة — فيحصل المستخدم على أحدث نسخة
// فور نشرها بالضبط كالسابق، لكن كل الفتحات اللاحقة (الغالبية العظمى) تصبح فورية من الكاش المحلي.
// (الشرح القديم الذي كان هنا: "ملفات JS لا تُضاف هنا — يتم تحديثها تلقائياً عبر
// networkFirstStrategy فى كل تشغيل" — لم يعد دقيقاً، الاستراتيجية الحالية موضحة أعلاه.)
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
  if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') console.log('[ServiceWorker] Installing...');

  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => {
      if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') console.log('[ServiceWorker] Caching static assets');
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.log('[ServiceWorker] Cache addAll error:', err);
      });
    })
  );

  self.skipWaiting();
});

// تنظيف نسخ Service Worker القديمة
self.addEventListener('activate', event => {
  if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') console.log('[ServiceWorker] Activating...');
  
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

  // تجاهل أي طلب لموقع خارجي (خطوط Google، مكتبات cdnjs، إلخ) ودَع المتصفح
  // يتعامل معه بشكل طبيعي. سبب مهم: أي fetch() يُنفَّذ من داخل الـ Service
  // Worker نفسه يخضع لـ connect-src في الـ CSP الخاص بالصفحة (وليس فقط
  // script-src/style-src)، فاعتراض هذه الطلبات هنا وإعادة تنفيذها بـ fetch()
  // كان يجعلها تفشل بصمت (CSP) حتى لو كانت مسموحة أصلاً بتحميلها عبر
  // <script>/<link> مباشرة، ويُرجع الـ SW استجابة 503 اصطناعية بدلاً منها —
  // وهو ما كان يمنع تحميل الخطوط ومكتبات xlsx/qrious/html2canvas/jspdf.
  if (url.origin !== self.location.origin) {
    return;
  }

  // تحديد استراتيجية التخزين حسب نوع الملف
  if (request.method === 'GET') {
    // للـ HTML و CSS و JS - استخدم Stale-While-Revalidate (استجابة فورية من الكاش المحلي + تحديث
    // فى الخلفية بالتوازي بلا انتظار) بدل Network First (كان يفرض انتظار السيرفر لكل ملف فى كل
    // فتحة). راجع تعليق CACHE_VERSION/RUNTIME_CACHE أعلى الملف لشرح كيف لا يزال وصول التحديثات
    // فورياً رغم ذلك.
    if (url.pathname.endsWith('.html') || 
        url.pathname.endsWith('.css') || 
        url.pathname.endsWith('.js')) {
      event.respondWith(staleWhileRevalidate(request));
    }
    // للصور والـ fonts - استخدم Cache First
    else if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot)$/)) {
      event.respondWith(cacheFirstStrategy(request));
    }
    // للـ API requests - استخدم Network First مع Fallback
    else if (url.pathname.includes('/api/')) {
      // طلبات مصادق عليها (تحمل رأس Authorization) لا تُخزَّن أبداً في كاش الخدمة المشترك ولا
      // تُقرأ منه: كاش الـ Service Worker مشترك على مستوى المتصفح/الجهاز ولا يفرّق بين المستخدمين
      // (المطابقة في caches.match تتم بالرابط وطريقة الطلب فقط وليس بترويسات Authorization) —
      // فكانت استجابة GET محفوظة لحساب أدمن تُقدَّم لاحقاً لأي مستخدم آخر يسجّل دخوله على نفس
      // المتصفح/الجهاز: تسريب كامل لبيانات المستخدمين عبر الكاش المشترك. تُنفَّذ هذه الطلبات
      // شبكةً فقط (بدون أي نسخة محفوظة أو استرجاع من الكاش) — سلامة البيانات قبل أي اعتبار أوفلاين.
      if (request.headers.get('authorization')) {
        event.respondWith(fetch(request));
      } else {
        event.respondWith(networkWithCacheFallback(request));
      }
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

// ملاحظة: أحداث online/offline لا تُطلق داخل Service Worker إطلاقاً (فقط window) — حُذفت المعالجات الميتة.

// قياس أداء الـ Service Worker — فقط في التطوير
if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') {
  console.log('[ServiceWorker] Loaded and ready to serve!');
}
