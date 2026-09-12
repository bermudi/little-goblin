/**
 * Isolated extractive reflection boundary for private reflection (issue #67,
 * decision 0035, `specs/inner-life/spec.md`).
 *
 * One invocation sends ONLY code-owned private-facts profile instructions and
 * the wake's captured input to the deployment's existing configured model, and
 * returns mechanically validated fact proposals or per-item rejections. The
 * boundary is tool-free, history-free, prompt-file/skill-free, and has no
 * Telegram destination: it cannot read conversation history, workspace
 * prompts, skills, or MCP config, and never constructs a Pi session, Surface,
 * Conversation, or Execution Environment.
 *
 * Validation is mechanical source support only: a proposal is accepted when
 * its text is a nonempty contiguous verbatim excerpt of one cited user-role
 * line inside the captured input. Truth and classification remain model
 * judgment for downstream memory policy (unit "Commit replay-safe memory
 * effects"); this module claims neither.
 *
 * Bounds (issue contract): 120-second deadline per invocation, 64 KiB output
 * cap, 32 proposals, 2,000 characters per excerpt. Malformed envelopes fail
 * the whole reflection; invalid individual proposals are recorded as bounded
 * rejections while valid siblings remain eligible. Provider failures are
 * recorded without raw prompts or credentials. Unavailable configuration
 * fails closed — there is no fallback model selection.
 *
 * This unit returns validated proposals only; it applies no memory and wires
 * no timers. Orchestration, attempt budgeting, and persistence belong to the
 * inner-life host and the wake store.
 */

import { z } from "zod";
import { contentText } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "../config.ts";
import { resolveModel, type ResolvedModel } from "../agent/models.ts";
import { boundedError, log } from "../log.ts";
import { validateWakeId } from "./paths.ts";
import { PRIVATE_FACTS_PROFILE, type WakeInputLine, type WakeProfile } from "./wake-store.ts";

// ---------------------------------------------------------------------------
// Bounds and constants
// ---------------------------------------------------------------------------

/** Version of the strict reflection output envelope. */
export const REFLECTION_OUTPUT_VERSION = 1;

/** Model output cap: 64 KiB for one reflection response. */
export const MAX_REFLECTION_OUTPUT_BYTES = 64 * 1024;

/** Default deadline for one reflection invocation: 120 seconds. */
export const REFLECTION_DEADLINE_MS = 120_000;

/** Maximum number of fact proposals in one accepted envelope. */
export const MAX_FACT_PROPOSALS = 32;

/** Maximum length of one accepted fact excerpt, in characters. */
export const MAX_FACT_TEXT_CHARS = 2000;

/** Bounded per-item rejection reasons. */
export const MAX_REFLECTION_REJECTION_CHARS = 300;

/** Bounded error detail carried by ReflectionError diagnostics. */
export const MAX_REFLECTION_ERROR_DETAIL_CHARS = 512;

/**
 * The only system instructions a private-facts reflection may receive. This
 * constant is the code-owned profile authority: the boundary sends exactly
 * this text and nothing else from the deployment, workspace, or history.
 */
export const PRIVATE_REFLECTION_SYSTEM_PROMPT = `You are the private reflection pass of a personal assistant. You extract durable facts the user explicitly stated, from the transcript excerpt you are given. You propose nothing else.

Rules:
- Propose only facts the user explicitly stated in their own messages. Never paraphrase, complete, or infer wording.
- Only lines marked "user" may be cited. Never cite assistant or tool lines.
- Each proposal copies one contiguous verbatim excerpt of exactly one cited user line into "text".
- "line" is the bracketed index of the cited line.
- "target" is "memory" for general durable facts, or "user" for user preferences and communication style. No other targets exist.
- When in doubt, propose nothing: return an empty proposals array.
- Output at most 32 proposals.

Respond with ONLY a JSON object in exactly this shape and nothing else:
{"version":1,"proposals":[{"kind":"fact","target":"memory","line":0,"text":"verbatim excerpt"}]}
`;

// ---------------------------------------------------------------------------
// Outcome and failure types
// ---------------------------------------------------------------------------

/** Eligible memory targets for the private-facts profile. */
export type ReflectionFactTarget = "memory" | "user";

/** One mechanically validated fact proposal: an excerpt of one cited user line. */
export interface AcceptedFactProposal {
  readonly target: ReflectionFactTarget;
  /** Index of the cited user line inside the captured wake input. */
  readonly lineIndex: number;
  /** Verbatim contiguous excerpt of the cited line. */
  readonly text: string;
}

/** One rejected envelope item, with a bounded reason. */
export interface RejectedProposal {
  readonly itemIndex: number;
  readonly reason: string;
}

export interface ReflectionOutcome {
  readonly proposals: readonly AcceptedFactProposal[];
  readonly rejections: readonly RejectedProposal[];
}

export type ReflectionFailureKind =
  | "unsupported-profile"
  | "config-unavailable"
  | "provider"
  | "deadline"
  | "cancelled"
  | "output-cap"
  | "malformed-envelope";

/** Bounded, wake-identity-bearing reflection failure. */
export class ReflectionError extends Error {
  readonly kind: ReflectionFailureKind;
  readonly wakeId: string;

  constructor(kind: ReflectionFailureKind, wakeId: string, detail: string, options?: { cause?: unknown }) {
    super(`Reflection ${kind} for ${wakeId}: ${detail.slice(0, MAX_REFLECTION_ERROR_DETAIL_CHARS)}`, options);
    this.name = "ReflectionError";
    this.kind = kind;
    this.wakeId = wakeId;
  }
}

/**
 * Redact secret material (prompts, credentials) from a diagnostic string.
 * Exported for deterministic verification; the engine uses it for every
 * provider-failure detail it records.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Model invocation seam
// ---------------------------------------------------------------------------

/** Everything the model boundary receives for one invocation. */
export interface ReflectionModelRequest {
  /** Code-owned private-facts instructions (`PRIVATE_REFLECTION_SYSTEM_PROMPT`). */
  readonly systemPrompt: string;
  /** The captured wake input, formatted with line indexes and roles. */
  readonly userPrompt: string;
  /** Aborted on deadline, host cancellation, and release after completion. */
  readonly signal: AbortSignal;
}

/**
 * Deterministic model seam. Production uses the deployment's existing
 * configured model via pi-ai; tests inject fakes so verification never makes
 * a live provider call.
 */
export type ReflectionModelInvoker = (request: ReflectionModelRequest) => Promise<string>;

// ---------------------------------------------------------------------------
// Output envelope validation
// ---------------------------------------------------------------------------

const reflectionEnvelopeSchema = z.object({
  version: z.literal(REFLECTION_OUTPUT_VERSION),
  proposals: z.array(z.unknown()).max(MAX_FACT_PROPOSALS),
}).strict();

const reflectionProposalItemSchema = z.object({
  kind: z.literal("fact"),
  target: z.enum(["memory", "user"]),
  line: z.number().int().min(0),
  text: z.string().min(1).max(MAX_FACT_TEXT_CHARS),
}).strict();

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const location = i.path.length > 0 ? i.path.join(".") : "output";
      return `${location}: ${i.message}`;
    })
    .join("; ")
    .slice(0, MAX_REFLECTION_REJECTION_CHARS);
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_REFLECTION_REJECTION_CHARS);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReflectionRequest {
  /** Durable wake identity; carried into every diagnostic. */
  readonly wakeId: string;
  /** The wake's code-selected capability profile; only private-facts/v1. */
  readonly profile: WakeProfile;
  /** The wake's captured, immutable transcript input. */
  readonly lines: readonly WakeInputLine[];
  /** Optional host cancellation signal (shutdown fencing). */
  readonly signal?: AbortSignal;
}

export interface ReflectionEngineOptions {
  /**
   * Deterministic invoker seam for tests. Mutually exclusive with `config`.
   */
  readonly invoker?: ReflectionModelInvoker;
  /**
   * Production configuration: the model is the deployment's existing
   * operator-selected `MODEL_NAME` via `resolveModel`; no other selection or
   * fallback exists.
   */
  readonly config?: Config;
  /** Invocation deadline. Defaults to the 120-second contract bound. */
  readonly deadlineMs?: number;
}

/**
 * Tool-free, history-free reflection boundary. Stateless between invocations:
 * concurrent wakes build fresh prompts and buffers and never share capture
 * state. Invalid envelopes fail the reflection; invalid items become recorded
 * rejections while valid siblings survive.
 */
export class ReflectionEngine {
  private readonly injectedInvoker: ReflectionModelInvoker | undefined;
  private readonly config: Config | undefined;
  private readonly deadlineMs: number;
  private cachedInvoker: ReflectionModelInvoker | null = null;
  private configuredApiKey: string | undefined;

  constructor(options: ReflectionEngineOptions) {
    if ((options.invoker !== undefined) === (options.config !== undefined)) {
      throw new Error("ReflectionEngine requires exactly one of invoker or config");
    }
    this.injectedInvoker = options.invoker;
    this.config = options.config;
    this.deadlineMs = options.deadlineMs ?? REFLECTION_DEADLINE_MS;
  }

  /**
   * Run one isolated reflection. Resolves with validated proposals and
   * per-item rejections, or throws ReflectionError with a bounded failure
   * kind. Late model results after deadline, cancellation, or completion are
   * rejected: they are never adopted.
   */
  async reflect(request: ReflectionRequest): Promise<ReflectionOutcome> {
    validateWakeId(request.wakeId);
    if (
      request.profile.id !== PRIVATE_FACTS_PROFILE.id ||
      request.profile.version !== PRIVATE_FACTS_PROFILE.version
    ) {
      throw new ReflectionError(
        "unsupported-profile",
        request.wakeId,
        `profile ${request.profile.id}/v${request.profile.version} is not eligible for private reflection`,
      );
    }

    const external = request.signal;
    // Shutdown fencing passes host signals that are already aborted before
    // the reflection starts. A DOM AbortSignal never replays its abort event,
    // so a pre-start abort must fail fast here — before any model invocation
    // — instead of relying on listener registration order downstream.
    if (external?.aborted) {
      throw new ReflectionError("cancelled", request.wakeId, "cancelled before the model invocation");
    }

    const controller = new AbortController();
    let deadlineHit = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      deadlineHit = true;
      controller.abort();
    }, this.deadlineMs);

    const onExternalAbort = (): void => controller.abort();
    if (external !== undefined) {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }

    const invocation = this.invokeModel(request, controller.signal);
    // Aborting settles the race with the correct failure kind computed at
    // abort time — deadline and external cancellation are distinguishable
    // regardless of which underlying rejection is observed first.
    const abortFailure = (): ReflectionError =>
      deadlineHit
        ? new ReflectionError("deadline", request.wakeId, `invocation exceeded the ${this.deadlineMs}ms deadline`)
        : new ReflectionError("cancelled", request.wakeId, "cancelled before completion");
    const abortPromise = new Promise<never>((_, reject) => {
      // Cancellation settlement is independent of event replay: reject
      // immediately when the signal aborted before this listener registered.
      if (controller.signal.aborted) {
        reject(abortFailure());
        return;
      }
      controller.signal.addEventListener("abort", () => reject(abortFailure()), { once: true });
    });

    try {
      const output = await Promise.race([invocation, abortPromise]);
      return this.parseOutput(output, request);
    } catch (err) {
      throw this.classify(err, request, deadlineHit);
    } finally {
      clearTimeout(timer);
      if (external !== undefined) external.removeEventListener("abort", onExternalAbort);
      // Release invocation resources on completion, failure, and cancellation
      // alike: nothing downstream may keep streaming against this signal.
      controller.abort();
      // Reject late results: whatever the invocation settles with after this
      // point is discarded, never adopted, and can never crash the host.
      void invocation.then(
        () => {
          log.debug("ignored late reflection output", { wakeId: request.wakeId });
        },
        (err: unknown) => {
          log.debug("discarded late reflection failure", { wakeId: request.wakeId, ...boundedError(err) });
        },
      );
    }
  }

  // -------------------------------------------------------------------------

  private async invokeModel(request: ReflectionRequest, signal: AbortSignal): Promise<string> {
    const invoker = this.resolvedInvoker(request.wakeId);
    return invoker({
      systemPrompt: PRIVATE_REFLECTION_SYSTEM_PROMPT,
      userPrompt: buildReflectionUserPrompt(request.lines),
      signal,
    });
  }

  /**
   * The invoker for this invocation: the injected seam, or the deployment's
   * existing configured model. Resolution failure is configuration
   * unavailability — the same single selection is retried, never replaced by
   * a fallback model.
   */
  private resolvedInvoker(wakeId: string): ReflectionModelInvoker {
    if (this.injectedInvoker !== undefined) return this.injectedInvoker;
    if (this.cachedInvoker !== null) return this.cachedInvoker;

    const config = this.config;
    if (config === undefined) {
      throw new ReflectionError("config-unavailable", wakeId, "no model configuration available");
    }
    let resolved: ResolvedModel;
    try {
      resolved = resolveModel(config);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ReflectionError("config-unavailable", wakeId, detail, { cause: err });
    }

    // The configured selection is held once, not re-derived per wake; the
    // deployment's MODEL_NAME and key are the only authority, with no
    // fallback.
    this.configuredApiKey = resolved.apiKey;
    const models = builtinModels();
    const model = resolved.model;
    const apiKey = resolved.apiKey;
    this.cachedInvoker = (modelRequest) =>
      models
        .completeSimple(
          model,
          {
            systemPrompt: modelRequest.systemPrompt,
            messages: [{ role: "user", content: modelRequest.userPrompt, timestamp: Date.now() }],
          },
          { apiKey, signal: modelRequest.signal },
        )
        .then((message) => contentText(message.content));
    return this.cachedInvoker;
  }

  private classify(err: unknown, request: ReflectionRequest, deadlineHit: boolean): ReflectionError {
    if (err instanceof ReflectionError) return err;
    if (deadlineHit) {
      return new ReflectionError(
        "deadline",
        request.wakeId,
        `invocation exceeded the ${this.deadlineMs}ms deadline`,
        { cause: err },
      );
    }
    if (request.signal?.aborted) {
      return new ReflectionError("cancelled", request.wakeId, "cancelled before completion", { cause: err });
    }
    // Provider failure: recorded without raw prompts or credentials.
    const userPrompt = buildReflectionUserPrompt(request.lines);
    const secrets = [PRIVATE_REFLECTION_SYSTEM_PROMPT, userPrompt];
    if (this.configuredApiKey !== undefined) secrets.push(this.configuredApiKey);
    const detail = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    return new ReflectionError("provider", request.wakeId, detail, { cause: err });
  }

  private parseOutput(raw: string, request: ReflectionRequest): ReflectionOutcome {
    const outputBytes = Buffer.byteLength(raw, "utf-8");
    if (outputBytes > MAX_REFLECTION_OUTPUT_BYTES) {
      throw new ReflectionError(
        "output-cap",
        request.wakeId,
        `model output is ${outputBytes} bytes, above the ${MAX_REFLECTION_OUTPUT_BYTES}-byte cap`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      throw new ReflectionError("malformed-envelope", request.wakeId, "output is not valid JSON");
    }
    const envelope = reflectionEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new ReflectionError("malformed-envelope", request.wakeId, formatIssues(envelope.error));
    }

    const proposals: AcceptedFactProposal[] = [];
    const rejections: RejectedProposal[] = [];
    for (const [itemIndex, item] of envelope.data.proposals.entries()) {
      const itemParsed = reflectionProposalItemSchema.safeParse(item);
      if (!itemParsed.success) {
        rejections.push({
          itemIndex,
          reason: boundedReason(`not a supported fact proposal: ${formatIssues(itemParsed.error)}`),
        });
        continue;
      }
      const { target, line, text } = itemParsed.data;
      const cited = request.lines.find((candidate) => candidate.index === line);
      if (cited === undefined) {
        rejections.push({
          itemIndex,
          reason: boundedReason(`cited line ${line} is outside the captured input`),
        });
        continue;
      }
      if (cited.role !== "user") {
        rejections.push({
          itemIndex,
          reason: boundedReason(`cited line ${line} is role ${cited.role}; only user lines are eligible`),
        });
        continue;
      }
      if (!cited.text.includes(text)) {
        rejections.push({
          itemIndex,
          reason: boundedReason(`text is not a verbatim excerpt of cited line ${line}`),
        });
        continue;
      }
      proposals.push({ target, lineIndex: line, text });
    }
    return { proposals, rejections };
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * The user prompt is the captured wake input and nothing else: bracketed line
 * indexes, roles, and text. No wake id, conversation identity, event
 * timestamps, surface ids, or workspace content.
 */
function buildReflectionUserPrompt(lines: readonly WakeInputLine[]): string {
  const formatted = lines.map((l) => `[${l.index}] ${l.role}: ${l.text}`).join("\n");
  return `Transcript excerpt:\n${formatted}`;
}
