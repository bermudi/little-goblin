// Crash-lab child: a real process owning real Pi Durable SQLite storage.
// MODE=submit opens the harness, submits one input (the model answers with
// an `act` call), and hangs — the test SIGKILLs it mid-dispatch.
// MODE=resume-file reopens the storage after a crash, resumes, and parks in
// the approval gate, serving the request over files so the test can kill it
// a second time, still undecided.
//
// Env (no secrets): MODE, GATED, HANG, STORAGE_PATH, MODEL_URL,
// MARKER_PATH, and for MODE=resume-file also REQUEST_PATH, DECISION_PATH.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ApprovalDecision, ApprovalHost } from "./gate.ts";
import { buildRegistry, MODEL_REF, makeActTool, makeModels } from "./lab.ts";

const env = process.env;
const mode = env.MODE ?? "";
const gated = env.GATED === "1";
const hang = env.HANG === "1";
const storagePath = env.STORAGE_PATH ?? "";
const modelUrl = env.MODEL_URL ?? "";
const markerPath = env.MARKER_PATH ?? "";
if (mode !== "submit" && mode !== "resume-file") throw new Error(`bad MODE: ${mode}`);
if (storagePath === "" || modelUrl === "" || markerPath === "") {
	throw new Error("STORAGE_PATH, MODEL_URL and MARKER_PATH are required");
}

const throwingHost: ApprovalHost = {
	requestApproval: async () => {
		throw new Error("approval requested where none should be");
	},
};

function fileHost(requestPath: string, decisionPath: string): ApprovalHost {
	return {
		requestApproval: async (request) => {
			writeFileSync(requestPath, JSON.stringify(request));
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				if (existsSync(decisionPath)) {
					return JSON.parse(readFileSync(decisionPath, "utf8")) as ApprovalDecision;
				}
				await Bun.sleep(40);
			}
			throw new Error("no operator decision arrived");
		},
	};
}

const host: ApprovalHost =
	mode === "resume-file" ? fileHost(env.REQUEST_PATH ?? "", env.DECISION_PATH ?? "") : throwingHost;

const models = await makeModels(modelUrl);
const registry = buildRegistry(gated, makeActTool(hang, markerPath), host);
const harness = await Harness.open(
	await openNodeSqliteStorage(storagePath),
	{ models, registry },
	ctx,
);
if (mode === "submit") {
	const root = await harness.root(ctx, { agent: { model: MODEL_REF } });
	await root.submit({ type: "input", content: "Run act on the widget." }, ctx);
} else {
	await harness.resume();
}
setInterval(() => {}, 3_600_000); // hold the event loop for the SIGKILL
