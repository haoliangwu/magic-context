<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <strong>한국어</strong> |
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

*이 문서는 커뮤니티 번역입니다. 영어 [README.md](./README.md)가 기준 문서이며 더 최신일 수 있습니다.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>한계 없는 컨텍스트. 스스로 관리되는 메모리. 평생 이어지는 하나의 세션.</strong><br>
  CortexKit의 일부이자 코딩 에이전트를 위한 해마입니다.
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
  <em>개발자를 한 가지 일을 위해 고용한 뒤 출시하자마자 해고하지는 않습니다.<br>에이전트에게도 그렇게 하지 마세요.</em>
</p>

<p align="center">
  <a href="#magic-context란">Magic Context란?</a> ·
  <a href="#빠른-시작">빠른 시작</a> ·
  <a href="#cortexkit의-일부">CortexKit</a> ·
  <a href="#컨텍스트-관리">컨텍스트</a> ·
  <a href="#캡처">캡처</a> ·
  <a href="#통합">통합</a> ·
  <a href="#회상">회상</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Magic Context란?

개발자를 버그 하나 고치게 하려고 고용한 뒤, 배포되는 순간 해고하지는 않습니다. 좋은 사람은 계속 함께합니다. 그들은 코드베이스를 익히고, 왜 그런 결정이 내려졌는지 기억하며, 매주 더 날카로워집니다.

코딩 에이전트는 반대로 작동합니다. 모든 작업은 프로젝트에 대한 기억이 없는 신입이고, 각 세션이 끝나면 그들을 해고하고 다시 처음부터 시작합니다. 작업 중간에는 흐름을 끊고 알고 있던 내용을 조용히 떨어뜨리는 "compaction" 중단도 만납니다. 해마가 손상되었을 때 생기는 것과 같은 순행성 기억상실입니다.

Magic Context는 에이전트에게 그 부분을 제공합니다. 코딩 에이전트를 위한 **해마**로서, 기억을 만들고, 통합하고, 다시 떠올리는 뇌의 부분을 완전히 백그라운드에서 맡습니다. 하나의 세션은 더 이상 일회성 계약자가 아니라 프로젝트 전체를 함께한 장기 팀원이 됩니다.

- **캡처.** historian이 기록을 압축할 때, 오래가는 지식(결정, 제약, 관례)을 프로젝트 메모리로 끌어올립니다. 이미 하고 있는 작업에서 메모리 시스템을 공짜로 얻게 됩니다.
- **통합.** 밤사이 dreamer 에이전트가 수면이 우리에게 해 주는 일을 합니다. 코드베이스를 기준으로 메모리를 확인하고, 중복 및 오래된 항목을 정리하며, 반복되는 내용을 승격합니다.
- **회상.** 적절한 메모리가 매 턴 자동으로 떠오르고, 에이전트는 필요할 때 메모리, 과거 대화, git 기록 전체를 검색할 수 있습니다. 세션을 넘어, OpenCode와 Pi를 넘어 작동합니다.

두 가지 약속이 있습니다. 에이전트는 **컨텍스트 관리를 위해 절대 멈추지 않고**(compaction 중단도, 끊긴 흐름도 없습니다), **절대 잊지 않습니다**.

프로젝트마다 하나의 세션을 실행하고 몇 주, 몇 달, 몇 년 동안 계속 이어 가세요. 함께 만든 모든 것을 기억합니다.

---

## 빠른 시작

대화형 설정 마법사를 실행하세요. 모델을 감지하고, 모든 것을 구성하며, 호환성도 처리합니다.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**또는 직접 실행(모든 OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

마법사는 보유한 harness(OpenCode, Pi 또는 둘 다)를 자동 감지하고, 플러그인을 추가하며, 내장 compaction을 비활성화하고, historian과 dreamer에 사용할 모델 선택을 돕고, 다른 컨텍스트 관리 플러그인과의 충돌을 해결합니다. 특정 harness를 대상으로 하려면 `--harness opencode` 또는 `--harness pi`를 사용하세요.

> **왜 내장 compaction을 비활성화하나요?** Magic Context가 직접 컨텍스트를 관리합니다. 호스트의 compaction은 캐시를 고려한 지연 작업을 방해하고 이중 압축을 일으킬 수 있습니다.

**수동 설정**(OpenCode): `opencode.json`에 플러그인을 추가하고 compaction을 끈 다음, `<project>/.cortexkit/`에 `magic-context.jsonc`를 넣으세요(사용자 전체 기본값은 `~/.config/cortexkit/`). [구성 참조](./CONFIGURATION.md)를 확인하세요.

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi`(Pi `>= 0.74.0` 필요). Pi 확장은 OpenCode와 같은 데이터베이스를 공유하며, 프로젝트 메모리와 임베딩은 둘 사이에서 함께 모입니다.

**문제 해결:** `npx @cortexkit/magic-context@latest doctor`는 harness를 자동 감지하고, 충돌(compaction, OMO hooks, DCP)을 확인하며, 플러그인과 TUI 사이드바를 검증하고, 데이터베이스 무결성 검사를 실행한 뒤 가능한 부분을 고칩니다. 바로 제출할 수 있는 버그 보고서를 만들려면 `--issue`를 추가하세요.

새 프로젝트든 오래 실행해 온 프로젝트든 방식은 같습니다. 설치하고, harness를 재시작하면, Magic Context가 그 시점부터 컨텍스트를 캡처합니다. 설치 전의 OpenCode 또는 Pi 세션을 되채우지는 않습니다.

<details>
<summary><strong>다른 컨텍스트 관리 플러그인과의 호환성</strong></summary>

<br>

Magic Context는 컨텍스트 관리를 처음부터 끝까지 소유하므로, 다른 플러그인이 이미 그 일을 하고 있으면 **스스로 비활성화**됩니다. 컨텍스트 관리자 두 개를 동시에 실행하면 기록이 이중으로 압축되고 프롬프트 캐시가 흔들립니다. 시작 시 다음 항목을 확인합니다. setup과 `doctor`가 각각을 해결하도록 돕고, 해결될 때까지 Magic Context는 안전하게 꺼진 상태로 남아 이유를 알려 줍니다.

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context가 이를 대체합니다. Setup이 꺼 줍니다.
- **DCP** (`opencode-dcp`): 별도의 컨텍스트 가지치기 플러그인입니다. 둘은 함께 실행할 수 없으므로 `plugin` 목록에서 제거하세요.
- **oh-my-opencode (OMO)**: setup은 겹치는 세 가지 hooks를 비활성화하도록 제안합니다.
  - `preemptive-compaction`: historian과 충돌하는 compaction을 트리거합니다.
  - `context-window-monitor`: Magic Context의 알림과 겹치는 사용량 경고를 주입합니다.
  - `anthropic-context-window-limit-recovery`: historian을 우회하는 긴급 compaction을 트리거합니다.

언제든 `npx @cortexkit/magic-context@latest doctor`를 실행해 다시 확인하고 자동으로 고치세요.

</details>

---

## CortexKit의 일부

뇌는 하나의 기관이 아닙니다. 유능한 코딩 에이전트도 마찬가지입니다.

**CortexKit**은 플러그인 제품군이며, 각 플러그인은 뇌의 서로 다른 영역을 모델로 합니다. 하나를 설치하면 에이전트가 더 날카로워집니다. 세 개를 모두 설치하면 에이전트에게 뇌가 생깁니다.

| 플러그인 | 영역 | 하는 일 |
|---|---|---|
| **Magic Context** *(현재 위치)* | 해마와 내측 측두엽 | 스스로 관리되는 컨텍스트와 장기 메모리. 프로젝트 지식을 형성, 통합, 회상하면서 compaction 중단 없이 세션을 계속 실행합니다. |
| **[AFT](https://github.com/cortexkit/aft)** | 감각운동 피질 | 코드 구조를 인식하고 정확히 행동합니다. 에이전트를 위한 제대로 된 IDE와 OS입니다. |
| **Alfonso** *(곧 제공)* | 전전두엽 피질 | 실행 제어. 계획하고, 작업을 분해하고, 에이전트와 모델을 선택하며, 언제 묻고 검증하고 커밋할지 결정합니다. |

Magic Context는 **앞으로 필요한 3개의 플러그인 중 하나**입니다. Magic Context는 기억하고, AFT는 인식하고 행동하며, Alfonso는 결정합니다. 이들은 하나의 CortexKit 저장소를 공유하므로 메모리가 harness와 도구를 넘어 함께 모입니다.

---

## ⚡ 컨텍스트 관리

*스스로 관리되는 한계 없는 세션.* 작업할수록 컨텍스트 창은 차오르고, 일반적인 해결책인 compaction은 에이전트를 멈춰 세운 뒤 모든 것을 다시 읽게 합니다. Magic Context는 이를 백그라운드에서 계속 처리하므로 세션은 그대로 이어집니다.

- **Historian 구획화**: 백그라운드 historian은 오래된 원시 기록을 **계층형 구획**으로 압축합니다. 이는 오래된 메시지를 대신하는 시간순 요약입니다. 각 구획에는 중요도 점수가 있어, 흐름을 잃지 않으면서도 라이브 창을 작게 유지합니다. 요약에는 주 에이전트의 코딩 능력이 필요 없으므로, 주 에이전트는 최고 수준으로 두고 historian은 저렴한 모델이나 완전한 로컬 모델에서 실행할 수 있습니다.
- **감쇠 렌더링**: 구획은 그 순간에 맞는 충실도로 렌더링되며, 모델의 컨텍스트 창에 맞춰 스스로 조정되는 결정적이고 LLM을 쓰지 않는 규칙을 따릅니다. 오래된 기록은 절벽에서 떨어지듯 사라지지 않고 부드럽게 희미해지며, 결정적이므로 같은 기록은 항상 같은 방식으로 렌더링됩니다.
- **에이전트가 버릴 것을 알려 주거나, 알려 주지 않거나**: 에이전트 주도 축소가 켜져 있으면 에이전트가 `ctx_reduce`를 호출해 오래된 도구 출력이나 긴 메시지를 제거 대상으로 표시합니다. 제거는 **대기열에 들어가고 캐시를 인식**하며, 캐시 안전 시점에만 적용되므로 축소가 캐시를 흔들지 않습니다. 끄면 에이전트는 컨텍스트 관리에서 완전히 빠집니다. 오래된 출력은 나이에 따라 자동으로 떨어지고, 선택적으로 가장 오래된 텍스트에 caveman 압축을 적용할 수 있습니다.
- **캐시 안정 레이아웃**: 이 모든 구조는 백그라운드 작업이 프롬프트의 캐시된 접두사를 절대 무효화하지 않도록 설계되어 있습니다. 캐시는 전체 세션 동안 살아남습니다.

결과적으로 하나의 세션이 몇 달 동안 실행되며, compaction 중단이 없고 캐시 가격을 쓰는 제공자에서는 비용도 낮습니다. OpenCode의 TUI에서 이를 볼 수 있으며, 라이브 사이드바가 소스별 컨텍스트 분해, historian 상태, 메모리 수를 표시하고 모든 메시지 뒤에 업데이트됩니다.

> *선택 사항(기본 꺼짐):* **caveman text compression**은 에이전트 주도 축소를 끄고 오래 실행되는 세션을 위해, 결정적인 나이 계층 규칙에 따라 가장 오래된 사용자 및 assistant 텍스트를 점진적으로 압축합니다.

---

## 🧠 캡처

*공짜로 얻는 메모리.* 기록을 압축하려면 historian이 전체 기록을 읽어야 합니다. 그래서 같은 패스에서 영구히 보관할 가치가 있는 지식, 즉 결정, 제약, 관례, 구성 값을 끌어내 **프로젝트 메모리**로 승격하고, 분류해 모든 미래 세션으로 가져갑니다. 이미 하고 있는 작업에서 메모리가 스스로 만들어집니다.

대부분은 자동으로 캡처되지만, 에이전트가 명시적으로 메모리를 기록할 수도 있습니다.

- **`ctx_memory`**: 작은 범주 분류(`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`) 안에서 세션을 넘는 지식을 직접 쓰거나 삭제합니다.

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **시간 인식** *(기본 켜짐)* 은 메시지 사이의 `+2h 15m` 같은 간격 표시와 날짜가 붙은 구획으로 에이전트에게 시간 감각을 주어, 어떤 일이 얼마나 오래전에 있었는지 추론할 수 있게 합니다. 끄려면 `temporal_awareness: false`를 설정하세요.

---

## 🌙 통합

*수면이 기억에 해 주는 일.* 선택적 **dreamer** 에이전트가 밤새 실행되어 메모리 품질을 높게 유지하고, 각 작업마다 임시 하위 세션을 띄웁니다.

- **검증**: 현재 코드베이스(경로, 구성, 패턴)를 기준으로 메모리를 점진적으로 확인하고 오래된 사실을 수정하거나 제거합니다.
- **정리**: 전체 메모리 풀을 스캔해 중복을 합치고, 표현을 다듬고, 가치가 낮거나 중복된 항목을 보관 처리합니다.
- **분류**: 라이브 프롬프트 캐시를 방해하지 않으면서 각 메모리의 중요도, 범위, 안전한 공유 가능성을 점수화합니다.
- **문서 유지**: 코드베이스 변경에 맞춰 `ARCHITECTURE.md`와 `STRUCTURE.md`를 최신으로 유지합니다.
- **사용자 메모리**: 사용자의 작업 방식(소통 스타일, 리뷰 초점, 작업 패턴)에 대한 반복 관찰을 모든 세션과 함께 이동하는 `<user-profile>`로 승격합니다.
- **Smart notes**: `surface_condition`이 참이 된 지연 노트를 평가하고 준비된 노트를 드러냅니다.

유휴 시간에 실행되므로 dreamer는 느린 로컬 모델과도 잘 어울립니다. 아무도 기다리지 않습니다. 언제든 `/ctx-dream`으로 실행을 트리거하세요.

---

## 🔎 회상

*올바른 순간의 올바른 메모리.* 매 턴 활성 프로젝트 메모리와 압축된 세션 기록이 자동으로, 캐시 안정적으로 주입됩니다. 필요할 때 에이전트는 다음을 사용합니다.

- **`ctx_search`**: 한 번의 질의로 세 계층을 동시에 검색합니다. 프로젝트 **memories**, 원시 **conversation** 기록, 인덱싱된 **git commits**입니다. 전체 텍스트 fallback을 갖춘 semantic embeddings를 사용합니다.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: 에이전트가 정확한 세부 정보를 필요로 할 때 압축된 기록 범위를 원래 `U:`/`A:` transcript로 되돌립니다.
- **`ctx_note`**: 지연된 의도를 위한 scratchpad입니다. 노트는 자연스러운 경계(커밋 후, historian 실행 후, todos 완료 시)에서 다시 떠오릅니다. **Smart notes**는 dreamer가 지켜보는 열린 조건을 가집니다.

회상은 **세션을 넘어**(새 세션이 모든 것을 상속) 그리고 **harness를 넘어**(OpenCode에서 메모리를 쓰고 Pi에서 가져오기) 작동합니다.

> **자동 검색 힌트** *(기본 켜짐)* 는 매 턴 백그라운드 `ctx_search`를 실행하고 관련 항목이 있으면 "희미한 회상"을 속삭입니다. 적어 둔 노트를 거의 떠올리는 느낌입니다. 항상 압축된 조각만 추가하고 전체 내용은 추가하지 않습니다. 끄려면 `memory.auto_search.enabled: false`를 설정하세요. **Git commit 인덱싱** *(선택 켜기)* 은 프로젝트 기록을 네 번째 `ctx_search` 소스로 semantic 검색 가능하게 합니다. `memory.git_commit_indexing.enabled: true`로 활성화하세요.

### 에이전트 도구 한눈에 보기

| 도구 | 섹션 | 하는 일 |
|------|-------|-------------|
| `ctx_reduce` | 컨텍스트 | 오래된 태그 콘텐츠를 캐시를 고려해 제거 대기열에 넣습니다 |
| `ctx_memory` | 캡처 | 오래가는 세션 간 메모리를 쓰거나 삭제합니다 |
| `ctx_search` | 회상 | 메모리, 대화 기록, git commits를 검색합니다 |
| `ctx_expand` | 회상 | 기록 범위를 transcript로 다시 압축 해제합니다 |
| `ctx_note` | 회상 | 지연된 의도와 dreamer가 평가하는 smart notes |

---

## 명령

| 명령 | 설명 |
|---------|-------------|
| `/ctx-status` | 디버그 보기: tags, pending drops, cache TTL, nudge state, historian 진행, 구획 범위, 기록 예산 |
| `/ctx-flush` | 캐시 TTL을 우회하여 모든 대기 작업을 즉시 강제 실행 |
| `/ctx-recomp` | 원시 기록에서 구획을 다시 빌드합니다(`start-end` 범위 허용). 저장 상태가 잘못된 것 같을 때 사용 |
| `/ctx-dream` | 필요할 때 dreamer 유지 관리를 실행: 메모리, 문서, smart notes, user-profile 검토 관리 |

---

## 데스크톱 앱

터미널 밖에서 Magic Context 상태를 탐색하고 관리하기 위한 동반 데스크톱 앱입니다.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **메모리 브라우저**: 범주와 프로젝트별로 프로젝트 메모리를 검색, 필터링, 편집합니다.
- **세션 기록**: 타임라인 탐색으로 모든 세션의 구획과 노트를 살펴봅니다.
- **캐시 진단**: 실시간 캐시 hit/miss 타임라인과 bust 원인 감지.
- **Dreamer 관리**: dream-run 기록을 보고, 실행을 트리거하고, 작업 결과를 검사합니다.
- **구성 편집기**: 모델 fallback 체인을 포함한 모든 설정을 양식 기반으로 편집합니다.
- **로그 뷰어**: 검색이 있는 실시간 로그 tailing.

Magic Context의 SQLite 데이터베이스에서 직접 읽습니다. 추가 서버도, API도 필요 없습니다. 자동 업데이트가 내장되어 있습니다.

---

## 구성

설정은 `magic-context.jsonc`에 있습니다. 모든 항목에는 합리적인 기본값이 있으며, 프로젝트 구성은 사용자 전체 설정 위에 병합됩니다. 전체 참조, 즉 캐시 TTL 조정, 모델별 execute 임계값, historian 및 dreamer 모델 선택, embedding providers, 메모리 설정은 **[CONFIGURATION.md](./CONFIGURATION.md)** 또는 **[docs.cortexkit.io의 구성 참조](https://docs.cortexkit.io/magic-context/reference/configuration/)**를 확인하세요.

**구성 위치**(공유 CortexKit 위치 하나, 프로젝트가 사용자를 덮어씀):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

이전 버전에서 업그레이드하나요? 기존 구성은 첫 실행 시 자동으로 여기로 이동됩니다(이전 경로에는 `.MOVED_READPLEASE` 단서가 남습니다).

---

## 저장소

모든 오래가는 상태는 공유 CortexKit 저장소 아래의 로컬 SQLite 데이터베이스에 있습니다(`~/.local/share/cortexkit/magic-context/context.db`, Windows에서는 XDG에 해당하는 위치, 오래된 OpenCode 폴더 데이터베이스는 첫 부팅 시 앞으로 마이그레이션됩니다). 데이터베이스를 열 수 없으면 Magic Context는 스스로 비활성화되고 사용자에게 알립니다. 메모리는 repo에서 파생한 **안정적인 프로젝트 ID**에 묶이므로, 디렉터리 경로에 묶이지 않고 worktrees, clones, forks를 넘어 프로젝트를 따라갑니다.

Magic Context는 몇 가지 다른 위치에도 씁니다.

| 경로 | 내용 | 지속성 |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite 데이터베이스, tags, 구획, 메모리, 모든 오래가는 상태(Windows에서는 XDG에 해당하는 위치) | **반드시 지속되어야 합니다.** 잃어버리면 메모리/기록을 잃습니다. |
| `~/.local/share/cortexkit/magic-context/models/` | 로컬 embedding 모델 캐시(약 90 MB `Xenova/all-MiniLM-L6-v2` ONNX), 로컬 embeddings가 활성화된 상태에서 첫 사용 시 다운로드 | 지속되는 것이 좋습니다. 아니면 실행할 때마다 다시 다운로드됩니다. `memory.enabled: false`이거나 `openai_compatible`/`ollama` embedding backend가 구성된 경우 사용되지 않습니다. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | 진단 로그 | 폐기 가능. |

**샌드박스 / 임시 환경(Docker, CI, 일회용 컨테이너):** 데이터베이스와 모델 캐시가 실행 사이에 유지되도록 `~/.local/share/cortexkit/magic-context/` 디렉터리를 영구 볼륨에 마운트하세요. 모델 캐시만 임시라면 모델이 다시 다운로드될 뿐입니다. 데이터베이스가 임시라면 메모리와 기록은 누적되지 않습니다. 약 90 MB 모델 다운로드를 완전히 피하려면 `memory.enabled: false`를 설정하거나 `embedding`을 원격 `openai_compatible`/`ollama` backend로 지정하세요.

---

## 스타 기록

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## 개발

**요구 사항:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream 실행에는 실행 중인 OpenCode 서버가 필요합니다(dreamer가 임시 하위 세션을 만듭니다). 필요할 때 OpenCode 안에서 `/ctx-dream`을 사용하세요.

---

## 기여

버그 보고와 pull requests를 환영합니다. 더 큰 변경은 먼저 issue를 열어 접근 방식을 논의하세요. 제출 전에 `bun run format`을 실행하세요. CI는 형식이 맞지 않은 코드를 거부합니다.

---

## 라이선스

[MIT](LICENSE)
