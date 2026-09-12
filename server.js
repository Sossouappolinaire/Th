// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API de
// transfert réseau -> réseau, qui combine les DEUX API FeexPay :
//
//   1) PAYIN : on encaisse chez l'EXPÉDITEUR (demande envoyée directement
//               à son numéro Mobile Money — USSD/notification — pour la
//               plupart des réseaux, ou lien de paiement `payment_url` à
//               ouvrir dans un nouvel onglet pour les réseaux à
//               redirection : Orange, Wave, Moov Côte d'Ivoire...).
//   2) Webhook / revérification (status: SUCCESSFUL) : dès que le payin est
//               confirmé, on déclenche AUTOMATIQUEMENT le PAYOUT vers le
//               DESTINATAIRE.
//   3) Webhook / revérification (status: SUCCESSFUL / FAILED) : confirme
//               (ou non) l'arrivée de l'argent chez le destinataire.
//
// Flux complet d'un transfert :
//   1) GET  /api/methods                 -> liste (catalogue statique) des
//                                            pays et réseaux Mobile Money
//                                            pris en charge par FeexPay
//                                            (voir feexpayCatalog.js —
//                                            FeexPay n'a pas de route pour
//                                            lister ses réseaux en direct).
//   2) POST /api/transfer                -> crée le transfert, lance le
//                                            PAYIN chez l'expéditeur.
//                                            Renvoie soit un lien de paiement
//                                            à ouvrir dans un nouvel onglet
//                                            (réseaux à redirection), soit
//                                            rien (l'expéditeur valide
//                                            directement sur son téléphone
//                                            via USSD/notification).
//   3) POST /api/webhook/feexpay          -> FeexPay notifie un évènement de
//                                            transaction (payin OU payout —
//                                            une seule URL de webhook côté
//                                            FeexPay). On ne fait JAMAIS
//                                            confiance au contenu du webhook
//                                            lui-même (FeexPay ne signe pas
//                                            ses webhooks) : il ne sert que
//                                            de déclencheur pour aller
//                                            revérifier le statut réel via
//                                            un appel authentifié à FeexPay.
//   4) GET  /api/transfer/:id            -> le front-end interroge l'état
//                                            (polling) ; on revérifie
//                                            toujours directement auprès de
//                                            FeexPay (au cas où un webhook
//                                            aurait été manqué, ou en
//                                            l'absence de configuration de
//                                            webhook).
//
// ⚠️ Point d'attention (à surveiller en production) : si le PAYIN réussit
// mais que le PAYOUT échoue ensuite (réseau destinataire indisponible,
// solde marchand insuffisant, etc.), l'argent a déjà été prélevé chez
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
const feexpay = require('./feexpayService');
const catalog = require('./feexpayCatalog');
const { getPhoneRule } = require('./phoneRules');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Stockage en mémoire des transferts (suffisant pour une démo ; utilisez une
// vraie base de données en production — l'état est perdu à chaque
// redémarrage/redéploiement).
const transfers = new Map(); // transferId -> transfer

// --- Catalogue des pays / opérateurs -------------------------------------
// FeexPay n'exposant aucune route pour lister ses réseaux en direct
// (contrairement à l'ancien fournisseur), ce catalogue est STATIQUE — voir
// feexpayCatalog.js. Pas de cache ni de catalogue de secours nécessaires ici.
function getMethods() {
  return catalog.publicCountries().map((country) => ({
    code: country.code,
    country: country.name,
    currency: country.currency,
    paymentMethods: country.operators.map((op) => ({
      key: op.slug,
      name: op.name,
      otpRequired: op.otpRequired,
      ussdCode: op.ussdCode,
      redirect: op.redirect,
    })),
  }));
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

// Liste des pays et opérateurs Mobile Money pris en charge (pour peupler le
// formulaire côté front-end — expéditeur ET destinataire —, sans exposer de
// clé API côté client).
function methodsHandler(req, res) {
  const data = getMethods().map((country) => ({
    ...country,
    phoneRule: getPhoneRule(country.code),
  }));
  return res.json({ success: true, source: 'catalog', degraded: false, data });
}

app.get('/api/methods', methodsHandler);
// Alias historique : certaines versions du front appelaient /api/countries.
app.get('/api/countries', methodsHandler);

// --- Étape 1 : créer le transfert et lancer le PAYIN chez l'expéditeur ----
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
    const countries = getMethods();

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

    const [firstName, ...rest] = String(senderName).trim().split(/\s+/);
    const collectionResult = await feexpay.initiateCollection({
      countryCode: senderCountryCode.toUpperCase(),
      operatorSlug: senderOperator,
      amount,
      phone: fullInternationalPhone(senderCountryCode, senderPhoneCheck.digitsOnly),
      firstName,
      lastName: rest.join(' ') || undefined,
      description: 'Transfert Kouame Paiement',
      callbackInfo: transferId,
      otpCode,
      returnUrl: `${config.feexpay.publicBaseUrl}/success.html?transferId=${transferId}`,
      cancelUrl: `${config.feexpay.publicBaseUrl}/?transferId=${transferId}`,
    });

    transfer.collectionId = collectionResult.reference;

    return res.json({
      success: true,
      transferId,
      // Présent uniquement pour les réseaux à redirection (Orange, Wave,
      // Moov Côte d'Ivoire...) : à ouvrir dans un NOUVEL ONGLET. Absent
      // sinon : l'expéditeur reçoit directement une demande
      // USSD/notification sur son téléphone.
      paymentUrl: collectionResult.paymentUrl,
      message: collectionResult.message || 'Demande de paiement envoyée à l\'expéditeur.',
    });
  } catch (error) {
    console.error('Erreur création transfert (payin) :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
    });
  }
});

// --- Étape 2 : suivi (polling) d'un transfert par le front-end ----------
// On revérifie toujours directement auprès de FeexPay (source de vérité),
// que ce soit en secours d'un webhook manqué, ou en l'absence de
// configuration de webhook côté dashboard.
app.get('/api/transfer/:transferId', async (req, res) => {
  const transfer = transfers.get(req.params.transferId);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  }

  try {
    if (transfer.stage === 'collection_pending' && transfer.collectionId) {
      const status = await feexpay.getCollectionStatus(transfer.collectionId);
      await applyCollectionStatus(transfer, status.status);
    } else if (transfer.stage === 'payout_pending' && transfer.payoutId) {
      const status = await feexpay.getPayoutStatus(transfer.payoutId);
      applyPayoutStatus(transfer, status.status);
    }
  } catch (error) {
    // On ignore silencieusement une erreur de revérification : le prochain
    // polling (ou webhook) réessaiera.
    console.warn('Revérification FeexPay échouée pour', transfer.transferId, ':', error.message);
  }

  return res.json({ success: true, transfer });
});

async function triggerPayout(transfer) {
  transfer.stage = 'payout_pending';
  transfer.message = 'Paiement reçu, envoi au destinataire en cours...';

  const payoutResult = await feexpay.initiatePayout({
    countryCode: transfer.recipient.countryCode.toUpperCase(),
    operatorSlug: transfer.recipient.withdrawMode,
    phone: fullInternationalPhone(transfer.recipient.countryCode, transfer.recipient.phone),
    amount: transfer.recipient.amount,
    motif: 'Transfert Kouame Paiement',
    callbackInfo: transfer.transferId,
  });

  transfer.payoutId = payoutResult.reference;
}

// Applique un statut de PAYIN (SUCCESSFUL / FAILED / PENDING) à un
// transfert, et déclenche le payout si nécessaire.
async function applyCollectionStatus(transfer, status) {
  if (transfer.stage !== 'collection_pending') return; // déjà traité
  if (status === 'SUCCESSFUL') {
    await triggerPayout(transfer).catch((err) => {
      console.error('Erreur déclenchement payout après payin :', err.message);
      transfer.stage = 'payout_failed';
      transfer.message = "Paiement reçu, mais l'envoi au destinataire n'a pas pu être lancé. Contactez le support.";
    });
  } else if (status === 'FAILED') {
    transfer.stage = 'collection_failed';
    transfer.message = "Le paiement de l'expéditeur a échoué ou a été refusé.";
  } // PENDING / IN PENDING STATE -> rien à faire, on reste en attente
}

// Applique un statut de PAYOUT (SUCCESSFUL / FAILED / PENDING) à un transfert.
function applyPayoutStatus(transfer, status) {
  if (transfer.stage !== 'payout_pending') return; // déjà traité
  if (status === 'SUCCESSFUL') {
    transfer.stage = 'completed';
    transfer.message = 'Transfert terminé avec succès.';
  } else if (status === 'FAILED') {
    transfer.stage = 'payout_failed';
    transfer.message = "Paiement reçu chez l'expéditeur, mais l'envoi au destinataire a échoué. Contactez le support pour un remboursement ou une nouvelle tentative.";
  } // PENDING -> rien à faire, on reste en attente
}

// --- Webhook FeexPay (payin ET payout partagent la même URL) -------------
// ⚠️ FeexPay ne signe pas ses webhooks (pas d'équivalent du
// X-SebPay-Signature de l'ancien fournisseur). On répond 200 immédiatement,
// puis on utilise le webhook UNIQUEMENT comme un déclencheur : le statut
// annoncé dans son corps n'est jamais appliqué tel quel, on revérifie
// toujours via un appel authentifié à FeexPay (getCollectionStatus /
// getPayoutStatus) avant de faire progresser le transfert.
app.post('/api/webhook/feexpay', (req, res) => {
  res.sendStatus(200);

  const body = req.body || {};
  console.log('Webhook FeexPay reçu :', body);

  const reference = feexpay.extractWebhookReference(body);
  const transferId = body.callback_info;
  if (!reference && !transferId) return; // rien d'exploitable

  const transfer = transferId
    ? transfers.get(transferId)
    : Array.from(transfers.values()).find((t) => t.collectionId === reference || t.payoutId === reference);
  if (!transfer) return; // référence inconnue

  if (transfer.stage === 'collection_pending' && transfer.collectionId) {
    feexpay.getCollectionStatus(transfer.collectionId)
      .then((status) => applyCollectionStatus(transfer, status.status))
      .catch((err) => console.warn('Revérification payin (webhook) échouée :', err.message));
  } else if (transfer.stage === 'payout_pending' && transfer.payoutId) {
    feexpay.getPayoutStatus(transfer.payoutId)
      .then((status) => applyPayoutStatus(transfer, status.status))
      .catch((err) => console.warn('Revérification payout (webhook) échouée :', err.message));
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
