package env

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type FilesystemRoot struct {
	Path     string
	Writable bool
	Label    string
}

const (
	DefaultSandboxWSHost       = "0.0.0.0"
	DefaultSandboxWSPort       = 8788
	DefaultHeartbeatSecs       = 5
	LSPTypeScriptExecutableEnv = "LSP_TYPESCRIPT_EXECUTABLE"
	LSPTypeScriptTsserverEnv   = "LSP_TYPESCRIPT_TSSERVER_PATH"
	LSPGoExecutableEnv         = "LSP_GO_EXECUTABLE"
	LSPPythonExecutableEnv     = "LSP_PYTHON_EXECUTABLE"
	LSPRequestTimeoutMSEnv     = "LSP_REQUEST_TIMEOUT_MS"
	LSPIdleTimeoutSecsEnv      = "LSP_IDLE_TIMEOUT_SECS"
	LSPMaxMessageBytesEnv      = "LSP_MAX_MESSAGE_BYTES"
)

// Mode selects how the sandbox exposes itself.
//   - ModeListen: cloud sandbox; accepts inbound websocket connections (default).
//   - ModeLocal:  local sandbox; dials out to the gateway relay and fences all
//     filesystem/process access inside WorkspaceDir.
const (
	ModeListen = "listen"
	ModeLocal  = "local"
)

type Config struct {
	SpaceID                        string
	Mode                           string
	WorkspaceDir                   string
	PlatformAgentsDir              string
	UserAgentsDir                  string
	ImageVersion                   string
	InternalAPIBaseURL             string
	SandboxReportToken             string
	PublicURLPrefix                string
	PodIP                          string
	PublicPorts                    []int
	LSPTypeScriptExecutable        string
	LSPTypeScriptTsserverPath      string
	LSPGoExecutable                string
	LSPPythonExecutable            string
	LSPRequestTimeoutMS            int
	LSPIdleTimeoutSecs             int
	LSPMaxMessageBytes             int
	ZombieSelfHealThreshold        int
	ZombieSelfHealConsecutiveTicks int

	// Local mode only. RelayURL is the gateway control endpoint the sandbox
	// dials out to; RelayToken is the user's access token used to authorize the
	// space binding. Fence, when true, restricts all path access to WorkspaceDir.
	RelayURL   string
	RelayToken string
	Fence      bool
}

// IsLocal reports whether the sandbox runs in local dial-out mode.
func (c Config) IsLocal() bool { return c.Mode == ModeLocal }

func Load() (Config, error) {
	spaceID := strings.TrimSpace(os.Getenv("COHUB_SPACE_ID"))
	if spaceID == "" {
		return Config{}, fmt.Errorf("COHUB_SPACE_ID is required")
	}

	workspaceDir := strings.TrimSpace(os.Getenv("WORKSPACE_DIR"))
	if workspaceDir == "" {
		workspaceDir = "/workspace"
	}
	workspaceDir = filepath.Clean(workspaceDir)

	platformAgentsDir := strings.TrimSpace(os.Getenv("PLATFORM_AGENTS_DIR"))
	if platformAgentsDir == "" {
		platformAgentsDir = "/configs/platform/.agents"
	}
	platformAgentsDir = filepath.Clean(platformAgentsDir)

	userAgentsDir := strings.TrimSpace(os.Getenv("USER_AGENTS_DIR"))
	if userAgentsDir == "" {
		userAgentsDir = "/configs/user/.agents"
	}
	userAgentsDir = filepath.Clean(userAgentsDir)

	imageVersion := strings.TrimSpace(os.Getenv("IMAGE_VERSION"))
	if imageVersion == "" {
		imageVersion = "sandbox:dev"
	}

	return Config{
		SpaceID:                        spaceID,
		Mode:                           ModeListen,
		WorkspaceDir:                   workspaceDir,
		PlatformAgentsDir:              platformAgentsDir,
		UserAgentsDir:                  userAgentsDir,
		ImageVersion:                   imageVersion,
		InternalAPIBaseURL:             strings.TrimSpace(os.Getenv("INTERNAL_API_BASE_URL")),
		SandboxReportToken:             strings.TrimSpace(os.Getenv("SANDBOX_REPORT_TOKEN")),
		PublicURLPrefix:                strings.TrimSpace(os.Getenv("PUBLIC_URL_PREFIX")),
		PodIP:                          strings.TrimSpace(os.Getenv("POD_IP")),
		PublicPorts:                    parsePortsEnv("COHUB_PUBLIC_PORTS", []int{3000, 5173}),
		LSPTypeScriptExecutable:        stringEnv(LSPTypeScriptExecutableEnv, "typescript-language-server"),
		LSPTypeScriptTsserverPath:      strings.TrimSpace(os.Getenv(LSPTypeScriptTsserverEnv)),
		LSPGoExecutable:                stringEnv(LSPGoExecutableEnv, "gopls"),
		LSPPythonExecutable:            stringEnv(LSPPythonExecutableEnv, "basedpyright-langserver"),
		LSPRequestTimeoutMS:            parseBoundedIntEnv(LSPRequestTimeoutMSEnv, 5_000, 250, 60_000),
		LSPIdleTimeoutSecs:             parseBoundedIntEnv(LSPIdleTimeoutSecsEnv, 300, 5, 3_600),
		LSPMaxMessageBytes:             parseBoundedIntEnv(LSPMaxMessageBytesEnv, 4*1024*1024, 64*1024, 16*1024*1024),
		ZombieSelfHealThreshold:        parseIntEnv("ZOMBIE_SELF_HEAL_THRESHOLD", 0),
		ZombieSelfHealConsecutiveTicks: parseIntEnv("ZOMBIE_SELF_HEAL_CONSECUTIVE_TICKS", 3),
	}, nil
}

// LocalOptions carries the flag values for local dial-out mode.
type LocalOptions struct {
	SpaceID    string
	RootDir    string
	RelayURL   string
	RelayToken string
}

// LoadLocal builds a Config for local dial-out mode. The workspace is the
// user-chosen directory and all access is fenced inside it. Platform/user
// agents dirs point at a per-space cache under the user's home directory so
// skills can be materialized later without touching the workspace.
func LoadLocal(opts LocalOptions) (Config, error) {
	if strings.TrimSpace(opts.SpaceID) == "" {
		return Config{}, fmt.Errorf("space id is required")
	}
	if strings.TrimSpace(opts.RelayURL) == "" {
		return Config{}, fmt.Errorf("relay url is required")
	}
	if strings.TrimSpace(opts.RelayToken) == "" {
		return Config{}, fmt.Errorf("relay token is required")
	}

	rootDir := strings.TrimSpace(opts.RootDir)
	if rootDir == "" {
		return Config{}, fmt.Errorf("root dir is required")
	}
	absRoot, err := filepath.Abs(rootDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve root dir: %w", err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return Config{}, fmt.Errorf("root dir does not exist: %w", err)
	}
	info, err := os.Stat(resolvedRoot)
	if err != nil || !info.IsDir() {
		return Config{}, fmt.Errorf("root dir is not a directory: %s", resolvedRoot)
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home dir: %w", err)
	}
	cacheDir := filepath.Join(homeDir, ".cache", "cohub", "spaces", opts.SpaceID)

	imageVersion := strings.TrimSpace(os.Getenv("IMAGE_VERSION"))
	if imageVersion == "" {
		imageVersion = "sandboxd:dev"
	}

	return Config{
		SpaceID:                   opts.SpaceID,
		Mode:                      ModeLocal,
		WorkspaceDir:              resolvedRoot,
		PlatformAgentsDir:         filepath.Join(cacheDir, "platform-agents"),
		UserAgentsDir:             filepath.Join(cacheDir, "user-agents"),
		ImageVersion:              imageVersion,
		PublicPorts:               parsePortsEnv("COHUB_PUBLIC_PORTS", []int{3000, 5173}),
		LSPTypeScriptExecutable:   stringEnv(LSPTypeScriptExecutableEnv, "typescript-language-server"),
		LSPTypeScriptTsserverPath: strings.TrimSpace(os.Getenv(LSPTypeScriptTsserverEnv)),
		LSPGoExecutable:           stringEnv(LSPGoExecutableEnv, "gopls"),
		LSPPythonExecutable:       stringEnv(LSPPythonExecutableEnv, "basedpyright-langserver"),
		LSPRequestTimeoutMS:       parseBoundedIntEnv(LSPRequestTimeoutMSEnv, 5_000, 250, 60_000),
		LSPIdleTimeoutSecs:        parseBoundedIntEnv(LSPIdleTimeoutSecsEnv, 300, 5, 3_600),
		LSPMaxMessageBytes:        parseBoundedIntEnv(LSPMaxMessageBytesEnv, 4*1024*1024, 64*1024, 16*1024*1024),
		RelayURL:                  strings.TrimSpace(opts.RelayURL),
		RelayToken:                strings.TrimSpace(opts.RelayToken),
		Fence:                     true,
	}, nil
}

func stringEnv(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}

func parseBoundedIntEnv(name string, defaultValue int, minimum int, maximum int) int {
	value := parseIntEnv(name, defaultValue)
	if value < minimum || value > maximum {
		return defaultValue
	}
	return value
}

func parseIntEnv(name string, defaultValue int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return defaultValue
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return defaultValue
	}
	if value < 0 {
		return 0
	}
	return value
}

func parsePortsEnv(name string, defaultValue []int) []int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return append([]int(nil), defaultValue...)
	}
	seen := map[int]struct{}{}
	ports := []int{}
	for _, part := range strings.Split(raw, ",") {
		port, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || port <= 0 || port > 65535 {
			continue
		}
		if _, ok := seen[port]; ok {
			continue
		}
		seen[port] = struct{}{}
		ports = append(ports, port)
	}
	if len(ports) == 0 {
		return append([]int(nil), defaultValue...)
	}
	return ports
}

func (c Config) FilesystemRoots() []FilesystemRoot {
	return []FilesystemRoot{
		{Path: c.WorkspaceDir, Writable: true, Label: "cwd"},
		{Path: c.PlatformAgentsDir, Writable: false, Label: "platform-agents"},
		{Path: c.UserAgentsDir, Writable: false, Label: "user-agents"},
		{Path: "/sessions", Writable: false, Label: "sessions"},
		{Path: "/tmp", Writable: true, Label: "tmp"},
	}
}
