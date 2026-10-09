# Vendored Broca wire goldens

Byte-identical copies of Broca's `session.send` request goldens. Magic Context's
historian and dreamer producers build these requests by hand (they do not link Broca's
crates), so `historian_producer.rs` compares its serialized send against these files.

| File | Broca source | Broca commit |
|---|---|---|
| `send_request.model_variant_queue.json` | `crates/broca-wire/tests/golden/send_request.model_variant_queue.json` | `f06a487a93d6b6a22a0008bea8d3fb4a036158ac` |
| `send_request.model_variant_steer.json` | `crates/broca-wire/tests/golden/send_request.model_variant_steer.json` | `f06a487a93d6b6a22a0008bea8d3fb4a036158ac` |

The files have no trailing newline, as in Broca. Do not reformat them: the test compares
bytes. To refresh, copy the files from the Broca repository unchanged and update the
commit above.
