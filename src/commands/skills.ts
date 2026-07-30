import { parseCommandArg } from "./parse.ts";
import {
  isValidSkillName,
  normalizeSelectedNames,
  type ResolvedSkillDiagnostic,
  type SkillPolicy,
  type SkillSource,
  type SourceSelection,
} from "../agent/skills/mod.ts";
import type {
  SkillPolicyStatus,
  SkillPolicyTransition,
} from "../orchestration/conversation-lifecycle.ts";

export type SkillsCommandIntent =
  | { kind: "inspect" }
  | { kind: "reload" }
  | { kind: "set"; source: SkillSource; selection: SourceSelection };

export class SkillsCommandSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsCommandSyntaxError";
  }
}

const SOURCES: readonly SkillSource[] = ["goblin", "environment", "host"];

function isSkillSource(value: string): value is SkillSource {
  return SOURCES.includes(value as SkillSource);
}

/** Parse the deliberately narrow `/skills` grammar without touching state. */
export function parseSkillsCommand(rawText: string): SkillsCommandIntent {
  const arg = parseCommandArg(rawText);
  if (arg === "") return { kind: "inspect" };

  const tokens = arg.split(/\s+/u);
  if (tokens.length === 1 && tokens[0] === "reload") return { kind: "reload" };
  const sourceToken = tokens[0];
  if (tokens.length < 2 || sourceToken === undefined || !isSkillSource(sourceToken)) {
    throw new SkillsCommandSyntaxError(
      "Usage: /skills [reload|<goblin|environment|host> all|none|only <name> ...]",
    );
  }

  const source = sourceToken;
  const mode = tokens[1];
  if (mode === "all" || mode === "none") {
    if (tokens.length !== 2) {
      throw new SkillsCommandSyntaxError(`Usage: /skills ${source} ${mode}`);
    }
    return { kind: "set", source, selection: { mode } };
  }

  if (mode !== "only" || tokens.length < 3) {
    throw new SkillsCommandSyntaxError(
      `Usage: /skills ${source} all|none|only <skill-name> ...`,
    );
  }

  const rawNames = tokens.slice(2);
  for (const name of rawNames) {
    if (!isValidSkillName(name)) {
      throw new SkillsCommandSyntaxError(`Invalid skill name: ${JSON.stringify(name)}`);
    }
  }
  const names = normalizeSelectedNames(source, rawNames);
  if (names.length === 0) {
    throw new SkillsCommandSyntaxError(`Usage: /skills ${source} only <skill-name> ...`);
  }
  return { kind: "set", source, selection: { mode: "selected", names } };
}

function formatSelection(selection: SourceSelection): string {
  return selection.mode === "selected"
    ? `selected (${selection.names.join(", ")})`
    : selection.mode;
}

function formatPolicy(policy: SkillPolicy): string {
  return [
    `  goblin: ${formatSelection(policy.goblin)}`,
    `  environment: ${formatSelection(policy.environment)}`,
    `  host: ${formatSelection(policy.host)}`,
  ].join("\n");
}

function formatDiagnostic(diagnostic: ResolvedSkillDiagnostic): string {
  return `  [${diagnostic.source}] ${diagnostic.code}: ${diagnostic.message} (${diagnostic.path})`;
}

/** Format a bounded, source-qualified status report for Telegram. */
export function formatSkillsStatus(
  status: SkillPolicyStatus,
  prefix = "",
  maxChars = 3800,
): string {
  const lines = [
    prefix,
    "Skill policy:",
    formatPolicy(status.policy),
    "",
    "Resolved skills:",
  ];
  if (status.resolvedSkills.skills.length === 0) {
    lines.push("  (none)");
  } else {
    for (const skill of status.resolvedSkills.skills) {
      lines.push(`  [${skill.source}] ${skill.name} — ${skill.filePath}`);
    }
  }

  if (status.resolvedSkills.diagnostics.length > 0) {
    lines.push("", "Catalog diagnostics:");
    for (const diagnostic of status.resolvedSkills.diagnostics) {
      lines.push(formatDiagnostic(diagnostic));
    }
  }

  const text = lines.filter((line, index) => !(index === 0 && line === "")).join("\n");
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  const marker = "\n… (status truncated)";
  if (limit <= marker.length) return marker.slice(0, limit);
  return `${text.slice(0, limit - marker.length)}${marker}`;
}

export function formatSkillsTransition(
  intent: Exclude<SkillsCommandIntent, { kind: "inspect" }>,
  result: SkillPolicyTransition,
): string {
  const action = intent.kind === "reload" ? "Skills reloaded." : "Skill policy updated.";
  const runtime = result.runtime === "invalidated"
    ? "The current runtime will be rebuilt on the next turn."
    : "No active runtime was present.";
  const cleanup = result.cleanupError
    ? ` Runtime cleanup reported an error after invalidation: ${result.cleanupError}`
    : "";
  return formatSkillsStatus(result, `${action} ${runtime}${cleanup}`);
}