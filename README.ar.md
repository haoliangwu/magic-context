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
  <strong>العربية</strong> |
  <a href="./README.no.md">Norsk</a> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*هذه ترجمة مجتمعية. ملف [README.md](./README.md) الإنجليزي هو مصدر الحقيقة وقد يكون أحدث.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>سياق غير محدود. ذاكرة تدير نفسها. جلسة واحدة، مدى الحياة.</strong><br>
  الحُصين لوكلاء البرمجة، وجزء من CortexKit.
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
  <em>أنت لا توظف مطورا لمهمة واحدة ثم تطرده عندما يسلّمها.<br>توقف عن فعل ذلك مع وكيلك.</em>
</p>

<p align="center">
  <a href="#ما-هو-magic-context">ما هو Magic Context؟</a> ·
  <a href="#البدء-السريع">البدء السريع</a> ·
  <a href="#جزء-من-cortexkit">CortexKit</a> ·
  <a href="#إدارة-السياق">السياق</a> ·
  <a href="#الالتقاط">الالتقاط</a> ·
  <a href="#التوحيد">التوحيد</a> ·
  <a href="#الاستدعاء">الاستدعاء</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## ما هو Magic Context؟

أنت لا توظف مطورا لإصلاح خطأ واحد ثم تطرده لحظة شحن الإصلاح. الجيدون تبقيهم. يتعلمون قاعدة الشيفرة، ويتذكرون لماذا اتخذت القرارات، ويصبحون أكثر حدة كل أسبوع.

وكلاء البرمجة يعملون بالعكس. كل مهمة هي موظف جديد بلا ذاكرة عن مشروعك، وفي نهاية كل جلسة تطرده وتبدأ من الصفر. وفي منتصف المهمة يواجهون حتى توقفات "compaction" التي تكسر التدفق وتفقد بصمت ما كانوا يعرفونه. هذا فقدان ذاكرة تقدمي، وهو ما يحدث عندما يتضرر الحُصين.

Magic Context يعطيهم واحدا. إنه **الحُصين** لوكلاء البرمجة، جزء الدماغ الذي يشكل الذكريات ويوحدها ويستدعيها، بالكامل في الخلفية. لا تعود الجلسة مقاولاً قابلاً للرمي، بل تصبح زميلا طويل الأمد كان موجودا طوال المشروع:

- **الالتقاط.** عندما يضغط historian تاريخك، يرفع المعرفة الدائمة (القرارات، القيود، الأعراف) إلى ذاكرة المشروع. تحصل على نظام ذاكرة مجانا من العمل الذي تقوم به بالفعل.
- **التوحيد.** أثناء الليل، تفعل وكلاء dreamer ما يفعله النوم لك: تتحقق من الذكريات مقابل قاعدة الشيفرة، وتنظم التكرارات والإدخالات القديمة، وترقي ما يتكرر.
- **الاستدعاء.** تظهر الذكريات المناسبة تلقائيا في كل دور، ويمكن للوكيل البحث عند الطلب عبر الذكريات والمحادثات السابقة وتاريخ git. عبر الجلسات، وعبر OpenCode و Pi.

وعدان: وكيلك **لا يتوقف أبدا لإدارة سياقه** (لا توقفات compaction ولا تدفق مكسور)، و**لا ينسى أبدا**.

شغل جلسة واحدة لكل مشروع واتركها تعمل لأسابيع أو أشهر أو سنوات. ستتذكر كل ما بنيتموه معا.

---

## البدء السريع

شغل معالج الإعداد التفاعلي. يكتشف نماذجك، ويضبط كل شيء، ويتعامل مع التوافق.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**أو شغله مباشرة (أي OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

يكتشف المعالج تلقائيا أي harnesses لديك (OpenCode أو Pi أو كلاهما)، يضيف plugin، يعطل compaction المدمج، يساعدك على اختيار نماذج historian و dreamer، ويحل التعارضات مع plugins أخرى لإدارة السياق. استهدف harness محددا باستخدام `--harness opencode` أو `--harness pi`.

> **لماذا نعطل compaction المدمج؟** Magic Context يدير السياق بنفسه. compaction الخاص بالمضيف سيتداخل مع عملياته المؤجلة الواعية للـ cache وسيضغط مرتين.

**الإعداد اليدوي** (OpenCode): أضف plugin وأوقف compaction في `opencode.json`، ثم ضع `magic-context.jsonc` في `<project>/.cortexkit/` (أو في `~/.config/cortexkit/` للإعدادات الافتراضية على مستوى المستخدم). راجع [مرجع التهيئة](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (يتطلب Pi `>= 0.74.0`). إضافة Pi تشارك قاعدة البيانات نفسها مع OpenCode؛ ذكريات المشروع و embeddings تتجمع عبر الاثنين.

**استكشاف الأخطاء:** `npx @cortexkit/magic-context@latest doctor` يكتشف harnesses تلقائيا، يفحص التعارضات (compaction و OMO hooks و DCP)، يتحقق من plugin وشريط TUI الجانبي، يشغل فحص سلامة على قاعدة البيانات، ويصلح ما يستطيع. أضف `--issue` لإنشاء تقرير bug جاهز للإرسال.

يعمل بالطريقة نفسها في مشروع جديد تماما أو مشروع طويل العمر: ثبته، أعد تشغيل harness، وسيبدأ Magic Context بالتقاط السياق من تلك اللحظة. لا يملأ جلسات OpenCode أو Pi السابقة للتثبيت.

<details>
<summary><strong>التوافق مع plugins أخرى لإدارة السياق</strong></summary>

<br>

Magic Context يملك إدارة السياق من البداية إلى النهاية، لذلك **يعطل نفسه** إذا كان plugin آخر يقوم بهذا العمل. تشغيل مديرين للسياق في وقت واحد سيضغط تاريخك مرتين ويزعزع prompt cache. عند البدء يفحص ما يلي؛ setup و `doctor` يساعدانك على حل كل نقطة، وحتى تحل يبقى Magic Context متوقفا (fail-safe) ويخبرك بالسبب:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context يستبدله. Setup يوقفه.
- **DCP** (`opencode-dcp`): plugin منفصل لتقليم السياق. لا يمكن تشغيلهما معا؛ أزله من قائمة `plugin`.
- **oh-my-opencode (OMO)**: يقدم setup تعطيل hooks الثلاثة المتداخلة:
  - `preemptive-compaction`: يشغل compaction يتعارض مع historian.
  - `context-window-monitor`: يحقن تحذيرات استخدام تتداخل مع nudges الخاصة بـ Magic Context.
  - `anthropic-context-window-limit-recovery`: يشغل compaction طارئا يتجاوز historian.

شغل `npx @cortexkit/magic-context@latest doctor` في أي وقت لإعادة الفحص والإصلاح تلقائيا.

</details>

---

## جزء من CortexKit

الدماغ ليس عضوا واحدا. وكذلك وكيل البرمجة القادر.

**CortexKit** عائلة من plugins، كل واحد منها مبني على منطقة مختلفة من الدماغ. ثبت واحدا وسيصبح وكيلك أكثر حدة. ثبت الثلاثة وسيملك دماغا.

| Plugin | المنطقة | ماذا يفعل |
|---|---|---|
| **Magic Context** *(أنت هنا)* | الحُصين والفص الصدغي الإنسي | سياق ذاتي الإدارة وذاكرة طويلة الأمد. يبقي الجلسات تعمل بلا توقفات compaction بينما يشكل معرفة المشروع ويوحدها ويستدعيها عبر الجلسات. |
| **[AFT](https://github.com/cortexkit/aft)** | القشرة الحسية الحركية | يدرك بنية الشيفرة ويتصرف عليها بدقة. IDE و OS حقيقيان لوكيلك. |
| **Alfonso** *(قريبا)* | القشرة أمام الجبهية | تحكم تنفيذي. يخطط ويفكك العمل ويختار الوكلاء والنماذج ويقرر متى يسأل ويتحقق ويعمل commit. |

Magic Context هو **1 من 3 plugins ستحتاجها فقط.** هو يتذكر؛ AFT يدرك ويتصرف؛ Alfonso يقرر. يشتركون في مخزن CortexKit واحد، فتتجمع الذاكرة عبر harnesses والأدوات.

---

## ⚡ إدارة السياق

*جلسة غير محدودة تدير نفسها.* تمتلئ نافذة السياق أثناء العمل، والحل المعتاد، compaction، يوقف الوكيل ليقرأ كل شيء من جديد. Magic Context يتعامل مع ذلك باستمرار في الخلفية، فتستمر الجلسة.

- **تجزئة historian**: يضغط historian في الخلفية التاريخ الخام القديم إلى **حجرات متدرجة**، وهي ملخصات زمنية تحل محل الرسائل القديمة. تحمل كل حجرة درجة أهمية، فتظل النافذة الحية صغيرة دون فقد الخيط. التلخيص لا يحتاج عضلات البرمجة لدى وكيلك الأساسي، لذا يمكنك تشغيل historian على نموذج رخيص أو حتى محلي بالكامل بينما يبقى الوكيل الرئيسي في أعلى مستوى.
- **عرض بالتلاشي**: تعرض الحجرات بالدقة المناسبة للحظة عبر قاعدة حتمية بلا LLM تضبط نفسها على نافذة سياق النموذج. التاريخ القديم يتلاشى بسلاسة بدلا من السقوط فجأة، ولأنها حتمية يظهر التاريخ نفسه دائما بالطريقة نفسها.
- **الوكيل يلمح إلى ما يجب إسقاطه، أو لا يفعل**: مع تفعيل التخفيض الموجه بالوكيل، يستدعي الوكيل `ctx_reduce` لتمييز مخرجات أدوات قديمة أو رسائل طويلة للإزالة. الإسقاطات **تصطف وتراعي cache**، وتطبق فقط في لحظات آمنة للـ cache، فلا يربك التخفيض الـ cache. أوقفه وسيبقى الوكيل خارج إدارة السياق تماما: تزال المخرجات القديمة تلقائيا حسب العمر، مع ضغط caveman اختياري لأقدم نص.
- **تخطيط ثابت للـ cache**: كل هذا منظم بحيث لا يلغي العمل الخلفي أبدا بادئة prompt المخزنة في cache. يبقى cache طوال الجلسة.

النتيجة: جلسة واحدة تعمل لأشهر، بلا توقفات compaction وبتكلفة منخفضة عند مزودي الأسعار المعتمدة على cache. يمكنك مشاهدة ذلك في TUI الخاص بـ OpenCode، حيث يعرض شريط جانبي حي تفصيل السياق حسب المصدر، حالة historian، وأعداد الذاكرة، ويتحدث بعد كل رسالة.

> *اختياري (مغلق افتراضيا):* **caveman text compression** يضغط تدريجيا أقدم نص user و assistant بقاعدة عمرية حتمية، للجلسات التي تعمل مع تعطيل التخفيض الموجه بالوكيل.

---

## 🧠 الالتقاط

*ذاكرة مجانا.* لكي يضغط historian تاريخك، عليه أن يقرأه كله. لذلك في المرور نفسه يستخرج المعرفة التي تستحق البقاء إلى الأبد، القرارات والقيود والأعراف وقيم التهيئة، ويرقيها إلى **ذاكرة المشروع**، مصنفة ومحمولة إلى كل جلسة مستقبلية. ذاكرتك تبني نفسها من العمل الذي تقوم به بالفعل.

يمكن للوكيل أيضا تسجيل الذكريات صراحة، رغم أن معظمها يلتقط تلقائيا له:

- **`ctx_memory`**: اكتب أو احذف معرفة عابرة للجلسات مباشرة ضمن تصنيف صغير (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **الوعي الزمني** *(مفعل افتراضيا)* يمنح الوكيل إحساسا بالوقت، مع علامات فجوة مثل `+2h 15m` بين الرسائل وحجرات مؤرخة، حتى يستطيع التفكير في مدى قدم حدث ما. اضبط `temporal_awareness: false` لإيقافه.

---

## 🌙 التوحيد

*ما يفعله النوم للذاكرة.* يعمل وكيل **dreamer** اختياري ليلا للحفاظ على جودة الذاكرة، منشئا جلسات فرعية مؤقتة لكل مهمة:

- **تحقق**: افحص الذكريات تدريجيا مقابل codebase الحالي (المسارات، configs، الأنماط) وأصلح أو أزل الحقائق القديمة.
- **نظم**: امسح حوض الذاكرة كله لدمج المكررات، وشد الصياغة، وأرشف الإدخالات منخفضة القيمة أو الزائدة.
- **صنف**: قيّم أهمية كل ذاكرة ونطاقها وقابليتها الآمنة للمشاركة دون إزعاج prompt cache الحي.
- **حافظ على docs**: أبق `ARCHITECTURE.md` و `STRUCTURE.md` محدثين من تغييرات codebase.
- **ذكريات المستخدم**: رقّ الملاحظات المتكررة عن طريقة عملك (أسلوب التواصل، تركيز review، أنماط العمل) إلى `<user-profile>` ينتقل مع كل جلسة.
- **Smart notes**: قيّم الملاحظات المؤجلة التي أصبح `surface_condition` لها صحيحا وأظهر الجاهزة.

لأنه يعمل أثناء الخمول، يناسب dreamer النماذج المحلية، حتى البطيئة. لا أحد ينتظر. شغل run في أي وقت باستخدام `/ctx-dream`.

---

## 🔎 الاستدعاء

*الذاكرة الصحيحة في اللحظة الصحيحة.* في كل دور، تحقن ذكريات المشروع النشطة وتاريخ الجلسة المضغوط تلقائيا وبثبات للـ cache. وعند الطلب يلجأ الوكيل إلى:

- **`ctx_search`**: استعلام واحد عبر ثلاث طبقات في وقت واحد: **memories** للمشروع، تاريخ **conversation** الخام، و **git commits** المفهرسة. Semantic embeddings مع fallback للنص الكامل.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: أعد نطاق تاريخ مضغوط إلى transcript الأصلي `U:`/`A:` عندما يحتاج الوكيل إلى التفاصيل الدقيقة.
- **`ctx_note`**: scratchpad للنوايا المؤجلة. تعود الملاحظات عند حدود طبيعية (بعد commits، بعد historian runs، عند انتهاء todos). تحمل **Smart notes** شرطا مفتوحا يراقبه dreamer.

يعمل الاستدعاء **عبر الجلسات** (ترث الجلسة الجديدة كل شيء) و**عبر harnesses** (اكتب ذاكرة في OpenCode واسترجعها في Pi).

> **تلميحات البحث التلقائي** *(مفعلة افتراضيا)* تشغل `ctx_search` في الخلفية كل دور وتهمس بـ "استدعاء غامض" عندما يوجد شيء ذو صلة، مثل شبه تذكر ملاحظة كتبتها. تضيف شذرات مضغوطة فقط، وليس المحتوى الكامل أبدا؛ اضبط `memory.auto_search.enabled: false` لإيقافها. **Git commit indexing** *(اختياري)* يجعل تاريخ مشروعك قابلا للبحث الدلالي كمصدر رابع لـ `ctx_search`، فعّله بـ `memory.git_commit_indexing.enabled: true`.

### أدوات الوكيل بنظرة سريعة

| الأداة | القسم | ماذا تفعل |
|------|-------|-------------|
| `ctx_reduce` | السياق | تصف محتوى tagged قديما للإزالة مع مراعاة cache |
| `ctx_memory` | الالتقاط | تكتب أو تحذف ذكريات دائمة عابرة للجلسات |
| `ctx_search` | الاستدعاء | تبحث في الذكريات وتاريخ المحادثات و git commits |
| `ctx_expand` | الاستدعاء | تفك ضغط نطاق تاريخ إلى transcript |
| `ctx_note` | الاستدعاء | نوايا مؤجلة و smart notes يقيمها dreamer |

---

## الأوامر

| الأمر | الوصف |
|---------|-------------|
| `/ctx-status` | عرض debug: tags، pending drops، cache TTL، حالة nudge، تقدم historian، تغطية الحجرات، ميزانية التاريخ |
| `/ctx-flush` | إجبار كل العمليات المصطفة فورا، مع تجاوز cache TTL |
| `/ctx-recomp` | إعادة بناء الحجرات من التاريخ الخام (يقبل نطاق `start-end`). استخدمه عندما تبدو الحالة المخزنة خاطئة |
| `/ctx-dream` | تشغيل صيانة dreamer عند الطلب: صيانة الذاكرة و docs و smart notes ومراجعة user-profile |

---

## تطبيق سطح المكتب

تطبيق سطح مكتب مرافق لتصفح وإدارة حالة Magic Context خارج الطرفية.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **متصفح الذاكرة**: ابحث وصف وحرر ذكريات المشروع حسب الفئة والمشروع.
- **تاريخ الجلسة**: تصفح الحجرات والملاحظات لأي جلسة عبر تنقل زمني.
- **تشخيص cache**: خط زمني فوري لـ cache hit/miss واكتشاف سبب bust.
- **إدارة dreamer**: اعرض تاريخ dream-run، شغل runs، وافحص نتائج المهام.
- **محرر التهيئة**: تحرير قائم على النماذج لكل إعداد، بما في ذلك سلاسل model fallback.
- **عارض السجلات**: live-tailing للسجلات مع بحث.

يقرأ مباشرة من قاعدة بيانات SQLite الخاصة بـ Magic Context. لا خادم إضافي ولا API. التحديثات التلقائية مدمجة.

---

## التهيئة

توجد الإعدادات في `magic-context.jsonc`. لكل شيء قيم افتراضية معقولة؛ تندمج تهيئة المشروع فوق إعدادات المستخدم. للمرجع الكامل، ضبط cache TTL، عتبات execute لكل نموذج، اختيار نماذج historian و dreamer، مزودي embeddings، وإعدادات الذاكرة، راجع **[CONFIGURATION.md](./CONFIGURATION.md)** أو **[مرجع التهيئة على docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**مواقع التهيئة** (موقع CortexKit مشترك واحد، المشروع يتجاوز المستخدم):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

هل ترقي من إصدار سابق؟ تنقل تهيئتك الحالية إلى هنا تلقائيا عند أول تشغيل (يترك أثر `.MOVED_READPLEASE` في المسار القديم).

---

## التخزين

كل الحالة الدائمة تعيش في قاعدة بيانات SQLite محلية تحت مخزن CortexKit المشترك (`~/.local/share/cortexkit/magic-context/context.db`، أو ما يعادله XDG على Windows؛ قواعد OpenCode القديمة داخل المجلد تهاجر عند أول تشغيل). إذا تعذر فتح قاعدة البيانات، يعطل Magic Context نفسه ويبلغك. ترتبط الذكريات بـ **هوية مشروع مستقرة** مشتقة من repo، فتتبع المشروع عبر worktrees و clones و forks بدلا من ارتباطها بمسار مجلد.

يكتب Magic Context أيضا إلى بضعة مواقع أخرى:

| المسار | ماذا | الاستمرارية |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | قاعدة SQLite، tags، حجرات، ذكريات، وكل الحالة الدائمة (XDG-equivalent على Windows) | **يجب أن تستمر.** فقدانها يفقد الذاكرة/التاريخ. |
| `~/.local/share/cortexkit/magic-context/models/` | Cache محلي لنموذج embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX)، ينزل عند أول استخدام عندما تكون embeddings المحلية مفعلة | يجب أن يستمر، وإلا يعاد تنزيله كل تشغيل. لا يستخدم عند `memory.enabled: false` أو عند تهيئة backend embeddings من نوع `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | سجل تشخيص | قابل للرمي. |

**بيئات معزولة / مؤقتة (Docker، CI، حاويات قابلة للرمي):** اربط دليل `~/.local/share/cortexkit/magic-context/` على volume دائم كي تبقى قاعدة البيانات و cache النموذج بين التشغيلات. إذا كان cache النموذج فقط مؤقتا، يعاد تنزيل النموذج ببساطة؛ وإذا كانت قاعدة البيانات مؤقتة، فلن تتراكم الذاكرة والتاريخ. لتجنب تنزيل نموذج ~90 MB بالكامل، اضبط `memory.enabled: false` أو وجه `embedding` إلى backend بعيد `openai_compatible`/`ollama`.

---

## تاريخ النجوم

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## التطوير

**المتطلبات:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

يتطلب تنفيذ Dream خادم OpenCode حيا (ينشئ dreamer جلسات فرعية مؤقتة). استخدم `/ctx-dream` داخل OpenCode للصيانة عند الطلب.

---

## المساهمة

Bug reports و pull requests مرحب بها. للتغييرات الأكبر، افتح issue أولا لمناقشة النهج. شغل `bun run format` قبل الإرسال؛ يرفض CI الشيفرة غير المنسقة.

---

## الترخيص

[MIT](LICENSE)
