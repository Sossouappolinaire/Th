// countries.js
// Référentiel des pays et réseaux Mobile Money proposés dans l'interface.
//
// ⚠️ IMPORTANT : les "slug" d'opérateurs (ex: 'mtn', 'orange', 'wave') sont
// ceux qu'on utilise pour appeler SebPay (champ `operator` des endpoints
// /collections et /payouts). Ils ont été recroisés avec la liste officielle
// SebPay (page "Opérateurs de paiement" de leur documentation) le
// 31/08/2026. Cela a corrigé deux erreurs qui auraient fait échouer des
// payouts en silence :
//   - Togo : le slug était 'togocom', qui N'EXISTE PAS chez SebPay. Le bon
//     slug pour T-Money est 'tmoney'.
//   - Niger : 'orange' était proposé alors que SebPay ne liste AUCUN Orange
//     Money pour le Niger. Remplacé par les opérateurs réellement listés
//     (Airtel, Moov, Amanata, Nita, LigdiCash, Zamani).
// Burkina Faso : ajout de LigdiCash (wligdicash), présent et actif chez
// SebPay mais absent de la liste précédente.
// ⚠️ Cette liste reste à reconfirmer côté SebPay avant tout gros volume :
// un mauvais slug fait échouer le payout avec une erreur explicite (aucun
// argent ne part), donc le risque est faible, mais autant vérifier via
// GET /operators?country=XX de temps en temps, les opérateurs pouvant
// changer de statut (actif/inactif) sans prévenir.
//
// `phoneDigits` = nombre de chiffres du numéro LOCAL (sans l'indicatif pays),
// vérifié pays par pays (plans de numérotation nationaux, 31/08/2026) :
//   Bénin 10 (préfixe "01" + 8 chiffres, réforme du 30/11/2024) · Togo 8 ·
//   Côte d'Ivoire 10 (passage à 10 chiffres le 31/01/2021) · Sénégal 9 ·
//   Burkina Faso 8 · Mali 8 · Niger 8 · Guinée 9 · Cameroun 9 (9 chiffres
//   depuis le 21/11/2014) · Congo-Brazzaville 9.
// Sert à valider strictement la longueur du numéro saisi (au lieu d'une
// fourchette générique 6-10 utilisée auparavant), côté serveur ET client.

const COUNTRIES = [
  {
    code: 'BJ',
    name: 'Bénin',
    flag: '🇧🇯',
    dialCode: '229',
    phoneDigits: 10, // préfixe "01" + 8 chiffres
    isHome: true, // pays où se trouve l'expéditeur (collecte toujours ici)
    // ⚠️ 3 réseaux retenus à la demande : MTN, Moov, Celtiis. SebPay liste
    // aussi "Coris Money" (slug 'coris') comme actif pour le Bénin — il a
    // été volontairement exclu ici. Si vous le vouliez inclus, dites-le-moi.
    operators: [
      { slug: 'mtn', name: 'MTN', color: '#ffcc00', textColor: '#16241f', prefixes: ['90', '91', '96', '97', '98', '99'] },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff', prefixes: ['94', '95', '64', '65', '66', '67', '68', '69'] },
      { slug: 'celtiis', name: 'Celtiis Money', color: '#00a651', textColor: '#ffffff' },
    ],
  },
  {
    code: 'TG', name: 'Togo', flag: '🇹🇬', dialCode: '228', phoneDigits: 8,
    operators: [
      // Corrigé : le slug SebPay pour T-Money est 'tmoney' (pas 'togocom').
      { slug: 'tmoney', name: 'T-Money', color: '#e30613', textColor: '#ffffff' },
      { slug: 'moov', name: 'Moov Africa (Flooz)', color: '#005baa', textColor: '#ffffff' },
    ],
  },
  {
    code: 'CI', name: "Côte d'Ivoire", flag: '🇨🇮', dialCode: '225', phoneDigits: 10,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff' },
      { slug: 'wave', name: 'Wave', color: '#1dc8f2', textColor: '#16241f' },
    ],
  },
  {
    code: 'SN', name: 'Sénégal', flag: '🇸🇳', dialCode: '221', phoneDigits: 9,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
      { slug: 'free', name: 'Free Money', color: '#e2001a', textColor: '#ffffff' },
      { slug: 'wave', name: 'Wave', color: '#1dc8f2', textColor: '#16241f' },
    ],
  },
  {
    code: 'BF', name: 'Burkina Faso', flag: '🇧🇫', dialCode: '226', phoneDigits: 8,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff' },
      { slug: 'wligdicash', name: 'LigdiCash', color: '#1b75bb', textColor: '#ffffff' },
    ],
  },
  {
    code: 'ML', name: 'Mali', flag: '🇲🇱', dialCode: '223', phoneDigits: 8,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff' },
    ],
  },
  {
    code: 'NE', name: 'Niger', flag: '🇳🇪', dialCode: '227', phoneDigits: 8,
    // Corrigé : 'orange' n'existe pas chez SebPay pour le Niger, retiré.
    operators: [
      { slug: 'airtel', name: 'Airtel Money', color: '#e40000', textColor: '#ffffff' },
      { slug: 'moov', name: 'Moov Africa', color: '#005baa', textColor: '#ffffff' },
      { slug: 'wligdicash', name: 'LigdiCash', color: '#1b75bb', textColor: '#ffffff' },
      { slug: 'amanata', name: 'Amanata', color: '#8e44ad', textColor: '#ffffff' },
      { slug: 'nita', name: 'Nita', color: '#16a085', textColor: '#ffffff' },
      { slug: 'zamani', name: 'Zamani', color: '#d35400', textColor: '#ffffff' },
    ],
  },
  {
    code: 'GN', name: 'Guinée', flag: '🇬🇳', dialCode: '224', phoneDigits: 9,
    operators: [
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f' },
    ],
  },
  {
    code: 'CM', name: 'Cameroun', flag: '🇨🇲', dialCode: '237', phoneDigits: 9,
    operators: [
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f' },
      { slug: 'orange', name: 'Orange Money', color: '#ff7900', textColor: '#ffffff' },
    ],
  },
  {
    code: 'CG', name: 'Congo', flag: '🇨🇬', dialCode: '242', phoneDigits: 9,
    operators: [
      { slug: 'mtn', name: 'MTN MoMo', color: '#ffcc00', textColor: '#16241f' },
      { slug: 'airtel', name: 'Airtel Money', color: '#e40000', textColor: '#ffffff' },
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

// Renvoie la liste sans les préfixes internes (pas utile côté client)
function publicCountries() {
  return COUNTRIES.map((c) => ({
    code: c.code,
    name: c.name,
    flag: c.flag,
    dialCode: c.dialCode,
    phoneDigits: c.phoneDigits,
    isHome: !!c.isHome,
    operators: c.operators.map((o) => ({ slug: o.slug, name: o.name, color: o.color, textColor: o.textColor })),
  }));
}

module.exports = { COUNTRIES, getCountry, getOperator, publicCountries };
