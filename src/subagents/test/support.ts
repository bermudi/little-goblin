import { mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";

type Listener = (event: Record<string, unknown>) => void;

const capturedCreateArgs: unknown[] = [];

export const sessionHolder = {
  listeners: [] as Listener[],
  sendUserMessage: mock(async (_text: string) => {}),
  abort: mock(async () => {}),
  dispose: mock(() => {}),

  reset(): void {
    this.listeners = [];
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
    AuthStorage: {
      create: (_path: string) => ({
        setRuntimeApiKey: (_provider: string, _key: string) => {},
      }),
    },
    ModelRegistry: {
      create: (_auth: unknown, _path: string) => ({}),
    },
    SettingsManager: {
      inMemory: (_obj: unknown) => ({}),
    },
    SessionManager: {
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
  mock.module("@mariozechner/pi-coding-agent", () => standardPiMock());
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
  mkdirSync(join(home, "workdir"), { recursive: true });
  mkdirSync(join(home, "pi-agent"), { recursive: true });
  return home;
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
