# Kouamé Paiement — Réseau vers autre

> ⚠️ **Sécurité — clés API codées en dur.** À la demande du propriétaire du
> projet, les clés SebPay sont écrites directement dans `config.js` plutôt
> que fournies via des variables d'environnement. Cela signifie que
> **quiconque obtient ce dossier (dépôt Git, zip, capture d'écran...) peut
> utiliser votre wallet SebPay.** Ne poussez jamais ce dossier tel quel sur
> un dépôt **public**, et ne le partagez qu'avec des personnes de confiance.
> Pour revenir à la méthode plus sûre (variables d'environnement, clés hors
> du code), voir `.env.example` — `config.js` continue de lire
> `SEBPAY_PUBLIC_KEY` / `SEBPAY_SECRET_KEY` en priorité si elles sont
> définies en environnement.

Application Node.js/Express qui permet un **vrai transfert réseau → réseau** :
on encaisse l'argent chez l'expéditeur (**Collection**), puis on l'envoie
automatiquement au destinataire (**Payout**), via l'API **SebPay**.

La liste des pays et opérateurs disponibles (pour l'expéditeur **et** le
destinataire) est récupérée **dynamiquement** depuis `GET /operators` : aucune
liste codée en dur, conformément à la doc SebPay (le champ `otp_required`
peut évoluer).

## Fonctionnement (Collection → webhook → Payout)

1. Le front-end charge `/api/methods` (proxy vers SebPay) pour peupler les
   listes déroulantes Pays → Réseau, à la fois pour l'**expéditeur** et le
   **destinataire**.
2. `POST /api/transfer` valide les données puis appelle
   `POST /collections` de SebPay pour encaisser l'**expéditeur** : celui-ci
   reçoit une demande de paiement directement sur son téléphone (USSD ou
   notification). Pour certains opérateurs (ex. Wave), SebPay renvoie un
   `provider_link` : le front-end l'ouvre alors dans un **nouvel onglet**.
3. Pour les opérateurs qui l'exigent (Orange CI/BF/SN…), un **code OTP** est
   demandé avant l'appel : l'utilisateur compose le code USSD indiqué
   (`ussd_code`, renvoyé par `GET /operators`) et saisit le code reçu.
4. SebPay notifie le résultat via `POST /api/webhook/sebpay/collection`
   (`status: approved / rejected / pending`), signé HMAC-SHA256
   (`X-SebPay-Signature`, vérifié avec `SEBPAY_SECRET_KEY`).
5. Dès que la collection est `approved`, le serveur déclenche automatiquement
   le **Payout** (`POST /payouts`) vers le destinataire.
6. SebPay notifie l'issue finale via `POST /api/webhook/sebpay/payout`
   (même mécanisme de signature).
7. Le front-end (`index.html`) interroge `GET /api/transfer/:transferId`
   toutes les 3 s jusqu'à un statut final :
   - `completed` — le destinataire a bien été crédité. Redirection vers
     **`success.html?transferId=...`**, qui revérifie l'état auprès du
     serveur avant d'afficher la confirmation ;
   - `collection_failed` — l'expéditeur n'a pas payé (rien n'a été prélevé) ;
   - `payout_failed` — **cas à surveiller** : l'expéditeur a payé mais
     l'envoi au destinataire a échoué. Selon la doc SebPay, le montant est
     alors remboursé **automatiquement sur votre wallet marchand** — pas
     directement à l'expéditeur : prévoyez un remboursement, une nouvelle
     tentative ou un suivi manuel pour ce cas.

En secours (si un webhook est manqué), `GET /api/transfer/:transferId`
revérifie aussi directement l'état auprès de SebPay (`GET /collections/{id}`
ou `GET /payouts/{id}`) tant que le transfert reste "pending".

⚠️ Le stockage des transferts en cours est fait en mémoire (`Map`) : il est
perdu à chaque redémarrage du service. Pour de la production, remplacez-le
par une vraie base de données — c'est d'autant plus important que c'est ce
qui relie le webhook de collection au payout à déclencher.

⚠️ **Aucune conversion de devise** n'est effectuée : un transfert n'est
autorisé que si le pays de l'expéditeur et celui du destinataire partagent
la même devise (ex. Bénin ↔ Sénégal, tous deux en XOF). Un transfert entre
devises différentes est refusé explicitement, côté front-end et côté
serveur.

## Réseaux, OTP et validation des numéros

- Les **pays et opérateurs** affichés dans le formulaire sont récupérés en
  direct depuis SebPay (`GET /operators`) — tout opérateur ajouté ou dont le
  statut `otp_required` change côté SebPay est reflété automatiquement
  (cache de 5 minutes), sans modification du code.
- Chaque réseau (MTN, Orange, Moov, Wave…) est représenté par un **badge
  coloré généré côté client** (pas les logos officiels des marques, pour des
  raisons de droits d'usage).
- Le **nom du pays et la devise** associés à chaque code pays (ex. `bj` →
  Bénin / XOF) viennent d'un petit référentiel statique dans `config.js`
  (`COUNTRY_META`), car l'API SebPay ne renvoie pas ces informations —
  uniquement la liste des opérateurs.
- Le **nombre de chiffres attendu par numéro** est vérifié (côté formulaire
  **et** côté serveur, dans `phoneRules.js`) pour les pays dont le plan de
  numérotation a pu être confirmé auprès de sources fiables (Côte d'Ivoire,
  Bénin, Togo, Burkina Faso, Sénégal, Niger, Cameroun, Gabon, Mali). Pour les
  autres pays pris en charge par SebPay, seul l'indicatif est connu ; une
  validation générique (6 à 12 chiffres) s'applique.

## Prérequis côté dashboard SebPay

1. **Récupérez vos clés API** (`X-Public-Key` / `X-Secret-Key`) depuis votre
   tableau de bord SebPay et renseignez-les dans `SEBPAY_PUBLIC_KEY` /
   `SEBPAY_SECRET_KEY`.
2. Assurez-vous que votre **wallet SebPay** dispose d'un solde suffisant :
   un payout déduit immédiatement le montant + les frais de votre wallet.

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
   | `SEBPAY_PUBLIC_KEY` | votre clé publique (dashboard SebPay) |
   | `SEBPAY_SECRET_KEY` | votre clé secrète (dashboard SebPay) |
   | `SEBPAY_BASE_URL` | `https://newapi.sebpay.bj/api/v1` |

   Inutile d'ajouter `PUBLIC_BASE_URL` : Render fournit automatiquement
   `RENDER_EXTERNAL_URL` (utilisée comme URL publique pour les
   `callback_url`). N'ajoutez cette variable que pour forcer une valeur
   précise (domaine personnalisé, test hors Render).
5. Déployez. Render assigne automatiquement `PORT` (le service écoute
   dessus, avec `10000` comme valeur de repli si non fournie).

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

⚠️ En local, SebPay ne pourra pas atteindre vos webhooks (`callback_url`)
tant que ce service n'est pas exposé publiquement (ex. via un tunnel type
ngrok) — le suivi de secours (`GET /api/transfer/:id` qui revérifie
directement auprès de SebPay) permet néanmoins de tester le flux complet.

## Structure du projet

```
fusionpay-transfert/
├── server.js         # routes Express + orchestration collection -> webhook -> payout
├── sebpayService.js  # appels aux API Collections ET Payouts de SebPay + vérif. signature webhook
├── config.js          # variables d'environnement + référentiel pays (nom/devise)
├── phoneRules.js      # longueur de numéro attendue par pays (+ indicatifs)
├── public/
│   ├── index.html     # formulaire (5 étapes) + suivi collection/payout en direct
│   ├── success.html   # page de confirmation finale (après redirection)
│   ├── success.js     # revérifie l'état auprès du serveur avant d'afficher le succès
│   ├── style.css
│   └── app.js
├── package.json
└── .env.example
```
