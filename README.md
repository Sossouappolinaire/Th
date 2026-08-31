# Transfert MTN ↔ Moov (Bénin) via SebPay

Application Node.js/Express qui encaisse chez l'expéditeur (collecte) puis
décaisse vers le destinataire (payout) via l'API SebPay.

## Déploiement sur Render.com

1. Poussez ce dossier sur un dépôt GitHub/GitLab.
2. Sur Render : **New +** → **Web Service** → connectez le dépôt.
3. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Port** : `10000` (déjà géré dans le code via `process.env.PORT || 10000`)
4. Dans l'onglet **Environment**, ajoutez les variables :
   | Clé | Valeur |
   |---|---|
   | `SEBPAY_PUBLIC_KEY` | votre `pk_live_...` (dashboard SebPay) |
   | `SEBPAY_SECRET_KEY` | votre `sk_live_...` (dashboard SebPay) |
   | `SEBPAY_BASE_URL` | `https://newapi.sebpay.bj/api/v1` |
   | `PUBLIC_BASE_URL` | l'URL Render une fois le service créé, ex. `https://votre-service.onrender.com` |
5. Déployez. Render assigne automatiquement `PORT` (le service écoute dessus,
   avec `10000` comme valeur de repli si non fournie).

## Test en local

```bash
cp .env.example .env
# renseignez vos clés dans .env
npm install
npm start
# -> http://localhost:10000
```

## Fonctionnement

1. `POST /api/transfer` initie une **collecte** chez l'expéditeur (l'argent
   part de son Mobile Money vers le wallet SebPay).
2. SebPay notifie le résultat via `POST /api/webhook` (signature HMAC-SHA256
   vérifiée avec `SEBPAY_SECRET_KEY`).
3. Si la collecte est `approved`, le serveur déclenche automatiquement un
   **payout** vers le destinataire.
4. Le front-end interroge `GET /api/transfer/:reference` toutes les 3 s
   jusqu'à un statut final (`completed` ou `failed`).

⚠️ Le stockage des transferts en cours est fait en mémoire (`Map`) : il est
perdu à chaque redémarrage du service. Pour de la production, remplacez-le
par une vraie base de données.
