// sebpayService.js
// Wrapper autour de l'API SebPay pour un vrai transfert « réseau à réseau » :
//
//   COLLECTIONS (encaissement) — on prélève l'argent chez l'EXPÉDITEUR :
//          demande de paiement envoyée directement à son numéro (USSD /
//          notification), ou lien de paiement à ouvrir dans un nouvel onglet
//          pour certains opérateurs (ex : Wave). Confirmation par webhook.
//
//   PAYOUTS (décaissement) — une fois l'encaissement confirmé, envoie
//          l'argent vers le destinataire (pays + réseau + numéro + nom).
//          Confirmation par webhook.
//
// Voir server.js pour l'orchestration complète (collection -> webhook -> payout).

const config = require('./config');

const BASE_URL = config.sebpay.baseUrl;

async function callSebPay(method, path, { body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Public-Key': config.sebpay.publicKey,
    'X-Secret-Key': config.sebpay.secretKey,
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.success === false) {
    const err = new Error(json.message || `Erreur SebPay (HTTP ${response.status})`);
    err.code = 'SEBPAY_ERROR';
    err.raw = json;
    throw err;
  }

  // Toutes les réponses SebPay sont enveloppées : { success, data, message }.
  return json.data !== undefined ? json.data : json;
}

// ------------------------------------------------------------------------
// Opérateurs — toujours interrogés en direct (jamais codés en dur), comme
// recommandé par la doc SebPay : la liste (et le champ otp_required) peut
// évoluer.
// ------------------------------------------------------------------------

/**
 * Liste les opérateurs Mobile Money disponibles, éventuellement filtrés par
 * pays (code ISO, ex: "BJ"). Chaque opérateur : { id, name, slug, code,
 * country, otp_required, ussd_code }.
 * GET /operators[?country=CODE]
 */
async function listOperators(countryCode) {
  const query = countryCode ? `?country=${encodeURIComponent(countryCode)}` : '';
  const data = await callSebPay('GET', `/operators${query}`);
  const list = Array.isArray(data) ? data : (data.operators || []);
  // On écarte les opérateurs signalés inactifs : les proposer garantissait un
  // payout rejeté par l'agrégateur (ex : Airtel Gabon, Moov Tchad).
  return list.filter((op) => {
    const status = String(op.status || op.state || '').toLowerCase();
    if (status && ['inactive', 'disabled', 'suspended'].includes(status)) return false;
    if (op.is_active === false || op.active === false) return false;
    return true;
  });
}

/**
 * Normalise un statut SebPay. Selon l'endpoint, SebPay renvoie
 * `approved`/`rejected`/`pending` (webhooks) OU `SUCCESS`/`FAILED`/`PENDING`
 * (réponses HTTP). Sans cette normalisation, un payout réussi restait
 * éternellement "en cours" côté site.
 */
function normalizeStatus(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (['approved', 'success', 'successful', 'completed', 'complete', 'paid', 'done'].includes(value)) return 'approved';
  if (['rejected', 'failed', 'failure', 'declined', 'canceled', 'cancelled', 'error', 'refunded'].includes(value)) return 'rejected';
  return 'pending';
}

// ------------------------------------------------------------------------
// COLLECTIONS — encaissement chez l'expéditeur
// ------------------------------------------------------------------------

/**
 * Initie une demande de paiement (encaissement) chez l'expéditeur.
 * POST /collections
 * phone : format international SANS le "+" (ex: "22997000000").
 * otpCode : requis uniquement pour certains opérateurs (voir otp_required
 * renvoyé par GET /operators — ex : Orange CI/BF/SN).
 */
async function initiateCollection({ amount, currency, phone, operator, country, externalReference, callbackUrl, otpCode }) {
  const payload = {
    amount: Number(amount),
    currency,
    phone,
    operator,
    country,
    external_reference: externalReference,
  };
  if (callbackUrl) payload.callback_url = callbackUrl;
  if (otpCode) payload.otp_code = otpCode;

  return callSebPay('POST', '/collections', { body: payload });
}

/**
 * Vérifie l'état d'une collecte directement auprès de SebPay — utile en
 * secours si un webhook a été manqué.
 * GET /collections/{id_or_reference}
 */
async function getCollection(idOrReference) {
  return callSebPay('GET', `/collections/${encodeURIComponent(idOrReference)}`);
}

// ------------------------------------------------------------------------
// PAYOUTS — envoi vers le destinataire
// ------------------------------------------------------------------------

/**
 * Initie un décaissement Mobile Money vers un destinataire.
 * POST /payouts
 * phone : format international SANS le "+".
 */
async function initiatePayout({ recipientName, phone, operator, country, amount, currency, externalReference, callbackUrl, description }) {
  const payload = {
    recipient_name: recipientName,
    phone,
    operator,
    country,
    amount: Number(amount),
    currency,
    external_reference: externalReference,
  };
  if (callbackUrl) payload.callback_url = callbackUrl;
  if (description) payload.description = description;

  return callSebPay('POST', '/payouts', { body: payload });
}

/**
 * Vérifie l'état d'un payout directement auprès de SebPay — utile en
 * secours si un webhook a été manqué.
 * GET /payouts/{id_or_reference}
 */
async function getPayout(idOrReference) {
  return callSebPay('GET', `/payouts/${encodeURIComponent(idOrReference)}`);
}

// ------------------------------------------------------------------------
// Webhooks — vérification de signature HMAC-SHA256
// ------------------------------------------------------------------------

/**
 * Vérifie la signature d'un webhook SebPay (en-tête X-SebPay-Signature),
 * calculée par SebPay comme HMAC-SHA256(corps JSON brut, clé secrète).
 * IMPORTANT : rawBody doit être le corps EXACT reçu (Buffer ou string),
 * pas le JSON re-sérialisé, sous peine de ne jamais matcher.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !rawBody) return false;
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', config.sebpay.secretKey)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false; // longueurs différentes, etc. -> signature invalide
  }
}

module.exports = {
  listOperators,
  normalizeStatus,
  initiateCollection,
  getCollection,
  initiatePayout,
  getPayout,
  verifyWebhookSignature,
};
