package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDotEnv(t *testing.T) {
	values, err := parseDotEnv(strings.NewReader(`
# comment
E2E_API_ID=12345
export E2E_API_HASH="abc=def"
E2E_GOBLIN='local_goblin'
E2E_ONLY=ping
`))
	if err != nil {
		t.Fatalf("parseDotEnv: %v", err)
	}

	expected := map[string]string{
		"E2E_API_ID":   "12345",
		"E2E_API_HASH": "abc=def",
		"E2E_GOBLIN":   "local_goblin",
		"E2E_ONLY":     "ping",
	}
	for key, want := range expected {
		if got := values[key]; got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

func TestParseDotEnvRejectsMalformedLines(t *testing.T) {
	for _, input := range []string{"NOT AN ASSIGNMENT", "1BAD=value", `KEY="unterminated`} {
		if _, err := parseDotEnv(strings.NewReader(input)); err == nil {
			t.Errorf("parseDotEnv(%q) unexpectedly succeeded", input)
		}
	}
}

func TestLoadDotEnvDoesNotOverrideOperatorEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("E2E_EXISTING_TEST=file\nE2E_LOADED_TEST=loaded\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("E2E_EXISTING_TEST", "operator")
	if err := os.Unsetenv("E2E_LOADED_TEST"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Unsetenv("E2E_LOADED_TEST"); err != nil {
			t.Errorf("unset E2E_LOADED_TEST: %v", err)
		}
	})

	if err := loadDotEnv(path); err != nil {
		t.Fatalf("loadDotEnv: %v", err)
	}
	if got := os.Getenv("E2E_EXISTING_TEST"); got != "operator" {
		t.Fatalf("existing variable = %q, want operator", got)
	}
	if got := os.Getenv("E2E_LOADED_TEST"); got != "loaded" {
		t.Fatalf("loaded variable = %q, want loaded", got)
	}
}

func TestLoadDotEnvAllowsMissingFile(t *testing.T) {
	if err := loadDotEnv(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatalf("loadDotEnv missing file: %v", err)
	}
}
