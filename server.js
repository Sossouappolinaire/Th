// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API
// de paiement qui appelle SebPay côté serveur (les clés API ne sont jamais
// exposées au navigateur).
//
// Depuis le 01/09/2026 (refonte) : l'application n'encaisse QUE — il n'y a
// plus de décaissement (payout) automatique vers un destinataire. L'argent
// payé par l'utilisateur reste dans le wallet SebPay du propriétaire de la
// plateforme. Seul un remboursement MANUEL depuis le panneau admin peut
// renvoyer l'argent à l'expéditeur (cas d'un client à rembourser).
//
// Logique :
//   1) POST /api/transfer      -> initie une COLLECTE chez le payeur, dans
//        SON pays (n'importe lequel des pays de countries.js).
//   2) POST /api/webhook       -> SebPay notifie le statut final.
//        - collecte "approved" -> le paiement est marqué "completed"
//          directement (aucun décaissement n'est déclenché).
//        - "rejected"          -> le paiement est marqué "failed".
//   3) GET /api/transfer/:ref  -> le front-end interroge l'état du paiement.
//   4) GET /api/countries      -> liste des pays/réseaux Mobile Money proposés.
//
// Panneau ADMIN (protégé par un jeton, voir config.admin.token) :
//   5) GET  /api/admin/pending              -> liste tous les paiements/remboursements en attente.
//   6) POST /api/admin/fix-pending          -> réconcilie TOUS les paiements en
//        attente avec l'état réel chez SebPay (rattrape les webhooks manqués).
//   7) POST /api/admin/transfer/:ref/check  -> réconcilie UN paiement et renvoie son état réel.
//   8) POST /api/admin/transfer/:ref/refund -> rembourse un paiement déjà encaissé
//        (renvoie l'argent au numéro payeur).
//   9) GET  /api/admin/all                  -> liste TOUS les paiements (tout statut confondu,
//        historique complet : référence, date/heure, pays, numéro, nom, montant, statut)
//        + la somme totale actuellement encaissée dans le compte SebPay de l'administrateur.

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const path = require('path');
const config = require('./config');
const sebpay = require('./sebpayService');
const countries = require('./countries');

const app = express();

// ⚠️ SebPay refuse tout PAYOUT sous un certain seuil ("amount_below_min").
// Un remboursement passe par un payout : un montant collecté sous ce seuil
// pourrait donc être encaissé mais ne pourrait JAMAIS être remboursé
// automatiquement par l'API. On bloque donc ici, avant la collecte.
// ⚠️ 100 XOF n'est PAS confirmé par la documentation officielle SebPay (elle
// ne précise aucun montant minimum) : c'est une valeur choisie sans test
// réel d'un payout à ce montant. Si un remboursement à 100 XOF échoue en
// pratique côté SebPay, remonter ce seuil (300 XOF avait été confirmé par
// un test réel, voir historique de ce fichier).
const MIN_PAYOUT_AMOUNT_XOF = 100;
const MIN_TRANSFER_AMOUNT_XOF = MIN_PAYOUT_AMOUNT_XOF;

// ---------------------------------------------------------------------------
// Persistance des paiements (fichier JSON local)
// ---------------------------------------------------------------------------
// ⚠️ L'API SebPay n'expose AUCUNE route pour "lister tout ce qui est en
// attente" : GET /collections/{id} et GET /payouts/{id} exigent de déjà
// connaître la référence. Il est donc impossible d'interroger SebPay au
// démarrage pour retrouver les paiements oubliés — l'appli DOIT garder
// elle-même la liste des références à vérifier. D'où cette persistance sur
// disque : elle survit à un crash/redémarrage du process (contrairement à un
// Map en mémoire), mais PAS à un redéploiement Render qui recrée le disque.
// Pour une garantie totale même après redéploiement, remplacez ce fichier
// JSON par une vraie base de données (Postgres, SQLite sur un Render Disk...).
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'transfers.json');

// Stockage en mémoire des paiements, rechargé depuis DATA_FILE au démarrage
// puis réécrit sur disque après chaque changement.
//
// Un même paiement peut être indexé sous plusieurs clés (sa référence
// d'origine "TRF-...", puis "TRF-...-REFUND-..." lors d'un remboursement)
// mais `transfer.reference` pointe toujours vers la référence CANONIQUE
// (celle d'origine) : c'est elle qu'il faut utiliser pour dédupliquer.
const transfers = new Map();

/** Recharge les paiements depuis le fichier JSON au démarrage. */
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
    console.log(`Paiements rechargés depuis le disque : ${canonicalByReference.size} transaction(s).`);
  } catch (error) {
    console.error('Impossible de recharger data/transfers.json :', error.message);
  }
}

/** Sauvegarde l'état courant de tous les paiements sur disque. */
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

/** Retrouve un paiement à partir de n'importe quelle référence connue
 * (référence d'origine, référence "-REFUND-..."...). */
function findTransfer(rawReference) {
  const reference = String(rawReference || '').trim();
  if (!reference) return null;
  if (transfers.has(reference)) return transfers.get(reference);
  return null;
}

/** Liste unique (dédupliquée) des paiements encore actionnables :
 * 'pending' (collecte ou remboursement en cours). */
function listPendingTransfers() {
  const seen = new Set();
  const pending = [];
  for (const transfer of transfers.values()) {
    if (seen.has(transfer.reference)) continue;
    seen.add(transfer.reference);
    if (transfer.status === 'pending') pending.push(transfer);
  }
  return pending.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Liste unique (dédupliquée) de TOUS les paiements, quel que soit leur
 * statut (pending, completed, failed, refunded) — sert au panneau admin
 * "historique complet" avec référence, date/heure, pays, numéro, nom. */
function listAllTransfers() {
  const seen = new Set();
  const all = [];
  for (const transfer of transfers.values()) {
    if (seen.has(transfer.reference)) continue;
    seen.add(transfer.reference);
    all.push(transfer);
  }
  return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Somme totale actuellement retenue dans le wallet SebPay de
 * l'administrateur : les paiements "completed" (encaissés et jamais
 * remboursés). Un paiement "refunded" ne compte plus (l'argent est reparti
 * vers le payeur). */
function totalAdminAccountAmount() {
  let total = 0;
  for (const transfer of listAllTransfers()) {
    if (transfer.status === 'completed') total += Number(transfer.amount) || 0;
  }
  return total;
}

/** Traite le résultat (webhook OU vérification manuelle) d'une collecte.
 * Aucun décaissement automatique n'est déclenché : un paiement approuvé est
 * directement marqué "completed", l'argent restant dans le wallet SebPay. */
function processCollectionResult(transfer, status, transactionId) {
  transfer.collectionTransactionId = transactionId || transfer.collectionTransactionId;

  if (status === 'approved') {
    transfer.status = 'completed';
    transfer.message = 'Paiement reçu avec succès.';
    transfer.updatedAt = nowIso();
  } else if (status === 'rejected') {
    transfer.status = 'failed';
    transfer.message = 'Le paiement a été refusé ou a expiré.';
    transfer.updatedAt = nowIso();
  }
  // status === 'pending' : rien à faire, on attend toujours.
}

/** Interroge SebPay pour connaître l'état RÉEL d'un paiement et met à jour
 * notre état local en conséquence (rattrape un webhook manqué). Renvoie
 * true si l'état local a changé. */
async function reconcileTransfer(transfer) {
  const statusBefore = transfer.status;
  const stageBefore = transfer.stage;

  if (transfer.stage === 'collection') {
    const idOrRef = transfer.collectionTransactionId || transfer.reference;
    const collection = await sebpay.getCollection(idOrRef);
    processCollectionResult(transfer, collection.status, collection.transaction_id);
  } else if (transfer.stage === 'refund') {
    const idOrRef = transfer.refundTransactionId || transfer.lastRefundReference || `${transfer.reference}-REFUND`;
    const payout = await sebpay.getPayout(idOrRef);
    if (payout.status === 'approved') {
      transfer.status = 'refunded';
      transfer.message = 'Argent remboursé avec succès au numéro payeur.';
      transfer.updatedAt = nowIso();
    } else if (payout.status === 'rejected') {
      transfer.status = 'completed'; // le remboursement a échoué, l'argent reste encaissé
      transfer.message = 'Le remboursement au numéro payeur a échoué.';
      transfer.updatedAt = nowIso();
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

/** Résout et valide un contact (pays + numéro + opérateur) pour le payeur.
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

// Route principale : déclenche la collecte chez le payeur, dans SON pays.
// Aucun destinataire, aucun décaissement : l'argent reste sur la plateforme.
//
// Corps attendu :
//   - senderCountry, senderPhone, senderOperator : pays + numéro + réseau du payeur
//   - senderOtpCode                                : requis si le réseau du payeur l'exige (voir otpRequired)
//   - amount                                       : montant en XOF (obligatoire)
app.post('/api/transfer', async (req, res) => {
  const { senderCountry, senderPhone, senderOperator, senderOtpCode, senderName, amount } = req.body;

  if (!senderCountry || !senderPhone || !amount) {
    return res.status(400).json({
      success: false,
      message: 'senderCountry, senderPhone et amount sont requis.',
    });
  }

  const trimmedSenderName = String(senderName || '').trim();
  if (!trimmedSenderName) {
    return res.status(400).json({
      success: false,
      message: 'Le nom du payeur est requis.',
    });
  }

  // SebPay refuse tout PAYOUT sous 300 XOF ("amount_below_min"). Comme un
  // éventuel remboursement passe par un payout, un montant sous ce seuil
  // pourrait être encaissé mais ne pourrait JAMAIS être remboursé
  // automatiquement par l'API. On bloque donc ici, avant la collecte.
  if (!amount || Number(amount) < MIN_TRANSFER_AMOUNT_XOF) {
    return res.status(400).json({
      success: false,
      message: `Montant invalide : le minimum autorisé est de ${MIN_TRANSFER_AMOUNT_XOF} XOF (SebPay pourrait refuser tout remboursement sous ce seuil).`,
    });
  }

  const sender = resolveContact(senderCountry, senderPhone, senderOperator);
  if (sender.error) {
    return res.status(400).json({ success: false, message: sender.error });
  }
  if (sender.operator.otpRequired && !senderOtpCode) {
    return res.status(400).json({
      success: false,
      message: `Le réseau ${sender.operator.name} exige un code de confirmation : composez ${sender.operator.ussdCode} sur votre téléphone puis saisissez le code reçu.`,
      code: 'OTP_REQUIRED',
    });
  }

  const reference = `TRF-${Date.now()}`;

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
      senderName: trimmedSenderName,
      amount: Number(amount),
      collectionTransactionId: collection.transaction_id || null,
      refundTransactionId: null,
      lastRefundReference: null,
      message: 'Paiement initié. En attente de validation sur votre téléphone.',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    saveTransfers();

    return res.json({
      success: true,
      status: 'pending',
      reference,
      message: collection.message || 'Paiement initié. Validez la transaction sur votre téléphone.',
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

// Permet au front-end de suivre l'état d'un paiement (polling)
app.get('/api/transfer/:reference', (req, res) => {
  const transfer = transfers.get(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
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
    processCollectionResult(transfer, status, transactionId);
  } else if (transfer.stage === 'refund') {
    if (status === 'approved') {
      transfer.status = 'refunded';
      transfer.message = 'Argent remboursé avec succès au numéro payeur.';
      transfer.updatedAt = nowIso();
    } else if (status === 'rejected') {
      transfer.status = 'completed';
      transfer.message = 'Le remboursement au numéro payeur a échoué.';
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

// Liste TOUT l'historique des paiements (tout statut confondu) + la somme
// totale actuellement encaissée dans le compte SebPay de l'administrateur.
// Alimente le tableau "Référence / Date-heure / Pays / Numéro / Nom / Montant"
// du panneau admin.
app.get('/api/admin/all', requireAdmin, (req, res) => {
  return res.json({
    success: true,
    transfers: listAllTransfers(),
    totalAmount: totalAdminAccountAmount(),
  });
});

// Corrige EN MASSE tous les paiements en attente : interroge SebPay pour
// chacun d'eux et rattrape tout webhook manqué.
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
        message: `Impossible de vérifier ce paiement auprès de SebPay pour le moment : ${error.message}`,
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

// Vérifie UN paiement par référence : interroge SebPay, met à jour l'état
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
      message: `Impossible de vérifier ce paiement auprès de SebPay : ${error.message}`,
      transfer,
    });
  }
});

// Rembourse un paiement déjà encaissé (renvoie l'argent au numéro payeur).
app.post('/api/admin/transfer/:reference/refund', requireAdmin, async (req, res) => {
  const transfer = findTransfer(req.params.reference);
  if (!transfer) {
    return res.status(404).json({ success: false, message: 'Référence introuvable.' });
  }
  if (transfer.status !== 'completed') {
    return res.status(400).json({
      success: false,
      message: `Ce paiement n'est pas au statut "encaissé" (statut actuel : ${transfer.status}), impossible de le rembourser.`,
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
      recipientName: 'Remboursement client',
      phone: transfer.senderPhone,
      operator: transfer.senderOperator,
      country: transfer.senderCountry || 'BJ',
      amount: transfer.amount,
      externalReference: refundReference,
    });

    transfer.stage = 'refund';
    transfer.status = 'pending';
    transfer.refundTransactionId = refund.transaction_id || null;
    transfer.lastRefundReference = refundReference;
    transfer.message = 'Remboursement demandé : l\'argent est en cours de renvoi au numéro payeur.';
    transfer.updatedAt = nowIso();
    transfers.set(refundReference, transfer);
    saveTransfers();

    return res.json({ success: true, transfer });
  } catch (error) {
    console.error('Erreur de remboursement SebPay :', error.message, error.raw || '');
    return res.status(400).json({
      success: false,
      message: `Le remboursement au numéro payeur a échoué : ${error.message}`,
      transfer,
    });
  }
});

// ---------------------------------------------------------------------------
// Réconciliation automatique périodique
// ---------------------------------------------------------------------------
// Rattrape les webhooks manqués tout seul, sans clic manuel dans l'admin.
// Tourne une première fois juste après le démarrage (une fois les paiements
// rechargés depuis le disque), puis toutes les RECONCILE_INTERVAL_MS.
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

async function autoReconcilePending() {
  const pending = listPendingTransfers();
  if (pending.length === 0) return;
  console.log(`Réconciliation auto : ${pending.length} paiement(s) en attente à vérifier...`);
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
