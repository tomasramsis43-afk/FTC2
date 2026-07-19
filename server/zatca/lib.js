/*
 * طبقة ربط بين تطبيقنا ومكتبة zatca-xml-js (المسؤولة عن بناء XML، التوقيع
 * الرقمي، QR، والاتصال بواجهات هيئة الزكاة والضريبة والجمارك).
 *
 * ⚠️ ملاحظة مهمة جداً على الوضع الحالي: المكتبة تدعم "الفاتورة الضريبية
 * المبسّطة" (Simplified Tax Invoice — B2C، مسار "التقرير/Reporting") فقط.
 * لا تدعم حالياً "الفاتورة الضريبية القياسية" (Standard/B2B — مسار
 * "التخليص/Clearance"). لذلك: العملاء الأفراد (بدون رقم ضريبي) يُرسَلون
 * فعلياً للهيئة الآن، أما عملاء الشركات (B2B) فتُبنى فاتورتهم وتُسجَّل
 * محلياً بحالة 'not_supported_yet' لحين إضافة مسار القياسية لاحقاً — حتى لا
 * نرسل للهيئة شيئاً غير مطابق للمواصفة الرسمية.
 *
 * أيضاً: المكتبة بإصدارها الحالي (0.1.9) لا تحتوي رابط إنتاج فعلي (production
 * endpoint) — مبنية للعمل مع بيئة Sandbox/Simulation فقط، وهذا مطابق تماماً
 * لما بدأنا فيه (Sandbox). عند الانتقال للإنتاج لاحقاً سنحتاج مراجعة هذه
 * النقطة تحديداً.
 */
const { EGS, ZATCASimplifiedTaxInvoice, ZATCAInvoiceTypes, ZATCAPaymentMethods } = require('zatca-xml-js');
const { pool } = require('../db');

const SOLUTION_NAME = 'TrainingCenterApp';

/* ---------------- تحميل/حفظ حالة EGS من قاعدة البيانات ---------------- */

async function loadActiveEgsRow(environment) {
  const r = await pool.query(
    `SELECT * FROM zatca_credentials WHERE environment = $1 AND is_active = true
     ORDER BY id DESC LIMIT 1`,
    [environment]
  );
  return r.rows[0] || null;
}

async function loadEgs(environment) {
  const row = await loadActiveEgsRow(environment);
  if (!row || !row.egs_info) return null;
  return { egs: new EGS(row.egs_info), row };
}

async function saveEgsInfo(environment, egs_info, existingRowId) {
  if (existingRowId) {
    const r = await pool.query(
      `UPDATE zatca_credentials SET egs_info = $1, updated_at = now(),
        compliance_csid = $2, compliance_secret = $3,
        production_csid = $4, production_secret = $5
       WHERE id = $6 RETURNING *`,
      [
        JSON.stringify(egs_info), egs_info.compliance_certificate || null, egs_info.compliance_api_secret || null,
        egs_info.production_certificate || null, egs_info.production_api_secret || null,
        existingRowId,
      ]
    );
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO zatca_credentials (environment, egs_info, compliance_csid, compliance_secret, production_csid, production_secret)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      environment, JSON.stringify(egs_info), egs_info.compliance_certificate || null, egs_info.compliance_api_secret || null,
      egs_info.production_certificate || null, egs_info.production_api_secret || null,
    ]
  );
  return r.rows[0];
}

/* حالة مختصرة وآمنة للعرض في الواجهة (بدون أي مفتاح خاص أو سر) */
function publicStatus(row) {
  if (!row) return { onboarded: false };
  const info = row.egs_info || {};
  return {
    onboarded: !!info.compliance_certificate,
    hasProductionCsid: !!info.production_certificate,
    complianceRequestId: info.compliance_request_id || null,
    environment: row.environment,
    vatNumber: info.VAT_number,
    vatName: info.VAT_name,
    updatedAt: row.updated_at,
  };
}

/* ---------------- التسجيل (Onboarding) ---------------- */

/*
 * orgProfile: {
 *   crnNumber, vatName, vatNumber, branchName, branchIndustry,
 *   city, citySubdivision, street, plotId, building, postalZone
 * }
 */
async function onboard({ environment, otp, orgProfile }) {
  const existing = await loadActiveEgsRow(environment);
  const egs_info = existing?.egs_info || {
    uuid: require('crypto').randomUUID(),
    custom_id: `EGS-${Date.now()}`,
    model: 'WebApp',
    CRN_number: orgProfile.crnNumber,
    VAT_name: orgProfile.vatName,
    VAT_number: orgProfile.vatNumber,
    location: {
      city: orgProfile.city,
      city_subdivision: orgProfile.citySubdivision,
      street: orgProfile.street,
      plot_identification: orgProfile.plotId || '0000',
      building: orgProfile.building || '0000',
      postal_zone: orgProfile.postalZone,
    },
    branch_name: orgProfile.branchName,
    branch_industry: orgProfile.branchIndustry,
  };

  const egs = new EGS(egs_info);
  // production=false → شهادة الاختبار/الامتثال (compliance) وليست الإنتاج
  await egs.generateNewKeysAndCSR(false, SOLUTION_NAME);
  const compliance_request_id = await egs.issueComplianceCertificate(otp);
  egs.set({ compliance_request_id });
  const saved = await saveEgsInfo(environment, egs.get(), existing?.id);
  return { complianceRequestId: compliance_request_id, status: publicStatus(saved) };
}

/* بعد نجاح فحص التوافق (compliance check) على عدد كافٍ من الفواتير التجريبية،
   نطلب شهادة الإنتاج (production/PCSID) — في بيئة الـSandbox هذه ليست شهادة
   إنتاج حقيقية، بل المرحلة الثانية من اعتماد الـSandbox نفسه. */
async function issueProductionCsid({ environment, complianceRequestId }) {
  const existing = await loadActiveEgsRow(environment);
  if (!existing) throw new Error('لا توجد بيانات تسجيل (onboarding) بعد لهذه البيئة');
  const egs = new EGS(existing.egs_info);
  const request_id = await egs.issueProductionCertificate(complianceRequestId);
  const saved = await saveEgsInfo(environment, egs.get(), existing.id);
  return { requestId: request_id, status: publicStatus(saved) };
}

/* ---------------- سلسلة تجزئة الفواتير (Hash Chain) ---------------- */

const FIRST_INVOICE_PIH = Buffer.from('0').toString('base64'); // "MA==" — قيمة ثابتة تشترطها الهيئة لأول فاتورة

async function withChainLock(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT invoice_counter, invoice_hash FROM zatca_invoice_log
       ORDER BY invoice_counter DESC LIMIT 1 FOR UPDATE`
    );
    const counter = r.rows[0] ? r.rows[0].invoice_counter + 1 : 1;
    const previousHash = r.rows[0] ? r.rows[0].invoice_hash : FIRST_INVOICE_PIH;
    const result = await fn(client, { counter, previousHash });
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------- بناء وتوقيع وإرسال فاتورة مبسّطة (B2C) ---------------- */

/*
 * params: {
 *   environment, sourceRef, documentType: 'invoice'|'credit_note',
 *   lineItems: [{ id, name, quantity, tax_exclusive_price, VAT_percent, discounts? }],
 *   issueDate: 'YYYY-MM-DD', issueTime: 'HH:mm:ss',
 *   cancelation?: { canceled_invoice_number, payment_method, reason } // إلزامي لو documentType = credit_note
 *   createdBy
 * }
 */
async function submitSimplifiedInvoice(params) {
  const { environment, sourceRef, documentType, lineItems, issueDate, issueTime, cancelation, createdBy } = params;
  const loaded = await loadEgs(environment);
  if (!loaded) throw new Error('لم يتم إعداد ربط الهيئة بعد (Onboarding) لهذه البيئة');
  const { egs, row } = loaded;
  const info = row.egs_info;
  if (!info.compliance_certificate) throw new Error('لا توجد شهادة امتثال (compliance CSID) بعد');

  return withChainLock(async (client, { counter, previousHash }) => {
    const invoice_serial_number = `${info.custom_id}-${counter}`;
    const cancelation_type = documentType === 'credit_note' ? ZATCAInvoiceTypes.CREDIT_NOTE : undefined;

    const invoice = new ZATCASimplifiedTaxInvoice({
      props: {
        egs_info: info,
        invoice_counter_number: counter,
        invoice_serial_number,
        issue_date: issueDate,
        issue_time: issueTime,
        previous_invoice_hash: previousHash,
        line_items: lineItems,
        cancelation: cancelation ? { ...cancelation, cancelation_type: cancelation_type || ZATCAInvoiceTypes.CREDIT_NOTE } : undefined,
      },
    });

    const { signed_invoice_string, invoice_hash, qr } = egs.signInvoice(invoice);

    let status = 'pending';
    let zatcaResponse = null;
    try {
      if (info.production_certificate) {
        // شهادة إنتاج (PCSID) موجودة → إرسال فعلي (تقرير الفاتورة)
        zatcaResponse = await egs.reportInvoice(signed_invoice_string, invoice_hash);
        status = zatcaResponse?.reportingStatus === 'REPORTED' ? 'reported'
          : (zatcaResponse?.warningMessages?.length ? 'warning' : 'reported');
      } else {
        // لسه ما فيه شهادة إنتاج → وضع فحص التوافق (يُستخدم أثناء التسجيل فقط)
        zatcaResponse = await egs.checkInvoiceCompliance(signed_invoice_string, invoice_hash);
        status = 'compliance_check';
      }
    } catch (e) {
      status = 'error';
      zatcaResponse = { error: e.message || String(e) };
    }

    const uuid = invoice.getXML().get('Invoice/cbc:UUID')?.[0]?.text || require('crypto').randomUUID();
    await client.query(
      `INSERT INTO zatca_invoice_log
        (invoice_uuid, invoice_type, document_type, source_ref, invoice_counter, previous_hash, invoice_hash, xml, signed_xml, qr_base64, status, zatca_response, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        `${invoice_serial_number}-${uuid}`, 'simplified', documentType, sourceRef, counter, previousHash, invoice_hash,
        null, signed_invoice_string, qr, status, JSON.stringify(zatcaResponse), createdBy || null,
      ]
    );

    return { status, qr, invoiceHash: invoice_hash, invoiceSerialNumber: invoice_serial_number, zatcaResponse };
  });
}

/* فاتورة B2B (قياسية) — غير مدعومة تقنياً بعد بهذه المكتبة. نسجّلها محلياً
   بحالة واضحة بدل تجاهلها، حتى تبقى قابلة للمتابعة لاحقاً دون إرسال خاطئ. */
async function logUnsupportedStandardInvoice({ sourceRef, documentType, createdBy }) {
  await pool.query(
    `INSERT INTO zatca_invoice_log
      (invoice_uuid, invoice_type, document_type, source_ref, invoice_counter, previous_hash, invoice_hash, status, created_by)
     VALUES ($1,'standard',$2,$3,0,'','',$4,$5)`,
    [require('crypto').randomUUID(), documentType, sourceRef, 'not_supported_yet', createdBy || null]
  );
}

module.exports = {
  loadActiveEgsRow,
  publicStatus,
  onboard,
  issueProductionCsid,
  submitSimplifiedInvoice,
  logUnsupportedStandardInvoice,
  ZATCAPaymentMethods,
};
