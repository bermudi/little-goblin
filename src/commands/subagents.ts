import type { SubagentInfo } from "../subagents/mod.ts";

export const NO_SUBAGENTS_REPLY = "No subagents tracked.";
export const CANCEL_SUBAGENT_USAGE_REPLY = "Usage: /cancel_subagent <id>";
export const REVIVE_SUBAGENT_USAGE_REPLY = "Usage: /revive <id> <prompt>";

export interface ReviveSubagentArgs {
  id: string;
  prompt: string;
}

function commandRemainder(rawText: string): string {
  const trimmed = rawText.trim();
  const firstSpace = trimmed.search(/\s/u);
  return firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
}

export function parseSubagentId(rawText: string): string | null {
  const remainder = commandRemainder(rawText);
  const [id] = remainder.split(/\s+/u);
  return id && id.length > 0 ? id : null;
}

export function parseReviveSubagentArgs(rawText: string): ReviveSubagentArgs | null {
  const remainder = commandRemainder(rawText);
  if (remainder === "") return null;

  const firstSpace = remainder.search(/\s/u);
  if (firstSpace === -1) return null;

  const id = remainder.slice(0, firstSpace);
  const prompt = remainder.slice(firstSpace).trim();
  return prompt === "" ? null : { id, prompt };
}

function formatSubagentLine(info: SubagentInfo): string {
  const name = info.name === null ? "" : ` (${info.name})`;
  const spawnedBy = info.spawnedBy === null ? "" : `, spawned by ${info.spawnedBy}`;
  return `- ${info.id}${name} — ${info.status} ${info.role}, spawned ${info.spawnedAt}${spawnedBy}`;
}

export function formatSubagentsList(infos: readonly SubagentInfo[]): string {
  if (infos.length === 0) return NO_SUBAGENTS_REPLY;
  return `Tracked subagents:\n${infos.map(formatSubagentLine).join("\n")}`;
}
