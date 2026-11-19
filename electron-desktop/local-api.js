/*
 * FTC2 — خادم محلي بالكامل (بدون إنترنت إطلاقاً)
 * -------------------------------------------------------------
 * هذا الملف يعيد تنفيذ واجهة الـ API التي يحتاجها البرنامج (نفس العقود
 * والمسارات وأشكال JSON الخاصة بالسيرفر السحابي الأصلي) لكن البيانات كلها
 * تُخزَّن في ملفات JSON على قرص الجهاز نفسه داخل مجلد بيانات المستخدم،
 * فلا يوجد أي اتصال بشبكة Render أو أي سحابة أو إنترنت.
 *
 * أرقام النسخ (version) و آلية التعارض 409 مُعاد تنفيذها كما هي، حتى تعمل
 * كل طبقة المزامنة في الواجهة بلا أي تعديل.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_COLLECTIONS = [
  'bagStock', 'vaultTx', 'deletedVaultTx', 'vaultDenomTx', 'bankStatementRows',
  'deletedInvoices', 'courseSessions', 'auditLog', 'companies', 'companyTransfers',
  'journalEntries', 'chartOfAccounts', 'journalDE', 'budgetEntries', 'suppliers',
  'purchases', 'manualSalesInvoices', 'scheduledVaultTx', 'followUpTasks'
];
const APPROVAL_GATED = ['vaultTx', 'bagStock', 'courseSessions'];
const PRUNABLE = ['auditLog', 'deletedVaultTx', 'deletedInvoices'];
const VALID_ROLES = ['admin', 'accountant', 'reception', 'staff'];

const ALL_KNOWN_VIEWS = [
  'dashboard', 'clients', 'companies', 'courses', 'courseinvoices', 'vault',
  'settlements', 'bags', 'purchases', 'reports', 'accounting', 'ledger',
  'budget', 'audit', 'settings', 'arkkan-sync'
];
const DEFAULT_ROLE_PERMISSIONS = {
  staff: ['dashboard', 'clients', 'companies', 'courses', 'courseinvoices', 'vault', 'settlements', 'bags', 'purchases', 'reports'],
  accountant: ['dashboard', 'clients', 'vault', 'settlements', 'accounting', 'ledger', 'budget', 'reports', 'purchases', 'companies'],
  reception: ['clients']
};

const LIC_PREFIX = 'ftc2-local-storage-salt-v1';
const DEFAULT_ADMIN = { username: 'admin', password: '123456', displayName: 'مدير النظام' };

function nowIso() { return new Date().toISOString(); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function randomId() { return crypto.randomBytes(16).toString('hex'); }
function normalizeRole(r) { return VALID_ROLES.includes(r) ? r : 'staff'; }

module.exports = function createLocalApi(opts) {
  const dataDir = opts.dataDir;
  const recordsDir = path.join(dataDir, 'records');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });

  // ------------------------------------------------------------------
  // طبقة التخزين: ملف JSON لكل مخزن + كتابة ذرّية (temp -> fsync -> rename)
  // ------------------------------------------------------------------
  // مشاكل كانت هنا:
  //   * أي خطأ في قراءة ملف كان يُعيد {} بصمت، فتقلع النسخة بقاعدة فاضية
  //     وأول كتابة تطمس الملف التالف نهائياً (فقدان بيانات كامل بهدوء).
  //   * لا fsync قبل الـ rename، فانقطاع الكهرباء قد يُبقي ملفاً فارغاً.
  const corruptionWarnings = [];

  function preserveCorruptFile(file, reason) {
    const backup = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    try { fs.copyFileSync(file, backup); } catch (e) { /* لا شيء إضافي يمكن فعله */ }
    corruptionWarnings.push({
      file: path.basename(file),
      backup: path.basename(backup),
      reason: String(reason || ''),
      at: nowIso(),
    });
    console.error('[FTC2] ' + reason + ' — احتُفظ بنسخة من الملف في: ' + backup);
  }

  function readJson(file, def) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') preserveCorruptFile(file, 'تعذّرت قراءة الملف: ' + ((e && e.message) || e));
      return def;
    }
    if (!raw || !raw.trim()) return def;
    try {
      return JSON.parse(raw);
    } catch (e) {
      preserveCorruptFile(file, 'ملف بيانات تالف: ' + ((e && e.message) || e));
      return def;
    }
  }

  function writeJson(file, obj) {
    const tmp = file + '.tmp';
    const data = JSON.stringify(obj);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      try { fs.closeSync(fd); } catch (e) {}
    }
    fs.renameSync(tmp, file);
  }

  const F = {
    kv:        path.join(dataDir, 'kv.json'),
    clients:   path.join(dataDir, 'client-records.json'),
    users:     path.join(dataDir, 'users.json'),
    sessions:  path.join(dataDir, 'sessions.json'),
    backups:   path.join(dataDir, 'backups.json'),
    roles:     path.join(dataDir, 'role-permissions.json'),
    history:   path.join(dataDir, 'login-history.json'),
    license:   path.join(dataDir, 'license.json'),
  };
  const collFile = (c) => path.join(recordsDir, c + '.json');

  const db = {
    kv: readJson(F.kv, {}),
    clients: readJson(F.clients, {}),
    users: readJson(F.users, {}),
    sessions: readJson(F.sessions, {}),
    backups: readJson(F.backups, []),
    roles: readJson(F.roles, null),
    history: readJson(F.history, []),
    license: readJson(F.license, null),
  };

  // تهيئة أولية: مستخدم أدمن افتراضي + صلاحيات الأدوار الافتراضية
  if (!db.roles) { db.roles = JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMISSIONS)); writeJson(F.roles, db.roles); }
  if (!Object.keys(db.users).length) {
    db.users[DEFAULT_ADMIN.username] = makeUser(DEFAULT_ADMIN.username, DEFAULT_ADMIN.password, DEFAULT_ADMIN.displayName, 'admin', '');
    writeJson(F.users, db.users);
  }

  // كان المعرّف يُحسب بعدد المستخدمين، فتتكرر المعرّفات بعد أي حذف.
  function nextUserId() {
    let max = 0;
    for (const u of Object.values(db.users || {})) {
      const n = Number(u && u.id) || 0;
      if (n > max) max = n;
    }
    return max + 1;
  }

  function makeUser(username, password, displayName, role, email) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return {
      id: nextUserId(),
      username,
      display_name: displayName || username,
      role: normalizeRole(role),
      is_active: true,
      email: email || '',
      salt, hash,
      created_at: nowIso(),
      token_version: 0,
    };
  }

  const saveKv = () => writeJson(F.kv, db.kv);
  const saveClients = () => writeJson(F.clients, db.clients);
  const saveUsers = () => writeJson(F.users, db.users);
  const saveSessions = () => writeJson(F.sessions, db.sessions);
  const saveBackups = () => writeJson(F.backups, db.backups);

  // تحميل كل تصنيفات السجلات من القرص عند الإقلاع
  const collections = {};
  for (const c of ALLOWED_COLLECTIONS) collections[c] = readJson(collFile(c), {});
  const saveCollection = (c) => writeJson(collFile(c), collections[c] || {});

  // ------------------------------------------------------------------
  // بث الأحداث اللحظية (SSE) — نسخة محلية بسيطة
  // ------------------------------------------------------------------
  const sseClients = new Set(); // { res, username }
  function broadcast(collection, actorUsername) {
    const payload = JSON.stringify({ collection, ts: Date.now() });
    for (const c of sseClients) {
      if (actorUsername && c.username === actorUsername) continue;
      try { c.res.write(`event: record-changed\ndata: ${payload}\n\n`); } catch (e) { /* ignore */ }
    }
  }

  // ------------------------------------------------------------------
  // المصادقة
  // ------------------------------------------------------------------
  function verifyPassword(user, password) {
    try {
      const hash = crypto.scryptSync(String(password), user.salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
    } catch (e) { return false; }
  }
  // ══════════════════════════════════════════════════════════════
  // عمر الجلسة + حدّ محاولات الدخول
  // كان التوكن صالحاً إلى الأبد ومكتوباً على القرص بلا أي انتهاء، ولا يوجد
  // أي حد لمحاولات كلمة المرور — أي تسريب لملف sessions.json كان يعني
  // دخولاً دائماً، والملف كان يكبر بلا نهاية.
  // ══════════════════════════════════════════════════════════════
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يوماً
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_BLOCK_MS = 60 * 1000;
  const loginAttempts = new Map(); // username -> { fails, blockedUntil }

  function sessionIsLive(s) {
    return !!(s && Number.isFinite(s.created) && (Date.now() - s.created) < SESSION_TTL_MS);
  }

  function pruneExpiredSessions() {
    let changed = false;
    for (const [token, s] of Object.entries(db.sessions)) {
      if (!sessionIsLive(s)) { delete db.sessions[token]; changed = true; }
    }
    if (changed) saveSessions();
  }

  function loginBlockRemaining(username) {
    const a = loginAttempts.get(username);
    if (!a || !a.blockedUntil) return 0;
    const left = a.blockedUntil - Date.now();
    if (left <= 0) { loginAttempts.delete(username); return 0; }
    return left;
  }

  function noteLoginFailure(username) {
    const a = loginAttempts.get(username) || { fails: 0, blockedUntil: 0 };
    a.fails += 1;
    if (a.fails >= LOGIN_MAX_FAILS) {
      const factor = Math.min(4, Math.floor(a.fails / LOGIN_MAX_FAILS) - 1);
      a.blockedUntil = Date.now() + LOGIN_BLOCK_MS * Math.pow(2, Math.max(0, factor));
    }
    loginAttempts.set(username, a);
  }

  function createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = { username: user.username, role: user.role, tv: user.token_version || 0, created: Date.now() };
    saveSessions();
    return token;
  }
  function currentAuth(req) {
    let token = null;
    const h = req.headers['authorization'] || '';
    if (h.startsWith('Bearer ')) token = h.slice(7);
    if (!token && req.query && req.query.token) token = String(req.query.token);
    if (!token) return null;
    const s = db.sessions[token];
    if (!s) return null;
    if (!sessionIsLive(s)) {
      delete db.sessions[token];
      saveSessions();
      return null;
    }
    const user = db.users[s.username];
    if (!user || user.is_active === false) return null;
    if ((user.token_version || 0) !== (s.tv || 0)) return null;
    return { token, username: user.username, role: normalizeRole(user.role), user };
  }
  function requireAuth(req, res, next) {
    const a = currentAuth(req);
    if (!a) return res.status(401).json({ error: 'غير مصرَّح — يرجى تسجيل الدخول' });
    req.auth = a;
    next();
  }
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.auth) return res.status(401).json({ error: 'غير مصرَّح — يرجى تسجيل الدخول' });
      if (!roles.includes(req.auth.role)) return res.status(403).json({ error: 'ليست لديك صلاحية كافية لهذا الإجراء' });
      next();
    };
  }
  function logLogin(username, role, ip, success) {
    db.history.push({ username, role, ip_address: ip || '127.0.0.1', device_info: 'تطبيق سطح المكتب', logged_in_at: nowIso(), success: !!success });
    if (db.history.length > 1500) db.history = db.history.slice(-1000);
    writeJson(F.history, db.history);
  }

  // تنظيف الجلسات المنتهية مرة عند الإقلاع.
  pruneExpiredSessions();

  // ------------------------------------------------------------------
  // صلاحيات الوصول لمفاتيح kv (مطابقة لخادم النسخة السحابية)
  // ------------------------------------------------------------------
  // مطابقة RESTRICTED_STORAGE_KEYS في الخادم الأصلي: null ⇐ للأدمن فقط.
  const RESTRICTED_STORAGE_KEYS = {
    users: null,
    zakatAdjustments: null,
    companyTransfers: 'companies',
    journalEntries: 'accounting',
    chartOfAccounts: 'ledger',
    journalDE: 'ledger',
    manualSalesInvoices: 'accounting',
    budgetEntries: 'budget',
    suppliers: 'purchases',
    vaultDenomTx: 'vault',
    bankStatementRows: 'vault',
    auditLog: 'audit',
  };
  const RESTRICTED_STAFF_VIEWS = ['settings', 'audit', 'accounting', 'ledger', 'budget'];
  function roleViews(role) {
    if (role === 'admin') return ALL_KNOWN_VIEWS.slice();
    return db.roles[role] || [];
  }
  function roleCanAccessView(role, view) {
    if (role === 'admin') return true;
    const allow = db.roles[role];
    if (Array.isArray(allow)) return allow.includes(view);
    return !RESTRICTED_STAFF_VIEWS.includes(view);
  }
  // قاعدة restrictKeyToAdmin في الخادم: قراءة/كتابة مفتاح kv مقيّدة.
  function canReadOrWriteKey(role, key) {
    if (role === 'admin') return true;
    if (key === 'clients') return role !== 'reception';
    if (!(key in RESTRICTED_STORAGE_KEYS)) return true;
    const view = RESTRICTED_STORAGE_KEYS[key];
    return view === null ? false : roleCanAccessView(role, view);
  }
  // قاعدة storage-versions/records-versions: RESTRICTED_STORAGE_KEYS فقط،
  // بلا قاعدة 'clients' الخاصة (تطبق على GET/PUT فقط في الخادم).
  function canSeeKeyVersion(role, key) {
    if (!(key in RESTRICTED_STORAGE_KEYS)) return true;
    const view = RESTRICTED_STORAGE_KEYS[key];
    return view === null ? role === 'admin' : roleCanAccessView(role, view);
  }
  // collectionRoleAllowed: التصنيفات المقيّدة هي فقط تلك الموجودة في
  // RESTRICTED_STORAGE_KEYS — أي تصنيف آخر متاح لكل الأدوار (الرؤية يحددها
  // recordsVisibilitySql لاحقاً، وليس صلاحية الشاشة).
  function collectionRoleAllowed(role, collection) {
    return canSeeKeyVersion(role, collection);
  }
  function canAccessCollection(role, collection) {
    return collectionRoleAllowed(role, collection);
  }

  // ------------------------------------------------------------------
  // فلترة الرؤية (نفس منطق الخادم): admin يرى الكل، reception يرى سجلاته
  // فقط، staff/accountant يرى المعتمد فقط.
  // ------------------------------------------------------------------
  function visibleRecords(list, role, username) {
    if (role === 'admin') return list;
    if (role === 'reception') {
      return list.filter(r => r.origin === 'reception' && r.created_by === username);
    }
    return list.filter(r => r.status === 'confirmed');
  }

  // ------------------------------------------------------------------
  // الراوتر
  // ------------------------------------------------------------------
  const router = express.Router();
  const json = express.json({ limit: '12mb' });
  router.use(json);

  // ===================== الترخيص =====================
  router.post('/api/license/validate', (req, res) => {
    const raw = String((req.body && req.body.licenseKey) || '').trim();
    const normalized = raw.replace(/[\s-]/g, '').toUpperCase();
    if (!normalized) return res.status(200).json({ valid: false, reason: 'كود الترخيص مطلوب' });

    if (!db.license) {
      const encKey = crypto.pbkdf2Sync(normalized, LIC_PREFIX, 150000, 32, 'sha256').toString('base64');
      db.license = { key: normalized, encKey, clientId: 'LOCAL-' + sha256hex(normalized).slice(0, 12).toUpperCase(), createdAt: nowIso() };
      writeJson(F.license, db.license);
    } else if (db.license.key !== normalized) {
      return res.status(200).json({
        valid: false,
        expired: false,
        clientId: null,
        reason: 'كود الترخيص لا يطابق الترخيص المُفعَّل على هذا الجهاز — أدخل نفس الكود الأصلي',
      });
    }
    res.status(200).json({
      valid: true,
      encKey: db.license.encKey,
      expiryDate: null,
      clientId: db.license.clientId,
    });
  });

  // ===================== المصادقة =====================
  router.post('/api/auth/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');

    const waitMs = loginBlockRemaining(username);
    if (waitMs > 0) {
      logLogin(username, null, req.ip, false);
      res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({ error: 'محاولات دخول كثيرة على هذا الحساب — أعد المحاولة بعد ' + Math.ceil(waitMs / 1000) + ' ثانية' });
    }

    const user = db.users[username];
    if (!user) {
      noteLoginFailure(username);
      logLogin(username, null, req.ip, false);
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    }
    if (!verifyPassword(user, password)) {
      noteLoginFailure(username);
      logLogin(username, user.role, req.ip, false);
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    loginAttempts.delete(username);
    const token = createSession(user);
    logLogin(user.username, user.role, req.ip, true);
    res.json({
      token,
      username: user.username,
      role: normalizeRole(user.role),
      user: { username: user.username, displayName: user.display_name || user.username, role: normalizeRole(user.role) },
      suspiciousAlert: [],
      lastLogin: null,
      newDeviceAlert: false,
      geoAlert: null,
    });
  });

  router.post('/api/auth/logout', requireAuth, (req, res) => {
    // إبطال الجلسة (كل جلسات هذا المستخدم ليست ضرورية — جلسة الجهاز الحالي فقط)
    delete db.sessions[req.auth.token];
    saveSessions();
    res.json({ ok: true });
  });

  // WebAuthn / QR — غير متاحة في النسخة المحلية (تحتاج أجهزة أخرى)
  router.post('/api/auth/webauthn/register-options', requireAuth, (req, res) =>
    res.status(400).json({ error: 'الدخول بالبصمة غير متاح في النسخة المحلية' }));
  router.post('/api/auth/webauthn/register-verify', requireAuth, (req, res) =>
    res.status(400).json({ error: 'الدخول بالبصمة غير متاح في النسخة المحلية' }));
  router.get('/api/auth/webauthn/credentials', requireAuth, (req, res) => res.json({ credentials: [] }));
  router.delete('/api/auth/webauthn/credentials/:id', requireAuth, (req, res) => res.json({ ok: true }));
  router.post('/api/auth/webauthn/login-options', (req, res) =>
    res.status(400).json({ error: 'الدخول بالبصمة غير متاح في النسخة المحلية' }));
  router.post('/api/auth/webauthn/login-verify', (req, res) =>
    res.status(401).json({ error: 'الدخول بالبصمة غير متاح في النسخة المحلية' }));
  router.post('/api/auth/webauthn/login-2fa', (req, res) =>
    res.status(401).json({ error: 'الدخول بالبصمة غير متاح في النسخة المحلية' }));

  router.post('/api/auth/qr-login/create', (req, res) =>
    res.status(400).json({ error: 'الدخول بمسح الكود غير متاح في النسخة المحلية' }));
  router.get('/api/auth/qr-login/status/:id', (req, res) => res.json({ status: 'expired' }));
  router.get('/api/auth/qr-login/info/:id', requireAuth, (req, res) => res.status(404).json({ error: 'الجلسة غير موجودة' }));
  router.post('/api/auth/qr-login/approve/:id', requireAuth, (req, res) => res.status(404).json({ error: 'الجلسة غير موجودة' }));
  router.post('/api/auth/qr-login/reject/:id', requireAuth, (req, res) => res.status(404).json({ error: 'الجلسة غير موجودة' }));

  // المصادقة الثنائية — غير متاحة محلياً
  router.get('/api/2fa/status', requireAuth, (req, res) => res.json({ enabled: false }));
  router.post('/api/2fa/setup', requireAuth, (req, res) =>
    res.status(400).json({ error: 'المصادقة الثنائية غير متاحة في النسخة المحلية' }));
  router.post('/api/2fa/verify-setup', requireAuth, (req, res) =>
    res.status(400).json({ error: 'المصادقة الثنائية غير متاحة في النسخة المحلية' }));
  router.post('/api/2fa/disable', requireAuth, (req, res) => res.json({ enabled: false }));

  // ===================== المستخدمون =====================
  router.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
    const users = Object.values(db.users).map(u => ({
      id: u.id, username: u.username, display_name: u.display_name, role: u.role,
      is_active: u.is_active !== false, email: u.email || '', created_at: u.created_at,
    }));
    res.json({ users });
  });
  router.get('/api/users/reception', requireAuth, requireRole('admin', 'accountant'), (req, res) => {
    const users = Object.values(db.users)
      .filter(u => normalizeRole(u.role) === 'reception')
      .map(u => ({ username: u.username, display_name: u.display_name }));
    res.json({ users });
  });
  router.post('/api/users', requireAuth, requireRole('admin'), (req, res) => {
    const b = req.body || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    const displayName = String(b.displayName || b.display_name || username);
    const role = normalizeRole(b.role);
    const email = String(b.email || '');
    if (!username || password.length < 6) {
      return res.status(400).json({ error: 'اسم المستخدم مطلوب وكلمة المرور 6 أحرف على الأقل' });
    }
    const existing = db.users[username];
    const user = existing
      ? Object.assign(existing, { display_name: displayName, role, email, is_active: true })
      : makeUser(username, password, displayName, role, email);
    if (existing) {
      const salt = crypto.randomBytes(16).toString('hex');
      user.salt = salt;
      user.hash = crypto.scryptSync(password, salt, 64).toString('hex');
      user.token_version = (user.token_version || 0) + 1;
    }
    user.id = user.id || nextUserId();
    db.users[username] = user;
    saveUsers();
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, email: user.email, created_at: user.created_at } });
  });
  router.delete('/api/users/:username', requireAuth, requireRole('admin'), (req, res) => {
    const username = req.params.username;
    if (username === req.auth.username) return res.status(400).json({ error: 'لا يمكن حذف حسابك الحالي' });
    if (!db.users[username]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    delete db.users[username];
    for (const [t, s] of Object.entries(db.sessions)) { if (s.username === username) delete db.sessions[t]; }
    saveUsers(); saveSessions();
    res.json({ username, deleted: true });
  });
  router.post('/api/users/:username/toggle-active', requireAuth, requireRole('admin'), (req, res) => {
    const username = req.params.username;
    if (username === req.auth.username) return res.status(400).json({ error: 'لا يمكن تعطيل حسابك الحالي' });
    const user = db.users[username];
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    user.is_active = user.is_active === false;
    if (!user.is_active) { for (const [t, s] of Object.entries(db.sessions)) { if (s.username === username) delete db.sessions[t]; } }
    saveUsers(); saveSessions();
    res.json({ username, isActive: user.is_active });
  });
  router.post('/api/users/:username/force-logout', requireAuth, requireRole('admin'), (req, res) => {
    const username = req.params.username;
    if (!db.users[username]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    for (const [t, s] of Object.entries(db.sessions)) { if (s.username === username) delete db.sessions[t]; }
    saveSessions();
    res.json({ username, loggedOut: true });
  });
  router.get('/api/login-history', requireAuth, requireRole('admin'), (req, res) => {
    const history = db.history.slice(-300).reverse();
    res.json({ history, suspiciousActivity: [] });
  });

  // ===================== صلاحيات الأدوار =====================
  router.get('/api/role-permissions', requireAuth, requireRole('admin'), (req, res) => {
    res.json({ rolePermissions: db.roles });
  });
  router.put('/api/role-permissions', requireAuth, requireRole('admin'), (req, res) => {
    const rp = (req.body && req.body.rolePermissions) || req.body || {};
    const clean = {};
    for (const role of ['staff', 'accountant', 'reception']) {
      const list = Array.isArray(rp[role]) ? rp[role].filter(v => ALL_KNOWN_VIEWS.includes(v)) : [];
      clean[role] = list;
    }
    db.roles = clean;
    writeJson(F.roles, db.roles);
    res.json({ rolePermissions: db.roles });
  });

  // ===================== مخزن المفاتيح (KV) =====================
  router.get('/api/storage-versions', requireAuth, (req, res) => {
    const versions = {};
    for (const [k, v] of Object.entries(db.kv)) {
      if (canSeeKeyVersion(req.auth.role, k)) versions[k] = v.version || 0;
    }
    res.json({ versions });
  });

  router.get('/api/storage', requireAuth, (req, res) => {
    const prefix = String(req.query.prefix || '');
    // الخادم لا يقيّد قائمة المفاتيح بالصلاحيات — الفلترة تتم عند القراءة الفعلية.
    const keys = Object.keys(db.kv).filter(k => k.startsWith(prefix));
    res.json({ keys });
  });

  router.get('/api/storage/:key', requireAuth, (req, res) => {
    const key = req.params.key;
    if (!canReadOrWriteKey(req.auth.role, key)) return res.status(403).json({ error: 'ليست لديك صلاحية كافية للوصول لهذه البيانات' });
    const entry = db.kv[key];
    if (req.query.meta) {
      return res.json({ key, version: entry ? entry.version : 0 });
    }
    if (!entry) {
      return res.json({ key, value: null, version: 0 });
    }
    if (req.headers['if-none-match'] && Number(req.headers['if-none-match']) === entry.version) {
      return res.status(304).end();
    }
    res.setHeader('ETag', String(entry.version));
    res.json({ key, value: entry.value, version: entry.version });
  });

  router.put('/api/storage/:key', requireAuth, (req, res) => {
    const key = req.params.key;
    if (!canReadOrWriteKey(req.auth.role, key)) return res.status(403).json({ error: 'ليست لديك صلاحية كافية للوصول للبيانات' });
    const value = req.body ? req.body.value : undefined;
    const version = req.body && typeof req.body.version === 'number' ? req.body.version : 0;
    if (typeof value !== 'string' || !value) {
      return res.status(400).json({ error: 'قيمة غير صالحة' });
    }
    const entry = db.kv[key];
    if (entry && entry.version !== version) {
      return res.status(409).json({ error: 'تعارض: تم تعديل هذه البيانات من جلسة أخرى — يرجى تحديث الصفحة', currentVersion: entry.version });
    }
    const newVersion = (entry ? entry.version : 0) + 1;
    db.kv[key] = { value, version: newVersion };
    saveKv();
    broadcast('kv:' + key, req.auth.username);
    res.json({ key, version: newVersion });
  });

  router.delete('/api/storage/:key', requireAuth, requireRole('admin'), (req, res) => {
    const key = req.params.key;
    delete db.kv[key];
    saveKv();
    broadcast('kv:' + key, req.auth.username);
    res.json({ key, deleted: true });
  });

  // ===================== السجلات العامة (collection records) =====================
  // requireValidCollection في الخادم: اسم تصنيف غير معروف ⇐ 400، والتصنيف
  // المقيّد غير المتاح لهذا الدور ⇐ 403.
  function checkCollection(req, res) {
    const c = req.params.collection;
    if (!ALLOWED_COLLECTIONS.includes(c)) {
      res.status(400).json({ error: 'اسم تصنيف بيانات غير صحيح' });
      return false;
    }
    if (!canAccessCollection(req.auth.role, c)) {
      res.status(403).json({ error: 'لا تملك صلاحية الوصول لهذا التصنيف' });
      return false;
    }
    return true;
  }

  router.get('/api/records-versions', requireAuth, (req, res) => {
    const versions = {};
    for (const c of ALLOWED_COLLECTIONS) {
      if (!canAccessCollection(req.auth.role, c)) continue;
      const list = visibleRecords(Object.values(collections[c] || {}), req.auth.role, req.auth.username);
      if (!list.length) continue;
      let sum = 0;
      for (const r of list) sum += (r.version || 0);
      versions[c] = { version: sum, count: list.length };
    }
    res.json({ versions });
  });

  router.get('/api/records/pending', requireAuth, requireRole('admin'), (req, res) => {
    const out = [];
    for (const c of ALLOWED_COLLECTIONS) {
      for (const r of Object.values(collections[c] || {})) {
        if (r.status === 'pending' && r.origin === 'reception') out.push({ collection: c, id: r.id, enc: r.enc, version: r.version, origin: r.origin, status: r.status, created_by: r.created_by, updated_by: r.updated_by, updated_at: r.updated_at });
      }
    }
    // سجلات العملاء المعلّقة لا تظهر هنا (مطابق للخادم) — تُعرض داخل شاشة العملاء
    // نفسها عبر clientRecordMeta، فتُستبعد من لوحة العمليات قيد الاعتماد.
    res.json({ records: out });
  });

  router.get('/api/records/:collection/versions', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    const list = visibleRecords(Object.values(collections[collection] || {}), req.auth.role, req.auth.username);
    res.json({ pairs: list.map(r => [r.id, r.version]) });
  });

  router.get('/api/records/:collection', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    let list = visibleRecords(Object.values(collections[collection] || {}), req.auth.role, req.auth.username);
    if (req.query.ids) {
      const ids = new Set(String(req.query.ids).split(',').filter(Boolean));
      list = list.filter(r => ids.has(r.id));
    } else if (req.query.page) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 200));
      list = list.slice((page - 1) * pageSize, page * pageSize);
    }
    res.json({ records: list.map(r => ({ id: r.id, enc: r.enc, version: r.version, origin: r.origin, status: r.status })) });
  });

  router.get('/api/records/:collection/:id', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    const r = (collections[collection] || {})[req.params.id];
    if (!r) return res.status(404).json({ error: 'لا يوجد سجل بهذا المعرّف' });
    if (!visibleRecords([r], req.auth.role, req.auth.username).length) return res.status(404).json({ error: 'لا يوجد سجل بهذا المعرّف' });
    res.json({ id: r.id, enc: r.enc, version: r.version, origin: r.origin, status: r.status });
  });

  function putRecord(store, collection, id, body, auth, save) {
    const enc = body ? body.enc : undefined;
    // نسخة مفقودة على سجل قائم = 0 ← تعارض 409، فلا كتابة صامتة فوق جلسة أخرى.
    const version = body && typeof body.version === 'number' ? body.version : 0;
    if (typeof enc !== 'string' || !enc) return { status: 400, json: { error: 'قيمة مشفّرة غير صالحة' } };
    const existing = store[id];
    // حارس الصلاحية على السجل القائم (مطابق للخادم): admin الكل، reception سجلاته
    // فقط، وغير admin/reception يعدّل المعتمد فقط.
    if (existing && auth.role !== 'admin') {
      if (auth.role === 'reception') {
        if (!(existing.origin === 'reception' && existing.created_by === auth.username)) {
          return { status: 403, json: { error: 'ليس لديك صلاحية تعديل هذا السجل' } };
        }
      } else if (existing.status !== 'confirmed') {
        return { status: 403, json: { error: 'لا يمكن تعديل سجل غير معتمد' } };
      }
    }
    if (existing && existing.version !== version) {
      return { status: 409, json: { error: 'تعارض: تم تعديل هذه البيانات من جلسة أخرى', currentVersion: existing.version, currentEnc: existing.enc } };
    }
    const rec = existing || { id, version: 0, created_by: auth.username, created_at: nowIso() };
    rec.enc = enc;
    // السجل الجديد يُدرج دائماً بالنسخة 1 (مطابق للخادم)، والقائم يتزايد.
    rec.version = existing ? (existing.version || 0) + 1 : 1;
    rec.updated_by = auth.username;
    rec.updated_at = nowIso();
    if (body && typeof body.clientId === 'string') rec.clientId = body.clientId;
    // origin/status يُضبطان مرة واحدة فقط عند الإنشاء (ON CONFLICT لا يعدّلهما).
    if (!existing) {
      if (collection === 'clients') {
        rec.origin = auth.role === 'reception' ? 'reception' : 'general';
        rec.status = auth.role === 'reception' ? 'pending' : 'confirmed';
      } else if (auth.role === 'reception' && APPROVAL_GATED.includes(collection)) {
        rec.origin = 'reception';
        rec.status = 'pending';
      } else if (auth.role === 'reception') {
        rec.origin = 'reception';
        rec.status = 'confirmed';
      } else {
        rec.origin = 'general';
        rec.status = 'confirmed';
      }
    }
    store[id] = rec;
    save();
    return { status: 200, json: { id, version: rec.version, origin: rec.origin, status: rec.status } };
  }

  router.put('/api/records/:collection/:id', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    if (!collections[collection]) collections[collection] = {};
    const out = putRecord(collections[collection], collection, req.params.id, req.body || {}, req.auth, () => saveCollection(collection));
    if (out.status === 200) broadcast(collection, req.auth.username);
    res.status(out.status).json(out.json);
  });

  function canTouchRecord(rec, auth) {
    if (auth.role === 'admin') return true;
    if (auth.role === 'reception') return rec.origin === 'reception' && rec.created_by === auth.username;
    return rec.status === 'confirmed';
  }

  router.delete('/api/records/:collection/:id', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    const store = collections[collection] || {};
    const r = store[req.params.id];
    if (!r) return res.json({ id: req.params.id, deleted: true });
    if (!canTouchRecord(r, req.auth)) return res.status(403).json({ error: 'ليس لديك صلاحية حذف هذا السجل' });
    if (req.query.version !== undefined && Number(req.query.version) !== r.version) {
      return res.status(409).json({ error: 'تعارض: تم تعديل هذه البيانات من جلسة أخرى', currentVersion: r.version });
    }
    delete store[req.params.id];
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ id: req.params.id, deleted: true });
  });

  router.post('/api/records/:collection/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
    const collection = req.params.collection;
    const store = collections[collection] || {};
    const r = store[req.params.id];
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    r.status = 'confirmed';
    r.version = (r.version || 0) + 1;
    r.updated_by = req.auth.username;
    r.updated_at = nowIso();
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ id: r.id, version: r.version, status: 'confirmed' });
  });

  router.post('/api/records/:collection/bulk-migrate', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    const records = (req.body && req.body.records) || [];
    if (!Array.isArray(records) || !records.length || records.length > 5000) {
      return res.status(400).json({ error: 'عدد السجلات غير صالح' });
    }
    if (!collections[collection]) collections[collection] = {};
    let migrated = 0;
    const conflicts = [];
    for (const item of records) {
      if (!item || !item.id || typeof item.enc !== 'string' || !item.enc) {
        return res.status(400).json({ error: 'سجل غير صالح داخل الدفعة' });
      }
      const out = putRecord(collections[collection], collection, item.id, item, req.auth, () => {});
      if (out.status === 200) migrated++;
      else if (out.status === 409) { item.enc = null; conflicts.push({ id: item.id, currentVersion: out.json.currentVersion, currentEnc: out.json.currentEnc }); }
      else return res.status(out.status).json(out.json);
      if (item.enc === null) delete item.enc;
    }
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ migrated, conflicts });
  });

  router.post('/api/records/:collection/bulk-delete', requireAuth, (req, res) => {
    const collection = req.params.collection;
    if (!checkCollection(req, res)) return;
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) return res.status(400).json({ error: 'قائمة المعرّفات غير صالحة' });
    const store = collections[collection] || {};
    let deleted = 0;
    let skipped = 0;
    for (const id of ids) {
      const rec = store[id];
      if (!rec) continue;
      // الحذف الجماعي كان يتخطى فحص الصلاحية الموجود في الحذف المفرد،
      // فكان أي دور قادراً على محو أي سجل داخل التصنيف.
      if (!canTouchRecord(rec, req.auth)) { skipped++; continue; }
      delete store[id];
      deleted++;
    }
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ deleted, skipped });
  });

  router.delete('/api/records/:collection', requireAuth, requireRole('admin'), (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED_COLLECTIONS.includes(collection)) return res.status(400).json({ error: 'اسم تصنيف بيانات غير صحيح' });
    collections[collection] = {};
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ deleted: true });
  });

  router.get('/api/records/:collection/prune-preview', requireAuth, requireRole('admin'), (req, res) => {
    const collection = req.params.collection;
    if (!PRUNABLE.includes(collection)) return res.status(400).json({ error: 'هذا التصنيف غير قابل للتنظيف' });
    const days = parseInt(req.query.olderThanDays, 10);
    if (!days || days < 90) return res.status(400).json({ error: 'المدة يجب أن تكون 90 يوماً على الأقل' });
    const cutoff = Date.now() - days * 86400000;
    const list = Object.values(collections[collection] || {});
    const wouldDelete = list.filter(r => new Date(r.updated_at || r.created_at).getTime() < cutoff).length;
    res.json({ wouldDelete, total: list.length, collection, olderThanDays: days });
  });
  router.post('/api/records/:collection/prune', requireAuth, requireRole('admin'), (req, res) => {
    const collection = req.params.collection;
    if (!PRUNABLE.includes(collection)) return res.status(400).json({ error: 'هذا التصنيف غير قابل للتنظيف' });
    const days = parseInt((req.body || {}).olderThanDays, 10);
    if (!days || days < 90) return res.status(400).json({ error: 'المدة يجب أن تكون 90 يوماً على الأقل' });
    const cutoff = Date.now() - days * 86400000;
    const store = collections[collection] || {};
    let deleted = 0;
    for (const [id, r] of Object.entries(store)) {
      if (new Date(r.updated_at || r.created_at).getTime() < cutoff) { delete store[id]; deleted++; }
    }
    saveCollection(collection);
    broadcast(collection, req.auth.username);
    res.json({ deleted, collection, olderThanDays: days });
  });

  // ===================== سجلات العملاء (client records) =====================
  router.get('/api/client-records/versions', requireAuth, (req, res) => {
    const list = visibleRecords(Object.values(db.clients), req.auth.role, req.auth.username);
    res.json({ pairs: list.map(r => [r.id, r.version]) });
  });
  router.get('/api/client-records/version', requireAuth, (req, res) => {
    const list = visibleRecords(Object.values(db.clients), req.auth.role, req.auth.username);
    let sum = 0;
    for (const r of list) sum += (r.version || 0);
    res.json({ version: sum, count: list.length });
  });
  router.get('/api/client-records/ids', requireAuth, (req, res) => {
    const list = visibleRecords(Object.values(db.clients), req.auth.role, req.auth.username);
    res.json({ ids: list.map(r => ({ id: r.id, clientIdHash: r.clientId ? sha256hex(r.clientId) : '' })) });
  });
  router.get('/api/client-records', requireAuth, (req, res) => {
    let list = visibleRecords(Object.values(db.clients), req.auth.role, req.auth.username);
    if (req.query.ids) {
      const ids = new Set(String(req.query.ids).split(',').filter(Boolean));
      list = list.filter(r => ids.has(r.id));
    } else if (req.query.page) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 200));
      list = list.slice((page - 1) * pageSize, page * pageSize);
    }
    res.json({ records: list.map(r => ({ id: r.id, enc: r.enc, version: r.version, origin: r.origin, status: r.status })) });
  });
  router.put('/api/client-records/:id', requireAuth, (req, res) => {
    const out = putRecord(db.clients, 'clients', req.params.id, req.body || {}, req.auth, saveClients);
    if (out.status === 200) broadcast('clients', req.auth.username);
    res.status(out.status).json(out.json);
  });
  router.post('/api/client-records/:id/approve', requireAuth, requireRole('admin'), (req, res) => {
    const r = db.clients[req.params.id];
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    r.status = 'confirmed'; r.version = (r.version || 0) + 1; r.updated_by = req.auth.username; r.updated_at = nowIso();
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ id: r.id, version: r.version, status: 'confirmed' });
  });
  router.post('/api/client-records/:id/reject', requireAuth, requireRole('admin'), (req, res) => {
    const r = db.clients[req.params.id];
    if (!r || r.status !== 'pending') return res.status(404).json({ error: 'لا يوجد سجل معلّق بهذا المعرّف بانتظار الاعتماد' });
    r.status = 'rejected'; r.version = (r.version || 0) + 1; r.rejected_at = nowIso(); r.updated_by = req.auth.username; r.updated_at = nowIso();
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ id: r.id, version: r.version, status: 'rejected' });
  });
  router.delete('/api/client-records/:id', requireAuth, (req, res) => {
    const r = db.clients[req.params.id];
    if (!r) return res.json({ id: req.params.id, deleted: true });
    if (!canTouchRecord(r, req.auth)) return res.status(403).json({ error: 'ليس لديك صلاحية حذف هذا السجل' });
    if (req.query.version !== undefined && Number(req.query.version) !== r.version) {
      return res.status(409).json({ error: 'تعارض: تم تعديل هذه البيانات من جلسة أخرى', currentVersion: r.version });
    }
    delete db.clients[req.params.id];
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ id: req.params.id, deleted: true });
  });
  router.post('/api/client-records/bulk-delete', requireAuth, (req, res) => {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000) return res.status(400).json({ error: 'قائمة المعرّفات غير صالحة' });
    let deleted = 0;
    let skipped = 0;
    // كان هذا المسار بلا أي فحص صلاحية إطلاقاً: أي دور مسموح له بشاشة
    // العملاء كان يستطيع حذف كل سجلات العملاء دفعة واحدة.
    for (const id of ids) {
      const rec = db.clients[id];
      if (!rec) continue;
      if (!canTouchRecord(rec, req.auth)) { skipped++; continue; }
      delete db.clients[id];
      deleted++;
    }
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ deleted, skipped });
  });
  router.delete('/api/client-records', requireAuth, requireRole('admin'), (req, res) => {
    db.clients = {};
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ deleted: true });
  });
  router.post('/api/client-records/bulk-migrate', requireAuth, (req, res) => {
    const records = (req.body && req.body.records) || [];
    if (!Array.isArray(records) || !records.length || records.length > 5000) {
      return res.status(400).json({ error: 'عدد السجلات غير صالح' });
    }
    let migrated = 0;
    const conflicts = [];
    for (const item of records) {
      if (!item || !item.id || typeof item.enc !== 'string' || !item.enc) {
        return res.status(400).json({ error: 'سجل غير صالح داخل الدفعة' });
      }
      const out = putRecord(db.clients, 'clients', item.id, item, req.auth, () => {});
      if (out.status === 200) migrated++;
      else if (out.status === 409) conflicts.push({ id: item.id, currentVersion: out.json.currentVersion, currentEnc: out.json.currentEnc });
      else return res.status(out.status).json(out.json);
    }
    saveClients(); broadcast('clients', req.auth.username);
    res.json({ migrated, conflicts });
  });

  // فهرس العملاء السحابي (clients_rows) غير موجود محلياً — الواجهة تتكفّل
  // بالبحث/الفلترة محلياً بالكامل عند تعذّر هذا المسار (خط رجعة مصمَّم أصلاً).
  router.get('/api/clients', requireAuth, (req, res) => {
    if (req.auth.role === 'reception') return res.status(403).json({ error: 'غير متاح لهذا الدور' });
    return res.status(400).json({ error: 'البحث عبر الخادم غير متاح في النسخة المحلية — يتم البحث محلياً' });
  });

  // ===================== النسخ الاحتياطية =====================
  router.get('/api/backups', requireAuth, requireRole('admin'), (req, res) => {
    res.json((db.backups || []).map(b => ({ id: b.id, kind: b.kind, size_bytes: b.size_bytes, created_by: b.created_by, created_at: b.created_at })));
  });
  router.post('/api/backups', requireAuth, requireRole('admin'), (req, res) => {
    const kind = (req.body && req.body.kind) === 'auto' ? 'auto' : 'manual';
    const enc = req.body && req.body.enc;
    if (typeof enc !== 'string' || !enc) return res.status(400).json({ error: 'بيانات النسخة الاحتياطية مطلوبة' });
    if (enc.length > 10 * 1024 * 1024) return res.status(400).json({ error: 'حجم النسخة الاحتياطية أكبر من الحد المسموح' });
    const id = randomId();
    const rec = { id, kind, enc, size_bytes: Buffer.byteLength(enc, 'utf8'), created_by: req.auth.username, created_at: nowIso() };
    db.backups.push(rec);
    if (db.backups.length > 30) db.backups = db.backups.slice(-30);
    saveBackups();
    res.json({ id, createdAt: rec.created_at });
  });
  router.get('/api/backups/:id', requireAuth, requireRole('admin'), (req, res) => {
    const b = (db.backups || []).find(x => x.id === req.params.id);
    if (!b) return res.status(404).json({ error: 'النسخة غير موجودة' });
    res.json({ id: b.id, kind: b.kind, enc: b.enc, created_at: b.created_at });
  });
  router.delete('/api/backups/:id', requireAuth, requireRole('admin'), (req, res) => {
    db.backups = (db.backups || []).filter(x => x.id !== req.params.id);
    saveBackups();
    res.json({ deleted: true });
  });

  // ===================== البث اللحظي =====================
  router.get('/api/events/stream', (req, res) => {
    const a = currentAuth(req);
    if (!a) { res.status(401).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res, username: a.username };
    sseClients.add(client);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 30000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
  });

  // ===================== خدمات تحتاج إنترنت (غير متاحة محلياً) =====================
  router.post('/api/ai/read-invoices', requireAuth, (req, res) => res.status(501).json({ error: 'قراءة الفواتير بالذكاء الاصطناعي غير متاحة في النسخة المحلية' }));
  router.post('/api/ai/classify-expense', requireAuth, (req, res) => res.status(501).json({ error: 'تصنيف المصروفات بالذكاء الاصطناعي غير متاح في النسخة المحلية' }));

  // ===================== الصحة =====================
  router.get('/api/health', (req, res) => res.json({
    ok: true,
    db: true,
    dataWarnings: corruptionWarnings.length,
    warnings: corruptionWarnings,
  }));

  // أي مسار /api غير معروف
  router.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود' }));

  return router;
};
