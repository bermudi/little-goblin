import { mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedSkillSet } from "../../agent/skills/mod.ts";
import type { Config } from "../../config.ts";
import type { ActiveScope, CapturedMemoryContext, SurfaceMemoryAuthority } from "../../memory/mod.ts";
import { piAgentDir } from "../../pi-host.ts";
import { workspacePath } from "../../workspace/paths.ts";
import { personalEnvironment } from "../../sessions/environment.ts";
import { dmSurface, supergroupSurface, surfaceId, type Surface } from "../../surface.ts";
import type { GenericSubagentInheritance } from "../types.ts";

const EMPTY_RESOLVED_SKILL_SET: ResolvedSkillSet = {
  skills: [],
  diagnostics: [],
  fingerprint: "test-empty",
};

/** Empty inherited authority for generic calls that don't exercise skills. */
export const EMPTY_GENERIC_SUBAGENT_INHERITANCE: GenericSubagentInheritance = {
  executionEnvironment: personalEnvironment(),
  resolvedSkills: EMPTY_RESOLVED_SKILL_SET,
};

/** Default active scope for tests that don't need a specific topic/agent scope. */
export const DEFAULT_SCOPE: ActiveScope = {
  chatId: -100123,
  topicScope: "general",
};

/** Default Telegram Surface backing the default active scope. */
export const DEFAULT_SURFACE: Surface = supergroupSurface(-100123);

/** Default Surface memory authority for tests. */
export const DEFAULT_AUTHORITY: SurfaceMemoryAuthority = {
  kind: "surface",
  sourceSurfaceId: surfaceId(DEFAULT_SURFACE),
  activeScope: DEFAULT_SCOPE,
};

/** Default parent capture for revive tests (empty bodies are ignored; the child re-captures). */
export const DEFAULT_PARENT_CAPTURE: CapturedMemoryContext = {
  kind: "surface",
  authority: DEFAULT_AUTHORITY,
  caller: { kind: "anonymous-subagent" },
  frozenSummary: null,
  frozenUserBody: "",
  frozenActiveMemoryBody: "",
};

/** A second active scope used to simulate the parent moving to a different Surface. */
export const OTHER_SCOPE: ActiveScope = {
  chatId: 456,
  topicScope: "general",
};

/** A second Surface and authority representing the moved parent. */
export const OTHER_SURFACE: Surface = dmSurface(456);

export const OTHER_AUTHORITY: SurfaceMemoryAuthority = {
  kind: "surface",
  sourceSurfaceId: surfaceId(OTHER_SURFACE),
  activeScope: OTHER_SCOPE,
};

export const OTHER_PARENT_CAPTURE: CapturedMemoryContext = {
  kind: "surface",
  authority: OTHER_AUTHORITY,
  caller: { kind: "main" },
  frozenSummary: null,
  frozenUserBody: "",
  frozenActiveMemoryBody: "",
};

type Listener = (event: Record<string, unknown>) => void;

const capturedCreateArgs: unknown[] = [];
let loadedSkillPathsOverride: readonly string[] | null = null;

export function setLoadedSkillPathsOverride(paths: readonly string[] | null): void {
  loadedSkillPathsOverride = paths;
}

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
  loadedSkillPathsOverride = null;
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

      getSkills(): { skills: Array<{ filePath: string }>; diagnostics: [] } {
        const paths = loadedSkillPathsOverride ?? (this.options.additionalSkillPaths ?? []) as string[];
        return {
          skills: paths.map((filePath) => ({ filePath })),
          diagnostics: [],
        };
      }
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
  mkdirSync(workspacePath(home), { recursive: true });
  mkdirSync(piAgentDir(home), { recursive: true });
  return home;
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
