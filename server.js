// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API
// de transfert d'argent qui appelle SebPay côté serveur (les clés API ne
// sont jamais exposées au navigateur).
//
// Logique du transfert :
//   1) POST /api/transfer      -> initie une COLLECTE chez l'expéditeur, dans
//        SON pays (n'importe lequel des pays de countries.js, plus seulement
//        le Bénin depuis le 01/09/2026 — voir doc SebPay /collections).
//   2) POST /api/webhook       -> SebPay notifie le statut final.
//        - collecte "approved" -> on déclenche un PAYOUT vers le destinataire,
//          dans SON pays (même pays que l'expéditeur en national, un autre
//          pays en international).
//        - payout "approved"   -> le transfert est marqué "completed".
//        - "rejected"          -> le transfert est marqué "failed".
//        - payout en échec après collecte réussie -> "blocked" (argent coincé
//          dans le wallet SebPay, actionnable depuis le panneau admin).
//   3) GET /api/transfer/:ref  -> le front-end interroge l'état du transfert.
//   4) GET /api/countries      -> liste des pays/réseaux Mobile Money proposés.
//
// Panneau ADMIN (protégé par un jeton, voir config.admin.token) :
//   5) GET  /api/admin/pending              -> liste tous les transferts en attente/bloqués.
//   6) POST /api/admin/fix-pending          -> réconcilie TOUS les transferts en
//        attente avec l'état réel chez SebPay (rattrape les webhooks manqués).
//   7) POST /api/admin/transfer/:ref/check  -> réconcilie UN transfert et renvoie son état réel.
//   8) POST /api/admin/transfer/:ref/cancel -> annule un transfert bloqué et RENVOIE
//        l'argent au numéro émetteur béninois.
//   9) POST /api/admin/transfer/:ref/retry  -> relance l'envoi vers le destinataire.

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const path = require('path');
const config = require('./config');
const sebpay = require('./sebpayService');
const countries = require('./countries');

const app = express();

// SebPay refuse tout PAYOUT sous ce seuil ("amount_below_min"). Comme le
// destinataire ET un éventuel remboursement passent tous les deux par un
// payout, un transfert sous ce montant ne pourra jamais être renvoyé nulle
// part par l'API en cas d'échec — l'argent resterait coincé sans solution
// automatisée. D'où le blocage préventif à la création (voir POST /api/transfer).
const MIN_PAYOUT_AMOUNT_XOF = 300;

// Commission plateforme (voir config.fees.platformFeePercent) : elle est
// déduite du montant envoyé au destinataire, jamais du montant collecté
// chez l'expéditeur. Comme le payout (destinataire) doit lui-même rester
// au-dessus de MIN_PAYOUT_AMOUNT_XOF, le montant minimum qu'un expéditeur
// peut envoyer est recalculé en conséquence (ex : avec 5%, il faut
// collecter au moins ~316 XOF pour qu'il en reste 300 après commission).
const PLATFORM_FEE_PERCENT = Number(config.fees && config.fees.platformFeePercent) || 0;
const MIN_TRANSFER_AMOUNT_XOF = Math.ceil(MIN_PAYOUT_AMOUNT_XOF / (1 - PLATFORM_FEE_PERCENT / 100));

/** Calcule la commission plateforme et le montant net envoyé au destinataire
 * pour un montant collecté donné. Les deux sont arrondis à l'unité XOF la
 * plus proche (XOF n'a pas de centimes) de façon à ce que
 * feeAmount + payoutAmount === amount, toujours. */
function computeFeeSplit(amount) {
  const feeAmount = Math.round((Number(amount) * PLATFORM_FEE_PERCENT) / 100);
  const payoutAmount = Number(amount) - feeAmount;
  return { feeAmount, payoutAmount };
}

// ---------------------------------------------------------------------------
// Persistance des transferts (fichier JSON local)
// ---------------------------------------------------------------------------
// ⚠️ L'API SebPay n'expose AUCUNE route pour "lister tout ce qui est en
// attente" : GET /collections/{id} et GET /payouts/{id} exigent de déjà
// connaître la référence. Il est donc impossible d'interroger SebPay au
// démarrage pour retrouver les transferts oubliés — l'appli DOIT garder
// elle-même la liste des références à vérifier. D'où cette persistance sur
// disque : elle survit à un crash/redémarrage du process (contrairement à un
// Map en mémoire), mais PAS à un redéploiement Render qui recrée le disque.
// Pour une garantie totale même après redéploiement, remplacez ce fichier
// JSON par une vraie base de données (Postgres, SQLite sur un Render Disk...).
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'transfers.json');

// Stockage en mémoire des transferts en cours, rechargé depuis DATA_FILE au
// démarrage puis réécrit sur disque après chaque changement.
//
// Un même transfert peut être indexé sous plusieurs clés (sa référence
// d'origine "TRF-...", puis "TRF-...-OUT" pour le payout, etc.) mais
// `transfer.reference` pointe toujours vers la référence CANONIQUE
// (celle d'origine) : c'est elle qu'il faut utiliser pour dédupliquer.
const transfers = new Map();

/** Recharge les transferts depuis le fichier JSON au démarrage. */
function loadTransfers() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const entries = JSON.parse(raw); // [[key, transferObject], ...]

    // Reconstitue le partage d'objet entre alias d'une même transaction
    // (plusieurs clés doivent pointer vers LE MÊME objet, comme en mémoire).
    const canonicalByReference = new Map();
    for (const [, transfer] of entries) {
      if (!canonicalByReference.has(transfer.reference)) {
        canonicalByReference.set(transfer.reference, transfer);
      }
    }
    for (const [key, transfer] of entries) {
      transfers.set(key, canonicalByReference.get(transfer.reference) || transfer);
    }
    console.log(`Transferts rechargés depuis le disque : ${canonicalByReference.size} transaction(s).`);
  } catch (error) {
    console.error('Impossible de recharger data/transfers.json :', error.message);
  }
}

/** Sauvegarde l'état courant de tous les transferts sur disque. */
function saveTransfers() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify([...transfers.entries()], null, 2));
  } catch (error) {
    console.error('Impossible d\'écrire data/transfers.json :', error.message);
  }
}

loadTransfers();

// Capture le corps brut (nécessaire pour vérifier la signature HMAC du webhook)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Aides internes
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/** Retrouve un transfert à partir de n'importe quelle référence connue
 * (référence d'origine, référence "-OUT", "-RETRY-...", "-REFUND"...). */
function findTransfer(rawReference) {
  const reference = String(rawReference || '').trim();
  if (!reference) return null;
  if (transfers.has(reference)) return transfers.get(reference);
  return null;
}

/** Liste unique (dédupliquée) des transferts encore actionnables :
 * 'pending' (en cours normal) ET 'blocked' (argent collecté mais envoi au
 * destinataire en échec — coincé dans le wallet SebPay, action requise). */
function listPendingTransfers() {
  const seen = new Set();
  const pending = [];
  for (const transfer of transfers.values()) {
    if (seen.has(transfer.reference)) continue;
    seen.add(transfer.reference);
    if (transfer.status === 'pending' || transfer.status === 'blocked') pending.push(transfer);
  }
  return pending.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Déclenche le payout vers le destinataire une fois la collecte confirmée.
 * `referenceSuffix` permet de forcer une référence externe unique lors d'une
 * nouvelle tentative (SebPay refuserait une external_reference déjà utilisée). */
async function triggerPayout(transfer, referenceSuffix = '-OUT') {
  const payoutReference = `${transfer.reference}${referenceSuffix}`;
  // Le destinataire reçoit transfer.payoutAmount (montant collecté MOINS la
  // commission plateforme), calculé et figé à la création du transfert —
  // voir computeFeeSplit(). transfer.amount reste le montant plein
  // collecté chez l'expéditeur (utilisé tel quel pour un remboursement).
  // Repli sur transfer.amount pour les transferts créés avant l'ajout de la
  // commission (déjà persistés sur disque sans champ payoutAmount).
  const amountToSend = transfer.payoutAmount != null ? transfer.payoutAmount : transfer.amount;
  const payout = await sebpay.initiatePayout({
    recipientName: 'Bénéficiaire',
    phone: transfer.receiverPhone,
    operator: transfer.receiverOperator,
    country: transfer.receiverCountry || 'BJ',
    amount: amountToSend,
    externalReference: payoutReference,
  });

  transfer.stage = 'payout';
  transfer.status = 'pending';
  transfer.payoutTransactionId = payout.transaction_id || null;
  transfer.lastPayoutReference = payoutReference;
  transfer.message = 'Fonds reçus, envoi au destinataire en cours.';
  transfer.updatedAt = nowIso();
  transfers.set(payoutReference, transfer); // permet de retrouver le transfert via la réf. du payout
  saveTransfers();
  return payoutReference;
}

/** Traite le résultat (webhook OU vérification manuelle) d'une collecte. */
async function processCollectionResult(transfer, status, transactionId) {
  transfer.collectionTransactionId = transactionId || transfer.collectionTransactionId;

  if (status === 'approved') {
    try {
      await triggerPayout(transfer);
    } catch (error) {
      console.error('Erreur payout SebPay :', error.message, error.raw || '');
      // 'blocked' (et non 'failed') : l'argent a bien été prélevé chez
      // l'expéditeur, il est coincé dans le wallet SebPay. Ce n'est PAS un
      // échec définitif du transfert : il reste actionnable (Annuler ou
      // Réessayer) depuis le panneau ADMIN, contrairement à un vrai 'failed'.
      transfer.status = 'blocked';
      transfer.message = `La collecte a réussi mais l'envoi au destinataire a échoué : ${error.message}`;
      transfer.updatedAt = nowIso();
    }
  } else if (status === 'rejected') {
    transfer.status = 'failed';
    transfer.message = 'La collecte a été refusée ou a expiré.';
    transfer.updatedAt = nowIso();
  }
  // status === 'pending' : rien à faire, on attend toujours.
}

/** Traite le résultat (webhook OU vérification manuelle) d'un payout. */
function processPayoutResult(transfer, status, transactionId) {
  transfer.payoutTransactionId = transactionId || transfer.payoutTransactionId;

  if (status === 'approved') {
    transfer.status = 'completed';
    transfer.message = 'Transfert terminé avec succès.';
    transfer.updatedAt = nowIso();
  } else if (status === 'rejected') {
    transfer.status = 'failed';
    transfer.message = 'Le décaissement vers le destinataire a échoué.';
    transfer.updatedAt = nowIso();
  }
  // status === 'pending' : rien à faire, on attend toujours.
}

/** Interroge SebPay pour connaître l'état RÉEL d'un transfert et met à jour
 * notre état local en conséquence (rattrape un webhook manqué). Renvoie
 * true si l'état local a changé. */
async function reconcileTransfer(transfer) {
  const statusBefore = transfer.status;
  const stageBefore = transfer.stage;

  if (transfer.stage === 'collection') {
    const idOrRef = transfer.collectionTransactionId || transfer.reference;
    const collection = await sebpay.getCollection(idOrRef);
    await processCollectionResult(transfer, collection.status, collection.transaction_id);
  } else if (transfer.stage === 'payout' || transfer.stage === 'refund') {
    const idOrRef = transfer.payoutTransactionId || transfer.lastPayoutReference || `${transfer.reference}-OUT`;
    const payout = await sebpay.getPayout(idOrRef);
    if (transfer.stage === 'refund') {
      if (payout.status === 'approved') {
        transfer.status = 'refunded';
        transfer.message = "Argent renvoyé avec succès au numéro émetteur.";
        transfer.updatedAt = nowIso();
      } else if (payout.status === 'rejected') {
        transfer.status = 'failed';
        transfer.message = "Le renvoi de l'argent au numéro émetteur a échoué.";
        transfer.updatedAt = nowIso();
      }
    } else {
      processPayoutResult(transfer, payout.status, payout.transaction_id);
    }
  }

  const changed = transfer.status !== statusBefore || transfer.stage !== stageBefore;
  if (changed) saveTransfers();
  return changed;
}

// ---------------------------------------------------------------------------
// Routes publiques
// ---------------------------------------------------------------------------

// Liste des pays et réseaux Mobile Money disponibles (alimente le front-end)
app.get('/api/countries', (req, res) => {
  res.json({ success: true, countries: countries.publicCountries() });
});

/** Résout et valide un contact (pays + numéro + opérateur), pour l'expéditeur
 * COMME pour le destinataire — les deux suivent désormais exactement la même
 * logique, aucun n'est plus figé sur le Bénin.
 * Pour le Bénin spécifiquement : normalisation tolérante à l'ancien format
 * 8 chiffres (voir normalizeBeninPhone) et détection auto du réseau par
 * préfixe si l'opérateur n'est pas fourni. Pour les autres pays : l'appelant
 * doit fournir l'opérateur (pas de plan de numérotation par réseau connu).
 * Renvoie { country, phone, operator } ou { error }. */
function resolveContact(countryCode, rawPhone, operatorSlug) {
  const country = countries.getCountry(countryCode);
  if (!country) return { error: 'Pays invalide.' };

  const normalizedPhone =
    country.code === 'BJ'
      ? sebpay.normalizeBeninPhone(rawPhone)
      : sebpay.normalizeInternationalPhone(rawPhone, country.dialCode, country.phoneDigits);

  if (!normalizedPhone) {
    return {
      error:
        country.code === 'BJ'
          ? 'Numéro béninois invalide.'
          : `Numéro invalide (le format ${country.name} attend ${country.phoneDigits} chiffres après l'indicatif +${country.dialCode}).`,
    };
  }

  let resolvedOperatorSlug = operatorSlug;
  if (!resolvedOperatorSlug && country.code === 'BJ') {
    resolvedOperatorSlug = sebpay.detectOperator(normalizedPhone.slice(3));
  }
  const operator = countries.getOperator(country.code, resolvedOperatorSlug);
  if (!operator) {
    return { error: `Réseau Mobile Money non reconnu pour ${country.name}.` };
  }

  return { country, phone: normalizedPhone, operator };
}

// Route principale : déclenche la collecte chez l'expéditeur, dans SON pays,
// puis prépare le payout vers le destinataire, dans LE SIEN.
//
// Corps attendu :
//   - senderCountry, senderPhone, senderOperator : pays + numéro + réseau de l'expéditeur
//   - senderOtpCode                              : requis si le réseau expéditeur l'exige (voir otpRequired)
//   - amount                                      : montant en XOF (obligatoire)
//   - transferType                                : 'national' (même pays) | 'international' (pays différents)
//   - destinationCountry, receiverPhone, receiverOperator : pays + numéro + réseau du destinataire
app.post('/api/transfer', async (req, res) => {
  const {
    senderCountry,
    senderPhone,
    senderOperator,
    senderOtpCode,
    receiverPhone,
    receiverOperator,
    amount,
    transferType = 'national',
    destinationCountry,
  } = req.body;

  if (!senderCountry || !senderPhone || !destinationCountry || !receiverPhone || !amount) {
    return res.status(400).json({
      success: false,
      message: 'senderCountry, senderPhone, destinationCountry, receiverPhone et amount sont requis.',
    });
  }

  if (transferType === 'national' && senderCountry !== destinationCountry) {
    return res.status(400).json({
      success: false,
      message: 'Un transfert national doit avoir le même pays des deux côtés (choisissez "International" sinon).',
    });
  }
  if (transferType === 'international' && senderCountry === destinationCountry) {
    return res.status(400).json({
      success: false,
      message: 'Un transfert international doit viser un pays différent de celui de l\'expéditeur (choisissez "National" sinon).',
    });
  }

  // SebPay refuse tout PAYOUT sous 300 XOF ("amount_below_min"). Comme le
  // destinataire ET un éventuel remboursement de l'expéditeur passent tous
  // les deux par un payout, un montant sous ce seuil peut être collecté chez
  // l'expéditeur mais ne pourra JAMAIS être renvoyé nulle part par l'API
  // (ni au destinataire, ni en remboursement) : l'argent resterait coincé
  // sans solution automatisée. On bloque donc ici, avant la collecte.
  if (!amount || Number(amount) < MIN_TRANSFER_AMOUNT_XOF) {
    return res.status(400).json({
      success: false,
      message: `Montant invalide : le minimum autorisé est de ${MIN_TRANSFER_AMOUNT_XOF} XOF (SebPay refuse tout décaissement sous ${MIN_PAYOUT_AMOUNT_XOF} XOF, et ${PLATFORM_FEE_PERCENT}% de commission plateforme sont déduits avant l'envoi au destinataire).`,
    });
  }

  const sender = resolveContact(senderCountry, senderPhone, senderOperator);
  if (sender.error) {
    return res.status(400).json({ success: false, message: `Expéditeur : ${sender.error}` });
  }
  if (sender.operator.otpRequired && !senderOtpCode) {
    return res.status(400).json({
      success: false,
      message: `Le réseau ${sender.operator.name} exige un code de confirmation : composez ${sender.operator.ussdCode} sur le téléphone de l'expéditeur puis saisissez le code reçu.`,
      code: 'OTP_REQUIRED',
    });
  }

  const receiver = resolveContact(destinationCountry, receiverPhone, receiverOperator);
  if (receiver.error) {
    return res.status(400).json({ success: false, message: `Destinataire : ${receiver.error}` });
  }

  const reference = `TRF-${Date.now()}`;
  const { feeAmount, payoutAmount } = computeFeeSplit(amount);

  try {
    const collection = await sebpay.initiateCollection({
      phone: sender.phone,
      operator: sender.operator.slug,
      country: sender.country.code,
      amount,
      externalReference: reference,
      otpCode: senderOtpCode,
    });

    transfers.set(reference, {
      reference,
      stage: 'collection',
      status: 'pending',
      senderCountry: sender.country.code,
      senderOperator: sender.operator.slug,
      senderPhone: sender.phone,
      receiverOperator: receiver.operator.slug,
      receiverPhone: receiver.phone,
      receiverCountry: receiver.country.code,
      amount: Number(amount), // montant plein collecté chez l'expéditeur
      feePercent: PLATFORM_FEE_PERCENT,
      feeAmount, // commission plateforme, conservée dans le wallet SebPay
      payoutAmount, // montant net effectivement envoyé au destinataire
      collectionTransactionId: collection.transaction_id || null,
      payoutTransactionId: null,
      lastPayoutReference: null,
      message: 'Collecte initiée. En attente de validation par l\'expéditeur sur son téléphone.',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveTransfers();

    return res.json({
      success: true,
      status: 'pending',
      reference,
      message: collection.message || 'Collecte initiée. Validez la transaction sur votre téléphone.',
    });
  } catch (error) {
    console.error('Erreur de collecte SebPay :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
    });
  }
});

// Permet au front-end de suivre l'état d'un transfert (polling)
app.get('/api/transfer/:reference', (req, res) => {
  const transfer = transfers.get(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Transfert introuvable.' });
  }
  return res.json({ success: true, transfer });
});

// Webhook : SebPay appelle cette URL pour notifier le statut final d'une transaction
function isValidSignature(req) {
  const signature = req.get('X-SebPay-Signature');
  if (!signature || !req.rawBody || !config.sebpay.secretKey) return false;

  const expected = crypto
    .createHmac('sha256', config.sebpay.secretKey)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.post('/api/webhook', async (req, res) => {
  if (!isValidSignature(req)) {
    console.warn('Webhook SebPay : signature invalide, requête ignorée.');
    return res.sendStatus(401);
  }

  const { external_reference: reference, status, transaction_id: transactionId } = req.body;
  console.log('Webhook SebPay reçu :', req.body);

  // Répondre 200 immédiatement pour respecter les bonnes pratiques SebPay ;
  // le reste du traitement continue en arrière-plan.
  res.sendStatus(200);

  const transfer = transfers.get(reference);
  if (!transfer) return; // référence inconnue

  if (transfer.stage === 'collection') {
    await processCollectionResult(transfer, status, transactionId);
  } else if (transfer.stage === 'payout') {
    processPayoutResult(transfer, status, transactionId);
  } else if (transfer.stage === 'refund') {
    if (status === 'approved') {
      transfer.status = 'refunded';
      transfer.message = 'Argent renvoyé avec succès au numéro émetteur.';
      transfer.updatedAt = nowIso();
    } else if (status === 'rejected') {
      transfer.status = 'failed';
      transfer.message = "Le renvoi de l'argent au numéro émetteur a échoué.";
      transfer.updatedAt = nowIso();
    }
  }
  saveTransfers();
});

// ---------------------------------------------------------------------------
// Routes ADMIN (protégées par jeton)
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || req.query.token;
  if (!token || token !== config.admin.token) {
    return res.status(401).json({ success: false, message: 'Accès réservé aux administrateurs.' });
  }
  next();
}

// Liste tous les paiements en attente (pour le tableau de bord ADMIN)
app.get('/api/admin/pending', requireAdmin, (req, res) => {
  return res.json({ success: true, transfers: listPendingTransfers() });
});

// Corrige EN MASSE tous les paiements en attente : interroge SebPay pour
// chacun d'eux et rattrape tout webhook manqué (déclenche le payout si la
// collecte était approuvée, marque "completed" si le payout était approuvé...).
app.post('/api/admin/fix-pending', requireAdmin, async (req, res) => {
  const pendingBefore = listPendingTransfers();
  const results = [];

  for (const transfer of pendingBefore) {
    try {
      const changed = await reconcileTransfer(transfer);
      results.push({
        reference: transfer.reference,
        changed,
        status: transfer.status,
        stage: transfer.stage,
        message: transfer.message,
      });
    } catch (error) {
      console.error(`Erreur de réconciliation pour ${transfer.reference} :`, error.message, error.raw || '');
      results.push({
        reference: transfer.reference,
        changed: false,
        status: transfer.status,
        stage: transfer.stage,
        message: `Impossible de vérifier ce transfert auprès de SebPay pour le moment : ${error.message}`,
        error: true,
      });
    }
  }

  const stillPending = results.filter((r) => r.status === 'pending');
  return res.json({
    success: true,
    checked: results.length,
    resolved: results.length - stillPending.length,
    stillPending: stillPending.length,
    results,
  });
});

// Vérifie UN transfert par référence : interroge SebPay, met à jour l'état
// local, et renvoie l'état à jour (utilisé par la recherche par référence).
app.post('/api/admin/transfer/:reference/check', requireAdmin, async (req, res) => {
  const transfer = findTransfer(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Référence introuvable.' });
  }

  try {
    await reconcileTransfer(transfer);
    return res.json({ success: true, transfer });
  } catch (error) {
    console.error('Erreur de vérification SebPay :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: `Impossible de vérifier ce transfert auprès de SebPay : ${error.message}`,
      transfer,
    });
  }
});

// Annule un transfert bloqué en attente et RENVOIE l'argent au numéro émetteur.
app.post('/api/admin/transfer/:reference/cancel', requireAdmin, async (req, res) => {
  const transfer = findTransfer(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Référence introuvable.' });
  }
  if (transfer.status !== 'pending' && transfer.status !== 'blocked') {
    return res.status(400).json({
      success: false,
      message: `Ce transfert n'est ni en attente ni bloqué (statut actuel : ${transfer.status}), impossible de l'annuler.`,
      transfer,
    });
  }
  // Uniquement si la collecte elle-même n'est pas encore confirmée (statut
  // 'pending'). Si le statut est 'blocked', la collecte a déjà réussi et
  // l'argent est bel et bien dans le wallet SebPay : le remboursement est
  // possible même si l'étape ('stage') est encore 'collection'.
  if (transfer.status === 'pending' && transfer.stage === 'collection') {
    return res.status(400).json({
      success: false,
      message:
        "L'argent n'a pas encore été collecté chez l'expéditeur : rien à rembourser pour l'instant. Vérifiez à nouveau dans un instant.",
      transfer,
    });
  }
  if (transfer.stage === 'refund') {
    return res.status(400).json({
      success: false,
      message: 'Un remboursement vers l\'émetteur est déjà en cours pour ce transfert. Utilisez "Vérifier" pour suivre son état plutôt que d\'en relancer un second.',
      transfer,
    });
  }
  if (transfer.amount < MIN_PAYOUT_AMOUNT_XOF) {
    return res.status(400).json({
      success: false,
      message: `Impossible : ${transfer.amount} XOF est sous le minimum SebPay (${MIN_PAYOUT_AMOUNT_XOF} XOF) pour tout décaissement, y compris un remboursement. Contactez le support SebPay directement avec la référence ${transfer.reference} pour un remboursement manuel.`,
      transfer,
    });
  }

  try {
    const refundReference = `${transfer.reference}-REFUND-${Date.now()}`;
    const refund = await sebpay.initiatePayout({
      recipientName: 'Remboursement expéditeur',
      phone: transfer.senderPhone,
      operator: transfer.senderOperator,
      country: transfer.senderCountry || 'BJ', // repli BJ pour les transferts créés avant ce champ
      amount: transfer.amount,
      externalReference: refundReference,
    });

    transfer.stage = 'refund';
    transfer.status = 'pending';
    transfer.payoutTransactionId = refund.transaction_id || null;
    transfer.lastPayoutReference = refundReference;
    transfer.message = "Annulation demandée : l'argent est en cours de renvoi au numéro émetteur.";
    transfer.updatedAt = nowIso();
    transfers.set(refundReference, transfer);
    saveTransfers();

    return res.json({ success: true, transfer });
  } catch (error) {
    console.error('Erreur de remboursement SebPay :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: `Le remboursement vers l'émetteur a échoué : ${error.message}`,
      transfer,
    });
  }
});

// Relance l'envoi vers le destinataire directement, sans redemander le
// montant (déjà connu depuis la tentative d'origine).
// ⚠️ Si SebPay confirme que le décaissement précédent est encore "pending"
// (donc réellement en cours de traitement chez SebPay, pas juste une donnée
// locale non synchronisée), relancer un nouveau décaissement crée un risque
// de double paiement si les deux finissent par être approuvés. Ne relancez
// que si vous avez confirmé auprès de SebPay/du support que la tentative
// précédente est définitivement bloquée ou perdue.
app.post('/api/admin/transfer/:reference/retry', requireAdmin, async (req, res) => {
  const transfer = findTransfer(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Référence introuvable.' });
  }
  if (transfer.status !== 'pending' && transfer.status !== 'blocked') {
    return res.status(400).json({
      success: false,
      message: `Ce transfert n'est ni en attente ni bloqué (statut actuel : ${transfer.status}), impossible de le relancer.`,
      transfer,
    });
  }
  // Idem : ne bloque que si la collecte elle-même n'est pas encore confirmée.
  if (transfer.status === 'pending' && transfer.stage === 'collection') {
    return res.status(400).json({
      success: false,
      message:
        "L'argent n'a pas encore été collecté chez l'expéditeur : impossible de relancer l'envoi au destinataire tant que la collecte n'est pas confirmée.",
      transfer,
    });
  }
  // Le retry relance un payout de transfer.payoutAmount (montant net, après
  // commission), c'est donc lui qu'il faut comparer au minimum SebPay.
  const retryPayoutAmount = transfer.payoutAmount != null ? transfer.payoutAmount : transfer.amount;
  if (retryPayoutAmount < MIN_PAYOUT_AMOUNT_XOF) {
    return res.status(400).json({
      success: false,
      message: `Impossible : ${retryPayoutAmount} XOF (montant net après commission) est sous le minimum SebPay (${MIN_PAYOUT_AMOUNT_XOF} XOF) pour tout décaissement — relancer échouera pour la même raison que la première fois. Contactez le support SebPay avec la référence ${transfer.reference} pour un remboursement manuel.`,
      transfer,
    });
  }

  try {
    await triggerPayout(transfer, `-RETRY-${Date.now()}`);
    return res.json({ success: true, transfer });
  } catch (error) {
    console.error('Erreur de relance payout SebPay :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: `La nouvelle tentative d'envoi au destinataire a échoué : ${error.message}`,
      transfer,
    });
  }
});

// ---------------------------------------------------------------------------
// Réconciliation automatique périodique
// ---------------------------------------------------------------------------
// Rattrape les webhooks manqués tout seul, sans clic manuel dans l'admin.
// Tourne une première fois juste après le démarrage (une fois les transferts
// rechargés depuis le disque), puis toutes les RECONCILE_INTERVAL_MS.
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

async function autoReconcilePending() {
  const pending = listPendingTransfers();
  if (pending.length === 0) return;
  console.log(`Réconciliation auto : ${pending.length} transfert(s) en attente à vérifier...`);
  for (const transfer of pending) {
    try {
      await reconcileTransfer(transfer);
    } catch (error) {
      console.error(`Réconciliation auto échouée pour ${transfer.reference} :`, error.message);
    }
  }
}

app.listen(config.port, () => {
  console.log(`Serveur lancé sur le port ${config.port}`);
  // Petit délai pour laisser le serveur finir de démarrer avant le premier appel SebPay.
  setTimeout(autoReconcilePending, 5000);
  setInterval(autoReconcilePending, RECONCILE_INTERVAL_MS);
});
