// admin.js
// Panneau ADMIN : liste + vérification + remboursement des paiements.
// Protégé par le mot de passe administrateur (voir config.admin.token). Le
// mot de passe saisi est envoyé dans l'en-tête X-Admin-Token et gardé en
// sessionStorage (effacé à la fermeture de l'onglet) — jamais codé en dur ici.

const TOKEN_KEY = 'admin_token';

const gate = document.getElementById('gate');
const appEl = document.getElementById('app');
const tokenInput = document.getElementById('tokenInput');
const tokenSubmit = document.getElementById('tokenSubmit');
const gateStatus = document.getElementById('gateStatus');

const refInput = document.getElementById('refInput');
const refCheckBtn = document.getElementById('refCheckBtn');
const refStatus = document.getElementById('refStatus');

const refreshBtn = document.getElementById('refreshBtn');
const fixAllBtn = document.getElementById('fixAllBtn');
const fixStatus = document.getElementById('fixStatus');
const tableWrap = document.getElementById('tableWrap');

const refreshAllBtn = document.getElementById('refreshAllBtn');
const totalBox = document.getElementById('totalBox');
const allTableWrap = document.getElementById('allTableWrap');

let countriesData = [];

fetch('/api/countries')
  .then((r) => r.json())
  .then((data) => { if (data.success) countriesData = data.countries; })
  .catch(() => {});

function setStatus(el, text, type) {
  el.textContent = text;
  el.className = `status-line status-line--${type}`;
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function formatOperator(op, countryCode) {
  if (!op) return '—';
  const country = countriesData.find((c) => c.code === (countryCode || 'BJ'));
  const found = country && country.operators.find((o) => o.slug === op);
  return found ? found.name : op.toUpperCase();
}

function formatCountry(code) {
  if (!code || code === 'BJ') return '🇧🇯 Bénin';
  const country = countriesData.find((c) => c.code === code);
  return country ? `${country.flag} ${country.name}` : code;
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

function stagePill(stage, status) {
  if (stage === 'refund') return `<span class="pill pill--refund">Remboursement</span>`;
  if (status === 'completed') return `<span class="pill pill--completed">Encaissé</span>`;
  return `<span class="pill pill--collection">Collecte</span>`;
}

function statusPill(status) {
  const map = {
    completed: ['pill--completed', 'Encaissé'],
    pending: ['pill--collection', 'En attente'],
    failed: ['pill--refund', 'Échoué'],
    refunded: ['pill--refund', 'Remboursé'],
  };
  const [cls, label] = map[status] || ['pill--collection', status];
  return `<span class="pill ${cls}">${label}</span>`;
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
    loadAllTransfers();
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
// Recherche par référence (vérifier / rembourser un paiement)
// ---------------------------------------------------------------------------

function renderRefTransfer(transfer) {
  const lines = [
    `Référence : ${transfer.reference}`,
    `Étape : ${transfer.stage} — Statut : ${transfer.status}`,
    `Payeur : ${transfer.senderPhone} (${formatOperator(transfer.senderOperator, transfer.senderCountry)}, ${formatCountry(transfer.senderCountry)})`,
    `Montant : ${formatAmount(transfer.amount)}`,
    transfer.message,
  ];

  const type = transfer.status === 'completed'
    ? 'success'
    : transfer.status === 'refunded'
    ? 'success'
    : transfer.status === 'failed'
    ? 'error'
    : 'info';

  setStatus(refStatus, lines.filter(Boolean).join(' · '), type);
}

refCheckBtn.addEventListener('click', async () => {
  const reference = refInput.value.trim();
  if (!reference) {
    setStatus(refStatus, 'Veuillez saisir une référence.', 'error');
    return;
  }

  refCheckBtn.disabled = true;
  refCheckBtn.textContent = 'Vérification...';

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
    loadAllTransfers();
  }
});

refInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') refCheckBtn.click();
});

// ---------------------------------------------------------------------------
// Historique complet + somme totale du compte administrateur
// ---------------------------------------------------------------------------

function renderAllTransfers(transfers, totalAmount) {
  setStatus(totalBox, `Somme totale dans le compte administrateur : ${formatAmount(totalAmount)} (paiements encaissés, hors remboursements).`, 'success');

  if (!transfers || transfers.length === 0) {
    allTableWrap.innerHTML = '<div class="empty">Aucun paiement pour le moment.</div>';
    return;
  }

  const rows = transfers
    .map((t) => {
      return `
        <tr>
          <td class="mono">${t.reference}</td>
          <td>${formatDate(t.createdAt)}</td>
          <td>${formatCountry(t.senderCountry)}</td>
          <td>${t.senderPhone || '—'}<br><span style="color:#8a8577">${formatOperator(t.senderOperator, t.senderCountry)}</span></td>
          <td>${t.senderName || '—'}</td>
          <td>${formatAmount(t.amount)}</td>
          <td>${statusPill(t.status)}</td>
        </tr>`;
    })
    .join('');

  allTableWrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Référence</th>
          <th>Date / heure</th>
          <th>Pays</th>
          <th>Numéro</th>
          <th>Nom</th>
          <th>Montant</th>
          <th>Statut</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function loadAllTransfers() {
  try {
    const { ok, data } = await adminFetch('/api/admin/all');
    if (ok) renderAllTransfers(data.transfers, data.totalAmount);
  } catch {
    // géré par adminFetch
  }
}

refreshAllBtn.addEventListener('click', loadAllTransfers);

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
      return `
        <tr data-ref="${t.reference}">
          <td class="mono">${t.reference}</td>
          <td>${stagePill(t.stage, t.status)}</td>
          <td>${t.senderPhone}<br><span style="color:#8a8577">${formatOperator(t.senderOperator, t.senderCountry)} · ${formatCountry(t.senderCountry)}</span></td>
          <td>${formatAmount(t.amount)}</td>
          <td>${formatDate(t.createdAt)}</td>
          <td>
            <div class="actions">
              <button class="secondary row-check">Vérifier</button>
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
          <th>Payeur</th>
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
  });
}

async function rowAction(row, reference, action) {
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
    loadAllTransfers();
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
  setStatus(fixStatus, 'Vérification de tous les paiements en attente auprès de notre prestataire de paiement...', 'info');

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
    loadAllTransfers();
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
