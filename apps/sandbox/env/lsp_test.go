package env

import "testing"

func TestLoadLSPDefaultsAndBounds(t *testing.T) {
	t.Setenv("COHUB_SPACE_ID", "space-lsp")
	t.Setenv(LSPTypeScriptExecutableEnv, "")
	t.Setenv(LSPTypeScriptTsserverEnv, "/opt/typescript/lib/tsserver.js")
	t.Setenv(LSPRequestTimeoutMSEnv, "1")
	t.Setenv(LSPIdleTimeoutSecsEnv, "7200")
	t.Setenv(LSPMaxMessageBytesEnv, "1024")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LSPTypeScriptExecutable != "typescript-language-server" {
		t.Fatalf("TypeScript executable = %q", cfg.LSPTypeScriptExecutable)
	}
	if cfg.LSPTypeScriptTsserverPath != "/opt/typescript/lib/tsserver.js" {
		t.Fatalf("tsserver path = %q", cfg.LSPTypeScriptTsserverPath)
	}
	if cfg.LSPRequestTimeoutMS != 5_000 {
		t.Fatalf("request timeout = %d", cfg.LSPRequestTimeoutMS)
	}
	if cfg.LSPIdleTimeoutSecs != 300 {
		t.Fatalf("idle timeout = %d", cfg.LSPIdleTimeoutSecs)
	}
	if cfg.LSPMaxMessageBytes != 4*1024*1024 {
		t.Fatalf("max message bytes = %d", cfg.LSPMaxMessageBytes)
	}
}
