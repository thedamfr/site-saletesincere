# Photographie — page publique et Golden Journeys

## Summary

`/photographie` présente l’offre et trois reportages, avec un lien depuis
l’accueil. La page fonctionne sans JavaScript et sans base de données.
Les originaux fournis restent hors Git ; seuls les dérivés Web sont livrés.
Valider les Golden Journeys avec `npm run test:e2e:photography` avant publication.
La livraison sous 48 h, les packs, le QR code et le consentement sont des
descriptions du service : cette page n’héberge pas leur outil de gestion.

## Synthèse

La maquette approuvée est implémentée dans
[`photography.hbs`](../server/views/photography.hbs), avec une
[feuille de style dédiée](../public/photography.css). La route utilise le
limiteur de pages et les en-têtes de sécurité du serveur. Le lien de contact
ouvre un email à Damien, dès l’introduction avant les photographies, puis en fin
de page. Le bouton initial reste visible sans défilement sur mobile et ordinateur. La galerie complémentaire repose sur `details/summary` ;
son ouverture n’est pas persistée et aucun cookie n’est ajouté par cette page.

Les photographies sont groupées par référence : dotAI / dotJS est un événement
en deux parties, puis viennent les Hodéfi Awards et les Masters de Feu.
La photo `0T9A2804.jpg`, envoyée deux fois, n’appartient pas aux Hodéfi Awards
et n’est pas retenue dans cette sélection.

Les Golden Journeys vérifient le chemin accueil → reportages → offre → contact,
les retours accueil/podcast, les interactions clavier, le chargement des photos,
les formats ordinateur/tablette/mobile et la consultation sans JavaScript.
La suite démarre le vrai serveur Fastify sur `127.0.0.1` avec un port libre.
PostgreSQL est simulé indisponible, RSS vide, stockage et worker désactivés.
L’envoi d’email et la gestion externe des livraisons/consentements ne sont pas
exécutés. Les tests n’utilisent pas `.env` et n’écrivent aucune donnée métier.

Les résultats, captures et preuves de révision sont conservés dans
`test-results/photography/`, ignoré par Git. Le rapport distingue un checkout
modifié d’un SHA publié. Une PR ultérieure doit rattacher ses résultats à sa
révision candidate ; ces vérifications locales ne prouvent pas un déploiement.

Le checkout historique présentait un échec sur la date RSS S1E5. Le main actuel
utilise déjà des fixtures pour ces tests. Le contrôle public confirme le
15 octobre en UTC, soit le 16 en Europe/Paris : suivi séparé dans
[l’issue #47](https://github.com/thedamfr/site-saletesincere/issues/47).
La livraison photographie préserve la page auteur et ajoute sa route au sitemap.
La CI exécute les Golden Journeys auteur et photographie et conserve leurs artefacts.

## Annexes

### Commandes reproductibles

Utiliser Node.js 24 ou plus récent et les dépendances du dépôt.

```bash
npm run build
DOTENV_CONFIG_PATH=/dev/null node --test test/routes/photography.test.js
DOTENV_CONFIG_PATH=/dev/null npm test
npm run test:e2e:photography
git diff --check
```

La suite E2E exige Chromium installé pour la version Playwright du projet et
sa sandbox active. Sur `game-prod-ovh-gra`, le navigateur déjà autorisé peut
être sélectionné sans changer les protections système :

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome npm run test:e2e:photography
```

La suite ferme son navigateur et son serveur en fin d’exécution, y compris en
cas d’échec. Les polices externes suivent le fonctionnement existant du site.

### Préparer les photographies

Placer les 12 JPEG sélectionnés dans un dossier privé, en conservant leurs noms.
Le [script de préparation](../scripts/prepare-photography.mjs) contient la
correspondance exacte avec les noms publics. FFmpeg avec l’encodeur WebP est
nécessaire seulement pour régénérer les images ; le build et le serveur utilisent
les dérivés versionnés.

```bash
npm run prepare:photography -- /chemin/prive/vers/les-jpeg
```

Le script produit des largeurs de 480 et 960 pixels, plus 1600 pixels pour
l’ouverture, ainsi qu’un JPEG social de 1200 × 800. Il conserve le cadrage,
retire les métadonnées et traite les images séquentiellement avec un thread.
Après remplacement d’une photo, vérifier son alternative, ses dimensions,
les dérivés et le rendu dans les Golden Journeys.

### Décision

Voir [l’ADR 0022](adr/adr_0022_page_photographie.md).
