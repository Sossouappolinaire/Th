// app.js
// Assistant en 5 étapes : (1) expéditeur, (2) pays destinataire,
// (3) réseau + numéro destinataire, (4) montant, (5) vérification & envoi.
// Charge dynamiquement la liste des pays/réseaux depuis /api/methods, gère
// la navigation entre étapes, puis suit (polling) l'état du transfert
// jusqu'à confirmation. N'appelle jamais SebPay directement : passe
// toujours par notre backend, qui seul détient les clés API.

const senderCountrySelect = document.getElementById('sender-country');
const senderDialCode = document.getElementById('sender-dial-code');
const senderNameInput = document.getElementById('sender-name');
const senderPhoneInput = document.getElementById('sender-phone');
const senderPhoneHint = document.getElementById('sender-phone-hint');
const senderNetworkGrid = document.getElementById('sender-network-grid');

const countrySelect = document.getElementById('country');
const recipientDialCode = document.getElementById('recipient-dial-code');
const networkGrid = document.getElementById('network-grid');
const recipientNameInput = document.getElementById('recipient-name');
const phoneInput = document.getElementById('phone');
const phoneHint = document.getElementById('phone-hint');
const amountInput = document.getElementById('amount');
const currencyTag = document.getElementById('currency-tag');

const otpField = document.getElementById('otp-field');
const otpInstructions = document.getElementById('otp-instructions');
const otpCodeInput = document.getElementById('otp-code');

const form = document.getElementById('transfer-form');
const submitBtn = document.getElementById('submit-btn');
const nextBtn = document.getElementById('next-btn');
const backBtn = document.getElementById('back-btn');
const formError = document.getElementById('form-error');

const panelForm = document.getElementById('panel-form');
const panelStatus = document.getElementById('panel-status');
const statusRing = document.getElementById('status-ring');
const statusIcon = document.getElementById('status-icon');
const statusTitle = document.getElementById('status-title');
const statusMessage = document.getElementById('status-message');
const newTransferBtn = document.getElementById('new-transfer-btn');

const summaryPhone = document.getElementById('summary-phone');
const summaryNetwork = document.getElementById('summary-network');
const summaryAmount = document.getElementById('summary-amount');
const summaryToken = document.getElementById('summary-token');

const reviewType = document.getElementById('review-type');
const reviewSender = document.getElementById('review-sender');
const reviewSenderNetwork = document.getElementById('review-sender-network');
const reviewRecipient = document.getElementById('review-recipient');
const reviewRecipientNetwork = document.getElementById('review-recipient-network');
const reviewNetwork = document.getElementById('review-network');
const reviewAmount = document.getElementById('review-amount');
const reviewReceived = document.getElementById('review-received');
const reviewExplanation = document.getElementById('review-explanation');
const recapNetworkBadge = document.getElementById('recap-network-badge');
const reviewNetworkBadge = document.getElementById('review-network-badge');
const recapBackBtn = document.getElementById('recap-back-btn');

const wizardSteps = Array.from(document.querySelectorAll('.wizard-step'));
const dots = Array.from(document.querySelectorAll('.dots__item'));
const TOTAL_STEPS = wizardSteps.length;
let currentStep = 1;

let countriesData = [];
let selectedSenderCountry = null;
let selectedSenderMethod = null; // facultatif, juste pour l'affichage
let selectedCountry = null;
let selectedMethod = null; // { key, name }

// Couleurs indicatives par opérateur (pas des logos officiels — un simple
// repère visuel construit côté client à partir du nom renvoyé par l'API).
const OPERATOR_COLORS = [
  { match: /mtn/i, bg: '#FFCC00', fg: '#16241f' },
  { match: /orange/i, bg: '#FF6600', fg: '#ffffff' },
  { match: /moov/i, bg: '#0072CE', fg: '#ffffff' },
  { match: /wave/i, bg: '#1DC8CD', fg: '#0b2b2c' },
  { match: /airtel/i, bg: '#E4022D', fg: '#ffffff' },
  { match: /^free/i, bg: '#8710D8', fg: '#ffffff' },
  { match: /celtiis/i, bg: '#00A19A', fg: '#ffffff' },
  { match: /card|visa|mastercard/i, bg: '#16241f', fg: '#ffffff' },
];
const DEFAULT_OPERATOR_COLOR = { bg: '#1B6B63', fg: '#ffffff' };

function operatorColor(name) {
  const found = OPERATOR_COLORS.find((o) => o.match.test(name));
  return found || DEFAULT_OPERATOR_COLOR;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Navigation entre les 5 étapes de l'assistant -----------------------

function renderDots() {
  dots.forEach((dot, index) => {
    const stepNumber = index + 1;
    dot.classList.remove('is-active', 'is-done');
    if (stepNumber < currentStep) dot.classList.add('is-done');
    else if (stepNumber === currentStep) dot.classList.add('is-active');
  });
}

function showStep(step) {
  currentStep = step;
  wizardSteps.forEach((el) => {
    el.classList.toggle('is-active', Number(el.dataset.substep) === step);
  });
  renderDots();
  formError.textContent = '';

  backBtn.disabled = step === 1;
  const isLastStep = step === TOTAL_STEPS;
  nextBtn.classList.toggle('is-hidden', isLastStep);
  submitBtn.classList.toggle('is-hidden', !isLastStep);
  if (isLastStep) fillReview();
}

function validateStep(step) {
  if (step === 1) {
    if (!selectedSenderCountry) return 'Veuillez choisir votre pays.';
    if (!senderNameInput.value.trim()) return 'Veuillez saisir votre nom.';
    const digits = senderPhoneInput.value.trim().replace(/\D/g, '');
    const rule = selectedSenderCountry.phoneRule;
    if (!digits) return 'Veuillez saisir votre numéro Mobile Money.';
    if (rule && typeof rule.digits === 'number' && digits.length !== rule.digits) {
      return `Numéro invalide : ${rule.digits} chiffres attendus (ex : ${rule.example}).`;
    }
    if ((!rule || typeof rule.digits !== 'number') && (digits.length < 6 || digits.length > 12)) {
      return 'Veuillez saisir un numéro de téléphone valide.';
    }
    if (!selectedSenderMethod) return 'Veuillez choisir votre réseau Mobile Money.';
    if (selectedSenderMethod.otpRequired && !otpCodeInput.value.trim()) {
      return `Veuillez saisir le code OTP reçu après avoir composé ${selectedSenderMethod.ussdCode || 'le code USSD indiqué'}.`;
    }
    return null;
  }
  if (step === 2) {
    if (!selectedCountry) return 'Veuillez choisir le pays du destinataire.';
    return null;
  }
  if (step === 3) {
    if (!selectedMethod) return 'Veuillez choisir un réseau.';
    if (!recipientNameInput.value.trim()) return 'Veuillez saisir le nom du destinataire.';
    const digits = phoneInput.value.trim().replace(/\D/g, '');
    const rule = selectedCountry.phoneRule;
    if (!digits) return 'Veuillez saisir le numéro du destinataire.';
    if (rule && typeof rule.digits === 'number' && digits.length !== rule.digits) {
      return `Numéro invalide : ${rule.digits} chiffres attendus pour ${selectedCountry.country} (ex : ${rule.example}).`;
    }
    if ((!rule || typeof rule.digits !== 'number') && (digits.length < 6 || digits.length > 12)) {
      return 'Veuillez saisir un numéro de téléphone valide.';
    }
    return null;
  }
  if (step === 4) {
    const amount = amountInput.value.trim();
    if (!amount || Number(amount) <= 0) return 'Veuillez saisir un montant valide.';
    if (selectedSenderCountry && selectedCountry && selectedSenderCountry.currency !== selectedCountry.currency) {
      return `Transfert impossible : ${selectedSenderCountry.country} (${selectedSenderCountry.currency}) et ${selectedCountry.country} (${selectedCountry.currency}) n'utilisent pas la même devise.`;
    }
    return null;
  }
  return null;
}

function fillReview() {
  const senderDigits = senderPhoneInput.value.trim().replace(/\D/g, '');
  const recipientDigits = phoneInput.value.trim().replace(/\D/g, '');
  const senderDial = selectedSenderCountry?.phoneRule?.dialCode;
  const recipientDial = selectedCountry?.phoneRule?.dialCode;
  const senderFull = `${senderDial ? '+' + senderDial + ' ' : ''}${senderDigits}`;
  const recipientFull = `${recipientDial ? '+' + recipientDial + ' ' : ''}${recipientDigits}`;
  const isNational = selectedSenderCountry && selectedCountry && selectedSenderCountry.code === selectedCountry.code;

  reviewType.textContent = selectedSenderCountry && selectedCountry
    ? (isNational
      ? `National — ${selectedCountry.country}`
      : `International — ${selectedSenderCountry.country} → ${selectedCountry.country}`)
    : '—';

  reviewSender.textContent = senderFull;
  reviewSenderNetwork.textContent = selectedSenderMethod ? selectedSenderMethod.name : '';

  const recipientName = recipientNameInput.value.trim();
  reviewRecipient.textContent = recipientName ? `${recipientName} — ${recipientFull}` : recipientFull;
  reviewRecipientNetwork.textContent = selectedMethod ? selectedMethod.name : '';

  reviewNetwork.textContent = selectedMethod ? selectedMethod.name : '—';

  const amount = amountInput.value.trim();
  const currency = selectedCountry ? selectedCountry.currency : '';
  const amountLabel = amount ? `${amount} ${currency}`.trim() : '—';
  reviewAmount.textContent = amountLabel;
  reviewReceived.textContent = amountLabel;

  const recipientNetworkName = selectedMethod ? selectedMethod.name : 'du réseau choisi';
  recapNetworkBadge.textContent = selectedMethod ? selectedMethod.name : '—';
  reviewNetworkBadge.textContent = selectedMethod ? selectedMethod.name : '—';

  // Explication claire, en toutes lettres, de qui paie et qui reçoit.
  reviewExplanation.textContent = amount
    ? `${amountLabel} seront prélevés de votre numéro ${senderFull}${selectedSenderMethod ? ' (' + selectedSenderMethod.name + ')' : ''} et envoyés à ${recipientName || 'votre destinataire'} au numéro ${recipientFull} sur le réseau ${recipientNetworkName}.`
    : 'Renseignez le montant pour voir le détail du transfert.';
}

nextBtn.addEventListener('click', () => {
  const error = validateStep(currentStep);
  if (error) {
    formError.textContent = error;
    return;
  }
  if (currentStep < TOTAL_STEPS) showStep(currentStep + 1);
});

backBtn.addEventListener('click', () => {
  if (currentStep > 1) showStep(currentStep - 1);
});

recapBackBtn.addEventListener('click', () => {
  if (currentStep > 1) showStep(currentStep - 1);
});

// --- Chargement des pays / réseaux disponibles ---------------------------
// La même liste (pays + réseaux pris en charge côté envoi/retrait) sert à
// la fois pour l'expéditeur et pour le destinataire.

async function loadMethods() {
  try {
    const response = await fetch('/api/methods');
    const data = await response.json();

    if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error('Liste vide');
    }

    countriesData = data.data;
    if (data.degraded) {
      const notice = document.getElementById('degraded-notice');
      if (notice) notice.classList.remove('is-hidden');
    }
    const options = '<option value="">Sélectionnez un pays</option>' +
      countriesData.map((c) => `<option value="${c.code}">${c.country}</option>`).join('');

    senderCountrySelect.innerHTML = options;
    senderCountrySelect.disabled = false;
    countrySelect.innerHTML = options;
    countrySelect.disabled = false;
  } catch (err) {
    senderCountrySelect.innerHTML = '<option value="">Pays indisponibles pour le moment</option>';
    countrySelect.innerHTML = '<option value="">Pays indisponibles pour le moment</option>';
    formError.textContent = 'Impossible de charger la liste des pays. Réessayez dans un instant.';
    return false;
  }
  return true;
}

function renderNetworkChips(grid, country, onSelect) {
  if (!country || !(country.paymentMethods || []).length) {
    grid.innerHTML = '<p class="hint">Sélectionnez d\'abord un pays.</p>';
    return;
  }

  grid.innerHTML = '';
  country.paymentMethods.forEach((method) => {
    const color = operatorColor(method.name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'network-chip';
    chip.dataset.key = method.key;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', 'false');
    chip.innerHTML = `
      <span class="network-chip__badge" style="background:${color.bg};color:${color.fg}">${method.name.charAt(0).toUpperCase()}</span>
      <span class="network-chip__name">${method.name}</span>
    `;
    chip.addEventListener('click', () => {
      grid.querySelectorAll('.network-chip').forEach((el) => {
        el.classList.remove('is-selected');
        el.setAttribute('aria-checked', 'false');
      });
      chip.classList.add('is-selected');
      chip.setAttribute('aria-checked', 'true');
      onSelect(method);
    });
    grid.appendChild(chip);
  });
}

function updatePhoneHint(hintEl, country) {
  const rule = country && country.phoneRule;
  if (rule) {
    hintEl.textContent = `${rule.digits} chiffres attendus pour ${country.country}, ex : ${rule.example}.`;
  } else {
    hintEl.textContent = 'Format local, sans indicatif pays.';
  }
}

senderCountrySelect.addEventListener('change', () => {
  selectedSenderCountry = countriesData.find((c) => c.code === senderCountrySelect.value) || null;
  selectedSenderMethod = null;
  renderNetworkChips(senderNetworkGrid, selectedSenderCountry, (method) => {
    selectedSenderMethod = method;
    toggleOtpField(method);
  });
  updatePhoneHint(senderPhoneHint, selectedSenderCountry);
  senderDialCode.textContent = selectedSenderCountry?.phoneRule?.dialCode ? `+${selectedSenderCountry.phoneRule.dialCode}` : '+—';
  toggleOtpField(null);
});

function toggleOtpField(method) {
  const needsOtp = Boolean(method && method.otpRequired);
  otpField.classList.toggle('is-hidden', !needsOtp);
  if (needsOtp) {
    otpInstructions.textContent = method.ussdCode
      ? `Composez ${method.ussdCode} sur votre téléphone pour recevoir votre code, puis saisissez-le ci-dessous.`
      : 'Cet opérateur exige un code de confirmation : suivez les instructions envoyées sur votre téléphone.';
  } else {
    otpCodeInput.value = '';
  }
}

countrySelect.addEventListener('change', () => {
  selectedCountry = countriesData.find((c) => c.code === countrySelect.value) || null;
  selectedMethod = null;
  renderNetworkChips(networkGrid, selectedCountry, (method) => { selectedMethod = method; });
  updatePhoneHint(phoneHint, selectedCountry);
  currencyTag.textContent = selectedCountry ? `(${selectedCountry.currency})` : '';
  recipientDialCode.textContent = selectedCountry?.phoneRule?.dialCode ? `+${selectedCountry.phoneRule.dialCode}` : '+—';
});

// --- Suivi du transfert --------------------------------------------------

function showStatusPanel() {
  panelForm.classList.add('is-hidden');
  panelStatus.classList.remove('is-hidden');
}

// Un transfert passe par les étapes suivantes (voir server.js) :
//   collection_pending -> l'expéditeur doit valider le paiement sur son téléphone (USSD/notification)
//   collection_failed  -> paiement de l'expéditeur refusé/échoué (fin, échec)
//   payout_pending      -> paiement reçu, envoi au destinataire en cours
//   completed           -> destinataire crédité (fin, succès)
//   payout_failed       -> paiement reçu MAIS envoi au destinataire échoué (fin, échec — cas à surveiller)
const STAGE_LABELS = {
  collection_pending: { title: 'En attente de votre validation…' },
  payout_pending: { title: 'Envoi au destinataire…' },
  completed: { title: 'Transfert réussi' },
  collection_failed: { title: 'Paiement refusé' },
  payout_failed: { title: "Échec de l'envoi" },
};

function renderPending(stage, message) {
  statusRing.className = 'status__ring is-spinning';
  statusIcon.textContent = '↻';
  statusTitle.textContent = (STAGE_LABELS[stage] && STAGE_LABELS[stage].title) || 'Transfert en cours…';
  statusMessage.textContent = message || 'Vérifiez votre téléphone : une demande de paiement Mobile Money vient de vous être envoyée.';
  newTransferBtn.classList.add('is-hidden');
}

function renderResult(stage, message) {
  const isSuccess = stage === 'completed';
  statusRing.className = `status__ring ${isSuccess ? 'is-success' : 'is-failed'}`;
  statusIcon.textContent = isSuccess ? '✓' : '✕';
  statusTitle.textContent = (STAGE_LABELS[stage] && STAGE_LABELS[stage].title) || (isSuccess ? 'Transfert réussi' : 'Transfert échoué');
  statusMessage.textContent = message;
  newTransferBtn.classList.remove('is-hidden');
}

const FINAL_STAGES = ['completed', 'collection_failed', 'payout_failed'];

async function pollTransfer(transferId, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`/api/transfer/${encodeURIComponent(transferId)}`);
    const data = await response.json();

    if (data.success) {
      const { stage, message, recipient } = data.transfer;
      if (recipient) {
        summaryNetwork.textContent = `${recipient.networkName} — ${recipient.countryName}`;
        summaryAmount.textContent = `${recipient.amount} ${recipient.currency}`.trim();
        summaryPhone.textContent = recipient.phone;
      }

      // Une fois confirmé "completed" par le serveur (donc par le webhook
      // payout de FusionMoney), on quitte cette page pour la vraie page de
      // confirmation : /success.html.
      if (stage === 'completed') {
        window.location.href = `/success.html?transferId=${encodeURIComponent(transferId)}`;
        return stage;
      }

      if (FINAL_STAGES.includes(stage)) {
        renderResult(stage, message);
        return stage;
      }
      renderPending(stage, message);
    }
    await sleep(intervalMs);
  }

  renderResult('timeout', 'Délai dépassé. Le transfert peut tout de même aboutir : vérifiez plus tard.');
  return 'timeout';
}

// --- Soumission du formulaire (étape 5) -----------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formError.textContent = '';

  for (let step = 1; step <= 4; step += 1) {
    const error = validateStep(step);
    if (error) {
      showStep(step);
      formError.textContent = error;
      return;
    }
  }

  const senderName = senderNameInput.value.trim();
  const senderPhone = senderPhoneInput.value.trim().replace(/\D/g, '');
  const recipientName = recipientNameInput.value.trim();
  const phone = phoneInput.value.trim().replace(/\D/g, '');
  const amount = amountInput.value.trim();
  const otpCode = otpCodeInput.value.trim();

  submitBtn.disabled = true;
  submitBtn.querySelector('.btn__label').textContent = 'Préparation du paiement…';

  try {
    const response = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        senderName,
        senderPhone,
        senderCountryCode: selectedSenderCountry.code,
        senderOperator: selectedSenderMethod.key,
        otpCode: otpCode || undefined,
        countryCode: selectedCountry.code,
        withdrawMode: selectedMethod.key,
        phone,
        recipientName,
        amount,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      formError.textContent = data.message || 'La création du transfert a échoué.';
      submitBtn.disabled = false;
      submitBtn.querySelector('.btn__label').textContent = 'Payer et envoyer';
      return;
    }

    showStatusPanel();
    summaryToken.textContent = data.transferId;
    renderPending('collection_pending', data.message);

    // Certains opérateurs (ex : Wave) renvoient un lien de paiement à ouvrir
    // dans un NOUVEL ONGLET (conformément à la doc SebPay) — l'expéditeur y
    // valide, pendant que cet onglet-ci continue de suivre l'état en direct.
    // Pour les autres opérateurs, l'expéditeur reçoit directement une
    // demande USSD/notification sur son téléphone : rien à ouvrir.
    if (data.paymentUrl) {
      window.open(data.paymentUrl, '_blank', 'noopener');
    }

    pollTransfer(data.transferId);
  } catch (err) {
    formError.textContent = 'Erreur réseau. Veuillez réessayer.';
    submitBtn.disabled = false;
    submitBtn.querySelector('.btn__label').textContent = 'Payer et envoyer';
  }
});

newTransferBtn.addEventListener('click', () => {
  form.reset();
  selectedSenderCountry = null;
  selectedSenderMethod = null;
  selectedCountry = null;
  selectedMethod = null;
  renderNetworkChips(senderNetworkGrid, null, () => {});
  renderNetworkChips(networkGrid, null, () => {});
  updatePhoneHint(senderPhoneHint, null);
  updatePhoneHint(phoneHint, null);
  toggleOtpField(null);
  senderDialCode.textContent = '+—';
  recipientDialCode.textContent = '+—';
  currencyTag.textContent = '';
  panelStatus.classList.add('is-hidden');
  panelForm.classList.remove('is-hidden');
  showStep(1);
});

// --- Reprise du suivi si l'expéditeur revient via un lien externe -------
// Pour les opérateurs qui ouvrent un lien de paiement dans un nouvel onglet
// (ex : Wave), on reste normalement dans l'onglet d'origine, qui continue
// de suivre l'état en direct. Ce mécanisme de reprise via ?transferId= dans
// l'URL reste toutefois disponible en secours (partage de lien, favori...).

function resumeTransferFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const transferId = params.get('transferId');
  if (!transferId) return false;

  showStatusPanel();
  summaryToken.textContent = transferId;
  renderPending('collection_pending', 'Vérification du paiement…');
  pollTransfer(transferId);

  // Nettoie l'URL pour éviter de relancer le suivi lors d'un rechargement.
  window.history.replaceState({}, document.title, window.location.pathname);
  return true;
}

showStep(1);
const resumedFromUrl = resumeTransferFromUrl();
const methodsReady = loadMethods();

// --- Écran d'accueil : barres de chargement puis ouverture du site -------
// Les deux premières barres avancent d'elles-mêmes ; la troisième attend la
// vraie réponse de /api/methods, pour que le site ne s'ouvre qu'une fois les
// pays et réseaux réellement chargés.

function runBoot(readyPromise) {
  const boot = document.getElementById('boot');
  const scene = document.getElementById('scene');
  if (!boot || !scene) return;

  const list = document.getElementById('boot-list');
  const pctEl = document.getElementById('boot-pct');
  const totalFill = document.getElementById('boot-total-fill');
  const hint = document.getElementById('boot-hint');

  const tasks = [
    { label: 'Connexion sécurisée', speed: 1.9, cap: 100 },
    { label: 'Réseaux Mobile Money', speed: 1.3, cap: 100 },
    { label: 'Pays disponibles', speed: 1.1, cap: 92 },
  ];

  tasks.forEach((task, i) => {
    const li = document.createElement('li');
    li.className = 'boot__item';
    li.innerHTML = `
      <span class="boot__label">${task.label}</span>
      <span class="boot__bar"><span class="boot__bar-fill" data-fill="${i}"></span></span>
      <span class="boot__value" data-value="${i}">0%</span>
    `;
    list.appendChild(li);
    task.value = 0;
    task.fillEl = li.querySelector('.boot__bar-fill');
    task.valueEl = li.querySelector('.boot__value');
    task.itemEl = li;
  });

  let ready = false;
  readyPromise
    .then((ok) => {
      ready = true;
      if (ok === false) hint.textContent = 'Réseaux chargés en mode secours…';
    })
    .catch(() => { ready = true; });

  let done = false;
  const tick = () => {
    tasks.forEach((task, i) => {
      const previousDone = i === 0 || tasks[i - 1].value >= 100;
      if (!previousDone) return;
      const cap = i === 2 ? (ready ? 100 : task.cap) : task.cap;
      if (task.value < cap) task.value = Math.min(cap, task.value + task.speed);
      task.fillEl.style.width = `${task.value}%`;
      task.valueEl.textContent = `${Math.round(task.value)}%`;
      task.itemEl.classList.toggle('is-done', task.value >= 100);
    });

    const total = tasks.reduce((sum, t) => sum + t.value, 0) / tasks.length;
    totalFill.style.width = `${total}%`;
    pctEl.textContent = Math.round(total);

    if (total >= 100) {
      if (done) return;
      done = true;
      hint.textContent = 'Prêt — ouverture…';
      setTimeout(() => {
        boot.classList.add('is-gone');
        scene.classList.remove('is-booting');
        setTimeout(() => boot.remove(), 700);
      }, 320);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

runBoot(resumedFromUrl ? Promise.resolve(true) : methodsReady);
