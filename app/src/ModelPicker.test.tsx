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
		mode?: "pick" | "favorites";
		onPick?: (ref: string) => void;
		onToggleFavorite?: (ref: string, on: boolean) => void;
	}) => {
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<ModelPicker
					title="Pick a model"
					current="prov/a"
					allowOff={false}
					favorites={props.favorites ?? []}
					catalog={CATALOG}
					provNames={["prov"]}
					{...(props.mode !== undefined ? { mode: props.mode } : {})}
					onPick={props.onPick ?? (() => {})}
					onToggleFavorite={props.onToggleFavorite ?? (() => {})}
					onClose={() => {}}
				/>,
			);
		});
	};

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

	test("favorites mode toggles on a row click instead of picking", async () => {
		const picked: string[] = [];
		const toggled: [string, boolean][] = [];
		await mount({
			mode: "favorites",
			onPick: (ref) => picked.push(ref),
			onToggleFavorite: (ref, on) => toggled.push([ref, on]),
		});
		const row = [...container.querySelectorAll("button.mrow")].find((b) =>
			b.textContent?.includes("Beta"),
		);
		await click(row);
		expect(toggled).toEqual([["prov/b", true]]);
		expect(picked).toEqual([]);
	});
});
