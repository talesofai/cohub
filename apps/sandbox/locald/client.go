package locald

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

func SendRequest(ctx context.Context, cfg Config, request IPCRequest) (IPCResponse, error) {
	cfg = cfg.normalize()
	if request.Version == 0 {
		request.Version = protocolVersion
	}
	conn, err := dialEndpoint(ctx, cfg.SocketPath)
	if err != nil {
		return IPCResponse{}, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return IPCResponse{}, fmt.Errorf("write locald IPC request: %w", err)
	}
	var response IPCResponse
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&response); err != nil {
		return IPCResponse{}, fmt.Errorf("read locald IPC response: %w", err)
	}
	if !response.OK && response.Code != "unbound" {
		return response, errors.New(response.Message)
	}
	return response, nil
}
