import { mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import type { ActiveScope } from "../../memory/mod.ts";
import { piAgentDir } from "../../pi-host.ts";
import { workdirPath } from "../../workspace/paths.ts";

/** Default active scope for tests that don't need a specific topic/agent scope. */
export const DEFAULT_SCOPE: ActiveScope = {
  chatId: -100123,
  topicScope: "general",
  namedAgent: null,
};

type Listener = (event: Record<string, unknown>) => void;

const capturedCreateArgs: unknown[] = [];

export const sessionHolder = {
  listeners: [] as Listener[],
  sendCustomMessage: mock(async (_msg: unknown, _opts?: unknown) => {}),
  sendUserMessage: mock(async (_text: string) => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),

  reset(): void {
    this.listeners = [];
    this.sendCustomMessage = mock(async (_msg: unknown, _opts?: unknown) => {});
    this.sendUserMessage = mock(async (_text: string) => {});
    this.abort = mock(async () => {});
    this.dispose = mock(() => {});
  },

  emit(event: Record<string, unknown>): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  },

  get proxy() {
    const holder = this;
    return {
      subscribe(listener: Listener) {
        holder.listeners.push(listener);
        return () => {
          const index = holder.listeners.indexOf(listener);
          if (index !== -1) {
            holder.listeners.splice(index, 1);
          }
        };
      },
      sendCustomMessage: (msg: unknown, opts?: unknown) => holder.sendCustomMessage(msg, opts),
      sendUserMessage: (text: string) => holder.sendUserMessage(text),
      abort: () => holder.abort(),
      dispose: () => holder.dispose(),
    };
  },
};

export function clearCapturedCreateArgs(): void {
  capturedCreateArgs.length = 0;
}

export function getCapturedCreateArgs(): readonly unknown[] {
  return capturedCreateArgs;
}

export function resetPiMockState(): void {
  clearCapturedCreateArgs();
  sessionHolder.reset();
}

export function standardPiMock() {
  return {
    defineTool: <T>(definition: T) => definition,
    ModelRuntime: {
      create: async (_opts?: unknown) => ({
        setRuntimeApiKey: async (_provider: string, _key: string) => {},
      }),
    },
    SettingsManager: {
      inMemory: (_obj: unknown) => ({}),
    },
    SessionManager: {
      inMemory: (_cwd: string) => ({ __stub: true } as unknown),
      create: (_cwd: string, dir: string) => {
        mkdirSync(dir, { recursive: true });
        return { __stub: true } as unknown;
      },
      open: (path: string, _sessionDir?: string, _cwdOverride?: string) => {
        return { __stub: true, __openedFrom: path } as unknown;
      },
    },
    DefaultResourceLoader: class {
      public readonly options: Record<string, unknown>;

      constructor(options: Record<string, unknown>) {
        this.options = options;
      }

      async reload(): Promise<void> {}
    },
    createAgentSession: async (opts: unknown) => {
      capturedCreateArgs.push(opts);
      return { session: sessionHolder.proxy, extensionsResult: {} };
    },
  };
}

export function installStandardPiMock(): void {
  mock.module("@earendil-works/pi-coding-agent", () => standardPiMock());
}

export function makeConfig(home: string): Config {
  return Object.freeze({
    botToken: "test-token",
    allowedTgUserIds: new Set<number>([1]),
    modelName: "poe/test-model",
    poeApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "none",
  }) as Config;
}

export function createTestHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(workdirPath(home), { recursive: true });
  mkdirSync(piAgentDir(home), { recursive: true });
  return home;
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
