/* ============================================================
   نبض — تبويب البحث برقم الإقامة (ID Search)
   ------------------------------------------------------------
   اكتب رقم إقامة واحداً أو الصق عدة أرقام دفعة واحدة (من إكسل،
   كل رقم في سطر). يعرض لكل رقم بيانات العميل كاملة إن وُجد في
   النظام، أو رسالة «هذا الشخص غير موجود بالنظام» إن لم يوجد.
   كل رقم الإقامة = رقم الهوية الوطني للعميل (clientId).
   ============================================================ */
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }

  /* ---------- تطبيع الأرقام المدخلة ---------- */
  function parseIds(raw) {
    var ids = [];
    var seen = {};
    (String(raw || '')
      .split(/[\r\n,;\t]+/)           // سطر أو فاصلة أو فاصلة منقوطة أو تبويب
    ).forEach(function (tok) {
      tok = tok.replace(/[^\d]/g, ''); // نزيل أي رموز غير رقمية (بما فيها الأرقام الداخلة)
      if (!tok) return;
      if (seen[tok]) return;           // إزالة التكرار (مثل ما لو تكرر الرقم في اللصق)
      seen[tok] = true;
      ids.push(tok);
    });
    return ids;
  }

  /* ---------- الحصول على بيانات الشخص ---------- */
  function clientById(id) {
    if (typeof clients === 'undefined') return null;
    return (clients || []).find(function (c) {
      return c && String(c.clientId || '') === String(id);
    });
  }

  /* ---------- معلومات الدفع للعميل ---------- */
  function clientPayments(c) {
    if (typeof vaultTx === 'undefined') return [];
    return (vaultTx || []).filter(function (t) {
      return t && t.type === 'in' && !t.deletedAt && String(t.clientId || '') === String(c.clientId);
    });
  }
  function paymentMethodText(c) {
    var pays = clientPayments(c);
    if (pays.length) {
      var parts = pays.map(function (t) { return String(t.method || '').trim(); }).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    var m = String(c.channel || '').trim();
    var m2 = String(c.channel2 || '').trim();
    if (m && m2) return m + ' + ' + m2;
    return m || m2 || null;
  }
  function paymentDateText(c) {
    var pays = clientPayments(c);
    if (pays.length) {
      var last = pays[pays.length - 1];
      if (last && last.date) return last.date;
    }
    return null;
  }
  function courseDateText(c) {
    var d = String(c.startDate || '').trim();
    return d || null;
  }
  /* صلاحية التدريب / الحقيبة:
     - إن أعاد أركان تاريخ صلاحية صريحاً نستخدمه كما هو.
     - وإلا تُحسب من تاريخ بداية الدورة بنفس قاعدة «صلاحية التثقيف الصحي»
       في البرنامج: 3 سنوات ناقص يوم (بداية 2026-01-10 → نهاية 2029-01-09). */
  function validityDateText(startDate, explicit) {
    var raw = String(explicit || '').trim();
    if (raw) return raw;
    var s = String(startDate || '').trim().replace(/\//g, '-');
    if (!s) return '';
    if (typeof FTCHealthEducation !== 'undefined' && FTCHealthEducation &&
        typeof FTCHealthEducation.calculateExpiry === 'function') {
      try {
        var iso = FTCHealthEducation.calculateExpiry(s);
        if (iso) return iso;
      } catch (e) {}
    }
    var d = new Date(s.slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setFullYear(d.getFullYear() + 3);
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(d) {
    if (!d) return '—';
    return (typeof formatDateDisplay === 'function' ? formatDateDisplay(d) : d) || '—';
  }

  /* ---------- خلية نتيجة الاختبار للعميل ---------- */
  function examInfo(c) {
    if (typeof arkkanExamStatusOf === 'function') {
      return arkkanExamStatusOf(c);
    }
    var er = String(c.examResult || '').trim();
    return er ? { r: er, d: c.examLastDate || '' } : null;
  }
  function examCellHtml(c) {
    var s = examInfo(c);
    if (!s) return '<span style="color:var(--text-muted);">لم يُختبَر</span>';
    var r = String(s.r).trim();
    var g = String(s.g || '').trim();
    var d = s.d || c.examLastDate || '';
    var tip = d ? 'آخر اختبار: ' + r + (g ? ' (درجة: ' + g + ')' : '') + ' — بتاريخ ' + d : 'آخر اختبار: ' + r + (g ? ' (درجة: ' + g + ')' : '');
    if (typeof arkkanExamCell === 'function') {
      // تمرير الكائن كاملاً لعرض الدرجة
      return '<span title="' + escapeHtml(tip) + '">' + arkkanExamCell({ r: r, g: g }) + '</span>';
    }
    if (r.includes('ناجح')) return '<span style="color:var(--success, green); font-weight:600;cursor:help;" title="' + escapeHtml(tip) + '">ناجح ✓' + (g ? ' (' + escapeHtml(g) + ')' : '') + '</span>';
    if (r.includes('راسب')) return '<span style="color:var(--danger, red); font-weight:600;cursor:help;" title="' + escapeHtml(tip) + '">راسب' + (g ? ' (' + escapeHtml(g) + ')' : '') + '</span>';
    return '<span style="color:var(--text-muted);cursor:help;" title="' + escapeHtml(tip) + '">' + escapeHtml(r) + (g ? ' (' + escapeHtml(g) + ')' : '') + '</span>';
  }

  /* ══════════════════════════════════════════════
     وكيل أركان داخل التبويب — للأشخاص غير الموجودين بالنظام
     ── كل شيء يدوي: المستخدم يكتب الرقم المرجعي بنفسه (إن توفر)
        ويضغط زر واحد يقوم بجلب كامل من أركان (الدورة، الفاتورة، القيمة،
        الحقيبة) + نتائج الاختبار ويعرضها للقراءة فقط — لا يُسجَّل شيء
        في قاعدة العملاء ولا يُعدَّل أي سجل قديم.
        بلا أي شرط تصفية (لا شرط FHD ولا غيره): طلب allCourses=true. ──
     ══════════════════════════════════════════════ */
  var arkkanCache = {}; // رقم الإقامة -> { refNum, data, exams, examsErr, at }

  /* ══════════════════════════════════════════════
     سجل البحث المحلي (عرض فقط — لا علاقة له بقاعدة العملاء)
     ── يحفظ آخر ما جُلب من أركان لكل رقم إقامة، فيستطيع المستخدم
        الرجوع إليه في أي وقت: لو بحث عن نفس الرقم مرة ثانية تظهر
        بياناته فوراً من السجل (بتاريخ الجلب) بلا أي اتصال بالوكيل.
        الحفظ في مخزن مستقل تماماً (مفتاح idsearchArkkanHistory)
        داخل window.storage مع احتياطي محلي — ولا يُسجَّل أي شيء
        في الشيت ولا يُضاف أي عميل للنظام. ── */
  var ARKKAN_HISTORY_KEY = 'idsearchArkkanHistory';
  var ARKKAN_HISTORY_MAX = 2000; // نحتفظ بأحدث 2000 رقم فقط
  var _akHistory = null;          // { [id]: { refNum, data, exams, examsErr, at } }
  var _akHistTimer = null;
  var _akHistQueue = Promise.resolve();

  function akHistoryNormalize(obj) {
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  }

  /* تحميل السجل — يبدأ من النسخة المحلية فوراً ثم يُزامن مع المخزن إن وُجد */
  async function akHistoryLoad() {
    if (_akHistory) return _akHistory;
    // 1) النسخة المحلية (localStorage): فورية وبلا أي اتصال
    try {
      var rawLs = localStorage.getItem(ARKKAN_HISTORY_KEY);
      if (rawLs) _akHistory = akHistoryNormalize(JSON.parse(rawLs));
    } catch (e) {}
    // 2) مخزن البرنامج (window.storage): يشمل أي مزامنة سحابية
    if (typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function') {
      try {
        var r = await window.storage.get(ARKKAN_HISTORY_KEY, false, false);
        var raw = r && r.value ? r.value : '';
        if (raw) {
          var obj = akHistoryNormalize(typeof raw === 'string' ? JSON.parse(raw) : raw);
          // ندمج الأحدث تاريخاً بين النسختين (لا نفقد ما جُلب أثناء الغياب)
          var merged = Object.assign({}, obj, _akHistory || {});
          for (var k in obj) {
            if (_akHistory && _akHistory[k] && (_akHistory[k].at || 0) > (obj[k].at || 0)) merged[k] = _akHistory[k];
          }
          _akHistory = merged;
        } else if (!_akHistory) {
          _akHistory = {};
        }
      } catch (e) { if (!_akHistory) _akHistory = {}; }
    } else if (!_akHistory) {
      _akHistory = {};
    }
    return _akHistory;
  }

  /* قصّ الحد الأقصى: نحتفظ بالأحدث تاريخ جلب */
  function akHistoryTrim() {
    if (!_akHistory) return;
    var keys = Object.keys(_akHistory);
    if (keys.length <= ARKKAN_HISTORY_MAX) return;
    keys.sort(function (a, b) { return (_akHistory[b].at || 0) - (_akHistory[a].at || 0); });
    var next = {};
    keys.slice(0, ARKKAN_HISTORY_MAX).forEach(function (k) { next[k] = _akHistory[k]; });
    _akHistory = next;
  }

  /* الحفظ المؤجَّل (debounce) + طابور مسلسل حتى لا تتعارض الكتابات */
  function akHistoryPersist() {
    if (!_akHistory) return;
    try { localStorage.setItem(ARKKAN_HISTORY_KEY, JSON.stringify(_akHistory)); } catch (e) {}
    if (_akHistTimer) clearTimeout(_akHistTimer);
    _akHistTimer = setTimeout(function () {
      _akHistTimer = null;
      akHistoryFlush();
    }, 600);
  }

  function akHistoryFlush() {
    if (!_akHistory) return _akHistQueue;
    var payload = JSON.stringify(_akHistory);
    if (typeof window !== 'undefined' && window.storage && typeof window.storage.set === 'function') {
      _akHistQueue = _akHistQueue.then(function () {
        return window.storage.set(ARKKAN_HISTORY_KEY, payload, false).catch(function () {});
      }).catch(function () {});
    }
    return _akHistQueue;
  }

  /* حفظ سجل واحد بعد اكتمال الجلب */
  function akHistoryPut(id, rec) {
    if (!id || !rec) return;
    akHistoryLoad().then(function () {
      _akHistory[String(id)] = rec;
      akHistoryTrim();
      akHistoryPersist();
    });
  }

  function akHistoryGet(id) {
    return (_akHistory && _akHistory[String(id)]) || null;
  }

  /* المصدر الموحّد لبيانات أركان لأي رقم: ذاكرة الجلسة أولاً ثم السجل المحلي.
     يُستخدم في العرض والتصدير معاً حتى يظهر في التقرير كل ما هو معروض. */
  function akRecord(id) {
    return arkkanCache[String(id)] || akHistoryGet(id) || null;
  }

  function akHistoryDelete(id) {
    akHistoryLoad().then(function () {
      if (_akHistory[String(id)]) {
        delete _akHistory[String(id)];
        akHistoryPersist();
        renderAkHistory();
      }
    });
  }

  function akHistoryClear() {
    akHistoryLoad().then(function () {
      _akHistory = {};
      akHistoryPersist();
      renderAkHistory();
    });
  }

  function arkkanApiBase() {
    return (typeof ARKKAN_API_BASE !== 'undefined') ? ARKKAN_API_BASE : 'http://localhost:9955';
  }

  function arkkanPost(path, body, timeoutMs) {
    return fetch(arkkanApiBase() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 95000)
    }).then(function (r) {
      if (!r.ok) {
        var msg = 'فشل الوكيل المحلي (HTTP ' + r.status + ')';
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && j.error) || msg);
        });
      }
      return r.json();
    });
  }

  /* تصنيف نتيجة الاختبار بلا أي شرط إضافي:
     ناجح ✓ / راسب / يحتاج إلى اختبار / لم يُختبَر */
  function arkkanTabClassify(exams) {
    var attempts = (exams && Array.isArray(exams.attempts)) ? exams.attempts : [];
    var last = String((exams && exams.lastResult) || '').trim();
    var texts = attempts.map(function (a) { return String((a && a.r) || ''); }).filter(Boolean);
    if (last) texts.push(last);
    if (texts.some(function (t) { return t.includes('ناجح'); })) return { label: 'ناجح ✓', color: 'var(--success, green)' };
    if (texts.some(function (t) { return t.includes('راسب'); })) return { label: 'راسب', color: 'var(--danger, red)' };
    if (attempts.length) return { label: 'يحتاج إلى اختبار', color: '#c98a00' };
    return { label: 'لم يُختبَر', color: 'var(--text-muted)' };
  }

  /* ══════════════════════════════════════════════
     القالب المشترك لكتلة البيانات التفصيلية (عرض فقط)
     ── يُستخدم للموجود بالنظام وللغائب (بيانات أركان) معاً،
        فتظهر بيانات كل شخص بالتنسيق نفسه تماماً في الحالتين. ──
     ══════════════════════════════════════════════ */
  function akDetailBlockHtml(o) {
    function cell(label, val) {
      var v = String(val == null ? '' : val).trim();
      return '<div style="min-width:0;">' +
        '<div style="font-size:11px;color:var(--text-muted);">' + escapeHtml(label) + '</div>' +
        '<div style="font-weight:600;">' + (v ? escapeHtml(v) : '—') + '</div>' +
        '</div>';
    }

    var attempts = Array.isArray(o.attempts) ? o.attempts : [];
    var attHtml = attempts.length
      ? attempts.map(function (a, i) {
          return (i + 1) + ') ' + escapeHtml(String((a && a.r) || '—')) +
            (a && a.g ? ' — الدرجة: ' + escapeHtml(String(a.g)) : '') +
            (a && a.d ? ' — ' + escapeHtml(String(a.d)) : '');
        }).join('<br>')
      : '—';

    var cls = o.cls || { label: 'لم يُختبَر', color: 'var(--text-muted)' };

    return '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px;">' +
        '<b>' + escapeHtml(o.title || '') + '</b>' +
        '<span style="font-size:12px;color:var(--text-muted);">' + escapeHtml(o.subtitle || '') + '</span>' +
        (o.stamp ? '<span style="font-size:12px;color:var(--text-muted);">' + escapeHtml(o.stamp) + '</span>' : '') +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px;margin-bottom:8px;">' +
        (o.cells || []).map(function (x) { return cell(x.label, x.val); }).join('') +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 16px;padding:8px 10px;border-radius:8px;background:var(--bg-secondary, rgba(0,0,0,.03));">' +
        '<b style="color:' + cls.color + ';">' + escapeHtml(cls.label) + '</b>' +
        '<span>آخر نتيجة: <b>' + (o.lastResult ? escapeHtml(String(o.lastResult)) : '—') + '</b></span>' +
        '<span>بتاريخ: ' + (o.lastDate ? escapeHtml(String(o.lastDate)) : '—') + '</span>' +
        '<span style="min-width:200px;">المحاولات:<br>' + attHtml + '</span>' +
      '</div>' +
      (o.notes && o.notes.length ? '<div style="margin-top:6px;color:#c98a00;font-size:12px;">' + o.notes.map(escapeHtml).join(' · ') + '</div>' : '');
  }

  /* محتوى صف التفاصيل لغير الموجود بالنظام — من بيانات أركان (جلسة أو سجل) */
  function arkkanDetailHtml(id) {
    var r = akRecord(id);
    if (!r) return '';
    var d = r.data || {};
    var ex = r.exams || {};
    var notes = [];

    if (d._validation && d._validation.status === 'VALIDATION_FAILED') notes.push('تنبيه: تعذّر تأكيد بعض الحقول المستخرجة من أركان');
    if (!d.courseNumber && !d.invoice && !d.bagInvoice) notes.push('لم يُعثر على بيانات دورة/حقيبة لهذه الهوية في أركان');
    if (r.examsErr) notes.push('نتائج الاختبار: ' + r.examsErr);

    return akDetailBlockHtml({
      title: '🪝 بيانات أركان لهذا الرقم',
      subtitle: 'عرض فقط — لا يُسجَّل شيء في النظام',
      stamp: 'تاريخ الجلب: ' + new Date(r.at).toLocaleString('ar-EG'),
      cells: [
        { label: 'الرقم المرجعي', val: r.refNum },
        { label: 'رقم الدورة', val: d.courseNumber },
        { label: 'تاريخ الدورة', val: d.startDate },
        { label: 'تاريخ انتهاء الدورة', val: d.endDate },
        { label: 'صلاحية التدريب / الحقيبة', val: validityDateText(d.startDate, d.validityDate) },
        { label: 'رقم الفاتورة', val: d.invoice },
        { label: 'تاريخ الفاتورة', val: d.date },
        { label: 'قيمة الفاتورة', val: d.coursePrice },
        { label: 'رقم فاتورة الحقيبة', val: d.bagInvoice },
        { label: 'تاريخ شراء الحقيبة', val: d.bagPurchaseDate }
      ],
      cls: arkkanTabClassify(r.exams),
      lastResult: ex.lastResult,
      lastDate: ex.lastDate,
      attempts: ex.attempts,
      notes: notes
    });
  }

  /* محتوى صف التفاصيل للموجود بالنظام — بنفس تنسيق كتلة أركان تماماً.
     قراءة فقط من بيانات العميل: لا يُحفظ ولا يُسجَّل أي شيء. */
  function clientDetailHtml(c) {
    var ex = examInfo(c) || {};
    var pays = clientPayments(c);
    var lastPay = pays.length ? pays[pays.length - 1] : null;
    return akDetailBlockHtml({
      title: '👤 بيانات العميل المسجّل بالنظام',
      subtitle: 'عرض فقط — لا يُسجَّل شيء في النظام',
      cells: [
        { label: 'الاسم', val: c.name },
        { label: 'الجوال', val: c.phone },
        { label: 'الجنسية', val: c.nationality },
        { label: 'نوع الدورة', val: c.courseType },
        { label: 'الرقم المرجعي', val: c.referNum },
        { label: 'رقم الدورة', val: c.courseNumber },
        { label: 'تاريخ الدورة', val: c.startDate },
        { label: 'تاريخ انتهاء الدورة', val: c.endDate },
        { label: 'صلاحية التدريب / الحقيبة', val: validityDateText(courseDateText(c) || c.startDate, c.validityEndDate) },
        { label: 'رقم الفاتورة', val: c.invoice },
        { label: 'تاريخ الفاتورة', val: c.date },
        { label: 'قيمة الفاتورة', val: c.coursePrice },
        { label: 'رقم فاتورة الحقيبة', val: c.bagInvoice },
        { label: 'تاريخ شراء الحقيبة', val: c.bagOwnDate || c.bagPurchaseDate },
        { label: 'طريقة الدفع', val: paymentMethodText(c) },
        { label: 'تاريخ الدفع', val: lastPay && lastPay.date }
      ],
      cls: clientClassify(c),
      lastResult: ex.r,
      lastDate: ex.d,
      attempts: c.examAttempts,
      notes: []
    });
  }

  /* تحديث صف التفاصيل بعد اكتمال الجلب */
  function renderArkkanDetail(id) {
    var tr = document.querySelector('#idsearch-tbody tr.idsearch-ak-detail[data-ak-for="' + id + '"]');
    if (!tr) return;
    tr.style.display = '';
    var td = tr.querySelector('td');
    if (td) td.innerHTML = arkkanDetailHtml(id);
  }

  /* جلب الرقم المرجعي «من نفس الوكيل المحلي» (POST /api/arkkan/refnum)
     — يستعلم من وحدة «استعلام عن رقم مرجعي» في منصة إدارة النظام
     باعتماد بيانات حساب المنصة المسجّلة في تبويب مزامنة أركان.
     تُستدعى من داخل الزر الواحد (🪝 جلب من أركان) إذا كانت الخانة فاضية.
     تُرجع الرقم المرجعي أو '' — ومن لا رقم مرجعي له لا تُجلَب له بيانات
     أصلاً (بيانات أركان تُفتح بالرقم المرجعي)، فيُتخطّى بدل جلب فارغ. */
  async function arkkanAgentRefNum(id) {
    if (typeof arkkanBasesCreds !== 'function') return '';
    var creds = arkkanBasesCreds();
    if (!creds.user || !creds.pass) return '';
    try {
      var res = await arkkanPost('/api/arkkan/refnum', { clientId: id, basesCreds: creds, reuseSession: true }, 70000);
      return String((res && res.refNum) || '').trim();
    } catch (e) { return ''; }
  }

  /* ضغطة الزر الواحد: جلب كامل + اختبارات، ثم العرض فقط.
     silent=true يستخدم من الجلب الجماعي (بلا توست لكل رقم — التقدّم يظهر بجانب الزر).
     القيمة المرجعة: 'ok' | 'skipped' | 'failed' — حتى يميّز الجلب الجماعي
     «بلا رقم مرجعي» (تخطّي) عن الفشل الحقيقي.
     شرط أساسي: بيانات أركان لا تُفتح إلا بالرقم المرجعي؛ فلو لم يتوفر رقم
     مرجعي (لا يدوياً ولا من وحدة الاستعلام) نتخطّى الرقم بدل استدعاء جلب
     يرجع فارغاً ويُحسب نجاحاً زائفاً. */
  async function arkkanTabFetch(id, wrap, silent) {
    if (typeof ARKKAN_IS_DESKTOP !== 'undefined' && !ARKKAN_IS_DESKTOP) {
      showToast('الجلب من أركان متاح فقط من تطبيق سطح المكتب', 'info');
      return 'failed';
    }
    var btn = wrap.querySelector('.idsearch-ak-btn');
    var refInput = wrap.querySelector('.idsearch-ak-ref');
    var status = wrap.querySelector('.idsearch-ak-status');
    var refNum = String((refInput && refInput.value) || '').trim();

    // احتياط: لو الخانة غير موجودة/فاضية نستخدم المرجع المحفوظ في سجل البحث
    if (!refNum) {
      var prev = akRecord(id);
      if (prev && prev.refNum) refNum = String(prev.refNum).trim();
    }

    // هل حساب المنصة (مصدر الرقم المرجعي) مضبوط؟
    var creds = null;
    if (typeof arkkanBasesCreds === 'function') {
      try { creds = arkkanBasesCreds(); } catch (e) { creds = null; }
    }
    var hasCreds = !!(creds && creds.user && creds.pass);

    if (typeof arkkanEnsureAgentReady === 'function') {
      try { await arkkanEnsureAgentReady(); }
      catch (e) { showToast(String(e.message || e), 'error'); return 'failed'; }
    }

    if (btn) btn.disabled = true;
    try {
      // الخطوة صفر: لو الخانة اليدوية فاضية — نجلب الرقم المرجعي من نفس الوكيل
      // (وحدة «استعلام عن رقم مرجعي»). بلا رقم مرجعي لا توجد بيانات في أركان.
      if (!refNum) {
        if (!hasCreds) {
          if (status) status.textContent = '⏭ تخطي — اضبط حساب المنصة في تبويب مزامنة أركان (مصدر الرقم المرجعي)';
          if (!silent) showToast('تخطي ' + id + ': اضبط حساب المنصة في تبويب مزامنة أركان أولاً — لا يمكن جلب الرقم المرجعي بدونه', 'info');
          return 'skipped';
        }
        if (status) status.textContent = '⏳ جاري جلب الرقم المرجعي من الوكيل...';
        var gotRef = await arkkanAgentRefNum(id);
        if (gotRef) {
          refNum = gotRef;
          if (refInput) refInput.value = gotRef;
        }
      }

      // لا رقم مرجعي = لا بيانات في أركان → تخطّي بلا استدعاء الجلب الكامل
      if (!refNum) {
        if (status) status.textContent = '⏭ تخطي — لا يوجد رقم مرجعي لهذا الشخص';
        if (!silent) showToast('تخطي ' + id + ': لا يوجد رقم مرجعي — بيانات أركان لا تُجلب بدونه', 'info');
        return 'skipped';
      }

      if (status) status.textContent = '⏳ جاري الجلب الكامل من أركان...';
      var data = await arkkanPost('/api/arkkan/fetch', { clientId: id, referNum: refNum, allCourses: true, stayOnPage: true });
      if (status) status.textContent = '⏳ اكتمل الجلب — جاري جلب نتائج الاختبار...';
      var exams = null, examsErr = '';
      try { exams = await arkkanPost('/api/arkkan/exams', { clientId: id, referNum: refNum, stayOnPage: true }); }
      catch (e2) { examsErr = String(e2.message || e2); }

      arkkanCache[id] = { refNum: refNum, data: data || {}, exams: exams, examsErr: examsErr, at: Date.now() };
      akHistoryPut(id, arkkanCache[id]); // يُحفظ في السجل المحلي (عرض فقط) للرجوع لاحقاً
      renderArkkanDetail(id);
      renderAkHistory();
      if (status) status.textContent = '✓ تم الجلب';
      if (!silent) showToast('تم الجلب من أركان — التصنيف: ' + arkkanTabClassify(exams).label, 'success');
      return 'ok';
    } catch (err) {
      if (status) status.textContent = '✕ ' + String(err.message || err).slice(0, 100);
      if (!silent) showToast('فشل الجلب من أركان: ' + String(err.message || err).slice(0, 100), 'error');
      return 'failed';
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ══════════════════════════════════════════════
     الجلب الجماعي — زر واحد فوق الصندوق بيجيب كل «غير موجود» بالترتيب
     ── يمشي رقم تلو الآخر (لأن الوكيل يعمل بالطابور المتسلسل أصلاً)،
        ويعرض التقدّم بجانب الزر، ويوقف فوراً عند الضغط على «⏹ إيقاف»
        (يُنهي بعد الانتهاء من الرقم الجاري فقط — لا يقطع عملياً جارية).
        النتيجة تُحفظ في arkkanCache وتظهر في صفوف التفاصيل مباشرة. ──
     ══════════════════════════════════════════════ */
  var _akBulkRunning = false;
  var _akBulkStop = false;

  async function arkkanTabBulk() {
    if (_akBulkRunning) return;
    if (typeof ARKKAN_IS_DESKTOP !== 'undefined' && !ARKKAN_IS_DESKTOP) {
      showToast('الجلب من أركان متاح فقط من تطبيق سطح المكتب', 'info');
      return;
    }
    var missing = (lastResults || []).filter(function (r) { return !r.found; });
    if (!missing.length) { showToast('لا توجد أرقام «غير موجودة» بعد البحث — اضغط بحث أولاً', 'info'); return; }

    // قبل تشغيل الوكيل: لو حساب المنصة (مصدر الرقم المرجعي) غير مضبوط، ولا يوجد
    // أي رقم مرجعي محفوظ/مكتوب يدوياً — لا فائدة من البدء (كل الأرقام ستُتخطّى).
    var bulkCreds = null;
    if (typeof arkkanBasesCreds === 'function') {
      try { bulkCreds = arkkanBasesCreds(); } catch (e) { bulkCreds = null; }
    }
    if (!(bulkCreds && bulkCreds.user && bulkCreds.pass)) {
      var anyRef = missing.some(function (m) {
        var inp = document.querySelector('.idsearch-ak-controls[data-ak-for="' + m.id + '"] .idsearch-ak-ref');
        if (inp && String(inp.value || '').trim()) return true;
        var rec = akRecord(m.id);
        return !!(rec && rec.refNum);
      });
      if (!anyRef) {
        showToast('لا يمكن الجلب: اضبط حساب المنصة في تبويب مزامنة أركان أولاً — فهو مصدر الرقم المرجعي، وبدونه لا توجد بيانات في أركان', 'info');
        return;
      }
    }

    if (typeof arkkanEnsureAgentReady === 'function') {
      try { await arkkanEnsureAgentReady(); }
      catch (e) { showToast(String(e.message || e), 'error'); return; }
    }

    var bulkBtn = $('#btn-idsearch-ak-bulk');
    var stopBtn = $('#btn-idsearch-ak-bulk-stop');
    var statusEl = $('#idsearch-ak-bulk-status');
    _akBulkRunning = true;
    _akBulkStop = false;
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = '';
    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = '⏳ جاري التجهيز...'; }

    var ok = 0, fail = 0, skipped = 0, stopped = false;
    for (var i = 0; i < missing.length; i++) {
      if (_akBulkStop) { stopped = true; break; }
      var id = missing[i].id;
      var wrap = document.querySelector('.idsearch-ak-controls[data-ak-for="' + id + '"]');
      if (statusEl) statusEl.textContent = '⏳ ' + (i + 1) + '/' + missing.length + ' — جاري جلب رقم الإقامة ' + id + ' ...';
      try {
        // نفّذ نفس مسار الزر الواحد (رقم مرجعي تلقائي إن كان الخانة فاضية + جلب كامل + اختبارات)
        // إن لم توجد خانة في الصف (حالة نادرة) نمرّر حاوية منفصلة حتى يكمل الجلب بلا واجهة
        var res = await arkkanTabFetch(id, wrap || document.createElement('span'), true);
        if (res === 'ok') ok++;
        else if (res === 'skipped') skipped++;
        else fail++;
      } catch (e) { fail++; }
    }

    _akBulkRunning = false;
    if (bulkBtn) bulkBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
    var parts = ['✅ ' + ok + ' جُلب'];
    if (skipped) parts.push('⏭ ' + skipped + ' تخطي (بلا رقم مرجعي)');
    if (fail) parts.push('❌ ' + fail + ' فشل');
    var summary = parts.join(' · ');
    if (statusEl) {
      statusEl.textContent = (stopped ? '⏹ توقّف يدوياً — ' : '') + summary;
      setTimeout(function () { if (statusEl) statusEl.style.display = 'none'; }, 12000);
    }
    showToast((stopped ? 'توقّف الجلب الجماعي — ' : 'انتهى الجلب الجماعي: ') + summary, fail ? 'error' : (skipped && !ok ? 'info' : 'success'));
  }

  function arkkanTabBulkStop() {
    if (!_akBulkRunning) return;
    _akBulkStop = true;
    var statusEl = $('#idsearch-ak-bulk-status');
    if (statusEl) statusEl.textContent = '⏹ سيتم الإيقاف بعد الانتهاء من الرقم الجاري...';
  }

  /* ══════════════════════════════════════════════
     لوحة «سجل البحث» — كل رقم جُلب سابقاً مع تاريخه وتصنيفه
     ── زر «عرض» يضع الرقم في صندوق البحث ويعرض صفوفه فوراً
        (من السجل، بلا أي اتصال بالوكيل). «حذف» يزيل سجلاً واحداً.
        «مسح السجل» يفرغ كل شيء. كل هذا لا يمس قاعدة العملاء إطلاقاً. ──
     ══════════════════════════════════════════════ */
  function akHistCell(id) {
    var rec = arkkanCache[id] || akHistoryGet(id);
    var cls = arkkanTabClassify(rec ? rec.exams : null);
    var when = rec && rec.at ? new Date(rec.at).toLocaleString('ar-EG') : '—';
    var course = rec && rec.data && rec.data.courseNumber ? String(rec.data.courseNumber) : '—';
    var refn = rec && rec.refNum ? String(rec.refNum) : '—';
    return '<tr data-akhist="' + escapeHtml(id) + '">' +
      '<td class="mono"><b>' + escapeHtml(id) + '</b></td>' +
      '<td class="mono">' + escapeHtml(refn) + '</td>' +
      '<td class="mono">' + escapeHtml(course) + '</td>' +
      '<td><b style="color:' + cls.color + ';">' + escapeHtml(cls.label) + '</b></td>' +
      '<td style="font-size:12px;color:var(--text-muted);">' + escapeHtml(when) + '</td>' +
      '<td style="white-space:nowrap;">' +
        '<button type="button" class="btn btn-ghost btn-sm akhist-view">👁 عرض</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm akhist-del">🗑 حذف</button>' +
      '</td>' +
    '</tr>';
  }

  function renderAkHistory() {
    var box = $('#idsearch-hist-list');
    var countEl = $('#idsearch-hist-count');
    if (!box) return;
    akHistoryLoad().then(function () {
      var ids = Object.keys(_akHistory || {}).sort(function (a, b) {
        return ((_akHistory[b] && _akHistory[b].at) || 0) - ((_akHistory[a] && _akHistory[a].at) || 0);
      });
      if (countEl) countEl.textContent = ids.length ? '(' + ids.length + ' رقم محفوظ)' : '(فارغ)';
      if (!ids.length) {
        box.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px;">لا توجد أرقام محفوظة بعد — كل رقم تجلبه من أركان يُحفظ هنا تلقائياً للرجوع إليه لاحقاً</div>';
        box.style.maxHeight = '';
        return;
      }
      box.innerHTML = '<table class="table table-striped"><thead><tr>' +
        '<th>رقم الإقامة</th><th>الرقم المرجعي</th><th>رقم الدورة</th><th>التصنيف</th><th>تاريخ الجلب</th><th></th>' +
        '</tr></thead><tbody>' + ids.map(akHistCell).join('') + '</tbody></table>';
      akHistFitBox();
    });
  }

  /* ضبط ارتفاع صندوق السجل على 10 صفوف بالضبط (رأس + 10 صفوف) بالقياس الفعلي،
     فلا يتأثر باختلاف الثيم/الخط — والباقي يُرى بالتمرير داخل الصندوق. */
  function akHistFitBox() {
    var box = $('#idsearch-hist-list');
    if (!box) return;
    var head = box.querySelector('thead tr');
    var row = box.querySelector('tbody tr');
    if (!head || !row) { box.style.maxHeight = ''; return; }
    var hh = head.getBoundingClientRect().height;
    var rh = row.getBoundingClientRect().height;
    if (hh > 0 && rh > 0) box.style.maxHeight = Math.round(hh + 10 * rh) + 'px';
  }

  /* وضع رقم محفوظ في صندوق البحث وعرضه فوراً */
  function akHistShow(id) {
    var inp = $('#idsearch-input');
    if (!inp) return;
    inp.value = String(id);
    runSearch(); // يعرض صف «غير موجود» + صف التفاصيل من السجل مباشرة
    var el = document.querySelector('#idsearch-tbody tr.idsearch-missing[data-id="' + id + '"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------- ذاكرة مؤقتة لنتائج آخر بحث ---------- */
  var lastResults = [];

  /* ---------- بناء جدول النتائج ---------- */
  function render(results) {
    var tbody = $('#idsearch-tbody');
    var resultsBox = $('#idsearch-results');
    var empty = $('#idsearch-empty');
    var summary = $('#idsearch-summary');

    lastResults = results || [];

    if (!results.length) {
      resultsBox.style.display = 'none';
      empty.style.display = '';
      return;
    }

    empty.style.display = 'none';
    resultsBox.style.display = '';

    var found = results.filter(function (r) { return r.found; }).length;
    var missing = results.length - found;
    summary.innerHTML = 'تم البحث عن <b>' + results.length + '</b> رقم إقامة — موجود في النظام: <b style="color:var(--brand-secondary, teal)">' + found + '</b> · غير موجود: <b style="color:var(--red)">' + missing + '</b>';

    tbody.innerHTML = results.map(function (r) {
      var c = r.client;
      if (!r.found) {
        // لو الرقم محفوظ من جلب سابق (ولم يُجلَب في هذه الجلسة) نُظهر بياناته فوراً من السجل
        if (!arkkanCache[r.id] && akHistoryGet(r.id)) arkkanCache[r.id] = akHistoryGet(r.id);
        var ak = arkkanCache[r.id];
        var refVal = ak ? escapeHtml(ak.refNum || '') : '';
        return '<tr class="idsearch-missing" data-id="' + escapeHtml(r.id) + '">' +
          '<td class="mono">' + escapeHtml(r.id) + '</td>' +
          '<td colspan="10" class="idsearch-notfound"><span class="badge badge-danger">✕</span> هذا الشخص غير موجود بالنظام' +
            '<span class="idsearch-ak-controls" data-ak-for="' + escapeHtml(r.id) + '" style="display:inline-flex;align-items:center;gap:8px;margin-inline-start:12px;flex-wrap:wrap;">' +
              '<input type="text" class="idsearch-ak-ref" value="' + refVal + '" placeholder="الرقم المرجعي (مطلوب للجلب)" title="بيانات أركان تُجلب بالرقم المرجعي فقط — إن لم يوجد رقم مرجعي يُتخطّى هذا الشخص" style="width:160px;padding:4px 8px;border-radius:6px;border:1px solid var(--border, #ccc);background:var(--input-bg, #fff);color:inherit;">' +
              '<button type="button" class="btn btn-ghost btn-sm idsearch-ak-btn">🪝 جلب من أركان</button>' +
              '<span class="idsearch-ak-status" style="font-size:12px;color:var(--text-muted);"></span>' +
            '</span>' +
          '</td>' +
          '<td><span class="pill pill-red">غير موجود</span></td>' +
        '</tr>' +
        '<tr class="idsearch-ak-detail" data-ak-for="' + escapeHtml(r.id) + '"' + (ak ? '' : ' style="display:none;"') + '>' +
          '<td colspan="12">' + arkkanDetailHtml(r.id) + '</td>' +
        '</tr>';
      }
      return '<tr data-clientid="' + escapeHtml(c.clientId) + '">' +
        '<td class="mono">' + escapeHtml(c.clientId || '—') + '</td>' +
        '<td><b>' + escapeHtml(c.name || '—') + '</b></td>' +
        '<td>' + escapeHtml(c.phone || '—') + '</td>' +
        '<td>' + escapeHtml(c.nationality || '—') + '</td>' +
        '<td>' + escapeHtml(c.courseType || '—') + '</td>' +
        '<td class="mono">' + escapeHtml(c.courseNumber || '—') + '</td>' +
        '<td>' + fmtDate(courseDateText(c)) + '</td>' +
        '<td class="mono">' + escapeHtml(c.invoice || '—') + '</td>' +
        '<td>' + escapeHtml(paymentMethodText(c) || '—') + '</td>' +
        '<td>' + fmtDate(paymentDateText(c)) + '</td>' +
        '<td>' + examCellHtml(c) + '</td>' +
        '<td><span class="pill pill-green">موجود</span></td>' +
      '</tr>' +
      // صف البيانات الكاملة للموجود — بنفس تنسيق كتلة الغائب (عرض فقط، بلا تسجيل)
      '<tr class="idsearch-client-detail" data-detail-for="' + escapeHtml(c.clientId) + '">' +
        '<td colspan="12">' + clientDetailHtml(c) + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ---------- تنفيذ البحث ---------- */
  function runSearch() {
    var raw = $('#idsearch-input').value;
    var ids = parseIds(raw);
    $('#idsearch-count-hint').textContent = ids.length
      ? 'تم رصد ' + ids.length + ' رقم إقامة صالح'
      : '';

    if (!ids.length) {
      $('#idsearch-count-hint').textContent = 'لم يتم العثور على أرقام صالحة — تأكد من إدخال أرقام الهوية';
      render([]);
      return;
    }

    var results = ids.map(function (id) {
      var c = clientById(id);
      return c ? { id: id, found: true, client: c } : { id: id, found: false, client: null };
    });
    render(results);
  }

  /* ---------- تصدير CSV ---------- */
  /* تصنيف اختبار عميل مسجّل بالنظام — نفس منطق تصنيف أركان بالضبط
     (ناجح / راسب / يحتاج إلى اختبار / لم يُختبَر) مع الحفاظ على أي نص حالة صريح */
  function clientClassify(c) {
    var er = String((c && c.examResult) || '').trim();
    var att = Array.isArray(c && c.examAttempts) ? c.examAttempts : [];
    var texts = att.map(function (a) { return String((a && a.r) || ''); }).filter(Boolean);
    if (er) texts.push(er);
    if (texts.some(function (t) { return t.includes('ناجح'); })) return { label: 'ناجح ✓', color: 'var(--success, green)' };
    if (texts.some(function (t) { return t.includes('راسب'); })) return { label: 'راسب', color: 'var(--danger, red)' };
    if (er) return { label: er, color: '#c98a00' };
    if (att.length) return { label: 'يحتاج إلى اختبار', color: '#c98a00' };
    return { label: 'لم يُختبَر', color: 'var(--text-muted)' };
  }

  /* نصّ المحاولات: «1) ناجح — الدرجة: 80 — 2026/01/01 | 2) ...» */
  function attemptsText(attempts) {
    var a = Array.isArray(attempts) ? attempts : [];
    if (!a.length) return '';
    return a.map(function (x, i) {
      var parts = [String((x && x.r) || '—')];
      if (x && x.g) parts.push('الدرجة: ' + x.g);
      if (x && x.d) parts.push(String(x.d));
      return (i + 1) + ') ' + parts.join(' — ');
    }).join(' | ');
  }

  /* ---------- تصدير CSV (تقرير شامل: كل المعروض + بيانات أركان كاملة) ---------- */
  function exportCSV() {
    if (!lastResults.length) { showToast('لا توجد نتائج للتصدير'); return; }
    // الأعمدة الأصلية الاثنا عشر أولاً بنفس ترتيبها، ثم أعمدة أركان الإضافية
    var rows = [[
      'رقم الإقامة', 'الاسم', 'الجوال', 'الجنسية', 'الدورة', 'رقم الدورة', 'تاريخ الدورة',
      'رقم الفاتورة', 'طريقة الدفع', 'تاريخ الدفع', 'نتيجة الاختبار', 'الحالة',
      'الرقم المرجعي', 'تاريخ الفاتورة', 'قيمة الفاتورة', 'رقم إيصال الحقيبة', 'تاريخ الحقيبة',
      'تصنيف الاختبار', 'تاريخ آخر اختبار', 'المحاولات', 'مصدر البيانات', 'تاريخ انتهاء الدورة',
      'صلاحية التدريب / الحقيبة'
    ]];
    lastResults.forEach(function (r) {
      if (!r.found) {
        // غير موجود بالنظام — تُطبع كل بيانات أركان (من الجلسة أو من السجل المحلي)
        var rec = akRecord(r.id);
        var d = (rec && rec.data) || {};
        var ex = (rec && rec.exams) || {};
        var cls = rec ? arkkanTabClassify(rec.exams) : null;
        rows.push([
          r.id, '', '', '', '',
          d.courseNumber || '', d.startDate || '', d.invoice || '', '', '',
          (ex.lastResult || ''), 'غير موجود',
          (rec && rec.refNum) || '', d.date || '', d.coursePrice || '',
          d.bagInvoice || '', d.bagPurchaseDate || '',
          cls ? cls.label : '', ex.lastDate || '', attemptsText(ex.attempts),
          rec ? ('أركان' + (rec.at ? ' — ' + new Date(rec.at).toLocaleString('ar-EG') : '')) : '',
          d.endDate || '',
          validityDateText(d.startDate, d.validityDate)
        ]);
        return;
      }
      var c = r.client;
      var ex2 = examInfo(c);
      var pays = clientPayments(c);
      var lastPay = pays.length ? pays[pays.length - 1] : null;
      rows.push([
        c.clientId || '', c.name || '', c.phone || '', c.nationality || '', c.courseType || '',
        c.courseNumber || '', c.startDate || '', c.invoice || '',
        paymentMethodText(c), (lastPay && lastPay.date) || '',
        ex2 ? ex2.r : '', 'موجود',
        c.referNum || '', c.date || '', c.coursePrice || '',
        c.bagInvoice || '', c.bagOwnDate || c.bagPurchaseDate || '',
        clientClassify(c).label, (ex2 && ex2.d) || '', attemptsText(c.examAttempts),
        'النظام',
        c.endDate || '',
        validityDateText(courseDateText(c) || c.startDate, c.validityEndDate)
      ]);
    });
    var csv = rows.map(function (row) {
      return row.map(function (cell) {
        return '"' + String(cell == null ? '' : cell).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'البحث-برقم-الاقامة.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------- التنقل لتفاصيل العميل ---------- */
  function openClient(id) {
    var s = $('#search');
    var clientsBtn = document.querySelector('nav.tabs button[data-view="clients"]');
    if (clientsBtn) clientsBtn.click();
    if (s) {
      s.value = id;
      s.dispatchEvent(new Event('input'));
    }
  }

  /* ---------- الربط ---------- */
  function init() {
    var runBtn = $('#btn-idsearch-run');
    var clearBtn = $('#btn-idsearch-clear');
    var exportBtn = $('#btn-idsearch-export');
    var input = $('#idsearch-input');
    if (!runBtn || !input) return;

    runBtn.addEventListener('click', runSearch);
    clearBtn.addEventListener('click', function () {
      input.value = '';
      $('#idsearch-count-hint').textContent = '';
      render([]);
      input.focus();
    });
    exportBtn.addEventListener('click', exportCSV);
    var akBulkBtn = $('#btn-idsearch-ak-bulk');
    var akBulkStopBtn = $('#btn-idsearch-ak-bulk-stop');
    if (akBulkBtn) akBulkBtn.addEventListener('click', arkkanTabBulk);
    if (akBulkStopBtn) akBulkStopBtn.addEventListener('click', arkkanTabBulkStop);

    // ── لوحة سجل البحث ──
    renderAkHistory(); // تحميل القائمة عند فتح التبويب
    // إعادة ضبط ارتفاع الصندوق عند فتح التبويب (القياس يحتاج أن يكون العنصر ظاهراً)
    var idsearchNavBtn = document.querySelector('nav.tabs button[data-view="idsearch"]');
    if (idsearchNavBtn) idsearchNavBtn.addEventListener('click', function () {
      requestAnimationFrame(function () { akHistFitBox(); });
    });
    window.addEventListener('resize', akHistFitBox);
    var histRefreshBtn = $('#btn-idsearch-hist-refresh');
    var histClearBtn = $('#btn-idsearch-hist-clear');
    if (histRefreshBtn) histRefreshBtn.addEventListener('click', function () { _akHistory = null; renderAkHistory(); });
    if (histClearBtn) histClearBtn.addEventListener('click', function () {
      if (!window.confirm('سيتم مسح كل الأرقام المحفوظة في سجل البحث من هذا الجهاز. متأكد؟')) return;
      akHistoryClear();
      showToast('تم مسح سجل البحث', 'success');
    });
    var histList = $('#idsearch-hist-list');
    if (histList) histList.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-akhist]');
      if (!row) return;
      var id = row.getAttribute('data-akhist');
      if (e.target.closest('.akhist-view')) { akHistShow(id); return; }
      if (e.target.closest('.akhist-del')) {
        akHistoryDelete(id);
        if (arkkanCache[id]) delete arkkanCache[id]; // يُزال من العرض الحالي أيضاً
        render(lastResults || []);
        showToast('تم حذف الرقم ' + id + ' من سجل البحث', 'success');
      }
    });
    input.addEventListener('keydown', function (e) {
      // Ctrl/Cmd + Enter ينفذ البحث
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });
    $('#idsearch-tbody').addEventListener('click', function (e) {
      var akBtn = e.target.closest('.idsearch-ak-btn');
      if (akBtn) {
        var akWrap = akBtn.closest('.idsearch-ak-controls');
        if (akWrap) arkkanTabFetch(akWrap.getAttribute('data-ak-for'), akWrap);
        return;
      }
      var tr = e.target.closest('tr[data-clientid]');
      if (tr && typeof openClientWorkspace === 'function') {
        var clientId = tr.getAttribute('data-clientid');
        var c = clientById(clientId);
        if (c) openClientWorkspace(c.id);
      }
    });
    // Enter داخل خانة الرقم المرجعي = تنفيذ الجلب مباشرة
    $('#idsearch-tbody').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var inp = e.target.closest('.idsearch-ak-ref');
      if (!inp) return;
      e.preventDefault();
      var akWrap = inp.closest('.idsearch-ak-controls');
      if (akWrap) arkkanTabFetch(akWrap.getAttribute('data-ak-for'), akWrap);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.renderIdSearch = function () { init(); };
})();
