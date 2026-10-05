<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <strong>繁體中文</strong> |
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
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*這是社群翻譯。英文 [README.md](./README.md) 是權威來源，內容可能更新。*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>無界上下文。會自我管理的記憶。一個會話，伴隨一生。</strong><br>
  CortexKit 的一部分，面向編碼代理的海馬體。
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
  <em>你不會為了一個任務雇用開發者，交付後就馬上解雇。<br>也別這樣對待你的代理。</em>
</p>

<p align="center">
  <a href="#什麼是-magic-context">什麼是 Magic Context？</a> ·
  <a href="#快速開始">快速開始</a> ·
  <a href="#cortexkit-的一部分">CortexKit</a> ·
  <a href="#上下文管理">上下文</a> ·
  <a href="#捕獲">捕獲</a> ·
  <a href="#鞏固">鞏固</a> ·
  <a href="#回憶">回憶</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## 什麼是 Magic Context？

你不會雇用一位開發者只修一個 bug，然後在它剛交付時立刻解雇。優秀的人你會留下。他們會學習程式碼庫，記得當初為什麼做出那些決定，並且每週都更敏銳。

編碼代理的工作方式正好相反。每個任務都是一位沒有專案記憶的新進人員，會話結束時你又把它解雇，從零開始。任務中途它們甚至會遇到「壓縮」暫停，流程被打斷，已經知道的內容也會悄悄遺失。這就是順行性失憶，和海馬體受損時發生的事一樣。

Magic Context 給它們補上這一部分。它是編碼代理的**海馬體**，也就是大腦中形成記憶、鞏固記憶、再把記憶喚回的部分，而且完全在背景執行。一個會話不再是一次性承包商，而會成為長期隊友，陪伴整個專案：

- **捕獲。** 當 historian 壓縮你的歷史時，它會把持久知識（決策、約束、慣例）提升到專案記憶中。你從已經在做的工作裡免費得到一套記憶系統。
- **鞏固。** 夜間，dreamer 代理會做睡眠替你做的事：對照程式碼庫驗證記憶，整理重複與過時項目，並提升反覆出現的內容。
- **回憶。** 正確的記憶會在每一輪自動浮現，代理也可以依需求搜尋記憶、過去對話與 git 歷史。跨會話，也跨 OpenCode 和 Pi。

兩個承諾：你的代理**永遠不會停下來管理上下文**（沒有壓縮暫停，沒有中斷的流程），而且它**永遠不會忘記**。

為每個專案執行一個會話，並讓它持續數週、數月或數年。它會記住你們一起建造的一切。

---

## 快速開始

執行互動式安裝精靈。它會偵測你的模型，設定所有內容，並處理相容性。

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**或直接執行（任何 OS）：**
```bash
npx @cortexkit/magic-context@latest setup
```

精靈會自動偵測你擁有的 harness（OpenCode、Pi，或兩者），加入外掛，停用內建壓縮，協助你為 historian 和 dreamer 選擇模型，並解決與其他上下文管理外掛的衝突。用 `--harness opencode` 或 `--harness pi` 指定特定 harness。

> **為什麼停用內建壓縮？** Magic Context 自己管理上下文。宿主的壓縮會干擾它的快取感知延遲操作，並造成雙重壓縮。

**手動設定**（OpenCode）：在 `opencode.json` 中加入外掛並關閉壓縮，然後把 `magic-context.jsonc` 放到 `<project>/.cortexkit/`（或把使用者層級預設值放到 `~/.config/cortexkit/`）。請參閱[設定參考](./CONFIGURATION.md)。

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi`（需要 Pi `>= 0.74.0`）。Pi 擴充套件與 OpenCode 共用同一個資料庫；專案記憶與嵌入會在兩者之間匯集。

**疑難排解：** `npx @cortexkit/magic-context@latest doctor` 會自動偵測你的 harness，檢查衝突（壓縮、OMO hooks、DCP），驗證外掛與 TUI 側邊欄，對資料庫執行完整性檢查，並盡力修復。加入 `--issue` 可產生可直接提交的 bug 報告。

無論是全新專案或長期執行的專案，運作方式都相同：安裝、重新啟動 harness，然後 Magic Context 從那一刻起捕獲上下文。它不會回填安裝前的 OpenCode 或 Pi 會話。

<details>
<summary><strong>與其他上下文管理外掛的相容性</strong></summary>

<br>

Magic Context 端到端擁有上下文管理，因此如果另一個外掛已經在做這件事，它會**停用自身**。同時執行兩個上下文管理器會把你的歷史雙重壓縮，並擾亂提示快取。啟動時它會檢查以下項目；setup 和 `doctor` 會協助你逐一解決。在解決之前，Magic Context 會保持關閉（故障安全）並告訴你原因：

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context 會取代它。Setup 會將它關閉。
- **DCP** (`opencode-dcp`): 一個獨立的上下文修剪外掛。兩者不能一起執行；請從你的 `plugin` 清單中移除它。
- **oh-my-opencode (OMO)**: setup 會提議停用三個重疊的 hooks：
  - `preemptive-compaction`: 觸發與 historian 衝突的壓縮。
  - `context-window-monitor`: 注入與 Magic Context 提示重疊的用量警告。
  - `anthropic-context-window-limit-recovery`: 觸發繞過 historian 的緊急壓縮。

隨時執行 `npx @cortexkit/magic-context@latest doctor` 重新檢查並自動修復。

</details>

---

## CortexKit 的一部分

大腦不是一個器官。能幹的編碼代理也不是。

**CortexKit** 是一個外掛家族，每個外掛都以大腦的不同區域為模型。安裝一個，你的代理就會更敏銳。三個都安裝，它就有了一顆大腦。

| 外掛 | 區域 | 作用 |
|---|---|---|
| **Magic Context** *（你在這裡）* | 海馬體與內側顳葉 | 自我管理的上下文與長期記憶。它在形成、鞏固並回憶跨會話的專案知識時，讓會話持續執行且沒有壓縮暫停。 |
| **[AFT](https://github.com/cortexkit/aft)** | 感覺運動皮層 | 感知程式碼結構並精準行動。給你的代理一個真正的 IDE 和 OS。 |
| **Alfonso** *（即將推出）* | 前額葉皮層 | 執行控制。規劃、拆解工作、選擇代理與模型，並決定何時詢問、驗證和提交。 |

Magic Context 是**你將永遠需要的 3 個外掛之一。** 它負責記憶；AFT 負責感知與行動；Alfonso 負責決策。它們共用一個 CortexKit 儲存，因此記憶會跨 harness 與工具匯集。

---

## ⚡ 上下文管理

*會自我管理的無界會話。* 工作時，上下文視窗會逐漸填滿，而通常的修復方式，壓縮，會讓代理停下來重新閱讀所有內容。Magic Context 持續在背景處理，所以會話會繼續前進。

- **Historian 分區**：背景 historian 會把舊的原始歷史壓縮成**分層分區**，也就是按時間排列、可替代舊訊息的摘要。每個分區都有重要性分數，因此即時視窗保持很小，同時不會遺失線索。摘要不需要主代理的編碼能力，所以你可以用便宜的模型，甚至完全本機的模型來執行 historian，同時讓主代理保持頂級水準。
- **衰減渲染**：分區會以當下合適的保真度渲染，規則是確定性的，不使用 LLM，並會根據模型的上下文視窗自我調整。舊歷史會優雅淡出，而不是從懸崖上掉下去。因為它是確定性的，相同歷史總會以相同方式渲染。
- **代理提示該丟什麼，或者不提示**：啟用代理驅動的縮減時，代理會呼叫 `ctx_reduce` 標記過時的工具輸出或長訊息以便移除。丟棄會**排隊並感知快取**，只在快取安全的時刻套用，所以縮減不會擾亂快取。關閉它後，代理完全不參與上下文管理：過時輸出會按年齡自動脫落，也可以對最舊文本使用可選的 caveman 壓縮。
- **快取穩定布局**：所有這些都被組織成背景工作永遠不會使提示的快取前綴失效。你的快取會貫穿整個會話。

結果是：一個會話可以執行數月，沒有壓縮暫停，並且在按快取計價的提供商上成本很低。你可以在 OpenCode 的 TUI 中觀察這一切，即時側邊欄會顯示按來源劃分的上下文、historian 狀態和記憶數量，並在每則訊息後更新。

> *可選（預設關閉）：* **caveman text compression** 會按照確定性的年齡分層規則，逐步壓縮最舊的使用者和助手文本，適用於關閉代理驅動縮減的長時間會話。

---

## 🧠 捕獲

*免費的記憶。* 為了壓縮你的歷史，historian 必須讀取全部歷史。因此在同一次遍歷中，它會抽取值得永久保留的知識：決策、約束、慣例、設定值，並提升到**專案記憶**中，分類後帶入每個未來會話。你的記憶會從你已經在做的工作裡自己建立起來。

代理也可以明確記錄記憶，雖然大多數記憶會自動為它捕獲：

- **`ctx_memory`**：直接寫入或刪除跨會話知識，使用一個小型類別分類法（`PROJECT_RULES`、`ARCHITECTURE`、`CONSTRAINTS`、`CONFIG_VALUES`、`NAMING`）。

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **時間感知** *（預設開啟）* 讓代理擁有時間感，在訊息之間使用類似 `+2h 15m` 的間隔標記和帶日期的分區，所以它能推理某件事發生在多久以前。設定 `temporal_awareness: false` 可關閉。

---

## 🌙 鞏固

*睡眠為記憶所做的事。* 可選的 **dreamer** 代理會在夜間執行，以保持記憶品質，並為每個任務啟動臨時子會話：

- **驗證**：增量檢查記憶是否符合目前程式碼庫（路徑、設定、模式），並修復或移除過時事實。
- **整理**：掃描整個記憶池，合併重複項，收緊措辭，並歸檔低價值或冗餘項目。
- **分類**：在不擾動即時提示快取的情況下，為每條記憶的重要性、範圍和安全共享性評分。
- **維護文件**：根據程式碼庫變化保持 `ARCHITECTURE.md` 和 `STRUCTURE.md` 最新。
- **使用者記憶**：把關於你工作方式的重複觀察（溝通風格、審查重點、工作模式）提升到會隨每個會話移動的 `<user-profile>` 中。
- **智慧筆記**：評估 `surface_condition` 已經成真的延遲筆記，並浮現準備好的那些。

因為它在閒置時間執行，dreamer 很適合搭配本機模型，即使模型很慢也可以。沒有人在等待。隨時用 `/ctx-dream` 觸發一次執行。

---

## 🔎 回憶

*在正確時刻出現的正確記憶。* 每一輪，活動的專案記憶和壓縮後的會話歷史都會自動、快取穩定地注入。依需求時，代理會使用：

- **`ctx_search`**：一次查詢同時跨三層：專案**記憶**、原始**對話**歷史，以及已索引的 **git commits**。語義嵌入，並帶全文回退。

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**：當代理需要確切細節時，把某段壓縮歷史範圍還原成原始 `U:`/`A:` transcript。
- **`ctx_note`**：用於延遲意圖的草稿板。筆記會在自然邊界重新浮現（提交之後、historian 執行之後、todos 完成時）。**Smart notes** 帶有開放式條件，由 dreamer 觀察。

回憶可以**跨會話**運作（新會話繼承一切），也可以**跨 harness** 運作（在 OpenCode 寫入記憶，在 Pi 中取回）。

> **自動搜尋提示** *（預設開啟）* 每一輪都會在背景執行一次 `ctx_search`，當有相關內容存在時輕聲給出「模糊回憶」，就像差點想起你記下過的一條筆記。它只追加緊湊片段，絕不追加完整內容；設定 `memory.auto_search.enabled: false` 可關閉。**Git commit 索引** *（選擇開啟）* 會讓你的專案歷史作為第四個 `ctx_search` 來源可被語義搜尋，使用 `memory.git_commit_indexing.enabled: true` 啟用。

### 代理工具一覽

| 工具 | 部分 | 作用 |
|------|-------|-------------|
| `ctx_reduce` | 上下文 | 將過時的已標記內容排隊等待移除，並感知快取 |
| `ctx_memory` | 捕獲 | 寫入或刪除持久的跨會話記憶 |
| `ctx_search` | 回憶 | 搜尋記憶、對話歷史和 git commits |
| `ctx_expand` | 回憶 | 將一段歷史範圍解壓回 transcript |
| `ctx_note` | 回憶 | 延遲意圖和由 dreamer 評估的 smart notes |

---

## 命令

| 命令 | 描述 |
|---------|-------------|
| `/ctx-status` | 偵錯視圖：tags、待處理丟棄、快取 TTL、提示狀態、historian 進度、分區覆蓋、歷史預算 |
| `/ctx-flush` | 立即強制執行所有排隊操作，繞過快取 TTL |
| `/ctx-recomp` | 從原始歷史重建分區（接受 `start-end` 範圍）。當儲存狀態看起來不對時使用 |
| `/ctx-dream` | 依需求執行 dreamer 維護：維護記憶、文件、smart notes，並審查 user-profile |

---

## 桌面應用程式

一個配套桌面應用程式，用於在終端機之外瀏覽和管理 Magic Context 狀態。

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **記憶瀏覽器**：按類別和專案搜尋、篩選並編輯專案記憶。
- **會話歷史**：透過時間軸導覽瀏覽任意會話的分區和筆記。
- **快取診斷**：即時快取命中/未命中時間軸和破壞原因偵測。
- **Dreamer 管理**：查看 dream-run 歷史，觸發執行，檢查任務結果。
- **設定編輯器**：以表單方式編輯每個設定，包括模型回退鏈。
- **日誌檢視器**：帶搜尋的即時日誌追蹤。

它直接讀取 Magic Context 的 SQLite 資料庫。不需要額外伺服器，也不需要 API。內建自動更新。

---

## 設定

設定位於 `magic-context.jsonc`。所有內容都有合理預設值；專案設定會疊加到使用者層級設定之上。完整參考，包括快取 TTL 調整、按模型設定的 execute 閾值、historian 和 dreamer 模型選擇、嵌入提供商以及記憶設定，請參閱 **[CONFIGURATION.md](./CONFIGURATION.md)** 或 **[docs.cortexkit.io 上的設定參考](https://docs.cortexkit.io/magic-context/reference/configuration/)**。

**設定位置**（一個共用的 CortexKit 位置，專案覆寫使用者）：
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

從早期版本升級？你的既有設定會在首次執行時自動移到這裡（舊路徑會留下一個 `.MOVED_READPLEASE` 麵包屑）。

---

## 儲存

所有持久狀態都位於共用 CortexKit 儲存下的本機 SQLite 資料庫中（`~/.local/share/cortexkit/magic-context/context.db`，Windows 上使用 XDG 等價位置；舊的 OpenCode 資料夾資料庫會在首次啟動時遷移）。如果資料庫無法開啟，Magic Context 會停用自身並通知你。記憶繫結到從 repo 衍生的**穩定專案身分**，因此它們會隨著專案跨 worktrees、clones 和 forks 移動，而不是綁定到目錄路徑。

Magic Context 還會寫入少數其他位置：

| 路徑 | 內容 | 持久性 |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite 資料庫，tags、分區、記憶和所有持久狀態（Windows 上使用 XDG 等價位置） | **必須持久。** 丟失它就會丟失你的記憶/歷史。 |
| `~/.local/share/cortexkit/magic-context/models/` | 本機嵌入模型快取（約 90 MB `Xenova/all-MiniLM-L6-v2` ONNX），啟用本機嵌入時首次使用會下載 | 應該持久，否則每次執行都會重新下載。設定 `memory.enabled: false` 或 `openai_compatible`/`ollama` 嵌入後端時不使用。 |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | 診斷日誌 | 可丟棄。 |

**沙盒化 / 暫時環境（Docker、CI、一次性容器）：** 將 `~/.local/share/cortexkit/magic-context/` 目錄掛載到持久卷上，讓資料庫和模型快取能在執行之間保留。如果只有模型快取是暫時的，模型只會重新下載；如果資料庫是暫時的，記憶和歷史不會累積。若要完全避免約 90 MB 的模型下載，請設定 `memory.enabled: false` 或將 `embedding` 指向遠端 `openai_compatible`/`ollama` 後端。

---

## 星標歷史

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## 開發

**需求：** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream 執行需要一個正在運作的 OpenCode 伺服器（dreamer 會建立臨時子會話）。在 OpenCode 中使用 `/ctx-dream` 進行依需求維護。

---

## 貢獻

歡迎 bug 報告和 pull requests。對於較大的變更，請先開啟 issue 討論方案。提交前執行 `bun run format`；CI 會拒絕未格式化的程式碼。

---

## 授權

[MIT](LICENSE)
