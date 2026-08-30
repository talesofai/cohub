package locald

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	jsoncanonicalizer "github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/zalando/go-keyring"
)

const (
	keyringService = "cohub-locald-v1"
	keyringUser    = "device-identity"
)

var ErrCredentialNotFound = keyring.ErrNotFound

func CanonicalJSON(value []byte) ([]byte, error) {
	canonical, err := jsoncanonicalizer.Transform(value)
	if err != nil {
		return nil, fmt.Errorf("canonicalize JSON: %w", err)
	}
	return canonical, nil
}

func CanonicalHash(value []byte) (string, []byte, error) {
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), canonical, nil
}

func GenerateIdentity() ([]byte, error) {
	identity := make([]byte, 32)
	if _, err := rand.Read(identity); err != nil {
		return nil, fmt.Errorf("generate locald identity: %w", err)
	}
	return identity, nil
}

func LoadOrCreateIdentity() ([]byte, error) {
	value, err := keyring.Get(keyringService, keyringUser)
	if err == nil {
		decoded, decodeErr := hex.DecodeString(value)
		if decodeErr != nil || len(decoded) < 32 {
			return nil, errors.New("locald keyring identity is malformed; remove the locald keyring entry and re-enroll")
		}
		return decoded, nil
	}
	if !errors.Is(err, keyring.ErrNotFound) {
		return nil, fmt.Errorf("read locald OS keychain: %w", err)
	}
	identity, generateErr := GenerateIdentity()
	if generateErr != nil {
		return nil, generateErr
	}
	if saveErr := SaveIdentity(identity); saveErr != nil {
		return nil, fmt.Errorf("save locald identity in OS keychain: %w", saveErr)
	}
	return identity, nil
}

func SaveCredential(name, value string) error {
	if strings.TrimSpace(name) == "" || value == "" {
		return errors.New("locald credential name and value are required")
	}
	return keyring.Set(keyringService, name, value)
}

func LoadCredential(name string) (string, error) {
	if strings.TrimSpace(name) == "" {
		return "", errors.New("locald credential name is required")
	}
	return keyring.Get(keyringService, name)
}

func DeleteCredential(name string) error {
	return keyring.Delete(keyringService, name)
}

func SaveIdentity(identity []byte) error {
	if len(identity) < 32 {
		return errors.New("locald identity must contain at least 32 bytes")
	}
	return keyring.Set(keyringService, keyringUser, hex.EncodeToString(identity))
}

func RotateIdentity() ([]byte, error) {
	identity, err := GenerateIdentity()
	if err != nil {
		return nil, err
	}
	if err := SaveIdentity(identity); err != nil {
		return nil, err
	}
	return identity, nil
}

func ScopedIdentity(identity []byte, scope, provider, raw string) string {
	mac := hmac.New(sha256.New, identity)
	mac.Write([]byte("cohub-local-agent-"))
	mac.Write([]byte(scope))
	mac.Write([]byte{0})
	mac.Write([]byte(provider))
	mac.Write([]byte{0})
	mac.Write([]byte(raw))
	return hex.EncodeToString(mac.Sum(nil))
}

func scopedUploadIdentity(spaceID, replicaID, raw string) string {
	return strings.TrimSpace(spaceID) + "\x00" + strings.TrimSpace(replicaID) + "\x00" + raw
}

func CanonicalWorkspaceRoot(root string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(absolute))
	if err != nil {
		return "", err
	}
	return filepath.Clean(resolved), nil
}

func RootFingerprint(identity []byte, spaceID, root string) string {
	return ScopedIdentity(identity, "path", "workspace", scopedUploadIdentity(spaceID, "root", strings.TrimSpace(root)))
}

func NativeSessionKey(identity []byte, spaceID, replicaID, provider, homeNamespace, rawSessionID string) string {
	return ScopedIdentity(identity, "session", provider, scopedUploadIdentity(spaceID, replicaID, homeNamespace+"\x00"+rawSessionID))
}

func NativeTurnKey(identity []byte, spaceID, replicaID, provider, rawTurnID string) string {
	return ScopedIdentity(identity, "turn", provider, scopedUploadIdentity(spaceID, replicaID, rawTurnID))
}

func NativeMessageKey(identity []byte, spaceID, replicaID, provider, rawMessageID string) string {
	return ScopedIdentity(identity, "message", provider, scopedUploadIdentity(spaceID, replicaID, rawMessageID))
}

func NativeToolKey(identity []byte, spaceID, replicaID, provider, rawToolID string) string {
	return ScopedIdentity(identity, "tool", provider, scopedUploadIdentity(spaceID, replicaID, rawToolID))
}
