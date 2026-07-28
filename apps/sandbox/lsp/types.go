package lsp

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

type Language string

const (
	LanguageTypeScript Language = "typescript"
	LanguageGo         Language = "go"
	LanguagePython     Language = "python"
)

type Action string

const (
	ActionStatus      Action = "status"
	ActionDiagnostics Action = "diagnostics"
	ActionDefinition  Action = "definition"
	ActionReferences  Action = "references"
	ActionHover       Action = "hover"
	ActionSymbols     Action = "symbols"
)

type SymbolScope string

const (
	SymbolScopeDocument  SymbolScope = "document"
	SymbolScopeWorkspace SymbolScope = "workspace"
)

type Query struct {
	Action      Action
	Language    Language
	Path        string
	Line        int
	Character   int
	SymbolScope SymbolScope
	Search      string
	Limit       int
	TimeoutMS   int
}

type Position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type Range struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

type Diagnostic struct {
	Range    Range       `json:"range"`
	Severity int         `json:"severity,omitempty"`
	Code     interface{} `json:"code,omitempty"`
	Source   string      `json:"source,omitempty"`
	Message  string      `json:"message"`
}

type Location struct {
	Path  string `json:"path"`
	Range Range  `json:"range"`
}

type Hover struct {
	Text  string `json:"text"`
	Range *Range `json:"range,omitempty"`
}

type Symbol struct {
	Name          string   `json:"name"`
	Kind          int      `json:"kind"`
	ContainerName string   `json:"containerName,omitempty"`
	Path          string   `json:"path,omitempty"`
	Range         Range    `json:"range"`
	Selection     *Range   `json:"selectionRange,omitempty"`
	Children      []Symbol `json:"children,omitempty"`
}

type ServerStatus struct {
	Language   Language `json:"language"`
	Available  bool     `json:"available"`
	Active     bool     `json:"active"`
	Executable string   `json:"executable,omitempty"`
	Version    string   `json:"version,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type QueryResult struct {
	Action      Action         `json:"action"`
	Language    Language       `json:"language,omitempty"`
	Server      string         `json:"server,omitempty"`
	Available   bool           `json:"available"`
	Active      bool           `json:"active,omitempty"`
	Status      []ServerStatus `json:"status,omitempty"`
	Diagnostics []Diagnostic   `json:"diagnostics,omitempty"`
	Locations   []Location     `json:"locations,omitempty"`
	Hover       *Hover         `json:"hover,omitempty"`
	Symbols     []Symbol       `json:"symbols,omitempty"`
	Total       int            `json:"total,omitempty"`
	Returned    int            `json:"returned,omitempty"`
	Truncated   bool           `json:"truncated,omitempty"`
	DurationMS  int64          `json:"durationMs"`
}

type ErrorCode string

const (
	ErrorUnavailable ErrorCode = "LSP_UNAVAILABLE"
	ErrorStartFailed ErrorCode = "LSP_START_FAILED"
	ErrorProtocol    ErrorCode = "LSP_PROTOCOL_ERROR"
	ErrorTimeout     ErrorCode = "TIMEOUT"
	ErrorInvalid     ErrorCode = "BAD_REQUEST"
	ErrorAccess      ErrorCode = "ACCESS_DENIED"
	ErrorNotFound    ErrorCode = "NOT_FOUND"
)

type Error struct {
	Code ErrorCode
	Err  error
}

func (e *Error) Error() string {
	if e == nil || e.Err == nil {
		return string(e.Code)
	}
	return e.Err.Error()
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func detectLanguage(path string, explicit Language) (Language, error) {
	if IsSupportedLanguage(explicit) {
		return explicit, nil
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts":
		return LanguageTypeScript, nil
	case ".go":
		return LanguageGo, nil
	case ".py", ".pyi":
		return LanguagePython, nil
	default:
		return "", &Error{Code: ErrorInvalid, Err: fmt.Errorf("cannot detect LSP language from path %q", path)}
	}
}

func IsSupportedLanguage(language Language) bool {
	switch language {
	case LanguageTypeScript, LanguageGo, LanguagePython:
		return true
	default:
		return false
	}
}

func pathToURI(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}

func uriToPath(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "file" {
		return value
	}
	return filepath.FromSlash(parsed.Path)
}

func clampLimit(value int) int {
	if value <= 0 {
		return 100
	}
	if value > 500 {
		return 500
	}
	return value
}

func normalizeLocations(raw json.RawMessage, limit int) ([]Location, int, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, 0, false, nil
	}
	type rawLocation struct {
		URI         string `json:"uri"`
		TargetURI   string `json:"targetUri"`
		Range       Range  `json:"range"`
		TargetRange Range  `json:"targetRange"`
	}
	var values []rawLocation
	if raw[0] == '[' {
		if err := json.Unmarshal(raw, &values); err != nil {
			return nil, 0, false, err
		}
	} else {
		var value rawLocation
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, 0, false, err
		}
		values = []rawLocation{value}
	}
	total := len(values)
	limit = clampLimit(limit)
	if len(values) > limit {
		values = values[:limit]
	}
	out := make([]Location, 0, len(values))
	for _, value := range values {
		uri := value.URI
		rng := value.Range
		if uri == "" {
			uri = value.TargetURI
			rng = value.TargetRange
		}
		out = append(out, Location{Path: uriToPath(uri), Range: rng})
	}
	return out, total, total > len(out), nil
}

func normalizeHover(raw json.RawMessage) (*Hover, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var payload struct {
		Contents interface{} `json:"contents"`
		Range    *Range      `json:"range"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return &Hover{Text: flattenMarkup(payload.Contents), Range: payload.Range}, nil
}

func flattenMarkup(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []interface{}:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if text := strings.TrimSpace(flattenMarkup(item)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	case map[string]interface{}:
		if text, ok := typed["value"].(string); ok {
			return text
		}
		if text, ok := typed["language"].(string); ok {
			return text
		}
	}
	return ""
}

func normalizeSymbols(raw json.RawMessage, limit int) ([]Symbol, int, bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, 0, false, nil
	}
	type rawSymbol struct {
		Name          string `json:"name"`
		Kind          int    `json:"kind"`
		ContainerName string `json:"containerName"`
		URI           string `json:"uri"`
		Range         Range  `json:"range"`
		Selection     *Range `json:"selectionRange"`
		Location      *struct {
			URI   string `json:"uri"`
			Range Range  `json:"range"`
		} `json:"location"`
		Children []rawSymbol `json:"children"`
	}
	var values []rawSymbol
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, 0, false, err
	}
	var countRawSymbols func([]rawSymbol) int
	countRawSymbols = func(items []rawSymbol) int {
		total := 0
		for _, item := range items {
			total += 1 + countRawSymbols(item.Children)
		}
		return total
	}
	total := countRawSymbols(values)
	remaining := clampLimit(limit)
	var convert func([]rawSymbol) []Symbol
	convert = func(items []rawSymbol) []Symbol {
		converted := make([]Symbol, 0, min(len(items), remaining))
		for _, item := range items {
			if remaining == 0 {
				break
			}
			remaining--
			path := uriToPath(item.URI)
			rng := item.Range
			if item.Location != nil {
				path = uriToPath(item.Location.URI)
				rng = item.Location.Range
			}
			symbol := Symbol{
				Name:          item.Name,
				Kind:          item.Kind,
				ContainerName: item.ContainerName,
				Path:          path,
				Range:         rng,
				Selection:     item.Selection,
			}
			symbol.Children = convert(item.Children)
			converted = append(converted, symbol)
		}
		return converted
	}
	out := convert(values)
	return out, total, total > countSymbols(out), nil
}

func countSymbols(symbols []Symbol) int {
	count := 0
	for _, symbol := range symbols {
		count += 1 + countSymbols(symbol.Children)
	}
	return count
}
