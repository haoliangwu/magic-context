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
  <strong>Polski</strong> |
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

*To jest tłumaczenie społeczności. Angielski [README.md](./README.md) jest źródłem prawdy i może być bardziej aktualny.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Nieograniczony kontekst. Pamięć, która zarządza się sama. Jedna sesja, na całe życie.</strong><br>
  Hipokamp dla agentów programistycznych, część CortexKit.
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
  <em>Nie zatrudniasz dewelopera do jednego zadania i nie zwalniasz go po dostarczeniu.<br>Przestań robić to swojemu agentowi.</em>
</p>

<p align="center">
  <a href="#czym-jest-magic-context">Czym jest Magic Context?</a> ·
  <a href="#szybki-start">Szybki start</a> ·
  <a href="#część-cortexkit">CortexKit</a> ·
  <a href="#zarządzanie-kontekstem">Kontekst</a> ·
  <a href="#przechwytywanie">Przechwytywanie</a> ·
  <a href="#konsolidacja">Konsolidacja</a> ·
  <a href="#przywoływanie">Przywoływanie</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Czym jest Magic Context?

Nie zatrudniasz dewelopera tylko po to, aby naprawił jeden błąd, i nie zwalniasz go w chwili wydania poprawki. Dobrych ludzi zatrzymujesz. Poznają kod, pamiętają, dlaczego podjęto decyzje, i z każdym tygodniem są skuteczniejsi.

Agenci programistyczni działają odwrotnie. Każde zadanie to nowy pracownik bez pamięci o projekcie, a na końcu każdej sesji zwalniasz go i zaczynasz od zera. W połowie zadania trafiają nawet na pauzy "compaction", które przerywają przepływ i po cichu gubią to, co wiedzieli. To amnezja następcza, taka jak przy uszkodzeniu hipokampa.

Magic Context daje im taki hipokamp. To **hipokamp** dla agentów programistycznych, część mózgu, która tworzy wspomnienia, konsoliduje je i przywołuje, całkowicie w tle. Sesja przestaje być jednorazowym wykonawcą i staje się długoterminowym członkiem zespołu obecnym przez cały projekt:

- **Przechwytywanie.** Gdy historian kompresuje twoją historię, podnosi trwałą wiedzę (decyzje, ograniczenia, konwencje) do pamięci projektu. Dostajesz system pamięci za darmo, z pracy, którą już wykonujesz.
- **Konsolidacja.** W nocy agenci dreamer robią to, co sen robi dla ciebie: sprawdzają wspomnienia z kodem, porządkują duplikaty i stare wpisy oraz promują to, co się powtarza.
- **Przywoływanie.** Właściwe wspomnienia pojawiają się automatycznie w każdej turze, a agent może na żądanie szukać w pamięciach, dawnych rozmowach i historii git. Między sesjami oraz między OpenCode i Pi.

Dwie obietnice: agent **nigdy nie zatrzymuje się, aby zarządzać kontekstem** (brak pauz compaction, brak przerwanego przepływu) i **nigdy nie zapomina**.

Uruchom jedną sesję na projekt i utrzymuj ją przez tygodnie, miesiące albo lata. Zapamięta wszystko, co razem zbudowaliście.

---

## Szybki start

Uruchom interaktywny kreator konfiguracji. Wykrywa modele, konfiguruje wszystko i obsługuje zgodność.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Albo uruchom bezpośrednio (dowolny OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Kreator automatycznie wykrywa, jakie harnesses masz (OpenCode, Pi albo oba), dodaje plugin, wyłącza wbudowane compaction, pomaga wybrać modele dla historian i dreamer oraz rozwiązuje konflikty z innymi pluginami zarządzania kontekstem. Wybierz konkretny harness przez `--harness opencode` lub `--harness pi`.

> **Dlaczego wyłączać wbudowane compaction?** Magic Context sam zarządza kontekstem. Compaction hosta zakłócałoby jego opóźnione operacje świadome cache i kompresowałoby podwójnie.

**Konfiguracja ręczna** (OpenCode): dodaj plugin i wyłącz compaction w `opencode.json`, potem umieść `magic-context.jsonc` w `<project>/.cortexkit/` (albo `~/.config/cortexkit/` dla domyślnych ustawień użytkownika). Zobacz [referencję konfiguracji](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (wymaga Pi `>= 0.74.0`). Rozszerzenie Pi współdzieli tę samą bazę danych co OpenCode; pamięci projektu i embeddings łączą się między nimi.

**Rozwiązywanie problemów:** `npx @cortexkit/magic-context@latest doctor` automatycznie wykrywa harnesses, sprawdza konflikty (compaction, OMO hooks, DCP), weryfikuje plugin i pasek boczny TUI, wykonuje kontrolę integralności bazy danych i naprawia to, co może. Dodaj `--issue`, aby utworzyć raport błędu gotowy do wysłania.

Działa tak samo w nowym i długo prowadzonym projekcie: zainstaluj, zrestartuj harness, a Magic Context od tego momentu przechwytuje kontekst. Nie uzupełnia sesji OpenCode ani Pi sprzed instalacji.

<details>
<summary><strong>Zgodność z innymi pluginami zarządzania kontekstem</strong></summary>

<br>

Magic Context zarządza kontekstem od początku do końca, więc **wyłącza się**, jeśli inny plugin już wykonuje tę pracę. Dwa menedżery kontekstu naraz podwójnie kompresowałyby historię i niszczyły stabilność cache promptu. Przy starcie sprawdza następujące rzeczy; setup i `doctor` pomagają rozwiązać każdą z nich, a dopóki nie są rozwiązane, Magic Context pozostaje wyłączony (fail-safe) i mówi dlaczego:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context je zastępuje. Setup je wyłącza.
- **DCP** (`opencode-dcp`): osobny plugin do przycinania kontekstu. Nie mogą działać razem; usuń go z listy `plugin`.
- **oh-my-opencode (OMO)**: setup proponuje wyłączyć trzy pokrywające się hooks:
  - `preemptive-compaction`: uruchamia compaction kolidujące z historian.
  - `context-window-monitor`: wstrzykuje ostrzeżenia użycia pokrywające się z podpowiedziami Magic Context.
  - `anthropic-context-window-limit-recovery`: uruchamia awaryjne compaction omijające historian.

Uruchom `npx @cortexkit/magic-context@latest doctor` w dowolnym momencie, aby sprawdzić ponownie i naprawić automatycznie.

</details>

---

## Część CortexKit

Mózg nie jest jednym organem. Zdolny agent programistyczny też nie.

**CortexKit** to rodzina pluginów, z których każdy jest wzorowany na innym obszarze mózgu. Zainstaluj jeden, a agent będzie ostrzejszy. Zainstaluj wszystkie trzy, a będzie miał mózg.

| Plugin | Region | Co robi |
|---|---|---|
| **Magic Context** *(jesteś tutaj)* | Hipokamp i przyśrodkowy płat skroniowy | Samozarządzający kontekst i pamięć długoterminowa. Utrzymuje sesje bez pauz compaction, jednocześnie tworząc, konsolidując i przywołując wiedzę projektu między nimi. |
| **[AFT](https://github.com/cortexkit/aft)** | Kora sensomotoryczna | Dostrzega strukturę kodu i działa na niej precyzyjnie. Porządne IDE i OS dla twojego agenta. |
| **Alfonso** *(wkrótce)* | Kora przedczołowa | Kontrola wykonawcza. Planuje, dzieli pracę, wybiera agentów i modele oraz decyduje, kiedy pytać, weryfikować i commitować. |

Magic Context to **1 z 3 pluginów, których kiedykolwiek będziesz potrzebować.** On pamięta; AFT postrzega i działa; Alfonso decyduje. Współdzielą jeden magazyn CortexKit, więc pamięć łączy się między harnesses i narzędziami.

---

## ⚡ Zarządzanie kontekstem

*Nieograniczona sesja, która zarządza się sama.* Okno kontekstu wypełnia się podczas pracy, a typowa naprawa, compaction, zatrzymuje agenta, żeby wszystko przeczytał ponownie. Magic Context obsługuje to stale w tle, więc sesja po prostu trwa dalej.

- **Kompartymentacja historian**: działający w tle historian kompresuje starą surową historię w **warstwowe kompartymenty**, chronologiczne streszczenia zastępujące starsze wiadomości. Każdy ma wynik ważności, więc aktywne okno pozostaje małe bez utraty wątku. Streszczanie nie potrzebuje siły programistycznej głównego agenta, więc historian może działać na tanim lub nawet w pełni lokalnym modelu, gdy główny agent pozostaje najwyższej klasy.
- **Renderowanie zanikania**: kompartymenty są renderowane z odpowiednią wiernością na dany moment, deterministyczną regułą bez LLM, która dostraja się do okna kontekstu modelu. Stara historia łagodnie blednie zamiast spadać z klifu, a ponieważ jest deterministyczna, ta sama historia zawsze renderuje się tak samo.
- **Agent podpowiada, co wyrzucić, albo nie**: przy włączonej redukcji sterowanej przez agenta agent wywołuje `ctx_reduce`, aby oznaczyć stare wyjścia narzędzi lub długie wiadomości do usunięcia. Zrzuty są **kolejkowane i świadome cache**, stosowane tylko w bezpiecznych momentach, więc redukcja nigdy nie niszczy cache. Wyłącz to, a agent całkiem wychodzi z zarządzania kontekstem: stare wyjścia są usuwane automatycznie według wieku, z opcjonalną kompresją caveman najstarszego tekstu.
- **Układ stabilny dla cache**: wszystko jest ułożone tak, aby praca w tle nigdy nie unieważniała cache'owanego prefiksu promptu. Cache przeżywa całą sesję.

Rezultat: jedna sesja działa miesiącami, bez pauz compaction i tanio u dostawców wyceniających cache. Możesz oglądać to w TUI OpenCode, gdzie pasek boczny na żywo pokazuje podział kontekstu według źródła, status historian i liczniki pamięci, aktualizując się po każdej wiadomości.

> *Opcjonalne (domyślnie wyłączone):* **caveman text compression** stopniowo kompresuje najstarszy tekst użytkownika i assistant deterministyczną regułą wiekową, dla sesji działających z wyłączoną redukcją sterowaną przez agenta.

---

## 🧠 Przechwytywanie

*Pamięć za darmo.* Aby skompresować historię, historian musi ją całą przeczytać. W tym samym przebiegu wyciąga więc wiedzę wartą zachowania na zawsze, decyzje, ograniczenia, konwencje, wartości konfiguracji, i promuje ją do **pamięci projektu**, skategoryzowaną i przenoszoną do każdej przyszłej sesji. Twoja pamięć buduje się sama z pracy, którą już wykonujesz.

Agent może też zapisywać pamięci jawnie, choć większość jest przechwytywana automatycznie:

- **`ctx_memory`**: zapisuj lub usuwaj wiedzę między sesjami bezpośrednio, w małej taksonomii kategorii (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Świadomość czasu** *(domyślnie włączona)* daje agentowi poczucie czasu, z markerami przerw jak `+2h 15m` między wiadomościami i datowanymi kompartymentami, aby mógł rozumować, jak dawno coś się wydarzyło. Ustaw `temporal_awareness: false`, aby wyłączyć.

---

## 🌙 Konsolidacja

*To, co sen robi dla pamięci.* Opcjonalny agent **dreamer** działa nocą, aby utrzymać wysoką jakość pamięci, uruchamiając efemeryczne sesje potomne dla każdego zadania:

- **Weryfikuj**: przyrostowo sprawdzaj pamięci z aktualną codebase (ścieżki, konfiguracje, wzorce) i naprawiaj albo usuwaj stare fakty.
- **Kuratoruj**: skanuj całą pulę pamięci, aby łączyć duplikaty, skracać sformułowania i archiwizować wpisy niskiej wartości lub redundantne.
- **Klasyfikuj**: oceniaj ważność, zakres i bezpieczną udostępnialność każdej pamięci bez naruszania cache aktywnego promptu.
- **Utrzymuj docs**: aktualizuj `ARCHITECTURE.md` i `STRUCTURE.md` na podstawie zmian w codebase.
- **Pamięci użytkownika**: promuj powtarzające się obserwacje o tym, jak pracujesz (styl komunikacji, fokus review, wzorce pracy) do `<user-profile>`, który podróżuje z każdą sesją.
- **Smart notes**: oceniaj odroczone notatki, których `surface_condition` stał się prawdziwy, i pokazuj gotowe.

Ponieważ działa w czasie bezczynności, dreamer dobrze łączy się z lokalnymi modelami, nawet wolnymi. Nikt nie czeka. Uruchom przebieg w dowolnym momencie przez `/ctx-dream`.

---

## 🔎 Przywoływanie

*Właściwa pamięć we właściwym momencie.* W każdej turze aktywne pamięci projektu i skompaktowana historia sesji są wstrzykiwane automatycznie i stabilnie dla cache. Na żądanie agent sięga po:

- **`ctx_search`**: jedno zapytanie przez trzy warstwy naraz: projektowe **memories**, surową historię **conversation** i zindeksowane **git commits**. Semantyczne embeddings z fallbackiem pełnotekstowym.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: przywróć skompresowany zakres historii do oryginalnego transcript `U:`/`A:`, gdy agent potrzebuje dokładnych szczegółów.
- **`ctx_note`**: scratchpad dla odroczonych intencji. Notatki wracają na naturalnych granicach (po commitach, po przebiegach historian, gdy todos się kończą). **Smart notes** niosą otwarty warunek, którego pilnuje dreamer.

Przywoływanie działa **między sesjami** (nowa sesja dziedziczy wszystko) i **między harnesses** (zapisz pamięć w OpenCode, odczytaj ją w Pi).

> **Automatyczne podpowiedzi wyszukiwania** *(domyślnie włączone)* uruchamiają w tle `ctx_search` w każdej turze i szepczą "mgliste przypomnienie", gdy istnieje coś istotnego, jak prawie przypomniana notatka. Dodaje tylko zwarte fragmenty, nigdy pełną treść; ustaw `memory.auto_search.enabled: false`, aby wyłączyć. **Indeksowanie git commitów** *(opt-in)* czyni historię projektu semantycznie przeszukiwalną jako czwarte źródło `ctx_search`, włącz przez `memory.git_commit_indexing.enabled: true`.

### Narzędzia agenta w skrócie

| Narzędzie | Sekcja | Co robi |
|------|-------|-------------|
| `ctx_reduce` | Kontekst | Kolejkuje stare oznaczone treści do usunięcia, świadomie wobec cache |
| `ctx_memory` | Przechwytywanie | Zapisuje lub usuwa trwałe pamięci między sesjami |
| `ctx_search` | Przywoływanie | Szuka w pamięciach, historii rozmów i git commits |
| `ctx_expand` | Przywoływanie | Dekompresuje zakres historii z powrotem do transcript |
| `ctx_note` | Przywoływanie | Odroczone intencje i smart notes oceniane przez dreamer |

---

## Polecenia

| Polecenie | Opis |
|---------|-------------|
| `/ctx-status` | Widok debugowania: tags, pending drops, cache TTL, stan nudge, postęp historian, pokrycie kompartymentów, budżet historii |
| `/ctx-flush` | Natychmiast wymuś wszystkie operacje w kolejce, z pominięciem cache TTL |
| `/ctx-recomp` | Przebuduj kompartymenty z surowej historii (akceptuje zakres `start-end`). Użyj, gdy zapisany stan wygląda źle |
| `/ctx-dream` | Uruchom konserwację dreamer na żądanie: pamięć, docs, smart notes i review user-profile |

---

## Aplikacja desktopowa

Towarzysząca aplikacja desktopowa do przeglądania i zarządzania stanem Magic Context poza terminalem.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Przeglądarka pamięci**: szukaj, filtruj i edytuj pamięci projektu według kategorii i projektu.
- **Historia sesji**: przeglądaj kompartymenty i notatki dowolnej sesji z nawigacją po osi czasu.
- **Diagnostyka cache**: linia czasu hit/miss cache w czasie rzeczywistym i wykrywanie przyczyn bust.
- **Zarządzanie dreamer**: oglądaj historię dream-run, uruchamiaj przebiegi, sprawdzaj wyniki zadań.
- **Edytor konfiguracji**: edycja formularzowa każdego ustawienia, w tym łańcuchów fallback modeli.
- **Podgląd logów**: live-tailing logów z wyszukiwaniem.

Czyta bezpośrednio z bazy SQLite Magic Context. Bez dodatkowego serwera, bez API. Automatyczne aktualizacje są wbudowane.

---

## Konfiguracja

Ustawienia znajdują się w `magic-context.jsonc`. Wszystko ma sensowne domyślne wartości; konfiguracja projektu nakłada się na ustawienia użytkownika. Pełna referencja, strojenie cache TTL, progi execute per model, wybór modeli historian i dreamer, dostawcy embeddings oraz ustawienia pamięci, jest w **[CONFIGURATION.md](./CONFIGURATION.md)** albo **[referencji konfiguracji na docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Lokalizacje konfiguracji** (jedna współdzielona lokalizacja CortexKit, projekt nadpisuje użytkownika):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Uaktualniasz ze starszej wersji? Istniejąca konfiguracja jest automatycznie przenoszona tutaj przy pierwszym uruchomieniu (w starej ścieżce zostaje okruszek `.MOVED_READPLEASE`).

---

## Przechowywanie

Cały trwały stan żyje w lokalnej bazie SQLite we wspólnym magazynie CortexKit (`~/.local/share/cortexkit/magic-context/context.db`, odpowiednik XDG w Windows; stare bazy z folderu OpenCode są migrowane przy pierwszym starcie). Jeśli bazy nie da się otworzyć, Magic Context wyłącza się i powiadamia cię. Pamięci są kluczowane do **stabilnej tożsamości projektu** wyprowadzonej z repo, więc podążają za projektem między worktrees, clones i forks, zamiast trzymać się ścieżki katalogu.

Magic Context zapisuje też w kilku innych miejscach:

| Ścieżka | Co | Trwałość |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Baza SQLite, tags, kompartymenty, pamięci, cały trwały stan (odpowiednik XDG w Windows) | **Musi przetrwać.** Utrata oznacza utratę pamięci/historii. |
| `~/.local/share/cortexkit/magic-context/models/` | Lokalny cache modelu embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), pobierany przy pierwszym użyciu, gdy lokalne embeddings są włączone | Powinien przetrwać, inaczej pobiera się ponownie przy każdym uruchomieniu. Nie jest używany, gdy `memory.enabled: false` albo skonfigurowano backend embeddings `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log diagnostyczny | Tymczasowy. |

**Środowiska sandbox / efemeryczne (Docker, CI, jednorazowe kontenery):** zamontuj katalog `~/.local/share/cortexkit/magic-context/` na trwałym wolumenie, aby baza i cache modelu przetrwały między uruchomieniami. Jeśli tylko cache modelu jest efemeryczny, model po prostu pobierze się ponownie; jeśli baza jest efemeryczna, pamięć i historia nie będą się kumulować. Aby całkowicie uniknąć pobierania modelu ~90 MB, ustaw `memory.enabled: false` albo skieruj `embedding` na zdalny backend `openai_compatible`/`ollama`.

---

## Historia gwiazdek

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Rozwój

**Wymagania:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Wykonywanie Dream wymaga działającego serwera OpenCode (dreamer tworzy efemeryczne sesje potomne). Użyj `/ctx-dream` w OpenCode do konserwacji na żądanie.

---

## Współtworzenie

Zgłoszenia bugów i pull requests są mile widziane. Przy większych zmianach najpierw otwórz issue, aby omówić podejście. Uruchom `bun run format` przed wysłaniem; CI odrzuca niesformatowany kod.

---

## Licencja

[MIT](LICENSE)
