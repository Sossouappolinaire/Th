// phoneRules.js
// Longueur attendue des numéros locaux (sans indicatif pays) pour les pays
// pris en charge par FeexPay (voir feexpayCatalog.js pour la liste des
// réseaux). Ces plans de numérotation évoluent régulièrement (ex : le
// Bénin est passé de 8 à 10 chiffres le 30/11/2024) — à vérifier
// périodiquement auprès de sources fiables (régulateurs télécoms).

const PHONE_RULES = {
  ci: { digits: 10, example: '0102030405', dialCode: '225' }, // Côte d'Ivoire — 10 chiffres depuis 2021
  bj: { digits: 10, example: '0197123456', dialCode: '229' }, // Bénin — 10 chiffres depuis le 30/11/2024
  tg: { digits: 8, example: '90123456', dialCode: '228' },    // Togo
  bf: { digits: 8, example: '70123456', dialCode: '226' },    // Burkina Faso
  sn: { digits: 9, example: '771234567', dialCode: '221' },   // Sénégal
  ml: { digits: 8, example: '70123456', dialCode: '223' },    // Mali
  cg: { digits: 9, example: '061234567', dialCode: '242' },   // Congo Brazzaville
};

function getPhoneRule(countryCode) {
  return PHONE_RULES[String(countryCode).toLowerCase()] || null;
}

module.exports = { PHONE_RULES, getPhoneRule };
