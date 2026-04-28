package workspacewatcher

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type ChangeHandler func(count int)

const debounceWindow = 500 * time.Millisecond

var ignoredDirNames = map[string]struct{}{
	".git":        {},
	".hg":         {},
	".svn":        {},
	"node_modules": {},
	".pnpm":       {},
	".svelte-kit": {},
	".next":       {},
	"dist":        {},
	"build":       {},
	"coverage":    {},
	"target":      {},
	".cache":      {},
}

func Start(ctx context.Context, root string, logger *slog.Logger, onChange ChangeHandler) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	root = filepath.Clean(root)
	if err := addRecursive(watcher, root, logger); err != nil {
		_ = watcher.Close()
		return err
	}

	logger.Info("workspace watcher started", slog.String("root", root))

	go func() {
		defer watcher.Close()

		var mu sync.Mutex
		pending := 0
		var timer *time.Timer

		flush := func() {
			mu.Lock()
			count := pending
			pending = 0
			timer = nil
			mu.Unlock()
			if count > 0 {
				onChange(count)
			}
		}

		markChanged := func() {
			mu.Lock()
			pending += 1
			if timer == nil {
				timer = time.AfterFunc(debounceWindow, flush)
			} else {
				timer.Reset(debounceWindow)
			}
			mu.Unlock()
		}

		for {
			select {
			case <-ctx.Done():
				mu.Lock()
				if timer != nil {
					timer.Stop()
				}
				mu.Unlock()
				logger.Info("workspace watcher stopped", slog.String("root", root))
				return
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if shouldIgnorePath(root, event.Name) {
					continue
				}
				if event.Has(fsnotify.Create) {
					addCreatedDirectory(watcher, event.Name, root, logger)
				}
				if event.Has(fsnotify.Create) || event.Has(fsnotify.Write) || event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
					markChanged()
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				logger.Warn("workspace watcher error", slog.String("root", root), slog.String("error", err.Error()))
			}
		}
	}()

	return nil
}

func addRecursive(watcher *fsnotify.Watcher, root string, logger *slog.Logger) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrPermission) {
				logger.Warn("workspace watcher skipping unreadable path", slog.String("path", path), slog.String("error", err.Error()))
				if entry != nil && entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		if shouldIgnorePath(root, path) && path != root {
			return filepath.SkipDir
		}
		if err := watcher.Add(path); err != nil {
			logger.Warn("workspace watcher failed to watch directory", slog.String("path", path), slog.String("error", err.Error()))
			return nil
		}
		return nil
	})
}

func addCreatedDirectory(watcher *fsnotify.Watcher, path string, root string, logger *slog.Logger) {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return
	}
	if shouldIgnorePath(root, path) {
		return
	}
	if err := addRecursive(watcher, path, logger); err != nil {
		logger.Warn("workspace watcher failed to watch created directory", slog.String("path", path), slog.String("error", err.Error()))
	}
}

func shouldIgnorePath(root string, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == "." {
		return false
	}
	if strings.HasPrefix(rel, "..") {
		return true
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for _, part := range parts {
		if _, ignored := ignoredDirNames[part]; ignored {
			return true
		}
		if strings.HasSuffix(part, "~") || strings.HasPrefix(part, ".#") {
			return true
		}
	}
	return false
}
