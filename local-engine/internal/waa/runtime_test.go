package waa

import (
	"aistudio-to-api/local-engine/internal/waa/mozjs"
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

func TestCanceledSnapshotReleasesPendingDelivery(t *testing.T) {
	vm, err := NewRuntime(context.Background(), Options{Challenge: Challenge{Program: "fixture", GlobalName: "fixture"}, Interpreter: `window.fixture={a:function(program,ready){ready(function(deliver,opts){},function(){})}}`, Profile: Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"}})
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := vm.Proof(ctx, "fixture-digest", "prompt"); err == nil {
		t.Fatal("snapshot did not time out")
	}
	pending := make(chan int, 1)
	vm.loop.post(func() { pending <- len(vm.results) })
	select {
	case n := <-pending:
		if n != 0 {
			t.Fatalf("retained %d canceled deliveries", n)
		}
	case <-time.After(time.Second):
		t.Fatal("event loop did not settle")
	}
}
func TestMain(m *testing.M) {
	code := m.Run()
	if !mozjs.Shutdown() {
		code = 1
	}
	os.Exit(code)
}

func TestTimedOutInterpreterInitializationDestroysNativeContext(t *testing.T) {
	before := mozjs.ContextCount()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	vm, err := NewRuntime(ctx, Options{Challenge: Challenge{Program: "fixture", GlobalName: "fixture"}, Interpreter: `while(true){}`, Profile: Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"}})
	if err == nil {
		vm.Close()
		t.Fatal("runaway interpreter was accepted")
	}
	if mozjs.ContextCount() != before {
		t.Fatal("canceled initializer retained a native context")
	}
}

func TestSettleWaitsForResourcesStartedByLoadHandlers(t *testing.T) {
	second, release := make(chan struct{}), make(chan struct{})
	vm, err := NewRuntime(context.Background(), Options{
		Challenge:   Challenge{Program: "fixture", GlobalName: "fixture"},
		Interpreter: `window.fixture={a:function(program,ready){var first=new Image();first.onload=function(){var next=new Image();next.src="https://www.google.com/second"};first.src="https://www.google.com/first";ready(function(deliver){deliver("!fixture")},function(){})}}`,
		Profile:     Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"},
		LoadImage: func(address string) bool {
			if address == "https://www.google.com/second" {
				close(second)
				<-release
			}
			return true
		},
	})
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	defer vm.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- vm.Settle(ctx) }()
	select {
	case <-second:
	case <-ctx.Done():
		t.Fatal("load handler did not start follow-up resource")
	}
	select {
	case err := <-done:
		t.Fatalf("settled before follow-up resource: %v", err)
	default:
	}
	// Closing a runtime with pending resources must wake Settle too.
	vm.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed runtime settled successfully")
		}
	case <-ctx.Done():
		t.Fatal("Settle remained blocked after close")
	}
}

func TestFatalDecoderRejectsInvalidBytesAlongsideReplacementCharacter(t *testing.T) {
	for _, tc := range []struct {
		name           string
		valid, invalid []byte
	}{
		{"utf-8", []byte("�"), append([]byte("�"), 0xff)},
		{"utf-16le", []byte{0xfd, 0xff}, []byte{0xfd, 0xff, 0x00, 0xd8}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeText(tc.name, tc.valid, true); err != nil {
				t.Fatalf("valid U+FFFD rejected: %v", err)
			}
			if _, err := decodeText(tc.name, tc.invalid, true); err == nil {
				t.Fatal("invalid input hidden by valid U+FFFD")
			}
			if _, err := decodeText(tc.name, tc.invalid, false); err != nil {
				t.Fatalf("non-fatal decode failed: %v", err)
			}
		})
	}
}

func TestSettleCompletesAfterChainedResources(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	started := make(chan struct{})
	vm, err := NewRuntime(context.Background(), Options{
		Challenge:   Challenge{Program: "fixture", GlobalName: "fixture"},
		Interpreter: `window.fixture={a:function(program,ready){var first=new Image();first.onload=function(){var second=new Image();second.src="https://www.google.com/second"};first.src="https://www.google.com/first";ready(function(deliver){deliver("!fixture")},function(){})}}`,
		Profile:     Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"},
		LoadImage: func(address string) bool {
			if address == "https://www.google.com/second" {
				close(started)
				<-release
			}
			return true
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer vm.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("follow-up load not started")
	}
	done := make(chan error, 1)
	go func() { done <- vm.Settle(ctx) }()
	releaseOnce.Do(func() { close(release) })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	proof, err := vm.Proof(ctx, "digest", "prompt")
	if err != nil || proof != "!fixture" {
		t.Fatalf("proof after settle: %q %v", proof, err)
	}
}

func TestConcurrentTimerRegistrationAndClose(t *testing.T) {
	loop := newEventLoop()
	defer loop.close()
	const count = 1000
	jobs := make(chan struct{}, count)
	var registrations sync.WaitGroup
	for range count {
		registrations.Go(func() { loop.schedule(time.Nanosecond, func() { jobs <- struct{}{} }) })
	}
	registrations.Wait()
	deadline := time.After(2 * time.Second)
	for range count {
		select {
		case <-jobs:
		case <-deadline:
			t.Fatal("timer callback lost")
		}
	}
	loop.mu.Lock()
	retained := len(loop.timers)
	loop.mu.Unlock()
	if retained != 0 {
		t.Fatalf("retained %d fired timers", retained)
	}
	for range count {
		registrations.Go(func() { loop.schedule(time.Millisecond, func() {}) })
	}
	loop.close()
	registrations.Wait()
	loop.mu.Lock()
	defer loop.mu.Unlock()
	if len(loop.timers) != 0 {
		t.Fatal("registered timers after close")
	}
}
