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
  <strong>Русский</strong> |
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

*Это перевод сообщества. Английский [README.md](./README.md) является источником истины и может быть более актуальным.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Безграничный контекст. Память, которая управляет собой. Одна сессия, на всю жизнь.</strong><br>
  Гиппокамп для кодирующих агентов, часть CortexKit.
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
  <em>Вы не нанимаете разработчика на одну задачу и не увольняете его после релиза.<br>Не делайте так со своим агентом.</em>
</p>

<p align="center">
  <a href="#что-такое-magic-context">Что такое Magic Context?</a> ·
  <a href="#быстрый-старт">Быстрый старт</a> ·
  <a href="#часть-cortexkit">CortexKit</a> ·
  <a href="#управление-контекстом">Контекст</a> ·
  <a href="#захват">Захват</a> ·
  <a href="#консолидация">Консолидация</a> ·
  <a href="#вспоминание">Вспоминание</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Что такое Magic Context?

Вы не нанимаете разработчика, чтобы исправить один баг, и не увольняете его в момент релиза. Хороших людей оставляют. Они изучают кодовую базу, помнят, почему принимались решения, и каждую неделю становятся сильнее.

Кодирующие агенты работают наоборот. Каждая задача похожа на нового сотрудника без памяти о вашем проекте, а в конце каждой сессии вы увольняете его и начинаете с нуля. В середине задачи они даже упираются в паузы "compaction", которые ломают поток и тихо теряют то, что агент знал. Это антероградная амнезия, то же самое, что происходит при повреждении гиппокампа.

Magic Context дает им этот гиппокамп. Это **гиппокамп** для кодирующих агентов, часть мозга, которая формирует воспоминания, консолидирует их и вызывает обратно, полностью в фоне. Сессия перестает быть одноразовым подрядчиком и становится долгосрочным товарищем по команде, который был рядом весь проект:

- **Захват.** Когда historian сжимает вашу историю, он поднимает устойчивые знания (решения, ограничения, соглашения) в память проекта. Вы получаете систему памяти бесплатно, из работы, которую уже делаете.
- **Консолидация.** Ночью агенты dreamer делают то, что сон делает для вас: проверяют воспоминания по кодовой базе, приводят в порядок дубликаты и устаревшие записи, продвигают повторяющееся.
- **Вспоминание.** Нужные воспоминания автоматически всплывают на каждом ходу, а агент может по запросу искать по памяти, прошлым разговорам и истории git. Между сессиями, а также между OpenCode и Pi.

Два обещания: ваш агент **никогда не останавливается, чтобы управлять контекстом** (нет пауз compaction, нет сломанного потока) и **никогда не забывает**.

Запустите одну сессию на проект и поддерживайте ее неделями, месяцами или годами. Она запомнит все, что вы построили вместе.

---

## Быстрый старт

Запустите интерактивный мастер настройки. Он обнаружит ваши модели, все настроит и обработает совместимость.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Или запустите напрямую (любой OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Мастер автоматически определяет, какие harnesses у вас есть (OpenCode, Pi или оба), добавляет plugin, отключает встроенный compaction, помогает выбрать модели для historian и dreamer, а также решает конфликты с другими plugin управления контекстом. Укажите конкретный harness через `--harness opencode` или `--harness pi`.

> **Зачем отключать встроенный compaction?** Magic Context сам управляет контекстом. Compaction хоста мешал бы его отложенным операциям с учетом cache и сжимал бы дважды.

**Ручная настройка** (OpenCode): добавьте plugin и отключите compaction в `opencode.json`, затем поместите `magic-context.jsonc` в `<project>/.cortexkit/` (или в `~/.config/cortexkit/` для пользовательских значений по умолчанию). См. [справочник конфигурации](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (требуется Pi `>= 0.74.0`). Расширение Pi использует ту же базу данных, что и OpenCode; память проекта и embeddings объединяются между ними.

**Устранение неполадок:** `npx @cortexkit/magic-context@latest doctor` автоматически обнаруживает harnesses, проверяет конфликты (compaction, OMO hooks, DCP), проверяет plugin и боковую панель TUI, запускает проверку целостности базы данных и исправляет то, что может. Добавьте `--issue`, чтобы создать готовый к отправке отчет о bug.

Одинаково работает на новом или давно живущем проекте: установите, перезапустите harness, и Magic Context начнет захватывать контекст с этого момента. Он не заполняет задним числом сессии OpenCode или Pi, которые были до установки.

<details>
<summary><strong>Совместимость с другими plugin управления контекстом</strong></summary>

<br>

Magic Context владеет управлением контекстом от начала до конца, поэтому **отключает себя**, если другой plugin уже выполняет эту работу. Два менеджера контекста одновременно дважды сжимали бы историю и портили prompt cache. При запуске он проверяет следующее; setup и `doctor` помогают решить каждый пункт, и пока они не решены, Magic Context остается выключенным (fail-safe) и объясняет почему:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context заменяет его. Setup отключает его.
- **DCP** (`opencode-dcp`): отдельный plugin для обрезки контекста. Они не могут работать вместе; удалите его из списка `plugin`.
- **oh-my-opencode (OMO)**: setup предлагает отключить три перекрывающихся hooks:
  - `preemptive-compaction`: запускает compaction, конфликтующий с historian.
  - `context-window-monitor`: вставляет предупреждения об использовании, которые перекрываются с nudges Magic Context.
  - `anthropic-context-window-limit-recovery`: запускает аварийный compaction, обходящий historian.

Запускайте `npx @cortexkit/magic-context@latest doctor` в любое время, чтобы проверить снова и исправить автоматически.

</details>

---

## Часть CortexKit

Мозг не состоит из одного органа. Способный кодирующий агент тоже.

**CortexKit** это семейство plugin, каждый из которых моделирует отдельную область мозга. Установите один, и агент станет острее. Установите все три, и у него будет мозг.

| Plugin | Область | Что делает |
|---|---|---|
| **Magic Context** *(вы здесь)* | Гиппокамп и медиальная височная доля | Самоуправляемый контекст и долговременная память. Держит сессии без пауз compaction, пока формирует, консолидирует и вспоминает знания проекта между ними. |
| **[AFT](https://github.com/cortexkit/aft)** | Сенсомоторная кора | Воспринимает структуру кода и точно действует по ней. Настоящие IDE и OS для вашего агента. |
| **Alfonso** *(скоро)* | Префронтальная кора | Исполнительный контроль. Планирует, разбивает работу, выбирает агентов и модели, решает, когда спрашивать, проверять и commit. |

Magic Context это **1 из 3 plugin, которые вам когда-либо понадобятся.** Он помнит; AFT воспринимает и действует; Alfonso решает. Они делят одно хранилище CortexKit, поэтому память объединяется между harnesses и инструментами.

---

## ⚡ Управление контекстом

*Безграничная сессия, которая управляет собой.* Окно контекста заполняется по мере работы, а обычное решение, compaction, резко останавливает агента, чтобы перечитать все. Magic Context обрабатывает это непрерывно в фоне, поэтому сессия просто продолжается.

- **Компартментализация historian**: фоновый historian сжимает старую сырую историю в **многоуровневые компартменты**, хронологические сводки, которые заменяют старые сообщения. У каждого есть оценка важности, поэтому живое окно остается маленьким без потери нити. Суммаризация не требует кодирующей силы основного агента, поэтому historian можно запускать на дешевой или даже полностью локальной модели, пока главный агент остается топовым.
- **Decay rendering**: компартменты отображаются с нужной для момента точностью по детерминированному правилу без LLM, которое само подстраивается под окно контекста модели. Старая история плавно исчезает, а не падает с обрыва, и поскольку правило детерминировано, одна и та же история всегда отображается одинаково.
- **Агент подсказывает, что убрать, или не подсказывает**: при включенном сокращении агентом агент вызывает `ctx_reduce`, чтобы пометить устаревшие выводы инструментов или длинные сообщения на удаление. Удаления **ставятся в очередь и учитывают cache**, применяются только в cache-безопасные моменты, так что сокращение никогда не портит cache. Выключите это, и агент полностью не участвует в управлении контекстом: устаревший вывод удаляется автоматически по возрасту, с опциональным caveman-сжатием самого старого текста.
- **Cache-стабильная раскладка**: все устроено так, чтобы фоновая работа никогда не инвалидировала кешированный префикс prompt. Cache переживает всю сессию.

Итог: одна сессия работает месяцами, без пауз compaction и с низкой стоимостью у провайдеров с cache-ценами. Это видно в TUI OpenCode, где живая боковая панель показывает разбор контекста по источникам, статус historian и число воспоминаний, обновляясь после каждого сообщения.

> *Опционально (по умолчанию выключено):* **caveman text compression** постепенно сжимает самый старый текст user и assistant детерминированным возрастным правилом, для сессий с выключенным агентским сокращением.

---

## 🧠 Захват

*Память бесплатно.* Чтобы сжать историю, historian должен прочитать ее всю. Поэтому в том же проходе он извлекает знания, которые стоит хранить всегда, решения, ограничения, соглашения, значения конфигурации, и повышает их до **памяти проекта**, классифицированной и переносимой в каждую будущую сессию. Ваша память строится сама из работы, которую вы уже делаете.

Агент также может явно записывать воспоминания, хотя большинство захватывается автоматически:

- **`ctx_memory`**: напрямую записывать или удалять знания между сессиями в небольшой таксономии категорий (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Осознание времени** *(по умолчанию включено)* дает агенту чувство времени, с маркерами разрывов вроде `+2h 15m` между сообщениями и датированными компартментами, чтобы он мог рассуждать, как давно что-то произошло. Установите `temporal_awareness: false`, чтобы отключить.

---

## 🌙 Консолидация

*То, что сон делает для памяти.* Опциональный агент **dreamer** запускается ночью, чтобы поддерживать качество памяти, создавая эфемерные дочерние сессии для каждой задачи:

- **Проверять**: постепенно сверять воспоминания с текущей кодовой базой (пути, конфиги, паттерны) и исправлять или удалять устаревшие факты.
- **Курировать**: сканировать весь пул памяти, объединять дубликаты, уплотнять формулировки и архивировать записи низкой ценности или избыточные.
- **Классифицировать**: оценивать важность, область и безопасную совместимость каждого воспоминания, не тревожа живой prompt cache.
- **Поддерживать docs**: держать `ARCHITECTURE.md` и `STRUCTURE.md` актуальными по изменениям кодовой базы.
- **Пользовательские воспоминания**: продвигать повторяющиеся наблюдения о том, как вы работаете (стиль общения, фокус review, рабочие паттерны), в `<user-profile>`, который путешествует с каждой сессией.
- **Smart notes**: оценивать отложенные заметки, чье `surface_condition` стало истинным, и показывать готовые.

Поскольку dreamer работает во время простоя, он хорошо сочетается с локальными моделями, даже медленными. Никто не ждет. Запустите прогон в любой момент через `/ctx-dream`.

---

## 🔎 Вспоминание

*Нужная память в нужный момент.* Каждый ход активные памяти проекта и компактная история сессии автоматически и cache-стабильно внедряются. По запросу агент использует:

- **`ctx_search`**: один запрос сразу по трем слоям: проектные **memories**, сырая история **conversation** и индексированные **git commits**. Семантические embeddings с полнотекстовым fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: вернуть сжатый диапазон истории к исходному transcript `U:`/`A:`, когда агенту нужны точные детали.
- **`ctx_note`**: scratchpad для отложенных намерений. Заметки всплывают на естественных границах (после commits, после запусков historian, когда todos завершены). **Smart notes** несут открытое условие, за которым следит dreamer.

Вспоминание работает **между сессиями** (новая сессия наследует все) и **между harnesses** (записать память в OpenCode, получить ее в Pi).

> **Автопоисковые подсказки** *(по умолчанию включены)* запускают фоновый `ctx_search` каждый ход и шепчут "смутное воспоминание", когда есть что-то релевантное, как почти вспомненная заметка. Добавляются только компактные фрагменты, никогда полный контент; установите `memory.auto_search.enabled: false`, чтобы отключить. **Индексация git commits** *(opt-in)* делает историю проекта семантически searchable как четвертый источник `ctx_search`, включается через `memory.git_commit_indexing.enabled: true`.

### Инструменты агента кратко

| Инструмент | Раздел | Что делает |
|------|-------|-------------|
| `ctx_reduce` | Контекст | Ставит устаревший tagged content в очередь на удаление, с учетом cache |
| `ctx_memory` | Захват | Записывает или удаляет долговременные межсессионные воспоминания |
| `ctx_search` | Вспоминание | Ищет в памяти, истории разговоров и git commits |
| `ctx_expand` | Вспоминание | Декомпрессирует диапазон истории обратно в transcript |
| `ctx_note` | Вспоминание | Отложенные намерения и smart notes, оцениваемые dreamer |

---

## Команды

| Команда | Описание |
|---------|-------------|
| `/ctx-status` | Debug view: tags, pending drops, cache TTL, nudge state, прогресс historian, покрытие компартментов, бюджет истории |
| `/ctx-flush` | Немедленно принудительно выполнить все операции в очереди, обходя cache TTL |
| `/ctx-recomp` | Перестроить компартменты из сырой истории (принимает диапазон `start-end`). Используйте, когда сохраненное состояние кажется неверным |
| `/ctx-dream` | Запустить обслуживание dreamer по запросу: память, docs, smart notes и review user-profile |

---

## Настольное приложение

Сопутствующее настольное приложение для просмотра и управления состоянием Magic Context вне терминала.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Браузер памяти**: искать, фильтровать и редактировать память проекта по категории и проекту.
- **История сессии**: просматривать компартменты и заметки любой сессии с навигацией по временной шкале.
- **Диагностика cache**: реальная шкала cache hit/miss и обнаружение причин bust.
- **Управление dreamer**: смотреть историю dream-run, запускать прогоны, изучать результаты задач.
- **Редактор конфигурации**: редактирование всех настроек через формы, включая цепочки model fallback.
- **Просмотр log**: live-tailing logs с поиском.

Оно читает напрямую из SQLite базы Magic Context. Без дополнительного сервера, без API. Автообновления встроены.

---

## Конфигурация

Настройки находятся в `magic-context.jsonc`. У всего есть разумные значения по умолчанию; конфигурация проекта накладывается поверх пользовательских настроек. Полный справочник, настройка cache TTL, пороги execute по моделям, выбор моделей historian и dreamer, поставщики embeddings и настройки памяти, см. в **[CONFIGURATION.md](./CONFIGURATION.md)** или **[справочнике конфигурации на docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Места конфигурации** (одно общее место CortexKit, проект переопределяет пользователя):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Обновляетесь с ранней версии? Существующая конфигурация автоматически переносится сюда при первом запуске (по старому пути остается след `.MOVED_READPLEASE`).

---

## Хранилище

Все долговременное состояние хранится в локальной SQLite базе под общим хранилищем CortexKit (`~/.local/share/cortexkit/magic-context/context.db`, XDG-эквивалент в Windows; устаревшие базы из папки OpenCode мигрируют при первом запуске). Если базу нельзя открыть, Magic Context отключает себя и уведомляет вас. Память привязана к **стабильной идентичности проекта**, полученной из repo, поэтому она следует за проектом через worktrees, clones и forks, а не привязана к пути каталога.

Magic Context также пишет в несколько других мест:

| Путь | Что | Постоянство |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite база, tags, компартменты, память, все долговременное состояние (XDG-эквивалент в Windows) | **Должна сохраняться.** Потеря означает потерю памяти/истории. |
| `~/.local/share/cortexkit/magic-context/models/` | Локальный cache модели embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), скачивается при первом использовании, когда локальные embeddings включены | Лучше сохранять, иначе будет скачиваться при каждом запуске. Не используется, когда `memory.enabled: false` или настроен backend embeddings `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Диагностический log | Можно удалить. |

**Sandbox / эфемерные среды (Docker, CI, одноразовые контейнеры):** смонтируйте каталог `~/.local/share/cortexkit/magic-context/` на постоянный volume, чтобы база и cache модели переживали запуски. Если эфемерен только cache модели, модель просто скачивается заново; если эфемерна база, память и история не накапливаются. Чтобы полностью избежать скачивания модели ~90 MB, установите `memory.enabled: false` или направьте `embedding` на удаленный backend `openai_compatible`/`ollama`.

---

## История звезд

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Разработка

**Требования:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Для выполнения Dream нужен живой сервер OpenCode (dreamer создает эфемерные дочерние сессии). Используйте `/ctx-dream` внутри OpenCode для обслуживания по запросу.

---

## Участие

Bug reports и pull requests приветствуются. Для крупных изменений сначала откройте issue, чтобы обсудить подход. Запустите `bun run format` перед отправкой; CI отклоняет неформатированный код.

---

## Лицензия

[MIT](LICENSE)
