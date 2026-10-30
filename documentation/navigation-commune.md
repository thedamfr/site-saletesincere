# Navigation commune

## Summary

Toutes les vues utilisent un header et un footer communs. Logo, navigation,
contact et mentions restent cohérents d’une page à l’autre, sur mobile comme
sur ordinateur. Les crédits spécifiques restent dans le contenu concerné.
La publication suit le circuit de livraison du dépôt. Les Golden Journeys se lancent avec
`npm run test:e2e` après `npm run build`.

## Synthèse

Le partial [header.hbs](../server/views/partials/header.hbs) est partagé par
l’accueil, la photographie, le podcast et ses épisodes, l’offre de production de
podcast, la page auteur, le laboratoire, les
quatre états newsletter et les vues historiques du mur, du manifeste et du
layout. Le manifeste reste une vue sans route publique : aucune route nouvelle
n’est créée.

Les destinations sont toujours `/`, `/photographie`, `/podcast`, `/damien-cavailles` et
`/#contact`. Le lien Podcast ouvre donc la page podcast aussi depuis l’accueil.
`aria-current` identifie les pages photographie et auteur, la page podcast ou la rubrique podcast
sur un épisode. Le logo possède un nom accessible et les liens gardent un focus
visible et une hauteur minimale de 44 px.

La feuille [site-header.css](../public/site-header.css) fixe les couleurs,
la police Oswald, les largeurs et les espacements sans dépendre du thème de la
page. Son fond ivoire assure le contraste sur les anciennes pages sombres.
La navigation peut revenir à la ligne si nécessaire. Le contenu auteur conserve
ses marges, sa largeur, ses polices et ses liens ; seul le header sort de son
conteneur étroit. Oswald utilise le fournisseur Google Fonts déjà présent sur
le site, avec une police de repli si le service est indisponible.

Le partial [footer.hbs](../server/views/partials/footer.hbs) utilise la même
largeur que le header, avec sa propre feuille [site-footer.css](../public/site-footer.css).
Il est placé après le contenu principal, hors des conteneurs étroits. Il réunit
le logo lié à l’accueil, l’identité, l’email, les liens Accueil, Photographie,
Podcast, À propos, Laboratoire du geste, Contact et l’offre de production de
podcast. Le crédit du logo et les mentions légales existantes sont conservés.
Le footer ne dépend ni de JavaScript, ni de données persistées, ni d’une API.
Les marqueurs `email_off` préservent le lien email sous Cloudflare sans JavaScript.

Les crédits NCLS.tv et Charlotte Coppens restent sur l’accueil et l’offre de
production, avant le footer ; ils ne sont pas attribués aux reportages photo.
La signature Charbon & Wafer reste dans la page podcast. Les anciennes règles
CSS propres aux six variantes de footer sont retirées.

Les tests de vues couvrent les treize templates et les états actifs. Les Golden
Journeys comparent la géométrie et les styles des headers à 320, 390, 768 et
1440 px et des footers sur huit pages publiques, suivent leurs liens, vérifient
le clavier, le rechargement et le rendu sans JavaScript. La géométrie du footer
est comparée relativement à son début, car la longueur des pages varie.
Les parcours auteur existants, dont le téléchargement exact du
portrait, restent exécutés. La qualification locale simule le RSS et une base
indisponible ; elle ne valide pas les services externes ou la production.
Aucun envoi newsletter ni changement de droits ou de données n’est requis.

## Annexes

### Commandes reproductibles

Avec Node.js 24.22.1 (version du dépôt) et les dépendances verrouillées installées :

```sh
npm run build
DOTENV_CONFIG_PATH=/dev/null NODE_ENV=production npm test
npm run test:e2e
npm run test:e2e:photography
npm run test:e2e:production-podcast
git diff --check
```

Les paramètres navigateur et l’emplacement des captures sont décrits dans le
[guide de la page auteur](page-auteur.md#vérification-reproductible).
Le rapport E2E distingue le SHA de base de l’empreinte des fichiers locaux
modifiés. Les captures et logs restent hors Git. Toute publication ultérieure
doit requalifier la révision candidate et suivre la procédure de livraison.
