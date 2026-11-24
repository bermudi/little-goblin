import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GoblinFace } from "./GoblinFace.tsx";

const markup = (working: number, needs: number | null, failed = false) =>
	renderToStaticMarkup(<GoblinFace working={working} needs={needs} failed={failed} onClick={() => {}} />);

test("face labels and badge show idle, jobs, needs and failed attention", () => {
	expect(markup(0, 0)).toContain('aria-label="Goblin, idle"');
	expect(markup(1, 0)).toContain('aria-label="Goblin, 1 job"');
	expect(markup(2, 1)).toContain('aria-label="Goblin, 2 jobs, 1 needs you"');
	expect(markup(0, 3)).toContain('aria-label="Goblin, 3 need you"');
	expect(markup(0, 120)).toContain(">99+</span>");
	expect(markup(0, null, true)).toContain("couldn&#x27;t load what needs you");
	expect(markup(1, 0)).toContain("goblin-avatar-sm");
});
