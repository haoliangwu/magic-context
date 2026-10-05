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
  <a href="./README.no.md">Norsk</a> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <strong>Українська</strong> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*Це переклад спільноти. Англійський [README.md](./README.md) є джерелом істини і може бути актуальнішим.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Безмежний контекст. Пам'ять, що керує собою. Одна сесія, на все життя.</strong><br>
  Гіпокамп для агентів кодування, частина CortexKit.
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
  <em>Ви не наймаєте розробника для одного завдання і не звільняєте його після релізу.<br>Припиніть робити це зі своїм агентом.</em>
</p>

<p align="center">
  <a href="#що-таке-magic-context">Що таке Magic Context?</a> ·
  <a href="#швидкий-старт">Швидкий старт</a> ·
  <a href="#частина-cortexkit">CortexKit</a> ·
  <a href="#керування-контекстом">Контекст</a> ·
  <a href="#захоплення">Захоплення</a> ·
  <a href="#консолідація">Консолідація</a> ·
  <a href="#пригадування">Пригадування</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Що таке Magic Context?

Ви не наймаєте розробника, щоб виправити один bug, і не звільняєте його в момент релізу. Хороших людей залишають. Вони вивчають кодову базу, пам'ятають, чому ухвалювалися рішення, і щотижня стають точнішими.

Агенти кодування працюють навпаки. Кожне завдання це новий працівник без пам'яті про ваш проєкт, а наприкінці кожної сесії ви звільняєте його і починаєте з нуля. Посеред завдання вони навіть натрапляють на паузи "compaction", які ламають потік і тихо викидають те, що агент знав. Це антероградна амнезія, те саме, що стається при пошкодженні гіпокампа.

Magic Context дає їм його. Це **гіпокамп** для агентів кодування, частина мозку, яка формує спогади, консолідує їх і викликає назад, повністю у фоні. Сесія перестає бути одноразовим підрядником і стає довгостроковим товаришем по команді, який був поруч протягом усього проєкту:

- **Захоплення.** Коли historian стискає вашу історію, він піднімає тривалі знання (рішення, обмеження, конвенції) у пам'ять проєкту. Ви отримуєте систему пам'яті безкоштовно з роботи, яку вже робите.
- **Консолідація.** Уночі агенти dreamer роблять те, що сон робить для вас: перевіряють спогади за кодовою базою, упорядковують дублікати й застарілі записи, підвищують те, що повторюється.
- **Пригадування.** Потрібні спогади автоматично з'являються на кожному ході, а агент може за потреби шукати в пам'яті, минулих розмовах і git історії. Між сесіями, а також між OpenCode і Pi.

Дві обіцянки: ваш агент **ніколи не зупиняється, щоб керувати своїм контекстом** (немає пауз compaction, немає зламаного потоку) і **ніколи не забуває**.

Запустіть одну сесію на проєкт і тримайте її тижнями, місяцями чи роками. Вона пам'ятатиме все, що ви побудували разом.

---

## Швидкий старт

Запустіть інтерактивний майстер налаштування. Він виявить ваші моделі, налаштує все і впорається із сумісністю.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Або запустіть напряму (будь-яка OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Майстер автоматично визначає, які harnesses у вас є (OpenCode, Pi або обидва), додає plugin, вимикає вбудований compaction, допомагає вибрати моделі для historian і dreamer, а також розв'язує конфлікти з іншими plugins керування контекстом. Націльте конкретний harness за допомогою `--harness opencode` або `--harness pi`.

> **Навіщо вимикати вбудований compaction?** Magic Context сам керує контекстом. Compaction хоста заважав би його відкладеним операціям з урахуванням cache і стискав би двічі.

**Ручне налаштування** (OpenCode): додайте plugin і вимкніть compaction в `opencode.json`, потім покладіть `magic-context.jsonc` у `<project>/.cortexkit/` (або `~/.config/cortexkit/` для користувацьких типових значень). Див. [довідник конфігурації](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (потрібен Pi `>= 0.74.0`). Розширення Pi ділить ту саму базу даних з OpenCode; пам'ять проєкту й embeddings об'єднуються між ними.

**Усунення проблем:** `npx @cortexkit/magic-context@latest doctor` автоматично виявляє harnesses, перевіряє конфлікти (compaction, OMO hooks, DCP), перевіряє plugin і бічну панель TUI, запускає перевірку цілісності бази даних і виправляє те, що може. Додайте `--issue`, щоб створити готовий до надсилання bug report.

Працює однаково для нового чи давно активного проєкту: встановіть, перезапустіть harness, і Magic Context почне захоплювати контекст із цього моменту. Він не заповнює сесії OpenCode або Pi, що були до встановлення.

<details>
<summary><strong>Сумісність з іншими plugins керування контекстом</strong></summary>

<br>

Magic Context володіє керуванням контекстом від початку до кінця, тому **вимикає себе**, якщо інший plugin уже робить цю роботу. Два менеджери контексту одночасно двічі стискали б історію і руйнували prompt cache. Під час запуску він перевіряє таке; setup і `doctor` допомагають розв'язати кожен пункт, і доки вони не вирішені, Magic Context залишається вимкненим (fail-safe) та пояснює чому:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context замінює його. Setup вимикає його.
- **DCP** (`opencode-dcp`): окремий plugin обрізання контексту. Вони не можуть працювати разом; видаліть його зі списку `plugin`.
- **oh-my-opencode (OMO)**: setup пропонує вимкнути три hooks, що перекриваються:
  - `preemptive-compaction`: запускає compaction, який конфліктує з historian.
  - `context-window-monitor`: вставляє попередження використання, що перекриваються з nudges Magic Context.
  - `anthropic-context-window-limit-recovery`: запускає аварійний compaction, який обходить historian.

Запускайте `npx @cortexkit/magic-context@latest doctor` будь-коли, щоб перевірити знову і виправити автоматично.

</details>

---

## Частина CortexKit

Мозок не є одним органом. Спроможний агент кодування теж.

**CortexKit** це сімейство plugins, кожен змодельований за іншою ділянкою мозку. Встановіть один, і агент стане гострішим. Встановіть усі три, і він матиме мозок.

| Plugin | Ділянка | Що робить |
|---|---|---|
| **Magic Context** *(ви тут)* | Гіпокамп і медіальна скронева частка | Самокерований контекст і довгострокова пам'ять. Тримає сесії без пауз compaction, поки формує, консолідує і пригадує знання проєкту між ними. |
| **[AFT](https://github.com/cortexkit/aft)** | Сенсомоторна кора | Сприймає структуру коду і точно діє на неї. Справжні IDE та OS для вашого агента. |
| **Alfonso** *(незабаром)* | Префронтальна кора | Виконавчий контроль. Планує, розкладає роботу, обирає агентів і моделі, вирішує, коли питати, перевіряти і commit. |

Magic Context це **1 з 3 plugins, які вам коли-небудь знадобляться.** Він пам'ятає; AFT сприймає і діє; Alfonso вирішує. Вони ділять одне сховище CortexKit, тому пам'ять об'єднується між harnesses і інструментами.

---

## ⚡ Керування контекстом

*Безмежна сесія, що керує собою.* Вікно контексту заповнюється під час роботи, а звичне рішення, compaction, зупиняє агента, щоб перечитати все. Magic Context обробляє це постійно у фоні, тож сесія просто триває.

- **Компартменталізація historian**: фоновий historian стискає стару сиру історію в **шаровані компартменти**, хронологічні підсумки, що замінюють старі повідомлення. Кожен має оцінку важливості, тому живе вікно лишається малим без втрати нитки. Підсумовування не потребує кодової сили основного агента, тому historian можна запускати на дешевій або повністю local моделі, поки головний агент лишається топовим.
- **Decay rendering**: компартменти показуються з потрібною на момент точністю за детермінованим правилом без LLM, яке саме підлаштовується до контекстного вікна моделі. Стара історія плавно згасає, а не падає з урвища, і оскільки це детерміновано, та сама історія завжди показується однаково.
- **Агент підказує, що викинути, або ні**: з увімкненим agent-driven reduction агент викликає `ctx_reduce`, щоб позначити старі tool outputs або довгі повідомлення на видалення. Drops **ставляться в чергу і враховують cache**, застосовуються лише у cache-safe моменти, тому зменшення ніколи не псує cache. Вимкніть це, і агент повністю виходить із керування контекстом: застарілий output автоматично відкидається за віком, з опційним caveman стисканням найстарішого тексту.
- **Cache-стабільне компонування**: усе влаштовано так, щоб фонова робота ніколи не інвалідовувала кешований prefix prompt. Ваш cache переживає всю сесію.

Результат: одна сесія працює місяцями, без пауз compaction і з низькою ціною у cache-priced провайдерів. Це видно в TUI OpenCode, де жива бічна панель показує розподіл контексту за джерелом, стан historian і лічильники пам'яті, оновлюючись після кожного повідомлення.

> *Опційно (вимкнено типово):* **caveman text compression** поступово стискає найстаріший текст user і assistant детермінованим віковим правилом для сесій з вимкненим agent-driven reduction.

---

## 🧠 Захоплення

*Пам'ять безкоштовно.* Щоб стиснути вашу історію, historian мусить прочитати її всю. У тому самому проході він витягує знання, які варто зберегти назавжди, рішення, обмеження, конвенції, значення конфігурації, і підвищує їх у **пам'ять проєкту**, категоризовану і перенесену в кожну майбутню сесію. Ваша пам'ять будує себе з роботи, яку ви вже робите.

Агент також може явно записувати спогади, хоча більшість захоплюється автоматично:

- **`ctx_memory`**: безпосередньо записуйте або видаляйте знання між сесіями у невеликій таксономії категорій (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Часова обізнаність** *(типово увімкнена)* дає агенту відчуття часу, з маркерами проміжків як `+2h 15m` між повідомленнями і датованими компартментами, щоб він міг міркувати, як давно щось сталося. Установіть `temporal_awareness: false`, щоб вимкнути.

---

## 🌙 Консолідація

*Те, що сон робить для пам'яті.* Опційний агент **dreamer** працює вночі, щоб підтримувати якість пам'яті, запускаючи ефемерні дочірні сесії для кожного завдання:

- **Перевіряти**: поступово звіряти спогади з поточною codebase (paths, configs, patterns) і виправляти або видаляти застарілі факти.
- **Упорядковувати**: сканувати весь пул пам'яті, щоб об'єднувати дублікати, ущільнювати формулювання і архівувати записи низької цінності або зайві.
- **Класифікувати**: оцінювати важливість, область і безпечну поширюваність кожного спогаду, не турбуючи живий prompt cache.
- **Підтримувати docs**: тримати `ARCHITECTURE.md` і `STRUCTURE.md` актуальними з огляду на зміни codebase.
- **Пам'ять користувача**: підвищувати повторювані спостереження про те, як ви працюєте (стиль комунікації, фокус review, робочі шаблони), у `<user-profile>`, що мандрує з кожною сесією.
- **Smart notes**: оцінювати відкладені нотатки, чиє `surface_condition` стало істинним, і показувати готові.

Оскільки він працює під час простою, dreamer добре поєднується з local моделями, навіть повільними. Ніхто не чекає. Запустіть run будь-коли через `/ctx-dream`.

---

## 🔎 Пригадування

*Правильна пам'ять у правильний момент.* На кожному ході активна пам'ять проєкту і стиснута історія сесії автоматично та cache-стабільно вставляються. На запит агент звертається до:

- **`ctx_search`**: один запит через три шари одразу: проєктні **memories**, сирий **conversation** history і проіндексовані **git commits**. Semantic embeddings з full-text fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: повернути стиснений діапазон історії до початкового `U:`/`A:` transcript, коли агенту потрібні точні деталі.
- **`ctx_note`**: scratchpad для відкладених намірів. Нотатки з'являються на природних межах (після commits, після historian runs, коли todos завершуються). **Smart notes** несуть відкриту умову, яку відстежує dreamer.

Пригадування працює **між сесіями** (нова сесія успадковує все) і **між harnesses** (записати пам'ять в OpenCode, отримати її в Pi).

> **Автоматичні пошукові підказки** *(типово увімкнені)* запускають фоновий `ctx_search` кожен хід і шепочуть "туманне пригадування", коли є щось релевантне, як майже згадана нотатка. Додаються лише компактні фрагменти, ніколи повний вміст; установіть `memory.auto_search.enabled: false`, щоб вимкнути. **Git commit indexing** *(opt-in)* робить історію проєкту семантично searchable як четверте джерело `ctx_search`, увімкніть через `memory.git_commit_indexing.enabled: true`.

### Інструменти агента коротко

| Інструмент | Розділ | Що робить |
|------|-------|-------------|
| `ctx_reduce` | Контекст | Ставить застарілий tagged content у чергу на видалення з урахуванням cache |
| `ctx_memory` | Захоплення | Записує або видаляє тривалі міжсесійні спогади |
| `ctx_search` | Пригадування | Шукає в пам'яті, історії розмов і git commits |
| `ctx_expand` | Пригадування | Розпаковує діапазон історії назад у transcript |
| `ctx_note` | Пригадування | Відкладені наміри і smart notes, які оцінює dreamer |

---

## Команди

| Команда | Опис |
|---------|-------------|
| `/ctx-status` | Debug view: tags, pending drops, cache TTL, nudge state, прогрес historian, покриття компартментів, бюджет історії |
| `/ctx-flush` | Негайно примусово виконати всі операції в черзі, оминаючи cache TTL |
| `/ctx-recomp` | Перебудувати компартменти із сирої історії (приймає діапазон `start-end`). Використовуйте, коли збережений стан здається неправильним |
| `/ctx-dream` | Запустити обслуговування dreamer на вимогу: пам'ять, docs, smart notes і user-profile review |

---

## Настільний застосунок

Супровідний настільний застосунок для перегляду й керування станом Magic Context поза терміналом.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Браузер пам'яті**: шукати, фільтрувати і редагувати пам'ять проєкту за категорією і проєктом.
- **Історія сесії**: переглядати компартменти і нотатки будь-якої сесії з навігацією часовою шкалою.
- **Діагностика cache**: реальна шкала cache hit/miss і виявлення причин bust.
- **Керування dreamer**: дивитися історію dream-run, запускати runs, перевіряти результати завдань.
- **Редактор конфігурації**: формове редагування кожного налаштування, включно з model fallback chains.
- **Переглядач log**: live-tailing logs з пошуком.

Він читає напряму з SQLite бази Magic Context. Без додаткового сервера, без API. Автооновлення вбудовані.

---

## Конфігурація

Налаштування живуть у `magic-context.jsonc`. Усе має розумні типові значення; конфігурація проєкту зливається поверх користувацьких налаштувань. Для повного довідника, налаштування cache TTL, порогів execute на модель, вибору моделей historian і dreamer, embedding providers і параметрів пам'яті див. **[CONFIGURATION.md](./CONFIGURATION.md)** або **[довідник конфігурації на docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Місця конфігурації** (одне спільне місце CortexKit, проєкт перевизначає користувача):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Оновлюєтеся зі старішої версії? Наявна конфігурація автоматично переноситься сюди під час першого запуску (на старому шляху лишається слід `.MOVED_READPLEASE`).

---

## Сховище

Увесь тривалий стан живе в локальній SQLite базі під спільним сховищем CortexKit (`~/.local/share/cortexkit/magic-context/context.db`, XDG-еквівалент у Windows; старі бази з папки OpenCode мігрують під час першого запуску). Якщо базу не можна відкрити, Magic Context вимикає себе і повідомляє вас. Пам'ять прив'язана до **стабільної ідентичності проєкту**, виведеної з repo, тому вона слідує за проєктом через worktrees, clones і forks, а не прив'язана до шляху каталогу.

Magic Context також пише в кілька інших місць:

| Шлях | Що | Постійність |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite база, tags, компартменти, пам'ять, увесь тривалий стан (XDG-еквівалент у Windows) | **Має зберігатися.** Втрата означає втрату пам'яті/історії. |
| `~/.local/share/cortexkit/magic-context/models/` | Локальний cache моделі embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), завантажується при першому використанні, коли local embeddings увімкнені | Має зберігатися, інакше завантажуватиметься знову при кожному запуску. Не використовується, коли `memory.enabled: false` або налаштовано backend embeddings `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Діагностичний log | Можна викидати. |

**Sandbox / ефемерні середовища (Docker, CI, одноразові контейнери):** змонтуйте каталог `~/.local/share/cortexkit/magic-context/` на постійний volume, щоб база і cache моделі зберігалися між запусками. Якщо ефемерний лише cache моделі, модель просто завантажиться знову; якщо ефемерна база, пам'ять та історія не накопичуються. Щоб повністю уникнути завантаження моделі ~90 MB, встановіть `memory.enabled: false` або направте `embedding` на віддалений backend `openai_compatible`/`ollama`.

---

## Історія зірок

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Розробка

**Вимоги:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Виконання Dream потребує живого сервера OpenCode (dreamer створює ефемерні дочірні сесії). Використовуйте `/ctx-dream` всередині OpenCode для обслуговування на вимогу.

---

## Участь

Bug reports і pull requests вітаються. Для більших змін спершу відкрийте issue, щоб обговорити підхід. Запустіть `bun run format` перед надсиланням; CI відхиляє неформатований код.

---

## Ліцензія

[MIT](LICENSE)
