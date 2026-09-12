# Kouamé Paiement — Réseau vers autre

> ⚠️ **Sécurité — clé API.** Contrairement à une version précédente de ce
> projet, la clé API **n'est plus codée en dur** : `config.js` la lit
> uniquement depuis les variables d'environnement `FEEXPAY_API_KEY` /
> `FEEXPAY_SHOP_ID` (voir `.env.example`). Ne commitez jamais votre fichier
> `.env` réel, et ne poussez jamais une clé API sur un dépôt public.

Application Node.js/Express qui permet un **vrai transfert réseau → réseau** :
on encaisse l'argent chez l'expéditeur (**Payin**), puis on l'envoie
automatiquement au destinataire (**Payout**), via l'API **FeexPay v2**.

La liste des pays et opérateurs disponibles (pour l'expéditeur **et** le
destinataire) vient d'un **catalogue statique** (`feexpayCatalog.js`) :
FeexPay, à la différence de l'ancien fournisseur, n'expose aucune route pour
lister ses réseaux en direct — chaque réseau correspond à un endpoint dédié
et fixe (ex. `/transactions/public/requesttopay/mtn_ci`), documenté pays par
pays / réseau par réseau. Un réseau n'apparaît dans ce catalogue que s'il est
pris en charge à la fois en Payin (pour servir d'expéditeur) et en Payout
(pour servir de destinataire).

## Fonctionnement (Payin → webhook/revérification → Payout)

1. Le front-end charge `/api/methods` (catalogue statique) pour peupler les
   listes déroulantes Pays → Réseau, à la fois pour l'**expéditeur** et le
   **destinataire**.
2. `POST /api/transfer` valide les données puis appelle
   `POST /transactions/public/requesttopay/{réseau}` de FeexPay pour
   encaisser l'**expéditeur**. Selon le réseau :
   - la plupart des réseaux envoient directement une demande de paiement sur
     le téléphone de l'expéditeur (USSD ou notification) ;
   - les réseaux **à redirection** (Orange, Wave, Moov Côte d'Ivoire...)
     renvoient un `payment_url` : le front-end l'ouvre alors dans un
     **nouvel onglet**.
3. Pour Orange Burkina Faso (seul réseau concerné à ce jour), un **code
   OTP** est demandé avant l'appel : l'utilisateur compose le code USSD
   indiqué (`#144*4*6*montant#`) et saisit le code reçu.
4. FeexPay peut notifier le résultat via un **webhook** (`POST
   /api/webhook/feexpay`) — mais **FeexPay ne signe pas ses webhooks**
   (pas d'équivalent du HMAC de l'ancien fournisseur). Le serveur ne fait
   donc **jamais confiance au contenu du webhook lui-même** : il ne sert que
   de déclencheur pour aller revérifier le statut réel via un appel
   authentifié (`Authorization: Bearer <clé API>`) directement auprès de
   FeexPay (`GET /transactions/public/single/status/{reference}` ou
   `GET /payouts/status/public/{reference}`).
5. Dès que le payin est confirmé `SUCCESSFUL`, le serveur déclenche
   automatiquement le **Payout** vers le destinataire.
6. Le front-end (`index.html`) interroge `GET /api/transfer/:transferId`
   toutes les 3 s jusqu'à un statut final :
   - `completed` — le destinataire a bien été crédité. Redirection vers
     **`success.html?transferId=...`**, qui revérifie l'état auprès du
     serveur avant d'afficher la confirmation ;
   - `collection_failed` — l'expéditeur n'a pas payé (rien n'a été prélevé) ;
   - `payout_failed` — **cas à surveiller** : l'expéditeur a payé mais
     l'envoi au destinataire a échoué. Prévoyez un remboursement, une
     nouvelle tentative ou un suivi manuel pour ce cas.

En secours (webhook manqué, ou webhook non configuré côté dashboard),
`GET /api/transfer/:transferId` revérifie aussi directement l'état auprès de
FeexPay tant que le transfert reste en `PENDING`. Sur la V2 de l'API FeexPay,
un payout renvoie d'ailleurs toujours `PENDING` au lancement : le statut
final s'obtient systématiquement via cette revérification.

⚠️ Le stockage des transferts en cours est fait en mémoire (`Map`) : il est
perdu à chaque redémarrage du service. Pour de la production, remplacez-le
par une vraie base de données — c'est d'autant plus important que c'est ce
qui relie le webhook/la revérification de payin au payout à déclencher.

⚠️ **Aucune conversion de devise** n'est effectuée : un transfert n'est
autorisé que si le pays de l'expéditeur et celui du destinataire partagent
la même devise (ex. Bénin ↔ Sénégal, tous deux en XOF). Un transfert entre
devises différentes est refusé explicitement, côté front-end et côté
serveur.

## Réseaux, OTP et validation des numéros

- Les **pays et opérateurs** affichés dans le formulaire viennent du
  catalogue statique `feexpayCatalog.js`, recroisé avec la documentation
  FeexPay v2 (Payin **et** Payout, pays par pays / réseau par réseau). Si
  FeexPay ajoute ou retire un réseau, ce fichier doit être mis à jour à la
  main (pas de liste dynamique côté FeexPay).
- Chaque réseau (MTN, Orange, Moov, Wave…) est représenté par un **badge
  coloré généré côté client** (pas les logos officiels des marques, pour des
  raisons de droits d'usage).
- Le **nom du pays et la devise** associés à chaque code pays viennent du
  même catalogue statique.
- Le **nombre de chiffres attendu par numéro** est vérifié (côté formulaire
  **et** côté serveur, dans `phoneRules.js`) pour tous les pays du
  catalogue (Côte d'Ivoire, Bénin, Togo, Burkina Faso, Sénégal, Mali, Congo
  Brazzaville).

## Prérequis côté dashboard FeexPay

1. **Créez un compte** et faites-le **valider** (nécessaire pour la
   production).
2. **Récupérez votre clé API** (`fp_live_...`) dans le menu **Développeurs**,
   et l'**identifiant de votre boutique** dans le menu **Boutiques** —
   renseignez-les dans `FEEXPAY_API_KEY` / `FEEXPAY_SHOP_ID`.
3. **Configurez l'URL de webhook** dans le menu **Webhook** du dashboard :
   `https://votre-service.onrender.com/api/webhook/feexpay` (FeexPay
   n'accepte pas de `callback_url` par requête, contrairement à l'ancien
   fournisseur : l'URL se configure une fois pour toutes ici).
4. Pour les réseaux **Wave**, activez d'abord votre compte Wave via le menu
   dédié du dashboard FeexPay avant de pouvoir l'utiliser en Payin.
5. Assurez-vous que votre **wallet FeexPay** dispose d'un solde suffisant :
   un payout déduit immédiatement le montant de votre wallet.
6. Les montants sont encadrés par FeexPay : Payin entre 100 et 2 000 000
   XOF ; Payout à partir de 50 ou 100 XOF selon le réseau.

## Déploiement sur Render.com

1. Poussez ce dossier sur un dépôt GitHub/GitLab.
2. Sur Render : **New +** → **Web Service** → connectez le dépôt.
3. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
4. Dans l'onglet **Environment**, ajoutez les variables :
   | Clé | Valeur |
   |---|---|
   | `FEEXPAY_API_KEY` | votre clé API (dashboard FeexPay, menu Développeurs) |
   | `FEEXPAY_SHOP_ID` | votre identifiant de boutique (dashboard FeexPay, menu Boutiques) |
   | `FEEXPAY_BASE_URL` | `https://api-v2.feexpay.me/api` |

   Inutile d'ajouter `PUBLIC_BASE_URL` : Render fournit automatiquement
   `RENDER_EXTERNAL_URL` (utilisée comme URL publique pour les
   `return_url`/`cancel_url`). N'ajoutez cette variable que pour forcer une
   valeur précise (domaine personnalisé, test hors Render).
5. Déployez. Render assigne automatiquement `PORT` (le service écoute
   dessus, avec `10000` comme valeur de repli si non fournie).
6. Une fois déployé, allez configurer l'URL de webhook dans le dashboard
   FeexPay (voir section précédente) avec l'URL Render obtenue.

## Vérifier que les variables d'environnement sont bien chargées

1. **Logs Render** — onglet **Logs** du service : juste après
   `Serveur lancé sur le port ...`, un résumé s'affiche automatiquement
   (✅/❌ pour chaque variable, sans jamais afficher sa valeur).
2. **Route `/api/health`** — ouvrez
   `https://votre-service.onrender.com/api/health` dans le navigateur :
   renvoie un JSON `{ "ok": true/false, "missingRequired": [...], "vars": [...] }`.
   `ok: false` = au moins une variable requise manque → allez dans
   **Environment** sur Render, ajoutez-la, puis redéployez (**Manual
   Deploy** → **Deploy latest commit**).

## Test en local

```bash
cp .env.example .env
# renseignez vos clés dans .env
npm install
npm start
# -> http://localhost:10000
```

⚠️ En local, FeexPay ne pourra pas atteindre votre webhook tant que ce
service n'est pas exposé publiquement (ex. via un tunnel type ngrok) — le
suivi de secours (`GET /api/transfer/:id`, qui revérifie directement auprès
de FeexPay) permet néanmoins de tester le flux complet sans webhook.

## Structure du projet

```
kouame-paiement/
├── server.js            # routes Express + orchestration payin -> webhook/revérification -> payout
├── feexpayService.js    # appels aux API Payin ET Payout de FeexPay + statut
├── feexpayCatalog.js    # catalogue statique pays/réseaux <-> endpoints FeexPay
├── config.js            # variables d'environnement (clé API, shop ID, URL publique)
├── phoneRules.js        # longueur de numéro attendue par pays (+ indicatifs)
├── public/
│   ├── index.html       # formulaire (5 étapes) + suivi payin/payout en direct
│   ├── success.html     # page de confirmation finale (après redirection)
│   ├── success.js       # revérifie l'état auprès du serveur avant d'afficher le succès
│   ├── style.css
│   └── app.js
├── package.json
└── .env.example
```

## Nouveautés

- **Écran d'accueil animé** : barres de chargement (connexion, réseaux, pays)
  qui montent jusqu'à 100 % — la dernière attend la vraie réponse de
  `/api/methods` — puis le site s'ouvre.
- **Reçu imprimé** (`/success.html`) : animation d'imprimante thermique, reçu
  détaillé (expéditeur, destinataire, réseau, montant, référence) et bouton
  « Imprimer ». Aperçu de démonstration : `/success.html?demo=1`.
