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
    const code = String(rawCode).toLowerCase();
    const meta = config.countryMeta(code);
    if (!meta) return; // pays inconnu de notre référentiel (devise non fiable) -> ignoré par sécurité

    if (!byCountry.has(code)) {
      byCountry.set(code, {
        code,
        country: meta.name,
        currency: meta.currency,
        paymentMethods: [],
      });
    }

    byCountry.get(code).paymentMethods.push({
      key: op.slug,
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
    const operators = await sebpay.listOperators();
    methodsCache = { data: groupOperatorsByCountry(operators), fetchedAt: Date.now() };
  }
  return methodsCache.data;
}

function findMethod(countries, countryCode, operatorSlug) {
  const country = countries.find((c) => c.code === countryCode);
  if (!country) return null;
  const method = (country.paymentMethods || []).find((m) => m.key === operatorSlug);
  if (!method) return null;
  return { country, method };
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

function fullInternationalPhone(countryCode, digitsOnly) {
  const rule = getPhoneRule(countryCode);
  return rule && rule.dialCode ? `${rule.dialCode}${digitsOnly}` : digitsOnly;
}

function webhookUrlFor(name) {
  return `${config.sebpay.publicBaseUrl}/api/webhook/sebpay/${name}`;
}

// Liste des pays et opérateurs Mobile Money pris en charge (pour peupler le
// formulaire côté front-end — expéditeur ET destinataire —, sans exposer de
// clé API côté client).
app.get('/api/methods', async (req, res) => {
  try {
    const data = await getMethods();
    const enriched = data.map((country) => ({
      ...country,
      phoneRule: getPhoneRule(country.code),
    }));
    return res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Erreur récupération des opérateurs SebPay :', error.message);
    return res.status(502).json({ success: false, message: "Impossible de récupérer la liste des réseaux disponibles." });
  }
});

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
        countryCode: senderCountryCode,
        countryName: senderMatch.country.country,
        networkName: senderMatch.method.name,
      },
      recipient: {
        countryCode,
        countryName: recipientMatch.country.country,
        currency,
        withdrawMode,
        networkName: recipientMatch.method.name,
        phone: recipientPhoneCheck.digitsOnly,
        name: recipientName,
        amount: Number(amount),
      },
      collectionId: null,
      payoutId: null,
      createdAt: new Date().toISOString(),
    };
    transfers.set(transferId, transfer);

    const collectionResult = await sebpay.initiateCollection({
      amount,
      currency,
      phone: fullInternationalPhone(senderCountryCode, senderPhoneCheck.digitsOnly),
      operator: senderOperator,
      country: senderCountryCode.toUpperCase(),
      externalReference: transferId,
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
      const status = await sebpay.getCollection(transfer.collectionId);
      if (status.status === 'approved') {
        await triggerPayout(transfer);
      } else if (status.status === 'rejected') {
        transfer.stage = 'collection_failed';
        transfer.message = "Le paiement de l'expéditeur a échoué ou a été refusé.";
      }
    } else if (transfer.stage === 'payout_pending' && transfer.payoutId) {
      const status = await sebpay.getPayout(transfer.payoutId);
      if (status.status === 'approved') {
        transfer.stage = 'completed';
        transfer.message = 'Transfert terminé avec succès.';
      } else if (status.status === 'rejected') {
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

async function triggerPayout(transfer) {
  transfer.stage = 'payout_pending';
  transfer.message = 'Paiement reçu, envoi au destinataire en cours...';

  const payoutResult = await sebpay.initiatePayout({
    recipientName: transfer.recipient.name,
    phone: fullInternationalPhone(transfer.recipient.countryCode, transfer.recipient.phone),
    operator: transfer.recipient.withdrawMode,
    country: transfer.recipient.countryCode.toUpperCase(),
    amount: transfer.recipient.amount,
    currency: transfer.recipient.currency,
    externalReference: transfer.transferId,
    callbackUrl: webhookUrlFor('payout'),
    description: `Transfert Kouamé Paiement ${transfer.transferId}`,
  });

  transfer.payoutId = payoutResult.transaction_id;
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

  const { external_reference: transferId, status } = body;
  const transfer = transferId ? transfers.get(transferId) : null;
  if (!transfer) return; // référence inconnue

  if (status === 'approved') {
    // L'argent est encaissé chez l'expéditeur : on déclenche le PAYOUT.
    triggerPayout(transfer).catch((err) => {
      console.error('Erreur déclenchement payout après collection :', err.message);
      transfer.stage = 'payout_failed';
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

  const { external_reference: transferId, status } = body;
  const transfer = transferId ? transfers.get(transferId) : null;
  if (!transfer) return; // référence inconnue

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

app.listen(config.port, () => {
  console.log(`Serveur lancé sur le port ${config.port}`);
  config.logEnvStatus();
});
