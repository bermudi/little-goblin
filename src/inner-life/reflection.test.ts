import { describe, expect, it } from "bun:test";
import {
  MAX_FACT_PROPOSALS,
  MAX_FACT_TEXT_CHARS,
  MAX_REFLECTION_OUTPUT_BYTES,
  MAX_REFLECTION_REJECTION_CHARS,
  PRIVATE_REFLECTION_SYSTEM_PROMPT,
  REFLECTION_DEADLINE_MS,
  ReflectionEngine,
  ReflectionError,
  redactSecrets,
  type ReflectionModelInvoker,
  type ReflectionModelRequest,
  type ReflectionRequest,
} from "./reflection.ts";
import { PRIVATE_FACTS_PROFILE, type WakeInputLine, type WakeRole } from "./wake-store.ts";
import type { Config } from "../config.ts";

/**
 * Reflection verifier for Litespec #67 unit "Execute isolated extractive
 * reflection".
 *
 * Scenarios (exact names from the issue):
 * - [R1] configured-model-receives-only-private-profile-input
 * - [R1] concurrent-wakes-do-not-share-history-or-capture-buffers
 * - [R2] stated-madrid-fact-accepted-inferred-spanish-rejected
 * - [R2] assistant-tool-outside-window-and-forged-effects-rejected
 * - [R2] strict-envelope-item-count-and-text-bounds
 * - [R3] deadline-output-cap-cancel-and-late-response-dispose
 * - [R3] missing-provider-and-provider-failure-have-no-fallback
 *
 * All model boundaries are deterministic fakes injected through the engine's
 * invoker seam; no live or paid provider call exists on any path here.
 */

const TS = "2026-01-01T00:00:00.000Z";

function line(index: number, role: WakeRole = "user", text = `line ${index}`): WakeInputLine {
  return { index, role, text, ts: TS };
}

function reflectionRequest(overrides: Partial<ReflectionRequest> = {}): ReflectionRequest {
  return {
    wakeId: "wake_" + "a".repeat(16),
    profile: PRIVATE_FACTS_PROFILE,
    lines: [line(0, "user", "I live in Madrid"), line(1, "assistant", "You live in Madrid.")],
    ...overrides,
  };
}

interface RecordedCall {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal: AbortSignal;
}

function fakeInvoker(
  responder: (call: RecordedCall, index: number) => Promise<string> | string,
): { invoker: ReflectionModelInvoker; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const invoker: ReflectionModelInvoker = (request: ReflectionModelRequest) => {
    const call: RecordedCall = {
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      signal: request.signal,
    };
    calls.push(call);
    return Promise.resolve(responder(call, calls.length - 1));
  };
  return { invoker, calls };
}

function fact(target: "memory" | "user", lineNumber: number, text: string): Record<string, unknown> {
  return { kind: "fact", target, line: lineNumber, text };
}

function envelope(proposals: unknown[]): string {
  return JSON.stringify({ version: 1, proposals });
}

function engineWith(output: string): ReflectionEngine {
  return new ReflectionEngine({ invoker: fakeInvoker(() => output).invoker });
}

async function reflectionFailure(promise: Promise<unknown>): Promise<ReflectionError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ReflectionError) return err;
    throw new Error(`expected ReflectionError, got: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error("expected the reflection to fail");
}

/** Minimal Config stub, same shape precedent as src/agent/models.test.ts. */
function configWith(modelName: string, openaiApiKey: string | undefined): Config {
  return {
    modelName,
    botToken: "t",
    allowedTgUserIds: "1",
    ...(openaiApiKey === undefined ? {} : { openaiApiKey }),
  } as unknown as Config;
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (err: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

describe("reflection", () => {
  it("configured-model-receives-only-private-profile-input", async () => {
    const lines: WakeInputLine[] = [
      {
        index: 4,
        role: "user",
        text: "I live in Madrid",
        ts: "2026-03-05T10:00:00.000Z",
        sourceSurfaceId: "tg:dm:123",
      },
      line(5, "assistant", "Noted, you live in Madrid."),
    ];
    const { invoker, calls } = fakeInvoker(() => envelope([fact("memory", 4, "I live in Madrid")]));
    const engine = new ReflectionEngine({ invoker });

    const outcome = await engine.reflect(reflectionRequest({ wakeId: "wake_" + "b".repeat(16), lines }));

    // Exactly one isolated invocation.
    expect(calls.length).toBe(1);
    // R1: only code-owned instructions — the exported private-profile prompt.
    expect(calls[0]!.systemPrompt).toBe(PRIVATE_REFLECTION_SYSTEM_PROMPT);
    // R1: only the captured wake input. No wake identity, conversation
    // identity, event timestamps, surface ids, or workspace content leaks in.
    const prompt = calls[0]!.userPrompt;
    expect(prompt).toContain("[4] user: I live in Madrid");
    expect(prompt).toContain("[5] assistant: Noted, you live in Madrid.");
    expect(prompt).not.toContain("wake_");
    expect(prompt).not.toContain("2026-03-05T10:00:00.000Z");
    expect(prompt).not.toContain("tg:dm:123");
    expect(prompt).not.toContain("conversation");
    // A mechanically supported excerpt is accepted as a validated proposal.
    expect(outcome.rejections).toEqual([]);
    expect(outcome.proposals).toEqual([{ target: "memory", lineIndex: 4, text: "I live in Madrid" }]);
    // R3: invocation resources are released on completion.
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it("concurrent-wakes-do-not-share-history-or-capture-buffers", async () => {
    const madridLines = [line(0, "user", "I live in Madrid"), line(1, "assistant", "Madrid is big.")];
    const berlinLines = [line(0, "user", "I work in Berlin"), line(1, "user", "My cat is named Fritz")];
    const calls: RecordedCall[] = [];
    // The first call completes last: interleaved, overlapping invocations.
    const latencies = [30, 5];
    const invoker: ReflectionModelInvoker = (request) => {
      const index = calls.length;
      calls.push({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        signal: request.signal,
      });
      // The response keys off the wake's own captured input, not call order.
      const output = request.userPrompt.includes("Madrid")
        ? envelope([fact("user", 0, "I live in Madrid")])
        : envelope([
            fact("memory", 1, "My cat is named Fritz"),
            // Poisoned: text copied from the OTHER wake's transcript. It must
            // be rejected against this wake's own buffer, never accepted via
            // shared state.
            fact("memory", 0, "I live in Madrid"),
          ]);
      const latency = latencies[index];
      return new Promise((resolve) => setTimeout(() => resolve(output), latency));
    };
    const engine = new ReflectionEngine({ invoker });

    const [madrid, berlin] = await Promise.all([
      engine.reflect(reflectionRequest({ wakeId: "wake_" + "c".repeat(16), lines: madridLines })),
      engine.reflect(reflectionRequest({ wakeId: "wake_" + "d".repeat(16), lines: berlinLines })),
    ]);

    expect(calls.length).toBe(2);
    // Fresh, identical, code-owned instructions per invocation; no history.
    expect(calls[0]!.systemPrompt).toBe(PRIVATE_REFLECTION_SYSTEM_PROMPT);
    expect(calls[1]!.systemPrompt).toBe(PRIVATE_REFLECTION_SYSTEM_PROMPT);
    // No capture-buffer bleed between concurrent wakes.
    expect(calls[0]!.userPrompt).not.toContain("Berlin");
    expect(calls[0]!.userPrompt).not.toContain("Fritz");
    expect(calls[1]!.userPrompt).not.toContain("Madrid");
    expect(calls[0]!.signal).not.toBe(calls[1]!.signal);
    // Each outcome validates against its own captured input only.
    expect(madrid.proposals).toEqual([{ target: "user", lineIndex: 0, text: "I live in Madrid" }]);
    expect(madrid.rejections).toEqual([]);
    expect(berlin.proposals).toEqual([{ target: "memory", lineIndex: 1, text: "My cat is named Fritz" }]);
    expect(berlin.rejections.length).toBe(1);
    expect(berlin.rejections[0]!.itemIndex).toBe(1);
    expect(berlin.rejections[0]!.reason).toContain("verbatim");
  });

  it("stated-madrid-fact-accepted-inferred-spanish-rejected", async () => {
    const { invoker } = fakeInvoker(() =>
      envelope([
        // Verbatim excerpt of the cited user line: eligible.
        fact("memory", 0, "I live in Madrid"),
        // Inferred wording that appears nowhere in the line: rejected.
        fact("memory", 0, "I speak Spanish"),
      ]),
    );
    const engine = new ReflectionEngine({ invoker });

    const outcome = await engine.reflect(
      reflectionRequest({ lines: [line(0, "user", "I live in Madrid and love quiet mornings")] }),
    );

    expect(outcome.proposals).toEqual([{ target: "memory", lineIndex: 0, text: "I live in Madrid" }]);
    expect(outcome.rejections.length).toBe(1);
    expect(outcome.rejections[0]!.itemIndex).toBe(1);
    expect(outcome.rejections[0]!.reason).toContain("verbatim");
  });

  it("assistant-tool-outside-window-and-forged-effects-rejected", async () => {
    const lines = [
      line(1, "user", "I live in Madrid"),
      line(2, "assistant", "You live in Madrid."),
      line(3, "toolResult", '{"weather":"sunny"}'),
    ];
    const { invoker } = fakeInvoker(() =>
      envelope([
        fact("memory", 2, "You live in Madrid."), // assistant role
        fact("user", 3, '{"weather":"sunny"}'), // tool result role
        fact("memory", 9, "I live in Madrid"), // outside the captured window
        { kind: "theme", target: "memory", line: 1, text: "I live in Madrid" }, // other effect kind
        { kind: "fact", target: "agent", line: 1, text: "I live in Madrid" }, // ineligible target
        fact("memory", 1, "I live in Madrid"), // the valid sibling
      ]),
    );
    const engine = new ReflectionEngine({ invoker });

    const outcome = await engine.reflect(reflectionRequest({ lines }));

    expect(outcome.proposals).toEqual([{ target: "memory", lineIndex: 1, text: "I live in Madrid" }]);
    expect(outcome.rejections.map((r) => r.itemIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(outcome.rejections[0]!.reason).toContain("user");
    expect(outcome.rejections[1]!.reason).toContain("user");
    expect(outcome.rejections[2]!.reason).toContain("outside the captured input");
    expect(outcome.rejections[3]!.reason).toContain("effect kind");
    expect(outcome.rejections[4]!.reason).toContain("target");
    for (const rejection of outcome.rejections) {
      expect(rejection.reason.length).toBeLessThanOrEqual(MAX_REFLECTION_REJECTION_CHARS);
    }
  });

  it("strict-envelope-item-count-and-text-bounds", async () => {
    const longLine = "long line ".repeat(270); // 2970 chars
    const lines = [line(0, "user", longLine)];
    const reflect = (output: string): Promise<unknown> =>
      engineWith(output).reflect(reflectionRequest({ lines }));

    // More than 32 items fails the whole envelope, not individual items.
    const tooMany = Array.from({ length: MAX_FACT_PROPOSALS + 1 }, () => fact("memory", 0, "long line"));
    expect((await reflectionFailure(reflect(envelope(tooMany)))).kind).toBe("malformed-envelope");

    // Unknown envelope version fails the reflection.
    expect(
      (await reflectionFailure(reflect(JSON.stringify({ version: 2, proposals: [] })))).kind,
    ).toBe("malformed-envelope");

    // Unknown top-level fields fail the envelope.
    expect(
      (await reflectionFailure(reflect(JSON.stringify({ version: 1, proposals: [], theme: "x" })))).kind,
    ).toBe("malformed-envelope");

    // proposals must be an array.
    expect(
      (await reflectionFailure(reflect(JSON.stringify({ version: 1, proposals: {} })))).kind,
    ).toBe("malformed-envelope");

    // Non-JSON output fails the envelope.
    expect((await reflectionFailure(reflect("not json at all"))).kind).toBe("malformed-envelope");
    expect((await reflectionFailure(reflect(""))).kind).toBe("malformed-envelope");

    // Exactly 32 valid items are all accepted.
    const exact = Array.from({ length: MAX_FACT_PROPOSALS }, () => fact("memory", 0, "long line"));
    const exactOutcome = (await reflect(envelope(exact))) as { proposals: unknown[]; rejections: unknown[] };
    expect(exactOutcome.proposals.length).toBe(MAX_FACT_PROPOSALS);
    expect(exactOutcome.rejections.length).toBe(0);

    // Unknown per-item fields reject the item and retain valid siblings.
    const withUnknown = [{ ...fact("memory", 0, "long line"), confidence: 0.9 }, fact("memory", 0, "long line")];
    const unknownOutcome = (await reflect(envelope(withUnknown))) as {
      proposals: Array<{ lineIndex: number }>;
      rejections: Array<{ itemIndex: number }>;
    };
    expect(unknownOutcome.proposals.length).toBe(1);
    expect(unknownOutcome.rejections.length).toBe(1);
    expect(unknownOutcome.rejections[0]!.itemIndex).toBe(0);

    // Empty item text rejects the item.
    const emptyText = (await reflect(envelope([fact("memory", 0, "")]))) as {
      proposals: unknown[];
      rejections: unknown[];
    };
    expect(emptyText.proposals.length).toBe(0);
    expect(emptyText.rejections.length).toBe(1);

    // Excerpts above 2000 characters reject the item…
    const tooLong = (await reflect(
      envelope([fact("memory", 0, "x".repeat(MAX_FACT_TEXT_CHARS + 1))]),
    )) as { proposals: unknown[]; rejections: unknown[] };
    expect(tooLong.proposals.length).toBe(0);
    expect(tooLong.rejections.length).toBe(1);

    // …while exactly-2000-character contiguous excerpts are accepted.
    const exactLength = (await reflect(
      envelope([fact("memory", 0, "x".repeat(MAX_FACT_TEXT_CHARS))]),
    )) as { proposals: Array<{ text: string }>; rejections: unknown[] };
    expect(exactLength.proposals.length).toBe(1);
    expect(exactLength.proposals[0]!.text.length).toBe(MAX_FACT_TEXT_CHARS);

    // The empty result is a supported outcome.
    const empty = (await engineWith(envelope([])).reflect(reflectionRequest({ lines: [line(0)] }))) as {
      proposals: unknown[];
      rejections: unknown[];
    };
    expect(empty.proposals).toEqual([]);
    expect(empty.rejections).toEqual([]);
  });

  it("deadline-output-cap-cancel-and-late-response-dispose", async () => {
    // Contract pins: the default deadline and output cap are the issue bounds.
    expect(REFLECTION_DEADLINE_MS).toBe(120_000);
    expect(MAX_REFLECTION_OUTPUT_BYTES).toBe(64 * 1024);

    // Deadline: the invocation is aborted and the reflection fails closed.
    {
      const calls: RecordedCall[] = [];
      const invoker: ReflectionModelInvoker = (request) =>
        new Promise<string>((_, reject) => {
          calls.push({
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            signal: request.signal,
          });
          request.signal.addEventListener("abort", () => reject(new Error("provider abort")), { once: true });
        });
      const engine = new ReflectionEngine({ invoker, deadlineMs: 25 });
      const failure = await reflectionFailure(engine.reflect(reflectionRequest()));
      expect(failure.kind).toBe("deadline");
      expect(calls[0]!.signal.aborted).toBe(true);
    }

    // Output cap: a response above 64 KiB fails regardless of content.
    {
      const engine = engineWith("x".repeat(MAX_REFLECTION_OUTPUT_BYTES + 1));
      expect((await reflectionFailure(engine.reflect(reflectionRequest()))).kind).toBe("output-cap");
    }
    // Exactly at the cap is acceptable: valid JSON padded to the boundary.
    {
      const base = envelope([fact("memory", 0, "I live in Madrid")]);
      const padded = base + " ".repeat(MAX_REFLECTION_OUTPUT_BYTES - Buffer.byteLength(base, "utf-8"));
      const outcome = (await engineWith(padded).reflect(reflectionRequest())) as { proposals: unknown[] };
      expect(outcome.proposals.length).toBe(1);
    }

    // Cancellation: the host signal releases the invocation, and a result
    // arriving late is rejected — it changes nothing.
    {
      const deferred = new Deferred<string>();
      let respond: () => Promise<string> | string = () => deferred.promise;
      let observedSignal: AbortSignal | undefined;
      const invoker: ReflectionModelInvoker = (request) => {
        observedSignal = request.signal;
        return Promise.resolve(respond());
      };
      const engine = new ReflectionEngine({ invoker });
      const controller = new AbortController();

      const pending = engine.reflect(reflectionRequest({ signal: controller.signal }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();
      const failure = await reflectionFailure(pending);
      expect(failure.kind).toBe("cancelled");
      expect(observedSignal!.aborted).toBe(true);

      // A late, otherwise-valid result must be rejected: resolve it now.
      deferred.resolve(envelope([fact("memory", 0, "I live in Madrid")]));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The engine stays usable after disposal: fresh invocation, no leaked
      // deadline, buffers, or cancellation state.
      respond = () => envelope([fact("memory", 0, "I live in Madrid")]);
      const again = (await engine.reflect(reflectionRequest())) as { proposals: unknown[] };
      expect(again.proposals.length).toBe(1);
    }
  });

  it("missing-provider-and-provider-failure-have-no-fallback", async () => {
    // Missing provider configuration: no model is selected, no fallback exists.
    const engine = new ReflectionEngine({ config: configWith("openai/gpt-5.4-mini", undefined) });
    const failure = await reflectionFailure(engine.reflect(reflectionRequest()));
    expect(failure.kind).toBe("config-unavailable");
    // The failure names the deployment selection problem; it does not select
    // a substitute.
    expect(failure.message).toContain("OPENAI_API_KEY");
    // Repeated reflection keeps failing closed on the same missing selection.
    expect((await reflectionFailure(engine.reflect(reflectionRequest()))).kind).toBe("config-unavailable");

    // An unknown configured model is the same configuration unavailability.
    const unknown = new ReflectionEngine({ config: configWith("or/no-such/model", "k") });
    expect((await reflectionFailure(unknown.reflect(reflectionRequest()))).kind).toBe("config-unavailable");

    // Provider failure: exactly one attempt is recorded — no retry, no
    // fallback — and the failure carries neither the prompt nor credentials.
    const calls: RecordedCall[] = [];
    const invoker: ReflectionModelInvoker = (request) => {
      calls.push({
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        signal: request.signal,
      });
      throw new Error(`HTTP 503 while sending ${request.userPrompt} with key sk-test-secret`);
    };
    const failingEngine = new ReflectionEngine({ invoker });
    const providerFailure = await reflectionFailure(failingEngine.reflect(reflectionRequest()));
    expect(providerFailure.kind).toBe("provider");
    expect(calls.length).toBe(1);
    expect(providerFailure.message).not.toContain("I live in Madrid");
    expect(providerFailure.message).not.toContain("You live in Madrid.");
    expect(providerFailure.wakeId).toBe(reflectionRequest().wakeId);

    // Credential redaction strips secret material from recorded diagnostics
    // (the production path redacts the deployment API key the same way).
    expect(redactSecrets("token sk-test-secret end", ["sk-test-secret"])).toBe("token [redacted] end");
  });
});
