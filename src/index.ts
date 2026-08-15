import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog } from "./log.ts";
import { MemoryEngine } from "./memory/mod.ts";
import { validateModelAtStartup } from "./agent/poe-validate.ts";
import { assertEdgeTtsAvailable, resolveVoiceName } from "./voice.ts";
import { syncTelegramMenu } from "./commands/registry.ts";
import { SchedulerLoop, DEFAULT_TRANSCRIPT_SYNC_MAX_MS } from "./scheduler/loop.ts";
import { runPreflight } from "./preflight.ts";
import { CURRENT_STATE_VERSION, readStateVersion } from "./state-version.ts";
import { ConversationStore, InternalSessionStore } from "./sessions/mod.ts";
import { reconcileProjectAssignmentAtColdStart } from "./orchestration/conversation-lifecycle.ts";

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
  await validateModelAtStartup(cfg, log);
  const {
    bot,
    closeAdmission,
    bufferedTextAdmission,
    runtimeAdmission,
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

  // Graceful shutdown. grammy's start() resolves when stop() is called.
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      log.info(`received ${signal}, stopping bot`);
      const failures: unknown[] = [];
      const attempt = async (step: string, operation: () => Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
          log.error("shutdown step failed", {
            step,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      // Close Telegram admission first. Its drain includes the coalescer flush,
      // so buffered text is admitted into runtime queues while runtime
      // admission is still open.
      const telegramDrain = closeAdmission();
      void telegramDrain.catch(() => {});
      // Coalesced text dispatches are allowed to finish their lifecycle work
      // and reach the runtime queue, but shutdown must not wait for their
      // complete model/steering handlers. Dispose runtimes only after this
      // narrower barrier has passed.
      const bufferedAdmission = bufferedTextAdmission();
      const schedulerDrain = scheduler.stopAndDrain();
      void schedulerDrain.catch(() => {});
      // Start runtime disposal before awaiting either Telegram drain. An
      // admitted handler may be waiting on a model operation (notably
      // steering via followUp), and runner disposal is what releases it.
      const runtimeDrain = (async (): Promise<void> => {
        await bufferedAdmission;
        await runtimeAdmission();
        await runtimeHost.disposeAll();
      })();
      // Observe rejection immediately: disposal can fail before the ordered
      // shutdown steps reach the later aggregation below.
      void runtimeDrain.catch(() => {});

      // Stop polling while the independent drains are in progress. The
      // scheduler drain is already in progress, but must not be awaited until
      // after runtime disposal: a dreaming turn may need that disposal to
      // abort its model request.
      await attempt("telegram polling", () => bot.stop());
      await attempt("conversation runtimes", () => runtimeDrain);
      await attempt("telegram admission", () => telegramDrain);
      await attempt("scheduler", () => schedulerDrain);
      await attempt("external agents", async () => {
        await externalAgentRunner?.dispose();
      });
      await attempt("subagents", () => subagentRunner.dispose());
      await attempt("memory engine", async () => {
        memoryEngine.close();
      });

      // Exit 0 only after complete cleanup; any failure is reported to the
      // supervisor with a non-zero status.
      if (failures.length > 0) {
        log.error("shutdown completed with cleanup failures", { count: failures.length });
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
