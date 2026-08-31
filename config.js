// config.js
// Centralise toutes les variables d'environnement liées à l'API SebPay.
// Toutes les valeurs sensibles doivent être définies dans les variables
// d'environnement de Render (jamais commitées dans git).

require('dotenv').config();

const config = {
  // Port sur lequel le serveur Express écoute.
  // Sur Render, la plateforme fournit automatiquement process.env.PORT ;
  // 10000 est utilisé en repli (et correspond au port par défaut attendu
  // pour ce déploiement).
  port: process.env.PORT || 10000,

  sebpay: {
    // URL de base de l'API SebPay (voir documentation officielle).
    baseUrl: process.env.SEBPAY_BASE_URL || 'https://newapi.sebpay.bj/api/v1',

    // Clé publique fournie par SebPay (pk_live_... ou pk_test_...)
    publicKey: process.env.SEBPAY_PUBLIC_KEY || '',

    // Clé secrète fournie par SebPay (sk_live_... ou sk_test_...)
    // Sert aussi à vérifier la signature HMAC des webhooks.
    secretKey: process.env.SEBPAY_SECRET_KEY || '',

    // URL publique de votre serveur, utilisée pour construire callback_url
    // (doit être l'URL Render, ex: https://votre-app.onrender.com)
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:10000',
  },
};

if (!config.sebpay.publicKey || !config.sebpay.secretKey) {
  console.warn('⚠️  SEBPAY_PUBLIC_KEY ou SEBPAY_SECRET_KEY manquante : vérifiez vos variables d\'environnement.');
}

module.exports = config;
