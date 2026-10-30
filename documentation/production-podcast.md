# Offre de production de podcast

## Summary

La page `/offre-production-podcast/` présente l’accompagnement éditorial de
Damien, deux formats d’intervention et une session gratuite d’une heure.
Elle est accessible depuis les footers publics. Le contact ouvre un email :
le créneau est convenu par échange. La qualification repose sur les Golden
Journeys locaux et la recette de l’environnement livré ; les preuves de SHA,
CI et production sont rattachées à la PR.

## Synthèse

Le contenu reprend le brief validé : angle, préparation, coordination,
postproduction, publication, extraits et livrables sponsors selon le forfait.
Le client conserve la validation éditoriale. L’intervention ponctuelle commence
à 500 € HT ; une saison représente un budget de 10 000 à 20 000 € HT, avec
son périmètre défini au départ. Aucun résultat d’audience ni financement n’est
garanti. La session gratuite reste accessible sans qualification budgétaire.

L’accès « Besoin d'un producteur sur mon podcast ? » figure dans les footers
de l’accueil, du catalogue podcast et des épisodes, de la photographie, de
la page auteur et du laboratoire du geste. Le header commun et les trois
offres d’accueil conservent leurs destinations et leur contenu.

La page est rendue en Handlebars sans dépendance à PostgreSQL, au flux RSS,
au stockage ou au worker. Elle fonctionne sans JavaScript et ne persiste
aucune donnée. La variante sans slash redirige en 301 vers l’URL canonique,
en conservant les paramètres de partage. Le sitemap et les métadonnées
Open Graph/Twitter utilisent l’URL avec slash final.

Les références distinguent les responsabilités : entretien, réalisation et
montage de l’épisode OCCT de Charbon & Wafer ; animation du webinaire GEO
HIT / EuraCreative. Les photos existantes et leurs crédits sont conservés.

Les tests vérifient la découverte, l’offre, la demande de session, les liens,
le clavier, le rechargement et les largeurs 320/390/768/1440 pixels. Ils
n’envoient pas d’email et ne démontrent pas l’ouverture d’un logiciel de
messagerie sur le poste du visiteur. Les références externes restent des
liens : leur lecture ou leur hébergement ne sont pas simulés comme réussis.

## Annexes

### Commandes et preuves

Utiliser la version Node indiquée par `.node-version`, les dépendances du
lockfile et Chromium avec sa sandbox active.

```sh
npm ci
npm run build
DOTENV_CONFIG_PATH=/dev/null npm test
npm run test:e2e:production-podcast
npm run test:e2e
npm run test:e2e:photography
npm run test:e2e:podcast
npm run test:e2e:podcast-video
git diff --check
```

La suite de l’offre démarre par défaut un serveur loopback isolé. Le flux RSS
et les dépendances métier sont simulés ; aucune base réelle ni `.env` n’est
utilisé. `E2E_BROWSER_EXECUTABLE` permet de choisir le Chromium installé.
`PRODUCTION_PODCAST_E2E_OUTPUT` permet de placer les rapports et captures hors
Git ; la CI les joint à l’artefact `golden-journeys-validate`.

Les modes distants n’acceptent que les deux environnements du site :

```sh
PRODUCTION_PODCAST_E2E_TARGET=staging npm run test:e2e:production-podcast
PRODUCTION_PODCAST_E2E_TARGET=production npm run test:e2e:production-podcast
```

La recette distante consulte les pages sans écriture métier. Elle ne navigue
pas vers le podcast, dont les requêtes peuvent préparer des jobs ; ces parcours
sont exercés sur le serveur local isolé. Vérifier séparément le digest actif,
la santé normale, le rollout, la surveillance et la notification de livraison.

### Références et livraison

- [Décision de conception](adr/adr_0025_offre_production_podcast.md).
- [Circuit de staging et production](livraison-continue.md).
- [Rôles publiés de Damien](../content/damien-cavailles.md).
- [Épisode OCCT et crédits](https://podcasts.saletesincere.fr/@charbonwafer/episodes/charbon-les-petits-de-douai-qui-travaillent-avec-intel-et-amd).
- [Webinaire GEO](https://app.livestorm.co/p/bf678e23-b016-4c5e-994a-663b6cfa1e90).

Le retour arrière consiste à révoquer le changement applicatif par le circuit
de livraison normal. Aucune restauration de données ou migration n’est requise.
