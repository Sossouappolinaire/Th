# Transfert MTN ↔ Moov (Bénin) via SebPay

Application Node.js/Express qui encaisse chez l'expéditeur (collecte) puis
décaisse vers le destinataire (payout) via l'API SebPay.

## Déploiement sur Render.com

Toute la configuration (clés SebPay, port, URL publique, mot de passe admin)
est écrite en dur dans `config.js` — aucune variable d'environnement n'est
nécessaire.

1. Ouvrez `config.js` et remplacez `publicBaseUrl` par l'URL réelle de votre
   service une fois créé (ex. `https://votre-service.onrender.com`) : SebPay
   en a besoin pour vous notifier via webhook. Tant que cette valeur reste le
   placeholder `https://VOTRE-SERVICE.onrender.com`, les paiements resteront
   bloqués en attente faute de notification reçue.
2. Poussez ce dossier sur un dépôt GitHub/GitLab.
3. Sur Render : **New +** → **Web Service** → connectez le dépôt.
4. Paramètres :
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
5. Déployez.

⚠️ Render attribue dynamiquement le port d'écoute via la variable `PORT` et
route le trafic vers ce port précis. `config.js` écoute maintenant sur un
port fixe (`10000`) plutôt que sur `process.env.PORT` : si Render assigne un
port différent de 10000 à votre service, le déploiement échouera. Si ce cas
se présente, il faudra soit fixer le port de Render sur 10000 dans les
paramètres du service (si l'option existe), soit remettre
`port: process.env.PORT || 10000` dans `config.js`.

## Test en local

```bash
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

Les transferts sont persistés dans `data/transfers.json` et rechargés
automatiquement au démarrage du serveur — un redémarrage/crash du process ne
fait donc plus perdre la trace des paiements en cours. Une réconciliation
automatique tourne aussi toutes les 2 minutes (voir plus bas), en plus du
bouton manuel dans le panneau ADMIN.

⚠️ Cette persistance est un fichier local : elle survit à un simple
redémarrage, mais **pas à un redéploiement Render** qui recrée le disque
(sauf si vous ajoutez un [Render Disk](https://render.com/docs/disks)). Pour
une garantie totale même après redéploiement, remplacez ce fichier JSON par
une vraie base de données (Postgres, etc.).

⚠️ L'API SebPay n'offre aucune route pour lister globalement "tous les
paiements en attente" du compte — uniquement `GET /collections/{ref}` et
`GET /payouts/{ref}`, qui exigent de connaître la référence à l'avance.
L'application doit donc absolument garder elle-même la liste des références
à surveiller ; elle ne peut pas la retrouver auprès de SebPay si elle la
perd.

## Réconciliation automatique

En plus des actions manuelles du panneau ADMIN, le serveur revérifie tout
seul chaque transfert encore `pending` auprès de SebPay :
- une première fois 5 secondes après le démarrage (utile juste après un
  redémarrage, pour rattraper ce qui s'est passé pendant l'arrêt) ;
- puis toutes les 2 minutes en continu.

Cela rattrape automatiquement les webhooks manqués sans intervention
manuelle. Le bouton "Corriger tout" de l'admin reste disponible pour forcer
une vérification immédiate.

## Panneau ADMIN (paiements bloqués en attente)

Un webhook manqué (SebPay n'a pas pu notifier le serveur, service redémarré
entre-temps, etc.) peut laisser un transfert bloqué : l'argent a été collecté
chez l'expéditeur mais jamais envoyé au destinataire. Le panneau ADMIN sert à
détecter et corriger ces cas.

- Accès : bouton **ADMIN** en haut de la page d'envoi, ou directement
  `/admin.html`. Protégé par un mot de passe écrit en dur dans `config.js`
  (`arrow2025` par défaut — changez `admin.token` dans `config.js` pour le
  personnaliser). Un mauvais mot de passe affiche « Accès réservé aux
  administrateurs. ».
- **Corriger tout** : réinterroge SebPay pour chaque paiement en attente et
  rattrape automatiquement les webhooks manqués (déclenche le décaissement si
  la collecte était en fait approuvée, marque le transfert « terminé » si le
  décaissement était en fait approuvé, etc.).
- **Traiter un paiement par référence** : on saisit la référence, elle est
  vérifiée auprès de SebPay. Si elle est toujours en attente, deux choix :
  - **Annuler** → renvoie l'argent au numéro de l'expéditeur (remboursement).
  - **Réessayer** → relance l'envoi vers le destinataire directement, sans
    redemander le montant (déjà connu depuis la tentative d'origine).
- La même liste et les mêmes actions (Vérifier / Annuler / Réessayer) sont
  aussi disponibles ligne par ligne dans le tableau des paiements en attente.

Nouvelles routes API (toutes protégées, en-tête `X-Admin-Token`) :

| Route | Effet |
|---|---|
| `GET /api/admin/pending` | Liste tous les paiements en attente |
| `POST /api/admin/fix-pending` | Réconcilie tous les paiements en attente avec SebPay |
| `POST /api/admin/transfer/:ref/check` | Réconcilie un paiement (par référence) |
| `POST /api/admin/transfer/:ref/cancel` | Renvoie l'argent au numéro émetteur |
| `POST /api/admin/transfer/:ref/retry` | Relance l'envoi au destinataire (montant déjà connu) |

⚠️ Ce mécanisme dépend du stockage en mémoire : après un redémarrage du
service, les transferts en cours à ce moment-là ne sont plus visibles dans
le panneau ADMIN (voir l'avertissement ci-dessus sur la persistance).
