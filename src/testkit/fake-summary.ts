// A fake fold summary that passes the compaction quality audit: the
// required headings, with the prompt's last operator line echoed under
// Pending user asks — or, for a chunk with none, the ask its running
// summary carried, as a real summarizer would.
export function foldSummary(text: string, prompt: string): string {
	const ask =
		[...prompt.matchAll(/^user: ([^[].*)$/gm)].at(-1)?.[1] ??
		/^## Pending user asks\n(.*)$/m.exec(prompt)?.[1] ??
		"";
	return `${text}\n## Decisions\n## Open TODOs\n## Constraints/Rules\n## Pending user asks\n${ask}\n## Exact identifiers`;
}
