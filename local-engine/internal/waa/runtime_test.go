package waa

import (
	"aistudio-to-api/local-engine/internal/waa/mozjs"
	"context"
	"os"
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
