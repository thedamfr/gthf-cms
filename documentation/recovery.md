# Reprise CMS après interruption

## Summary

L’issue #29 ajoute un journal média privé, une reprise bornée après interruption et
une identité conservée lors du réessai d’un envoi. La qualification utilise une VM
isolée et des données synthétiques. Le backend et l’adaptateur admin sont implémentés ; la qualification réelle reste en cours :
aucune panne n’a été injectée en production, aucune livraison n’est encore validée.
Le contrôle `/api/release` borne déjà l’attente de la base et demande l’annulation
SQL ; ses tests unitaires ne constituent pas une preuve de reprise réelle. Les
envois depuis URL de la médiathèque bêta inactive restent hors garantie de réessai client.

## Synthèse

Une intention d’envoi porte une clé UUID `Idempotency-Key`. Une nouvelle sélection
volontaire obtient une nouvelle clé, même pour un contenu identique. Une reprise
réutilise la clé précédente ; réutiliser cette clé avec un autre payload est un
conflit. La version d’origine du média remplacé/supprimé reste ancrée entre
tentatives : un réessai ne peut pas écraser une modification concurrente. Le journal PostgreSQL doit précéder tout effet S3, et le reçu final doit
être transactionnel avec le fichier Strapi. Les objets portent des clés immuables
par tentative ; les anciens objets ne sont nettoyés qu’après validation SQL.

Le résultat public d’une opération est `pending`, `committed`, `interrupted` ou
`failed`. Une opération complète côté stockage peut être finalisée après redémarrage.
Un transfert incomplet dont les octets temporaires ont disparu devient explicitement
interrompu : il n’est jamais annoncé réussi. Le client peut reprendre la même
intention. Un reçu ne peut être consulté que par son propriétaire autorisé.

Le réconciliateur est prévu toutes les 15 secondes, avec bail de 90 secondes et
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

L’adaptation admin est limitée à six modules privés Strapi 5.52.3, vérifiés par SHA256
avant build. Le fichier `scripts/recovery/admin-adapter.ts` transforme leurs points
de transport dans Vite ; aucun prototype global ni dépendance installée n’est modifié.
La page **Reprise des médias** retrouve les intentions de l’onglet après rechargement.
`sessionStorage` garde propriétaire, UUID, métadonnées et résultat, jamais le token ou
les octets. Après perte des fichiers temporaires, sélectionner à nouveau les mêmes
fichiers reprend la clé ; une sélection normale dans la médiathèque crée une nouvelle
intention. Une panne de stockage de session bloque l’envoi avant tout effet réseau. Les anciens
onglets admin sont refusés avant mutation unitaire avec `409 ADMIN_RELOAD_REQUIRED` ;
il faut actualiser l’administration. Le déploiement initial doit éviter la coexistence
de writers CMS anciens et nouveaux, car l’ancienne version ignore les clés.

Les services médias sont toujours journalisés, y compris depuis l’API, l’import URL
et la suppression groupée. Sans clé fournie par le client, une nouvelle clé est
créée : ces appels ne promettent pas de dédupliquer un nouveau POST après réponse
perdue. L’import URL de l’interface bêta inactive est hors garantie de réessai client.
La suppression groupée attend tous les commits médias avant de supprimer les dossiers ;
une coupure peut laisser un dossier partiellement vidé, sans référence recréée.

`npm run test:recovery:journal` charge Strapi puis draine uniquement le worker de
ce processus de test, avant les expirations artificielles de bail. Son helper
interne exige tous les garde-fous VM ; aucune option générale ne désactive le
réconciliateur normal. Exécuter ce Job avant les pods CMS permanents du banc.

Les tables privées `gthf_media_operations` et `gthf_media_cleanup` sont additives.
Les reçus sont accessibles sous `/upload/recovery/operations/:key`, avec session admin,
propriété de l’intention et vérification des permissions conditionnelles actuelles.
Les objets étrangers détectés par checksum sont préservés et l’opération échoue
explicitement ; le nettoyage ne détruit jamais ces collisions. Les lignes de
nettoyage terminées sont retirées, tandis que les reçus durables sont conservés.
Les objets remplacés restent disponibles dix minutes pour les pages encore en cache ;
le délai de reprise métier de 300 secondes n’abrège pas cette rétention.

La commande E2E existante reste `npm run test:e2e -- staging`, dépendante du clone
frontend voisin. La campagne isolée et ses preuves de SIGKILL, réponse perdue,
indisponibilité des dépendances et deuxième crash sont en préparation. Elles doivent
indiquer les SHA CMS/frontend, les délais, les permissions et les limites.

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
`after-commit`, `during-cleanup`. Le CMS revendique ce fichier et publie
`observed.json` avant d’attendre. Le fichier et son répertoire sont synchronisés
sur le disque (`fsync`) avant la pause ; la qualification doit aussi conserver
les marqueurs côté contrôleur pour les pertes du support complet. Le contrôleur tue alors le processus ou la VM.
Pour un témoin sans panne, `release.json` reprend campagne, clé, point, `attempt`
et `objectIndex` exacts de l’observation. Il est consommé et synchronisé après usage
pour ne pas libérer une deuxième pause par erreur.
Aucun header HTTP ne permet d’activer ces pauses.
