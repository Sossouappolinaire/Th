// server.js
// Point d'entrée du serveur. Sert le front-end statique et expose l'API
// de transfert d'argent qui appelle SebPay côté serveur (les clés API ne
// sont jamais exposées au navigateur).
//
// Logique du transfert MTN <-> Moov :
//   1) POST /api/transfer      -> initie une COLLECTE chez l'expéditeur.
//   2) POST /api/webhook       -> SebPay notifie le statut final.
//        - collecte "approved" -> on déclenche un PAYOUT vers le destinataire.
//        - payout "approved"   -> le transfert est marqué "completed".
//        - "rejected"          -> le transfert est marqué "failed".
//   3) GET /api/transfer/:ref  -> le front-end interroge l'état du transfert.

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const config = require('./config');
const sebpay = require('./sebpayService');

const app = express();

// Stockage en mémoire des transferts en cours (suffisant pour une démo ;
// utilisez une vraie base de données en production, l'état est perdu à
// chaque redémarrage/redeploy).
const transfers = new Map();

// Capture le corps brut (nécessaire pour vérifier la signature HMAC du webhook)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Route principale : déclenche la collecte chez l'expéditeur
app.post('/api/transfer', async (req, res) => {
  const { senderPhone, receiverPhone, amount } = req.body;

  if (!senderPhone || !receiverPhone || !amount) {
    return res.status(400).json({
      success: false,
      message: 'senderPhone, receiverPhone et amount sont requis.',
    });
  }

  const normalizedSender = sebpay.normalizeBeninPhone(senderPhone);
  const normalizedReceiver = sebpay.normalizeBeninPhone(receiverPhone);

  if (!normalizedSender || !normalizedReceiver) {
    return res.status(400).json({ success: false, message: 'Numéro de téléphone béninois invalide.' });
  }

  const senderOperator = sebpay.detectOperator(normalizedSender.slice(3));
  const receiverOperator = sebpay.detectOperator(normalizedReceiver.slice(3));

  if (!senderOperator || !receiverOperator) {
    return res
      .status(400)
      .json({ success: false, message: "Impossible de déterminer l'opérateur (MTN/Moov) à partir du numéro." });
  }

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Montant invalide.' });
  }

  const reference = `TRF-${Date.now()}`;

  try {
    const collection = await sebpay.initiateCollection({
      phone: normalizedSender,
      operator: senderOperator,
      amount,
      externalReference: reference,
    });

    transfers.set(reference, {
      reference,
      stage: 'collection',
      status: 'pending',
      senderPhone: normalizedSender,
      receiverPhone: normalizedReceiver,
      receiverOperator,
      amount: Number(amount),
      collectionTransactionId: collection.transaction_id || null,
      payoutTransactionId: null,
      message: 'Collecte initiée. En attente de validation par l\'expéditeur sur son téléphone.',
    });

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
  if (!transfer) return; // référence inconnue (peut-être un payout, traité ci-dessous)

  if (transfer.stage === 'collection') {
    transfer.collectionTransactionId = transactionId || transfer.collectionTransactionId;

    if (status === 'approved') {
      // La collecte a réussi : on déclenche le décaissement vers le destinataire.
      try {
        const payoutReference = `${reference}-OUT`;
        const payout = await sebpay.initiatePayout({
          recipientName: 'Bénéficiaire',
          phone: transfer.receiverPhone,
          operator: transfer.receiverOperator,
          amount: transfer.amount,
          externalReference: payoutReference,
        });

        transfer.stage = 'payout';
        transfer.status = 'pending';
        transfer.payoutTransactionId = payout.transaction_id || null;
        transfer.message = 'Fonds reçus, envoi au destinataire en cours.';
        transfers.set(payoutReference, transfer); // permet de retrouver le transfert via la réf. du payout
      } catch (error) {
        console.error('Erreur payout SebPay :', error.message, error.raw || '');
        transfer.status = 'failed';
        transfer.message = "La collecte a réussi mais l'envoi au destinataire a échoué.";
      }
    } else if (status === 'rejected') {
      transfer.status = 'failed';
      transfer.message = "La collecte a été refusée ou a expiré.";
    }
    return;
  }

  if (transfer.stage === 'payout') {
    transfer.payoutTransactionId = transactionId || transfer.payoutTransactionId;

    if (status === 'approved') {
      transfer.status = 'completed';
      transfer.message = 'Transfert terminé avec succès.';
    } else if (status === 'rejected') {
      transfer.status = 'failed';
      transfer.message = 'Le décaissement vers le destinataire a échoué.';
    }
  }
});

app.listen(config.port, () => {
  console.log(`Serveur lancé sur le port ${config.port}`);
});
