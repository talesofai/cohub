package locald

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

func syncReplicaMutationDirectories(root string, paths []string) error {
	directories, err := replicaMutationDirectories(root, paths)
	if err != nil {
		return err
	}
	return syncDirectories(directories)
}

func replicaMutationDirectories(root string, paths []string) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	directories := make(map[string]struct{})
	for _, path := range paths {
		target, err := targetPathForReplicaMutationChecked(root, path)
		if err != nil {
			return nil, err
		}
		directory := filepath.Dir(target)
		if info, statErr := os.Lstat(target); statErr == nil && info.IsDir() {
			directory = target
		} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
			return nil, statErr
		}
		for {
			info, statErr := os.Lstat(directory)
			if statErr == nil {
				if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
					return nil, fmt.Errorf("workspace mutation parent is not a physical directory: %s", directory)
				}
				directories[directory] = struct{}{}
			} else if !errors.Is(statErr, os.ErrNotExist) {
				return nil, statErr
			}
			if filepath.Clean(directory) == filepath.Clean(root) {
				break
			}
			parent := filepath.Dir(directory)
			if parent == directory || !sameOrBelowRoot(root, parent) {
				return nil, errors.New("workspace mutation directory escapes replica root")
			}
			directory = parent
		}
	}
	return deepestDirectoriesFirst(directories), nil
}

func syncDirectoryTree(root, boundary string) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	boundary, err = filepath.Abs(boundary)
	if err != nil {
		return err
	}
	if !sameOrBelowRoot(boundary, root) {
		return errors.New("directory tree escapes durability boundary")
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("durability tree root is not a physical directory: %s", root)
	}
	directories := make(map[string]struct{})
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories[path] = struct{}{}
		}
		return nil
	}); err != nil {
		return err
	}
	for directory := filepath.Dir(root); filepath.Clean(root) != filepath.Clean(boundary); directory = filepath.Dir(directory) {
		info, err := os.Lstat(directory)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("durability boundary contains a non-directory: %s", directory)
		}
		directories[directory] = struct{}{}
		if filepath.Clean(directory) == filepath.Clean(boundary) {
			break
		}
	}
	return syncDirectories(deepestDirectoriesFirst(directories))
}

func deepestDirectoriesFirst(directories map[string]struct{}) []string {
	result := make([]string, 0, len(directories))
	for directory := range directories {
		result = append(result, directory)
	}
	sort.Slice(result, func(i, j int) bool {
		leftDepth := pathDepth(result[i])
		rightDepth := pathDepth(result[j])
		if leftDepth != rightDepth {
			return leftDepth > rightDepth
		}
		return result[i] < result[j]
	})
	return result
}

func pathDepth(path string) int {
	depth := 0
	for directory := filepath.Clean(path); ; directory = filepath.Dir(directory) {
		depth++
		if parent := filepath.Dir(directory); parent == directory {
			return depth
		}
	}
}

func syncDirectories(directories []string) error {
	for _, directory := range directories {
		if err := syncFilePath(directory); err != nil {
			return fmt.Errorf("sync directory %s: %w", directory, err)
		}
	}
	return nil
}
