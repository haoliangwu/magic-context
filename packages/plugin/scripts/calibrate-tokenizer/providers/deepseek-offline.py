"""Count public calibration probes with a local Hugging Face tokenizer only."""
import json
import sys

try:
    from transformers import AutoTokenizer
except ImportError:
    print(json.dumps({"skip": "transformers is not installed; use an isolated environment: python3 -m venv .venv && .venv/bin/python -m pip install transformers tokenizers; then set DEEPSEEK_TOKENIZER_PYTHON=.venv/bin/python"}))
    sys.exit(0)

try:
    tokenizer = AutoTokenizer.from_pretrained(
        sys.argv[1], trust_remote_code=True, local_files_only=True
    )
    probes = json.load(sys.stdin)
    counts = {
        name: len(tokenizer.encode(text, add_special_tokens=False))
        for name, text in probes.items()
    }
    print(json.dumps({"counts": counts}))
except Exception as error:
    # Do not emit tokenizer configuration, probe text, or arbitrary library output.
    print(json.dumps({"skip": f"offline tokenizer failed ({type(error).__name__})"}))
