# ADR 0025 — Page d’offre de production de podcast

## Summary

Décision du 30 octobre 2026 : créer une page publique d’offre à
`/offre-production-podcast/`, accessible depuis les footers existants.
Elle présente l’accompagnement éditorial, les budgets et une session gratuite
par email. Le header partagé et les offres de l’accueil sont conservés.
Le plan approuvé comprend la recette staging puis la livraison après les
changements podcast et header des PR #68 et #69.

## Synthèse

- **Rendu :** vue Handlebars, CSS dédié, identité ivoire/noir, Oswald/Inter,
  photos existantes et header partagé. Aucun nouveau JavaScript ni service.
- **Interface publique :** GET avec slash final ; redirection 301 depuis la
  variante sans slash, paramètres conservés ; URL canonique dans le sitemap
  et les métadonnées de partage.
- **Parcours :** lien « Besoin d'un producteur sur mon podcast ? » dans les
  footers publics déjà présents ; lecture de l’offre puis email prérempli
  pour demander une heure gratuite. Le créneau est confirmé par échange.
- **Contenu :** prestations selon forfait, validation éditoriale du client,
  budgets indicatifs et références avec responsabilités vérifiées. La session
  reste indépendante du budget, sans collecte ni filtrage de prospect.
- **Sécurité et accessibilité :** route de lecture utilisant les protections
  existantes, sans base, RSS, upload ou écriture. HTML sémantique, lien
  d’évitement, focus visible, images décrites et fonctionnement sans JavaScript.
- **Validation :** tests ciblés de route, Golden Journeys par commande npm
  versionnée, captures responsive et requalification après rebase. Les tests
  email n’envoient rien ; les tests distants évitent les GET podcast à effets
  de bord. Les preuves sont liées à la révision candidate puis livrée.
- **Retour arrière :** revert applicatif via la livraison existante ; aucune
  migration ni donnée à restaurer.

## Annexes

- [Offre et Golden Journeys](../production-podcast.md).
- [Identité claire de Saleté Sincère](adr_0017_identite_claire_et_territoire_charbon_wafer.md).
- [Livraison continue](../livraison-continue.md).
