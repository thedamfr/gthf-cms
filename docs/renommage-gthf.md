# Renommage technique GTHF

## Summary

Le dépôt et le package CMS prennent le nom `gthf-cms`. Les références au
frontend, la publication des candidats et les noms Kubernetes suivent `gthf`.
La migration conserve les données et droits persistés. Les Golden Journeys
restent exécutés sur les vraies applications ; les preuves de chaque candidat
sont rattachées à son SHA dans la PR.

## Synthèse

Le workflow CMS consomme le déployeur de `thedamfr/gthf-frontend`, épinglé par
SHA, et publie ses preuves dans `gthf-release`. Les namespaces cibles sont
`gthf-staging` pour la production historique et `gthf-qualification` pour le
staging isolé. Les nouvelles images reçoivent `GTHF_REVISION`. Le middleware
conserve la lecture de `GTHDF_REVISION` pour les images et environnements plus
anciens. L’argument Docker historique reste un alias.

Les scripts de copie médias reconnaissent `GTHF_CMS_CLEVER_APP`,
`GTHF_OVH_CREDENTIALS_FILE`, `GTHF_OVH_BUCKET` et `GTHF_MEDIA_COPY_CONCURRENCY`,
avec repli sur leur ancienne forme `GTHDF_*`. La préparation staging accepte
`GTHF_NAMESPACE` ou l’ancien alias et garde ses restrictions à la qualification,
à PostgreSQL et au bucket dédié. La nouvelle variable prime lorsque les deux
sont présentes.

Les bases et utilisateurs PostgreSQL, les volumes Docker existants, les buckets
`gthdf-*`, l’application Clever `gthdf-cms`, le rôle `gthdf-datamaster`, le jeton
`gthdf-staging-read` et les métadonnées S3 `gthdf-source-sha256` restent stables.
Les modifier créerait un risque de données absentes, de droits dupliqués ou de
reprise de copie invalide. Le renommage n’exécute aucun script de migration
métier et ne reconstruit pas implicitement l’image qui tourne en production.

## Annexes

### Validation reproductible

Depuis le checkout CMS avec le frontend voisin nommé `gthf-frontend` :

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
npm run test:e2e -- staging
npm run test:e2e -- production
```

`test:e2e` lance `../gthf-frontend/infrastructure/delivery/recipe.mjs`. La PR
précise les deux SHA des checkouts, la version Node/npm, l’environnement,
les commandes, les scénarios réussis ou échoués et les rapports expurgés. La
suite dépend des accès Kubernetes autorisés et des applications réelles ; elle
n’est pas simulée et n’est pas lancée sur un runner PR sans ces accès.

Les Golden Journeys couvrent les contenus publiés et médias, les pages villes,
le catalogue et le téléchargement GPX. En staging, ils couvrent aussi la connexion authentifiée,
le CRUD, la preview protégée, la publication visible
dans Next.js, les uploads et le nettoyage des seules données temporaires.
La persistance et les droits restent à vérifier lors de la migration des
ressources Kubernetes, avec les preuves du déployeur commun. Un succès unitaire
ou un build ne vaut pas réussite de ces Golden Journeys.

### Retour arrière

Conserver les anciens noms de registre et les alias techniques pendant la
transition. Réactiver la configuration et le digest précédents si la
qualification échoue ; ne supprimer ni volume ni donnée. L’historique de
septembre dans le README et le runbook reste une preuve datée et ne remplace
pas les résultats de la révision courante.
