# ADR 0024 — Intentions durables et reprise après coupure

Date : 2026-10-11. Statut : implémenté dans le candidat de l’issue 56 ;
qualifié sur VM dédiée, non livré en production.
Preuves : [qualification du candidat](../qualification-issue-56.md).

## Summary

Une intention acceptée doit survivre au processus qui l’a reçue. PostgreSQL garde
les jobs podcast et le journal newsletter ; le catalogue RSS permet de reconstruire
les résolutions manquantes. La reprise automatique vise **300 secondes après le
retour des dépendances**, y compris après épuisement des premiers retries. Un effet
Brevo ambigu reste explicitement incertain, sans nouvel envoi aveugle. Cette
décision ne vaut ni preuve de qualification ni autorisation de déploiement.

## Synthèse

Les queues `resolve-episode` et `op3-stats-refresh` restent dans `pg-boss`. Une
écriture SQL ratée fait échouer le traitement ; elle ne peut plus produire un job
terminé sans résultat durable. L’acceptation d’une résolution exige un identifiant
de job ou la confirmation d’un job durable déjà en attente. Le buffer mémoire
sert seulement d’optimisation. Toutes les 30 secondes, lorsque la base est
inscriptible et le worker prêt, un réconciliateur relit le catalogue RSS complet,
y compris les bandes-annonces et leur `itemGuid`, sans attendre une visite.

Chaque job expire après 60 secondes, avec trois retries initiaux espacés de
5 secondes, sans backoff. Une tentative réseau est annulable et bornée à
45 secondes. Une indisponibilité fournisseur est une erreur ; un épisode
réellement absent peut produire un résultat partiel valide. Les anciennes tâches
non terminales reçoivent également les limites courantes, sans supprimer leurs
identifiants, charges utiles ou compteurs.

Le pool applicatif annule les requêtes côté PostgreSQL après 1,5 seconde, avant
le timeout client de 2 secondes. Une connexion fautive est retirée du pool,
y compris lorsqu’un rollback échoue. Les arrêts et reconnexions sont sérialisés.

Une panne longue ne doit pas immobiliser un échec terminal. Avant même de relire
le RSS, le réconciliateur réarme au plus 100 jobs échoués depuis au moins
60 secondes. Il conserve le même identifiant, le dernier diagnostic et le
compteur d’essais ; il accorde une tentative supplémentaire. Un job concurrent ou
plus récent du même épisode exclut l’ancien ; la queue OP3 est traitée comme une
seule intention logique. Les verrous SQL empêchent deux réconciliateurs de
réarmer la même ligne simultanément.

Pour la newsletter, `newsletter_requests` déduplique l’intention par adresse et
liste. `newsletter_attempts` conserve une trace ajoutée avant chaque mutation
distante, dans la même transaction que la prise en charge. Une interruption après
ce point passe par une consultation Brevo : l’appartenance à la liste confirme
l’effet ; une absence ne prouve pas qu’aucun effet n’a eu lieu. L’état reste alors
`uncertain`. Seul un refus explicite attestant l’absence d’effet permet de
réessayer la mutation. Une base indisponible interdit son acceptation.
Un retour arrière doit conserver ce nouveau handler, ou bloquer
`POST /newsletter/subscribe` avant de réactiver l’ancien code. Garder les tables
seules n’empêche pas l’ancien handler de répéter un effet distant.

L’arrêt HTTP lance les fermetures en parallèle. Les tentatives sont annulées
avant 8 secondes, `pg-boss` dispose de 10 secondes et son manager de 12 secondes,
pour tenir dans les deux budgets déclarés : 30 secondes sans `preStop` dans le
manifest OVH ; environ 15 secondes après le `preStop` de 15 secondes dans celui
du staging, dont le délai total reste également de 30 secondes.

## Annexes

### Couplage assumé et retour arrière

Les API `createQueue` et `updateQueue` ne corrigent pas les métadonnées déjà
copiées dans les jobs. Les deux mises à jour SQL ciblées de
[`recoveryPolicy.js`](../../server/queues/recoveryPolicy.js) dépendent donc du
schéma de **pg-boss 11.1.1**, version du lockfile. Toute montée de version exige
une revue de ce contrat et une qualification PostgreSQL réelle des anciens jobs,
de leur expiration et du réarmement. Aucun job n’est supprimé ni remis à zéro.
Un retour au code précédent arrête le réarmement périodique ; les limites et
compteurs déjà persistés restent en base.

Pour la newsletter, conserver `newsletter_requests`, `newsletter_attempts` et
leur historique est nécessaire mais insuffisant : l’ancien handler ignore ce
journal et peut renvoyer une mutation dont le résultat était incertain. Le
retour arrière exige donc soit de conserver le nouveau handler, soit de bloquer
`POST /newsletter/subscribe` **avant** de remettre l’ancien code en service, puis
de garder cette route bloquée jusqu’au rétablissement du traitement durable.
Aucune suppression du journal ni remise à zéro des états ne fait partie du
retour arrière.

Les budgets d’arrêt ci-dessus proviennent des manifests
[OVH](../../k8s/ovh/app.yaml) et [staging](../../k8s/staging/app.yaml).
Une qualification sans `preStop` ne démontre pas à elle seule le délai réduit
du staging ; les limites applicatives de 8, 10 et 12 secondes sont conservées
pour les deux cibles.

### Limites et preuves attendues

La garantie couvre la cible OVH avec stockage S3 et Sale-wall désactivés ; elle
ne qualifie pas leurs effets historiques. Les lectures externes peuvent être
répétées. L’incertitude d’une mutation distante ne permet pas de promettre une
exécution exactement une fois. Un résultat partiel valide de même révision RSS
n’est pas recalculé indéfiniment. Le budget de 300 secondes doit être mesuré pour
la charge qualifiée, et ne constitue pas une garantie de débit pour un catalogue
ou un arriéré arbitrairement grand.

La commande versionnée `npm run test:e2e:resilience` doit établir les Golden
Journeys sur la VM dédiée : consultation, droits, persistance, pannes longues,
shutdown, crash répété et redémarrage avec `/tmp` vide. Les résultats doivent
relier SHA de base, diff candidat et image immuable aux délais HTTP, worker et
résultat métier. Des tests unitaires seuls ne démontrent pas cette reprise.

Références : [issue 56](https://github.com/thedamfr/site-saletesincere/issues/56),
[hébergement](../hebergement-deploiement.md),
[mode dégradé](../prd_mode_degrade_sans_bdd.md).
