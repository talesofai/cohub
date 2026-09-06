package locald

import "testing"

func TestRootFingerprintsAreScopedToSpace(t *testing.T) {
	identity := []byte("0123456789abcdef0123456789abcdef")
	rootA := RootFingerprint(identity, "space-a", "/workspace/project")
	rootB := RootFingerprint(identity, "space-b", "/workspace/project")
	if rootA == rootB {
		t.Fatal("root fingerprints are linkable across Spaces")
	}
}
