// The chart leaf — hand-drawn SVG, no library: grouped bars or lines
// with an axis and ticks, or a pie (slices = first series' values
// over the x labels); every mark carries a native <title> tooltip.
// X labels thin when crowded; the legend appears when more than one
// series exists — or always for a pie, where the slices need their
// labels. The viewBox is sized in measured pixels (ResizeObserver on
// the wrapper), so tick/label text stays a constant CSS size at any
// container width; the fallback width only ever serves the first
// paint and static markup. Series colors are .ui-chart-s<n> classes
// so the hues live in the stylesheet's tokens, not here.

import { useEffect, useRef, useState } from "react";
import type { UiLeaf } from "../../../src/agent/tools/ui-schema.ts";

const H = 220;
const FALLBACK_W = 560;
const PAD = { l: 46, r: 10, t: 12, b: 30 };
const TICKS = 4;

// Keep enough significant digits to distinguish ticks at this spacing,
// including after scaling to thousands. Number removes trailing zeroes.
function fmt(n: number, spacing: number): string {
	if (n === 0) return "0";
	const scale = Math.abs(n) >= 10_000 ? 1000 : 1;
	const precision = Math.min(100, Math.max(1, Math.ceil(Math.log10(Math.abs(n) / spacing)) + 3));
	return `${Number((n / scale).toPrecision(precision))}${scale === 1000 ? "k" : ""}`;
}

// One slice per value of the first series, labelled by x — the
// schema's describe promises the model the same semantics (extra
// series ignored, non-negative values). Zero-total data guards the
// total to 1: slices degrade to 0% arcs, never NaN geometry.
function Pie({
	labels,
	values,
	pcts,
	unit,
	w,
	h,
}: {
	labels: readonly string[];
	values: readonly number[];
	pcts: readonly number[];
	unit: string | undefined;
	w: number;
	h: number;
}) {
	const total = values.reduce((a, b) => a + b, 0) || 1;
	const cx = w / 2;
	const cy = h / 2;
	const r = Math.min(w, h) / 2 - 8;
	let angle = -Math.PI / 2;
	return (
		<>
			{values.map((v, i) => {
				const next = angle + (v / total) * Math.PI * 2;
				const large = next - angle > Math.PI ? 1 : 0;
				const d = `M${cx},${cy} L${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(next)},${cy + r * Math.sin(next)} Z`;
				angle = next;
				return (
					<path key={i} className={`ui-chart-pie ui-chart-s${i % 5}`} d={d}>
						<title>{`${labels[i]}: ${unit !== undefined ? `${v} ${unit}` : `${v}`} (${pcts[i]}%)`}</title>
					</path>
				);
			})}
		</>
	);
}

export function Chart({ leaf }: { leaf: Extract<UiLeaf, { type: "chart" }> }) {
	const { kind, x, series, unit } = leaf;
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(FALLBACK_W);
	useEffect(() => {
		const el = ref.current;
		if (el === null || typeof ResizeObserver !== "function") return;
		const ro = new ResizeObserver((entries) => {
			const w = entries[0]?.contentRect.width;
			if (w !== undefined && w > 0) setWidth(Math.round(w));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const W = Math.max(240, width);

	const pie = kind === "pie";
	const slices = series[0]!;
	const sum = slices.values.reduce((a, b) => a + b, 0);
	const total = sum || 1; // zero-total data guards geometry — 0% arcs, never NaN
	// Shares shown whole: largest-remainder rounding so the legend's
	// percentages sum to exactly 100 — per-slice Math.round can land
	// on 99 or 101 (e.g. thirds at 33.33…).
	const pcts = (() => {
		const raw = slices.values.map((v) => ((v / total) * 100) % 1);
		const out = slices.values.map((v) => Math.floor((v / total) * 100));
		if (sum <= 0) return out;
		let left = 100 - out.reduce((a, b) => a + b, 0);
		const order = raw.map((frac, i) => ({ frac, i })).sort((a, b) => b.frac - a.frac);
		for (const { i } of order) {
			if (left <= 0) break;
			out[i]! += 1;
			left -= 1;
		}
		return out;
	})();
	const fmtVal = (v: number) => (unit !== undefined ? `${v} ${unit}` : `${v}`);

	const all = series.flatMap((s) => s.values);
	// The baseline pins 0: all-positive data hangs from the top of the
	// plot, all-negative climbs to it — mixed spans both directions.
	const lo = Math.min(0, ...all);
	const hi = Math.max(0, ...all);
	const span = hi - lo || 1;
	const plotW = W - PAD.l - PAD.r;
	const plotH = H - PAD.t - PAD.b;
	const py = (v: number) => PAD.t + plotH * (1 - (v - lo) / span);

	// Bars group per x slot; lines space points evenly. A single x gets
	// the whole slot either way.
	const slotW = plotW / x.length;
	const barW = kind === "bar" ? Math.min(28, (slotW * 0.72) / series.length) : 0;
	const px = (i: number) =>
		kind === "bar"
			? PAD.l + i * slotW + slotW / 2
			: PAD.l + (x.length === 1 ? plotW / 2 : (plotW * i) / (x.length - 1));

	// Thin labels against real pixels — the longest label sets the slot
	// a drawn label needs (~7px/char at the 11px mono tick).
	const longest = Math.max(1, ...x.map((l) => l.length));
	const labelPx = Math.max(44, longest * 7);
	const labelEvery = Math.max(1, Math.ceil(x.length / Math.max(1, Math.floor(plotW / labelPx))));
	const ticks = Array.from({ length: TICKS + 1 }, (_, i) => lo + (span * i) / TICKS);
	const baseline = py(0);

	return (
		<div className="ui-chart" ref={ref}>
			{(pie || series.length > 1 || unit !== undefined) && (
				// Head aligns with the plot's left edge — the unit label
				// sits over the axis, and nothing glyph-sized rides flush
				// against the block's left edge. A pie has no axis, so its
				// head aligns with the block itself.
				<div className="ui-chart-head" style={{ paddingLeft: pie ? 0 : PAD.l }}>
					{unit !== undefined && <span className="ui-chart-unit">{unit}</span>}
					{(pie || series.length > 1) && (
						<span className="ui-chart-legend">
							{pie
								? x.map((label, i) => (
										<span key={i} className="ui-chart-key">
											<span className={`ui-chart-swatch ui-chart-s${i % 5}`} />
											{`${label} · ${pcts[i]}%`}
										</span>
									))
								: series.map((s, i) => (
										<span key={i} className="ui-chart-key">
											<span className={`ui-chart-swatch ui-chart-s${i}`} />
											{s.name}
										</span>
									))}
						</span>
					)}
				</div>
			)}
			<svg
				className="ui-chart-svg"
				viewBox={`0 0 ${W} ${H}`}
				role="img"
				aria-label={`${kind} chart`}
			>
				{pie ? (
					<Pie labels={x} values={slices.values} pcts={pcts} unit={unit} w={W} h={H} />
				) : (
					<>
						{ticks.map((t, i) => (
							<g key={i}>
								<line className="ui-chart-grid" x1={PAD.l} x2={W - PAD.r} y1={py(t)} y2={py(t)} />
								<text className="ui-chart-tick" x={PAD.l - 6} y={py(t) + 4} textAnchor="end">
									{fmt(t, span / TICKS)}
								</text>
							</g>
						))}
						<line className="ui-chart-axis" x1={PAD.l} x2={W - PAD.r} y1={baseline} y2={baseline} />
						{x.map((label, i) =>
							i % labelEvery === 0 ? (
								<text
									key={i}
									className="ui-chart-tick"
									x={px(i)}
									y={H - PAD.b + 16}
									textAnchor="middle"
								>
									{label}
								</text>
							) : null,
						)}
						{kind === "bar"
							? series.map((s, si) =>
									s.values.map((v, i) => {
										const gx = px(i) - (barW * series.length) / 2 + si * barW;
										const top = Math.min(py(v), baseline);
										return (
											<rect
												key={`${si}-${i}`}
												className={`ui-chart-bar ui-chart-s${si}`}
												x={gx}
												y={top}
												width={Math.max(1, barW - 2)}
												height={Math.max(1, Math.abs(py(v) - baseline))}
												rx={2}
											>
												<title>{`${s.name} · ${x[i]}: ${fmtVal(v)}`}</title>
											</rect>
										);
									}),
								)
							: series.map((s, si) => (
									<g key={si}>
										<polyline
											className={`ui-chart-line ui-chart-s${si}`}
											points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(" ")}
										/>
										{s.values.map((v, i) => (
											<circle
												key={i}
												className={`ui-chart-dot ui-chart-s${si}`}
												cx={px(i)}
												cy={py(v)}
												r={2.5}
											>
												<title>{`${s.name} · ${x[i]}: ${fmtVal(v)}`}</title>
											</circle>
										))}
									</g>
								))}
					</>
				)}
			</svg>
		</div>
	);
}
