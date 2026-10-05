<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.it.md">Italiano</a> |
  <a href="./README.da.md">Dansk</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.pl.md">Polski</a> |
  <a href="./README.ru.md">Русский</a> |
  <a href="./README.bs.md">Bosanski</a> |
  <a href="./README.ar.md">العربية</a> |
  <strong>Norsk</strong> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*Dette er en fellesskapsoversettelse. Den engelske [README.md](./README.md) er den autoritative kilden og kan være mer oppdatert.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Ubegrenset kontekst. Minne som styrer seg selv. Én økt, for livet.</strong><br>
  Hippocampus for coding agents, en del av CortexKit.
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
  <em>Du ansetter ikke en utvikler for én oppgave og sparker dem når de leverer.<br>Slutt å gjøre det mot agenten din.</em>
</p>

<p align="center">
  <a href="#hva-er-magic-context">Hva er Magic Context?</a> ·
  <a href="#hurtigstart">Hurtigstart</a> ·
  <a href="#en-del-av-cortexkit">CortexKit</a> ·
  <a href="#kontekststyring">Kontekst</a> ·
  <a href="#innhenting">Innhenting</a> ·
  <a href="#konsolidering">Konsolidering</a> ·
  <a href="#gjenkalling">Gjenkalling</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Hva er Magic Context?

Du ansetter ikke en utvikler for å fikse én bug og sparker dem i det øyeblikket den sendes. De gode beholder du. De lærer kodebasen, husker hvorfor beslutninger ble tatt, og blir skarpere hver uke.

Coding agents fungerer motsatt. Hver oppgave er en nyansettelse uten minne om prosjektet ditt, og på slutten av hver økt sparker du dem og starter på null. Midt i en oppgave treffer de til og med "compaction"-pauser som bryter flyten og stille slipper det de visste. Det er anterograd amnesi, det samme som skjer når hippocampus er skadet.

Magic Context gir dem en. Det er **hippocampus** for coding agents, den delen av hjernen som danner minner, konsoliderer dem og henter dem frem, helt i bakgrunnen. En økt slutter å være en engangsleverandør og blir en langsiktig lagkamerat som var der for hele prosjektet:

- **Innhenting.** Når historian komprimerer historikken din, løfter den varig kunnskap (beslutninger, begrensninger, konvensjoner) inn i prosjektminnet. Du får et minnesystem gratis, fra arbeid du allerede gjør.
- **Konsolidering.** Over natten gjør dreamer-agenter det søvn gjør for deg: verifiserer minner mot kodebasen, kuraterer duplikater og foreldede oppføringer, og fremmer det som går igjen.
- **Gjenkalling.** De riktige minnene dukker automatisk opp hver tur, og agenten kan søke i minner, tidligere samtaler og git-historikk ved behov. På tvers av økter, og på tvers av OpenCode og Pi.

To løfter: agenten din **stopper aldri for å styre konteksten sin** (ingen compaction-pauser, ingen ødelagt flyt), og den **glemmer aldri**.

Kjør én økt per prosjekt og la den gå i uker, måneder eller år. Den husker alt dere har bygd sammen.

---

## Hurtigstart

Kjør den interaktive oppsettsveiviseren. Den oppdager modellene dine, konfigurerer alt og håndterer kompatibilitet.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Eller kjør direkte (alle OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Veiviseren oppdager automatisk hvilke harnesses du har (OpenCode, Pi eller begge), legger til pluginet, deaktiverer innebygd compaction, hjelper deg å velge modeller for historian og dreamer, og løser konflikter med andre kontekststyringsplugins. Rett deg mot et bestemt harness med `--harness opencode` eller `--harness pi`.

> **Hvorfor deaktivere innebygd compaction?** Magic Context styrer konteksten selv. Hostens compaction ville forstyrre de cache-bevisste utsatte operasjonene og dobbeltkomprimere.

**Manuelt oppsett** (OpenCode): legg til pluginet og slå av compaction i `opencode.json`, legg deretter en `magic-context.jsonc` i `<project>/.cortexkit/` (eller `~/.config/cortexkit/` for brukerbrede standarder). Se [konfigurasjonsreferansen](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (krever Pi `>= 0.74.0`). Pi-utvidelsen deler samme database som OpenCode; prosjektminner og embeddings samles på tvers av begge.

**Feilsøking:** `npx @cortexkit/magic-context@latest doctor` oppdager automatisk harnesses, sjekker konflikter (compaction, OMO hooks, DCP), verifiserer plugin og TUI-sidefelt, kjører integritetssjekk på databasen og fikser det den kan. Legg til `--issue` for å lage en feilrapport klar til innsending.

Det fungerer likt på et helt nytt eller langvarig prosjekt: installer, start harnesset på nytt, og Magic Context fanger kontekst fra det tidspunktet. Det etterfyller ikke OpenCode- eller Pi-økter fra før installasjonen.

<details>
<summary><strong>Kompatibilitet med andre kontekststyringsplugins</strong></summary>

<br>

Magic Context eier kontekststyringen fra ende til ende, så det **deaktiverer seg selv** hvis et annet plugin allerede gjør jobben. To kontekststyrere samtidig ville dobbeltkomprimere historikken og herje med prompt-cachen. Ved oppstart sjekker det følgende; setup og `doctor` hjelper deg å løse hvert punkt, og inntil de er løst forblir Magic Context av (fail-safe) og sier hvorfor:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context erstatter den. Setup slår den av.
- **DCP** (`opencode-dcp`): et separat plugin for kontekstbeskjæring. De to kan ikke kjøre sammen; fjern det fra `plugin`-listen.
- **oh-my-opencode (OMO)**: setup tilbyr å deaktivere de tre overlappende hooks:
  - `preemptive-compaction`: utløser compaction som kolliderer med historian.
  - `context-window-monitor`: injiserer bruksvarsler som overlapper med Magic Contexts nudges.
  - `anthropic-context-window-limit-recovery`: utløser nødcompaction som omgår historian.

Kjør `npx @cortexkit/magic-context@latest doctor` når som helst for å sjekke på nytt og autofikse.

</details>

---

## En del av CortexKit

En hjerne er ikke ett organ. Det er ikke en dyktig coding agent heller.

**CortexKit** er en familie av plugins, hver modellert etter en annen region i hjernen. Installer ett, og agenten din blir skarpere. Installer alle tre, og den har en hjerne.

| Plugin | Region | Hva det gjør |
|---|---|---|
| **Magic Context** *(du er her)* | Hippocampus og medial temporallapp | Selvstyrende kontekst og langtidsminne. Holder økter gående uten compaction-pauser mens den danner, konsoliderer og gjenkaller prosjektkunnskap på tvers av dem. |
| **[AFT](https://github.com/cortexkit/aft)** | Sensorimotorisk cortex | Oppfatter kodestruktur og handler presist på den. En skikkelig IDE og OS for agenten din. |
| **Alfonso** *(kommer snart)* | Prefrontal cortex | Eksekutiv kontroll. Planlegger, bryter ned arbeid, velger agenter og modeller, og avgjør når den skal spørre, verifisere og committe. |

Magic Context er **1 av de 3 pluginene du noen gang trenger.** Den husker; AFT oppfatter og handler; Alfonso avgjør. De deler ett CortexKit-lager, så minne samles på tvers av harnesses og verktøy.

---

## ⚡ Kontekststyring

*En ubegrenset økt som styrer seg selv.* Kontekstvinduet fylles mens du arbeider, og den vanlige løsningen, compaction, stopper agenten brått for å lese alt på nytt. Magic Context håndterer det fortløpende i bakgrunnen, så økten bare fortsetter.

- **Historian-kompartmentalisering**: en bakgrunns-historian komprimerer gammel rå historikk til **nivådelte kompartementer**, kronologiske sammendrag som står inn for eldre meldinger. Hvert har en viktighetsscore, så live-vinduet holder seg lite uten å miste tråden. Sammendrag trenger ikke coding-kraften til primæragenten, så du kan kjøre historian på en billig eller helt lokal modell mens hovedagenten forblir toppnivå.
- **Decay-rendering**: kompartementer renderes med riktig nøyaktighet for øyeblikket, etter en deterministisk no-LLM-regel som tilpasser seg modellens kontekstvindu. Gammel historikk falmer pent i stedet for å falle utenfor en kant, og fordi den er deterministisk, renderes samme historikk alltid likt.
- **Agenten hinter hva som skal droppes, eller ikke**: med agentdrevet reduksjon på kaller agenten `ctx_reduce` for å markere foreldede verktøyutdata eller lange meldinger for fjerning. Drops er **køet og cache-bevisste**, brukt bare på cache-sikre tidspunkter, så reduksjon aldri ødelegger cachen. Slå det av, og agenten holder seg helt ute av kontekststyring: foreldede utdata fjernes automatisk etter alder, med valgfri caveman-komprimering av eldste tekst.
- **Cache-stabil layout**: alt dette er strukturert slik at bakgrunnsarbeid aldri ugyldiggjør den cachede prefiksen til prompten din. Cachen overlever hele økten.

Resultatet: én økt kjører i måneder, uten compaction-pauser og med lav kostnad hos cache-prisede leverandører. Du kan se det i OpenCodes TUI, der et live sidefelt viser kontekstfordeling etter kilde, historian-status og minnetall, oppdatert etter hver melding.

> *Valgfritt (av som standard):* **caveman text compression** komprimerer gradvis den eldste bruker- og assistant-teksten etter en deterministisk aldersregel, for økter som kjører med agentdrevet reduksjon av.

---

## 🧠 Innhenting

*Minne, gratis.* For å komprimere historikken må historian lese alt. I samme pass løfter den derfor ut kunnskapen som er verdt å beholde for alltid, beslutninger, begrensninger, konvensjoner, konfigurasjonsverdier, og promoterer den til **prosjektminne**, kategorisert og båret inn i hver fremtidige økt. Minnet ditt bygger seg selv fra arbeidet du allerede gjør.

Agenten kan også registrere minner eksplisitt, selv om de fleste fanges automatisk for den:

- **`ctx_memory`**: skriv eller slett kunnskap på tvers av økter direkte, i en liten kategoritaksonomi (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Tidsbevissthet** *(på som standard)* gir agenten en følelse av tid, med gapmarkører som `+2h 15m` mellom meldinger og daterte kompartementer, så den kan resonnere om hvor lenge siden noe skjedde. Sett `temporal_awareness: false` for å slå det av.

---

## 🌙 Konsolidering

*Det søvn gjør for minnet.* En valgfri **dreamer**-agent kjører om natten for å holde minnekvaliteten høy, og starter flyktige barneøkter for hver oppgave:

- **Verifiser**: sjekk minner inkrementelt mot den nåværende kodebasen (stier, configs, mønstre) og fiks eller fjern foreldede fakta.
- **Kurater**: skann hele minnepoolen for å slå sammen duplikater, stramme formuleringer og arkivere lavverdi eller redundante oppføringer.
- **Klassifiser**: gi hvert minne score for viktighet, omfang og trygg delbarhet uten å forstyrre live prompt-cache.
- **Vedlikehold docs**: hold `ARCHITECTURE.md` og `STRUCTURE.md` oppdatert fra endringer i kodebasen.
- **Brukerminner**: promoter gjentatte observasjoner om hvordan du jobber (kommunikasjonsstil, review-fokus, arbeidsmønstre) til en `<user-profile>` som følger hver økt.
- **Smart notes**: evaluer utsatte notater hvis `surface_condition` har blitt sann og vis de klare.

Fordi den kjører i inaktiv tid, passer dreamer godt med lokale modeller, selv trege. Ingen venter. Utløs en kjøring når som helst med `/ctx-dream`.

---

## 🔎 Gjenkalling

*Riktig minne i riktig øyeblikk.* Hver tur injiseres aktive prosjektminner og komprimert økthistorikk automatisk og cache-stabilt. Ved behov bruker agenten:

- **`ctx_search`**: ett søk på tvers av tre lag samtidig: prosjektets **memories**, rå **conversation**-historikk og indekserte **git commits**. Semantiske embeddings med fulltekst-fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: hent et komprimert historikkområde tilbake til original `U:`/`A:` transcript når agenten trenger nøyaktige detaljer.
- **`ctx_note`**: en scratchpad for utsatte intensjoner. Notater dukker opp igjen ved naturlige grenser (etter commits, etter historian-kjøringer, når todos fullføres). **Smart notes** har en åpen betingelse som dreamer følger med på.

Gjenkalling fungerer **på tvers av økter** (en ny økt arver alt) og **på tvers av harnesses** (skriv et minne i OpenCode, hent det i Pi).

> **Automatiske søkehint** *(på som standard)* kjører en bakgrunns-`ctx_search` hver tur og hvisker et "vagt minne" når noe relevant finnes, som nesten å huske et notat du tok. Den legger bare til kompakte fragmenter, aldri fullt innhold; sett `memory.auto_search.enabled: false` for å slå av. **Git commit-indeksering** *(opt-in)* gjør prosjekthistorikken semantisk søkbar som en fjerde `ctx_search`-kilde, aktiver med `memory.git_commit_indexing.enabled: true`.

### Agentverktøy på et øyeblikk

| Verktøy | Seksjon | Hva det gjør |
|------|-------|-------------|
| `ctx_reduce` | Kontekst | Køer foreldet tagget innhold for fjerning, cache-bevisst |
| `ctx_memory` | Innhenting | Skriver eller sletter varige minner på tvers av økter |
| `ctx_search` | Gjenkalling | Søker i minner, samtalehistorikk og git commits |
| `ctx_expand` | Gjenkalling | Dekomprimerer et historikkområde tilbake til transcript |
| `ctx_note` | Gjenkalling | Utsatte intensjoner og dreamer-evaluerte smart notes |

---

## Kommandoer

| Kommando | Beskrivelse |
|---------|-------------|
| `/ctx-status` | Debug-visning: tags, pending drops, cache TTL, nudge-tilstand, historian-fremdrift, kompartementdekning, historikkbudsjett |
| `/ctx-flush` | Tving alle køede operasjoner umiddelbart, forbi cache TTL |
| `/ctx-recomp` | Bygg kompartementer på nytt fra rå historikk (aksepterer et `start-end`-område). Bruk når lagret tilstand virker feil |
| `/ctx-dream` | Kjør dreamer-vedlikehold på forespørsel: vedlikehold minne, docs, smart notes og user-profile review |

---

## Desktop-app

En tilhørende desktop-app for å bla i og administrere Magic Context-tilstand utenfor terminalen.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Minnebrowser**: søk, filtrer og rediger prosjektminner etter kategori og prosjekt.
- **Økthistorikk**: bla i kompartementer og notater for enhver økt med tidslinjenavigasjon.
- **Cache-diagnostikk**: sanntids cache hit/miss-tidslinje og bust-årsaksdeteksjon.
- **Dreamer-administrasjon**: se dream-run-historikk, utløs kjøringer, inspiser oppgaveresultater.
- **Konfigurasjonseditor**: skjemabasert redigering for hver innstilling, inkludert model fallback chains.
- **Loggviser**: live-tailing logs med søk.

Den leser direkte fra Magic Contexts SQLite-database. Ingen ekstra server, ingen API. Automatiske oppdateringer innebygd.

---

## Konfigurasjon

Innstillinger ligger i `magic-context.jsonc`. Alt har fornuftige standarder; prosjektkonfigurasjon flettes over brukerbrede innstillinger. For full referanse, cache TTL-tuning, execute-terskler per modell, valg av historian- og dreamer-modeller, embedding providers og minneinnstillinger, se **[CONFIGURATION.md](./CONFIGURATION.md)** eller **[konfigurasjonsreferansen på docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Konfigurasjonsplasseringer** (én delt CortexKit-plassering, prosjekt overstyrer bruker):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Oppgraderer du fra en tidligere versjon? Eksisterende konfigurasjon flyttes hit automatisk ved første kjøring (en `.MOVED_READPLEASE`-brødsmule blir igjen på den gamle stien).

---

## Lagring

All varig tilstand ligger i en lokal SQLite-database under det delte CortexKit-lageret (`~/.local/share/cortexkit/magic-context/context.db`, XDG-ekvivalent på Windows; eldre OpenCode-mappedatabaser migreres ved første oppstart). Hvis databasen ikke kan åpnes, deaktiverer Magic Context seg selv og varsler deg. Minner er knyttet til en **stabil prosjektidentitet** avledet fra repo, så de følger et prosjekt på tvers av worktrees, clones og forks i stedet for å være bundet til en katalogsti.

Magic Context skriver også til noen få andre steder:

| Sti | Hva | Persistens |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite-database, tags, kompartementer, minner, all varig tilstand (XDG-ekvivalent på Windows) | **Må persistere.** Mister du den, mister du minne/historikk. |
| `~/.local/share/cortexkit/magic-context/models/` | Lokal embedding-modellcache (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), lastes ned ved første bruk når lokale embeddings er aktivert | Bør persistere, ellers lastes den ned på nytt hver kjøring. Brukes ikke når `memory.enabled: false` eller en `openai_compatible`/`ollama` embedding backend er konfigurert. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Diagnostikklogg | Kan kastes. |

**Sandboxede / flyktige miljøer (Docker, CI, engangscontainere):** monter katalogen `~/.local/share/cortexkit/magic-context/` på et vedvarende volum slik at databasen og modellcachen overlever mellom kjøringer. Hvis bare modellcachen er flyktig, lastes modellen bare ned på nytt; hvis databasen er flyktig, akkumuleres ikke minne og historikk. For å unngå modellnedlastingen på ~90 MB helt, sett `memory.enabled: false` eller pek `embedding` på en ekstern `openai_compatible`/`ollama` backend.

---

## Stjernehistorikk

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Utvikling

**Krav:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream-kjøring krever en live OpenCode-server (dreamer lager flyktige barneøkter). Bruk `/ctx-dream` i OpenCode for vedlikehold på forespørsel.

---

## Bidra

Bug reports og pull requests er velkomne. For større endringer, åpne en issue først for å diskutere tilnærmingen. Kjør `bun run format` før innsending; CI avviser uformatert kode.

---

## Lisens

[MIT](LICENSE)
