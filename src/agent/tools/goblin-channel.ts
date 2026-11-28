import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ToolCallContext, Tools } from "../../tool.ts";
import { isHosted, zodInputJsonSchema } from "../../tool.ts";
import { policyOf } from "../tool-policy.ts";
import { summarize } from "../../reviewer-evidence.ts";
import { log } from "../../log.ts";
import { sleep } from "../../timing.ts";

const MAX_REQUEST = 1024 * 1024;
const MAX_CALLS = 50;
const ABORT_GRACE_MS = 2000;

interface PropertySchema {
	type?: string;
	enum?: unknown[];
	const?: unknown;
	description?: string;
	items?: { type?: string };
	anyOf?: { type?: string }[];
}

const typeOf = (property: PropertySchema | undefined): string | undefined =>
	property?.type ?? property?.anyOf?.find((member) => member.type !== "null")?.type;

const nullable = (property: PropertySchema | undefined): boolean =>
	property?.anyOf?.some((member) => member.type === "null") === true;

const isHelp = (word: string | undefined): boolean => word === "--help" || word === "-h";

const actionsOf = (action: { enum?: unknown[]; const?: unknown } | undefined): string[] =>
	(action?.enum ?? (action?.const === undefined ? [] : [action.const])).filter((value): value is string => typeof value === "string");

export type ToolDispatch = (
	name: string,
	input: unknown,
	options: ToolCallContext,
) => PromiseLike<unknown> | unknown;

interface ReplyMessage {
	id: number;
	stdout: string;
	stderr: string;
	code: number;
}

interface CommandBinding {
	tools: Tools;
	conversation?: string;
	dispatch?: ToolDispatch;
}
const commandBindings = new WeakMap<object, CommandBinding>();

export function withGoblinCommands(tools: Tools, conversation?: string): Tools {
	if (tools.bash === undefined || isHosted(tools.bash)) return tools;
	const out: Tools = {};
	for (const [name, tool] of Object.entries(tools)) {
		out[name] = policyOf(name).command && !isHosted(tool) ? { ...tool, declared: false } : tool;
	}
	const bash = out.bash;
	if (bash !== undefined) commandBindings.set(bash, { tools: out, ...(conversation ? { conversation } : {}) });
	return out;
}

export function bindCommandDispatch(tools: Tools, dispatch: ToolDispatch): void {
	const bash = tools.bash;
	if (bash === undefined) return;
	const binding = commandBindings.get(bash);
	if (binding === undefined) return;
	if (binding.dispatch !== undefined) throw new Error("bash command dispatch is already bound");
	binding.dispatch = dispatch;
}

export function commandBindingFor(tool: object): CommandBinding | undefined {
	return commandBindings.get(tool);
}

export function commandRuntime(opts: {
	tools: Tools;
	dispatch: ToolDispatch;
	toolCallId: string;
	conversation?: string;
	abortSignal?: AbortSignal;
}): {
	env: Record<string, string>;
	handle(message: unknown, send: (value: unknown) => void): void;
	settle(): Promise<void>;
	close(): void;
	outputCalls(): { tool: string; args: string; ok: boolean; result: string }[];
} {
	const dirname = mkdtempSync(join(tmpdir(), "goblin-channel-"));
	chmodSync(dirname, 0o700);
	const lockFile = join(dirname, "lock");
	writeFileSync(lockFile, "", { mode: 0o600 });
	const bashEnv = join(dirname, "bash-env");
	writeFileSync(
		bashEnv,
		"export GOBLIN_CHANNEL_FD=$NODE_CHANNEL_FD\nexport GOBLIN_CHANNEL_MODE=$NODE_CHANNEL_SERIALIZATION_MODE\nunset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE BASH_ENV\n",
		{ mode: 0o600 },
	);
	let alive = true;
	const pending = new Set<Promise<void>>();
	const running = new Map<number, { tool: string; args: string }>();
	let returned: { tool: string; args: string; ok: boolean; result: string }[] | undefined;
	let count = 0;
	let dispatchSeq = 0;
	const calls: { tool: string; args: string; ok: boolean; result: string }[] = [];
	const allowed: [string, Exclude<Tools[string], { hosted: string } >][] = [];
	for (const [name, tool] of Object.entries(opts.tools)) {
		if (policyOf(name).command && !isHosted(tool)) allowed.push([name, tool]);
	}
	const schemas = new Map(allowed.map(([name, tool]) => [name, tool.input]));
	const descriptions = new Map(allowed.map(([name, tool]) => [name, tool.description]));
	const cli = resolve(import.meta.dir, "goblin-cli.ts");
	const launcher = resolve(import.meta.dir, "../../../scripts/commands");
	const env = {
		PATH: `${launcher}:${process.env.PATH ?? ""}`,
		BASH_ENV: bashEnv,
		GOBLIN_CHANNEL_LOCK: lockFile,
		GOBLIN_BUN: process.execPath,
		GOBLIN_CLI: cli,
	};

	const stdinHint = (name: string): string => {
		const hasAction = name === "<command>"
			? allowed.some(([, tool]) => (zodInputJsonSchema(tool.input) as { properties?: Record<string, unknown> }).properties?.action !== undefined)
			: (zodInputJsonSchema(schemas.get(name)!) as { properties?: Record<string, unknown> }).properties?.action !== undefined;
		return `A value of - reads that option from stdin, so multi-line text can come from a pipe or a heredoc:\n  goblin ${name}${hasAction ? " <action>" : ""} --<option> - <<'EOF'\n  ...\n  EOF\n`;
	};
	const usage = (name: string): string => {
		const json = zodInputJsonSchema(schemas.get(name)!) as {
			properties?: Record<string, PropertySchema>;
			required?: string[];
		};
		const actions = actionsOf(json.properties?.action);
		const hasAction = json.properties?.action !== undefined;
		const flags = Object.keys(json.properties ?? {}).filter((key) => key !== "action");
		return `${descriptions.get(name) ?? ""}\n\nUsage: goblin ${name}${hasAction ? " <action>" : ""} [options]\n${actions.length > 0 ? `Actions: ${actions.join(", ")}\n` : ""}${flags.map((key) => {
			const property = json.properties?.[key];
			const values = property?.enum?.filter((value): value is string => typeof value === "string");
			const flag = key.replaceAll("_", "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
			const shape = typeOf(property) === "array"
				? `<${property?.items?.type ?? "value"}> (repeat for more)`
				: `<${values?.length ? values.join("|") : typeOf(property) ?? "value"}${nullable(property) ? "|null" : ""}>`;
			return `  --${flag}${json.required?.includes(key) ? " (required)" : ""} ${shape}${property?.description ? ` — ${property.description}` : ""}`;
		}).join("\n")}\n`;
	};
	const help = (name?: string): Omit<ReplyMessage, "id"> => {
		if (name === undefined) {
			if (allowed.length === 0) return { stdout: "\n", stderr: "", code: 0 };
			return {
				stdout: `${allowed.map(([tool]) => usage(tool)).join("\n")}\n${stdinHint("<command>")}`,
				stderr: "",
				code: 0,
			};
		}
		if (!schemas.has(name)) return { stdout: "", stderr: `goblin: ${name} is not available in this chat\n`, code: 2 };
		return { stdout: `${usage(name)}\n${stdinHint(name)}`, stderr: "", code: 0 };
	};

	const handle = (message: unknown, send: (value: unknown) => void): void => {
		const parsedMessage = z
			.object({ id: z.number().int(), argv: z.array(z.string()), stdin: z.string().optional() })
			.safeParse(message);
		if (!parsedMessage.success) return;
		const req = parsedMessage.data;
		const respond = (reply: Omit<ReplyMessage, "id">): void => {
			try {
				send({ id: req.id, ...reply });
			} catch (err) {
				log.warn("goblin reply failed", { toolCallId: opts.toolCallId, code: reply.code, error: err instanceof Error ? err.message : String(err) });
			}
		};
		if (!alive) return respond({ stdout: "", stderr: "goblin: the bash call that owned this channel has ended\n", code: 75 });
		count += 1;
		if (count > MAX_CALLS) return respond({ stdout: "", stderr: "goblin: call limit reached (50 per bash call)\n", code: 2 });
		const encoded = JSON.stringify(req);
		if (Buffer.byteLength(encoded) > MAX_REQUEST) return respond({ stdout: "", stderr: "goblin: request exceeds 1 MiB\n", code: 2 });
		const task = (async () => {
			const argv = req.argv;
			if (argv.length === 0 || isHelp(argv[0])) return respond(help());
			const name = argv.shift()!;
			if (isHelp(argv[0])) return respond(help(name));
			const schema = schemas.get(name);
			const tool = opts.tools[name];
			if (schema === undefined || tool === undefined || isHosted(tool)) {
				return respond({ stdout: "", stderr: `goblin: ${name} is not available in this chat\n`, code: 2 });
			}
			const schemaJson = zodInputJsonSchema(schema) as { properties?: Record<string, PropertySchema> };
			const hasAction = schemaJson.properties?.action !== undefined;
			if (hasAction && (argv[0] === undefined || argv[0].startsWith("--"))) {
				const actions = actionsOf(schemaJson.properties?.action).join(", ");
				return respond({ stdout: "", stderr: `goblin: ${name} needs an action first: goblin ${name} <action> [options]. Actions: ${actions}\n`, code: 2 });
			}
			const action = hasAction ? argv.shift() : undefined;
			if (argv.some((word, index) => index % 2 === 0 && isHelp(word))) return respond(help(name));
			const args: Record<string, unknown> = action === undefined ? {} : { action };
			let invoked = false;
			try {
				for (let i = 0; i < argv.length; i += 2) {
					const flag = argv[i]!;
					const raw = argv[i + 1];
					if (!flag.startsWith("--") || raw === undefined) throw new Error(`invalid option ${flag}`);
					const inputKey = flag.slice(2);
					if (inputKey === "json") {
						const value: unknown = JSON.parse(raw);
						if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("--json needs an object");
						Object.assign(args, value);
						continue;
					}
					const properties = schemaJson.properties ?? {};
					const key = Object.keys(properties).find((candidate) =>
						candidate.replaceAll("_", "").toLowerCase() === inputKey.replaceAll("-", "").toLowerCase(),
					);
					const property = key === undefined ? undefined : properties[key];
					const type = typeOf(property);
					if (key === undefined || type === undefined || key === "action") throw new Error(`unknown option ${flag}`);
					const value = raw === "-" && req.stdin !== undefined ? req.stdin : raw;
					if (raw === "null" && nullable(property)) args[key] = null;
					else if (type === "array") {
						const list: unknown = value.trimStart().startsWith("[") ? JSON.parse(value) : undefined;
						const previous = Array.isArray(args[key]) ? args[key] as unknown[] : [];
						args[key] = Array.isArray(list) ? [...previous, ...list] : [...previous, value];
					} else if (type === "integer" || type === "number") args[key] = Number(value);
					else if (type === "boolean") args[key] = value === "true" ? true : value === "false" ? false : value;
					else args[key] = value;
				}
				const checked = await schema.safeParseAsync(args);
				if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? "invalid arguments");
				if (!alive) return respond({ stdout: "", stderr: "goblin: the bash call that owned this channel has ended\n", code: 75 });
				dispatchSeq += 1;
				invoked = true;
				const childCallId = `${opts.toolCallId}/${dispatchSeq}`;
				log.info("tool call", {
					conversation: opts.conversation ?? "",
					tool: name,
					parent: opts.toolCallId,
					toolCallId: childCallId,
					arg: JSON.stringify(checked.data).slice(0, 200),
				});
				let result: unknown;
				const seq = dispatchSeq;
				running.set(seq, { tool: name, args: summarize(checked.data, 200) });
				try {
					result = await opts.dispatch(name, checked.data, {
						toolCallId: childCallId,
						...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
					});
				} catch (err) {
					running.delete(seq);
					const text = err instanceof Error ? err.message : String(err);
					log.warn("tool execute failed", {
						conversation: opts.conversation ?? "",
						tool: name,
						parent: opts.toolCallId,
						error: text.slice(0, 300),
					});
					calls.push({ tool: name, args: summarize(checked.data, 200), ok: false, result: summarize(text, 300) });
					return respond({ stdout: "", stderr: `${text}\n`, code: 1 });
				}
				running.delete(seq);
				const failed = typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string";
				const text = failed
					? (result as { error: string }).error
					: typeof result === "object" && result !== null && typeof (result as { content?: unknown }).content === "string"
						? (result as { content: string }).content
						: JSON.stringify(result, null, 2);
				calls.push({
					tool: name,
					args: summarize(checked.data, 200),
					ok: !failed,
					result: summarize(text, 300),
				});
				if (failed) {
					log.warn("tool execute failed", {
						conversation: opts.conversation ?? "",
						tool: name,
						parent: opts.toolCallId,
						error: text.slice(0, 300),
					});
				}
				return respond(failed ? { stdout: "", stderr: `${text}\n`, code: 1 } : { stdout: `${text}\n`, stderr: "", code: 0 });
			} catch (err) {
				const text = err instanceof Error ? err.message : String(err);
				if (invoked) calls.push({ tool: name, args: summarize(args, 200), ok: false, result: summarize(text, 300) });
				return respond({ stdout: "", stderr: `goblin: ${text}\n`, code: 2 });
			}
		})();
		pending.add(task);
		void task.finally(() => pending.delete(task));
	};
	return {
		env,
		handle: (message, send) => handle(message, send),
		settle: async () => {
			alive = false;
			const all = Promise.allSettled([...pending]).then(() => undefined);
			const signal = opts.abortSignal;
			const aborted = signal === undefined
				? new Promise<never>(() => {})
				: new Promise<void>((resolve) => {
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve(), { once: true });
					});
			await Promise.race([all, aborted.then(() => Promise.race([all, sleep(ABORT_GRACE_MS)]))]);
			for (const call of running.values()) {
				calls.push({ ...call, ok: false, result: "still running when the bash call ended; its result was not waited for" });
				log.warn("goblin call abandoned after abort", { conversation: opts.conversation ?? "", tool: call.tool, parent: opts.toolCallId });
			}
			returned = [...calls];
		},
		close: () => {
			alive = false;
			rmSync(dirname, { recursive: true, force: true });
		},
		outputCalls: () => returned ?? [...calls],
	};
}
