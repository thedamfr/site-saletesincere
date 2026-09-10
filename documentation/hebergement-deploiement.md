# Hébergement et déploiement — Saleté Sincère

État vérifié le **10 septembre 2026**. Ce guide concerne uniquement le site et
ses smartlinks ; il ne déploie ni Podcast Studio ni les autres applications du
cluster partagé.

## Cibles et responsabilités

| Cible | Rôle actuel | Mise à jour |
| --- | --- | --- |
| `saletesincere.fr` | Production publique, Cloudflare → OVH/MicroK8s | Image GHCR à activer explicitement sur OVH |
| `staging.saletesincere.fr` | Staging encore partiel au 10 septembre 2026, 17:10 UTC : base signalée en lecture seule, worker arrêté | Deployment `site-saletesincere-preview` ; cible complète et isolée à réaliser |
| Application Clever `sale-wall` | Installation historique distincte, toujours active | Intégration GitHub encore déclenchée par `main` |

**Le propriétaire demande un staging complet et isolé pour présenter et tester
le travail.** La preview partielle observée ne satisfait pas cette exigence.
Voir [l'état daté](#prévisualisation-observée-sur-staging) et le
[contrat du staging complet](#staging-complet-exigé). Cette mise à jour documentaire
ne réalise pas sa duplication ni son déploiement.

Le namespace, le Service et le Deployment de production se nomment `site-saletesincere` ;
le conteneur applicatif est `web`. PostgreSQL et le worker `pg-boss` sont actifs.
`DISABLE_STORAGE=true` et `DISABLE_WALL=true` retirent le stockage objet et le mur
vocal de cette cible : `/wall` redirige vers `/`, les anciennes écritures du mur
répondent en 410.

Les [manifests OVH](../k8s/ovh/) décrivent l’infrastructure. Leurs tags d’image
d’amorçage ne suivent pas automatiquement les releases : **ne pas relancer
`kubectl apply -k k8s/ovh` pour une simple publication**, au risque de rétablir une
ancienne image ou de toucher aux ressources persistantes. Ne pas relancer les
scripts de transfert de secrets ou de restauration de base pour une release.

Le manifeste d’amorçage `k8s/ovh/ingress.yaml` pointe encore le staging vers
le Service de production : le réappliquer annulerait le routage de preview
observé. Le Job `k8s/ovh/migration-job.yaml`, à nom et image historiques,
n’est pas une étape générique de release. La
[direction de livraison continue](livraison-continue.md) prévoit de rendre
ces opérations rejouables sans écraser la version active ; elle n’est pas activée.


## Accès à vérifier avant intervention

Sur le poste de travail vérifié, l’alias SSH est `penthouse`, utilisateur `ubuntu`.
Le nom d’hôte Linux renvoyé est encore `game-prod-ovh-gra`. L’ancien nom Tailscale
`game-prod-ovh-gra.taild95457.ts.net` utilisé par les scripts de migration ne résout
plus depuis ce poste ; ne pas recopier cet accès sans le revérifier.

```bash
gh auth status
ssh -G penthouse
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes penthouse hostname
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere get deployments,pods,ingresses -o wide'
```

Conserver la vérification de clé SSH. Si l’accès ou la clé ne correspond plus,
faire confirmer la cible ; ne pas désactiver `StrictHostKeyChecking` et ne pas
changer les groupes ou droits du serveur pour contourner un refus.

Les opérations Kubernetes passent par `sudo -n /snap/bin/microk8s kubectl` sur ce
serveur. Toujours préciser le namespace ; ne pas modifier les autres applications.
Ne jamais lire ou afficher les valeurs des Secrets pendant une recette.

## Publier une version

### 1. Préparer et vérifier le code

Le déploiement doit être autorisé. Examiner l’état Git, récupérer le dernier
`origin/main` et intégrer les changements déjà publiés sans les écraser. Vérifier
explicitement le périmètre des modifications locales avant de les inclure.

Pour un changement applicatif :

```bash
npm test
npm run build
git diff --check
```

Si le logo change, exécuter aussi `npm run check:logo-animation` avec Chromium
installé, ou `LOGO_BROWSER_CHANNEL=chrome npm run check:logo-animation` avec Chrome.
Voir la [recette du logo](logo-animation.md).

Certains tests podcast historiques accèdent encore au RSS réel : un refus réseau
peut produire des redirections au lieu du HTML attendu. Le test mémoire OG est
également sensible aux allocations et au ramasse-miettes. Diagnostiquer et
consigner les échecs ; ne pas annoncer une suite verte lorsqu’elle ne l’est pas.
Ne jamais utiliser une base de production pour les tests.

Pour une modification exclusivement documentaire, contrôler le diff et les liens
locaux ; ne pas relancer le build applicatif par défaut.

### 2. Fusionner et attendre la publication de l’image

Ouvrir la PR en brouillon, terminer les vérifications, la passer en « Ready for review »,
puis la fusionner lorsque la publication est autorisée. Retenir le **SHA complet
du commit fusionné sur `main`**, pas celui d’un ancien commit de la branche.

Le [workflow `publish-image.yml`](../.github/workflows/publish-image.yml) construit
une image `linux/amd64` depuis le [Dockerfile](../Dockerfile), puis publie :

```text
ghcr.io/thedamfr/site-saletesincere:<SHA_COMPLET_DU_COMMIT_FUSIONNE>
```

```bash
gh run list --workflow publish-image.yml --branch main --limit 5 --json databaseId,headSha,status,conclusion,url
```

Attendre `completed` / `success` pour le SHA choisi. **Ce workflow ne contient
aucune étape de déploiement OVH.** En parallèle, Clever Cloud reçoit encore la
mise à jour via son intégration GitHub ; son succès ne remplace pas l’étape suivante.

### 3. Activer l’image sur OVH

Avant mutation, relever l’image courante pour le retour arrière, confirmer que
les pods existants sont prêts et vérifier la marge de capacité et de quota pour
le rollout. Le staging complet doit pouvoir rester disponible pendant les
publications de production ; son arrêt ne fait pas partie d'une release ordinaire.
Si la marge manque, bloquer l'activation avant mutation.

Contrôles de l'image et des pods :

```bash
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere get deployment site-saletesincere -o wide'
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere get pods'
```

Remplacer la valeur ci-dessous par le SHA complet vérifié à l’étape précédente :

```bash
release_commit='<SHA_COMPLET_VERIFIE>'
[[ "$release_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1
ssh penthouse "sudo -n /snap/bin/microk8s kubectl -n site-saletesincere set image deployment/site-saletesincere web=ghcr.io/thedamfr/site-saletesincere:${release_commit}"
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere rollout status deployment/site-saletesincere --timeout=60s'
```

Le Deployment utilise `RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0` : le pod
existant est conservé jusqu’à ce que le nouveau soit prêt. Un timeout de suivi
n’annule pas le déploiement ; inspecter l’état des pods et les événements du
namespace avant toute nouvelle action. Ne pas supprimer les pods ou volumes pour
forcer une réussite.

### 4. Faire la recette sur le vrai domaine

```bash
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere get deployment site-saletesincere -o wide'
ssh penthouse 'sudo -n /snap/bin/microk8s kubectl -n site-saletesincere get pods'
curl -fsS --max-time 20 https://saletesincere.fr/health
curl -sSI --max-time 20 https://saletesincere.fr/laboratoire-du-geste
curl -sSI --max-time 20 https://saletesincere.fr/__logo-lab
curl -sSI --max-time 20 https://staging.saletesincere.fr/laboratoire-du-geste
```

Vérifier :

- le Deployment utilise exactement l’image choisie, avec un pod prêt ;
- `/health` répond en 200, `mode: normal`, base `read_write`, worker `ready` ;
- la home, `/podcast`, un épisode réel et les routes modifiées répondent comme
  prévu, sans envoyer de formulaire ni créer de données pour les tester ;
- le laboratoire public répond en 200 sans `noindex`, l’ancienne adresse en 301
  vers `/laboratoire-du-geste`, le staging conserve son en-tête `noindex` ;
- les nouveaux assets sont réellement servis et le navigateur affiche la version
  attendue, pas seulement le serveur local.

Le CSS global est recompilé dans le conteneur. Le contexte Docker exclut notamment
les tests et la documentation : certaines classes Tailwind détectées localement
peuvent donc manquer du build conteneur sans affecter les vues réelles. En cas
d’écart de hash, comparer au fichier construit dans le pod et inspecter le rendu,
plutôt que conclure automatiquement à un cache périmé.

### 5. Retour arrière applicatif

Si nécessaire et dans le cadre de la publication autorisée, réactiver sur le même
Deployment le tag immuable relevé avant l’intervention avec la commande `set image`,
puis attendre le rollout et refaire la recette. Vérifier auparavant que cette
version est compatible avec le schéma actuel. Ne pas restaurer une base, supprimer
un volume ou inverser une migration avec cette procédure.

Un retour de trafic vers Clever Cloud est **une opération distincte** nécessitant
validation du routage et des données : les bases OVH et Clever ne sont pas
supposées synchronisées. Ne pas modifier le DNS ou arrêter Clever au cours d’une
simple publication applicative.

## Diagnostic : Clever à jour, domaine public inchangé

Comparer la route sur `saletesincere.fr` et sur l’URL historique
`https://app-cb755f4a-25da-4a25-b40c-c395f5086569.cleverapps.io`, puis contrôler
l’image du Deployment OVH. Le cas a été observé lors de la publication du laboratoire :
Clever servait la nouvelle page, tandis qu’OVH utilisait encore l’ancienne image.
Ce n’était pas un cache HTML à purger.

L’origine OVH vérifiée est `141.94.98.109`. Un contrôle ponctuel avec
`curl --resolve saletesincere.fr:443:141.94.98.109` conserve le nom TLS et permet
de distinguer l’origine du proxy, sans changer le DNS. Les commandes
`clever status --alias sale-wall` et `clever activity --alias sale-wall` restent
utiles pour l’installation historique uniquement ; ne pas afficher `clever env`.

## Recette historique — PR 29

Le 10 septembre 2026, la [PR 29](https://github.com/thedamfr/site-saletesincere/pull/29)
a publié le commit `d6ed6ff9c0438b05cc8df74a4e3b2f60b79b4d15`. L’image GHCR a été
construite avec succès puis activée sur OVH ; Clever a reçu le même commit.
Le tag OVH précédent était `484da98f5e9a5e2a949a04e821ee95188e7d0c6b`.

Recette : rollout réussi, pod applicatif prêt sans redémarrage, PostgreSQL prêt,
santé `normal/read_write/ready`, routes publiques et redirections vérifiées,
laboratoire contrôlé dans le navigateur. Aucun DNS, Secret, volume ou autre
service du cluster n’a été modifié. Vérifications avant publication : build,
14 tests ciblés et 101 étapes visuelles réussis ; suite complète avec réseau :
152 réussites, 12 tests ignorés, un échec mémoire OG non modifié (59,46 Mo après
warmup). Ce suivi reste distinct de la recette HTTP de production.

Historique et décision : [ADR 0018](adr/adr_0018_migration_ovh_et_retrait_sale_wall.md),
[ancienne installation Clever Cloud](adr/adr_0003_deployment_production_clevercloud.md).


## Audit de livraison — 10 septembre 2026

Au relevé vers 15:54 UTC, le `main` distant et le tag du Deployment de
production correspondent à `f03a1be99bd48ae839f08e9cf310cf87aa1b99f3` (PR 30).
La [publication GHCR](https://github.com/thedamfr/site-saletesincere/actions/runs/34466109980)
a réussi ; son workflow ne déploie pas OVH. La concordance ponctuelle des SHA
ne prouve pas une livraison automatique.

Le pod de production est prêt. `/health` confirme `mode=normal`,
`database.state=read_write`, `episodeWorker.state=ready`. Ce relevé ne
réexécute pas toute la recette PR 30. La direction demandée est
[GitHub Actions → GHCR → déploiement OVH vérifié](livraison-continue.md),
avec sélection des builds et activation après CI verte sur `main`.
Elle reste à implémenter ; la procédure manuelle ci-dessus décrit l’existant.

## Prévisualisation observée sur staging

Au relevé initial du 10 septembre 2026 vers 15:54 UTC, l'Ingress
`site-saletesincere-staging` ciblait le Service `site-saletesincere-preview`.
Ce Deployment présentait le podcast sur l'image de base de production, avec
le template et le CSS montés depuis un ConfigMap, sans secrets métier ni base
configurée et avec le worker, le stockage et le Sale-wall désactivés. Son état
`degraded/unavailable/stopped` décrivait les limites de cette preview ; il ne
constituait pas un critère de réussite pour un staging fonctionnel complet.
Les manifests d'amorçage ne reproduisent pas ce montage.

**Au contrôle actualisé vers 17:10 UTC, le staging reste incomplet.** `/health`
retourne `mode=degraded`, `database.state=read_only` et
`episodeWorker.state=stopped`. La base n'est donc plus à décrire comme simplement
absente sur la foi du relevé précédent. Le Deployment preview observé contient
le conteneur `web` et les volumes `design` et `tmp` ; aucun PostgreSQL ni PVC
supplémentaire dédié au staging n'a été constaté dans ce namespace. Cela ne
démontre ni une base staging inscriptible et isolée, ni un worker fonctionnel.
Aucune recette complète de ce staging n'est acquise.

La production `saletesincere.fr` garde le Service `site-saletesincere` et son
application avec base et worker. Aucune modification de design n’est publiée
par la présente PR documentaire. La preview est un état déjà observé sur le
serveur ; ses changements applicatifs sont gérés séparément.

Le routage et les deux Deployments prêts ont été revérifiés vers 16:20 UTC.
Le quota du namespace reste entièrement utilisé pour les limites CPU (2/2)
et mémoire (2/2 GiB). La preview occupe ainsi la marge nécessaire au pod
supplémentaire du rollout de production, malgré la capacité libre de l’hôte.
Ce relevé de quota est daté ; il doit être renouvelé avant tout déploiement.
La cible exige de dimensionner et versionner la coexistence du staging complet,
de la production et des pods supplémentaires de leurs rollouts. Arrêter le
staging à chaque publication de production n'est pas une solution acceptable.
Un manque de capacité bloque la release avant mutation ; les ajustements de
quota et de ressources doivent être explicitement préparés et vérifiés.


## Staging complet exigé

Le staging doit reproduire l'application et les dépendances nécessaires aux
fonctions actives en production ainsi qu'aux changements présentés. Un rendu
HTML, un HTTP 200 ou un fonctionnement dégradé ne suffisent pas. La cible est
une copie fonctionnelle isolée, avec ses versions et sa configuration traçables ;
sa mise en place reste à réaliser.

| Élément | Exigence pour le staging |
| --- | --- |
| Application | Backend Fastify, vues, routes et assets du commit à présenter, déployés par image identifiée par digest |
| PostgreSQL | Instance, base, rôle, Secret et PVC dédiés au staging ; aucun droit d'écriture vers la base de production |
| Worker | `pg-boss` actif sur la base staging, avec ses propres queues, jobs et caches ; aucun consommateur des queues de production |
| Configuration | ConfigMaps, Secrets, URLs de base et références de services propres au staging, sans réutilisation implicite des identifiants de production |
| Stockage | Volumes, caches et médias propres ; bucket et identifiants staging si une fonction utilise le stockage objet, sans écriture dans les objets de production |
| Services externes | Comptes ou endpoints de test pour e-mails, webhooks, statistiques et publications ; aucun destinataire réel, compteur OP3 ou autre effet de production déclenché par les essais |
| Réseau | Namespace et routage staging identifiés, accès et politiques réseau isolés, TLS et `noindex` conservés ; `noindex` ne remplace pas un contrôle d'accès |

Le Sale-wall et S3/Cellar sont désactivés sur la production actuelle : un staging
complet ne les réactive pas sans demande fonctionnelle. Il doit reproduire les
fonctions effectivement attendues, avec un stockage indépendant pour celles qui
en ont besoin. D'éventuels adaptateurs sandbox concernent les services externes,
pas le remplacement de PostgreSQL ou du worker par une simulation.

Préparer les données avec des jeux de test représentatifs ou un clone contrôlé
dont la source, la destination, le périmètre et la date sont connus. Anonymiser
les données personnelles lorsque nécessaire et exclure les secrets de production.
Avant le démarrage des workers sur un clone, neutraliser les jobs hérités et
réorienter les destinations externes vers le staging ou les services de test.
La procédure ne doit ni écraser des données de production ni reconnecter le
staging à leur stockage. Aucune copie de données n'est exécutée par cette PR.

La recette du staging doit vérifier :

- Le digest attendu, les pods, la base, les volumes et le worker propres à cet
  environnement ; `/health` doit annoncer `mode=normal`,
  `database.state=read_write` et `episodeWorker.state=ready`, comme en production.
- Les parcours de la home et du podcast, les pages épisode, les smartlinks,
  les liens résolus et les fonctions métier modifiées, avec leurs données.
- Les écritures et migrations prévues sur les données staging, la consommation
  effective d'un job par le worker et les caches ou artefacts qu'il produit ;
  les parcours newsletter utilisent uniquement les comptes et destinataires de test.
- L'absence d'accès en écriture aux bases, buckets, queues et services de production,
  ainsi que l'absence d'effets externes de production pendant ces essais.
- Le maintien du staging et de la production pendant leurs mises à jour, avec
  une marge de capacité et de quota suffisante pour les stratégies de rollout.

Les essais dégradés restent utiles comme tests de résilience séparés ; leur
succès ne remplace pas cette recette en mode normal. Publier l'URL staging,
le commit, le digest et les résultats permet au propriétaire de tester une
version complète avant sa présentation comme prête. La validation staging
ne dispense pas de la recette du domaine de production après publication.
