# Photographie — page publique et Golden Journeys

## Summary

`/photographie` présente l’offre et quatre reportages, avec un lien depuis
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

Les photographies sont groupées par référence : Forum PHP 2026, dotAI / dotJS
(un événement en deux parties), Hodéfi Awards et Masters de Feu. Les trois
originaux Forum PHP conservent leur composition : la conférence ouvre la page,
puis l’intervenante et les échanges sur le stand TYPO3 illustrent les prises de
parole et les rencontres. Les deux images se juxtaposent sur ordinateur et
s’empilent jusqu’à 600 pixels ; le portrait occupe 84 % de la colonne mobile.
La direction graphique ivoire/noir, les polices et les autres séries sont conservées.
La photo `0T9A2804.jpg`, envoyée deux fois, n’appartient pas aux Hodéfi Awards
et n’est pas retenue dans cette sélection.

Les Golden Journeys vérifient le chemin accueil → reportages → offre → contact,
les retours accueil/podcast, les interactions clavier, le chargement des photos,
les formats ordinateur/tablette/mobile, le cadrage complet des nouvelles images
et la consultation sans JavaScript.
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

Placer les JPEG sélectionnés dans un dossier privé, en conservant leurs noms.
Le [script de préparation](../scripts/prepare-photography.mjs) contient la
correspondance exacte avec les noms publics. FFmpeg avec l’encodeur WebP est
nécessaire seulement pour régénérer les images ; le build et le serveur utilisent
les dérivés versionnés.

```bash
# Sélection historique : 12 JPEG
npm run prepare:photography -- /chemin/prive/vers/les-jpeg

# Forum PHP 2026 : uniquement les trois originaux fournis
npm run prepare:photography -- /chemin/prive/vers/forum-php --forum-php
```

Le script produit des largeurs de 480 et 960 pixels, plus 1600 pixels pour
l’ouverture, ainsi qu’un JPEG social de 1200 × 800. Il conserve le cadrage,
retire les métadonnées et traite les images séquentiellement avec un thread.
Toutes les sources de la sélection sont vérifiées avant écriture. Le mode
`--forum-php` conserve les dérivés historiques et prépare sept WebP (26 à 184 ko)
et un JPEG social distinct de 255 ko. Aucun original n’est ajouté au dépôt.

| Original fourni | Usage | Dérivés WebP |
| --- | --- | --- |
| `DSC02973.jpg` (4096 × 2731) | Ouverture et partage social | `forum-php-2026-conference-{480,960,1600}.webp` |
| `DSC03026.jpg` (2731 × 4096) | Prises de parole | `forum-php-2026-intervenante-{480,960}.webp` |
| `DSC03055.jpg` (4096 × 2731) | Rencontres et partenaires | `forum-php-2026-rencontres-{480,960}.webp` |

Après remplacement d’une photo, vérifier son alternative, ses dimensions,
les dérivés et le rendu dans les Golden Journeys.

### Vérification des domaines déployés

```bash
npm run test:e2e:photography:staging
npm run test:e2e:photography:production
```

Ces modes ciblent exclusivement les domaines fixes de staging et de production.
Ils ne démarrent pas de serveur, ne lisent pas `.env`, n’envoient aucun email et
ne déclenchent aucune écriture métier. Ils contrôlent la santé, les identifiants
publics de livraison et les SHA-256 du CSS et des huit dérivés Forum PHP, puis
les trois Golden Journeys. La navigation vers le podcast est réservée au mode
local : à distance, seul le lien est vérifié, car `GET /podcast` peut mettre en
file un traitement d’épisode. Les requêtes navigateur vers ces routes et les
méthodes autres que GET/HEAD sont bloquées par les modes distants.
Staging doit également rester `noindex`. Les rapports
et captures sont conservés dans `test-results/photography-staging/` ou
`test-results/photography-production/`. `PHOTOGRAPHY_E2E_OUTPUT` peut choisir un
répertoire d’artefacts, et `E2E_BROWSER_CHANNEL` le navigateur installé en CI.
Le mode local reste isolé par défaut ; lui seul simule les dépendances indisponibles.

### Recette approuvée — 13 octobre 2026

Le propriétaire a validé les textes et cadrages sur staging, puis demandé le
merge et la mise en production. La surcouche de recette porte l’empreinte
`640c2de9e3d2482ef7dc965fec3d18d51a951db071c7be891163f11c1e10b3a8`.
L’intégration reprend ces dix fichiers (template, CSS, huit images) sur `main`
avec les liens existants, dont « À propos ». Les preuves au SHA candidat et les
contrôles après publication sont joints à la PR.

La recette temporaire monte deux ConfigMaps immuables dans le Deployment
`site-saletesincere-staging` : `photography-forum-2026-640c2de9e3d2` et sa variante
`-images`. Une livraison d’image seule ne retire pas ces montages. Après
publication de la même version sur staging, retirer uniquement la surcouche
avec le patch à préconditions conservé dans les preuves locales
`test-results/photography-staging/deployment/rollback-patch.json`, après relecture
de l’état actuel et sous le verrou du [runbook de livraison](livraison-continue.md).
Conserver les ConfigMaps et les données ; ne pas écraser une évolution concurrente.

### Décision

Voir [l’ADR 0022](adr/adr_0022_page_photographie.md).
