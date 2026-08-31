# SebPay Transfert — Bénin & International

Application Node.js/Express qui encaisse chez l'expéditeur (collecte, toujours
un Mobile Money béninois) puis décaisse vers le destinataire (payout) via
l'API SebPay — au Bénin (MTN ↔ Moov) ou dans un autre pays africain pris en
charge par SebPay.

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

1. `POST /api/transfer` initie une **collecte** chez l'expéditeur (toujours un
   numéro Mobile Money béninois).
2. SebPay notifie le résultat via `POST /api/webhook` (signature HMAC-SHA256
   vérifiée avec `SEBPAY_SECRET_KEY`).
3. Si la collecte est `approved`, le serveur déclenche automatiquement un
   **payout** vers le destinataire — au Bénin ou dans le pays choisi.
4. Le front-end interroge `GET /api/transfer/:reference` toutes les 3 s
   jusqu'à un statut final (`completed`, `failed`, `blocked` ou `refunded`).

### Numéros béninois (réforme du 30/11/2024)

Les numéros béninois comptent désormais 10 chiffres locaux (préfixe `01` +
8 chiffres). `sebpayService.js` accepte l'ancien format à 8 chiffres et le
nouveau, et détecte l'opérateur (MTN/Moov) à partir des 2 chiffres qui
suivent le `01`.

### Transfert national vs international

- **National** : le destinataire est aussi un numéro béninois. Le réseau
  (MTN/Moov) est détecté automatiquement, mais reste visible/modifiable via
  les puces de réseau à l'écran.
- **International** : l'utilisateur choisit d'abord le pays du destinataire,
  puis le réseau Mobile Money disponible dans ce pays (`countries.js`), puis
  saisit le numéro local. La collecte reste toujours au Bénin ; seul le
  *payout* part vers le pays choisi (`country` transmis à SebPay).

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
