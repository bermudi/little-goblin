#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigFileSchema } from "./schema.ts";
import { agentsMdPath, soulMdPath } from "./pi-host.ts";

const DEFAULT_MODEL = "poe/Claude-Sonnet-4.6";

interface Answers {
  botToken: string;
  userId: number;
  model: string;
  logLevel: "debug" | "info" | "warn" | "error";
  poeApiKey?: string;
  openrouterApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  zaiApiKey?: string;
  agentName?: string;
}

function getEnvDefault(name: string): string | undefined {
  return process.env[name] || undefined;
}

export function parseIdList(raw: string): number[] | undefined {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  const def = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${question}${def}: `);
  return answer.trim() || defaultValue || "";
}

async function promptRequired(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: string): Promise<string> {
  while (true) {
    const answer = await prompt(rl, question, defaultValue);
    if (answer) return answer;
    console.log("Required. Please enter a value.");
  }
}

async function promptNumber(rl: ReturnType<typeof createInterface>, question: string, defaultValue?: number): Promise<number> {
  while (true) {
    const def = defaultValue ? ` (${defaultValue})` : "";
    const answer = await rl.question(`${question}${def}: `);
    const num = Number(answer.trim() || defaultValue);
    if (Number.isInteger(num) && num > 0) return num;
    console.log("Please enter a valid positive integer.");
  }
}

async function promptChoice<T extends string>(rl: ReturnType<typeof createInterface>, question: string, choices: T[], defaultValue: T): Promise<T> {
  while (true) {
    const def = ` (${defaultValue})`;
    const answer = await rl.question(`${question} [${choices.join("/")}]${def}: `);
    const value = (answer.trim() || defaultValue) as T;
    if (choices.includes(value)) return value;
    console.log(`Please choose one of: ${choices.join(", ")}`);
  }
}

async function collectAnswers(): Promise<Answers> {
  const rl = createInterface({ input: stdin, output: stdout });

  // Try to get defaults from .env
  const envToken = getEnvDefault("BOT_TOKEN");
  const envUsers = getEnvDefault("ALLOWED_TG_USER_IDS") ? parseIdList(getEnvDefault("ALLOWED_TG_USER_IDS")!) : undefined;
  const envModel = getEnvDefault("MODEL_NAME");
  const envLogLevel = getEnvDefault("LOG_LEVEL");
  const envPoe = getEnvDefault("POE_API_KEY");
  const envOr = getEnvDefault("OPENROUTER_API_KEY");
  const envOa = getEnvDefault("OPENAI_API_KEY");
  const envAn = getEnvDefault("ANTHROPIC_API_KEY");

  console.log("\n🧙‍♂️  Little Goblin Setup\n");
  console.log("This wizard creates your goblin.json5 config file.\n");
  console.log("Values can be:");
  console.log("  - Literal: \"your-token-here\"");
  console.log("  - Env var: BOT_TOKEN (reads from process.env)");
  console.log("  - Command: \"!pass show bots/goblin\" (runs shell command)\n");

  if (envToken || envUsers || envModel) {
    console.log("📋 Found values in .env — using as defaults.\n");
  }

  const botToken = await promptRequired(rl, "Bot token", envToken);
  const userId = await promptNumber(rl, "Your Telegram user ID (from @userinfobot)", envUsers?.[0]);

  const model = await prompt(rl, "Model", envModel || DEFAULT_MODEL);

  const logLevel = await promptChoice(rl, "Log level", ["debug", "info", "warn", "error"], (envLogLevel as "info") || "info");

  console.log("\n📡 API Keys (optional, supports env var names or !commands):");

  const poeApiKey = await prompt(rl, "  Poe API key", envPoe);
  const openrouterApiKey = await prompt(rl, "  OpenRouter API key", envOr);
  const openaiApiKey = await prompt(rl, "  OpenAI API key", envOa);
  const anthropicApiKey = await prompt(rl, "  Anthropic API key", envAn);
  const zaiApiKey = await prompt(rl, "  Z.AI API key (Coding Plan)", getEnvDefault("ZAI_API_KEY"));
  const agentName = await promptRequired(rl, "Conversational agent name");

  rl.close();

  return {
    botToken,
    userId,
    model,
    logLevel,
    poeApiKey: poeApiKey || undefined,
    openrouterApiKey: openrouterApiKey || undefined,
    openaiApiKey: openaiApiKey || undefined,
    anthropicApiKey: anthropicApiKey || undefined,
    zaiApiKey: zaiApiKey || undefined,
    agentName,
  };
}

export function buildSoulTemplate(agentName: string): string {
  return `# ${agentName}

${agentName} is the deployment-owned conversational identity for this Little Goblin.

## Voice

- Be concise, direct, and useful in Telegram conversations.
- Preserve the operator's preferences and house style here.
- Keep private identity and relationship details in this file, not in source code.
`;
}

export const DEFAULT_AGENTS_TEMPLATE = `# Operating Rules

- Treat Telegram as the primary interface.
- Be truthful about tool use, uncertainty, and state changes.
- Ask before destructive or irreversible actions.
- Keep durable preferences and deployment-specific rules in this file.
`;

export interface PromptFileMigrationResult {
  createdSoul: boolean;
  createdAgents: boolean;
}

export function createMissingPromptFiles(
  home: string,
  agentName: string,
  warn: (message: string) => void = console.warn,
): PromptFileMigrationResult {
  const soulPath = soulMdPath(home);
  const agentsPath = agentsMdPath(home);
  const hasSoul = existsSync(soulPath);
  const hasAgents = existsSync(agentsPath);

  if (!hasSoul && hasAgents) {
    warn(
      "Existing AGENTS.md found without SOUL.md; it may contain old identity or voice content. Creating SOUL.md without copying from AGENTS.md.",
    );
  }

  let createdSoul = false;
  let createdAgents = false;
  mkdirSync(home, { recursive: true });
  if (!hasSoul) {
    writeFileSync(soulPath, buildSoulTemplate(agentName), { flag: "wx" });
    createdSoul = true;
  }
  if (!hasAgents) {
    writeFileSync(agentsPath, DEFAULT_AGENTS_TEMPLATE, { flag: "wx" });
    createdAgents = true;
  }

  return { createdSoul, createdAgents };
}

export function buildConfig(answers: Answers): string {
  const lines: string[] = ["// Generated by little-goblin onboard", "{"];

  lines.push(`  botToken: ${JSON.stringify(answers.botToken)},`);
  lines.push(`  allowedUsers: [${answers.userId}],`);
  lines.push(`  model: ${JSON.stringify(answers.model)},`);
  lines.push(`  logLevel: ${JSON.stringify(answers.logLevel)},`);

  const optionalKeys = ["poeApiKey", "openrouterApiKey", "openaiApiKey", "anthropicApiKey", "zaiApiKey"] as const;
  for (const key of optionalKeys) {
    const value = answers[key];
    if (value) {
      lines.push(`  ${key}: ${JSON.stringify(value)},`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const goblinHome = process.env.GOBLIN_HOME ?? join(homedir(), "goblin");
  const configPath = join(goblinHome, "goblin.json5");
  const soulPath = soulMdPath(goblinHome);
  const needsSoul = !existsSync(soulPath);

  if (existsSync(configPath)) {
    if (needsSoul || !existsSync(agentsMdPath(goblinHome))) {
      const rl = createInterface({ input: stdin, output: stdout });
      const agentName = needsSoul ? await promptRequired(rl, "Conversational agent name") : "Goblin";
      rl.close();
      const result = createMissingPromptFiles(goblinHome, agentName);
      if (result.createdSoul) console.error(`✅ Created ${soulPath}`);
      if (result.createdAgents) console.error(`✅ Created ${agentsMdPath(goblinHome)}`);
    }
    console.error(`❌ Config already exists at ${configPath}`);
    console.error("Run with GOBLIN_HOME set to use a different location, or delete the existing config.");
    process.exit(1);
  }

  const answers = await collectAnswers();
  const configContent = buildConfig(answers);

  // Validate before writing
  const parseResult = ConfigFileSchema.safeParse({
    botToken: answers.botToken,
    allowedUsers: [answers.userId],
    model: answers.model,
    logLevel: answers.logLevel,
    poeApiKey: answers.poeApiKey,
    openrouterApiKey: answers.openrouterApiKey,
    openaiApiKey: answers.openaiApiKey,
    anthropicApiKey: answers.anthropicApiKey,
    zaiApiKey: answers.zaiApiKey,
  });

  if (!parseResult.success) {
    console.error("\n❌ Config validation failed:");
    for (const issue of parseResult.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  // Show preview
  console.log("\n📄 Preview of goblin.json5:");
  console.log("─".repeat(40));
  console.log(configContent);
  console.log("─".repeat(40));

  // Ensure directory exists and write
  mkdirSync(goblinHome, { recursive: true });
  writeFileSync(configPath, configContent + "\n");
  const promptResult = createMissingPromptFiles(goblinHome, answers.agentName ?? "Goblin");

  console.log(`\n✅ Created ${configPath}`);
  if (promptResult.createdSoul) console.log(`✅ Created ${soulMdPath(goblinHome)}`);
  if (promptResult.createdAgents) console.log(`✅ Created ${agentsMdPath(goblinHome)}`);
  console.log("\nNext steps:");
  console.log(`  1. Review the config: cat ${configPath}`);
  console.log(`  2. Start the bot: bun run src/index.ts`);
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
