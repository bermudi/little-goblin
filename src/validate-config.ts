#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { ensureGoblinHome } from "./config.ts";
import { initLog, log } from "./log.ts";
import { runPreflight } from "./preflight.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  await runPreflight(cfg);
  log.info("Configuration is valid and ready to start.");
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("Configuration check failed:");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
