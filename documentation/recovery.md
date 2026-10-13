# Reprise CMS après interruption

## Summary

L’issue #29 ajoute un journal média privé, une reprise bornée après interruption et
une identité conservée lors du réessai d’un envoi. La qualification utilise une VM
isolée et des données synthétiques. Cette branche est en cours de développement :
aucune panne n’a été injectée en production, aucune livraison n’est encore validée.
Le contrôle `/api/release` borne déjà l’attente de la base et demande l’annulation
SQL ; ses tests unitaires ne constituent pas une preuve de reprise réelle.

## Synthèse

Une intention d’envoi porte une clé UUID `Idempotency-Key`. Une nouvelle sélection
volontaire obtient une nouvelle clé, même pour un contenu identique. Une reprise
réutilise la clé précédente ; réutiliser cette clé avec un autre payload est un
conflit. Le journal PostgreSQL doit précéder tout effet S3, et le reçu final doit
être transactionnel avec le fichier Strapi. Les objets portent des clés immuables
par tentative ; les anciens objets ne sont nettoyés qu’après validation SQL.

Le résultat public d’une opération est `pending`, `committed`, `interrupted` ou
`failed`. Une opération complète côté stockage peut être finalisée après redémarrage.
Un transfert incomplet dont les octets temporaires ont disparu devient explicitement
interrompu : il n’est jamais annoncé réussi. Le client peut reprendre la même
intention. Un reçu ne peut être consulté que par son propriétaire autorisé.

Le réconciliateur est prévu toutes les 15 secondes, avec bail de 90 secondes et
contrôle de propriété avant validation. La cible de reprise après retour des
dépendances est de 180 secondes ; elle doit être mesurée par les Golden Journeys.
Les pauses de faute sont inactives par défaut et refusent une base de production.
L’arrêt brutal est effectué par le contrôleur externe de qualification.

## Annexes

### Qualification et état des preuves

Premiers contrôles reproductibles :

```sh
npm exec tsx -- --test tests/release-health.test.ts tests/recovery-fault-gate.test.ts
```

La commande E2E existante reste `npm run test:e2e -- staging`, dépendante du clone
frontend voisin. La campagne isolée et ses preuves de SIGKILL, réponse perdue,
indisponibilité des dépendances et deuxième crash sont en préparation. Elles doivent
indiquer les SHA CMS/frontend, les délais, les permissions et les limites.

### Protocole des pauses de qualification

Les quatre paramètres sont obligatoires ensemble :

- `GTHF_RECOVERY_ISOLATED=true` ;
- `GTHF_RECOVERY_CAMPAIGN=<UUID>` ;
- `DATABASE_NAME=gthf_recovery_<identifiant>` ;
- `GTHF_RECOVERY_FAULT_DIR=<chemin absolu persistant dans la VM>`.

Le contrôleur écrit `gate.json` avec `campaignId`, `key`, `point` et facultativement
`objectIndex`. Les points sont `after-journal`, `after-object`, `before-commit`,
`after-commit`, `during-cleanup`. Le CMS revendique ce fichier et publie
`observed.json` avant d’attendre. Le contrôleur tue alors le processus ou la VM.
Pour un témoin sans panne, `release.json` reprend campagne, clé et point exacts.
Aucun header HTTP ne permet d’activer ces pauses.
