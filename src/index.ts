import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog } from "./log.ts";
import { MemoryEngine } from "./memory/mod.ts";
import { assertEdgeTtsAvailable, resolveVoiceName } from "./voice.ts";
import { syncTelegramMenu } from "./commands/registry.ts";
import { SchedulerLoop, DEFAULT_TRANSCRIPT_SYNC_MAX_MS } from "./scheduler/loop.ts";
import { runPreflight } from "./preflight.ts";
import { CURRENT_STATE_VERSION, readStateVersion } from "./state-version.ts";
import { ConversationStore, InternalSessionStore } from "./sessions/mod.ts";
import { reconcileProjectAssignmentAtColdStart } from "./orchestration/conversation-lifecycle.ts";
import { ShutdownCoordinator } from "./shutdown/mod.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  const stateVersion = readStateVersion(cfg.goblinHome);
  if (stateVersion !== CURRENT_STATE_VERSION) {
    log.error("state version mismatch; run `bun run migrate` with the service stopped", {
      current: stateVersion,
      required: CURRENT_STATE_VERSION,
    });
    process.exit(1);
  }
  const memoryEngine = new MemoryEngine(cfg.goblinHome, cfg.openaiApiKey);
  await memoryEngine.migrate();
  reconcileProjectAssignmentAtColdStart(cfg.goblinHome);
  await memoryEngine.embeddingProvider.reindexIfNeeded();
  await runPreflight(cfg);
  const {
    bot,
    gate,
    lifecycle,
    subagentRunner,
    runtimeHost,
    scheduleStore,
    dispatcher,
    externalAgentRunner,
  } = buildBot(cfg, { memoryEngine });

  await memoryEngine.syncTranscripts({ maxDurationMs: DEFAULT_TRANSCRIPT_SYNC_MAX_MS });
  await externalAgentRunner?.init();

  // Scheduled turns resolve the current Conversation through the same
  // lifecycle authority as Telegram intake and serialize through the same
  // per-Conversation runtime queue as /queue and media prompts. Dreaming gets
  // canonical Conversation enumeration and Surface-free internal persistence
  // as separate, explicit dependencies.
  const scheduler = new SchedulerLoop({
    store: scheduleStore,
    lifecycle,
    conversationCatalog: new ConversationStore(cfg.goblinHome),
    internalSessionStore: new InternalSessionStore(cfg.goblinHome),
    dispatcher,
    home: cfg.goblinHome,
    memoryEngine,
  });
  scheduler.start();

  // Graceful shutdown. The coordinator owns the phase list; index.ts's
  // shutdown body is one call. grammy's start() resolves when stop() is
  // called inside the coordinator's "stop-telegram-polling" phase.
  const coordinator = new ShutdownCoordinator({
    gate,
    stopTelegramPolling: () => bot.stop(),
    drainBufferedText: () => gate.bufferedTextAdmission(),
    drainRuntimeAdmission: () => gate.runtimeAdmission(),
    disposeRuntimes: () => runtimeHost.disposeAll(),
    drainScheduler: () => scheduler.stopAndDrain(),
    disposeExternalAgents: async () => { await externalAgentRunner?.dispose(); },
    disposeSubagents: () => subagentRunner.dispose(),
    closeMemoryEngine: async () => { memoryEngine.close(); },
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const result = await coordinator.shutdown(signal);
      if (!result.ok) {
        log.error("shutdown completed with cleanup failures", { count: result.failures });
        process.exit(1);
      }
      process.exit(0);
    })();
    return shutdownPromise;
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
