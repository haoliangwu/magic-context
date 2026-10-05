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
  <strong>日本語</strong> |
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

*これはコミュニティ翻訳です。英語の [README.md](./README.md) が正本であり、より新しい場合があります。*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>無限のコンテキスト。自分で管理する記憶。一生続くひとつのセッション。</strong><br>
  CortexKit の一部であり、コーディングエージェントのための海馬です。
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
  <em>ひとつの仕事のために開発者を雇い、出荷した瞬間に解雇したりはしません。<br>あなたのエージェントにも、それをしないでください。</em>
</p>

<p align="center">
  <a href="#magic-context-とは">Magic Context とは?</a> ·
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#cortexkit-の一部">CortexKit</a> ·
  <a href="#コンテキスト管理">コンテキスト</a> ·
  <a href="#キャプチャ">キャプチャ</a> ·
  <a href="#統合">統合</a> ·
  <a href="#想起">想起</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Magic Context とは?

ひとつのバグを直すためだけに開発者を雇い、出荷された瞬間に解雇することはありません。優秀な人は残します。彼らはコードベースを学び、なぜその判断が行われたのかを覚え、毎週さらに鋭くなります。

コーディングエージェントは逆の動きをします。すべてのタスクが、あなたのプロジェクトの記憶を持たない新入社員です。そして各セッションの終わりに解雇し、またゼロから始めます。作業の途中では、流れを止め、知っていたことを静かに落としてしまう "compaction" の一時停止にも当たります。これは前向性健忘で、海馬が損傷したときに起きるものと同じです。

Magic Context はその海馬を与えます。これはコーディングエージェントのための**海馬**であり、記憶を形成し、統合し、思い出す脳の部分です。それを完全にバックグラウンドで行います。ひとつのセッションは使い捨ての請負人ではなく、プロジェクト全体にいた長期のチームメイトになります。

- **キャプチャ。** historian が履歴を圧縮するとき、永続的な知識（判断、制約、規約）をプロジェクトメモリへ引き上げます。すでに行っている作業から、無料で記憶システムが得られます。
- **統合。** 夜の間、dreamer エージェントは睡眠が人にしていることを行います。コードベースに照らして記憶を検証し、重複や古い項目を整理し、繰り返し現れるものを昇格させます。
- **想起。** 適切な記憶が各ターンで自動的に浮上し、エージェントは必要に応じて記憶、過去の会話、git 履歴を検索できます。セッションを越えて、OpenCode と Pi を越えて動作します。

約束はふたつです。あなたのエージェントは**コンテキスト管理のために決して停止せず**（compaction の一時停止も、壊れた流れもありません）、**決して忘れません**。

プロジェクトごとにひとつのセッションを実行し、数週間、数か月、または何年も続けてください。一緒に作ったすべてを覚えています。

---

## クイックスタート

対話型のセットアップウィザードを実行します。モデルを検出し、すべてを設定し、互換性を処理します。

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**または直接実行（任意の OS）：**
```bash
npx @cortexkit/magic-context@latest setup
```

ウィザードは、利用中の harness（OpenCode、Pi、または両方）を自動検出し、プラグインを追加し、組み込み compaction を無効化し、historian、dreamer 用のモデル選択を手伝い、ほかのコンテキスト管理プラグインとの衝突を解決します。特定の harness を対象にするには `--harness opencode` または `--harness pi` を使います。

> **なぜ組み込み compaction を無効化するのですか?** Magic Context は自分でコンテキストを管理します。ホスト側の compaction は、キャッシュを意識した遅延操作に干渉し、二重圧縮を起こします。

**手動セットアップ**（OpenCode）：`opencode.json` にプラグインを追加し、compaction をオフにしてから、`magic-context.jsonc` を `<project>/.cortexkit/` に置きます（ユーザー全体のデフォルトは `~/.config/cortexkit/`）。[設定リファレンス](./CONFIGURATION.md)を参照してください。

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi`（Pi `>= 0.74.0` が必要）。Pi 拡張は OpenCode と同じデータベースを共有し、プロジェクトメモリと embeddings は両方で集約されます。

**トラブルシューティング：** `npx @cortexkit/magic-context@latest doctor` は harness を自動検出し、衝突（compaction、OMO hooks、DCP）を確認し、プラグインと TUI サイドバーを検証し、データベースの整合性チェックを実行し、可能なものを修復します。`--issue` を追加すると、そのまま送れる bug report を作成します。

新しいプロジェクトでも長く続くプロジェクトでも同じです。インストールし、harness を再起動すると、Magic Context はその時点からコンテキストをキャプチャします。インストール前の OpenCode または Pi セッションをさかのぼって埋めることはありません。

<details>
<summary><strong>ほかのコンテキスト管理プラグインとの互換性</strong></summary>

<br>

Magic Context はコンテキスト管理を端から端まで担うため、別のプラグインがすでにその仕事をしている場合は**自分を無効化**します。ふたつのコンテキスト管理を同時に実行すると、履歴が二重に圧縮され、プロンプトキャッシュが乱れます。起動時に以下を確認します。setup と `doctor` はそれぞれの解決を助け、解決するまで Magic Context は停止したまま（fail-safe）理由を伝えます。

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context が置き換えます。Setup がオフにします。
- **DCP** (`opencode-dcp`): 別のコンテキスト剪定プラグインです。ふたつは一緒に動かせません。`plugin` リストから削除してください。
- **oh-my-opencode (OMO)**: setup は重複する 3 つの hooks を無効化する提案をします。
  - `preemptive-compaction`: historian と衝突する compaction を起動します。
  - `context-window-monitor`: Magic Context の nudges と重なる使用量警告を挿入します。
  - `anthropic-context-window-limit-recovery`: historian を迂回する緊急 compaction を起動します。

いつでも `npx @cortexkit/magic-context@latest doctor` を実行して再確認し、自動修復できます。

</details>

---

## CortexKit の一部

脳はひとつの器官ではありません。有能なコーディングエージェントも同じです。

**CortexKit** はプラグインのファミリーで、それぞれが脳の異なる領域をモデルにしています。ひとつ入れればエージェントは鋭くなります。3 つすべてを入れれば、エージェントは脳を持ちます。

| プラグイン | 領域 | 役割 |
|---|---|---|
| **Magic Context** *（ここ）* | 海馬と内側側頭葉 | 自己管理するコンテキストと長期記憶。プロジェクト知識を形成、統合、想起しながら、compaction の一時停止なしにセッションを走らせ続けます。 |
| **[AFT](https://github.com/cortexkit/aft)** | 感覚運動皮質 | コード構造を認識し、正確に作用します。エージェントのための本物の IDE と OS です。 |
| **Alfonso** *（近日公開）* | 前頭前皮質 | 実行制御。計画し、作業を分解し、エージェントとモデルを選び、いつ質問、検証、commit するかを決めます。 |

Magic Context は**あなたが今後必要とする 3 つのプラグインのうち 1 つ**です。Magic Context は記憶し、AFT は認識して行動し、Alfonso は決定します。これらはひとつの CortexKit ストアを共有するため、記憶は harness とツールを越えて集まります。

---

## ⚡ コンテキスト管理

*自分で管理する無限のセッション。* 作業を続けるとコンテキストウィンドウは埋まります。通常の対処である compaction は、エージェントを止めてすべてを読み直させます。Magic Context はこれをバックグラウンドで継続的に処理するので、セッションはそのまま進みます。

- **Historian の区画化**：バックグラウンドの historian は古い生の履歴を**階層化された区画**へ圧縮します。これは古いメッセージの代わりになる時系列の要約です。各区画には重要度スコアがあり、流れを失わずにライブウィンドウを小さく保ちます。要約には主エージェントのコーディング力は不要なので、主エージェントを最上位のままにしつつ、historian は安価なモデルや完全ローカルのモデルで実行できます。
- **減衰レンダリング**：区画は、その時点に適した忠実度でレンダリングされます。LLM を使わない決定的な規則が、モデルのコンテキストウィンドウに合わせて自動調整します。古い履歴は突然落ちるのではなく自然に薄れ、決定的なので同じ履歴は常に同じ形でレンダリングされます。
- **エージェントが捨てるものを示す、または示さない**：エージェント駆動の削減を有効にすると、エージェントは `ctx_reduce` を呼び出し、古いツール出力や長いメッセージを削除対象としてマークします。削除は**キューに入り、キャッシュを意識**し、キャッシュ安全な時点でのみ適用されるため、削減がキャッシュを乱しません。オフにすると、エージェントはコンテキスト管理から完全に外れます。古い出力は年齢で自動的に取り除かれ、任意で最古のテキストに caveman 圧縮を使えます。
- **キャッシュ安定レイアウト**：これらは、バックグラウンド作業がプロンプトのキャッシュ済みプレフィックスを無効化しないよう構造化されています。キャッシュはセッション全体で生き続けます。

結果として、ひとつのセッションが数か月動き、compaction の一時停止がなく、キャッシュ課金のプロバイダーでは低コストです。OpenCode の TUI でその様子を見られます。ライブサイドバーがソース別のコンテキスト内訳、historian 状態、メモリ数を表示し、各メッセージ後に更新します。

> *任意（デフォルトではオフ）：* **caveman text compression** は、エージェント駆動削減をオフにして長く走るセッション向けに、決定的な年齢階層ルールで最も古い user と assistant のテキストを段階的に圧縮します。

---

## 🧠 キャプチャ

*無料の記憶。* 履歴を圧縮するには、historian はそれをすべて読む必要があります。その同じパスで、永遠に残す価値のある知識、判断、制約、規約、設定値を取り出し、**プロジェクトメモリ**へ昇格させ、分類して将来のすべてのセッションへ運びます。あなたの記憶は、すでに行っている作業から自分で構築されます。

ほとんどは自動的にキャプチャされますが、エージェントは明示的に記憶を記録することもできます。

- **`ctx_memory`**：小さなカテゴリ分類（`PROJECT_RULES`、`ARCHITECTURE`、`CONSTRAINTS`、`CONFIG_VALUES`、`NAMING`）の中で、セッションを越える知識を直接書き込みまたは削除します。

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **時間認識** *（デフォルトでオン）* は、メッセージ間の `+2h 15m` のようなギャップマーカーと日付付き区画により、エージェントに時間感覚を与えます。何がどれくらい前に起きたかを推論できます。オフにするには `temporal_awareness: false` を設定します。

---

## 🌙 統合

*睡眠が記憶にしていること。* 任意の **dreamer** エージェントが夜間に実行され、各タスクごとに一時的な子セッションを起動して記憶品質を高く保ちます。

- **検証**：現在のコードベース（パス、設定、パターン）に対して記憶を増分的に確認し、古い事実を修正または削除します。
- **整理**：メモリプール全体をスキャンし、重複を統合し、表現を締め、価値の低いまたは冗長な項目をアーカイブします。
- **分類**：ライブプロンプトキャッシュを乱さずに、各記憶の重要度、範囲、安全な共有可能性を採点します。
- **docs の維持**：コードベースの変更から `ARCHITECTURE.md` と `STRUCTURE.md` を最新に保ちます。
- **ユーザーメモリ**：あなたの働き方（コミュニケーションスタイル、レビューの焦点、作業パターン）に関する繰り返し観察を、各セッションと一緒に移動する `<user-profile>` へ昇格します。
- **Smart notes**：`surface_condition` が真になった遅延ノートを評価し、準備できたものを浮上させます。

アイドル時間に実行されるため、dreamer は遅いものを含むローカルモデルと相性がよいです。誰も待ちません。いつでも `/ctx-dream` で実行を開始できます。

---

## 🔎 想起

*正しい瞬間に正しい記憶を。* 各ターンで、アクティブなプロジェクトメモリと圧縮済みセッション履歴が、自動的かつキャッシュ安定に注入されます。必要に応じて、エージェントは次を使います。

- **`ctx_search`**：3 つの層を同時に横断する 1 回のクエリです。プロジェクトの **memories**、生の **conversation** 履歴、インデックス済み **git commits**。全文 fallback 付きの semantic embeddings を使います。

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**：エージェントが正確な詳細を必要とするとき、圧縮された履歴範囲を元の `U:`/`A:` transcript に戻します。
- **`ctx_note`**：遅延した意図のための scratchpad です。ノートは自然な境界（commit 後、historian 実行後、todos 完了時）で再浮上します。**Smart notes** は dreamer が見守るオープンな条件を持ちます。

想起は**セッションを越えて**（新しいセッションがすべてを継承）そして**harness を越えて**（OpenCode で記憶を書き、Pi で取り出す）機能します。

> **自動検索ヒント** *（デフォルトでオン）* は各ターンでバックグラウンド `ctx_search` を実行し、関連するものがあると「ぼんやりした記憶」をささやきます。取ったメモをほとんど思い出しかけるような感覚です。追加するのはコンパクトな断片だけで、完全な内容は決して追加しません。オフにするには `memory.auto_search.enabled: false` を設定します。**Git commit indexing** *（オプトイン）* は、プロジェクト履歴を 4 つ目の `ctx_search` ソースとして semantic に検索可能にします。`memory.git_commit_indexing.enabled: true` で有効化します。

### エージェントツール一覧

| ツール | セクション | 役割 |
|------|-------|-------------|
| `ctx_reduce` | コンテキスト | 古いタグ付きコンテンツをキャッシュを意識して削除キューへ入れる |
| `ctx_memory` | キャプチャ | 永続的なセッション横断メモリを書き込みまたは削除する |
| `ctx_search` | 想起 | メモリ、会話履歴、git commits を検索する |
| `ctx_expand` | 想起 | 履歴範囲を transcript に戻す |
| `ctx_note` | 想起 | 遅延した意図と dreamer が評価する smart notes |

---

## コマンド

| コマンド | 説明 |
|---------|-------------|
| `/ctx-status` | デバッグビュー：tags、pending drops、cache TTL、nudge 状態、historian 進捗、区画カバレッジ、履歴予算 |
| `/ctx-flush` | キュー内のすべての操作を即時に強制実行し、cache TTL を迂回 |
| `/ctx-recomp` | 生の履歴から区画を再構築（`start-end` 範囲を受け付けます）。保存状態がおかしく見えるときに使用 |
| `/ctx-dream` | 必要に応じて dreamer メンテナンスを実行：メモリ、docs、smart notes、user-profile review を維持 |

---

## デスクトップアプリ

ターミナルの外で Magic Context の状態を閲覧し管理するための companion desktop app です。

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **メモリブラウザ**：カテゴリとプロジェクトでプロジェクトメモリを検索、フィルタ、編集します。
- **セッション履歴**：タイムラインナビゲーションで任意のセッションの区画とノートを閲覧します。
- **キャッシュ診断**：リアルタイムの cache hit/miss タイムラインと bust 原因検出。
- **Dreamer 管理**：dream-run 履歴を表示し、実行を開始し、タスク結果を確認します。
- **設定エディタ**：モデル fallback chain を含むすべての設定をフォームで編集します。
- **ログビューア**：検索付きの live-tailing logs。

Magic Context の SQLite データベースから直接読み込みます。追加サーバーも API も不要です。自動更新が組み込まれています。

---

## 設定

設定は `magic-context.jsonc` にあります。すべてに妥当なデフォルトがあります。プロジェクト設定はユーザー全体の設定の上にマージされます。完全なリファレンス、cache TTL の調整、モデルごとの execute しきい値、historian と dreamer のモデル選択、embedding providers、メモリ設定については、**[CONFIGURATION.md](./CONFIGURATION.md)** または **[docs.cortexkit.io の設定リファレンス](https://docs.cortexkit.io/magic-context/reference/configuration/)** を参照してください。

**設定場所**（共有 CortexKit 位置は 1 つで、プロジェクトがユーザーを上書きします）：
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

以前のバージョンからアップグレードしますか? 既存設定は初回実行時に自動でここへ移動されます（古いパスには `.MOVED_READPLEASE` の目印が残ります）。

---

## ストレージ

永続状態はすべて、共有 CortexKit ストア下のローカル SQLite データベースにあります（`~/.local/share/cortexkit/magic-context/context.db`、Windows では XDG 相当、従来の OpenCode フォルダーデータベースは初回起動時に移行されます）。データベースを開けない場合、Magic Context は自分を無効化して通知します。記憶は repo から導かれた**安定したプロジェクト ID**に結び付けられるため、ディレクトリパスではなく、worktrees、clones、forks をまたいでプロジェクトに追従します。

Magic Context はほかにもいくつかの場所へ書き込みます。

| パス | 内容 | 永続性 |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite データベース、tags、区画、メモリ、すべての永続状態（Windows では XDG 相当） | **必ず永続化してください。** 失うとメモリ/履歴を失います。 |
| `~/.local/share/cortexkit/magic-context/models/` | ローカル embedding モデルキャッシュ（約 90 MB `Xenova/all-MiniLM-L6-v2` ONNX）。ローカル embeddings 有効時に初回使用でダウンロード | 永続化が望ましいです。そうでなければ毎回再ダウンロードされます。`memory.enabled: false` または `openai_compatible`/`ollama` embedding backend が設定されている場合は使われません。 |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | 診断ログ | 破棄可能。 |

**サンドボックス / 一時環境（Docker、CI、使い捨てコンテナ）：** データベースとモデルキャッシュが実行間で残るよう、`~/.local/share/cortexkit/magic-context/` ディレクトリを永続ボリュームにマウントしてください。モデルキャッシュだけが一時的なら、モデルは再ダウンロードされるだけです。データベースが一時的なら、メモリと履歴は蓄積されません。約 90 MB のモデルダウンロードを完全に避けるには、`memory.enabled: false` を設定するか、`embedding` をリモートの `openai_compatible`/`ollama` backend に向けてください。

---

## スター履歴

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## 開発

**要件:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream 実行には動作中の OpenCode サーバーが必要です（dreamer は一時的な子セッションを作成します）。オンデマンドのメンテナンスには OpenCode 内で `/ctx-dream` を使います。

---

## コントリビューション

bug reports と pull requests を歓迎します。大きな変更では、まず issue を開いて方針を話し合ってください。提出前に `bun run format` を実行してください。CI は未フォーマットのコードを拒否します。

---

## ライセンス

[MIT](LICENSE)
