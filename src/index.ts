import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog } from "./log.ts";
import { validateModelAtStartup } from "./agent/poe-validate.ts";
import { preflightGoblinPromptFiles } from "./agent/system-prompt.ts";
import { assertEdgeTtsAvailable, resolveVoiceName } from "./voice.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  await preflightGoblinPromptFiles({ home: cfg.goblinHome, warn: log.warn });
  await validateModelAtStartup(cfg, log);
  const { bot, manager, subagentRunner, agentRunners } = buildBot(cfg);
  manager.init();

  // Graceful shutdown. grammy's start() resolves when stop() is called.
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, stopping bot`);
    // Dispose subagents first (cancels running ones, releases sessions).
    await subagentRunner.dispose();
    // Dispose agent runners (releases pi sessions).
    for (const runner of agentRunners.values()) {
      runner.dispose();
    }
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log.info("little-goblin starting", {
    goblinHome: cfg.goblinHome,
    allowedUsers: cfg.allowedTgUserIds.size,
    model: cfg.modelName,
  });

  try {
    await assertEdgeTtsAvailable();
  } catch (err) {
    log.warn("voice check failed; /voice may fail at runtime", {
      voice: resolveVoiceName(),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Long-polling. No webhook, no inbound ports.
  await bot.start({
    onStart: (me) => {
      log.info(`bot online as @${me.username} (id ${me.id})`);
    },
  });
}

main().catch((err) => {
  log.error("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
