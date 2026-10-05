# Gemma 4 31B: light prompt behavior

Route: `ollama-cloud/gemma4:31b` (request model `gemma4:31b`)

The light preset received three probes covering early stamping without narration, archive search before asking, and titled note creation.

## stamp

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "stamp",
  "content": "",
  "toolCalls": [
    {
      "id": "call_o9gcpzts",
      "function": {
        "index": 0,
        "name": "ctx_reduce",
        "arguments": {
          "drop": "102,103,105"
        }
      }
    }
  ],
  "checks": {
    "stampsEarly": true,
    "doesNotNarrate": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1240,
    "completionTokens": 25
  }
}
```

## search

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "search",
  "content": "",
  "toolCalls": [
    {
      "id": "call_r4p339by",
      "function": {
        "index": 0,
        "name": "ctx_search",
        "arguments": {
          "query": "why did we choose SQLite over postgres?"
        }
      }
    }
  ],
  "checks": {
    "searchesBeforeAsking": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1127,
    "completionTokens": 22
  }
}
```

## note

Result: **PASS**

```json
{
  "model": "ollama-cloud/gemma4:31b",
  "requestedModel": "gemma4:31b",
  "preset": "light",
  "probe": "note",
  "content": "",
  "toolCalls": [
    {
      "id": "call_twzil2sg",
      "function": {
        "index": 0,
        "name": "ctx_note",
        "arguments": {
          "action": "write",
          "content": "Revisit cache invalidation benchmark after v1.0\nThe current run is noisy on CI; need to compare it with the local baseline."
        }
      }
    }
  ],
  "checks": {
    "notesWithTitle": true
  },
  "passed": true,
  "usage": {
    "promptTokens": 1189,
    "completionTokens": 49
  }
}
```
