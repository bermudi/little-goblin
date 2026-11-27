import type { GwsRunner } from "../mail-gws.ts";

export interface Call {
	args: string[];
}

function headers(
	from = "a@x.com",
	subject = "s",
	date = "d",
): Array<{ name: string; value: string }> {
	return [
		{ name: "From", value: from },
		{ name: "Subject", value: subject },
		{ name: "Date", value: date },
	];
}

export function msgGet(id: string, thread = "t"): unknown {
	return {
		id,
		threadId: thread,
		snippet: `snip-${id}`,
		payload: { headers: headers(`a-${id}@x.com`, `sub-${id}`, "today") },
	};
}

export function fakeGws(routes: {
	history?: (params: Record<string, unknown>, call: number) => unknown;
	list?: (params: Record<string, unknown>, call: number) => unknown;
	get?: (params: Record<string, unknown>, call: number) => unknown;
	profile?: (params: Record<string, unknown>, call: number) => unknown;
	fail?: { code: number; stdout: string; stderr: string };
}): { run: GwsRunner; calls: Call[] } {
	const calls: Call[] = [];
	let n = 0;
	const run: GwsRunner = async (args) => {
		calls.push({ args: [...args] });
		n++;
		if (routes.fail) return { ...routes.fail };
		const pi = args.indexOf("--params");
		const params = pi === -1 ? {} : (JSON.parse(args[pi + 1]!) as Record<string, unknown>);
		const [resource, method] = [args[2], args[3]];
		if (resource === "history" && method === "list") {
			return {
				code: 0,
				stdout: JSON.stringify(routes.history?.(params, n) ?? { historyId: "200" }),
				stderr: "",
			};
		}
		if (resource === "messages" && method === "list") {
			return {
				code: 0,
				stdout: JSON.stringify(routes.list?.(params, n) ?? { messages: [] }),
				stderr: "",
			};
		}
		if (resource === "messages" && method === "get") {
			return {
				code: 0,
				stdout: JSON.stringify(routes.get?.(params, n) ?? msgGet(String(params.id ?? "m"))),
				stderr: "",
			};
		}
		if (resource === "getProfile") {
			return {
				code: 0,
				stdout: JSON.stringify(routes.profile?.(params, n) ?? { historyId: "999" }),
				stderr: "",
			};
		}
		throw new Error(`unexpected gws argv: ${args.join(" ")}`);
	};
	return { run, calls };
}

export function envelope(c: Call): { resource: string; method: string; params: Record<string, unknown> } {
	const pi = c.args.indexOf("--params");
	return {
		resource: c.args[2]!,
		method: c.args[3]!,
		params: pi === -1 ? {} : (JSON.parse(c.args[pi + 1]!) as Record<string, unknown>),
	};
}
