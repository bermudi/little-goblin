package main

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
)

// AssertionError is thrown by expect on failure.
type AssertionError struct{ Msg string }

func (e *AssertionError) Error() string { return e.Msg }

func assertErr(format string, args ...any) error {
	return &AssertionError{Msg: fmt.Sprintf(format, args...)}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("… (+%d chars)", len(s)-max)
}

// expectString provides assertion helpers for string values.
type expectString struct {
	actual   string
	negated  bool
}

func expect(s string) expectString {
	return expectString{actual: s}
}

func (e expectString) not() expectString {
	return expectString{actual: e.actual, negated: !e.negated}
}

func (e expectString) check(pass bool, format string, args ...any) {
	ok := pass
	if e.negated {
		ok = !pass
	}
	if !ok {
		prefix := ""
		if e.negated {
			prefix = "NOT expected: "
		}
		panic(assertErr("%s%s", prefix, fmt.Sprintf(format, args...)))
	}
}

func (e expectString) toContain(needle string) {
	e.check(strings.Contains(e.actual, needle),
		"expected string to contain %q\nactual: %s", needle, truncate(e.actual, 500))
}

func (e expectString) toMatch(re *regexp.Regexp) {
	e.check(re.MatchString(e.actual),
		"expected to match %s\nactual: %s", re, truncate(e.actual, 500))
}

func (e expectString) toBe(expected string) {
	e.check(e.actual == expected,
		"expected toBe %q\nactual: %s", expected, truncate(e.actual, 500))
}

func (e expectString) toBeGreaterThan(n int) {
	e.check(len(e.actual) > n,
		"expected length > %d, got %d", n, len(e.actual))
}

func (e expectString) toBeGreaterThanOrEqual(n int) {
	e.check(len(e.actual) >= n,
		"expected length >= %d, got %d", n, len(e.actual))
}

// expectInt provides assertion helpers for int values.
type expectInt struct {
	actual  int
	negated bool
}

func expectIntVal(n int) expectInt {
	return expectInt{actual: n}
}

func (e expectInt) check(pass bool, format string, args ...any) {
	ok := pass
	if e.negated {
		ok = !pass
	}
	if !ok {
		panic(assertErr("%s", fmt.Sprintf(format, args...)))
	}
}

func (e expectInt) toBeGreaterThan(n int) {
	e.check(e.actual > n, "expected %d > %d", e.actual, n)
}

func (e expectInt) toBeGreaterThanOrEqual(n int) {
	e.check(e.actual >= n, "expected %d >= %d", e.actual, n)
}

func (e expectInt) toBe(expected int) {
	e.check(e.actual == expected, "expected %d, got %d", expected, e.actual)
}

// expectBool asserts on boolean values.
func expectBool(b, expected bool) {
	if b != expected {
		panic(assertErr("expected %v, got %v", expected, b))
	}
}

// expectEqual asserts deep equality.
func expectEqual(actual, expected any) {
	if !reflect.DeepEqual(actual, expected) {
		panic(assertErr("expected equal:\n  expected: %v\n  actual:   %v", expected, actual))
	}
}
