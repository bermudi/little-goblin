import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import JSON5 from "json5";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  agent as acpAgent,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type AgentRequestContext,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { createDelegatedExternalAgentTool } from "../external-agents/tool.ts";
import type { ProcessHandle, ProcessHost, ProcessSpawnArgs, ProcessExit } from "../external-agents/types.ts";
import { ExternalAgentHost } from "../external-agents/host.ts";
import { DelegatedWorkHost } from "../delegated-work/host.ts";
import { personalEnvironment } from "../sessions/environment.ts";
import { dmSurface, surfaceId } from "../surface.ts";
import { asConversationRuntimeId } from "../delegated-work/types.ts";
import { startSettingsServer } from "./server.ts";

interface LaunchModule {
  resolveDeploymentDevinModel(goblinHome: string): string | undefined;
  createDeploymentDevinModelResolver(goblinHome: string): () => string | undefined;
}

// Dynamic loading lets the verifier-only commit typecheck before implementation.
const modulePath = "./launch.ts";
async function loadLaunch(): Promise<LaunchModule> {
  const loaded: unknown = await import(modulePath);
  return loaded as LaunchModule;
}

const BOT_TOKEN = "test-bot-token-launch-456";
const OPERATOR_ID = 123;
const ORIGIN = "https://app.example";

const DEVIN_CAPS: AgentCapabilities = {
  loadSession: true,
  sessionCapabilities: { delete: {} },
};

type PromptBehavior = (ctx: AgentRequestContext<PromptRequest>) => Promise<PromptResponse> | PromptResponse;

class FakeHandle implements ProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly exitPromise: Promise<ProcessExit>;
  private resolveExit!: (exit: ProcessExit) => void;
  constructor(fromClient: PassThrough, toClient: PassThrough) {
    this.stdin = fromClient;
    this.stdout = toClient;
    this.exitPromise = new Promise<ProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
  }
  async *readLines(): AsyncIterable<string> {}
  waitForExit(): Promise<ProcessExit> {
    return this.exitPromise;
  }
  async kill(): Promise<void> {
    this.stdin.end();
    this.stdout.push(null);
    this.resolveExit({ exitCode: null, signal: "SIGTERM" });
    await this.exitPromise;
  }
  getStderr(): string {
    return "";
  }
}

class MockServer {
  readonly handle: FakeHandle;
  private readonly behaviors: PromptBehavior[];
  constructor(sessionId: string, behaviors: PromptBehavior[]) {
    this.behaviors = [...behaviors];
    const fromClient = new PassThrough();
    const toClient = new PassThrough();
    this.handle = new FakeHandle(fromClient, toClient);
    const app = acpAgent({ name: "mock-launch-agent" })
      .onRequest(methods.agent.initialize, (c) => ({
        protocolVersion: c.params.protocolVersion,
        agentCapabilities: DEVIN_CAPS,
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId }))
      .onRequest(methods.agent.session.prompt, (c) => {
        const next = this.behaviors.shift();
        if (next !== undefined) return next(c);
        return { stopReason: "end_turn" };
      });
    const connection = app.connect(ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(fromClient)));
    void connection.closed.catch(() => {});
  }
}

class MockProcessHost implements ProcessHost {
  readonly spawns: Array<{ args: ProcessSpawnArgs; server: MockServer }> = [];
  constructor(private readonly factory: (args: ProcessSpawnArgs, index: number) => MockServer) {}
  async spawn(args: ProcessSpawnArgs): Promise<ProcessHandle> {
    const server = this.factory(args, this.spawns.length);
    this.spawns.push({ args, server });
    return server.handle;
  }
}

function ownership() {
  return {
    lifetime: "durable" as const,
    ownerConversationId: "conversation-launch",
    runtimeId: asConversationRuntimeId("runtime-launch"),
    originSurfaceId: surfaceId(dmSurface(901)),
    executionEnvironment: personalEnvironment(),
    ownershipEpochId: "epoch-launch",
  };
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first !== undefined && first.type === "text" && typeof first.text === "string") return first.text;
  return "";
}

function signInitData(params: Record<string, string>, botToken: string): string {
  const check = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return [...Object.entries(params), ["hash", hash] as [string, string]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function validInitData(botToken = BOT_TOKEN, userId = OPERATOR_ID): string {
  const auth_date = String(Math.floor(Date.now() / 1000));
  const user = JSON.stringify({ id: userId, first_name: "Op" });
  return signInitData({ auth_date, user }, botToken);
}

function makeHome(initial: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "goblin-settings-launch-"));
  writeFileSync(join(home, "goblin.json5"), JSON5.stringify(initial) + "\n", "utf-8");
  return home;
}

async function saveViaSettingsApi(home: string, modelId: string): Promise<{ devinDefaultModel: string | null }> {
  const handle = startSettingsServer({
    goblinHome: home,
    botToken: BOT_TOKEN,
    allowedUserIds: [OPERATOR_ID],
    allowedOrigins: [ORIGIN],
  });
  try {
    const res = await fetch(`${handle.url}/api/config/devin`, {
      method: "PUT",
      headers: {
        authorization: `tma ${validInitData()}`,
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ patch: { defaultModel: modelId } }),
    });
    expect(res.status).toBe(200);
    return { devinDefaultModel: modelId };
  } finally {
    await handle.close();
  }
}

const CTX = undefined as unknown as ExtensionContext;

describe("Saved default controls the next ACP run", () => {
  it("saved deployment model is captured by the next ACP launch", async () => {
    const { createDeploymentDevinModelResolver } = await loadLaunch();
    const home = makeHome({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" });
    const cwd = mkdtempSync(join(tmpdir(), "goblin-launch-cwd-"));
    try {
      const saved = await saveViaSettingsApi(home, "atlas-exact-a");
      expect(saved.devinDefaultModel).toBe("atlas-exact-a");

      const workHost = new DelegatedWorkHost(home);
      const processHost = new MockProcessHost(
        (_args, index) =>
          new MockServer(`sess-launch-${index}`, [
            async (ctx) => {
              await ctx.client.notify(methods.client.session.update, {
                sessionId: `sess-launch-${index}`,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
              });
              return { stopReason: "end_turn" };
            },
          ]),
      );
      const agentHost = new ExternalAgentHost({ processHost });
      const tool = createDelegatedExternalAgentTool({
        workHost,
        agentHost,
        enabledBackends: ["devin"],
        buildOwnership: ownership,
        resolveDevinModel: createDeploymentDevinModelResolver(home),
      });
      const result = await tool.execute(
        "call-1",
        { action: "start", agent: "devin", task: "do delegated work", workingDirectory: cwd },
        undefined,
        undefined,
        CTX,
      );
      const text = toolText(result);
      expect(text).toContain("Started external devin run");
      expect(text).toContain("atlas-exact-a");
      expect(processHost.spawns).toHaveLength(1);
      expect(processHost.spawns[0]?.args.command).toEqual([
        "devin",
        "--permission-mode",
        "auto",
        "--sandbox",
        "acp",
        "--model",
        "atlas-exact-a",
      ]);
      const ids = workHost.listRecordIds();
      expect(ids).toHaveLength(1);
      const record = workHost.loadRecord(ids[0] ?? "");
      expect(record?.kind).toBe("external-agent");
      if (record?.kind === "external-agent") {
        expect(record.external.backend).toBe("devin");
        expect(record.external.devinModel).toBe("atlas-exact-a");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("changing defaults preserves admitted run model identity", async () => {
    const { createDeploymentDevinModelResolver } = await loadLaunch();
    const home = makeHome({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" });
    const cwd = mkdtempSync(join(tmpdir(), "goblin-launch-cwd-"));
    try {
      await saveViaSettingsApi(home, "atlas-exact-a");
      const workHost = new DelegatedWorkHost(home);
      const processHost = new MockProcessHost(
        (_args, index) =>
          new MockServer(`sess-preserve-${index}`, [
            index === 0
              ? () => ({ stopReason: "input_required" }) as unknown as PromptResponse
              : async (ctx) => {
                  await ctx.client.notify(methods.client.session.update, {
                    sessionId: `sess-preserve-${index}`,
                    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } },
                  });
                  return { stopReason: "end_turn" };
                },
          ]),
      );
      const agentHost = new ExternalAgentHost({ processHost });
      const tool = createDelegatedExternalAgentTool({
        workHost,
        agentHost,
        enabledBackends: ["devin"],
        buildOwnership: ownership,
        resolveDevinModel: createDeploymentDevinModelResolver(home),
      });
      const first = await tool.execute(
        "call-1",
        { action: "start", agent: "devin", task: "first work", workingDirectory: cwd },
        undefined,
        undefined,
        CTX,
      );
      expect(toolText(first)).toContain("input_required");
      const firstId = workHost.listRecordIds()[0] ?? "";
      expect(workHost.loadRecord(firstId)?.kind).toBe("external-agent");

      // Change the deployment default without restarting: same resolver sees it.
      await saveViaSettingsApi(home, "boreal-exact");
      const second = await tool.execute(
        "call-2",
        { action: "start", agent: "devin", task: "second work", workingDirectory: cwd },
        undefined,
        undefined,
        CTX,
      );
      expect(toolText(second)).toContain("boreal-exact");
      expect(processHost.spawns).toHaveLength(2);
      expect(processHost.spawns[0]?.args.command).toContain("atlas-exact-a");
      expect(processHost.spawns[1]?.args.command).toContain("boreal-exact");
      const firstRecord = workHost.loadRecord(firstId);
      expect(firstRecord?.kind).toBe("external-agent");
      if (firstRecord?.kind === "external-agent") {
        expect(firstRecord.external.devinModel).toBe("atlas-exact-a");
      }
      const ids = workHost.listRecordIds();
      expect(ids).toHaveLength(2);
      const secondId = ids.find((id) => id !== firstId) ?? "";
      const secondRecord = workHost.loadRecord(secondId);
      if (secondRecord?.kind === "external-agent") {
        expect(secondRecord.external.devinModel).toBe("boreal-exact");
      } else {
        throw new Error("second delegated-run record missing");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("unavailable selection never launches a substitute", async () => {
    const { createDeploymentDevinModelResolver, resolveDeploymentDevinModel } = await loadLaunch();
    // No devin section: explicit no-selection. A stale startup snapshot must not authorize a launch.
    const home = makeHome({
      botToken: "x",
      allowedUsers: [OPERATOR_ID],
      model: "m",
      externalAgents: { backends: ["devin"], devinModel: "stale-startup-model" },
    });
    const cwd = mkdtempSync(join(tmpdir(), "goblin-launch-cwd-"));
    try {
      expect(resolveDeploymentDevinModel(home)).toBeUndefined();
      const workHost = new DelegatedWorkHost(home);
      const processHost = new MockProcessHost(() => new MockServer("sess-never", []));
      const agentHost = new ExternalAgentHost({ processHost });
      const tool = createDelegatedExternalAgentTool({
        workHost,
        agentHost,
        enabledBackends: ["devin"],
        buildOwnership: ownership,
        resolveDevinModel: createDeploymentDevinModelResolver(home),
      });
      const missing = await tool.execute(
        "call-1",
        { action: "start", agent: "devin", task: "needs model", workingDirectory: cwd },
        undefined,
        undefined,
        CTX,
      );
      const missingText = toolText(missing);
      expect(missingText.startsWith("Error:")).toBe(true);
      expect(missingText).not.toContain("stale-startup-model");
      expect(workHost.listRecordIds()).toHaveLength(0);
      expect(processHost.spawns).toHaveLength(0);

      // A model-facing override is rejected without a record or process.
      const override = await tool.execute(
        "call-2",
        {
          action: "start",
          agent: "devin",
          task: "needs model",
          workingDirectory: cwd,
          model: "atlas-exact-a",
        } as unknown as Record<string, string>,
        undefined,
        undefined,
        CTX,
      );
      expect(toolText(override).startsWith("Error:")).toBe(true);
      expect(workHost.listRecordIds()).toHaveLength(0);
      expect(processHost.spawns).toHaveLength(0);

      // Corrupt deployment config fails visibly without launching a substitute.
      writeFileSync(join(home, "goblin.json5"), "{ invalid json5 ", "utf-8");
      const corrupt = await tool.execute(
        "call-3",
        { action: "start", agent: "devin", task: "needs model", workingDirectory: cwd },
        undefined,
        undefined,
        CTX,
      );
      expect(toolText(corrupt).startsWith("Error:")).toBe(true);
      expect(workHost.listRecordIds()).toHaveLength(0);
      expect(processHost.spawns).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("concurrent launches capture the same saved default independently", async () => {
    const { createDeploymentDevinModelResolver } = await loadLaunch();
    const home = makeHome({ botToken: "x", allowedUsers: [OPERATOR_ID], model: "m" });
    const cwd = mkdtempSync(join(tmpdir(), "goblin-launch-cwd-"));
    try {
      await saveViaSettingsApi(home, "atlas-exact-a");
      const workHost = new DelegatedWorkHost(home);
      const processHost = new MockProcessHost(
        (_args, index) =>
          new MockServer(`sess-concurrent-${index}`, [
            async (ctx) => {
              await ctx.client.notify(methods.client.session.update, {
                sessionId: `sess-concurrent-${index}`,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
              });
              return { stopReason: "end_turn" };
            },
          ]),
      );
      const agentHost = new ExternalAgentHost({ processHost });
      const tool = createDelegatedExternalAgentTool({
        workHost,
        agentHost,
        enabledBackends: ["devin"],
        buildOwnership: ownership,
        resolveDevinModel: createDeploymentDevinModelResolver(home),
      });
      const [first, second] = await Promise.all([
        tool.execute("call-1", { action: "start", agent: "devin", task: "one", workingDirectory: cwd }, undefined, undefined, CTX),
        tool.execute("call-2", { action: "start", agent: "devin", task: "two", workingDirectory: cwd }, undefined, undefined, CTX),
      ]);
      expect(toolText(first)).toContain("atlas-exact-a");
      expect(toolText(second)).toContain("atlas-exact-a");
      expect(processHost.spawns).toHaveLength(2);
      for (const spawn of processHost.spawns) {
        expect(spawn.args.command).toContain("atlas-exact-a");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
