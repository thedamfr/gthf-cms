# GTHF CMS

## Summary

Le CMS Strapi de GTHF porte les schémas, l’administration et les médias du site.
Le dépôt et le package se nomment `gthf-cms` ; le déployeur commun est dans
`gthf-frontend`. Le renommage conserve les données, buckets et droits existants.
Les commandes de développement et de livraison sont détaillées dans les
[annexes](#annexes), et les validations du renommage dans le
[guide dédié](docs/renommage-gthf.md).

## Synthèse

Le CMS et le frontend gardent des cycles de livraison séparés et partagent le
déployeur frontend. La production utilise le namespace `gthf-staging` ; le
staging isolé utilise `gthf-qualification`. Les noms historiques des bases,
buckets, volumes Docker et rôles persistés restent stables afin de conserver
les données et permissions. L’application Clever historique conserve également
son nom.

`GTHF_REVISION` identifie les nouvelles images et l’ancienne variable
`GTHDF_REVISION` reste comprise. Les scripts de migration acceptent les nouvelles
variables `GTHF_*` et leurs anciens alias. Aucune migration métier n’est lancée
par le renommage.

La validation comprend `npm test`, `npm run build` et les Golden Journeys réels
avec `npm run test:e2e -- staging`, puis `npm run test:e2e -- production`. Ces
derniers nécessitent le checkout voisin `gthf-frontend` à la révision du déployeur
retenue et les accès autorisés de Penthouse. Ils réalisent le CRUD et les uploads
en staging seulement ; la production est vérifiée en lecture seule. Leur
résultat est distinct de celui des tests unitaires et doit accompagner chaque PR.

## Annexes

CMS Strapi du Grand Tour des Hauts-de-France. Ce dépôt porte les schémas
éditoriaux, l’administration, les migrations et les médias consommés par
l’application publique.

## Organisation des dépôts et documentation

Le produit GTHF est réparti entre :

- ce dépôt `gthf-cms`, source du schéma exécutable Strapi ;
- [`gthf-frontend`](https://github.com/thedamfr/gthf-frontend), application
  Next.js qui consomme son contrat de données.

Les PRD transverses ont une source canonique unique dans
[`gthf-frontend/documentation/`](https://github.com/thedamfr/gthf-frontend/tree/main/documentation).
Chaque document précise les dépôts d’implémentation concernés, leur ordre de
déploiement et les contraintes de compatibilité. Dans un checkout local où les
deux dépôts sont voisins, ces fichiers se trouvent sous
`../gthf-frontend/documentation/`.

Ne pas copier les PRD dans ce dépôt : les lier depuis le README, une issue ou
une pull request. Cette centralisation simplifie la revue d’architecture sans
coupler les cycles de livraison. Chaque application possède son dépôt et son
image, mais les manifests et playbooks OVH des deux applications sont dans le
dépôt frontend. `production-clever` décrit l'ancien hébergement ; ce n'est plus
la cible de production publique.

Documents de référence :

- [PRD 01 — Référentiel des villes et pages hubs](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/prd_01_referentiel_villes_pages_hubs.md), livré ;
- [PRD 02 — Retrouver son chapitre sur mobile](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/prd_02_retrouver_chapitre_mobile.md), livré et validé en production ;
- [PRD 03 — GPX Builder v2 ville à ville](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/prd_03_gpx_builder_ville_a_ville.md), implémenté localement, qualification éditoriale en attente ;
- [PRD 04 — Catalogue d’itinéraires ville à ville](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/prd_04_catalogue_itineraires_ville_a_ville.md), livré ; optimisation SEO des fiches en cours de déploiement.
- le lot CMS DataMaster du PRD 05 est documenté dans
  [`docs/prd05-datamaster-rbac.md`](docs/prd05-datamaster-rbac.md).

## 🐳 Development Setup

### Prerequisites

- Node.js v24.3.0+
- Docker & Docker Compose

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- **PostgreSQL** (port 5432): Database `gthdf`
- **MinIO** (ports 9000/9001): S3-compatible object storage

### 2. Configure Environment

Create `.env` file with:

```env
# Database
DATABASE_NAME=gthdf
DATABASE_USERNAME=gthdf
DATABASE_PASSWORD=gthdf

# MinIO S3 Storage
AWS_ACCESS_KEY_ID=gthdf
AWS_SECRET_ACCESS_KEY=gthdfpassword
AWS_REGION=us-east-1
AWS_BUCKET=gthdf-media
AWS_CDN_URL=http://127.0.0.1:9000/gthdf-media
```

### 3. Create MinIO Bucket

**Important**: Create bucket via AWS SDK (not MinIO CLI) for compatibility:

```bash
node create-bucket.js
```

Set public read policy:

```bash
s3cmd setpolicy minio-policy.json s3://gthdf-media --host=http://127.0.0.1:9000 \
  --host-bucket=http://127.0.0.1:9000/gthdf-media \
  --access_key=gthdf --secret_key=gthdfpassword --no-ssl
```

### 4. Install & Run

```bash
npm install
npm run develop
```

## Livraison continue OVH

Le transport local est coordonné par les PR
[frontend #36](https://github.com/thedamfr/gthf-frontend/pull/36) et
[CMS #26](https://github.com/thedamfr/gthf-cms/pull/26), fusionnées dans cet ordre.
Les premières images GHCR, issues des anciennes PR #33/#23, ont déjà été
vérifiées dans le staging isolé puis en production.
Le [runbook commun](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/deploiement_continu.md)
conserve les digests, les recettes et l’incident suivi d’une reprise. Le raccordement automatique utilise un réconciliateur local sur Penthouse,
sans connexion des runners au serveur.

La production utilise `gthf-staging` et conserve le bucket `gthdf-staging-media` à Paris.
Le staging complet utilise `gthf-qualification` et `gthf-staging-media-bis` à
Gravelines. L’utilisateur S3 GTHF autorisé est installé dans les deux environnements ;
les secrets Strapi et les comptes de recette sont distincts. Le
[CMS staging](https://staging-cms.gthf.fr/) exige une authentification.

L'image reçoit `GTHF_REVISION` au build, sans secret ; `GTHDF_REVISION` reste accepté pour les anciens déployeurs. `GET /api/release` renvoie
cette révision avec `Cache-Control: no-store` après une requête PostgreSQL ; une
base indisponible donne 503. `DATABASE_FORCE_MIGRATION` vaut `false` par défaut :
Strapi conserve les tables et colonnes persistantes lors d'un retour arrière.
Les modifications destructives ou contraintes nouvelles restent des migrations
à planifier séparément. Le déployeur vérifie cette compatibilité avant un rollout.

Au démarrage PostgreSQL, `register` sérialise `db.schema.sync()` avec un verrou
transactionnel consultatif commun aux instances CMS (`0x47544853`). Il est
libéré au succès comme à l'échec. L'ancien pod peut continuer à servir pendant
la synchronisation additive du nouveau ; les démarrages concurrents attendent
leur tour. Conserver `DATABASE_POOL_MAX=3` au minimum : le verrou réserve une
connexion en plus de celles utilisées par Strapi. La première activation doit
partir du schéma courant sans changement, car l'image historique ne porte pas
encore ce verrou. Les deux démarrages simultanés et la persistance ont été
vérifiés en staging ; les 37 schémas de la première promotion sont identiques.

Les contrôles de stockage et le peuplement initial utilisent :

```bash
npm run delivery:storage:check -- /chemin/prive/ovh-gthf.txt
npm run delivery:storage:check -- /chemin/prive/ovh-gthf.txt --inventory
```

Le premier contrôle crée, lit et supprime son seul objet temporaire dans le
bucket staging, puis vérifie l'accès de contrôle au bucket de production.
`--inventory` ne fait que compter les objets et leurs octets dans staging.
Le peuplement `delivery:staging:prepare` est exécuté par le job Ansible du
frontend dans le namespace vérifié ; il requiert les secrets de staging et
refuse les overrides PostgreSQL/Cellar. Les copies marquées par leur checksum
sont réutilisées ; seuls les objets manquants sont transférés. La migration
réécrit les tables applicatives, crée les accès de recette et enlève les
jetons d'exemple uniquement lors de l'initialisation sans administrateur.
Les 2 720 objets et la réécriture des 2 209 fichiers ont été vérifiés le
11 septembre. Les applications et domaines staging sont isolés, et les recettes
CRUD, preview, publication, upload et nettoyage ont réussi.

## Image de production autohébergée

Les preuves historiques du 11 septembre 2026 concernent `deployment/gthdf-cms`,
namespace `gthdf-staging`, servant `https://cms.gthf.fr` sur Penthouse avec le commit
`bd7c11222ed03325fe2161d349de0b1286255e18` et le digest GHCR
`sha256:35dd2cdc3bccd4c91db281b79eab4a4efbcda5aa28b404e80c8be1e4ab8972d8`.
Le même digest avait été qualifié dans `gthdf-qualification`. Ces preuves
historiques ne valent pas validation du renommage courant ; voir le
[guide de renommage](docs/renommage-gthf.md). PostgreSQL et les médias sont conservés.

Les [critères de staging complet](docs/livraison-continue.md#staging-complet-du-produit)
sont recettés. Le réconciliateur local est actif et a traité automatiquement
`02963c8bafed323658890752cc19f2c9356e7748` le 11 septembre à 17:49 UTC, après recette
staging puis production. Le runtime étant identique, il conserve le digest
ci-dessus ; 228 contrôles origine ont réussi sans erreur. Une CI verte atteste
la publication du candidat ; le résultat de production est enregistré sur le serveur.

Le [plan de livraison du CMS](docs/livraison-continue.md) décrit la sélection,
le verrou commun, la compatibilité des schémas et le retour arrière. Le serveur
lit le candidat public dans `gthf-release` et le cluster récupère son digest GHCR.
Ansible et Kustomize restent
les outils d’activation ; les commandes Docker locales suivantes sont un secours.

Le `Dockerfile` produit une image Strapi autonome et non-root sur Node.js 24.
Les identifiants PostgreSQL, les secrets Strapi et les clés S3 sont injectés au
runtime ; ils ne doivent jamais être transmis comme arguments de build. Le
stockage S3 générique utilise `AWS_ENDPOINT`, `AWS_REGION`, `AWS_BUCKET`,
`AWS_ACCESS_KEY_ID` et `AWS_SECRET_ACCESS_KEY`. `PUBLIC_URL` fixe l'URL publique
du CMS derrière le proxy et `MEDIA_ALLOWED_ORIGINS` complète la CSP. Le CORS
n'utilise jamais la valeur permissive par défaut de Strapi : il accepte
uniquement `CLIENT_URL` et les origines HTTP(S) explicites de
`PREVIEW_ALLOWED_ORIGINS`.

```bash
sudo -n docker build -t gthf-cms:staging .
sudo -n docker run --rm --network none gthf-cms:staging node -e \
  "console.log(process.getuid(), process.getgid())"
```

Ces commandes utilisent le builder local autorisé sur OVH ; un poste de
développement peut disposer d'un autre mode d'accès Docker. Le build ne
remplace pas l'import dans le containerd MicroK8s ni l'activation du workload.
La recette MicroK8s et la stratégie de migration sont documentées dans le
[runbook infra frontend](https://github.com/thedamfr/gthf-frontend/blob/main/infrastructure/README.md)
et l'[ADR d'hébergement](https://github.com/thedamfr/gthf-frontend/blob/main/documentation/adr_hebergement_microk8s_partage.md).

### Portée des commandes distantes et des migrations

Les procédures Clever ci-dessous conservent l'historique des migrations, mais
ne sont pas des commandes de production OVH :

| Commande | Cible réellement sélectionnée aujourd'hui |
|---|---|
| `migrate:cities:remote`, `migrate:featured-cities:remote` | Variables `POSTGRESQL_ADDON_*_REMOTE` du fichier local, à contrôler explicitement |
| `migrate:chapter-display-order:remote`, `prepare:gpx-anchors:remote`, `migrate:catalogue-schema:remote` | Base récupérée par `clever env`, application Clever `gthdf-cms` par défaut |
| `migrate:media:ovh-staging` | Copie depuis Cellar vers le bucket OVH, sans suppression de la source |
| `seed:remote` | Base distante fournie en environnement ; import de données d'exemple, exclu de la livraison de production |

Le suffixe `:remote` ne signifie jamais « base OVH ». Ne pas appliquer les
commandes Clever à la source historique en pensant modifier la production.
Une future exécution OVH doit identifier le serveur, le namespace et la base,
utiliser les identifiants privés autorisés, produire un dry-run puis vérifier
une sauvegarde avant les options d'application prévues par le script. Les
migrations irréversibles ou restaurations écrasantes restent des opérations
spécifiques, hors du déploiement automatique courant.

Les migrations métier ne sont pas des étapes automatiques de démarrage.
Strapi peut toutefois synchroniser son schéma au lancement : un changement de
schéma exige donc une revue de compatibilité avant le rollout. Pour les
évolutions additives, livrer et valider le CMS avant le frontend qui lit les
nouveaux champs ; conserver les champs lors d'un rollback applicatif.

### Copie des médias vers OVH Paris

La copie de staging est reprenable et non destructive : elle récupère les
identifiants Cellar avec `clever-cli`, lit les identifiants OVH depuis un fichier
privé explicitement fourni et ne supprime jamais la source. Les objets déjà
présents avec la même taille sont ignorés.

```bash
GTHF_OVH_CREDENTIALS_FILE=/chemin/prive/ovh.env \
  npm run migrate:media:ovh-staging
```

Le domaine public du bucket OVH utilise le format virtual-host
`https://gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net` ; le format
path-style sert aux appels S3 authentifiés mais ne doit pas être utilisé comme
`AWS_CDN_URL`.

Le CMS et le frontend doivent partager la même valeur longue et aléatoire de
`PREVIEW_SECRET`. Elle protège l’activation du Draft Mode pour les previews
d’article, de chapitre et de ville.

## Migration PRD 01 des villes

Le script de reprise lit par défaut l’export contrôlé
`../gthf-frontend/documentation/data/gthf_villes_et_produits_seo/csv/villes.csv`.
Il utilise les noms legacy des chapitres pour proposer uniquement les villes
nécessaires ; il n’importe jamais tout le référentiel de 223 villes.

Commencer obligatoirement par le dry-run, qui ne modifie aucune donnée :

```bash
npm run migrate:cities
```

Le rapport détaillé est écrit dans
`.tmp/city-migration-report.json`. Une ville ambiguë ou absente y est associée
au chapitre concerné. Pour résoudre un homonyme, copier
`scripts/city-migration-resolutions.example.json`, renseigner le slug du
chapitre et la `municipalityKey` relue, puis relancer :

```bash
npm run migrate:cities -- --resolutions /chemin/resolutions.json
```

Après revue du rapport, l’application est volontaire :

```bash
npm run migrate:cities -- --resolutions /chemin/resolutions.json --apply
```

Garanties du script :

- `dry-run` par défaut et rapport JSON observable ;
- création de brouillons avec `hasPublicPage=false` uniquement ;
- mise à jour des brouillons de chapitre sans aucune republication ;
- refus d’écraser des `cityPassages` éditoriaux qui diffèrent de la
  proposition legacy ;
- exécution idempotente : un second passage valide reste sans changement.

Les chemins peuvent être remplacés avec `--mapping`, `--resolutions` et
`--report`. `npm run migrate:cities -- --help` documente toutes les options.

### Libellés directionnels des itinéraires

`City.fromLabel` et `City.toLabel` sont deux chaînes éditoriales optionnelles,
limitées à 180 caractères. Elles contiennent le libellé prépositionnel complet,
par exemple `du Touquet-Paris-Plage`, `d’Abbeville`, `au Crotoy` ou
`à Camiers`. Elles servent au H1, au téléchargement, aux cartes et aux liens
d’itinéraires. Laisser un champ vide active le fallback grammatical du
frontend ; renseigner puis publier la ville permet de traiter une exception
comme un h aspiré.

Le changement de schéma est additif et ne demande aucun script de migration.
Déployer le CMS avant la version du frontend qui sélectionne ces champs dans
l’API Strapi. L’ancien frontend les ignore ; en cas de rollback, conserver les
colonnes et redéployer seulement le frontend précédent.

### Reprise manuelle historique sur Clever

Cette reprise n'est jamais lancée au démarrage de Clever Cloud. Strapi crée le
schéma au chargement de la nouvelle version ; le script ci-dessous reprend
ensuite les données, une seule fois et depuis un checkout local où les deux
dépôts sont voisins.

Après déploiement du CMS, mettre `gthf-frontend` à jour pour disposer du CSV
canonique et renseigner dans le `.env` local du CMS les variables
`POSTGRESQL_ADDON_HOST_REMOTE`, `POSTGRESQL_ADDON_PORT_REMOTE`,
`POSTGRESQL_ADDON_DB_REMOTE`, `POSTGRESQL_ADDON_USER_REMOTE` et
`POSTGRESQL_ADDON_PASSWORD_REMOTE`. Commencer par le dry-run distant :

```bash
npm run migrate:cities:remote -- --resolutions /chemin/resolutions.json
```

Relire le rapport local `.tmp/city-migration-report.json`, notamment les
ambiguïtés, conflits et chapitres bloqués. L'application distante exige ensuite
deux options explicites :

```bash
npm run migrate:cities:remote -- \
  --resolutions /chemin/resolutions.json \
  --apply \
  --confirm-remote
```

Même dans ce mode, seules des villes en brouillon avec `hasPublicPage=false` et
les versions brouillon des chapitres sont écrites. La relecture puis la
publication éditoriale restent manuelles dans Strapi.

### Sélection des villes mises en avant

La sélection éditoriale validée est versionnée dans
`scripts/featured-city-passages.json`. Elle conserve tous les passages de
ville et change uniquement leur booléen `featured`, avec un maximum de six
intermédiaires par chapitre.

Commencer par un dry-run local ou distant :

```bash
npm run migrate:featured-cities
npm run migrate:featured-cities:remote
```

Le rapport `.tmp/featured-city-migration-report.json` expose, pour chaque
chapitre, les clés mises en avant avant et après la migration. Après relecture,
l’application locale ou distante est volontaire :

```bash
npm run migrate:featured-cities -- --apply
npm run migrate:featured-cities:remote -- --apply --confirm-remote
```

Le script est idempotent, ne modifie que les brouillons de chapitre et ne
publie aucun document. Pour revenir en arrière, reconstruire un fichier de
sélection à partir des `beforeFeaturedMunicipalityKeys` du rapport sauvegardé,
puis le passer avec `--selection` après un nouveau dry-run. Une restauration de
la sauvegarde PostgreSQL prise avant application reste le retour arrière
complet.

## Migration PRD 02 de l’ordre public des chapitres

Le champ `displayOrder` fixe l’ordre public de la boucle sans dépendre de
l’ordre de retour de Strapi. Un brouillon peut temporairement ne pas avoir
d’ordre ou partager une valeur avec un autre brouillon. La publication exige
en revanche des entiers positifs, uniques et contigus de `1` au nombre de
chapitres publiés. Dépublier ou supprimer un chapitre d’ordre intermédiaire
est refusé tant que cela créerait un trou ; retirer le dernier ordre conserve
un ensemble valide. Les publications, dépublications et suppressions sont
sérialisées avant validation par un verrou transactionnel global PostgreSQL
(`pg_advisory_xact_lock`, clé stable `0x47544846`, soit `GTHF` en ASCII). Ce
verrou couvre aussi les créations lorsque la table est vide. Les opérations
limitées aux brouillons restent inchangées et ne prennent pas ce verrou.

Le mapping versionné couvre explicitement les dix slugs actuels, de
`lille-a-arras` (`1`) à `st-omer-lille` (`10`). Commencer par le dry-run local :

```bash
npm run migrate:chapter-display-order
```

Le rapport `.tmp/chapter-display-order-migration-report.json` affiche, pour
chaque slug, les valeurs brouillon et publiée avant migration ainsi que la
valeur cible. L’application est volontaire :

```bash
npm run migrate:chapter-display-order -- --apply
```

La commande met à jour dans une seule transaction les versions brouillon et
publiée de chaque document. Elle ne republie aucun chapitre et n’écrit que
`displayOrder`. Elle refuse l’ensemble de l’application si un slug est absent,
inattendu, dupliqué ou s’il manque une des deux versions. Un second passage doit
signaler les dix chapitres comme inchangés.

Pour la cible historique Clever, prendre une sauvegarde PostgreSQL, vérifier
que la CLI Clever est installée et authentifiée, puis exécuter d’abord :

```bash
npm run migrate:chapter-display-order:remote -- --allow-self-signed-tls
```

La commande appelle `clever env --app gthdf-cms --format json`, sélectionne
l’endpoint PostgreSQL externe `DIRECT_*` et conserve les secrets uniquement en
mémoire. Elle ne dépend pas de variables `*_REMOTE` copiées dans `.env`. Une
autre application peut être ciblée explicitement avec
`--clever-app <id-ou-nom>`. La vérification du certificat TLS reste active par
défaut. Clever expose actuellement cet endpoint avec un certificat auto-signé
et sans CA dans les variables de l’add-on : l’exception
`--allow-self-signed-tls` est donc volontaire et visible dans chaque commande
distante, tout en conservant le chiffrement TLS.

Après relecture du rapport et contrôle des dix associations, appliquer avec le
second verrou :

```bash
npm run migrate:chapter-display-order:remote -- \
  --allow-self-signed-tls \
  --apply \
  --confirm-remote
```

Contrôler ensuite que les valeurs publiées vont de `1` à `10` et que les
relations `nextChapter` et `previousChapter` n’ont pas changé. Le rollback
applicatif peut conserver ce champ additif : l’ancien frontend l’ignore. Pour
annuler également les données CMS, restaurer la sauvegarde PostgreSQL prise
avant `--apply`; le script ne modifiant aucun autre champ, aucune reprise de
contenu séparée n’est nécessaire.

### Exécution de production du 5 août 2026

La migration a été appliquée aux dix documents de production, soit vingt
versions brouillon et publiée. Elle a écrit les ordres `1` à `10` sans erreur ;
le dry-run postérieur a classé les dix documents comme inchangés. Les rapports
avant et après application ont été conservés localement sans exposer les
identifiants de la base.

La sauvegarde tentée ce jour-là n’a pas abouti. L’application sans sauvegarde
réussie a fait l’objet d’une autorisation explicite pour cette exécution
précise. Cette exception historique ne change pas le runbook : toute nouvelle
application distante doit être précédée d’une sauvegarde PostgreSQL réussie et
contrôlée.

## Préparation PRD 03 des ancrages et jonctions GPX

Le CMS conserve deux ancrages qualifiés par `cityPassage`, un pour
`gpxFileAB` et un pour `gpxFileBA`. Chaque chapitre porte également une
jonction par sens vers le prochain chapitre réellement parcouru. Ces données
sont liées au SHA-256 binaire des médias : remplacer un GPX les rend périmées
et ferme le Builder jusqu’à une nouvelle revue.

Le coupe-circuit `Global.gpxBuilderEnabled` est requis et vaut `false` par
défaut. L’activer ou publier un chapitre alors qu’il est actif déclenche la
validation de toute la boucle publiée. Le CMS refuse une ancre non validée,
un ordre incohérent, une empreinte étrangère ou une jonction non qualifiée.

Commencer obligatoirement par le dry run :

```bash
npm run prepare:gpx-anchors
```

Le rapport `.tmp/gpx-anchor-report.json` contient, par chapitre et par sens,
les empreintes, candidats ordonnés, ambiguïtés, jonctions et snapshot `before`.
Il ne contient pas de secret. Copier
`scripts/gpx-anchor-resolutions.example.json`, puis renseigner uniquement les
candidats et écarts effectivement relus :

```bash
npm run prepare:gpx-anchors -- \
  --resolutions /chemin/gpx-anchor-resolutions.json
```

Dans chaque sens, le premier et le dernier passage ordonnés sont ancrés
directement sur les deux extrémités du média GPX officiel. Leur ville sert à
nommer la frontière de chapitre, pas à reprojeter cette frontière vers le
centre de la commune. Pour chaque passage intermédiaire, le chaînage du
premier passage AB vient du jeu contrôlé du 19 juillet 2026 et est interpolé
sur le segment original, jamais sur une coordonnée saisie à la main. Le point
BA est ensuite rapproché de ce même arrêt AB sur le média directionnel BA,
sous contrainte d'ordre. Les empreintes AB du jeu contrôlé doivent correspondre
exactement aux médias courants, sinon la commande bloque le chapitre.

Une frontière de chapitre correspond à un même lieu éditorial dans les deux
sens, même si les médias et leurs extrémités restent directionnels. Le tableau
`junctionPairs` permet donc de renseigner une seule fois la ville, le repère
(`train_station` ou `landmark`), les chapitres porteurs AB et BA et la décision.
La commande développe cette décision en deux jonctions techniques portant la
même note de revue. Le format historique `junctions` reste accepté pour un cas
réellement propre à un seul sens.

Les cinq écarts actuellement relevés sont préparés, mais pas appliqués, dans
`scripts/gpx-anchor-resolutions.gthf-junctions.json`. Arras, Hirson, Soissons
et Lille utilisent leur gare ; Condé-sur-l’Escaut utilise le point près des
fortifications. Ce fichier ne valide aucun des 466 ancrages de passage et ne
doit donc pas être utilisé avec `--apply` avant leur revue.

Le fichier `scripts/gpx-anchor-resolutions.gthf.json` contient la revue
complète liée aux empreintes courantes : 466 ancrages directionnels et les
cinq décisions de jonction partagées. Il reste inutilisable si un candidat ou
un média change, car la clé de candidat inclut le SHA-256 de la source.

Après revue du nouveau rapport, l’application locale exige une double option
et ne modifie que les brouillons de chapitre :

```bash
npm run prepare:gpx-anchors -- \
  --resolutions /chemin/gpx-anchor-resolutions.json \
  --apply \
  --confirm-apply
```

L’exécution distante historique sur Clever suit le même ordre après une
sauvegarde PostgreSQL réussie. Le dry run reste sans écriture ; l’application distante exige les
trois confirmations explicites :

```bash
npm run prepare:gpx-anchors:remote -- \
  --allow-self-signed-tls \
  --resolutions /chemin/gpx-anchor-resolutions.json

npm run prepare:gpx-anchors:remote -- \
  --allow-self-signed-tls \
  --resolutions /chemin/gpx-anchor-resolutions.json \
  --apply \
  --confirm-apply \
  --confirm-remote
```

Comme la migration PRD 02, la commande distante lit avec la CLI Clever
l’endpoint PostgreSQL externe `DIRECT_*` et conserve les secrets uniquement
en mémoire. Elle ne demande ni variables `*_REMOTE` dans `.env`, ni saisie de
coordonnées GPS. Les options `--cities` et `--chapters` permettent d’indiquer
les deux CSV si les dépôts ne sont pas voisins à leurs emplacements habituels.
L’exception TLS reste explicite parce que l’endpoint externe actuel présente
un certificat auto-signé.

Le script ne publie aucun chapitre et n’active jamais le Builder. Après
application, relire les brouillons, publier l’ensemble cohérent, exécuter les
recettes AB et BA depuis le frontend, puis seulement activer le coupe-circuit.
Un second passage avec les mêmes résolutions doit être idempotent.

Les mesures géométriques des composants `gpx-anchor` et `gpx-junction`
utilisent le type Strapi `float`, stocké en `double precision` dans PostgreSQL.
Le type Strapi `decimal` ne convient pas ici : sa précision par défaut
`numeric(10,2)` arrondit notamment les coordonnées et la fraction de segment.
Après le déploiement d’un changement de ce type, réappliquer les résolutions
aux brouillons pour restaurer les valeurs issues des GPX, puis exiger un second
passage entièrement inchangé avant toute publication. Un rollback immédiat
désactive le Builder et conserve ces colonnes en double précision ; il ne les
reconvertit pas en `decimal`.

Pour revenir en arrière, laisser ou remettre le coupe-circuit à `false`, puis
restaurer les valeurs `before` du rapport conservé ou la sauvegarde PostgreSQL.
Ne pas supprimer les champs additifs ni les médias dans un rollback immédiat.

### Dry run local du 6 août 2026

Sur la copie locale synchronisée, la commande a inspecté les dix chapitres et
proposé 466 ancrages sans écriture, blocage ni erreur. Le rapport demande une
revue renforcée pour 179 ancrages. Les dix jonctions exactes sont calculées
automatiquement ; les dix jonctions non exactes correspondent à cinq lieux
physiques. Le dry run avec le fichier de paires les qualifie toutes en
`accepted_gap`, avec le même repère dans les deux sens, sans écriture ni
erreur. Ce résultat valide la préparation des jonctions, pas les propositions
d’ancrage : il ne doit pas être transformé en `--apply` avant leur revue.

### Dry run de production du 6 août 2026

Après déploiement du schéma, la commande distante utilisant l’endpoint
PostgreSQL externe Clever a inspecté les dix chapitres et calculé les 466
ancrages sans écriture, blocage ni erreur. Le jeu contrôlé couvre les 426
passages intermédiaires directionnels ; les 40 frontières reprennent les
extrémités exactes. Le rapprochement BA reste inférieur à 362 m pour tous les
arrêts. Les trois concurrences restantes — Marœuil, Avesnes-sur-Helpe et
Cayeux-sur-Mer en BA — ont été résolues par proximité avec l’arrêt AB et
cohérence de chaînage. Le dry run final retrouve 466 résolutions `validated`,
dix jonctions exactes et dix jonctions acceptées correspondant aux cinq lieux
éditoriaux, avec zéro proposition, blocage, ancrage périmé ou erreur.

### Validation locale

Avec PostgreSQL disponible et le schéma chargé, les validations pures et le
smoke test Strapi se lancent ainsi :

```bash
npm test
npm run test:integration:prd01
```

Le smoke test vérifie le refus d'une ville incomplète, l'immutabilité du slug
après publication et le refus d'un chapitre aux passages invalides. Ses
documents QA temporaires sont supprimés avant la fin du test.

## Provisionnement PRD05 du rôle DataMaster

Le rôle d’administration `DataMaster` sépare la qualification du catalogue de
la contribution éditoriale, sans modifier les rôles de l’API publique ni
affecter automatiquement un compte. Le provisionnement est idempotent et reste
en lecture seule par défaut. Il réserve également au DataMaster les ancrages et
jonctions GPX techniques imbriqués dans les chapitres, sans retirer aux rôles
éditoriaux leurs autres champs de chapitre :

```bash
npm run provision:datamaster
npm run provision:datamaster -- --apply --confirm-apply
```

Après l’application, un second dry-run doit annoncer
`"changesRequired": false`. L’affectation du rôle et la recette avec deux
comptes restent manuelles. La matrice exacte, les protections serveur, le
protocole de recette et le rollback sont détaillés dans
[`docs/prd05-datamaster-rbac.md`](docs/prd05-datamaster-rbac.md).

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## Déploiement de production

Les images sont d'abord construites et importées dans MicroK8s, puis activées
avec Ansible et Kustomize depuis le dépôt frontend. Suivre la section
[Image de production autohébergée](#image-de-production-autohébergée) et le
[runbook infra](https://github.com/thedamfr/gthf-frontend/blob/main/infrastructure/README.md).
La commande npm `deploy` existe encore dans `package.json`, mais appelle
`strapi deploy` : elle ne déploie pas ce cluster OVH. Le hook
`.clevercloud/post_build.sh` est conservé pour l'ancien hébergement ; il ne
constitue pas une automatisation de livraison OVH.

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0-or-later).
See the LICENSE file for the full license text.
