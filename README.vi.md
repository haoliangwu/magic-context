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
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <strong>Tiếng Việt</strong>
</p>

*Đây là bản dịch cộng đồng. Bản tiếng Anh [README.md](./README.md) là nguồn chuẩn và có thể được cập nhật hơn.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Ngữ cảnh không giới hạn. Bộ nhớ tự quản lý. Một phiên, dùng cả đời.</strong><br>
  Hồi hải mã cho các tác nhân lập trình, một phần của CortexKit.
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
  <em>Bạn không thuê một lập trình viên cho một việc rồi sa thải họ khi giao hàng.<br>Đừng làm vậy với agent của bạn.</em>
</p>

<p align="center">
  <a href="#magic-context-là-gì">Magic Context là gì?</a> ·
  <a href="#bắt-đầu-nhanh">Bắt đầu nhanh</a> ·
  <a href="#một-phần-của-cortexkit">CortexKit</a> ·
  <a href="#quản-lý-ngữ-cảnh">Ngữ cảnh</a> ·
  <a href="#thu-nhận">Thu nhận</a> ·
  <a href="#củng-cố">Củng cố</a> ·
  <a href="#nhớ-lại">Nhớ lại</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Magic Context là gì?

Bạn không thuê một lập trình viên để sửa một bug rồi sa thải họ ngay lúc bản sửa được phát hành. Người giỏi thì bạn giữ lại. Họ học codebase, nhớ vì sao các quyết định được đưa ra, và sắc bén hơn mỗi tuần.

Các tác nhân lập trình hoạt động ngược lại. Mỗi nhiệm vụ là một người mới không có ký ức về dự án của bạn, và cuối mỗi phiên bạn sa thải họ rồi bắt đầu lại từ số không. Giữa nhiệm vụ họ còn gặp các lần dừng "compaction" làm gãy luồng và âm thầm làm rơi mất những gì họ đã biết. Đó là chứng quên thuận chiều, giống điều xảy ra khi hồi hải mã bị tổn thương.

Magic Context cho họ một hồi hải mã. Nó là **hồi hải mã** cho các tác nhân lập trình, phần não tạo ký ức, củng cố ký ức và gọi lại chúng, hoàn toàn ở nền. Một phiên không còn là nhà thầu dùng một lần mà trở thành đồng đội dài hạn đã ở đó suốt dự án:

- **Thu nhận.** Khi historian nén lịch sử của bạn, nó nâng kiến thức bền vững (quyết định, ràng buộc, quy ước) vào bộ nhớ dự án. Bạn có một hệ thống bộ nhớ miễn phí từ công việc bạn đã làm.
- **Củng cố.** Qua đêm, các agent dreamer làm điều giấc ngủ làm cho bạn: kiểm chứng ký ức với codebase, sắp xếp trùng lặp và mục lỗi thời, rồi nâng cấp những gì lặp lại.
- **Nhớ lại.** Ký ức đúng tự động xuất hiện ở mỗi lượt, và agent có thể tìm trong ký ức, các cuộc trò chuyện cũ và lịch sử git khi cần. Xuyên phiên, và xuyên OpenCode với Pi.

Hai lời hứa: agent của bạn **không bao giờ dừng để quản lý ngữ cảnh** (không dừng compaction, không gãy luồng) và **không bao giờ quên**.

Chạy một phiên cho mỗi dự án và giữ nó trong nhiều tuần, tháng hoặc năm. Nó sẽ nhớ mọi thứ các bạn đã xây dựng cùng nhau.

---

## Bắt đầu nhanh

Chạy trình hướng dẫn thiết lập tương tác. Nó phát hiện các mô hình của bạn, cấu hình mọi thứ và xử lý tương thích.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Hoặc chạy trực tiếp (mọi OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Trình hướng dẫn tự phát hiện harnesses bạn có (OpenCode, Pi hoặc cả hai), thêm plugin, tắt compaction tích hợp, giúp bạn chọn mô hình cho historian và dreamer, rồi giải quyết xung đột với các plugins quản lý ngữ cảnh khác. Nhắm một harness cụ thể bằng `--harness opencode` hoặc `--harness pi`.

> **Vì sao tắt compaction tích hợp?** Magic Context tự quản lý ngữ cảnh. Compaction của host sẽ can thiệp vào các thao tác trì hoãn có nhận biết cache và nén hai lần.

**Thiết lập thủ công** (OpenCode): thêm plugin và tắt compaction trong `opencode.json`, rồi đặt `magic-context.jsonc` trong `<project>/.cortexkit/` (hoặc `~/.config/cortexkit/` cho mặc định toàn người dùng). Xem [tham chiếu cấu hình](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (yêu cầu Pi `>= 0.74.0`). Phần mở rộng Pi dùng chung cơ sở dữ liệu với OpenCode; ký ức dự án và embeddings được gom giữa cả hai.

**Khắc phục sự cố:** `npx @cortexkit/magic-context@latest doctor` tự phát hiện harnesses, kiểm tra xung đột (compaction, OMO hooks, DCP), xác minh plugin và thanh bên TUI, chạy kiểm tra toàn vẹn cơ sở dữ liệu và sửa những gì có thể. Thêm `--issue` để tạo báo cáo bug sẵn sàng gửi.

Hoạt động giống nhau trên dự án mới hoặc đã chạy lâu: cài đặt, khởi động lại harness, và Magic Context thu ngữ cảnh từ thời điểm đó. Nó không backfill các phiên OpenCode hoặc Pi trước khi được cài.

<details>
<summary><strong>Tương thích với plugins quản lý ngữ cảnh khác</strong></summary>

<br>

Magic Context sở hữu quản lý ngữ cảnh từ đầu đến cuối, nên nó **tự tắt** nếu một plugin khác đã làm việc đó. Chạy hai trình quản lý ngữ cảnh cùng lúc sẽ nén đôi lịch sử và làm xáo trộn prompt cache. Khi khởi động nó kiểm tra các mục sau; setup và `doctor` giúp bạn giải quyết từng mục, và cho đến khi giải quyết xong Magic Context vẫn tắt (fail-safe) và cho biết lý do:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context thay thế nó. Setup sẽ tắt.
- **DCP** (`opencode-dcp`): plugin riêng để tỉa ngữ cảnh. Hai plugin không thể chạy cùng nhau; gỡ nó khỏi danh sách `plugin`.
- **oh-my-opencode (OMO)**: setup đề nghị tắt ba hooks chồng lấn:
  - `preemptive-compaction`: kích hoạt compaction xung đột với historian.
  - `context-window-monitor`: chèn cảnh báo sử dụng chồng lấn với nudges của Magic Context.
  - `anthropic-context-window-limit-recovery`: kích hoạt compaction khẩn cấp bỏ qua historian.

Chạy `npx @cortexkit/magic-context@latest doctor` bất cứ lúc nào để kiểm tra lại và tự sửa.

</details>

---

## Một phần của CortexKit

Bộ não không phải một cơ quan duy nhất. Một tác nhân lập trình đủ năng lực cũng vậy.

**CortexKit** là một gia đình plugins, mỗi plugin mô phỏng một vùng não khác nhau. Cài một cái và agent của bạn sắc bén hơn. Cài cả ba và nó có bộ não.

| Plugin | Vùng | Nó làm gì |
|---|---|---|
| **Magic Context** *(bạn đang ở đây)* | Hồi hải mã và thùy thái dương giữa | Ngữ cảnh tự quản và bộ nhớ dài hạn. Giữ phiên chạy không dừng compaction trong khi hình thành, củng cố và nhớ lại tri thức dự án giữa các phiên. |
| **[AFT](https://github.com/cortexkit/aft)** | Vỏ não cảm giác vận động | Nhận biết cấu trúc mã và hành động chính xác trên đó. Một IDE và OS đúng nghĩa cho agent của bạn. |
| **Alfonso** *(sắp có)* | Vỏ não trước trán | Điều khiển điều hành. Lập kế hoạch, phân rã công việc, chọn agents và mô hình, quyết định khi nào hỏi, xác minh và commit. |

Magic Context là **1 trong 3 plugins bạn sẽ cần.** Nó nhớ; AFT nhận biết và hành động; Alfonso quyết định. Chúng dùng chung một CortexKit store, nên bộ nhớ được gom giữa harnesses và công cụ.

---

## ⚡ Quản lý ngữ cảnh

*Một phiên không giới hạn tự quản lý.* Cửa sổ ngữ cảnh đầy lên khi bạn làm việc, và cách sửa thông thường, compaction, dừng agent lại để đọc lại mọi thứ. Magic Context xử lý liên tục ở nền, nên phiên cứ tiếp tục.

- **Phân khoang historian**: historian ở nền nén lịch sử thô cũ thành **các khoang phân tầng**, các tóm tắt theo thời gian thay cho tin nhắn cũ. Mỗi khoang có điểm quan trọng, nên cửa sổ live vẫn nhỏ mà không mất mạch. Tóm tắt không cần sức lập trình của agent chính, nên bạn có thể chạy historian trên mô hình rẻ hoặc hoàn toàn local trong khi agent chính vẫn top-tier.
- **Hiển thị suy giảm**: các khoang được render với độ trung thực phù hợp cho thời điểm, bằng quy tắc deterministic không dùng LLM tự điều chỉnh theo cửa sổ ngữ cảnh của mô hình. Lịch sử cũ phai dần mượt mà thay vì rơi khỏi vách đá, và vì deterministic, cùng một lịch sử luôn render giống nhau.
- **Agent gợi ý nên bỏ gì, hoặc không**: khi bật agent-driven reduction, agent gọi `ctx_reduce` để đánh dấu tool outputs cũ hoặc tin nhắn dài cần xóa. Drops được **xếp hàng và cache-aware**, chỉ áp dụng ở thời điểm cache-safe, nên reduction không phá cache. Tắt nó thì agent hoàn toàn đứng ngoài quản lý ngữ cảnh: output cũ tự rơi theo tuổi, với tùy chọn nén caveman cho văn bản cũ nhất.
- **Bố cục ổn định cache**: tất cả được cấu trúc để công việc nền không bao giờ làm mất hiệu lực prefix đã cache của prompt. Cache của bạn sống qua cả phiên.

Kết quả: một phiên chạy hàng tháng, không dừng compaction và chi phí thấp trên nhà cung cấp tính giá theo cache. Bạn có thể xem trong TUI của OpenCode, nơi thanh bên live hiển thị phân rã ngữ cảnh theo nguồn, trạng thái historian và số lượng bộ nhớ, cập nhật sau mỗi tin nhắn.

> *Tùy chọn (tắt mặc định):* **caveman text compression** dần nén văn bản user và assistant cũ nhất bằng quy tắc deterministic theo tuổi, cho các phiên chạy với agent-driven reduction tắt.

---

## 🧠 Thu nhận

*Bộ nhớ miễn phí.* Để nén lịch sử của bạn, historian phải đọc tất cả. Vì vậy trong cùng một lượt nó trích xuất tri thức đáng giữ mãi, quyết định, ràng buộc, quy ước, giá trị cấu hình, và nâng lên thành **bộ nhớ dự án**, được phân loại và mang vào mọi phiên sau. Bộ nhớ của bạn tự xây từ công việc bạn đang làm.

Agent cũng có thể ghi ký ức rõ ràng, dù phần lớn được tự động thu nhận cho nó:

- **`ctx_memory`**: ghi hoặc xóa trực tiếp tri thức xuyên phiên, trong một phân loại nhỏ (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Nhận thức thời gian** *(bật mặc định)* cho agent cảm giác thời gian, với dấu khoảng như `+2h 15m` giữa tin nhắn và các khoang có ngày, để nó suy luận sự việc xảy ra bao lâu trước. Đặt `temporal_awareness: false` để tắt.

---

## 🌙 Củng cố

*Điều giấc ngủ làm cho trí nhớ.* Agent **dreamer** tùy chọn chạy qua đêm để giữ chất lượng bộ nhớ cao, tạo các child sessions tạm thời cho từng nhiệm vụ:

- **Xác minh**: kiểm tra tăng dần ký ức với codebase hiện tại (paths, configs, patterns) và sửa hoặc xóa sự thật lỗi thời.
- **Chăm sóc**: quét toàn bộ memory pool để gộp trùng lặp, siết lời văn và lưu trữ mục giá trị thấp hoặc dư thừa.
- **Phân loại**: chấm điểm tầm quan trọng, phạm vi và khả năng chia sẻ an toàn của từng ký ức mà không làm nhiễu prompt cache live.
- **Duy trì docs**: giữ `ARCHITECTURE.md` và `STRUCTURE.md` cập nhật từ thay đổi codebase.
- **Ký ức người dùng**: nâng các quan sát lặp lại về cách bạn làm việc (phong cách giao tiếp, trọng tâm review, mẫu làm việc) vào `<user-profile>` đi cùng mọi phiên.
- **Smart notes**: đánh giá các ghi chú trì hoãn có `surface_condition` đã đúng và đưa các ghi chú sẵn sàng lên.

Vì chạy lúc rảnh, dreamer hợp với mô hình local, kể cả mô hình chậm. Không ai phải đợi. Kích hoạt một run bất cứ lúc nào bằng `/ctx-dream`.

---

## 🔎 Nhớ lại

*Ký ức đúng vào đúng lúc.* Mỗi lượt, ký ức dự án đang hoạt động và lịch sử phiên đã compact được tự động chèn vào theo cách ổn định cache. Khi cần, agent dùng:

- **`ctx_search`**: một truy vấn qua ba lớp cùng lúc: **memories** của dự án, lịch sử **conversation** thô và **git commits** đã lập chỉ mục. Semantic embeddings với full-text fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: đưa một khoảng lịch sử nén trở lại transcript gốc `U:`/`A:` khi agent cần chi tiết chính xác.
- **`ctx_note`**: scratchpad cho ý định trì hoãn. Notes xuất hiện lại ở các ranh giới tự nhiên (sau commits, sau historian runs, khi todos xong). **Smart notes** mang một điều kiện mở mà dreamer theo dõi.

Nhớ lại hoạt động **xuyên phiên** (phiên mới thừa hưởng mọi thứ) và **xuyên harnesses** (ghi ký ức trong OpenCode, lấy lại trong Pi).

> **Gợi ý tìm kiếm tự động** *(bật mặc định)* chạy `ctx_search` nền mỗi lượt và thì thầm một "hồi tưởng mơ hồ" khi có điều liên quan, như gần nhớ ra một ghi chú đã viết. Nó chỉ thêm mảnh gọn, không bao giờ thêm nội dung đầy đủ; đặt `memory.auto_search.enabled: false` để tắt. **Git commit indexing** *(opt-in)* làm lịch sử dự án tìm kiếm semantic được như nguồn `ctx_search` thứ tư, bật bằng `memory.git_commit_indexing.enabled: true`.

### Công cụ agent nhìn nhanh

| Công cụ | Phần | Nó làm gì |
|------|-------|-------------|
| `ctx_reduce` | Ngữ cảnh | Xếp hàng nội dung tagged cũ để xóa, có nhận biết cache |
| `ctx_memory` | Thu nhận | Ghi hoặc xóa ký ức bền vững xuyên phiên |
| `ctx_search` | Nhớ lại | Tìm ký ức, lịch sử trò chuyện và git commits |
| `ctx_expand` | Nhớ lại | Giải nén một khoảng lịch sử trở lại transcript |
| `ctx_note` | Nhớ lại | Ý định trì hoãn và smart notes do dreamer đánh giá |

---

## Lệnh

| Lệnh | Mô tả |
|---------|-------------|
| `/ctx-status` | Màn hình debug: tags, pending drops, cache TTL, trạng thái nudge, tiến độ historian, độ phủ khoang, ngân sách lịch sử |
| `/ctx-flush` | Buộc tất cả thao tác đang xếp hàng chạy ngay, bỏ qua cache TTL |
| `/ctx-recomp` | Dựng lại khoang từ lịch sử thô (nhận khoảng `start-end`). Dùng khi trạng thái lưu trữ có vẻ sai |
| `/ctx-dream` | Chạy bảo trì dreamer theo yêu cầu: duy trì bộ nhớ, docs, smart notes và review user-profile |

---

## Ứng dụng desktop

Ứng dụng desktop đi kèm để duyệt và quản lý trạng thái Magic Context bên ngoài terminal.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Trình duyệt bộ nhớ**: tìm, lọc và sửa ký ức dự án theo danh mục và dự án.
- **Lịch sử phiên**: duyệt khoang và ghi chú của bất kỳ phiên nào bằng điều hướng timeline.
- **Chẩn đoán cache**: timeline cache hit/miss thời gian thực và phát hiện nguyên nhân bust.
- **Quản lý dreamer**: xem lịch sử dream-run, kích hoạt runs, kiểm tra kết quả nhiệm vụ.
- **Trình sửa cấu hình**: sửa mọi thiết lập bằng biểu mẫu, gồm model fallback chains.
- **Trình xem log**: live-tailing logs có tìm kiếm.

Nó đọc trực tiếp từ cơ sở dữ liệu SQLite của Magic Context. Không cần server thêm, không API. Có tự cập nhật tích hợp.

---

## Cấu hình

Thiết lập nằm trong `magic-context.jsonc`. Mọi thứ có mặc định hợp lý; cấu hình dự án được merge lên trên thiết lập toàn người dùng. Để xem tham chiếu đầy đủ, chỉnh cache TTL, ngưỡng execute theo mô hình, chọn mô hình historian và dreamer, embedding providers và thiết lập bộ nhớ, xem **[CONFIGURATION.md](./CONFIGURATION.md)** hoặc **[tham chiếu cấu hình trên docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Vị trí cấu hình** (một vị trí CortexKit chung, dự án ghi đè người dùng):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Nâng cấp từ phiên bản cũ? Cấu hình hiện có được tự động chuyển tới đây trong lần chạy đầu tiên (để lại dấu `.MOVED_READPLEASE` ở đường dẫn cũ).

---

## Lưu trữ

Mọi trạng thái bền vững nằm trong cơ sở dữ liệu SQLite local dưới CortexKit store chung (`~/.local/share/cortexkit/magic-context/context.db`, tương đương XDG trên Windows; cơ sở dữ liệu OpenCode-folder cũ được migrate khi khởi động lần đầu). Nếu không mở được cơ sở dữ liệu, Magic Context tự tắt và thông báo cho bạn. Ký ức được gắn với **danh tính dự án ổn định** suy ra từ repo, nên chúng theo dự án qua worktrees, clones và forks thay vì bị buộc vào đường dẫn thư mục.

Magic Context cũng ghi vào vài vị trí khác:

| Đường dẫn | Nội dung | Độ bền |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Cơ sở dữ liệu SQLite, tags, khoang, ký ức, mọi trạng thái bền vững (tương đương XDG trên Windows) | **Phải được giữ.** Mất nó là mất memory/history. |
| `~/.local/share/cortexkit/magic-context/models/` | Cache mô hình embedding local (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), tải lần đầu khi local embeddings bật | Nên được giữ, nếu không sẽ tải lại mỗi lần chạy. Không dùng khi `memory.enabled: false` hoặc đã cấu hình backend embedding `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log chẩn đoán | Có thể bỏ. |

**Môi trường sandbox / tạm thời (Docker, CI, container dùng rồi bỏ):** mount thư mục `~/.local/share/cortexkit/magic-context/` vào volume bền vững để cơ sở dữ liệu và cache mô hình sống qua các lần chạy. Nếu chỉ cache mô hình tạm thời, mô hình chỉ tải lại; nếu cơ sở dữ liệu tạm thời, bộ nhớ và lịch sử không tích lũy. Để tránh hoàn toàn tải mô hình ~90 MB, đặt `memory.enabled: false` hoặc trỏ `embedding` tới backend từ xa `openai_compatible`/`ollama`.

---

## Lịch sử sao

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Phát triển

**Yêu cầu:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Thực thi Dream cần server OpenCode đang chạy (dreamer tạo child sessions tạm thời). Dùng `/ctx-dream` trong OpenCode để bảo trì theo yêu cầu.

---

## Đóng góp

Bug reports và pull requests đều được hoan nghênh. Với thay đổi lớn, hãy mở issue trước để thảo luận hướng tiếp cận. Chạy `bun run format` trước khi gửi; CI từ chối mã chưa format.

---

## Giấy phép

[MIT](LICENSE)
