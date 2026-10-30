# Navigation commune

## Summary

Toutes les vues utilisent le même header : logo Saleté Sincère, Podcast,
À propos et Contact. Le composant reprend l’identité du podcast et reste
indépendant des styles du contenu. La correction est préparée localement ;
elle ne constitue pas une publication. Les Golden Journeys se lancent avec
`npm run test:e2e` après `npm run build`.

## Synthèse

Le partial [header.hbs](../server/views/partials/header.hbs) est partagé par
l’accueil, le podcast et ses épisodes, la page auteur, le laboratoire, les
quatre états newsletter et les vues historiques du mur, du manifeste et du
layout. Le manifeste reste une vue sans route publique : aucune route nouvelle
n’est créée. Les pages de travaux locaux distincts de cette révision ne sont
pas importées.

Les destinations sont toujours `/`, `/podcast`, `/damien-cavailles` et
`/#contact`. Le lien Podcast ouvre donc la page podcast aussi depuis l’accueil.
`aria-current` identifie la page auteur, la page podcast ou la rubrique podcast
sur un épisode. Le logo possède un nom accessible et les liens gardent un focus
visible et une hauteur minimale de 44 px.

La feuille [site-header.css](../public/site-header.css) fixe les couleurs,
la police Oswald, les largeurs et les espacements sans dépendre du thème de la
page. Son fond ivoire assure le contraste sur les anciennes pages sombres.
La navigation peut revenir à la ligne si nécessaire. Le contenu auteur conserve
ses marges, sa largeur, ses polices et ses liens ; seul le header sort de son
conteneur étroit. Oswald utilise le fournisseur Google Fonts déjà présent sur
le site, avec une police de repli si le service est indisponible.

Les tests de vues couvrent les onze templates et les états actifs. Les Golden
Journeys comparent la géométrie et les styles des headers à 320, 390, 768 et
1440 px, suivent leurs liens, vérifient le clavier, le rechargement et le rendu
sans JavaScript. Les parcours auteur existants, dont le téléchargement exact du
portrait, restent exécutés. La qualification locale simule le RSS et une base
indisponible ; elle ne valide pas les services externes ou la production.
Aucun envoi newsletter ni changement de droits ou de données n’est requis.

## Annexes

### Commandes reproductibles

Avec Node.js 24 ou plus récent et les dépendances verrouillées installées :

```sh
npm run build
DOTENV_CONFIG_PATH=/dev/null NODE_ENV=production npm test
npm run test:e2e
git diff --check
```

Les paramètres navigateur et l’emplacement des captures sont décrits dans le
[guide de la page auteur](page-auteur.md#vérification-reproductible).
Le rapport E2E distingue le SHA de base de l’empreinte des fichiers locaux
modifiés. Les captures et logs restent hors Git. Toute publication ultérieure
doit requalifier la révision candidate et suivre la procédure de livraison.
