<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <strong>Español</strong> |
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

*Esta es una traducción de la comunidad. El [README.md](./README.md) en inglés es la fuente de verdad y puede estar más actualizado.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Contexto sin límites. Memoria que se administra sola. Una sesión, para toda la vida.</strong><br>
  El hipocampo para agentes de programación, parte de CortexKit.
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
  <em>No contratas a un desarrollador para una tarea y lo despides cuando entrega.<br>Deja de hacerle eso a tu agente.</em>
</p>

<p align="center">
  <a href="#qué-es-magic-context">¿Qué es Magic Context?</a> ·
  <a href="#inicio-rápido">Inicio rápido</a> ·
  <a href="#parte-de-cortexkit">CortexKit</a> ·
  <a href="#gestión-del-contexto">Contexto</a> ·
  <a href="#captura">Captura</a> ·
  <a href="#consolidación">Consolidación</a> ·
  <a href="#recuperación">Recuperación</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## ¿Qué es Magic Context?

No contratas a un desarrollador para arreglar un solo bug y lo despides en cuanto se publica. A los buenos los conservas. Aprenden el código, recuerdan por qué se tomaron las decisiones y mejoran cada semana.

Los agentes de programación funcionan al revés. Cada tarea es una nueva contratación sin memoria de tu proyecto y, al final de cada sesión, los despides y empiezas desde cero. A mitad de una tarea incluso chocan con pausas de "compaction" que rompen el flujo y dejan caer en silencio lo que sabían. Es amnesia anterógrada, lo mismo que ocurre cuando el hipocampo está dañado.

Magic Context les da uno. Es el **hipocampo** para agentes de programación, la parte del cerebro que forma recuerdos, los consolida y los recupera, todo en segundo plano. Una sesión deja de ser un contratista desechable y se convierte en un compañero de largo plazo que estuvo allí durante todo el proyecto:

- **Captura.** Mientras el historian comprime tu historia, eleva el conocimiento duradero (decisiones, restricciones, convenciones) a la memoria del proyecto. Obtienes un sistema de memoria gratis, a partir del trabajo que ya haces.
- **Consolidación.** Durante la noche, los agentes dreamer hacen lo que el sueño hace por ti: verifican recuerdos contra el código, depuran duplicados y entradas obsoletas, y promueven lo que se repite.
- **Recuperación.** Los recuerdos correctos aparecen automáticamente en cada turno, y el agente puede buscar en recuerdos, conversaciones pasadas e historial de git cuando lo necesita. Entre sesiones, y entre OpenCode y Pi.

Dos promesas: tu agente **nunca se detiene para administrar su contexto** (sin pausas de compaction, sin flujo roto) y **nunca olvida**.

Ejecuta una sesión por proyecto y mantenla durante semanas, meses o años. Recordará todo lo que construyeron juntos.

---

## Inicio rápido

Ejecuta el asistente interactivo de configuración. Detecta tus modelos, configura todo y maneja la compatibilidad.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**O ejecútalo directamente (cualquier OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

El asistente detecta automáticamente qué harnesses tienes (OpenCode, Pi o ambos), agrega el plugin, desactiva la compaction integrada, te ayuda a elegir modelos para historian y dreamer, y resuelve conflictos con otros plugins de gestión de contexto. Apunta a un harness específico con `--harness opencode` o `--harness pi`.

> **¿Por qué desactivar la compaction integrada?** Magic Context administra el contexto por sí mismo. La compaction del host interferiría con sus operaciones diferidas conscientes de la caché y comprimiría dos veces.

**Configuración manual** (OpenCode): agrega el plugin y apaga la compaction en `opencode.json`, luego coloca un `magic-context.jsonc` en `<project>/.cortexkit/` (o en `~/.config/cortexkit/` para valores predeterminados de usuario). Consulta la [referencia de configuración](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (requiere Pi `>= 0.74.0`). La extensión de Pi comparte la misma base de datos que OpenCode; las memorias del proyecto y los embeddings se agrupan entre ambos.

**Solución de problemas:** `npx @cortexkit/magic-context@latest doctor` detecta automáticamente tus harnesses, revisa conflictos (compaction, OMO hooks, DCP), verifica el plugin y la barra lateral TUI, ejecuta una comprobación de integridad en la base de datos y arregla lo que puede. Agrega `--issue` para generar un informe de bug listo para enviar.

Funciona igual en un proyecto nuevo o de larga duración: instala, reinicia el harness, y Magic Context captura contexto desde ese momento. No rellena sesiones de OpenCode o Pi anteriores a su instalación.

<details>
<summary><strong>Compatibilidad con otros plugins de gestión de contexto</strong></summary>

<br>

Magic Context posee la gestión de contexto de principio a fin, así que **se desactiva** si otro plugin ya hace ese trabajo. Ejecutar dos gestores de contexto a la vez comprimiría dos veces tu historial y sacudiría la caché del prompt. Al iniciar revisa lo siguiente; setup y `doctor` te ayudan a resolver cada punto, y hasta que estén resueltos Magic Context permanece apagado (a prueba de fallos) y te dice por qué:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context la reemplaza. Setup la apaga.
- **DCP** (`opencode-dcp`): un plugin separado de poda de contexto. No pueden ejecutarse juntos; elimínalo de tu lista `plugin`.
- **oh-my-opencode (OMO)**: setup ofrece desactivar los tres hooks que se solapan:
  - `preemptive-compaction`: dispara compaction que entra en conflicto con historian.
  - `context-window-monitor`: inyecta advertencias de uso que se solapan con los avisos de Magic Context.
  - `anthropic-context-window-limit-recovery`: dispara compaction de emergencia que evita historian.

Ejecuta `npx @cortexkit/magic-context@latest doctor` cuando quieras para volver a revisar y corregir automáticamente.

</details>

---

## Parte de CortexKit

Un cerebro no es un solo órgano. Un agente de programación capaz tampoco.

**CortexKit** es una familia de plugins, cada uno modelado a partir de una región distinta del cerebro. Instala uno y tu agente se vuelve más agudo. Instala los tres y tendrá un cerebro.

| Plugin | Región | Qué hace |
|---|---|---|
| **Magic Context** *(estás aquí)* | Hipocampo y lóbulo temporal medial | Contexto autogestionado y memoria de largo plazo. Mantiene las sesiones en marcha sin pausas de compaction mientras forma, consolida y recupera conocimiento del proyecto entre ellas. |
| **[AFT](https://github.com/cortexkit/aft)** | Corteza sensoriomotora | Percibe la estructura del código y actúa sobre ella con precisión. Un IDE y OS adecuados para tu agente. |
| **Alfonso** *(próximamente)* | Corteza prefrontal | Control ejecutivo. Planifica, descompone trabajo, elige agentes y modelos, y decide cuándo preguntar, verificar y hacer commit. |

Magic Context es **1 de los 3 plugins que alguna vez necesitarás.** Recuerda; AFT percibe y actúa; Alfonso decide. Comparten un único almacén CortexKit, así que la memoria se agrupa entre harnesses y herramientas.

---

## ⚡ Gestión del contexto

*Una sesión sin límites que se administra sola.* La ventana de contexto se llena mientras trabajas, y la solución habitual, compaction, detiene al agente en seco para que vuelva a leer todo. Magic Context lo maneja continuamente en segundo plano, así que la sesión simplemente sigue.

- **Compartimentación de historian**: un historian en segundo plano comprime el historial bruto antiguo en **compartimentos por niveles**, resúmenes cronológicos que sustituyen mensajes anteriores. Cada uno tiene una puntuación de importancia, así que la ventana activa se mantiene pequeña sin perder el hilo. Resumir no necesita la fuerza de programación del agente principal, por lo que puedes ejecutar historian en un modelo barato o incluso totalmente local mientras tu agente principal sigue siendo de primer nivel.
- **Renderizado con decaimiento**: los compartimentos se renderizan con la fidelidad adecuada para el momento, mediante una regla determinista sin LLM que se ajusta sola a la ventana de contexto del modelo. El historial antiguo se desvanece con suavidad en lugar de caer por un precipicio, y como es determinista, el mismo historial siempre se renderiza igual.
- **El agente sugiere qué soltar, o no lo hace**: con la reducción dirigida por el agente activada, el agente llama a `ctx_reduce` para marcar salidas de herramientas obsoletas o mensajes largos para eliminarlos. Las eliminaciones se **ponen en cola y respetan la caché**, aplicadas solo en momentos seguros para la caché, de modo que la reducción nunca la sacude. Desactívalo y el agente queda totalmente fuera de la gestión de contexto: la salida obsoleta se descarta automáticamente por antigüedad, con compresión caveman opcional del texto más antiguo.
- **Diseño estable para caché**: todo esto está estructurado para que el trabajo en segundo plano nunca invalide el prefijo en caché de tu prompt. Tu caché sobrevive durante toda la sesión.

El resultado: una sesión se ejecuta durante meses, sin pausas de compaction y con bajo costo en proveedores con precio por caché. Puedes verlo en la TUI de OpenCode, donde una barra lateral en vivo muestra el desglose de contexto por fuente, el estado de historian y los conteos de memoria, actualizándose después de cada mensaje.

> *Opcional (desactivado por defecto):* **caveman text compression** comprime progresivamente el texto más antiguo de usuario y asistente mediante una regla determinista por edades, para sesiones que se ejecutan con la reducción dirigida por el agente desactivada.

---

## 🧠 Captura

*Memoria, gratis.* Para comprimir tu historial, historian tiene que leerlo todo. Así que en la misma pasada extrae el conocimiento que vale la pena conservar para siempre, decisiones, restricciones, convenciones, valores de configuración, y lo promueve a **memoria del proyecto**, categorizada y llevada a cada sesión futura. Tu memoria se construye sola a partir del trabajo que ya estás haciendo.

El agente también puede registrar recuerdos explícitamente, aunque la mayoría se capturan automáticamente para él:

- **`ctx_memory`**: escribe o elimina directamente conocimiento entre sesiones, en una pequeña taxonomía de categorías (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Conciencia temporal** *(activada por defecto)* da al agente sentido del tiempo, con marcadores de intervalo como `+2h 15m` entre mensajes y compartimentos fechados, para que pueda razonar sobre cuánto tiempo pasó. Define `temporal_awareness: false` para desactivarla.

---

## 🌙 Consolidación

*Lo que el sueño hace por la memoria.* Un agente **dreamer** opcional se ejecuta durante la noche para mantener alta la calidad de la memoria, iniciando sesiones hijas efímeras para cada tarea:

- **Verificar**: comprobar incrementalmente recuerdos contra el código actual (rutas, configuraciones, patrones) y corregir o eliminar hechos obsoletos.
- **Curar**: escanear todo el conjunto de memorias para fusionar duplicados, ajustar redacción y archivar entradas de bajo valor o redundantes.
- **Clasificar**: puntuar la importancia, el alcance y la posibilidad segura de compartir cada recuerdo sin perturbar la caché del prompt activo.
- **Mantener documentos**: mantener `ARCHITECTURE.md` y `STRUCTURE.md` actualizados a partir de cambios en el código.
- **Memorias de usuario**: promover observaciones recurrentes sobre cómo trabajas (estilo de comunicación, foco de revisión, patrones de trabajo) a un `<user-profile>` que viaja con cada sesión.
- **Smart notes**: evaluar notas diferidas cuyo `surface_condition` se cumplió y mostrar las que están listas.

Como se ejecuta en tiempo de inactividad, dreamer combina bien con modelos locales, incluso lentos. Nadie está esperando. Dispara una ejecución en cualquier momento con `/ctx-dream`.

---

## 🔎 Recuperación

*El recuerdo correcto en el momento correcto.* En cada turno, las memorias activas del proyecto y el historial de sesión compactado se inyectan automáticamente y de forma estable para la caché. Bajo demanda, el agente recurre a:

- **`ctx_search`**: una consulta en tres capas a la vez: **memories** del proyecto, historial bruto de **conversation** y **git commits** indexados. Embeddings semánticos con respaldo de texto completo.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: recuperar un rango de historial comprimido al transcript original `U:`/`A:` cuando el agente necesita detalles exactos.
- **`ctx_note`**: un bloc para intenciones diferidas. Las notas reaparecen en límites naturales (después de commits, después de ejecuciones de historian, cuando terminan los todos). **Smart notes** llevan una condición abierta que dreamer observa.

La recuperación funciona **entre sesiones** (una sesión nueva hereda todo) y **entre harnesses** (escribe una memoria en OpenCode y recupérala en Pi).

> **Sugerencias de búsqueda automática** *(activadas por defecto)* ejecutan un `ctx_search` en segundo plano cada turno y susurran un "recuerdo vago" cuando existe algo relevante, como casi recordar una nota que tomaste. Solo agrega fragmentos compactos, nunca contenido completo; define `memory.auto_search.enabled: false` para desactivarlo. **Indexación de git commits** *(opcional)* hace que el historial del proyecto sea semánticamente buscable como una cuarta fuente de `ctx_search`, habilítala con `memory.git_commit_indexing.enabled: true`.

### Herramientas del agente de un vistazo

| Herramienta | Sección | Qué hace |
|------|-------|-------------|
| `ctx_reduce` | Contexto | Poner en cola contenido etiquetado obsoleto para eliminarlo, consciente de la caché |
| `ctx_memory` | Captura | Escribir o eliminar memorias duraderas entre sesiones |
| `ctx_search` | Recuperación | Buscar en memorias, historial de conversación y git commits |
| `ctx_expand` | Recuperación | Descomprimir un rango de historial de vuelta al transcript |
| `ctx_note` | Recuperación | Intenciones diferidas y smart notes evaluadas por dreamer |

---

## Comandos

| Comando | Descripción |
|---------|-------------|
| `/ctx-status` | Vista de depuración: tags, pending drops, TTL de caché, estado de nudge, progreso de historian, cobertura de compartimentos, presupuesto de historial |
| `/ctx-flush` | Forzar inmediatamente todas las operaciones en cola, omitiendo el TTL de caché |
| `/ctx-recomp` | Reconstruir compartimentos desde historial bruto (acepta un rango `start-end`). Úsalo cuando el estado guardado parezca incorrecto |
| `/ctx-dream` | Ejecutar mantenimiento de dreamer bajo demanda: mantener memoria, documentos, smart notes y revisión de user-profile |

---

## Aplicación de escritorio

Una aplicación de escritorio complementaria para explorar y administrar el estado de Magic Context fuera de la terminal.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Explorador de memoria**: busca, filtra y edita memorias de proyecto por categoría y proyecto.
- **Historial de sesión**: explora compartimentos y notas de cualquier sesión con navegación por línea de tiempo.
- **Diagnóstico de caché**: línea de tiempo en tiempo real de aciertos/fallos de caché y detección de causas de bust.
- **Gestión de dreamer**: ve historial de dream-run, dispara ejecuciones e inspecciona resultados de tareas.
- **Editor de configuración**: edición basada en formularios para cada ajuste, incluidas cadenas de fallback de modelos.
- **Visor de logs**: seguimiento en vivo de logs con búsqueda.

Lee directamente la base de datos SQLite de Magic Context. Sin servidor adicional, sin API. Autoactualizaciones integradas.

---

## Configuración

Los ajustes viven en `magic-context.jsonc`. Todo tiene valores predeterminados razonables; la configuración del proyecto se combina encima de los ajustes de usuario. Para la referencia completa, ajuste de TTL de caché, umbrales de execute por modelo, selección de modelos de historian y dreamer, proveedores de embeddings y ajustes de memoria, consulta **[CONFIGURATION.md](./CONFIGURATION.md)** o la **[referencia de configuración en docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**Ubicaciones de configuración** (una ubicación compartida de CortexKit, el proyecto sobrescribe al usuario):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

¿Actualizas desde una versión anterior? Tu configuración existente se mueve aquí automáticamente en la primera ejecución (queda una miga `.MOVED_READPLEASE` en la ruta anterior).

---

## Almacenamiento

Todo el estado duradero vive en una base de datos SQLite local bajo el almacén compartido de CortexKit (`~/.local/share/cortexkit/magic-context/context.db`, equivalente XDG en Windows; las bases de datos heredadas de carpetas OpenCode se migran al iniciar por primera vez). Si la base de datos no puede abrirse, Magic Context se desactiva y te avisa. Las memorias se asocian a una **identidad estable del proyecto** derivada del repo, así que siguen a un proyecto entre worktrees, clones y forks en lugar de atarse a una ruta de directorio.

Magic Context también escribe en algunas otras ubicaciones:

| Ruta | Qué | Persistencia |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | Base de datos SQLite, tags, compartimentos, memorias y todo el estado duradero (equivalente XDG en Windows) | **Debe persistir.** Perderla implica perder tu memoria/historial. |
| `~/.local/share/cortexkit/magic-context/models/` | Caché local del modelo de embeddings (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), descargado en el primer uso cuando los embeddings locales están habilitados | Debería persistir, o se volverá a descargar en cada ejecución. No se usa cuando `memory.enabled: false` o se configura un backend de embeddings `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Log de diagnóstico | Desechable. |

**Entornos con sandbox / efímeros (Docker, CI, contenedores desechables):** monta el directorio `~/.local/share/cortexkit/magic-context/` en un volumen persistente para que la base de datos y la caché del modelo sobrevivan entre ejecuciones. Si solo la caché del modelo es efímera, el modelo simplemente se descarga de nuevo; si la base de datos es efímera, la memoria y el historial no se acumulan. Para evitar por completo la descarga del modelo de ~90 MB, define `memory.enabled: false` o apunta `embedding` a un backend remoto `openai_compatible`/`ollama`.

---

## Historial de estrellas

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Desarrollo

**Requisitos:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

La ejecución de Dream requiere un servidor OpenCode activo (dreamer crea sesiones hijas efímeras). Usa `/ctx-dream` dentro de OpenCode para mantenimiento bajo demanda.

---

## Contribución

Se agradecen informes de bugs y pull requests. Para cambios más grandes, abre primero un issue para discutir el enfoque. Ejecuta `bun run format` antes de enviar; CI rechaza código sin formato.

---

## Licencia

[MIT](LICENSE)
