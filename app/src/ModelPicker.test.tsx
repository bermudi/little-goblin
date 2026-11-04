import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { ProviderModelCatalog } from "../../src/http/app-wire.ts";
import { ModelPicker } from "./ModelPicker.tsx";

// happy-dom mount — no fetch: the picker is a pure component.
const CATALOG: ProviderModelCatalog[] = [
	{
		provider: "prov",
		models: [
			{ id: "a", name: "Alpha", releaseDate: "2026-01-01" },
			{ id: "b", name: "Beta", releaseDate: "2026-02-01" },
		],
	},
	{
		provider: "other",
		models: [{ id: "z", name: "Zeta", releaseDate: "2026-03-01" }],
	},
];

describe("ModelPicker", () => {
	let win: Window;
	let container: HTMLElement;
	let root: Root | null = null;
	const installed: string[] = [];
	const install = (name: string, value: unknown) => {
		Reflect.set(globalThis, name, value);
		installed.push(name);
	};

	beforeEach(() => {
		win = new Window();
		const div = win.document.createElement("div");
		win.document.body.appendChild(div);
		container = div as unknown as HTMLElement;
		installed.length = 0;
		install("window", win);
		install("document", win.document);
		install("navigator", win.navigator);
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	});

	afterEach(async () => {
		if (root !== null) {
			await act(async () => {
				root?.unmount();
			});
			root = null;
		}
		await win.happyDOM.close();
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		for (const name of installed) Reflect.deleteProperty(globalThis, name);
	});

	const click = async (el: Element | null | undefined) => {
		expect(el).toBeTruthy();
		await act(async () => {
			el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
		});
	};

	const mount = async (props: {
		favorites?: string[];
		pickerModels?: string[] | null;
		current?: string;
		onPick?: (ref: string) => void;
		onToggleFavorite?: (ref: string, on: boolean) => void;
	}) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ModelPicker
					title="Pick a model"
					current={props.current ?? "prov/a"}
					allowOff={false}
					favorites={props.favorites ?? []}
					pickerModels={props.pickerModels ?? null}
					catalog={CATALOG}
					provNames={["prov", "other"]}
					onPick={props.onPick ?? (() => {})}
					onToggleFavorite={props.onToggleFavorite ?? (() => {})}
					onClose={() => {}}
				/>,
			);
		});
	};

	const setScope = async (scope: string) => {
		const select = container.querySelector('select[aria-label="Model provider"]');
		expect(select).toBeTruthy();
		await act(async () => {
			(select as HTMLSelectElement).value = scope;
			select!.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
		});
	};

	const rowRefs = () =>
		[...container.querySelectorAll(".mline .mrow, .msheet-body > .mrow")].map((r) =>
			(r.querySelector(".ref")?.textContent ?? r.textContent ?? "").trim(),
		);

	test("the star toggles the favorite without picking the row", async () => {
		const picked: string[] = [];
		const toggled: [string, boolean][] = [];
		await mount({
			onPick: (ref) => picked.push(ref),
			onToggleFavorite: (ref, on) => toggled.push([ref, on]),
		});
		const star = container.querySelector('[aria-label="favorite prov/b"]');
		expect(star?.textContent).toBe("☆");
		await click(star);
		expect(toggled).toEqual([["prov/b", true]]);
		expect(picked).toEqual([]);
	});

	test("a favorited row's star offers unfavorite", async () => {
		const toggled: [string, boolean][] = [];
		await mount({
			favorites: ["prov/b"],
			onToggleFavorite: (ref, on) => toggled.push([ref, on]),
		});
		const star = container.querySelector('[aria-label="unfavorite prov/b"]');
		expect(star?.textContent).toBe("★");
		await click(star);
		expect(toggled).toEqual([["prov/b", false]]);
	});

	test("a row click picks the model", async () => {
		const picked: string[] = [];
		const toggled: [string, boolean][] = [];
		await mount({
			onPick: (ref) => picked.push(ref),
			onToggleFavorite: (ref, on) => toggled.push([ref, on]),
		});
		const row = [...container.querySelectorAll("button.mrow")].find((b) =>
			b.textContent?.includes("Beta"),
		);
		await click(row);
		expect(picked).toEqual(["prov/b"]);
		expect(toggled).toEqual([]);
	});

	test("favorites list first, before the catalog groups", async () => {
		await mount({ favorites: ["prov/b"] });
		const groups = [...container.querySelectorAll(".mgroup")].map((g) => g.textContent);
		expect(groups[0]).toBe("Favorites");
		// The favorite is pinned out of its provider group.
		const rows = [...container.querySelectorAll(".mline")].map((r) => r.textContent);
		expect(rows[0]).toContain("Beta");
		expect(rows[0]).toContain("prov/b");
	});

	test("a curated list renders favorites, current, then the list — the catalog rest stays hidden", async () => {
		await mount({ favorites: ["prov/b"], pickerModels: ["prov/b", "other/z"] });
		const rows = rowRefs();
		// Favorites float first; the current ref stays pinned; the curated
		// tail follows in list order. prov/a is only the Current row — the
		// catalog groups are replaced by the membership list.
		expect(rows).toEqual(["prov/b", "prov/a", "other/z"]);
		const groups = [...container.querySelectorAll(".mgroup")].map((g) => g.textContent);
		expect(groups).toEqual(["Favorites", "Current", "Models"]);
	});

	test("a hidden favorite stays hidden until the settings list re-enables it", async () => {
		await mount({ favorites: ["other/z"], pickerModels: ["prov/b"] });
		// Current renders before the curated tail; the hidden favorite is
		// nowhere in the sheet.
		expect(rowRefs()).toEqual(["prov/a", "prov/b"]);
	});

	test("an empty curated list leaves the current ref and the typed path", async () => {
		const picked: string[] = [];
		await mount({ pickerModels: [], onPick: (ref) => picked.push(ref) });
		expect(rowRefs()).toEqual(["prov/a"]);
		// The typed path survives Disable all: Enter on a full ref picks it
		// even though nothing is enabled. The type gesture is the repo's
		// standard one — prototype value setter, then input+keyup (the
		// keyup is what flushes React's change plugin under happy-dom).
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Search models"]',
		);
		expect(input).toBeTruthy();
		await act(async () => {
			(input as HTMLElement).focus();
			Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
				input,
				"other/z",
			);
			input!.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
			input!.dispatchEvent(
				new win.KeyboardEvent("keyup", { bubbles: true, key: "e" }) as unknown as Event,
			);
		});
		await act(async () => {
			input!.dispatchEvent(
				new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
			);
		});
		expect(picked).toEqual(["other/z"]);
	});

	test("the provider scope filters catalog groups, favorites and current", async () => {
		await mount({ favorites: ["prov/b", "other/z"], current: "prov/a" });
		expect(rowRefs()).toContain("prov/b");
		expect(rowRefs()).toContain("other/z");
		expect(rowRefs()).toContain("prov/a");
		await setScope("other");
		const refs = rowRefs();
		// The scope wins over the pin: other-provider favorites and the
		// current ref leave the sheet entirely.
		expect(refs).toEqual(["other/z"]);
		// Clearing restores every row.
		await setScope("");
		expect(rowRefs()).toEqual(
			expect.arrayContaining(["prov/b", "other/z", "prov/a"]),
		);
	});

	test("a scope with an empty catalog still shows that provider's favorites", async () => {
		await mount({ favorites: ["prov/b", "other/z"], current: "prov/a" });
		await setScope("prov");
		const refs = rowRefs();
		expect(refs).toContain("prov/b");
		expect(refs).toContain("prov/a");
		expect(refs).not.toContain("other/z");
	});

	test("a typed current matching a favorite only by case renders once", async () => {
		await mount({ favorites: ["zhipu/glm-5"], current: "Zhipu/GLM-5" });
		expect(rowRefs().filter((r) => r.toLowerCase().includes("zhipu/glm-5"))).toEqual([
			"zhipu/glm-5",
		]);
	});

	test("a catalog row matching the current ref only by case is pinned out", async () => {
		await mount({ current: "PROV/A" });
		// Only the Current row carries that model — the catalog row, which
		// differs just by case, is pinned out.
		const rows = rowRefs().filter((r) => r.toLowerCase().includes("prov/a"));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("PROV/A");
		// The untouched catalog row still shows.
		expect(rowRefs()).toContain("prov/b");
	});
});
