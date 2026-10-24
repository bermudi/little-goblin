// The model sheet, shared by Settings and the chat composer: favorites
// first, then the current value, then the catalog, with a search that
// also accepts a typed provider/model-id. In "pick" mode a row chooses
// the model; in "favorites" mode a row click toggles its star. The star
// on every model row toggles the favorite without picking it.
import { Fragment, useState } from "react";
import type { ModelOption, ProviderModelCatalog } from "../../src/http/app-wire.ts";

export function ModelPicker({
	title,
	current,
	allowOff,
	favorites,
	catalog,
	provNames,
	mode = "pick",
	onPick,
	onToggleFavorite,
	onClose,
}: {
	title: string;
	current: string;
	allowOff: boolean;
	favorites: string[];
	catalog: ProviderModelCatalog[];
	provNames: string[];
	/** "pick" chooses a model per row; "favorites" edits the list itself —
	 *  a row click toggles that ref's star and the sheet stays open. */
	mode?: "pick" | "favorites";
	onPick: (ref: string) => void;
	onToggleFavorite: (ref: string, on: boolean) => void;
	onClose: () => void;
}) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState("");
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
	const favs = favorites.filter(hit);
	const showCurrent = current !== "" && !favorites.includes(current) && hit(current);
	const pinned = new Set([...favorites, current]);
	const groups = catalog
		.filter((group) => scope === "" || group.provider === scope)
		.map((group) => ({
			provider: group.provider,
			models: group.models
				.map((model) => ({ ...model, ref: `${group.provider}/${model.id}` }))
				.filter((model) => !pinned.has(model.ref) && hit(model.ref)),
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
	const hasResults = favs.length > 0 || showCurrent || groups.length > 0;
	const known = (ref: string) =>
		canonical.has(ref.toLowerCase()) ||
		favorites.some((f) => f.toLowerCase() === ref.toLowerCase());
	const showCustom =
		customRef !== null &&
		!known(customRef) &&
		customRef !== current &&
		(!hasResults || customRef.includes("/"));
	// The one row gesture: pick mode selects, favorites mode toggles —
	// a not-yet-favorite ref toggles on, which is also what "Use …" means
	// under "favorites".
	const choose = (ref: string) =>
		mode === "favorites" ? onToggleFavorite(ref, !isFav(ref)) : onPick(ref);
	const row = (ref: string, label?: string) => {
		const model = meta.get(ref);
		const primary = label ?? model?.name ?? ref;
		const pickButton = (
			<button
				key={ref || "off"}
				type="button"
				className={ref === current ? "mrow sel" : "mrow"}
				onClick={() => choose(ref)}
			>
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
		);
		if (ref === "") return pickButton;
		return (
			<div className="mline" key={ref}>
				{pickButton}
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
			</div>
		);
	};
	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key !== "Enter" || raw === "") return;
		e.preventDefault();
		const exact = canonical.get(raw.toLowerCase());
		// A fully typed provider/model ref beats a catalog row that only
		// contains it as a substring — Enter saves what was typed.
		const pick =
			exact ??
			(showCustom && raw.includes("/") ? customRef : undefined) ??
			favs[0] ??
			(showCurrent ? current : undefined) ??
			groups[0]?.models[0]?.ref ??
			(showCustom ? customRef : null);
		if (pick !== null) choose(pick);
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
							<button type="button" className="mrow" onClick={() => choose(customRef)}>
								<span className="mcell">
									<span className="mname">Use “{customRef}”</span>
								</span>
							</button>
						</>
					)}
					{groups.map((group) => (
						<Fragment key={group.provider}>
							<div className="mgroup">{group.provider} models</div>
							{group.models.map((model) => row(model.ref))}
						</Fragment>
					))}
					{q !== "" && !hasResults && !showCustom && <div className="mempty">No models match.</div>}
				</div>
			</div>
		</div>
	);
}
