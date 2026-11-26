// Transcript rendering: one message's parts → transcript elements.

import { memo, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { Popover, PopoverContent } from "@ui-sdk/react/popover";
import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ReasoningUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { ApprovalCard } from "../Approvals.tsx";
import { ArtifactCard } from "../docview.tsx";
import { Markdown } from "../markdown.tsx";
import { bytes } from "../opsShared.tsx";
import { useFoldFollow } from "./useFoldFollow.ts";
import { Brain } from "lucide-react";
import {
  ToolRun,
  activitySummary,
  partFailed,
  partRunning,
  partSummaryLine,
  liveAction,
} from "../tools/mod.tsx";
import { liveThoughtLine } from "./liveThoughtLine.ts";
import { LiveWork } from "./LiveWork.tsx";
import { UiPart } from "../ui/UiPart.tsx";
import type { AttachmentRef } from "../../../src/agent/attachments.ts";
import { hasInlineParts, inlineChipLabel, isInlinePart } from "../../../src/inline-parts.ts";
import { fetchAttachmentUrl } from "./attachmentUrl.ts";
import { ChipDetails } from "./MessageBox.tsx";
import { parseChip, type Chip, type QuoteChip } from "./draft.ts";
import {
  type Artifact,
  artifactOf,
  presentationsOf,
} from "../../../src/agent/tools/artifact-schema.ts";

type ActivityPart = ToolUIPart | DynamicToolUIPart | ReasoningUIPart;
type SentChip = Exclude<Chip, QuoteChip>;
// A part that folds into an Activity run: a tool call (ui parts render
// inline as the interface and never join) or thought text with
// something in it.
function isActivityPart(p: UIMessage["parts"][number]): boolean {
  return (
    (isToolUIPart(p) && getToolName(p) !== "ui") ||
    (p.type === "reasoning" && p.text.trim() !== "")
  );
}
// A thought fold. Live, the label shimmers "Thinking" and the summary
// previews the newest line; settled, it folds to "Thought". The body
// renders as markdown.
function Thought({ parts, live }: { parts: ReasoningUIPart[]; live: boolean }) {
  const text = parts.map((p) => p.text).join("\n\n");
  const preview = live
    ? (text
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? "")
    : "";
  return (
    <details className={live ? "reasoning-fold live" : "reasoning-fold"}>
      <summary>
        <Brain size={12} strokeWidth={1.75} className="reasoning-ic" />
        <span className={live ? "reasoning-label shimmer" : "reasoning-label"}>
          {live ? "Thinking" : "Thought"}
        </span>
        {preview !== "" && <span className="reasoning-preview">{preview}</span>}
      </summary>
      <div className="reasoning">
        <Markdown text={text} />
      </div>
    </details>
  );
}

function Activity({
  parts,
  live,
  ended,
}: {
  parts: ActivityPart[];
  live: boolean;
  // The owning message's turn is over (unlanded record) — a stuck
  // streaming state can never progress, so it draws ended, not running.
  ended?: boolean | undefined;
}) {
  const tools = parts.filter((p): p is ToolUIPart | DynamicToolUIPart =>
    isToolUIPart(p),
  );
  const running = !ended && tools.some(partRunning);
  const failures = tools.filter(partFailed).length;
  const lines = tools.map(partSummaryLine);
  const fold = useRef<HTMLDetailsElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useFoldFollow(fold, list, parts, !ended && (live || running));
  const thoughts = parts.filter((p): p is ReasoningUIPart => p.type === "reasoning");
  const newestThought = thoughts.findLast((p) => p.text.trim() !== "");
  const newest = parts.at(-1);
  const actionPart = tools.findLast(partRunning) ?? (newest !== undefined && isToolUIPart(newest) ? newest : undefined);
  const action = liveAction(actionPart);
  const thoughtOnly = !live && tools.length === 0;
  let summary: ReactNode;
  if (live) {
    summary = (
      <LiveWork
        thought={newestThought === undefined ? undefined : liveThoughtLine(newestThought.text)}
        icon={action.icon}
        label={action.label}
      />
    );
  } else if (thoughtOnly) {
    summary = (
      <>
        <Brain size={12} strokeWidth={1.75} className="reasoning-ic" />
        <span className="reasoning-label">Thought</span>
      </>
    );
  } else {
    summary = (
      <>
        <span className={running ? "worked-sum shimmer" : "worked-sum"} title={lines.join("; ")}>
          {activitySummary(tools)}
        </span>
        {failures > 0 && <span className="worked-fail">— {failures} failed</span>}
      </>
    );
  }
  return (
    <details className={live ? "worked live" : thoughtOnly ? "reasoning-fold" : "worked"} ref={fold}>
      <summary>{summary}</summary>
      {thoughtOnly ? (
        <div className="reasoning"><Markdown text={thoughts.map((p) => p.text).join("\n\n")} /></div>
      ) : <ul ref={list} hidden={parts.length === 0}>
        {parts.map((p, i) =>
          isToolUIPart(p) ? (
            <ToolRun
              key={p.toolCallId === "" ? i : p.toolCallId}
              part={p}
              // exactOptionalPropertyTypes: absent, never explicit undefined.
              {...(ended === true ? { ended: true } : {})}
            />
          ) : (
            <li key={`t${i}`}>
              <Thought
                parts={[p]}
                live={ended !== true && p.state === "streaming"}
              />
            </li>
          ),
        )}
      </ul>}
    </details>
  );
}

export function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="12"
      height="12"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

// Transcript bytes are wire data — the persisted blob gets its shape
// checked at this render boundary, never cast. The check is
// structural (the server's zod schema imports node modules the
// browser bundle cannot carry): the required fields with their types,
// optional ones only when well-typed. A malformed blob renders as no
// chip / is skipped from draft restore — it must not throw the
// transcript (the app has no error boundary).
export function parseAttachmentRef(data: unknown): AttachmentRef | null {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const o = data as Record<string, unknown>;
  if (
    typeof o.path !== "string" ||
    typeof o.mediaType !== "string" ||
    typeof o.filename !== "string" ||
    typeof o.size !== "number"
  ) {
    return null;
  }
  return {
    path: o.path,
    ...(typeof o.sha256 === "string" ? { sha256: o.sha256 } : {}),
    mediaType: o.mediaType,
    filename: o.filename,
    size: o.size,
    ...(typeof o.transcript === "string" ? { transcript: o.transcript } : {}),
    ...(typeof o.transcriptionError === "string"
      ? { transcriptionError: o.transcriptionError }
      : {}),
    ...(typeof o.speech === "boolean" ? { speech: o.speech } : {}),
  };
}

function AttachmentChip({
  data,
  token,
}: {
  data: unknown;
  token: string | null;
}) {
  const ref = parseAttachmentRef(data);
  if (ref === null) return null;
  return <AttachmentRefChip attachment={ref} token={token} />;
}

// Split from AttachmentChip so the hooks below never sit after an
// early return: a part whose data starts parsing would change the
// hook count between renders.
function AttachmentRefChip({
  attachment: ref,
  token,
}: {
  attachment: AttachmentRef;
  token: string | null;
}) {
  const isImage = ref.mediaType.startsWith("image/");
  const isAudio = ref.mediaType.startsWith("audio/");
  const path = ref.path;
  const [inlineUrl, setInlineUrl] = useState<string | null>(null);
  // A failed download surfaces as a chip message — a missing
  // attachment or expired credential otherwise reads as a dead button.
  const [dlError, setDlError] = useState<string | null>(null);
  useEffect(() => {
    if ((!isImage && !isAudio) || path === "") return;
    let live = true;
    let url: string | null = null;
    void fetchAttachmentUrl(token, path)
      .then((u) => {
        if (live) {
          url = u;
          setInlineUrl(u);
        } else {
          // Unmounted mid-fetch — the cleanup already ran, so
          // revoke here or the blob pins until page unload.
          URL.revokeObjectURL(u);
        }
      })
      .catch((e: unknown) => {
        // A dead prefetch otherwise degrades to the download chip
        // with no reason — show it like a failed download.
        if (live)
          setDlError(e instanceof Error ? e.message : "download failed");
      });
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [isImage, isAudio, path, token]);
  if (isImage && inlineUrl !== null) {
    return (
      <a
        className="attachment image"
        href={inlineUrl}
        target="_blank"
        rel="noreferrer"
      >
        <img src={inlineUrl} alt={ref.filename} />
        <span className="attachment-name">{ref.filename}</span>
        <span className="attachment-size">{bytes(ref.size)}</span>
      </a>
    );
  }
  if (isAudio && inlineUrl !== null) {
    return (
      <span className="attachment audio">
        <audio controls preload="metadata" src={inlineUrl} />
        <span className="attachment-name">{ref.filename}</span>
        <span className="attachment-size">{bytes(ref.size)}</span>
        {ref.speech === true && ref.transcript !== undefined && (
          <span className="attachment-transcript">“{ref.transcript}”</span>
        )}
        {ref.transcriptionError !== undefined && (
          <span className="attachment-transcript error">
            couldn't transcribe: {ref.transcriptionError}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="attachment">
      <FileIcon />
      {path !== "" ? (
        // A download, not window.open: the bytes aren't render-safe
        // (fetchAttachmentUrl wraps them as octet-stream) and the
        // object URL can be revoked the moment it starts.
        <button
          type="button"
          className="attachment-name link"
          onClick={() => {
            setDlError(null);
            void fetchAttachmentUrl(token, path).then(
              (u) => {
                const a = document.createElement("a");
                a.href = u;
                a.download = ref.filename;
                a.click();
                URL.revokeObjectURL(u);
              },
              (err: unknown) => {
                setDlError(
                  err instanceof Error ? err.message : "download failed",
                );
              },
            );
          }}
        >
          {ref.filename}
        </button>
      ) : (
        <span className="attachment-name">{ref.filename}</span>
      )}
      <span className="attachment-size">{bytes(ref.size)}</span>
      {dlError !== null && (
        <span className="msg-err">Download failed: {dlError}</span>
      )}
      {ref.speech === true && ref.transcript !== undefined && (
        <span className="attachment-transcript">“{ref.transcript}”</span>
      )}
      {ref.transcriptionError !== undefined && (
        <span className="attachment-transcript error">
          couldn't transcribe: {ref.transcriptionError}
        </span>
      )}
    </span>
  );
}

// An explicit skill invocation — the part is the durable record; the
// body rode only the owning turn's model view.
function SkillChip({ data }: { data: unknown }) {
  const d = (typeof data === "object" && data !== null ? data : {}) as {
    name?: string;
    url?: string;
    path?: string;
  };
  const temp = typeof d.url === "string";
  // A temp part carries {url, path} only — the staged layout
  // <digest>/<name>/SKILL.md yields the name the descriptor gave it.
  const tempName =
    typeof d.path === "string"
      ? (d.path.split("/").filter(Boolean).at(-2) ?? "unknown")
      : "unknown";
  let host = d.url ?? "";
  if (temp && d.url !== undefined) {
    try {
      host = new URL(d.url).host;
    } catch {
      // The wire validated it; an unparseable survivor keeps the full form.
    }
  }
  return (
    <span
      className="attachment note-chip"
      title={
        temp
          ? `Temp skill from ${d.url} — its body rode the turn that invoked it`
          : `Skill ${d.name ?? ""} — its body rode the turn that invoked it`
      }
    >
      <span aria-hidden="true">⚡</span>
      <span className="attachment-name">
        {temp ? "Temp skill · " : "Skill · "}
        {temp ? tempName : (d.name ?? "unknown")}
        {temp ? ` (${host})` : ""}
      </span>
    </span>
  );
}

function NoteChip({
  data,
  onOpenNote,
}: {
  data: unknown;
  onOpenNote?: ((id: string) => void) | undefined;
}) {
  const d = (typeof data === "object" && data !== null ? data : {}) as {
    id?: string;
    title?: string;
    rev?: number;
  };
  if (typeof d.id !== "string") return null;
  // An optimistic part (or older history) may carry only the id — it
  // labels itself rather than dropping the chip. A rev only displays
  // when the server's expansion actually stamped one.
  const label = `Note · ${typeof d.title === "string" ? d.title : d.id}${
    typeof d.rev === "number" ? ` · rev ${d.rev}` : ""
  }`;
  if (onOpenNote === undefined) {
    return (
      <a
        className="attachment note-chip"
        href={`/app/n/${encodeURIComponent(d.id)}`}
      >
        <FileIcon />
        <span className="attachment-name">{label}</span>
      </a>
    );
  }
  return (
    <span className="attachment note-chip">
      <FileIcon />
      <button
        type="button"
        className="attachment-name link"
        onClick={() => onOpenNote(d.id!)}
      >
        {label}
      </button>
    </span>
  );
}

function inlineChip(part: UIMessage["parts"][number]): SentChip | null {
  const value = (part as { data?: unknown }).data;
  if (part.type === "data-attachment") {
    const ref = parseAttachmentRef(value);
    const chip = ref === null ? null : parseChip({ kind: "file", state: "ready", ref });
    return chip?.kind === "file" ? chip : null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (part.type === "data-note" && typeof data.id === "string") {
    const chip = parseChip({
      kind: "note",
      id: data.id,
      title: typeof data.title === "string" ? data.title : data.id,
    });
    return chip?.kind === "note" ? chip : null;
  }
  if (part.type === "data-skill") {
    if (typeof data.name === "string") {
      const chip = parseChip({ kind: "skill", ref: { name: data.name } });
      return chip?.kind === "skill" ? chip : null;
    }
    if (typeof data.url === "string" && typeof data.path === "string") {
      const chip = parseChip({ kind: "skill", ref: { url: data.url, path: data.path } });
      return chip?.kind === "skill" ? chip : null;
    }
  }
  return null;
}

function sentChipName(chip: SentChip): string {
  if (chip.kind === "note") return chip.title;
  if (chip.kind === "skill") {
    if ("name" in chip.ref) return chip.ref.name;
    return chip.ref.path.split("/").filter(Boolean).at(-2) ?? "skill";
  }
  return chip.state === "ready" ? chip.ref.filename : chip.filename;
}

function sentChipAria(chip: SentChip): string {
  if (chip.kind === "note") return `Note ${chip.title}`;
  if (chip.kind === "skill") return `Skill ${sentChipName(chip)}`;
  return `File ${sentChipName(chip)}`;
}

function SentChip({
  chip,
  token,
  onOpenNote,
}: {
  chip: SentChip;
  token: string | null;
  onOpenNote?: ((id: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const activate = () => setOpen(true);
  return (
    <>
      <span
        ref={anchor}
        className="goblin-chip"
        role="button"
        tabIndex={0}
        aria-label={sentChipAria(chip)}
        data-goblin-chip={JSON.stringify(chip)}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        }}
      >
        <span className="goblin-chip-icon" aria-hidden="true">
          {chip.kind === "skill" ? "⚡" : "•"}
        </span>
        <span className="goblin-chip-name">{sentChipName(chip)}</span>
      </span>
      {open && anchor.current !== null && (
        <Popover
          open
          onOpenChange={(next) => setOpen(next)}
        >
          <PopoverContent
            anchor={anchor.current}
            align="start"
            sideOffset={6}
            className="chip-pop"
            finalFocus={() => anchor.current}
          >
            <ChipDetails
              chip={chip}
              token={token}
              onOpenNote={(id) => onOpenNote?.(id)}
              onRemove={() => {}}
              readOnly
            />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

function chipLabel(chip: SentChip): string {
  return `[${inlineChipLabel(chip.kind, sentChipName(chip))}]`;
}

function inlineMarker(index: number): string {
  return `\uE000${index}\uE001`;
}

function selectionText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1) return Array.from(node.childNodes, selectionText).join("");
  const element = node as Element;
  if (element.matches("[data-goblin-chip]")) {
    try {
      const chip = parseChip(JSON.parse(element.getAttribute("data-goblin-chip") ?? ""));
      return chip === null || chip.kind === "quote" ? "" : chipLabel(chip);
    } catch {
      return "";
    }
  }
  if (element.tagName === "BR") return "\n";
  const inner = Array.from(element.childNodes, selectionText).join("");
  return /^(?:DIV|LI|P|BLOCKQUOTE|H[1-6])$/.test(element.tagName) && inner !== ""
    ? `${inner}\n`
    : inner;
}

export function copyInlineSelection(event: ClipboardEvent<HTMLElement>): void {
  const root = event.currentTarget;
  const selection = root.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (range === null || range.collapsed || event.clipboardData === null) return;
  let holdsChip = false;
  for (const element of root.querySelectorAll("[data-goblin-chip]")) {
    if (range.intersectsNode(element)) {
      holdsChip = true;
      break;
    }
  }
  if (!holdsChip) return;
  const fragment = range.cloneContents();
  const text = selectionText(fragment).replace(/\n$/, "");
  const container = root.ownerDocument.createElement("div");
  container.append(fragment.cloneNode(true));
  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData("text/html", container.innerHTML);
  event.preventDefault();
}

export function hasUiPart(parts: UIMessage["parts"]): boolean {
  return parts.some((p) => isToolUIPart(p) && getToolName(p) === "ui");
}

function MessagePartsView({
  parts,
  token,
  noteProjectId,
  onAction,
  onOpenNote,
  clipFences,
  busy,
  streaming,
  working,
  ended,
  messages,
  sentMedia,
}: {
  parts: UIMessage["parts"];
  token?: string | null;
  // The conversation's project — a note-card "New note" binds to it.
  noteProjectId?: string | null | undefined;
  // ui block actions (choices, form submits) post through the
  // caller's sendMessage; busy disables them while a turn runs.
  onAction?: ((text: string) => void) | undefined;
  // Note chips and the fenced note card navigate in-app when wired.
  onOpenNote?: ((id: string) => void) | undefined;
  // Operator messages: long pasted fences clip to a preview. Model
  // output renders whole — its fences are the answer, not clutter.
  clipFences?: boolean | undefined;
  busy?: boolean | undefined;
  // This message is still arriving; older cards stay actionable during later turns.
  streaming?: boolean | undefined;
  working?: boolean | undefined;
  // The owning turn is over (unlanded record): stuck tool states draw
  // ended — "no result recorded" — never a running shimmer.
  ended?: boolean | undefined;
  // The full transcript, when the caller has it: ui surfaces re-derive
  // their picked choice row from persisted [ui] messages.
  messages?: readonly UIMessage[] | undefined;
  sentMedia?: ReadonlyMap<string, readonly UIMessage[]> | undefined;
}) {
  if (hasInlineParts(parts)) {
    const prose: string[] = [];
    const chipNodes: ReactNode[] = [];
    const chipLabels: string[] = [];
    const imageMedia: UIMessage["parts"] = [];
    const audioMedia: UIMessage["parts"] = [];
    const mediaPaths = new Set<string>();
    const remaining: UIMessage["parts"] = [];
    for (const part of parts) {
      if (part.type === "text") {
        prose.push(part.text);
        continue;
      }
      if (!isInlinePart(part)) {
        remaining.push(part);
        continue;
      }
      const chip = inlineChip(part);
      if (chip === null) {
        remaining.push(part);
        continue;
      }
      const index = chipNodes.length;
      const label = chipLabel(chip);
      chipLabels.push(label);
      chipNodes.push(
        <SentChip
          key={`${index}:${part.type}`}
          chip={chip}
          token={token ?? null}
          onOpenNote={onOpenNote}
        />,
      );
      prose.push(inlineMarker(index));
      if (part.type === "data-attachment") {
        const ref = chip.kind === "file" && chip.state === "ready" ? chip.ref : null;
        if (
          ref !== null &&
          (ref.mediaType.startsWith("image/") || ref.mediaType.startsWith("audio/")) &&
          !mediaPaths.has(ref.path)
        ) {
          mediaPaths.add(ref.path);
          (ref.mediaType.startsWith("image/") ? imageMedia : audioMedia).push(part);
        }
      }
    }
    return (
      <>
        <Markdown
          text={prose.join("")}
          chips={chipNodes}
          chipLabels={chipLabels}
          token={token}
          noteProjectId={noteProjectId}
          onOpenNote={onOpenNote}
          streaming={streaming}
          clipFences={clipFences}
        />
        {[...imageMedia, ...audioMedia].map((part, index) => (
          <AttachmentChip
            key={`inline-media:${index}`}
            data={(part as { data?: unknown }).data}
            token={token ?? null}
          />
        ))}
        {remaining.length > 0 && (
          <MessagePartsView
            parts={remaining}
            token={token ?? null}
            noteProjectId={noteProjectId}
            onAction={onAction}
            onOpenNote={onOpenNote}
            clipFences={clipFences}
            busy={busy}
            streaming={streaming}
            working={working}
            ended={ended}
            messages={messages}
            sentMedia={sentMedia}
          />
        )}
      </>
    );
  }
  const out: ReactNode[] = [];
  let liveDrawn = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (isToolUIPart(p) && getToolName(p) === "ui") {
      // ui parts render inline as the interface itself — they never
      // join a Worked run.
      out.push(
        <UiPart
          key={p.toolCallId === "" ? i : p.toolCallId}
          part={p}
          onAction={onAction}
          busy={busy}
          token={token}
          noteProjectId={noteProjectId}
          onOpenNote={onOpenNote}
          messages={messages}
          streaming={streaming}
        />,
      );
      continue;
    }
    if (p.type === "data-approval") {
      const data =
        typeof p.data === "object" && p.data !== null
          ? (p.data as { kind?: unknown; id?: unknown })
          : null;
      if (
        (data?.kind === "program" || data?.kind === "mail") &&
        typeof data.id === "number"
      ) {
        out.push(
          <ApprovalCard
            key={i}
            token={token ?? null}
            kind={data.kind}
            id={data.id}
          />,
        );
      }
      continue;
    }
    if (isActivityPart(p) || p.type === "step-start" || p.type === "reasoning") {
      const run: ActivityPart[] = [];
      let j = i;
      while (j < parts.length) {
        const q = parts[j]!;
        if (isToolUIPart(q)) {
          if (getToolName(q) === "ui") break;
          run.push(q);
        } else if (q.type === "reasoning") {
          // Empty reasoning parts exist in history — providers that
          // seal chain-of-thought (encrypted, or an unmapped
          // dialect) still emit the part. They carry nothing and
          // break nothing.
          if (q.text.trim() !== "") run.push(q);
        } else if (q.type === "text") {
          if (q.text.trim() !== "") break;
        } else if (q.type === "source-url" && run.length === 0) {
          break;
        } else if (
          q.type === "data-attachment" ||
          q.type === "data-note" ||
          q.type === "data-approval" ||
          q.type === "data-skill" ||
          q.type === "file"
        ) {
          break;
        }
        // step-start, sources, and any future plumbing render as
        // nothing — they never split a run.
        j++;
      }
      if (working === true && j === parts.length) liveDrawn = true;
      if (run.length > 0 || (working === true && j === parts.length)) out.push(
        <Activity
          key={`w${i}`}
          parts={run}
          live={working === true && j === parts.length}
          ended={ended}
        />,
      );
      for (const q of run) {
        if (!isToolUIPart(q)) continue;
        for (const media of sentMedia?.get(q.toolCallId) ?? []) {
          out.push(
            <MessagePartsView
              key={`media:${media.id}`}
              parts={media.parts}
              token={token ?? null}
              noteProjectId={noteProjectId}
              onOpenNote={onOpenNote}
            />,
          );
        }
        if (q.state !== "output-available") continue;
        // Published artifacts hoist out of the fold into cards — the
        // fold records that the call ran; the card is the openable
        // thing. Direct artifact calls and a script's collected
        // presentations land the same way.
        const name = getToolName(q);
        const artifacts: Artifact[] =
          name === "artifact"
            ? ([artifactOf(q.output)].filter((a) => a !== null) as Artifact[])
            : name === "script"
              ? presentationsOf(q.output).map((p2) => p2.artifact)
              : [];
        for (const a of artifacts) {
          out.push(<ArtifactCard key={`a:${a.path}`} artifact={a} />);
        }
      }
      i = j - 1;
      continue;
    }
    if (p.type === "text")
      out.push(
        <Markdown
          key={i}
          text={p.text}
          token={token}
          noteProjectId={noteProjectId}
          onOpenNote={onOpenNote}
          streaming={streaming}
          clipFences={clipFences}
        />,
      );
    else if (p.type === "data-attachment")
      out.push(<AttachmentChip key={i} data={p.data} token={token ?? null} />);
    else if (p.type === "data-note")
      out.push(<NoteChip key={i} data={p.data} onOpenNote={onOpenNote} />);
    else if (p.type === "data-skill")
      out.push(<SkillChip key={i} data={p.data} />);
    else if (p.type === "file")
      out.push(
        <span key={i} className="attachment">
          <FileIcon />
          <span className="attachment-name">{p.filename ?? "attachment"}</span>
        </span>,
      );
    else if (p.type === "source-url") {
      // Hosted-search citations arrive as source-url parts — group
      // the run into one compact row of links.
      const row: { url: string; title?: string }[] = [];
      let j = i;
      while (j < parts.length && parts[j]!.type === "source-url") {
        const q = parts[j] as {
          type: "source-url";
          url: string;
          title?: string;
        };
        row.push({
          url: q.url,
          ...(q.title !== undefined ? { title: q.title } : {}),
        });
        j++;
      }
      out.push(
        <div key={i} className="sources-row">
          {row.map((src) => (
            <a
              key={src.url}
              href={src.url}
              target="_blank"
              rel="noreferrer"
              className="source-link"
            >
              {src.title ?? hostnameOf(src.url)}
            </a>
          ))}
        </div>,
      );
      i = j - 1;
    }
  }
  if (working === true && !liveDrawn)
    out.push(<Activity key={`w${parts.length}`} parts={[]} live ended={ended} />);
  return <>{out}</>;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const MessageParts = memo(MessagePartsView);
