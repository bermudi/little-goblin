import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { genericSubagentMetaPath } from "../paths.ts";
import { SubagentRunner } from "../mod.ts";
import type { SubagentMeta } from "../types.ts";
import {
  createTestHome,
  DEFAULT_SCOPE,
  flush,
  installStandardPiMock,
  makeConfig,
  resetPiMockState,
  sessionHolder,
} from "./support.ts";
import { mock } from "bun:test";

describe("SubagentRunner — cancel guards", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-cancel-guards-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    installStandardPiMock();
  });

  it("cancel before session init (race): runAgent checks status after creating session", async () => {
    let resolveCreate!: () => void;
    const createBlocked = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });

    mock.module("@earendil-works/pi-coding-agent", () => ({
      defineTool: <T>(definition: T) => definition,
      AuthStorage: { create: () => ({ setRuntimeApiKey: () => {} }) },
      ModelRegistry: { create: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      SessionManager: {
        create: (_cwd: string, dir: string) => {
          mkdirSync(dir, { recursive: true });
          return { __stub: true };
        },
        open: () => ({ __stub: true }),
      },
      DefaultResourceLoader: class {
        options: Record<string, unknown>;

        constructor(options: Record<string, unknown>) {
          this.options = options;
        }

        async reload(): Promise<void> {}
      },
      createAgentSession: async (opts: unknown) => {
        void opts;
        await createBlocked;
        return { session: sessionHolder.proxy, extensionsResult: {} };
      },
    }));

    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    await runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("cancelled");

    resolveCreate();
    await flush();
    await flush();

    expect(sessionHolder.sendUserMessage).not.toHaveBeenCalled();
  });

  it("cancel on completed subagent is a no-op (doesn't overwrite status)", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.emit({ type: "agent_end", messages: [] });
    await handle.result;
    expect(runner.list()[0]?.status).toBe("completed");

    await runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("completed");
    expect(sessionHolder.abort).not.toHaveBeenCalled();
  });

  it("cancel on errored subagent is a no-op", async () => {
    sessionHolder.sendUserMessage = mock(async () => {
      throw new Error("boom");
    });
    const handle = await runner.spawn({ prompt: "trigger", activeScope: DEFAULT_SCOPE });
    await flush();
    await flush();
    await expect(handle.result).rejects.toThrow("boom");

    expect(runner.list()[0]?.status).toBe("error");
    await runner.cancel(handle.id);
    expect(runner.list()[0]?.status).toBe("error");
  });
});

describe("SubagentRunner — startup error handling", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-subagent-startup-err-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    installStandardPiMock();
  });

  it("marks meta as error when createAgentSession throws", async () => {
    mock.module("@earendil-works/pi-coding-agent", () => ({
      defineTool: <T>(definition: T) => definition,
      AuthStorage: { create: () => ({ setRuntimeApiKey: () => {} }) },
      ModelRegistry: { create: () => ({}) },
      SettingsManager: { inMemory: () => ({}) },
      SessionManager: {
        create: (_cwd: string, dir: string) => {
          mkdirSync(dir, { recursive: true });
          return { __stub: true };
        },
        open: () => ({ __stub: true }),
      },
      DefaultResourceLoader: class {
        options: Record<string, unknown>;

        constructor(options: Record<string, unknown>) {
          this.options = options;
        }

        async reload(): Promise<void> {}
      },
      createAgentSession: async () => {
        throw new Error("session-creation-failed");
      },
    }));

    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();
    await flush();

    await expect(handle.result).rejects.toThrow("session-creation-failed");

    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("error");
    expect(meta.errorMessage).toBe("session-creation-failed");
  });
});

describe("SubagentRunner — double-cancel race guard", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-race-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("second cancel is a no-op when first cancels synchronously", async () => {
    const handle = await runner.spawn({ prompt: "work", activeScope: DEFAULT_SCOPE });
    await flush();

    await Promise.all([runner.cancel(handle.id), runner.cancel(handle.id)]);

    expect(sessionHolder.abort).toHaveBeenCalledTimes(1);
    expect(runner.list()[0]?.status).toBe("cancelled");
  });
});

describe("SubagentRunner — cancel vs agent_end race", () => {
  let tmp: string;
  let runner: SubagentRunner;

  beforeEach(() => {
    tmp = createTestHome("goblin-cancel-race-");
    runner = new SubagentRunner(makeConfig(tmp));
    resetPiMockState();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("agent_end arriving during cancel() does not overwrite cancelled status", async () => {
    const handle = await runner.spawn({ prompt: "test", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.abort = mock(async () => {
      sessionHolder.emit({ type: "agent_end", messages: [] });
    });

    await runner.cancel(handle.id);

    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
    const meta = JSON.parse(
      readFileSync(genericSubagentMetaPath(tmp, handle.id), "utf-8"),
    ) as SubagentMeta;
    expect(meta.status).toBe("cancelled");
  });

  it("error event arriving during cancel() does not overwrite cancelled status", async () => {
    const handle = await runner.spawn({ prompt: "test", activeScope: DEFAULT_SCOPE });
    await flush();

    sessionHolder.abort = mock(async () => {
      sessionHolder.emit({ type: "agent_end", messages: [] });
    });

    await runner.cancel(handle.id);
    expect(runner.list().find((entry) => entry.id === handle.id)?.status).toBe("cancelled");
  });
});
