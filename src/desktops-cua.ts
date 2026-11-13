// The guest-session contract for the desktop pool: the cua tool
// allowlist, the desktop action union, and the constants the cua/launch
// exec paths share. Pure data and pure predicates — no podman, no
// refuse(); src/desktops.ts consumes this (issue #456).
import { z } from "zod";

// cua-driver 0.34.1's input tools minus the ones bypassing goblin's
// gates: launch_app/kill_app route around the launch whitelist and
// refusal logging, browser_* drives an unwired CDP channel, raw
// mouse_*/move_cursor/parallel_mouse_drag are covered by click/drag.
export type CuaTool =
	| "click"
	| "double_click"
	| "right_click"
	| "press_key"
	| "hotkey"
	| "type_text"
	| "scroll"
	| "drag"
	| "set_value"
	| "bring_to_front"
	| "invoke_menu"
	| "set_window_frame";

// Must stay literal against the CuaTool union — growing one without
// the other is a type error. act is the enforcement point: a boundary
// cast to CuaTool proves nothing at runtime.
export const CUA_TOOLS: ReadonlySet<string> = new Set<CuaTool>([
	"click",
	"double_click",
	"right_click",
	"press_key",
	"hotkey",
	"type_text",
	"scroll",
	"drag",
	"set_value",
	"bring_to_front",
	"invoke_menu",
	"set_window_frame",
]);

export type DesktopAction =
	| { kind: "launch"; app: "chromium"; url?: string }
	| { kind: "cua"; tool: CuaTool; args: Record<string, unknown> };

export const listWindowsSchema = z.object({
	windows: z
		.array(z.object({ pid: z.number(), app_name: z.string(), z_index: z.number() }))
		.optional(),
});

export const DESKTOP_USER = "desk";
export const SESSION_SOCKET = "/run/desk/cua.sock";
// Must mirror the env goblin-launch pins in the image — nothing here
// may derive from container-writable state.
export const SESSION_ENV = {
	HOME: "/home/desk",
	DISPLAY: ":99",
	DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/desk/bus",
	XDG_RUNTIME_DIR: "/home/desk/.runtime",
} as const;
export const EXEC_OPTS = { timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024 } as const;

// Chromium refuses background-injected input when its renderer isn't
// the focused surface. AT-SPI tools (invoke_menu, set_window_frame,
// bring_to_front) take no delivery_mode; set_value is AT-SPI
// SetValue, not injected input.
export const FOREGROUND_TOOLS: ReadonlySet<string> = new Set([
	"click",
	"double_click",
	"right_click",
	"press_key",
	"hotkey",
	"type_text",
	"scroll",
	"drag",
]);

// Model-controlled strings land on Chromium's argv — a bare `--flag`
// becomes a browser switch. Real URLs (no whitespace/control chars)
// or exactly about:blank.
const LAUNCH_URL_RE = /^(?:https?|file):\/\/[^\s\x00-\x1f\x7f]+$/;
export function launchUrlOk(url: string): boolean {
	return url === "about:blank" || LAUNCH_URL_RE.test(url);
}
