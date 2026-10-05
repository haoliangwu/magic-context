<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <strong>Deutsch</strong> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
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

*Dies ist eine Community-Übersetzung. Die englische [README.md](./README.md) ist die maßgebliche Quelle und kann aktueller sein.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Unbegrenzter Kontext. Speicher, der sich selbst verwaltet. Eine Sitzung, ein Leben lang.</strong><br>
  Der Hippocampus für Coding-Agenten, Teil von CortexKit.
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
  <em>Du stellst keinen Entwickler für eine Aufgabe ein und entlässt ihn, sobald er liefert.<br>Hör auf, das mit deinem Agenten zu tun.</em>
</p>

<p align="center">
  <a href="#was-ist-magic-context">Was ist Magic Context?</a> ·
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#teil-von-cortexkit">CortexKit</a> ·
  <a href="#kontextverwaltung">Kontext</a> ·
  <a href="#erfassen">Erfassen</a> ·
  <a href="#konsolidieren">Konsolidieren</a> ·
  <a href="#abrufen">Abrufen</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Was ist Magic Context?

Du stellst keinen Entwickler ein, damit er einen Fehler behebt, und entlässt ihn in dem Moment, in dem die Änderung ausgeliefert wird. Die guten behältst du. Sie lernen die Codebasis, erinnern sich daran, warum Entscheidungen getroffen wurden, und werden jede Woche schärfer.

Coding-Agenten funktionieren genau umgekehrt. Jede Aufgabe ist eine Neueinstellung ohne Erinnerung an dein Projekt, und am Ende jeder Sitzung entlässt du sie und beginnst wieder bei null. Mitten in der Aufgabe treffen sie sogar auf "compaction"-Pausen, die den Fluss unterbrechen und still verwerfen, was sie wussten. Das ist anterograde Amnesie, dasselbe, was passiert, wenn der Hippocampus geschädigt ist.

Magic Context gibt ihnen einen. Es ist der **Hippocampus** für Coding-Agenten, der Teil des Gehirns, der Erinnerungen bildet, sie konsolidiert und wieder abruft, vollständig im Hintergrund. Eine Sitzung ist nicht mehr ein austauschbarer Auftragnehmer, sondern wird zu einem langfristigen Teammitglied, das das ganze Projekt begleitet hat:

- **Erfassen.** Während der historian deine Historie komprimiert, hebt er das dauerhafte Wissen (Entscheidungen, Einschränkungen, Konventionen) in den Projektspeicher. Du bekommst ein Speichersystem gratis, aus Arbeit, die du ohnehin schon tust.
- **Konsolidieren.** Über Nacht machen dreamer-Agenten das, was Schlaf für dich tut: Erinnerungen gegen die Codebasis prüfen, Duplikate und veraltete Einträge kuratieren und wiederkehrende Inhalte hochstufen.
- **Abrufen.** Die richtigen Erinnerungen erscheinen automatisch in jedem Zug, und der Agent kann bei Bedarf Erinnerungen, frühere Gespräche und die git-Historie durchsuchen. Über Sitzungen hinweg, und über OpenCode und Pi hinweg.

Zwei Versprechen: Dein Agent **hört nie auf, um seinen Kontext zu verwalten** (keine compaction-Pausen, kein gebrochener Fluss), und er **vergisst nie**.

Starte eine Sitzung pro Projekt und lass sie über Wochen, Monate oder Jahre laufen. Sie erinnert sich an alles, was ihr gemeinsam gebaut habt.

---

## Schnellstart

Führe den interaktiven Einrichtungsassistenten aus. Er erkennt deine Modelle, konfiguriert alles und kümmert sich um Kompatibilität.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Oder direkt ausführen (beliebiges OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Der Assistent erkennt automatisch, welche Harnesses du hast (OpenCode, Pi oder beide), fügt das Plugin hinzu, deaktiviert eingebaute compaction, hilft dir bei der Modellauswahl für historian und dreamer und löst Konflikte mit anderen Kontextverwaltungs-Plugins. Wähle ein bestimmtes Harness mit `--harness opencode` oder `--harness pi` aus.

> **Warum eingebaute compaction deaktivieren?** Magic Context verwaltet Kontext selbst. Die compaction des Hosts würde seine cache-bewussten verzögerten Operationen stören und doppelt komprimieren.

**Manuelle Einrichtung** (OpenCode): Füge das Plugin hinzu und schalte compaction in `opencode.json` aus. Lege dann eine `magic-context.jsonc` in `<project>/.cortexkit/` ab (oder in `~/.config/cortexkit/` für benutzerweite Defaults). Siehe die [Konfigurationsreferenz](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (erfordert Pi `>= 0.74.0`). Die Pi-Erweiterung teilt sich dieselbe Datenbank wie OpenCode. Projekterinnerungen und Embeddings werden über beide hinweg gebündelt.

**Fehlerbehebung:** `npx @cortexkit/magic-context@latest doctor` erkennt deine Harnesses automatisch, prüft auf Konflikte (compaction, OMO hooks, DCP), verifiziert das Plugin und die TUI-Seitenleiste, führt eine Integritätsprüfung der Datenbank aus und repariert, was es kann. Füge `--issue` hinzu, um einen einreichfertigen Fehlerbericht zu erstellen.

Es funktioniert gleich auf einem brandneuen oder einem lange laufenden Projekt: installieren, das Harness neu starten, und Magic Context erfasst ab dann Kontext. Es füllt keine OpenCode- oder Pi-Sitzungen aus der Zeit vor der Installation nach.

<details>
<summary><strong>Kompatibilität mit anderen Kontextverwaltungs-Plugins</strong></summary>

<br>

Magic Context besitzt die Kontextverwaltung von Anfang bis Ende, daher **deaktiviert es sich selbst**, wenn bereits ein anderes Plugin diese Aufgabe übernimmt. Zwei Kontextmanager gleichzeitig würden deine Historie doppelt komprimieren und den Prompt-Cache durcheinanderbringen. Beim Start prüft es Folgendes. setup und `doctor` helfen dir, jeden Punkt zu lösen. Bis dahin bleibt Magic Context aus (fail-safe) und sagt dir warum:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context ersetzt sie. Setup schaltet sie aus.
- **DCP** (`opencode-dcp`): ein separates Plugin zum Beschneiden von Kontext. Beide können nicht zusammen laufen. Entferne es aus deiner `plugin`-Liste.
- **oh-my-opencode (OMO)**: setup bietet an, die drei überschneidenden hooks zu deaktivieren:
  - `preemptive-compaction`: löst compaction aus, die mit dem historian kollidiert.
  - `context-window-monitor`: fügt Nutzungswarnungen ein, die sich mit Magic Contexts Hinweisen überschneiden.
  - `anthropic-context-window-limit-recovery`: löst Notfall-compaction aus, die den historian umgeht.

Führe jederzeit `npx @cortexkit/magic-context@latest doctor` aus, um erneut zu prüfen und automatisch zu reparieren.

</details>

---

## Teil von CortexKit

Ein Gehirn ist nicht ein einziges Organ. Ein fähiger Coding-Agent ist es auch nicht.

**CortexKit** ist eine Familie von Plugins, jedes nach einer anderen Gehirnregion modelliert. Installiere eines und dein Agent wird schärfer. Installiere alle drei und er hat ein Gehirn.

| Plugin | Region | Was es macht |
|---|---|---|
| **Magic Context** *(du bist hier)* | Hippocampus und medialer Temporallappen | Selbstverwaltender Kontext und Langzeitgedächtnis. Hält Sitzungen ohne compaction-Pausen am Laufen, während es projektbezogenes Wissen über Sitzungen hinweg bildet, konsolidiert und abruft. |
| **[AFT](https://github.com/cortexkit/aft)** | Sensomotorischer Cortex | Nimmt Code-Struktur wahr und handelt präzise danach. Eine richtige IDE und ein OS für deinen Agenten. |
| **Alfonso** *(kommt bald)* | Präfrontaler Cortex | Exekutive Kontrolle. Plant, zerlegt Arbeit, wählt Agenten und Modelle und entscheidet, wann gefragt, geprüft und committet wird. |

Magic Context ist **eines der 3 Plugins, die du je brauchen wirst.** Es erinnert sich; AFT nimmt wahr und handelt; Alfonso entscheidet. Sie teilen sich einen CortexKit-Speicher, sodass Erinnerungen über Harnesses und Werkzeuge hinweg zusammengeführt werden.

---

## ⚡ Kontextverwaltung

*Eine unbegrenzte Sitzung, die sich selbst verwaltet.* Das Kontextfenster füllt sich während der Arbeit, und die übliche Lösung, compaction, stoppt den Agenten abrupt, damit er alles neu liest. Magic Context erledigt das fortlaufend im Hintergrund, sodass die Sitzung einfach weiterläuft.

- **Historian-Kompartimentierung**: Ein Hintergrund-historian komprimiert alte Rohhistorie in **gestufte Kompartimente**, chronologische Zusammenfassungen, die ältere Nachrichten vertreten. Jedes trägt einen Wichtigkeitswert, sodass das Live-Fenster klein bleibt, ohne den Faden zu verlieren. Zusammenfassen braucht nicht die Coding-Muskeln deines Hauptagenten, also kannst du den historian auf einem günstigen oder sogar vollständig lokalen Modell ausführen, während dein Hauptagent erstklassig bleibt.
- **Decay-Rendering**: Kompartimente werden mit der passenden Genauigkeit für den Moment gerendert, nach einer deterministischen No-LLM-Regel, die sich selbst auf das Kontextfenster des Modells abstimmt. Alte Historie verblasst sanft, statt abrupt zu verschwinden, und weil es deterministisch ist, wird dieselbe Historie immer gleich gerendert.
- **Der Agent weist darauf hin, was fallen soll, oder eben nicht**: Wenn agentengesteuerte Reduktion aktiv ist, ruft der Agent `ctx_reduce` auf, um veraltete Tool-Ausgaben oder lange Nachrichten zur Entfernung zu markieren. Entfernungen werden **in eine Warteschlange gestellt und sind cache-bewusst**, angewendet nur in cache-sicheren Momenten, sodass Reduktion den Cache nie durcheinanderbringt. Schalte es aus, und der Agent bleibt vollständig aus der Kontextverwaltung heraus: veraltete Ausgaben werden automatisch nach Alter abgestreift, optional mit caveman-Kompression des ältesten Textes.
- **Cache-stabiles Layout**: All das ist so strukturiert, dass Hintergrundarbeit nie das gecachte Präfix deines Prompts ungültig macht. Dein Cache überlebt die ganze Sitzung.

Das Ergebnis: Eine Sitzung läuft monatelang, ohne compaction-Pausen und mit niedrigen Kosten bei cache-bepreisten Anbietern. Du kannst es in OpenCodes TUI beobachten, wo eine Live-Seitenleiste die Kontextaufteilung nach Quelle, den historian-Status und die Anzahl der Erinnerungen zeigt und nach jeder Nachricht aktualisiert wird.

> *Optional (standardmäßig aus):* **caveman text compression** komprimiert den ältesten Benutzer- und Assistant-Text schrittweise nach einer deterministischen Altersstufenregel, für Sitzungen, die mit deaktivierter agentengesteuerter Reduktion laufen.

---

## 🧠 Erfassen

*Speicher, kostenlos.* Um deine Historie zu komprimieren, muss der historian alles lesen. Im selben Durchlauf hebt er deshalb das dauerhaft wertvolle Wissen heraus, Entscheidungen, Einschränkungen, Konventionen, Konfigurationswerte, und befördert es in den **Projektspeicher**, kategorisiert und in jede zukünftige Sitzung getragen. Dein Speicher entsteht von selbst aus der Arbeit, die du bereits tust.

Der Agent kann Erinnerungen auch ausdrücklich aufzeichnen, obwohl die meisten automatisch für ihn erfasst werden:

- **`ctx_memory`**: Sitzungsübergreifendes Wissen direkt schreiben oder löschen, in einer kleinen Kategorietaxonomie (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Zeitbewusstsein** *(standardmäßig an)* gibt dem Agenten ein Gefühl für Zeit, mit Lückenmarkern wie `+2h 15m` zwischen Nachrichten und datierten Kompartimenten, sodass er darüber nachdenken kann, wie lange etwas her ist. Setze `temporal_awareness: false`, um es auszuschalten.

---

## 🌙 Konsolidieren

*Was Schlaf für Erinnerung tut.* Ein optionaler **dreamer**-Agent läuft über Nacht, um die Speicherqualität hoch zu halten, und startet für jede Aufgabe kurzlebige Kind-Sitzungen:

- **Prüfen**: Erinnerungen inkrementell gegen die aktuelle Codebasis prüfen (Pfade, Konfigurationen, Muster) und veraltete Fakten reparieren oder entfernen.
- **Kuratieren**: Den gesamten Speicherpool scannen, um Duplikate zusammenzuführen, Formulierungen zu straffen und geringwertige oder redundante Einträge zu archivieren.
- **Klassifizieren**: Wichtigkeit, Geltungsbereich und sichere Teilbarkeit jeder Erinnerung bewerten, ohne den Live-Prompt-Cache zu stören.
- **Dokumente pflegen**: `ARCHITECTURE.md` und `STRUCTURE.md` anhand von Änderungen in der Codebasis aktuell halten.
- **Benutzererinnerungen**: Wiederkehrende Beobachtungen dazu, wie du arbeitest (Kommunikationsstil, Review-Fokus, Arbeitsmuster), in ein `<user-profile>` hochstufen, das mit jeder Sitzung mitreist.
- **Smart notes**: Zurückgestellte Notizen auswerten, deren `surface_condition` wahr geworden ist, und die fertigen sichtbar machen.

Weil er in Leerlaufzeit läuft, passt der dreamer gut zu lokalen Modellen, auch langsamen. Niemand wartet. Starte jederzeit einen Lauf mit `/ctx-dream`.

---

## 🔎 Abrufen

*Die richtige Erinnerung im richtigen Moment.* In jedem Zug werden aktive Projekterinnerungen und die komprimierte Sitzungshistorie automatisch und cache-stabil injiziert. Bei Bedarf greift der Agent zu:

- **`ctx_search`**: Eine Abfrage über drei Ebenen gleichzeitig: Projekt-**memories**, rohe **conversation**-Historie und indizierte **git commits**. Semantische Embeddings mit Volltext-Fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: Einen komprimierten Historienbereich zurück zum ursprünglichen `U:`/`A:` transcript holen, wenn der Agent die exakten Details braucht.
- **`ctx_note`**: Ein Scratchpad für zurückgestellte Absichten. Notizen tauchen an natürlichen Grenzen wieder auf (nach Commits, nach historian-Läufen, wenn todos fertig sind). **Smart notes** tragen eine offene Bedingung, auf die der dreamer achtet.

Abruf funktioniert **über Sitzungen hinweg** (eine neue Sitzung erbt alles) und **über Harnesses hinweg** (eine Erinnerung in OpenCode schreiben, in Pi abrufen).

> **Automatische Suchhinweise** *(standardmäßig an)* führen in jedem Zug eine Hintergrund-`ctx_search` aus und flüstern eine "vage Erinnerung", wenn etwas Relevantes existiert, wie das Fast-Erinnern an eine Notiz, die du gemacht hast. Es hängt nur kompakte Fragmente an, nie vollständige Inhalte. Setze `memory.auto_search.enabled: false`, um es auszuschalten. **Git-Commit-Indizierung** *(Opt-in)* macht deine Projekthistorie als vierte `ctx_search`-Quelle semantisch durchsuchbar, aktivierbar mit `memory.git_commit_indexing.enabled: true`.

### Agentenwerkzeuge auf einen Blick

| Werkzeug | Abschnitt | Was es macht |
|------|-------|-------------|
| `ctx_reduce` | Kontext | Veraltete getaggte Inhalte cache-bewusst zur Entfernung einreihen |
| `ctx_memory` | Erfassen | Dauerhafte sitzungsübergreifende Erinnerungen schreiben oder löschen |
| `ctx_search` | Abrufen | Erinnerungen, Gesprächshistorie und git commits durchsuchen |
| `ctx_expand` | Abrufen | Einen Historienbereich zurück zum transcript dekomprimieren |
| `ctx_note` | Abrufen | Zurückgestellte Absichten und vom dreamer bewertete smart notes |

---

## Befehle

| Befehl | Beschreibung |
|---------|-------------|
| `/ctx-status` | Debug-Ansicht: tags, pending drops, Cache-TTL, Hinweiszustand, historian-Fortschritt, Kompartimentabdeckung, Historienbudget |
| `/ctx-flush` | Alle eingereihten Operationen sofort erzwingen und Cache-TTL umgehen |
| `/ctx-recomp` | Kompartimente aus Rohhistorie neu aufbauen (akzeptiert einen `start-end`-Bereich). Verwenden, wenn gespeicherter Zustand falsch wirkt |
| `/ctx-dream` | Dreamer-Wartung bei Bedarf ausführen: Speicher, Dokumente, smart notes und user-profile-Review pflegen |

---

## Desktop-App

Eine begleitende Desktop-App zum Durchsuchen und Verwalten des Magic Context-Zustands außerhalb des Terminals.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Speicherbrowser**: Projekterinnerungen nach Kategorie und Projekt suchen, filtern und bearbeiten.
- **Sitzungshistorie**: Kompartimente und Notizen jeder Sitzung mit Zeitliniennavigation durchsuchen.
- **Cache-Diagnose**: Echtzeit-Zeitlinie für Cache-Hits und Misses sowie Erkennung von Bust-Ursachen.
- **Dreamer-Verwaltung**: dream-run-Historie ansehen, Läufe starten, Aufgabenergebnisse prüfen.
- **Konfigurationseditor**: Formularbasierte Bearbeitung jeder Einstellung, einschließlich Modell-Fallback-Ketten.
- **Log-Viewer**: Live-tailing von Logs mit Suche.

Sie liest direkt aus der SQLite-Datenbank von Magic Context. Kein zusätzlicher Server, keine API. Automatische Updates sind eingebaut.

---

## Konfiguration

Einstellungen liegen in `magic-context.jsonc`. Alles hat sinnvolle Defaults. Projektkonfiguration wird über benutzerweite Einstellungen gelegt. Für die vollständige Referenz, Cache-TTL-Abstimmung, execute-Schwellen pro Modell, Modellwahl für historian und dreamer, Embedding-Anbieter und Speichereinstellungen, siehe **[CONFIGURATION.md](./CONFIGURATION.md)** oder die **[Konfigurationsreferenz auf docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Konfigurationsorte** (ein gemeinsamer CortexKit-Ort, Projekt überschreibt Benutzer):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Upgrade von einer früheren Version? Deine vorhandene Konfiguration wird beim ersten Lauf automatisch hierher verschoben (am alten Pfad bleibt eine `.MOVED_READPLEASE`-Spur zurück).

---

## Speicherort

Alle dauerhaften Zustände liegen in einer lokalen SQLite-Datenbank im gemeinsamen CortexKit-Speicher (`~/.local/share/cortexkit/magic-context/context.db`, XDG-Äquivalent unter Windows; ältere Datenbanken im OpenCode-Ordner werden beim ersten Start migriert). Wenn die Datenbank nicht geöffnet werden kann, deaktiviert Magic Context sich selbst und benachrichtigt dich. Erinnerungen sind an eine **stabile Projektidentität** gebunden, die aus dem repo abgeleitet wird, sodass sie einem Projekt über worktrees, clones und forks folgen, statt an einen Verzeichnispfad gebunden zu sein.

Magic Context schreibt außerdem an einige andere Orte:

| Pfad | Was | Persistenz |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite-Datenbank, tags, Kompartimente, Erinnerungen, aller dauerhafter Zustand (XDG-Äquivalent unter Windows) | **Muss bestehen bleiben.** Geht sie verloren, gehen Speicher/Historie verloren. |
| `~/.local/share/cortexkit/magic-context/models/` | Lokaler Embedding-Modellcache (ca. 90 MB `Xenova/all-MiniLM-L6-v2` ONNX), wird beim ersten Gebrauch heruntergeladen, wenn lokale Embeddings aktiviert sind | Sollte bestehen bleiben, sonst wird er bei jedem Lauf erneut heruntergeladen. Nicht verwendet, wenn `memory.enabled: false` oder ein `openai_compatible`/`ollama` Embedding-Backend konfiguriert ist. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Diagnose-Log | Wegwerfbar. |

**Sandboxed / flüchtige Umgebungen (Docker, CI, Wegwerfcontainer):** Hänge das Verzeichnis `~/.local/share/cortexkit/magic-context/` auf ein persistentes Volume, damit Datenbank und Modellcache zwischen Läufen erhalten bleiben. Wenn nur der Modellcache flüchtig ist, wird das Modell einfach erneut heruntergeladen. Wenn die Datenbank flüchtig ist, sammeln sich Speicher und Historie nicht an. Um den ca. 90 MB großen Modelldownload ganz zu vermeiden, setze `memory.enabled: false` oder richte `embedding` auf ein entferntes `openai_compatible`/`ollama` Backend.

---

## Star-Historie

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Entwicklung

**Anforderungen:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream-Ausführung erfordert einen laufenden OpenCode-Server (der dreamer erstellt kurzlebige Kind-Sitzungen). Verwende `/ctx-dream` in OpenCode für Wartung bei Bedarf.

---

## Beitragen

Fehlerberichte und pull requests sind willkommen. Öffne für größere Änderungen zuerst ein issue, um den Ansatz zu besprechen. Führe vor dem Einreichen `bun run format` aus. CI lehnt unformatierten Code ab.

---

## Lizenz

[MIT](LICENSE)
