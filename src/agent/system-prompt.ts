import { join } from "node:path";
import {
  readOptionalPromptFile,
  readRequiredPromptFile,
  workspacePromptFile,
} from "../workspace/mod.ts";
import type { ExecutionEnvironment } from "../sessions/environment.ts";
import { isProjectEnvironment } from "../sessions/environment.ts";

export const GOBLIN_PRODUCT_SHELL = `## Runtime Mechanics

You are running inside little-goblin, a Telegram-native personal AI agent.

- Treat Telegram as the user interface: keep responses suitable for chat, and use available Telegram/status affordances when the runtime exposes them.
- Be truthful about tool results and uncertainty. Do not claim you ran commands, read files, or changed state unless a tool result confirms it.
- Ask before irreversible or destructive actions. Prefer safe, recoverable operations when possible.
- Treat agent-owned identity, agent-owned operating rules, product mechanics, and project guidance as separate prompt sections with their own scope.
- Memory snapshots arrive as per-turn context asides; use them as current context, but do not treat them as permanent system instructions.
- Every user message is prefixed with \`[From: Name (@username)]\`. This tells you who is speaking. You may be talking to your operator or to a stranger who @mentioned you in a group — address them by their actual name, not by the operator's name.`;

export interface BuildGoblinSystemPromptOptions {
  home: string;
  executionEnvironment: ExecutionEnvironment;
}

/** System prompt value: assembled text plus the provenance of loaded prompt files. */
export class GoblinSystemPrompt {
  /** The assembled system prompt text. */
  readonly prompt: string;
  /** Paths of prompt files that were actually loaded, in order. */
  readonly sources: readonly string[];

  constructor(prompt: string, sources: readonly string[]) {
    this.prompt = prompt;
    this.sources = sources;
  }
}

export async function buildGoblinSystemPrompt(
  opts: BuildGoblinSystemPromptOptions,
): Promise<GoblinSystemPrompt> {
  const soulFile = workspacePromptFile(opts.home, "SOUL.md");
  const agentsFile = workspacePromptFile(opts.home, "AGENTS.md");
  const projectAgentsPath =
    isProjectEnvironment(opts.executionEnvironment)
      ? join(opts.executionEnvironment.projectRoot, "AGENTS.md")
      : undefined;

  const soul = await readRequiredPromptFile(soulFile.path);
  const sources: string[] = [soulFile.path];
  const deploymentAgents = await readOptionalPromptFile(agentsFile.path);
  if (deploymentAgents !== null) {
    sources.push(agentsFile.path);
  }
  const projectAgents =
    projectAgentsPath === undefined ? null : await readOptionalPromptFile(projectAgentsPath);
  if (projectAgentsPath !== undefined && projectAgents !== null) {
    sources.push(projectAgentsPath);
  }

  const prompt = [
    section("Agent Identity and Voice (SOUL.md)", soul),
    deploymentAgents === null
      ? null
      : section("Agent Operating Rules (AGENTS.md)", deploymentAgents),
    GOBLIN_PRODUCT_SHELL,
    projectAgents === null
      ? null
      : section("Project Guidance (projectRoot/AGENTS.md)", projectAgents),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");

  return new GoblinSystemPrompt(prompt, sources);
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trimEnd()}`;
}
