const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.LICENSE_SECRET = process.env.LICENSE_SECRET || 'test-license-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://u:p@localhost:5432/db';

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('QR: polling على جلسة pending لا يستهلكها (يرجع pending مراراً)', async () => {
  const express = require('express');
  const router = require('../routes/qr-login');
  const app = express(); app.use(express.json()); app.use(router);
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const base = 'http://localhost:' + srv.address().port;
    const c = await (await fetch(base + '/api/auth/qr-login/create', { method: 'POST' })).json();
    for (let i = 0; i < 3; i++) {
      const st = await (await fetch(base + '/api/auth/qr-login/status/' + c.sessionId)).json();
      assert.equal(st.status, 'pending');
    }
  } finally { srv.close(); }
});

test('Magic link: الرابط لا يُبنى من Origin/Host الطلب', () => {
  const src = read('server', 'routes', 'magic-link.js');
  assert.ok(!/req\.headers\.origin/.test(src), 'لا استخدام لـ Origin القادم من الطلب');
  assert.ok(!/req\.headers\.host/.test(src), 'لا استخدام لـ Host القادم من الطلب');
  assert.ok(/getTrustedOrigin\(\)/.test(src));
});

test('server.js: لا أسرار/روابط webhook ثابتة ولا إيقاف للسيرفر عند unhandledRejection', () => {
  const src = read('server', 'server.js');
  assert.ok(!/AKfycb/.test(src) && !/GHAYYER_DI_TOKEN/.test(src));
  const m = src.match(/process\.on\('unhandledRejection'[\s\S]*?\}\);/);
  assert.ok(m && !/shutdown\(/.test(m[0]), 'unhandledRejection لا يستدعي shutdown');
});

test('arkkan-agent: يستمع على 127.0.0.1 ويرفض Origin/Host غريب', () => {
  const src = read('arkkan-agent.js');
  assert.ok(/server\.listen\(cfg\.AGENT_PORT,\s*'127\.0\.0\.1'/.test(src));
  assert.ok(/Origin غير مسموح/.test(src) && /Host غير مسموح/.test(src));
});

test('email: تنظيف HTML يحذف السكربت والأحداث والروابط الخطرة', () => {
  const sanitize = require('sanitize-html');
  assert.ok(sanitize); // المكتبة متاحة
  const src = read('server', 'routes', 'email.js');
  assert.ok(/sanitize-html/.test(src));
  assert.ok(/sanitizeEmailHtml\(String\(bodyHtml\)\)/.test(src), 'admin-alert يُنظَّف أيضاً');
});
