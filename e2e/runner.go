package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gotd/td/tg"
)

// SmokeCtx is passed to each test function.
type SmokeCtx struct {
	env        *Env
	g          *GoblinDriver
	ctx        context.Context
	dispatcher tg.UpdateDispatcher
}

// TestCase is a registered smoke test.
type TestCase struct {
	Name     string
	Fn       func(ctx SmokeCtx) error
	Requires func(env *Env) string // returns skip reason or ""
}

var registry []TestCase

// test registers a smoke test.
func test(name string, fn func(ctx SmokeCtx) error, requires func(env *Env) string) {
	registry = append(registry, TestCase{Name: name, Fn: fn, Requires: requires})
}

type TestResult struct {
	Name   string
	Status string // "pass", "fail", "skip"
	Ms     int64
	Error  string
}

// runAll runs all registered tests sequentially and returns the exit code.
func runAll(ctx SmokeCtx) int {
	var results []TestResult

	// Validate E2E_ONLY against registered names.
	if ctx.env.Only != nil {
		for name := range ctx.env.Only {
			found := false
			for _, tc := range registry {
				if tc.Name == name {
					found = true
					break
				}
			}
			if !found {
				fmt.Fprintf(os.Stderr, "[warn] E2E_ONLY references unknown test: %s\n", name)
			}
		}
	}

	fmt.Printf("\n Goblin smoke suite — %d test(s) registered\n\n", len(registry))

	for _, tc := range registry {
		skipReason := ""
		if ctx.env.Only != nil && !ctx.env.Only[tc.Name] {
			skipReason = "skipped (E2E_ONLY)"
		} else if ctx.env.Skip[tc.Name] {
			skipReason = "skipped (E2E_SKIP)"
		} else if tc.Requires != nil {
			skipReason = tc.Requires(ctx.env)
		}

		if skipReason != "" {
			results = append(results, TestResult{Name: tc.Name, Status: "skip", Error: skipReason})
			fmt.Printf("  \033[33mSKIP\033[0m %s — %s\n", tc.Name, skipReason)
			continue
		}

		start := time.Now()
		// Wrap in a func to recover from assertion panics so one failed
		// assertion doesn't crash the entire suite.
		var err error
		func() {
			defer func() {
				if r := recover(); r != nil {
					if ae, ok := r.(*AssertionError); ok {
						err = ae
					} else {
						err = fmt.Errorf("panic: %v", r)
					}
				}
			}()
			err = tc.Fn(ctx)
		}()
		ms := time.Since(start).Milliseconds()

		if err != nil {
			results = append(results, TestResult{Name: tc.Name, Status: "fail", Ms: ms, Error: err.Error()})
			fmt.Printf("  \033[31mFAIL\033[0m %s (%dms)\n", tc.Name, ms)
			// Print first line of error.
			lines := fmt.Sprintf("%s", err.Error())
			if idx := strings.Index(lines, "\n"); idx >= 0 {
				lines = lines[:idx]
			}
			fmt.Printf("        \033[31m%s\033[0m\n", lines)
		} else {
			results = append(results, TestResult{Name: tc.Name, Status: "pass", Ms: ms})
			fmt.Printf("  \033[32mPASS\033[0m %s (%dms)\n", tc.Name, ms)
		}
	}

	// Summary.
	pass, fail, skip := 0, 0, 0
	for _, r := range results {
		switch r.Status {
		case "pass":
			pass++
		case "fail":
			fail++
		case "skip":
			skip++
		}
	}
	fmt.Printf("\n  \033[1m%d passed\033[0m", pass)
	if fail > 0 {
		fmt.Printf(", \033[31m%d failed\033[0m", fail)
	}
	if skip > 0 {
		fmt.Printf(", \033[33m%d skipped\033[0m", skip)
	}
	fmt.Println()

	if fail > 0 {
		fmt.Printf("\n  \033[1m\033[31mFailures:\033[0m\n")
		for _, r := range results {
			if r.Status == "fail" {
				fmt.Printf("    \033[31m✗\033[0m %s\n        %s\n", r.Name, r.Error)
			}
		}
	}

	if fail > 0 {
		return 1
	}
	return 0
}
