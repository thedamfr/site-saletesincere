# Hébergement et déploiement — Saleté Sincère

État vérifié le **10 septembre 2026**. Ce guide concerne uniquement le site et
ses smartlinks ; il ne déploie ni Podcast Studio ni les autres applications du
cluster partagé.

## Cibles et responsabilités

| Cible | Rôle actuel | Mise à jour |
| --- | --- | --- |
| `saletesincere.fr` | Production publique, Cloudflare → OVH/MicroK8s | Image GHCR à activer explicitement sur OVH |
| `staging.saletesincere.fr` | Prévisualisation podcast séparée, sans base ni worker, avec `noindex` | Deployment `site-saletesincere-preview` |
| Application Clever `sale-wall` | Installation historique distincte, toujours active | Intégration GitHub encore déclenchée par `main` |

**Le staging sert une preview visuelle séparée au relevé du 10 septembre.**
Elle ne valide pas les écritures, la base ou le worker de production. Voir
[la description de son périmètre](#prévisualisation-observée-sur-staging).

Le namespace, le Service et le Deployment OVH se nomment `site-saletesincere` ;
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

Avant mutation, relever l’image courante pour le retour arrière et confirmer que
les pods existants sont prêts :

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

Le 10 septembre 2026, l’Ingress `site-saletesincere-staging` cible le Service
`site-saletesincere-preview`. Ce Deployment sert une recette visuelle du podcast
sur la même image de base que la production, avec le template et le CSS montés
depuis un ConfigMap. Il ne reçoit pas les secrets métier et désactive base,
worker, stockage et Sale-wall. Son `/health` retourne volontairement
`degraded/unavailable/stopped`. Ce montage temporaire ne constitue pas un
staging fonctionnel complet. Les manifests d’amorçage ne le reproduisent pas.

La production `saletesincere.fr` garde le Service `site-saletesincere` et son
application avec base et worker. Aucune modification de design n’est publiée
par la présente PR documentaire. La preview est un état déjà observé sur le
serveur ; ses changements applicatifs sont gérés séparément.

Le routage et les deux Deployments prêts ont été revérifiés vers 16:20 UTC.
Le quota du namespace reste entièrement utilisé pour les limites CPU (2/2)
et mémoire (2/2 GiB). La preview occupe ainsi la marge nécessaire au pod
supplémentaire du rollout de production, malgré la capacité libre de l’hôte.
La direction CD impose un précontrôle du quota et une stratégie de coexistence
avant activation : aucun arrêt implicite de staging ni relèvement automatique
du quota. Une mise à zéro temporaire de la preview doit être coordonnée et
autorisée ; elle n’est pas exécutée par cette revue documentaire.
