package lsp

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
)

func TestRealLanguageServers(t *testing.T) {
	requested := strings.TrimSpace(os.Getenv("COHUB_LSP_INTEGRATION"))
	if requested == "" {
		t.Skip("set COHUB_LSP_INTEGRATION=typescript,go,python to run real language servers")
	}

	workspace := t.TempDir()
	fixtures := map[Language]struct {
		path    string
		content string
	}{
		LanguageTypeScript: {path: "main.ts", content: "const answer: string = 42;\n"},
		LanguageGo:         {path: "main.go", content: "package main\nfunc broken( {\n"},
		LanguagePython:     {path: "main.py", content: "answer: str = 42\n"},
	}
	if err := os.WriteFile(filepath.Join(workspace, "go.mod"), []byte("module example.com/lspfixture\n\ngo 1.24\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewManager(env.Config{
		SpaceID:             "lsp-integration",
		LSPRequestTimeoutMS: 30_000,
		LSPIdleTimeoutSecs:  60,
		LSPMaxMessageBytes:  4 * 1024 * 1024,
	}, process.NewManager(logger), logger)
	defer manager.Close()
	policy := NewReadPolicy(workspace)

	for _, rawLanguage := range strings.Split(requested, ",") {
		language := Language(strings.TrimSpace(rawLanguage))
		fixture, ok := fixtures[language]
		if !ok {
			t.Fatalf("unsupported integration language %q", rawLanguage)
		}
		t.Run(string(language), func(t *testing.T) {
			path := filepath.Join(workspace, fixture.path)
			original := []byte(fixture.content)
			if err := os.WriteFile(path, original, 0o644); err != nil {
				t.Fatal(err)
			}
			result, err := manager.Query("integration-owner", policy, Query{
				Action:    ActionDiagnostics,
				Language:  language,
				Path:      path,
				TimeoutMS: 30_000,
			})
			if err != nil {
				t.Fatalf("diagnostics: %v", err)
			}
			if !result.Available || len(result.Diagnostics) == 0 {
				t.Fatalf("result = %#v, want at least one diagnostic", result)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(original) {
				t.Fatal("language server changed the source file")
			}
		})
	}
}
