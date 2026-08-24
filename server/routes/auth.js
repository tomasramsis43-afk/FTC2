const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { signToken, requireAuth, requireRole, resolveUserFromToken, hashPassword, verifyPassword,
  verifyEmergencyAdmin, signEmergencyToken, generateTotpSecret, totpOtpauthUrl, verifyTotpToken,
  generateBackupCodes, hashBackupCodes, consumeBackupCode } = require('../auth');
const { addClient: addSseClient, removeClient: removeSseClient } = require('../sse');
const { authLimiter, licenseLimiter } = require('../rate-limiters');
const { validateLicenseKey } = require('../license');
const { alertAdmins, wrapHtml } = require('../services/email');

// تحديد الدولة/المدينة تقريبياً من عنوان IP، عبر خدمة ipwho.is المجانية (بدون مفتاح API).
// best-effort بالكامل: أي فشل (شبكة/انتهاء مهلة/عنوان محلي) يُرجع null بهدوء دون كسر تسجيل
// الدخول نفسه أبداً. مهلة قصيرة (2.5 ثانية) حتى لا تُبطئ استجابة الدخول بشكل ملحوظ لو تعذّر
// الوصول للخدمة الخارجية.
async function geolocateIp(ip) {
  if (!ip) return null;
  // تجاهل عناوين IP المحلية/الخاصة — الاستعلام عنها لن يعطي نتيجة مفيدة على أي حال.
  if (/^(127\.|10\.|192\.168\.|::1$|::ffff:127\.|fc00:|fe80:)/.test(ip)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json();
    if (!data || data.success === false) return null;
    return { country: data.country || null, city: data.city || null };
  } catch (e) {
    return null;
  }
}

// خطوة 1: توليد سر مؤقّت (pending) + رابط otpauth للـ QR — لا يُفعَّل فعلياً إلا بعد
// تأكيد أول كود صحيح فى /verify (يمنع تفعيل غير مقصود لو المستخدم أغلق الصفحة قبل المسح).
router.post('/api/2fa/setup', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const secret = generateTotpSecret();
    await pool.query('UPDATE server_users SET totp_pending_secret = $1 WHERE username = $2', [secret, req.user.username]);
    const otpauthUrl = totpOtpauthUrl(secret, req.user.username);
    res.json({ secret, otpauthUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر بدء إعداد المصادقة الثنائية' });
  }
});
// خطوة 2: تأكيد أول كود من تطبيق المصادقة — عند النجاح ينتقل السر من pending إلى الفعلي
// وتُولَّد 10 أكواد احتياطية تُعرض للمستخدم مرة واحدة فقط (النص الصريح لا يُخزَّن أبداً).
router.post('/api/2fa/verify-setup', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const r = await pool.query('SELECT totp_pending_secret FROM server_users WHERE username = $1', [req.user.username]);
    const pending = r.rows[0]?.totp_pending_secret;
    if (!pending) return res.status(400).json({ error: 'ابدأ خطوة الإعداد أولاً' });
    if (!verifyTotpToken(req.body?.totpCode, pending)) {
      return res.status(401).json({ error: 'الكود غير صحيح، تأكد من مزامنة الوقت فى جهازك وحاول مجدداً' });
    }
    const backupCodes = generateBackupCodes(10);
    const hashed = await hashBackupCodes(backupCodes);
    await pool.query(
      `UPDATE server_users SET totp_secret = $1, totp_pending_secret = NULL, totp_enabled = true,
       totp_backup_codes = $2, token_version = token_version + 1 WHERE username = $3`,
      [pending, JSON.stringify(hashed), req.user.username]
    );
    res.json({ enabled: true, backupCodes }); // النص الصريح لهذه الأكواد يُعرض مرة واحدة فقط هنا
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تفعيل المصادقة الثنائية' });
  }
});
// إلغاء التفعيل — يتطلب كلمة المرور الحالية كتأكيد إضافي (مش مجرد ضغطة زر عابرة على حساب حساس)
router.post('/api/2fa/disable', requireAuth, requireRole('admin'), authLimiter, async (req, res) => {
  try {
    const r = await pool.query('SELECT password_hash FROM server_users WHERE username = $1', [req.user.username]);
    const ok = r.rows[0] && await verifyPassword(req.body?.password || '', r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
    await pool.query(
      `UPDATE server_users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = false,
       totp_backup_codes = NULL WHERE username = $1`,
      [req.user.username]
    );
    res.json({ enabled: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر إلغاء المصادقة الثنائية' });
  }
});
router.get('/api/2fa/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT totp_enabled FROM server_users WHERE username = $1', [req.user.username]);
    res.json({ enabled: !!(r.rows[0] && r.rows[0].totp_enabled) });
  } catch (e) {
    res.status(500).json({ error: 'تعذّر جلب حالة المصادقة الثنائية' });
  }
});

/* ---------------- تسجيل الدخول ---------------- */
router.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  }
  try {
    // ملاحظة أمنية: لا نقرأ رأس X-Forwarded-For يدوياً إطلاقاً — كان يُسمح لأي عميل بتزييفه
    // (spoofing) ليُسجَّل عنوان مزوّر في سجل الدخول. نعتمد على req.ip الذي يحسبه Express نفسه
    // وفقاً لإعداد trust proxy أعلاه (يثق فقط بأول proxy — ترتيب Render)، ففي الحالة الطبيعية عبر
    // الـ LB يُرجَع IP الزائر الحقيقي، وفي حالة الاتصال المباشر يُرجَع عنوان الاتصال الفعلي.
    const loginIp = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const loginDevice = (req.headers['user-agent'] || '').toString().slice(0, 300);
    // تحقق أولاً من حساب الطوارئ (مخزّن بالكامل في متغيرات البيئة، مستقل عن قاعدة
    // البيانات) — يسمح بالدخول للنظام حتى لو قاعدة البيانات اتغيرت أو كانت فاضية
    // تماماً أو معطّلة. لا يؤثر على حسابات جدول server_users العادية بأي شكل.
    const isEmergencyLogin = await verifyEmergencyAdmin(username.trim(), password);
    if (isEmergencyLogin) {
      const token = signEmergencyToken(username.trim());
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info) VALUES ($1, $2, $3, $4)',
        [username.trim(), 'admin', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
      return res.json({
        token,
        username: username.trim(),
        role: 'admin',
        user: { username: username.trim(), displayName: 'حساب الطوارئ', role: 'admin' },
      });
    }
    const r = await pool.query('SELECT * FROM server_users WHERE username = $1', [username.trim()]);
    const user = r.rows[0];
    if (!user) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [username.trim(), null, loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // قفل تلقائي مؤقت (بغض النظر عن IP المُستخدَم فى المحاولة الحالية) — يحمي من محاولة تخمين
    // موزّعة على عدة أجهزة/شبكات تتفادى rate limiting العادي المبني على IP وحده.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: `الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة` });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      // 5 محاولات فاشلة متتالية بكلمة المرور تقفل الحساب 15 دقيقة، ثم يُعاد العداد لصفر.
      pool.query(
        `UPDATE server_users SET
           failed_login_count = CASE WHEN failed_login_count + 1 >= 5 THEN 0 ELSE failed_login_count + 1 END,
           locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + INTERVAL '15 minutes' ELSE locked_until END
         WHERE id = $1`,
        [user.id]
      ).catch(e => console.error('تعذّر تحديث عداد المحاولات الفاشلة:', e));
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    // حساب معطّل من طرف المدير: نرفض الدخول برسالة واضحة قبل إصدار أي توكن،
    // حتى لو كانت كلمة المرور صحيحة.
    if (user.is_active === false) {
      pool.query(
        'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
        [user.username, user.role || 'staff', loginIp, loginDevice]
      ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
      return res.status(403).json({ error: 'هذا الحساب معطّل حالياً، تواصل مع المدير' });
    }
    // المصادقة الثنائية: كلمة المرور صحيحة والحساب مفعّل، لكن لو هذا المستخدم مفعّل عنده TOTP
    // فلازم نتحقق من كود إضافي قبل إصدار أي توكن — بدون هذه الخطوة، كلمة المرور وحدها كانت كافية.
    if (user.totp_enabled) {
      const { totpCode, backupCode } = req.body || {};
      if (!totpCode && !backupCode) {
        // لسه محتاجين الخطوة التانية — مش خطأ، فقط إشارة للواجهة إنها تعرض حقل الكود.
        // لا نُصدر أي توكن هنا إطلاقاً.
        return res.json({ requires2FA: true, username: user.username });
      }
      let verified = false;
      if (totpCode) {
        verified = verifyTotpToken(totpCode, user.totp_secret);
      } else if (backupCode) {
        // استهلاك الكود الاحتياطي بشكل ذرّي (قفل الصف داخل معاملة قصيرة) — يُغلق نافذة TOCTOU
        // التي كانت تسمح لطلبين متزامنين يحملان نفس الكود بالنجاح معاً قبل أن يلحق أيٌّ منهما
        // بحفظ القائمة المحدَّثة (مقارنة bcrypt البطيئة توسّع النافذة). SELECT ... FOR UPDATE
        // يجعل الطلب الثاني ينتظر حتى يُنفَّذ الأولُ ويُحفظ نتيجةَ الاستهلاك فيكتب فوقها،
        // فيستهلك الكودَ طلبٌ واحد فقط مهما تزامن معه غيره.
        let tx = null;
        try {
          tx = await pool.connect();
          await tx.query('BEGIN');
          const locked = await tx.query('SELECT totp_backup_codes FROM server_users WHERE id = $1 FOR UPDATE', [user.id]);
          const result = await consumeBackupCode(locked.rows[0].totp_backup_codes, backupCode);
          verified = result.ok;
          if (result.ok) {
            await tx.query('UPDATE server_users SET totp_backup_codes = $1 WHERE id = $2', [result.remaining, user.id]);
          }
          await tx.query('COMMIT');
        } catch (e) {
          if (tx) await tx.query('ROLLBACK').catch(() => {});
          console.error(e);
          verified = false;
        } finally {
          if (tx) tx.release();
        }
      }
      if (!verified) {
        pool.query(
          'INSERT INTO login_history (username, role, ip_address, device_info, success) VALUES ($1, $2, $3, $4, false)',
          [user.username, user.role || 'staff', loginIp, loginDevice]
        ).catch(e => console.error('تعذّر تسجيل محاولة دخول فاشلة:', e));
        return res.status(401).json({ error: 'كود التحقق غير صحيح' });
      }
    }
    // نجلب آخر عملية دخول ناجحة سابقة لهذا المستخدم قبل تسجيل عملية الدخول الحالية في السجل
    // (يجب أن يحدث هذا الاستعلام قبل الـ INSERT أسفل، وإلا سيُرجع الدخول الحالي نفسه بدل السابق له).
    // best-effort: فشل هذا الاستعلام لا يجب أن يمنع المستخدم من الدخول فعلياً.
    let lastLogin = null;
    let isNewDevice = false;
    try {
      const prevLogin = await pool.query(
        `SELECT logged_in_at, ip_address, device_info FROM login_history
         WHERE username = $1 AND success = true
         ORDER BY logged_in_at DESC LIMIT 1`,
        [user.username]
      );
      lastLogin = prevLogin.rows[0] || null;
      // "جهاز جديد": نفس بصمة الجهاز (User-Agent) لم تُستخدم من قبل مع هذا الحساب في أي دخول
      // ناجح سابق — تقريب بسيط بدون أي مكتبة بصمة إضافية، كافٍ لتنبيه المستخدم/المدير بدخول
      // من متصفح/جهاز لم يره من قبل. لا يُحتسب "جديد" لو كانت هذه أول مرة يدخل فيها الحساب
      // إطلاقاً (lastLogin فارغ)، لتفادي تنبيه لا فائدة منه عند أول تسجيل دخول.
      if (lastLogin && loginDevice) {
        const deviceSeen = await pool.query(
          `SELECT 1 FROM login_history WHERE username = $1 AND success = true AND device_info = $2 LIMIT 1`,
          [user.username, loginDevice]
        );
        isNewDevice = deviceSeen.rows.length === 0;
      }
    } catch (e) {
      console.error('تعذّر جلب آخر عملية دخول سابقة أو التحقق من الجهاز:', e);
    }
    // فحص هل عنوان IP الحالي سبق له دخول ناجح لهذا الحساب — "غير متعارف عليه خارجي" يعني IP لم يُسجَّل من قبل
    let isNewIp = false;
    try {
      if (lastLogin && loginIp) {
        const ipSeen = await pool.query(
          `SELECT 1 FROM login_history WHERE username = $1 AND success = true AND ip_address = $2 LIMIT 1`,
          [user.username, loginIp]
        );
        isNewIp = ipSeen.rows.length === 0;
      }
    } catch (e) {
      console.error('تعذّر التحقق من عنوان IP:', e);
    }
    // تحديد دولة/مدينة الدخول الحالي تقريبياً من عنوان IP، ومقارنتها بالدولة الأكثر تكراراً فى
    // دخولات هذا الحساب الناجحة السابقة — لتنبيه المستخدم لو الدخول الحالي من دولة غير معتادة له.
    // best-effort بالكامل: لا يمنع الدخول أبداً حتى لو فشلت خدمة الـ geolocation أو كانت بطيئة.
    const currentGeo = await geolocateIp(loginIp);
    let geoAlert = null;
    try {
      if (currentGeo && currentGeo.country) {
        const usual = await pool.query(
          `SELECT country, COUNT(*)::int AS cnt FROM login_history
           WHERE username = $1 AND success = true AND country IS NOT NULL
           GROUP BY country ORDER BY cnt DESC LIMIT 1`,
          [user.username]
        );
        const usualCountry = usual.rows[0]?.country || null;
        if (usualCountry && usualCountry !== currentGeo.country) {
          geoAlert = { country: currentGeo.country, city: currentGeo.city, usualCountry };
        }
      }
    } catch (e) {
      console.error('تعذّر تحديد الدولة المعتادة لهذا الحساب:', e);
    }
    const token = signToken(user);
    // نجاح كامل: تصفير عداد المحاولات الفاشلة وأي قفل مؤقت قائم لهذا الحساب.
    pool.query('UPDATE server_users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id])
      .catch(e => console.error('تعذّر تصفير عداد المحاولات الفاشلة:', e));
    // تسجيل عملية الدخول في سجل الدخول (best-effort — فشل هذا التسجيل لا يجب أن يمنع
    // المستخدم من الدخول فعلياً، لذا لا ننتظره ولا نُفشل الطلب لو حدث خطأ فيه).
    pool.query(
      'INSERT INTO login_history (username, role, ip_address, device_info, country, city) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.username, user.role || 'staff', loginIp, loginDevice, currentGeo?.country || null, currentGeo?.city || null]
    ).catch(e => console.error('تعذّر تسجيل عملية الدخول في السجل:', e));
    // نُرجع username و role صراحة في جسم الاستجابة، لأن الواجهة أصبحت تعتمد عليهما
    // مباشرة لتحديد صلاحيات المستخدم (admin/staff)، بدلاً من أي قائمة محلية داخل البرنامج.
    // الاستجابة تُرسل فوراً — بدون الانتظار في استعلام الأنشطة المشتبكة للمدراء.
    res.json({
      token,
      username: user.username,
      role: user.role || 'staff',
      user: { username: user.username, displayName: user.display_name, role: user.role || 'staff' },
      suspiciousAlert: [],
      lastLogin: lastLogin ? { at: lastLogin.logged_in_at, ip: lastLogin.ip_address, device: lastLogin.device_info } : null,
      newDeviceAlert: isNewDevice,
      geoAlert,
    });
    // تنبيه إيميل فقط للدخول غير المتعارف عليه (خارجي جديد): إذا كان الجهاز أو عنوان IP أو الدولة جديداً
    // — لو الجهاز/IP مسجّل من قبل لا يُرسل إشعار. best-effort: لا يُبطئ الاستجابة ولا يفشل الدخول.
    if (isNewDevice || isNewIp || geoAlert) {
      const reasonLines = [
        isNewDevice ? '<li>تسجيل دخول من جهاز/متصفح لم يُستخدم من قبل مع هذا الحساب</li>' : '',
        isNewIp ? `<li>تسجيل دخول من عنوان IP جديد غير مسجّل لهذا الحساب (${loginIp || 'غير معروف'})</li>` : '',
        geoAlert ? `<li>تسجيل دخول من دولة غير معتادة (${geoAlert.country || 'غير معروفة'}) بينما المعتاد هو ${geoAlert.usualCountry}</li>` : '',
      ].filter(Boolean).join('');
      alertAdmins(
        `دخول غير متعارف عليه للحساب "${user.username}"`,
        `<p>تم رصد دخول غير متعارف عليه للحساب <b>${user.username}</b> (${user.role || 'staff'}):</p>
         <ul>${reasonLines}</ul>
         <p style="color:#888; font-size:13px;">IP: ${loginIp || 'غير معروف'} — الوقت: ${new Date().toLocaleString('ar-EG')}</p>`
      ).catch(() => {});
    }
    // تنبيه استباقي للأدمن: لو فيه نشاط مشبوه (محاولات دخول مشبوهة) حصل منذ آخر مرة راجع
    // فيها شاشة "سجل الدخول"، نُرجعه على شاشة الإعدادات — لا نُبطئ تسجيل الدخول بفحصه
    // مباشرة في استجابة التركيب. يعمل الاستعلام وتحديث last_login_history_seen_at في الخلفية.
    setImmediate(() => {
      if ((user.role || 'staff') === 'admin') {
        const since = user.last_login_history_seen_at || new Date(Date.now() - 24 * 3600 * 1000);
        pool.query(
          `UPDATE server_users SET last_login_history_seen_at = now() WHERE id = $1`,
          [user.id]
        ).catch(e => console.error('تعذّر تحديث وقت آخر مراجعة لسجل الدخول:', e));
        pool.query(
          `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
           FROM login_history
           WHERE success = false AND logged_in_at > $1
           GROUP BY username, ip_address
           HAVING COUNT(*) >= 3
           ORDER BY failed_count DESC LIMIT 10`,
          [since]
        ).then(r => {
          // نُرسل إيميلاً فقط لو فيه صفوف جديدة فعلاً (تُكتشف أول مرة بعد هذا الدخول تحديداً)،
          // لتفادي إرسال نفس التنبيه بالإيميل مع كل دخول أدمن جديد طول ما نفس المحاولات قائمة.
          if (r.rows.length > 0) {
            const rows = r.rows.map(x => `<li>${x.username} من ${x.ip_address || 'IP غير معروف'} — ${x.failed_count} محاولة فاشلة</li>`).join('');
            alertAdmins('محاولات دخول فاشلة متكررة', `<p>تم رصد محاولات دخول فاشلة متكررة:</p><ul>${rows}</ul>`).catch(() => {});
          }
        }).catch(e => console.error('تعذّر فحص النشاط المشبوه:', e));
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

// POST /api/auth/logout -> إبطال فوري لكل توكنات هذا المستخدم (بما فيها التوكن
// المُستخدَم في هذا الطلب نفسه)، بدل الاكتفاء بمسح التوكن من المتصفح فقط.
router.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE id = $1', [req.user.sub]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تسجيل الخروج على الخادم' });
  }
});

/* ---------------- بث الأحداث اللحظية (SSE) ----------------
   اتصال يبقى مفتوحاً طوال الجلسة، يُخطِر كل الأجهزة المتصلة (أي دور) فوراً بأي تعديل/حذف/اعتماد
   يحدث من مستخدم آخر — بدل انتظار الفحص الدوري كل دقيقتين فى الواجهة. لا نستخدم requireAuth
   العادي هنا لأن EventSource فى المتصفح لا يدعم إرسال ترويسة Authorization إطلاقاً، فيصل نفس
   التوكن المعتاد عبر query string بدلاً من ذلك (نفس آلية resolveUserFromToken المستخدمة داخلياً
   فى requireAuth، فلا فرق فى قوة التحقق نفسها). خارج أي rate limiter لأنه اتصال واحد طويل لكل
   جهاز وليس سلسلة طلبات متكررة.
   ملاحظة: يظهر التوكن هنا فى الـ URL (سجلات الوصول المحتملة على السيرفر/الوسطاء) — تُقبَل هذه
   نقطة الضعف الصغيرة لأن SSE لا يدعم ترويسات أصلاً، وتوكن الجلسة نفسه (30 يوماً صلاحية) لا
   يتغيّر بذلك عن أي طلب GET آخر لو كان يُمرَّر بطريقة مشابهة. */
router.get('/api/events/stream', async (req, res) => {
  let user;
  try {
    user = await resolveUserFromToken(req.query.token);
  } catch (e) {
    return res.status(e.status || 401).end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // يمنع أي وسيط شبكي (proxy) يقف بين المتصفح والسيرفر من تخزين الاستجابة مؤقتاً بدل بثها
    // لحظياً — بدونه قد تصل الأحداث متأخرة أو دفعة واحدة بدل لحظياً حسب إعدادات الوسيط.
    'X-Accel-Buffering': 'no',
  });
  // تعطيل خوارزمية Nagle على هذا الاتصال تحديداً: بدونها، Node/TCP قد يؤخر إرسال حزم صغيرة
  // (مثل نبضة الحياة أو حدث تغيير واحد) بضع مئات المللي ثانية أملاً فى تجميعها مع بيانات أخرى —
  // تأخير غير مقبول لقناة الغرض الوحيد منها السرعة اللحظية.
  try { req.socket.setNoDelay(true); } catch (e) {}
  res.flushHeaders();
  res.write(': connected\n\n');
  const clientId = addSseClient(res, user);
  req.on('close', () => removeSseClient(clientId));
});

/* ---------------- إدارة المستخدمين (للمدير admin فقط) ----------------
   بديل عن تشغيل seed-user.js يدوياً من الطرفية في كل مرة — نفس المنطق بالضبط لكن عبر API
   محمي بـ requireRole('admin') على مستوى الخادم نفسه (مش مجرد إخفاء زر في الواجهة). */
const VALID_SERVER_ROLES = ['admin', 'accountant', 'reception', 'staff'];

// GET /api/users -> قائمة المستخدمين (بدون كلمات المرور المشفّرة أبداً)
router.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, display_name, role, is_active, email, created_at FROM server_users ORDER BY created_at ASC'
    );
    res.json({ users: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة المستخدمين' });
  }
});

// GET /api/users/reception -> قائمة مختصرة (اسم المستخدم + الاسم الظاهر فقط) بموظفي دور الاستقبال حصراً،
// متاحة للمدير والمحاسب معاً (على عكس /api/users الكاملة المقصورة على المدير فقط) — تُستخدم فقط لتعبئة
// فلتر "موظفي الاستقبال" في شيت العملاء وشيت الحركات المالية، ولا تُرجع أي بيانات حساسة أخرى.
router.get('/api/users/reception', requireAuth, requireRole('admin', 'accountant'), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT username, display_name FROM server_users WHERE role = 'reception' ORDER BY created_at ASC"
    );
    res.json({ users: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب قائمة موظفي الاستقبال' });
  }
});

// POST /api/users  body: { username, password, displayName, role, email } -> إنشاء مستخدم جديد أو تحديث كلمة مرور/صلاحية مستخدم موجود
router.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, displayName, role, email } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'اسم المستخدم مطلوب' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 6 أحرف' });
  const finalRole = VALID_SERVER_ROLES.includes(role) ? role : 'staff';
  const finalEmail = (email || '').trim() || null;
  try {
    const hash = await hashPassword(password);
    const r = await pool.query(
      `INSERT INTO server_users (username, password_hash, display_name, role, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         display_name = COALESCE(EXCLUDED.display_name, server_users.display_name),
         role = EXCLUDED.role,
         email = COALESCE(EXCLUDED.email, server_users.email),
         token_version = server_users.token_version + 1
       RETURNING id, username, display_name, role, email, created_at`,
      [username.trim(), hash, displayName || username.trim(), finalRole, finalEmail]
    );
    res.json({ user: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حفظ المستخدم' });
  }
});

// DELETE /api/users/:username -> حذف مستخدم (لا يمكن للمدير حذف حسابه الحالي بنفسه لتفادي فقدان الوصول بالخطأ)
router.delete('/api/users/:username', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    await pool.query('DELETE FROM server_users WHERE username = $1', [target]);
    res.json({ username: target, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر حذف المستخدم' });
  }
});

// GET /api/login-history -> آخر عمليات الدخول (ناجحة وفاشلة) لكل المستخدمين (admin فقط)، بالإضافة
// لملخص "نشاط مشبوه" (تجميع محاولات فاشلة حسب اسم المستخدم/الـ IP خلال آخر ساعة)، حتى يلاحظ
// المدير أي محاولات دخول غير مصرّح بها لم تصل لحد rate limiting نفسه (محاولات متفرقة بطيئة).
router.get('/api/login-history', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT username, role, ip_address, device_info, logged_in_at, success FROM login_history ORDER BY logged_in_at DESC LIMIT 300'
    );
    const suspicious = await pool.query(
      `SELECT username, ip_address, COUNT(*)::int AS failed_count, MAX(logged_in_at) AS last_attempt
       FROM login_history
       WHERE success = false AND logged_in_at > now() - INTERVAL '1 hour'
       GROUP BY username, ip_address
       HAVING COUNT(*) >= 3
       ORDER BY failed_count DESC`
    );
    // تسجيل أن هذا الأدمن راجع الشاشة الآن — يمنع تكرار نفس التنبيه الاستباقي عند دخوله لاحقاً
    // لو مفيش نشاط جديد بعد هذه اللحظة.
    pool.query('UPDATE server_users SET last_login_history_seen_at = now() WHERE username = $1', [req.user.username])
      .catch(e => console.error('تعذّر تحديث وقت آخر مراجعة لسجل الدخول:', e));
    res.json({ history: r.rows, suspiciousActivity: suspicious.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر جلب سجل الدخول' });
  }
});

// POST /api/users/:username/force-logout -> تسجيل خروج فوري لهذا المستخدم من كل الأجهزة/الجلسات
// دفعة واحدة (عبر زيادة token_version، بنفس آلية /api/auth/logout الحالية)، بدون حاجة لكلمة مروره.
router.post('/api/users/:username/force-logout', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  try {
    const r = await pool.query('UPDATE server_users SET token_version = token_version + 1 WHERE username = $1 RETURNING username', [target]);
    if (!r.rows[0]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ username: target, loggedOut: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر إنهاء جلسات هذا المستخدم' });
  }
});

// POST /api/users/:username/toggle-active -> تعطيل/تفعيل حساب مستخدم (بدون حذفه).
// عند التعطيل: يُرفض دخوله فوراً من الآن فصاعداً، وأي جلسة مفتوحة له حالياً تُقطع
// فوراً أيضاً (نزيد token_version بنفس آلية force-logout، بالإضافة لتحقق is_active
// في requireAuth). لا يمكن للمدير تعطيل حسابه الحالي بنفسه لتفادي فقدان الوصول بالخطأ.
router.post('/api/users/:username/toggle-active', requireAuth, requireRole('admin'), async (req, res) => {
  const target = req.params.username;
  if (target === req.user.username) {
    return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الحالي وأنت مسجّل دخول به' });
  }
  try {
    const r = await pool.query(
      `UPDATE server_users
       SET is_active = NOT is_active, token_version = token_version + 1
       WHERE username = $1
       RETURNING username, is_active`,
      [target]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json({ username: r.rows[0].username, isActive: r.rows[0].is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'تعذّر تغيير حالة المستخدم' });
  }
});

/* ---------------- التحقق من كود الترخيص (لا يتطلب تسجيل دخول) ---------------- */
// ربط الترخيص بالجهاز: عند كل تحقق ناجح، نقارن IP الاتصال الحالي (يُحسب من الاتصال نفسه على
// السيرفر تماماً كما فى تسجيل الدخول أعلاه، وليس من أي رأس يمكن للعميل تزييفه) وبصمة الجهاز
// (deviceFingerprint، مُشتقة على الفرونت-إند من خصائص العتاد/المتصفح الفعلية عبر Web Crypto،
// وليست قيمة مخزَّنة فى كاش المتصفح) بالقيم المرتبطة أصلاً بهذا الترخيص (clientId). أول تحقق
// ناجح لأي clientId يُسجَّل كـ"الجهاز الأصلي" تلقائياً. أي اختلاف لاحق (IP أو بصمة أو الاثنين)
// يُسجَّل فى license_activity ويُرسَل تنبيه بالإيميل للإدارة فقط — best-effort بالكامل، لا يمنع
// التحقق من النجاح إطلاقاً حتى لو فشل أي جزء من هذا المنطق.
router.post('/api/license/validate', licenseLimiter, async (req, res) => {
  const { licenseKey, deviceFingerprint } = req.body || {};
  const result = validateLicenseKey(licenseKey);
  if (!result.valid || !result.clientId) {
    return res.json(result);
  }
  try {
    const ip = (req.ip || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const fp = (deviceFingerprint || '').toString().slice(0, 200);
    const existing = await pool.query(
      'SELECT bound_ip, bound_fingerprint FROM license_bindings WHERE client_id = $1',
      [result.clientId]
    );
    let isNewIp = false, isNewDevice = false;
    if (existing.rows[0]) {
      const bound = existing.rows[0];
      isNewIp = !!(ip && bound.bound_ip && ip !== bound.bound_ip);
      isNewDevice = !!(fp && bound.bound_fingerprint && fp !== bound.bound_fingerprint);
      await pool.query(
        'UPDATE license_bindings SET last_ip = $2, last_fingerprint = $3, last_seen_at = now() WHERE client_id = $1',
        [result.clientId, ip, fp]
      );
    } else {
      // أول تحقق ناجح لهذا الترخيص على الإطلاق — يُسجَّل كـ"الجهاز الأصلي" المرجعي.
      await pool.query(
        `INSERT INTO license_bindings (client_id, bound_ip, bound_fingerprint, last_ip, last_fingerprint)
         VALUES ($1, $2, $3, $2, $3)
         ON CONFLICT (client_id) DO NOTHING`,
        [result.clientId, ip, fp]
      );
    }
    if (isNewIp || isNewDevice) {
      const geo = await geolocateIp(ip);
      pool.query(
        `INSERT INTO license_activity (client_id, ip_address, device_fingerprint, country, city, is_new_ip, is_new_device)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [result.clientId, ip, fp, geo?.country || null, geo?.city || null, isNewIp, isNewDevice]
      ).catch(e => console.error('تعذّر تسجيل نشاط ربط الترخيص:', e));
      const reasonLines = [
        isNewIp ? '<li>تحقق من الترخيص من عنوان IP مختلف عن الجهاز المرتبط به أصلاً</li>' : '',
        isNewDevice ? '<li>تحقق من الترخيص من بصمة جهاز مختلفة عن الجهاز المرتبط به أصلاً</li>' : '',
      ].filter(Boolean).join('');
      alertAdmins(
        `استخدام الترخيص من جهاز/موقع مختلف (${result.clientId})`,
        `<p>تم رصد ما يلي عند التحقق من كود الترخيص الخاص بـ <b>${result.clientId}</b>:</p>
         <ul>${reasonLines}</ul>
         <p style="color:#888; font-size:13px;">IP: ${ip || 'غير معروف'}${geo?.country ? ` (${geo.city ? geo.city + '، ' : ''}${geo.country})` : ''} — الوقت: ${new Date().toLocaleString('ar-EG')}</p>`
      ).catch(() => {});
    }
  } catch (e) {
    // فشل منطق الربط لا يجب أبداً أن يمنع تحقق ترخيص صحيح من النجاح.
    console.error('تعذّر التحقق من ربط الترخيص بالجهاز:', e);
  }
  res.json(result);
});

module.exports = router;
