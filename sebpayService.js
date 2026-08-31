// sebpayService.js
// Wrapper autour de l'API SebPay, conforme à la documentation officielle :
// - POST /collections  : encaisser l'argent chez l'expéditeur (Mobile Money -> wallet SebPay)
// - POST /payouts      : décaisser l'argent depuis le wallet SebPay vers le destinataire
//
// Un "transfert" MTN <-> Moov est donc réalisé en 2 étapes asynchrones,
// enchaînées via le webhook (voir server.js) :
//   1) On collecte l'argent chez l'expéditeur.
//   2) Quand SebPay confirme la collecte (status "approved" via webhook),
//      on déclenche automatiquement le payout vers le destinataire.

const config = require('./config');

const BASE_URL = config.sebpay.baseUrl;

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Public-Key': config.sebpay.publicKey,
    'X-Secret-Key': config.sebpay.secretKey,
  };
}

/**
 * Normalise un numéro béninois vers le format international sans "+".
 * Accepte : 90 12 34 56 / 90123456 / 22990123456 / +22990123456
 * Renvoie : 22990123456 (indicatif 229 + 8 chiffres)
 */
function normalizeBeninPhone(rawPhone) {
  const digitsOnly = String(rawPhone).replace(/\D/g, '');

  if (digitsOnly.startsWith('229') && digitsOnly.length === 11) {
    return digitsOnly;
  }
  if (digitsOnly.length === 8) {
    return `229${digitsOnly}`;
  }
  return null; // format non reconnu
}

/**
 * Détermine le slug d'opérateur SebPay (mtn | moov) à partir des 8 chiffres
 * locaux d'un numéro béninois.
 * Préfixes MTN Bénin  : 90, 91, 96, 97, 98, 99
 * Préfixes Moov Bénin : 94, 95, 64, 65, 66, 67, 68, 69
 * ⚠️ Les plans de numérotation évoluent : à ajuster si besoin, ou à remplacer
 * par un appel à GET /operators?country=BJ pour rester dynamique.
 */
function detectOperator(localEightDigits) {
  const prefix2 = localEightDigits.slice(0, 2);
  const mtnPrefixes = ['90', '91', '96', '97', '98', '99'];
  const moovPrefixes = ['94', '95', '64', '65', '66', '67', '68', '69'];

  if (mtnPrefixes.includes(prefix2)) return 'mtn';
  if (moovPrefixes.includes(prefix2)) return 'moov';
  return null;
}

async function callSebpay(method, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.success === false) {
    const err = new Error(json.message || `Erreur SebPay (HTTP ${response.status})`);
    err.code = 'SEBPAY_ERROR';
    err.raw = json;
    throw err;
  }

  // L'API enveloppe ses réponses dans { success, data, message }
  return json.data !== undefined ? json.data : json;
}

/**
 * Initie une collecte (encaissement) Mobile Money.
 * POST /collections
 */
async function initiateCollection({ phone, operator, amount, externalReference, otpCode }) {
  const payload = {
    amount: Number(amount),
    currency: 'XOF',
    phone,
    operator,
    country: 'BJ',
    external_reference: externalReference,
    callback_url: `${config.sebpay.publicBaseUrl}/api/webhook`,
  };
  if (otpCode) payload.otp_code = otpCode;

  return callSebpay('POST', '/collections', payload);
}

/** GET /collections/{id_or_reference} */
async function getCollection(idOrReference) {
  return callSebpay('GET', `/collections/${encodeURIComponent(idOrReference)}`);
}

/**
 * Initie un décaissement (payout) Mobile Money.
 * POST /payouts
 */
async function initiatePayout({ recipientName, phone, operator, amount, externalReference }) {
  const payload = {
    recipient_name: recipientName,
    phone,
    operator,
    country: 'BJ',
    amount: Number(amount),
    currency: 'XOF',
    external_reference: externalReference,
    callback_url: `${config.sebpay.publicBaseUrl}/api/webhook`,
  };

  return callSebpay('POST', '/payouts', payload);
}

/** GET /payouts/{id_or_reference} */
async function getPayout(idOrReference) {
  return callSebpay('GET', `/payouts/${encodeURIComponent(idOrReference)}`);
}

module.exports = {
  normalizeBeninPhone,
  detectOperator,
  initiateCollection,
  getCollection,
  initiatePayout,
  getPayout,
};
