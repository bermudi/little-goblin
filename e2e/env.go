package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Env holds all configuration for the e2e smoke harness, read from environment
// variables. See e2e/README.md and e2e/.env.example for documentation.
type Env struct {
	APIID            int
	APIHash          string
	Goblin           string // bot username (without @) or numeric id
	Chat             string // optional: chat for DM tests (defaults to goblin)
	ForumChat        string // optional: supergroup with forum topics
	ForumTopicID     string // optional: topic id, or "create"
	ProjectDir       string // optional: dir for /project file tests
	MCPProbePrompt   string // optional: prompt for MCP tool-call test
	MCPProbeExpect   string // optional: substring expected in MCP test reply
	Voice            bool   // optional: enable /voice test
	Timeout          time.Duration
	Settle           time.Duration
	CommandTimeout   time.Duration
	Skip             map[string]bool
	Only             map[string]bool // nil = run all
}

func loadEnv() (*Env, error) {
	apiID, err := strconv.Atoi(os.Getenv("E2E_API_ID"))
	if err != nil {
		return nil, fmt.Errorf("E2E_API_ID must be set to an integer (get it from https://my.telegram.org): %w", err)
	}
	apiHash := os.Getenv("E2E_API_HASH")
	if apiHash == "" {
		return nil, fmt.Errorf("E2E_API_HASH must be set (get it from https://my.telegram.org)")
	}
	goblin := strings.TrimPrefix(os.Getenv("E2E_GOBLIN"), "@")
	if goblin == "" {
		return nil, fmt.Errorf("E2E_GOBLIN must be set (goblin's bot username or numeric id)")
	}

	e := &Env{
		APIID:          apiID,
		APIHash:        apiHash,
		Goblin:         goblin,
		Chat:           strings.TrimPrefix(os.Getenv("E2E_CHAT"), "@"),
		ForumChat:      strings.TrimPrefix(os.Getenv("E2E_FORUM_CHAT"), "@"),
		ForumTopicID:   os.Getenv("E2E_FORUM_TOPIC_ID"),
		ProjectDir:     os.Getenv("E2E_PROJECT_DIR"),
		MCPProbePrompt: os.Getenv("E2E_MCP_PROBE_PROMPT"),
		MCPProbeExpect: os.Getenv("E2E_MCP_PROBE_EXPECT"),
		Voice:          os.Getenv("E2E_VOICE") == "1",
		Timeout:        envDuration("E2E_TIMEOUT_MS", 180*time.Second),
		Settle:         envDuration("E2E_SETTLE_MS", 2500*time.Millisecond),
		CommandTimeout: envDuration("E2E_COMMAND_TIMEOUT_MS", 30*time.Second),
	}

	if v := os.Getenv("E2E_MCP_PROBE"); v != "" {
		var probe struct {
			Prompt string `json:"prompt"`
			Expect string `json:"expect"`
		}
		if err := json.Unmarshal([]byte(v), &probe); err != nil {
			return nil, fmt.Errorf("E2E_MCP_PROBE is invalid JSON: %w", err)
		}
		e.MCPProbePrompt = probe.Prompt
		e.MCPProbeExpect = probe.Expect
	}

	if v := os.Getenv("E2E_SKIP"); v != "" {
		e.Skip = make(map[string]bool)
		for _, name := range strings.Split(v, ",") {
			name = strings.TrimSpace(name)
			if name != "" {
				e.Skip[name] = true
			}
		}
	}
	if v := os.Getenv("E2E_ONLY"); v != "" {
		e.Only = make(map[string]bool)
		for _, name := range strings.Split(v, ",") {
			name = strings.TrimSpace(name)
			if name != "" {
				e.Only[name] = true
			}
		}
	}

	return e, nil
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	ms, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}

// requires returns nil if the condition is met, or a skip reason string.
func (e *Env) requires(cond bool, reason string) string {
	if cond {
		return ""
	}
	return reason
}
