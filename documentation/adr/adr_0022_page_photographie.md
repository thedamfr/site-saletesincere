# ADR 0022 — Page photographie événementielle et reportage corporate

## Summary

La route `/photographie` transpose la maquette validée le 25 septembre 2026 :
offre, approche et références dotAI / dotJS, Hodéfi Awards et Masters de Feu.
Elle est rendue côté serveur, accessible depuis l’accueil et indépendante de
PostgreSQL, du RSS et du stockage objet. Son implémentation locale n’autorise
pas sa publication. Les modalités de livraison et de consentement décrivent
le service existant ; elles ne créent pas une application de livraison.

## Synthèse

- **Décision :** page Handlebars autonome, identité ivoire/noir, Oswald et Inter,
  feuille `/photography.css` isolée comme celle du laboratoire du geste.
- **Références :** dotAI / dotJS forme un seul événement en deux parties.
  Les Hodéfi Awards et les Masters de Feu gardent leurs séries distinctes.
  Aucune référence de reportage en entreprise n’est inventée.
- **Parcours :** découverte depuis l’accueil, lecture des reportages, ouverture
  de deux images complémentaires, contact par email et retour à l’accueil.
- **Accessibilité :** HTML sémantique, lien d’évitement, focus visible,
  alternatives textuelles et galerie native `details/summary`, utilisable sans
  JavaScript. Les compositions photographiques restent entières.
- **Performance :** dérivés WebP locaux avec `srcset`, dimensions intrinsèques,
  chargement différé hors ouverture et JPEG social. Originaux hors Git,
  métadonnées retirées lors de la génération. Aucun nouveau service tiers ;
  Google Fonts est déjà employé par l’identité existante.
- **Sécurité :** route de lecture avec les en-têtes et limites existants,
  sans saisie, upload, écriture en base ou stockage de consentement.
- **Validation :** tests de routes, build et Golden Journeys via
  `npm run test:e2e:photography`. Le navigateur utilise un serveur loopback,
  aucun service de production ; les limites sont précisées dans le guide.
- **Retour arrière :** retirer le lien d’accueil et la route, puis les fichiers
  propres à la page. Aucune migration ni donnée métier concernée.

## Annexes

- [Guide et Golden Journeys](../photographie.md).
- [Identité de marque](adr_0017_identite_claire_et_territoire_charbon_wafer.md).
- [Rendu Handlebars](adr_0009_migration_handlebars.md).

Le README historique de `server/views/` décrit encore une migration Pug/HTML.
Le moteur réellement utilisé et l’ADR 0009 font foi pour cette page.
