import { describe, it, expect } from "bun:test";
import { defaultProcessHost } from "./process.ts";

describe("ProcessHostImpl", () => {
  it("spawns a command and reads stdout lines", async () => {
    const processHost = defaultProcessHost();
    const handle = await processHost.spawn({ command: ["cat"] });

    handle.stdin.write("hello\n", "utf-8", () => {
      handle.stdin.end();
    });

    const lines: string[] = [];
    for await (const line of handle.readLines()) {
      lines.push(line);
    }

    expect(lines).toContain("hello");
    const exit = await handle.waitForExit();
    expect(exit.exitCode).toBe(0);
  });

  it("kills a running process", async () => {
    const processHost = defaultProcessHost();
    const handle = await processHost.spawn({ command: ["sleep", "10"] });

    const exitPromise = handle.waitForExit();
    await handle.kill();

    const exit = await exitPromise;
    expect(exit.signal).toBe("SIGTERM");
  });
});
