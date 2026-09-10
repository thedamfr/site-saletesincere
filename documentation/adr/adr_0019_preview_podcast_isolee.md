# ADR 0019 — Prévisualisation isolée du podcast

Date : 2026-09-10. Statut : accepté pour la proposition demandée.

Le domaine staging partageait le Service et la base de production. Pour montrer
la refonte du podcast avant sa validation, son Ingress cible désormais un Service
et un Deployment dédiés, dans le namespace `site-saletesincere`.

La prévisualisation utilise l'image de production par tag immuable et monte le
template podcast et le CSS compilé depuis un ConfigMap identifié par leur hash.
Initialement sans accès base, elle consulte désormais les caches PostgreSQL de
production après autorisation explicite du propriétaire. Le Secret existant est
référencé par `DATABASE_URL`, sans modification de son contenu. `PGOPTIONS=-c
default_transaction_read_only=on` configure les sessions en lecture seule. Ce
réglage de session ne remplace pas un rôle PostgreSQL dédié à la lecture.
Le worker, le stockage et le mur restent désactivés. Les liens résolus, les badges
vidéo et les statistiques OP3 font désormais partie de la recette visuelle.

Le DNS et le certificat existants sont conservés, ainsi que le `noindex` staging.
La production conserve son Deployment et son Service. Ce montage est une recette
temporaire ; une publication définitive utilisera une nouvelle image applicative.

Retour arrière : remettre le backend de l'Ingress `site-saletesincere-staging`
sur le Service `site-saletesincere`. Aucune restauration de données nécessaire.
Les ressources de prévisualisation ne sont pas incluses dans le kustomization
d'amorçage ; leur suppression éventuelle exige une demande distincte.

Direction visuelle corrigée à la demande du propriétaire : reprendre le carton
podcast de la landing et sa jaquette illustrée officielle, selon
[l’ADR 0017](adr_0017_identite_claire_et_territoire_charbon_wafer.md).
La photographie kintsugi de la première proposition est abandonnée.
