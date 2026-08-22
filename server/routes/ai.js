const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { aiLimiter } = require('../rate-limiters');

/* ---------------- قراءة فواتير الدورات من ملفات حقيقية (PDF/صور) بالذكاء الاصطناعي ----------------
   تستقبل مجموعة ملفات (Base64)، وترسل كل ملف لـ Claude API لاستخراج البيانات المطبوعة داخله فقط
   (رقم الهوية، رقم الفاتورة، تاريخ الفاتورة، القيمة الفعلية). لا شيء يُحفظ هنا في قاعدة البيانات —
   فقط استخراج وإرجاع النتائج للواجهة، التي تعرضها للمراجعة اليدوية قبل الحفظ النهائي (بنفس منطق
   ونموذج التحقق المستخدم أصلاً في "تحديث/استيراد فواتير الدورات دفعة واحدة"). */
const invoiceReadJsonParser = express.json({ limit: '40mb' });

const CI_EXTRACT_SYSTEM_PROMPT = `أنت مساعد استخراج بيانات من فواتير/إيصالات دورات تدريبية سعودية.
سيصلك ملف فاتورة أو إيصال واحد (صورة أو PDF). استخرج منه فقط ما هو مكتوب صراحةً داخل الملف:
- nationalId: رقم الهوية/الإقامة للمتدرب إن وُجد مكتوباً بوضوح (أرقام فقط بدون مسافات أو رموز)
- invoiceNo: رقم الفاتورة أو رقم الإيصال
- date: تاريخ إصدار الفاتورة بصيغة YYYY-MM-DD
- actualValue: القيمة الإجمالية الفعلية المدفوعة (رقم فقط بدون رمز عملة)
- clientNameOnInvoice: اسم العميل كما هو مكتوب في الفاتورة إن وُجد
لا تخترع أي قيمة غير موجودة فعلياً في الملف — إن لم يظهر حقل بوضوح اجعله null.
أجب بصيغة JSON فقط بدون أي نص أو علامات \`\`\`json، بالشكل التالي بالضبط:
{"nationalId": "...", "invoiceNo": "...", "date": "...", "actualValue": 0, "clientNameOnInvoice": "...", "confidence": "high|medium|low"}`;

async function extractInvoiceFile(f) {
  const mime = String(f.mimeType || '').toLowerCase();
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  const fileName = f.name || 'ملف';
  if (!f.dataBase64 || (!isPdf && !isImage)) {
    return { fileName, error: 'صيغة ملف غير مدعومة (يجب أن تكون صورة أو PDF)' };
  }
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.dataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: f.dataBase64 } };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: CI_EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: 'استخرج البيانات من هذه الفاتورة.' }] }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return { fileName, error: `تعذّرت قراءة الملف (HTTP ${r.status})`, detail: errText.slice(0, 200) };
    }
    const data = await r.json();
    const rawText = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      fileName,
      nationalId: parsed.nationalId ? String(parsed.nationalId).trim() : null,
      invoiceNo: parsed.invoiceNo ? String(parsed.invoiceNo).trim() : null,
      date: parsed.date || null,
      actualValue: parsed.actualValue !== null && parsed.actualValue !== undefined && parsed.actualValue !== '' ? Number(parsed.actualValue) : null,
      clientNameOnInvoice: parsed.clientNameOnInvoice || null,
      confidence: parsed.confidence || 'unknown',
    };
  } catch (e) {
    return { fileName, error: 'تعذّر تحليل استجابة الذكاء الاصطناعي' };
  }
}

router.post('/api/ai/read-invoices', requireAuth, invoiceReadJsonParser, aiLimiter, async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'لم يتم إرسال أي ملفات' });
  if (files.length > 30) return res.status(400).json({ error: 'الحد الأقصى 30 ملفاً في المرة الواحدة' });
  // حد أقصى 8 ميجابايت لكل ملف على حدة (أكثر من كافٍ لأي فاتورة/إيصال ممسوح ضوئياً) — دفاع إضافي
  // بجانب حد الـ 40 ميجابايت الإجمالي لكل الطلب، بدل الاعتماد على الحد الكلي فقط.
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  for (const f of files) {
    const approxBytes = f?.dataBase64 ? Math.ceil(f.dataBase64.length * 0.75) : 0;
    if (approxBytes > MAX_FILE_BYTES) {
      return res.status(400).json({ error: `الملف "${f.name || 'بدون اسم'}" أكبر من الحد المسموح (8 ميجابايت للملف الواحد)` });
    }
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير مُعدّ على الخادم (ANTHROPIC_API_KEY)' });
  }
  // معالجة بحد أقصى 3 ملفات بالتوازي في نفس الوقت لتفادي إغراق الـ API
  const results = [];
  const queue = [...files];
  async function worker() {
    while (queue.length) {
      const f = queue.shift();
      results.push(await extractInvoiceFile(f));
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()]);
    res.json({ results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّرت معالجة الملفات' });
  }
});

/* ---------------- تصنيف المصروفات بالذكاء الاصطناعي (عبر الخادم) ----------------
   تستقبل اسم المستلم/الملاحظات/رقم المستند/المبلغ + قائمة التصنيفات المتاحة،
   وتطلب من Claude اقتراح أنسب تصنيف (موجود أو جديد) مع سبب الاختيار.
   المفتاح يبقى في process.env.ANTHROPIC_API_KEY فقط ولا يُكشف للواجهة. */
const AI_CLASSIFY_SYSTEM_PROMPT = 'أنت مساعد تصنيف مصروفات لمركز تدريب سعودي. سيصلك اسم مستلم مبلغ و/أو ملاحظة و/أو رقم مستند و/أو مبلغ مصروف. اختر أنسب تصنيف من قائمة "availableCategories" المُرسلة فقط إن وجد تصنيف مناسباً فعلياً. إن لم توجد أي تصنيف مناسب في القائمة، اقترح اسم تصنيف عربي جديد قصير (كلمة أو كلمتان) يصلح لتكرار هذا النوع من المصروفات مستقبلاً. أجب بصيغة JSON فقط بدون أي نص أو علامات ```json، بالشكل التالي بالضبط: {"category":"...", "isNew": true أو false, "reason":"جملة قصيرة توضح سبب الاختيار"}';

router.post('/api/ai/classify-expense', requireAuth, aiLimiter, async (req, res) => {
  const { recipientName, notes, documentRef, amount, availableCategories } = req.body || {};
  if (!recipientName && !notes && !documentRef) {
    return res.status(400).json({ error: 'أدخل اسم مستلم المبلغ أو ملاحظة أو رقم مستند أولاً' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير مُعدّ على الخادم (ANTHROPIC_API_KEY)' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: AI_CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ recipientName: recipientName || null, notes: notes || null, documentRef: documentRef || null, amount: amount || null, availableCategories: availableCategories || [] }) }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: `تعذّر الاتصال بخدمة الذكاء الاصطناعي (HTTP ${r.status})`, detail: errText.slice(0, 200) });
    }
    const data = await r.json();
    const rawText = (data.content || []).map(b => b.text || '').join('').trim();
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      return res.status(502).json({ error: 'استجابة الذكاء الاصطناعي غير صالحة (ليست JSON)' });
    }
    res.json({ category: String(parsed.category || '').trim(), isNew: !!parsed.isNew, reason: parsed.reason || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر الحصول على اقتراح التصنيف' });
  }
});


module.exports = router;
