#!/usr/bin/env node
// توقيع تحديثات تطبيق سطح المكتب (Ed25519).
//   node tools/update-signing.js keygen [مسار-المفتاح-الخاص]   ← مرة واحدة (أو للتدوير)
//   node tools/update-signing.js sign                           ← بعد أي تعديل على ملفات الواجهة/الوكيل
// المفتاح الخاص يبقى عندك فقط (لا يُرفع للريبو ولا يوضع على Render).
// يُنتج: frontend/update-manifest.json (ملفات الواجهة) و agent-manifest.json (ملفات الوكيل).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'electron-desktop', 'update-pubkey.pem');
const DEFAULT_PRIV = process.env.UPDATE_PRIVATE_KEY_FILE || path.join(ROOT, '.update-private.pem');

// نفس التطبيع في main.js: توحيد نهايات الأسطر قبل الـ hash
const sha256 = (buf) => crypto.createHash('sha256')
  .update(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')).digest('hex');

function listFrom(mainSrc, name) {
  const m = mainSrc.match(new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\]);'));
  if (!m) throw new Error('لم أجد ' + name + ' في main.js');
  return JSON.parse(m[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
}

function buildManifest(baseDir, files) {
  const out = {};
  for (const f of files) {
    const p = path.join(baseDir, f);
    if (!fs.existsSync(p)) { console.warn('⚠️ ملف غير موجود (تخطّي):', f); continue; }
    out[f] = sha256(fs.readFileSync(p));
  }
  return out;
}

function signAndWrite(privKey, files, dest) {
  const payload = JSON.stringify({ v: 1, seq: Date.now(), issuedAt: new Date().toISOString(), files });
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privKey).toString('base64');
  fs.writeFileSync(dest, JSON.stringify({ payload, sig }, null, 2) + '\n');
  console.log('✔', path.relative(ROOT, dest), '(' + Object.keys(files).length + ' ملف)');
}

const cmd = process.argv[2];
if (cmd === 'keygen') {
  const out = process.argv[3] || DEFAULT_PRIV;
  if (fs.existsSync(out)) { console.error('المفتاح الخاص موجود مسبقاً:', out, '— احذفه يدوياً إن أردت التدوير'); process.exit(1); }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('تم إنشاء المفتاح الخاص:', out, '\nوالعام:', PUB, '\nاحفظ الخاص في مكان آمن ولا ترفعه.');
} else if (cmd === 'sign') {
  const priv = crypto.createPrivateKey(fs.readFileSync(DEFAULT_PRIV));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron-desktop', 'main.js'), 'utf8');
  signAndWrite(priv, buildManifest(path.join(ROOT, 'frontend'), listFrom(mainSrc, 'SYNCED_FILES')),
    path.join(ROOT, 'frontend', 'update-manifest.json'));
  signAndWrite(priv, buildManifest(ROOT, listFrom(mainSrc, 'AGENT_FILES')),
    path.join(ROOT, 'agent-manifest.json'));
} else {
  console.log('الاستخدام: keygen | sign');
  process.exit(1);
}
