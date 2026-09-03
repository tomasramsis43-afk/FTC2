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
    var d = s.d || c.examLastDate || '';
    var tip = d ? 'آخر اختبار: ' + r + ' — بتاريخ ' + d : 'آخر اختبار: ' + r;
    if (typeof arkkanExamCell === 'function') {
      return '<span title="' + escapeHtml(tip) + '">' + arkkanExamCell(r) + '</span>';
    }
    if (r.includes('ناجح')) return '<span style="color:var(--success, green); font-weight:600;cursor:help;" title="' + escapeHtml(tip) + '">ناجح ✓</span>';
    if (r.includes('راسب')) return '<span style="color:var(--danger, red); font-weight:600;cursor:help;" title="' + escapeHtml(tip) + '">راسب</span>';
    return '<span style="color:var(--text-muted);cursor:help;" title="' + escapeHtml(tip) + '">' + escapeHtml(r) + '</span>';
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
        return '<tr class="idsearch-missing">' +
          '<td class="mono">' + escapeHtml(r.id) + '</td>' +
          '<td colspan="10" class="idsearch-notfound"><span class="badge badge-danger">✕</span> هذا الشخص غير موجود بالنظام</td>' +
          '<td><span class="pill pill-red">غير موجود</span></td>' +
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
  function exportCSV() {
    if (!lastResults.length) { showToast('لا توجد نتائج للتصدير'); return; }
    var rows = [
      ['رقم الإقامة', 'الاسم', 'الجوال', 'الجنسية', 'الدورة', 'رقم الدورة', 'تاريخ الدورة', 'رقم الفاتورة', 'طريقة الدفع', 'تاريخ الدفع', 'نتيجة الاختبار', 'الحالة']
    ];
    lastResults.forEach(function (r) {
      if (!r.found) { rows.push([r.id, '', '', '', '', '', '', '', '', '', '', 'غير موجود']); return; }
      var c = r.client;
      var ex = examInfo(c);
      var pays = clientPayments(c);
      var lastPay = pays.length ? pays[pays.length - 1] : null;
      rows.push([
        c.clientId || '', c.name || '', c.phone || '', c.nationality || '', c.courseType || '',
        c.courseNumber || '', c.startDate || '', c.invoice || '',
        paymentMethodText(c), (lastPay && lastPay.date) || '',
        ex ? ex.r : '', 'موجود'
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
    input.addEventListener('keydown', function (e) {
      // Ctrl/Cmd + Enter ينفذ البحث
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });
    $('#idsearch-tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-clientid]');
      if (tr && typeof openClientWorkspace === 'function') {
        var clientId = tr.getAttribute('data-clientid');
        var c = clientById(clientId);
        if (c) openClientWorkspace(c.id);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.renderIdSearch = function () { init(); };
})();
