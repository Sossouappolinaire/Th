# Paiement Mobile Money — Encaissement uniquement

Application Node.js/Express qui encaisse (collecte) de l'argent via l'API
SebPay. Depuis la refonte du 01/09/2026, l'application n'a **plus de
destinataire ni de décaissement automatique** : l'utilisateur choisit son
pays parmi ceux listés dans `countries.js`, paie, et l'argent reste dans le
wallet SebPay du propriétaire de la plateforme. Un message de succès avec le
montant payé s'affiche une fois le paiement confirmé.

## ⚠️ Sécurité

Les clés SebPay et le mot de passe admin sont actuellement écrits **en dur**
dans `config.js`, à la demande. Ce fichier ne doit **jamais** être poussé sur
un dépôt public. S'il devait fuiter, régénérez les clés depuis le dashboard
SebPay et changez le mot de passe admin.

## Déploiement sur Render.com

1. Poussez ce dossier sur un dépôt GitHub/GitLab (`.gitignore` exclut déjà
   `node_modules/` et `data/`).
2. Sur Render : **New +** → **Web Service** → connectez le dépôt.
3. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
4. Vérifiez que `config.js` contient bien vos clés SebPay et l'URL Render
   finale dans `sebpay.publicBaseUrl` (nécessaire pour recevoir les webhooks).
5. Déployez.

## Test en local

```bash
npm install
npm start
# -> http://localhost:10000
```

## Fonctionnement

1. `POST /api/transfer` initie une **collecte** chez l'utilisateur, dans SON
   pays (`senderCountry`, n'importe lequel de `countries.js`).
2. SebPay notifie le résultat via `POST /api/webhook` (signature HMAC-SHA256
   vérifiée avec `SEBPAY_SECRET_KEY`).
3. Si la collecte est `approved`, le paiement est marqué **`completed`**
   directement — aucun décaissement n'est déclenché, l'argent reste sur la
   plateforme.
4. Le front-end interroge `GET /api/transfer/:reference` toutes les 3 s
   jusqu'à un statut final (`completed` ou `failed`) et affiche un message de
   succès avec le montant payé dès que le statut passe à `completed`.

### Numéros béninois (réforme du 30/11/2024)

Les numéros béninois comptent désormais 10 chiffres locaux (préfixe `01` +
8 chiffres). `sebpayService.js` accepte l'ancien format à 8 chiffres et le
nouveau, et détecte l'opérateur (MTN/Moov) à partir des 2 chiffres qui
suivent le `01`. C'est la seule détection automatique par préfixe : pour
tous les autres pays, l'utilisateur choisit son réseau manuellement (puces).

### Code OTP (certains opérateurs)

Orange Burkina Faso, Orange Côte d'Ivoire et Orange Sénégal exigent que
l'abonné compose un code USSD et saisisse l'OTP reçu avant la collecte
(voir `countries.js` → `otpRequired`/`ussdCode`, et la doc SebPay
"Vérification OTP"). Le formulaire affiche ce champ automatiquement quand
l'utilisateur choisit un tel réseau ; sans OTP, `/api/transfer` renvoie une
erreur `OTP_REQUIRED` explicite plutôt que de laisser SebPay rejeter la
collecte silencieusement. Cette liste peut évoluer : à revérifier via
`GET /operators` avant un vrai lancement.

⚠️ Les pays/réseaux listés dans `countries.js` au-delà du Bénin (Togo,
Côte d'Ivoire, Sénégal, Burkina Faso, Mali, Niger, Guinée, Cameroun, Congo)
utilisent les slugs d'opérateurs les plus courants du marché. **Vérifiez-les
auprès de SebPay (documentation ou support) avant un vrai lancement à
l'international** : un mauvais slug fait simplement échouer la collecte avec
une erreur explicite (aucun argent ne bouge), mais autant confirmer en amont.

### Montant minimum

SebPay refuse tout décaissement sous **300 XOF**. Comme un remboursement
passe par un décaissement, ce seuil est bloqué dès la création du paiement
pour garantir qu'un paiement encaissé pourra toujours être remboursé si
besoin.

### Persistance

Les paiements sont sauvegardés dans `data/transfers.json` (créé
automatiquement), et rechargés au démarrage. Cela survit à un crash/redémarrage
du process, mais **pas** à un redéploiement Render qui recrée le disque — pour
une garantie totale, remplacez ce fichier par une vraie base de données
(Postgres, ou un Render Disk persistant).

Le serveur réconcilie aussi automatiquement, toutes les 2 minutes, tous les
paiements encore en attente auprès de SebPay (rattrape les webhooks manqués).

## Panneau admin

Accessible sur `/admin.html`, protégé par le mot de passe défini dans
`config.admin.token`. Permet de :

- lister tous les paiements en attente ;
- vérifier l'état réel d'un paiement par référence auprès de SebPay ;
- **rembourser** un paiement déjà encaissé (renvoie l'argent au numéro
  payeur) — utile pour un client à rembourser ;
- corriger en masse tous les paiements en attente en un clic.
