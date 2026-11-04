// The model sheet, shared by Settings and the chat composer: favorites
// first, then the current value, then what the picker offers — a
// curated membership list when one exists (settings → Models), else the
// whole catalog grouped by provider — with a search that also accepts a
// typed provider/model-id. A row chooses the model; the star on every
// model row toggles the favorite without picking it.
import { Fragment, useState } from "react";
import type { ModelOption, ProviderModelCatalog } from "../../src/http/app-wire.ts";

export function ModelPicker({
	title,
	current,
	allowOff,
	favorites,
	pickerModels,
	catalog,
	provNames,
	onPick,
	onToggleFavorite,
	onClose,
}: {
	title: string;
	current: string;
	allowOff: boolean;
	favorites: string[];
	/** The curated membership (settings → Models) — null offers the
	 *  whole catalog grouped by provider. */
	pickerModels: string[] | null;
	catalog: ProviderModelCatalog[];
	provNames: string[];
	onPick: (ref: string) => void;
	onToggleFavorite: (ref: string, on: boolean) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState("");
	// ?? null: an older backend's config view lacks the key — read as
	// never curated, not an empty sheet.
	const curatedList = pickerModels ?? null;
	const q = query.trim().toLowerCase();
	const meta = new Map<string, ModelOption>();
	const canonical = new Map<string, string>();
	for (const group of catalog)
		for (const model of group.models) {
			const ref = `${group.provider}/${model.id}`;
			meta.set(ref, model);
			canonical.set(ref.toLowerCase(), ref);
		}
	const favSet = new Set(favorites.map((f) => f.toLowerCase()));
	const isFav = (ref: string) => ref !== "" && favSet.has(ref.toLowerCase());
	// Search spans the full ref and the catalog's friendly name, so
	// "glm-5.3" and "GLM" both land on the same row.
	const hit = (ref: string) => {
		if (q === "") return true;
		const name = meta.get(ref)?.name?.toLowerCase() ?? "";
		return ref.toLowerCase().includes(q) || name.includes(q);
	};
	// The provider scope filters every model row — favorites and current
	// included — or "codex" reads as broken: its catalog can be empty
	// while other providers' favorites fill the sheet.
	const scoped = (ref: string) =>
		scope === "" || ref.toLowerCase().startsWith(`${scope.toLowerCase()}/`);
	// Curated membership: a star alone doesn't surface a model — hidden
	// favorites stay hidden until the settings list re-enables them.
	const curatedSet = new Set((curatedList ?? []).map((r) => r.toLowerCase()));
	const favs = favorites.filter(
		(f) =>
			scoped(f) &&
			hit(f) &&
			(curatedList === null || curatedSet.has(f.toLowerCase())),
	);
	// The typed path stores refs exactly as entered, so dedupe compares
	// lowercased (like favSet/canonical) while display strings stay as-is.
	// Current is suppressed only when the Favorites block renders it — a
	// starred-but-hidden current must keep its Current row.
	const showCurrent =
		current !== "" &&
		!favs.some((f) => f.toLowerCase() === current.toLowerCase()) &&
		scoped(current) &&
		hit(current);
	const pinned = new Set([...favorites, current].map((r) => r.toLowerCase()));
	// Curated tail: the enabled non-favorites in list order — the same
	// shape the settings list shows.
	const curatedRest =
		curatedList === null
			? []
			: (curatedList ?? [])
					.filter(
						(r) =>
							!favSet.has(r.toLowerCase()) && !pinned.has(r.toLowerCase()) && scoped(r) && hit(r),
					)
					.filter((r, i, a) => a.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i);
	const groups = catalog
		.filter((group) => scope === "" || group.provider === scope)
		.map((group) => ({
			provider: group.provider,
			models: group.models
				.map((model) => ({ ...model, ref: `${group.provider}/${model.id}` }))
				.filter((model) => !pinned.has(model.ref.toLowerCase()) && hit(model.ref)),
		}))
		.filter((group) => group.models.length > 0);
	const raw = query.trim();
	const typedProvider = scope !== "" ? scope : provNames.length === 1 ? provNames[0] : undefined;
	// Anything the catalog doesn't know stays reachable: a full
	// provider/model ref is used as typed, a bare id joins the selected
	// provider (or the only one configured).
	const customRef =
		raw === ""
			? null
			: raw.includes("/")
				? raw
				: typedProvider === undefined
					? null
					: `${typedProvider}/${raw}`;
	const known = (ref: string) =>
		canonical.has(ref.toLowerCase()) ||
		favorites.some((f) => f.toLowerCase() === ref.toLowerCase());
	const curatedMode = curatedList !== null;
	const hasResults =
		favs.length > 0 ||
		showCurrent ||
		(curatedMode ? curatedRest.length > 0 : groups.length > 0);
	const showCustom =
		customRef !== null &&
		!known(customRef) &&
		customRef !== current &&
		(!hasResults || customRef.includes("/"));
	const row = (ref: string, label?: string) => {
		const model = meta.get(ref);
		const primary = label ?? model?.name ?? ref;
		return (
			<div className="mline" key={ref}>
				<button type="button" className={ref === current ? "mrow sel" : "mrow"} onClick={() => onPick(ref)}>
					<span className="mcell">
						<span className={ref === "" ? "off-label" : "mname"}>{primary}</span>
						{model?.name != null && (
							<span className="ref" title={ref}>
								{ref}
							</span>
						)}
					</span>
					{ref === current && <span className="check">✓</span>}
				</button>
				{ref !== "" && (
					<button
						type="button"
						className={isFav(ref) ? "mstar on" : "mstar"}
						aria-label={isFav(ref) ? `unfavorite ${ref}` : `favorite ${ref}`}
						onClick={(e) => {
							e.stopPropagation();
							onToggleFavorite(ref, !isFav(ref));
						}}
					>
						{isFav(ref) ? "★" : "☆"}
					</button>
				)}
			</div>
		);
	};
	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key !== "Enter" || raw === "") return;
		e.preventDefault();
		// Exact resolution ignores visibility: a catalog hit resolves to
		// its catalog spelling, a favorite to its stored spelling — so the
		// typed path reaches a hidden model (or a hidden favorite's exact
		// ref) even when curation keeps it off every row.
		const exact =
			canonical.get(raw.toLowerCase()) ??
			favorites.find((f) => f.toLowerCase() === raw.toLowerCase());
		// A fully typed provider/model ref beats a catalog row that only
		// contains it as a substring — Enter saves what was typed.
		const pick =
			exact ??
			(showCustom && raw.includes("/") ? customRef : undefined) ??
			favs[0] ??
			(showCurrent ? current : undefined) ??
			(curatedMode ? curatedRest[0] : groups[0]?.models[0]?.ref) ??
			(showCustom ? customRef : null);
		if (pick !== null) onPick(pick);
	};
	return (
		<div className="veil on" onClick={onClose}>
			<div className="msheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
				<header className="msheet-head">
					<h3>{title}</h3>
					<button type="button" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				<div className="msheet-filter">
					<input
						className="mono"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={onKeyDown}
						placeholder="Search models or type provider/model-id"
						autoComplete="off"
						spellCheck={false}
						autoCapitalize="off"
						aria-label="Search models"
					/>
					{provNames.length > 0 && (
						<select
							aria-label="Model provider"
							value={scope}
							onChange={(e) => setScope(e.target.value)}
						>
							<option value="">All providers</option>
							{provNames.map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
					)}
				</div>
				<div className="msheet-body">
					{allowOff && row("", "Off")}
					{favs.length > 0 && (
						<>
							<div className="mgroup">Favorites</div>
							{favs.map((f) => row(f))}
						</>
					)}
					{showCurrent && (
						<>
							<div className="mgroup">Current</div>
							{row(current)}
						</>
					)}
					{showCustom && customRef !== null && (
						<>
							<div className="mgroup">Not in the catalog</div>
							<div className="mline">
								<button type="button" className="mrow" onClick={() => onPick(customRef)}>
									<span className="mcell">
										<span className="mname">Use “{customRef}”</span>
									</span>
								</button>
							</div>
						</>
					)}
				{curatedMode ? (
					curatedRest.length > 0 && (
						<>
							{favs.length > 0 && <div className="mgroup">Models</div>}
							{curatedRest.map((ref) => row(ref))}
						</>
					)
				) : (
					groups.map((group) => (
						<Fragment key={group.provider}>
							<div className="mgroup">{group.provider} models</div>
							{group.models.map((model) => row(model.ref))}
						</Fragment>
					))
				)}
					{q !== "" && !hasResults && !showCustom && <div className="mempty">No models match.</div>}
				</div>
			</div>
		</div>
	);
}
