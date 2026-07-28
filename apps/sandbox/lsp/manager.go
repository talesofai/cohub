package lsp

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/cohub/apps/sandbox/env"
	"github.com/cohub/apps/sandbox/process"
)

type ServerConfig struct {
	Language              Language
	Executable            string
	Args                  []string
	VersionExecutable     string
	VersionArgs           []string
	Env                   map[string]string
	InitializationOptions map[string]interface{}
}

type ManagerConfig struct {
	Servers         map[Language]ServerConfig
	RequestTimeout  time.Duration
	IdleTimeout     time.Duration
	MaxMessageBytes int
	StateRoot       string
}

type Manager struct {
	cfg            ManagerConfig
	processManager *process.Manager
	logger         *slog.Logger

	mu      sync.Mutex
	clients map[string]*client
	stop    chan struct{}
}

func NewManager(cfg env.Config, processManager *process.Manager, logger *slog.Logger) *Manager {
	requestTimeout := time.Duration(cfg.LSPRequestTimeoutMS) * time.Millisecond
	if requestTimeout <= 0 {
		requestTimeout = 5 * time.Second
	}
	idleTimeout := time.Duration(cfg.LSPIdleTimeoutSecs) * time.Second
	if idleTimeout <= 0 {
		idleTimeout = 5 * time.Minute
	}
	maxMessageBytes := cfg.LSPMaxMessageBytes
	if maxMessageBytes <= 0 {
		maxMessageBytes = defaultMaxMessageBytes
	}
	return NewManagerWithConfig(ManagerConfig{
		Servers: map[Language]ServerConfig{
			LanguageTypeScript: {
				Language:              LanguageTypeScript,
				Executable:            firstNonEmpty(cfg.LSPTypeScriptExecutable, "typescript-language-server"),
				Args:                  []string{"--stdio"},
				VersionArgs:           []string{"--version"},
				InitializationOptions: typescriptInitializationOptions(cfg.LSPTypeScriptTsserverPath),
			},
			LanguageGo: {
				Language:    LanguageGo,
				Executable:  firstNonEmpty(cfg.LSPGoExecutable, "gopls"),
				VersionArgs: []string{"version"},
			},
			LanguagePython: {
				Language:          LanguagePython,
				Executable:        firstNonEmpty(cfg.LSPPythonExecutable, "basedpyright-langserver"),
				Args:              []string{"--stdio"},
				VersionExecutable: basedPyrightVersionExecutable(cfg.LSPPythonExecutable),
				VersionArgs:       []string{"--version"},
			},
		},
		RequestTimeout:  requestTimeout,
		IdleTimeout:     idleTimeout,
		MaxMessageBytes: maxMessageBytes,
		StateRoot:       filepath.Join(os.TempDir(), "cohub-lsp", cfg.SpaceID),
	}, processManager, logger)
}

func NewManagerWithConfig(cfg ManagerConfig, processManager *process.Manager, logger *slog.Logger) *Manager {
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = 5 * time.Second
	}
	if cfg.IdleTimeout <= 0 {
		cfg.IdleTimeout = 5 * time.Minute
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = defaultMaxMessageBytes
	}
	if strings.TrimSpace(cfg.StateRoot) == "" {
		cfg.StateRoot = filepath.Join(os.TempDir(), "cohub-lsp")
	}
	manager := &Manager{
		cfg:            cfg,
		processManager: processManager,
		logger:         logger,
		clients:        make(map[string]*client),
		stop:           make(chan struct{}),
	}
	go manager.idleLoop()
	return manager
}

func (m *Manager) Query(ownerIdentity string, policy ReadPolicy, query Query) (QueryResult, error) {
	startedAt := time.Now()
	if query.Action == ActionStatus {
		status := m.Status(ownerIdentity, query.Language)
		return QueryResult{
			Action:     ActionStatus,
			Language:   query.Language,
			Available:  anyAvailable(status),
			Status:     status,
			DurationMS: time.Since(startedAt).Milliseconds(),
		}, nil
	}
	language, err := detectLanguage(query.Path, query.Language)
	if err != nil {
		return QueryResult{}, err
	}
	query.Language = language
	if !policy.CanRead(query.Path) {
		return QueryResult{}, &Error{Code: ErrorAccess, Err: fmt.Errorf("LSP read denied outside the current Space: %s", query.Path)}
	}
	if _, err := os.Stat(query.Path); err != nil {
		if os.IsNotExist(err) {
			return QueryResult{}, &Error{Code: ErrorNotFound, Err: err}
		}
		return QueryResult{}, &Error{Code: ErrorProtocol, Err: err}
	}
	root, err := workspaceRootFor(query.Path, policy)
	if err != nil {
		return QueryResult{}, err
	}
	server, ok := m.cfg.Servers[language]
	if !ok {
		return QueryResult{}, &Error{Code: ErrorUnavailable, Err: fmt.Errorf("no LSP server configured for %s", language)}
	}
	serverName := server.Executable
	server, err = resolveServerCommand(server)
	if err != nil {
		return QueryResult{}, &Error{Code: ErrorUnavailable, Err: fmt.Errorf("%s language server is unavailable: %w", language, err)}
	}

	requestTimeout := m.cfg.RequestTimeout
	if query.TimeoutMS > 0 {
		requestTimeout = time.Duration(query.TimeoutMS) * time.Millisecond
		if requestTimeout < 250*time.Millisecond {
			requestTimeout = 250 * time.Millisecond
		}
		if requestTimeout > 60*time.Second {
			requestTimeout = 60 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()

	languageClient, err := m.getOrCreateClient(ctx, ownerIdentity, root, server)
	if err != nil {
		return QueryResult{}, err
	}
	uri, minimumDiagnosticVersion, err := languageClient.ensureOpen(query.Path)
	if err != nil {
		return QueryResult{}, classifyClientError(err)
	}

	result := QueryResult{
		Action:     query.Action,
		Language:   language,
		Server:     filepath.Base(serverName),
		Available:  true,
		Active:     true,
		DurationMS: 0,
	}
	positionParams := map[string]interface{}{
		"textDocument": map[string]string{"uri": uri},
		"position": Position{
			Line:      max(query.Line, 0),
			Character: max(query.Character, 0),
		},
	}
	limit := clampLimit(query.Limit)

	switch query.Action {
	case ActionDiagnostics:
		diagnostics, err := languageClient.waitDiagnostics(ctx, uri, minimumDiagnosticVersion)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return QueryResult{}, classifyClientError(err)
		}
		result.Total = len(diagnostics)
		if len(diagnostics) > limit {
			diagnostics = diagnostics[:limit]
			result.Truncated = true
		}
		result.Diagnostics = diagnostics
		result.Returned = len(diagnostics)
	case ActionDefinition:
		var raw json.RawMessage
		if err := languageClient.request(ctx, "textDocument/definition", positionParams, &raw); err != nil {
			return QueryResult{}, classifyClientError(err)
		}
		locations, total, truncated, err := normalizeLocations(raw, limit)
		if err != nil {
			return QueryResult{}, &Error{Code: ErrorProtocol, Err: err}
		}
		result.Locations, result.Total, result.Returned, result.Truncated = locations, total, len(locations), truncated
	case ActionReferences:
		positionParams["context"] = map[string]bool{"includeDeclaration": true}
		var raw json.RawMessage
		if err := languageClient.request(ctx, "textDocument/references", positionParams, &raw); err != nil {
			return QueryResult{}, classifyClientError(err)
		}
		locations, total, truncated, err := normalizeLocations(raw, limit)
		if err != nil {
			return QueryResult{}, &Error{Code: ErrorProtocol, Err: err}
		}
		result.Locations, result.Total, result.Returned, result.Truncated = locations, total, len(locations), truncated
	case ActionHover:
		var raw json.RawMessage
		if err := languageClient.request(ctx, "textDocument/hover", positionParams, &raw); err != nil {
			return QueryResult{}, classifyClientError(err)
		}
		hover, err := normalizeHover(raw)
		if err != nil {
			return QueryResult{}, &Error{Code: ErrorProtocol, Err: err}
		}
		result.Hover = hover
		if hover != nil {
			result.Total, result.Returned = 1, 1
		}
	case ActionSymbols:
		var raw json.RawMessage
		method := "textDocument/documentSymbol"
		params := interface{}(map[string]interface{}{"textDocument": map[string]string{"uri": uri}})
		if query.SymbolScope == SymbolScopeWorkspace {
			method = "workspace/symbol"
			params = map[string]string{"query": query.Search}
		}
		if err := languageClient.request(ctx, method, params, &raw); err != nil {
			return QueryResult{}, classifyClientError(err)
		}
		symbols, total, truncated, err := normalizeSymbols(raw, limit)
		if err != nil {
			return QueryResult{}, &Error{Code: ErrorProtocol, Err: err}
		}
		result.Symbols, result.Total, result.Returned, result.Truncated = symbols, total, countSymbols(symbols), truncated
	default:
		return QueryResult{}, &Error{Code: ErrorInvalid, Err: fmt.Errorf("unsupported LSP action %q", query.Action)}
	}
	result.DurationMS = time.Since(startedAt).Milliseconds()
	return result, nil
}

func (m *Manager) Status(ownerIdentity string, requested Language) []ServerStatus {
	languages := []Language{LanguageTypeScript, LanguageGo, LanguagePython}
	if IsSupportedLanguage(requested) {
		languages = []Language{requested}
	}
	statuses := make([]ServerStatus, 0, len(languages))
	for _, language := range languages {
		server, ok := m.cfg.Servers[language]
		status := ServerStatus{Language: language}
		if !ok {
			status.Error = "not configured"
			statuses = append(statuses, status)
			continue
		}
		resolved, err := resolveServerCommand(server)
		if err != nil {
			status.Error = err.Error()
			statuses = append(statuses, status)
			continue
		}
		status.Available = true
		status.Executable = filepath.Base(server.Executable)
		status.Active = m.hasActiveLanguage(language)
		if version, err := m.detectVersion(ownerIdentity, resolved); err == nil {
			status.Version = version
		} else {
			status.Error = err.Error()
		}
		statuses = append(statuses, status)
	}
	return statuses
}

func (m *Manager) detectVersion(ownerIdentity string, server ServerConfig) (string, error) {
	if len(server.VersionArgs) == 0 {
		return "", nil
	}
	stateDir, processEnv, err := m.protocolState(ownerIdentity, server.Language, "version")
	if err != nil {
		return "", err
	}
	mergeTrustedEnv(processEnv, server.Env)
	versionExecutable := firstNonEmpty(server.VersionExecutable, server.Executable)
	started, err := m.processManager.StartProtocol(ownerIdentity, versionExecutable, server.VersionArgs, stateDir, 3, processEnv)
	if err != nil {
		return "", err
	}
	_ = started.Stdin.Close()
	output, _ := io.ReadAll(io.LimitReader(io.MultiReader(started.Stdout, started.Stderr), 8*1024))
	exit := <-started.Exit
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		return "", fmt.Errorf("version command failed: %s", strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func (m *Manager) getOrCreateClient(ctx context.Context, ownerIdentity string, root string, server ServerConfig) (*client, error) {
	key := clientKey(ownerIdentity, root, server.Language)
	m.mu.Lock()
	existing := m.clients[key]
	if existing != nil && existing.isAlive() {
		existing.touch()
		m.mu.Unlock()
		return existing, nil
	}
	delete(m.clients, key)
	m.mu.Unlock()

	stateDir, processEnv, err := m.protocolState(ownerIdentity, server.Language, root)
	if err != nil {
		return nil, &Error{Code: ErrorStartFailed, Err: err}
	}
	mergeTrustedEnv(processEnv, server.Env)
	started, err := m.processManager.StartProtocol(
		ownerIdentity,
		server.Executable,
		server.Args,
		root,
		0,
		processEnv,
	)
	if err != nil {
		return nil, &Error{Code: ErrorStartFailed, Err: fmt.Errorf("start %s language server: %w", server.Language, err)}
	}
	created, err := newClient(
		ctx,
		server.Language,
		server.Executable,
		root,
		started,
		m.cfg.MaxMessageBytes,
		m.logger,
		func() error { return m.processManager.Abort(started.ID) },
		server.InitializationOptions,
	)
	if err != nil {
		_ = m.processManager.Abort(started.ID)
		return nil, &Error{Code: ErrorStartFailed, Err: err}
	}
	_ = stateDir

	m.mu.Lock()
	if winner := m.clients[key]; winner != nil && winner.isAlive() {
		m.mu.Unlock()
		closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		created.close(closeCtx)
		cancel()
		return winner, nil
	}
	m.clients[key] = created
	m.mu.Unlock()
	return created, nil
}

func (m *Manager) protocolState(ownerIdentity string, language Language, scope string) (string, map[string]string, error) {
	stateDir := filepath.Join(m.cfg.StateRoot, safeComponent(ownerIdentity), safeComponent(string(language)), safeComponent(scope))
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", nil, err
	}
	if canonical, err := filepath.EvalSymlinks(stateDir); err == nil {
		stateDir = canonical
	}
	processEnv := map[string]string{
		"HOME":           stateDir,
		"TMPDIR":         stateDir,
		"XDG_CACHE_HOME": filepath.Join(stateDir, "cache"),
		"GOCACHE":        filepath.Join(stateDir, "go-build"),
		"GOMODCACHE":     filepath.Join(stateDir, "go-mod"),
	}
	for _, path := range processEnv {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return "", nil, err
		}
	}
	return stateDir, processEnv, nil
}

func (m *Manager) hasActiveLanguage(language Language) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, languageClient := range m.clients {
		if languageClient.language == language && languageClient.isAlive() {
			return true
		}
	}
	return false
}

func (m *Manager) CloseIdle(now time.Time) int {
	m.mu.Lock()
	closing := make([]*client, 0)
	for key, languageClient := range m.clients {
		if !languageClient.isAlive() || languageClient.idleFor(now) >= m.cfg.IdleTimeout {
			delete(m.clients, key)
			if languageClient.isAlive() {
				closing = append(closing, languageClient)
			}
		}
	}
	m.mu.Unlock()
	for _, languageClient := range closing {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		languageClient.close(ctx)
		cancel()
	}
	return len(closing)
}

func (m *Manager) Close() {
	select {
	case <-m.stop:
		return
	default:
		close(m.stop)
	}
	m.mu.Lock()
	closing := make([]*client, 0, len(m.clients))
	for _, languageClient := range m.clients {
		closing = append(closing, languageClient)
	}
	m.clients = make(map[string]*client)
	m.mu.Unlock()
	for _, languageClient := range closing {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		languageClient.close(ctx)
		cancel()
	}
}

func (m *Manager) idleLoop() {
	interval := m.cfg.IdleTimeout / 2
	if interval < time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			m.CloseIdle(now)
		case <-m.stop:
			return
		}
	}
}

func workspaceRootFor(path string, policy ReadPolicy) (string, error) {
	root, ok := policy.RootFor(path)
	if !ok {
		return "", &Error{Code: ErrorAccess, Err: fmt.Errorf("no readable LSP workspace root contains %s", path)}
	}
	return root, nil
}

func clientKey(ownerIdentity string, root string, language Language) string {
	return ownerIdentity + "\x00" + filepath.Clean(root) + "\x00" + string(language)
}

func classifyClientError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &Error{Code: ErrorTimeout, Err: err}
	}
	var typed *Error
	if errors.As(err, &typed) {
		return typed
	}
	return &Error{Code: ErrorProtocol, Err: err}
}

func anyAvailable(status []ServerStatus) bool {
	for _, item := range status {
		if item.Available {
			return true
		}
	}
	return false
}

func safeComponent(value string) string {
	original := strings.TrimSpace(value)
	if original == "" {
		return "default"
	}
	var builder strings.Builder
	for _, char := range original {
		switch {
		case char >= 'a' && char <= 'z':
			builder.WriteRune(char)
		case char >= 'A' && char <= 'Z':
			builder.WriteRune(char)
		case char >= '0' && char <= '9':
			builder.WriteRune(char)
		case char == '-', char == '_', char == '.':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
		if builder.Len() >= 48 {
			break
		}
	}
	if builder.Len() == 0 {
		builder.WriteString("value")
	}
	digest := sha256.Sum256([]byte(original))
	return fmt.Sprintf("%s-%x", builder.String(), digest[:6])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func typescriptInitializationOptions(configuredPath string) map[string]interface{} {
	tsserverPath := strings.TrimSpace(configuredPath)
	if tsserverPath == "" {
		if resolved, err := exec.LookPath("tsserver"); err == nil {
			tsserverPath = resolved
		}
	}
	if tsserverPath == "" {
		return nil
	}
	if filepath.Base(tsserverPath) != "tsserver.js" {
		nodeModulesRoot := filepath.Dir(filepath.Dir(tsserverPath))
		for _, packageName := range []string{"typescript-lsp", "typescript"} {
			candidate := filepath.Join(nodeModulesRoot, packageName, "lib", "tsserver.js")
			if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
				tsserverPath = candidate
				break
			}
		}
	}
	return map[string]interface{}{
		"tsserver": map[string]string{"path": tsserverPath},
	}
}

func mergeTrustedEnv(target map[string]string, values map[string]string) {
	for key, value := range values {
		target[key] = value
	}
}

func resolveServerCommand(server ServerConfig) (ServerConfig, error) {
	executable, err := exec.LookPath(server.Executable)
	if err != nil {
		return ServerConfig{}, err
	}
	server.Executable = executable
	versionExecutable := firstNonEmpty(server.VersionExecutable, server.Executable)
	if len(server.VersionArgs) > 0 {
		versionExecutable, err = exec.LookPath(versionExecutable)
		if err != nil {
			return ServerConfig{}, err
		}
		server.VersionExecutable = versionExecutable
	}
	if !isNodeLanguageServer(server.Language) {
		return server, nil
	}

	entrypoint := resolveNodeEntrypoint(executable, server.Language, false)
	if entrypoint == "" {
		return server, nil
	}
	nodeExecutable, err := exec.LookPath("node")
	if err != nil {
		return ServerConfig{}, fmt.Errorf("%s language server requires node: %w", server.Language, err)
	}
	server.Executable = nodeExecutable
	server.Args = append([]string{entrypoint}, server.Args...)
	if len(server.VersionArgs) > 0 {
		versionEntrypoint := resolveNodeEntrypoint(versionExecutable, server.Language, true)
		if versionEntrypoint == "" {
			return ServerConfig{}, fmt.Errorf("%s version command is not a trusted Node entrypoint", server.Language)
		}
		server.VersionExecutable = nodeExecutable
		server.VersionArgs = append([]string{versionEntrypoint}, server.VersionArgs...)
	}
	return server, nil
}

func basedPyrightVersionExecutable(languageServer string) string {
	executable := strings.TrimSpace(languageServer)
	if executable == "" {
		return "basedpyright"
	}
	if filepath.Base(executable) != "basedpyright-langserver" {
		return "basedpyright"
	}
	directory := filepath.Dir(executable)
	if directory == "." {
		return "basedpyright"
	}
	return filepath.Join(directory, "basedpyright")
}

func isNodeLanguageServer(language Language) bool {
	return language == LanguageTypeScript || language == LanguagePython
}

func resolveNodeEntrypoint(executable string, language Language, version bool) string {
	if resolved, err := filepath.EvalSymlinks(executable); err == nil && isNodeEntrypoint(resolved) {
		return resolved
	}
	if filepath.Base(filepath.Dir(executable)) != ".bin" {
		return ""
	}
	var relativePath string
	switch language {
	case LanguageTypeScript:
		relativePath = filepath.Join("typescript-language-server", "lib", "cli.mjs")
	case LanguagePython:
		if version {
			relativePath = filepath.Join("basedpyright", "index.js")
		} else {
			relativePath = filepath.Join("basedpyright", "langserver.index.js")
		}
	default:
		return ""
	}
	candidate := filepath.Clean(filepath.Join(filepath.Dir(executable), "..", relativePath))
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func isNodeEntrypoint(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".js", ".mjs", ".cjs":
		return true
	default:
		return false
	}
}
