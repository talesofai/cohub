package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	defaultMaxEntries      = 2_000_000
	defaultMaxFileBytes    = int64(5 * 1024 * 1024 * 1024)
	defaultMaxSnapshotSize = int64(100 * 1024 * 1024 * 1024)
)

type ScanPolicy struct {
	PolicyVersion    int64    `json:"policyVersion"`
	DefaultExcludes  []string `json:"defaultExcludes,omitempty"`
	CustomExcludes   []string `json:"customExcludes,omitempty"`
	SensitiveMode    string   `json:"sensitiveContentMode,omitempty"`
	MaxEntries       int      `json:"maxEntries,omitempty"`
	MaxFileBytes     int64    `json:"maxFileBytes,omitempty"`
	MaxSnapshotBytes int64    `json:"maxSnapshotBytes,omitempty"`
}

type ScanWarning struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

type ScanBlob struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type ScanResult struct {
	Manifest       map[string]any
	ManifestBytes  []byte
	ManifestSHA256 string
	TreeHash       string
	Blobs          []ScanBlob
	Warnings       []ScanWarning
	IgnoredCount   int
}

type ScanError struct {
	Code  string
	Paths []string
	Err   error
}

func (e *ScanError) Error() string {
	if len(e.Paths) == 0 {
		return fmt.Sprintf("%s: %v", e.Code, e.Err)
	}
	return fmt.Sprintf("%s (%s): %v", e.Code, strings.Join(e.Paths, ", "), e.Err)
}

func (e *ScanError) Unwrap() error { return e.Err }

var sensitiveBasename = regexp.MustCompile(`(?i)^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks)|credentials?(\..*)?|secrets?(\..*)?|config\.json|auth\.json)$`)
var windowsReservedBasename = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)
var sensitivePath = regexp.MustCompile(`(?i)(^|/)(\.ssh|\.aws|\.config/gcloud|\.pi|\.codex|\.claude)(/|$)`)

func ScanWorkspace(root string, policy ScanPolicy) (ScanResult, error) {
	if policy.PolicyVersion < 1 {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: errors.New("policy version must be positive")}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	root = filepath.Clean(root)
	if policy.MaxEntries <= 0 {
		policy.MaxEntries = defaultMaxEntries
	}
	if policy.MaxFileBytes <= 0 {
		policy.MaxFileBytes = defaultMaxFileBytes
	}
	if policy.MaxSnapshotBytes <= 0 {
		policy.MaxSnapshotBytes = defaultMaxSnapshotSize
	}
	if policy.SensitiveMode == "" {
		policy.SensitiveMode = "exclude_with_warning"
	}
	if _, err := os.Stat(root); err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Paths: []string{"."}, Err: err}
	}

	patterns := append(append([]string{}, policy.DefaultExcludes...), policy.CustomExcludes...)
	compiledPatterns := make([]*regexp.Regexp, 0, len(patterns))
	for _, pattern := range patterns {
		pattern = strings.TrimSpace(pattern)
		if pattern == "" {
			continue
		}
		// The server validates the canonical policy. Locald uses a deliberately
		// small, deterministic glob translation for early filtering; an unknown
		// pattern is ignored as a policy error rather than used to hide files.
		compiled, compileErr := globRegexp(pattern)
		if compileErr != nil {
			return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: fmt.Errorf("invalid exclude pattern %q: %w", pattern, compileErr)}
		}
		compiledPatterns = append(compiledPatterns, compiled)
	}

	entries := make([]map[string]any, 0, 1024)
	blobs := make([]ScanBlob, 0, 1024)
	warnings := make([]ScanWarning, 0)
	ignoredCount := 0
	var totalBytes int64

	walkErr := filepath.WalkDir(root, func(path string, dirEntry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			rel, _ := filepath.Rel(root, path)
			return &ScanError{Code: "scan_incomplete", Paths: []string{slashPath(rel)}, Err: walkErr}
		}
		if path == root {
			return nil
		}
		relRaw, err := filepath.Rel(root, path)
		if err != nil {
			return &ScanError{Code: "scan_incomplete", Err: err}
		}
		rel, err := normalizePath(relRaw)
		if err != nil {
			return &ScanError{Code: "path_unsupported", Paths: []string{slashPath(relRaw)}, Err: err}
		}
		isDir := dirEntry.IsDir()
		if hardExcluded(rel) || matchesPattern(compiledPatterns, rel, isDir) {
			ignoredCount++
			if isDir {
				return filepath.SkipDir
			}
			return nil
		}
		if (policy.SensitiveMode != "include_with_consent") && isSensitive(rel) {
			warnings = append(warnings, ScanWarning{Path: rel, Type: "sensitive", Reason: "sensitive_content_policy"})
			ignoredCount++
			if isDir {
				return filepath.SkipDir
			}
			return nil
		}
		if len(entries) >= policy.MaxEntries {
			return &ScanError{Code: "scan_limit", Paths: []string{rel}, Err: fmt.Errorf("workspace exceeds %d entries", policy.MaxEntries)}
		}
		info, err := dirEntry.Info()
		if err != nil {
			return &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: err}
		}
		if isDir {
			entries = append(entries, map[string]any{"path": rel, "type": "directory"})
			return nil
		}
		if dirEntry.Type()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: err}
			}
			if !safeSymlink(root, path, target) {
				warnings = append(warnings, ScanWarning{Path: rel, Type: "unsupported", Reason: "unsafe_symlink_target"})
				return nil
			}
			entries = append(entries, map[string]any{"path": rel, "type": "symlink", "symlinkTarget": slashPath(target)})
			return nil
		}
		if !info.Mode().IsRegular() {
			warnings = append(warnings, ScanWarning{Path: rel, Type: "unsupported", Reason: "unsupported_file_type"})
			return nil
		}
		if info.Size() < 0 || info.Size() > policy.MaxFileBytes {
			return &ScanError{Code: "scan_limit", Paths: []string{rel}, Err: fmt.Errorf("file exceeds configured limit")}
		}
		hash, size, err := hashStable(path, rel, policy.MaxFileBytes)
		if err != nil {
			return err
		}
		totalBytes += size
		if totalBytes > policy.MaxSnapshotBytes {
			return &ScanError{Code: "scan_limit", Paths: []string{rel}, Err: fmt.Errorf("workspace exceeds configured byte limit")}
		}
		entries = append(entries, map[string]any{
			"path":       rel,
			"type":       "file",
			"size":       size,
			"sha256":     hash,
			"executable": info.Mode().Perm()&0o111 != 0,
		})
		blobs = append(blobs, ScanBlob{Path: rel, SHA256: hash, Size: size})
		return nil
	})
	if walkErr != nil {
		if scanErr, ok := walkErr.(*ScanError); ok {
			return ScanResult{}, scanErr
		}
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: walkErr}
	}

	sort.Slice(entries, func(i, j int) bool {
		left := entries[i]["path"].(string)
		right := entries[j]["path"].(string)
		if left != right {
			return left < right
		}
		return entries[i]["type"].(string) < entries[j]["type"].(string)
	})
	seenNFC := map[string]string{}
	seenFolded := map[string]string{}
	for _, entry := range entries {
		path := entry["path"].(string)
		nfc := norm.NFC.String(path)
		if prior, exists := seenNFC[nfc]; exists && prior != path {
			return ScanResult{}, &ScanError{Code: "path_collision", Paths: []string{prior, path}, Err: errors.New("unicode normalization collision")}
		}
		seenNFC[nfc] = path
		folded := strings.ToLower(nfc)
		if prior, exists := seenFolded[folded]; exists && prior != path {
			return ScanResult{}, &ScanError{Code: "path_collision", Paths: []string{prior, path}, Err: errors.New("case collision")}
		}
		seenFolded[folded] = path
	}
	policyHashInput := map[string]any{
		"defaultExcludes":      policy.DefaultExcludes,
		"customExcludes":       policy.CustomExcludes,
		"sensitiveContentMode": policy.SensitiveMode,
		"maxEntries":           policy.MaxEntries,
		"maxFileBytes":         policy.MaxFileBytes,
		"maxSnapshotBytes":     policy.MaxSnapshotBytes,
	}
	policyRaw, err := EncodeJSON(policyHashInput)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	policyHash, _, err := CanonicalHash(policyRaw)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	manifest := map[string]any{
		"version":          1,
		"policyVersion":    policy.PolicyVersion,
		"scanPolicyHash":   policyHash,
		"entries":          entries,
		"boundaries":       []any{},
		"portableGitState": nil,
	}
	manifestRaw, err := EncodeJSON(manifest)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	manifestHash, canonicalManifest, err := CanonicalHash(manifestRaw)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	treeRaw, err := EncodeJSON(map[string]any{
		"scanPolicyHash":   policyHash,
		"entries":          entries,
		"boundaries":       []any{},
		"portableGitState": nil,
	})
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	treeHash, _, err := CanonicalHash(treeRaw)
	if err != nil {
		return ScanResult{}, &ScanError{Code: "scan_incomplete", Err: err}
	}
	return ScanResult{
		Manifest:       manifest,
		ManifestBytes:  canonicalManifest,
		ManifestSHA256: manifestHash,
		TreeHash:       treeHash,
		Blobs:          blobs,
		Warnings:       warnings,
		IgnoredCount:   ignoredCount,
	}, nil
}

func hashStable(path, rel string, maxBytes int64) (string, int64, error) {
	for attempt := 0; attempt < 3; attempt++ {
		before, err := os.Lstat(path)
		if err != nil {
			return "", 0, &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: err}
		}
		if !before.Mode().IsRegular() {
			return "", 0, &ScanError{Code: "workspace_busy", Paths: []string{rel}, Err: errors.New("file changed type during scan")}
		}
		if before.Size() > maxBytes {
			return "", 0, &ScanError{Code: "scan_limit", Paths: []string{rel}, Err: errors.New("file exceeds configured limit")}
		}
		file, err := os.Open(path)
		if err != nil {
			return "", 0, &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: err}
		}
		hash := sha256.New()
		size, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", 0, &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: copyErr}
		}
		if closeErr != nil {
			return "", 0, &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: closeErr}
		}
		after, err := os.Lstat(path)
		if err != nil {
			return "", 0, &ScanError{Code: "scan_incomplete", Paths: []string{rel}, Err: err}
		}
		if sameFileIdentity(before, after) {
			return hex.EncodeToString(hash.Sum(nil)), size, nil
		}
	}
	return "", 0, &ScanError{Code: "workspace_busy", Paths: []string{rel}, Err: errors.New("file remained unstable while scanning")}
}

func sameFileIdentity(before, after os.FileInfo) bool {
	return os.SameFile(before, after) && before.Size() == after.Size() && before.ModTime().Equal(after.ModTime()) && before.Mode() == after.Mode()
}

func normalizePath(value string) (string, error) {
	if value == "" || !utf8.ValidString(value) {
		return "", errors.New("path is empty or invalid UTF-8")
	}
	value = slashPath(value)
	if !utf8.ValidString(value) {
		return "", errors.New("path is not valid UTF-8")
	}
	value = norm.NFC.String(value)
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\x00") {
		return "", errors.New("absolute or NUL path")
	}
	if len([]byte(value)) > 4096 {
		return "", errors.New("path exceeds 4096 UTF-8 bytes")
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if len([]byte(part)) > 255 || part == "" || part == "." || part == ".." || strings.IndexFunc(part, func(r rune) bool { return r < 0x20 }) >= 0 || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || windowsReservedBasename.MatchString(part) {
			return "", errors.New("non-portable path segment")
		}
	}
	return value, nil
}

func slashPath(value string) string { return filepath.ToSlash(value) }

func hardExcluded(path string) bool {
	parts := strings.Split(path, "/")
	for index, part := range parts {
		if part == ".git" {
			return true
		}
		if index == 0 && part == ".cohub" && len(parts) > 1 && parts[1] == "system" {
			return true
		}
	}
	return false
}

func isSensitive(path string) bool {
	return sensitiveBasename.MatchString(filepath.Base(path)) || sensitivePath.MatchString(path)
}

func safeSymlink(root, path, target string) bool {
	if target == "" || filepath.IsAbs(target) || strings.Contains(target, "\\") {
		return false
	}
	resolved := filepath.Clean(filepath.Join(filepath.Dir(path), target))
	rel, err := filepath.Rel(root, resolved)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel)
}

func globRegexp(pattern string) (*regexp.Regexp, error) {
	pattern = slashPath(strings.TrimPrefix(pattern, "./"))
	var builder strings.Builder
	builder.WriteString("^")
	for index := 0; index < len(pattern); index++ {
		char := pattern[index]
		switch char {
		case '*':
			if index+1 < len(pattern) && pattern[index+1] == '*' {
				builder.WriteString(".*")
				index++
			} else {
				builder.WriteString("[^/]*")
			}
		case '?':
			builder.WriteString("[^/]")
		case '/':
			builder.WriteByte('/')
		default:
			builder.WriteString(regexp.QuoteMeta(string(char)))
		}
	}
	builder.WriteString("/?$")
	return regexp.Compile(builder.String())
}

func matchesPattern(patterns []*regexp.Regexp, path string, directory bool) bool {
	if directory {
		path += "/"
	}
	for _, pattern := range patterns {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}
