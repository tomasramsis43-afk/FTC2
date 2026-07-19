/**
 * Performance Optimization Script
 * Handles debouncing, throttling, virtual scrolling, and lazy loading
 */

class PerformanceOptimizer {
  constructor() {
    this.debounceTimers = {};
    this.throttleTimers = {};
    this.observerOptions = {
      root: null,
      rootMargin: '50px',
      threshold: 0.01
    };
  }

  /**
   * Debounce - تنفيذ الدالة مرة واحدة فقط بعد انتظار معين
   * مثالي للـ search و resize events
   */
  debounce(func, wait, key) {
    return (...args) => {
      clearTimeout(this.debounceTimers[key]);
      this.debounceTimers[key] = setTimeout(() => {
        func.apply(this, args);
      }, wait);
    };
  }

  /**
   * Throttle - تنفيذ الدالة بحد أقصى كل X ميلي ثانية
   * مثالي للـ scroll events
   */
  throttle(func, limit, key) {
    if (!this.throttleTimers[key]) {
      func.apply(this);
      this.throttleTimers[key] = true;
      setTimeout(() => {
        this.throttleTimers[key] = false;
      }, limit);
    }
  }

  /**
   * Intersection Observer - تحميل عناصر عند الحاجة
   */
  observeLazyElements() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const element = entry.target;
          
          // تحميل الصور
          if (element.tagName === 'IMG' && element.dataset.src) {
            element.src = element.dataset.src;
            element.removeAttribute('data-src');
          }
          
          // تحميل الـ iframes
          if (element.tagName === 'IFRAME' && element.dataset.src) {
            element.src = element.dataset.src;
            element.removeAttribute('data-src');
          }
          
          observer.unobserve(element);
        }
      });
    }, this.observerOptions);

    document.querySelectorAll('[data-src]').forEach(el => {
      observer.observe(el);
    });
  }

  /**
   * Virtual Scrolling - تحميل صفوف الجدول حسب الحاجة
   */
  initVirtualScroll(tableSelector, rowHeight = 40, bufferSize = 5) {
    const table = document.querySelector(tableSelector);
    if (!table) return;

    const tbody = table.querySelector('tbody');
    const scrollContainer = table.parentElement;
    
    let visibleRows = [];
    
    const updateVisibleRows = () => {
      const scrollTop = scrollContainer.scrollTop;
      const viewportHeight = scrollContainer.clientHeight;
      
      const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferSize);
      const endIndex = Math.ceil((scrollTop + viewportHeight) / rowHeight) + bufferSize;
      
      const rows = tbody.querySelectorAll('tr');
      rows.forEach((row, index) => {
        if (index >= startIndex && index <= endIndex) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });
    };

    scrollContainer.addEventListener('scroll', () => {
      this.throttle(updateVisibleRows, 100, 'virtualScroll');
    });

    updateVisibleRows();
  }

  /**
   * Request Animation Frame - أداء أفضل للـ animations
   */
  smoothScroll(target, duration = 300) {
    const start = window.scrollY;
    const distance = target - start;
    let startTime = null;

    const animation = (currentTime) => {
      if (startTime === null) startTime = currentTime;
      const elapsed = currentTime - startTime;
      const run = ease(elapsed, start, distance, duration);
      window.scrollTo(0, run);
      
      if (elapsed < duration) {
        requestAnimationFrame(animation);
      }
    };

    const ease = (t, b, c, d) => {
      t /= d / 2;
      if (t < 1) return c / 2 * t * t + b;
      t--;
      return -c / 2 * (t * (t - 2) - 1) + b;
    };

    requestAnimationFrame(animation);
  }

  /**
   * Batch DOM Updates - تجميع التحديثات لتقليل reflows
   */
  batchDOMUpdates(updates) {
    const fragment = document.createDocumentFragment();
    
    updates.forEach(update => {
      if (update.type === 'create') {
        const element = document.createElement(update.tag);
        if (update.attrs) {
          Object.entries(update.attrs).forEach(([key, value]) => {
            element.setAttribute(key, value);
          });
        }
        if (update.content) {
          element.textContent = update.content;
        }
        fragment.appendChild(element);
      }
    });

    return fragment;
  }

  /**
   * Connection-aware Loading - تحميل حسب سرعة الاتصال
   */
  getConnectionSpeed() {
    if ('connection' in navigator) {
      const connection = navigator.connection;
      return connection.effectiveType; // '4g', '3g', '2g', 'slow-2g'
    }
    return '4g';
  }

  loadResourcesByConnection(resources) {
    const speed = this.getConnectionSpeed();
    
    if (speed === 'slow-2g' || speed === '2g') {
      // تحميل الموارد الخفيفة فقط
      return resources.filter(r => r.priority === 'high');
    }
    
    return resources;
  }

  /**
   * Memory Leak Prevention - تنظيف الموارد
   */
  cleanup() {
    Object.keys(this.debounceTimers).forEach(key => {
      clearTimeout(this.debounceTimers[key]);
    });
    this.debounceTimers = {};
    this.throttleTimers = {};
  }
}

/**
 * Performance Metrics - قياس الأداء
 */
class PerformanceMetrics {
  static logMetrics() {
    if (window.performance && window.performance.timing) {
      const timing = window.performance.timing;
      const metrics = {
        'DNS Lookup': timing.domainLookupEnd - timing.domainLookupStart,
        'TCP Connection': timing.connectEnd - timing.connectStart,
        'Time to First Byte': timing.responseStart - timing.navigationStart,
        'DOM Parsing': timing.domInteractive - timing.domLoading,
        'Resource Loading': timing.loadEventStart - timing.domInteractive,
        'Total Load Time': timing.loadEventEnd - timing.navigationStart
      };

      console.table(metrics);
      return metrics;
    }
  }

  static measureFunctionPerformance(func, label) {
    const start = performance.now();
    const result = func();
    const end = performance.now();
    
    console.log(`${label} took ${(end - start).toFixed(2)}ms`);
    return result;
  }

  static markAndMeasure(markName, measureName) {
    performance.mark(markName);
    performance.measure(measureName, markName);
    const measure = performance.getEntriesByName(measureName)[0];
    console.log(`${measureName}: ${measure.duration.toFixed(2)}ms`);
  }
}

/**
 * Cache Management - إدارة الـ Cache
 */
class CacheManager {
  constructor(cacheName = 'ftc-cache-v1') {
    this.cacheName = cacheName;
  }

  async cacheRequest(request) {
    const cache = await caches.open(this.cacheName);
    const response = await fetch(request);
    cache.put(request, response.clone());
    return response;
  }

  async getCachedResponse(request) {
    const cache = await caches.open(this.cacheName);
    return cache.match(request);
  }

  async clearCache() {
    const cache = await caches.open(this.cacheName);
    const keys = await cache.keys();
    await Promise.all(keys.map(key => cache.delete(key)));
  }
}

/**
 * LocalStorage Manager - إدارة التخزين المحلي
 */
class StorageManager {
  static set(key, value, ttl = null) {
    const data = {
      value,
      timestamp: Date.now(),
      ttl
    };
    localStorage.setItem(key, JSON.stringify(data));
  }

  static get(key) {
    const data = localStorage.getItem(key);
    if (!data) return null;

    const parsed = JSON.parse(data);
    
    // تحقق من انتهاء الصلاحية
    if (parsed.ttl && Date.now() - parsed.timestamp > parsed.ttl) {
      localStorage.removeItem(key);
      return null;
    }

    return parsed.value;
  }

  static remove(key) {
    localStorage.removeItem(key);
  }

  static clear() {
    localStorage.clear();
  }
}

/**
 * Event Delegation - تقليل عدد المستمعات
 */
class EventDelegator {
  constructor(container, eventType = 'click') {
    this.container = container;
    this.eventType = eventType;
    this.handlers = new Map();

    this.container.addEventListener(eventType, (e) => {
      this.handleEvent(e);
    });
  }

  on(selector, callback) {
    if (!this.handlers.has(selector)) {
      this.handlers.set(selector, []);
    }
    this.handlers.get(selector).push(callback);
  }

  handleEvent(e) {
    const target = e.target;

    this.handlers.forEach((callbacks, selector) => {
      if (target.matches(selector)) {
        callbacks.forEach(callback => callback.call(target, e));
      }
    });
  }
}

// تهيئة الأداة عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
  const optimizer = new PerformanceOptimizer();
  
  // تحميل العناصر الكسولة
  optimizer.observeLazyElements();
  
  // قياس الأداء
  setTimeout(() => {
    PerformanceMetrics.logMetrics();
  }, 0);

  // تنظيف الموارد عند إغلاق الصفحة
  window.addEventListener('beforeunload', () => {
    optimizer.cleanup();
  });

  // Export للاستخدام العام
  window.FTCOptimizer = {
    optimizer,
    metrics: PerformanceMetrics,
    cache: new CacheManager(),
    storage: StorageManager,
    delegation: EventDelegator
  };
});
