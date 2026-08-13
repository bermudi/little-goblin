import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedSkillSet } from "../../agent/skills/mod.ts";
import type { Config } from "../../config.ts";
import type { ActiveScope, CapturedMemoryContext, SurfaceMemoryAuthority } from "../../memory/mod.ts";
import {
  delegatedWorkRecordPath,
  delegatedWorkRunDir,
} from "../../delegated-work/paths.ts";
import { piAgentDir } from "../../pi-host.ts";
import { soulMdPath, workspacePath } from "../../workspace/paths.ts";
import { personalEnvironment } from "../../sessions/environment.ts";
import { dmSurface, supergroupSurface, surfaceId, type Surface } from "../../surface.ts";
import type { GenericSubagentInheritance, SubagentHandle } from "../types.ts";
import type { SubagentRunner } from "../mod.ts";
import { FakeSubagentHost } from "./fake-host.ts";

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

export interface TestSessionHolder {
  listeners: Listener[];
  inUse: boolean;
  sendCustomMessage: ReturnType<typeof mock>;
  sendUserMessage: ReturnType<typeof mock>;
  abort: ReturnType<typeof mock>;
  dispose: ReturnType<typeof mock>;
  reset(): void;
  emit(event: Record<string, unknown>): void;
  complete(messages?: readonly unknown[], willRetry?: boolean): void;
  readonly proxy: {
    subscribe(listener: Listener): () => void;
    sendCustomMessage(message: unknown, options?: unknown): Promise<void>;
    sendUserMessage(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
  };
}

const capturedCreateArgs: unknown[] = [];
let loadedSkillPathsOverride: readonly string[] | null = null;
const sessionHolders: TestSessionHolder[] = [];

export function setLoadedSkillPathsOverride(paths: readonly string[] | null): void {
  loadedSkillPathsOverride = paths;
}

function makeSessionHolder(): TestSessionHolder {
  const holder: TestSessionHolder = {
    listeners: [],
    inUse: false,
    sendCustomMessage: mock(async (_msg: unknown, _opts?: unknown) => {}),
    sendUserMessage: mock(async (_text: string) => {}),
    abort: mock(async () => {}),
    dispose: mock(() => {}),

    reset(): void {
      this.listeners = [];
      this.inUse = false;
      this.sendCustomMessage = mock(async (_msg: unknown, _opts?: unknown) => {});
      this.sendUserMessage = mock(async (_text: string) => {});
      this.abort = mock(async () => {});
      this.dispose = mock(() => {});
    },

    emit(event: Record<string, unknown>): void {
      for (const listener of [...this.listeners]) listener(event);
    },

    complete(messages: readonly unknown[] = [], willRetry = false): void {
      this.emit({ type: "agent_end", messages, willRetry });
      if (!willRetry) this.emit({ type: "agent_settled" });
    },

    get proxy() {
      return {
        subscribe(listener: Listener) {
          holder.listeners.push(listener);
          return () => {
            const index = holder.listeners.indexOf(listener);
            if (index !== -1) holder.listeners.splice(index, 1);
          };
        },
        sendCustomMessage: (msg: unknown, opts?: unknown) => holder.sendCustomMessage(msg, opts),
        sendUserMessage: (text: string) => holder.sendUserMessage(text),
        abort: () => holder.abort(),
        dispose: () => {
          try {
            holder.dispose();
          } finally {
            holder.inUse = false;
          }
        },
      };
    },
  };
  return holder;
}

export const sessionHolder = makeSessionHolder();
sessionHolders.push(sessionHolder);

export function getSessionHolder(index: number): TestSessionHolder {
  const holder = sessionHolders[index];
  if (holder === undefined) throw new Error(`No fake session holder at index ${index}`);
  return holder;
}

export function clearCapturedCreateArgs(): void {
  capturedCreateArgs.length = 0;
}

export function getCapturedCreateArgs(): readonly unknown[] {
  return capturedCreateArgs;
}

export function resetPiMockState(): void {
  clearCapturedCreateArgs();
  loadedSkillPathsOverride = null;
  sessionHolders.length = 1;
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
      let holder = sessionHolders.find((candidate) => !candidate.inUse);
      if (holder === undefined) {
        holder = makeSessionHolder();
        sessionHolders.push(holder);
      }
      holder.inUse = true;
      return { session: holder.proxy, extensionsResult: {} };
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
  writeFileSync(soulMdPath(home), "test goblin identity\n", "utf-8");
  mkdirSync(piAgentDir(home), { recursive: true });
  return home;
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

/** Lightweight view of a host-owned delegated-work record for test assertions. */
export interface SubagentRecordView {
  id: string;
  kind: string;
  name: string | null;
  role: "generic" | "named";
  depth: number;
  createdAt: string;
  status: string;
  completedAt: string | null;
  errorMessage: string | undefined;
  ownerConversationId: string | undefined;
  runtimeId: string | undefined;
  lifetime: "attached" | undefined;
  originSurfaceId: string | undefined;
  executionEnvironment: unknown;
  deliveryState: string | undefined;
  invocations: Record<string, unknown>[];
}

function readRecordRaw(home: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(delegatedWorkRecordPath(home, id), "utf-8")) as Record<string, unknown>;
}

function recordLastInvocation(record: Record<string, unknown>): Record<string, unknown> {
  const invocations = record.invocations as unknown[] | undefined;
  if (!Array.isArray(invocations) || invocations.length === 0) {
    throw new Error("record has no invocations");
  }
  const last = invocations.at(-1) as Record<string, unknown> | undefined;
  if (last === undefined) throw new Error("record has no invocations");
  return last;
}

/** Read and derive the canonical test view from a host-owned record. */
export function readRecord(home: string, id: string): SubagentRecordView {
  const record = readRecordRaw(home, id);
  const last = recordLastInvocation(record);
  const invocations = record.invocations as unknown[];
  const outcome = last.outcome as Record<string, unknown> | null;
  const kind = record.kind as string;
  return {
    id: record.id as string,
    kind,
    name: record.name as string | null,
    role: kind === "generic-subagent" ? "generic" : "named",
    depth: record.depth as number,
    createdAt: record.createdAt as string,
    status: last.status as string,
    completedAt: last.completedAt as string | null,
    errorMessage: outcome && typeof outcome.errorMessage === "string" ? outcome.errorMessage : undefined,
    ownerConversationId: last.ownerConversationId as string | undefined,
    runtimeId: last.runtimeId as string | undefined,
    lifetime: last.lifetime as "attached" | undefined,
    originSurfaceId: last.originSurfaceId as string | undefined,
    executionEnvironment: last.executionEnvironment,
    deliveryState: last.deliveryState as string | undefined,
    invocations: invocations as Record<string, unknown>[],
  };
}

/** Return the path to a host-owned record file for tests that only need a string. */
export function recordPathFor(home: string, id: string): string {
  return delegatedWorkRecordPath(home, id);
}

/** Return the path to a host-owned run directory. */
export function runDirFor(home: string, id: string): string {
  return delegatedWorkRunDir(home, id);
}

/** Create a valid generic or named record payload for direct disk setup. */
export function validRecord(
  id: string,
  overrides: Record<string, unknown> = {},
  status: "running" | "completed" | "error" | "cancelled" | "interrupted" = "completed",
  outcome: Record<string, unknown> | null = { kind: "success", text: "done" },
  deliveryState: "pending" | "delivered" | "suppressed" = "delivered",
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    kind: "generic-subagent",
    name: null,
    depth: 1,
    createdAt: now,
    invocations: [{
      index: 0,
      ownerConversationId: "conversation-a",
      runtimeId: "runtime-1",
      ownershipEpochId: "epoch-1",
      lifetime: "attached",
      originSurfaceId: surfaceId(dmSurface(1)),
      executionEnvironment: personalEnvironment(),
      status,
      outcome,
      deliveryState,
      startedAt: now,
      completedAt: status === "running" ? null : now,
    }],
    ...overrides,
  };
}

/** Write a record and an optional session file to a run directory. */
export function writeRecordAndSession(
  home: string,
  id: string,
  record: Record<string, unknown>,
  sessionFileName?: string,
): string {
  const runDir = delegatedWorkRunDir(home, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(delegatedWorkRecordPath(home, id), JSON.stringify(record));
  if (sessionFileName !== undefined) {
    const sessionFile = join(runDir, sessionFileName);
    writeFileSync(sessionFile, "");
    return sessionFile;
  }
  return runDir;
}

/** Write a fake .jsonl session file into a run directory. */
export function writeSessionFile(home: string, id: string, fileName = "2026-01-01T00-00-00.jsonl"): string {
  const runDir = delegatedWorkRunDir(home, id);
  mkdirSync(runDir, { recursive: true });
  const sessionFile = join(runDir, fileName);
  writeFileSync(sessionFile, "");
  return sessionFile;
}

/** Complete a subagent, await its result, and acknowledge delivery to release the host registration. */
export async function completeAndAcknowledge(
  runner: SubagentRunner,
  host: FakeSubagentHost,
  handle: SubagentHandle,
  text = "done",
): Promise<string> {
  host.latest().complete(text);
  const result = await handle.result;
  runner.acknowledgeDelivery(handle.id);
  return result;
}
