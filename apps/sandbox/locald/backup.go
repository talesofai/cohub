package locald

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

type localBackupDescriptor struct {
	Version         int    `json:"version"`
	SpaceID         string `json:"spaceId"`
	ReplicaID       string `json:"replicaId"`
	RootFingerprint string `json:"rootFingerprint"`
	TreeHash        string `json:"treeHash"`
	CreatedAt       string `json:"createdAt"`
	ManifestFile    string `json:"manifestFile"`
}

func (d *Daemon) createInitialRecoveryBackup(replica *ReplicaState, scan ScanResult) (string, error) {
	if replica == nil || replica.SpaceID == "" || replica.ReplicaID == "" || scan.TreeHash == "" || len(scan.ManifestBytes) == 0 {
		return "", errors.New("initial recovery backup identity is incomplete")
	}
	backupRoot := filepath.Join(d.cfg.DataDir, "backups", replica.SpaceID)
	finalPath := filepath.Join(backupRoot, scan.TreeHash)
	if valid, err := validateRecoveryBackup(finalPath, scan); err != nil {
		return "", err
	} else if valid {
		return finalPath, nil
	}
	if err := os.MkdirAll(backupRoot, 0o700); err != nil {
		return "", fmt.Errorf("create backup root: %w", err)
	}
	staging := finalPath + ".staging-" + uuid.NewString()
	if err := os.MkdirAll(filepath.Join(staging, "blobs"), 0o700); err != nil {
		return "", fmt.Errorf("create backup staging directory: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(staging)
		}
	}()

	seen := make(map[string]struct{}, len(scan.Blobs))
	for _, blob := range scan.Blobs {
		if _, ok := seen[blob.SHA256]; ok {
			continue
		}
		seen[blob.SHA256] = struct{}{}
		source, err := targetPathForReplicaChecked(replica.Root, blob.Path)
		if err != nil {
			return "", err
		}
		destination := filepath.Join(staging, "blobs", blob.SHA256)
		if err := copyStableBackupFile(source, destination, blob.Size, blob.SHA256); err != nil {
			return "", fmt.Errorf("backup managed file %s: %w", blob.Path, err)
		}
	}
	if err := writeSyncedPrivateFile(filepath.Join(staging, "manifest.json"), scan.ManifestBytes); err != nil {
		return "", fmt.Errorf("write backup manifest: %w", err)
	}
	descriptorRaw, err := json.Marshal(localBackupDescriptor{
		Version:         1,
		SpaceID:         replica.SpaceID,
		ReplicaID:       replica.ReplicaID,
		RootFingerprint: replica.RootFingerprint,
		TreeHash:        scan.TreeHash,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339Nano),
		ManifestFile:    "manifest.json",
	})
	if err != nil {
		return "", err
	}
	canonicalDescriptor, err := CanonicalJSON(descriptorRaw)
	if err != nil {
		return "", err
	}
	if err := writeSyncedPrivateFile(filepath.Join(staging, "backup.json"), canonicalDescriptor); err != nil {
		return "", fmt.Errorf("write backup descriptor: %w", err)
	}
	if err := os.Rename(staging, finalPath); err != nil {
		if valid, validateErr := validateRecoveryBackup(finalPath, scan); validateErr == nil && valid {
			committed = true
			_ = os.RemoveAll(staging)
			return finalPath, nil
		}
		return "", fmt.Errorf("commit recovery backup: %w", err)
	}
	committed = true
	return finalPath, nil
}

func validateRecoveryBackup(path string, scan ScanResult) (bool, error) {
	descriptorRaw, err := os.ReadFile(filepath.Join(path, "backup.json"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read recovery backup descriptor: %w", err)
	}
	var descriptor localBackupDescriptor
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		return false, fmt.Errorf("decode recovery backup descriptor: %w", err)
	}
	if descriptor.Version != 1 || descriptor.TreeHash != scan.TreeHash || descriptor.ManifestFile != "manifest.json" {
		return false, errors.New("existing recovery backup descriptor does not match the local tree")
	}
	manifestRaw, err := os.ReadFile(filepath.Join(path, descriptor.ManifestFile))
	if err != nil {
		return false, fmt.Errorf("read recovery backup manifest: %w", err)
	}
	manifestHash, _, err := CanonicalHash(manifestRaw)
	if err != nil {
		return false, err
	}
	if manifestHash != scan.ManifestSHA256 {
		return false, errors.New("existing recovery backup manifest hash mismatch")
	}
	seen := make(map[string]struct{}, len(scan.Blobs))
	for _, blob := range scan.Blobs {
		if _, ok := seen[blob.SHA256]; ok {
			continue
		}
		seen[blob.SHA256] = struct{}{}
		blobPath := filepath.Join(path, "blobs", blob.SHA256)
		info, err := os.Stat(blobPath)
		if err != nil || !info.Mode().IsRegular() || info.Size() != blob.Size {
			return false, errors.New("existing recovery backup blob is missing or incomplete")
		}
		file, err := os.Open(blobPath)
		if err != nil {
			return false, err
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return false, copyErr
		}
		if closeErr != nil {
			return false, closeErr
		}
		if hex.EncodeToString(hash.Sum(nil)) != blob.SHA256 {
			return false, errors.New("existing recovery backup blob hash mismatch")
		}
	}
	return true, nil
}

func copyStableBackupFile(source, destination string, expectedSize int64, expectedHash string) error {
	before, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !before.Mode().IsRegular() || before.Size() != expectedSize {
		return errors.New("source changed after workspace scan")
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	after, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if written != expectedSize || !sameFileIdentity(before, after) || hex.EncodeToString(hash.Sum(nil)) != expectedHash {
		return errors.New("source changed while creating recovery backup")
	}
	return nil
}

func writeSyncedPrivateFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
