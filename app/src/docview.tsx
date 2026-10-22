// The document viewer — one modal for every "open this file" surface in
// the app. Two doc kinds ride the same modal: a live workspace read
// (click a path chip — shows the file as it is now, mutable like the
// read_file tool) and an immutable published artifact (snapshot bytes in
// the attachment store). Rendering is by kind: markdown through the
// shared renderer (relative links navigate inside the modal, back
// button walks the stack), HTML inside the same sandboxed srcdoc frame
// as ui leaves, images/audio/video/pdf over object URLs, plain text for
// the rest of the text kinds, and a download affordance for binaries.
// All fetching goes through the conversation-scoped reader route —
// containment, caps and refusals live server-side.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Artifact } from "../../src/agent/tools/artifact-schema.ts";
import { fetchAttachment, fetchConversationFile } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { bytes } from "./opsShared.tsx";
import { srcdoc } from "./ui/HtmlFrame.tsx";

export type DocRef =
	| { kind: "file"; path: string }
	| { kind: "artifact"; artifact: Artifact };

export interface DocViewer {
	openFile(path: string): void;
	openArtifact(artifact: Artifact): void;
}

const DocViewerContext = createContext<DocViewer | null>(null);

export function useDocViewer(): DocViewer | null {
	return useContext(DocViewerContext);
}

/** The published-artifact card transcript parts render — a button that
 *  opens the doc in the viewer. Inert without a provider (tests,
 *  detached renders). */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
	const viewer = useDocViewer();
	return (
		<button
			type="button"
			className="doccard"
			onClick={() => viewer?.openArtifact(artifact)}
			disabled={viewer === null}
			title={artifact.name}
		>
			<span className="doccard-glyph" aria-hidden>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
					width="14"
					height="14"
				>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<polyline points="14 2 14 8 20 8" />
				</svg>
			</span>
			<span className="doccard-body">
				<span className="doccard-title">{artifact.title ?? artifact.name}</span>
				<span className="doccard-meta">
					{artifact.title !== undefined && artifact.title !== artifact.name
						? `${artifact.name} · `
						: ""}
					{artifact.mediaType.split(";")[0]} · {bytes(artifact.size)}
				</span>
			</span>
		</button>
	);
}

/** Narrow a tool part's output to an artifact, re-exported so ChatView
 *  doesn't reach into the wire schema itself. */
export { artifactOf } from "../../src/agent/tools/artifact-schema.ts";

export function DocViewerProvider({
	token,
	conversationId,
	children,
}: {
	token: string | null;
	conversationId: string;
	children: ReactNode;
}) {
	const [stack, setStack] = useState<DocRef[]>([]);
	const value = useMemo<DocViewer>(
		() => ({
			openFile: (path) => setStack([{ kind: "file", path }]),
			openArtifact: (artifact) => setStack([{ kind: "artifact", artifact }]),
		}),
		[],
	);
	const fetchDoc = useMemo(
		() => (ref: DocRef) =>
			ref.kind === "file"
				? fetchConversationFile(token, conversationId, ref.path)
				: fetchAttachment(token, basenameOf(ref.artifact.path)),
		[token, conversationId],
	);
	return (
		<DocViewerContext.Provider value={value}>
			{children}
			{stack.length > 0 && (
				<DocModal
					stack={stack}
					fetchDoc={fetchDoc}
					onClose={() => setStack([])}
					onBack={() => setStack((s) => s.slice(0, -1))}
					onNavigate={(path) =>
						setStack((s) => [
							...s,
							// A doc without a resolvable base never gets clickable
							// links — the ?? "" only keeps the narrowing honest.
							{ kind: "file" as const, path: resolveRelative(baseOf(s.at(-1)!) ?? "", path) },
						])
					}
				/>
			)}
		</DocViewerContext.Provider>
	);
}

function basenameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
}

function dirnameOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

// Where a relative link inside this doc resolves: live files against
// their own directory, workspace-sourced artifacts against the source's
// directory. Sandbox-sourced docs have no fetchable base — their links
// stay literal (no baseOf, no onFileLink).
function baseOf(ref: DocRef): string | null {
	if (ref.kind === "file") return dirnameOf(ref.path);
	if (ref.artifact.source.target === "workspace") return dirnameOf(ref.artifact.source.path);
	return null;
}

function resolveRelative(base: string, rel: string): string {
	if (rel.startsWith("/")) return rel;
	const parts = base === "" ? [] : base.split("/");
	for (const seg of rel.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

type DocRender = "markdown" | "html" | "image" | "audio" | "video" | "pdf" | "text" | "download";

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;
// Extensions the mime sniff won't know but a reader should show as text.
const TEXT_EXTS = new Set([
	"txt", "md", "markdown", "html", "htm", "css", "csv", "json", "jsonl", "xml", "yaml", "yml",
	"toml", "ini", "log", "sh", "bash", "zsh", "py", "js", "jsx", "ts", "tsx", "go", "rs", "c",
	"cc", "cpp", "h", "hpp", "java", "kt", "rb", "php", "sql", "lua", "zig",
]);

function extOf(name: string): string {
	const i = name.lastIndexOf(".");
	return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function renderKind(mediaType: string, name: string): DocRender {
	const t = mediaType.split(";")[0]!.trim().toLowerCase();
	const ext = extOf(name);
	if (t === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
	if (t === "text/html" || ext === "html" || ext === "htm") return "html";
	if (t === "application/pdf" || ext === "pdf") return "pdf";
	if (INLINE_IMAGE.test(t)) return "image";
	if (t.startsWith("audio/")) return "audio";
	if (t.startsWith("video/")) return "video";
	if (t.startsWith("text/") || t === "application/json" || TEXT_EXTS.has(ext)) return "text";
	return "download";
}

// Text decode is bounded — a 30 MiB log should download, not freeze the
// tab. Markdown and html decode those same bytes and then parse them on
// top, so the cap demotes every decoded kind, not just plain text.
const TEXT_DECODE_MAX = 4 * 1024 * 1024;

function DocModal({
	stack,
	fetchDoc,
	onClose,
	onBack,
	onNavigate,
}: {
	stack: DocRef[];
	fetchDoc: (ref: DocRef) => Promise<Response | Blob>;
	onClose: () => void;
	onBack: () => void;
	onNavigate: (path: string) => void;
}) {
	const top = stack.at(-1)!;
	const title = top.kind === "file" ? basenameOf(top.path) : (top.artifact.title ?? top.artifact.name);
	const base = baseOf(top);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="veil doc-veil" onClick={onClose}>
			<div
				className="msheet doc"
				role="dialog"
				aria-label={title}
				onClick={(e) => e.stopPropagation()}
			>
				<header className="msheet-head doc-head">
					{stack.length > 1 && (
						<button type="button" className="doc-back" aria-label="Back" onClick={onBack}>
							←
						</button>
					)}
					<h3>{title}</h3>
					<button type="button" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				<div className="doc-body">
					<DocBody
						key={stack.length}
						doc={top}
						fetchDoc={fetchDoc}
						onFileLink={base === null ? undefined : onNavigate}
					/>
				</div>
			</div>
		</div>
	);
}

type BodyState =
	| { phase: "loading" }
	| { phase: "error"; error: string }
	| { phase: "ready"; blob: Blob; url: string | null; text: string | null; render: DocRender };

function DocBody({
	doc,
	fetchDoc,
	onFileLink,
}: {
	doc: DocRef;
	fetchDoc: (ref: DocRef) => Promise<Response | Blob>;
	onFileLink: ((path: string) => void) | undefined;
}) {
	const [state, setState] = useState<BodyState>({ phase: "loading" });
	const name = doc.kind === "file" ? basenameOf(doc.path) : doc.artifact.name;
	const declaredType =
		doc.kind === "artifact" ? doc.artifact.mediaType : null;

	useEffect(() => {
		let live = true;
		let objectUrl: string | null = null;
		setState({ phase: "loading" });
		fetchDoc(doc)
			.then(async (res) => {
				const blob =
					res instanceof Blob ? res : await res.blob();
				if (!live) return;
				const mediaType =
					declaredType ??
					(res instanceof Blob
						? ""
						: (res.headers.get("content-type") ?? "").split(";")[0]!);
				let render = renderKind(mediaType || blob.type, name);
				if (
					(render === "markdown" || render === "html" || render === "text") &&
					blob.size > TEXT_DECODE_MAX
				)
					render = "download";
				let text: string | null = null;
				let url: string | null = null;
				if (render === "markdown" || render === "html" || render === "text") {
					text = await blob.text();
					if (!live) return;
				} else if (render !== "download") {
					url = URL.createObjectURL(blob);
					objectUrl = url;
				}
				setState({ phase: "ready", blob, url, text, render });
			})
			.catch((err) => {
				if (!live) return;
				setState({
					phase: "error",
					error: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			live = false;
			if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
		};
	}, [doc, fetchDoc, name, declaredType]);

	if (state.phase === "loading") return <div className="doc-note">loading…</div>;
	if (state.phase === "error") return <div className="doc-err">{state.error}</div>;
	const { blob, url, text, render } = state;
	switch (render) {
		case "markdown":
			return (
				<div className="doc-md">
					<Markdown text={text ?? ""} onFileLink={onFileLink} />
				</div>
			);
		case "html":
			return (
				<iframe
					className="doc-frame"
					sandbox="allow-scripts"
					srcDoc={srcdoc(text ?? "")}
					title={name}
				/>
			);
		case "image":
			return <img className="doc-media" src={url ?? undefined} alt={name} />;
		case "audio":
			return <audio className="doc-media" controls src={url ?? undefined} />;
		case "video":
			return <video className="doc-media" controls src={url ?? undefined} />;
		case "pdf":
			return <iframe className="doc-frame" sandbox="" src={url ?? undefined} title={name} />;
		case "text":
			return <pre className="doc-text">{text}</pre>;
		case "download":
			return (
				<div className="doc-note">
					<p>
						{name} — {bytes(blob.size)}
					</p>
					<DownloadLink blob={blob} name={name} />
				</div>
			);
	}
}

function DownloadLink({ blob, name }: { blob: Blob; name: string }) {
	const url = useMemo(() => URL.createObjectURL(blob), [blob]);
	useEffect(() => () => URL.revokeObjectURL(url), [url]);
	return (
		<a className="doc-download" href={url} download={name}>
			download {name}
		</a>
	);
}
