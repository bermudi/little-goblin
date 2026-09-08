import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log.ts";

interface Options {
  command?: readonly [string, ...string[]];
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}
interface Variant {
  id: string;
  label: string;
  contextTokens?: number;
  outputTokens?: number;
  costSummary?: string;
  costTier?: string;
  description?: string;
  isNew: boolean;
  isBeta: boolean;
}
interface Catalog {
  families: { id: string; slug: string; label: string; aliases: string[]; variants: Variant[] }[];
}
interface CatalogModule {
  discoverDevinCatalog(options?: Options): Promise<Catalog>;
}
// Dynamic loading lets the verifier-only commit typecheck before implementation.
const modulePath = "./devin-catalog.ts";
async function discover(options?: Options): Promise<Catalog> {
  const loaded: unknown = await import(modulePath);
  return (loaded as CatalogModule).discoverDevinCatalog(options);
}

let root: string;
let fixture: string;
const family = {
  family_uid: "test-family", slug: "test-family", family_label: "Test family", aliases: ["test-alias"],
  variants: [{ model_uid: "test-model", label: "Test variant", max_context_tokens: 200000,
    max_output_tokens: 8192, cost_tier: "Test cost", cost_summary: "Reported cost", is_new: true, is_beta: false }],
};
let counter = 0;
function command(mode: string, payload = ""): readonly [string, ...string[]] {
  const input = join(root, `input-${counter++}.json`);
  writeFileSync(input, payload, { flag: "wx" });
  return [process.execPath, fixture, mode, input];
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "goblin-catalog-test-"));
  fixture = join(root, "cli.ts");
  writeFileSync(fixture, `
import { readFileSync, writeFileSync } from 'node:fs';
const [mode, input, ...args] = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['models', 'list', '--format', 'json'])) process.exit(90);
if (mode === 'output') process.stdout.write(readFileSync(input, 'utf8'));
else if (mode === 'exit') { process.stderr.write('RAW_OUTPUT_SENTINEL'); process.exit(7); }
else if (mode === 'large') process.stdout.write('x'.repeat(100000));
else if (mode === 'large-stderr') process.stderr.write('x'.repeat(100000));
else if (mode === 'wait') { writeFileSync(input + '.pid', String(process.pid)); setInterval(() => {}, 100); }
else if (mode === 'env') {
  const keys = Object.keys(process.env);
  if (keys.some(k => k.endsWith('_API_KEY') || k === 'BOT_TOKEN' || k === 'GOBLIN_SETTINGS_TEST_SECRET')) process.exit(91);
  process.stdout.write(readFileSync(input, 'utf8'));
} else process.exit(92);
`, { flag: "wx" });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => { info.mockRestore(); warn.mockRestore(); });
let info = spyOn(log, "info");
let warn = spyOn(log, "warn");
function captureLogs(): void {
  info = spyOn(log, "info");
  warn = spyOn(log, "warn");
}
function pidIsGone(path: string): boolean {
  const pid = Number(readFileSync(path, "utf8"));
  try { process.kill(pid, 0); return false; }
  catch (error: unknown) { return error instanceof Error && "code" in error && error.code === "ESRCH"; }
}
async function waitForPid(path: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try { readFileSync(path); return; }
    catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(5);
  }
  throw new Error("fixture child did not start");
}

describe("Live Devin catalog with bounded discovery", () => {
  it("live process returns searchable families and exact variants", async () => {
    captureLogs();
    const result = await discover({ command: command("output", JSON.stringify({ families: [family], ignored: "private" })) });
    expect(result).toEqual({ families: [{ id: "test-family", slug: "test-family", label: "Test family", aliases: ["test-alias"],
      variants: [{ id: "test-model", label: "Test variant", contextTokens: 200000, outputTokens: 8192,
        costTier: "Test cost", costSummary: "Reported cost", isNew: true, isBeta: false }] }] });
    expect(info.mock.calls.map(c => c[0])).toEqual(["Devin catalog discovery started", "Devin catalog discovery completed"]);
  });

  it("absent optional model metadata stays absent", async () => {
    const minimal = { ...family, variants: [{ model_uid: "test-adaptive", label: "Test adaptive", description: "Provider description", is_new: false, is_beta: true }] };
    const result = await discover({ command: command("output", JSON.stringify({ families: [minimal] })) });
    expect(result.families[0]?.variants[0]).toEqual({ id: "test-adaptive", label: "Test adaptive", description: "Provider description", isNew: false, isBeta: true });
  });

  it("malformed empty and duplicate catalogs are rejected", async () => {
    const values = ["not json", "null", "{}", '{"families":[]}',
      JSON.stringify({ families: [{ ...family, variants: [] }] }),
      JSON.stringify({ families: [family, family] }),
      JSON.stringify({ families: [family, { ...family, family_uid: "other", slug: "other" }] }),
      JSON.stringify({ families: [{ ...family, variants: [family.variants[0], family.variants[0]] }] }),
      JSON.stringify({ families: [{ ...family, family_uid: " " }] }),
      JSON.stringify({ families: [{ ...family, variants: [{ ...family.variants[0], max_context_tokens: -1 }] }] }),
    ];
    for (const payload of values) {
      await expect(discover({ command: command("output", payload) })).rejects.toMatchObject({ reason: "invalid-catalog" });
    }
  });

  it("process failures are classified and bounded", async () => {
    await expect(discover({ command: [join(root, "missing")] })).rejects.toMatchObject({ reason: "unavailable" });
    await expect(discover({ command: [root] })).rejects.toMatchObject({ reason: "process-failed" });
    await expect(discover({ command: command("exit") })).rejects.toMatchObject({ reason: "process-failed", exitCode: 7 });
    await expect(discover({ command: command("large"), maxBufferBytes: 128 })).rejects.toMatchObject({ reason: "output-limit" });
    await expect(discover({ command: command("large-stderr"), maxBufferBytes: 128 })).rejects.toMatchObject({ reason: "output-limit" });
    await expect(discover({ timeoutMs: 0 })).rejects.toMatchObject({ reason: "invalid-options" });
    await expect(discover({ maxBufferBytes: 3_000_000 })).rejects.toMatchObject({ reason: "invalid-options" });
  });

  it("timeout and cancellation terminate discovery children", async () => {
    const timed = command("wait");
    await expect(discover({ command: timed, timeoutMs: 500 })).rejects.toMatchObject({ reason: "timeout" });
    expect(pidIsGone(`${timed[3]}.pid`)).toBe(true);
    const controller = new AbortController();
    const cancelled = command("wait");
    const pending = discover({ command: cancelled, signal: controller.signal }).then(() => null, (error: unknown) => error);
    await waitForPid(`${cancelled[3]}.pid`);
    controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled" });
    expect(pidIsGone(`${cancelled[3]}.pid`)).toBe(true);
    await expect(discover({ command: [join(root, "not-spawned")], signal: AbortSignal.abort() })).rejects.toMatchObject({ reason: "cancelled" });
  });

  it("allowlist environment and independent cancellation", async () => {
    const previous = process.env.GOBLIN_SETTINGS_TEST_SECRET;
    process.env.GOBLIN_SETTINGS_TEST_SECRET = "synthetic-test-value";
    try {
      const controller = new AbortController();
      const waiting = command("wait");
      const pending = discover({ command: waiting, signal: controller.signal }).then(() => null, (error: unknown) => error);
      await waitForPid(`${waiting[3]}.pid`);
      const success = discover({ command: command("env", JSON.stringify({ families: [family] })) });
      controller.abort();
      expect(await pending).toMatchObject({ reason: "cancelled" });
      expect((await success).families).toHaveLength(1);
      expect(pidIsGone(`${waiting[3]}.pid`)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GOBLIN_SETTINGS_TEST_SECRET;
      else process.env.GOBLIN_SETTINGS_TEST_SECRET = previous;
    }
  });

  it("discovery signals never contain raw output", async () => {
    captureLogs();
    for (const args of [command("exit"), command("output", "RAW_OUTPUT_SENTINEL")]) {
      const error: unknown = await discover({ command: args }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("RAW_OUTPUT_SENTINEL");
    }
    expect(warn.mock.calls).toHaveLength(2);
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain("RAW_OUTPUT_SENTINEL");
  });
});
