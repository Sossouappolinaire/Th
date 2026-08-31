// config.js
// ⚠️ ATTENTION SÉCURITÉ ⚠️
// Les clés SebPay ci-dessous sont écrites EN DUR dans ce fichier (à la demande).
// Ne poussez JAMAIS ce fichier sur un dépôt public (GitHub, etc.) et ne le
// partagez à personne : quiconque l'obtient peut effectuer des transactions
// avec votre compte SebPay. Pensez à régénérer ces clés si ce fichier venait
// à fuiter.

const config = {
  // Port sur lequel le serveur Express écoute.
  port: 10000,

  sebpay: {
    // URL de base de l'API SebPay
    baseUrl: 'https://newapi.sebpay.bj/api/v1',

    // Clé publique SebPay (pk_live_...)
    publicKey: 'pk_live_KZXk20YFXuETMvvo7B5TZEoybXLtsopBZWKjEPyN',

    // Clé secrète SebPay (sk_live_...) — sert aussi à vérifier la signature HMAC des webhooks
    secretKey: 'sk_live_w6OsteIR8i0Q4mQImeN67irPGUtCSjbYAk6VU6fbpX1lch4ULPrdr5dcD8zt',

    // URL publique de votre service Render, utilisée pour construire callback_url.
    publicBaseUrl: 'https://ma-boutique-ngu0.onrender.com',
  },

  admin: {
    // Mot de passe requis pour accéder au panneau ADMIN (liste + correction
    // des paiements en attente), écrit en dur à la demande.
    token: 'arrow2025',
  },

  fees: {
    // Commission de la plateforme, prélevée sur le montant envoyé au
    // destinataire (le montant COLLECTÉ chez l'expéditeur, lui, reste
    // inchangé). Ex : expéditeur envoie 5000 XOF, avec 5% -> le
    // destinataire reçoit 4750 XOF, les 250 XOF restants restent dans le
    // wallet SebPay au profit du propriétaire de la plateforme.
    // En cas de remboursement (annulation), c'est le montant COLLECTÉ en
    // entier qui est renvoyé à l'expéditeur, sans déduire cette commission.
    platformFeePercent: 5,
  },
};

module.exports = config;
