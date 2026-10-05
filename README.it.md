<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
  <strong>Italiano</strong> |
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

*Questa è una traduzione della community. Il [README.md](./README.md) in inglese è la fonte autorevole e potrebbe essere più aggiornato.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Contesto senza limiti. Memoria che si gestisce da sola. Una sessione, per sempre.</strong><br>
  L'ippocampo per agenti di programmazione, parte di CortexKit.
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
  <em>Non assumi uno sviluppatore per un compito e lo licenzi appena consegna.<br>Smetti di farlo al tuo agente.</em>
</p>

<p align="center">
  <a href="#che-cosa-è-magic-context">Che cosa è Magic Context?</a> ·
  <a href="#avvio-rapido">Avvio rapido</a> ·
  <a href="#parte-di-cortexkit">CortexKit</a> ·
  <a href="#gestione-del-contesto">Contesto</a> ·
  <a href="#acquisizione">Acquisizione</a> ·
  <a href="#consolidamento">Consolidamento</a> ·
  <a href="#richiamo">Richiamo</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Che cosa è Magic Context?

Non assumi uno sviluppatore per correggere un solo bug e lo licenzi nel momento in cui viene pubblicato. Quelli bravi li tieni. Imparano la codebase, ricordano perché sono state prese certe decisioni e diventano più efficaci ogni settimana.

Gli agenti di programmazione lavorano al contrario. Ogni attività è una nuova assunzione senza memoria del tuo progetto, e alla fine di ogni sessione la licenzi e riparti da zero. A metà attività incontrano persino pause di "compaction" che spezzano il flusso e perdono silenziosamente ciò che sapevano. È amnesia anterograda, la stessa cosa che accade quando l'ippocampo è danneggiato.

Magic Context gliene dà uno. È **l'ippocampo** per gli agenti di programmazione, la parte del cervello che forma ricordi, li consolida e li richiama, interamente in background. Una sessione smette di essere un collaboratore usa e getta e diventa un compagno di squadra a lungo termine, presente per tutto il progetto:

- **Acquisizione.** Mentre historian comprime la tua cronologia, porta la conoscenza durevole (decisioni, vincoli, convenzioni) nella memoria del progetto. Ottieni un sistema di memoria gratis, dal lavoro che stai già facendo.
- **Consolidamento.** Di notte gli agenti dreamer fanno ciò che il sonno fa per te: verificano i ricordi contro la codebase, curano duplicati e voci obsolete, e promuovono ciò che ricorre.
- **Richiamo.** I ricordi giusti emergono automaticamente a ogni turno, e l'agente può cercare tra ricordi, conversazioni passate e cronologia git su richiesta. Tra sessioni, e tra OpenCode e Pi.

Due promesse: il tuo agente **non si ferma mai per gestire il contesto** (niente pause di compaction, niente flusso interrotto) e **non dimentica mai**.

Esegui una sessione per progetto e lasciala andare avanti per settimane, mesi o anni. Ricorderà tutto ciò che avete costruito insieme.

---

## Avvio rapido

Esegui la procedura guidata interattiva. Rileva i tuoi modelli, configura tutto e gestisce la compatibilità.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Oppure esegui direttamente (qualsiasi OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

La procedura rileva automaticamente quali harness hai (OpenCode, Pi o entrambi), aggiunge il plugin, disattiva la compaction integrata, ti aiuta a scegliere i modelli per historian e dreamer, e risolve i conflitti con altri plugin di gestione del contesto. Punta a un harness specifico con `--harness opencode` o `--harness pi`.

> **Perché disattivare la compaction integrata?** Magic Context gestisce il contesto da sé. La compaction dell'host interferirebbe con le sue operazioni differite attente alla cache e comprimerebbe due volte.

**Configurazione manuale** (OpenCode): aggiungi il plugin e disattiva la compaction in `opencode.json`, poi metti un `magic-context.jsonc` in `<project>/.cortexkit/` (o in `~/.config/cortexkit/` per i default utente). Vedi il [riferimento di configurazione](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (richiede Pi `>= 0.74.0`). L'estensione Pi condivide lo stesso database di OpenCode; memorie di progetto ed embeddings confluiscono in entrambi.

**Risoluzione dei problemi:** `npx @cortexkit/magic-context@latest doctor` rileva automaticamente i tuoi harness, controlla conflitti (compaction, OMO hooks, DCP), verifica il plugin e la barra laterale TUI, esegue un controllo di integrità sul database e corregge ciò che può. Aggiungi `--issue` per creare un bug report pronto da inviare.

Funziona allo stesso modo su un progetto nuovo o di lunga durata: installa, riavvia l'harness, e Magic Context cattura il contesto da quel momento in poi. Non recupera le sessioni OpenCode o Pi precedenti all'installazione.

<details>
<summary><strong>Compatibilità con altri plugin di gestione del contesto</strong></summary>

<br>

Magic Context possiede la gestione del contesto dall'inizio alla fine, quindi **si disattiva** se un altro plugin sta già facendo quel lavoro. Eseguire due gestori di contesto insieme comprimerebbe due volte la cronologia e destabilizzerebbe la cache del prompt. All'avvio controlla quanto segue; setup e `doctor` ti aiutano a risolvere ogni punto, e finché non sono risolti Magic Context resta spento (fail-safe) e ti dice perché:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context la sostituisce. Setup la disattiva.
- **DCP** (`opencode-dcp`): un plugin separato di potatura del contesto. I due non possono girare insieme; rimuovilo dalla tua lista `plugin`.
- **oh-my-opencode (OMO)**: setup propone di disattivare i tre hooks sovrapposti:
  - `preemptive-compaction`: attiva una compaction che confligge con historian.
  - `context-window-monitor`: inserisce avvisi di utilizzo che si sovrappongono ai suggerimenti di Magic Context.
  - `anthropic-context-window-limit-recovery`: attiva una compaction di emergenza che bypassa historian.

Esegui `npx @cortexkit/magic-context@latest doctor` in qualsiasi momento per ricontrollare e correggere automaticamente.

</details>

---

## Parte di CortexKit

Un cervello non è un solo organo. Nemmeno un agente di programmazione capace.

**CortexKit** è una famiglia di plugin, ciascuno modellato su una regione diversa del cervello. Installane uno e il tuo agente diventa più acuto. Installali tutti e tre e avrà un cervello.

| Plugin | Regione | Cosa fa |
|---|---|---|
| **Magic Context** *(sei qui)* | Ippocampo e lobo temporale mediale | Contesto autogestito e memoria a lungo termine. Mantiene le sessioni attive senza pause di compaction mentre forma, consolida e richiama conoscenza del progetto tra di esse. |
| **[AFT](https://github.com/cortexkit/aft)** | Corteccia sensomotoria | Percepisce la struttura del codice e agisce su di essa con precisione. Un vero IDE e OS per il tuo agente. |
| **Alfonso** *(in arrivo)* | Corteccia prefrontale | Controllo esecutivo. Pianifica, scompone il lavoro, sceglie agenti e modelli, e decide quando chiedere, verificare e fare commit. |

Magic Context è **1 dei 3 plugin di cui avrai mai bisogno.** Ricorda; AFT percepisce e agisce; Alfonso decide. Condividono un unico archivio CortexKit, quindi la memoria si accumula tra harness e strumenti.

---

## ⚡ Gestione del contesto

*Una sessione senza limiti che si gestisce da sola.* La finestra di contesto si riempie mentre lavori, e la soluzione normale, la compaction, ferma l'agente per fargli rileggere tutto. Magic Context la gestisce continuamente in background, così la sessione continua.

- **Compartimentazione historian**: un historian in background comprime la vecchia cronologia grezza in **compartimenti a livelli**, riassunti cronologici che sostituiscono i messaggi più vecchi. Ognuno ha un punteggio di importanza, quindi la finestra viva resta piccola senza perdere il filo. Riassumere non richiede la forza di programmazione dell'agente principale, quindi puoi eseguire historian su un modello economico o persino locale mentre l'agente principale resta di fascia alta.
- **Rendering a decadimento**: i compartimenti vengono renderizzati con la fedeltà giusta per il momento, tramite una regola deterministica senza LLM che si adatta alla finestra di contesto del modello. La vecchia cronologia svanisce gradualmente invece di cadere di colpo, e poiché è deterministica, la stessa cronologia viene sempre renderizzata nello stesso modo.
- **L'agente suggerisce cosa eliminare, oppure no**: con la riduzione guidata dall'agente attiva, l'agente chiama `ctx_reduce` per segnare output di strumenti obsoleti o messaggi lunghi per la rimozione. Le rimozioni sono **in coda e attente alla cache**, applicate solo nei momenti sicuri per la cache, quindi la riduzione non la destabilizza mai. Disattivala e l'agente resta completamente fuori dalla gestione del contesto: l'output vecchio viene scartato automaticamente per età, con compressione caveman opzionale del testo più vecchio.
- **Layout stabile per la cache**: tutto questo è strutturato in modo che il lavoro in background non invalidi mai il prefisso cache del prompt. La cache sopravvive per tutta la sessione.

Il risultato: una sessione gira per mesi, senza pause di compaction e con basso costo sui provider a prezzo cache. Puoi osservarlo nella TUI di OpenCode, dove una barra laterale live mostra la ripartizione del contesto per sorgente, lo stato di historian e il conteggio delle memorie, aggiornandosi dopo ogni messaggio.

> *Opzionale (disattivato per default):* **caveman text compression** comprime progressivamente il testo utente e assistant più vecchio con una regola deterministica per fasce di età, per sessioni che girano con la riduzione guidata dall'agente disattivata.

---

## 🧠 Acquisizione

*Memoria, gratis.* Per comprimere la tua cronologia, historian deve leggerla tutta. Nello stesso passaggio estrae quindi la conoscenza da conservare per sempre, decisioni, vincoli, convenzioni, valori di configurazione, e la promuove a **memoria di progetto**, categorizzata e portata in ogni sessione futura. La tua memoria si costruisce da sola dal lavoro che stai già facendo.

L'agente può anche registrare memorie esplicitamente, anche se la maggior parte viene catturata automaticamente per lui:

- **`ctx_memory`**: scrivi o elimina direttamente conoscenza tra sessioni, in una piccola tassonomia di categorie (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Consapevolezza temporale** *(attiva per default)* dà all'agente un senso del tempo, con marcatori di intervallo come `+2h 15m` tra messaggi e compartimenti datati, così può ragionare su quanto tempo fa sia successo qualcosa. Imposta `temporal_awareness: false` per disattivarla.

---

## 🌙 Consolidamento

*Ciò che il sonno fa per la memoria.* Un agente **dreamer** opzionale gira durante la notte per mantenere alta la qualità della memoria, avviando sessioni figlie effimere per ogni attività:

- **Verifica**: controllare incrementalmente le memorie contro la codebase corrente (percorsi, configurazioni, pattern) e correggere o rimuovere fatti obsoleti.
- **Cura**: scansionare l'intero pool di memoria per unire duplicati, stringere la formulazione e archiviare voci di basso valore o ridondanti.
- **Classifica**: assegnare un punteggio a importanza, ambito e condivisibilità sicura di ogni memoria senza disturbare la cache del prompt live.
- **Mantieni documenti**: tenere `ARCHITECTURE.md` e `STRUCTURE.md` aggiornati dai cambiamenti della codebase.
- **Memorie utente**: promuovere osservazioni ricorrenti su come lavori (stile di comunicazione, focus di review, pattern di lavoro) in un `<user-profile>` che viaggia con ogni sessione.
- **Smart notes**: valutare note differite il cui `surface_condition` si è avverato e far emergere quelle pronte.

Poiché gira nei tempi morti, dreamer si abbina bene ai modelli locali, anche lenti. Nessuno aspetta. Avvia una run in qualsiasi momento con `/ctx-dream`.

---

## 🔎 Richiamo

*Il ricordo giusto al momento giusto.* A ogni turno, le memorie di progetto attive e la cronologia di sessione compattata vengono iniettate automaticamente e in modo stabile per la cache. Su richiesta, l'agente usa:

- **`ctx_search`**: una query su tre livelli insieme: **memories** del progetto, cronologia grezza di **conversation** e **git commits** indicizzati. Embeddings semantici con fallback full-text.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: riportare un intervallo di cronologia compressa al transcript originale `U:`/`A:` quando l'agente ha bisogno dei dettagli esatti.
- **`ctx_note`**: uno scratchpad per intenzioni differite. Le note riemergono ai confini naturali (dopo i commit, dopo le run di historian, quando i todos finiscono). **Smart notes** portano una condizione aperta che dreamer osserva.

Il richiamo funziona **tra sessioni** (una nuova sessione eredita tutto) e **tra harnesses** (scrivi una memoria in OpenCode, recuperala in Pi).

> **Suggerimenti di ricerca automatica** *(attivi per default)* eseguono un `ctx_search` in background a ogni turno e sussurrano un "richiamo vago" quando esiste qualcosa di rilevante, come quasi ricordare una nota presa. Aggiunge solo frammenti compatti, mai contenuto completo; imposta `memory.auto_search.enabled: false` per disattivarlo. **Indicizzazione dei git commit** *(opt-in)* rende la cronologia del progetto ricercabile semanticamente come quarta sorgente `ctx_search`, abilitabile con `memory.git_commit_indexing.enabled: true`.

### Strumenti dell'agente in breve

| Strumento | Sezione | Cosa fa |
|------|-------|-------------|
| `ctx_reduce` | Contesto | Accoda contenuto taggato obsoleto per la rimozione, rispettando la cache |
| `ctx_memory` | Acquisizione | Scrive o elimina memorie durevoli tra sessioni |
| `ctx_search` | Richiamo | Cerca memorie, cronologia delle conversazioni e git commits |
| `ctx_expand` | Richiamo | Decomprime un intervallo di cronologia nel transcript |
| `ctx_note` | Richiamo | Intenzioni differite e smart notes valutate da dreamer |

---

## Comandi

| Comando | Descrizione |
|---------|-------------|
| `/ctx-status` | Vista debug: tags, pending drops, TTL cache, stato dei suggerimenti, progresso historian, copertura dei compartimenti, budget cronologia |
| `/ctx-flush` | Forza immediatamente tutte le operazioni in coda, bypassando il TTL cache |
| `/ctx-recomp` | Ricostruisce i compartimenti dalla cronologia grezza (accetta un intervallo `start-end`). Da usare quando lo stato salvato sembra errato |
| `/ctx-dream` | Esegui manutenzione dreamer su richiesta: memoria, documenti, smart notes e review di user-profile |

---

## App desktop

Un'app desktop complementare per esplorare e gestire lo stato di Magic Context fuori dal terminale.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Browser memoria**: cerca, filtra e modifica memorie di progetto per categoria e progetto.
- **Cronologia sessione**: esplora compartimenti e note di qualsiasi sessione con navigazione temporale.
- **Diagnostica cache**: timeline in tempo reale di hit/miss cache e rilevamento cause di bust.
- **Gestione dreamer**: visualizza cronologia dream-run, avvia run, ispeziona risultati dei task.
- **Editor configurazione**: modifica a moduli per ogni impostazione, incluse catene di fallback dei modelli.
- **Visualizzatore log**: live-tailing dei log con ricerca.

Legge direttamente dal database SQLite di Magic Context. Nessun server extra, nessuna API. Aggiornamenti automatici integrati.

---

## Configurazione

Le impostazioni stanno in `magic-context.jsonc`. Tutto ha default sensati; la configurazione di progetto si fonde sopra le impostazioni utente. Per il riferimento completo, regolazione TTL cache, soglie execute per modello, scelta dei modelli historian e dreamer, provider di embeddings e impostazioni di memoria, vedi **[CONFIGURATION.md](./CONFIGURATION.md)** o il **[riferimento di configurazione su docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Posizioni di configurazione** (una posizione CortexKit condivisa, il progetto sovrascrive l'utente):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Aggiorni da una versione precedente? La configurazione esistente viene spostata qui automaticamente al primo avvio (nel vecchio percorso resta una traccia `.MOVED_READPLEASE`).

---

## Archiviazione

Tutto lo stato durevole vive in un database SQLite locale sotto l'archivio CortexKit condiviso (`~/.local/share/cortexkit/magic-context/context.db`, equivalente XDG su Windows; i database legacy nella cartella OpenCode vengono migrati al primo avvio). Se il database non può essere aperto, Magic Context si disattiva e ti avvisa. Le memorie sono associate a una **identità di progetto stabile** derivata dal repo, quindi seguono un progetto tra worktrees, clones e forks invece di essere legate a un percorso di directory.

Magic Context scrive anche in alcune altre posizioni:

| Percorso | Cosa | Persistenza |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Database SQLite, tags, compartimenti, memorie, tutto lo stato durevole (equivalente XDG su Windows) | **Deve persistere.** Perderlo significa perdere memoria/cronologia. |
| `~/.local/share/cortexkit/magic-context/models/` | Cache locale del modello di embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), scaricata al primo uso quando gli embeddings locali sono abilitati | Dovrebbe persistere, altrimenti viene riscaricata a ogni esecuzione. Non usata quando `memory.enabled: false` o è configurato un backend embeddings `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log diagnostico | Eliminabile. |

**Ambienti sandbox / effimeri (Docker, CI, container usa e getta):** monta la directory `~/.local/share/cortexkit/magic-context/` su un volume persistente così database e cache del modello sopravvivono tra le esecuzioni. Se solo la cache del modello è effimera, il modello viene semplicemente riscaricato; se il database è effimero, memoria e cronologia non si accumulano. Per evitare del tutto il download del modello da ~90 MB, imposta `memory.enabled: false` o punta `embedding` a un backend remoto `openai_compatible`/`ollama`.

---

## Cronologia delle stelle

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Sviluppo

**Requisiti:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

L'esecuzione di Dream richiede un server OpenCode attivo (dreamer crea sessioni figlie effimere). Usa `/ctx-dream` dentro OpenCode per manutenzione su richiesta.

---

## Contribuire

Bug report e pull requests sono benvenuti. Per modifiche più grandi, apri prima una issue per discutere l'approccio. Esegui `bun run format` prima di inviare; CI rifiuta codice non formattato.

---

## Licenza

[MIT](LICENSE)
