#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { ensureGoblinHome } from "./config.ts";
import { initLog } from "./log.ts";
import { runPreflight } from "./preflight.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  initLog(cfg.logLevel);
  ensureGoblinHome(cfg);
  await runPreflight(cfg);
  console.log("\n✅ Configuration is valid and ready to start.");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("\n❌ Configuration check failed:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
