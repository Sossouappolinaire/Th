// feexpayCatalog.js
// Référentiel statique des pays et réseaux Mobile Money pris en charge, et
// de leur correspondance avec les endpoints de l'API FeexPay v2.
//
// ⚠️ Différence majeure avec l'ancien fournisseur (SebPay) : FeexPay n'expose
// AUCUNE route de type « GET /operators » pour lister dynamiquement les
// réseaux disponibles. Chez FeexPay, chaque réseau correspond à un endpoint
// dédié et fixe (ex : /transactions/public/requesttopay/mtn_ci), documenté
// pays par pays / réseau par réseau dans « Documentation API FeexPay v2 ».
// Ce catalogue est donc la SOURCE DE VÉRITÉ (il n'y a plus de cache ni de
// catalogue de secours distinct : c'est celui-ci qui est utilisé pour
// peupler /api/methods côté front-end ET pour router les appels côté
// serveur). Si FeexPay ajoute un réseau, il faut l'ajouter ici à la main.
//
// Un réseau n'est listé ici QUE s'il est pris en charge à la fois :
//   - en PAYIN (collecte / requesttopay) — pour pouvoir servir d'expéditeur ;
//   - en PAYOUT (décaissement) — pour pouvoir servir de destinataire.
// (Bénin : Coris Money existe en payin chez FeexPay mais PAS en payout, et
// nécessite en plus un flux OTP en 2 étapes différent des autres — il est
// donc volontairement exclu, comme il l'était déjà avec l'ancien fournisseur.)
//
// Pour chaque opérateur :
//   payinPath   : chemin sous /transactions/public/requesttopay/
//   payoutPath  : chemin sous /payouts/public/
//   payoutNetwork : si l'endpoint payout est mutualisé entre plusieurs
//                   réseaux (ex : Bénin, Togo), valeur à envoyer dans le
//                   champ `network` du corps de la requête.
//   redirect    : true si FeexPay répond avec un `payment_url` vers lequel
//                 rediriger l'expéditeur (à ouvrir dans un nouvel onglet) —
//                 sinon l'expéditeur reçoit directement une demande
//                 USSD/notification sur son téléphone.
//   otpRequired / ussdCode : réseau nécessitant un code OTP généré par
//                 l'expéditeur via USSD AVANT l'appel (aujourd'hui, seul
//                 Orange Burkina Faso chez FeexPay).

const COUNTRIES = [
  {
    code: 'BJ',
    name: 'Bénin',
    flag: '🇧🇯',
    dialCode: '229',
    currency: 'XOF',
    phoneDigits: 10, // préfixe "01" + 8 chiffres
    operators: [
      { slug: 'mtn', name: 'MTN', color: '#ffcc00', textColor: '#16241f', payinPath: 'mtn', payoutPath: 'transfer/global', payoutNetwork: 'MTN' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff', payinPath: 'moov', payoutPath: 'transfer/global', payoutNetwork: 'MOOV' },
      { slug: 'celtiis', name: 'Celtiis Money', color: '#00a651', textColor: '#ffffff', payinPath: 'celtiis_bj', payoutPath: 'celtiis_bj', payoutNetwork: 'CELTIIS BJ' },
    ],
  },
  {
    code: 'TG', name: 'Togo', flag: '🇹🇬', dialCode: '228', currency: 'XOF', phoneDigits: 8,
    operators: [
      { slug: 'togocom', name: 'Togocom T-Money', color: '#e30613', textColor: '#ffffff', payinPath: 'togocom_tg', payoutPath: 'togo', payoutNetwork: 'TOGOCOM TG' },
      { slug: 'moov', name: 'Moov Africa (Flooz)', color: '#005baa', textColor: '#ffffff', payinPath: 'moov_tg', payoutPath: 'togo', payoutNetwork: 'MOOV TG' },
    ],
  },
  {
    code: 'CI', name: "Côte d'Ivoire", flag: '🇨🇮', dialCode: '225', currency: 'XOF', phoneDigits: 10,
    operators: [
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f', payinPath: 'mtn_ci', payoutPath: 'mtn_ci' },
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff', payinPath: 'orange_ci', payoutPath: 'orange_ci', redirect: true },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff', payinPath: 'moov_ci', payoutPath: 'moov_ci', redirect: true },
      { slug: 'wave', name: 'Wave', color: '#1dc8f2', textColor: '#16241f', payinPath: 'wave_ci', payoutPath: 'wave_ci', redirect: true },
    ],
  },
  {
    code: 'SN', name: 'Sénégal', flag: '🇸🇳', dialCode: '221', currency: 'XOF', phoneDigits: 9,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff', payinPath: 'orange_sn', payoutPath: 'orange_sn', redirect: true },
      { slug: 'free', name: 'Free Money', color: '#e2001a', textColor: '#ffffff', payinPath: 'free_sn', payoutPath: 'free_sn', redirect: true },
      { slug: 'wave', name: 'Wave', color: '#1dc8f2', textColor: '#16241f', payinPath: 'wave_sn', payoutPath: 'wave_sn', redirect: true },
    ],
  },
  {
    code: 'BF', name: 'Burkina Faso', flag: '🇧🇫', dialCode: '226', currency: 'XOF', phoneDigits: 8,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff', payinPath: 'orange_bf', payoutPath: 'orange_bf', otpRequired: true, ussdCode: '#144*4*6*montant#' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff', payinPath: 'moov_bf', payoutPath: 'moov_bf' },
      { slug: 'wave', name: 'Wave', color: '#1dc8f2', textColor: '#16241f', payinPath: 'wave_bf', payoutPath: 'wave_bf', redirect: true },
    ],
  },
  {
    code: 'ML', name: 'Mali', flag: '🇲🇱', dialCode: '223', currency: 'XOF', phoneDigits: 8,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff', payinPath: 'orange_ml', payoutPath: 'orange_ml' },
      { slug: 'mobicash', name: 'Mobicash', color: '#8e44ad', textColor: '#ffffff', payinPath: 'mobicash_ml', payoutPath: 'mobicash_ml' },
    ],
  },
  {
    code: 'CG', name: 'Congo Brazzaville', flag: '🇨🇬', dialCode: '242', currency: 'XAF', phoneDigits: 9,
    operators: [
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f', payinPath: 'mtn_cg', payoutPath: 'mtn_cg' },
    ],
  },
];

function getCountry(code) {
  return COUNTRIES.find((c) => c.code === String(code).toUpperCase()) || null;
}

function getOperator(countryCode, operatorSlug) {
  const country = getCountry(countryCode);
  if (!country) return null;
  return country.operators.find((o) => o.slug === operatorSlug) || null;
}

// Forme publique consommée par le front-end (GET /api/methods) : pas besoin
// d'exposer les chemins internes payinPath/payoutPath.
function publicCountries() {
  return COUNTRIES.map((c) => ({
    code: c.code,
    name: c.name,
    flag: c.flag,
    dialCode: c.dialCode,
    currency: c.currency,
    phoneDigits: c.phoneDigits,
    operators: c.operators.map((o) => ({
      slug: o.slug,
      name: o.name,
      color: o.color,
      textColor: o.textColor,
      otpRequired: !!o.otpRequired,
      ussdCode: o.ussdCode || null,
      redirect: !!o.redirect,
    })),
  }));
}

module.exports = { COUNTRIES, getCountry, getOperator, publicCountries };
