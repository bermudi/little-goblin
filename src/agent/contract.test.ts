import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentRunner } from "./mod.ts";
import type { TurnCallbacks } from "./mod.ts";
import type { Config } from "../config.ts";
import { soulMdPath, workdirPath } from "../workspace/paths.ts";
import { piAgentDir } from "../pi-host.ts";

function makeConfig(home: string): Config {
  return {
    botToken: "test-token",
    allowedTgUserIds: new Set([1]),
    modelName: "faux/faux-1",
    poeApiKey: "test-key",
    openrouterApiKey: "test-key",
    openaiApiKey: "test-key",
    anthropicApiKey: "test-key",
    goblinHome: home,
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    voiceName: "en-US-AriaNeural",
    favorites: [],
  };
}

describe("AgentRunner pi-ai contract", () => {
  let tmpDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "goblin-contract-"));
    mkdirSync(workdirPath(tmpDir), { recursive: true });
    mkdirSync(piAgentDir(tmpDir), { recursive: true });
    mkdirSync(dirname(soulMdPath(tmpDir)), { recursive: true });
    writeFileSync(soulMdPath(tmpDir), "test goblin identity\n", "utf-8");
    faux = registerFauxProvider();
  });

  afterEach(() => {
    faux.unregister();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams a response through the real SDK using the faux provider", async () => {
    const model = faux.getModel() as Model<Api>;
    const runner = new AgentRunner({
      cfg: makeConfig(tmpDir),
      sessionId: "abcdef1234",
      locator: { chatId: 1 },
      customTools: [],
      resolvedModel: { model, apiKey: "fake-key", thinkingLevel: "medium" },
    });

    faux.setResponses([fauxAssistantMessage("Hello from faux")]);

    const onTextDelta = mock((_text: string) => {});
    const onAgentEnd = mock(() => {});
    const callbacks: TurnCallbacks = {
      onTextDelta,
      onToolStart: mock(() => {}),
      onToolEnd: mock(() => {}),
      onStatusUpdate: mock(() => {}),
      onAgentEnd,
    };

    await runner.prompt("hi", callbacks);

    expect(onTextDelta).toHaveBeenCalled();
    expect(onAgentEnd).toHaveBeenCalled();

    const deltas = onTextDelta.mock.calls.map((call) => call[0]);
    expect(deltas.join("")).toContain("Hello from faux");
  });
});
