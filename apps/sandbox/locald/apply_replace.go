package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type localFileReplacement struct {
	root            string
	workspacePath   string
	source          string
	destination     string
	temporary       string
	journalPath     string
	expectedSize    int64
	expectedHash    string
	destinationMode os.FileMode
}

func newLocalFileReplacement(root, cycleID, workspacePath, source, destination string, expectedSize int64, expectedHash string, mode os.FileMode) (localFileReplacement, error) {
	if root == "" || cycleID == "" || workspacePath == "" || source == "" || destination == "" || expectedSize < 0 || expectedHash == "" {
		return localFileReplacement{}, errors.New("local file replacement identity is incomplete")
	}
	digest := sha256.Sum256([]byte(cycleID + "\x00" + workspacePath))
	temporary := filepath.Join(filepath.Dir(destination), ".cohub-apply-"+hex.EncodeToString(digest[:12])+".tmp")
	journalPath, err := filepath.Rel(root, temporary)
	if err != nil {
		return localFileReplacement{}, err
	}
	journalPath = filepath.ToSlash(journalPath)
	checkedTemporary, err := targetPathForReplicaChecked(root, journalPath)
	if err != nil {
		return localFileReplacement{}, err
	}
	if filepath.Clean(checkedTemporary) != filepath.Clean(temporary) || filepath.Clean(temporary) == filepath.Clean(destination) {
		return localFileReplacement{}, errors.New("local file replacement path is unsafe")
	}
	return localFileReplacement{
		root:            root,
		workspacePath:   workspacePath,
		source:          source,
		destination:     destination,
		temporary:       temporary,
		journalPath:     journalPath,
		expectedSize:    expectedSize,
		expectedHash:    expectedHash,
		destinationMode: mode,
	}, nil
}

func (replacement localFileReplacement) install() error {
	if err := mkdirAllReplicaPathParentChecked(replacement.root, replacement.workspacePath, 0o775); err != nil {
		return err
	}
	input, err := os.Open(replacement.source)
	if err != nil {
		return err
	}
	defer input.Close()

	temporary, err := targetPathForReplicaMutationChecked(replacement.root, replacement.journalPath)
	if err != nil {
		return err
	}
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	removeTemporary := true
	defer func() {
		if output != nil {
			_ = output.Close()
		}
		if removeTemporary {
			_ = removeReplicaPathChecked(replacement.root, replacement.journalPath)
		}
	}()

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, replacement.expectedSize+1))
	if err != nil {
		return err
	}
	if written != replacement.expectedSize || hex.EncodeToString(hash.Sum(nil)) != replacement.expectedHash {
		return errors.New("staged file changed before local apply")
	}
	if err := output.Chmod(replacement.destinationMode); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	output = nil
	if err := renameReplicaPathChecked(replacement.root, replacement.journalPath, replacement.workspacePath); err != nil {
		return err
	}
	removeTemporary = false
	return nil
}
