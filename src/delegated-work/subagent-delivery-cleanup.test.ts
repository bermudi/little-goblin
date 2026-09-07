import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import type { ConversationState } from "../sessions/types.ts";
import {
  supergroupSurface,
  surfaceId,
  type Surface,
  type SurfaceId,
} from "../surface.ts";
import type { SurfaceMemoryAuthority, CapturedMemoryContext } from "../memory/mod.ts";
import type { ResolvedSkillSet } from "../agent/skills/mod.ts";
import {
  DurableCompletionWake,
  type CompletionWakeRail,
  type WakeTurnAdmission,
} from "./delivery.ts";
import { asConversationRuntimeId, type DelegatedRuntimeContext } from "./types.ts";
import { SubagentRunner } from "../subagents/mod.ts";
import { FakeSubagentHost } from "../subagents/test/fake-host.ts";
import type { GenericSubagentInheritance, SubagentInstance } from "../subagents/types.ts";
import { delegatedWorkRunDir } from "./paths.ts";

/**
 * Issue #54 unit 3 verifier: retained subagent release after canonical
 * delivery acknowledgement.
 *
 * Wires a live SubagentRunner (Fake Pi host) to the production
 * DurableCompletionWake through the runner's own DelegatedWorkHost. The wake
 * is the single acknowledgement owner: Telegram intake never coordinates
 * host writes and runner cleanup in these tests.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "goblin-subagent-delivery-cleanup-"));
}

function makeConfig(home: string): Config {
  return Object.freeze({
    botToken: "test-token",
    allowedTgUserIds: new Set<number>([1]),
    modelName: "openai/test-model",
    openaiApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "none",
  }) as Config;
}

const EMPTY_SKILLS: ResolvedSkillSet = {
  skills: [],
  diagnostics: [],
  fingerprint: "test-empty",
};

const DEFAULT_SURFACE: Surface = supergroupSurface(-100123);

const DEFAULT_AUTHORITY: SurfaceMemoryAuthority = {
  kind: "surface",
  sourceSurfaceId: surfaceId(DEFAULT_SURFACE),
  activeScope: { chatId: -100123, topicScope: "general" },
};

const DEFAULT_PARENT_CAPTURE: CapturedMemoryContext = {
  kind: "surface",
  authority: DEFAULT_AUTHORITY,
  caller: { kind: "anonymous-subagent" },
  frozenSummary: null,
  frozenUserBody: "",
  frozenActiveMemoryBody: "",
};

const EMPTY_INHERITANCE: GenericSubagentInheritance = {
  executionEnvironment: personalEnvironment(),
  resolvedSkills: EMPTY_SKILLS,
};

function durableContext(originSurfaceId: SurfaceId): DelegatedRuntimeContext {
  return {
    ownerConversationId: "conversation-durable",
    runtimeId: asConversationRuntimeId(`runtime-durable-${Math.random().toString(16).slice(2)}`),
    originSurfaceId,
    executionEnvironment: personalEnvironment(),
  };
}

function boundConversation(id: string): ConversationState {
  return { id, createdAt: new Date().toISOString(), executionEnvironment: personalEnvironment() };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface EnqueuedTurn {
  readonly conversation: ConversationState;
  readonly surface: Surface;
  readonly content: string;
}

class FakeRail implements CompletionWakeRail {
  readonly bindings = new Map<string, ConversationState>();
  readonly enqueued: EnqueuedTurn[] = [];

  async resolveCurrent(surface: Surface): Promise<ConversationState | null> {
    return this.bindings.get(surfaceId(surface)) ?? null;
  }

  enqueueScheduledTurn(
    conversation: ConversationState,
    surface: Surface,
    content: string,
  ): boolean | WakeTurnAdmission {
    this.enqueued.push({ conversation, surface, content });
    return {
      accepted: true,
      started: Promise.resolve(true),
      settled: Promise.resolve(true),
    };
  }
}

function getInstance(runner: SubagentRunner, id: string): SubagentInstance | undefined {
  return (runner as unknown as { activeSubagents: Map<string, SubagentInstance> }).activeSubagents.get(id);
}

function writeSessionFile(home: string, id: string): void {
  const runDir = delegatedWorkRunDir(home, id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "2026-01-01T00-00-00.jsonl"), "");
}

describe("subagent delivery cleanup after canonical acknowledgement", () => {
  it("C1: automatic wake acknowledgement releases real retained subagent instance and host registration", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const handle = await runner.spawn({
        prompt: "background work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      handle.result.catch(() => {});
      await flush();

      fakeHost.latest().complete("durable result");
      await handle.result;
      await flush();

      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.delegatedRegistration).not.toBeNull();

      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      expect(await wake.deliverCompletion(handle.id, 0)).toBe("delivered");

      const record = runner.delegatedWorkHost.loadRecord(handle.id)!;
      expect(record.invocations[0]!.deliveryState).toBe("delivered");
      expect(record.invocations[0]!.outcome).toEqual({ kind: "success", text: "durable result" });
      expect(rail.enqueued.length).toBe(1);

      const instance = getInstance(runner, handle.id);
      expect(instance?.deliveryState).toBe("delivered");
      expect(instance?.delegatedRegistration).toBeNull();
      const listed = runner.list().find((entry) => entry.id === handle.id);
      expect(listed?.deliveryState).toBe("delivered");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C1: repeated background completion deliveries leave no retained pending instances", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const handle = await runner.spawn({
          prompt: `background work ${i}`,
          authority: DEFAULT_AUTHORITY,
          inheritance: EMPTY_INHERITANCE,
          delegatedContext: durableContext(origin),
          lifetime: "durable",
        });
        handle.result.catch(() => {});
        await flush();
        fakeHost.latest().complete(`result ${i}`);
        await handle.result;
        ids.push(handle.id);
        expect(await wake.deliverCompletion(handle.id, 0)).toBe("delivered");
      }

      const pending = runner.list().filter((entry) => entry.deliveryState === "pending");
      expect(pending).toEqual([]);
      for (const id of ids) {
        expect(runner.delegatedWorkHost.loadRecord(id)!.invocations[0]!.deliveryState).toBe("delivered");
        expect(getInstance(runner, id)?.delegatedRegistration).toBeNull();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C2: failed response retains live pending instance", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const handle = await runner.spawn({
        prompt: "background work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("result awaiting delivery");
      await handle.result;

      const rail = new FakeRail();
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      expect(await wake.deliverCompletion(handle.id, 0)).toBe("pending");
      expect(rail.enqueued.length).toBe(0);
      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.delegatedRegistration).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C2: failed acknowledgement persistence retains live pending instance", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const handle = await runner.spawn({
        prompt: "background work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("accepted result");
      await handle.result;

      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      const host = runner.delegatedWorkHost;
      const original = host.acknowledgeDelivery.bind(host);
      host.acknowledgeDelivery = () => {
        throw new Error("disk full");
      };
      try {
        await expect(wake.deliverCompletion(handle.id, 0)).rejects.toThrow(/disk full/);
      } finally {
        host.acknowledgeDelivery = original;
      }
      expect(host.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.deliveryState).toBe("pending");
      expect(getInstance(runner, handle.id)?.delegatedRegistration).not.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C2: suppression and duplicate acknowledgement cannot double release or resurrect delivery", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      const suppressed = await runner.spawn({
        prompt: "suppressed work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      suppressed.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("suppressed result");
      await suppressed.result;
      runner.delegatedWorkHost.suppressDelivery(suppressed.id, 0);

      expect(await wake.deliverCompletion(suppressed.id, 0)).toBe("suppressed");
      expect(runner.delegatedWorkHost.loadRecord(suppressed.id)!.invocations[0]!.deliveryState).toBe("suppressed");
      expect(getInstance(runner, suppressed.id)?.deliveryState).not.toBe("delivered");

      const handle = await runner.spawn({
        prompt: "delivered work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("delivered result");
      await handle.result;
      expect(await wake.deliverCompletion(handle.id, 0)).toBe("delivered");
      expect(await wake.deliverCompletion(handle.id, 0)).toBe("delivered");
      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("delivered");
      expect(getInstance(runner, handle.id)?.deliveryState).toBe("delivered");
      expect(getInstance(runner, handle.id)?.delegatedRegistration).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C2: late old invocation acknowledgement does not release revived invocation", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const handle = await runner.spawn({
        prompt: "first work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("first result");
      await handle.result;
      runner.acknowledgeDelivery(handle.id);
      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("delivered");

      writeSessionFile(home, handle.id);
      const revived = runner.revive(
        DEFAULT_PARENT_CAPTURE,
        EMPTY_INHERITANCE,
        handle.id,
        "follow-up work",
      );
      revived.catch(() => {});
      await flush();
      const revivedInstance = getInstance(runner, handle.id);
      expect(revivedInstance?.invocationIndex).toBe(1);
      expect(revivedInstance?.status).toBe("running");
      expect(revivedInstance?.delegatedRegistration).not.toBeNull();

      const rail = new FakeRail();
      rail.bindings.set(DEFAULT_AUTHORITY.sourceSurfaceId, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);
      expect(await wake.deliverCompletion(handle.id, 0)).toBe("delivered");

      const current = getInstance(runner, handle.id);
      expect(current?.invocationIndex).toBe(1);
      expect(current?.status).toBe("running");
      expect(current?.deliveryState).toBe("pending");
      expect(current?.delegatedRegistration).not.toBeNull();

      fakeHost.latest().complete("revived result");
      await revived;
      runner.acknowledgeDelivery(handle.id);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C3: restarted completion acknowledgement succeeds without a live instance", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const host = runner.delegatedWorkHost;
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const runId = "restart-run-00000000-0000-0000-0000-000000000001";
      host.createRecord(runId, "generic-subagent", null, 1, {
        lifetime: "durable",
        ownerConversationId: "conversation-durable",
        runtimeId: asConversationRuntimeId("runtime-restart"),
        originSurfaceId: origin,
        executionEnvironment: personalEnvironment(),
        ownershipEpochId: "epoch-restart",
      });
      host.completeInvocation(runId, 0, "restarted result");

      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, host);
      runner.setCompletionWake(wake);

      expect(await wake.deliverCompletion(runId, 0)).toBe("delivered");
      expect(host.loadRecord(runId)!.invocations[0]!.deliveryState).toBe("delivered");
      expect(host.loadRecord(runId)!.invocations[0]!.outcome).toEqual({
        kind: "success",
        text: "restarted result",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C3: attached blocking acknowledgement still releases matching instance", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const handle = await runner.spawn({
        prompt: "blocking work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("blocking result");
      const text = await handle.result;
      expect(text).toBe("blocking result");

      runner.acknowledgeDelivery(handle.id);
      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("delivered");
      expect(getInstance(runner, handle.id)?.deliveryState).toBe("delivered");
      expect(getInstance(runner, handle.id)?.delegatedRegistration).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("C3: cleanup failure surfaces identity without rolling back accepted persisted delivery", async () => {
    const home = tempHome();
    try {
      const fakeHost = new FakeSubagentHost();
      const runner = new SubagentRunner(makeConfig(home), undefined, undefined, fakeHost);
      const origin = DEFAULT_AUTHORITY.sourceSurfaceId;
      const handle = await runner.spawn({
        prompt: "background work",
        authority: DEFAULT_AUTHORITY,
        inheritance: EMPTY_INHERITANCE,
        delegatedContext: durableContext(origin),
        lifetime: "durable",
      });
      handle.result.catch(() => {});
      await flush();
      fakeHost.latest().complete("durable result");
      await handle.result;

      const rail = new FakeRail();
      rail.bindings.set(origin, boundConversation("conversation-durable"));
      const wake = new DurableCompletionWake(rail, runner.delegatedWorkHost);
      runner.setCompletionWake(wake);

      const instance = getInstance(runner, handle.id);
      expect(instance?.delegatedRegistration).not.toBeNull();
      const registration = instance!.delegatedRegistration!;
      registration.release = () => {
        throw new Error("cleanup boom");
      };

      const failure = await wake.deliverCompletion(handle.id, 0).then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(handle.id);
      expect(message).toContain("0");
      expect(message).toContain(origin);
      expect(rail.enqueued.length).toBe(1);
      expect(runner.delegatedWorkHost.loadRecord(handle.id)!.invocations[0]!.deliveryState).toBe("delivered");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
