# المرحلة 0 — شبكة الأمان (النسخ الاحتياطي المشفر + القياس)

## ما الذي أُضيف
| الملف | الوظيفة |
|---|---|
| `.github/workflows/db-backup.yml` | نسخة مرتين أسبوعياً (الأحد والخميس 01:30 UTC — لتوفير حصة نقل البيانات 5GB في Neon المجاني) من Neon ← استرجاع تجريبي + مطابقة الصفوف ← تشفير age ← حفظ كـ GitHub Artifact (90 يوماً) ← رفع اختياري لتخزين S3 خارجي لو أُضيفت أسراره |
| `server/scripts/storage-baseline.js` | قياس حجم الجداول والـ collections (قراءة فقط) |
| `server/metrics.js` | عدّ تعارضات 409 في اللوج (بلا تغيير في أي استجابة) |
| `server/tests/storage-phase0.test.js` | اختبارات + حواجز على الـ workflow |

## إعداد لمرة واحدة
1. **مفتاح age** (المفتاح الخاص يُحفظ خارج GitHub في مكانين؛ ضياعه = ضياع القدرة على فك كل النسخ):
   ```
   age-keygen -o ftc2-backup-key.txt
   ```
   السطر `# public key: age1...` هو `AGE_PUBLIC_KEY`.
2. **Secrets** في GitHub (Settings → Secrets and variables → Actions) — اثنان فقط:
   `DATABASE_URL` (يُفضّل role قراءة فقط في Neon) و`AGE_PUBLIC_KEY`.
3. شغّل الـ workflow يدوياً (Actions ← DB Backup (encrypted) ← Run workflow). النسخة تظهر أسفل صفحة التشغيل في قسم **Artifacts**.
   - لو إصدار Postgres في Neon غير 18: اضبط Variable باسم `PG_MAJOR`.
4. **اختياري**: تخزين خارجي إضافي (Cloudflare R2 أو Backblaze B2): أضف `R2_ACCOUNT_ID` و`R2_ACCESS_KEY_ID` و`R2_SECRET_ACCESS_KEY` و`R2_BUCKET` فيُفعَّل الرفع والاحتفاظ تلقائياً.

> ملاحظة: الريبو عام، فالـ Artifacts قابلة للتنزيل من أي حساب GitHub مسجّل؛ المحتوى مشفّر بـ age فلا يُقرأ بدون المفتاح الخاص، لكن حجم الملف وتوقيته ظاهران.

## استرجاع نسخة (اختبره مرة قبل ما تحتاجه)
```
# نزّل الـ Artifact من صفحة التشغيل في GitHub (أو من S3 لو مفعّل) ثم:
sha256sum -c ftc2-STAMP.dump.age.sha256
age -d -i ftc2-backup-key.txt ftc2-STAMP.dump.age > ftc2.dump
pg_restore --no-owner --no-privileges -d "<رابط فرع staging>" ftc2.dump
```
**لا تسترجع على الإنتاج مباشرة** — دائماً على فرع Neon منفصل أولاً.

## بيئة staging (Neon Branching)
أنشئ فرعاً من الإنتاج باسم `staging` (Neon Console ← Branches ← Create). كل مرحلة قادمة تُجرَّب عليه أولاً بـ `DATABASE_URL` الخاص به. يُعاد إنشاء الفرع من الإنتاج قبل كل مرحلة.

## خط الأساس (نفّذه قبل المرحلة 1)
```
cd server
DATABASE_URL="<الإنتاج>" node scripts/storage-baseline.js --out baseline-before.json
```
احتفظ بالملف؛ بعد كل مرحلة شغّل الأمر بـ `--out baseline-after-N.json` وقارن (`compareSnapshots`).

**تعارضات 409**: بعد النشر يظهر في لوج Render سطر لكل تعارض:
`[metric] conflict409 route="PUT /api/client-records/:id" total=N`
عدّها أسبوعاً كاملاً قبل المرحلة 4: `grep -c "conflict409"`. (العدّاد يتصفّر مع إعادة تشغيل العملية.)

## معيار إنجاز المرحلة 0
- [ ] workflow النسخ الاحتياطي نجح يدوياً وظهر الملف `.age` في Artifacts
- [ ] استرجاع كامل نجح على فرع staging بمفتاح age
- [ ] `baseline-before.json` محفوظ
- [ ] أسبوع من عدّ الـ 409 قبل بدء المرحلة 4

## الرجوع
المرحلة إضافية بالكامل: لا تغيّر البيانات ولا الواجهة. للإلغاء: عطّل الـ workflow؛ ولإزالة العدّاد احذف سطر `conflictLogger` من `server.js`.
