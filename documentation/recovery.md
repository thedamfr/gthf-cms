# Reprise CMS après interruption

## Summary

L’issue #29 ajoute un journal média durable et conserve l’identité des réessais,
y compris pour les lots et imports URL. La qualification isolée réussit :
21 contrôles PostgreSQL, huit Golden Journeys navigateur et 14 parcours avec trois
coupures VM, aux révisions précisées en annexe. Les droits sont revérifiés avant
commit et consultation. Le workflow épingle le déployeur compatible fusionné.
Le correctif des remplacements/recadrages bêta attend sa qualification navigateur. Restent les images CI finales avant livraison ; aucune validation de production n’est annoncée.

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
après réponse perdue. L’import URL SSE utilise une clé par URL, conservée par l’admin ; chaque reçu est récupérable séparément.
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
prise par le cycle de 15 secondes. Chaque cycle réserve huit lignes aux suppressions
finies et deux aux surveillances récurrentes, triées par échéance dans leur classe :
une file plus longue allonge la redétection. Chaque clé nécessite au
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

### Qualification isolée du 14 octobre 2026

Le CMS `5a31467c6c8c8922014a2894a58828ac120bbaba` a passé 21 contrôles PostgreSQL
réels et huit Golden Journeys navigateur avec le script de cette même révision.
La campagne commune utilise le frontend et harnais
`01c80a9c95ddb7dd3868ded0b73a3802e58d9118` et le socle infra
`23a87fdcd8b0a70d855397776f532f209cc7755a` : 14/14 Golden Journeys réussis,
fin le 14 octobre à 02:04:28 UTC, trois vraies coupures QEMU et transports fermés.
Les reprises après retour des dépendances ont pris 93,234 / 94,636 / 93,211 s,
sous la cible de 300 s. Les cinq parcours de convergence frontend passent aussi.

Dans le checkout frontend à cette révision :

```sh
npm run test:e2e:recovery -- --target vm --phase qualify --manifest "$GTHF_MANIFEST"
npm run test:e2e:recovery -- --target vm --phase convergence --manifest "$GTHF_MANIFEST" --previous-manifest "$GTHF_PREVIOUS_MANIFEST"
```

Ces preuves couvrent les droits, la persistance, les opérations interrompues,
les versions médias conservées et une partition frontend–CMS de 601 s. MinIO,
la source URL synthétique et la réinjection explicite d’un PUT tardif ne qualifient
pas les fournisseurs publics. Les pertes de réponse navigateur sont injectées ;
les opérations SQL/S3 et les coupures VM sont réelles. Les rapports détaillés et
les essais échoués restent privés ; la synthèse est rattachée à la PR #32.

Ces résultats concernent les images locales de ces SHA. Le workflow épingle le
déployeur frontend `9aba52eec841ca5a412865fb2a823d198ff43bf5`, fusionné par la
PR #43 : première activation en Recreate et rollback limité aux capacités médias
v2/lots v1. Sa CI main a réussi avant la fusion CMS #32. Les images finales publiées
par les CI restent à requalifier avant staging et
production. La recette `npm run test:e2e -- staging` dépend du clone frontend
voisin ; la production utilise `npm run test:e2e -- production` en lecture seule.

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
Trois parcours supplémentaires exercent les contrôles bêta **Replace this file** et
**Crop → Apply** : réessai après perte avant envoi avec la même clé ; nouvelle sélection
volontaire avec clé neuve, réponse perdue après commit puis reçu après rechargement
sans second POST ; recadrage persistant et reçu interdit au lecteur anonyme. La
révocation des droits courants est aussi vérifiée par les tests du client et les
parcours serveur de la campagne commune. Ces nouveaux parcours doivent être exécutés
sur la révision corrective ; les huit succès historiques ci-dessus ne les couvrent pas.
Aucune coupure VM n’est effectuée par cette commande. Les médias synthétiques
créés restent conservés pour les vérifications SQL/S3 et le nettoyage final du banc.

### Golden Journeys navigateur URL

La suite comporte huit parcours médias, remplacement et recadrage. L’option suivante ajoute trois
Golden Journeys URL : sélections volontaires/URL dupliquées aux clés distinctes,
interruption avant envoi puis reprise de la même entrée après rechargement, et
flux perdu après commit puis reçu retrouvé sans second POST.

```sh
npm run test:e2e:media-admin -- --campaign UUID --manifest /CHEMIN/PRIVE/manifest.json --url-fixture /CHEMIN/PRIVE/url-fixture.json
```

Le fichier privé, dans le même répertoire de campagne que le manifeste, contient
`{"campaignId":"UUID","url":"http://203.0.113.42:9000/BUCKET/CLE"}`. Il est produit
seulement après validation du routage réel par `withUrlFixture`, dans le harnais
frontend `scripts/recovery/url-fixture.mjs`. Le Service temporaire appartient à la
VM synthétique et à la campagne ; son retrait est conditionné par son UID.
L’URL vise un objet synthétique du bucket de cette campagne, sans query string.
Ce banc conserve le contrôle SSRF de Strapi et n’autorise pas l’egress public ; il
qualifie une source HTTP du banc, pas un fournisseur public distant.

Le navigateur active la médiathèque bêta uniquement dans son propre contexte
Playwright afin d’exercer le flux serveur SSE. Cette option ne modifie aucun
réglage de l’application. La médiathèque historique télécharge les URL dans le
navigateur puis utilise l’upload multipart déjà journalisé ; ce chemin distinct
reste protégé par ses reçus multipart. Sans `--url-fixture`, le rapport indique
explicitement que les trois parcours URL n’ont pas été exécutés. Avec cette option,
la suite attend onze succès ; sans elle, huit.

### Remplacement et recadrage dans la médiathèque bêta

Le transport `replaceAsset` de Strapi 5.52.3 est adapté au même journal client que
les autres mutations. Le bouton de remplacement et **Crop → Apply** conservent le
multipart natif et les métadonnées. Une sélection native `File` garde sa clé tant
que propriétaire, cible et métadonnées restent identiques ; sélectionner à nouveau
le même fichier crée un nouvel objet `File` et une nouvelle intention. Les reçus
sont consultés avant de répéter une intention connue, y compris après rechargement.
Un refus de permission courant reste un refus ; un échec de `sessionStorage`
empêche l’envoi. Les octets du fichier ne sont pas conservés côté navigateur.

```sh
npm exec tsx -- --test tests/media-admin-replacement.test.ts tests/media-admin-adapter.test.ts
```

Ces tests exécutent les modules Strapi réellement adaptés et le client de reprise.
Le transport HTTP et le stockage navigateur y sont simulés ; la commande navigateur
ci-dessus apporte la preuve SQL/S3 et des interactions réelles sur le banc isolé.

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
vraies transactions PostgreSQL. Deux contrôles supplémentaires saturent le petit pool
du Job, puis observent et annulent un vrai `pg_sleep` : ils journalisent le délai de
503, la fin réelle de la requête et le retour à 200, sans modifier la configuration
PostgreSQL. Les suppressions S3 et les vrais SIGKILL restent
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
surcharges de connexion `DATABASE_URL` et `POSTGRESQL_ADDON_URI/HOST/DB/PORT` sont refusées.
Le banc exige aussi `DATABASE_HOST=postgres`, port `5432` et schéma `public` ;
un autre endpoint ou schéma ne peut pas activer les pauses, même avec le bon nom de base.
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


### Événements informatifs après commit

Les créations, remplacements et suppressions acquittés émettent les événements
Strapi habituels ; un lot conserve aussi `media-folder.delete` et la métrique de
suppression multiple. Seul le processus qui vient de committer les émet : le
rejeu d’un reçu ne relance pas ces effets. Ils restent informatifs et best-effort,
comme les hooks du fournisseur : une coupure entre commit et émission peut perdre
un événement. Le reçu SQL et la reprise métier ne dépendent pas de leur livraison.


### Import URL SSE et reçus individuels

`POST /upload/actions/upload-from-urls` reçoit `{urls, folderId, operationKeys}` :
1 à 20 URL HTTP(S), autant de clés UUID distinctes et un dossier positif ou `null`.
L’absence des clés renvoie `409 ADMIN_RELOAD_REQUIRED` avant les en-têtes SSE.
Les URL normalisées et le dossier sont liés par une empreinte au reçu `upload`.
Chaque entrée est indépendante : le client peut reprendre une seule URL avec sa
clé, sans nouvelle table de lot. Les propriétaires, droits courants et conflits
sont vérifiés avant le flux puis avant chaque entrée. Un reçu committed est rendu
avant tout téléchargement ; pending/failed ne déclenchent pas de refetch.

Un reçu interrupted permet une nouvelle tentative immuable de la même URL. Si la
source distante a changé entre ces tentatives, les octets peuvent changer avant
le premier commit réussi ; un résultat déjà committed reste définitivement le
résultat de cette intention. Une nouvelle sélection volontaire utilise une autre
clé, même pour une URL identique. Le service de téléchargement Strapi conserve ses
protections SSRF, taille, durée et MIME. Les erreurs de dépendance ne publient pas
de détails de connexion.

Les événements SSE conservent `file:fetching`, `file:uploading`, `file:complete`,
`file:error` et `stream:complete`. Complete/error ajoutent `operationKey` ; complete
indique `replayed`, error indique `code` et `retryable`. L’admin consulte le reçu
avant de renvoyer et ne relance pas la génération de métadonnées sur un replay.
Une coupure du flux peut laisser certaines entrées sans tentative : leurs clés
persistées permettent de les distinguer des entrées déjà committed.


### Capacité et baux du nettoyage

Chaque cycle réserve huit lignes aux suppressions finies et deux aux surveillances
récurrentes de PUT tardif. Une accumulation d’intentions abandonnées ne prend donc
pas toute la capacité des suppressions explicites ; les deux classes progressent.
Le balayage récurrent est replanifié à au moins 60 s, pas garanti toutes les 60 s
si le nombre d’intentions ou la latence S3 dépasse la capacité. Son retard augmente
avec cette charge ; aucune borne de débit illimité n’est promise.

Le bail cleanup est renouvelé toutes les 15 s pendant le traitement, vérifié avant
chaque HEAD/DELETE S3 et à la finalisation. Un propriétaire expiré ne peut pas
renouveler son ancien bail ni finaliser la ligne. L’arrêt gracieux attend également
le renouvellement actif. Un appel S3 déjà envoyé peut finir après perte du bail,
mais il porte uniquement sur la clé immuable de la tentative nettoyée.
