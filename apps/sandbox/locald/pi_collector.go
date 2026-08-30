package locald

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const supportedPITranscriptVersion = "0.81.1"

type piCollectorInput struct {
	ExecutionAttemptID string           `json:"executionAttemptId"`
	NativeSessionID    string           `json:"nativeSessionId"`
	NativeTurnID       string           `json:"nativeTurnId"`
	ProviderVersion    string           `json:"providerVersion"`
	Prompt             string           `json:"prompt"`
	Messages           []map[string]any `json:"messages"`
}

func (d *Daemon) collectPI(request IPCRequest) IPCResponse {
	replica, err := d.state.ReplicaForPath(request.CWD)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "state_failed", Message: err.Error()}
	}
	if replica == nil {
		return IPCResponse{Version: protocolVersion, Code: "workspace_unattached", Message: "Workspace is not attached to CoHub."}
	}
	if replica.MirrorMode == "disabled" {
		return IPCResponse{Version: protocolVersion, OK: true, Code: "mirror_disabled", SpaceID: replica.SpaceID, ReplicaID: replica.ReplicaID}
	}
	var input piCollectorInput
	if err := json.Unmarshal(request.Payload, &input); err != nil {
		return IPCResponse{Version: protocolVersion, Code: "pi_bundle_invalid", Message: err.Error()}
	}
	if input.ExecutionAttemptID == "" || input.NativeSessionID == "" || input.NativeTurnID == "" || strings.TrimSpace(input.Prompt) == "" {
		return IPCResponse{Version: protocolVersion, Code: "pi_bundle_invalid", Message: "execution attempt, session, turn, and prompt are required"}
	}
	permit, err := d.state.PermitContext(input.ExecutionAttemptID)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "permit_read_failed", Message: err.Error()}
	}
	if permit == nil || permit.SpaceID != replica.SpaceID || permit.ReplicaID != replica.ReplicaID || permit.Status != "active" {
		return IPCResponse{Version: protocolVersion, Code: "workspace_not_ready", Message: "The local execution permit is not active."}
	}
	bundle, err := d.buildPIBundle(replica, permit, input)
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "pi_bundle_invalid", Message: err.Error()}
	}
	canonical, err := CanonicalJSON(mustJSON(bundle))
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "pi_bundle_invalid", Message: err.Error()}
	}
	eventID := uuid.NewString()
	var bundleID string
	if value, ok := bundle["bundleId"].(string); ok {
		bundleID = value
	}
	sequence, err := d.state.AppendSpool(eventID, mustJSON(spoolEnvelope{
		Kind:               "bundle",
		Version:            protocolVersion,
		EventID:            eventID,
		SpaceID:            replica.SpaceID,
		ReplicaID:          replica.ReplicaID,
		ExecutionAttemptID: input.ExecutionAttemptID,
		Bundle:             canonical,
	}))
	if err != nil {
		return IPCResponse{Version: protocolVersion, Code: "spool_failed", Message: err.Error()}
	}
	return IPCResponse{
		Version:            protocolVersion,
		OK:                 true,
		EventID:            eventID,
		LocalReceiptSeq:    sequence,
		ExecutionAttemptID: input.ExecutionAttemptID,
		SpaceID:            replica.SpaceID,
		ReplicaID:          replica.ReplicaID,
		Data:               map[string]any{"bundleId": bundleID},
	}
}

func (d *Daemon) buildPIBundle(replica *ReplicaState, permit *PermitContext, input piCollectorInput) (map[string]any, error) {
	providerVersion := firstNonEmpty(input.ProviderVersion, "unknown")
	if replica.MirrorMode == "full" && !piTranscriptVersionSupported(providerVersion) {
		return nil, fmt.Errorf("unsupported Pi transcript version %q; full mirror requires %s", providerVersion, supportedPITranscriptVersion)
	}
	identity := d.identityKey()
	nativeSessionKey := NativeSessionKey(identity, replica.SpaceID, replica.ReplicaID, "pi", "pi-agent", input.NativeSessionID)
	nativeTurnKey := NativeTurnKey(identity, replica.SpaceID, replica.ReplicaID, "pi", input.NativeTurnID)
	history := make([]any, 0, len(input.Messages)+1)
	if replica.MirrorMode == "full" {
		history = append(history, map[string]any{
			"nativeMessageKey": NativeMessageKey(identity, replica.SpaceID, replica.ReplicaID, "pi", input.NativeTurnID+"\x00user"),
			"role":             "user",
			"content":          []any{map[string]any{"type": "text", "text": input.Prompt}},
			"occurredAt":       time.Now().UTC().Format(time.RFC3339Nano),
		})
		for index, message := range input.Messages {
			converted, err := d.convertPIMessage(replica, identity, input.NativeTurnID, index, message)
			if err != nil {
				return nil, err
			}
			if converted != nil {
				history = append(history, converted)
			}
		}
		assistantCount := 0
		for _, entry := range history {
			if record, ok := entry.(map[string]any); ok && record["role"] == "assistant" {
				assistantCount++
			}
		}
		if assistantCount == 0 {
			return nil, errors.New("Pi turn has no finalized assistant message")
		}
	}
	now := time.Now().UTC()
	promptEvent := d.piBundleEvent(replica, permit, nativeSessionKey, nativeTurnKey, providerVersion, "prompt_submitted", input.Prompt, 0, now)
	stopEvent := d.piBundleEvent(replica, permit, nativeSessionKey, nativeTurnKey, providerVersion, "turn_stopped", "", 1, now)
	return map[string]any{
		"version":                  1,
		"executionAttemptId":       input.ExecutionAttemptID,
		"workspacePolicyVersion":   replica.PolicyVersion,
		"integrationPolicyVersion": replica.IntegrationPolicyVersion,
		"sessionMirrorMode":        replica.MirrorMode,
		"bundleId":                 ScopedIdentity(identity, "bundle", "pi", scopedUploadIdentity(replica.SpaceID, replica.ReplicaID, input.ExecutionAttemptID+"\x00"+nativeTurnKey)),
		"provider":                 "pi",
		"providerVersion":          providerVersion,
		"adapterVersion":           "locald-pi-v1",
		"nativeSessionKey":         nativeSessionKey,
		"nativeTurnKey":            nativeTurnKey,
		"previousNativeCursor":     nil,
		"nextNativeCursor": map[string]any{
			"turn":        nativeTurnKey,
			"completedAt": now.Format(time.RFC3339Nano),
		},
		"cohubTranscriptBase": nil,
		"workspaceExecutionBase": map[string]any{
			"executionAttemptId":  input.ExecutionAttemptID,
			"canonicalSnapshotId": nullableString(permit.BaseSnapshotID),
			"localSnapshotId":     nullableString(replica.AppliedSnapshotID),
			"leaseEpoch":          nullableInt(permit.LeaseEpoch),
		},
		"events":       []any{promptEvent, stopEvent},
		"historyDelta": history,
		"fidelityHint": "exact",
		"diagnostics": map[string]any{
			"collector":          "pi_extension",
			"sourceMessageCount": len(input.Messages),
		},
	}, nil
}

func piTranscriptVersionSupported(value string) bool {
	for _, field := range strings.FieldsFunc(value, func(r rune) bool {
		return !(r >= '0' && r <= '9') && r != '.'
	}) {
		if field == supportedPITranscriptVersion {
			return true
		}
	}
	return false
}

func (d *Daemon) piBundleEvent(replica *ReplicaState, permit *PermitContext, sessionKey, turnKey, providerVersion, eventType, prompt string, sequence int64, observedAt time.Time) map[string]any {
	payload := map[string]any{}
	if prompt != "" {
		payload["prompt"] = prompt
	}
	return map[string]any{
		"version":                  1,
		"executionAttemptId":       permit.ExecutionAttemptID,
		"eventId":                  uuid.NewString(),
		"observedAt":               observedAt.Format(time.RFC3339Nano),
		"deviceId":                 replica.DeviceID,
		"replicaId":                replica.ReplicaID,
		"provider":                 "pi",
		"providerVersion":          providerVersion,
		"adapterVersion":           "locald-pi-v1",
		"identityKeyVersion":       1,
		"workspacePolicyVersion":   replica.PolicyVersion,
		"integrationPolicyVersion": replica.IntegrationPolicyVersion,
		"sessionMirrorMode":        replica.MirrorMode,
		"nativeSessionKey":         sessionKey,
		"nativeTurnKey":            turnKey,
		"nativeEventSequence":      sequence,
		"localReceiptSequence":     sequence,
		"type":                     eventType,
		"workspace": map[string]any{
			"relativeCwd":             ".",
			"baseCanonicalSnapshotId": nullableString(permit.BaseSnapshotID),
			"localSnapshotId":         nullableString(replica.AppliedSnapshotID),
			"leaseEpoch":              nullableInt(permit.LeaseEpoch),
		},
		"payload": payload,
	}
}

func (d *Daemon) convertPIMessage(replica *ReplicaState, identity []byte, nativeTurnID string, index int, message map[string]any) (map[string]any, error) {
	role, _ := message["role"].(string)
	if role == "user" || role == "system" || role == "developer" || role == "custom" || role == "notification" {
		return nil, nil
	}
	rawMessageID := firstPayloadString(message, "id", "messageId", "responseId")
	if rawMessageID == "" {
		rawMessageID = fmt.Sprintf("%s:%d", nativeTurnID, index)
	}
	messageKey := NativeMessageKey(identity, replica.SpaceID, replica.ReplicaID, "pi", rawMessageID)
	occurredAt := piTimestamp(message["timestamp"])
	switch role {
	case "assistant":
		content, toolCalls, err := d.convertPIContent(replica, identity, message["content"], true)
		if err != nil {
			return nil, err
		}
		result := map[string]any{
			"nativeMessageKey": messageKey,
			"role":             "assistant",
			"content":          content,
			"occurredAt":       occurredAt,
		}
		if len(toolCalls) > 0 {
			result["toolCalls"] = toolCalls
		}
		if usage := piUsage(message["usage"]); len(usage) > 0 {
			result["usage"] = usage
		}
		return result, nil
	case "toolResult":
		rawToolID := firstPayloadString(message, "toolCallId", "tool_call_id")
		if rawToolID == "" {
			return nil, errors.New("Pi tool result has no tool call id")
		}
		content, _, err := d.convertPIContent(replica, identity, message["content"], false)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"nativeMessageKey":  messageKey,
			"role":              "tool_result",
			"content":           []any{},
			"nativeToolCallKey": NativeToolKey(identity, replica.SpaceID, replica.ReplicaID, "pi", rawToolID),
			"occurredAt":        occurredAt,
			"toolResult": map[string]any{
				"isError": booleanValue(message["isError"]),
				"content": content,
			},
		}, nil
	case "compactionSummary":
		summary, _ := message["summary"].(string)
		if strings.TrimSpace(summary) == "" {
			return nil, nil
		}
		return map[string]any{
			"nativeMessageKey": messageKey,
			"role":             "compaction",
			"content":          []any{map[string]any{"type": "text", "text": summary}},
			"occurredAt":       occurredAt,
		}, nil
	default:
		return nil, nil
	}
}

func (d *Daemon) convertPIContent(replica *ReplicaState, identity []byte, value any, allowTools bool) ([]any, []any, error) {
	items, ok := value.([]any)
	if !ok {
		if text, ok := value.(string); ok {
			return []any{map[string]any{"type": "text", "text": text}}, nil, nil
		}
		return []any{}, nil, nil
	}
	content := make([]any, 0, len(items))
	toolCalls := make([]any, 0)
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		typeName, _ := record["type"].(string)
		switch typeName {
		case "text":
			text, _ := record["text"].(string)
			content = append(content, map[string]any{"type": "text", "text": text})
		case "thinking":
			thinking, _ := record["thinking"].(string)
			content = append(content, map[string]any{"type": "thinking", "text": thinking})
		case "image":
			content = append(content, map[string]any{"type": "image"})
		case "toolCall":
			if !allowTools {
				continue
			}
			rawID := firstPayloadString(record, "id", "toolCallId")
			name := firstPayloadString(record, "name", "toolName")
			if rawID == "" || name == "" {
				return nil, nil, errors.New("Pi tool call identity is incomplete")
			}
			arguments := map[string]any{}
			if raw, ok := record["arguments"].(map[string]any); ok {
				clean, err := sanitizeValue(raw, 0)
				if err != nil {
					return nil, nil, err
				}
				arguments, _ = clean.(map[string]any)
			}
			toolCalls = append(toolCalls, map[string]any{
				"nativeToolCallKey": NativeToolKey(identity, replica.SpaceID, replica.ReplicaID, "pi", rawID),
				"name":              name,
				"arguments":         arguments,
			})
		}
	}
	return content, toolCalls, nil
}

func piTimestamp(value any) string {
	switch typed := value.(type) {
	case float64:
		return time.UnixMilli(int64(typed)).UTC().Format(time.RFC3339Nano)
	case int64:
		return time.UnixMilli(typed).UTC().Format(time.RFC3339Nano)
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func piUsage(value any) map[string]float64 {
	record, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	result := map[string]float64{}
	for _, key := range []string{"input", "output", "cacheRead", "cacheWrite", "totalTokens"} {
		if number, ok := record[key].(float64); ok && number >= 0 {
			result[key] = number
		}
	}
	return result
}

func booleanValue(value any) bool {
	result, _ := value.(bool)
	return result
}
