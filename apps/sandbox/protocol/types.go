package protocol

import "encoding/json"

const Version = "1"

type BaseMessage struct {
	Version   string `json:"version"`
	Type      string `json:"type"`
	SpaceID   string `json:"spaceId"`
	SandboxID string `json:"sandboxId"`
	Timestamp int64  `json:"timestamp"`
}

type RequestScopedMessage struct {
	BaseMessage
	RequestID  string  `json:"requestId"`
	SessionID  *string `json:"sessionId,omitempty"`
	ToolCallID *string `json:"toolCallId,omitempty"`
}

type OperationScopedMessage struct {
	BaseMessage
	OpID       string  `json:"opId"`
	RequestID  string  `json:"requestId"`
	Seq        int64   `json:"seq"`
	SessionID  *string `json:"sessionId,omitempty"`
	ToolCallID *string `json:"toolCallId,omitempty"`
}

type SandboxFilesystemRoot struct {
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
	Label    string `json:"label,omitempty"`
}

type SandboxFilesystem struct {
	Roots      []SandboxFilesystemRoot `json:"roots"`
	DefaultCwd string                  `json:"defaultCwd"`
	Mode       string                  `json:"mode,omitempty"`
	Notes      []string                `json:"notes,omitempty"`
}

type SandboxCapabilities struct {
	FSRead       bool `json:"fsRead"`
	FSWrite      bool `json:"fsWrite"`
	FSStat       bool `json:"fsStat"`
	FSLs         bool `json:"fsLs"`
	FSFind       bool `json:"fsFind"`
	FSGrep       bool `json:"fsGrep"`
	ProcessStart bool `json:"processStart"`
	ProcessAbort bool `json:"processAbort"`
}

type SandboxProcessStats struct {
	ActiveProcesses        int   `json:"activeProcesses,omitempty"`
	StartedTotal           int64 `json:"startedTotal,omitempty"`
	CompletedTotal         int64 `json:"completedTotal,omitempty"`
	AbortedTotal           int64 `json:"abortedTotal,omitempty"`
	TimedOutTotal          int64 `json:"timedOutTotal,omitempty"`
	IdentityCleanupTotal   int64 `json:"identityCleanupTotal,omitempty"`
	ForceKilledTotal       int64 `json:"forceKilledTotal,omitempty"`
	TerminateFailuresTotal int64 `json:"terminateFailuresTotal,omitempty"`
}

type SandboxHealthStats struct {
	ZombieProcessCount int `json:"zombieProcessCount,omitempty"`
	AttachedSessions   int `json:"attachedSessions,omitempty"`
}

type SandboxSetupInfo struct {
	Ran      bool   `json:"ran"`
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Duration string `json:"duration"`
	Error    string `json:"error,omitempty"`
}

type SandboxMetadata struct {
	Hostname     string               `json:"hostname,omitempty"`
	ImageVersion string               `json:"imageVersion,omitempty"`
	StartedAt    string               `json:"startedAt,omitempty"`
	Process      *SandboxProcessStats `json:"process,omitempty"`
	Health       *SandboxHealthStats  `json:"health,omitempty"`
	Setup        *SandboxSetupInfo    `json:"setup,omitempty"`
}

type SandboxHeartbeat struct {
	BaseMessage
	Status       string              `json:"status"`
	Capabilities SandboxCapabilities `json:"capabilities,omitempty"`
	Filesystem   *SandboxFilesystem  `json:"filesystem,omitempty"`
	Metadata     *SandboxMetadata    `json:"metadata,omitempty"`
}

type WorkspaceFSChanged struct {
	BaseMessage
	EventID string `json:"eventId"`
	Count   int    `json:"count"`
}

type SessionAttach struct {
	BaseMessage
	RequestID string `json:"requestId"`
	Identity  string `json:"identity"`
}

type SessionAttachOK struct {
	BaseMessage
	RequestID    string `json:"requestId"`
	ConnectionID string `json:"connectionId"`
	Identity     string `json:"identity"`
}

type RPCRequest struct {
	RequestScopedMessage
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type RPCAccepted struct {
	RequestScopedMessage
	OpID string `json:"opId"`
}

type RPCCompleted struct {
	OperationScopedMessage
	Result interface{} `json:"result"`
}

type RPCErrorPayload struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type RPCFailed struct {
	OperationScopedMessage
	Error RPCErrorPayload `json:"error"`
}

type RPCEventPayload struct {
	Type      string `json:"type"`
	ProcessID string `json:"processId,omitempty"`
	Chunk     string `json:"chunk,omitempty"`
	ExitCode  *int   `json:"exitCode,omitempty"`
}

type RPCEvent struct {
	OperationScopedMessage
	Event RPCEventPayload `json:"event"`
}

type IncomingEnvelope struct {
	Type string `json:"type"`
}
