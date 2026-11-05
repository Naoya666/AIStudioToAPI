package main

import (
	"aistudio-to-api/local-engine/internal/aistudio"
	"aistudio-to-api/local-engine/internal/camoufoxnative"
	"aistudio-to-api/local-engine/internal/waa/mozjs"

	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	_ "time/tzdata"
)

type pool struct {
	mu       sync.RWMutex
	sessions map[string]*aistudio.Session
	pending  map[string]bool
	root     string
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	status, kind := 503, "local_engine"
	if errors.Is(err, camoufoxnative.ErrAuthenticationRequired) {
		kind = "local_credentials_incomplete"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		status = 504
	}
	if errors.Is(err, context.Canceled) {
		status = 499
	}
	var proof *aistudio.LocalProofError
	if errors.As(err, &proof) {
		kind = "local_waa"
	}
	var expired *aistudio.SessionExpiredError
	if errors.As(err, &expired) {
		status = 401
		kind = "session_expired"
	}
	var rpc *aistudio.RPCError
	if errors.As(err, &rpc) {
		status = rpc.StatusCode
		kind = "google_http"
	}
	reply(w, status, map[string]any{"kind": kind, "message": "Local engine operation failed", "status": status})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 100*1024*1024)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(v); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			reply(w, 413, map[string]any{"kind": "payload_limit", "status": 413})
			return false
		}
		reply(w, 400, map[string]string{"message": "invalid request"})
		return false
	}
	return true
}
func (p *pool) handler(w http.ResponseWriter, r *http.Request) {
	budget := 300000
	if n, err := strconv.Atoi(r.Header.Get("X-Timeout-Ms")); err == nil && n > 0 && n <= 86400000 {
		budget = n
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(budget)*time.Millisecond)
	defer cancel()
	if r.URL.Path == "/health" && r.Method == "GET" {
		reply(w, 200, map[string]string{"engine": "spidermonkey-152", "status": "ready"})
		return
	}
	if r.URL.Path == "/sessions" && r.Method == "POST" {
		var opts aistudio.SessionOptions
		if !decode(w, r, &opts) {
			return
		}
		var idBytes [24]byte
		if _, err := rand.Read(idBytes[:]); err != nil {
			failure(w, err)
			return
		}
		id := hex.EncodeToString(idBytes[:])
		dir := filepath.Join(p.root, id)
		if err := os.Mkdir(dir, 0700); err != nil {
			failure(w, err)
			return
		}
		s, err := aistudio.NewSession(ctx, opts, filepath.Join(dir, "state.json"))
		if err != nil {
			os.RemoveAll(dir)
			failure(w, err)
			return
		}
		if ctx.Err() != nil {
			s.Close()
			os.RemoveAll(dir)
			return
		}
		p.mu.Lock()
		p.sessions[id] = s
		p.pending[id] = true
		p.mu.Unlock()
		// A lost create response must not leak an unowned VM indefinitely.
		time.AfterFunc(30*time.Second, func() {
			p.mu.Lock()
			orphan := p.pending[id] && p.sessions[id] == s
			if orphan {
				delete(p.pending, id)
				delete(p.sessions, id)
			}
			p.mu.Unlock()
			if orphan {
				s.Close()
				os.RemoveAll(dir)
			}
		})
		reply(w, 200, map[string]any{"id": id, "catalog": s.Catalog()})
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 2 || len(parts) > 3 || parts[0] != "sessions" {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	p.mu.RLock()
	s := p.sessions[id]
	p.mu.RUnlock()
	if s == nil {
		reply(w, 410, map[string]string{"message": "local session unavailable"})
		return
	}
	if len(parts) == 2 && r.Method == "DELETE" {
		p.mu.Lock()
		delete(p.sessions, id)
		delete(p.pending, id)
		p.mu.Unlock()
		s.Close()
		os.RemoveAll(filepath.Join(p.root, id))
		reply(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(parts) != 3 {
		http.NotFound(w, r)
		return
	}
	if parts[2] == "activate" && r.Method == "POST" {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		reply(w, 200, map[string]bool{"ok": true})
		return
	}
	if parts[2] == "state" && r.Method == "GET" {
		reply(w, 200, s.State())
		return
	}
	if parts[2] == "drive" && r.Method == "POST" {
		var op aistudio.DriveOperation
		if !decode(w, r, &op) {
			return
		}
		v, err := s.Drive(ctx, op)
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, v)
		return
	}
	if parts[2] != "rpc" || r.Method != "POST" {
		http.NotFound(w, r)
		return
	}
	var call aistudio.Call
	if !decode(w, r, &call) {
		return
	}
	if !aistudio.AllowedMethod(call.Method) {
		reply(w, 400, map[string]string{"message": "unsupported RPC"})
		return
	}
	response, err := s.Send(ctx, call)
	if err != nil {
		failure(w, err)
		return
	}
	defer response.Body.Close()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(200)
	encoder := json.NewEncoder(w)
	flusher, _ := w.(http.Flusher)
	var body strings.Builder
	stream := call.Method == "GenerateContent" && response.StatusCode == 200
	responseLimit := 100 * 1024 * 1024
	if strings.Contains(call.Method, "CodeAssistant") || strings.Contains(call.Method, "Applet") {
		responseLimit = 16 * 1024 * 1024
	}
	buf := make([]byte, 16*1024)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if stream {
				if err := encoder.Encode(map[string]string{"data": base64.StdEncoding.EncodeToString(buf[:n])}); err != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			} else {
				if body.Len()+n > responseLimit {
					encoder.Encode(map[string]any{"error": map[string]any{"kind": "payload_limit", "status": 413}})
					return
				}
				body.Write(buf[:n])
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				encoder.Encode(map[string]any{"error": map[string]any{"status": 502, "kind": "transport", "message": "Google response interrupted"}})
				return
			}
			break
		}
	}
	if call.Method == "GetAiStudioBenefitTier" && response.StatusCode == 200 {
		s.ApplyTier([]byte(body.String()))
	}
	encoder.Encode(map[string]any{"result": map[string]any{"status": response.StatusCode, "text": body.String(), "source": "google_http"}})
}
func main() {
	// Upstream runtime errors can include challenge data; ordinary logs expose no such data.
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if mozjs.Init() != nil {
		os.Exit(2)
	}
	socket := os.Getenv("AISTUDIO_ENGINE_SOCKET")
	if socket == "" || !filepath.IsAbs(socket) {
		os.Exit(2)
	}
	root := filepath.Dir(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(2)
	}
	defer os.Remove(socket)
	if os.Chmod(socket, 0600) != nil {
		os.Exit(2)
	}
	p := &pool{sessions: map[string]*aistudio.Session{}, pending: map[string]bool{}, root: root}
	server := &http.Server{Handler: http.HandlerFunc(p.handler), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	stopped := make(chan struct{})
	var shutdown sync.Once
	quit := func() {
		shutdown.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			server.Shutdown(ctx)
			server.Close()
			p.mu.Lock()
			sessions := p.sessions
			p.sessions = map[string]*aistudio.Session{}
			p.mu.Unlock()
			for _, s := range sessions {
				s.Close()
			}
			close(stopped)
		})
	}
	// A killed Node parent closes this pipe. Do not leave an orphan signer.
	go func() { io.Copy(io.Discard, os.Stdin); quit() }()
	go func() { <-stop; quit() }()
	err = server.Serve(listener)
	if err != nil && err != http.ErrServerClosed {
		go quit()
	}
	<-stopped
	mozjs.Shutdown()
}
