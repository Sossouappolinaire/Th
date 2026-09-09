// success.js
// Reçu imprimé du transfert.
// Cette page n'affiche JAMAIS "transfert réussi" sur la seule foi de l'URL :
// elle revérifie toujours l'état réel du transfert auprès de notre backend
// (/api/transfer/:id), qui lui-même ne passe à "completed" qu'après avoir
// reçu la confirmation du webhook payout de SebPay (signature HMAC
// vérifiée). Impossible donc d'afficher un faux reçu en tapant l'URL à la main.

const screenEl = document.getElementById('printer-screen');
const receiptEl = document.getElementById('receipt');
const stampEl = document.getElementById('r-stamp');
const printBtn = document.getElementById('print-btn');

const set = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
};

function showError(message) {
  screenEl.textContent = 'Erreur';
  stampEl.textContent = 'REÇU INDISPONIBLE';
  stampEl.style.color = '#e5484d';
  stampEl.style.borderColor = '#e5484d';
  set('r-ref', '—');
  set('r-date', new Date().toLocaleString('fr-FR'));
  set('r-sender', message);
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  return `${value.toLocaleString('fr-FR')} ${currency || ''}`.trim();
}

function formatPhone(phone) {
  return phone ? String(phone).replace(/(\d{2})(?=\d)/g, '$1 ').trim() : '—';
}

async function loadTransfer() {
  const params = new URLSearchParams(window.location.search);
  const transferId = params.get('transferId');

  // Aperçu du reçu (démo) : /success.html?demo=1 — aucune donnée réelle.
  if (params.get('demo') === '1') {
    screenEl.textContent = 'Aperçu du reçu';
    set('r-ref', 'DEMO-0001');
    set('r-date', new Date().toLocaleString('fr-FR'));
    set('r-sender', 'Jean Dupont');
    set('r-sender-phone', formatPhone('97000000'));
    set('r-sender-network', 'MTN MoMo');
    set('r-recipient', 'Awa Diallo');
    set('r-recipient-phone', formatPhone('77000000'));
    set('r-recipient-network', 'Wave');
    set('r-country', 'Sénégal');
    set('r-amount', formatMoney(25000, 'XOF'));
    set('r-fees', '0 XOF');
    set('r-total', formatMoney(25000, 'XOF'));
    stampEl.textContent = 'APERÇU — DÉMO';
    return;
  }

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

    const { stage, sender, recipient, createdAt } = data.transfer;

    if (stage !== 'completed') {
      // Pas (encore, ou plus) confirmé : la page principale sait suivre
      // collection_pending / payout_pending / échecs en direct.
      window.location.href = `/?transferId=${encodeURIComponent(transferId)}`;
      return;
    }

    screenEl.textContent = 'Reçu imprimé ✓';

    set('r-ref', transferId);
    set('r-date', new Date(createdAt || Date.now()).toLocaleString('fr-FR'));

    if (sender) {
      set('r-sender', sender.name || '—');
      set('r-sender-phone', formatPhone(sender.phone));
      set('r-sender-network', sender.networkName || '—');
    }

    if (recipient) {
      set('r-recipient', recipient.name || '—');
      set('r-recipient-phone', formatPhone(recipient.phone));
      set('r-recipient-network', recipient.networkName || '—');
      set('r-country', recipient.countryName || '—');
      const money = formatMoney(recipient.amount, recipient.currency);
      set('r-amount', money);
      set('r-fees', `0 ${recipient.currency || ''}`.trim());
      set('r-total', money);
    }
  } catch (err) {
    showError('Erreur réseau. Vérifiez votre connexion et réessayez.');
  }
}

printBtn.addEventListener('click', () => window.print());

// Léger effet "papier qui sort" après l'animation d'impression.
receiptEl.addEventListener('animationend', () => {
  screenEl.textContent = 'Prêt';
});

loadTransfer();
