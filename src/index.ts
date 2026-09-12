import { loadConfig, ensureGoblinHome } from "./config.ts";
import { buildBot } from "./bot.ts";
import { log, initLog, boundedError } from "./log.ts";
import { MemoryEngine } from "./memory/mod.ts";
import { assertEdgeTtsAvailable, resolveVoiceName } from "./voice.ts";
import { syncTelegramMenu } from "./commands/registry.ts";
import { startDeploymentSettingsServer } from "./settings/composition.ts";
import { createRestartTrigger } from "./settings/restart.ts";
import { syncSettingsMenuButton } from "./settings/telegram.ts";
import type { SettingsServerHandle } from "./settings/server.ts";
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
  const memoryEngine = new MemoryEngine(cfg.goblinHome, cfg.embeddings);
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
    pendingClaim,
  } = buildBot(cfg, { memoryEngine });

  // Decision-0036 startup re-arm: durable completions retained pending whose
  // origin Surface is still bound (bindings persist across restarts) are
  // re-delivered without waiting for an interaction; unbound ones wait for
  // the next authorized interaction or summon. Fire-and-forget with observed
  // failures — startup must not depend on delivery succeeding.
  void pendingClaim.rearmAtStartup().catch((err: unknown) => {
    log.error("pending completion startup re-arm failed", { ...boundedError(err) });
  });

  await memoryEngine.syncTranscripts({ maxDurationMs: DEFAULT_TRANSCRIPT_SYNC_MAX_MS });

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

  // Optional loopback Settings Mini App API (decision 0049). Deployment owns
  // the stable port and public URL in `goblin.json5` `settings`; this
  // composition root owns the handle lifetime. Loopback only —
  // operator-managed Tailscale Serve supplies private HTTPS and is never
  // configured here. Null when disabled. Started after the shutdown wiring
  // below so the restart trigger can reference it directly.

  // Graceful shutdown. The coordinator owns the Telegram phase list;
  // index.ts additionally owns the Settings handle. Signal-driven shutdown
  // closes the Settings handle first so new Settings work is rejected before
  // Telegram drains begin; a restart-driven shutdown closes it last so the
  // 200 response to POST /api/restart survives the drain. grammy's
  // start() resolves when stop() is called inside the coordinator's
  // "stop-telegram-polling" phase.
  const coordinator = new ShutdownCoordinator({
    gate,
    stopTelegramPolling: () => bot.stop(),
    drainBufferedText: () => gate.bufferedTextAdmission(),
    drainRuntimeAdmission: () => gate.runtimeAdmission(),
    disposeRuntimes: () => runtimeHost.disposeAll(),
    drainScheduler: () => scheduler.stopAndDrain(),
    disposeSubagents: () => subagentRunner.dispose(),
    closeMemoryEngine: async () => { memoryEngine.close(); },
  });
  let shutdownPromise: Promise<void> | undefined;
  let settingsHandle: SettingsServerHandle | null = null;
  const shutdown = (
    signal: string,
    opts?: { failureExitCode?: number; closeSettingsLast?: boolean },
  ): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const failureExitCode = opts?.failureExitCode ?? 1;
    const closeSettingsLast = opts?.closeSettingsLast ?? false;
    shutdownPromise = (async () => {
      let settingsCloseFailed = false;
      const closeSettingsOnce = async (): Promise<void> => {
        if (settingsHandle === null) return;
        try {
          await settingsHandle.close();
        } catch (err) {
          settingsCloseFailed = true;
          log.error("settings server close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      if (!closeSettingsLast) await closeSettingsOnce();
      const result = await coordinator.shutdown(signal);
      if (closeSettingsLast) await closeSettingsOnce();
      if (settingsCloseFailed || !result.ok) {
        log.error("shutdown completed with cleanup failures", { count: result.failures });
        process.exit(failureExitCode);
      }
      process.exit(0);
    })();
    return shutdownPromise;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Operator self-restart (POST /api/restart) reuses the shutdown path above
  // — no parallel phase list: it runs the same coordinator phases, closes
  // the Settings listener last (the 200 response must survive the drain),
  // drains under a bounded deadline, and always exits 0; the
  // operator-deployed systemd `Restart=on-success` owns revival.
  const requestRestart = createRestartTrigger({
    runShutdown: () => shutdown("restart", { failureExitCode: 0, closeSettingsLast: true }),
    exit: (code) => process.exit(code),
  });
  try {
    settingsHandle = startDeploymentSettingsServer(cfg, { requestRestart });
  } catch (err) {
    log.error("settings server failed to start", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
  if (settingsHandle) {
    log.info("Settings Mini App API enabled", { url: settingsHandle.url });
  }

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

  // Explicit Telegram launch entry for Settings (decision 0049): chat menu
  // button opening the Mini App web_app URL. Best-effort; /settings remains
  // discoverable via the command menu when the button is unavailable.
  await syncSettingsMenuButton(bot.api, cfg, log.warn);

  // Long-polling. No webhook. The only listener is the optional loopback
  // Settings API above; Tailscale Serve supplies private HTTPS.
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
