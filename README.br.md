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
  <strong>Português (Brasil)</strong> |
  <a href="./README.th.md">ไทย</a> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*Esta é uma tradução da comunidade. O [README.md](./README.md) em inglês é a fonte da verdade e pode estar mais atualizado.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Contexto sem limites. Memória que se gerencia sozinha. Uma sessão, para a vida toda.</strong><br>
  O hipocampo para agentes de programação, parte do CortexKit.
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
  <em>Você não contrata um desenvolvedor para uma tarefa e o demite quando ele entrega.<br>Pare de fazer isso com seu agente.</em>
</p>

<p align="center">
  <a href="#o-que-é-magic-context">O que é Magic Context?</a> ·
  <a href="#início-rápido">Início rápido</a> ·
  <a href="#parte-do-cortexkit">CortexKit</a> ·
  <a href="#gerenciamento-de-contexto">Contexto</a> ·
  <a href="#captura">Captura</a> ·
  <a href="#consolidação">Consolidação</a> ·
  <a href="#recuperação">Recuperação</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## O que é Magic Context?

Você não contrata um desenvolvedor para corrigir um único bug e o demite no momento em que a correção é publicada. Os bons você mantém. Eles aprendem a base de código, lembram por que as decisões foram tomadas e ficam mais afiados toda semana.

Agentes de programação funcionam do jeito oposto. Cada tarefa é uma nova contratação sem memória do seu projeto, e no fim de cada sessão você a demite e começa do zero. No meio da tarefa eles ainda encontram pausas de "compaction" que quebram o fluxo e deixam cair silenciosamente o que sabiam. É amnésia anterógrada, a mesma coisa que acontece quando o hipocampo é danificado.

Magic Context dá um a eles. É o **hipocampo** para agentes de programação, a parte do cérebro que forma memórias, as consolida e as recupera, inteiramente em segundo plano. Uma sessão deixa de ser um contratado descartável e vira um colega de equipe de longo prazo que esteve presente durante todo o projeto:

- **Captura.** Enquanto o historian comprime seu histórico, ele eleva o conhecimento durável (decisões, restrições, convenções) para a memória do projeto. Você ganha um sistema de memória de graça, a partir do trabalho que já está fazendo.
- **Consolidação.** Durante a noite, agentes dreamer fazem o que o sono faz por você: verificam memórias contra a base de código, organizam duplicatas e entradas obsoletas, e promovem o que se repete.
- **Recuperação.** As memórias certas aparecem automaticamente a cada turno, e o agente pode procurar em memórias, conversas passadas e histórico git sob demanda. Entre sessões, e entre OpenCode e Pi.

Duas promessas: seu agente **nunca para para gerenciar seu contexto** (sem pausas de compaction, sem fluxo quebrado) e **nunca esquece**.

Execute uma sessão por projeto e mantenha-a por semanas, meses ou anos. Ela lembra tudo que vocês construíram juntos.

---

## Início rápido

Execute o assistente interativo de configuração. Ele detecta seus modelos, configura tudo e cuida da compatibilidade.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Ou execute diretamente (qualquer OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

O assistente detecta automaticamente quais harnesses você tem (OpenCode, Pi ou ambos), adiciona o plugin, desativa a compaction integrada, ajuda você a escolher modelos para historian e dreamer, e resolve conflitos com outros plugins de gerenciamento de contexto. Aponte para um harness específico com `--harness opencode` ou `--harness pi`.

> **Por que desativar a compaction integrada?** Magic Context gerencia o contexto por conta própria. A compaction do host interferiria nas operações adiadas conscientes de cache e comprimiria duas vezes.

**Configuração manual** (OpenCode): adicione o plugin e desligue a compaction em `opencode.json`, depois coloque um `magic-context.jsonc` em `<project>/.cortexkit/` (ou `~/.config/cortexkit/` para padrões de usuário). Veja a [referência de configuração](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (requer Pi `>= 0.74.0`). A extensão Pi compartilha o mesmo banco de dados que o OpenCode; memórias do projeto e embeddings se agrupam entre ambos.

**Solução de problemas:** `npx @cortexkit/magic-context@latest doctor` detecta seus harnesses automaticamente, verifica conflitos (compaction, OMO hooks, DCP), valida o plugin e a barra lateral TUI, executa uma checagem de integridade no banco de dados e corrige o que puder. Adicione `--issue` para criar um relatório de bug pronto para enviar.

Funciona igual em um projeto novo ou antigo: instale, reinicie o harness, e o Magic Context captura contexto a partir desse ponto. Ele não preenche sessões OpenCode ou Pi anteriores à instalação.

<details>
<summary><strong>Compatibilidade com outros plugins de gerenciamento de contexto</strong></summary>

<br>

Magic Context possui o gerenciamento de contexto de ponta a ponta, então **se desativa** se outro plugin já estiver fazendo esse trabalho. Dois gerenciadores de contexto ao mesmo tempo comprimiriam seu histórico duas vezes e bagunçariam o prompt cache. Na inicialização ele verifica o seguinte; setup e `doctor` ajudam a resolver cada item, e até que sejam resolvidos Magic Context fica desligado (fail-safe) e explica por quê:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context a substitui. Setup a desliga.
- **DCP** (`opencode-dcp`): um plugin separado de poda de contexto. Os dois não podem rodar juntos; remova-o da sua lista `plugin`.
- **oh-my-opencode (OMO)**: setup oferece desativar os três hooks que se sobrepõem:
  - `preemptive-compaction`: dispara compaction que conflita com historian.
  - `context-window-monitor`: injeta avisos de uso que se sobrepõem aos nudges do Magic Context.
  - `anthropic-context-window-limit-recovery`: dispara compaction de emergência que ignora historian.

Execute `npx @cortexkit/magic-context@latest doctor` a qualquer momento para verificar de novo e corrigir automaticamente.

</details>

---

## Parte do CortexKit

Um cérebro não é um único órgão. Um agente de programação capaz também não.

**CortexKit** é uma família de plugins, cada um modelado em uma região diferente do cérebro. Instale um e seu agente fica mais afiado. Instale os três e ele tem um cérebro.

| Plugin | Região | O que faz |
|---|---|---|
| **Magic Context** *(você está aqui)* | Hipocampo e lobo temporal medial | Contexto autogerenciado e memória de longo prazo. Mantém sessões em execução sem pausas de compaction enquanto forma, consolida e recupera conhecimento do projeto entre elas. |
| **[AFT](https://github.com/cortexkit/aft)** | Córtex sensório-motor | Percebe a estrutura do código e age sobre ela com precisão. Um IDE e OS de verdade para seu agente. |
| **Alfonso** *(em breve)* | Córtex pré-frontal | Controle executivo. Planeja, decompõe trabalho, escolhe agentes e modelos, e decide quando perguntar, verificar e commitar. |

Magic Context é **1 dos 3 plugins de que você vai precisar.** Ele lembra; AFT percebe e age; Alfonso decide. Eles compartilham um único armazenamento CortexKit, então a memória se agrupa entre harnesses e ferramentas.

---

## ⚡ Gerenciamento de contexto

*Uma sessão sem limites que se gerencia sozinha.* A janela de contexto se enche enquanto você trabalha, e a solução comum, compaction, para o agente para reler tudo. Magic Context cuida disso continuamente em segundo plano, então a sessão continua.

- **Compartimentalização historian**: um historian em segundo plano comprime histórico bruto antigo em **compartimentos em camadas**, resumos cronológicos que representam mensagens mais antigas. Cada um carrega uma pontuação de importância, então a janela ativa fica pequena sem perder o fio. Resumir não precisa da força de programação do agente principal, então você pode rodar historian em um modelo barato ou totalmente local enquanto o agente principal fica no topo.
- **Renderização por decaimento**: compartimentos são renderizados com a fidelidade certa para o momento, por uma regra determinística sem LLM que se ajusta à janela de contexto do modelo. O histórico antigo desaparece de forma suave em vez de cair de um penhasco, e como é determinístico, o mesmo histórico sempre renderiza igual.
- **O agente sugere o que descartar, ou não**: com redução guiada pelo agente ligada, o agente chama `ctx_reduce` para marcar saídas de ferramentas obsoletas ou mensagens longas para remoção. Os descartes são **enfileirados e conscientes de cache**, aplicados apenas em momentos seguros para cache, então a redução nunca desestabiliza o cache. Desligue isso e o agente fica totalmente fora do gerenciamento de contexto: saída obsoleta é removida automaticamente por idade, com compressão caveman opcional do texto mais antigo.
- **Layout estável para cache**: tudo isso é estruturado para que trabalho em segundo plano nunca invalide o prefixo cacheado do seu prompt. Seu cache sobrevive à sessão inteira.

O resultado: uma sessão roda por meses, sem pausas de compaction e com baixo custo em provedores com preço por cache. Você pode ver isso na TUI do OpenCode, onde uma barra lateral ao vivo mostra a divisão do contexto por fonte, status do historian e contagens de memória, atualizando após cada mensagem.

> *Opcional (desligado por padrão):* **caveman text compression** comprime progressivamente o texto mais antigo de user e assistant por uma regra determinística por idade, para sessões que rodam com redução guiada pelo agente desligada.

---

## 🧠 Captura

*Memória, de graça.* Para comprimir seu histórico, historian precisa ler tudo. Então, na mesma passagem, ele extrai o conhecimento que vale guardar para sempre, decisões, restrições, convenções, valores de configuração, e o promove para **memória do projeto**, categorizada e levada a cada sessão futura. Sua memória se constrói sozinha a partir do trabalho que você já faz.

O agente também pode registrar memórias explicitamente, embora a maioria seja capturada automaticamente para ele:

- **`ctx_memory`**: escreva ou apague conhecimento entre sessões diretamente, em uma pequena taxonomia de categorias (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Consciência temporal** *(ligada por padrão)* dá ao agente uma noção de tempo, com marcadores de intervalo como `+2h 15m` entre mensagens e compartimentos datados, para que ele raciocine sobre há quanto tempo algo aconteceu. Defina `temporal_awareness: false` para desligar.

---

## 🌙 Consolidação

*O que o sono faz pela memória.* Um agente **dreamer** opcional roda durante a noite para manter a qualidade da memória alta, criando sessões filhas efêmeras para cada tarefa:

- **Verificar**: checar memórias incrementalmente contra a codebase atual (caminhos, configs, padrões) e corrigir ou remover fatos obsoletos.
- **Curar**: varrer todo o pool de memória para mesclar duplicatas, apertar redação e arquivar entradas de baixo valor ou redundantes.
- **Classificar**: pontuar a importância, escopo e compartilhamento seguro de cada memória sem perturbar o prompt cache ativo.
- **Manter docs**: manter `ARCHITECTURE.md` e `STRUCTURE.md` atualizados a partir de mudanças na codebase.
- **Memórias de usuário**: promover observações recorrentes sobre como você trabalha (estilo de comunicação, foco de review, padrões de trabalho) para um `<user-profile>` que viaja com cada sessão.
- **Smart notes**: avaliar notas adiadas cujo `surface_condition` se tornou verdadeiro e mostrar as prontas.

Como roda em tempo ocioso, dreamer combina bem com modelos locais, mesmo lentos. Ninguém fica esperando. Dispare uma execução a qualquer momento com `/ctx-dream`.

---

## 🔎 Recuperação

*A memória certa no momento certo.* A cada turno, memórias ativas do projeto e histórico de sessão compactado são injetados automaticamente e de forma estável para cache. Sob demanda, o agente usa:

- **`ctx_search`**: uma consulta em três camadas ao mesmo tempo: **memories** do projeto, histórico bruto de **conversation** e **git commits** indexados. Semantic embeddings com fallback de texto completo.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: trazer um intervalo de histórico comprimido de volta ao transcript original `U:`/`A:` quando o agente precisa dos detalhes exatos.
- **`ctx_note`**: um scratchpad para intenções adiadas. Notas reaparecem em limites naturais (depois de commits, depois de execuções de historian, quando todos terminam). **Smart notes** carregam uma condição em aberto que dreamer observa.

A recuperação funciona **entre sessões** (uma nova sessão herda tudo) e **entre harnesses** (escreva uma memória no OpenCode, recupere-a no Pi).

> **Dicas de busca automática** *(ligadas por padrão)* rodam um `ctx_search` em segundo plano a cada turno e sussurram uma "lembrança vaga" quando algo relevante existe, como quase lembrar uma nota que você fez. Só adiciona fragmentos compactos, nunca conteúdo completo; defina `memory.auto_search.enabled: false` para desligar. **Indexação de git commits** *(opt-in)* torna o histórico do projeto semanticamente pesquisável como uma quarta fonte de `ctx_search`, habilite com `memory.git_commit_indexing.enabled: true`.

### Ferramentas do agente em resumo

| Ferramenta | Seção | O que faz |
|------|-------|-------------|
| `ctx_reduce` | Contexto | Enfileira conteúdo marcado obsoleto para remoção, consciente de cache |
| `ctx_memory` | Captura | Escreve ou apaga memórias duráveis entre sessões |
| `ctx_search` | Recuperação | Pesquisa memórias, histórico de conversa e git commits |
| `ctx_expand` | Recuperação | Descomprime um intervalo de histórico de volta ao transcript |
| `ctx_note` | Recuperação | Intenções adiadas e smart notes avaliadas por dreamer |

---

## Comandos

| Comando | Descrição |
|---------|-------------|
| `/ctx-status` | Visão de debug: tags, pending drops, cache TTL, estado de nudge, progresso do historian, cobertura de compartimentos, orçamento de histórico |
| `/ctx-flush` | Forçar todas as operações enfileiradas imediatamente, ignorando cache TTL |
| `/ctx-recomp` | Reconstruir compartimentos a partir do histórico bruto (aceita um intervalo `start-end`). Use quando o estado armazenado parecer errado |
| `/ctx-dream` | Executar manutenção dreamer sob demanda: manter memória, docs, smart notes e revisão de user-profile |

---

## Aplicativo desktop

Um aplicativo desktop companheiro para navegar e gerenciar o estado do Magic Context fora do terminal.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Navegador de memória**: pesquise, filtre e edite memórias do projeto por categoria e projeto.
- **Histórico de sessão**: navegue por compartimentos e notas de qualquer sessão com navegação em linha do tempo.
- **Diagnóstico de cache**: linha do tempo em tempo real de cache hit/miss e detecção de causas de bust.
- **Gerenciamento dreamer**: veja histórico de dream-run, dispare execuções, inspecione resultados de tarefas.
- **Editor de configuração**: edição por formulário para cada configuração, incluindo cadeias de fallback de modelos.
- **Visualizador de logs**: live-tailing logs com busca.

Ele lê diretamente do banco SQLite do Magic Context. Sem servidor extra, sem API. Autoatualizações integradas.

---

## Configuração

As configurações ficam em `magic-context.jsonc`. Tudo tem padrões sensatos; a configuração do projeto é mesclada sobre as configurações de usuário. Para a referência completa, ajuste de cache TTL, limites execute por modelo, seleção de modelos historian e dreamer, provedores de embeddings e configurações de memória, veja **[CONFIGURATION.md](./CONFIGURATION.md)** ou a **[referência de configuração em docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Locais de configuração** (um local CortexKit compartilhado, projeto sobrescreve usuário):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Atualizando de uma versão anterior? Sua configuração existente é movida para cá automaticamente na primeira execução (um rastro `.MOVED_READPLEASE` fica no caminho antigo).

---

## Armazenamento

Todo estado durável vive em um banco SQLite local sob o armazenamento CortexKit compartilhado (`~/.local/share/cortexkit/magic-context/context.db`, equivalente XDG no Windows; bancos legados em pastas OpenCode são migrados no primeiro boot). Se o banco não puder ser aberto, Magic Context se desativa e avisa você. Memórias são chaveadas para uma **identidade estável de projeto** derivada do repo, então acompanham um projeto entre worktrees, clones e forks em vez de ficarem presas a um caminho de diretório.

Magic Context também escreve em alguns outros locais:

| Caminho | O quê | Persistência |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Banco SQLite, tags, compartimentos, memórias, todo estado durável (equivalente XDG no Windows) | **Deve persistir.** Perdê-lo perde sua memória/histórico. |
| `~/.local/share/cortexkit/magic-context/models/` | Cache local do modelo de embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), baixado no primeiro uso quando embeddings locais estão habilitados | Deve persistir, senão será baixado de novo a cada execução. Não é usado quando `memory.enabled: false` ou um backend de embeddings `openai_compatible`/`ollama` está configurado. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log de diagnóstico | Descartável. |

**Ambientes sandbox / efêmeros (Docker, CI, contêineres descartáveis):** monte o diretório `~/.local/share/cortexkit/magic-context/` em um volume persistente para que o banco e o cache do modelo sobrevivam entre execuções. Se só o cache do modelo for efêmero, o modelo apenas será baixado de novo; se o banco for efêmero, memória e histórico não se acumulam. Para evitar completamente o download do modelo de ~90 MB, defina `memory.enabled: false` ou aponte `embedding` para um backend remoto `openai_compatible`/`ollama`.

---

## Histórico de estrelas

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Desenvolvimento

**Requisitos:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

A execução de Dream requer um servidor OpenCode ativo (dreamer cria sessões filhas efêmeras). Use `/ctx-dream` dentro do OpenCode para manutenção sob demanda.

---

## Contribuição

Bug reports e pull requests são bem-vindos. Para mudanças maiores, abra primeiro uma issue para discutir a abordagem. Execute `bun run format` antes de enviar; CI rejeita código sem formatação.

---

## Licença

[MIT](LICENSE)
