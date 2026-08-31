# SebPay Transfert — Multi-pays

Application Node.js/Express qui encaisse chez l'expéditeur (collecte) puis
décaisse vers le destinataire (payout) via l'API SebPay. Depuis le
01/09/2026, l'expéditeur ET le destinataire choisissent chacun leur pays
parmi ceux listés dans `countries.js` — l'expéditeur n'est plus figé sur le
Bénin.

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

1. `POST /api/transfer` initie une **collecte** chez l'expéditeur, dans SON
   pays (`senderCountry`, n'importe lequel de `countries.js`).
2. SebPay notifie le résultat via `POST /api/webhook` (signature HMAC-SHA256
   vérifiée avec `SEBPAY_SECRET_KEY`).
3. Si la collecte est `approved`, le serveur déclenche automatiquement un
   **payout** vers le destinataire, dans LE SIEN (`destinationCountry`).
4. Le front-end interroge `GET /api/transfer/:reference` toutes les 3 s
   jusqu'à un statut final (`completed`, `failed`, `blocked` ou `refunded`).

### Numéros béninois (réforme du 30/11/2024)

Les numéros béninois comptent désormais 10 chiffres locaux (préfixe `01` +
8 chiffres). `sebpayService.js` accepte l'ancien format à 8 chiffres et le
nouveau, et détecte l'opérateur (MTN/Moov) à partir des 2 chiffres qui
suivent le `01`. C'est la seule détection automatique par préfixe : pour
tous les autres pays, l'utilisateur choisit son réseau manuellement (puces).

### Transfert national vs international

- **National** : expéditeur et destinataire dans **le même pays**
  (n'importe lequel de `countries.js`, pas seulement le Bénin). Au Bénin, le
  réseau (MTN/Moov) est détecté automatiquement mais reste modifiable via
  les puces.
- **International** : l'expéditeur choisit son pays et son réseau, puis le
  destinataire choisit un **autre** pays (exclu de la liste : celui de
  l'expéditeur) et son réseau. Chaque étape passe par `country` (côté
  collecte **et** côté payout) transmis à SebPay.

### Code OTP (certains opérateurs)

Orange Burkina Faso, Orange Côte d'Ivoire et Orange Sénégal exigent que
l'abonné compose un code USSD et saisisse l'OTP reçu avant la collecte
(voir `countries.js` → `otpRequired`/`ussdCode`, et la doc SebPay
"Vérification OTP"). Le formulaire affiche ce champ automatiquement quand
l'expéditeur choisit un tel réseau ; sans OTP, `/api/transfer` renvoie une
erreur `OTP_REQUIRED` explicite plutôt que de laisser SebPay rejeter la
collecte silencieusement. Cette liste peut évoluer : à revérifier via
`GET /operators` avant un vrai lancement.

⚠️ Les pays/réseaux listés dans `countries.js` au-delà du Bénin (Togo,
Côte d'Ivoire, Sénégal, Burkina Faso, Mali, Niger, Guinée, Cameroun, Congo)
utilisent les slugs d'opérateurs les plus courants du marché. **Vérifiez-les
auprès de SebPay (documentation ou support) avant un vrai lancement à
l'international** : un mauvais slug fait simplement échouer le payout avec
une erreur explicite (aucun argent ne part), mais autant confirmer en amont.

### Montant minimum

SebPay refuse tout décaissement (payout) sous **300 XOF**. Comme un
remboursement passe aussi par un payout, ce seuil est bloqué dès la création
du transfert pour éviter qu'un montant collecté reste coincé sans solution.

### Persistance

Les transferts en cours sont sauvegardés dans `data/transfers.json` (créé
automatiquement), et rechargés au démarrage. Cela survit à un crash/redémarrage
du process, mais **pas** à un redéploiement Render qui recrée le disque — pour
une garantie totale, remplacez ce fichier par une vraie base de données
(Postgres, ou un Render Disk persistant).

Le serveur réconcilie aussi automatiquement, toutes les 2 minutes, tous les
transferts encore en attente auprès de SebPay (rattrape les webhooks manqués).

## Panneau admin

Accessible sur `/admin.html`, protégé par le mot de passe défini dans
`config.admin.token`. Permet de :

- lister tous les paiements en attente ou bloqués ;
- vérifier l'état réel d'un transfert par référence auprès de SebPay ;
- **annuler** un transfert bloqué (renvoie l'argent au numéro émetteur) ;
- **réessayer** l'envoi au destinataire sans ressaisir le montant ;
- corriger en masse tous les paiements en attente en un clic.

Un transfert passe au statut **`blocked`** quand la collecte a réussi mais
que l'envoi au destinataire a échoué : l'argent est alors dans le wallet
SebPay, ni perdu ni livré — à traiter depuis ce panneau (annuler ou
réessayer).
