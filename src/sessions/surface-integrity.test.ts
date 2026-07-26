import { describe, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "..");
const allowedRelative = new Set(["sessions/types.ts", "sessions/surface-compat.ts", "sessions/surface-migration.ts"]);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("surface identity integrity", () => {
  it("does not use ChatLocator or locatorFromCtx outside migration files", () => {
    const failures: string[] = [];
    const allowed = new Set([...allowedRelative].map((rel) => join(srcRoot, rel)));

    for (const file of walk(srcRoot)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, "utf8");
      if (content.includes("ChatLocator")) {
        failures.push(`${file}: ChatLocator`);
      }
      if (content.includes("locatorFromCtx")) {
        failures.push(`${file}: locatorFromCtx`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Banned legacy surface identifiers found in production code:\n${failures.join("\n")}`);
    }
  });

  it("does not reconstruct Surface kind from grammy routing fields outside the normalization boundary", () => {
    const failures: string[] = [];
    const allowed = new Set([
      join(srcRoot, "tg/context-surface.ts"),
      join(srcRoot, "tg/middleware.ts"),
      join(srcRoot, "bot.ts"),
      join(srcRoot, "commands/ping.ts"),
    ]);

    const patterns = [
      { name: "chat.type", re: /\bchat\??\.type\b/ },
      { name: "msg.message_thread_id", re: /\bmsg\??\.message_thread_id\b/ },
      { name: "is_topic_message", re: /\bis_topic_message\b/ },
      { name: "is_forum", re: /\bis_forum\b/ },
      { name: "is_direct_messages", re: /\bis_direct_messages\b/ },
      { name: "direct_messages_topic", re: /\bdirect_messages_topic\b/ },
      { name: "guestMessage", re: /\bguestMessage\b/ },
      { name: "guest_message", re: /\bguest_message\b/ },
    ];

    for (const file of walk(srcRoot)) {
      if (allowed.has(file)) continue;
      const content = readFileSync(file, "utf8");
      for (const { name, re } of patterns) {
        if (re.test(content)) {
          failures.push(`${file}: ${name}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Grammy routing field used outside the Surface normalization boundary:\n${failures.join("\n")}`
      );
    }
  });
});
