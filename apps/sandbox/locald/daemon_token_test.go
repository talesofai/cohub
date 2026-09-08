package locald

import (
	"sync"
	"testing"
)

func TestSetAccessTokenUpdatesExplicitTokenSafely(t *testing.T) {
	daemon := &Daemon{cfg: Config{AccessToken: "initial-token"}}

	const readers = 32
	var group sync.WaitGroup
	group.Add(readers + 1)
	go func() {
		defer group.Done()
		for index := 0; index < readers; index++ {
			daemon.setAccessToken("refreshed-token")
		}
	}()
	for index := 0; index < readers; index++ {
		go func() {
			defer group.Done()
			for attempt := 0; attempt < readers; attempt++ {
				token, err := daemon.accessToken()
				if err != nil {
					t.Errorf("accessToken() returned error: %v", err)
					return
				}
				if token != "initial-token" && token != "refreshed-token" {
					t.Errorf("accessToken() returned unexpected token %q", token)
					return
				}
			}
		}()
	}
	group.Wait()

	token, err := daemon.accessToken()
	if err != nil {
		t.Fatalf("accessToken() returned error after update: %v", err)
	}
	if token != "refreshed-token" {
		t.Fatalf("accessToken() = %q, want refreshed-token", token)
	}
}
