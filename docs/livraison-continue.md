# Livraison continue du CMS GTHF

## Summary

Le workflow CMS publie une image par SHA et un candidat que le réconciliateur
local qualifie avant promotion. Le dépôt, les nouvelles images et les ressources
Kubernetes utilisent le préfixe `gthf`. Les données et identités persistantes
conservent leurs noms. Le [guide de renommage](renommage-gthf.md) précise les
compatibilités et les Golden Journeys à exécuter.

## Synthèse

Le namespace `gthf-qualification` reçoit les recettes CRUD, preview, publication
et médias ; `gthf-staging` sert la production et reçoit uniquement des contrôles
en lecture. Chaque candidat garde le SHA CMS, le digest et la révision exacte du
déployeur frontend. Le publieur frontend est épinglé dans le workflow CMS ; sa
mise à jour nécessite une revue du changement de ce SHA.

Les bases, buckets, clés, rôles et jetons persistants ne sont pas renommés. Les
variables techniques `GTHF_*` disposent d’alias `GTHDF_*` pour la transition. Les
historiques ci-dessous décrivent les qualifications de septembre et ne prouvent
pas une validation de la révision candidate actuelle. Exécuter les Golden
Journeys par `npm run test:e2e -- staging` et `npm run test:e2e -- production`
avec le checkout frontend voisin à la révision prévue. La production conserve
son dernier digest compatible en cas d’échec ; aucune base n’est restaurée
implicitement.

## Annexes

Version 0.5 — 11 septembre 2026. Statut : **réconciliation locale activée, cycle CMS vérifié**.
Le [plan initial du 10 septembre](livraison-continue-initiale-2026-09-10.md) est conservé intégralement.
Le [runbook frontend](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/deploiement_continu.md) porte les commandes communes et les preuves d'exploitation.
Le transport local est coordonné dans les PR [frontend #36](https://github.com/thedamfr/gthf-frontend/pull/36) puis [CMS #26](https://github.com/thedamfr/gthf-cms/pull/26), fusionnées dans cet ordre. Les PR #33/#23 portent la première qualification historique des images.

## Staging complet du produit

Le namespace `gthf-qualification` contient un PostgreSQL dédié, une copie éditoriale sans comptes ni secrets de production et les accès de recette propres au CMS. Les 2 720 objets média et les 2 209 références de fichiers ont été copiés et réécrits vers `gthf-staging-media-bis` à Gravelines. La base et les médias persistent séparément de la production.

Sur instruction explicite du propriétaire, l'utilisateur S3 `gthf` est partagé entre les deux buckets GTHF. Les clés S3 ne constituent donc pas une barrière entre staging et production ; les scripts bornent les écritures de recette au seul bucket staging. Les identités PostgreSQL, Strapi et les jetons restent propres à chaque environnement. Le contrôle d'accès au bucket de production avec les nouvelles clés réussit depuis le 11 septembre ; leur installation en production est vérifiée après promotion.

Les applications et domaines sont isolés. [Frontend staging](https://staging.gthf.fr/) et [CMS staging](https://staging-cms.gthf.fr/) exigent une authentification ; TLS, refus 401 et redirection HTTP ont été vérifiés. Aucune URL Tailscale Serve GTHF n’est configurée.

## Implémentation et validations

- `.github/workflows/delivery.yml` : tests et build sur PR, publication par SHA/digest GHCR sur `main`, puis candidat public dans `gthf-release`, pris en charge par le réconciliateur local après réussite complète du workflow.
- `GET /api/release` : révision effective du processus, absence de cache et requête PostgreSQL ; dépendance indisponible en 503.
- `DATABASE_FORCE_MIGRATION=false` : conservation des tables et colonnes lors du retour arrière ; changements destructifs refusés par le déployeur.
- `src/infrastructure/schema-lock.ts` : verrou PostgreSQL autour de la synchronisation du schéma, pour conserver le rolling update sans synchronisations concurrentes. Le pool garde au moins trois connexions ; voir les conditions de première activation dans le [README](../README.md#livraison-continue-ovh).
- `.dockerignore` : documentation narrative et tests exclus de l'image ; les scripts et données métier restent des entrées runtime.
- `delivery:storage:check` : contrôle borné création/lecture/suppression en staging, puis accès au bucket de production sans écriture.
- `delivery:staging:prepare` : copie reprenable des médias, réécriture des URLs et comptes de staging, avec garde-fous sur la cible.

Les 259 tests CMS et le build Strapi ont réussi localement. La préparation réelle de la base et des médias a réussi, avec un administrateur, un jeton de lecture et aucun webhook. Le [workflow CMS](https://github.com/thedamfr/gthf-cms/actions/runs/34608608471) a publié le digest `sha256:35dd2cdc3bccd4c91db281b79eab4a4efbcda5aa28b404e80c8be1e4ab8972d8` du commit `bd7c11222ed03325fe2161d349de0b1286255e18`. La qualification puis la promotion ont été exécutées par une opération SSH autorisée, avec les preuves du runbook frontend lié ci-dessus. Les recettes CRUD/preview/publication/upload/nettoyage, la persistance et deux démarrages CMS simultanés ont réussi. La reprise de production a passé 468 contrôles origine sans erreur, dont une fenêtre de santé de 60 secondes après rollout. La première tentative avait déclenché un retour arrière après des timeouts ; les preuves des deux tentatives sont conservées dans le runbook commun.

Le [nouveau workflow CMS](https://github.com/thedamfr/gthf-cms/actions/runs/34629330095)
a publié `02963c8bafed323658890752cc19f2c9356e7748`. Le service local a vérifié
automatiquement le candidat puis exécuté la recette staging de 17:48:06 à
17:48:31 UTC et la recette production de 17:48:31 à 17:49:53 UTC. Les 228 contrôles
origine ont réussi, avec au moins 60 secondes saines après la recette et des sondes
Prometheus fraîches avant et après. Les sources runtime n’ayant pas changé, le
CMS conserve le digest de `bd7c112` ; seule sa révision traitée avance à `02963c8`.
La première publication construit une image en l’absence d’historique de candidats,
mais le service conserve l’image en production lorsqu’elle est équivalente.
Les [PR de clôture frontend #37](https://github.com/thedamfr/gthf-frontend/pull/37)
et [CMS #27](https://github.com/thedamfr/gthf-cms/pull/27) recevront, après fusion,
le résultat du contrôle documentaire : réutilisation des images et conservation
des pods. Ce contrôle reste à exécuter lors de la rédaction de cette version.

## Activation et retour arrière

Le workflow CMS utilise le publieur frontend épinglé au commit
`636d7b6a6226d225141df69d57d45c6bc344f7c7`, fusionné dans la PR #36, et conserve ce SHA
dans chaque candidat. Toute mise à jour de ce publieur demande une modification
relue du workflow CMS ; un nouveau commit frontend ne reçoit donc pas implicitement
le jeton d’écriture CMS. Le service
local sur Penthouse suit le mécanisme déjà actif du site : il vérifie le candidat,
la CI et les empreintes, qualifie en staging puis promeut sous le verrou commun.
Le serveur lit les dépôts publics sans identifiant GitHub ; les images privées
utilisent le Secret GHCR existant. Aucun accès SSH ou Tailscale de runner n’est
nécessaire. ArgoCD Studio reste une intégration séparée en préparation ; cette
livraison ne crée pas d’Application ArgoCD GTHF. Le runbook commun porte
l’installation, la pause et les preuves des cycles réels frontend et CMS vérifiés.

La première paire d’images a été qualifiée puis promue, avec sauvegarde PostgreSQL et contrôles de disponibilité. Les références initiales staging et production sont enregistrées après réussite de leurs recettes. La livraison automatique refuse leur absence. Les volumes, secrets et données de staging ne sont jamais promus. Le retour arrière conserve les données et réactive la dernière image compatible ; aucune restauration de base n'est automatique.

Les scripts Clever et le seed distant restent des opérations historiques distinctes : voir la [portée des commandes](../README.md#portée-des-commandes-distantes-et-des-migrations).
