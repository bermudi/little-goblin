# Document viewer

## How to get to it

Open a published artifact card in a conversation. A file path chip inside
an expanded read/write/edit tool opens the same viewer on the live file.
The header has Copy for markdown, plain text and HTML source.

## Fixture setup

The standard fake model does not call tools. For this journey, seed a
synthetic transcript and public files in the throwaway instance only.
This proves the viewer and its reader routes, not model/tool behavior.

Start `bun run try doc-copy`, then run this from the checkout root:

```sh
GOBLIN_HOME=/tmp/goblin-verify/doc-copy bun --no-env-file -e '
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./src/conversation.ts";
import { appAddress } from "./src/conversation-address.ts";
import { paths } from "./src/config.ts";
const text = "# Copy sample\n\n**Raw** markdown.\n\n[Plain](plain.txt) [HTML](page.html) [PDF](sample.pdf) [Large](large.txt)\n";
mkdirSync(paths.attachments(), { recursive: true });
for (const [name, body] of [
  ["index.md", text],
  ["plain.txt", "Line one\nLine two — λ 中文 🙂\n"],
  ["page.html", "<h1>Copy source</h1><p>Not rendered text.</p>"],
  ["sample.pdf", "%PDF-1.4 synthetic download fixture"],
  ["large.txt", "x".repeat(4 * 1024 * 1024 + 1)],
]) writeFileSync(join(paths.workspace(), name), body);
const path = join(paths.attachments(), "copy-snapshot.md");
writeFileSync(path, text);
const store = openStore(join(process.env.GOBLIN_HOME, "state/goblin.sqlite"));
try {
  const c = store.resolve(appAddress("doc-copy"), paths.workspace(), { model: "fake/verify-model", thinking: "off" });
  store.setMeta(c.id, { title: "Document copy check" });
  store.append(c.id, [{
    id: crypto.randomUUID(), role: "assistant", parts: [
      { type: "tool-read_file", toolCallId: "read-sample", state: "output-available",
        input: { path: "index.md" }, output: { content: text, lines: 5, shown: 5 } },
      { type: "tool-artifact", toolCallId: "publish-sample", state: "output-available",
        input: { source: { target: "workspace", path: "index.md" } },
        output: { artifact: { path, name: "index.md", title: "Copy sample",
          mediaType: "text/markdown", size: Buffer.byteLength(text),
          source: { target: "workspace", path: "index.md" } } } },
    ],
  }]);
} finally { store.close(); }
'
```

Open the printed instance URL with `c/doc-copy` appended.

## Journey and proof

Use a named headless `agent-browser` session. Start a recording before the
first click.

1. Click **Copy sample**, then **Copy** in the dialog.
2. Check that the label changes to **Copied** and the clipboard equals
   `workspace/index.md`, including markdown syntax and links.
3. Follow **Plain** immediately after copying. The new header must say
   **Copy**, not **Copied**. Copy and compare with `workspace/plain.txt`.
4. Click **Back**. Copy must be idle again.
5. Follow **HTML**, copy, and compare with the HTML source file.
6. Visit **PDF** and **Large**. Both offer download and no header copy
   button. Go back after each.
7. Close the viewer. Expand **Worked**, then the `read_file` tool, and
   click its `index.md` chip. Copy must equal the live workspace file.

Capture the action and result, plus the reader-route lines in
`state/goblin.log`. Clipboard reads in headless Chrome can require an
explicit permission grant for this loopback origin. Grant it only in the
test-owned browser. Do not replace `navigator.clipboard` for a successful
copy test; a stub cannot prove that the actual clipboard was written.

Clipboard-denial feedback, pending writes during navigation, empty files
and non-text media are also covered by `app/src/docview.test.tsx`; those
tests fake only fetch and the clipboard boundary.

Stop the test browser with `agent-browser --session <name> close`, then
stop the instance with `bun run try down doc-copy`.
