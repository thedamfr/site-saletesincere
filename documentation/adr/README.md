# Architecture Decision Records (ADRs)

L’[index complet des ADR](index.md) est la liste de référence des décisions du
projet Saleté Sincère.

## Hébergement et déploiement

- [Guide opérationnel](../hebergement-deploiement.md) : production OVH, publication
  GHCR, activation de l’image, recette et retour arrière.
- [ADR 0018](adr_0018_migration_ovh_et_retrait_sale_wall.md) : migration et production
  OVH, retrait du Sale-wall.
- [ADR 0003](adr_0003_deployment_production_clevercloud.md) : installation Clever
  Cloud historique, toujours active séparément.

Une image publiée par GitHub Actions ou un déploiement Clever réussi ne signifie
pas que le domaine public a été mis à jour : vérifier le Deployment OVH.

## Créer ou mettre à jour un ADR

Suivre les [instructions du projet](../../AGENTS.md), conserver l’état initial des
décisions comme historique et mettre à jour l’[index complet](index.md). Une
correction locale ne nécessite pas de nouvel ADR.

## Documentation connexe

- [README du projet](../../readme.md)
- [Sécurité](../../security/)
- [Scripts](../../scripts/)
