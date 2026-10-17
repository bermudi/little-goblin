import { test } from "bun:test";
import { join } from "node:path";
import { textModel } from "../testkit/fake-model.ts";
import { type Config, type ConfigRef } from "../config.ts";
import { openStore } from "../conversation.ts";
import { Runtime } from "../runtime.ts";
import { openNotes } from "../notes.ts";
import { openProjects, projectWorkdir } from "../projects.ts";
import type { AuthStore } from "../auth.ts";
import { startHttp } from "./mod.ts";
import { handleAppApi, resolveAppAuth, type AppChannelDeps } from "./app-channel.ts";
import { useHome } from "../testkit.ts";

// End-to-end over the real HTTP listener with the model faked at the
// provider edge (the suite's convention). The appApi closure mirrors
// index.ts's wiring verbatim.

export const APP_TOKEN_NAME = "app-token";
export const APP_TOKEN_VALUE = "sekret-app-token";

export function setup(
	opts: {
		token?: string | undefined;
		wireApp?: boolean;
		deltas?: string[];
		delayMs?: number;
		transcribe?: AppChannelDeps["transcribe"];
		speak?: AppChannelDeps["speak"];
		// Records each turn's resolved working directory — the same
		// workdirFor value index.ts feeds makeTools/sandbox/delegate.
		workdirs?: string[];
		titleFor?: AppChannelDeps["titleFor"];
		operator?: AppChannelDeps["operator"];
		rewriteNote?: AppChannelDeps["rewriteNote"];
	} = {},
) {
	const home = useHome("goblin-app-");
	const store = openStore(join(home, "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const runtime = new Runtime({
		store,
		buildStep: () => ({
			model: textModel(opts.deltas ?? ["hello", " app"], {
				...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
			}).model,
			system: "test",
		}),
		// projectWorkdir mirrors index.ts's workdirFor — a vanished
		// project dir throws here, inside the turn's admission.
		makeTools: (conv) => {
			opts.workdirs?.push(projectWorkdir(projects, conv));
			return {};
		},
	});
	const auth: Pick<AuthStore, "resolve"> = {
		resolve: (name) =>
			name === APP_TOKEN_NAME
				? Promise.resolve(APP_TOKEN_VALUE)
				: Promise.reject(new Error("no such auth record")),
	};
	const configRef: ConfigRef = {
		current: {
			providers: {
				zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
			},
			model: "zai/m",
			tts: false,
			favorites: [],
			thinking: "medium",
			operators: [42],
			allowedUsers: [42],
			telegram: { dmGapMinutes: 45, richReplies: true, showReasoning: false },
			http: { port: 0 },
			logLevel: "info",
			...(opts.token !== undefined ? { appToken: opts.token } : {}),
		} as Config,
		ttsDown: false,
	};
	const configWrites = { count: 0 };
	// Boot-time resolution, verbatim index.ts: the mode pins for the
	// life of this "process" — a configRef flip below must not reach it.
	const appTokenName = resolveAppAuth(opts.token);
	const appDeps: AppChannelDeps = {
		store,
		runtime,
		projects,
		notes,
		auth,
		configRef,
		onConfigWritten: () => {
			configWrites.count += 1;
		},
		...(opts.transcribe !== undefined ? { transcribe: opts.transcribe } : {}),
		...(opts.speak !== undefined ? { speak: opts.speak } : {}),
		...(opts.titleFor !== undefined ? { titleFor: opts.titleFor } : {}),
		...(opts.operator !== undefined ? { operator: opts.operator } : {}),
		...(opts.rewriteNote !== undefined ? { rewriteNote: opts.rewriteNote } : {}),
	};
	const http = startHttp({
		configRef,
		botToken: "test-bot-token",
		onConfigWritten: () => {},
		// The composition-root wiring, verbatim: the handler reaches this
		// module only through the opaque dep.
		...(opts.wireApp === false
			? {}
			: { appApi: (req: Request, url: URL) => handleAppApi(req, url, appTokenName, appDeps) }),
	});
	const call = (path: string, init: RequestInit = {}, bearer: string | null = APP_TOKEN_VALUE) =>
		fetch(`http://127.0.0.1:${http.port}${path}`, {
			...init,
			headers: {
				...(init.headers ?? {}),
				...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
			},
		});
	return { http, store, runtime, projects, notes, configRef, configWrites, call, home, appDeps };
}

// The minted conversation + one chat turn, drained — the shape every
// feature test below starts from.
export async function createAndChat(
	call: (path: string, init?: RequestInit) => Promise<Response>,
	text = "hi",
	id = "chat-01",
) {
	await call("/api/app/conversations", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	});
	const res = await call("/api/app/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			conversationId: `app/${id}`,
			message: { id: "m1", role: "user", parts: [{ type: "text", text }] },
		}),
	});
	const sse = await res.text();
	return { res, sse };
}
