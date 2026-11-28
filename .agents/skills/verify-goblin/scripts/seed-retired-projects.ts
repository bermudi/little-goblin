import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appAddress } from "../../../../src/conversation-address.ts";
import { openStore } from "../../../../src/conversation.ts";
import { paths } from "../../../../src/home-layout.ts";
import { setLogStream } from "../../../../src/log.ts";
import { openNotes } from "../../../../src/notes.ts";
import { openProjects } from "../../../../src/projects.ts";

const home = process.env.GOBLIN_HOME;
if (home === undefined || dirname(home) !== join(tmpdir(), "goblin-verify") ||
	!/^[a-z0-9-]+$/.test(home.slice(dirname(home).length + 1))) {
	throw new Error("Set GOBLIN_HOME to a new named home under /tmp/goblin-verify.");
}
if (existsSync(home)) throw new Error(`Refusing to seed an existing home: ${home}`);
mkdirSync(paths.state(), { recursive: true });
if (realpathSync(home) !== home) throw new Error("The verification home cannot be a symlink.");
setLogStream(process.stderr);
const store = openStore(paths.db());
try {
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const workshop = projects.create({
		name: "Workshop",
		instructions: "Check the saw inventory before ordering.",
		memory: "off",
	});
	const garden = projects.create({
		name: "Garden",
		instructions: "Only use plants that tolerate dry shade.",
	});
	const finished = projects.create({ name: "Finished renovation" });
	projects.patch(finished.id, { archived: true });
	for (const [project, id, title, text] of [
		[workshop, "retired-saw", "Saw repairs", "The saw needs a new cord."],
		[garden, "retired-seeds", "Seeds to order", "Try two bags of clover."],
		[finished, "retired-keys", "Spare keys", "Spare keys are in the cabinet."],
	] as const) {
		const chat = store.resolve(appAddress(id), paths.workspace());
		store.bindProject(chat.id, project.id);
		store.setMeta(chat.id, { title });
		store.append(chat.id, [{ id: `old-${id}`, role: "user", parts: [{ type: "text", text }] }]);
	}
	const inventory = notes.create({ title: "Saw inventory", body: "One bench saw", projectId: workshop.id });
	store.chatNotePins.set("app/retired-saw", inventory.id, true);
	writeFileSync(join(workshop.dir, "inventory.txt"), "One bench saw\n");
	process.stdout.write(`${workshop.id}\n`);
} finally {
	store.close();
}
