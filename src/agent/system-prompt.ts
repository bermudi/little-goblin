import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsMdPath, soulMdPath } from "../pi-host.ts";

export const GOBLIN_PRODUCT_SHELL = `## Runtime Mechanics

You are running inside little-goblin, a Telegram-native personal AI agent.

- Treat Telegram as the user interface: keep responses suitable for chat, and use available Telegram/status affordances when the runtime exposes them.
- Be truthful about tool results and uncertainty. Do not claim you ran commands, read files, or changed state unless a tool result confirms it.
- Ask before irreversible or destructive actions. Prefer safe, recoverable operations when possible.
- Treat deployment identity, deployment operating rules, product mechanics, and project guidance as separate prompt sections with their own scope.
- Memory snapshots arrive as per-turn context asides; use them as current context, but do not treat them as permanent system instructions.
- Every user message is prefixed with \`[From: Name (@username)]\`. This tells you who is speaking. You may be talking to your operator or to a stranger who @mentioned you in a group — address them by their actual name, not by the operator's name.`;

export class MissingSoulError extends Error {
  readonly code = "GOBLIN_MISSING_SOUL";
  readonly path: string;

  constructor(path: string) {
    super(
      `Missing required Goblin prompt file: ${path}. Run onboarding or create SOUL.md in $GOBLIN_HOME.`,
    );
    this.name = "MissingSoulError";
    this.path = path;
  }
}

export interface BuildGoblinSystemPromptOptions {
  home: string;
  projectDir?: string;
}

export async function buildGoblinSystemPrompt(
  opts: BuildGoblinSystemPromptOptions,
): Promise<string> {
  const soulPath = soulMdPath(opts.home);
  const deploymentAgentsPath = agentsMdPath(opts.home);
  const projectAgentsPath =
    opts.projectDir === undefined ? undefined : join(opts.projectDir, "AGENTS.md");

  const soul = await readRequiredSoul(soulPath);
  const deploymentAgents = await readOptionalPromptFile(deploymentAgentsPath);
  const projectAgents =
    projectAgentsPath === undefined ? null : await readOptionalPromptFile(projectAgentsPath);

  return [
    section("Deployment Identity and Voice (SOUL.md)", soul),
    deploymentAgents === null
      ? null
      : section("Deployment Operating Rules (AGENTS.md)", deploymentAgents),
    GOBLIN_PRODUCT_SHELL,
    projectAgents === null
      ? null
      : section("Project Guidance (projectDir/AGENTS.md)", projectAgents),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

export interface PreflightGoblinPromptFilesOptions {
  home: string;
  warn: (message: string, extra?: unknown) => void;
}

export async function preflightGoblinPromptFiles(
  opts: PreflightGoblinPromptFilesOptions,
): Promise<void> {
  const soulPath = soulMdPath(opts.home);
  const deploymentAgentsPath = agentsMdPath(opts.home);

  try {
    await access(soulPath);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new MissingSoulError(soulPath);
    }
    throw err;
  }

  try {
    await access(deploymentAgentsPath);
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      opts.warn("optional Goblin prompt file missing", {
        path: deploymentAgentsPath,
        note: "Create AGENTS.md in $GOBLIN_HOME for deployment operating rules.",
      });
      return;
    }
    throw err;
  }
}

async function readRequiredSoul(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      throw new MissingSoulError(path);
    }
    throw err;
  }
}

async function readOptionalPromptFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trimEnd()}`;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
