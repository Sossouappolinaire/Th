# API FeexPay — résumé pour ce projet

Ce fichier résume la partie de l'API FeexPay v2 réellement utilisée par
`feexpayService.js` / `feexpayCatalog.js`. Pour la documentation complète
(dashboard, FeexLink, SDKs, FAQ...), voir `Documentation-API-FeexPay-v2.pdf`
fourni avec le projet, ou https://docs.feexpay.me.

## Authentification

Une seule clé API, envoyée en en-tête sur chaque requête :

```
Authorization: Bearer fp_live_votre_cle_api
```

`FEEXPAY_API_KEY` dans `.env`. Pas de couple clé publique/secrète comme chez
l'ancien fournisseur.

## URL de base

```
https://api-v2.feexpay.me/api
```

## Payin (collecte chez l'expéditeur)

`POST /transactions/public/requesttopay/{reseau}` — un chemin fixe par
réseau (voir `feexpayCatalog.js` pour la correspondance complète, ex.
`mtn`, `moov_ci`, `wave_sn`, `orange_bf`...).

Corps commun : `shop`, `amount`, `phoneNumber` (obligatoires) ; `first_name`,
`last_name`, `description`, `callback_info` (optionnels).

Réseaux **à redirection** (Orange, Wave, Moov Côte d'Ivoire, Orange/Wave/Free
Sénégal, Wave Burkina Faso) : ajoutent `return_url`/`cancel_url` et la
réponse contient un `payment_url` à ouvrir dans un nouvel onglet.

Orange Burkina Faso exige un `otp` (généré par l'abonné via
`#144*4*6*montant#` avant l'appel).

Limites : montant entre 100 et 2 000 000 XOF.

## Statut d'un payin

```
GET /transactions/public/single/status/{reference}
```

Renvoie `status`: `PENDING` | `SUCCESSFUL` | `FAILED`.

## Payout (décaissement vers le destinataire)

`POST /payouts/public/{route}` — certaines routes sont mutualisées entre
plusieurs réseaux via le champ `network` (Bénin : `transfer/global` avec
`network: MTN|MOOV` ; Togo : `togo` avec `network: TOGOCOM TG|MOOV TG`),
d'autres sont dédiées à un seul réseau (Côte d'Ivoire, Sénégal, Burkina
Faso, Mali, Congo Brazzaville, Celtiis Bénin).

Corps commun : `shop`, `amount`, `phoneNumber`, `motif` (obligatoires —
`motif` : 30 caractères maximum, sans caractères spéciaux) ; `email`,
`callback_info` (optionnels).

⚠️ Sur la V2, le lancement d'un payout renvoie toujours `PENDING` : le
statut final s'obtient uniquement via l'API Statut ci-dessous.

## Statut d'un payout

```
GET /payouts/status/public/{reference}
```

## Webhooks

FeexPay envoie un `POST` avec un payload JSON (`reference`, `status`,
`amount`, `callback_info`, `phoneNumber`, `reseau`...) vers **une seule URL**
configurée dans le dashboard (menu Webhook) — pas de `callback_url` par
requête.

⚠️ **Aucune signature n'accompagne ces webhooks** (pas d'équivalent du HMAC
de l'ancien fournisseur). Ce projet ne fait donc jamais confiance directement
au contenu d'un webhook : il l'utilise uniquement comme déclencheur pour
revérifier le statut réel via un appel authentifié aux endpoints de statut
ci-dessus (voir `verifyIncomingNotification`/`extractWebhookReference` dans
`feexpayService.js` et le webhook `/api/webhook/feexpay` de `server.js`).

## Codes d'erreur utiles

Format standard : `{ "statusCode": 404, "message": "...", "code": "..." }`
(`message` peut être un tableau de strings pour les erreurs de validation).

Quelques codes rencontrés : `ERR_INVALID_API_KEY`, `ERR_SHOP_NOT_FOUND`,
`ERR_INSUFFICIENT_BALANCE`, `ERR_INVALID_PHONE_NUMBER`,
`ERR_INVALID_AMOUNT`, `ERR_NETWORK_UNAVAILABLE`, `ERR_TRANSACTION_FAILED`,
`ERR_DUPLICATE_TRANSACTION`, `ERR_IP_NOT_AUTHORIZED`,
`ERR_PAYOUT_NOT_ENABLED`.
