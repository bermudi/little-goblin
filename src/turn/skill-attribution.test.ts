import { expect, test } from "bun:test";
import { join } from "node:path";
import { skillUnderPath } from "./skill-attribution.ts";

const ROOT = "/ws";

test("skill paths resolve only a valid direct-child skill directory", () => {
	expect(skillUnderPath([join(ROOT, "skills")], join(ROOT, "skills/demo/SKILL.md"))).toBe("demo");
	expect(skillUnderPath([join(ROOT, "skills-proposed")], join(ROOT, "skills-proposed/open-source-check/helper.md"))).toBe("open-source-check");
	expect(skillUnderPath([join(ROOT, "skills")], join(ROOT, "skills/notes.md"))).toBeNull();
	expect(skillUnderPath([join(ROOT, "skills")], join(ROOT, "skills/NotASkill/SKILL.md"))).toBeNull();
	expect(skillUnderPath([join(ROOT, "skills")], join(ROOT, "outside/demo/SKILL.md"))).toBeNull();
});
