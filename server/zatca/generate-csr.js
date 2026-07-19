/*
 * توليد المفتاح الخاص (Private Key) وطلب توقيع الشهادة (CSR) المطلوبين للتسجيل
 * في منصة "فاتورة" (المرحلة الثانية من الفوترة الإلكترونية).
 *
 * الاستخدام:
 *   1) عدّل القيم في كائن CONFIG بالأسفل بمعلومات منشأتك الحقيقية.
 *   2) شغّل: node server/zatca/generate-csr.js
 *   3) سيُنشئ مجلد server/zatca/out/ يحتوي:
 *        - private-key.pem   (المفتاح الخاص — سرّي جداً، لا يُرفع لأي مكان عام/Git)
 *        - csr.pem           (طلب توقيع الشهادة بصيغة PEM)
 *        - csr-base64.txt    (نفس الطلب لكن Base64 بسطر واحد — هذا ما يُلصق في بوابة فاتورة)
 *   4) الصق محتوى csr-base64.txt في بوابة فاتورة (Fatoora Portal) لطلب compliance CSID.
 *
 * ملاحظة مهمة عن البيئات الثلاث لدى الهيئة (تأكد من القيمة الصحيحة من بوابة فاتورة
 * وقت التنفيذ الفعلي، لأن الهيئة قد تُحدّث هذه الثوابت):
 *   - Sandbox / بيئة المطورين التجريبية بدون رقم ضريبي حقيقي  → TSTZATCA-Code-Signing
 *   - Simulation / بيئة المحاكاة (قبل الإنتاج، برقم ضريبي حقيقي) → PREZATCA-Code-Signing
 *   - Production / الإنتاج الفعلي                              → ZATCA-Code-Signing
 * بما أننا بدأنا بـ Sandbox، الإعداد الافتراضي هنا TSTZATCA-Code-Signing.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG = {
  // بيئة التوليد الحالية: 'sandbox' | 'simulation' | 'production'
  environment: 'sandbox',

  // بيانات المنشأة — عدّلها بمعلوماتك الحقيقية
  // ⚠️ استخدم الاسم القانوني بالأحرف اللاتينية (English) هنا وليس بالعربي:
  // اختبرنا الحقول بالعربي وتظهر مشوّهة (Mojibake) داخل الشهادة الناتجة لأن
  // هذه الحقول تُرمَّز عبر openssl config وقد لا تُقرأ بشكل صحيح من جهة الهيئة.
  // الاسم العربي التجاري يظهر داخل الفاتورة نفسها لاحقاً (في XML) وليس هنا.
  organizationName: 'Your Company Name LLC', // O
  organizationUnit: 'Main Branch',            // OU (اسم الفرع/الإدارة)
  commonName: 'Your Company Name LLC',        // CN
  countryCode: 'SA',

  // بيانات إضافية تطلبها الهيئة داخل subjectAltName
  solutionName: 'TrainingCenterApp',  // اسم الحل/النظام (بدون مسافات يفضّل)
  solutionVersion: '1.0',
  egsSerialNumber: '1',               // رقم تسلسلي فريد لوحدة التوليد (EGS) لديك
  vatRegistrationNumber: '3XXXXXXXXXXX03', // الرقم الضريبي الفعلي (15 رقم يبدأ وينتهي بـ3)
  branchLocation: 'Riyadh, Saudi Arabia', // عنوان الفرع (لاتيني لنفس سبب الحقول أعلاه)
  branchIndustry: 'Education Services',   // نشاط الفرع

  // نوع الفواتير المدعومة: 4 خانات ثنائية [قياسية][مبسّطة][محجوز][محجوز]
  // "1100" = يدعم الفواتير القياسية B2B والمبسّطة B2C معاً (هذا ما يناسبك)
  invoiceTypeSupport: '1100',

  emailAddress: 'you@example.com',
};

const TEMPLATE_BY_ENV = {
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

function buildOpensslConfig(cfg) {
  const template = TEMPLATE_BY_ENV[cfg.environment];
  if (!template) throw new Error(`بيئة غير معروفة: ${cfg.environment}`);
  const serialField = `1-${cfg.solutionName}|2-${cfg.solutionVersion}|3-${cfg.egsSerialNumber}`;
  return `oid_section = OIDs

[OIDs]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[req]
default_bits = 2048
emailAddress = ${cfg.emailAddress}
req_extensions = req_ext
x509_extensions = v3_ca
prompt = no
default_md = sha256
distinguished_name = dn

[dn]
C = ${cfg.countryCode}
OU = ${cfg.organizationUnit}
O = ${cfg.organizationName}
CN = ${cfg.commonName}

[v3_ca]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment

[req_ext]
certificateTemplateName = ASN1:PRINTABLESTRING:${template}
subjectAltName = dirName:alt_names

[alt_names]
SN = ${serialField}
UID = ${cfg.vatRegistrationNumber}
title = ${cfg.invoiceTypeSupport}
registeredAddress = ${cfg.branchLocation}
businessCategory = ${cfg.branchIndustry}
`;
}

function main() {
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const configPath = path.join(outDir, 'csr-config.txt');
  const keyPath = path.join(outDir, 'private-key.pem');
  const csrPath = path.join(outDir, 'csr.pem');
  const csrB64Path = path.join(outDir, 'csr-base64.txt');

  fs.writeFileSync(configPath, buildOpensslConfig(CONFIG), 'utf8');

  // 1) مفتاح خاص بمنحنى secp256k1 (المطلوب من الهيئة تحديداً، وليس RSA)
  execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', keyPath]);

  // 2) طلب توقيع الشهادة (CSR) موقّع بنفس المفتاح، وفق الإعدادات أعلاه
  execFileSync('openssl', [
    'req', '-new',
    '-sha256',
    '-key', keyPath,
    '-config', configPath,
    '-out', csrPath,
  ]);

  // 3) نسخة Base64 بسطر واحد (هذا بالضبط ما تطلبه بوابة فاتورة / الـ API)
  const csrPem = fs.readFileSync(csrPath, 'utf8');
  const csrB64 = Buffer.from(csrPem, 'utf8').toString('base64');
  fs.writeFileSync(csrB64Path, csrB64, 'utf8');

  console.log('✅ تم التوليد بنجاح:');
  console.log('   - المفتاح الخاص :', keyPath, '  (سرّي — لا يُرفع لأي مستودع/مكان عام)');
  console.log('   - CSR (PEM)      :', csrPath);
  console.log('   - CSR (Base64)   :', csrB64Path, '  ← الصق محتواه في بوابة فاتورة');
  console.log('\nبيئة التوليد:', CONFIG.environment, '→ certificateTemplateName =', TEMPLATE_BY_ENV[CONFIG.environment]);
}

main();
