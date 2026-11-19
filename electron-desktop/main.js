/*
 * FTC2 — نسخة سطح المكتب بالعمل الكامل دون إنترنت
 * -------------------------------------------------------------
 * البرنامج محلي بالكامل — لا سيرفر مركزي ولا مشاركة بين الأجهزة:
 *   - كل طلبات /api تُخدَم محلياً بواسطة local-api.js فوق ملفات JSON في
 *     مجلد بيانات المستخدم.
 *   - لا تنزيل/تحديث لملفات الواجهة من GitHub — الواجهة تُقرأ من app-assets
 *     المرفقة مع التطبيق مباشرة.
 *   - وكيل أركان يعمل محلياً إن كانت حزمته مرفقة، وجلب شيتات جوجل (/gsheet-csv)
 *     يعمل عبر بروكسي محلي يتجاوز قيود CORS.
 *
 * المنفذ 127.0.0.1:17532 (نفس العقد الأصلي) والاستماع محصور على loopback.
 */
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

// Move writable user data into the program folder (C:\Program Files\FTC2\data)
try { app.setPath('userData', 'C:/Program Files/FTC2/data'); } catch (e) {}

const PORT = 17532;
const OFFLINE_STUB_MSG = 'هذه الميزة تتطلب اتصال إنترنت وغير متاحة في النسخة المحلية';

// ═══════════════════════════════════════════════════════════════
// حراسة الطلبات المحلية
// ---------------------------------------------------------------
// السيرفر يستمع على loopback فقط، لكن أي صفحة مفتوحة في متصفح النظام تستطيع
// إرسال طلبات إليه (DNS rebinding / CSRF). لذلك نرفض:
//   1) أي طلب لا يحمل Host الخاص بالبرنامج (يقطع DNS rebinding).
//   2) أي طلب يحمل Origin أو Sec-Fetch-Site من موقع آخر (يقطع CSRF).
// لا يقيّد ذلك الاستخدام الشرعي: الواجهة تُحمَّل من نفس هذا الأصل.
// ═══════════════════════════════════════════════════════════════
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://[::1]:${PORT}`,
]);
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isAllowedLocalUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.has(u.host.toLowerCase());
  } catch (e) {
    return false;
  }
}

// كي لا يُحقن نص خارجي داخل صفحات HTML نخدمها من أصل البرنامج نفسه (XSS).
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// صفحة العودة من Google تصل دائماً كتنقّل cross-site (من accounts.google.com إلى
// 127.0.0.1)، فيرفضها الفحص أعلاه قبل أن تصل إلى المعالج. نستثني هذا المسار وحده
// من فحص Origin/Sec-Fetch-Site مع إبقاء فحص Host: الحماية من CSRF هنا مضمونة بـ
// state أحادي الاستخدام ومحدود الصلاحية (consumeOAuthState) داخل المعالج نفسه.
function isGDriveOAuthCallback(req) {
  return req.method === 'GET' && req.path === '/gdrive/callback';
}

function localRequestGuard(req, res, next) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return res.status(403).json({ error: 'طلب مرفوض: عنوان المضيف غير مسموح' });
  }
  if (isGDriveOAuthCallback(req)) return next();
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(String(origin).toLowerCase())) {
    return res.status(403).json({ error: 'طلب مرفوض: أصل الطلب غير مسموح' });
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ error: 'طلب مرفوض: طلب صادر من موقع آخر' });
  }
  next();
}

const createLocalApi = require('./local-api.js');

let mainWindow;
let dataDir;

// ═══════════════════════════════════════════════════════════════
// تذكّر بيانات الدخول على هذا الجهاز (اسم المستخدم + كلمة المرور)
// ---------------------------------------------------------------
// تُخزَّن كلمة المرور مشفّرة بحماية نظام التشغيل (Windows DPAPI عبر
// safeStorage) في ملف داخل مجلد بيانات التطبيق، ولا تُكتب كنص صريح أبداً.
// الواجهة تصل إليها عبر window.desktopAPI المحقون من preload.js.
// لا يوجد دخول تلقائي: تُملأ الحقول فقط ويضغط المستخدم «دخول».
// ═══════════════════════════════════════════════════════════════
const LOGIN_CREDS_FILE = 'login-credentials.json';

function loginCredsPath() {
  return path.join(app.getPath('userData'), LOGIN_CREDS_FILE);
}

function registerLoginCredsIpc() {
  ipcMain.handle('ftc2-creds:get', () => {
    try {
      const p = loginCredsPath();
      if (!fs.existsSync(p)) return { ok: false };
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!raw || !raw.data) return { ok: false };
      let json;
      if (raw.enc === 'safeStorage') {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false };
        json = safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
      } else {
        json = Buffer.from(raw.data, 'base64').toString('utf8');
      }
      const obj = JSON.parse(json);
      return { ok: true, username: obj.username || '', password: obj.password || '' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('ftc2-creds:save', (evt, username, password) => {
    try {
      const json = JSON.stringify({ username: String(username || ''), password: String(password || '') });
      let enc, data;
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        enc = 'safeStorage';
        data = safeStorage.encryptString(json).toString('base64');
      } else {
        // احتياطي: ترميز base64 لو تعذّر تشفير النظام (نادر جداً على ويندوز).
        enc = 'base64';
        data = Buffer.from(json, 'utf8').toString('base64');
      }
      fs.writeFileSync(loginCredsPath(), JSON.stringify({ v: 1, enc, data }), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('ftc2-creds:clear', () => {
    try {
      const p = loginCredsPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// Receipts (إيصالات أركان) — حفظ على القرص + فهرس برقم الفاتورة
// ---------------------------------------------------------------
// المصدر الحقيقي للربط هو رقم الفاتورة، وليس مجرد العميل:
//   <receipts-root>/<clientId>/دورة_<invoice>_<clientId>.pdf
//   <receipts-root>/<clientId>/receipts-index.json   (فهرس العميل)
//   <receipts-root>/_invoice-index.json              (فهرس عام للبحث السريع)
// كل عمليات العرض/الطباعة تُقرأ من النسخة المحلية أولاً.
// ═══════════════════════════════════════════════════════════════
const RECEIPTS_FOLDER_FILE = 'receipts-folder.json';
const RECEIPTS_GLOBAL_INDEX = '_invoice-index.json';
const RECEIPTS_INDEX_TTL_MS = 15000;
let _receiptsIndexCache = null;
let _receiptsIndexCacheAt = 0;

function defaultReceiptsDir() {
  return path.join(app.getPath('userData'), 'arkkan-receipts');
}

function receiptsFolderConfigPath() {
  return path.join(app.getPath('userData'), RECEIPTS_FOLDER_FILE);
}

function readCustomReceiptsDir() {
  try {
    const p = receiptsFolderConfigPath();
    if (!fs.existsSync(p)) return '';
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const folder = raw && raw.folder ? String(raw.folder).trim() : '';
    if (!folder) return '';
    // ملفات قديمة قد تحتوي مساراً تالفاً/غير موجود — نتجاهله ونعود للمسار الافتراضي.
    if (!fs.existsSync(folder)) return '';
    return folder;
  } catch (e) { return ''; }
}

function receiptsRoots() {
  const roots = [];
  const custom = readCustomReceiptsDir();
  if (custom) roots.push(custom);
  const def = defaultReceiptsDir();
  if (!roots.some(r => path.resolve(r).toLowerCase() === path.resolve(def).toLowerCase())) roots.push(def);
  return roots;
}

function receiptsBaseDir() {
  return receiptsRoots()[0];
}

function safeClientDirName(clientId) {
  return String(clientId == null ? '' : clientId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'unknown';
}

function clientReceiptsDir(clientId, root) {
  return path.join(root || receiptsBaseDir(), safeClientDirName(clientId));
}

function normalizeReceiptInvoice(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    // تجاهل الفواصل الشكلية فقط (مسافة/شرطة/نقطة/شرطة سفلية...) — تبقى الأرقام والحروف كما هي
    // حتى لا يُطابق إيصال فاتورة مختلفة، مع قبول اختلاف تنسيق الرقم بين شيت العملاء وأركان.
    .replace(/[^0-9A-Za-z\u0621-\u064A]/g, '')
    .toUpperCase();
}

function receiptKindLabel(kind) {
  return kind === 'course' ? 'دورة' : kind === 'bag' ? 'حقيبة' : 'إيصال';
}

function cleanReceiptToken(value, fallback) {
  const s = String(value == null ? '' : value)
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/[^\w\u0600-\u06FF._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return s || fallback || 'receipt';
}

function isPathInside(root, target) {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(target));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch (e) { return false; }
}

function readClientReceiptsIndex(dir) {
  try {
    const p = path.join(dir, 'receipts-index.json');
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeClientReceiptsIndex(dir, list) {
  const p = path.join(dir, 'receipts-index.json');
  const slim = (Array.isArray(list) ? list : []).slice(0, 200);
  fs.writeFileSync(p, JSON.stringify(slim, null, 2), 'utf8');
}

/* فهرس موثوق في جذر مجلد الإيصالات، يُكتب فقط عند حفظ إيصال جديد من البرنامج.
   الغرض: تمييز الملفات التي يحمل اسمها رقم الفاتورة الحقيقي عن الملفات القديمة التي
   يحمل اسمها رقم الدورة (مثل FHD967) — بدون هذا الفهرس لا يمكن التفريق بينهما
   بعد إعادة تشغيل البرنامج، وقد يُنسب إيصال عميل إلى عميل آخر. */
function readRootInvoiceIndex(root) {
  try {
    const p = path.join(root, RECEIPTS_GLOBAL_INDEX);
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeRootInvoiceIndex(root, list) {
  try {
    const p = path.join(root, RECEIPTS_GLOBAL_INDEX);
    const slim = (Array.isArray(list) ? list : []).slice(0, 20000);
    fs.writeFileSync(p, JSON.stringify(slim), 'utf8');
    return true;
  } catch (e) { return false; }
}

/* الملف القديم يحمل في اسمه رقم الدورة (FHD967) وليس رقم الفاتورة (FHD17616).
   أرقام الفواتير الحقيقية في أركان 5 أرقام أو أكثر، وأرقام الدورات الحالية 3-4 أرقام.
   القاعدة تُستخدم فقط للملفات التي لا يوجد لها سجل في الفهرس الموثوق. */
function receiptTokenLooksLikeInvoice(token) {
  const t = String(token || '').toUpperCase();
  if (!t) return false;
  const m = t.match(/^([A-Z]*)(\d+)$/);
  if (!m) return false;
  return m[2].length >= 5;
}

function _indexReceiptEntry(raw, dir, clientDirName, stat) {
  const fileName = String(raw.fileName || '').trim();
  const invoiceNo = String(raw.invoiceNo || '').trim();
  const key = normalizeReceiptInvoice(invoiceNo);
  if (!fileName || !key) return null;
  const filePath = path.join(dir, fileName);
  if (!isPathInside(dir, filePath) || !fs.existsSync(filePath)) return null;
  let fileStat = stat;
  if (!fileStat) { try { fileStat = fs.statSync(filePath); } catch (e) { return null; } }
  return {
    invoiceNo,
    invoiceKey: key,
    kind: raw.kind === 'bag' ? 'bag' : 'course',
    courseNumber: raw.courseNumber || '',
    date: raw.date || '',
    fileName,
    path: filePath,
    clientId: String(raw.clientId || clientDirName || ''),
    clientRecordId: raw.clientRecordId || '',
    clientName: raw.clientName || '',
    mime: raw.mime || (/\.png$/i.test(fileName) ? 'image/png' : 'application/pdf'),
    ext: raw.ext || path.extname(fileName).replace(/^\./, '').toLowerCase(),
    size: fileStat.size,
    savedAt: raw.savedAt || fileStat.mtime.toISOString(),
  };
}

const RECEIPT_MONTH_NAMES = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/* استخراج (النوع، هوية العميل، رقم الفاتورة) من اسم ملف إيصال.
   الصيغ المدعومة:
     دورة_<clientId>_<invoice>.pdf   ← الصيغة الفعلية للملفات المحفوظة مسبقاً
     دورة_<invoice>_<clientId>.pdf   ← صيغة احتياطية
     دورة_<clientId>.pdf             ← بلا رقم فاتورة (لا تُفهرس؛ لا يمكن ربطها بدقة)
   لا نخمّن أبداً: الملف بلا رقم فاتورة لا يُنسب لأي فاتورة. */
function parseReceiptFileName(fileName) {
  const m = String(fileName || '').match(/^(دورة|حقيبة|إيصال)_([^_]+)(?:_([^_]+))?\.(pdf|png|jpe?g)$/i);
  if (!m) return null;
  const kind = m[1] === 'حقيبة' ? 'bag' : 'course';
  const a = m[2];
  const b = m[3] || '';
  const isClientId = v => /^\d{10}$/.test(v);
  let clientId = '';
  let invoice = '';
  if (b) {
    if (isClientId(a)) { clientId = a; invoice = b; }
    else if (isClientId(b)) { invoice = a; clientId = b; }
    else { clientId = a; invoice = b; }
  } else if (isClientId(a)) {
    clientId = a;
  } else {
    invoice = a;
  }
  return { kind, clientId, invoice, ext: String(m[4]).toLowerCase() };
}

/* مجلد السنة/الشهر المستخدم فعلياً في مجلد الإيصالات المخصص (تاريخ 2026/10/20 مثلاً). */
function receiptDateFolder(dateValue) {
  const raw = String(dateValue || '').trim();
  if (!raw) return null;
  let year = 0;
  let month = 0;
  const m = raw.match(/^(\d{4})[\/\-.]?(\d{1,2})/);
  if (m) { year = Number(m[1]); month = Number(m[2]); }
  if (!year || !month) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) { year = d.getFullYear(); month = d.getMonth() + 1; }
  }
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return { year, monthName: RECEIPT_MONTH_NAMES[month - 1] };
}

function scanReceiptsIndex(force) {
  const now = Date.now();
  if (!force && _receiptsIndexCache && (now - _receiptsIndexCacheAt) < RECEIPTS_INDEX_TTL_MS) {
    return _receiptsIndexCache;
  }
  const items = {};
  // المفتاح يشمل هوية العميل: نفس رقم الفاتورة/الدورة قد يتكرر بين عملاء مختلفين،
  // ودون ذلك كان إيصال عميل يطمس إيصال عميل آخر في الفهرس.
  const dedupeId = (invoiceKey, kind, clientId) => invoiceKey + '|' + kind + '|' + String(clientId || '');
  const put = (entry) => {
    if (!entry || !entry.invoiceKey) return;
    const id = dedupeId(entry.invoiceKey, entry.kind, entry.clientId);
    const old = items[id];
    if (!old || (Number(!!entry.authoritative) > Number(!!old.authoritative)) ||
        (!!entry.authoritative === !!old.authoritative && String(entry.savedAt) > String(old.savedAt))) {
      items[id] = entry;
    }
  };

  for (const root of receiptsRoots()) {
    const trustedPaths = new Set();

    // (1) الفهرس الموثوق: ما حفظه البرنامج بنفسه، وفيه رقم الفاتورة الحقيقي ونوع الإيصال.
    for (const raw of readRootInvoiceIndex(root)) {
      if (!raw) continue;
      const rel = String(raw.relPath || raw.fileName || '').replace(/\\/g, '/');
      if (!rel) continue;
      const full = path.resolve(root, rel);
      if (!isPathInside(root, full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (!stat.isFile()) continue;
      trustedPaths.add(full.toLowerCase());
      const invoiceNo = String(raw.invoiceNo || '').trim();
      const invoiceKey = normalizeReceiptInvoice(invoiceNo);
      if (!invoiceKey) continue;
      put({
        invoiceNo,
        invoiceKey,
        kind: raw.kind === 'bag' ? 'bag' : 'course',
        courseNumber: raw.courseNumber || '',
        date: raw.date || '',
        fileName: path.basename(full),
        path: full,
        clientId: String(raw.clientId || ''),
        clientRecordId: raw.clientRecordId || '',
        clientName: raw.clientName || '',
        mime: raw.mime || (/\.png$/i.test(full) ? 'image/png' : 'application/pdf'),
        ext: String(raw.ext || path.extname(full).replace(/^\./, '')).toLowerCase(),
        size: stat.size,
        savedAt: raw.savedAt || stat.mtime.toISOString(),
        authoritative: true,
      });
    }

    // (2) فحص تعاودي للمجلدات (المجلد المخصص فيه «الدورات/2026/أكتوبر» و«الحقائب/2026/أكتوبر»).
    const queue = [{ dir: root, depth: 0 }];
    let guard = 0;
    while (queue.length && guard < 40000) {
      const current = queue.shift();
      let entries = [];
      try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (e) { continue; }

      // فهرس قديم داخل مجلد العميل — يحمل رقم الفاتورة الحقيقي، لذلك يُعامل كموثوق.
      const referenced = new Set();
      const clientDirName = path.basename(current.dir);
      for (const raw of readClientReceiptsIndex(current.dir)) {
        if (!raw) continue;
        const entry = _indexReceiptEntry(raw, current.dir, clientDirName);
        if (entry) {
          referenced.add(entry.fileName);
          put({ ...entry, authoritative: true });
        }
      }

      for (const ent of entries) {
        guard++;
        const full = path.join(current.dir, ent.name);
        if (ent.isDirectory()) {
          if (current.depth < 4) queue.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (referenced.has(ent.name)) continue;
        if (trustedPaths.has(path.resolve(full).toLowerCase())) continue;
        if (!/\.(pdf|png|jpe?g)$/i.test(ent.name)) continue;
        const parsed = parseReceiptFileName(ent.name);
        if (!parsed || !parsed.invoice) continue;
        if (!isPathInside(root, full)) continue;

        const token = String(parsed.invoice);
        const tokenKey = normalizeReceiptInvoice(token);
        if (!tokenKey) continue;

        // في الملفات القديمة: اسم ملف الدورة يحمل رقم الدورة، واسم ملف الحقيبة يحمل رقم الفاتورة.
        const legacyCourseToken = parsed.kind === 'course' && !receiptTokenLooksLikeInvoice(token);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        put({
          invoiceNo: token,
          invoiceKey: tokenKey,
          kind: parsed.kind,
          // لو الرقم رقم دورة، نُبقيه كرقم دورة فقط ولا ندّعي أنه رقم فاتورة.
          courseNumber: legacyCourseToken ? token : '',
          date: '',
          fileName: ent.name,
          path: full,
          clientId: parsed.clientId || '',
          clientRecordId: '',
          clientName: '',
          mime: parsed.ext === 'png' ? 'image/png' : 'application/pdf',
          ext: parsed.ext,
          size: stat.size,
          savedAt: stat.mtime.toISOString(),
          authoritative: false,
          legacyCourseToken,
        });
      }
    }
  }

  // تعليم الأرقام المشتركة بين أكثر من عميل: لا يجوز عرضها بالبحث برقم الفاتورة وحده.
  const owners = new Map();
  for (const entry of Object.values(items)) {
    const k = entry.invoiceKey + '|' + entry.kind;
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k).add(String(entry.clientId || ''));
  }
  for (const entry of Object.values(items)) {
    const set = owners.get(entry.invoiceKey + '|' + entry.kind);
    entry.ambiguous = !!(set && set.size > 1);
  }

  _receiptsIndexCache = items;
  _receiptsIndexCacheAt = now;
  return items;
}

function receiptsIndexList() {
  return Object.values(scanReceiptsIndex(false)).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/* ترتيب المرشحين: الموثوق أولاً، ثم إيصال الدورة، ثم الأحدث. */
function _pickReceiptEntry(list) {
  if (!list || !list.length) return null;
  return list.slice().sort((a, b) =>
    (Number(!!b.authoritative) - Number(!!a.authoritative)) ||
    (Number(b.kind === 'course') - Number(a.kind === 'course')) ||
    String(b.savedAt).localeCompare(String(a.savedAt))
  )[0];
}

/* البحث برقم الفاتورة. عند تمرير clientId تصبح المطابقة صارمة على نفس العميل،
   فلا يمكن أبداً عرض إيصال عميل آخر حتى لو تكرر الرقم بين عملاء مختلفين. */
function findReceipt(invoiceNo, clientId) {
  const key = normalizeReceiptInvoice(invoiceNo);
  if (!key) return null;
  const all = Object.values(scanReceiptsIndex(false)).filter(x => x.invoiceKey === key);
  if (!all.length) return null;
  if (clientId) {
    const mine = all.filter(x => String(x.clientId) === String(clientId));
    return mine.length ? _pickReceiptEntry(mine) : null;
  }
  const owners = new Set(all.map(x => String(x.clientId || '')).filter(Boolean));
  if (owners.size > 1) return null; // رقم مشترك بين عملاء — لا نخمّن
  return _pickReceiptEntry(all);
}

/* البحث لعميل محدد مع الاستفادة من الملفات القديمة:
   1) مطابقة رقم الفاتورة الحقيقي.
   2) مطابقة رقم الدورة (الملفات القديمة المسماة بـ دورة_<الهوية>_<رقم الدورة>.pdf).
   3) ملف دورة وحيد لهذا العميل بلا رقم في اسمه — يُعرض كخيار أخير لأنه ملفه هو. */
function findReceiptForClient(payload) {
  const p = payload || {};
  const clientId = String(p.clientId || '').trim();
  if (!clientId) return findReceipt(p.invoiceNo);
  const invoiceKey = normalizeReceiptInvoice(p.invoiceNo);
  const courseKey = normalizeReceiptInvoice(p.courseNumber);
  const mine = Object.values(scanReceiptsIndex(false))
    .filter(x => String(x.clientId) === clientId);
  if (!mine.length) return null;

  if (invoiceKey) {
    const exact = mine.filter(x => x.invoiceKey === invoiceKey && !x.legacyCourseToken);
    if (exact.length) return _pickReceiptEntry(exact);
  }
  if (courseKey) {
    const byCourse = mine.filter(x => x.kind === 'course' && x.legacyCourseToken && x.invoiceKey === courseKey);
    if (byCourse.length) return _pickReceiptEntry(byCourse);
  }
  // ملف قديم واحد فقط لهذا العميل (بلا رقم فاتورة أو رقم دورة) — لا لبس فيه.
  const legacyCourses = mine.filter(x => x.kind === 'course' && !x.authoritative);
  if (legacyCourses.length === 1) return legacyCourses[0];
  return null;
}

/* البحث بنوع صريح (دورة/حقيبة) — لطباعة الدفعات: يمنع أن يُطبع إيصال حقيبة
   بدل إيصال دورة أو العكس حتى لو حمل الاثنان نفس الرقم لنفس العميل. */
function findReceiptForKind(invoiceNo, clientId, kind) {
  const key = normalizeReceiptInvoice(invoiceNo);
  if (!key) return null;
  const cid = String(clientId || '').trim();
  let mine = Object.values(scanReceiptsIndex(false)).filter(x => x.invoiceKey === key);
  if (cid) {
    mine = mine.filter(x => String(x.clientId) === cid);
  } else {
    const owners = new Set(mine.map(x => String(x.clientId || '')).filter(Boolean));
    if (owners.size > 1) return null; // رقم مشترك بين عملاء — لا نخمّن
  }
  if (!mine.length) return null;
  const wanted = kind === 'bag' ? 'bag' : (kind === 'course' ? 'course' : '');
  if (!wanted) return _pickReceiptEntry(mine);
  const typed = mine.filter(x => x.kind === wanted);
  return typed.length ? _pickReceiptEntry(typed) : null;
}

function persistReceipt(data) {
  const { clientId, clientName, clientRecordId, invoiceNo, kind, courseNumber, date, mime, base64, ext } = data || {};
  const invoice = String(invoiceNo || '').trim();
  if (!clientId || !invoice || !base64) {
    return { ok: false, error: 'بيانات ناقصة (clientId, invoiceNo, base64 مطلوبة)' };
  }
  const kindKey = kind === 'bag' ? 'bag' : 'course';
  const cleanExt = String(ext || (mime === 'image/png' ? 'png' : 'pdf')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
  const invoiceKey = normalizeReceiptInvoice(invoice);

  // إن كانت هناك نسخة محلية لنفس الفاتورة/النوع، نكتب فوقها في مكانها بدل إنشاء نسخة ثانية.
  scanReceiptsIndex(false);
  const existing = findReceipt(invoice, clientId);
  const roots = receiptsRoots();
  let root = receiptsBaseDir();
  let fileName = '';
  let filePath = '';
  let dir = '';

  if (existing && existing.ext === cleanExt) {
    const existingRoot = roots.find(r => isPathInside(r, existing.path));
    if (existingRoot) {
      root = existingRoot;
      filePath = existing.path;
      fileName = existing.fileName;
      dir = path.dirname(filePath);
    }
  }

  if (!filePath) {
    const kindFolder = kindKey === 'bag' ? 'الحقائب' : 'الدورات';
    const dateFolder = receiptDateFolder(date);
    dir = dateFolder
      ? path.join(root, kindFolder, String(dateFolder.year), dateFolder.monthName)
      : path.join(root, kindFolder);
    fs.mkdirSync(dir, { recursive: true });
    fileName = `${receiptKindLabel(kindKey)}_${cleanReceiptToken(clientId, 'client')}_${cleanReceiptToken(invoice, 'receipt')}.${cleanExt}`;
    filePath = path.join(dir, fileName);
  }
  if (!isPathInside(root, filePath)) return { ok: false, error: 'مسار ملف غير صالح' };

  const buffer = Buffer.from(String(base64), 'base64');
  fs.writeFileSync(filePath, buffer);

  const entry = {
    invoiceNo: invoice,
    invoiceKey,
    kind: kindKey,
    courseNumber: courseNumber || '',
    date: date || '',
    fileName,
    path: filePath,
    clientId: String(clientId),
    clientRecordId: String(clientRecordId || ''),
    clientName: clientName || '',
    mime: mime || (cleanExt === 'png' ? 'image/png' : 'application/pdf'),
    ext: cleanExt,
    size: buffer.length,
    savedAt: new Date().toISOString(),
  };

  // فهرس جانبي قديم إن كان موجوداً في نفس المجلد (لا ننشئ واحداً جديداً في مجلدات السنوات).
  const legacyIndexPath = path.join(dir, 'receipts-index.json');
  if (fs.existsSync(legacyIndexPath)) {
    const index = readClientReceiptsIndex(dir);
    const next = index.filter(x => !(normalizeReceiptInvoice(x.invoiceNo) === invoiceKey &&
      (x.kind === 'bag' ? 'bag' : 'course') === kindKey));
    next.unshift({
      invoiceNo: invoice, kind: kindKey, courseNumber: entry.courseNumber, date: entry.date,
      fileName, mime: entry.mime, ext: cleanExt, size: entry.size, savedAt: entry.savedAt,
      clientId: entry.clientId, clientRecordId: entry.clientRecordId, clientName: entry.clientName,
    });
    writeClientReceiptsIndex(dir, next);
  }

  // الفهرس الموثوق في الجذر: هو ما يجعل البرنامج يعرف بعد إعادة التشغيل أن اسم هذا
  // الملف يحمل رقم الفاتورة الحقيقي (وليست أرقام الدورات القديمة).
  const relPath = path.relative(root, filePath).split(path.sep).join('/');
  const globalIndex = readRootInvoiceIndex(root).filter(x => {
    const sameInvoice = normalizeReceiptInvoice(x.invoiceNo) === invoiceKey;
    const sameKind = (x.kind === 'bag' ? 'bag' : 'course') === kindKey;
    const sameClient = String(x.clientId || '') === String(clientId);
    return !(sameInvoice && sameKind && sameClient);
  });
  globalIndex.unshift({
    invoiceNo: invoice, kind: kindKey, clientId: String(clientId),
    clientRecordId: entry.clientRecordId, clientName: entry.clientName,
    courseNumber: entry.courseNumber, date: entry.date,
    fileName, relPath, mime: entry.mime, ext: cleanExt, size: entry.size, savedAt: entry.savedAt,
  });
  writeRootInvoiceIndex(root, globalIndex);

  // تحديث الفهرس في الذاكرة فوراً — بلا إعادة فحص كل الملفات بعد كل إيصال.
  const cacheEntry = { ...entry, authoritative: true, legacyCourseToken: false, ambiguous: false };
  if (!_receiptsIndexCache) scanReceiptsIndex(true);
  const cacheId = invoiceKey + '|' + kindKey + '|' + String(clientId);
  _receiptsIndexCache[cacheId] = cacheEntry;
  _receiptsIndexCacheAt = Date.now();
  return { ok: true, path: filePath, fileName, entry: cacheEntry };
}

function receiptFileResponse(res, rec) {
  if (!rec || !rec.path || !fs.existsSync(rec.path)) {
    res.status(404).json({ error: 'الإيصال غير موجود على هذا الجهاز' });
    return;
  }
  if (!receiptsRoots().some(root => isPathInside(root, rec.path))) {
    res.status(403).json({ error: 'مسار غير مسموح' });
    return;
  }
  const base = path.basename(rec.path);
  const ascii = base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', rec.mime || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.sendFile(path.resolve(rec.path));
}

function registerReceiptsIpc() {
  // حفظ إيصال على القرص (يُستدعى من الطابور التلقائي ومن التحميل اليدوي)
  ipcMain.handle('ftc2-receipts:save', async (evt, data) => {
    try { return persistReceipt(data); }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // فهرس كل الإيصالات المحفوظة (بدون محتوى الملفات)
  ipcMain.handle('ftc2-receipts:index', async () => {
    try {
      return { ok: true, items: receiptsIndexList(), folder: receiptsBaseDir(), defaultFolder: defaultReceiptsDir() };
    } catch (e) {
      return { ok: false, error: String(e.message || e), items: [] };
    }
  });

  // البحث برقم الفاتورة (المصدر الأول قبل أي اتصال بأركان)
  ipcMain.handle('ftc2-receipts:find', async (evt, payload) => {
    try {
      const rec = findReceiptForClient(payload);
      return rec ? { ok: true, receipt: rec } : { ok: false, error: 'الإيصال غير محفوظ محلياً' };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // فتح مجلد إيصالات العميل (أو المجلد الرئيسي)
  ipcMain.handle('ftc2-receipts:open-folder', async (evt, clientId, invoiceNo) => {
    try {
      if (!clientId && !invoiceNo) return { ok: false, error: 'clientId مطلوب' };
      let dir;
      if (invoiceNo) {
        const rec = findReceipt(invoiceNo, clientId);
        dir = rec ? path.dirname(rec.path) : clientReceiptsDir(clientId);
      } else {
        dir = clientReceiptsDir(clientId);
      }
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, folder: dir };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  // فتح مجلد الإيصالات الرئيسي (جميع العملاء)
  ipcMain.handle('ftc2-receipts:open-base-folder', async () => {
    try {
      const dir = receiptsBaseDir();
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, folder: dir };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  // فتح ملف الإيصال في التطبيق الافتراضي
  ipcMain.handle('ftc2-receipts:open-file', async (evt, payload) => {
    try {
      const rec = findReceipt(payload && payload.invoiceNo, payload && payload.clientId);
      if (!rec) return { ok: false, error: 'الإيصال غير موجود محلياً' };
      const err = await shell.openPath(rec.path);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // تصدير/حفظ نسخة من الإيصال في مكان يختاره المستخدم
  ipcMain.handle('ftc2-receipts:export', async (evt, payload) => {
    try {
      const rec = findReceipt(payload && payload.invoiceNo, payload && payload.clientId);
      if (!rec) return { ok: false, error: 'الإيصال غير موجود محلياً' };
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const saveOpts = {
        title: 'حفظ نسخة من إيصال أركان',
        defaultPath: path.join(app.getPath('downloads'), rec.fileName),
        filters: rec.mime === 'image/png' ? [{ name: 'PNG Image', extensions: ['png'] }] : [{ name: 'PDF', extensions: ['pdf'] }],
      };
      const r = owner ? await dialog.showSaveDialog(owner, saveOpts) : await dialog.showSaveDialog(saveOpts);
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.copyFileSync(rec.path, r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  /* ── تصدير إيصالات دفعة واحدة كملفات PDF في مجلد يختاره المستخدم ──
     يُستخدم لإرسال إيصالات الدورة/الحقيبة عبر واتساب: تُحفظ كل النسخ في
     مجلد واحد بأسماء واضحة (النوع + اسم العميل + رقم الإيصال). */
  ipcMain.handle('ftc2-receipts:export-batch', async (evt, payload) => {
    try {
      const items = Array.isArray(payload && payload.items) ? payload.items : [];
      if (!items.length) return { ok: false, error: 'لا توجد إيصالات للتصدير' };
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const pickOpts = {
        title: 'اختر مجلد حفظ إيصالات واتساب',
        defaultPath: app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory'],
      };
      const pick = owner ? await dialog.showOpenDialog(owner, pickOpts) : await dialog.showOpenDialog(pickOpts);
      if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) return { ok: false, canceled: true };
      const dir = pick.filePaths[0];
      const printOptions = normalizeReceiptPrintOptions(payload && payload.printOptions);
      const safePart = v => String(v == null ? '' : v).replace(/[\\/:*?"<>|\r\n\t]+/g, '-').trim();
      const saved = [], missing = [], failed = [];
      let seq = 0;
      for (const it of items) {
        const rec = findReceiptForKind(it && it.invoiceNo, it && it.clientId, it && it.kind);
        if (!rec) {
          missing.push({ clientId: it && it.clientId, clientRecordId: it && it.clientRecordId, invoiceNo: it && it.invoiceNo, kind: it && it.kind, name: it && it.name });
          continue;
        }
        try {
          // كل الملفات تُسلَّم PDF: الأصل إن كان PDF، وإلا نعيد بناءه كصفحة PDF.
          let src = rec.path;
          if (path.extname(String(rec.path || '')).toLowerCase() !== '.pdf') {
            src = await prepareReceiptPrintPdf(rec.path, printOptions);
          }
          seq++;
          const kindLabel = rec.kind === 'bag' ? 'الحقيبة' : 'الدورة';
          const namePart = safePart(it && it.name);
          const invPart = safePart(rec.invoiceNo);
          const base = `إيصال_${kindLabel}_${String(seq).padStart(2, '0')}` +
            (namePart ? '_' + namePart : '') + (invPart ? '_' + invPart : '');
          let dest = path.join(dir, base + '.pdf');
          let dup = 1;
          while (fs.existsSync(dest)) dest = path.join(dir, base + '_' + (++dup) + '.pdf');
          fs.copyFileSync(src, dest);
          saved.push({
            invoiceNo: rec.invoiceNo,
            kind: rec.kind,
            clientId: rec.clientId,
            clientRecordId: (it && it.clientRecordId) || '',
            name: (it && it.name) || '',
            path: dest,
            fileName: path.basename(dest),
          });
        } catch (e) {
          failed.push({ invoiceNo: rec.invoiceNo, kind: rec.kind, clientId: rec.clientId, clientRecordId: (it && it.clientRecordId) || '', name: (it && it.name) || '', error: String((e && e.message) || e) });
        }
      }
      return { ok: true, dir, saved, missing, failed };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /* ── تجهيز الإيصال للطباعة بمقاس مضبوط ──────────────────────────────
     إيصالات أركان (خاصة إيصالات الحقائب) محتواها يلمس حواف صفحة A4،
     والطابعات الليزرية لا تطبع أول ~4 مم من كل حافة — فتتأكّل الحروف.
     الحل: نعيد بناء صفحة PDF جديدة بمقاس الورق المطلوب ونضع محتوى الإيصال
     في وسطها بحجم يضمن بقاءه داخل حدود الطباعة مع هامش أمان، ثم نطبعها 1:1.
     لا يتغيّر الملف الأصلي المحفوظ إطلاقاً. */
  const PRINT_PAPER_PT = {
    A4: [595.28, 841.89],
    A5: [419.53, 595.28],
    Letter: [612, 792],
    Legal: [612, 1008],
  };
  const MM_TO_PT = 72 / 25.4;

  function receiptPrintLayout(srcW, srcH, paper, marginMm, percent) {
    const dims = PRINT_PAPER_PT[paper] || [srcW, srcH];
    const pw = dims[0], ph = dims[1];
    const marginPt = Math.max(0, Math.min(25, Number(marginMm) || 0)) * MM_TO_PT;
    const usableW = Math.max(1, pw - marginPt * 2);
    const usableH = Math.max(1, ph - marginPt * 2);
    const fit = Math.min(usableW / Math.max(1, srcW), usableH / Math.max(1, srcH));
    const ratio = Math.max(0.3, Math.min(1, (Number(percent) || 100) / 100));
    const scale = fit * ratio;
    const dw = srcW * scale, dh = srcH * scale;
    return { pw, ph, dw, dh, x: (pw - dw) / 2, y: (ph - dh) / 2, scale, fit };
  }

  function normalizeReceiptPrintOptions(opts) {
    const o = opts || {};
    const paper = PRINT_PAPER_PT[o.paper] ? o.paper : 'A4';
    const m = Number(o.marginMm);
    const marginMm = Math.max(0, Math.min(20, Number.isFinite(m) ? m : 6));
    const p = Number(o.percent);
    const percent = Math.max(30, Math.min(100, Number.isFinite(p) && p > 0 ? p : 100));
    return { paper, marginMm, percent };
  }

  function printCacheDir() {
    const dir = path.join(app.getPath('userData'), 'print-cache');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function prunePrintCache(dir, keep) {
    try {
      const files = fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f));
      if (files.length <= keep) return;
      const rows = files.map(f => {
        let t = 0;
        try { t = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { t = 0; }
        return { f, t };
      }).sort((a, b) => a.t - b.t);
      rows.slice(0, Math.max(0, files.length - keep)).forEach(x => {
        try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) {}
      });
    } catch (e) {}
  }

  // يبني (أو يعيد استخدام) PDF جاهزاً للطباعة بنفس مقاس الورق والهامش والحجم المطلوب.
  async function prepareReceiptPrintPdf(srcPath, opts) {
    const o = normalizeReceiptPrintOptions(opts);
    const st = fs.statSync(srcPath);
    const key = crypto.createHash('sha1')
      .update([srcPath, st.size, Math.round(st.mtimeMs), o.paper, o.marginMm, o.percent].join('|'))
      .digest('hex');
    const dir = printCacheDir();
    const out = path.join(dir, key + '.pdf');
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 800) return out;
    } catch (e) {}

    const PDFLib = require(path.join(__dirname, 'vendor', 'pdf-lib.min.js'));
    const bytes = fs.readFileSync(srcPath);
    const ext = path.extname(srcPath).toLowerCase();
    const doc = await PDFLib.PDFDocument.create();
    if (ext === '.pdf') {
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      for (const p of src.getPages()) {
        const w = p.getWidth(), h = p.getHeight();
        const L = receiptPrintLayout(w, h, o.paper, o.marginMm, o.percent);
        const page = doc.addPage([L.pw, L.ph]);
        const emb = await doc.embedPage(p);
        page.drawPage(emb, { x: L.x, y: L.y, width: L.dw, height: L.dh });
      }
    } else if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      const img = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const L = receiptPrintLayout(img.width, img.height, o.paper, o.marginMm, o.percent);
      const page = doc.addPage([L.pw, L.ph]);
      page.drawImage(img, { x: L.x, y: L.y, width: L.dw, height: L.dh });
    } else {
      throw new Error('صيغة الإيصال غير مدعومة للطباعة: ' + ext);
    }
    const outBytes = await doc.save();
    const tmp = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, outBytes);
    fs.renameSync(tmp, out);
    prunePrintCache(dir, 400);
    return out;
  }

  // طباعة الإيصال عبر نافذة الطباعة الأصلية (اختيار الطابعة — ليست طباعة صامتة)
  ipcMain.handle('ftc2-receipts:print', async (evt, payload) => {
    let win = null;
    try {
      const rec = findReceipt(payload && payload.invoiceNo, payload && payload.clientId);
      if (!rec) return { ok: false, error: 'الإيصال غير موجود محلياً' };
      // نطبع نسخة معاد بناءها بمقاس مضبوط بدل الملف الأصلي (يمنع تأكّل الحروف عند الحواف)
      let printFile = rec.path;
      try { printFile = await prepareReceiptPrintPdf(rec.path, payload && payload.printOptions); } catch (e) {}
      win = new BrowserWindow({
        width: 900,
        height: 1000,
        title: 'طباعة إيصال ' + rec.invoiceNo,
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await win.loadFile(printFile);
      await new Promise(r => setTimeout(r, 1200));
      win.showInactive();
      return await new Promise(resolve => {
        let finished = false;
        const finish = (ok, error) => {
          if (finished) return;
          finished = true;
          try { if (win && !win.isDestroyed()) win.close(); } catch (e) {}
          resolve(ok ? { ok: true } : { ok: false, error: error || 'تعذّرت الطباعة' });
        };
        try {
          const opts = { silent: false, printBackground: true, margins: { marginType: 'none' } };
          const paper = normalizeReceiptPrintOptions(payload && payload.printOptions).paper;
          if (PRINT_PAPER_PT[paper]) opts.pageSize = paper;
          win.webContents.print(opts, (success, failureReason) => {
            if (success) finish(true);
            else if (/cancel/i.test(String(failureReason || ''))) finish(false, 'تم إلغاء الطباعة');
            else finish(false, failureReason || 'تعذّرت الطباعة');
          });
        } catch (e) { finish(false, String(e.message || e)); }
        setTimeout(() => finish(false, 'انتهت مهلة الطباعة'), 120000);
      });
    } catch (e) {
      try { if (win && !win.isDestroyed()) win.close(); } catch (e2) {}
      return { ok: false, error: String(e.message || e) };
    }
  });

  // معاينة نسخة الطباعة (نفس الملف الذي سيُرسل للطابعة) قبل حرق ورق
  ipcMain.handle('ftc2-receipts:preview-print', async (evt, payload) => {
    try {
      const rec = payload && payload.kind
        ? findReceiptForKind(payload.invoiceNo, payload.clientId, payload.kind)
        : findReceipt(payload && payload.invoiceNo, payload && payload.clientId);
      if (!rec) return { ok: false, error: 'الإيصال غير موجود محلياً' };
      const file = await prepareReceiptPrintPdf(rec.path, payload && payload.printOptions);
      const err = await shell.openPath(file);
      if (err) return { ok: false, error: err };
      return { ok: true, path: file };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // ── طباعة دفعة إيصالات (دورة/حقيبة) لعدة عملاء بضغطة واحدة ──
  // الطابعة تُختار مرة واحدة في الواجهة، ثم تُطبع الإيصالات تباعاً بلا أي نافذة إضافية.
  let _printBatchToken = 0;
  let _printBatchCanceled = false;

  async function _printReceiptSilent(rec, deviceName, copies, printOptions) {
    let win = null;
    try {
      // نطبع نسخة معاد بناءها بمقاس مضبوط (ورق + هامش أمان + نسبة الحجم)
      let printFile = rec.path;
      try { printFile = await prepareReceiptPrintPdf(rec.path, printOptions); } catch (e) {}
      win = new BrowserWindow({
        width: 900,
        height: 1000,
        show: false,
        title: 'طباعة إيصال ' + rec.invoiceNo,
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      await win.loadFile(printFile);
      await new Promise(r => setTimeout(r, 1200));
      const paper = normalizeReceiptPrintOptions(printOptions).paper;
      const base = { silent: true, printBackground: true, copies: Math.max(1, copies | 0) };
      const fullOpts = Object.assign({}, base, { margins: { marginType: 'none' } });
      if (PRINT_PAPER_PT[paper]) fullOpts.pageSize = paper;
      if (deviceName) fullOpts.deviceName = deviceName;
      const minimalOpts = Object.assign({}, base);
      if (deviceName) minimalOpts.deviceName = deviceName;

      const runPrint = opts => new Promise(resolve => {
        let finished = false;
        const finish = (ok, error) => {
          if (finished) return;
          finished = true;
          resolve(ok ? { ok: true } : { ok: false, error: error || 'تعذّرت الطباعة' });
        };
        try {
          win.webContents.print(opts, (success, failureReason) => {
            if (success) finish(true);
            else if (/cancel/i.test(String(failureReason || ''))) finish(false, 'تم إلغاء الطباعة');
            else finish(false, failureReason || 'تعذّرت الطباعة');
          });
        } catch (e) { finish(false, String(e.message || e)); }
        setTimeout(() => finish(false, 'انتهت مهلة الطباعة'), 90000);
      });

      const first = await runPrint(fullOpts);
      if (first.ok) return first;
      if (/إلغاء|cancel/i.test(String(first.error || ''))) return first;
      // بعض تعريفات الطابعات ترفض pageSize/margins — نعيد المحاولة بالإعدادات الافتراضية
      // (المحتوى مضبوط داخل الهامش مسبقاً فلا يتأكّل حتى مع هوامش الطابعة الافتراضية).
      const second = await runPrint(minimalOpts);
      if (!second.ok && first.error) second.error = second.error || first.error;
      return second;
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e2) {}
    }
  }

  // قائمة الطابعات المثبتة على الجهاز (تُعرض مرة واحدة قبل طباعة الدفعة)
  ipcMain.handle('ftc2-receipts:printers', async () => {
    try {
      const wc = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents : null;
      if (!wc) return { ok: false, error: 'لا توجد نافذة مفتوحة' };
      const list = await wc.getPrintersAsync();
      return {
        ok: true,
        printers: (Array.isArray(list) ? list : []).map(p => ({
          name: p.name,
          displayName: p.displayName || p.name,
          isDefault: !!p.isDefault,
          status: p.status,
        })),
      };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // معرفة أي إيصالات الدفعة محفوظ على الجهاز فعلاً (بلا طباعة)
  ipcMain.handle('ftc2-receipts:resolve-batch', async (evt, payload) => {
    try {
      scanReceiptsIndex(false);
      const items = Array.isArray(payload && payload.items) ? payload.items : [];
      const out = items.map(it => {
        const rec = findReceiptForKind(it && it.invoiceNo, it && it.clientId, it && it.kind);
        return Object.assign({}, it, { found: !!rec, fileName: rec ? rec.fileName : '' });
      });
      return { ok: true, items: out, found: out.filter(x => x.found).length, missing: out.filter(x => !x.found).length };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('ftc2-receipts:print-batch', async (evt, payload) => {
    const items = Array.isArray(payload && payload.items) ? payload.items : [];
    const deviceName = String((payload && payload.deviceName) || '').trim();
    const copies = Math.min(20, Math.max(1, Number(payload && payload.copies) || 1));
    const printOptions = normalizeReceiptPrintOptions(payload && payload.printOptions);
    if (!items.length) return { ok: false, error: 'لا توجد إيصالات للطباعة' };
    const token = ++_printBatchToken;
    _printBatchCanceled = false;
    const send = data => {
      try { if (evt.sender && !evt.sender.isDestroyed()) evt.sender.send('ftc2-receipts:print-batch-progress', data); } catch (e) {}
    };
    const printed = [], failed = [], missing = [];
    let canceled = false;
    for (let i = 0; i < items.length; i++) {
      if (_printBatchCanceled || token !== _printBatchToken) { canceled = true; break; }
      const it = items[i] || {};
      const rec = findReceiptForKind(it.invoiceNo, it.clientId, it.kind);
      if (!rec) {
        missing.push({ clientId: it.clientId, clientRecordId: it.clientRecordId, invoiceNo: it.invoiceNo, kind: it.kind, name: it.name || '' });
        send({ phase: 'missing', index: i + 1, total: items.length, invoiceNo: it.invoiceNo, kind: it.kind });
        continue;
      }
      send({ phase: 'printing', index: i + 1, total: items.length, invoiceNo: rec.invoiceNo, kind: rec.kind });
      const r = await _printReceiptSilent(rec, deviceName, copies, printOptions);
      if (r.ok) printed.push({ invoiceNo: rec.invoiceNo, kind: rec.kind, clientId: rec.clientId });
      else failed.push({ invoiceNo: rec.invoiceNo, kind: rec.kind, clientId: rec.clientId, error: r.error });
      send({ phase: r.ok ? 'printed' : 'failed', index: i + 1, total: items.length, invoiceNo: rec.invoiceNo, kind: rec.kind, error: r.error || '' });
    }
    return { ok: true, total: items.length, printed: printed.length, failed, missing, canceled, printOptions };
  });

  ipcMain.handle('ftc2-receipts:print-batch-cancel', async () => {
    _printBatchCanceled = true;
    _printBatchToken++;
    return { ok: true };
  });

  // مجلد الحفظ: قراءة/تغيير/العودة للافتراضي
  ipcMain.handle('ftc2-receipts:get-folder', async () => {
    const custom = readCustomReceiptsDir();
    return { ok: true, folder: custom, activeFolder: receiptsBaseDir(), defaultFolder: defaultReceiptsDir() };
  });

  ipcMain.handle('ftc2-receipts:select-folder', async () => {
    try {
      const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
      const openOpts = {
        title: 'اختر مجلد حفظ إيصالات أركان',
        properties: ['openDirectory', 'createDirectory'],
      };
      const r = owner ? await dialog.showOpenDialog(owner, openOpts) : await dialog.showOpenDialog(openOpts);
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
      const folder = r.filePaths[0];
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(receiptsFolderConfigPath(), JSON.stringify({ v: 1, folder }, null, 2), 'utf8');
      _receiptsIndexCache = null;
      scanReceiptsIndex(true);
      return { ok: true, folder, activeFolder: folder };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  ipcMain.handle('ftc2-receipts:clear-folder', async () => {
    try {
      const p = receiptsFolderConfigPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      _receiptsIndexCache = null;
      scanReceiptsIndex(true);
      return { ok: true, folder: '', activeFolder: defaultReceiptsDir() };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

// Google Drive Integration — وحدة النسخ الاحتياطي على Google Drive
// ══════════════════════════════════════════════════════════════
const GDRIVE_CONFIG_FILE = 'gdrive-config.json';
const GDRIVE_TOKEN_FILE = 'gdrive-token.json';

function gdriveConfigPath() {
  return path.join(app.getPath('userData'), GDRIVE_CONFIG_FILE);
}

function gdriveTokenPath() {
  return path.join(app.getPath('userData'), GDRIVE_TOKEN_FILE);
}

// ══════════════════════════════════════════════════════════════
// تخزين آمن للأسرار (clientSecret + توكنات Google Drive/Gmail)
// --------------------------------------------------------------
// كانت هذه الملفات تُكتب JSON صريحاً على القرص، وبداخلها refresh_token
// يمنح صلاحية gmail.send — أي نسخة عابرة للمجلد كانت تكفي للسيطرة على
// حساب Google. الآن تُشفَّر بـ safeStorage (DPAPI على ويندوز)، مع دعم
// قراءة الصيغة القديمة وترقيتها تلقائياً.
// ══════════════════════════════════════════════════════════════
function canEncryptSecrets() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch (e) { return false; }
}

function writeSecretFile(file, obj) {
  const json = JSON.stringify(obj);
  if (canEncryptSecrets()) {
    try {
      const data = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'safeStorage', data }), 'utf8');
      return;
    } catch (e) {
      console.error('[secrets] تعذّر تشفير ' + path.basename(file) + ': ' + ((e && e.message) || e));
    }
  }
  // احتياطي: base64 فقط (إخفاء لا تشفير) — حين يتعذّر تشفير النظام.
  console.error('[secrets] تحذير: ' + path.basename(file) + ' سيُحفظ بترميز base64 غير مشفّر');
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: 'base64', data: Buffer.from(json, 'utf8').toString('base64') }), 'utf8');
}

function readSecretFile(file, def) {
  try {
    if (!fs.existsSync(file)) return def;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return def;
    if (!raw.enc) return raw; // صيغة قديمة: كائن JSON صريح
    let json;
    if (raw.enc === 'safeStorage') {
      if (!canEncryptSecrets()) {
        console.error('[secrets] التشفير غير متاح حالياً — تعذّرت قراءة ' + path.basename(file));
        return def;
      }
      json = safeStorage.decryptString(Buffer.from(String(raw.data || ''), 'base64'));
    } else {
      json = Buffer.from(String(raw.data || ''), 'base64').toString('utf8');
    }
    return JSON.parse(json);
  } catch (e) {
    console.error('[secrets] تعذّرت قراءة ' + path.basename(file) + ': ' + ((e && e.message) || e));
    return def;
  }
}

// إعدادات تطبيق Google Cloud (يجب على المستخدم إدخالها من واجهة الإعدادات)
const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${PORT}/gdrive/callback`;

function loadGDriveConfig() {
  const cfg = readSecretFile(gdriveConfigPath(), null);
  if (cfg && typeof cfg === 'object') {
    return {
      clientId: String(cfg.clientId || ''),
      clientSecret: String(cfg.clientSecret || ''),
      redirectUri: String(cfg.redirectUri || DEFAULT_REDIRECT_URI),
    };
  }
  return { clientId: '', clientSecret: '', redirectUri: DEFAULT_REDIRECT_URI };
}

function saveGDriveConfig(config) {
  writeSecretFile(gdriveConfigPath(), config);
}

function loadGDriveTokens() {
  const tokens = readSecretFile(gdriveTokenPath(), null);
  return tokens && typeof tokens === 'object' ? tokens : null;
}

function saveGDriveTokens(tokens) {
  writeSecretFile(gdriveTokenPath(), tokens);
}

// ترقية الملفات القديمة غير المشفّرة عند الإقلاع (مرة واحدة).
function migratePlaintextSecrets() {
  for (const file of [gdriveConfigPath(), gdriveTokenPath()]) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && !raw.enc) {
        writeSecretFile(file, raw);
        console.error('[secrets] تم تشفير ' + path.basename(file) + ' (كان نصاً صريحاً)');
      }
    } catch (e) { /* ملف غير مقروء — يُعالج عند أول استخدام */ }
  }
}

function clearGDriveTokens() {
  try { fs.unlinkSync(gdriveTokenPath()); } catch (e) {}
}

// ميزة السيرفر المركزي أُلغيت نهائياً: البرنامج يعمل محلياً فقط، وكل طلبات
// /api/* تُخدَم من local-api.js حصراً. نُبعد أي إعداد قديم متبقٍّ حتى لا يظن
// أحد أنه ما زال فعّالاً (لا يوجد في الكود أي قارئ لهذا الملف بعد الآن).
function retireLegacyServerConfig() {
  try {
    const legacy = path.join(app.getPath('userData'), 'server-config.json');
    if (fs.existsSync(legacy)) {
      fs.renameSync(legacy, legacy.replace(/\.json$/, '') + '.json.disabled');
      console.error('[config] تم تعطيل server-config.json — البرنامج يعمل محلياً فقط');
    }
  } catch (e) { /* غير حرج */ }
}

// الحصول على Access Token صالح (تحديث تلقائي إذا انتهت صلاحيته)
async function getValidAccessToken() {
  const config = loadGDriveConfig();
  let tokens = loadGDriveTokens();
  
  if (!tokens || !tokens.refresh_token) {
    throw new Error('غير مصادق مع Google Drive — يرجى ربط الحساب من الإعدادات');
  }
  
  // التحقق من صلاحية التوكن
  const now = Date.now();
  if (tokens.expiry_date && tokens.expiry_date > now + 60000) {
    return tokens.access_token; // لا يزال صالحاً
  }
  
  // تحديث التوكن باستخدام Refresh Token
  const refreshParams = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshParams.toString(),
  });
  
  if (!response.ok) {
    const err = await response.text();
    clearGDriveTokens();
    throw new Error('فشل تحديث توكن Google Drive: ' + err);
  }
  
  const newTokens = await response.json();
  tokens = {
    ...tokens,
    access_token: newTokens.access_token,
    expiry_date: Date.now() + (newTokens.expires_in || 3600) * 1000,
  };
  saveGDriveTokens(tokens);
  return tokens.access_token;
}

// ══════════════════════════════════════════════════════════════
// حماية تدفق OAuth2 من login-CSRF
// كان الكود يولّد state ثم يتجاهله عند الرجوع، فأي كود مصادقة مسروق
// كان يمكن حقنه في جلسة المستخدم. الآن يُخزَّن مؤقتاً ويُتحقق منه مرة واحدة.
// ══════════════════════════════════════════════════════════════
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
let pendingOAuthState = null; // { value, expires }

function issueOAuthState() {
  pendingOAuthState = { value: crypto.randomBytes(16).toString('hex'), expires: Date.now() + OAUTH_STATE_TTL_MS };
  return pendingOAuthState.value;
}

// يقبل الطلب إن طابق الـ state، أو إن كانت هناك محاولة ربط جارية ولم يُرسل
// state (مسار لصق الكود يدوياً) — وفي الحالتين يُستهلك فلا يُعاد استخدامه.
function consumeOAuthState(provided) {
  const pending = pendingOAuthState;
  pendingOAuthState = null;
  if (!pending) return false;
  if (Date.now() > pending.expires) return false;
  if (provided == null || provided === '') return true;
  const got = String(provided);
  if (got.length !== pending.value.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(pending.value));
  } catch (e) {
    return false;
  }
}

// بدء تدفق OAuth2 — يفتح نافذة مصادقة في المتصفح
async function startGDriveAuth() {
  const config = loadGDriveConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error('بيانات اعتماد Google Cloud غير مضبوطة — أدخل Client ID و Client Secret في الإعدادات');
  }
  
  const state = issueOAuthState();
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  
  // فتح نافذة مصادقة في متصفح النظام
  shell.openExternal(authUrl);
  
  // انتظار الكود من callback (يتم التعامل معه عبر IPC من renderer)
  return { authUrl, state };
}

// معالجة رمز المصادقة المستلم من Google
async function handleGDriveCallback(code, state) {
  if (!consumeOAuthState(state)) {
    throw new Error('انتهت صلاحية جلسة الربط أو أن الطلب لا يخص هذا الجهاز — ابدأ الربط من جديد من الإعدادات');
  }
  const config = loadGDriveConfig();
  const tokenParams = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
  });
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل الحصول على التوكن: ' + err);
  }
  
  const tokens = await response.json();
  const tokenData = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope,
    token_type: tokens.token_type,
  };
  saveGDriveTokens(tokenData);
  return { success: true };
}

// رفع ملف إلى Google Drive
async function uploadToGDrive(fileName, fileContent, mimeType = 'application/json', folderId = null) {
  const accessToken = await getValidAccessToken();
  
  const metadata = {
    name: fileName,
    parents: folderId ? [folderId] : undefined,
  };
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([fileContent], { type: mimeType }));
  
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل رفع الملف: ' + err);
  }
  
  return await response.json();
}

// تحميل ملف من Google Drive
async function downloadFromGDrive(fileId) {
  const accessToken = await getValidAccessToken();
  
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل تحميل الملف: ' + err);
  }
  
  return await response.text();
}

// قائمة ملفات النسخ الاحتياطي في Google Drive
async function listGDriveBackups(folderId = null) {
  const accessToken = await getValidAccessToken();
  
  let query = "trashed=false and mimeType='application/json' and name contains 'نسخة_احتياطية'";
  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }
  
  const url = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q: query,
    fields: 'files(id,name,createdTime,size,modifiedTime)',
    orderBy: 'createdTime desc',
    pageSize: 50,
  }).toString();
  
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل جلب قائمة الملفات: ' + err);
  }
  
  const data = await response.json();
  return data.files || [];
}

// البحث عن مجلد النسخ الاحتياطي أو إنشاؤه
async function getOrCreateBackupFolder() {
  const accessToken = await getValidAccessToken();
  
  // البحث عن مجلد موجود
  const searchUrl = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q: "trashed=false and mimeType='application/vnd.google-apps.folder' and name='FTC2 Backups'",
    fields: 'files(id,name)',
  }).toString();
  
  let response = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل البحث عن المجلد: ' + err);
  }
  
  let data = await response.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  
  // إنشاء مجلد جديد
  const createResponse = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'FTC2 Backups',
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  
  if (!createResponse.ok) {
    const err = await createResponse.text();
    throw new Error('فشل إنشاء المجلد: ' + err);
  }
  
  const folder = await createResponse.json();
  return folder.id;
}

// حذف ملف من Google Drive
async function deleteFromGDrive(fileId) {
  const accessToken = await getValidAccessToken();
  
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  
  if (!response.ok) {
    const err = await response.text();
    throw new Error('فشل حذف الملف: ' + err);
  }
  
  return { success: true };
}

// التحقق من حالة الاتصال
async function checkGDriveConnection() {
  try {
    const accessToken = await getValidAccessToken();
    const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return { connected: false };
    const data = await response.json();
    return { connected: true, user: data.user };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

// هل يمنح التوكن الحالي صلاحية إرسال البريد (gmail.send)؟ تُمنح عند إعادة ربط الحساب.
function gdriveTokenHasMailScope() {
  const tokens = loadGDriveTokens();
  const scope = (tokens && tokens.scope) || '';
  return String(scope).indexOf('gmail.send') !== -1;
}

// اسم ملف بديل بالحروف اللاتينية (يُستخدم في ترويسة المرفق مع الاسم الأصلي بترميز RFC 2231).
function asciiFallbackFilename(name) {
  const s = String(name == null ? '' : name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_').trim();
  return s || 'attachment';
}
function rfc2231Filename(name) {
  return encodeURIComponent(String(name == null ? '' : name)).replace(/['()*!]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// تطبيع قائمة عناوين البريد: تقبل مصفوفة أو نصاً وترجع نصاً مفصولاً بفواصل.
// كان العنوان يُمرَّر كما هو إلى ترويسة To/Cc، فكان فاصل سطر واحد يكفي لحقن
// ترويسات إضافية (Bcc مثلاً) أو لتغيير جسم الرسالة.
const EMAIL_ADDRESS_RE = /^[^\s@,<>"'\\\r\n]+@[^\s@,<>"'\\\r\n]+\.[^\s@,<>"'\\\r\n]+$/;

function normalizeMailAddresses(value) {
  const arr = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const valid = [];
  const invalid = [];
  for (const item of arr) {
    const addr = String(item == null ? '' : item).replace(/[\r\n\t]/g, ' ').trim();
    if (!addr) continue;
    if (!EMAIL_ADDRESS_RE.test(addr)) { invalid.push(addr); continue; }
    valid.push(addr);
  }
  if (invalid.length) throw new Error('عنوان بريد غير صالح: ' + invalid.join(' , '));
  return valid.join(', ');
}

// بناء رسالة MIME (RFC 2822) جاهزة للإرسال عبر Gmail API — ترميز UTF-8 للعربية،
// مع دعم نسخة كربونية (Cc) ومرفقات (CSV/PDF) عبر multipart/mixed.
function buildRawMimeMessage({ to, subject, html, cc, attachments }) {
  const encodeHeader = (value) => '=?UTF-8?B?' + Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64') + '?=';
  const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');
  const toBase64 = (s) => Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
  const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const list = Array.isArray(attachments) ? attachments.filter((a) => a && a.base64) : [];

  const headerSafe = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  const headers = ['MIME-Version: 1.0', 'To: ' + headerSafe(to)];
  if (cc) headers.push('Cc: ' + headerSafe(cc));
  headers.push('Subject: ' + encodeHeader(subject));
  const htmlBody = wrap76(toBase64(html || ''));

  // بدون مرفقات: رسالة html بسيطة
  if (!list.length) {
    const message = headers.concat([
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]).join('\r\n') + '\r\n\r\n' + htmlBody;
    return b64url(message);
  }

  // مع مرفقات: multipart/mixed (جزء html + جزء لكل مرفق)
  const boundary = 'ftc2_' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  parts.push('--' + boundary + '\r\n' +
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    htmlBody + '\r\n');
  for (const a of list) {
    const type = String(a.type || 'application/octet-stream').replace(/[\r\n]/g, '').trim() || 'application/octet-stream';
    const name = String(a.name || 'attachment');
    const ascii = asciiFallbackFilename(name);
    parts.push('--' + boundary + '\r\n' +
      'Content-Type: ' + type + '; name="' + ascii + '"\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      'Content-Disposition: attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + rfc2231Filename(name) + '\r\n\r\n' +
      wrap76(String(a.base64).replace(/[\r\n]/g, '')) + '\r\n');
  }
  parts.push('--' + boundary + '--\r\n');
  const message = headers.concat([
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  ]).join('\r\n') + '\r\n\r\n' + parts.join('');
  return b64url(message);
}

// رسالة خطأ عربية واضحة لأخطاء Gmail API (تفعيل الخدمة، الصلاحيات، إلخ).
function gmailErrorMessage(errText) {
  const raw = String(errText || '');
  try {
    const parsed = JSON.parse(raw);
    const err = parsed && parsed.error;
    const details = (err && err.details) || [];
    const info = details.find((d) => d && d['@type'] && String(d['@type']).indexOf('ErrorInfo') !== -1);
    if (info && info.reason === 'SERVICE_DISABLED') {
      const url = (info.metadata && info.metadata.activationUrl) || 'https://console.developers.google.com/apis/api/gmail.googleapis.com';
      return 'خدمة Gmail API غير مفعّلة في مشروع Google Cloud الخاص بك — فعّلها مرة واحدة (وقد يستغرق التفعيل دقائق ثم أعد المحاولة) من الرابط: ' + url;
    }
    if (err && err.message) return 'فشل إرسال البريد: ' + err.message;
  } catch (e) { /* ليس JSON */ }
  return 'فشل إرسال البريد: ' + raw;
}

// إرسال بريد عبر Gmail API بنفس حساب Google المربوط (financeftc6@gmail.com مثلاً).
async function sendMailViaGmail({ to, subject, html, cc, attachments }) {
  if (!to) throw new Error('عنوان المستلم مطلوب');
  if (!gdriveTokenHasMailScope()) {
    throw new Error('صلاحية إرسال البريد غير ممنوحة — اضغط "تفعيل إرسال الإيميل" في الإعدادات لإعادة ربط حساب Google والموافقة على صلاحية الإرسال');
  }
  const accessToken = await getValidAccessToken();
  const raw = buildRawMimeMessage({ to, subject, html, cc, attachments });
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(gmailErrorMessage(errText));
  }
  return await response.json();
}

// ══════════════════════════════════════════════════════════════
// مسارات HTTP محلية لـ Google Drive — الواجهة تستدعيها مثل باقي الـ API
// ══════════════════════════════════════════════════════════════

function registerGDriveRoutes(srv) {
  const send = (res, code, payload) => {
    res.status(code).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json(payload);
  };
  const wrap = (fn) => async (req, res) => {
    try {
      const result = await fn(req);
      send(res, 200, Object.assign({ ok: true }, result || {}));
    } catch (e) {
      send(res, 200, { ok: false, error: (e && e.message) || String(e) });
    }
  };

  // الحصول على الإعدادات الحالية
  srv.get('/gdrive/config', wrap(async () => {
    const config = loadGDriveConfig();
    return { clientId: config.clientId, redirectUri: config.redirectUri, hasSecret: !!config.clientSecret };
  }));

  // حفظ الإعدادات
  srv.post('/gdrive/config', wrap(async (req) => {
    const body = req.body || {};
    const clientId = String(body.clientId || '').trim();
    const clientSecret = String(body.clientSecret || '').trim();
    if (!clientId) throw new Error('Client ID مطلوب');
    const config = loadGDriveConfig();
    config.clientId = clientId;
    // لو لم يُرسل سر جديد نحتفظ بالقديم (تعديل جزئي)
    if (clientSecret) config.clientSecret = clientSecret;
    if (!config.clientSecret) throw new Error('Client Secret مطلوب');
    saveGDriveConfig(config);
    return { saved: true };
  }));

  // بدء المصادقة (يفتح متصفح النظام)
  srv.post('/gdrive/auth/start', wrap(async () => {
    return await startGDriveAuth();
  }));

  // معالجة الكود يدوياً (لو نُسخ من عنوان إعادة التوجيه)
  srv.post('/gdrive/auth/callback', wrap(async (req) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    if (!code) throw new Error('كود المصادقة مطلوب');
    return await handleGDriveCallback(code, body.state);
  }));

  // حالة الاتصال
  srv.get('/gdrive/status', wrap(async () => {
    const config = loadGDriveConfig();
    const conn = await checkGDriveConnection();
    return { configured: !!(config.clientId && config.clientSecret), canSendMail: gdriveTokenHasMailScope(), ...conn };
  }));

  // قطع الاتصال
  srv.post('/gdrive/disconnect', wrap(async () => {
    clearGDriveTokens();
    return { disconnected: true };
  }));

  // رفع نسخة احتياطية (المحتوى يُرسل كنص JSON كامل)
  srv.post('/gdrive/backups', wrap(async (req) => {
    const body = req.body || {};
    const content = body.content;
    if (typeof content !== 'string' || !content) throw new Error('محتوى النسخة مطلوب');
    const folderId = await getOrCreateBackupFolder();
    let fileName = String(body.fileName || '').trim();
    if (!fileName) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fileName = `نسخة_احتياطية_كاملة_${stamp}.json`;
    }
    const file = await uploadToGDrive(fileName, content, 'application/json', folderId);
    return { file, folderId };
  }));

  // قائمة النسخ
  srv.get('/gdrive/backups', wrap(async () => {
    const folderId = await getOrCreateBackupFolder();
    const files = await listGDriveBackups(folderId);
    return { files, folderId };
  }));

  // تحميل نسخة
  srv.get('/gdrive/backups/:id', wrap(async (req) => {
    const content = await downloadFromGDrive(req.params.id);
    return { content };
  }));

  // حذف نسخة
  srv.delete('/gdrive/backups/:id', wrap(async (req) => {
    return await deleteFromGDrive(req.params.id);
  }));

  // إرسال بريد إلكتروني عبر حساب Gmail المربوط (يُستخدم للملخّص اليومي للتعديلات، وكل
  // تقارير/فواتير البرنامج، مع دعم مرفقات CSV/PDF ونسخة كربونية Cc).
  srv.post('/gdrive/send-mail', wrap(async (req) => {
    const body = req.body || {};
    const to = normalizeMailAddresses(body.to);
    const cc = normalizeMailAddresses(body.cc);
    const subject = String(body.subject || '(بدون عنوان)').trim();
    const html = String(body.html || '');
    if (!to) throw new Error('عنوان المستلم مطلوب');
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((a) => a && a.base64).map((a) => ({ name: a.name, type: a.type, base64: a.base64 }))
      : [];
    const result = await sendMailViaGmail({ to, cc, subject, html, attachments });
    return { sent: true, id: (result && result.id) || null };
  }));
}

// ------------------------------------------------------------------
// المسارات المحلية التي اعتادت الواجهة على استدعائها من السيرفر نفسه
// وليست جزءاً من /api — نرد عليها برفض مفهوم بدل ما يسقط التطبيق في خطأ 404.
// ------------------------------------------------------------------
function noInternet(reason) {
  return (req, res) => {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    res.status(503).json({ error: reason });
  };
}

// ------------------------------------------------------------------
// بروكسي شيتات جوجل (/gsheet-csv)
// الواجهة (gsheet-workflow.js) تبني رابط CSV من رابط الشيت ثم تطلبه من هذا
// المسار، لأن الجلب المباشر من المتصفح إلى docs.google.com يُحجب بقيود CORS.
// هذا المسار كان مُعطَّلاً بنص "غير متاح بدون إنترنت" (503) فكان الجلب يفشل
// دائماً حتى والحاسب متصل — الآن يُنفَّذ الجلب فعلياً من عملية Node نفسها.
// ------------------------------------------------------------------
function sanitizeGsheetUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    // قيد صارم حتى لا يتحوّل المسار إلى بروكسي مفتوح لأي عنوان (SSRF):
    // يُقبل فقط ما بناه toCsvUrl في الواجهة — docs.google.com + /spreadsheets/
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== 'docs.google.com') return null;
    if (!u.pathname.startsWith('/spreadsheets/')) return null;
    return u.toString();
  } catch (e) { return null; }
}

async function sendGsheetCsv(rawUrl, res) {
  const csvUrl = sanitizeGsheetUrl(rawUrl);
  if (!csvUrl) {
    res.status(400).json({ error: 'رابط غير صالح — المطلوب رابط Google Sheets يبدأ بـ https://docs.google.com/spreadsheets/' });
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch(csvUrl, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'text/csv,text/plain,*/*',
        'accept-language': 'ar,en;q=0.8'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.name === 'AbortError') ? 'انتهت مهلة الاتصال بجوجل (20 ثانية)' : ((e && e.message) || String(e));
    res.status(502).json({ error: 'تعذّر الوصول إلى جوجل: ' + msg });
    return;
  }
  clearTimeout(timer);

  const finalUrl = r.url || '';
  const needsLogin = /accounts\.google\.com|ServiceLogin/i.test(finalUrl);
  if (!r.ok || needsLogin) {
    const hint = needsLogin
      ? ' — الشيت غير متاح للقراءة العامة: من Google Sheets اختر ملف ← المشاركة ← نشر على الويب (أو اجعل الرابط متاحاً لأي شخص يملكه) ثم أعد المحاولة'
      : '';
    const status = r.ok ? 403 : (r.status >= 400 && r.status < 600 ? r.status : 502);
    res.status(status).json({ error: 'تعذّر جلب الشيت من جوجل — HTTP ' + r.status + hint });
    return;
  }

  const ctype = String(r.headers.get('content-type') || '');
  const text = await r.text();
  if (/text\/html/i.test(ctype)) {
    res.status(403).json({ error: 'أعادت جوجل صفحة HTML بدل ملف CSV — غالباً الشيت غير منشور أو غير مشترك: اختر "نشر على الويب" أو "أي شخص يملك الرابط" ثم أعد المحاولة' });
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(text);
}

// ------------------------------------------------------------------
// وكيل أركان (Chromium/Playwright) — مرفق بالكامل داخل الحزمة.
// يعمل في عملية Node منفصلة على 127.0.0.1:9955، وتُشغّله الواجهة عند الطلب.
// المتصفح (chromium headless shell) ومكتبة playwright مضمّنان في
// resources/agent-env، فلا حاجة لأي تنزيل وقت التشغيل.
// ------------------------------------------------------------------
const ARKKAN_AGENT_PORT = 9955;
const AGENT_FILES = ['arkkan-agent.js', 'arkkan-config.js', 'arkkan-logger.js', 'arkkan-utils.js', 'arkkan-sync.js'];

let arkkanChild = null;
let arkkanStopRequested = false;

function arkkanUserDir() {
  return path.join(app.getPath('userData'), 'arkkan-agent-files');
}

function arkkanBundledDir() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(process.resourcesPath);
  dirs.push(__dirname);
  for (const d of dirs) {
    for (const f of AGENT_FILES) {
      try { if (fs.existsSync(path.join(d, f))) return d; } catch (e) {}
    }
  }
  return null;
}

function arkkanBundledEnvDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'agent-env'));
  candidates.push(path.join(__dirname, 'agent-env'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'deps', 'playwright'))) return c;
    } catch (e) {}
  }
  return null;
}

function arkkanBrowsersDir() {
  const env = arkkanBundledEnvDir();
  if (!env) return null;
  const b = path.join(env, 'browsers');
  try { return fs.existsSync(b) ? b : null; } catch (e) { return null; }
}

let arkkanBundleUpdated = false;

async function arkkanEnsureUserBundle() {
  const userDir = arkkanUserDir();
  fs.mkdirSync(userDir, { recursive: true });
  const src = arkkanBundledDir();
  const updated = [];
  for (const f of AGENT_FILES) {
    const dest = path.join(userDir, f);
    let bundled = null;
    if (src) { try { bundled = fs.readFileSync(path.join(src, f)); } catch (e) {} }
    if (!bundled) continue;
    let current = null;
    try { current = fs.readFileSync(dest); } catch (e) {}
    // نُحدّث الملف لو النسخة المرفقة مختلفة (كان يُترك القديم للأبد فلا يصل أي إصلاح للوكيل)
    if (current && current.length === bundled.length && current.equals(bundled)) continue;
    try { fs.writeFileSync(dest, bundled); updated.push(f); } catch (e) {}
  }
  arkkanBundleUpdated = updated.length > 0;
  if (updated.length) console.log('[arkkan] تم تحديث ملفات الوكيل: ' + updated.join(', '));
  return userDir;
}

function arkkanPing(timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: ARKKAN_AGENT_PORT, path: '/ping', timeout: timeoutMs }, res => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
  });
}

function arkkanSpawnAgent(agentPath) {
  try {
    const envDir = arkkanBundledEnvDir();
    const browsers = arkkanBrowsersDir();
    const logFile = path.join(app.getPath('userData'), 'arkkan-agent.log');
    const logFd = fs.openSync(logFile, 'a');
    // نستخدم process.execPath (Electron نفسه) بوضع ELECTRON_RUN_AS_NODE لتشغيل
    // الوكيل دون الحاجة إلى تثبيت Node.js على جهاز المستخدم.
    const env = Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: path.join(envDir, 'deps')
    });
    if (browsers) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    const child = spawn(process.execPath, [agentPath], {
      cwd: arkkanUserDir(),
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    });
    try { fs.closeSync(logFd); } catch (e) {}
    child.unref();
    arkkanChild = child;
    arkkanStopRequested = false;
    child.on('exit', () => { arkkanChild = null; });
    child.on('error', () => { arkkanChild = null; });
    return { message: 'تم تشغيل وكيل أركان — سيبدأ العمل خلال لحظات' };
  } catch (e) {
    return { error: e.message };
  }
}

async function arkkanStartAgent() {
  const userDir = await arkkanEnsureUserBundle();
  const envDir = arkkanBundledEnvDir();
  if (!envDir) return { error: 'حزمة وكيل أركان غير مرفقة مع البرنامج' };
  if (!arkkanBrowsersDir()) return { error: 'متصفح Chromium غير مرفق مع البرنامج' };
  // لو حدّثنا ملفات الوكيل وهو يعمل، نعيد تشغيله ليعمل بالنسخة الجديدة فوراً.
  if (arkkanBundleUpdated && await arkkanPing()) {
    await arkkanRequestShutdown();
    if (await arkkanPing()) arkkanStopAgent();
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (!(await arkkanPing(400))) break;
    }
  }
  if (await arkkanPing()) return { message: 'وكيل أركان يعمل بالفعل', alreadyRunning: true };
  const agentPath = path.join(userDir, 'arkkan-agent.js');
  if (!fs.existsSync(agentPath)) return { error: 'ملف arkkan-agent.js غير موجود' };
  return arkkanSpawnAgent(agentPath);
}

function arkkanStopAgent() {
  arkkanStopRequested = true;
  if (arkkanChild && typeof arkkanChild.kill === 'function') {
    try { arkkanChild.kill(); } catch (e) {}
  }
  arkkanChild = null;
}

// إيقاف الوكيل عبر منفذه المحلي (يعمل حتى لو شُغّل في جلسة سابقة وليس ابناً لهذه العملية).
function arkkanRequestShutdown(timeoutMs = 4000) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      host: '127.0.0.1', port: ARKKAN_AGENT_PORT, path: '/shutdown', method: 'POST', timeout: timeoutMs,
    }, res => {
      res.on('data', () => {});
      res.on('end', () => finish(true));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
    req.end();
  });
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const srv = express();
    srv.disable('x-powered-by');

    // أول طبقة: رفض أي طلب لا يأتي من الواجهة نفسها (Host/Origin/Sec-Fetch-Site).
    srv.use(localRequestGuard);

    srv.use((req, res, next) => {
      if (req.path.includes('..')) return res.status(400).end();
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      next();
    });

    // ---- قراءة جسم الطلب JSON ----
    // الحدود صارت مقيّدة بكل مسار. كان هنا حد عام واحد بـ 512mb يسبق حد
    // local-api (12mb) فيجعله بلا أثر، فكان أي طلب كبير غير مصادَق قادراً
    // على استهلاك ذاكرة العملية الرئيسية بالكامل.
    srv.use('/gdrive', express.json({ limit: '512mb' })); // النسخ الاحتياطية الكاملة
    srv.use('/api', express.json({ limit: '12mb' }));     // مطابق لحد local-api

    // ---- Google Drive (نسخ احتياطي/استعادة) ----
    registerGDriveRoutes(srv);

    // ---- جلب شيتات جوجل (بروكسي يتجاوز CORS) ----
    srv.get('/gsheet-csv', (req, res) => {
      if (req.method === 'OPTIONS') { res.status(204).end(); return; }
      sendGsheetCsv(req.query.url, res).catch(e => {
        if (!res.headersSent) res.status(502).json({ error: 'تعذّر جلب الشيت: ' + ((e && e.message) || e) });
      });
    });
    srv.post('/gsheet-approve-notify', noInternet('مزامنة اعتماد العميل مع Google Sheets غير متاحة بدون إنترنت — ' + OFFLINE_STUB_MSG));
    srv.post('/arkkan-scrape', noInternet('سحب البيانات من منصة أركان غير متاح بدون إنترنت — ' + OFFLINE_STUB_MSG));
    srv.use('/arkkan', noInternet('الاتصال بمنصة أركان غير متاح بدون إنترنت'));

    // ---- وكيل أركان المحلي (Chromium مضمّن) ----
    srv.post('/arkkan-agent/start', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const result = await arkkanStartAgent();
      res.status(result.error ? 500 : 200).json(result);
    });
    srv.post('/arkkan-agent/autostart', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const result = await arkkanStartAgent();
      res.status(result.error ? 500 : 200).json(result);
    });
    srv.post('/arkkan-agent/stop', (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      arkkanStopAgent();
      res.json({ stopped: true });
    });
    srv.get('/arkkan-agent/status', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const running = await arkkanPing();
      res.json({ running, agentPath: 'arkkan-agent.js' });
    });

    // ---- عرض الإيصالات المحفوظة داخل شاشة المعاينة (نفس أصل البرنامج) ----
    // لا يُسمح بتمرير مسار ملف؛ البحث يتم عبر الفهرس فقط، ثم يُتحقق أن الملف
    // داخل مجلد الإيصالات فعلاً (منع Path Traversal).
    srv.get('/receipts-file', (req, res) => {
      try {
        const invoiceNo = String(req.query.invoice || '').trim();
        const clientId = String(req.query.clientId || '').trim();
        const courseNumber = String(req.query.course || '').trim();
        const rec = clientId
          ? findReceiptForClient({ clientId, invoiceNo, courseNumber })
          : findReceipt(invoiceNo);
        receiptFileResponse(res, rec);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
      }
    });

    // ---- واجهة الـ API المحلية بالكامل ----
    srv.use(createLocalApi({ dataDir }));

    // ---- Google Drive OAuth2 Callback Endpoint ----
    srv.get('/gdrive/callback', async (req, res) => {
      const { code, error, state } = req.query;
      if (error) {
        return res.send(`
          <!DOCTYPE html>
          <html dir="rtl" lang="ar">
          <head><meta charset="UTF-8"><title>خطأ في المصادقة</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1f2e;color:#fff;direction:rtl}.card{background:#232a3e;padding:2rem;border-radius:12px;max-width:400px;text-align:center}</style>
          </head>
          <body><div class="card"><h2>❌ فشل المصادقة</h2><p>${escapeHtml(error)}</p><button onclick="window.close()" style="margin-top:1rem;padding:.5rem 1rem;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer">إغلاق</button></div></body>
          </html>
        `);
      }
      if (!code) {
        return res.status(400).send('كود المصادقة مفقود');
      }
      try {
        await handleGDriveCallback(code, state);
        res.send(`
          <!DOCTYPE html>
          <html dir="rtl" lang="ar">
          <head><meta charset="UTF-8"><title>تم بنجاح</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1f2e;color:#fff;direction:rtl}.card{background:#232a3e;padding:2rem;border-radius:12px;max-width:400px;text-align:center}</style>
          </head>
          <body><div class="card"><h2>✅ تم ربط Google Drive بنجاح</h2><p>يمكنك الآن إغلاق هذه النافذة والعودة للبرنامج</p><button onclick="window.close()" style="margin-top:1rem;padding:.5rem 1rem;background:#22c55e;color:#fff;border:none;border-radius:6px;cursor:pointer">إغلاق النافذة</button></div></body>
          </html>
        `);
      } catch (e) {
        res.status(500).send(`
          <!DOCTYPE html>
          <html dir="rtl" lang="ar">
          <head><meta charset="UTF-8"><title>خطأ</title>
          <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1f2e;color:#fff;direction:rtl}.card{background:#232a3e;padding:2rem;border-radius:12px;max-width:400px;text-align:center}</style>
          </head>
          <body><div class="card"><h2>❌ خطأ</h2><p>${escapeHtml(e.message)}</p><button onclick="window.close()" style="margin-top:1rem;padding:.5rem 1rem;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer">إغلاق</button></div></body>
          </html>
        `);
      }
    });

    // ---- ملفات الواجهة ----
    const assetsDir = path.join(__dirname, 'app-assets');
    srv.use(express.static(assetsDir, { etag: false, lastModified: false, cacheControl: false }));
    srv.use((req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

    const listener = srv.listen(PORT, '127.0.0.1', () => resolve());
    listener.on('error', (err) => {
      dialog.showErrorBox(
        'تعذّر فتح البرنامج',
        err.code === 'EADDRINUSE'
          ? 'يبدو أن نسخة أخرى من البرنامج شغالة بالفعل. أغلقها من مدير المهام ثم أعد المحاولة.'
          : 'حدث خطأ غير متوقع: ' + err.message
      );
      app.quit();
      reject(err);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'FTC2 - برنامج إدارة المركز',
    icon: path.join(__dirname, 'app-assets', 'icons', 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: false,
      allowRunningInsecureContent: false,
      enableRemoteModule: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    if (process.env.FTC2_NO_MAXIMIZE !== '1') mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}/app.html`);
  if (process.env.FTC2_DEBUG === '1') mainWindow.webContents.openDevTools({ mode: 'right' });

  // منع أي انتقال في النافذة الرئيسية خارج البرنامج: الـ preload (وبالتالي
  // window.desktopAPI وكلمة المرور المحفوظة) يبقى محقوناً في أي صفحة تُحمَّل
  // في هذه النافذة، فكان رابط خارجي واحد كافياً لتسريب بيانات الدخول.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedLocalUrl(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('about:blank')) return { action: 'allow' };
    // فتح خارجي لبروتوكولات الويب فقط — لا file:// ولا معالجات بروتوكول أخرى.
    try {
      const u = new URL(url);
      if (EXTERNAL_SCHEMES.has(u.protocol)) shell.openExternal(url);
    } catch (e) { /* رابط غير صالح */ }
    return { action: 'deny' };
  });

  Menu.setApplicationMenu(null);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    dataDir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    retireLegacyServerConfig();

    registerLoginCredsIpc();
    registerReceiptsIpc();
    migratePlaintextSecrets();

    await startLocalServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((err) => {
    console.error('[startup] تعذّر بدء البرنامج:', err);
    dialog.showErrorBox('تعذّر بدء البرنامج', String((err && err.message) || err));
    app.quit();
  });

  app.on('window-all-closed', () => {
    arkkanStopAgent();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => arkkanStopAgent());
}
