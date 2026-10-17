// Project routes (design/projects.md): the rail's Projects section and
// the /app/p/<id> page.

import { z } from "zod";
import { log } from "../log.ts";
import { type Project, ProjectInputError } from "../projects.ts";
import { type AppChannelDeps, jsonBodyRefusal, NO_STORE } from "./app-shared.ts";
import type { AppProject, AppProjectList } from "./app-wire.ts";

// Project creation: the linked-dir path goes through the domain's
// resolveLinkedDir (ProjectInputError → 422) — here it's only a
// non-empty string.
const projectCreateBody = z.object({
	name: z.string().trim().min(1).max(80),
	instructions: z.string().max(20_000).optional(),
	memory: z.enum(["shared", "off"]).optional(),
	dir: z.string().min(1).optional(),
});

// The mutable fields; `.strict()` because unknown keys are caller bugs
// (dir gets its own refusal first — its message names the immutability
// ruling rather than "unrecognized key").
const projectPatchBody = z
	.object({
		name: z.string().trim().min(1).max(80).optional(),
		instructions: z.string().max(20_000).optional(),
		memory: z.enum(["shared", "off"]).optional(),
		archived: z.boolean().optional(),
	})
	.strict()
	.refine(
		(p) =>
			p.name !== undefined ||
			p.instructions !== undefined ||
			p.memory !== undefined ||
			p.archived !== undefined,
		{ message: "nothing to write" },
	);

// The wire shape — `home` is goblin-owned scratch the client never
// addresses, so it doesn't cross the boundary.
function appProject(p: Project): AppProject {
	return {
		id: p.id,
		name: p.name,
		slug: p.slug,
		dir: p.dir,
		managed: p.managed,
		instructions: p.instructions,
		memory: p.memory,
		createdAt: p.createdAt,
		archivedAt: p.archivedAt,
	};
}

export async function handleProjectsRoute(
	req: Request,
	url: URL,
	deps: AppChannelDeps,
): Promise<Response | null> {
	const path = url.pathname;

	// Projects (design/projects.md): the rail's Projects section and the
	// /app/p/<id> page. Creation refuses bad linked dirs 422 via
	// ProjectInputError; every other failure propagates to the 500 path.
	if (path === "/api/app/projects") {
		if (req.method === "GET") {
			const body: AppProjectList = { projects: deps.projects.list().map(appProject) };
			log.debug("app project list served", { count: body.projects.length });
			return Response.json(body, { headers: NO_STORE });
		}
		if (req.method === "POST") {
			const refusedJson = jsonBodyRefusal(req);
			if (refusedJson !== null) return refusedJson;
			let json: unknown;
			try {
				json = await req.json();
			} catch {
				return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
			}
			const parsed = projectCreateBody.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: z.prettifyError(parsed.error) },
					{ status: 422, headers: NO_STORE },
				);
			}
			try {
				const project = deps.projects.create(parsed.data);
				return Response.json(appProject(project), { status: 201, headers: NO_STORE });
			} catch (err) {
				if (err instanceof ProjectInputError) {
					return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
				}
				throw err;
			}
		}
		return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
	}

	const projectMatch = path.match(/^\/api\/app\/projects\/([^/]+)$/);
	if (projectMatch) {
		if (req.method !== "GET" && req.method !== "PATCH") {
			return Response.json({ error: "method" }, { status: 405, headers: NO_STORE });
		}
		let projectId: string;
		try {
			projectId = decodeURIComponent(projectMatch[1]!);
		} catch {
			projectId = "";
		}
		const project = deps.projects.get(projectId);
		if (project === null) {
			return Response.json({ error: "no such project" }, { status: 404, headers: NO_STORE });
		}
		if (req.method === "GET") {
			return Response.json(appProject(project), { headers: NO_STORE });
		}
		const refusedJson = jsonBodyRefusal(req);
		if (refusedJson !== null) return refusedJson;
		let json: unknown;
		try {
			json = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
		}
		// dir is not a patchable field — a repoint would silently re-cwd
		// every chat under it; new project, new binding instead.
		if (typeof json === "object" && json !== null && "dir" in json) {
			return Response.json(
				{ error: "dir is immutable after creation" },
				{ status: 422, headers: NO_STORE },
			);
		}
		const parsed = projectPatchBody.safeParse(json);
		if (!parsed.success) {
			return Response.json(
				{ error: z.prettifyError(parsed.error) },
				{ status: 422, headers: NO_STORE },
			);
		}
		try {
			const updated = deps.projects.patch(project.id, parsed.data);
			return Response.json(appProject(updated), { headers: NO_STORE });
		} catch (err) {
			if (err instanceof ProjectInputError) {
				return Response.json({ error: err.message }, { status: 422, headers: NO_STORE });
			}
			throw err;
		}
	}

	return null;
}
