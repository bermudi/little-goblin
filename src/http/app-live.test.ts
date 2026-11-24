import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDelegations } from "../delegations.ts";
import { startMailApproval } from "../mail-approval.ts";
import { openOutbox } from "../mail-outbox.ts";
import { startProgramApproval } from "../program-approval.ts";
import { openPrograms } from "../programs.ts";
import { appAddress } from "../conversation-address.ts";
import { deferred, sleep, waitUntil } from "../testkit.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { openAppLive } from "./app-live.ts";
import {
	APP_LIVE_TOPICS,
	APP_LIVE_VERSION_HEADER,
	type AppLiveEvent,
	type AppLiveTopic,
	type AppLiveVersions,
} from "./app-live-topics.ts";
import { APP_TOKEN_NAME, APP_TOKEN_VALUE, setup } from "./app-testing.ts";

interface EventReader {
	read(): Promise<{ value?: Uint8Array; done: boolean }>;
	cancel(): Promise<void>;
}

function pumpLive(reader: EventReader, events: AppLiveEvent[]): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	return (async () => {
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				for (;;) {
					const end = buffer.indexOf("\n\n");
					if (end === -1) break;
					const frame = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = frame.split("\n").find((line) => line.startsWith("data: "));
					if (data !== undefined) events.push(JSON.parse(data.slice(6)) as AppLiveEvent);
				}
			}
		} catch {
			return;
		}
	})();
}

async function postJson(
	call: (path: string, init?: RequestInit) => Promise<Response>,
	path: string,
	body: unknown,
): Promise<Response> {
	return call(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const liveStream = async (
	call: (path: string, init?: RequestInit) => Promise<Response>,
) => {
	const res = await call("/api/app/live");
	const events: AppLiveEvent[] = [];
	const reader = res.body!.getReader() as EventReader;
	const pump = pumpLive(reader, events);
	await waitUntil(() => events.length > 0, "initial version map");
	return { res, reader, events, pump };
};

const moved = (
	events: AppLiveEvent[],
	from: number,
	topic: AppLiveTopic,
	baseline: string,
	label: string,
): Promise<void> =>
	waitUntil(
		() => events.slice(from).some((e) => e.versions[topic] !== baseline),
		label,
	);

const skillOperator = (home: string) => ({
	skillSources: {
		forConversation: () => [],
		forgetConversation: () => 0,
		managedNames: () => new Set<string>(),
		skillsDir: join(home, "live-skills"),
		proposedDir: join(home, "live-skills-proposed"),
		archiveDir: join(home, "live-skills-archive"),
		usagePath: join(home, "live-skill-usage.json"),
	},
});

const writeSkill = (home: string) => {
	const dir = join(home, "live-skills", "live-skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		"---\nname: live-skill\ndescription: proves the sweep\n---\nbody\n",
	);
};

describe("app live feed", () => {
	test("announces a complete version map matching every wired GET's version header", async () => {
		const { http, call, home, appDeps } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		const dbPath = join(home, "goblin.sqlite");
		const programs = openPrograms(dbPath);
		const outbox = openOutbox(dbPath);
		const delegations = openDelegations(dbPath);
		const lane = {
			present: async () => ({ kind: "posted", messageId: null, surface: "test" }) as const,
			notice: async () => {},
			settle: async () => {},
			strip: async () => {},
		};
		const mail = startMailApproval(
			{
				outbox,
				sender: () => null,
				reader: () => null,
				lanes: { app: lane, telegram: lane },
				now: () => new Date("2026-11-23T10:00:00Z"),
			},
			60_000,
		);
		const program = startProgramApproval({
			programs,
			publicUrl: () => undefined,
			present: async () => {},
		});
		appDeps.approvals = { program, mail };
		appDeps.operator = {
			programs,
			delegations,
			skillSources: {
				forConversation: () => [],
				forgetConversation: () => 0,
				managedNames: () => new Set(),
				skillsDir: join(home, "live-skills"),
				proposedDir: join(home, "live-skills-proposed"),
				archiveDir: join(home, "live-skills-archive"),
				usagePath: join(home, "live-skill-usage.json"),
			},
		};
		try {
			const { res, reader, events, pump } = await liveStream(call);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
			const first = events[0]!;
			expect(first.type).toBe("versions");
			expect(Object.keys(first.versions).sort()).toEqual([...APP_LIVE_TOPICS].sort());
			const header = async (path: string) =>
				(await call(path)).headers.get(APP_LIVE_VERSION_HEADER);
			for (const topic of APP_LIVE_TOPICS) {
				const got = await call(`/api/app/${topic}`);
				expect(got.status, topic).toBe(200);
				expect(got.headers.get(APP_LIVE_VERSION_HEADER), topic).toBe(first.versions[topic]);
			}
			expect(await header("/api/app/notes?project=loose")).toBeNull();
			expect(await header("/api/app/notes?archived=1")).toBeNull();

			const seen = events.length;
			programs.proposals.proposeCreate(
				{
					name: "live proposal",
					charter: "prove approvals announce",
					cron: "0 9 * * 1",
					maxLatenessMinutes: 60,
					hook: false,
					mailFilter: null,
				},
				{ target: "app/chat-01" },
			);
			await moved(events, seen, "approvals", first.versions.approvals, "approvals announced");
			await moved(events, seen, "attention", first.versions.attention, "attention announced");
			expect(await header("/api/app/approvals")).toBe(events.at(-1)!.versions.approvals);
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
			await mail.stop();
			programs.close();
			outbox.close();
		}
	});

	test("each durable app write moves only its own topic's version", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		try {
			const { reader, events, pump } = await liveStream(call);
			let prev = events[0]!.versions;
			const step = async (
				label: string,
				topic: AppLiveTopic,
				run: () => Promise<Response>,
				get: string,
			) => {
				const from = events.length;
				const res = await run();
				expect(res.status, label).toBeLessThan(400);
				await moved(events, from, topic, prev[topic], `${label} announced`);
				const next = events.at(-1)!.versions;
				for (const t of APP_LIVE_TOPICS) {
					if (t !== topic) expect(next[t], `${label} left ${t} alone`).toBe(prev[t]);
				}
				const got = await call(get);
				expect(got.headers.get(APP_LIVE_VERSION_HEADER), `${label} GET header`).toBe(
					next[topic],
				);
				prev = next;
			};
			const patchJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
				call(path, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				});

			await step(
				"create chat",
				"conversations",
				() => postJson(call, "/api/app/conversations", { id: "live-t2" }),
				"/api/app/conversations",
			);
			await step(
				"rename chat",
				"conversations",
				() => patchJson("/api/app/conversations/live-t2", { title: "renamed" }),
				"/api/app/conversations",
			);
			await step(
				"pin chat",
				"conversations",
				() => patchJson("/api/app/conversations/live-t2", { pinned: true }),
				"/api/app/conversations",
			);
			await step(
				"archive chat",
				"conversations",
				() => patchJson("/api/app/conversations/live-t2", { archived: true }),
				"/api/app/conversations",
			);
			await step(
				"unarchive chat",
				"conversations",
				() => patchJson("/api/app/conversations/live-t2", { archived: false }),
				"/api/app/conversations",
			);
			await step(
				"delete chat",
				"conversations",
				() => call("/api/app/conversations/live-t2", { method: "DELETE" }),
				"/api/app/conversations",
			);

			const fromProject = events.length;
			const project = (await (
				await postJson(call, "/api/app/projects", { name: "live project" })
			).json()) as { id: string };
			await moved(events, fromProject, "projects", prev.projects, "create project announced");
			const afterProject = events.at(-1)!.versions;
			expect(
				(await call("/api/app/projects")).headers.get(APP_LIVE_VERSION_HEADER),
			).toBe(afterProject.projects);
			prev = afterProject;
			await step(
				"rename project",
				"projects",
				() => patchJson(`/api/app/projects/${project.id}`, { name: "live project 2" }),
				"/api/app/projects",
			);

			const fromNote = events.length;
			const note = (await (
				await postJson(call, "/api/app/notes", { title: "live note", body: "v1" })
			).json()) as { id: string; rev: number };
			await moved(events, fromNote, "notes", prev.notes, "create note announced");
			const afterNote = events.at(-1)!.versions;
			expect((await call("/api/app/notes")).headers.get(APP_LIVE_VERSION_HEADER)).toBe(
				afterNote.notes,
			);
			prev = afterNote;
			await step(
				"edit note",
				"notes",
				() =>
					patchJson(
						`/api/app/notes/${note.id}`,
						{ body: "v2" },
						{ "if-match": `"${note.rev}"` },
					),
				"/api/app/notes",
			);
			await step(
				"archive note",
				"notes",
				() => patchJson(`/api/app/notes/${note.id}`, { archived: true }),
				"/api/app/notes",
			);
			await step(
				"delete note",
				"notes",
				() => call(`/api/app/notes/${note.id}`, { method: "DELETE" }),
				"/api/app/notes",
			);
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("a second connection's program and delegation writes announce their topics", async () => {
		const { http, call, appDeps, home } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		const dbPath = join(home, "goblin.sqlite");
		const programs = openPrograms(dbPath);
		const delegations = openDelegations(dbPath);
		appDeps.operator = { programs, delegations };
		try {
			const { reader, events, pump } = await liveStream(call);
			const first = events[0]!.versions;
			const programsGet = await call("/api/app/programs");
			expect(programsGet.status).toBe(200);
			expect(programsGet.headers.get(APP_LIVE_VERSION_HEADER)).toBe(first.programs);
			const fromPrograms = events.length;
			programs.create({
				name: "live program",
				charter: "prove the feed",
				cron: "0 9 * * *",
				address: { chatId: 1, threadId: null },
			});
			await moved(events, fromPrograms, "programs", first.programs, "programs announced");
			const fromDelegations = events.length;
			delegations.create({
				name: "live delegation",
				harness: "fake",
				cwd: "/tmp",
				task: "prove the feed",
				address: { chatId: 1, threadId: null },
			});
			await moved(events, fromDelegations, "delegations", first.delegations, "delegations announced");
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("a skill directory written to disk announces skills on the sweep", async () => {
		const { http, call, appDeps, home } = setup({ token: APP_TOKEN_NAME });
		appDeps.operator = skillOperator(home);
		try {
			const { reader, events, pump } = await liveStream(call);
			const first = events[0]!.versions;
			const fromSkills = events.length;
			writeSkill(home);
			await moved(events, fromSkills, "skills", first.skills, "skills announced on sweep");
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("a busy lane moves activity while it runs and back when it ends", async () => {
		const script = sdkScript();
		const { http, call, runtime } = setup({ token: APP_TOKEN_NAME, scriptedModel: script, liveSweepMs: 60_000 });
		try {
			await postJson(call, "/api/app/conversations", { id: "live-busy" });
			const { reader, events, pump } = await liveStream(call);
			const first = events[0]!.versions;
			const gate = deferred();
			const entered = deferred();
			script.script({
				kind: "hold",
				parts: [{ type: "text", text: "held reply" }],
				gate: gate.promise,
				entered: () => entered.resolve(),
			});
			const fromActivity = events.length;
			const submitted = await postJson(call, "/api/app/chat", {
				conversationId: "app/live-busy",
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
			});
			expect(submitted.status).toBe(202);
			await entered.promise;
			await waitUntil(
				() => runtime.busyConversations().includes("app/live-busy"),
				"busy lane open",
			);
			await moved(events, fromActivity, "activity", first.activity, "activity moved busy");
			gate.resolve();
			await waitUntil(
				() => !runtime.busyConversations().includes("app/live-busy"),
				"busy lane closed",
			);
			await waitUntil(
				() =>
					events.some((e) => e.versions.activity !== first.activity) &&
					events.at(-1)!.versions.activity === first.activity,
				"activity moved back",
			);
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("a lane that opens and closes without a database write moves activity both ways", async () => {
		const { http, call, appDeps, runtime } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		let busy: string[] = [];
		appDeps.runtime = Object.create(runtime, {
			busyConversations: { value: () => busy },
		}) as typeof runtime;
		try {
			await postJson(call, "/api/app/conversations", { id: "live-lane" });
			const { reader, events, pump } = await liveStream(call);
			const idle = events[0]!.versions.activity;
			busy = ["app/live-lane"];
			await waitUntil(() => events.at(-1)!.versions.activity !== idle, "lane opened");
			busy = [];
			await waitUntil(() => events.at(-1)!.versions.activity === idle, "lane closed");
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("a child conversation announces while its parent turn is held", async () => {
		const script = sdkScript();
		const { http, call, store, runtime } = setup({
			token: APP_TOKEN_NAME,
			scriptedModel: script,
			liveSweepMs: 60_000,
		});
		try {
			await postJson(call, "/api/app/conversations", { id: "live-parent" });
			const { reader, events, pump } = await liveStream(call);
			const first = events[0]!.versions;
			const gate = deferred();
			const entered = deferred();
			script.script({
				kind: "hold",
				parts: [{ type: "text", text: "held reply" }],
				gate: gate.promise,
				entered: () => entered.resolve(),
			});
			const submitted = await postJson(call, "/api/app/chat", {
				conversationId: "app/live-parent",
				message: { id: "m1", role: "user", parts: [{ type: "text", text: "go" }] },
			});
			expect(submitted.status).toBe(202);
			await entered.promise;
			await waitUntil(
				() => runtime.busyConversations().includes("app/live-parent"),
				"parent turn held",
			);
			const parent = store.get("app/live-parent");
			expect(parent).not.toBeNull();
			const fromChild = events.length;
			store.resolveAgentChild(
				parent!,
				"general",
				{ model: "zai/m", thinking: "medium" },
				new Date().toISOString(),
			);
			await moved(events, fromChild, "conversations", first.conversations, "child announced");
			expect(runtime.busyConversations()).toContain("app/live-parent");
			gate.resolve();
			await waitUntil(
				() => !runtime.busyConversations().includes("app/live-parent"),
				"parent settled",
			);
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("quiet data produces no events; the last detach stops the watch timer", async () => {
		const { http, call, appDeps, posts, store, configRef } = setup({
			token: APP_TOKEN_NAME,
			liveSweepMs: 40,
		});
		let recentCalls = 0;
		appDeps.posts = {
			recent: (limit, before) => {
				recentCalls += 1;
				return posts.recent(limit, before);
			},
		};
		try {
			const { reader, events, pump } = await liveStream(call);
			await waitUntil(() => recentCalls >= 4, "several sweeps");
			expect(events.length).toBe(1);
			await reader.cancel();
			await pump;
			const frozen = recentCalls;
			store.resolve(appAddress("live-quiet"), "/work", configRef.current);
			await sleep(150);
			expect(recentCalls).toBe(frozen);
		} finally {
			http.stop();
		}
	});

	test("a live subscriber registers no conversation event listeners", async () => {
		const { http, call, runtime } = setup({ token: APP_TOKEN_NAME });
		try {
			await postJson(call, "/api/app/conversations", { id: "live-nosub" });
			const { reader, pump } = await liveStream(call);
			await sleep(120);
			expect(runtime.conversationEventSubscriberCount("app/live-nosub")).toBe(0);
			await reader.cancel();
			await pump;
			expect(runtime.conversationEventSubscriberCount("app/live-nosub")).toBe(0);
		} finally {
			http.stop();
		}
	});

	test("a failing topic announces its error version and recovers", async () => {
		const { http, call, appDeps, notes } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		try {
			const { reader, events, pump } = await liveStream(call);
			const first = events[0]!.versions;
			appDeps.notes = {
				...notes,
				list: () => {
					throw new Error("live-918 boom");
				},
			};
			await postJson(call, "/api/app/conversations", { id: "live-failing" });
			await waitUntil(
				() => events.some((e) => e.versions.notes.startsWith("error:")),
				"notes error announced",
			);
			const failed = events.at(-1)!.versions;
			expect(failed.notes).toContain("error:");
			expect(failed.conversations).not.toBe(first.conversations);
			appDeps.notes = notes;
			await postJson(call, "/api/app/conversations", { id: "live-recovered" });
			await waitUntil(
				() => events.at(-1)!.versions.notes === first.notes,
				"notes recovered",
			);
			await reader.cancel();
			await pump;
		} finally {
			http.stop();
		}
	});

	test("POST is refused, a missing bearer is refused, and cancel + abort both detach", async () => {
		const { http, call, appDeps, posts, store, configRef } = setup({ token: APP_TOKEN_NAME });
		expect((await call("/api/app/live", { method: "POST" })).status).toBe(405);
		expect((await call("/api/app/live", {}, null)).status).toBe(401);
		expect((await call("/api/app/live", {}, "wrong-token")).status).toBe(401);
		let recentCalls = 0;
		appDeps.posts = {
			recent: (limit, before) => {
				recentCalls += 1;
				return posts.recent(limit, before);
			},
		};
		try {
			const { reader, events, pump } = await liveStream(call);
			expect(events[0]!.type).toBe("versions");
			await reader.cancel();
			await pump;
			let frozen = recentCalls;
			store.resolve(appAddress("live-detach-1"), "/work", configRef.current);
			await sleep(150);
			expect(recentCalls).toBe(frozen);

			const ctl = new AbortController();
			const res = await fetch(`http://127.0.0.1:${http.port}/api/app/live`, {
				headers: { authorization: `Bearer ${APP_TOKEN_VALUE}` },
				signal: ctl.signal,
			});
			const events2: AppLiveEvent[] = [];
			const pump2 = pumpLive(res.body!.getReader() as EventReader, events2);
			await waitUntil(() => events2.length > 0, "second initial map");
			ctl.abort();
			await pump2;
			await sleep(150);
			frozen = recentCalls;
			store.resolve(appAddress("live-detach-2"), "/work", configRef.current);
			await sleep(150);
			expect(recentCalls).toBe(frozen);
		} finally {
			http.stop();
		}
	});

	test("a subscriber that attaches after a quiet gap gets the current versions", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		try {
			const gone = await liveStream(call);
			await gone.reader.cancel();
			await gone.pump;
			await postJson(call, "/api/app/conversations", { id: "live-gap" });
			const back = await liveStream(call);
			const list = await call("/api/app/conversations");
			expect(back.events[0]!.versions.conversations).not.toBe(
				gone.events[0]!.versions.conversations,
			);
			expect(list.headers.get(APP_LIVE_VERSION_HEADER)).toBe(
				back.events[0]!.versions.conversations,
			);
			await back.reader.cancel();
			await back.pump;
		} finally {
			http.stop();
		}
	});

	test("a skill written while nobody listens is in the next first event", async () => {
		const { http, call, appDeps, home } = setup({ token: APP_TOKEN_NAME, liveSweepMs: 60_000 });
		appDeps.operator = skillOperator(home);
		try {
			const gone = await liveStream(call);
			await gone.reader.cancel();
			await gone.pump;
			writeSkill(home);
			const back = await liveStream(call);
			expect(back.events[0]!.versions.skills).not.toBe(gone.events[0]!.versions.skills);
			await back.reader.cancel();
			await back.pump;
		} finally {
			http.stop();
		}
	});

	test("a commit that lands during the first read is announced by the next tick", async () => {
		const { http, call, appDeps, posts, home } = setup({
			token: APP_TOKEN_NAME,
			liveSweepMs: 60_000,
		});
		await postJson(call, "/api/app/conversations", { id: "live-race" });
		const other = new Database(join(home, "goblin.sqlite"));
		let raced = false;
		appDeps.posts = {
			recent: (limit, before) => {
				if (!raced) {
					raced = true;
					other.run("UPDATE conversations SET title = 'from elsewhere' WHERE id = 'app/live-race'");
				}
				return posts.recent(limit, before);
			},
		};
		try {
			const { reader, events, pump } = await liveStream(call);
			await moved(events, 0, "conversations", events[0]!.versions.conversations, "race announced");
			await reader.cancel();
			await pump;
		} finally {
			other.close();
			http.stop();
		}
	});

	test("a throwing listener stops neither the other listeners nor the timer", async () => {
		const { http, call, appDeps } = setup({ token: APP_TOKEN_NAME });
		const seen: AppLiveVersions[] = [];
		const bad = appDeps.live.subscribe(() => {
			throw new Error("live-918 listener");
		});
		const good = appDeps.live.subscribe((versions) => seen.push(versions));
		try {
			await postJson(call, "/api/app/conversations", { id: "live-listener-1" });
			await waitUntil(() => seen.length === 1, "first change reached the good listener");
			await postJson(call, "/api/app/conversations", { id: "live-listener-2" });
			await waitUntil(() => seen.length === 2, "second change reached the good listener");
		} finally {
			bad.unsubscribe();
			good.unsubscribe();
			http.stop();
		}
	});

	test("two openAppLive instances on the same data announce equal versions", async () => {
		const { http, call, appDeps } = setup({ token: APP_TOKEN_NAME });
		try {
			await postJson(call, "/api/app/conversations", { id: "live-restart" });
			const first = openAppLive(appDeps).subscribe(() => {});
			const second = openAppLive(appDeps).subscribe(() => {});
			expect(second.versions).toEqual(first.versions);
			first.unsubscribe();
			second.unsubscribe();
		} finally {
			http.stop();
		}
	});
});
