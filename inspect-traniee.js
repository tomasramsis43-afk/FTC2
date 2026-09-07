/**
 * inspect-traniee.js — استكشاف نموذج "اضافة طلب متدرب" في أركان
 * (تحليل فقط — لا يرسل أي بيانات)
 *
 * التشغيل:
 *   $env:ARKKAN_USER="..." ; $env:ARKKAN_PASS="..." ; node inspect-traniee.js
 */

const { chromium } = require('playwright');

const LOGIN_URL = 'https://arkkanapp2.net/Municipal/educational-bags-login.aspx';
const TARGET_URL = 'https://arkkanapp2.net/Municipal/Traniee_Request.aspx';
const USER = process.env.ARKKAN_USER || '';
const PASS = process.env.ARKKAN_PASS || '';

if (!USER || !PASS) {
  console.error('❌ حدد ARKKAN_USER و ARKKAN_PASS كمتغيرات بيئة');
  process.exit(1);
}

const SHOT_DIR = (process.env.ARKKAN_SHOT_DIR || (__dirname + '/.inspect-shots'));

function describePage(pg, label) {
  return pg.evaluate((lbl) => {
    const sel = (s) => [...document.querySelectorAll(s)];
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const fields = sel('input, select, textarea').map((el) => {
      let label = '';
      if (el.id) {
        const lb = document.querySelector(`label[for="${el.id}"]`);
        if (lb) label = lb.innerText.trim();
      }
      const parent = el.closest('.form-group, .col, .row, form, div');
      if (!label && parent) {
        const lb = parent.querySelector('label');
        if (lb) label = lb.innerText.trim();
      }
      return {
        tag: el.tagName,
        id: el.id,
        name: el.name || '',
        type: el.type || el.tagName,
        label,
        required: el.required || false,
        options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ v: o.value, t: o.text.trim() })) : undefined,
        hidden: !visible(el),
      };
    });
    const buttons = sel('button, input[type="submit"], input[type="button"], a.btn').map((b) => ({
      text: (b.innerText || b.value || '').trim().slice(0, 60),
      id: b.id || '',
    }));
    return {
      label: lbl,
      url: location.href,
      title: document.title,
      bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
      links: sel('a').map(a => (a.innerText || '').trim()).filter(Boolean).slice(0, 40),
      fields,
      buttons,
    };
  }, label);
}

(async () => {
  const browser = await chromium.launch({ headless: process.env.ARKKAN_HEADLESS !== 'false' });
  const ctx = await browser.newContext({ locale: 'ar' });
  const pg = await ctx.newPage();
  const fs = require('fs');
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  try {
    console.log('1) فتح صفحة الدخول...');
    await pg.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pg.waitForTimeout(2000);

    let current = await describePage(pg, 'login-page');
    console.log('   URL بعد الفتح:', current.url);

    // إن كنا على صفحة دخول — نملا الحقول
    if (await pg.locator('#UsernameLog').count()) {
      console.log('2) تسجيل الدخول...');
      await pg.fill('#UsernameLog', USER);
      await pg.fill('#Password', PASS);
      await pg.click('#btn_submitEnter');
      // إنتظار انتقال (WebForms postback)
      await pg.waitForTimeout(7000);
      current = await describePage(pg, 'after-login');
      console.log('   URL بعد الدخول:', current.url);
    }

    await pg.screenshot({ path: `${SHOT_DIR}/after-login.png`, fullPage: false });

    // 3) الذهاب للنموذج المستهدف إن لم نكن عليه
    if (!current.url.includes('Traniee_Request')) {
      console.log('3) الانتقال إلى صفحات Traniee_Request.aspx...');
      await pg.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await pg.waitForTimeout(4000);
      current = await describePage(pg, 'target-page');
      console.log('   URL:', current.url);
    }

    if (!current.url.includes('Traniee_Request')) {
      // ربما بيفتح في إطار؟ نفحص بدون الوصول للصفحة الثابتة
      console.log('   ⚠️ لم نصل لصفحة الطلب — نفحص الإطارات...');
      for (const f of pg.frames()) {
        const fu = f.url();
        if (fu && fu !== 'about:blank' && !fu.startsWith('javascript')) {
          console.log('   frame:', fu);
        }
      }
    }

    await pg.screenshot({ path: `${SHOT_DIR}/traniee-request.png`, fullPage: false });
    fs.writeFileSync(`${SHOT_DIR}/page.json`, JSON.stringify(current, null, 2), 'utf8');

    console.log(`\n${'═'.repeat(60)}`);
    console.log('📄 الصفحة:', current.title || '(بدون عنوان)');
    console.log('🔗 الرابط:', current.url);
    console.log('\n📋 حقول النموذج:');
    for (const f of current.fields.filter(x => !x.hidden)) {
      const opts = f.options ? ` [${f.options.map(o => `${o.t}(${o.v})`).join(' | ')}]` : '';
      console.log(`   - ${f.label || '(بدون تسمية)'} | #${f.id} | ${f.tagName}:${f.type}${f.required ? ' *مطلوب' : ''}${opts}`);
    }
    console.log(fieldsCount => `\n🧩 إجمالي الحقول الظاهرة: ${fieldsCount}`, current.fields.filter(x => !x.hidden).length);
    console.log('🔘 الأزرار:', current.buttons.map(b => `"${b.text}"`).join(' ، ') || '(لا يوجد)');
    console.log(`\n📸 اللقطات في: ${SHOT_DIR}`);
    console.log('═'.repeat(60));

    fs.writeFileSync(`${SHOT_DIR}/links.txt`, (current.links || []).join('\n'), 'utf8');
  } catch (e) {
    console.error('❌ خطأ:', e.message);
    await pg.screenshot({ path: `${SHOT_DIR}/error.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})();