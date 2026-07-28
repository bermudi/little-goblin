package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// loadDotEnv loads a local dotenv file without overriding variables already
// supplied by the operator or secret injector. A missing file is expected;
// malformed or unreadable files fail loud.
func loadDotEnv(path string) error {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("open dotenv file: %w", err)
	}
	defer f.Close()

	values, err := parseDotEnv(f)
	if err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	for key, value := range values {
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return fmt.Errorf("set %s from %s: %w", key, path, err)
		}
	}
	return nil
}

func parseDotEnv(r io.Reader) (map[string]string, error) {
	values := make(map[string]string)
	scanner := bufio.NewScanner(r)
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, rawValue, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || !validEnvKey(key) {
			return nil, fmt.Errorf("line %d: expected KEY=VALUE", lineNumber)
		}

		value := strings.TrimSpace(rawValue)
		if strings.HasPrefix(value, "\"") {
			if len(value) < 2 || value[len(value)-1] != '"' {
				return nil, fmt.Errorf("line %d: unterminated double-quoted value", lineNumber)
			}
			unquoted, err := strconv.Unquote(value)
			if err != nil {
				return nil, fmt.Errorf("line %d: invalid quoted value: %w", lineNumber, err)
			}
			value = unquoted
		} else if strings.HasPrefix(value, "'") {
			if len(value) < 2 || value[len(value)-1] != '\'' {
				return nil, fmt.Errorf("line %d: unterminated single-quoted value", lineNumber)
			}
			value = value[1 : len(value)-1]
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read dotenv file: %w", err)
	}
	return values, nil
}

func validEnvKey(key string) bool {
	if key == "" || !isEnvKeyStart(key[0]) {
		return false
	}
	for i := 1; i < len(key); i++ {
		if !isEnvKeyStart(key[i]) && (key[i] < '0' || key[i] > '9') {
			return false
		}
	}
	return true
}

func isEnvKeyStart(ch byte) bool {
	return ch == '_' || ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z'
}
