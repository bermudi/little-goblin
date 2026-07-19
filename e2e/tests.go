package main

import (
	"fmt"
	"math/rand"
	"regexp"
	"strings"
	"time"
)

// --- Command smoke tests ---

func init() {
	// /ping — exact text check.
	test("ping", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "ping"); err != nil {
			return fmt.Errorf("send /ping: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		text := stripSystemTag(reply.Text)
		expect(text).toContain("pong 🐲")
		expect(text).toContain("chat:")
		expect(text).toContain(fmt.Sprintf("user: %d", ctx.g.meID))
		return nil
	}, nil)

	// /help — lists commands.
	test("help", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "help"); err != nil {
			return fmt.Errorf("send /help: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		lower := strings.ToLower(reply.Text)
		if !strings.Contains(lower, "/ping") {
			return assertErr("/help reply missing /ping: %s", truncate(reply.Text, 200))
		}
		if !strings.Contains(lower, "/new") {
			return assertErr("/help reply missing /new: %s", truncate(reply.Text, 200))
		}
		return nil
	}, nil)

	// /start — DM session creation or welcome back.
	test("start", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "start"); err != nil {
			return fmt.Errorf("send /start: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)Session|Welcome back|already its own session`))
		return nil
	}, nil)

	// /debug — dumps diagnostics.
	test("debug", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "debug"); err != nil {
			return fmt.Errorf("send /debug: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)session|model|tools`))
		return nil
	}, nil)

	// /name — name the session.
	test("name", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, fmt.Sprintf("name smoke-%d", time.Now().Unix())); err != nil {
			return fmt.Errorf("send /name: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)Renamed|session`))
		return nil
	}, nil)

	// /new — archive + fresh session.
	test("new", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "new"); err != nil {
			return fmt.Errorf("send /new: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)Created new session|new session`))
		return nil
	}, nil)

	// --- Conversation + tool-call tests ---

	test("conversation: exact literal reply", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx, "Reply with exactly the word BANANA and nothing else. No punctuation."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("BANANA")
		return nil
	}, nil)

	test("tool: bash echo", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Use the bash tool to run this exact command: echo hello-smoke\n"+
				"Then reply with the exact stdout on a single line, nothing else."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("hello-smoke")
		return nil
	}, nil)

	test("tool: read file", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Use the read tool to read /etc/hostname, then reply with its exact contents and nothing else."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toBeGreaterThan(0)
		expect(reply.Text).toMatch(regexp.MustCompile(`[\w.\-]+`))
		return nil
	}, nil)

	test("memory: write + recall", func(ctx SmokeCtx) error {
		token := fmt.Sprintf("teal-%d", rand.Intn(1000000))
		if err := ctx.g.sendText(ctx.ctx,
			fmt.Sprintf("Use the memory_write tool to add an entry to the \"user\" scope with this exact content: "+
				"my smoke-test color is %s. Then reply with: REMEMBERED", token)); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		ack, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(ack.Text).toMatch(regexp.MustCompile(`(?i)REMEMBERED|added|remembered|stored|saved`))

		// Recall in a follow-up turn.
		if err := ctx.g.sendText(ctx.ctx, "What is my smoke-test color? Reply with just the color token."); err != nil {
			return fmt.Errorf("send recall: %w", err)
		}
		recall, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(recall.Text).toContain(token)
		return nil
	}, nil)

	test("memory: read tool", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Use the memory_read tool with target \"user\". Reply with the first 40 characters of the body, then the marker ENDREAD."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("ENDREAD")
		return nil
	}, nil)

	// --- Subagent tests ---

	test("subagent: spawn + bash stdout", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Spawn a subagent (spawn_subagent) with this prompt: "+
				"'Use the bash tool to run: echo subagent-smoke, then report the exact stdout.' "+
				"When the subagent finishes, reply with its exact final text."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("subagent-smoke")
		return nil
	}, nil)

	test("subagents: list command", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "subagents"); err != nil {
			return fmt.Errorf("send /subagents: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)subagent|none|id|status`))
		return nil
	}, nil)

	// --- Media tests ---

	test("voice: /voice returns a voice note", func(ctx SmokeCtx) error {
		// /voice acts on the last assistant message, so seed one first.
		if err := ctx.g.sendText(ctx.ctx, "Reply with exactly: hello voice"); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		if _, err := ctx.g.awaitAgentReply(); err != nil {
			return err
		}
		if err := ctx.g.sendCommand(ctx.ctx, "voice"); err != nil {
			return fmt.Errorf("send /voice: %w", err)
		}
		reply, err := ctx.g.awaitVoice()
		if err != nil {
			return err
		}
		expectBool(reply.Media.Type == "voice", true)
		return nil
	}, func(env *Env) string {
		return env.requires(env.Voice, "set E2E_VOICE=1 (requires Edge TTS: uvx edge-tts)")
	})

	test("file: send document into project dir and read it back", func(ctx SmokeCtx) error {
		dir := ctx.env.ProjectDir
		if err := ctx.g.sendCommand(ctx.ctx, "project "+dir); err != nil {
			return fmt.Errorf("send /project: %w", err)
		}
		bound, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(bound.Text).toMatch(regexp.MustCompile(`(?i)Bound|project`))

		payload := fmt.Sprintf("file-smoke-%d", time.Now().UnixMilli())
		if err := ctx.g.sendFile(ctx.ctx, "test.txt", []byte(payload),
			"What exact text does this uploaded file contain? Reply with just that text."); err != nil {
			return fmt.Errorf("send file: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain(payload)
		return nil
	}, func(env *Env) string {
		return env.requires(env.ProjectDir != "", "set E2E_PROJECT_DIR to a writable directory")
	})

	test("big-output: >20k chars roll over to reply.md", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Output the single character x repeated 25000 times with no spaces, no newlines, and nothing else."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.inbox.awaitAgentReply(ctx.env.Timeout, 4*time.Second)
		if err != nil {
			return err
		}
		if reply.Media.Type == "document" {
			re := regexp.MustCompile(`(?i)reply\.md$`)
			if !re.MatchString(reply.Media.FileName) {
				return assertErr("expected reply.md document, got fileName=%q", reply.Media.FileName)
			}
			return nil
		}
		// Fallback: some models may stream the full text instead of rolling over.
		expect(reply.Text).toBeGreaterThanOrEqual(15000)
		return nil
	}, nil)

	// --- Optional tests ---

	test("mcp: call an MCP server tool", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx, ctx.env.MCPProbePrompt); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain(ctx.env.MCPProbeExpect)
		return nil
	}, func(env *Env) string {
		return env.requires(env.MCPProbePrompt != "" && env.MCPProbeExpect != "",
			"set E2E_MCP_PROBE_PROMPT and E2E_MCP_PROBE_EXPECT (or E2E_MCP_PROBE JSON)")
	})

	test("forum-topic: /ping in a forum topic", func(ctx SmokeCtx) error {
		forum, err := newForumDriver(ctx.ctx, ctx.env, ctx.dispatcher, ctx.g.api)
		if err != nil {
			return fmt.Errorf("create forum driver: %w", err)
		}
		if err := forum.sendCommand(ctx.ctx, "ping"); err != nil {
			return fmt.Errorf("send /ping in topic: %w", err)
		}
		reply, err := forum.awaitSystemReply()
		if err != nil {
			return err
		}
		text := stripSystemTag(reply.Text)
		expect(text).toContain("pong 🐲")
		expect(text).toContain(fmt.Sprintf("user: %d", forum.meID))
		return nil
	}, func(env *Env) string {
		return env.requires(env.ForumChat != "", "set E2E_FORUM_CHAT (and optionally E2E_FORUM_TOPIC_ID)")
	})
}
