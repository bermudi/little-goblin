// The model sheet, shared by Settings and the chat composer: favorites
// first, then the current value, then what the picker offers — a
// curated membership list when one exists (settings → Models), else the
// whole catalog grouped by provider — with a search that also accepts a
// typed provider/model-id. A row chooses the model; the star on every
// model row toggles the favorite without picking it.
//
// The list mechanics — filtering, arrow-key highlight, Enter, and the
// listbox/combobox ARIA wiring — come from @ui-sdk/react's `command`
// primitive (vercel-labs/ui), mounted open inside this sheet. What
// stays here is the domain: pinning, curation, the provider scope,
// stars, and the typed path's exact resolution.
import { useRef, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui-sdk/react/command";
import type { ModelOption, ProviderModelCatalog } from "../../src/http/app-wire.ts";

// The Off row's item value. Item values double as model refs, and every
// pickable ref carries a provider slash, so this spelling is one no ref
// can produce.
const OFF = "\u0000off";

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
	// The row the operator last moved the highlight to (arrows, pointer),
	// or null. Only user moves fire onValueChange — auto-highlights land
	// silently — so a fresh query's Enter keeps running the typed path's
	// exact resolution, and Enter after an arrow runs the row the
	// operator chose.
	const arrowed = useRef<string | null>(null);
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
	// "glm-5.3" and "GLM" both land on the same row. Feeds both the
	// command's `filter` and the pre-render row lists below.
	const hit = (ref: string, needle: string = q) => {
		if (needle === "") return true;
		const name = meta.get(ref)?.name?.toLowerCase() ?? "";
		return ref.toLowerCase().includes(needle) || name.includes(needle);
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
	// One row: the option is the item; the mrow button inside keeps the
	// row's own click target (the command runs it either way) and the
	// star stays beside it, its own click never reaching the item.
	const row = (ref: string, label?: string) => {
		const model = meta.get(ref);
		const primary = label ?? model?.name ?? ref;
		return (
			<CommandItem key={ref} value={ref === "" ? OFF : ref} className="mline">
				<button type="button" className={ref === current ? "mrow sel" : "mrow"}>
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
						ref={(el) => {
							if (el === null) return;
							// The command's row press is a native click listener on
							// the option, so a React onClick here would fire too
							// late to stop it. The star stops its own click natively
							// and toggles there.
							const onStarClick = (e: MouseEvent) => {
								e.stopPropagation();
								onToggleFavorite(ref, !isFav(ref));
							};
							el.addEventListener("click", onStarClick);
							return () => el.removeEventListener("click", onStarClick);
						}}
					>
						{isFav(ref) ? "★" : "☆"}
					</button>
				)}
			</CommandItem>
		);
	};
	// Enter with no highlighted row runs the typed path: exact
	// resolution ignores visibility — a catalog hit resolves to its
	// catalog spelling, a favorite to its stored spelling — so typing
	// reaches a hidden model (or a hidden favorite's exact ref) even
	// when curation keeps it off every row. A fully typed provider/model
	// ref beats a catalog row that only contains it as a substring.
	const onEnter = () => {
		if (raw === "") return;
		const exact =
			canonical.get(raw.toLowerCase()) ??
			favorites.find((f) => f.toLowerCase() === raw.toLowerCase());
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
				<Command
					className="msheet-command"
					query={query}
					onQueryChange={(q) => {
						setQuery(q);
						// Typing re-filters: the operator's arrow choice is
						// spent, and Enter falls back to the typed path.
						arrowed.current = null;
					}}
					filter={(item, search) => {
						const needle = search.trim().toLowerCase();
						return hit(item.value === OFF ? "" : item.value, needle);
					}}
					onValueChange={(value) => {
						arrowed.current = value;
					}}
					onAction={(value) => onPick(value === OFF ? "" : value)}
					onKeyDownCapture={(e) => {
						// Only the search field's Enter: the scope select and
						// the row buttons keep their own. Enter after an
						// arrow runs the row the operator chose; otherwise
						// the typed path takes over — and an empty query
						// picks nothing, so the highlighted first row cannot
						// run by itself. (tagName, not instanceof: happy-dom
						// realms have their own element classes.)
						if (e.key !== "Enter" || (e.target as HTMLElement | null)?.tagName !== "INPUT")
							return;
						if (query.trim() !== "" && arrowed.current !== null) return;
						e.preventDefault();
						e.stopPropagation();
						onEnter();
					}}
				>
					<div className="msheet-filter">
						<CommandInput
							className="mono"
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
						{q !== "" && <CommandEmpty className="mempty">No models match.</CommandEmpty>}
						<CommandList>
							{allowOff && row("", "Off")}
							{favs.length > 0 && (
								<CommandGroup>
									<CommandGroupLabel className="mgroup">Favorites</CommandGroupLabel>
									{favs.map((f) => row(f))}
								</CommandGroup>
							)}
							{showCurrent && (
								<CommandGroup>
									<CommandGroupLabel className="mgroup">Current</CommandGroupLabel>
									{row(current)}
								</CommandGroup>
							)}
							{showCustom && customRef !== null && (
								<CommandGroup>
									<CommandGroupLabel className="mgroup">Not in the catalog</CommandGroupLabel>
									<CommandItem value={customRef} className="mline">
										<button type="button" className="mrow">
											<span className="mcell">
												<span className="mname">Use “{customRef}”</span>
											</span>
										</button>
									</CommandItem>
								</CommandGroup>
							)}
							{curatedMode ? (
								curatedRest.length > 0 && (
									<CommandGroup>
										{favs.length > 0 && (
											<CommandGroupLabel className="mgroup">Models</CommandGroupLabel>
										)}
										{curatedRest.map((ref) => row(ref))}
									</CommandGroup>
								)
							) : (
								groups.map((group) => (
									<CommandGroup key={group.provider}>
										<CommandGroupLabel className="mgroup">
											{group.provider} models
										</CommandGroupLabel>
										{group.models.map((model) => row(model.ref))}
									</CommandGroup>
								))
							)}
						</CommandList>
					</div>
				</Command>
			</div>
		</div>
	);
}
