package lsp

import (
	"path/filepath"
	"sort"
	"strings"
)

// ReadPolicy bounds semantic queries and returned locations to explicit Space
// roots. Roots are canonicalized when possible and longest roots win.
type ReadPolicy struct {
	roots []string
}

func NewReadPolicy(roots ...string) ReadPolicy {
	seen := make(map[string]struct{}, len(roots))
	cleaned := make([]string, 0, len(roots))
	for _, root := range roots {
		root = canonicalPath(root)
		if root == "" {
			continue
		}
		if _, ok := seen[root]; ok {
			continue
		}
		seen[root] = struct{}{}
		cleaned = append(cleaned, root)
	}
	sort.SliceStable(cleaned, func(left, right int) bool {
		return len(cleaned[left]) > len(cleaned[right])
	})
	return ReadPolicy{roots: cleaned}
}

func (p ReadPolicy) CanRead(path string) bool {
	_, ok := p.RootFor(path)
	return ok
}

func (p ReadPolicy) RootFor(path string) (string, bool) {
	candidate := canonicalPath(path)
	for _, root := range p.roots {
		relative, err := filepath.Rel(root, candidate)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			continue
		}
		return root, true
	}
	return "", false
}

func canonicalPath(path string) string {
	cleaned := filepath.Clean(strings.TrimSpace(path))
	if cleaned == "." || cleaned == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return filepath.Clean(resolved)
	}
	return cleaned
}
