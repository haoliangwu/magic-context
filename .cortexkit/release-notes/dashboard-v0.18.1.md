## Dashboard v0.18.1

Fixes for the Cache tab and for converted OpenCode 2 stores. Works with Magic Context 0.44.x.

### Converted OpenCode stores show every session (#559)
An OpenCode store converted from 1 to 2 keeps older sessions in OpenCode 1's tables and adds new ones to `session_v2`. The dashboard read only one of them, so newer OpenCode 2 sessions were missing, or older ones were. It now reads both and merges them by session: a session present in both is shown from its OpenCode 2 record, and its messages and cache history are read from there.

### Running Broca sessions show their steps
Broca stamps a session's time only when a run starts and when it ends, so the Cache tab saw no change during a run and a gather session stayed at "0 events" until it finished. The tab now dates a running Broca session by its live log file, so steps appear while the run is going.

### Cache cards keep one height
A card whose provider reported no cached tokens showed "No cached tokens reported" in the figure slot, which wrapped and made that card taller than the others. The slot now shows a grey dash, with "cache not reported" in small text below it, and every card keeps the same height.

### Fewer false cache warnings on OpenAI
For providers that don't report cache writes, the tab estimated the cache it expected from the previous turn's input plus its output. Output isn't re-read from the cache on the next turn, so healthy turns often showed as warnings. The estimate now uses the previous turn's input only.
