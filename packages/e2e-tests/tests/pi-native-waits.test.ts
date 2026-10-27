import { expect, test } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

// The holder must live outside Pi so native SQLite waiting cannot delay release.
test("real Pi turns under a writer lock replay managed bytes or refuse within 25 seconds", async () => {
  const h = await PiTestHarness.create({ host: "pi" });
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await h.sendPrompt("Warm the managed request before writer contention.");
    await h.waitForMockQuiescence();
    const before = h.requests().length;
    holder = Bun.spawn(["python3", "-u", "-c", `
import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1])
c.execute('BEGIN IMMEDIATE')
print('HELD', flush=True)
time.sleep(32)
c.commit()
`, h.contextDbPath()], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("HELD");
    const marker = "writer-locked-turn-770";
    const start = performance.now();
    const result = await h.sendPrompt(marker, { timeoutMs: 26_000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(25_500);
    const requests = h.requests().slice(before);
    if (requests.length) {
      const serialized = JSON.stringify(requests);
      expect(serialized).toContain(marker);
      expect(serialized).toContain("§");
    } else {
      expect(result.stdout + result.stderr + JSON.stringify(await h.getMessages())).toMatch(/Magic Context.*(not safely prepare|storage is busy)/);
    }
    console.log(`real Pi held-writer: elapsed_ms=${Math.round(elapsed)} requests=${requests.length} outcome=${requests.length ? "managed replay" : "refusal"}`);
  } finally {
    if (holder) { holder.kill(); await holder.exited; }
    await h.dispose();
  }
}, 90_000);
