// feexpayService.js
// Wrapper autour de l'API FeexPay v2 pour un vrai transfert « réseau à
// réseau » :
//
//   PAYIN (collecte) — on prélève l'argent chez l'EXPÉDITEUR : demande
//          envoyée directement à son numéro (USSD / notification) pour la
//          plupart des réseaux, ou lien de paiement (`payment_url`) à ouvrir
//          dans un nouvel onglet pour les réseaux à redirection (Orange,
//          Wave, Moov Côte d'Ivoire...). Confirmation par webhook et/ou par
//          consultation du statut.
//
//   PAYOUT (décaissement) — une fois le payin confirmé, envoie l'argent
//          vers le destinataire (réseau + numéro). Confirmation par webhook
//          et/ou par consultation du statut (toujours PENDING au lancement
//          sur la V2 : le statut final s'obtient ensuite via l'API Statut).
//
// ⚠️ Contrairement à l'ancien fournisseur (SebPay), FeexPay :
//   - n'a PAS de route générique /collections ou /payouts avec un champ
//     `operator` : chaque réseau a son propre chemin d'URL fixe (voir
//     feexpayCatalog.js pour la correspondance réseau -> chemin) ;
//   - n'a PAS de champ `callback_url` par requête : l'URL de notification se
//     configure une fois pour toutes dans le dashboard FeexPay (menu
//     Webhook) ;
//   - ne signe PAS ses webhooks (pas d'équivalent du X-SebPay-Signature /
//     HMAC). Voir verifyIncomingNotification() ci-dessous pour la parade
//     adoptée.
//
// Voir server.js pour l'orchestration complète (payin -> webhook -> payout).

const config = require('./config');
const catalog = require('./feexpayCatalog');

const BASE_URL = config.feexpay.baseUrl;

async function callFeexPay(method, path, { body } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.feexpay.apiKey}`,
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Format d'erreur FeexPay : { statusCode, message, code }. `message`
    // peut être un tableau de strings pour les erreurs de validation (400).
    const message = Array.isArray(json.message) ? json.message.join(' ; ') : (json.message || `Erreur FeexPay (HTTP ${response.status})`);
    const err = new Error(message);
    err.code = json.code || 'FEEXPAY_ERROR';
    err.raw = json;
    throw err;
  }

  return json;
}

/**
 * Nettoie une chaîne pour le champ `motif` des payouts (30 caractères
 * maximum, sans caractères spéciaux ni accents, imposé par FeexPay).
 */
function sanitizeMotif(text) {
  const ascii = String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .replace(/[^a-zA-Z0-9 ]/g, ' ') // retire les caractères spéciaux
    .replace(/\s+/g, ' ')
    .trim();
  return (ascii || 'Transfert').slice(0, 30);
}

// ------------------------------------------------------------------------
// PAYIN — collecte chez l'expéditeur
// ------------------------------------------------------------------------

/**
 * Initie une demande de paiement (payin) chez l'expéditeur.
 * POST /transactions/public/requesttopay/{reseau}
 * phone : format international SANS le "+" (ex: "22997000000").
 * otpCode : requis uniquement pour Orange Burkina Faso à ce jour (l'abonné
 * doit d'abord composer le code USSD indiqué par le catalogue).
 * Renvoie éventuellement `payment_url` (réseaux à redirection : Orange,
 * Wave, Moov Côte d'Ivoire...) — à ouvrir dans un nouvel onglet.
 */
async function initiateCollection({ countryCode, operatorSlug, amount, phone, firstName, lastName, description, callbackInfo, otpCode, returnUrl, cancelUrl }) {
  const operator = catalog.getOperator(countryCode, operatorSlug);
  if (!operator) {
    throw new Error(`Réseau expéditeur inconnu du catalogue FeexPay : ${countryCode}/${operatorSlug}`);
  }

  const payload = {
    shop: config.feexpay.shopId,
    amount: Number(amount),
    phoneNumber: phone,
  };
  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  if (description) payload.description = description;
  if (callbackInfo) payload.callback_info = callbackInfo;
  if (operator.otpRequired) payload.otp = otpCode || '';
  if (operator.redirect) {
    payload.return_url = returnUrl || config.feexpay.publicBaseUrl;
    payload.cancel_url = cancelUrl || config.feexpay.publicBaseUrl;
  }

  const data = await callFeexPay('POST', `/transactions/public/requesttopay/${operator.payinPath}`, { body: payload });
  return {
    reference: data.reference || data.order_id,
    status: data.status || 'PENDING',
    message: data.message,
    paymentUrl: data.payment_url || null,
  };
}

/**
 * Vérifie l'état d'un payin directement auprès de FeexPay — c'est la
 * SOURCE DE VÉRITÉ utilisée aussi bien pour le polling que pour confirmer
 * un webhook reçu (voir server.js), FeexPay ne signant pas ses webhooks.
 * GET /transactions/public/single/status/{reference}
 */
async function getCollectionStatus(reference) {
  return callFeexPay('GET', `/transactions/public/single/status/${encodeURIComponent(reference)}`);
}

// ------------------------------------------------------------------------
// PAYOUT — envoi vers le destinataire
// ------------------------------------------------------------------------

/**
 * Initie un décaissement Mobile Money vers un destinataire.
 * POST /payouts/public/{reseau ou route mutualisée}
 * phone : format international SANS le "+".
 * Sur la V2, le lancement renvoie toujours un statut PENDING : le statut
 * final s'obtient ensuite via getPayoutStatus().
 */
async function initiatePayout({ countryCode, operatorSlug, phone, amount, motif, email, callbackInfo }) {
  const operator = catalog.getOperator(countryCode, operatorSlug);
  if (!operator) {
    throw new Error(`Réseau destinataire inconnu du catalogue FeexPay : ${countryCode}/${operatorSlug}`);
  }

  const payload = {
    shop: config.feexpay.shopId,
    amount: Number(amount),
    phoneNumber: phone,
    motif: sanitizeMotif(motif),
  };
  if (operator.payoutNetwork) payload.network = operator.payoutNetwork;
  if (email) payload.email = email;
  if (callbackInfo) payload.callback_info = callbackInfo;

  const data = await callFeexPay('POST', `/payouts/public/${operator.payoutPath}`, { body: payload });
  return {
    reference: data.reference,
    status: data.status || 'PENDING',
    message: data.message,
  };
}

/**
 * Vérifie l'état d'un payout directement auprès de FeexPay.
 * GET /payouts/status/public/{reference}
 */
async function getPayoutStatus(reference) {
  return callFeexPay('GET', `/payouts/status/public/${encodeURIComponent(reference)}`);
}

// ------------------------------------------------------------------------
// Webhooks — pas de signature chez FeexPay (contrairement à SebPay)
// ------------------------------------------------------------------------

/**
 * FeexPay envoie ses webhooks SANS en-tête de signature (pas d'équivalent
 * du X-SebPay-Signature / HMAC de l'ancien fournisseur) : un webhook reçu
 * ne peut donc PAS être considéré comme authentifié par lui-même — un tiers
 * connaissant l'URL du webhook pourrait en théorie forger un payload.
 *
 * Parade adoptée dans server.js : à la réception d'un webhook, on ne fait
 * JAMAIS confiance directement à son contenu (statut, montant...) pour
 * faire progresser un transfert. On l'utilise uniquement comme un
 * DÉCLENCHEUR pour aller revérifier le statut réel via getCollectionStatus()
 * / getPayoutStatus(), qui sont des appels authentifiés (Authorization:
 * Bearer <clé API>) directement auprès de FeexPay. C'est cette réponse-là,
 * et elle seule, qui fait foi.
 */
function extractWebhookReference(body) {
  return (body && (body.reference || body.order_id)) || null;
}

module.exports = {
  initiateCollection,
  getCollectionStatus,
  initiatePayout,
  getPayoutStatus,
  extractWebhookReference,
  sanitizeMotif,
};
