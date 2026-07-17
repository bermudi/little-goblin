import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog } from "./log.ts";
import { validateModelAtStartup } from "./agent/poe-validate.ts";
import { assertEdgeTtsAvailable, resolveVoiceName } from "./voice.ts";
import { syncTelegramMenu } from "./commands/registry.ts";
import { SchedulerLoop } from "./scheduler/loop.ts";
import { runPreflight } from "./preflight.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  await runPreflight(cfg);
  await validateModelAtStartup(cfg, log);
  const { bot, manager, subagentRunner, agentRunners, scheduleStore, dispatcher, externalAgentRunner } = buildBot(cfg);
  await externalAgentRunner?.init();
  manager.init();

  // Scheduler: start after manager.init() so bindings/state are available for
  // peekBinding validation. Shares the same ScheduleStore and TurnDispatcher
  // as Telegram intake, so scheduled turns serialize through the same
  // per-session queue as /queue and media prompts.
  const scheduler = new SchedulerLoop({ store: scheduleStore, sessionSource: manager, dispatcher, home: cfg.goblinHome });
  scheduler.start();

  // Graceful shutdown. grammy's start() resolves when stop() is called.
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, stopping bot`);
    // Stop the scheduler first so no new due schedules dispatch during shutdown.
    scheduler.stop();
    // Dispose external agents first (cancels running ones).
    await externalAgentRunner?.dispose();
    // Dispose subagents first (cancels running ones, releases sessions).
    await subagentRunner.dispose();
    // Dispose agent runners (releases pi sessions and awaits reflection).
    await Promise.all([...agentRunners.values()].map((runner) => runner.dispose()));
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

  // Populate Telegram's / autocomplete menu from the command registry.
  // Best-effort: a failure does not prevent the bot from starting —
  // commands still dispatch via the message:text handler.
  await syncTelegramMenu(bot.api, log.warn);

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
