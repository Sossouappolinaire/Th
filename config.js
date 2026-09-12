// config.js
// Centralise la configuration liée à l'API FeexPay (Payin = collecte chez
// l'expéditeur, Payout = envoi vers le destinataire).
//
// ⚠️ FeexPay utilise UNE SEULE clé API (Authorization: Bearer fp_...), à
// la différence de l'ancien fournisseur (SebPay) qui utilisait une paire
// clé publique / clé secrète. Il faut aussi fournir l'identifiant de
// boutique (`shop`) sur CHAQUE requête Payin/Payout.
//
// ⚠️ À la demande explicite du propriétaire du projet, la clé API et
// l'identifiant de boutique sont codés EN DUR ci-dessous plutôt que lus
// uniquement depuis des variables d'environnement. Conséquences à connaître :
//   - Quiconque a accès à ce fichier (dépôt Git, zip partagé, capture
//     d'écran...) a accès à votre clé API FeexPay, donc à votre wallet.
//   - Si ce dossier est poussé sur un dépôt Git PUBLIC, la clé sera visible
//     de tous, y compris dans l'historique même après suppression ultérieure.
//   - process.env.FEEXPAY_API_KEY / FEEXPAY_SHOP_ID restent lus en priorité
//     s'ils sont définis (ex : sur Render), pour permettre de revenir à la
//     méthode par variables d'environnement sans retoucher ce fichier — mais
//     par défaut, ce sont les valeurs codées en dur ci-dessous qui s'appliquent.

require('dotenv').config();

const config = {
  // Port sur lequel le serveur Express écoute.
  port: process.env.PORT || 10000,

  feexpay: {
    // URL de base de l'API FeexPay v2 (voir la documentation fournie).
    baseUrl: process.env.FEEXPAY_BASE_URL || 'https://api-v2.feexpay.me/api',

    // Clé API (fp_live_... en production, test_... en mode sandbox) —
    // envoyée en Authorization: Bearer <apiKey> sur chaque requête.
    // ⚠️ Cette clé donne un accès complet au wallet FeexPay du compte.
    apiKey: process.env.FEEXPAY_API_KEY || 'fp_TgztQYTEsitJDPfSRKPJxrUASUtAcXSiX1Juk1ig3tDTFwtBFtAJyG4KgKJ0LLp6',

    // Identifiant de la boutique (menu Développeurs > Boutiques du dashboard
    // FeexPay) — requis dans le corps de CHAQUE requête Payin/Payout.
    shopId: process.env.FEEXPAY_SHOP_ID || 'zKl514PGtGduCPu',

    // URL publique de ce service, utilisée pour construire les return_url /
    // cancel_url (opérateurs à redirection : Orange, Wave, Moov CI, etc.) et
    // pour afficher où configurer le webhook FeexPay (menu Webhook du
    // dashboard — FeexPay n'accepte pas de callback_url par requête comme
    // SebPay, l'URL de notification se configure une fois pour toutes côté
    // dashboard).
    // Auto-détectée sur Render via RENDER_EXTERNAL_URL ; PUBLIC_BASE_URL
    // reste disponible pour la forcer manuellement (autre hébergeur, domaine
    // personnalisé, test local).
    publicBaseUrl: process.env.PUBLIC_BASE_URL
      || process.env.RENDER_EXTERNAL_URL
      || `http://localhost:${process.env.PORT || 10000}`,
  },
};

if (!config.feexpay.apiKey || !config.feexpay.shopId) {
  console.warn('⚠️  FEEXPAY_API_KEY et/ou FEEXPAY_SHOP_ID manquantes : les appels à l\'API FeexPay échoueront tant qu\'elles ne sont pas définies.');
}

// --- Vérification des variables d'environnement (utile juste après un ---
// --- déploiement sur Render, pour confirmer que tout est bien chargé) ---
const ENV_VARS = [
  { key: 'FEEXPAY_API_KEY', required: false, note: 'clé API FeexPay (fp_...) — sinon, valeur codée en dur dans config.js utilisée' },
  { key: 'FEEXPAY_SHOP_ID', required: false, note: 'identifiant de boutique — sinon, valeur codée en dur dans config.js utilisée' },
  { key: 'FEEXPAY_BASE_URL', required: false, note: 'a une valeur par défaut correcte, à ne changer que si FeexPay vous en donne une autre' },
  { key: 'PORT', required: false, note: 'fourni automatiquement par Render' },
  { key: 'RENDER_EXTERNAL_URL', required: false, note: "fournie automatiquement par Render (sert de PUBLIC_BASE_URL) ; absente en local ou hors Render, c'est normal" },
  { key: 'PUBLIC_BASE_URL', required: false, note: 'à définir manuellement hors Render (autre hébergeur, domaine personnalisé, test local) pour que les return_url/cancel_url FeexPay soient correctes' },
];

/**
 * Construit un rapport de l'état des variables d'environnement, sans
 * jamais exposer leur valeur. Utilisé au démarrage (logs) et par la route
 * GET /api/health (voir server.js).
 */
function checkEnvVars() {
  const vars = ENV_VARS.map((v) => ({
    key: v.key,
    required: v.required,
    loaded: Boolean(process.env[v.key] && String(process.env[v.key]).trim() !== ''),
    note: v.note,
  }));
  const missingRequired = vars.filter((v) => v.required && !v.loaded).map((v) => v.key);
  return {
    ok: missingRequired.length === 0,
    missingRequired,
    publicBaseUrlInUse: config.feexpay.publicBaseUrl,
    vars,
  };
}

/**
 * Affiche un résumé lisible dans les logs juste après le démarrage du
 * serveur, pour confirmer d'un coup d'œil que les variables d'environnement
 * ont bien été chargées.
 */
function logEnvStatus() {
  const report = checkEnvVars();
  console.log('\n--- Vérification des variables d\'environnement ---');
  report.vars.forEach((v) => {
    const icon = v.loaded ? '✅' : (v.required ? '❌' : '⚠️ ');
    const tag = v.required ? 'requise' : 'optionnelle';
    console.log(`${icon} ${v.key} (${tag}) — ${v.loaded ? 'chargée' : 'absente'} — ${v.note}`);
  });
  if (report.ok) {
    console.log('✅ Toutes les variables requises sont chargées.');
  } else {
    console.log(`❌ Variables requises manquantes : ${report.missingRequired.join(', ')}`);
    console.log('   -> Sur Render : Dashboard du service > Environment > Add Environment Variable, puis redéployez.');
  }
  console.log(`ℹ️  URL publique utilisée (return_url/cancel_url) : ${report.publicBaseUrlInUse}`);
  if (report.publicBaseUrlInUse.startsWith('http://localhost')) {
    console.log("   ⚠️  Ceci ressemble à une adresse locale — pensez à configurer l'URL de webhook dans le dashboard FeexPay avec une adresse publique une fois déployé.");
  }
  console.log('--- Fin de la vérification ---\n');
  return report;
}

module.exports = config;
module.exports.checkEnvVars = checkEnvVars;
module.exports.logEnvStatus = logEnvStatus;
