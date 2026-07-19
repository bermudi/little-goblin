// Command e2e-smoke is the goblin end-to-end smoke suite.
//
// It drives goblin as a real Telegram user via gotd (MTProto), exercising the
// full feature surface: slash commands, agent turns, tool calls, memory,
// subagents, voice, files, forum topics, MCP.
//
// Run goblin separately first (`bun run dev`), then:
//
//	go run ./e2e/
//
// See e2e/README.md for setup.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

func main() {
	env, err := loadEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[err] %s\n", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Session file lives next to the binary (e2e/.session.json, gitignored).
	// The harness is run from the e2e/ directory (cd e2e && go run .).
	sessionPath := ".session.json"

	dispatcher := tg.NewUpdateDispatcher()
	client := telegram.NewClient(env.APIID, env.APIHash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: sessionPath},
		UpdateHandler:  dispatcher,
	})

	exitCode := 1
	err = client.Run(ctx, func(runCtx context.Context) error {
		if err := authenticate(runCtx, client, env); err != nil {
			return fmt.Errorf("auth: %w", err)
		}

		api := tg.NewClient(client)
		driver, err := newDriver(runCtx, env, dispatcher, api)
		if err != nil {
			return fmt.Errorf("create driver: %w", err)
		}

		exitCode = runAll(SmokeCtx{
			env:        env,
			g:          driver,
			ctx:        runCtx,
			dispatcher: dispatcher,
		})
		return nil
	})

	if err != nil {
		fmt.Fprintf(os.Stderr, "[err] Smoke suite crashed: %s\n", err)
		exitCode = 1
	}

	os.Exit(exitCode)
}
