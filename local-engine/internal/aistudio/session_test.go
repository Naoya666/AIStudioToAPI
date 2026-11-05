package aistudio

import (
	"aistudio-to-api/local-engine/internal/waa"
	"aistudio-to-api/local-engine/internal/waa/mozjs"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Synthetic challenge for offline adapter tests. This is NOT a Google proof.
func fixtureSession(t *testing.T, identity string, send roundTripFunc) *Session {
	t.Helper()
	vm, err := waa.NewRuntime(context.Background(), waa.Options{Challenge: waa.Challenge{Program: "fixture", GlobalName: "fixture"}, Interpreter: `window.fixture={a:function(program,ready){ready(function(deliver,opts){deliver("!fixture:"+opts[0].content)},function(){})}}`, Profile: waa.Profile{PageURL: "https://aistudio.google.com/prompts/new_chat", Locale: "en-US", TimeZone: "UTC"}})
	if err != nil {
		t.Fatal(err)
	}
	r := &goWAARuntime{vm: vm, vmExpires: time.Now().Add(time.Hour), session: &sessionCookies{state: StorageState{Cookies: []StateCookie{{Name: "SAPISID", Value: identity, Domain: ".google.com", Path: "/", Expires: -1, Secure: true}, {Name: "__Secure-1PAPISID", Value: identity, Domain: ".google.com", Path: "/", Expires: -1, Secure: true}, {Name: "__Secure-3PAPISID", Value: identity, Domain: ".google.com", Path: "/", Expires: -1, Secure: true}}}}, client: &http.Client{Transport: send}, headers: http.Header{"X-Goog-Api-Key": {"fixture-key"}, "X-Goog-Authuser": {"2"}, "X-Aistudio-Visit-Id": {identity}}, userAgent: "fixture-firefox"}
	r.pageCatalog.Tier = []byte(`[1]`)
	s := &Session{runtime: r}
	t.Cleanup(func() { r.Close() })
	return s
}
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}
func TestProtectedFieldsIdentityAndNoRetry(t *testing.T) {
	for _, method := range []string{"GenerateContent", "CodeAssistantOffline"} {
		t.Run(method, func(t *testing.T) {
			count := 0
			s := fixtureSession(t, "account-A", func(r *http.Request) (*http.Response, error) {
				count++
				if r.URL.String() != makerSuiteRPCURL+method {
					t.Fatalf("unexpected URL %s", r.URL)
				}
				if !strings.Contains(r.Header.Get("Cookie"), "SAPISID=account-A") || r.Header.Get("X-Goog-Authuser") != "2" || r.Header.Get("X-AIStudio-G1-Tier") != "TIER1" || r.Header.Get("X-Aistudio-Visit-Id") != "account-A" || r.Header.Get("User-Agent") != "fixture-firefox" || !strings.Contains(r.Header.Get("Authorization"), "SAPISIDHASH") {
					t.Fatal("session headers inconsistent")
				}
				var b []any
				json.NewDecoder(r.Body).Decode(&b)
				hash := sha256.Sum256([]byte("附件 prompt"))
				want := fmt.Sprintf("!fixture:%x", hash)
				if b[proofIndex(method)] != want {
					t.Fatalf("wrong proof field/digest: %#v", b)
				}
				return response(403, `[7,"risk control"]`), nil
			})
			prompt := "prompt"
			body := make([]any, 8)
			body[1] = []any{[]any{[]any{[]any{nil, "附件"}, []any{nil, "prompt"}}, "user"}}
			if method == "CodeAssistantOffline" {
				body[0] = []any{[]any{[]any{[]any{nil, "附件"}, []any{nil, "prompt"}}, "user"}}
			}
			result, err := s.Send(context.Background(), Call{Method: method, Body: body, Binding: "附件 prompt", PagePrompt: &prompt})
			if err != nil {
				t.Fatal(err)
			}
			defer result.Body.Close()
			if result.StatusCode != 403 || count != 1 {
				t.Fatal("403 was retried or hidden")
			}
		})
	}
}
func TestCookieWarmupMergesAndKeepsProxyClient(t *testing.T) {
	var calls []string
	s := fixtureSession(t, "A", func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.URL.String())
		res := response(200, "ok")
		res.Header.Set("Set-Cookie", "__Secure-1PSIDTS=rotated; Domain=.google.com; Path=/; Secure; HttpOnly")
		return res, nil
	})
	s.runtime.authWarmup(context.Background())
	if len(calls) != 1 || !strings.HasPrefix(calls[0], "https://console.cloud.google.com/onboarding/auth_warmup?") {
		t.Fatal(calls)
	}
	cookie, ok := s.State().CookieValue("__Secure-1PSIDTS", "https://aistudio.google.com/", time.Now())
	if !ok || cookie != "rotated" {
		t.Fatal("rotated cookie not retained")
	}
}
func TestAccountConcurrencyIsolationAnd401(t *testing.T) {
	var group sync.WaitGroup
	for _, id := range []string{"account-A", "account-B"} {
		id := id
		s := fixtureSession(t, id, func(r *http.Request) (*http.Response, error) {
			if !strings.Contains(r.Header.Get("Cookie"), "SAPISID="+id) || r.Header.Get("X-Aistudio-Visit-Id") != id {
				t.Error("cross account state")
			}
			return response(401, `[16,"expired"]`), nil
		})
		for range 3 {
			group.Go(func() {
				r, err := s.Send(context.Background(), Call{Method: "CountTokens", Body: []any{}})
				if err != nil {
					t.Error(err)
					return
				}
				r.Body.Close()
				if r.StatusCode != 401 {
					t.Error("401 lost")
				}
			})
		}
	}
	group.Wait()
}
func TestCanceledTransportAndEndpointRestrictions(t *testing.T) {
	s := fixtureSession(t, "A", func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.Send(ctx, Call{Method: "CountTokens", Body: []any{}})
	if err == nil || time.Since(start) > time.Second {
		t.Fatal("cancellation not bounded")
	}
	for _, method := range []string{"https://example.com", "../GenerateContent", "GetSecret"} {
		if _, err := s.Send(context.Background(), Call{Method: method}); err == nil {
			t.Fatal("arbitrary RPC accepted")
		}
	}
	for _, raw := range []string{"http://google.com/", "https://google.com.evil.test/", "https://evil.test/", "https://user@google.com/", "https://google.com:8080/"} {
		u, _ := url.Parse(raw)
		if allowedGoogleURL(u) {
			t.Fatal(raw)
		}
	}
	if AllowedMethod("RotateCookies") {
		t.Fatal("arbitrary auth endpoint exposed")
	}
}

func TestMain(m *testing.M) {
	result := m.Run()
	if !mozjs.Shutdown() {
		result = 1
	}
	os.Exit(result)
}

func TestBuildLargeAttachmentUploadsBeforeProofAndSubmit(t *testing.T) {
	calls := []string{}
	s := fixtureSession(t, "upload-account", func(r *http.Request) (*http.Response, error) {
		calls = append(calls, r.URL.String())
		if !strings.Contains(r.Header.Get("Cookie"), "SAPISID=upload-account") || r.Header.Get("User-Agent") != "fixture-firefox" {
			t.Fatal("upload identity differs")
		}
		if r.URL.String() == aiStudioOrigin+"/_/upload" {
			res := response(200, "")
			res.Header.Set("X-Goog-Upload-URL", aiStudioOrigin+"/_/upload?fixture=1")
			return res, nil
		}
		if strings.HasPrefix(r.URL.String(), aiStudioOrigin+"/_/upload?") {
			if r.Header.Get("X-Goog-Upload-Command") != "upload, finalize" {
				t.Fatal("missing finalize")
			}
			return response(200, "uploaded/path"), nil
		}
		var body []any
		json.NewDecoder(r.Body).Decode(&body)
		proof := fmt.Sprintf("!fixture:%x", sha256.Sum256([]byte(" prompt")))
		if body[1] != proof {
			t.Fatal("Build bound a placeholder rather than final parts")
		}
		turn := body[0].([]any)[0].([]any)
		part := turn[0].([]any)[0].([]any)
		if part[17].([]any)[1] != "uploaded/path" {
			t.Fatal("upload reference lost")
		}
		return response(200, `["task"]`), nil
	})
	prompt := "prompt"
	body := make([]any, 8)
	body[0] = []any{[]any{[]any{map[string]any{"__upload": []any{"text/plain", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("附件", 100000))), "context.txt"}}, []any{nil, prompt}}, "user"}}
	result, err := s.Send(context.Background(), Call{Method: "CodeAssistantOffline", Body: body, PagePrompt: &prompt})
	if err != nil {
		t.Fatal(err)
	}
	result.Body.Close()
	if len(calls) != 3 || calls[2] != makerSuiteRPCURL+"CodeAssistantOffline" {
		t.Fatal(calls)
	}
}
func TestPlaygroundBindingIncludesMediaWhilePageUsesOnlyLastTurn(t *testing.T) {
	file := make([]any, 6)
	file[5] = []any{"drive-file"}
	body := []any{"models/test", []any{[]any{[]any{[]any{nil, "history"}}, "model"}, []any{[]any{[]any{nil, nil, []any{"image/png", "base64-data"}}, file, []any{nil, "prompt"}}, "user"}}}
	binding, page, err := playgroundProofInputs(body)
	if err != nil || binding != "history base64-data drive-file prompt" || page != "prompt" {
		t.Fatalf("unexpected binding/page: %q %q %v", binding, page, err)
	}
}

func TestDriveIdentityAndDynamicBearerStayInsideSession(t *testing.T) {
	calls := 0
	s := fixtureSession(t, "drive-account", func(r *http.Request) (*http.Response, error) {
		calls++
		if strings.HasSuffix(r.URL.Path, "/GenerateAccessToken") {
			return response(200, `["private-fixture-bearer"]`), nil
		}
		if r.Header.Get("Authorization") != "Bearer private-fixture-bearer" || r.Header.Get("Origin") != aiStudioOrigin || r.Header.Get("User-Agent") != "fixture-firefox" || r.Header.Get("Sec-Fetch-Site") != "cross-site" {
			t.Fatal("Drive identity/headers differ")
		}
		return response(200, "file"), nil
	})
	result, err := s.Drive(context.Background(), DriveOperation{Method: "GET", FileID: "fixture-file", Download: true})
	if err != nil {
		t.Fatal(err)
	}
	if result["data"] != base64.StdEncoding.EncodeToString([]byte("file")) || calls != 2 {
		t.Fatal("Drive protocol mismatch")
	}
}

func TestCompanionRequestIsCanceledWithOwningRequest(t *testing.T) {
	calls := 0
	s := fixtureSession(t, "companion-account", func(r *http.Request) (*http.Response, error) { calls++; return response(200, "[]"), nil })
	ctx, cancel := context.WithCancel(context.Background())
	ctx = withFollowUp(ctx, followUp{URL: makerSuiteRPCURL + "CountTokens", Body: []byte("[]"), Delay: 10 * time.Millisecond})
	response, err := s.runtime.SendProtected(ctx, makerSuiteRPCURL+"GenerateContent", http.Header{}, []byte("[]"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	cancel()
	time.Sleep(30 * time.Millisecond)
	if calls != 1 {
		t.Fatal("companion request survived cancellation")
	}
}
