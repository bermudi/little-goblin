import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog } from "./log.ts";
import { validateModelAtStartup } from "./agent/models.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
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
