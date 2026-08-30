package locald

import "testing"

func TestUploadedNativeIdentitiesAreScopedToSpaceAndReplica(t *testing.T) {
	identity := []byte("0123456789abcdef0123456789abcdef")
	sessionA := NativeSessionKey(identity, "space-a", "replica-a", "pi", "home", "session")
	sessionB := NativeSessionKey(identity, "space-b", "replica-a", "pi", "home", "session")
	sessionC := NativeSessionKey(identity, "space-a", "replica-b", "pi", "home", "session")
	if sessionA == sessionB || sessionA == sessionC || sessionB == sessionC {
		t.Fatal("native session identities are linkable across Space or replica scope")
	}
	turnA := NativeTurnKey(identity, "space-a", "replica-a", "pi", "turn")
	turnB := NativeTurnKey(identity, "space-a", "replica-b", "pi", "turn")
	if turnA == turnB {
		t.Fatal("native turn identities are linkable across replicas")
	}
	rootA := RootFingerprint(identity, "space-a", "/workspace/project")
	rootB := RootFingerprint(identity, "space-b", "/workspace/project")
	if rootA == rootB {
		t.Fatal("root fingerprints are linkable across Spaces")
	}
}
