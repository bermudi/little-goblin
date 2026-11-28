import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import type { AppBot, AppBotMemory, AppBotPatch, AppConfigView } from "../../src/http/app-wire.ts";
import { getBotMemory, getConfig, moveBotChatBack, patchBot } from "./api.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { Markdown } from "./markdown.tsx";

export function BotPage({ token, bot, tab, onChanged, onMovedBack, onTab }: {
	token: string | null;
	bot: AppBot;
	tab: "settings" | "memory";
	onChanged: () => Promise<unknown>;
	onMovedBack: (conversationId: string) => void;
	onTab: (tab: "settings" | "memory") => void;
}) {
	const [draft, setDraft] = useState({ name: bot.name, instructions: bot.instructions, model: bot.model ?? "", thinking: bot.thinking ?? "" });
	const [config, setConfig] = useState<AppConfigView | null>(null);
	const [memory, setMemory] = useState<AppBotMemory | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setDraft({ name: bot.name, instructions: bot.instructions, model: bot.model ?? "", thinking: bot.thinking ?? "" });
		void getConfig(token).then(setConfig, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, [token, bot]);
	useEffect(() => {
		if (tab !== "memory") return;
		setMemory(null);
		void getBotMemory(token, bot.id).then(setMemory, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, [token, bot.id, tab]);
	const models = config === null ? [] : (config.pickerModels ?? config.catalog.flatMap((group) => group.models.map((model) => `${group.provider}/${model.id}`)));
	const save = async () => {
		const patch: AppBotPatch = {};
		if (draft.name !== bot.name) patch.name = draft.name;
		if (draft.instructions !== bot.instructions) patch.instructions = draft.instructions;
		if (draft.model !== (bot.model ?? "")) patch.model = draft.model || null;
		if (draft.thinking !== (bot.thinking ?? "")) patch.thinking = draft.thinking || null;
		if (Object.keys(patch).length === 0 || pending) return;
		setPending(true); setError(null);
		try { await patchBot(token, bot.id, patch); await onChanged(); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setPending(false); }
	};
	const moveBack = async () => {
		setPending(true); setError(null);
		try { onMovedBack((await moveBotChatBack(token, bot.id)).conversationId); }
		catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setPending(false); }
	};
	return <div className="ops bot-settings">
		<header className="bot-page-header">
			<BotAvatar name={bot.name} large />
			<div><h1>{bot.name}</h1><p>Idle · bot</p></div>
			<a className="addbtn" href={`/app/c/${bot.mainConversationId.slice("app/".length)}`}>Open main chat</a>
		</header>
		<Tabs value={tab} onValueChange={(v) => { if (v === "settings" || v === "memory") onTab(v); }}>
			<TabsList aria-label={`${bot.name} bot page`}>
				<TabsTab value="settings">Settings</TabsTab><TabsTab value="memory">Memory</TabsTab>
			</TabsList>
			<TabsPanel value="settings">
				<div className="bot-settings-fields">
					<label htmlFor="bot-name">Name</label><input id="bot-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
					<label htmlFor="bot-model">Default model</label><select id="bot-model" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}><option value="">App default ({config?.model ?? "loading"})</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
					<label htmlFor="bot-thinking">Thinking</label><select id="bot-thinking" value={draft.thinking} onChange={(e) => setDraft({ ...draft, thinking: e.target.value })}><option value="">App default ({config?.thinking ?? "loading"})</option>{(config?.thinkingLevels ?? []).map((level) => <option key={level} value={level}>{level}</option>)}</select>
					<label htmlFor="bot-instructions">Instructions</label><textarea id="bot-instructions" value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} />
					<label>Folder</label><p>{bot.folder ?? "No folder"}</p>
					<span /><div><button className="addbtn" disabled={pending} onClick={() => void save()}>{pending ? "Saving…" : "Save"}</button> <span>Changes apply to fresh conversations.</span></div>
				</div>
				{bot.canMoveBack && <section className="card bot-settings-move"><div><p>The main chat returns to Little Goblin’s side chats with its history intact.</p><button type="button" className="danger" disabled={pending} onClick={() => void moveBack()}>Move back to Little Goblin</button></div></section>}
			</TabsPanel>
			<TabsPanel value="memory">
				{memory === null ? <p>Loading memory…</p> : memory.path === null ? <p>This bot has no folder, so it has no memory file.</p> : memory.text === null ? <p>No MEMORY.md yet. The bot writes it as it learns.</p> : <Markdown text={memory.text} token={token} />}
				{memory?.path !== null && memory !== null && <p>{memory.path}</p>}
			</TabsPanel>
		</Tabs>
		{error !== null && <p className="err-inline" role="alert">{error}</p>}
	</div>;
}
