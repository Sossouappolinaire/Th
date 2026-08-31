// admin.js
// Panneau ADMIN : liste + correction des paiements en attente.
// Protégé par le mot de passe administrateur (voir config.admin.token /
// variable d'environnement ADMIN_TOKEN, "arrow2025" par défaut). Le mot de
// passe saisi est envoyé dans l'en-tête X-Admin-Token et gardé en
// sessionStorage (effacé à la fermeture de l'onglet) — jamais codé en dur ici.

const TOKEN_KEY = 'sebpay_admin_token';

const gate = document.getElementById('gate');
const appEl = document.getElementById('app');
const tokenInput = document.getElementById('tokenInput');
const tokenSubmit = document.getElementById('tokenSubmit');
const gateStatus = document.getElementById('gateStatus');

const refInput = document.getElementById('refInput');
const refCheckBtn = document.getElementById('refCheckBtn');
const refStatus = document.getElementById('refStatus');
const refActions = document.getElementById('refActions');
const refCancelBtn = document.getElementById('refCancelBtn');
const refRetryBtn = document.getElementById('refRetryBtn');

const refreshBtn = document.getElementById('refreshBtn');
const fixAllBtn = document.getElementById('fixAllBtn');
const fixStatus = document.getElementById('fixStatus');
const tableWrap = document.getElementById('tableWrap');

let currentRefTransfer = null;

function setStatus(el, text, type) {
  el.textContent = text;
  el.className = `status-line status-line--${type}`;
}

function clearStatus(el) {
  el.textContent = '';
  el.className = 'status-line';
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function formatOperator(op) {
  return op === 'mtn' ? 'MTN' : op === 'moov' ? 'Moov' : op || '—';
}

function formatAmount(amount) {
  return `${Number(amount).toLocaleString('fr-FR')} FCFA`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fr-FR');
  } catch {
    return iso;
  }
}

function stagePill(stage) {
  const label = stage === 'collection' ? 'Collecte' : stage === 'payout' ? 'Décaissement' : 'Remboursement';
  return `<span class="pill pill--${stage}">${label}</span>`;
}

/** Wrapper fetch qui ajoute le jeton admin et gère l'expiration (401). */
async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': getToken(),
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    showGate();
    setStatus(gateStatus, 'Accès réservé aux administrateurs.', 'error');
    throw new Error('UNAUTHORIZED');
  }

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function showGate() {
  gate.style.display = 'block';
  appEl.style.display = 'none';
}

function showApp() {
  gate.style.display = 'none';
  appEl.style.display = 'block';
}

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

async function tryEnter(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
  try {
    const { ok, data } = await adminFetch('/api/admin/pending');
    if (!ok) {
      sessionStorage.removeItem(TOKEN_KEY);
      setStatus(gateStatus, data.message || 'Accès réservé aux administrateurs.', 'error');
      return;
    }
    showApp();
    renderPending(data.transfers);
  } catch {
    // adminFetch a déjà affiché "Accès réservé aux administrateurs." sur un 401
  }
}

tokenSubmit.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus(gateStatus, 'Veuillez saisir un mot de passe.', 'error');
    return;
  }
  tryEnter(token);
});

tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tokenSubmit.click();
});

// ---------------------------------------------------------------------------
// Recherche par référence (traiter un paiement bloqué)
// ---------------------------------------------------------------------------

function renderRefTransfer(transfer) {
  currentRefTransfer = transfer;

  const lines = [
    `Référence : ${transfer.reference}`,
    `Étape : ${transfer.stage} — Statut : ${transfer.status}`,
    `Expéditeur : ${transfer.senderPhone} (${formatOperator(transfer.senderOperator)})`,
    `Destinataire : ${transfer.receiverPhone} (${formatOperator(transfer.receiverOperator)})`,
    `Montant : ${formatAmount(transfer.amount)}`,
    transfer.message,
  ];

  const type = transfer.status === 'completed' || transfer.status === 'refunded'
    ? 'success'
    : transfer.status === 'failed'
    ? 'error'
    : 'info';

  setStatus(refStatus, lines.join(' · '), type);

  if (transfer.status === 'pending' && (transfer.stage === 'payout' || transfer.stage === 'refund')) {
    refActions.style.display = 'flex';
  } else {
    refActions.style.display = 'none';
  }
}

refCheckBtn.addEventListener('click', async () => {
  const reference = refInput.value.trim();
  if (!reference) {
    setStatus(refStatus, 'Veuillez saisir une référence.', 'error');
    return;
  }

  refCheckBtn.disabled = true;
  refCheckBtn.textContent = 'Vérification...';
  refActions.style.display = 'none';

  try {
    const { ok, data } = await adminFetch(
      `/api/admin/transfer/${encodeURIComponent(reference)}/check`,
      { method: 'POST' }
    );

    if (!data.transfer) {
      setStatus(refStatus, data.message || 'Référence introuvable.', 'error');
      return;
    }

    renderRefTransfer(data.transfer);
    if (!ok && data.message) {
      setStatus(refStatus, data.message, 'error');
    }
  } catch {
    // géré par adminFetch
  } finally {
    refCheckBtn.disabled = false;
    refCheckBtn.textContent = 'Vérifier';
  }
});

refInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refCheckBtn.click();
});

refCancelBtn.addEventListener('click', async () => {
  if (!currentRefTransfer) return;
  if (!confirm(`Renvoyer ${formatAmount(currentRefTransfer.amount)} au numéro émetteur ${currentRefTransfer.senderPhone} ?`)) return;
  refCancelBtn.disabled = true;
  refRetryBtn.disabled = true;
  try {
    const { data } = await adminFetch(
      `/api/admin/transfer/${encodeURIComponent(currentRefTransfer.reference)}/cancel`,
      { method: 'POST' }
    );
    if (data.transfer) renderRefTransfer(data.transfer);
    if (!data.success) setStatus(refStatus, data.message, 'error');
    loadPending();
  } catch {
    // géré par adminFetch
  } finally {
    refCancelBtn.disabled = false;
    refRetryBtn.disabled = false;
  }
});

refRetryBtn.addEventListener('click', async () => {
  if (!currentRefTransfer) return;
  if (
    !confirm(
      `Relancer l'envoi de ${formatAmount(currentRefTransfer.amount)} vers ${currentRefTransfer.receiverPhone} ? Ne faites ceci que si vous avez confirmé que la tentative précédente est bloquée (risque de double paiement sinon).`
    )
  )
    return;
  refCancelBtn.disabled = true;
  refRetryBtn.disabled = true;
  try {
    const { data } = await adminFetch(
      `/api/admin/transfer/${encodeURIComponent(currentRefTransfer.reference)}/retry`,
      { method: 'POST' }
    );
    if (data.transfer) renderRefTransfer(data.transfer);
    if (!data.success) setStatus(refStatus, data.message, 'error');
    loadPending();
  } catch {
    // géré par adminFetch
  } finally {
    refCancelBtn.disabled = false;
    refRetryBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Liste + correction en masse
// ---------------------------------------------------------------------------

function renderPending(transfers) {
  if (!transfers || transfers.length === 0) {
    tableWrap.innerHTML = '<div class="empty">Aucun paiement en attente pour le moment.</div>';
    return;
  }

  const rows = transfers
    .map((t) => {
      const canAct = t.stage === 'payout' || t.stage === 'refund';
      return `
        <tr data-ref="${t.reference}">
          <td class="mono">${t.reference}</td>
          <td>${stagePill(t.stage)}</td>
          <td>${t.senderPhone}<br><span style="color:#8a8577">${formatOperator(t.senderOperator)}</span></td>
          <td>${t.receiverPhone}<br><span style="color:#8a8577">${formatOperator(t.receiverOperator)}</span></td>
          <td>${formatAmount(t.amount)}</td>
          <td>${formatDate(t.createdAt)}</td>
          <td>
            <div class="actions">
              <button class="secondary row-check">Vérifier</button>
              <div class="row2">
                <button class="danger row-cancel" ${canAct ? '' : 'disabled'}>Annuler</button>
                <button class="success row-retry" ${canAct ? '' : 'disabled'}>Réessayer</button>
              </div>
            </div>
          </td>
        </tr>`;
    })
    .join('');

  tableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Référence</th>
          <th>Étape</th>
          <th>Expéditeur</th>
          <th>Destinataire</th>
          <th>Montant</th>
          <th>Créé le</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  tableWrap.querySelectorAll('tr[data-ref]').forEach((row) => {
    const reference = row.dataset.ref;
    row.querySelector('.row-check').addEventListener('click', () => rowAction(row, reference, 'check'));
    row.querySelector('.row-cancel').addEventListener('click', () => rowAction(row, reference, 'cancel'));
    row.querySelector('.row-retry').addEventListener('click', () => rowAction(row, reference, 'retry'));
  });
}

async function rowAction(row, reference, action) {
  if (action === 'cancel' && !confirm(`Renvoyer l'argent de ${reference} au numéro émetteur ?`)) return;
  if (action === 'retry' && !confirm(`Relancer l'envoi de ${reference} au destinataire ? (risque de double paiement si la tentative précédente aboutit aussi)`)) return;

  const buttons = row.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));

  try {
    const { data } = await adminFetch(`/api/admin/transfer/${encodeURIComponent(reference)}/${action}`, {
      method: 'POST',
    });
    setStatus(fixStatus, `${reference} : ${data.message || data.transfer?.message || 'traité.'}`, data.success ? 'success' : 'error');
  } catch {
    // géré par adminFetch
  } finally {
    loadPending();
  }
}

async function loadPending() {
  try {
    const { ok, data } = await adminFetch('/api/admin/pending');
    if (ok) renderPending(data.transfers);
  } catch {
    // géré par adminFetch
  }
}

refreshBtn.addEventListener('click', loadPending);

fixAllBtn.addEventListener('click', async () => {
  fixAllBtn.disabled = true;
  fixAllBtn.textContent = 'Correction en cours...';
  setStatus(fixStatus, 'Vérification de tous les paiements en attente auprès de SebPay...', 'info');

  try {
    const { ok, data } = await adminFetch('/api/admin/fix-pending', { method: 'POST' });
    if (!ok) {
      setStatus(fixStatus, data.message || 'La correction a échoué.', 'error');
      return;
    }

    const summary = data.results
      .map((r) => `${r.reference} → ${r.status}${r.changed ? ' (mis à jour)' : ''}`)
      .join(' · ');

    setStatus(
      fixStatus,
      `${data.checked} paiement(s) vérifié(s), ${data.resolved} résolu(s), ${data.stillPending} encore en attente. ${summary}`,
      data.stillPending > 0 ? 'info' : 'success'
    );

    loadPending();
  } catch {
    // géré par adminFetch
  } finally {
    fixAllBtn.disabled = false;
    fixAllBtn.textContent = 'Corriger tout';
  }
});

// ---------------------------------------------------------------------------
// Démarrage : si un jeton est déjà en session, on tente d'entrer directement.
// ---------------------------------------------------------------------------

(function init() {
  const existingToken = getToken();
  if (existingToken) {
    tryEnter(existingToken);
  } else {
    showGate();
  }
})();
