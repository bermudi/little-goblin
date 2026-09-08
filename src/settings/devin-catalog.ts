import { execFile, type ExecFileException } from "node:child_process";
import { z } from "zod";
import { prepareEnv } from "../external-agents/env.ts";
import { log } from "../log.ts";

// Catalog discovery has a short request lifetime. These are NOT execution limits.
const DISCOVERY_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const identity = z.string().min(1).refine(value => value.trim() === value);
const text = z.string().min(1);
const variantSchema = z.object({
  model_uid: identity,
  label: text,
  max_context_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  cost_tier: text.optional(),
  cost_summary: text.optional(),
  description: text.optional(),
  is_new: z.boolean(),
  is_beta: z.boolean(),
});
const catalogSchema = z.object({
  families: z.array(z.object({
    family_uid: identity,
    slug: identity,
    family_label: text,
    aliases: z.array(identity),
    variants: z.array(variantSchema).min(1),
  })).min(1),
}).superRefine((catalog, ctx) => {
  const families = new Set<string>();
  const slugs = new Set<string>();
  const variants = new Set<string>();
  for (const family of catalog.families) {
    if (families.has(family.family_uid) || slugs.has(family.slug)) {
      ctx.addIssue({ code: "custom", message: "duplicate family identity" });
    }
    families.add(family.family_uid);
    slugs.add(family.slug);
    for (const variant of family.variants) {
      if (variants.has(variant.model_uid)) {
        ctx.addIssue({ code: "custom", message: "duplicate variant identity" });
      }
      variants.add(variant.model_uid);
    }
  }
});

export interface DevinModelVariant {
  id: string;
  label: string;
  contextTokens?: number;
  outputTokens?: number;
  costTier?: string;
  costSummary?: string;
  description?: string;
  isNew: boolean;
  isBeta: boolean;
}

export interface DevinModelCatalog {
  families: {
    id: string;
    slug: string;
    label: string;
    aliases: string[];
    variants: DevinModelVariant[];
  }[];
}

export type CatalogFailureReason =
  | "invalid-options"
  | "unavailable"
  | "process-failed"
  | "output-limit"
  | "timeout"
  | "cancelled"
  | "invalid-catalog";

/** Safe for callers to display; raw provider output never becomes an error cause. */
export class CatalogDiscoveryError extends Error {
  constructor(
    readonly reason: CatalogFailureReason,
    readonly exitCode?: number,
  ) {
    super(`Devin model discovery failed: ${reason}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`);
    this.name = "CatalogDiscoveryError";
  }
}

export interface CatalogDiscoveryOptions {
  /** Internal process-boundary injection, never a model-facing launch option. */
  command?: readonly [string, ...string[]];
  /** Tests may tighten, but not remove or widen, the production bounds. */
  timeoutMs?: number;
  maxBufferBytes?: number;
  signal?: AbortSignal;
}

const optionsSchema = z.object({
  command: z.tuple([text]).rest(text).default(["devin"]),
  timeoutMs: z.number().int().min(1).max(DISCOVERY_TIMEOUT_MS).default(DISCOVERY_TIMEOUT_MS),
  maxBufferBytes: z.number().int().min(1).max(OUTPUT_LIMIT_BYTES).default(OUTPUT_LIMIT_BYTES),
  signal: z.instanceof(AbortSignal).optional(),
});

function classifyProcessError(error: ExecFileException, signal?: AbortSignal): CatalogDiscoveryError {
  if (signal?.aborted || error.code === "ABORT_ERR") return new CatalogDiscoveryError("cancelled");
  if (error.code === "ENOENT") return new CatalogDiscoveryError("unavailable");
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new CatalogDiscoveryError("output-limit");
  if (error.killed && error.signal === "SIGKILL") return new CatalogDiscoveryError("timeout");
  return new CatalogDiscoveryError("process-failed", typeof error.code === "number" ? error.code : undefined);
}

function readCatalogProcess(options: z.infer<typeof optionsSchema>): Promise<string> {
  return new Promise((resolve, reject) => {
    let result: { error: ExecFileException | null; stdout: string } | undefined;
    const [executable, ...prefix] = options.command;
    const child = execFile(executable, [...prefix, "models", "list", "--format", "json"], {
      encoding: "utf8",
      env: prepareEnv(),
      timeout: options.timeoutMs,
      maxBuffer: options.maxBufferBytes,
      signal: options.signal,
      // This is a read-only CLI query, not a resumable agent session.
      killSignal: "SIGKILL",
      shell: false,
    }, (error, stdout) => {
      result = { error, stdout };
    });
    // Abort callbacks can precede process exit. Do not settle until close has
    // reaped the child and closed its pipes (also emitted on spawn failure).
    child.once("close", () => {
      if (result === undefined) {
        reject(new CatalogDiscoveryError("process-failed"));
      } else if (result.error !== null) {
        reject(classifyProcessError(result.error, options.signal));
      } else {
        resolve(result.stdout);
      }
    });
    child.stdin?.end();
  });
}

function parseCatalog(raw: string): DevinModelCatalog {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    // Parser messages can quote the input; never forward them.
    throw new CatalogDiscoveryError("invalid-catalog");
  }
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) throw new CatalogDiscoveryError("invalid-catalog");
  return {
    families: parsed.data.families.map(family => ({
      id: family.family_uid,
      slug: family.slug,
      label: family.family_label,
      aliases: family.aliases,
      variants: family.variants.map(variant => ({
        id: variant.model_uid,
        label: variant.label,
        ...(variant.max_context_tokens === undefined ? {} : { contextTokens: variant.max_context_tokens }),
        ...(variant.max_output_tokens === undefined ? {} : { outputTokens: variant.max_output_tokens }),
        ...(variant.cost_tier === undefined ? {} : { costTier: variant.cost_tier }),
        ...(variant.cost_summary === undefined ? {} : { costSummary: variant.cost_summary }),
        ...(variant.description === undefined ? {} : { description: variant.description }),
        isNew: variant.is_new,
        isBeta: variant.is_beta,
      })),
    })),
  };
}

/**
 * One request owns its child and returned snapshot. No global cache, durable
 * state, model selection, or AI inference. Independent calls cancel separately.
 */
export async function discoverDevinCatalog(options: CatalogDiscoveryOptions = {}): Promise<DevinModelCatalog> {
  const started = performance.now();
  log.info("Devin catalog discovery started");
  try {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) throw new CatalogDiscoveryError("invalid-options");
    if (parsed.data.signal?.aborted) throw new CatalogDiscoveryError("cancelled");
    const catalog = parseCatalog(await readCatalogProcess(parsed.data));
    log.info("Devin catalog discovery completed", {
      families: catalog.families.length,
      variants: catalog.families.reduce((count, family) => count + family.variants.length, 0),
      elapsedMs: Math.round(performance.now() - started),
    });
    return catalog;
  } catch (error: unknown) {
    // Unknown failures remain failures, but cannot smuggle argv/output into logs.
    const failure = error instanceof CatalogDiscoveryError
      ? error
      : new CatalogDiscoveryError("process-failed");
    log.warn("Devin catalog discovery failed", {
      reason: failure.reason,
      exitCode: failure.exitCode,
      elapsedMs: Math.round(performance.now() - started),
    });
    throw failure;
  }
}
