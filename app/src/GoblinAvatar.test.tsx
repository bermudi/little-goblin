import { expect, test } from "bun:test";
import { GoblinAvatar } from "./GoblinAvatar.tsx";

test("Goblin avatar uses the transparent portrait and exposes working state", () => {
	const html = GoblinAvatar({ size: "lg", working: true });
	expect(html.props.className).toBe("goblin-avatar goblin-avatar-lg");
	expect(html.props["data-working"]).toBe("");
	expect(html.props.children.props.src).toBe("/app/goblin-portrait.webp");
	expect(GoblinAvatar({ size: "sm", working: false }).props["data-working"]).toBeUndefined();
});
