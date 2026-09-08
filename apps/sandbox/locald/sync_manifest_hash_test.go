package locald

import "testing"

func TestRemoteManifestTreeHashPreservesFalseExecutable(t *testing.T) {
	raw := []byte(`{"version":1,"policyVersion":1,"scanPolicyHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","entries":[{"path":"file.txt","type":"file","size":0,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","executable":false}],"boundaries":[],"portableGitState":null}`)

	got, err := remoteManifestTreeHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	const want = "6c76198288c0da51d25dc63d69d81d5a40e6984a0d6023963d27a3ffc27ac7a2"
	if got != want {
		t.Fatalf("tree hash = %s, want %s", got, want)
	}
}
