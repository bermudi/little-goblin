import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function startupFixture(
	mode: string,
	assetMode = "healthy",
	kind: "accept" | "watch" | "brief" = "accept",
	// Floored watches pin what the restart must replace: "dead" measured
	// an inactive unit, "stale" measured the still-running invocation
	// (it can never be accepted), "restarted" measures then restarts
	// again mid-watch.
	floor?: "dead" | "stale" | "restarted",
	// Written to $GOBLIN_HOME/goblin.json5 when present — the watcher
	// reads the boot-pinned telegram switch from it. Absent: no config
	// file, the watcher keeps the strict legacy expectation.
	config?: unknown,
): Promise<{ exit: number; output: string }> {
	const dir = mkdtempSync(join(tmpdir(), "goblin-startup-test-"));
	if (config !== undefined) writeFileSync(join(dir, "goblin.json5"), JSON.stringify(config));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (new URL(req.url).pathname === "/app/") {
				if (mode.startsWith("during-http-")) writeFileSync(join(dir, "during-http"), "changed");
				if (assetMode === "stalled-headers") return await new Promise<Response>(() => {});
				return new Response(
					assetMode === "not-html"
						? "other service"
						: `<!doctype html><div id="root"></div><script src="${assetMode === "remote-origin" ? "https://fixture.invalid/app/main.js" : "/app/assets/main.js"}"></script>`,
					{ headers: { "content-type": "text/html" } },
				);
			}
			if (assetMode === "stalled-body")
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("fixture"));
						},
					}),
				);
			if (assetMode === "oversized") return new Response(new Uint8Array(8 * 1024 * 1024 + 1));
			if (assetMode === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://fixture.invalid/app/main.js" },
				});
			if (assetMode === "asset-html")
				return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
			return new Response("fixture JS", { status: assetMode === "missing" ? 404 : 200 });
		},
	});
	try {
		const metadata = join(dir, "metadata.ts");
		writeFileSync(
			metadata,
			`import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const started=${JSON.stringify(join(dir, "started"))}; const countFile=${JSON.stringify(join(dir, "count"))}; const starts=${JSON.stringify(join(dir, "starts"))};
const mode=${JSON.stringify(mode)};
if(process.argv[2]==='start'){const sc=existsSync(starts)?Number(readFileSync(starts,'utf8')):0;writeFileSync(starts,String(sc+1));writeFileSync(started,String(Math.floor(Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000000)+sc));process.exit(0);}
const startCount=existsSync(starts)?Number(readFileSync(starts,'utf8')):0;
// Each (re)start mints a distinct invocation id, like systemd.
const id=startCount>1?'cccccccccccccccccccccccccccccccc':'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const active=existsSync(started);const mono=active?readFileSync(started,'utf8'):'0';
const brief=${JSON.stringify(kind === "brief")};
if(process.argv[2]==='identity'){
if(active&&mode==='stalled-command')await new Promise(resolve=>setTimeout(resolve,10000));
const changed=existsSync(${JSON.stringify(join(dir, "during-http"))});
const count=existsSync(countFile)?Number(readFileSync(countFile,'utf8')):0; if(active)writeFileSync(countFile,String(count+1));
process.stdout.write('InvocationID='+ (active?((mode==='switch'&&count>0)||(mode==='during-http-switch'&&changed)?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':id):'')+'\\nExecMainStartTimestampMonotonic='+mono+'\\nNRestarts='+(active&&(mode==='restart'||mode==='during-http-restart'&&changed||mode==='watch-restart'&&count>0||mode==='watch-prerestart')?'1':'0')+'\\nActiveState='+(active?'active':'inactive')+'\\n');
}else{
const names=mode==='boot-error'?['boot failed']:mode==='poll-error'?['long polling failed']:mode==='no-polling'?['goblin up']:mode==='cursor'?(process.argv.includes('--after-cursor=fixture-up')?['long polling started']:['goblin up']):['goblin up','long polling started'];
for(const msg of names)process.stdout.write(JSON.stringify({...(mode==='cursor'?{__CURSOR:'fixture-up'}:{}),_SYSTEMD_INVOCATION_ID:mode==='old-logs'?'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':id,__MONOTONIC_TIMESTAMP:mode==='old-time'?'0':mono,__REALTIME_TIMESTAMP:String(mode==='before-attempt'?0:Date.now()*1000),MESSAGE:JSON.stringify({msg,...(msg==='goblin up'&&mode==='generated'?{port:${server.port}}:msg==='goblin up'&&mode==='wrong-port'?{port:${server.port! + 1}}:msg==='goblin up'&&mode==='invalid-port'?{port:0}:{}),error:'FIXTURE_SECRET',body:'FIXTURE_SECRET'})})+'\\n');
process.stdout.write(JSON.stringify({_SYSTEMD_INVOCATION_ID:id,__MONOTONIC_TIMESTAMP:mono,__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:'unstructured FIXTURE_SECRET'})+'\\n');
if(brief){
process.stdout.write(JSON.stringify({SYSLOG_IDENTIFIER:'systemd',__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:'Started goblin.service.'})+'\\n');
process.stdout.write(JSON.stringify({_SYSTEMD_INVOCATION_ID:'dddddddddddddddddddddddddddddddd',__MONOTONIC_TIMESTAMP:'0',__REALTIME_TIMESTAMP:String(Date.now()*1000),MESSAGE:JSON.stringify({msg:'goblin up',error:'FIXTURE_SECRET'})})+'\\n');
}
}`,
		);
		writeFileSync(
			join(bin, "systemctl"),
			`#!/bin/sh\ncase "$*" in\n'--user show goblin.service '*) exec '${process.execPath}' --no-install '${metadata}' identity ;;\n'--user enable goblin.service') : ;;\n'--user start --no-block goblin.service') exec '${process.execPath}' --no-install '${metadata}' start ;;\n*) exit 99 ;;\nesac\n`,
			{ mode: 0o755 },
		);
		writeFileSync(
			join(bin, "journalctl"),
			`#!/bin/sh\nexec '${process.execPath}' --no-install '${metadata}' journal "$@"\n`,
			{ mode: 0o755 },
		);
		const runner = join(dir, "runner.ts");
		const checkStartup = join(import.meta.dir, "check-startup.ts");
		const watchRunner = [
			`import {spawnSync} from 'node:child_process';`,
			`import {readFileSync} from 'node:fs';`,
			`import {watchStartup} from ${JSON.stringify(checkStartup)};`,
			`const started=${JSON.stringify(join(dir, "started"))};`,
			`spawnSync(process.execPath, ['--no-install', ${JSON.stringify(metadata)}, 'start']);`,
			floor === "stale" || floor === "restarted"
				? `const floor={invocationId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',monotonic:Number(readFileSync(started,'utf8'))};`
				: floor === "dead"
					? `const floor={invocationId:'',monotonic:0};`
					: `const floor=undefined;`,
			floor === "restarted"
				? `spawnSync(process.execPath, ['--no-install', ${JSON.stringify(metadata)}, 'start']);`
				: "",
			`try { await watchStartup(${server.port}, 900, floor); process.stdout.write('accepted'); } catch(error) { process.stderr.write(error instanceof Error ? error.message : 'failed'); process.exitCode=1; }`,
		].join("\n");
		// The deploy fallback itself: spawn the shipped CLI under the
		// stubbed systemctl/journalctl and relay its output verbatim.
		const briefRunner = [
			`import {spawnSync} from 'node:child_process';`,
			`spawnSync(process.execPath, ['--no-install', ${JSON.stringify(metadata)}, 'start']);`,
			`const r=spawnSync(process.execPath, ['--no-install', 'run', ${JSON.stringify(checkStartup)}, '--brief', '40'], {encoding:'utf8'});`,
			`process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');`,
			`process.exit(r.status ?? 1);`,
		].join("\n");
		writeFileSync(
			runner,
			kind === "watch"
				? watchRunner
				: kind === "brief"
					? briefRunner
					: `import {acceptStartup} from ${JSON.stringify(checkStartup)};\ntry { await acceptStartup(${mode === "generated" || mode === "missing-port" ? 0 : server.port}, 900); process.stdout.write('accepted'); } catch(error) { process.stderr.write(error instanceof Error ? error.message : 'failed'); process.exitCode=1; }`,
		);
		const proc = Bun.spawn([process.execPath, "--no-install", runner], {
			env: { PATH: `${bin}:/usr/bin`, HOME: dir, GOBLIN_HOME: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exit, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exit, output: stdout + stderr };
	} finally {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("invocation-specific startup acceptance", () => {
	test("configured zero derives actual positive port from the current invocation ready event", async () => {
		const result = await startupFixture("generated");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("journal polling resumes after the last consumed cursor", async () => {
		const result = await startupFixture("cursor");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("both current lifecycle events and served local HTML/assets are required, private fields never print", async () => {
		const result = await startupFixture("healthy");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	for (const mode of [
		"old-logs",
		"old-time",
		"before-attempt",
		"no-polling",
		"restart",
		"switch",
		"boot-error",
		"poll-error",
		"wrong-port",
		"invalid-port",
		"missing-port",
		"stalled-command",
		"during-http-restart",
		"during-http-switch",
	])
		test(`${mode} prevents acceptance without leaking journal bodies`, async () => {
			const result = await startupFixture(mode);
			expect(result.exit).toBe(1);
			expect(result.output).not.toContain("accepted");
			expect(result.output).not.toContain("FIXTURE_SECRET");
		});
	for (const mode of [
		"missing",
		"not-html",
		"stalled-headers",
		"stalled-body",
		"oversized",
		"redirect",
		"asset-html",
		"remote-origin",
	])
		test(`${mode} app fails even with an active service and both lifecycle events`, async () => {
			const result = await startupFixture("healthy", mode);
			expect(result.exit).toBe(1);
			expect(result.output).not.toContain("accepted");
		});
	test("a telegram-disabled boot accepts on up/active/port/assets without polling evidence", async () => {
		// enabled is a boot-pinned channel switch: long polling never starts
		// under it, so demanding the line would time out every legal
		// app-only install (design/doctor.md → startup-aware acceptance).
		const result = await startupFixture("no-polling", "healthy", "accept", undefined, {
			providers: { fake: { kind: "codex" } },
			model: "fake/model",
			operators: [],
			telegram: { enabled: false },
		});
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("a present config with telegram enabled still demands long-polling evidence", async () => {
		const result = await startupFixture("no-polling", "healthy", "accept", undefined, {
			providers: { fake: { kind: "codex" } },
			model: "fake/model",
			operators: [1],
			telegram: { enabled: true },
		});
		expect(result.exit).toBe(1);
		expect(result.output).not.toContain("accepted");
	});
	test("an unreadable config fails as its own category, not raw config content", async () => {
		const result = await startupFixture("no-polling", "healthy", "accept", undefined, {
			telegram: { enabled: false },
		});
		expect(result.exit).toBe(1);
		expect(result.output).toContain("startup config unreadable");
		expect(result.output).not.toContain("accepted");
	});
	test("watch mode accepts the already-started invocation a deploy restart created", async () => {
		const result = await startupFixture("healthy", "healthy", "watch");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("watch mode gates a crash-restart within budget", async () => {
		const result = await startupFixture("watch-restart", "healthy", "watch");
		expect(result.exit).toBe(1);
		expect(result.output).toContain("startup failed or restarted");
		expect(result.output).not.toContain("accepted");
		expect(result.output).not.toContain("FIXTURE_SECRET");
	});
	for (const floor of [undefined, "dead"] as const)
		test(`watch mode refuses an already-replaced invocation (${floor ?? "unfloored"})`, async () => {
			const result = await startupFixture("watch-prerestart", "healthy", "watch", floor);
			expect(result.exit).toBe(1);
			expect(result.output).toContain("startup failed or restarted");
			expect(result.output).not.toContain("accepted");
			expect(result.output).not.toContain("FIXTURE_SECRET");
		});
	test("a floored watch accepts the invocation that postdates a dead unit", async () => {
		const result = await startupFixture("healthy", "healthy", "watch", "dead");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("a floored watch can never accept the floor's own invocation", async () => {
		// The floor measured the still-running unit — the restart pending
		// behind it means that invocation must never satisfy the watch.
		const result = await startupFixture("healthy", "healthy", "watch", "stale");
		expect(result.exit).toBe(1);
		expect(result.output).toContain("startup deadline expired");
		expect(result.output).not.toContain("accepted");
	});
	test("a floored watch accepts a restart that landed after the floor", async () => {
		const result = await startupFixture("healthy", "healthy", "watch", "restarted");
		expect(result.exit).toBe(0);
		expect(result.output).toBe("accepted");
	});
	test("the deploy brief prints lifecycle and systemd lines but never journal bodies", async () => {
		const result = await startupFixture("healthy", "healthy", "brief");
		expect(result.exit).toBe(0);
		expect(result.output).toContain("systemd: Started goblin.service.");
		expect(result.output).toContain("goblin: goblin up");
		expect(result.output).toContain("journal entries withheld");
		expect(result.output).not.toContain("FIXTURE_SECRET");
	});
});
