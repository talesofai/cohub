// Package relay implements the local sandbox dial-out client. In local mode the
// sandbox cannot be reached directly (it lives behind the user's NAT), so it
// dials out to the gateway relay and keeps a long-lived control connection. The
// gateway asks it, over that control channel, to open additional data channels;
// each data channel is then served with the exact same agent-sandbox protocol
// used by the cloud listener, so no agent/protocol changes are required.
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// SessionServer is satisfied by ws.Server; it serves one protocol session over a
// dialed-out connection and blocks until that connection ends.
type SessionServer interface {
	ServeDialedConn(ctx context.Context, conn *websocket.Conn, remote string)
}

// TokenProvider supplies a current bearer token for a control or data dial.
// It is useful for long-lived local runtimes whose short-lived access token can
// rotate while the relay connection remains alive.
type TokenProvider func(context.Context) (string, error)

// Options configures the relay client.
type Options struct {
	// RelayURL is the gateway control endpoint, e.g.
	// wss://gateway.cohub.live/sandbox/relay or wss://gateway.cohub.live/runtime/relay.
	RelayURL string
	// Token is the user's/device access token, used by the gateway to authorize
	// the caller against the target space or registered runtime.
	Token string
	// SpaceID identifies the space this sandbox serves. Runtime mode also uses
	// this for routing and authorization.
	SpaceID string
	// Kind selects the registration namespace. The default is sandbox.
	Kind string
	// RuntimeID identifies a registered local ACP runtime when Kind is runtime.
	RuntimeID string
	// Provider is recorded by the gateway for runtime registrations.
	Provider string
	// Server serves each opened legacy sandbox data channel.
	Server SessionServer
	// RuntimeServer serves each opened ACP data channel.
	RuntimeServer SessionServer
	// TokenProvider refreshes or loads a current token before each dial. When
	// absent, Token is used as-is for backwards compatibility with sandboxes.
	TokenProvider TokenProvider
	OnRegistered  func()
	Logger        *slog.Logger
}

// control frames exchanged on the control channel. Kept intentionally small and
// separate from the agent-sandbox protocol carried on data channels. The
// Payload field carries watcher events (fs.changed / ports.changed) that the
// gateway republishes to space subscribers, so the web file tree stays live
// even when no agent is attached.
type controlFrame struct {
	Type      string          `json:"type"`
	Kind      string          `json:"kind,omitempty"`
	SpaceID   string          `json:"spaceId,omitempty"`
	RuntimeID string          `json:"runtimeId,omitempty"`
	Provider  string          `json:"provider,omitempty"`
	Channel   string          `json:"channel,omitempty"`
	Protocol  string          `json:"protocol,omitempty"`
	Message   string          `json:"message,omitempty"`
	Status    int             `json:"status,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

const (
	controlPingInterval = 20 * time.Second
	dialTimeout         = 15 * time.Second
	configRetryDelay    = 5 * time.Minute
)

var reconnectDelays = []time.Duration{
	250 * time.Millisecond,
	time.Second,
	2 * time.Second,
	5 * time.Second,
	10 * time.Second,
	30 * time.Second,
}

// Client maintains the control connection and lets the runtime publish watcher
// events over it. The zero value is not usable; construct with NewClient.
type Client struct {
	opts Options
	mu   sync.Mutex
	conn *websocket.Conn // active control connection, nil when disconnected
}

type relayConfigError struct {
	status int
	err    error
}

func (e *relayConfigError) Error() string {
	return fmt.Sprintf("relay configuration rejected with HTTP %d: %v", e.status, e.err)
}

func (e *relayConfigError) Unwrap() error {
	return e.err
}

func NewClient(opts Options) *Client {
	return &Client{opts: opts}
}

// SetServer sets the session server used to serve opened data channels. It must
// be called before Run when the client is constructed without Options.Server.
func (c *Client) SetServer(server SessionServer) {
	c.opts.Server = server
}

// PublishEvent sends a watcher event (fs.changed / ports.changed) over the
// active control connection. It is a no-op (drops the event) when the control
// connection is down; the gateway/web recover via the watcher's resync frame
// on reconnect. Safe for concurrent use.
func (c *Client) PublishEvent(eventType string, payload interface{}) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		c.opts.Logger.Warn("relay marshal event failed", slog.String("type", eventType), slog.String("error", err.Error()))
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, conn, controlFrame{Type: eventType, SpaceID: c.opts.SpaceID, Payload: raw}); err != nil {
		c.opts.Logger.Debug("relay publish event failed", slog.String("type", eventType), slog.String("error", err.Error()))
	}
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
}

// Run maintains the control connection, reconnecting with backoff until ctx is
// cancelled. It never returns until ctx is done.
func (c *Client) Run(ctx context.Context) {
	opts := c.opts
	attempt := 0
	for {
		if ctx.Err() != nil {
			return
		}
		start := time.Now()
		err := c.connectControl(ctx)
		if err != nil && ctx.Err() == nil {
			opts.Logger.Warn("relay control connection ended", slog.String("error", err.Error()))
		}
		// A connection that stayed up for a while resets the backoff.
		if time.Since(start) > time.Minute {
			attempt = 0
		}
		if ctx.Err() != nil {
			return
		}
		delay := reconnectDelays[min(attempt, len(reconnectDelays)-1)]
		var configErr *relayConfigError
		if errors.As(err, &configErr) {
			delay = configRetryDelay
		} else {
			delay = delay/2 + time.Duration(rand.Int63n(int64(delay/2)+1))
		}
		attempt++
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}

// Run maintains the control connection using a throwaway client. Retained for
// call sites that do not need to publish events.
func Run(ctx context.Context, opts Options) {
	NewClient(opts).Run(ctx)
}

func (c *Client) connectControl(ctx context.Context) error {
	opts := c.opts
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()

	token, err := c.currentToken(dialCtx)
	if err != nil {
		return err
	}
	conn, response, err := websocket.Dial(dialCtx, controlURL(opts.RelayURL), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		if response != nil && (response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden) {
			return &relayConfigError{status: response.StatusCode, err: err}
		}
		return fmt.Errorf("dial control: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "closing")
	// Allow larger control frames so batched watcher events fit (the gateway
	// caps this side too). Data channels keep their own larger limit.
	conn.SetReadLimit(1024 * 1024)

	kind := opts.Kind
	if kind == "" {
		kind = "sandbox"
	}
	if err := wsjson.Write(ctx, conn, controlFrame{
		Type:      "register",
		Kind:      kind,
		SpaceID:   opts.SpaceID,
		RuntimeID: opts.RuntimeID,
		Provider:  opts.Provider,
	}); err != nil {
		return fmt.Errorf("send register: %w", err)
	}

	ctx, cancelLoop := context.WithCancel(ctx)
	defer cancelLoop()
	c.setConn(conn)
	defer c.setConn(nil)
	pingErr := make(chan error, 1)
	go controlPingLoop(ctx, conn, cancelLoop, pingErr)

	for {
		var frame controlFrame
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			select {
			case err := <-pingErr:
				return fmt.Errorf("ping control: %w", err)
			default:
				return fmt.Errorf("read control: %w", err)
			}
		}
		switch frame.Type {
		case "registered":
			opts.Logger.Info("relay registered", slog.String("spaceId", opts.SpaceID))
			if opts.OnRegistered != nil {
				opts.OnRegistered()
			}
		case "open":
			if frame.Channel == "" {
				opts.Logger.Warn("relay open without channel id")
				continue
			}
			go c.openDataChannel(ctx, opts, frame.Channel, frame.Protocol, token)
		case "error":
			err := fmt.Errorf("relay rejected connection: %s", frame.Message)
			if frame.Status == 0 || (frame.Status >= 400 && frame.Status < 500) {
				return &relayConfigError{status: frame.Status, err: err}
			}
			return err
		case "ping":
			_ = wsjson.Write(ctx, conn, controlFrame{Type: "pong"})
		case "pong":
			// keepalive ack
		default:
			opts.Logger.Warn("unknown control frame", slog.String("type", frame.Type))
		}
	}
}

func controlPingLoop(ctx context.Context, conn *websocket.Conn, cancel context.CancelFunc, result chan<- error) {
	ticker := time.NewTicker(controlPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := wsjson.Write(ctx, conn, controlFrame{Type: "ping"}); err != nil {
				select {
				case result <- err:
				default:
				}
				cancel()
				return
			}
		}
	}
}

// openDataChannel dials a fresh data connection for the given channel id and
// serves it with the standard protocol. Each channel is independent; the
// gateway pipes it transparently to one waiting cloud peer (agent, worker…).
func (c *Client) openDataChannel(ctx context.Context, opts Options, channel, protocol, token string) {
	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	if strings.TrimSpace(token) == "" {
		opts.Logger.Warn("relay data channel token unavailable", slog.String("channel", channel))
		return
	}
	conn, _, err := websocket.Dial(dialCtx, dataURL(opts.RelayURL, channel), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + token}},
	})
	cancel()
	if err != nil {
		opts.Logger.Warn("relay data channel dial failed", slog.String("channel", channel), slog.String("error", err.Error()))
		return
	}
	opts.Logger.Info("relay data channel opened", slog.String("channel", channel), slog.String("protocol", protocol))
	server := opts.Server
	if protocol == "acp" {
		server = opts.RuntimeServer
	}
	if server == nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "runtime server is unavailable")
		return
	}
	server.ServeDialedConn(ctx, conn, "relay:"+channel)
}

func (c *Client) currentToken(ctx context.Context) (string, error) {
	if c.opts.TokenProvider != nil {
		token, err := c.opts.TokenProvider(ctx)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(token) == "" {
			return "", errors.New("relay token provider returned an empty token")
		}
		return strings.TrimSpace(token), nil
	}
	if strings.TrimSpace(c.opts.Token) == "" {
		return "", errors.New("relay token is required")
	}
	return strings.TrimSpace(c.opts.Token), nil
}

func controlURL(base string) string {
	return strings.TrimRight(strings.TrimSpace(base), "/")
}

func dataURL(base, channel string) string {
	u, err := url.Parse(base)
	if err != nil {
		return fmt.Sprintf("%s/data?channel=%s", base, url.QueryEscape(channel))
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/data"
	q := u.Query()
	q.Set("channel", channel)
	u.RawQuery = q.Encode()
	return u.String()
}
