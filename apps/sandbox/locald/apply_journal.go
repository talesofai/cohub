package locald

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type localApplyJournalEntry struct {
	Path    string `json:"path"`
	Existed bool   `json:"existed"`
}

type localApplyJournalDescriptor struct {
	Version   int                      `json:"version"`
	CycleID   string                   `json:"cycleId"`
	Root      string                   `json:"root"`
	CreatedAt string                   `json:"createdAt"`
	Entries   []localApplyJournalEntry `json:"entries"`
}

type localApplyJournal struct {
	descriptor localApplyJournalDescriptor
	path       string
	state      *StateStore
}

func localApplyJournalPath(dataDir, cycleID string) string {
	return filepath.Join(dataDir, "apply-journals", cycleID)
}

func createLocalApplyJournal(state *StateStore, dataDir, root, cycleID string, paths []string) (*localApplyJournal, error) {
	if state == nil || dataDir == "" || root == "" || cycleID == "" {
		return nil, errors.New("local apply journal identity is incomplete")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	journalPath := localApplyJournalPath(dataDir, cycleID)
	if _, err := os.Stat(journalPath); err == nil {
		return nil, errors.New("local apply journal already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(journalPath, "nodes"), 0o700); err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(journalPath)
		}
	}()

	unique := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if _, err := targetPathForReplicaChecked(root, path); err != nil {
			return nil, err
		}
		unique[path] = struct{}{}
	}
	sortedPaths := make([]string, 0, len(unique))
	for path := range unique {
		sortedPaths = append(sortedPaths, path)
	}
	sort.Slice(sortedPaths, func(i, j int) bool {
		leftDepth := strings.Count(sortedPaths[i], "/")
		rightDepth := strings.Count(sortedPaths[j], "/")
		if leftDepth != rightDepth {
			return leftDepth < rightDepth
		}
		return sortedPaths[i] < sortedPaths[j]
	})

	entries := make([]localApplyJournalEntry, 0, len(sortedPaths))
	for _, path := range sortedPaths {
		skipped := false
		for _, entry := range entries {
			if entry.Existed && (entry.Path == path || strings.HasPrefix(path, entry.Path+"/")) {
				skipped = true
				break
			}
		}
		if skipped {
			continue
		}
		source, _ := targetPathForReplicaChecked(root, path)
		_, statErr := os.Lstat(source)
		if errors.Is(statErr, os.ErrNotExist) {
			entries = append(entries, localApplyJournalEntry{Path: path, Existed: false})
			continue
		}
		if statErr != nil {
			return nil, statErr
		}
		destination := filepath.Join(journalPath, "nodes", filepath.FromSlash(path))
		if err := copyLocalApplyNode(source, destination); err != nil {
			return nil, err
		}
		entries = append(entries, localApplyJournalEntry{Path: path, Existed: true})
	}

	descriptor := localApplyJournalDescriptor{
		Version:   1,
		CycleID:   cycleID,
		Root:      filepath.Clean(root),
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Entries:   entries,
	}
	descriptorRaw, err := json.Marshal(descriptor)
	if err != nil {
		return nil, err
	}
	if err := writeSyncedPrivateFile(filepath.Join(journalPath, "journal.json"), descriptorRaw); err != nil {
		return nil, err
	}
	if err := state.RecordApplyJournal(cycleID, descriptor.Root, journalPath); err != nil {
		return nil, err
	}
	committed = true
	return &localApplyJournal{descriptor: descriptor, path: journalPath, state: state}, nil
}

func loadLocalApplyJournal(state *StateStore, item ApplyJournalState) (*localApplyJournal, error) {
	raw, err := os.ReadFile(filepath.Join(item.JournalPath, "journal.json"))
	if err != nil {
		return nil, err
	}
	var descriptor localApplyJournalDescriptor
	if err := json.Unmarshal(raw, &descriptor); err != nil {
		return nil, err
	}
	if descriptor.Version != 1 || descriptor.CycleID != item.CycleID || filepath.Clean(descriptor.Root) != filepath.Clean(item.Root) {
		return nil, errors.New("local apply journal descriptor does not match SQLite state")
	}
	for _, entry := range descriptor.Entries {
		if _, err := targetPathForReplicaChecked(descriptor.Root, entry.Path); err != nil {
			return nil, err
		}
	}
	return &localApplyJournal{descriptor: descriptor, path: item.JournalPath, state: state}, nil
}

func (j *localApplyJournal) Rollback() error {
	if j == nil {
		return nil
	}
	restored := make([]string, 0, len(j.descriptor.Entries))
	for _, entry := range j.descriptor.Entries {
		skipped := false
		for _, ancestor := range restored {
			if entry.Path == ancestor || strings.HasPrefix(entry.Path, ancestor+"/") {
				skipped = true
				break
			}
		}
		if skipped {
			continue
		}
		destination, err := targetPathForReplicaChecked(j.descriptor.Root, entry.Path)
		if err != nil {
			return err
		}
		if err := os.RemoveAll(destination); err != nil {
			return err
		}
		if entry.Existed {
			source := filepath.Join(j.path, "nodes", filepath.FromSlash(entry.Path))
			if err := copyLocalApplyNode(source, destination); err != nil {
				return err
			}
		}
		restored = append(restored, entry.Path)
	}
	return nil
}

func (j *localApplyJournal) Cleanup() error {
	if j == nil {
		return nil
	}
	if err := j.state.DeleteApplyJournal(j.descriptor.CycleID); err != nil {
		return err
	}
	return os.RemoveAll(j.path)
}

func recoverLocalApplyJournals(state *StateStore, dataDir string) error {
	items, err := state.PendingApplyJournals()
	if err != nil {
		return err
	}
	for _, item := range items {
		journal, err := loadLocalApplyJournal(state, item)
		if err != nil {
			return fmt.Errorf("load apply journal %s: %w", item.CycleID, err)
		}
		if err := journal.Rollback(); err != nil {
			return fmt.Errorf("rollback apply journal %s: %w", item.CycleID, err)
		}
		if err := journal.Cleanup(); err != nil {
			return fmt.Errorf("cleanup apply journal %s: %w", item.CycleID, err)
		}
	}
	// Any remaining directory has no applying SQLite row (for example a crash
	// while staging before the durable journal insert) or is already committed.
	return os.RemoveAll(filepath.Join(dataDir, "apply-journals"))
}

func copyLocalApplyNode(source, destination string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(target, destination)
	}
	if info.IsDir() {
		if err := os.MkdirAll(destination, info.Mode().Perm()); err != nil {
			return err
		}
		children, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := copyLocalApplyNode(filepath.Join(source, child.Name()), filepath.Join(destination, child.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("unsupported node in local apply journal: %s", source)
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
