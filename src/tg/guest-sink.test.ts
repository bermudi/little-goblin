import { describe, it, expect } from "bun:test";
import { GuestReplySink } from "./guest-sink.ts";

describe("GuestReplySink", () => {
  it("accumulates text deltas", () => {
    const sink = new GuestReplySink();
    sink.onTextDelta("Hello");
    sink.onTextDelta(", ");
    sink.onTextDelta("world!");
    expect(sink.text).toBe("Hello, world!");
  });

  it("ignores tool events (start/end with various signatures)", () => {
    const sink = new GuestReplySink();
    sink.onTextDelta("answer");
    // Tool callbacks accept args per TurnCallbacks but GuestReplySink no-ops them.
    // Call with the full signature to confirm they don't throw or mutate text.
    sink.onToolStart("read_file", { path: "/tmp" });
    sink.onToolEnd("read_file", false);
    sink.onToolStart("bash", { cmd: "ls" });
    sink.onToolEnd("bash", true);
    expect(sink.text).toBe("answer");
  });

  it("ignores status updates", () => {
    const sink = new GuestReplySink();
    sink.onTextDelta("a");
    sink.onStatusUpdate("thinking...");
    sink.onStatusUpdate("running tool");
    expect(sink.text).toBe("a");
  });

  it("onAgentEnd does not throw and leaves text intact", () => {
    const sink = new GuestReplySink();
    sink.onTextDelta("final");
    sink.onAgentEnd();
    expect(sink.text).toBe("final");
  });

  it("yields empty string for a turn with no text deltas", () => {
    const sink = new GuestReplySink();
    sink.onToolStart("read_file", {});
    sink.onToolEnd("read_file", false);
    sink.onStatusUpdate("thinking...");
    sink.onAgentEnd();
    expect(sink.text).toBe("");
  });
});
