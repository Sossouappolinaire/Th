// success.js
// Cette page n'affiche JAMAIS "transfert réussi" sur la seule foi de l'URL :
// elle revérifie toujours l'état réel du transfert auprès de notre backend
// (/api/transfer/:id), qui lui-même ne passe à "completed" qu'après avoir
// reçu la confirmation du webhook payout de SebPay (signature HMAC
// vérifiée). Impossible donc d'afficher un faux succès en tapant l'URL à la main.

const statusRing = document.getElementById('status-ring');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const summaryPhone = document.getElementById('summary-phone');
const summaryNetwork = document.getElementById('summary-network');
const summaryAmount = document.getElementById('summary-amount');
const summaryToken = document.getElementById('summary-token');

function showError(message) {
  statusRing.className = 'status__ring is-failed';
  statusIcon.textContent = '✕';
  statusTitle.textContent = 'Impossible d\'afficher ce transfert';
  statusMessage.textContent = message;
}

async function loadTransfer() {
  const params = new URLSearchParams(window.location.search);
  const transferId = params.get('transferId');

  if (!transferId) {
    window.location.href = '/';
    return;
  }

  try {
    const response = await fetch(`/api/transfer/${encodeURIComponent(transferId)}`);
    const data = await response.json();

    if (!data.success) {
      showError('Ce transfert est introuvable. Il a peut-être expiré.');
      return;
    }

    const { stage, message, recipient } = data.transfer;

    if (recipient) {
      summaryPhone.textContent = recipient.phone;
      summaryNetwork.textContent = `${recipient.networkName} — ${recipient.countryName}`;
      summaryAmount.textContent = `${recipient.amount} ${recipient.currency}`.trim();
    }
    summaryToken.textContent = transferId;

    if (stage === 'completed') {
      statusTitle.textContent = 'Transfert réussi';
      statusMessage.textContent = message || 'Le destinataire a bien été crédité.';
      return;
    }

    // Le transfert n'est pas (encore, ou plus) confirmé "completed" : on
    // renvoie vers la page principale, qui sait suivre payin_pending /
    // payout_pending / payin_failed / payout_failed en direct.
    window.location.href = `/?transferId=${encodeURIComponent(transferId)}`;
  } catch (err) {
    showError('Erreur réseau. Vérifiez votre connexion et réessayez.');
  }
}

loadTransfer();
