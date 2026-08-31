// config.js
// ⚠️ ATTENTION SÉCURITÉ ⚠️
// Les clés SebPay ci-dessous sont écrites EN DUR dans ce fichier (à la demande).
// Ne poussez JAMAIS ce fichier sur un dépôt public (GitHub, etc.) et ne le
// partagez à personne : quiconque l'obtient peut effectuer des transactions
// avec votre compte SebPay. Pensez à régénérer ces clés si ce fichier venait
// à fuiter.

const config = {
  // Port sur lequel le serveur Express écoute (Render fournit process.env.PORT).
  port: process.env.PORT || 10000,

  sebpay: {
    // URL de base de l'API SebPay
    baseUrl: 'https://newapi.sebpay.bj/api/v1',

    // Clé publique SebPay (pk_live_...)
    publicKey: 'pk_live_KZXk20YFXuETMvvo7B5TZEoybXLtsopBZWKjEPyN',

    // Clé secrète SebPay (sk_live_...) — sert aussi à vérifier la signature HMAC des webhooks
    secretKey: 'sk_live_w6OsteIR8i0Q4mQImeN67irPGUtCSjbYAk6VU6fbpX1lch4ULPrdr5dcD8zt',

    // URL publique de votre service Render, utilisée pour construire callback_url
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://ma-boutique-ngu0.onrender.com',
  },
};

module.exports = config;
