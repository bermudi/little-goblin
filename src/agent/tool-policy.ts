// Declared per-tool policy: one descriptor per tool, read by every consumer
// that used to match tool names against its own list (retry guard, script
// composition, guest filtering, taint marking, skill attribution, nested-call
// expansion). A new tool must add a row here — `TOOL_POLICY` is typed over
// `ToolName`, and tool-policy.test.ts fails if a built tool has no row.
//
// Unknown names (dynamic/foreign tools; none exist today) get CONSERVATIVE:
// replay-unsafe, untrusted, not scriptable, not offered to any guest.

export interface ToolPolicy {
	// "safe": a re-asked call after a crash/resume may simply execute again
	// (the observed value is only meaningful fresh). "unsafe": potentially
	// effectful — a historical execution refuses as an unowned repeat.
	replay: "safe" | "unsafe";
	// "untrusted": output carries remote content (taints a script's output).
	output: "trusted" | "untrusted";
	// Can write files, directly or (script) through composed calls — its
	// output is scanned for skill-provenance attribution.
	writesFiles: boolean;
	// Composes other tools; its output carries nested call records.
	composes: boolean;
	// Callable from inside a `script`.
	scriptable: boolean;
	// Mounted for the sandboxed guest persona (the sandbox ruling: search only).
	guestSandbox: boolean;
	// Mounted on guest-channel turns for a non-sandbox persona.
	guestChannel: boolean;
}

export const CONSERVATIVE_POLICY: ToolPolicy = {
	replay: "unsafe",
	output: "untrusted",
	writesFiles: false,
	composes: false,
	scriptable: false,
	guestSandbox: false,
	guestChannel: false,
};

const BASE: ToolPolicy = {
	replay: "unsafe",
	output: "trusted",
	writesFiles: false,
	composes: false,
	scriptable: false,
	guestSandbox: false,
	guestChannel: true,
};

const P = (over: Partial<ToolPolicy>): ToolPolicy => ({ ...BASE, ...over });

export const TOOL_NAMES = [
	"read_file",
	"write_file",
	"edit_file",
	"bash",
	"speak",
	"transcribe",
	"vision",
	"generate_image",
	"program",
	"delegate",
	"herdr",
	"mail",
	"send_file",
	"artifact",
	"memory_search",
	"memory_reflect",
	"fetch",
	"search",
	"history_search",
	"note",
	"sandbox",
	"subagent",
	"desktop",
	"responsibility",
	"ui",
	"script",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_POLICY: Record<ToolName, ToolPolicy> = {
	read_file: P({ replay: "safe", scriptable: true }),
	write_file: P({ writesFiles: true, scriptable: true }),
	edit_file: P({ writesFiles: true, scriptable: true }),
	bash: P({ scriptable: true }),
	speak: P({ guestChannel: false }),
	transcribe: P({ scriptable: true }),
	vision: P({}),
	generate_image: P({ guestChannel: false }),
	program: P({ guestChannel: false }),
	delegate: P({ guestChannel: false }),
	herdr: P({ guestChannel: false }),
	mail: P({ guestChannel: false }),
	send_file: P({ guestChannel: false }),
	artifact: P({ scriptable: true }),
	memory_search: P({ replay: "safe", scriptable: true, guestChannel: false }),
	memory_reflect: P({ guestChannel: false }),
	fetch: P({ output: "untrusted", scriptable: true }),
	search: P({ output: "untrusted", scriptable: true, guestSandbox: true }),
	history_search: P({ replay: "safe", scriptable: true, guestChannel: false }),
	note: P({ guestChannel: false }),
	sandbox: P({ scriptable: true }),
	subagent: P({ guestChannel: false }),
	desktop: P({ guestChannel: false }),
	responsibility: P({}),
	ui: P({}),
	script: P({ writesFiles: true, composes: true }),
};

export function policyOf(name: string): ToolPolicy {
	return Object.hasOwn(TOOL_POLICY, name) ? TOOL_POLICY[name as ToolName] : CONSERVATIVE_POLICY;
}
