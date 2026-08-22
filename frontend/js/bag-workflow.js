/* FTC2 — Bag workflow business rules
   This module does not replace the existing bag/inventory/accounting engine.
   It provides one normalized vocabulary for the three real business cases:
   1) trainee supplied their own bag;
   2) center received the bag amount and still needs to purchase it;
   3) center purchased the bag and the purchase is completed.
*/
(function(global){
  'use strict';

  const SOURCES = Object.freeze({
    TRAINEE: 'trainee',
    CENTER: 'center',
    STOCK: 'stock'
  });

  const STATES = Object.freeze({
    NOT_REQUIRED: 'not_required',
    TRAINEE_SUPPLIED: 'trainee_supplied',
    PAYMENT_PENDING_PURCHASE: 'payment_pending_purchase',
    PURCHASED: 'purchased'
  });

  function normalizeSource(value){
    const v = String(value || '').trim().toLowerCase();
    if(v === 'stock') return SOURCES.STOCK;
    if(v === 'buy' || v === 'center' || v === 'centre') return SOURCES.CENTER;
    if(v === 'trainee' || v === 'client' || v === 'own') return SOURCES.TRAINEE;
    return '';
  }

  function normalizeState(client){
    const c = client || {};
    const source = normalizeSource(c.bagSource);

    if(c.bagRequired === false) return STATES.NOT_REQUIRED;
    if(source === SOURCES.TRAINEE) return STATES.TRAINEE_SUPPLIED;
    if(source === SOURCES.STOCK) return STATES.PURCHASED;
    if(source === SOURCES.CENTER && c.bagStatus === 'purchased') return STATES.PURCHASED;
    if(source === SOURCES.CENTER) return STATES.PAYMENT_PENDING_PURCHASE;
    return '';
  }

  function accountingClassification(client){
    const state = normalizeState(client);
    switch(state){
      case STATES.TRAINEE_SUPPLIED:
        return { category:'bag', cashFlow:'none', centerPurchase:false, traineeReceivable:false };
      case STATES.PAYMENT_PENDING_PURCHASE:
        return { category:'bag', cashFlow:'customer_collection', centerPurchase:false, traineeReceivable:false };
      case STATES.PURCHASED:
        return { category:'bag', cashFlow:'supplier_payment', centerPurchase:true, traineeReceivable:false };
      default:
        return { category:'none', cashFlow:'none', centerPurchase:false, traineeReceivable:false };
    }
  }

  function displayLabel(client){
    switch(normalizeState(client)){
      case STATES.TRAINEE_SUPPLIED: return 'المتدرب أحضر الحقيبة';
      case STATES.PAYMENT_PENDING_PURCHASE: return 'مدفوعة — بانتظار شراء الحقيبة';
      case STATES.PURCHASED: return 'تم شراء الحقيبة';
      case STATES.NOT_REQUIRED: return 'غير مطلوبة';
      default: return 'غير محددة';
    }
  }

  global.FTCBagWorkflow = Object.freeze({
    SOURCES,
    STATES,
    normalizeSource,
    normalizeState,
    accountingClassification,
    displayLabel
  });
})(window);
