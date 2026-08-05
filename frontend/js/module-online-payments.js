/* ============================================================
   الدفع الإلكتروني (مدى/فيزا عبر Moyasar) — طرف الواجهة
   ============================================================
   السيرفر لا يملك مفتاح تشفير البيانات، فلا يقدر يكتب حركة خزنة بنفسه.
   بدل كده: أي جهاز فيه مستخدم مسجّل دخول يسأل دورياً عن الدفعات اللي
   نجحت فعلياً (status='paid') ولسه محدّش طبّقها، وينشئ منها حركة خزنة
   عادية (نفس شكل أي حركة يدوية) ويشفّرها ويحفظها بالطريقة المعتادة،
   ثم يبلّغ السيرفر إنها اتطبّقت حتى لا يكررها جهاز تاني.
*/

/** إنشاء رابط دفع جديد لعميل — يُستدعى من زر في شاشة العميل/الخزنة. */
async function createOnlinePaymentLink(clientId, clientName, amount, description) {
  try {
    const res = await serverFetch('/api/payments/create-link', {
      method: 'POST',
      body: JSON.stringify({
        clientRef: clientId || '',
        clientLabel: clientName || '',
        amount: num(amount),
        description: description || `دفعة — ${clientName || ''}`,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'تعذّر إنشاء رابط الدفع');
      return null;
    }
    const data = await res.json();
    return data; // { id, checkoutUrl, gatewayId }
  } catch (e) {
    showToast('تعذّر الاتصال بالسيرفر لإنشاء رابط الدفع');
    return null;
  }
}

/** ينشئ حركة خزنة محلية من دفعة إلكترونية مؤكدة، بنفس شكل حركة يدوية عادية. */
function buildVaultTxFromOnlinePayment(p) {
  return {
    id: uid(), seq: allocVaultSeq('vault'), createdAt: Date.now(),
    type: 'in', isReturn: false, date: todayISO(), amount: num(p.amount),
    method: 'network', notes: (p.description ? p.description + ' — ' : '') + 'دفع إلكتروني (مدى/فيزا)',
    clientId: p.client_ref || '', clientName: p.client_label || '', manual: '', category: '',
    recipientName: '', referenceNo: p.gateway_id || p.id, destination: 'vault', networkInvoice: '',
  };
}

let _applyingOnlinePayments = false;
/** يفحص الدفعات المعلّقة ويطبّقها محلياً. آمن للاستدعاء المتكرر (single-flight). */
async function applyPendingOnlinePayments() {
  if (_applyingOnlinePayments) return false;
  if (typeof manualOfflineMode !== 'undefined' && manualOfflineMode) return false;
  _applyingOnlinePayments = true;
  try {
    const res = await serverFetch('/api/payments/pending');
    if (!res.ok) return false;
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return false;

    let anyApplied = false;
    for (const p of list) {
      if (typeof isDateLocked === 'function' && isDateLocked(todayISO())) continue; // الشهر مقفل — تبقى معلّقة لحين فتحه
      snapshotState(`تسجيل دفعة إلكترونية: ${p.client_label || p.id}`);
      const tx = buildVaultTxFromOnlinePayment(p);
      vaultTx.push(tx);
      try {
        const ackRes = await serverFetch(`/api/payments/${p.id}/ack`, { method: 'POST' });
        if (!ackRes.ok) {
          // جهاز آخر سبقنا بتطبيقها — تراجع عن الحركة المحلية لتفادي التكرار.
          vaultTx.pop();
          continue;
        }
      } catch (e) {
        vaultTx.pop();
        continue;
      }
      anyApplied = true;
      await logAudit('add', 'الحركات المالية', `دفعة إلكترونية تلقائية رقم تسلسلي #${tx.seq || '—'} بمبلغ ${fmt(num(tx.amount))}`);
    }
    if (anyApplied) await saveVaultTx();
    return anyApplied;
  } catch (e) {
    return false;
  } finally {
    _applyingOnlinePayments = false;
  }
}

// فحص دوري كل 45 ثانية طالما البرنامج مفتوح، بالإضافة لفحص فوري عند كل renderVault
// (نفس نمط runDueScheduledVaultTx الموجود مسبقاً في module-finance.js).
if (typeof window !== 'undefined') {
  setInterval(() => { applyPendingOnlinePayments().then(applied => { if (applied && typeof renderVault === 'function') renderVault(); }); }, 45000);
}
