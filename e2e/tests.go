package main

import (
	"errors"
	"fmt"
	"math/rand"
	"regexp"
	"strings"
	"time"
)

// --- Command smoke tests ---

func pingInTopic(ctx SmokeCtx, driver *GoblinDriver, label string, unthreaded *LiveInbox) (err error) {
	defer func() {
		err = errors.Join(err, driver.cleanupCreatedTopic(ctx.ctx))
	}()

	if err := driver.sendCommand(ctx.ctx, "ping"); err != nil {
		return fmt.Errorf("send /ping in %s: %w", label, err)
	}
	reply, err := driver.awaitSystemReply()
	if err != nil {
		if unthreaded != nil {
			return fmt.Errorf("%w; unthreaded DM replies captured: %d", err, len(unthreaded.snapshot()))
		}
		return err
	}
	text := stripSystemTag(reply.Text)
	if !strings.Contains(text, "pong 🐲") {
		return assertErr("%s reply missing pong: %s", label, truncate(reply.Text, 200))
	}
	if !strings.Contains(text, fmt.Sprintf("user: %d", driver.meID)) {
		return assertErr("%s reply missing driving user id: %s", label, truncate(reply.Text, 200))
	}
	return nil
}

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

	// /start — status only; valid whether the DM is currently bound or fresh.
	test("start", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "start"); err != nil {
			return fmt.Errorf("send /start: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?i)(Welcome back.*Conversation|No active conversation)`))
		return nil
	}, nil)

	// /new — create and bind a fresh conversation, leaving the prior one resumable.
	test("new", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "new"); err != nil {
			return fmt.Errorf("send /new: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("Created new conversation")
		return nil
	}, nil)

	// /debug — dump diagnostics for the conversation created above.
	test("debug", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "debug"); err != nil {
			return fmt.Errorf("send /debug: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`(?s)Conversation:.*Model:.*Tools:`))
		return nil
	}, nil)

	// /name — name the active conversation.
	test("name", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, fmt.Sprintf("name smoke-%d", time.Now().Unix())); err != nil {
			return fmt.Errorf("send /name: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("Named conversation")
		return nil
	}, nil)

	// /cancel while idle must report honestly and return promptly.
	test("cancel idle", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "cancel"); err != nil {
			return fmt.Errorf("send /cancel: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("Nothing to cancel")
		return nil
	}, nil)

	// /archive removes the active binding after /new.
	test("archive", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "archive"); err != nil {
			return fmt.Errorf("send /archive: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("Conversation archived")
		return nil
	}, nil)

	// /start verifies that archive cleared the Surface binding.
	test("start after archive", func(ctx SmokeCtx) error {
		if err := ctx.g.sendCommand(ctx.ctx, "start"); err != nil {
			return fmt.Errorf("send /start after /archive: %w", err)
		}
		reply, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toContain("No active conversation")
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

	test("memory: search tool", func(ctx SmokeCtx) error {
		if err := ctx.g.sendText(ctx.ctx,
			"Use the memory_search tool with query \"smoke-test color\". Reply with one matching teal-NNNNNN token from the tool result, then the marker ENDSEARCH."); err != nil {
			return fmt.Errorf("send: %w", err)
		}
		reply, err := ctx.g.awaitAgentReply()
		if err != nil {
			return err
		}
		expect(reply.Text).toMatch(regexp.MustCompile(`teal-\d+`))
		expect(reply.Text).toContain("ENDSEARCH")
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
		reply, err := ctx.g.awaitDocument()
		if err != nil {
			return err
		}
		re := regexp.MustCompile(`(?i)reply\.md$`)
		if !re.MatchString(reply.Media.FileName) {
			return assertErr("expected reply.md document, got fileName=%q", reply.Media.FileName)
		}

		// The file is emitted as soon as the stream crosses 20k; the model may
		// still be producing a short tail. Stop that tail and wait for the cancel
		// acknowledgement so the next smoke test never races this turn.
		if err := ctx.g.sendCommand(ctx.ctx, "cancel"); err != nil {
			return fmt.Errorf("stop big-output tail: %w", err)
		}
		cancelled, err := ctx.g.awaitSystemReply()
		if err != nil {
			return err
		}
		if !strings.Contains(cancelled.Text, "Cancelled.") && !strings.Contains(cancelled.Text, "Nothing to cancel") {
			return assertErr("expected completed cancellation after reply.md, got %q", cancelled.Text)
		}
		if strings.Contains(cancelled.Text, "may still be running") {
			return assertErr("big-output runtime did not stop cleanly: %q", cancelled.Text)
		}
		if strings.Contains(cancelled.Text, "Cancelled.") {
			// The runtime posts its terminal aborted response after the command ack.
			// Consume it before the next test sends a prompt, otherwise that delayed
			// message can be mistaken for the next turn's reply.
			terminal, err := ctx.g.awaitAgentReply()
			if err != nil {
				return fmt.Errorf("wait for cancelled big-output turn to settle: %w", err)
			}
			if !strings.Contains(strings.ToLower(terminal.Text), "aborted") {
				return assertErr("expected terminal aborted response after cancellation, got %q", terminal.Text)
			}
		}
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

	test("dm-topic: /ping in a private topic", func(ctx SmokeCtx) error {
		topic, err := newDMTopicDriver(ctx.ctx, ctx.env, ctx.dispatcher, ctx.g.api)
		if err != nil {
			return fmt.Errorf("create DM topic driver: %w", err)
		}
		return pingInTopic(ctx, topic, "DM topic", ctx.g.inbox)
	}, func(env *Env) string {
		return env.requires(env.DMTopicID != "", "set E2E_DM_TOPIC_ID to a private-chat topic id")
	})

	test("forum-topic: /ping in a forum topic", func(ctx SmokeCtx) error {
		forum, err := newForumDriver(ctx.ctx, ctx.env, ctx.dispatcher, ctx.g.api)
		if err != nil {
			return fmt.Errorf("create forum driver: %w", err)
		}
		return pingInTopic(ctx, forum, "forum topic", nil)
	}, func(env *Env) string {
		return env.requires(env.ForumChat != "", "set E2E_FORUM_CHAT (and optionally E2E_FORUM_TOPIC_ID)")
	})
}
