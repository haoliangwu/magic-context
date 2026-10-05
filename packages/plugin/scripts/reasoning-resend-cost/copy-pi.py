"""Copy recent Pi transcripts only. OpenCode acquisition is narrow, read-only SQL
in analyze.ts; never create a whole-store snapshot on the shared disk.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import time


def main():
    os.umask(0o077)
    root = Path(os.environ.get("TMPDIR", "/tmp")) / "magic-context/reasoning-diff"
    root.mkdir(parents=True, exist_ok=False)
    sessions = Path.home() / ".pi/agent/sessions"
    files = list(sessions.glob("*/*.jsonl"))
    selected = [p for p in files if p.stat().st_mtime >= time.time() - 7 * 86400]
    size = sum(p.stat().st_size for p in selected)
    if size > 2_000_000_000:
        raise RuntimeError(f"Refusing {size} bytes of Pi copies; narrow the selection first")
    (root / "pi").mkdir()
    for path in selected:
        destination = root / "pi" / path.relative_to(sessions)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    (root / "pi-inventory.json").write_text(json.dumps({
        "copiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "filesInventoried": len(files), "filesCopied": len(selected), "bytesCopied": size,
        "selection": "mtime within seven days of acquisition; entry timestamps filtered in analysis",
        "files": [str(p.relative_to(sessions)) for p in selected],
    }, indent=2))
    print(f"Python {sys.version.split()[0]}: copied {len(selected)} of {len(files)} Pi files ({size} bytes)")


if __name__ == "__main__":
    main()
