---
title: Migration OVH et retrait du Sale-wall
description: Déployer le site et les smartlinks sur le MicroK8s OVH partagé sans stockage objet
owner: @thedamfr
status: implemented
review_after: 2026-10-09
canonical_url: https://github.com/thedamfr/site-saletesincere/blob/main/documentation/adr/adr_0018_migration_ovh_et_retrait_sale_wall.md
tags: [adr, infrastructure, ovh, microk8s, podcast]
adr_number: 0018
date_created: 2026-09-09
impact: critical
---

# ADR 0018 — Migration OVH et retrait du Sale-wall

## Contexte

Le produit public conservé est le site `saletesincere.fr`, avec la landing, la
newsletter et les smartlinks `/podcast`. Le mur vocal et ses uploads sont
retirés. L'application Clever Cloud reste le service canonique tant que la
recette OVH et la bascule DNS de production ne sont pas explicitement validées.

Le serveur dédié OVH `game-prod-ovh-gra` exploite déjà un MicroK8s mono-nœud
partagé. Les conventions du Podcast Studio et de `gthf.fr` imposent un namespace,
des Secrets, des quotas, des politiques réseau et des volumes propres à chaque
application.

## Décision

- déployer dans le namespace `site-saletesincere` ;
- exposer d'abord `staging.saletesincere.fr`, avec HTTPS et `X-Robots-Tag:
  noindex, nofollow, noarchive` ;
- restaurer PostgreSQL localement sur OVH afin de préserver les liens d'épisode,
  les mesures OP3 et le fonctionnement de `pg-boss` ;
- ne copier aucun objet Cellar et ne créer aucun bucket de remplacement ;
- activer `DISABLE_STORAGE=true` : le worker continue de résoudre les plateformes
  mais n'essaie plus de générer ou supprimer des images OG dans S3 ;
- activer `DISABLE_WALL=true` : `/wall` redirige définitivement vers `/` et les
  anciennes écritures répondent `410 SALE_WALL_RETIRED` avant tout accès base ou
  stockage ;
- utiliser la jaquette RSS comme image sociale lorsque l'ancienne image OG S3
  n'est plus conservée ;
- exécuter l'image applicative en utilisateur non-root avec un filesystem racine
  en lecture seule ;
- conserver Clever Cloud et ses add-ons comme rollback jusqu'à une recette
  staging puis une autorisation distincte de bascule de `saletesincere.fr`.

## Données et secrets

Le rôle PostgreSQL managé de Clever Cloud n'autorise pas la lecture de tous les
catalogues nécessaires à `pg_dump`. Le schéma cible est donc créé par les
migrations versionnées du dépôt, puis seules les tables `episode_links` et
`op3_stats` sont transférées en CSV chiffré par SSH. Les tables du mur, les jobs
`pg-boss` et les références d'objets Cellar ne sont pas copiés.

Seules les variables Brevo, Spotify, YouTube et OP3 autorisées sont recopiées
dans un Secret Kubernetes. Les credentials Cellar et les variables propres à
Clever Cloud ne sont pas transférés.

Les colonnes `og_image_url`, `og_image_s3_key` et `generated_at` de la copie OVH
sont remises à `NULL`. Cette opération ne touche pas la base Clever utilisée
pour le rollback.

## Bascule et rollback

La recette commence avec un enregistrement A proxifié
`staging.saletesincere.fr` vers `141.94.98.109`. Le certificat est demandé par
DNS-01 avant la création de cet enregistrement.

La bascule canonique de `saletesincere.fr` et le déprovisionnement Clever ne font
pas partie de la recette staging. En cas d'échec, supprimer ou désactiver
l'enregistrement staging suffit ; le trafic canonique reste sur Clever Cloud.

## Vérifications attendues

- namespace, quotas, NetworkPolicies, PVC et pods prêts ;
- certificat `staging.saletesincere.fr` prêt ;
- `/health` en mode normal, PostgreSQL `read_write` et worker `ready` ;
- `/`, `/podcast` et une page `/podcast/:season/:episode` en `200` ;
- `/wall` en `301` vers `/` et API du mur en `410` ;
- en-tête staging `X-Robots-Tag` présent ;
- aucun Secret, dump ou objet Cellar copié dans le dépôt ou les logs.

## Résultat vérifié le 9 septembre 2026

Le staging OVH est opérationnel avec l'image
`site-saletesincere:staging-20260909-2`. Le certificat DNS-01 est prêt, le pod
applicatif et PostgreSQL sont `Ready`, `/health` expose le mode `normal`, une
base `read_write` et un worker `ready`.

La reprise contrôlée contient 29 lignes `episode_links` et 5 lignes `op3_stats`.
Les tables `posts` et `votes` sont vides, et aucune ligne ne conserve de
référence OG Cellar. Les routes `/`, `/podcast` et `/podcast/3/1` répondent en
200, `/wall` redirige en 301 vers `/` et l'ancienne API d'écriture répond en
410. La recette HTTPS forcée vers `141.94.98.109` confirme également la
redirection HTTP vers HTTPS et l'en-tête `X-Robots-Tag`.

L'enregistrement DNS `A` proxifié de `staging.saletesincere.fr` vers
`141.94.98.109` est propagé. La recette publique confirme le HTTPS, les routes
applicatives et le mode normal. Clever Cloud reste disponible pour le domaine
canonique et le rollback jusqu'à une décision de bascule distincte.

Après la recette staging, l'image applicative est publiée dans GHCR sous un tag
de commit immuable. Un workflow GitHub Actions reproduit cette publication lors
des mises à jour de `main`. Le certificat et l'Ingress de
`saletesincere.fr` peuvent être préparés sur OVH sans modifier son DNS ; ils ne
reçoivent donc aucun trafic canonique avant la bascule explicite.

Le certificat de production et l'Ingress ont été créés puis vérifiés directement
sur l'IP OVH. Ils servent une réponse HTTPS valide, sans en-tête `noindex`. La
prochaine opération de production est exclusivement la bascule DNS de
`saletesincere.fr` vers `141.94.98.109`.
