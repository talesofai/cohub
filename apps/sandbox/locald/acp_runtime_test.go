package locald

import (
	"testing"
	"time"
)

func TestRuntimeAttemptRefFromMetadataValidatesBinding(t *testing.T) {
	spaceID := "11111111-1111-4111-8111-111111111111"
	replicaID := "22222222-2222-4222-8222-222222222222"
	attemptID := "33333333-3333-4333-8333-333333333333"
	baseSnapshotID := "44444444-4444-4444-8444-444444444444"
	expiresAt := time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)

	ref, err := runtimeAttemptRefFromMetadata(map[string]any{
		"cohubExecutionAttemptId": attemptID,
		"cohubRuntimeId":          "runtime",
		"cohubSpaceId":            spaceID,
		"cohubReplicaId":          replicaID,
		"cohubBaseSnapshotId":     baseSnapshotID,
		"cohubLeaseEpoch":         float64(7),
		"cohubLeaseExpiresAt":     expiresAt,
	}, "runtime", spaceID, replicaID)
	if err != nil {
		t.Fatal(err)
	}
	if ref.attemptID != attemptID || ref.spaceID != spaceID || ref.replicaID != replicaID || ref.baseSnapshotID != baseSnapshotID || ref.leaseEpoch != 7 {
		t.Fatalf("unexpected runtime attempt reference: %#v", ref)
	}
}

func TestRuntimeAttemptRefFromMetadataRejectsStaleOrMismatchedBinding(t *testing.T) {
	base := map[string]any{
		"cohubExecutionAttemptId": "33333333-3333-4333-8333-333333333333",
		"cohubRuntimeId":          "runtime",
		"cohubSpaceId":            "11111111-1111-4111-8111-111111111111",
		"cohubReplicaId":          "22222222-2222-4222-8222-222222222222",
		"cohubLeaseEpoch":         float64(1),
		"cohubLeaseExpiresAt":     time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano),
	}
	if _, err := runtimeAttemptRefFromMetadata(base, "runtime", "99999999-9999-4999-8999-999999999999", base["cohubReplicaId"].(string)); err == nil {
		t.Fatal("expected Space mismatch to be rejected")
	}

	expired := make(map[string]any, len(base))
	for key, value := range base {
		expired[key] = value
	}
	expired["cohubLeaseExpiresAt"] = time.Now().UTC().Add(-time.Second).Format(time.RFC3339Nano)
	if _, err := runtimeAttemptRefFromMetadata(expired, "runtime", base["cohubSpaceId"].(string), base["cohubReplicaId"].(string)); err == nil {
		t.Fatal("expected expired lease to be rejected")
	}

	invalidUUID := make(map[string]any, len(base))
	for key, value := range base {
		invalidUUID[key] = value
	}
	invalidUUID["cohubExecutionAttemptId"] = "attempt"
	if _, err := runtimeAttemptRefFromMetadata(invalidUUID, "runtime", base["cohubSpaceId"].(string), base["cohubReplicaId"].(string)); err == nil {
		t.Fatal("expected invalid attempt UUID to be rejected")
	}
	missingBase := make(map[string]any, len(base))
	for key, value := range base {
		missingBase[key] = value
	}
	missingBase["cohubBaseSnapshotId"] = ""
	if _, err := runtimeAttemptRefFromMetadata(missingBase, "runtime", base["cohubSpaceId"].(string), base["cohubReplicaId"].(string)); err == nil {
		t.Fatal("expected missing base snapshot to be rejected")
	}
}

func TestRewriteAcpPathsPreservesLogicalWorkspacePaths(t *testing.T) {
	value := rewriteAcpPaths(map[string]any{
		"location": map[string]any{"path": "/workspace/src/main.go"},
		"cwd":      "/home/user/project",
	}, "/home/user/project")
	location := value["location"].(map[string]any)
	if location["path"] != "/workspace/src/main.go" || value["cwd"] != "/workspace" {
		t.Fatalf("unexpected rewritten ACP paths: %#v", value)
	}
}

func TestSanitizedRuntimeEnvironmentRemovesCohubCredentials(t *testing.T) {
	input := []string{
		"PATH=/usr/bin",
		"COHUB_API_URL=https://api.example.test",
		"COHUB_RUNTIME_TOKEN=secret",
		"COHUB_LOCAL_AGENT_ACCESS_TOKEN=secret",
		"COHUB_UNLISTED_INTERNAL_VALUE=secret",
		"WORKER_SECRET=secret",
		"DATABASE_URL=postgres://internal",
		"PROVIDER_SETTING=kept",
	}
	filtered := sanitizedRuntimeEnvironment(input)
	if len(filtered) != 2 || filtered[0] != "PATH=/usr/bin" || filtered[1] != "PROVIDER_SETTING=kept" {
		t.Fatalf("unexpected provider environment: %#v", filtered)
	}
}

func TestAcpRequestIDsKeepJSONTypesDistinct(t *testing.T) {
	if acpRequestIDKey(float64(1)) == acpRequestIDKey("1") {
		t.Fatal("numeric and string ACP request ids must not collide")
	}
	if !validAcpRequestID(float64(1)) || !validAcpRequestID("1") {
		t.Fatal("expected valid ACP request ids")
	}
	if validAcpRequestID(true) || validAcpRequestID("") {
		t.Fatal("expected invalid ACP request ids to be rejected")
	}
}

func TestDefaultAcpProviderCommandsUsePublishedBinaries(t *testing.T) {
	cases := map[string]string{
		"pi":          "pi-acp",
		"codex":       "codex-acp",
		"claude_code": "claude-agent-acp",
	}
	for provider, expected := range cases {
		if actual := defaultAcpProviderCommand(provider); actual != expected {
			t.Fatalf("provider %q resolved to %q, want %q", provider, actual, expected)
		}
	}
	if command := defaultAcpProviderCommand("unknown"); command != "" {
		t.Fatalf("unknown provider resolved to %q", command)
	}
}
