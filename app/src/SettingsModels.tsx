// Models — chat models, helper models, and the chat picker's curated
// membership list (toggle = offered in the pickers, star = pinned
// first, arrows = order within the pinned/unpinned segments).
import { useState } from "react";
import type { ThinkingLevel } from "../../src/config.ts";
import { displayLevel, type SettingsDraft } from "./settingsDraft.ts";
import { Row, Seg, type SettingsCtx, Switch } from "./settingsKit.tsx";

const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

// Case-insensitive ref identity everywhere — the typed paths store refs
// exactly as entered while catalogs lowercase nothing.
const sameRef = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function SettingsModels({ ctx }: { ctx: SettingsCtx }) {
	const { draft, patchDraft, levels, modelNames, setSheet, modelButton, toggleFavoriteDraft, setNotice } =
		ctx;
	// Catalog refs in catalog order — the uncurated baseline.
	const catalogRefs: string[] = [];
	for (const group of ctx.modelCatalog)
		for (const m of group.models) catalogRefs.push(`${group.provider}/${m.id}`);
	const favSet = new Set(draft.favorites.map((f) => f.toLowerCase()));
	const isFav = (ref: string) => favSet.has(ref.toLowerCase());

	// Enabled refs in display order: favorites floated first (favorites
	// order), then the rest in list (or catalog) order. Case-dupes from
	// the typed paths keep their first occurrence.
	const withDupe = (refs: string[]) => {
		const seen = new Set<string>();
		return refs.filter((r) => {
			const k = r.toLowerCase();
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		});
	};
	// The membership base a mutation starts from — reading the uncurated
	// state as its display list, so the first toggle pins exactly what
	// the operator was looking at.
	const baseList = () =>
		draft.pickerModels ??
		withDupe([...draft.favorites, ...catalogRefs.filter((r) => !isFav(r))]);
	const ordered = withDupe(
		draft.pickerModels === null
			? baseList()
			: [...draft.favorites.filter((f) => draft.pickerModels!.some((r) => sameRef(r, f))), ...draft.pickerModels],
	);
	// Everything the operator could re-enable: catalog, stars, the
	// curated list, and the custom-ref inventory (hiding a custom model
	// must not forget it — the inventory is the way back).
	const known = withDupe([
		...catalogRefs,
		...draft.favorites,
		...(draft.pickerModels ?? []),
		...draft.customModels,
	]);
	const enabledSet = new Set(ordered.map((r) => r.toLowerCase()));
	const hidden = known.filter((r) => !enabledSet.has(r.toLowerCase()));
	// Segment boundary for the arrows — favorites float above the rest,
	// and a move never crosses it.
	const favCount = ordered.filter(isFav).length;

	// Custom model rows — refs no configured provider's catalog knows.
	const custom = (ref: string) => !catalogRefs.some((r) => sameRef(r, ref));

	const setPicker = (refs: string[]) => patchDraft({ pickerModels: withDupe(refs) });
	// A custom ref leaving the membership keeps its inventory entry —
	// catalog refs rebuild themselves, custom refs can't.
	const rememberCustom = (ref: string): Partial<SettingsDraft> =>
		custom(ref) && !draft.customModels.some((r) => sameRef(r, ref))
			? { customModels: [...draft.customModels, ref] }
			: {};
	const setEnabled = (ref: string, on: boolean) => {
		const base = baseList();
		if (on) {
			if (!base.some((r) => sameRef(r, ref))) setPicker([...base, ref]);
			return;
		}
		patchDraft({
			pickerModels: withDupe(base.filter((r) => !sameRef(r, ref))),
			...rememberCustom(ref),
		});
	};
	// Favorites reorder within the visible favorites: hidden favorites
	// (starred but toggled off) keep their array slots while the enabled
	// ones take the new display order around them.
	const moveFav = (ref: string, d: number) => {
		const disp = ordered.slice(0, favCount);
		const i = disp.indexOf(ref);
		const j = i + d;
		if (i < 0 || j < 0 || j >= disp.length) return;
		const next = disp.slice();
		next[i] = next[j]!;
		next[j] = ref;
		const queue = [...next];
		patchDraft({
			favorites: draft.favorites.map((f) =>
				enabledSet.has(f.toLowerCase()) ? (queue.shift() ?? f) : f,
			),
		});
	};
	const moveRow = (i: number, d: number) => {
		const j = i + d;
		if (j < 0 || j >= ordered.length) return;
		// Segment edge: favorites reorder favorites; the rest reorders the
		// rest. Crossing the boundary would silently restar/reorder.
		if (Math.min(i, j) < favCount !== Math.max(i, j) < favCount) return;
		const ref = ordered[i]!;
		if (isFav(ref)) {
			moveFav(ref, d);
			return;
		}
		const favs = ordered.slice(0, favCount);
		const rest = ordered.slice(favCount);
		const k = i - favCount;
		const swap = rest[k]!;
		rest[k] = rest[k + d]!;
		rest[k + d] = swap;
		setPicker([...favs, ...rest]);
	};
	const removeRef = (ref: string) =>
		patchDraft({
			favorites: draft.favorites.filter((f) => !sameRef(f, ref)),
			...(draft.pickerModels !== null
				? { pickerModels: draft.pickerModels.filter((r) => !sameRef(r, ref)) }
				: {}),
			// × is the one exit that forgets: inventory, membership, star.
			customModels: draft.customModels.filter((r) => !sameRef(r, ref)),
		});

	const [query, setQuery] = useState("");
	const [adding, setAdding] = useState(false);
	const [customRef, setCustomRef] = useState("");
	const q = query.trim().toLowerCase();
	const hit = (ref: string) =>
		q === "" ||
		ref.toLowerCase().includes(q) ||
		(modelNames.get(ref)?.toLowerCase().includes(q) ?? false);
	const shown = ordered.filter(hit);
	const shownHidden = hidden.filter(hit);

	const addCustom = () => {
		const ref = customRef.trim();
		// splitModelRef's contract: provider up to the FIRST slash, the
		// model id the rest — namespaced ids (openrouter/anthropic/...)
		// carry slashes, only whitespace is a typo.
		if (!/^[^\s/]+\/[^\s]+$/.test(ref)) {
			setNotice({ text: "Custom models take a provider/model-id ref.", kind: "err" });
			return;
		}
		if (known.some((r) => sameRef(r, ref))) {
			setNotice({ text: `${ref} is already in the list.`, kind: "err" });
			return;
		}
		patchDraft({
			pickerModels: withDupe([...baseList(), ref]),
			customModels: [...draft.customModels, ref],
		});
		setCustomRef("");
		setAdding(false);
	};

	const disableAll = () => {
		if (draft.pickerModels === null) {
			// Uncurated has no custom membership to lose — favorites keep
			// their refs.
			setPicker([]);
			return;
		}
		const strays = withDupe(
			draft.pickerModels.filter((r) => custom(r) && !draft.customModels.some((x) => sameRef(x, r))),
		);
		patchDraft({
			pickerModels: [],
			...(strays.length > 0 ? { customModels: [...draft.customModels, ...strays] } : {}),
		});
	};

	const row = (ref: string, on: boolean) => {
		const name = modelNames.get(ref);
		const i = ordered.indexOf(ref);
		// The star mutates the STORED favorite spelling: the row may show
		// the catalog's casing while favorites hold another (typed paths
		// store as entered), and unfavorite compares exactly.
		const fav = draft.favorites.find((f) => sameRef(f, ref)) ?? ref;
		return (
			<div className="chain-card pk-row" key={ref}>
				<div className="chain-head">
					<button
						type="button"
						className={isFav(ref) ? "pk-star on" : "pk-star"}
						aria-label={isFav(ref) ? `unfavorite ${fav}` : `favorite ${fav}`}
						onClick={() => toggleFavoriteDraft(fav, !isFav(fav))}
					>
						{isFav(ref) ? "★" : "☆"}
					</button>
					<span className="fav-cell">
						<span className="fav-name">{name ?? ref}</span>
						{name !== undefined && <span className="fav-ref">{ref}</span>}
					</span>
					<span className="chain-btns">
						{custom(ref) && (
							<button type="button" aria-label={`remove ${ref}`} onClick={() => removeRef(ref)}>
								×
							</button>
						)}
						{on && (
							<>
								<button
									type="button"
									aria-label={`move ${ref} up`}
									disabled={i === 0 || i === favCount}
									onClick={() => moveRow(i, -1)}
								>
									↑
								</button>
								<button
									type="button"
									aria-label={`move ${ref} down`}
									disabled={i === ordered.length - 1 || i === favCount - 1}
									onClick={() => moveRow(i, 1)}
								>
									↓
								</button>
							</>
						)}
					</span>
					<Switch
						on={on}
						ariaLabel={on ? `hide ${ref} from the picker` : `show ${ref} in the picker`}
						onChange={(v) => setEnabled(ref, v)}
					/>
				</div>
			</div>
		);
	};

	return (
		<>
			<h2 className="ops-h2">Chat picker</h2>
			<div className="card">
				<div className="pk-tools">
					<input
						className="mono pk-filter"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter models"
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label="Filter models"
					/>
					<button
						className="pk-toolbtn"
						type="button"
						disabled={ordered.length === 0}
						onClick={disableAll}
					>
						Disable all
					</button>
					<span className="pk-count">
						{known.length} models · {hidden.length} hidden
					</span>
				</div>
				<div className="pk-add">
					{adding ? (
						<div className="addrow">
							<input
								className="mono"
								value={customRef}
								onChange={(e) => setCustomRef(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addCustom();
									}
								}}
								placeholder="provider/model-id"
								autoComplete="off"
								spellCheck={false}
								autoCapitalize="off"
								aria-label="Custom model ref"
							/>
							<button className="addbtn" type="button" onClick={addCustom}>
								Add
							</button>
							<button
								className="addbtn"
								type="button"
								onClick={() => {
									setAdding(false);
									setCustomRef("");
								}}
							>
								Cancel
							</button>
						</div>
					) : (
						<button className="keylink" type="button" onClick={() => setAdding(true)}>
							+ Add custom model
						</button>
					)}
				</div>
				{shown.map((ref) => row(ref, true))}
				{shownHidden.length > 0 && <div className="mgroup">Hidden from picker</div>}
				{shownHidden.map((ref) => row(ref, false))}
				{q !== "" && shown.length === 0 && shownHidden.length === 0 && (
					<div className="cap ops-cap">No models match.</div>
				)}
				<div className="cap">
					What the chat pickers offer, here and on every connected device. Stars pin a model
					first; the toggle hides it from the picker without touching the bindings above. Custom
					refs — anything the catalog doesn't know — stay listed while hidden; only the × removes
					one.
				</div>
			</div>
			<h2 className="ops-h2">Default models</h2>
			<div className="card">
				{modelButton(
					"App chats",
					"New app conversations only. Each chat remembers its own model and thinking level.",
					"model",
					draft.model,
					"appModelLabel",
				)}
				<Row
					label="Thinking"
					cap={
						levels.app.unavailable
							? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
							: "Only levels this model can express are shown."
					}
					col
				>
					<Seg
						options={levels.app.values}
						value={displayLevel(draft.thinking, levels.app.values)}
						ariaLabel="App default thinking level"
						onChange={(v) => patchDraft({ thinking: v as ThinkingLevel })}
					/>
				</Row>
				{draft.telegramEnabled ? (
					<>
						{modelButton(
							"Telegram",
							"Shared by all Telegram conversations.",
							"telegram",
							draft.telegramModel,
							"tgModelLabel",
						)}
						<Row
							label="Telegram thinking"
							cap={
								levels.telegram.unavailable
									? "Couldn't check this model's levels — every rung is shown; the server clamps at send time."
									: "Only levels this model can express are shown."
							}
							col
						>
							<Seg
								options={levels.telegram.values}
								value={displayLevel(draft.telegramThinking, levels.telegram.values)}
								ariaLabel="Telegram thinking level"
								onChange={(v) => patchDraft({ telegramThinking: v as ThinkingLevel })}
							/>
						</Row>
					</>
				) : (
					<div className="cap ops-cap">Telegram is off — turn it on under Telegram.</div>
				)}
			</div>
			<h2 className="ops-h2">Fallbacks</h2>
			<div className="card">
				{draft.modelFallbacks.map((f, i) => {
					const name = modelNames.get(f);
					const move = (d: number) => {
						const j = i + d;
						if (j < 0 || j >= draft.modelFallbacks.length) return;
						const next = draft.modelFallbacks.slice();
						next[i] = next[j]!;
						next[j] = f;
						patchDraft({ modelFallbacks: next });
					};
					return (
						<div className="chain-card" key={`${i}:${f}`}>
							<div className="chain-head">
								<span className="fav-cell">
									<span className="fav-name">
										{i + 1}. {name ?? f}
									</span>
									{name !== undefined && <span className="fav-ref">{f}</span>}
								</span>
								<span className="chain-btns">
									<button
										type="button"
										aria-label={`move fallback ${f} up`}
										disabled={i === 0}
										onClick={() => move(-1)}
									>
										↑
									</button>
									<button
										type="button"
										aria-label={`move fallback ${f} down`}
										disabled={i === draft.modelFallbacks.length - 1}
										onClick={() => move(1)}
									>
										↓
									</button>
									<button
										type="button"
										aria-label={`remove fallback ${f}`}
										onClick={() =>
											patchDraft({
												modelFallbacks: draft.modelFallbacks.filter((_, j) => j !== i),
											})
										}
									>
										×
									</button>
								</span>
							</div>
						</div>
					);
				})}
				<button className="ghost" type="button" onClick={() => setSheet("fallback")}>
					+ Add fallback
				</button>
				<div className="cap">
					When a chat's own model fails before doing anything (quota, outage, bad key), the turn
					tries these in order. Every chat, app and Telegram; compaction too. Empty = no fallback.
				</div>
			</div>
			{/* Helpers run on every surface — Telegram turns included — so
			    the card sits outside both channel groupings. */}
			<h2 className="ops-h2">Helpers</h2>
			<div className="card">
				{modelButton(
					"Topic titles",
					"Names Telegram topics and new app chats, then stops.",
					"title",
					draft.titleModel,
					"titleModelLabel",
				)}
				{modelButton(
					"Vision",
					"Adds a vision tool — answers questions about image files. Needed when the chat model can't see attachments. Telegram and app turns.",
					"vision",
					draft.vision?.model ?? "",
					"visionLabel",
				)}
				{modelButton(
					"Image generation",
					"Adds an image tool — the OpenAI images endpoint.",
					"image",
					draft.image?.model ?? "",
					"imageLabel",
				)}
				{draft.image !== null && (
					<Row label="Image size" cap="A default for the tool's calls — it may pick another." col>
						<Seg
							options={["default", ...IMAGE_SIZES]}
							value={draft.image.size === "" ? "default" : draft.image.size}
							ariaLabel="Image size"
							onChange={(v) =>
								patchDraft({
									image:
										draft.image === null
											? draft.image
											: { ...draft.image, size: v === "default" ? "" : v },
								})
							}
						/>
					</Row>
				)}
			</div>
		</>
	);
}
