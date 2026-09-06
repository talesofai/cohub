package locald

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Config struct {
	DataDir       string
	SocketPath    string
	APIBaseURL    string
	DeviceID      string
	AccessToken   string
	RefreshToken  string
	PollInterval  time.Duration
	HTTPTimeout   time.Duration
	DaemonVersion string
}

func DefaultSocketPath(dataDir string) string {
	if runtime.GOOS == "windows" {
		return `\\.\pipe\cohub-locald-v1`
	}
	return filepath.Join(dataDir, "locald.sock")
}

func ConfigFromEnvironment(dataDir string) Config {
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	return Config{
		DataDir:       dataDir,
		SocketPath:    strings.TrimSpace(os.Getenv("COHUB_LOCALD_SOCKET")),
		APIBaseURL:    strings.TrimRight(strings.TrimSpace(os.Getenv("COHUB_API_URL")), "/"),
		DeviceID:      strings.TrimSpace(os.Getenv("COHUB_LOCAL_AGENT_DEVICE_ID")),
		AccessToken:   strings.TrimSpace(os.Getenv("COHUB_LOCAL_AGENT_ACCESS_TOKEN")),
		RefreshToken:  strings.TrimSpace(os.Getenv("COHUB_LOCAL_AGENT_REFRESH_TOKEN")),
		PollInterval:  5 * time.Second,
		HTTPTimeout:   10 * time.Second,
		DaemonVersion: strings.TrimSpace(os.Getenv("COHUB_LOCALD_VERSION")),
	}
}

func (c Config) normalize() Config {
	if c.DataDir == "" {
		c.DataDir = DefaultDataDir()
	}
	if c.SocketPath == "" {
		c.SocketPath = DefaultSocketPath(c.DataDir)
	}
	if c.PollInterval <= 0 {
		c.PollInterval = 5 * time.Second
	}
	if c.HTTPTimeout <= 0 {
		c.HTTPTimeout = 10 * time.Second
	}
	return c
}
