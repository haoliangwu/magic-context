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
  <strong>Bosanski</strong> |
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

*Ovo je prijevod zajednice. Engleski [README.md](./README.md) je izvor istine i može biti ažurniji.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Neograničen kontekst. Memorija koja se sama upravlja. Jedna sesija, za cijeli život.</strong><br>
  Hipokampus za coding agents, dio CortexKit.
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
  <em>Ne zapošljavaš developera za jedan zadatak i ne otpuštaš ga kad isporuči.<br>Prestani to raditi svom agentu.</em>
</p>

<p align="center">
  <a href="#šta-je-magic-context">Šta je Magic Context?</a> ·
  <a href="#brzi-početak">Brzi početak</a> ·
  <a href="#dio-cortexkit">CortexKit</a> ·
  <a href="#upravljanje-kontekstom">Kontekst</a> ·
  <a href="#hvatanje">Hvatanje</a> ·
  <a href="#konsolidacija">Konsolidacija</a> ·
  <a href="#prisjećanje">Prisjećanje</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Šta je Magic Context?

Ne zapošljavaš developera da popravi jedan bug i ne otpuštaš ga čim se promjena isporuči. Dobre zadržavaš. Oni nauče codebase, pamte zašto su odluke donesene i svake sedmice postaju oštriji.

Coding agents rade suprotno. Svaki zadatak je novi radnik bez memorije o tvom projektu, a na kraju svake sesije ga otpustiš i kreneš od nule. Usred zadatka čak naiđu na "compaction" pauze koje prekidaju tok i tiho izgube ono što su znali. To je anterogradna amnezija, isto što se desi kada je hipokampus oštećen.

Magic Context im daje jedan. To je **hipokampus** za coding agents, dio mozga koji formira sjećanja, konsoliduje ih i priziva, potpuno u pozadini. Jedna sesija prestaje biti jednokratni izvođač i postaje dugoročni član tima koji je bio tu za cijeli projekat:

- **Hvatanje.** Dok historian kompresuje tvoju historiju, on podiže trajno znanje (odluke, ograničenja, konvencije) u memoriju projekta. Dobijaš sistem memorije besplatno, iz posla koji već radiš.
- **Konsolidacija.** Tokom noći dreamer agenti rade ono što san radi za tebe: provjeravaju sjećanja prema codebase, uređuju duplikate i zastarjele zapise, i promovišu ono što se ponavlja.
- **Prisjećanje.** Prava sjećanja se automatski pojavljuju u svakom potezu, a agent može po potrebi pretraživati memorije, prošle razgovore i git historiju. Kroz sesije, i kroz OpenCode i Pi.

Dva obećanja: tvoj agent **nikad ne staje da upravlja svojim kontekstom** (nema compaction pauza, nema prekinutog toka) i **nikad ne zaboravlja**.

Pokreni jednu sesiju po projektu i pusti je da traje sedmicama, mjesecima ili godinama. Pamtiće sve što ste zajedno izgradili.

---

## Brzi početak

Pokreni interaktivni čarobnjak za podešavanje. On otkriva tvoje modele, sve konfiguriše i rješava kompatibilnost.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Ili pokreni direktno (bilo koji OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Čarobnjak automatski otkriva koje harnesses imaš (OpenCode, Pi ili oba), dodaje plugin, isključuje ugrađeni compaction, pomaže da izabereš modele za historian i dreamer, i rješava konflikte s drugim pluginima za upravljanje kontekstom. Ciljaj određeni harness pomoću `--harness opencode` ili `--harness pi`.

> **Zašto isključiti ugrađeni compaction?** Magic Context sam upravlja kontekstom. Compaction hosta bi ometao njegove odgođene operacije svjesne cachea i kompresovao dva puta.

**Ručno podešavanje** (OpenCode): dodaj plugin i isključi compaction u `opencode.json`, zatim stavi `magic-context.jsonc` u `<project>/.cortexkit/` (ili `~/.config/cortexkit/` za korisničke zadane postavke). Vidi [referencu konfiguracije](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (zahtijeva Pi `>= 0.74.0`). Pi proširenje dijeli istu bazu podataka kao OpenCode; projektne memorije i embeddings se udružuju preko oba.

**Rješavanje problema:** `npx @cortexkit/magic-context@latest doctor` automatski otkriva harnesses, provjerava konflikte (compaction, OMO hooks, DCP), verifikuje plugin i TUI sidebar, pokreće provjeru integriteta baze podataka i popravlja šta može. Dodaj `--issue` da napraviš bug report spreman za slanje.

Radi isto na potpuno novom ili dugotrajnom projektu: instaliraj, restartuj harness, i Magic Context od tog trenutka hvata kontekst. Ne popunjava OpenCode ili Pi sesije od prije instalacije.

<details>
<summary><strong>Kompatibilnost s drugim pluginima za upravljanje kontekstom</strong></summary>

<br>

Magic Context posjeduje upravljanje kontekstom od kraja do kraja, pa **sam sebe isključuje** ako drugi plugin već radi taj posao. Dva upravljača kontekstom odjednom bi dvostruko kompresovala historiju i razdrmala prompt cache. Pri pokretanju provjerava sljedeće; setup i `doctor` pomažu da riješiš svaku stavku, a dok se ne riješe Magic Context ostaje isključen (fail-safe) i kaže ti zašto:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context ga zamjenjuje. Setup ga isključuje.
- **DCP** (`opencode-dcp`): poseban plugin za orezivanje konteksta. Ne mogu raditi zajedno; ukloni ga iz `plugin` liste.
- **oh-my-opencode (OMO)**: setup nudi da isključi tri hooks koja se preklapaju:
  - `preemptive-compaction`: pokreće compaction koji se sukobljava s historian.
  - `context-window-monitor`: ubacuje upozorenja o upotrebi koja se preklapaju s Magic Context nudges.
  - `anthropic-context-window-limit-recovery`: pokreće hitni compaction koji zaobilazi historian.

Pokreni `npx @cortexkit/magic-context@latest doctor` bilo kada da ponovo provjeri i automatski popravi.

</details>

---

## Dio CortexKit

Mozak nije jedan organ. Nije ni sposoban coding agent.

**CortexKit** je porodica plugina, svaki modeliran prema drugoj regiji mozga. Instaliraj jedan i agent postaje oštriji. Instaliraj sva tri i ima mozak.

| Plugin | Regija | Šta radi |
|---|---|---|
| **Magic Context** *(ovdje si)* | Hipokampus i medijalni temporalni režanj | Samoupravljajući kontekst i dugoročna memorija. Drži sesije aktivnim bez compaction pauza dok formira, konsoliduje i priziva znanje projekta kroz njih. |
| **[AFT](https://github.com/cortexkit/aft)** | Senzomotorni korteks | Percepira strukturu koda i djeluje po njoj precizno. Pravi IDE i OS za tvog agenta. |
| **Alfonso** *(uskoro)* | Prefrontalni korteks | Izvršna kontrola. Planira, razlaže posao, bira agente i modele, i odlučuje kada pitati, verifikovati i commitovati. |

Magic Context je **1 od 3 plugina koja će ti ikad trebati.** On pamti; AFT percepira i djeluje; Alfonso odlučuje. Dijele jedno CortexKit skladište, pa se memorija udružuje kroz harnesses i alate.

---

## ⚡ Upravljanje kontekstom

*Neograničena sesija koja upravlja sama sobom.* Kontekstni prozor se puni dok radiš, a uobičajeno rješenje, compaction, zaustavlja agenta da sve ponovo pročita. Magic Context to stalno rješava u pozadini, pa sesija samo nastavlja.

- **Historian kompartmentalizacija**: pozadinski historian kompresuje staru sirovu historiju u **slojevite kompartmente**, hronološke sažetke koji zamjenjuju starije poruke. Svaki ima ocjenu važnosti, pa live prozor ostaje mali bez gubljenja niti. Sažimanje ne treba coding snagu primarnog agenta, pa historian možeš pokrenuti na jeftinom ili potpuno lokalnom modelu dok glavni agent ostaje vrhunski.
- **Decay rendering**: kompartimenti se renderuju s pravom vjernošću za trenutak, determinističkim no-LLM pravilom koje se samo podešava na kontekstni prozor modela. Stara historija elegantno blijedi umjesto da nestane odjednom, i pošto je deterministička, ista historija se uvijek renderuje isto.
- **Agent nagovijesti šta ispustiti, ili ne**: s agent-driven reduction uključenim, agent zove `ctx_reduce` da označi zastarjele izlaze alata ili duge poruke za uklanjanje. Ispuštanja su **u redu čekanja i cache-aware**, primijenjena samo u cache-safe trenucima, tako da redukcija nikad ne razdrma cache. Isključi to i agent potpuno izlazi iz upravljanja kontekstom: zastarjeli izlaz se automatski odbacuje po starosti, uz opcionalnu caveman kompresiju najstarijeg teksta.
- **Cache-stabilan raspored**: sve je strukturirano tako da pozadinski rad nikad ne poništi cacheirani prefiks prompta. Tvoj cache preživljava cijelu sesiju.

Rezultat: jedna sesija radi mjesecima, bez compaction pauza i uz nizak trošak kod provider-a s cache cijenama. Možeš to gledati u OpenCode TUI, gdje live sidebar prikazuje raspodjelu konteksta po izvoru, historian status i brojeve memorija, ažurirano nakon svake poruke.

> *Opcionalno (isključeno po defaultu):* **caveman text compression** postepeno kompresuje najstariji user i assistant tekst determinističkim pravilom po starosti, za sesije koje rade s agent-driven reduction isključenim.

---

## 🧠 Hvatanje

*Memorija, besplatno.* Da kompresuje tvoju historiju, historian mora pročitati sve. U istom prolazu izvlači znanje vrijedno trajnog čuvanja, odluke, ograničenja, konvencije, konfiguracijske vrijednosti, i promoviše ga u **projektnu memoriju**, kategorizovanu i prenesenu u svaku buduću sesiju. Tvoja memorija se sama gradi iz posla koji već radiš.

Agent može i eksplicitno zapisivati memorije, iako se većina hvata automatski za njega:

- **`ctx_memory`**: direktno piši ili briši znanje preko sesija, u maloj taksonomiji kategorija (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Vremenska svjesnost** *(uključena po defaultu)* daje agentu osjećaj vremena, s markerima razmaka kao `+2h 15m` između poruka i datiranim kompartimentima, tako da može rasuđivati koliko se davno nešto desilo. Postavi `temporal_awareness: false` da je isključiš.

---

## 🌙 Konsolidacija

*Ono što san radi za memoriju.* Opcionalni **dreamer** agent radi preko noći da održava kvalitet memorije, pokrećući prolazne child sessions za svaki zadatak:

- **Verifikuj**: inkrementalno provjeri memorije prema trenutnom codebase (putanje, configs, obrasci) i popravi ili ukloni zastarjele činjenice.
- **Uredi**: skeniraj cijeli memorijski pool da spojiš duplikate, zategneš formulacije i arhiviraš niskovrijedne ili redundantne unose.
- **Klasificiraj**: ocijeni važnost, opseg i sigurnu dijeljivost svake memorije bez ometanja live prompt cachea.
- **Održavaj docs**: drži `ARCHITECTURE.md` i `STRUCTURE.md` ažurnim prema promjenama u codebase.
- **Korisničke memorije**: promoviši ponavljajuća opažanja o tome kako radiš (stil komunikacije, fokus review-a, radni obrasci) u `<user-profile>` koji putuje sa svakom sesijom.
- **Smart notes**: ocijeni odgođene bilješke čiji se `surface_condition` ostvario i prikaži spremne.

Pošto radi tokom praznog hoda, dreamer se dobro slaže s lokalnim modelima, čak i sporim. Niko ne čeka. Pokreni run bilo kada s `/ctx-dream`.

---

## 🔎 Prisjećanje

*Prava memorija u pravom trenutku.* Svaki potez, aktivne projektne memorije i kompaktirana historija sesije ubacuju se automatski i cache-stabilno. Na zahtjev agent koristi:

- **`ctx_search`**: jedan upit kroz tri sloja odjednom: projektne **memories**, sirovu historiju **conversation** i indeksirane **git commits**. Semantički embeddings s full-text fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: vrati kompresovani raspon historije u originalni `U:`/`A:` transcript kada agent treba tačne detalje.
- **`ctx_note`**: scratchpad za odgođene namjere. Bilješke se ponovo pojavljuju na prirodnim granicama (poslije commits, poslije historian runs, kada todos završe). **Smart notes** nose otvoreni uslov koji dreamer prati.

Prisjećanje radi **kroz sesije** (nova sesija nasljeđuje sve) i **kroz harnesses** (upiši memoriju u OpenCode, preuzmi je u Pi).

> **Automatski hints za pretragu** *(uključeni po defaultu)* pokreću pozadinski `ctx_search` svaki potez i šapnu "nejasno prisjećanje" kad postoji nešto relevantno, kao da se skoro sjetiš bilješke koju si zapisao. Dodaje samo kompaktne fragmente, nikad puni sadržaj; postavi `memory.auto_search.enabled: false` da isključiš. **Git commit indexing** *(opt-in)* čini historiju projekta semantički pretraživom kao četvrti izvor `ctx_search`, uključi s `memory.git_commit_indexing.enabled: true`.

### Alati agenta ukratko

| Alat | Sekcija | Šta radi |
|------|-------|-------------|
| `ctx_reduce` | Kontekst | Stavi zastarjeli tagovani sadržaj u red za uklanjanje, cache-aware |
| `ctx_memory` | Hvatanje | Piši ili briši trajne memorije preko sesija |
| `ctx_search` | Prisjećanje | Pretraži memorije, historiju razgovora i git commits |
| `ctx_expand` | Prisjećanje | Dekomprimuj raspon historije nazad u transcript |
| `ctx_note` | Prisjećanje | Odgođene namjere i smart notes koje dreamer procjenjuje |

---

## Komande

| Komanda | Opis |
|---------|-------------|
| `/ctx-status` | Debug prikaz: tags, pending drops, cache TTL, nudge stanje, historian napredak, pokrivenost kompartimenata, budžet historije |
| `/ctx-flush` | Odmah forsiraj sve operacije u redu, zaobilazeći cache TTL |
| `/ctx-recomp` | Ponovo izgradi kompartmente iz sirove historije (prima `start-end` raspon). Koristi kada pohranjeno stanje izgleda pogrešno |
| `/ctx-dream` | Pokreni dreamer održavanje na zahtjev: održavaj memoriju, docs, smart notes i user-profile review |

---

## Desktop aplikacija

Prateća desktop aplikacija za pregled i upravljanje Magic Context stanjem izvan terminala.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Preglednik memorije**: pretraži, filtriraj i uređuj projektne memorije po kategoriji i projektu.
- **Historija sesije**: pregledaj kompartmente i bilješke za bilo koju sesiju uz navigaciju po vremenskoj liniji.
- **Cache dijagnostika**: real-time cache hit/miss vremenska linija i detekcija bust uzroka.
- **Dreamer upravljanje**: pregledaj dream-run historiju, pokreni runs, pregledaj rezultate zadataka.
- **Editor konfiguracije**: uređivanje svakog podešavanja kroz forme, uključujući model fallback lance.
- **Preglednik logova**: live-tailing logova s pretragom.

Čita direktno iz Magic Context SQLite baze podataka. Nema dodatnog servera, nema API-ja. Automatska ažuriranja su ugrađena.

---

## Konfiguracija

Podešavanja žive u `magic-context.jsonc`. Sve ima razumne default vrijednosti; konfiguracija projekta se spaja preko korisničkih podešavanja. Za punu referencu, cache TTL podešavanje, execute pragove po modelu, izbor historian i dreamer modela, embedding providers i memorijska podešavanja, vidi **[CONFIGURATION.md](./CONFIGURATION.md)** ili **[referencu konfiguracije na docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Lokacije konfiguracije** (jedna zajednička CortexKit lokacija, projekat nadjačava korisnika):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Nadograđuješ sa starije verzije? Postojeća konfiguracija se automatski premješta ovdje pri prvom pokretanju (na staroj putanji ostaje `.MOVED_READPLEASE` trag).

---

## Pohrana

Svo trajno stanje živi u lokalnoj SQLite bazi pod zajedničkim CortexKit skladištem (`~/.local/share/cortexkit/magic-context/context.db`, XDG ekvivalent na Windows; legacy baze u OpenCode folderu migriraju se pri prvom pokretanju). Ako se baza ne može otvoriti, Magic Context se isključuje i obavještava te. Memorije su vezane za **stabilni identitet projekta** izveden iz repo, pa prate projekat kroz worktrees, clones i forks umjesto da budu vezane za putanju direktorija.

Magic Context piše i na nekoliko drugih lokacija:

| Putanja | Šta | Trajnost |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite baza, tags, kompartimenti, memorije, svo trajno stanje (XDG ekvivalent na Windows) | **Mora opstati.** Gubitak znači gubitak memorije/historije. |
| `~/.local/share/cortexkit/magic-context/models/` | Lokalni cache embedding modela (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), preuzima se pri prvoj upotrebi kada su lokalni embeddings uključeni | Treba opstati, inače se ponovo preuzima pri svakom pokretanju. Ne koristi se kada je `memory.enabled: false` ili je konfigurisan `openai_compatible`/`ollama` embedding backend. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Dijagnostički log | Može se odbaciti. |

**Sandbox / prolazna okruženja (Docker, CI, jednokratni kontejneri):** mountaj direktorij `~/.local/share/cortexkit/magic-context/` na trajni volume tako da baza podataka i cache modela prežive između pokretanja. Ako je samo cache modela prolazan, model se jednostavno ponovo preuzima; ako je baza prolazna, memorija i historija se ne akumuliraju. Da potpuno izbjegneš download modela od ~90 MB, postavi `memory.enabled: false` ili usmjeri `embedding` na udaljeni `openai_compatible`/`ollama` backend.

---

## Historija zvjezdica

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Razvoj

**Zahtjevi:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream izvršavanje zahtijeva aktivan OpenCode server (dreamer kreira prolazne child sessions). Koristi `/ctx-dream` unutar OpenCode za održavanje na zahtjev.

---

## Doprinos

Bug reports i pull requests su dobrodošli. Za veće promjene prvo otvori issue da se razgovara o pristupu. Pokreni `bun run format` prije slanja; CI odbija neformatiran kod.

---

## Licenca

[MIT](LICENSE)
