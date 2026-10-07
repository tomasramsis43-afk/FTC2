# المرحلة 0 — شبكة الأمان (النسخ الاحتياطي المشفر + القياس)

## ما الذي أُضيف
| الملف | الوظيفة |
|---|---|
| `.github/workflows/db-backup.yml` | نسخة ليلية (01:30 UTC) من Neon ← استرجاع تجريبي + مطابقة الصفوف ← تشفير age ← رفع R2 ← احتفاظ 30 يوماً (حد أدنى 7) |
| `server/scripts/storage-baseline.js` | قياس حجم الجداول والـ collections (قراءة فقط) |
| `server/metrics.js` | عدّ تعارضات 409 في اللوج (بلا تغيير في أي استجابة) |
| `server/tests/storage-phase0.test.js` | اختبارات + حواجز على الـ workflow |

## إعداد لمرة واحدة (أنت)
1. **R2**: أنشئ bucket (مثلاً `ftc2-backups`) ثم API Token بصلاحية Object Read & Write على هذا الـ bucket فقط.
2. **مفتاح age** على جهازك (ليس على GitHub):
   ```
   age-keygen -o ftc2-backup-key.txt
   ```
   السطر `# public key: age1...` هو `AGE_PUBLIC_KEY`. احفظ الملف نفسه في مكانين خارج الريبو (مدير كلمات مرور + نسخة غير متصلة). **ضياعه = ضياع القدرة على فك كل النسخ.**
3. **Secrets** في GitHub (Settings → Secrets and variables → Actions):
   `DATABASE_URL` (يُفضّل role قراءة فقط في Neon)، `AGE_PUBLIC_KEY`، `R2_ACCOUNT_ID`، `R2_ACCESS_KEY_ID`، `R2_SECRET_ACCESS_KEY`، `R2_BUCKET`.
4. شغّل الـ workflow يدوياً (Actions ← DB Backup (encrypted) ← Run workflow) وتأكد إن كل الخطوات خضراء.
   - لو إصدار Postgres في Neon غير 17: اضبط Variable باسم `PG_MAJOR`.

## استرجاع نسخة (اختبره مرة قبل ما تحتاجه)
```
aws s3 cp s3://BUCKET/db-backups/ftc2-STAMP.dump.age . --endpoint-url https://ACCOUNT.r2.cloudflarestorage.com
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
- [ ] workflow النسخ الاحتياطي نجح يدوياً وظهر الملف `.age` في R2
- [ ] استرجاع كامل نجح على فرع staging بمفتاح age
- [ ] `baseline-before.json` محفوظ
- [ ] أسبوع من عدّ الـ 409 قبل بدء المرحلة 4

## الرجوع
المرحلة إضافية بالكامل: لا تغيّر البيانات ولا الواجهة. للإلغاء: عطّل الـ workflow؛ ولإزالة العدّاد احذف سطر `conflictLogger` من `server.js`.
