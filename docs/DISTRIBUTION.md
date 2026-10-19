# Distribution et versions compatibles

Cette documentation accompagne le candidat Companion **3.7.2** préparé pour
le parcours vérifiable. Un artefact local construit et testé n'est pas une
version publiée. Utiliser le fichier et l'empreinte indiqués dans le dossier
de livraison ; `@latest` et les pins d'un plugin peuvent désigner une autre version.

## Installer un artefact préparé

Dans un répertoire jetable, installer le tarball exact sans scripts de cycle
de vie, puis invoquer son propre point d'entrée :

```sh
npm install --prefix /chemin/installation --ignore-scripts /chemin/snipara-companion-3.7.2.tgz
/chemin/installation/node_modules/.bin/snipara-companion --help
```

Les dépendances npm doivent être disponibles dans le cache ou sur le registre.
Cette installation ne publie rien, ne configure aucun compte Snipara et ne
lance pas d'agent. Conserver le tarball avec son SHA-256. Une mise à jour du
source demande de reconstruire, tester et revoir un nouvel artefact.

Le build CommonJS embarque les graphes des dépendances runtime ESM pour rester
chargeable sous Node 18. Le miroir source conserve la même configuration de
construction. Vérifier le véritable point d'entrée installé sur le moteur
minimal annoncé, y compris lecture/écriture de configuration, et pas seulement
sur le Node du poste de développement.

## Choisir son parcours

| Outils choisis | Point d'entrée | Limite |
| --- | --- | --- |
| Hosted MCP seul | Requêtes de contexte et mémoire via le client existant | Pas de suivi local Companion ni Controller implicite |
| Companion seul | `task start`, `task work`, `task verify`, `task decide`, `task resume` | Aucun agent Orchestrator requis ; les preuves non observées restent inconnues |
| Orchestrator seul | `task intake`, `task start`, `task show`, `task resume` | Utiliser son paquet et ses guides ; aucun Companion requis |
| Les deux | Export du workflow, bridge revu puis Controller | Conserver identités, politiques, preuves et versions ; aucun lancement implicite |

Le [guide du parcours](TASK_JOURNEY.md), le [contexte par tâche](TASK_CONTEXT.md)
et la [reprise](WORK_CONTINUITY.md) décrivent les commandes exactes. Les
opérations de tâche locales n'exigent pas une activation Hosted. Une commande
de mémoire ou de récupération distante conserve ses propres besoins d'accès.

## Contrats et reprise

Le couple préparé pour le parcours complet est Companion **3.7.2** et
Orchestrator **1.10.0**. Cela ne déclare pas toute autre paire incompatible :
les contrats effectivement présents déterminent ce que chaque lecteur accepte.

- Les anciens exports sans contexte versionné gardent leur comportement de
  référence ou de titre ; l'absence de source ne prouve pas son chargement.
- `source-context-v1` conserve le contexte et ses références riches.
  `runtime-source-context-v1` lie en plus les corps exacts du pack remis à
  chaque tâche et leur consommateur. Une version inconnue ou une liaison
  altérée doit être refusée avant création d'un Controller.
- Charger un ancien workflow ne le migre pas silencieusement en nouveau
  contrat. Garder l'original ; préparer/exporter une nouvelle copie avec les
  commandes existantes si le parcours nécessite davantage de preuves.
- Une reprise revalide dépôt, index et pièces. Un historique conservé ne
  représente pas une preuve fraîche d'un runtime encore vivant.

Avant une combinaison différente, vérifier son export avec le consommateur
exact ; un refus demande une mise à jour ou un nouvel export, sans retirer les
champs de sécurité pour faire accepter le fichier. La validation d'un bridge
ne prouve ni l'utilisation sémantique du contexte par un modèle, ni son succès.

## Vérification de livraison

Les suites publiques du dépôt peuvent cibler ce point d'entrée par
`SNIPARA_COMPANION_TEST_CLI=/chemin/installation/node_modules/snipara-companion/dist/index.js`.
Une valeur explicitement fournie mais vide, absente du disque ou invalide
échoue ; elle ne doit pas retomber sur le build du checkout. Sans cette variable,
les suites conservent leur chemin source habituel. Le reçu doit vérifier l'origine des
imports Python du wheel installé lorsque le bridge est exercé.

Les paquets create-snipara, MCP, OpenClaw et business restent indépendants.
Leurs publications ne sont requises que si leur propre comportement change.
Les pins d'un plugin et le miroir public Companion constituent des surfaces
distinctes à revalider lors d'une livraison ultérieure autorisée.

Les démonstrations connues, la campagne publique exposée et le collecteur L7
ne remplacent pas la qualification indépendante L6 ni les mesures humaines L7.
Ni installation, ni reprise, ni dossier ne fusionne ou ne déploie du code.
