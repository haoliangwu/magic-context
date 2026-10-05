<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <strong>Français</strong> |
  <a href="./README.it.md">Italiano</a> |
  <a href="./README.da.md">Dansk</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.pl.md">Polski</a> |
  <a href="./README.ru.md">Русский</a> |
  <a href="./README.bs.md">Bosanski</a> |
  <a href="./README.ar.md">العربية</a> |
  <a href="./README.no.md">Norsk</a> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*Ceci est une traduction communautaire. Le [README.md](./README.md) en anglais est la source de référence et peut être plus à jour.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Contexte sans limites. Mémoire qui se gère elle-même. Une session, pour la vie.</strong><br>
  L'hippocampe pour agents de codage, partie de CortexKit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context?label=cli&color=orange&style=flat-square" alt="npm @cortexkit/magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?label=opencode&color=blue&style=flat-square" alt="npm @cortexkit/opencode-magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/pi-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/pi-magic-context?label=pi&color=purple&style=flat-square" alt="npm @cortexkit/pi-magic-context"></a>
  <a href="https://discord.gg/DSa65w8wuf"><img src="https://img.shields.io/discord/1488852091056295957?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
  <a href="https://github.com/cortexkit/magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <em>Tu n'engages pas un développeur pour une tâche avant de le congédier dès qu'il livre.<br>Arrête de faire cela à ton agent.</em>
</p>

<p align="center">
  <a href="#présentation-de-magic-context">Présentation de Magic Context</a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#une-partie-de-cortexkit">CortexKit</a> ·
  <a href="#gestion-du-contexte">Contexte</a> ·
  <a href="#capture">Capture</a> ·
  <a href="#consolidation">Consolidation</a> ·
  <a href="#rappel">Rappel</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Présentation de Magic Context

Tu n'engages pas un développeur pour corriger un seul bug et le renvoies au moment où c'est livré. Les bons, tu les gardes. Ils apprennent la base de code, se souviennent des raisons derrière les décisions et deviennent plus efficaces chaque semaine.

Les agents de codage fonctionnent à l'inverse. Chaque tâche est une nouvelle recrue sans mémoire de ton projet, et à la fin de chaque session tu la renvoies puis tu repars de zéro. En plein travail, ils rencontrent même des pauses de "compaction" qui brisent le flux et perdent discrètement ce qu'ils savaient. C'est une amnésie antérograde, la même chose que lorsque l'hippocampe est endommagé.

Magic Context leur en donne un. C'est **l'hippocampe** des agents de codage, la partie du cerveau qui forme les souvenirs, les consolide et les rappelle, entièrement en arrière-plan. Une session cesse d'être un prestataire jetable et devient un coéquipier de long terme présent pendant tout le projet :

- **Capture.** Quand l'historian compresse ton historique, il remonte le savoir durable (décisions, contraintes, conventions) dans la mémoire du projet. Tu obtiens un système de mémoire gratuitement, à partir du travail que tu fais déjà.
- **Consolidation.** Pendant la nuit, les agents dreamer font ce que le sommeil fait pour toi : vérifier les souvenirs avec la base de code, organiser les doublons et les entrées périmées, puis promouvoir ce qui revient.
- **Rappel.** Les bons souvenirs remontent automatiquement à chaque tour, et l'agent peut chercher à la demande dans les souvenirs, les anciennes conversations et l'historique git. Entre sessions, et entre OpenCode et Pi.

Deux promesses : ton agent **ne s'arrête jamais pour gérer son contexte** (pas de pauses de compaction, pas de flux cassé) et il **n'oublie jamais**.

Lance une session par projet et garde-la en vie pendant des semaines, des mois ou des années. Elle se souvient de tout ce que vous avez construit ensemble.

---

## Démarrage rapide

Exécute l'assistant de configuration interactif. Il détecte tes modèles, configure tout et gère la compatibilité.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Ou exécuter directement (tout OS) :**
```bash
npx @cortexkit/magic-context@latest setup
```

L'assistant détecte automatiquement les harnesses présents (OpenCode, Pi ou les deux), ajoute le plugin, désactive la compaction intégrée, t'aide à choisir les modèles pour historian et dreamer, puis résout les conflits avec les autres plugins de gestion de contexte. Cible un harness précis avec `--harness opencode` ou `--harness pi`.

> **Pourquoi désactiver la compaction intégrée ?** Magic Context gère le contexte lui-même. La compaction de l'hôte interférerait avec ses opérations différées conscientes du cache et compresserait deux fois.

**Configuration manuelle** (OpenCode) : ajoute le plugin et coupe la compaction dans `opencode.json`, puis place un `magic-context.jsonc` dans `<project>/.cortexkit/` (ou dans `~/.config/cortexkit/` pour des valeurs par défaut utilisateur). Voir la [référence de configuration](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (nécessite Pi `>= 0.74.0`). L'extension Pi partage la même base de données qu'OpenCode ; les mémoires de projet et les embeddings se mettent en commun entre les deux.

**Dépannage :** `npx @cortexkit/magic-context@latest doctor` détecte automatiquement tes harnesses, vérifie les conflits (compaction, OMO hooks, DCP), valide le plugin et la barre latérale TUI, lance un contrôle d'intégrité de la base de données et corrige ce qu'il peut. Ajoute `--issue` pour créer un rapport de bug prêt à soumettre.

Même fonctionnement sur un projet neuf ou ancien : installe, redémarre le harness, et Magic Context capture le contexte à partir de ce moment. Il ne remplit pas rétroactivement les sessions OpenCode ou Pi d'avant son installation.

<details>
<summary><strong>Compatibilité avec d'autres plugins de gestion de contexte</strong></summary>

<br>

Magic Context possède la gestion du contexte de bout en bout, donc il **se désactive** si un autre plugin fait déjà ce travail. Deux gestionnaires de contexte en même temps compresseraient deux fois ton historique et perturberaient le cache du prompt. Au démarrage, il vérifie les points suivants ; setup et `doctor` t'aident à résoudre chacun d'eux, et tant qu'ils ne sont pas résolus Magic Context reste éteint (fail-safe) et t'explique pourquoi :

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`) : Magic Context la remplace. Setup la désactive.
- **DCP** (`opencode-dcp`) : un plugin séparé de réduction de contexte. Les deux ne peuvent pas fonctionner ensemble ; retire-le de ta liste `plugin`.
- **oh-my-opencode (OMO)** : setup propose de désactiver les trois hooks qui se recoupent :
  - `preemptive-compaction` : déclenche une compaction qui entre en conflit avec l'historian.
  - `context-window-monitor` : injecte des avertissements d'usage qui se recoupent avec les rappels de Magic Context.
  - `anthropic-context-window-limit-recovery` : déclenche une compaction d'urgence qui contourne l'historian.

Exécute `npx @cortexkit/magic-context@latest doctor` à tout moment pour revérifier et corriger automatiquement.

</details>

---

## Une partie de CortexKit

Un cerveau n'est pas un seul organe. Un agent de codage compétent non plus.

**CortexKit** est une famille de plugins, chacun inspiré d'une région différente du cerveau. Installe-en un et ton agent devient plus affûté. Installe les trois et il a un cerveau.

| Plugin | Région | Ce qu'il fait |
|---|---|---|
| **Magic Context** *(vous êtes ici)* | Hippocampe et lobe temporal médian | Contexte autogéré et mémoire à long terme. Garde les sessions actives sans pauses de compaction pendant qu'il forme, consolide et rappelle le savoir du projet entre elles. |
| **[AFT](https://github.com/cortexkit/aft)** | Cortex sensorimoteur | Perçoit la structure du code et agit dessus avec précision. Un vrai IDE et OS pour ton agent. |
| **Alfonso** *(bientôt disponible)* | Cortex préfrontal | Contrôle exécutif. Planifie, décompose le travail, choisit agents et modèles, et décide quand demander, vérifier et commit. |

Magic Context est **1 des 3 plugins dont tu auras jamais besoin.** Il se souvient ; AFT perçoit et agit ; Alfonso décide. Ils partagent un seul magasin CortexKit, donc la mémoire se met en commun entre harnesses et outils.

---

## ⚡ Gestion du contexte

*Une session sans limites qui se gère elle-même.* La fenêtre de contexte se remplit pendant que tu travailles, et la correction habituelle, la compaction, arrête net l'agent pour tout relire. Magic Context gère cela continuellement en arrière-plan, donc la session continue simplement.

- **Compartimentation historian** : un historian en arrière-plan compresse l'ancien historique brut en **compartiments par niveaux**, des résumés chronologiques qui remplacent les anciens messages. Chacun porte un score d'importance, donc la fenêtre active reste petite sans perdre le fil. Résumer n'a pas besoin de la force de codage de ton agent principal, donc tu peux faire tourner historian sur un modèle bon marché ou même entièrement local pendant que ton agent principal reste de premier niveau.
- **Rendu par décroissance** : les compartiments sont rendus avec la fidélité adaptée au moment, par une règle déterministe sans LLM qui s'ajuste à la fenêtre de contexte du modèle. L'ancien historique s'estompe proprement au lieu de disparaître d'un coup, et comme c'est déterministe, le même historique se rend toujours de la même manière.
- **L'agent indique quoi laisser tomber, ou il ne le fait pas** : avec la réduction pilotée par l'agent, l'agent appelle `ctx_reduce` pour marquer les sorties d'outils périmées ou les longs messages à retirer. Les suppressions sont **mises en file et conscientes du cache**, appliquées seulement aux moments sûrs pour le cache afin que la réduction ne le perturbe jamais. Désactive-la et l'agent reste entièrement hors de la gestion du contexte : les sorties périmées disparaissent automatiquement avec l'âge, avec une compression caveman optionnelle du plus vieux texte.
- **Disposition stable pour le cache** : tout cela est structuré pour que le travail en arrière-plan n'invalide jamais le préfixe mis en cache de ton prompt. Ton cache survit toute la session.

Résultat : une session tourne pendant des mois, sans pauses de compaction et à faible coût chez les fournisseurs tarifés au cache. Tu peux le voir dans la TUI d'OpenCode, où une barre latérale en direct affiche la répartition du contexte par source, l'état de l'historian et les comptes de mémoire, avec mise à jour après chaque message.

> *Optionnel (désactivé par défaut) :* **caveman text compression** compresse progressivement le plus vieux texte utilisateur et assistant selon une règle déterministe par âge, pour les sessions qui tournent avec la réduction pilotée par l'agent désactivée.

---

## 🧠 Capture

*De la mémoire, gratuitement.* Pour compresser ton historique, l'historian doit tout lire. Dans le même passage, il extrait donc le savoir à conserver pour toujours, décisions, contraintes, conventions, valeurs de configuration, et le promeut en **mémoire de projet**, catégorisé et transporté dans chaque session future. Ta mémoire se construit à partir du travail que tu fais déjà.

L'agent peut aussi enregistrer explicitement des souvenirs, même si la plupart sont capturés automatiquement pour lui :

- **`ctx_memory`** : écrire ou supprimer directement du savoir entre sessions, dans une petite taxonomie de catégories (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Conscience temporelle** *(activée par défaut)* donne à l'agent un sens du temps, avec des marqueurs d'écart comme `+2h 15m` entre les messages et des compartiments datés, afin qu'il puisse raisonner sur l'ancienneté d'un événement. Définis `temporal_awareness: false` pour la désactiver.

---

## 🌙 Consolidation

*Ce que le sommeil fait pour la mémoire.* Un agent **dreamer** optionnel tourne pendant la nuit pour garder une mémoire de haute qualité, en lançant des sessions enfant éphémères pour chaque tâche :

- **Vérifier** : contrôler progressivement les souvenirs avec la base de code actuelle (chemins, configs, motifs) et corriger ou retirer les faits périmés.
- **Organiser** : parcourir tout le pool de mémoire pour fusionner les doublons, resserrer la formulation et archiver les entrées de faible valeur ou redondantes.
- **Classer** : noter l'importance, la portée et la possibilité de partage sûr de chaque souvenir sans perturber le cache du prompt actif.
- **Maintenir la documentation** : garder `ARCHITECTURE.md` et `STRUCTURE.md` à jour avec les changements de la base de code.
- **Souvenirs utilisateur** : promouvoir les observations récurrentes sur ta façon de travailler (style de communication, focus de revue, habitudes de travail) dans un `<user-profile>` qui voyage avec chaque session.
- **Smart notes** : évaluer les notes différées dont `surface_condition` est devenue vraie et faire remonter celles qui sont prêtes.

Comme il tourne pendant les temps morts, dreamer s'accorde bien avec les modèles locaux, même lents. Personne n'attend. Lance une exécution à tout moment avec `/ctx-dream`.

---

## 🔎 Rappel

*Le bon souvenir au bon moment.* À chaque tour, les mémoires de projet actives et l'historique de session compacté sont injectés automatiquement et de manière stable pour le cache. À la demande, l'agent utilise :

- **`ctx_search`** : une requête sur trois couches à la fois : **memories** du projet, historique brut de **conversation** et **git commits** indexés. Embeddings sémantiques avec repli en texte intégral.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`** : ramener une plage d'historique compressée au transcript original `U:`/`A:` quand l'agent a besoin des détails exacts.
- **`ctx_note`** : un scratchpad pour les intentions différées. Les notes réapparaissent aux limites naturelles (après les commits, après les runs historian, quand les todos se terminent). **Smart notes** porte une condition ouverte que dreamer surveille.

Le rappel fonctionne **entre sessions** (une nouvelle session hérite de tout) et **entre harnesses** (écrire une mémoire dans OpenCode, la retrouver dans Pi).

> **Indices de recherche automatique** *(activés par défaut)* lance un `ctx_search` en arrière-plan à chaque tour et murmure un "rappel vague" lorsqu'un élément pertinent existe, comme lorsque tu te souviens presque d'une note prise plus tôt. Il n'ajoute que des fragments compacts, jamais le contenu complet ; définis `memory.auto_search.enabled: false` pour le désactiver. **Indexation des git commits** *(opt-in)* rend l'historique du projet recherchable sémantiquement comme quatrième source `ctx_search`, à activer avec `memory.git_commit_indexing.enabled: true`.

### Outils de l'agent en un coup d'œil

| Outil | Section | Ce qu'il fait |
|------|-------|-------------|
| `ctx_reduce` | Contexte | Mettre en file le contenu tagué périmé pour suppression, en tenant compte du cache |
| `ctx_memory` | Capture | Écrire ou supprimer des souvenirs durables entre sessions |
| `ctx_search` | Rappel | Chercher dans les souvenirs, l'historique de conversation et les git commits |
| `ctx_expand` | Rappel | Décompresser une plage d'historique vers le transcript |
| `ctx_note` | Rappel | Intentions différées et smart notes évaluées par dreamer |

---

## Commandes

| Commande | Description |
|---------|-------------|
| `/ctx-status` | Vue de débogage : tags, suppressions en attente, TTL de cache, état des rappels, progression historian, couverture des compartiments, budget d'historique |
| `/ctx-flush` | Forcer immédiatement toutes les opérations en file, en contournant le TTL de cache |
| `/ctx-recomp` | Reconstruire les compartiments depuis l'historique brut (accepte une plage `start-end`). À utiliser quand l'état stocké semble faux |
| `/ctx-dream` | Exécuter la maintenance dreamer à la demande : mémoire, docs, smart notes et revue user-profile |

---

## Application de bureau

Une application de bureau compagnon pour parcourir et gérer l'état de Magic Context hors du terminal.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Navigateur de mémoire** : rechercher, filtrer et modifier les mémoires de projet par catégorie et projet.
- **Historique de session** : parcourir les compartiments et notes de toute session avec navigation chronologique.
- **Diagnostics de cache** : chronologie en temps réel des hits/misses de cache et détection des causes de bust.
- **Gestion dreamer** : voir l'historique des dream-run, déclencher des runs, inspecter les résultats de tâches.
- **Éditeur de configuration** : édition par formulaire de chaque réglage, y compris les chaînes de fallback de modèles.
- **Visionneuse de logs** : suivi en direct des logs avec recherche.

Elle lit directement dans la base SQLite de Magic Context. Pas de serveur supplémentaire, pas d'API. Mises à jour automatiques intégrées.

---

## Configuration

Les réglages vivent dans `magic-context.jsonc`. Tout a des valeurs par défaut raisonnables ; la configuration de projet se fusionne au-dessus des réglages utilisateur. Pour la référence complète, réglage du TTL de cache, seuils execute par modèle, choix des modèles historian et dreamer, fournisseurs d'embeddings et réglages de mémoire, consulte **[CONFIGURATION.md](./CONFIGURATION.md)** ou la **[référence de configuration sur docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Emplacements de configuration** (un emplacement CortexKit partagé, le projet remplace l'utilisateur) :
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Mise à niveau depuis une version antérieure ? Ta configuration existante est déplacée ici automatiquement au premier lancement (un fil d'Ariane `.MOVED_READPLEASE` reste à l'ancien chemin).

---

## Stockage

Tout l'état durable vit dans une base SQLite locale sous le magasin CortexKit partagé (`~/.local/share/cortexkit/magic-context/context.db`, équivalent XDG sous Windows ; les anciennes bases dans le dossier OpenCode migrent au premier démarrage). Si la base ne peut pas être ouverte, Magic Context se désactive et te prévient. Les souvenirs sont liés à une **identité de projet stable** dérivée du repo, donc ils suivent un projet entre worktrees, clones et forks au lieu d'être attachés à un chemin de dossier.

Magic Context écrit aussi à quelques autres emplacements :

| Chemin | Quoi | Persistance |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Base SQLite, tags, compartiments, souvenirs, tout l'état durable (équivalent XDG sous Windows) | **Doit persister.** La perdre fait perdre ta mémoire/historique. |
| `~/.local/share/cortexkit/magic-context/models/` | Cache local du modèle d'embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), téléchargé au premier usage quand les embeddings locaux sont activés | Devrait persister, sinon il est retéléchargé à chaque exécution. Non utilisé quand `memory.enabled: false` ou qu'un backend d'embeddings `openai_compatible`/`ollama` est configuré. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log de diagnostic | Jetable. |

**Environnements sandbox / éphémères (Docker, CI, conteneurs jetables) :** monte le répertoire `~/.local/share/cortexkit/magic-context/` sur un volume persistant pour que la base et le cache de modèle survivent entre les runs. Si seul le cache de modèle est éphémère, le modèle est simplement retéléchargé ; si la base est éphémère, la mémoire et l'historique ne s'accumulent pas. Pour éviter entièrement le téléchargement du modèle d'environ 90 MB, définis `memory.enabled: false` ou pointe `embedding` vers un backend distant `openai_compatible`/`ollama`.

---

## Historique des étoiles

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Développement

**Prérequis :** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

L'exécution de Dream nécessite un serveur OpenCode actif (dreamer crée des sessions enfant éphémères). Utilise `/ctx-dream` dans OpenCode pour la maintenance à la demande.

---

## Contribuer

Les rapports de bugs et les pull requests sont bienvenus. Pour les changements plus importants, ouvre d'abord une issue pour discuter de l'approche. Exécute `bun run format` avant de soumettre ; CI rejette le code non formaté.

---

## Licence

[MIT](LICENSE)
