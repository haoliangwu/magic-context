<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.it.md">Italiano</a> |
  <strong>Dansk</strong> |
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

*Dette er en fællesskabsoversættelse. Den engelske [README.md](./README.md) er den autoritative kilde og kan være mere opdateret.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Ubegrænset kontekst. Hukommelse der styrer sig selv. Én session, for livet.</strong><br>
  Hippocampus for coding agents, en del af CortexKit.
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
  <em>Du ansætter ikke en udvikler til én opgave og fyrer dem, når de leverer.<br>Hold op med at gøre det mod din agent.</em>
</p>

<p align="center">
  <a href="#hvad-er-magic-context">Hvad er Magic Context?</a> ·
  <a href="#hurtig-start">Hurtig start</a> ·
  <a href="#en-del-af-cortexkit">CortexKit</a> ·
  <a href="#kontekststyring">Kontekst</a> ·
  <a href="#indfangning">Indfangning</a> ·
  <a href="#konsolidering">Konsolidering</a> ·
  <a href="#genkaldelse">Genkaldelse</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Hvad er Magic Context?

Du ansætter ikke en udvikler til at rette én fejl og fyrer dem i det øjeblik, den er sendt ud. De gode beholder du. De lærer kodebasen, husker hvorfor beslutninger blev taget, og bliver skarpere hver uge.

Coding agents arbejder modsat. Hver opgave er en nyansættelse uden hukommelse om dit projekt, og ved slutningen af hver session fyrer du dem og starter fra nul. Midt i en opgave rammer de endda "compaction"-pauser, der bryder flowet og stille taber det, de vidste. Det er anterograd amnesi, det samme der sker, når hippocampus er beskadiget.

Magic Context giver dem en. Det er **hippocampus** for coding agents, den del af hjernen der danner minder, konsoliderer dem og genkalder dem, helt i baggrunden. En session holder op med at være en engangskonsulent og bliver en langsigtet holdkammerat, der var med gennem hele projektet:

- **Indfangning.** Når historian komprimerer din historik, løfter den den varige viden (beslutninger, begrænsninger, konventioner) ind i projekthukommelsen. Du får et hukommelsessystem gratis, fra arbejde du allerede udfører.
- **Konsolidering.** Om natten gør dreamer-agenter det, søvn gør for dig: verificerer minder mod kodebasen, kuraterer dubletter og forældede poster, og fremmer det der går igen.
- **Genkaldelse.** De rigtige minder dukker automatisk op ved hver tur, og agenten kan søge i minder, tidligere samtaler og git-historik efter behov. På tværs af sessioner, og på tværs af OpenCode og Pi.

To løfter: din agent **stopper aldrig for at styre sin kontekst** (ingen compaction-pauser, intet brudt flow), og den **glemmer aldrig**.

Kør én session pr. projekt og lad den fortsætte i uger, måneder eller år. Den husker alt, I har bygget sammen.

---

## Hurtig start

Kør den interaktive opsætningsguide. Den registrerer dine modeller, konfigurerer alt og håndterer kompatibilitet.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Eller kør direkte (ethvert OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Guiden registrerer automatisk hvilke harnesses du har (OpenCode, Pi eller begge), tilføjer pluginet, deaktiverer indbygget compaction, hjælper dig med at vælge modeller til historian og dreamer, og løser konflikter med andre kontekststyringsplugins. Målret et bestemt harness med `--harness opencode` eller `--harness pi`.

> **Hvorfor deaktivere indbygget compaction?** Magic Context styrer selv kontekst. Værtens compaction ville forstyrre dens cache-bevidste udskudte operationer og dobbeltkomprimere.

**Manuel opsætning** (OpenCode): tilføj pluginet og slå compaction fra i `opencode.json`, og læg derefter en `magic-context.jsonc` i `<project>/.cortexkit/` (eller `~/.config/cortexkit/` for brugerbrede standarder). Se [konfigurationsreferencen](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (kræver Pi `>= 0.74.0`). Pi-udvidelsen deler samme database som OpenCode; projekthukommelser og embeddings samles på tværs af begge.

**Fejlfinding:** `npx @cortexkit/magic-context@latest doctor` registrerer automatisk dine harnesses, tjekker for konflikter (compaction, OMO hooks, DCP), verificerer plugin og TUI-sidebjælke, kører et integritetstjek på databasen og retter det, den kan. Tilføj `--issue` for at oprette en fejlrapport, der er klar til indsendelse.

Det virker ens på et helt nyt eller et langvarigt projekt: installer, genstart harnesset, og Magic Context indfanger kontekst fra det tidspunkt. Det efterfylder ikke OpenCode- eller Pi-sessioner fra før installationen.

<details>
<summary><strong>Kompatibilitet med andre kontekststyringsplugins</strong></summary>

<br>

Magic Context ejer kontekststyringen fra ende til ende, så det **deaktiverer sig selv**, hvis et andet plugin allerede gør arbejdet. To kontekststyringer på samme tid ville dobbeltkomprimere din historik og slide på prompt-cachen. Ved start tjekker det følgende; setup og `doctor` hjælper dig med at løse hvert punkt, og indtil de er løst, forbliver Magic Context slukket (fail-safe) og fortæller hvorfor:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context erstatter den. Setup slår den fra.
- **DCP** (`opencode-dcp`): et separat plugin til kontekstbeskæring. De to kan ikke køre sammen; fjern det fra din `plugin`-liste.
- **oh-my-opencode (OMO)**: setup tilbyder at deaktivere de tre hooks, der overlapper:
  - `preemptive-compaction`: udløser compaction, der konflikter med historian.
  - `context-window-monitor`: indsætter brugsadvarsler, der overlapper Magic Contexts nudges.
  - `anthropic-context-window-limit-recovery`: udløser nødcompaction, der omgår historian.

Kør `npx @cortexkit/magic-context@latest doctor` når som helst for at tjekke igen og rette automatisk.

</details>

---

## En del af CortexKit

En hjerne er ikke ét organ. Det er en dygtig coding agent heller ikke.

**CortexKit** er en familie af plugins, hvert modelleret efter en anden region i hjernen. Installer ét, og din agent bliver skarpere. Installer alle tre, og den har en hjerne.

| Plugin | Region | Hvad det gør |
|---|---|---|
| **Magic Context** *(du er her)* | Hippocampus og medial temporallap | Selvstyrende kontekst og langtidshukommelse. Holder sessioner kørende uden compaction-pauser, mens den danner, konsoliderer og genkalder projektviden på tværs af dem. |
| **[AFT](https://github.com/cortexkit/aft)** | Sensorimotorisk cortex | Opfatter kodestruktur og handler præcist på den. En ordentlig IDE og OS til din agent. |
| **Alfonso** *(kommer snart)* | Præfrontal cortex | Eksekutiv kontrol. Planlægger, opdeler arbejde, vælger agenter og modeller, og beslutter hvornår der skal spørges, verificeres og committes. |

Magic Context er **1 af de 3 plugins, du nogensinde får brug for.** Det husker; AFT opfatter og handler; Alfonso beslutter. De deler ét CortexKit-lager, så hukommelse samles på tværs af harnesses og værktøjer.

---

## ⚡ Kontekststyring

*En ubegrænset session der styrer sig selv.* Kontekstvinduet fyldes mens du arbejder, og den normale løsning, compaction, stopper agenten brat for at læse alt igen. Magic Context håndterer det løbende i baggrunden, så sessionen bare fortsætter.

- **Historian-kompartmentalisering**: en baggrunds-historian komprimerer gammel rå historik til **lagdelte kompartementer**, kronologiske resuméer der står i stedet for ældre beskeder. Hvert har en vigtighedsscore, så live-vinduet forbliver lille uden at miste tråden. Resuméer kræver ikke din primære agents coding-muskler, så du kan køre historian på en billig eller endda helt lokal model, mens hovedagenten forbliver topklasse.
- **Decay-rendering**: kompartementer renderes med den rette detaljegrad for øjeblikket, efter en deterministisk no-LLM-regel der selv tilpasser sig modellens kontekstvindue. Gammel historik falmer pænt i stedet for at falde ud over en kant, og fordi det er deterministisk, renderes den samme historik altid på samme måde.
- **Agenten antyder hvad der skal droppes, eller gør det ikke**: med agentdrevet reduktion slået til kalder agenten `ctx_reduce` for at markere gamle værktøjsoutput eller lange beskeder til fjernelse. Drops bliver **lagt i kø og er cache-bevidste**, anvendt kun på cache-sikre tidspunkter, så reduktion aldrig ødelægger cachen. Slå det fra, og agenten holdes helt ude af kontekststyring: gammelt output fjernes automatisk efter alder, med valgfri caveman-kompression af den ældste tekst.
- **Cache-stabilt layout**: alt dette er struktureret, så baggrundsarbejde aldrig gør det cachede præfiks i din prompt ugyldigt. Din cache overlever hele sessionen.

Resultatet: én session kører i måneder, uden compaction-pauser og med lav pris hos cache-prissatte udbydere. Du kan se det ske i OpenCodes TUI, hvor en live sidebjælke viser kontekstopdeling efter kilde, historian-status og hukommelsestal, opdateret efter hver besked.

> *Valgfrit (slået fra som standard):* **caveman text compression** komprimerer gradvist den ældste bruger- og assistant-tekst efter en deterministisk aldersregel, for sessioner der kører med agentdrevet reduktion slået fra.

---

## 🧠 Indfangning

*Hukommelse, gratis.* For at komprimere din historik skal historian læse det hele. I samme omgang løfter den derfor den viden, der er værd at beholde for altid, beslutninger, begrænsninger, konventioner, konfigurationsværdier, og fremmer den til **projekthukommelse**, kategoriseret og båret ind i hver fremtidig session. Din hukommelse bygger sig selv fra det arbejde, du allerede udfører.

Agenten kan også registrere minder eksplicit, selvom de fleste fanges automatisk for den:

- **`ctx_memory`**: skriv eller slet viden på tværs af sessioner direkte, i en lille kategoritaksonomi (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Tidsbevidsthed** *(slået til som standard)* giver agenten en tidsfornemmelse, med gap-markører som `+2h 15m` mellem beskeder og daterede kompartementer, så den kan ræsonnere om hvor længe siden noget skete. Sæt `temporal_awareness: false` for at slå det fra.

---

## 🌙 Konsolidering

*Det søvn gør for hukommelsen.* En valgfri **dreamer**-agent kører om natten for at holde hukommelseskvaliteten høj og starter flygtige børnesessioner for hver opgave:

- **Verificer**: tjek minder inkrementelt mod den aktuelle kodebase (stier, configs, mønstre) og ret eller fjern forældede fakta.
- **Kuratér**: scan hele hukommelsespuljen for at flette dubletter, stramme formuleringer og arkivere lavværdi eller overflødige poster.
- **Klassificér**: scor hvert mindes vigtighed, omfang og sikre delbarhed uden at forstyrre den live prompt-cache.
- **Vedligehold docs**: hold `ARCHITECTURE.md` og `STRUCTURE.md` aktuelle ud fra ændringer i kodebasen.
- **Brugerminder**: fremm gentagne observationer om hvordan du arbejder (kommunikationsstil, review-fokus, arbejdsmønstre) til en `<user-profile>`, der rejser med hver session.
- **Smart notes**: vurder udskudte noter, hvis `surface_condition` er blevet sand, og vis de klare.

Fordi den kører i inaktiv tid, passer dreamer godt med lokale modeller, selv langsomme. Ingen venter. Udløs en kørsel når som helst med `/ctx-dream`.

---

## 🔎 Genkaldelse

*Det rette minde på det rette tidspunkt.* Ved hver tur injiceres aktive projekthukommelser og den kompakterede sessionshistorik automatisk og cache-stabilt. Efter behov bruger agenten:

- **`ctx_search`**: én forespørgsel på tværs af tre lag på én gang: projektets **memories**, rå **conversation**-historik og indekserede **git commits**. Semantiske embeddings med fuldtekst-fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: hent et komprimeret historikområde tilbage til den oprindelige `U:`/`A:` transcript, når agenten har brug for de nøjagtige detaljer.
- **`ctx_note`**: en scratchpad til udskudte intentioner. Noter dukker op igen ved naturlige grænser (efter commits, efter historian-kørsler, når todos afsluttes). **Smart notes** har en åben betingelse, som dreamer holder øje med.

Genkaldelse virker **på tværs af sessioner** (en ny session arver alt) og **på tværs af harnesses** (skriv en hukommelse i OpenCode, hent den i Pi).

> **Automatiske søgehints** *(slået til som standard)* kører en baggrunds-`ctx_search` hver tur og hvisker en "vag erindring", når noget relevant findes, som næsten at huske en note du tog. Den tilføjer kun kompakte fragmenter, aldrig fuldt indhold; sæt `memory.auto_search.enabled: false` for at slå det fra. **Git commit-indeksering** *(tilvalg)* gør din projekthistorik semantisk søgbar som en fjerde `ctx_search`-kilde, aktiver med `memory.git_commit_indexing.enabled: true`.

### Agentværktøjer kort fortalt

| Værktøj | Sektion | Hvad det gør |
|------|-------|-------------|
| `ctx_reduce` | Kontekst | Læg gammelt tagget indhold i kø til fjernelse, cache-bevidst |
| `ctx_memory` | Indfangning | Skriv eller slet varige minder på tværs af sessioner |
| `ctx_search` | Genkaldelse | Søg i minder, samtalehistorik og git commits |
| `ctx_expand` | Genkaldelse | Dekomprimér et historikområde tilbage til transcript |
| `ctx_note` | Genkaldelse | Udskudte intentioner og dreamer-vurderede smart notes |

---

## Kommandoer

| Kommando | Beskrivelse |
|---------|-------------|
| `/ctx-status` | Debugvisning: tags, pending drops, cache TTL, nudge-tilstand, historian-fremskridt, kompartementdækning, historikbudget |
| `/ctx-flush` | Tving alle køede operationer straks, uden om cache TTL |
| `/ctx-recomp` | Genopbyg kompartementer fra rå historik (accepterer et `start-end`-interval). Brug når gemt tilstand virker forkert |
| `/ctx-dream` | Kør dreamer-vedligeholdelse efter behov: vedligehold hukommelse, docs, smart notes og user-profile review |

---

## Desktop-app

En ledsagende desktop-app til at gennemse og styre Magic Context-tilstand uden for terminalen.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Hukommelsesbrowser**: søg, filtrér og redigér projekthukommelser efter kategori og projekt.
- **Sessionshistorik**: gennemse kompartementer og noter for enhver session med tidslinjenavigation.
- **Cache-diagnostik**: realtidslinje for cache hit/miss og registrering af bust-årsager.
- **Dreamer-styring**: se dream-run-historik, udløs kørsler, inspicér opgaveresultater.
- **Konfigurationseditor**: formularbaseret redigering for hver indstilling, inklusive model fallback-kæder.
- **Logviser**: live-tailing logs med søgning.

Den læser direkte fra Magic Contexts SQLite-database. Ingen ekstra server, ingen API. Autoopdateringer indbygget.

---

## Konfiguration

Indstillinger ligger i `magic-context.jsonc`. Alt har fornuftige standarder; projektkonfiguration flettes oven på brugerbrede indstillinger. For den fulde reference, cache TTL-tuning, execute-tærskler pr. model, valg af historian- og dreamer-modeller, embedding providers og hukommelsesindstillinger, se **[CONFIGURATION.md](./CONFIGURATION.md)** eller **[konfigurationsreferencen på docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Konfigurationsplaceringer** (én delt CortexKit-placering, projekt tilsidesætter bruger):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Opgraderer du fra en tidligere version? Din eksisterende konfiguration flyttes automatisk hertil ved første kørsel (en `.MOVED_READPLEASE`-brødkrumme efterlades på den gamle sti).

---

## Lager

Al varig tilstand ligger i en lokal SQLite-database under det delte CortexKit-lager (`~/.local/share/cortexkit/magic-context/context.db`, XDG-ækvivalent på Windows; legacy OpenCode-mappedatabaser migreres frem ved første opstart). Hvis databasen ikke kan åbnes, deaktiverer Magic Context sig selv og giver dig besked. Minder er knyttet til en **stabil projektidentitet** afledt af repoet, så de følger et projekt på tværs af worktrees, clones og forks i stedet for at være bundet til en mappesti.

Magic Context skriver også til nogle få andre placeringer:

| Sti | Hvad | Persistens |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite-database, tags, kompartementer, minder, al varig tilstand (XDG-ækvivalent på Windows) | **Skal bevares.** Mister du den, mister du hukommelse/historik. |
| `~/.local/share/cortexkit/magic-context/models/` | Lokal embedding-modelcache (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), downloades ved første brug når lokale embeddings er aktiveret | Bør bevares, ellers downloades den igen hver kørsel. Bruges ikke når `memory.enabled: false` eller en `openai_compatible`/`ollama` embedding-backend er konfigureret. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Diagnostisk log | Kan smides væk. |

**Sandboxede / flygtige miljøer (Docker, CI, engangscontainere):** mount mappen `~/.local/share/cortexkit/magic-context/` på et vedvarende volume, så database og modelcache overlever mellem kørsler. Hvis kun modelcachen er flygtig, downloades modellen bare igen; hvis databasen er flygtig, ophobes hukommelse og historik ikke. For helt at undgå modeldownloadet på ~90 MB, sæt `memory.enabled: false` eller peg `embedding` på en fjern `openai_compatible`/`ollama` backend.

---

## Stjernehistorik

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Udvikling

**Krav:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream-kørsel kræver en live OpenCode-server (dreamer opretter flygtige børnesessioner). Brug `/ctx-dream` inde i OpenCode til vedligeholdelse efter behov.

---

## Bidrag

Bugrapporter og pull requests er velkomne. For større ændringer, åbn først en issue for at diskutere tilgangen. Kør `bun run format` før indsendelse; CI afviser uformateret kode.

---

## Licens

[MIT](LICENSE)
