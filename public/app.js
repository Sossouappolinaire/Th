// app.js
// Pilote l'assistant par étapes (type de transfert -> expéditeur ->
// destinataire -> montant -> confirmation), interroge /api/countries pour
// peupler les pays/réseaux, puis soumet /api/transfer et suit le statut par
// polling jusqu'à confirmation. N'appelle jamais SebPay directement : passe
// toujours par notre backend, qui seul détient les clés API.
//
// Depuis le 01/09/2026 : l'expéditeur n'est plus figé sur le Bénin — il
// choisit son pays exactement comme le destinataire (pays -> réseau ->
// numéro), avec en plus un champ OTP quand le réseau choisi l'exige
// (Orange BF/CI/SN à ce jour, voir countries.js -> otpRequired).

const MIN_PAYOUT_AMOUNT_XOF = 300; // doit rester synchronisé avec server.js
const PLATFORM_FEE_PERCENT = 5; // doit rester synchronisé avec config.js -> fees.platformFeePercent
// Montant minimum réellement collectable : après déduction de la commission
// plateforme, il doit en rester au moins MIN_PAYOUT_AMOUNT_XOF pour le
// destinataire (sinon SebPay refuse le décaissement). Doit rester
// synchronisé avec MIN_TRANSFER_AMOUNT_XOF côté server.js.
const MIN_TRANSFER_AMOUNT_XOF = Math.ceil(MIN_PAYOUT_AMOUNT_XOF / (1 - PLATFORM_FEE_PERCENT / 100));

// Préfixes EZAB officiels ARCEP Bénin (liste publiée 02/2026), sans le "01".
// ⚠️ Avec la portabilité, le préfixe n'est qu'une SUGGESTION : il ne doit
// jamais bloquer un numéro ni écraser le réseau choisi par l'utilisateur.
const MTN_PREFIXES = ['42', '46', '50', '51', '52', '53', '54', '56', '57', '59', '61', '62', '66', '67', '69', '90', '91', '96', '97'];
const MOOV_PREFIXES = ['45', '55', '58', '60', '63', '64', '65', '68', '94', '95', '98', '99'];
const CELTIIS_PREFIXES = ['20', '21', '22', '23', '24', '28', '29', '40', '41', '43', '44', '47', '48', '49', '92', '93'];

const form = document.getElementById('transfer-form');
const messageBox = document.getElementById('message');
const submitBtn = document.getElementById('submit-btn');

const panels = [...document.querySelectorAll('.panel')];
const dots = [...document.querySelectorAll('.steps__dot')];
const lines = [...document.querySelectorAll('.steps__line')];

const tiles = [...document.querySelectorAll('.choice-tile')];

// --- Expéditeur (panneau 2) ---
const senderCountryField = document.getElementById('senderCountryField');
const senderCountryTrigger = document.getElementById('senderCountryTrigger');
const senderCountryTriggerLabel = document.getElementById('senderCountryTriggerLabel');
const senderCountryList = document.getElementById('senderCountryList');
const senderOperatorChips = document.getElementById('senderOperatorChips');
const senderDialCode = document.getElementById('senderDialCode');
const senderInput = document.getElementById('senderPhone');
const senderOtpField = document.getElementById('senderOtpField');
const senderOtpHint = document.getElementById('senderOtpHint');
const senderOtpInput = document.getElementById('senderOtpCode');

// --- Destinataire (panneau 3) ---
const destTitle = document.getElementById('destTitle');
const destLede = document.getElementById('destLede');
const countryField = document.getElementById('countryField');
const countryTrigger = document.getElementById('countryTrigger');
const countryTriggerLabel = document.getElementById('countryTriggerLabel');
const countryList = document.getElementById('countryList');
const operatorChips = document.getElementById('operatorChips');
const receiverDialCode = document.getElementById('receiverDialCode');
const receiverInput = document.getElementById('receiverPhone');

const amountInput = document.getElementById('amount');
const routeSummary = document.getElementById('routeSummary');

const recapList = document.getElementById('recapList');
const statusTrail = document.getElementById('statusTrail');

let currentPanel = 1;
let countriesData = [];
let manualSenderOperatorPick = false;
let manualOperatorPick = false;

const state = {
  type: null,           // 'national' | 'international'
  senderCountry: null,  // code pays de l'expéditeur
  senderOperator: null, // slug réseau de l'expéditeur
  senderPhone: '',
  senderOtpCode: '',
  country: null,        // code pays du destinataire
  operator: null,       // slug réseau du destinataire
  receiverPhone: '',
  amount: '',
};

// ---------------------------------------------------------------------------
// Détection réseau béninois côté client (miroir de sebpayService.js), pour
// un retour visuel immédiat sans aller-retour serveur. Ne s'applique qu'au
// Bénin : les autres pays n'ont pas de plan de numérotation par réseau
// connu ici, l'utilisateur choisit son réseau lui-même (chips).
// ---------------------------------------------------------------------------
function bjLocalDigits(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('229')) digits = digits.slice(3);
  if (digits.length === 8) digits = `01${digits}`;
  return digits;
}

function detectBjOperator(raw) {
  const digits = bjLocalDigits(raw);
  if (digits.length < 4) return null;
  const prefix2 = digits.slice(2, 4);
  if (MTN_PREFIXES.includes(prefix2)) return 'mtn';
  if (MOOV_PREFIXES.includes(prefix2)) return 'moov';
  if (CELTIIS_PREFIXES.includes(prefix2)) return 'celtiis';
  return null;
}

function isValidBjPhone(raw) {
  const digits = bjLocalDigits(raw);
  // Portabilité : on ne valide QUE le format (01 + 8 chiffres). Le réseau
  // est celui choisi par l'utilisateur, pas celui déduit du préfixe.
  return digits.length === 10 && digits.startsWith('01');
}

function isValidIntlPhone(raw, dialCode, expectedDigits) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith(dialCode)) digits = digits.slice(dialCode.length);
  if (expectedDigits) return digits.length === expectedDigits;
  return digits.length >= 6 && digits.length <= 10;
}

function findCountry(code) {
  return countriesData.find((c) => c.code === code) || null;
}
function findOperator(countryCode, slug) {
  const country = findCountry(countryCode);
  if (!country) return null;
  return country.operators.find((o) => o.slug === slug) || null;
}

// ---------------------------------------------------------------------------
// Navigation entre panneaux
// ---------------------------------------------------------------------------
function goToPanel(n) {
  currentPanel = n;
  panels.forEach((p) => {
    p.hidden = Number(p.dataset.panel) !== n;
  });
  dots.forEach((d) => {
    const i = Number(d.dataset.dot);
    d.classList.toggle('is-done', i < n);
    d.classList.toggle('is-current', i === n);
  });
  lines.forEach((l) => {
    l.classList.toggle('is-filled', Number(l.dataset.line) < n);
  });
  if (n === 3) setupDestinataireStep();
  if (n === 5) buildRecap();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => goToPanel(Math.max(1, currentPanel - 1)));
});

// ---------------------------------------------------------------------------
// Animation "chargement" au clic — remplit le bouton de 0 à 100% avant
// d'exécuter l'action demandée (avance de panneau, ou envoi du transfert).
// ---------------------------------------------------------------------------
function playLoadingTransition(button, duration = 900) {
  return new Promise((resolve) => {
    const originalText = button.textContent;
    button.disabled = true;
    button.classList.add('is-loading');
    button.innerHTML = '<span class="btn-progress__fill"></span><span class="btn-progress__label">0%</span>';
    const fill = button.querySelector('.btn-progress__fill');
    const label = button.querySelector('.btn-progress__label');
    const start = performance.now();

    function tick(now) {
      const pct = Math.min(100, Math.round(((now - start) / duration) * 100));
      fill.style.width = `${pct}%`;
      label.textContent = `${pct}%`;
      if (pct < 100) {
        requestAnimationFrame(tick);
      } else {
        setTimeout(() => {
          button.classList.remove('is-loading');
          button.disabled = false;
          button.textContent = originalText;
          resolve();
        }, 120);
      }
    }
    requestAnimationFrame(tick);
  });
}

// Boutons "Continuer" (data-next) : jouent l'animation puis avancent d'un
// panneau.
document.querySelectorAll('.panel__nav [data-next]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    await playLoadingTransition(btn);
    goToPanel(Math.min(5, currentPanel + 1));
  });
});

// ---------------------------------------------------------------------------
// Étape 1 — Type de transfert
// National = expéditeur et destinataire dans LE MÊME pays (n'importe lequel).
// International = deux pays différents. Comme le pays expéditeur n'est plus
// figé sur le Bénin, on repart de zéro à chaque changement de type : le pays
// destinataire ne peut être fixé qu'une fois le pays expéditeur connu (étape
// suivante).
// ---------------------------------------------------------------------------
function resetCountryTrigger(triggerLabel, dialEl) {
  triggerLabel.textContent = 'Choisir un pays';
  triggerLabel.classList.add('country-trigger__placeholder');
  if (dialEl) dialEl.textContent = '+—';
}

tiles.forEach((tile) => {
  tile.addEventListener('click', () => {
    state.type = tile.dataset.type;

    state.senderCountry = null;
    state.senderOperator = null;
    state.senderPhone = '';
    state.senderOtpCode = '';
    manualSenderOperatorPick = false;
    state.country = null;
    state.operator = null;
    state.receiverPhone = '';
    manualOperatorPick = false;

    senderInput.value = '';
    senderOtpInput.value = '';
    resetCountryTrigger(senderCountryTriggerLabel, senderDialCode);
    senderOperatorChips.innerHTML = '<span class="chip-empty">Choisissez d\u2019abord un pays.</span>';
    senderOtpField.hidden = true;

    receiverInput.value = '';
    resetCountryTrigger(countryTriggerLabel, receiverDialCode);
    operatorChips.innerHTML = '<span class="chip-empty">Choisissez d\u2019abord un pays.</span>';

    validateStep2();
    goToPanel(2);
  });
});

// ---------------------------------------------------------------------------
// Étape 2 — Expéditeur (pays + réseau + numéro + OTP éventuel)
// ---------------------------------------------------------------------------
function renderSenderCountryList() {
  senderCountryList.innerHTML = countriesData
    .map(
      (c) => `<li data-code="${c.code}"><span class="flag">${c.flag}</span><span>${c.name}</span><span class="dial">+${c.dialCode}</span></li>`
    )
    .join('');

  senderCountryList.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      const code = li.dataset.code;
      const country = findCountry(code);
      state.senderCountry = code;
      state.senderOperator = null;
      manualSenderOperatorPick = false;
      senderCountryTriggerLabel.textContent = `${country.flag} ${country.name}`;
      senderCountryTriggerLabel.classList.remove('country-trigger__placeholder');
      senderDialCode.textContent = `+${country.dialCode}`;
      senderCountryList.hidden = true;
      senderCountryTrigger.setAttribute('aria-expanded', 'false');
      senderInput.value = '';
      state.senderPhone = '';
      renderSenderOperatorChips();
      updateSenderOtpVisibility();
      validateStep2();
    });
  });
}

senderCountryTrigger.addEventListener('click', () => {
  const expanded = senderCountryTrigger.getAttribute('aria-expanded') === 'true';
  senderCountryTrigger.setAttribute('aria-expanded', String(!expanded));
  senderCountryList.hidden = expanded;
});

/** Initiales génériques pour l'icône d'un opérateur (pas de logo de marque
 * déposée : juste un badge coloré avec 1-2 lettres, cohérent avec les
 * couleurs déjà définies par opérateur dans countries.js). */
function operatorInitials(name) {
  const words = String(name).trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function applyChipSelected(chip, country) {
  const op = country.operators.find((o) => o.slug === chip.dataset.slug);
  chip.classList.add('is-selected');
  chip.style.background = op.color;
  chip.style.color = op.textColor;
}
function resetChip(chip) {
  chip.classList.remove('is-selected');
  chip.style.background = '';
  chip.style.color = '';
}

function renderSenderOperatorChips() {
  const country = findCountry(state.senderCountry);
  if (!country) {
    senderOperatorChips.innerHTML = '<span class="chip-empty">Choisissez d\u2019abord un pays.</span>';
    return;
  }
  senderOperatorChips.innerHTML = country.operators
    .map(
      (op) =>
        `<button type="button" class="chip" data-slug="${op.slug}">` +
        `<span class="chip__icon" style="background:#fff;color:${op.color};border:1.5px solid ${op.color}">${operatorInitials(op.name)}</span>` +
        `${op.name}</button>`
    )
    .join('');

  senderOperatorChips.querySelectorAll('.chip').forEach((chip) => {
    if (chip.dataset.slug === state.senderOperator) applyChipSelected(chip, country);
    chip.addEventListener('click', () => {
      manualSenderOperatorPick = true;
      state.senderOperator = chip.dataset.slug;
      senderOperatorChips.querySelectorAll('.chip').forEach((c) => resetChip(c));
      applyChipSelected(chip, country);
      updateSenderOtpVisibility();
      validateStep2();
    });
  });
}

/** Affiche le champ OTP si le réseau expéditeur choisi l'exige (voir
 * countries.js -> otpRequired), avec le code USSD à composer. */
function updateSenderOtpVisibility() {
  const op = findOperator(state.senderCountry, state.senderOperator);
  if (op && op.otpRequired) {
    senderOtpField.hidden = false;
    senderOtpHint.textContent = `${op.name} exige un code de confirmation : composez ${op.ussdCode} sur ce téléphone, puis saisissez le code reçu ci-dessous.`;
  } else {
    senderOtpField.hidden = true;
    state.senderOtpCode = '';
    senderOtpInput.value = '';
  }
}

senderInput.addEventListener('input', () => {
  state.senderPhone = senderInput.value.trim();
  if (state.senderCountry === 'BJ' && !manualSenderOperatorPick) {
    const detected = detectBjOperator(state.senderPhone);
    if (detected && detected !== state.senderOperator) {
      state.senderOperator = detected;
      senderOperatorChips.querySelectorAll('.chip').forEach((c) => {
        c.dataset.slug === detected ? applyChipSelected(c, findCountry('BJ')) : resetChip(c);
      });
      updateSenderOtpVisibility();
    }
  }
  validateStep2();
});

senderOtpInput.addEventListener('input', () => {
  state.senderOtpCode = senderOtpInput.value.trim();
  validateStep2();
});

function validateStep2() {
  const country = findCountry(state.senderCountry);
  const phoneOk = country
    ? country.code === 'BJ'
      ? isValidBjPhone(state.senderPhone)
      : isValidIntlPhone(state.senderPhone, country.dialCode, country.phoneDigits)
    : false;
  const op = findOperator(state.senderCountry, state.senderOperator);
  const otpOk = !op || !op.otpRequired || state.senderOtpCode.length > 0;
  document.querySelector('[data-panel="2"] [data-next]').disabled = !(state.senderOperator && phoneOk && otpOk);
}

// ---------------------------------------------------------------------------
// Étape 3 — Destinataire (pays + réseau + numéro)
// En national : même pays que l'expéditeur, pas de sélecteur pays.
// En international : n'importe quel AUTRE pays que celui de l'expéditeur.
// ---------------------------------------------------------------------------
function setupDestinataireStep() {
  if (state.type === 'national') {
    countryField.hidden = true;
    if (state.country !== state.senderCountry) {
      state.country = state.senderCountry;
      state.operator = null;
      manualOperatorPick = false;
      receiverInput.value = '';
      state.receiverPhone = '';
    }
    const country = findCountry(state.country);
    destTitle.textContent = 'Qui reçoit l\u2019argent ?';
    destLede.textContent = country
      ? `Numéro ${country.name} du destinataire — même pays que l\u2019expéditeur.`
      : 'Numéro du destinataire.';
    receiverDialCode.textContent = country ? `+${country.dialCode}` : '+—';
    renderOperatorChips();
  } else {
    countryField.hidden = false;
    destTitle.textContent = 'Vers quel pays ?';
    destLede.textContent = 'Choisissez le pays, puis le réseau du destinataire.';
    if (state.country === state.senderCountry) {
      state.country = null;
      state.operator = null;
      manualOperatorPick = false;
      resetCountryTrigger(countryTriggerLabel, receiverDialCode);
      receiverInput.value = '';
      state.receiverPhone = '';
      operatorChips.innerHTML = '<span class="chip-empty">Choisissez d\u2019abord un pays.</span>';
    }
    renderCountryList();
  }
  validateStep3();
}

function renderCountryList() {
  countryList.innerHTML = countriesData
    .filter((c) => c.code !== state.senderCountry)
    .map(
      (c) => `<li data-code="${c.code}"><span class="flag">${c.flag}</span><span>${c.name}</span><span class="dial">+${c.dialCode}</span></li>`
    )
    .join('');

  countryList.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      const code = li.dataset.code;
      const country = findCountry(code);
      state.country = code;
      state.operator = null;
      manualOperatorPick = false;
      countryTriggerLabel.textContent = `${country.flag} ${country.name}`;
      countryTriggerLabel.classList.remove('country-trigger__placeholder');
      receiverDialCode.textContent = `+${country.dialCode}`;
      countryList.hidden = true;
      countryTrigger.setAttribute('aria-expanded', 'false');
      renderOperatorChips();
      validateStep3();
    });
  });
}

countryTrigger.addEventListener('click', () => {
  const expanded = countryTrigger.getAttribute('aria-expanded') === 'true';
  countryTrigger.setAttribute('aria-expanded', String(!expanded));
  countryList.hidden = expanded;
});

function renderOperatorChips() {
  const country = findCountry(state.country);
  if (!country) {
    operatorChips.innerHTML = '<span class="chip-empty">Choisissez d\u2019abord un pays.</span>';
    return;
  }
  operatorChips.innerHTML = country.operators
    .map(
      (op) =>
        `<button type="button" class="chip" data-slug="${op.slug}">` +
        `<span class="chip__icon" style="background:#fff;color:${op.color};border:1.5px solid ${op.color}">${operatorInitials(op.name)}</span>` +
        `${op.name}</button>`
    )
    .join('');

  operatorChips.querySelectorAll('.chip').forEach((chip) => {
    if (chip.dataset.slug === state.operator) applyChipSelected(chip, country);
    chip.addEventListener('click', () => {
      manualOperatorPick = true;
      state.operator = chip.dataset.slug;
      operatorChips.querySelectorAll('.chip').forEach((c) => resetChip(c));
      applyChipSelected(chip, country);
      validateStep3();
    });
  });
}

receiverInput.addEventListener('input', () => {
  state.receiverPhone = receiverInput.value.trim();

  if (state.country === 'BJ' && !manualOperatorPick) {
    const detected = detectBjOperator(state.receiverPhone);
    if (detected && detected !== state.operator) {
      state.operator = detected;
      operatorChips.querySelectorAll('.chip').forEach((c) => {
        c.dataset.slug === detected ? applyChipSelected(c, findCountry('BJ')) : resetChip(c);
      });
    }
  }
  validateStep3();
});

function validateStep3() {
  const country = findCountry(state.country);
  const phoneOk = country
    ? country.code === 'BJ'
      ? isValidBjPhone(state.receiverPhone)
      : isValidIntlPhone(state.receiverPhone, country.dialCode, country.phoneDigits)
    : false;
  document.querySelector('[data-panel="3"] [data-next]').disabled = !(state.operator && phoneOk);
}

// ---------------------------------------------------------------------------
// Étape 4 — Montant
// ---------------------------------------------------------------------------
amountInput.addEventListener('input', () => {
  state.amount = amountInput.value.trim();
  const senderCountry = findCountry(state.senderCountry);
  const receiverCountry = findCountry(state.country);
  const op = receiverCountry && state.operator ? receiverCountry.operators.find((o) => o.slug === state.operator) : null;
  const valid = Number(state.amount) >= MIN_TRANSFER_AMOUNT_XOF;

  document.querySelector('[data-panel="4"] [data-next]').disabled = !valid;

  if (senderCountry && receiverCountry && op && state.amount) {
    routeSummary.innerHTML = `${senderCountry.flag} ${senderCountry.name} → ${receiverCountry.flag} ${receiverCountry.name} · <strong>${op.name}</strong> · ${Number(state.amount).toLocaleString('fr-FR')} FCFA`;
  } else {
    routeSummary.textContent = '';
  }
});

// ---------------------------------------------------------------------------
// Étape 5 — Récapitulatif
// ---------------------------------------------------------------------------
function buildRecap() {
  const senderCountry = findCountry(state.senderCountry);
  const country = findCountry(state.country);
  const op = country ? country.operators.find((o) => o.slug === state.operator) : null;
  const senderOp = senderCountry ? senderCountry.operators.find((o) => o.slug === state.senderOperator) : null;
  const amount = Number(state.amount) || 0;
  const feeAmount = Math.round((amount * PLATFORM_FEE_PERCENT) / 100);
  const netAmount = amount - feeAmount;

  const rows = [
    [
      'Type',
      state.type === 'national'
        ? `National — ${senderCountry ? senderCountry.name : ''}`
        : `International — ${senderCountry ? senderCountry.name : ''} → ${country ? country.name : ''}`,
    ],
    ['Votre numéro', `+${senderCountry ? senderCountry.dialCode : ''} ${state.senderPhone}${senderOp ? ' · ' + senderOp.name : ''}`],
    ['Destinataire', `+${country ? country.dialCode : ''} ${state.receiverPhone}`],
    ['Réseau destinataire', op ? op.name : '—'],
    ['Vous envoyez', `${amount.toLocaleString('fr-FR')} FCFA`],
    ['Frais de service', `${feeAmount.toLocaleString('fr-FR')} FCFA (${PLATFORM_FEE_PERCENT}%)`],
    ['Le destinataire reçoit', `${netAmount.toLocaleString('fr-FR')} FCFA`],
  ];

  recapList.innerHTML = rows
    .map(
      ([label, value], i) =>
        `<div${i === rows.length - 1 ? ' class="recap__amount"' : ''}><dt>${label}</dt><dd>${value}</dd></div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Envoi + suivi du transfert
// ---------------------------------------------------------------------------
function showMessage(text, type) {
  messageBox.textContent = text;
  messageBox.className = `message message--${type}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateTrail(transfer) {
  statusTrail.hidden = false;
  const items = {
    collection: statusTrail.querySelector('[data-stage="collection"]'),
    payout: statusTrail.querySelector('[data-stage="payout"]'),
    completed: statusTrail.querySelector('[data-stage="completed"]'),
  };
  Object.values(items).forEach((el) => el.classList.remove('is-active', 'is-done'));

  if (transfer.stage === 'collection') {
    items.collection.classList.add('is-active');
    return;
  }
  items.collection.classList.add('is-done');

  if (transfer.status === 'completed') {
    items.payout.classList.add('is-done');
    items.completed.classList.add('is-done');
  } else if (transfer.stage === 'payout' || transfer.stage === 'refund' || transfer.status === 'blocked') {
    items.payout.classList.add('is-active');
  }
}

async function pollTransfer(reference, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`/api/transfer/${encodeURIComponent(reference)}`);
    const data = await response.json();

    if (data.success) {
      const { status, message } = data.transfer;
      updateTrail(data.transfer);
      const isTerminal = ['completed', 'failed', 'blocked', 'refunded'].includes(status);
      showMessage(message, status === 'failed' || status === 'blocked' ? 'error' : 'success');
      if (isTerminal) return status;
    }
    await sleep(intervalMs);
  }

  showMessage('Délai dépassé. Vérifiez le statut plus tard.', 'error');
  return 'timeout';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  messageBox.className = 'message';
  statusTrail.hidden = true;

  await playLoadingTransition(submitBtn, 900);
  submitBtn.disabled = true;
  submitBtn.textContent = 'Envoi en cours...';

  try {
    const response = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderCountry: state.senderCountry,
        senderPhone: state.senderPhone,
        senderOperator: state.senderOperator,
        senderOtpCode: state.senderOtpCode || undefined,
        receiverPhone: state.receiverPhone,
        receiverOperator: state.operator,
        amount: state.amount,
        transferType: state.type,
        destinationCountry: state.country,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      showMessage(data.message || 'Le transfert a échoué.', 'error');
      return;
    }

    showMessage(data.message || 'Collecte initiée, validez sur votre téléphone.', 'success');
    updateTrail({ stage: 'collection', status: 'pending' });
    const finalStatus = await pollTransfer(data.reference);

    if (finalStatus === 'completed') {
      submitBtn.textContent = 'Transfert envoyé ✓';
    } else {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Envoyer';
    }
  } catch (err) {
    showMessage('Erreur réseau. Veuillez réessayer.', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Envoyer';
  }
});

// ---------------------------------------------------------------------------
// Démarrage : charge la liste des pays/réseaux depuis le backend
// ---------------------------------------------------------------------------
async function init() {
  try {
    const response = await fetch('/api/countries');
    const data = await response.json();
    if (data.success) countriesData = data.countries;
  } catch (err) {
    console.error('Impossible de charger la liste des pays :', err);
  }
  renderSenderCountryList();
  renderCountryList();
  goToPanel(1);
}

init();
