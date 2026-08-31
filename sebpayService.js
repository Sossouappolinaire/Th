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
 * Depuis le 30/11/2024, le Bénin est passé à une numérotation à 10 chiffres :
 * chaque numéro est désormais précédé du préfixe "01" (ex: 97 XX XX XX -> 01 97 XX XX XX).
 * Accepte : 97 12 34 56 (ancien 8 chiffres) / 0197123456 / 22901971234 56 / +22901971234 56
 * Renvoie : 22901971234 56 (indicatif 229 + 01 + 8 chiffres = 13 chiffres)
 */
function normalizeBeninPhone(rawPhone) {
  let digits = String(rawPhone).replace(/\D/g, '');

  // Retire l'indicatif pays s'il est présent, pour ne garder que la partie locale
  if (digits.startsWith('229')) {
    digits = digits.slice(3);
  }

  // Ancien format à 8 chiffres (avant la réforme du 30/11/2024) : on ajoute le préfixe 01
  if (digits.length === 8) {
    digits = `01${digits}`;
  }

  // Format actuel : préfixe 01 + 8 chiffres = 10 chiffres au total
  if (digits.length === 10 && digits.startsWith('01')) {
    return `229${digits}`;
  }

  return null; // format non reconnu
}

/**
 * Détermine le slug d'opérateur SebPay (mtn | moov) à partir des 10 chiffres
 * locaux d'un numéro béninois (préfixe "01" + 8 chiffres, ex: "0197123456").
 * L'opérateur se détermine par les 2 chiffres qui suivent le "01".
 * Préfixes MTN Bénin  : 90, 91, 96, 97, 98, 99
 * Préfixes Moov Bénin : 94, 95, 64, 65, 66, 67, 68, 69
 * ⚠️ Les plans de numérotation évoluent : à ajuster si besoin, ou à remplacer
 * par un appel à GET /operators?country=BJ pour rester dynamique.
 */
function detectOperator(localTenDigits) {
  const prefix2 = localTenDigits.slice(2, 4);
  const mtnPrefixes = ['90', '91', '96', '97', '98', '99'];
  const moovPrefixes = ['94', '95', '64', '65', '66', '67', '68', '69'];

  if (mtnPrefixes.includes(prefix2)) return 'mtn';
  if (moovPrefixes.includes(prefix2)) return 'moov';
  return null;
}

/**
 * Normalise un numéro international à partir de l'indicatif du pays choisi
 * dans l'interface (utilisé pour les destinataires hors Bénin, où l'on ne
 * peut pas deviner l'opérateur depuis le préfixe : l'utilisateur le
 * sélectionne lui-même dans la liste des réseaux du pays).
 * Accepte le numéro avec ou sans l'indicatif, avec espaces/tirets.
 * `expectedDigits` = nombre exact de chiffres attendu pour la partie locale
 * de ce pays (voir countries.js -> phoneDigits, vérifié par pays). Si non
 * fourni, on retombe sur l'ancienne fourchette générique 6-10 chiffres.
 * Renvoie l'indicatif + partie locale (sans "+"), ou null si la longueur
 * ne correspond pas.
 */
function normalizeInternationalPhone(rawPhone, dialCode, expectedDigits) {
  const digitsOnly = String(rawPhone).replace(/\D/g, '');
  const withCode = digitsOnly.startsWith(dialCode) ? digitsOnly : `${dialCode}${digitsOnly}`;
  const localPart = withCode.slice(dialCode.length);

  if (expectedDigits) {
    if (localPart.length !== expectedDigits) return null;
  } else if (localPart.length < 6 || localPart.length > 10) {
    return null;
  }
  return withCode;
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
async function initiatePayout({ recipientName, phone, operator, country, amount, externalReference }) {
  const payload = {
    recipient_name: recipientName,
    phone,
    operator,
    country: country || 'BJ',
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
  normalizeInternationalPhone,
  initiateCollection,
  getCollection,
  initiatePayout,
  getPayout,
};
