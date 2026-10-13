# Reprise CMS après interruption

## Summary

L’issue #29 ajoute un journal média durable et un réessai conservant la même
intention, y compris pour les suppressions groupées et de dossiers. Le backend et l’adaptateur admin sont implémentés ; la qualification
réelle PostgreSQL, S3 et navigateur reste en cours dans une VM synthétique.
Aucune panne ni livraison n’est validée en production. Les droits sont revérifiés
avant commit et consultation. L’import URL de la médiathèque bêta inactive reste
hors garantie de réessai client.

## Synthèse

Une intention d’envoi porte une clé UUID `Idempotency-Key`. Une sélection
obtient une nouvelle clé, même pour un contenu identique. Une reprise
réutilise la clé précédente ; réutiliser cette clé avec un autre payload est un
conflit. La version d’origine du média remplacé/supprimé reste ancrée entre
tentatives : un réessai ne peut pas écraser une modification concurrente. Le journal PostgreSQL doit précéder tout effet S3, et le reçu final doit
être transactionnel avec le fichier Strapi. Les objets portent des clés immuables
par tentative. Les originaux et variantes sont hashés et déposés dans un répertoire
privé, puis envoyés en flux après journalisation : les corps du lot ne
sont pas conservés ensemble dans le heap. Ce spool est supprimé après traitement ;
les versions remplacées sont conservées tant que le fichier logique existe. Sa
suppression explicite libère toutes ses versions après validation SQL. Les anciennes
URL restent donc lisibles, et le stockage augmente avec les remplacements : remplacer
une image ne révoque pas ses anciennes versions, il faut supprimer le média. Les clés de tentatives
interrompues restent surveillées durablement : un PUT dont la réponse a expiré peut
encore aboutir côté S3 après une première vérification d’absence. Ce suivi implique
des lectures S3 récurrentes et une croissance du journal, explicitées ci-dessous.

Le résultat public d’une opération est `pending`, `committed`, `interrupted` ou
`failed`. Une opération complète côté stockage peut être finalisée après redémarrage.
Un transfert incomplet dont les octets temporaires ont disparu devient explicitement
interrompu : il n’est jamais annoncé réussi. Le client peut reprendre la même
intention. Avant commit, la révocation certaine des droits rend l’opération `failed`
avec `AUTHORIZATION_REVOKED` ; une panne de vérification la laisse en attente.
Les reçus déjà validés restent stables et ne sont consultables que par leur propriétaire
actuellement autorisé. Le journal ne conserve aucun token ni relation admin privée.

Les suppressions groupées figent leurs fichiers et dossiers avant le premier effet.
Un reçu parent conserve la progression des enfants : une coupure reprend les mêmes
clés, une révocation laisse un résultat partiel explicite. Un fichier ajouté ensuite
au dossier reste intact et empêche sa suppression. Les dossiers et le reçu final
sont validés ensemble, après tous les fichiers, dans une transaction courte.

Le réconciliateur passe toutes les 15 secondes, avec bail de 90 secondes et
contrôle de propriété avant validation. L’arrêt gracieux attend les mutations,
le cycle actif et ses heartbeats avant de fermer S3 puis le pool PostgreSQL. La cible de reprise après retour des
dépendances est de 300 secondes ; elle doit être mesurée par les Golden Journeys.
Les pauses de faute sont inactives par défaut et refusent une base de production.
L’arrêt brutal est effectué par le contrôleur externe de qualification.

## Annexes

### Qualification et état des preuves

Premiers contrôles reproductibles :

```sh
npm exec tsx -- --test tests/release-health.test.ts tests/recovery-fault-gate.test.ts
```

Tests de reprise ciblés :

```sh
npm exec tsx -- --test tests/media-recovery.test.ts tests/media-admin-recovery.test.ts tests/media-admin-adapter.test.ts
npm run build
```

L’adaptation admin est limitée aux modules privés Strapi 5.52.3 listés dans
`ADMIN_CONTRACTS`, vérifiés par SHA256
avant build. Le fichier `scripts/recovery/admin-adapter.ts` transforme leurs points
de transport dans Vite ; aucun prototype global ni dépendance installée n’est modifié.
La page **Reprise des médias** retrouve les intentions de l’onglet après rechargement.
`sessionStorage` garde propriétaire, UUID, métadonnées et résultat, jamais le token ou
les octets. Après perte des fichiers temporaires, sélectionner à nouveau les mêmes
fichiers reprend la clé ; une sélection normale dans la médiathèque crée une nouvelle
intention. Une panne de stockage de session bloque l’envoi avant tout effet réseau. Les anciens
onglets admin sont refusés avant mutation unitaire ou suppression groupée avec `409 ADMIN_RELOAD_REQUIRED` ;
il faut actualiser l’administration. Le déploiement initial doit éviter la coexistence
de writers CMS anciens et nouveaux, car l’ancienne version ignore les clés.

Les services médias sont toujours journalisés, y compris depuis l’API, l’import URL
et la suppression groupée. Les clients API hors admin peuvent omettre la clé :
une nouvelle clé est alors créée, sans garantie de dédupliquer un nouveau POST
après réponse perdue. L’import URL de l’interface bêta inactive est hors garantie de réessai client.
La suppression groupée admin exige sa clé dès le contrôleur, même pour un dossier vide.
Le protocole parent et ses limites sont détaillés ci-dessous.

`npm run test:recovery:journal` charge Strapi puis draine uniquement le worker de
ce processus de test, avant les expirations artificielles de bail. Son helper
interne exige tous les garde-fous VM ; aucune option générale ne désactive le
réconciliateur normal. Exécuter ce Job avant les pods CMS permanents du banc.

Les tables privées `gthf_media_operations`, `gthf_media_cleanup` et
`gthf_media_batches` sont additives.
Les reçus sont accessibles sous `/upload/recovery/operations/:key`, avec session admin,
propriété de l’intention et vérification des permissions conditionnelles actuelles.
Avant tout commit encore en attente, y compris autonome, les droits du principal sont
relus : admin actif et conditions, token non révoqué/non expiré avec son périmètre,
utilisateur API actif avec son rôle. Un refus certain devient `failed` avec
`AUTHORIZATION_REVOKED` et nettoie les nouveaux objets ; une panne de lecture laisse
l’opération en attente. Un reçu déjà `committed` reste inchangé. Les déconnexions de
session ne révoquent pas à elles seules une intention déjà autorisée ; les identités
et droits actuels sont relus sans conserver de jeton. Les jobs internes sans principal
délégué restent des opérations de confiance du processus. Les sujets persistés ne
conservent que les identifiants des relations admin, jamais leurs mots de passe.
Strapi désactive le parseur JSONB PostgreSQL : le journal décode donc explicitement
ses colonnes JSON privées, sans modifier le parseur global.

Les objets étrangers détectés par checksum sont préservés et l’opération échoue
explicitement ; le nettoyage ne détruit jamais ces collisions. Les nettoyages d’anciens objets committés sont retirés après vérification, tandis que
les reçus restent conservés. Les clés abandonnées (y compris après révocation des
droits) gardent une ligne `recurring=true`, état `pending`, sans bail entre deux
contrôles : une première absence ne prouve pas qu’un PUT serveur ne finira pas plus tard.
Après chaque balayage, la prochaine vérification est planifiée à 60 secondes, puis
prise par le cycle de 15 secondes. Le budget reste huit nettoyages par cycle, triés
par échéance : une file plus longue allonge la redétection. Chaque clé nécessite au
moins un HEAD par balayage ; un objet tardif possédé ajoute DELETE puis HEAD. Le coût
et le volume de ces suivis augmentent donc avec les tentatives interrompues. Ils ne
sont pas purgés automatiquement faute de borne attestée de terminaison du PUT serveur.
Les nouvelles tentatives ont d’autres clés ; les collisions étrangères restent intactes.
Les versions remplacées portent `retain_file_id` et ne sont pas sondées sur S3 tant
que ce fichier existe. Cela couvre les caches publics longs et leur fallback pendant
une partition réseau, sans diminuer la disponibilité. Le DELETE autorisé du fichier
libère les nettoyages de toutes les versions, qui restent reprenables après crash.
La migration additive rattache les nettoyages de remplacements encore présents à leur
fichier ; elle ne recrée pas des objets déjà supprimés avant cette version.
L’image annonce `io.gthf.media-recovery=2` : un runtime v1 ignore cette rétention et ne
doit jamais être utilisé en rollback dès présence de `retain_file_id`.
Le protocole des lots exige en plus `io.gthf.media-batch-recovery=1` ; les images
intermédiaires sans ce label ne sont pas des cibles de rollback compatibles.

La commande E2E existante reste `npm run test:e2e -- staging`, dépendante du clone
frontend voisin. La campagne isolée et ses preuves de SIGKILL, réponse perdue,
indisponibilité des dépendances et deuxième crash sont en préparation. Elles doivent
indiquer les SHA CMS/frontend, les délais, les permissions et les limites.

### Golden Journey navigateur admin

Avec le CMS du manifeste déjà prêt et son tunnel loopback ouvert par le contrôleur :

```sh
npm run test:e2e:media-admin -- --campaign UUID --manifest /CHEMIN/PRIVE/manifest.json
```

Le script exige un checkout propre, la campagne VM synthétique et la révision CMS
exacte. Il utilise Playwright installé sur l’hôte, Chromium avec sandbox, le seul
CMS `127.0.0.1:33137` et MinIO `127.0.0.1:33190`. Les identifiants synthétiques sont
lus dans `credentials.json` à côté du manifeste, jamais affichés. Les rapports,
traces et captures restent privés sous le répertoire de campagne.

Les interactions réelles sélectionnent deux fois le même fichier avec deux UUID,
reprennent un transfert interrompu avec le même UUID, puis rechargent la page des
reçus après une réponse de commit perdue. Deux autres Golden Journeys utilisent
la vraie sélection groupée de deux fichiers et un dossier : réessai avant envoi,
puis réponse perdue avec reçu parent après rechargement. Ces pertes réseau sont simulées dans
Playwright et restent distinctes des vrais SIGKILL/coupures QEMU de la campagne.
Aucune coupure VM n’est effectuée par cette commande. Les médias synthétiques
créés restent conservés pour les vérifications SQL/S3 et le nettoyage final du banc.

### Suppression groupée : parent durable et périmètre figé

`POST /upload/actions/bulk-delete` reçoit `{fileIds: number[], folderIds: number[]}`
et `Idempotency-Key`. Les IDs positifs sont triés et dédupliqués. Le snapshot persiste
les versions des fichiers, IDs des créateurs, dossiers descendants et clés enfants
avant toute suppression. Le même UUID ne peut désigner à la fois une opération et
un lot : un verrou PostgreSQL par clé protège les deux journaux contre cette course.

Le parent `gthf_media_batches` a les états `pending`, `committed`, `failed`, un bail
propriétaire de 90 s et la reprise normale toutes les 15 s. Les enfants utilisent
les transactions et nettoyages médias existants, séquentiellement. Chaque commit et
chaque consultation réévalue les droits actuels ; les descendants ne contournent
pas les permissions conditionnelles de leur créateur. Une sélection nouvelle a une
clé nouvelle ; confirmer ou reprendre la même sélection conserve sa clé et son payload.

Le reçu unifié `/upload/recovery/operations/:key` annonce `kind=bulk-delete`,
`retryable=false`, `progress={total,committed,failed,children}` avec les IDs, clés et
états de chaque enfant. Seul `committed` comporte `result={files,folders}`. Un reçu
partiel conserve les fichiers déjà supprimés et identifie ce qui reste ; il ne vaut
pas réussite du lot. La page admin mémorise cette progression et consulte le reçu
avant toute reprise après rechargement. Un reçu absent permet le même POST ; une
réponse DB incertaine ne permet jamais un nouvel envoi aveugle.

La finalisation des dossiers s’exécute après tous les commits enfants, sans S3 dans
la transaction. Les tables fichiers, dossiers et leurs liaisons sont brièvement
verrouillées en écriture (`lock_timeout=1.5s`, `statement_timeout=3s`) ; les lectures
restent possibles. Le périmètre et l’absence de nouveaux fichiers sont relus avant
la suppression des seuls dossiers figés et le commit du reçu parent. Une contention
reste en attente ; un déplacement, un changement de dossier ou un nouveau contenu
rend le lot `failed/FOLDER_CHANGED` et conserve les nouveaux éléments. Aucun réessai
ne redécouvre puis supprime automatiquement un périmètre plus large.

`npm run test:recovery:journal` couvre aussi collisions d’identités, bail parent,
crash simulé après premier enfant, reprise unique, refus des droits actuels,
contenu concurrent préservé et rollback du DELETE dossier avec le reçu. Ce sont de
vraies transactions PostgreSQL ; les suppressions S3 et les vrais SIGKILL restent
qualifiés séparément dans la campagne VM.

### Protocole des pauses de qualification

Les six paramètres sont obligatoires ensemble :

- `GTHF_RECOVERY_ISOLATED=true` ;
- `GTHF_RECOVERY_CAMPAIGN=<UUID>` ;
- `DATABASE_CLIENT=postgres` ;
- `DATABASE_NAME=gthf_recovery_<UUID sans tirets>` ;
- `GTHF_RECOVERY_NAMESPACE=gthf-recovery`, injecté depuis `metadata.namespace` ;
- `GTHF_RECOVERY_FAULT_DIR=<chemin absolu persistant dans la VM>`.

Le répertoire contient obligatoirement `campaign.json` avant le démarrage :

```json
{"campaignId":"<UUID>","databaseName":"gthf_recovery_<UUID sans tirets>","namespace":"gthf-recovery","isolated":true}
```

Ces valeurs doivent correspondre exactement aux variables du processus. Les
surcharges de connexion `DATABASE_URL` et `POSTGRESQL_ADDON_URI/HOST/DB` sont refusées.
Le contrôleur écrit `gate.json` avec `campaignId`, `key`, `point` et facultativement
`objectIndex`. Les points sont `after-journal`, `after-object`, `before-commit`,
`after-commit`, `during-cleanup`, `after-batch-child`. Ce dernier porte la clé et
la tentative du parent, et `objectIndex=0` après le premier fichier validé. Le CMS revendique ce fichier et publie
`observed.json` avant d’attendre. Le fichier et son répertoire sont synchronisés
sur le disque (`fsync`) avant la pause ; la qualification doit aussi conserver
les marqueurs côté contrôleur pour les pertes du support complet. Le contrôleur tue alors le processus ou la VM.
Pour un témoin sans panne, `release.json` reprend campagne, clé, point, `attempt`
et `objectIndex` exacts de l’observation. Il est consommé et synchronisé après usage
pour ne pas libérer une deuxième pause par erreur.
Aucun header HTTP ne permet d’activer ces pauses.
