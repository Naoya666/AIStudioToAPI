package aistudio

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"aistudio-to-api/local-engine/internal/waa"
)

// TestVMRefreshSharedAndIndependentOfRequest uses an offline challenge so the
// refresh lifecycle is exercised without Google credentials or network access.
func TestVMRefreshSharedAndIndependentOfRequest(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	source := `window.fixture={a:function(program,ready){ready(function(deliver,opts){deliver("!renewed")},function(){})}}`
	challenge, err := json.Marshal([]any{[]any{"fixture", []string{source}, nil, waa.InterpreterHash([]byte(source)), "fixture", "fixture", nil, ""}})
	if err != nil {
		t.Fatal(err)
	}
	session := fixtureSession(t, "refresh", func(req *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			close(entered)
		}
		select {
		case <-release:
			return response(200, string(challenge)), nil
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	})
	r := session.runtime
	r.profile = waa.Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"}
	r.vmExpires = time.Now().Add(-time.Second)
	r.vmMu.Lock()
	first := r.refreshVM()
	second := r.refreshVM()
	r.vmMu.Unlock()
	if first != second {
		t.Fatal("concurrent callers started separate refreshes")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("refresh did not start")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.Proof(ctx, "digest", "prompt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter: %v", err)
	}
	select {
	case <-first.done:
		t.Fatal("request cancellation ended shared refresh")
	default:
	}
	close(release)
	select {
	case <-first.done:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not finish")
	}
	if first.err != nil {
		t.Fatal(first.err)
	}
	proof, err := r.Proof(context.Background(), "digest", "prompt")
	if err != nil || proof != "!renewed" {
		t.Fatalf("refreshed proof: %q %v", proof, err)
	}
	r.refreshExpiredVM() // An old timer callback must not replace the fresh VM.
	if calls.Load() != 1 {
		t.Fatalf("duplicate Waa/Create calls: %d", calls.Load())
	}
	r.vmMu.Lock()
	defer r.vmMu.Unlock()
	if r.refreshing != nil {
		t.Fatal("old timer started another refresh")
	}
}

func TestCloseCancelsVMRefresh(t *testing.T) {
	entered := make(chan struct{})
	session := fixtureSession(t, "refresh-close", func(req *http.Request) (*http.Response, error) {
		close(entered)
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	r := session.runtime
	r.vmMu.Lock()
	refresh := r.refreshVM()
	r.vmMu.Unlock()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("refresh did not start")
	}
	r.Close()
	select {
	case <-refresh.done:
	case <-time.After(time.Second):
		t.Fatal("close did not cancel refresh")
	}
	if refresh.err == nil {
		t.Fatal("closed runtime accepted a refreshed VM")
	}
	r.refreshExpiredVM()
	r.vmMu.Lock()
	defer r.vmMu.Unlock()
	if r.refreshing != nil || r.vm != nil {
		t.Fatal("closed runtime was revived")
	}
}

func TestVMRefreshFailureKeepsOldVMAndAllowsRecovery(t *testing.T) {
	var calls atomic.Int32
	source := `window.fixture={a:function(program,ready){ready(function(deliver){deliver("!recovered")},function(){})}}`
	challenge, _ := json.Marshal([]any{[]any{"fixture", []string{source}, nil, waa.InterpreterHash([]byte(source)), "fixture", "fixture", nil, ""}})
	session := fixtureSession(t, "refresh-retry", func(req *http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			return response(503, "temporarily unavailable"), nil
		}
		return response(200, string(challenge)), nil
	})
	r := session.runtime
	r.profile = waa.Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"}
	previous := r.vm
	r.vmExpires = time.Now().Add(-time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := r.Proof(ctx, "digest", "prompt"); err == nil {
		t.Fatal("failed refresh was hidden")
	}
	if r.vm != previous || r.refreshing != nil {
		t.Fatal("failed refresh discarded VM or retained refresh ownership")
	}
	proof, err := r.Proof(ctx, "digest", "prompt")
	if err != nil || proof != "!recovered" {
		t.Fatalf("refresh recovery: %q %v", proof, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("Waa/Create calls: %d", calls.Load())
	}
}
