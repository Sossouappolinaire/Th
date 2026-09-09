// config.js
// Centralise la configuration liée à l'API SebPay (Collections =
// encaissement chez l'expéditeur, Payouts = envoi vers le destinataire).
//
// ⚠️ À la demande explicite du propriétaire du projet, les clés API sont
// codées EN DUR ci-dessous plutôt que lues depuis des variables
// d'environnement. Conséquences à connaître :
//   - Quiconque a accès à ce fichier (dépôt Git, zip partagé, capture
//     d'écran...) a accès à votre clé secrète SebPay, donc à votre wallet.
//   - Si ce dossier est poussé sur un dépôt Git PUBLIC, la clé sera visible
//     de tous, y compris dans l'historique même après suppression ultérieure.
//   - process.env.SEBPAY_PUBLIC_KEY / SEBPAY_SECRET_KEY restent lus en
//     priorité s'ils sont définis (ex : sur Render), pour permettre de
//     revenir à la méthode par variables d'environnement sans retoucher ce
//     fichier — mais par défaut, ce sont les valeurs codées en dur ci-dessous
//     qui s'appliquent.

require('dotenv').config();

const config = {
  // Port sur lequel le serveur Express écoute.
  port: process.env.PORT || 10000,

  sebpay: {
    // URL de base de l'API SebPay (voir la documentation fournie).
    baseUrl: process.env.SEBPAY_BASE_URL || 'https://newapi.sebpay.bj/api/v1',

    // Clé publique (pk_live_...) — identifie le compte SebPay.
    publicKey: process.env.SEBPAY_PUBLIC_KEY || 'pk_live_KZXk20YFXuETMvvo7B5TZEoybXLtsopBZWKjEPyN',

    // Clé secrète (sk_live_...) — sert à signer les requêtes ET à vérifier
    // la signature HMAC-SHA256 des webhooks entrants.
    // ⚠️ Cette clé donne un accès complet au wallet SebPay du compte.
    secretKey: process.env.SEBPAY_SECRET_KEY || 'sk_live_w6OsteIR8i0Q4mQImeN67irPGUtCSjbYAk6VU6fbpX1lch4ULPrdr5dcD8zt',

    // URL publique de ce service, utilisée pour construire les callback_url
    // envoyées à SebPay (ex : https://votre-app.onrender.com).
    // Auto-détectée sur Render via RENDER_EXTERNAL_URL ; PUBLIC_BASE_URL
    // reste disponible pour la forcer manuellement (autre hébergeur, domaine
    // personnalisé, test local).
    publicBaseUrl: process.env.PUBLIC_BASE_URL
      || process.env.RENDER_EXTERNAL_URL
      || `http://localhost:${process.env.PORT || 10000}`,
  },
};

if (!config.sebpay.publicKey || !config.sebpay.secretKey) {
  console.warn('⚠️  SEBPAY_PUBLIC_KEY et/ou SEBPAY_SECRET_KEY manquantes : les appels à l\'API SebPay échoueront tant qu\'elles ne sont pas définies.');
}

// --- Référentiel pays (nom + devise) --------------------------------------
// SebPay renvoie dynamiquement les opérateurs disponibles par pays
// (GET /operators), mais pas de nom de pays lisible ni de devise associée.
// On garde donc ce petit référentiel statique en plus, uniquement pour
// l'affichage et pour choisir la bonne devise — jamais pour la liste des
// opérateurs elle-même, qui reste toujours interrogée en direct (voir
// sebpayService.js), conformément à la documentation SebPay.
const COUNTRY_META = {
  bj: { name: 'Bénin', currency: 'XOF' },
  ci: { name: "Côte d'Ivoire", currency: 'XOF' },
  tg: { name: 'Togo', currency: 'XOF' },
  bf: { name: 'Burkina Faso', currency: 'XOF' },
  sn: { name: 'Sénégal', currency: 'XOF' },
  ne: { name: 'Niger', currency: 'XOF' },
  ml: { name: 'Mali', currency: 'XOF' },
  gw: { name: 'Guinée-Bissau', currency: 'XOF' },
  cm: { name: 'Cameroun', currency: 'XAF' },
  ga: { name: 'Gabon', currency: 'XAF' },
  cg: { name: 'Congo', currency: 'XAF' },
  td: { name: 'Tchad', currency: 'XAF' },
  cd: { name: 'R.D. Congo', currency: 'CDF' },
  gn: { name: 'Guinée', currency: 'GNF' },
  gm: { name: 'Gambie', currency: 'GMD' },
  ng: { name: 'Nigéria', currency: 'NGN' },
  gh: { name: 'Ghana', currency: 'GHS' },
  ke: { name: 'Kenya', currency: 'KES' },
  ug: { name: 'Ouganda', currency: 'UGX' },
  tz: { name: 'Tanzanie', currency: 'TZS' },
};

function countryMeta(code) {
  return COUNTRY_META[String(code).toLowerCase()] || null;
}

// --- Vérification des variables d'environnement (utile juste après un ---
// --- déploiement sur Render, pour confirmer que tout est bien chargé) ---
// Les clés SebPay ont désormais une valeur par défaut codée en dur
// ci-dessus : elles ne sont donc plus "required" au sens strict (l'app
// démarre sans variable d'environnement définie), mais définir
// SEBPAY_PUBLIC_KEY / SEBPAY_SECRET_KEY en environnement reste possible et
// prend toujours le dessus sur la valeur codée en dur.
const ENV_VARS = [
  { key: 'SEBPAY_PUBLIC_KEY', required: false, note: 'clé publique SebPay (pk_...) — sinon, valeur codée en dur dans config.js utilisée' },
  { key: 'SEBPAY_SECRET_KEY', required: false, note: 'clé secrète SebPay (sk_...) — sinon, valeur codée en dur dans config.js utilisée' },
  { key: 'SEBPAY_BASE_URL', required: false, note: 'a une valeur par défaut correcte, à ne changer que si SebPay vous en donne une autre' },
  { key: 'PORT', required: false, note: 'fourni automatiquement par Render' },
  { key: 'RENDER_EXTERNAL_URL', required: false, note: "fournie automatiquement par Render (sert de PUBLIC_BASE_URL) ; absente en local ou hors Render, c'est normal" },
  { key: 'PUBLIC_BASE_URL', required: false, note: 'à définir manuellement hors Render (autre hébergeur, domaine personnalisé, test local) pour que les callback_url SebPay soient correctes' },
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
    publicBaseUrlInUse: config.sebpay.publicBaseUrl,
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
  console.log(`ℹ️  URL publique utilisée (callback_url) : ${report.publicBaseUrlInUse}`);
  if (report.publicBaseUrlInUse.startsWith('http://localhost')) {
    console.log("   ⚠️  Ceci ressemble à une adresse locale — SebPay ne pourra pas vous notifier par webhook tant que ce service n'est pas exposé publiquement.");
  }
  console.log('--- Fin de la vérification ---\n');
  return report;
}


// --- Normalisation des codes pays -----------------------------------------
// SebPay peut renvoyer un code ISO-2 ("BJ"), ISO-3 ("BEN") ou un nom de pays
// selon les opérateurs. On ramène tout vers notre code ISO-2 minuscule, sinon
// des opérateurs valides étaient silencieusement ignorés (liste vide côté
// formulaire -> "Pays indisponibles pour le moment").
const COUNTRY_ALIASES = {
  ben: 'bj', civ: 'ci', tgo: 'tg', bfa: 'bf', sen: 'sn', ner: 'ne', mli: 'ml',
  gnb: 'gw', cmr: 'cm', gab: 'ga', cog: 'cg', tcd: 'td', cod: 'cd', gin: 'gn',
  gmb: 'gm', nga: 'ng', gha: 'gh', ken: 'ke', uga: 'ug', tza: 'tz',
  benin: 'bj', "cote d'ivoire": 'ci', "côte d'ivoire": 'ci', 'ivory coast': 'ci',
  togo: 'tg', 'burkina faso': 'bf', senegal: 'sn', 'sénégal': 'sn', niger: 'ne',
  mali: 'ml', 'guinea-bissau': 'gw', 'guinee-bissau': 'gw', cameroun: 'cm',
  cameroon: 'cm', gabon: 'ga', congo: 'cg', tchad: 'td', chad: 'td',
  'rd congo': 'cd', 'drc': 'cd', guinee: 'gn', 'guinée': 'gn', guinea: 'gn',
  gambie: 'gm', gambia: 'gm', nigeria: 'ng', 'nigéria': 'ng', ghana: 'gh',
  kenya: 'ke', ouganda: 'ug', uganda: 'ug', tanzanie: 'tz', tanzania: 'tz',
};

function normalizeCountryCode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (COUNTRY_META[value]) return value;
  if (COUNTRY_ALIASES[value]) return COUNTRY_ALIASES[value];
  return null;
}

// --- Catalogue de secours -------------------------------------------------
// Utilisé UNIQUEMENT si l'appel direct GET /operators échoue ou ne renvoie
// aucun opérateur exploitable (clé API restreinte par IP, panne SebPay...).
// Le formulaire reste alors utilisable et affiche un avertissement, au lieu
// d'un écran bloqué "Pays indisponibles pour le moment".
const FALLBACK_OPERATORS = {
  // ⚠️ Slugs SANS suffixe pays (ex : "moov", pas "moov-bj"). C'est le format
  // que SebPay accepte réellement pour POST /collections et POST /payouts
  // (confirmé par countries.js et par un test réel) — un slug suffixé fait
  // échouer la COLLECTE avec l'erreur SebPay "Operator not found or not
  // configured for this country". Le pays est transmis séparément via le
  // champ `country` de la requête, pas dans le slug.
  bj: [['mtn', 'MTN Money'], ['moov', 'Moov Money'], ['celtiis', 'Celtiis Money'], ['coris', 'Coris Money']],
  ci: [['orange', 'Orange Money'], ['mtn', 'MTN Money'], ['moov', 'Moov Money'], ['wave', 'Wave Money']],
  tg: [['moov', 'Moov Money'], ['tmoney', 'T-Money']],
  bf: [['orange', 'Orange Money'], ['moov', 'Moov Money'], ['wligdicash', 'LigdiCash']],
  sn: [['orange', 'Orange Money'], ['wave', 'Wave Money'], ['free', 'Free Money']],
  ml: [['orange', 'Orange Money'], ['moov', 'Moov Money']],
  ne: [['airtel', 'Airtel Money'], ['moov', 'Moov Money'], ['amanata', 'Amanata'], ['nita', 'Nita'], ['wligdicash', 'LigdiCash'], ['zamani', 'Zamani']],
  gw: [['orange', 'Orange Money']],
  gn: [['orange', 'Orange Money'], ['mtn', 'MTN Money']],
  cm: [['mtn', 'MTN Money'], ['orange', 'Orange Money']],
  ga: [['moov', 'Moov Money']],
  cg: [['mtn', 'MTN Money'], ['airtel', 'Airtel Money']],
  cd: [['orange', 'Orange Money'], ['airtel', 'Airtel Money'], ['mpesa', 'Mpesa'], ['vodacom', 'Vodacom'], ['afrimoney', 'Afri Money']],
  gm: [['afrimoney', 'Afri Money']],
  ng: [['mtn', 'MTN Money'], ['airtel', 'Airtel']],
  gh: [['mtn', 'MTN Money'], ['telecel', 'Telecel Cash'], ['airtel', 'Airtel']],
  ke: [['mpesa', 'Mpesa'], ['airtel', 'Airtel']],
  ug: [['mtn', 'MTN'], ['airtel', 'Airtel']],
  tz: [['mpesa', 'Mpesa'], ['airtel', 'Airtel'], ['tigopesa', 'Tigo Pesa'], ['halo_pesa', 'Halo Pesa'], ['ezypesa', 'Ezy Pesa']],
};

// Opérateurs signalés INACTIFS par SebPay : refusés en amont plutôt que de
// laisser partir une collecte/un payout voué à l'échec. Scopé par pays
// ("cc:slug") car le slug seul (ex: "airtel") est maintenant partagé par
// plusieurs pays — un Set global aurait bloqué Airtel partout à cause du
// seul Airtel Gabon inactif.
const INACTIVE_OPERATORS = new Set(['ga:airtel', 'sn:emoney', 'td:airtel', 'td:moov']);

// Le formulaire peut encore envoyer d'anciens slugs suffixés par pays
// (ancienne version du front, cache navigateur). On les ramène au slug plat
// réellement accepté par SebPay.
function resolveOperatorSlug(countryCode, slug, availableSlugs = []) {
  const cc = String(countryCode || '').toLowerCase();
  const raw = String(slug || '').toLowerCase().trim();
  if (!raw) return null;
  const candidates = availableSlugs.length ? availableSlugs
    : (FALLBACK_OPERATORS[cc] || []).map(([k]) => k);
  if (candidates.includes(raw)) return raw;
  const base = raw.endsWith(`-${cc}`) ? raw.slice(0, -(cc.length + 1)) : raw.replace(/-[a-z]{2}$/, '');
  const legacy = { togocom: 'tmoney', vodafone: 'telecel', airteltigo: 'airtel', ligdicash: 'wligdicash' };
  const mapped = legacy[base] || base;
  const found = candidates.find((c) => c === mapped || c.startsWith(`${mapped}_`));
  return found || null;
}

function fallbackCountries() {
  return Object.keys(FALLBACK_OPERATORS).map((code) => ({
    code,
    country: COUNTRY_META[code].name,
    currency: COUNTRY_META[code].currency,
    paymentMethods: FALLBACK_OPERATORS[code].map(([key, name]) => ({
      key, name, otpRequired: false, ussdCode: null,
    })),
  }));
}

module.exports = config;
module.exports.countryMeta = countryMeta;
module.exports.normalizeCountryCode = normalizeCountryCode;
module.exports.fallbackCountries = fallbackCountries;
module.exports.COUNTRY_META = COUNTRY_META;
module.exports.INACTIVE_OPERATORS = INACTIVE_OPERATORS;
module.exports.resolveOperatorSlug = resolveOperatorSlug;
module.exports.checkEnvVars = checkEnvVars;
module.exports.logEnvStatus = logEnvStatus;
