package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/term"

	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/tg"
)

// terminalAuth implements auth.UserAuthenticator for interactive first-run login.
type terminalAuth struct {
	phone string
}

func (a terminalAuth) Phone(_ context.Context) (string, error) {
	if a.phone != "" {
		return a.phone, nil
	}
	fmt.Print("Phone number (international format, e.g. +15551234567): ")
	s, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(s), nil
}

func (terminalAuth) Code(_ context.Context, _ *tg.AuthSentCode) (string, error) {
	fmt.Print("Login code: ")
	s, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(s), nil
}

func (terminalAuth) Password(_ context.Context) (string, error) {
	fmt.Print("2FA password: ")
	b, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func (terminalAuth) SignUp(_ context.Context) (auth.UserInfo, error) {
	return auth.UserInfo{}, fmt.Errorf("sign up not implemented")
}

func (terminalAuth) AcceptTermsOfService(_ context.Context, tos tg.HelpTermsOfService) error {
	return &auth.SignUpRequired{TermsOfService: tos}
}

// newClient creates a gotd client with file-backed session storage.
// On first run (no session file), the caller must run auth.Flow inside
// client.Run to log in interactively.
func newClient(env *Env, sessionPath string) *telegram.Client {
	return telegram.NewClient(env.APIID, env.APIHash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: sessionPath},
	})
}

// authenticate runs the auth flow if the stored session is missing or invalid.
// Must be called inside client.Run.
func authenticate(ctx context.Context, client *telegram.Client, env *Env) error {
	status, err := client.Auth().Status(ctx)
	if err != nil {
		return fmt.Errorf("auth status: %w", err)
	}
	if status.Authorized {
		return nil
	}
	fmt.Fprintln(os.Stderr, "No valid session — starting interactive login.")
	flow := auth.NewFlow(terminalAuth{}, auth.SendCodeOptions{})
	if err := client.Auth().IfNecessary(ctx, flow); err != nil {
		return fmt.Errorf("auth flow: %w", err)
	}
	fmt.Fprintln(os.Stderr, "Login successful. Session cached to e2e/.session.json.")
	return nil
}
