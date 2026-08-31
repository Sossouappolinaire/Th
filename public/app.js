// app.js
// Gère la soumission du formulaire, puis suit (polling) l'état du transfert
// jusqu'à confirmation. N'appelle jamais SebPay directement : passe toujours
// par notre backend (/api/transfer), qui seul détient les clés API.

const form = document.getElementById('transfer-form');
const submitBtn = document.getElementById('submit-btn');
const messageBox = document.getElementById('message');
const summaryBox = document.getElementById('summary');

function showMessage(text, type) {
  messageBox.textContent = text;
  messageBox.className = `message message--${type}`;
}

function formatOperator(op) {
  return op === 'mtn' ? 'MTN' : op === 'moov' ? 'Moov' : op || '—';
}

function formatAmount(amount) {
  return `${Number(amount).toLocaleString('fr-FR')} FCFA`;
}

/** Affiche le résumé détaillé (référence, montant, numéros, ids de
 * transaction) une fois le transfert terminé (réussi, échoué ou remboursé). */
function showSummary(transfer) {
  if (!transfer) {
    summaryBox.innerHTML = '';
    return;
  }

  const rows = [
    ['Référence', transfer.reference],
    ['Statut', transfer.status],
    ['Expéditeur', `${transfer.senderPhone || '—'} (${formatOperator(transfer.senderOperator)})`],
    ['Destinataire', `${transfer.receiverPhone || '—'} (${formatOperator(transfer.receiverOperator)})`],
    ['Montant', formatAmount(transfer.amount)],
    ['Réf. collecte', transfer.collectionTransactionId || '—'],
    ['Réf. décaissement', transfer.payoutTransactionId || '—'],
  ];

  summaryBox.innerHTML = rows
    .map(
      ([label, value]) =>
        `<li><span class="k">${label}</span><span class="v">${String(value).replace(/</g, '&lt;')}</span></li>`
    )
    .join('');
}

function isValidBeninPhone(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('229')) digits = digits.slice(3);
  // Ancien format (8 chiffres) ou nouveau format depuis le 30/11/2024 (01 + 8 chiffres)
  return digits.length === 8 || (digits.length === 10 && digits.startsWith('01'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTransfer(reference, { intervalMs = 3000, timeoutMs = 120000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`/api/transfer/${encodeURIComponent(reference)}`);
    const data = await response.json();

    if (data.success) {
      const { status, message } = data.transfer;
      showMessage(message, status === 'failed' ? 'error' : 'success');
      if (status === 'completed' || status === 'failed') {
        showSummary(data.transfer);
        return status;
      }
    }
    await sleep(intervalMs);
  }

  showMessage("Délai dépassé. Vérifiez le statut plus tard.", 'error');
  return 'timeout';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  messageBox.className = 'message';
  showSummary(null);

  const senderOperator = document.getElementById('senderOperator').value;
  const senderPhone = document.getElementById('senderPhone').value.trim();
  const receiverOperator = document.getElementById('receiverOperator').value;
  const receiverPhone = document.getElementById('receiverPhone').value.trim();
  const amount = document.getElementById('amount').value.trim();

  if (!isValidBeninPhone(senderPhone) || !isValidBeninPhone(receiverPhone)) {
    showMessage('Veuillez saisir des numéros béninois valides (8 chiffres).', 'error');
    return;
  }

  if (!amount || Number(amount) <= 0) {
    showMessage('Veuillez saisir un montant valide.', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Envoi en cours...';

  try {
    const response = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderOperator, senderPhone, receiverOperator, receiverPhone, amount }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showMessage(data.message || 'Le transfert a échoué.', 'error');
      return;
    }

    showMessage(data.message || 'Collecte initiée, validez sur votre téléphone.', 'success');
    const finalStatus = await pollTransfer(data.reference);

    if (finalStatus === 'completed') {
      form.reset();
    }
  } catch (err) {
    showMessage('Erreur réseau. Veuillez réessayer.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Envoyer';
  }
});
