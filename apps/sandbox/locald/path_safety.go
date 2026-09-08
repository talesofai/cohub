package locald

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func targetPathForReplicaMutationChecked(root, path string) (string, error) {
	destination, err := targetPathForReplicaChecked(root, path)
	if err != nil {
		return "", err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return "", fmt.Errorf("inspect replica root: %w", err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return "", errors.New("replica root is not a physical directory")
	}
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return "", fmt.Errorf("open replica root: %w", err)
	}
	defer rootHandle.Close()

	parts := strings.Split(path, "/")
	for index := 1; index < len(parts); index++ {
		ancestor := filepath.FromSlash(strings.Join(parts[:index], "/"))
		info, statErr := rootHandle.Lstat(ancestor)
		if errors.Is(statErr, os.ErrNotExist) {
			break
		}
		if statErr != nil {
			return "", fmt.Errorf("inspect replica path ancestor %q: %w", ancestor, statErr)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("replica path ancestor %q is a symbolic link", ancestor)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("replica path ancestor %q is not a directory", ancestor)
		}
	}
	return destination, nil
}

func removeReplicaPathChecked(root, path string) error {
	destination, err := targetPathForReplicaMutationChecked(root, path)
	if err != nil {
		return err
	}
	return os.RemoveAll(destination)
}

func mkdirAllReplicaPathChecked(root, path string, mode os.FileMode) error {
	destination, err := targetPathForReplicaMutationChecked(root, path)
	if err != nil {
		return err
	}
	return os.MkdirAll(destination, mode)
}

func mkdirAllReplicaPathParentChecked(root, path string, mode os.FileMode) error {
	destination, err := targetPathForReplicaMutationChecked(root, path)
	if err != nil {
		return err
	}
	return os.MkdirAll(filepath.Dir(destination), mode)
}

func symlinkReplicaPathChecked(root, target, path string) error {
	destination, err := targetPathForReplicaMutationChecked(root, path)
	if err != nil {
		return err
	}
	return os.Symlink(target, destination)
}

func renameReplicaPathChecked(root, oldPath, newPath string) error {
	source, err := targetPathForReplicaMutationChecked(root, oldPath)
	if err != nil {
		return err
	}
	destination, err := targetPathForReplicaMutationChecked(root, newPath)
	if err != nil {
		return err
	}
	return os.Rename(source, destination)
}
