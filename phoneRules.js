// phoneRules.js
// Longueur attendue des numéros locaux (sans indicatif pays) pour les pays
// pris en charge par SebPay. Ces plans de numérotation évoluent
// régulièrement (ex : le Bénin est passé de 8 à 10 chiffres le
// 30/11/2024, le Gabon de 8 à 9 chiffres le 06/04/2024) — seuls les pays
// listés ci-dessous ont une règle stricte, volontairement limitée à ceux
// dont le format a pu être vérifié auprès de sources fiables (régulateurs
// télécoms, presse spécialisée). Pour tout pays absent de cette table
// (renvoyé dynamiquement par FusionMoney mais non encore documenté ici),
// une validation générique et non bloquante est appliquée côté front-end
// (voir public/app.js) — le transfert reste possible, seul l'indice de
// format précis n'est pas affiché.
//
// ⚠️ À vérifier périodiquement : ces plans de numérotation changent.

const PHONE_RULES = {
  ci: { digits: 10, example: '0102030405', dialCode: '225' }, // Côte d'Ivoire — 10 chiffres depuis 2021
  bj: { digits: 10, example: '0197123456', dialCode: '229' }, // Bénin — 10 chiffres depuis le 30/11/2024
  tg: { digits: 8, example: '90123456', dialCode: '228' },    // Togo
  bf: { digits: 8, example: '70123456', dialCode: '226' },    // Burkina Faso
  sn: { digits: 9, example: '771234567', dialCode: '221' },   // Sénégal
  ne: { digits: 8, example: '90123456', dialCode: '227' },    // Niger
  cm: { digits: 9, example: '671234567', dialCode: '237' },   // Cameroun
  ga: { digits: 9, example: '074123456', dialCode: '241' },   // Gabon — 9 chiffres depuis le 06/04/2024
  ml: { digits: 8, example: '70123456', dialCode: '223' },    // Mali

  // Pays supplémentaires pris en charge par SebPay : indicatif connu, mais
  // format local non encore vérifié auprès d'une source fiable -> pas de
  // règle de longueur stricte (digits volontairement absent), seule
  // l'indicatif est affiché côté front-end. Voir getPhoneRule() ci-dessous.
  cd: { dialCode: '243' }, // R.D. Congo
  cg: { dialCode: '242' }, // Congo
  gn: { dialCode: '224' }, // Guinée
  gw: { dialCode: '245' }, // Guinée-Bissau
  gm: { dialCode: '220' }, // Gambie
  td: { dialCode: '235' }, // Tchad
  ng: { dialCode: '234' }, // Nigéria
  gh: { dialCode: '233' }, // Ghana
  ke: { dialCode: '254' }, // Kenya
  ug: { dialCode: '256' }, // Ouganda
  tz: { dialCode: '255' }, // Tanzanie
};

function getPhoneRule(countryCode) {
  return PHONE_RULES[String(countryCode).toLowerCase()] || null;
}

module.exports = { PHONE_RULES, getPhoneRule };
