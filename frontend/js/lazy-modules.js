/* ============================================================
   lazy-modules.js — تحميل كسول لملفات الموديولات الأثقل
   ------------------------------------------------------------
   المرحلة 1 من خطة تسريع الواجهة: بدل ما app.html يحمّل كل ملفات
   JS مرة واحدة عند فتح الصفحة، الملفات المدرجة هنا تتحمّل فقط أول
   مرة يفتح فيها المستخدم الشاشة المرتبطة بيها فعليًا.

   لا يغيّر أي منطق أعمال — فقط توقيت تحميل الملف نفسه.
   الاستخدام: window.ensureViewLoaded(viewName) ترجع Promise تتحقق
   لما الملف/الملفات تكون جاهزة (أو فورًا لو الـ view مش من ضمن
   القائمة هنا، أو كانت محمّلة مسبقًا).
   ============================================================ */
(function () {
  'use strict';

  // فقط الشاشات المُختارة للمرحلة الأولى (عملياتية، مش شاشات مالية
  // حساسة) — أي شاشة تانية غير مذكورة هنا تُعتبر "محمّلة أصلاً" في
  // app.html كالمعتاد بلا أي تغيير في سلوكها.
  var LAZY_VIEWS = {
    companies: ['js/module-companies.js'],
    purchases: ['js/module-purchases.js'],
    courses:   ['js/module-courses.js']
  };

  var _loaded = new Set();
  var _loading = new Map();

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('تعذّر تحميل ' + src)); };
      document.body.appendChild(s);
    });
  }

  window.ensureViewLoaded = function (view) {
    var files = LAZY_VIEWS[view];
    if (!files) return Promise.resolve(); // شاشة محمّلة أصلاً، مفيش داعي لأي تأخير
    if (_loaded.has(view)) return Promise.resolve();
    if (_loading.has(view)) return _loading.get(view);

    var p = Promise.all(files.map(loadScript))
      .then(function () { _loaded.add(view); })
      .catch(function (err) {
        _loading.delete(view); // نسمح بمحاولة تانية لاحقًا لو فشل التحميل (مثلاً مشكلة شبكة مؤقتة)
        console.error(err);
        if (typeof showToast === 'function') showToast('تعذّر تحميل هذا القسم، حاول مرة أخرى');
        throw err;
      });
    _loading.set(view, p);
    return p;
  };
})();
