// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API de
// transfert réseau -> réseau, qui combine les DEUX API SebPay :
//
//   1) COLLECTION : on encaisse chez l'EXPÉDITEUR (demande envoyée
//               directement à son numéro Mobile Money — USSD/notification —
//               ou lien à ouvrir dans un nouvel onglet pour certains
//               opérateurs comme Wave).
//   2) Webhook collection (status: approved) : dès que l'encaissement est
//               confirmé, on déclenche AUTOMATIQUEMENT le PAYOUT vers le
//               DESTINATAIRE.
//   3) Webhook payout (status: approved / rejected) : confirme (ou non)
//               l'arrivée de l'argent chez le destinataire.
//
// Flux complet d'un transfert :
//   1) GET  /api/methods                 -> liste (mise en cache) des pays et
//                                            opérateurs Mobile Money disponibles,
//                                            interrogée en direct auprès de
//                                            SebPay (jamais codée en dur).
//   2) POST /api/transfer                -> crée le transfert, lance la
//                                            COLLECTION chez l'expéditeur.
//                                            Renvoie soit un lien de paiement
//                                            à ouvrir dans un nouvel onglet
//                                            (Wave), soit rien (l'expéditeur
//                                            valide directement sur son
//                                            téléphone via USSD/notification).
//   3) POST /api/webhook/sebpay/collection -> SebPay confirme l'encaissement
//                                            -> on lance alors le PAYOUT.
//   4) POST /api/webhook/sebpay/payout     -> SebPay confirme (ou non)
//                                            l'envoi au destinataire.
//   5) GET  /api/transfer/:id            -> le front-end interroge l'état
//                                            (polling) ; en secours, si l'état
//                                            reste "pending" trop longtemps,
//                                            on revérifie directement auprès
//                                            de SebPay (au cas où un webhook
//                                            aurait été manqué).
//
// ⚠️ Point d'attention (à surveiller en production) : si la COLLECTION
// réussit mais que le PAYOUT échoue ensuite (réseau destinataire
// indisponible, solde marchand insuffisant, etc.), l'argent a déjà été
// prélevé chez l'expéditeur. Selon la doc SebPay, un payout en échec
// rembourse automatiquement VOTRE WALLET SebPay — pas directement
// l'expéditeur. Le statut du transfert passe alors à "payout_failed" : à
// vous de mettre en place un remboursement de l'expéditeur, une nouvelle
// tentative de payout, ou un suivi manuel.
//
// ⚠️ Limite volontaire : ce service ne fait AUCUNE conversion de devise. Un
// transfert n'est autorisé que si le pays de l'expéditeur et celui du
// destinataire partagent la même devise (ex : Bénin -> Sénégal, tous deux en
// XOF). Un transfert entre devises différentes est refusé explicitement
// plutôt que d'appliquer un taux de change inventé.

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const config = require('./config');
const sebpay = require('./sebpayService');
const { getPhoneRule } = require('./phoneRules');

const app = express();
// On conserve le corps brut de la requête (req.rawBody) pour pouvoir
// vérifier la signature HMAC des webhooks SebPay, qui est calculée sur les
// octets exacts envoyés — pas sur une re-sérialisation JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

// Stockage en mémoire des transferts (suffisant pour une démo ; utilisez une
// vraie base de données en production — l'état est perdu à chaque
// redémarrage/redéploiement).
const transfers = new Map(); // transferId -> transfer
// SebPay impose une external_reference UNIQUE par transaction : réutiliser la
// même pour la collecte ET le payout faisait rejeter le payout (« reference
// already used ») -> l'argent était encaissé mais jamais envoyé.
// On génère donc des références distinctes et on garde un index pour
// retrouver le transfert quand un webhook arrive.
const refIndex = new Map(); // external_reference -> transferId

function registerRef(ref, transferId) {
  if (ref) refIndex.set(ref, transferId);
}

function transferByRef(ref) {
  if (!ref) return null;
  const direct = transfers.get(ref);
  if (direct) return direct;
  const id = refIndex.get(ref);
  return id ? transfers.get(id) || null : null;
}

// --- Cache de la liste des pays / opérateurs (interrogée en direct) -----
let methodsCache = { data: [], fetchedAt: 0 };
const METHODS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — la doc SebPay recommande de ne pas figer cette liste trop longtemps (otp_required peut évoluer)

function groupOperatorsByCountry(operators) {
  const byCountry = new Map(); // code pays (minuscule) -> { code, country, currency, paymentMethods: [] }

  operators.forEach((op) => {
    // Le champ "country" renvoyé par SebPay peut être un objet ({code, name})
    // ou directement un code selon les opérateurs ; on gère les deux cas.
    const rawCode = (op.country && (op.country.code || op.country.id)) || op.country_code || op.country;
    if (!rawCode) return;
    const code = config.normalizeCountryCode(rawCode);
    if (!code) return; // pays inconnu de notre référentiel (devise non fiable) -> ignoré par sécurité
    const meta = config.countryMeta(code);
    if (!meta) return;

    if (!byCountry.has(code)) {
      byCountry.set(code, {
        code,
        country: meta.name,
        currency: meta.currency,
        paymentMethods: [],
      });
    }

    const slug = op.slug || op.code || op.key;
    if (!slug) return;
    if (byCountry.get(code).paymentMethods.some((m) => m.key === slug)) return;
    byCountry.get(code).paymentMethods.push({
      key: slug,
      name: op.name,
      otpRequired: Boolean(op.otp_required),
      ussdCode: op.ussd_code || null,
    });
  });

  return Array.from(byCountry.values());
}

async function getMethods({ forceRefresh = false } = {}) {
  const isStale = Date.now() - methodsCache.fetchedAt > METHODS_CACHE_TTL_MS;
  if (forceRefresh || isStale || methodsCache.data.length === 0) {
    try {
      const operators = await sebpay.listOperators();
      const grouped = groupOperatorsByCountry(operators);
      if (grouped.length > 0) {
        methodsCache = { data: grouped, fetchedAt: Date.now(), source: 'sebpay' };
      } else {
        console.warn('SebPay a répondu sans opérateur exploitable : catalogue de secours utilisé.');
        methodsCache = { data: config.fallbackCountries(), fetchedAt: Date.now(), source: 'fallback' };
      }
    } catch (error) {
      console.error('GET /operators SebPay a échoué :', error.message, '- catalogue de secours utilisé.');
      // On ne laisse JAMAIS le formulaire sans pays : catalogue de secours,
      // et cache court pour retenter rapidement l'appel direct.
      methodsCache = {
        data: config.fallbackCountries(),
        fetchedAt: Date.now() - (METHODS_CACHE_TTL_MS - 60 * 1000),
        source: 'fallback',
      };
    }
  }
  return methodsCache.data;
}

function findMethod(countries, countryCode, operatorSlug) {
  const code = config.normalizeCountryCode(countryCode);
  const country = countries.find((c) => c.code === code);
  if (!country) return null;
  const methods = country.paymentMethods || [];
  // Le slug envoyé par le formulaire peut être ancien ou sans suffixe pays
  // ("moov" au lieu de "moov-bj") : on le ramène au slug SebPay réel, sinon
  // le payout partait avec un opérateur inconnu et échouait.
  const resolved = config.resolveOperatorSlug(code, operatorSlug, methods.map((m) => m.key));
  const method = methods.find((m) => m.key === resolved);
  if (!method) return null;
  if (config.INACTIVE_OPERATORS.has(method.key)) return null;
  return { country, method, slug: method.key };
}

function validatePhone(phone, countryCode, label) {
  const digitsOnly = String(phone || '').replace(/\D/g, '');
  const rule = getPhoneRule(countryCode);
  if (rule && typeof rule.digits === 'number' && digitsOnly.length !== rule.digits) {
    return { error: `Numéro invalide pour ${label} : ${rule.digits} chiffres attendus (ex : ${rule.example}).` };
  }
  if ((!rule || typeof rule.digits !== 'number') && (digitsOnly.length < 6 || digitsOnly.length > 12)) {
    return { error: `Numéro de téléphone (${label}) invalide.` };
  }
  return { digitsOnly };
}

/**
 * Numéro au format international SANS le « + », comme exigé par SebPay
 * (/collections et /payouts). On enlève un éventuel « 00 » ou indicatif déjà
 * saisi pour ne jamais envoyer un indicatif en double (ex : 229229...), qui
 * faisait rejeter le décaissement.
 */
function fullInternationalPhone(countryCode, phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  const rule = getPhoneRule(countryCode);
  if (!rule || !rule.dialCode) return digits;
  const dial = rule.dialCode;
  if (digits.startsWith('00' + dial)) digits = digits.slice(2 + dial.length);
  else if (digits.startsWith(dial) && (!rule.digits || digits.length === dial.length + rule.digits)) {
    digits = digits.slice(dial.length);
  }
  return `${dial}${digits}`;
}

function webhookUrlFor(name) {
  return `${config.sebpay.publicBaseUrl}/api/webhook/sebpay/${name}`;
}

// Liste des pays et opérateurs Mobile Money pris en charge (pour peupler le
// formulaire côté front-end — expéditeur ET destinataire —, sans exposer de
// clé API côté client).
async function methodsHandler(req, res) {
  try {
    const data = await getMethods();
    const enriched = data.map((country) => ({
      ...country,
      phoneRule: getPhoneRule(country.code),
    }));
    return res.json({
      success: true,
      source: methodsCache.source || 'sebpay',
      degraded: methodsCache.source === 'fallback',
      data: enriched,
    });
  } catch (error) {
    console.error('Erreur récupération des opérateurs SebPay :', error.message);
    const data = config.fallbackCountries().map((country) => ({
      ...country,
      phoneRule: getPhoneRule(country.code),
    }));
    return res.json({ success: true, source: 'fallback', degraded: true, data });
  }
}

app.get('/api/methods', methodsHandler);
// Alias historique : certaines versions du front appelaient /api/countries.
app.get('/api/countries', methodsHandler);

// --- Étape 1 : créer le transfert et lancer la COLLECTION chez l'expéditeur
app.post('/api/transfer', async (req, res) => {
  const {
    senderPhone, senderName, senderCountryCode, senderOperator, otpCode,
    countryCode, withdrawMode, phone, recipientName, amount,
  } = req.body;

  if (!senderPhone || !senderName || !senderCountryCode || !senderOperator) {
    return res.status(400).json({ success: false, message: 'senderPhone, senderName, senderCountryCode et senderOperator sont requis.' });
  }
  if (!countryCode || !withdrawMode || !phone || !recipientName || !amount) {
    return res.status(400).json({
      success: false,
      message: 'countryCode, withdrawMode, phone, recipientName et amount (destinataire) sont requis.',
    });
  }
  if (Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Montant invalide.' });
  }

  try {
    const countries = await getMethods();

    const senderMatch = findMethod(countries, senderCountryCode, senderOperator);
    if (!senderMatch) {
      return res.status(400).json({ success: false, message: 'Pays ou réseau expéditeur non reconnu. Merci de resélectionner un réseau dans la liste.' });
    }
    const recipientMatch = findMethod(countries, countryCode, withdrawMode);
    if (!recipientMatch) {
      return res.status(400).json({ success: false, message: 'Pays ou réseau destinataire non reconnu. Merci de resélectionner un réseau dans la liste.' });
    }

    // Pas de conversion de devise gérée par ce service : on refuse plutôt
    // que d'inventer un taux de change.
    if (senderMatch.country.currency !== recipientMatch.country.currency) {
      return res.status(400).json({
        success: false,
        message: `Ce service ne prend pas en charge les transferts entre devises différentes (${senderMatch.country.currency} → ${recipientMatch.country.currency}).`,
      });
    }

    const senderPhoneCheck = validatePhone(senderPhone, senderCountryCode, "l'expéditeur");
    if (senderPhoneCheck.error) return res.status(400).json({ success: false, message: senderPhoneCheck.error });

    const recipientPhoneCheck = validatePhone(phone, countryCode, `le destinataire (${recipientMatch.country.country})`);
    if (recipientPhoneCheck.error) return res.status(400).json({ success: false, message: recipientPhoneCheck.error });

    if (senderMatch.method.otpRequired && !otpCode) {
      return res.status(400).json({
        success: false,
        message: `Code OTP requis pour ${senderMatch.method.name}. Composez ${senderMatch.method.ussdCode || 'le code USSD indiqué'} sur votre téléphone, puis saisissez le code reçu.`,
      });
    }

    const transferId = crypto.randomUUID();
    const currency = senderMatch.country.currency;

    const transfer = {
      transferId,
      stage: 'collection_pending', // collection_pending -> collection_failed | payout_pending -> completed | payout_failed
      message: "En attente du paiement de l'expéditeur.",
      sender: {
        phone: senderPhoneCheck.digitsOnly,
        name: senderName,
        countryCode: config.normalizeCountryCode(senderCountryCode) || senderCountryCode,
        countryName: senderMatch.country.country,
        networkName: senderMatch.method.name,
      },
      recipient: {
        countryCode: config.normalizeCountryCode(countryCode) || countryCode,
        countryName: recipientMatch.country.country,
        currency,
        withdrawMode,
        payoutOperator: recipientMatch.slug, // slug SebPay réel utilisé pour /payouts
        networkName: recipientMatch.method.name,
        phone: recipientPhoneCheck.digitsOnly,
        name: recipientName,
        amount: Number(amount),
      },
      collectionId: null,
      payoutId: null,
      createdAt: new Date().toISOString(),
    };
    transfer.collectionRef = `${transferId}-c`;
    transfers.set(transferId, transfer);
    registerRef(transferId, transferId);
    registerRef(transfer.collectionRef, transferId);

    const collectionResult = await sebpay.initiateCollection({
      amount,
      currency,
      phone: fullInternationalPhone(senderCountryCode, senderPhoneCheck.digitsOnly),
      operator: config.apiOperatorSlug(senderMatch.slug, senderMatch.country.code),
      country: senderCountryCode.toUpperCase(),
      externalReference: transfer.collectionRef,
      callbackUrl: webhookUrlFor('collection'),
      otpCode,
    });

    transfer.collectionId = collectionResult.transaction_id;

    return res.json({
      success: true,
      transferId,
      // Présent uniquement pour certains opérateurs (ex : Wave) : à ouvrir
      // dans un NOUVEL ONGLET, conformément à la doc SebPay. Absent sinon :
      // l'expéditeur valide directement sur son téléphone (USSD/notification).
      paymentUrl: collectionResult.provider_link || null,
      message: collectionResult.message || 'Demande de paiement envoyée à l\'expéditeur.',
    });
  } catch (error) {
    console.error('Erreur création transfert (collection) :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
    });
  }
});

// --- Étape 2 : suivi (polling) d'un transfert par le front-end ----------
// Filet de sécurité : si l'état est encore "pending" et n'a pas bougé
// depuis un moment, on revérifie directement auprès de SebPay, au cas où un
// webhook aurait été manqué (la doc SebPay présente le webhook comme le
// mécanisme principal et le polling comme un complément).
app.get('/api/transfer/:transferId', async (req, res) => {
  const transfer = transfers.get(req.params.transferId);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  }

  try {
    if (transfer.stage === 'collection_pending' && transfer.collectionId) {
      const status = await sebpay.getCollection(transfer.collectionId || transfer.collectionRef);
      const state = sebpay.normalizeStatus(status.status);
      if (state === 'approved') {
        await triggerPayout(transfer);
      } else if (state === 'rejected') {
        transfer.stage = 'collection_failed';
        transfer.message = "Le paiement de l'expéditeur a échoué ou a été refusé.";
      }
    } else if (transfer.stage === 'collection_pending' && !transfer.collectionId) {
      // Rien à revérifier : la collecte n'a pas pu être créée.
    } else if (transfer.stage === 'payout_pending' && (transfer.payoutId || transfer.payoutRef)) {
      const status = await sebpay.getPayout(transfer.payoutId || transfer.payoutRef);
      const state = sebpay.normalizeStatus(status.status);
      if (state === 'approved') {
        transfer.stage = 'completed';
        transfer.message = 'Transfert terminé avec succès.';
      } else if (state === 'rejected') {
        transfer.stage = 'payout_failed';
        transfer.message = "Paiement reçu chez l'expéditeur, mais l'envoi au destinataire a échoué. Contactez le support.";
      }
    }
  } catch (error) {
    // On ignore silencieusement une erreur de revérification : le webhook
    // reste la source de vérité principale, ce polling n'est qu'un filet.
    console.warn('Revérification SebPay échouée pour', transfer.transferId, ':', error.message);
  }

  return res.json({ success: true, transfer });
});

const PAYOUT_MAX_ATTEMPTS = 3;

function isRetryablePayoutError(error) {
  const msg = String((error && error.message) || '').toLowerCase();
  return ['timeout', 'temporair', 'temporar', 'try again', 'réessay', 'reessay',
    'insufficient', 'solde', 'balance', 'unavailable', 'indisponible',
    'internal server error', 'too many requests', 'rate limit', 'fetch failed',
    'network'].some((k) => msg.includes(k));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Décaissement vers le destinataire (POST /payouts).
 *
 * Points corrigés (cause des « paiement reçu mais envoi non lancé ») :
 *  - external_reference distincte de celle de la collecte (et distincte à
 *    chaque nouvelle tentative), sinon SebPay refuse la transaction ;
 *  - slug opérateur du DESTINATAIRE résolu au format SebPay (`moov-bj`…) ;
 *  - numéro remis au format international sans « + » ;
 *  - le transfert ne passe en « envoi en cours » qu'une fois SebPay ayant
 *    accepté la demande — en cas d'échec on enregistre la vraie raison au
 *    lieu de laisser le transfert bloqué ;
 *  - nouvelles tentatives automatiques sur les erreurs passagères.
 */
async function triggerPayout(transfer, { manual = false } = {}) {
  if (transfer.payoutId) return transfer; // déjà lancé : jamais deux fois
  if (transfer.payoutInFlight) return transfer;
  transfer.payoutInFlight = true;
  transfer.message = 'Paiement reçu, envoi au destinataire en cours...';

  const attemptBase = transfer.payoutAttempts || 0;
  let lastError = null;

  try {
    for (let i = 1; i <= PAYOUT_MAX_ATTEMPTS; i += 1) {
      const attempt = attemptBase + i;
      // Référence unique par tentative : SebPay est idempotent sur ce champ,
      // réutiliser la précédente renverrait l'échec précédent.
      const payoutRef = `${transfer.transferId}-p${attempt}`;
      registerRef(payoutRef, transfer.transferId);
      transfer.payoutRef = payoutRef;
      transfer.payoutAttempts = attempt;

      try {
        const payoutResult = await sebpay.initiatePayout({
          recipientName: transfer.recipient.name,
          phone: fullInternationalPhone(transfer.recipient.countryCode, transfer.recipient.phone),
          operator: config.apiOperatorSlug(
            transfer.recipient.payoutOperator || transfer.recipient.withdrawMode,
            transfer.recipient.countryCode,
          ),
          country: transfer.recipient.countryCode.toUpperCase(),
          amount: transfer.recipient.amount,
          currency: transfer.recipient.currency,
          externalReference: payoutRef,
          callbackUrl: webhookUrlFor('payout'),
          description: `Transfert Kouame Paiement ${transfer.transferId}`,
        });

        transfer.payoutId = payoutResult.transaction_id || payoutRef;
        registerRef(transfer.payoutId, transfer.transferId);
        transfer.payoutFee = payoutResult.fee_amount ?? null;
        transfer.stage = 'payout_pending';
        transfer.lastError = null;
        transfer.message = "Paiement reçu, envoi au destinataire en cours...";

        // Certains opérateurs répondent déjà "approved" à l'initiation.
        if (sebpay.normalizeStatus(payoutResult.status) === 'approved') {
          transfer.stage = 'completed';
          transfer.message = 'Transfert terminé avec succès.';
        }
        return transfer;
      } catch (error) {
        lastError = error;
        console.error(
          `Payout tentative ${attempt} échouée pour ${transfer.transferId} :`,
          error.message,
          JSON.stringify(error.raw || {}),
        );
        if (i < PAYOUT_MAX_ATTEMPTS && isRetryablePayoutError(error)) {
          await sleep(2000 * i);
          continue;
        }
        break;
      }
    }

    transfer.stage = 'payout_failed';
    transfer.lastError = lastError ? lastError.message : 'Erreur inconnue';
    transfer.message = `Paiement reçu, mais l'envoi au destinataire n'a pas pu être lancé (${transfer.lastError}). Nos équipes peuvent le relancer.`;
    const err = new Error(transfer.lastError);
    err.code = 'PAYOUT_FAILED';
    if (manual) throw err;
    return transfer;
  } finally {
    transfer.payoutInFlight = false;
  }
}

// --- Webhook COLLECTION : encaissement chez l'expéditeur ------------------
app.post('/api/webhook/sebpay/collection', (req, res) => {
  const signature = req.get('X-SebPay-Signature');
  if (!sebpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('Webhook SebPay (collection) : signature invalide, requête ignorée.');
    return res.sendStatus(401);
  }

  // Répondre 200 immédiatement ; le reste du traitement continue ensuite.
  res.sendStatus(200);

  const body = req.body || {};
  console.log('Webhook SebPay (collection) reçu :', body);

  const transfer = transferByRef(body.external_reference) || transferByRef(body.transaction_id);
  if (!transfer) return; // référence inconnue
  const status = sebpay.normalizeStatus(body.status);

  if (status === 'approved') {
    // L'argent est encaissé chez l'expéditeur : on déclenche le PAYOUT.
    transfer.collectedAt = transfer.collectedAt || new Date().toISOString();
    triggerPayout(transfer).catch((err) => {
      console.error('Erreur déclenchement payout après collection :', err.message);
      transfer.stage = 'payout_failed';
      transfer.lastError = err.message;
      transfer.message = "Paiement reçu, mais l'envoi au destinataire n'a pas pu être lancé. Contactez le support.";
    });
  } else if (status === 'rejected') {
    transfer.stage = 'collection_failed';
    transfer.message = "Le paiement de l'expéditeur a échoué ou a été refusé.";
  } else {
    transfer.stage = 'collection_pending';
    transfer.message = 'Paiement en cours de traitement...';
  }
});

// --- Webhook PAYOUT : envoi vers le destinataire ---------------------------
app.post('/api/webhook/sebpay/payout', (req, res) => {
  const signature = req.get('X-SebPay-Signature');
  if (!sebpay.verifyWebhookSignature(req.rawBody, signature)) {
    console.warn('Webhook SebPay (payout) : signature invalide, requête ignorée.');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const body = req.body || {};
  console.log('Webhook SebPay (payout) reçu :', body);

  const transfer = transferByRef(body.external_reference) || transferByRef(body.transaction_id);
  if (!transfer) return; // référence inconnue
  const status = sebpay.normalizeStatus(body.status);

  if (status === 'approved') {
    transfer.stage = 'completed';
    transfer.message = 'Transfert terminé avec succès.';
  } else if (status === 'rejected') {
    transfer.stage = 'payout_failed';
    transfer.message = "Paiement reçu chez l'expéditeur, mais l'envoi au destinataire a échoué ou a été refusé. Contactez le support pour un remboursement ou une nouvelle tentative.";
  }
});

// Route de vérification post-déploiement : à ouvrir dans le navigateur
// (https://votre-service.onrender.com/api/health) pour confirmer que les
// variables d'environnement sont bien chargées sur Render. Ne renvoie
// jamais les valeurs elles-mêmes, seulement si chaque variable est définie.
app.get('/api/health', (req, res) => {
  const report = config.checkEnvVars();
  return res.status(report.ok ? 200 : 500).json(report);
});


// --- Relance manuelle d'un décaissement -----------------------------------
// Sert quand le payout n'a pas pu être lancé (réseau destinataire momentanément
// indisponible, solde wallet insuffisant au moment de la collecte...).
// L'argent a déjà été encaissé : la relance ne re-débite pas l'expéditeur.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(401).json({ success: false, message: "ADMIN_TOKEN n'est pas configuré sur le serveur." });
  if (req.get('X-Admin-Token') !== ADMIN_TOKEN) return res.status(401).json({ success: false, message: 'Accès réservé aux administrateurs.' });
  return next();
}

function publicTransfer(t) {
  return {
    reference: t.transferId,
    transferId: t.transferId,
    stage: t.stage,
    message: t.message,
    lastError: t.lastError || null,
    amount: t.recipient.amount,
    currency: t.recipient.currency,
    countryCode: t.recipient.countryCode.toUpperCase(),
    operator: t.recipient.payoutOperator || t.recipient.withdrawMode,
    recipient: t.recipient,
    sender: t.sender,
    collectionId: t.collectionId,
    payoutId: t.payoutId,
    payoutAttempts: t.payoutAttempts || 0,
    createdAt: t.createdAt,
  };
}

async function retryPayoutFor(transfer) {
  if (transfer.stage === 'completed') return { ok: true, message: 'Transfert déjà terminé.' };
  if (transfer.stage === 'collection_failed') return { ok: false, message: "L'encaissement a échoué : rien à envoyer." };
  if (transfer.stage === 'collection_pending') return { ok: false, message: "L'encaissement n'est pas encore confirmé." };
  transfer.payoutId = null; // nouvelle tentative = nouvelle référence
  try {
    await triggerPayout(transfer, { manual: true });
    return { ok: true, message: transfer.message };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

app.post('/api/transfer/:transferId/retry-payout', requireAdmin, async (req, res) => {
  const transfer = transfers.get(req.params.transferId) || transferByRef(req.params.transferId);
  if (!transfer) return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  const result = await retryPayoutFor(transfer);
  return res.status(result.ok ? 200 : 400).json({ success: result.ok, message: result.message, transfer: publicTransfer(transfer) });
});

app.get('/api/admin/all', requireAdmin, (req, res) => {
  const data = Array.from(transfers.values()).map(publicTransfer);
  return res.json({ success: true, count: data.length, transfers: data, data });
});

app.get('/api/admin/pending', requireAdmin, (req, res) => {
  const data = Array.from(transfers.values())
    .filter((t) => t.stage !== 'completed')
    .map(publicTransfer);
  return res.json({ success: true, count: data.length, transfers: data, data });
});

app.get('/api/admin/transfer/:reference/check', requireAdmin, async (req, res) => {
  const transfer = transfers.get(req.params.reference) || transferByRef(req.params.reference);
  if (!transfer) return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  try {
    if (transfer.payoutId || transfer.payoutRef) {
      const status = await sebpay.getPayout(transfer.payoutId || transfer.payoutRef);
      const state = sebpay.normalizeStatus(status.status);
      if (state === 'approved') { transfer.stage = 'completed'; transfer.message = 'Transfert terminé avec succès.'; }
      if (state === 'rejected') { transfer.stage = 'payout_failed'; transfer.message = "L'envoi au destinataire a été refusé."; }
    } else if (transfer.collectionId || transfer.collectionRef) {
      const status = await sebpay.getCollection(transfer.collectionId || transfer.collectionRef);
      if (sebpay.normalizeStatus(status.status) === 'approved') await triggerPayout(transfer);
    }
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  return res.json({ success: true, transfer: publicTransfer(transfer) });
});

// Relance en masse de tous les transferts encaissés mais non envoyés.
app.post('/api/admin/fix-pending', requireAdmin, async (req, res) => {
  const stuck = Array.from(transfers.values()).filter((t) => t.stage === 'payout_failed' || (t.stage === 'payout_pending' && !t.payoutId));
  const results = [];
  for (const transfer of stuck) {
    // eslint-disable-next-line no-await-in-loop
    const result = await retryPayoutFor(transfer);
    results.push({ reference: transfer.transferId, ...result });
  }
  return res.json({ success: true, fixed: results.filter((r) => r.ok).length, total: stuck.length, results });
});

app.listen(config.port, () => {
  console.log(`Serveur lancé sur le port ${config.port}`);
  config.logEnvStatus();
});
