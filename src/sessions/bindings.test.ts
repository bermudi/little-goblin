import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadBindings, loadLegacyBindings } from "./bindings.ts";
import { configPath } from "./paths.ts";
import { surfaceId, dmSurface } from "../surface.ts";

describe("bindings", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "goblin-bindings-"));
    mkdirSync(dirname(configPath(home)), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects a canonical file that binds one conversation to multiple surfaces", () => {
    writeFileSync(
      configPath(home),
      JSON.stringify({
        version: 1,
        surfaces: {
          [surfaceId(dmSurface(1))]: "abc123def0",
          [surfaceId(dmSurface(2))]: "abc123def0",
        },
      }),
    );

    expect(() => loadBindings(home)).toThrow(/already bound/);
  });

  it("rejects an array surfaces value as corrupt canonical authority", () => {
    writeFileSync(configPath(home), JSON.stringify({ version: 1, surfaces: [] }));

    expect(() => loadBindings(home)).toThrow(/invalid canonical bindings/);
  });

  it("rejects arrays masquerading as legacy binding maps", () => {
    writeFileSync(configPath(home), JSON.stringify({ dm: [] }));

    expect(() => loadLegacyBindings(home)).toThrow(/invalid legacy bindings/);
  });
});
