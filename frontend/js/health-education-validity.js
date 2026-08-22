/* ============================================================================
   FTC2 — Health Education Validity
   ---------------------------------------------------------------------------
   Business rule:
   - Course duration = actual training duration (for example: 2 days).
   - Health education validity = 3 years starting from the course start date.
   - The validity period is NOT the course duration.
   - When the 3-year validity ends, the trainee needs a new course.

   This module is intentionally additive and dependency-free. It does not
   change the existing course/bag/accounting logic until the UI/data layer is
   explicitly wired to it.
   ============================================================================ */

(function(global){
  'use strict';

  const VALIDITY_YEARS = 3;
  const MS_PER_DAY = 86400000;

  function toDate(value){
    if(!value) return null;
    if(value instanceof Date){
      const d = new Date(value.getTime());
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(value).trim();
    if(!s) return null;
    const d = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function isoDate(d){
    if(!d || Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  /*
   * Inclusive validity rule:
   * start 2026-01-10 -> expiry 2029-01-09.
   * This keeps the validity at exactly three calendar years while making the
   * last valid day the day before the anniversary.
   */
  function calculateExpiry(startDate, years = VALIDITY_YEARS){
    const start = toDate(startDate);
    if(!start) return '';
    const anniversary = new Date(start.getTime());
    anniversary.setFullYear(anniversary.getFullYear() + Number(years || VALIDITY_YEARS));
    anniversary.setDate(anniversary.getDate() - 1);
    return isoDate(anniversary);
  }

  function daysRemaining(expiryDate, today = new Date()){
    const expiry = toDate(expiryDate);
    const now = toDate(today);
    if(!expiry || !now) return null;
    const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const b = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
    return Math.floor((b - a) / MS_PER_DAY);
  }

  function status(expiryDate, today = new Date(), warningDays = 90){
    const remaining = daysRemaining(expiryDate, today);
    if(remaining === null) return 'unknown';
    if(remaining < 0) return 'expired';
    if(remaining <= Number(warningDays)) return 'expiring';
    return 'valid';
  }

  function statusLabel(expiryDate, today = new Date(), warningDays = 90){
    const s = status(expiryDate, today, warningDays);
    return {
      valid: 'ساري',
      expiring: 'ينتهي قريباً',
      expired: 'منتهي — يحتاج دورة جديدة',
      unknown: 'غير محدد'
    }[s];
  }

  function buildRecord(courseStartDate, options = {}){
    const start = isoDate(toDate(courseStartDate));
    return {
      validityType: 'health_education',
      validityYears: Number(options.validityYears || VALIDITY_YEARS),
      validityStartDate: start,
      validityEndDate: calculateExpiry(start, options.validityYears || VALIDITY_YEARS),
      sourceCourseId: options.sourceCourseId || '',
      sourceCourseNumber: options.sourceCourseNumber || '',
      sourceCourseType: options.sourceCourseType || '',
      status: status(calculateExpiry(start, options.validityYears || VALIDITY_YEARS)),
      renewedFromId: options.renewedFromId || '',
      createdAt: options.createdAt || Date.now()
    };
  }

  /*
   * Returns a new validity record without mutating the old course record.
   * This is important when a trainee takes another course after three years:
   * the old validity remains in history and the new one becomes a new record.
   */
  function renew(previousRecord, newCourseStartDate, options = {}){
    return buildRecord(newCourseStartDate, {
      ...options,
      renewedFromId: previousRecord?.id || previousRecord?.validityId || ''
    });
  }

  global.FTCHealthEducation = Object.freeze({
    VALIDITY_YEARS,
    calculateExpiry,
    daysRemaining,
    status,
    statusLabel,
    buildRecord,
    renew
  });

})(window);
