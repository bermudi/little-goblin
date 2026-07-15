import { describe, it, expect } from "bun:test";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import { buildPermissionResponse } from "./devin.ts";

function option(optionId: string, kind: PermissionOption["kind"]): PermissionOption {
  return { optionId, name: optionId, kind };
}

describe("buildPermissionResponse", () => {
  it("selects reject_once when available", () => {
    const options = [
      option("allow-once", "allow_once"),
      option("reject-once", "reject_once"),
    ];
    const response = buildPermissionResponse(options);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("selects reject_always when available", () => {
    const options = [
      option("allow-always", "allow_always"),
      option("reject-always", "reject_always"),
    ];
    const response = buildPermissionResponse(options);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject-always" });
  });

  it("prefers reject over allow even when allow comes first", () => {
    const options = [
      option("allow-once", "allow_once"),
      option("allow-always", "allow_always"),
      option("reject-once", "reject_once"),
    ];
    const response = buildPermissionResponse(options);
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("never selects an allow option when no reject is offered", () => {
    const options = [
      option("allow-once", "allow_once"),
      option("allow-always", "allow_always"),
    ];
    const response = buildPermissionResponse(options);
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("returns cancelled when no options are offered", () => {
    const response = buildPermissionResponse(undefined);
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("returns cancelled when options is empty", () => {
    const response = buildPermissionResponse([]);
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });
});
