package aistudio

// The application owns scheduling/retries. This package sends every operation once.
import (
	"aistudio-to-api/local-engine/internal/camoufoxnative"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Session struct {
	runtime *goWAARuntime
	mu      sync.Mutex
	closed  bool
	stop    context.CancelFunc
	done    chan struct{}
}
type SessionOptions struct {
	State    StorageState `json:"state"`
	Proxy    string       `json:"proxy"`
	AuthUser int          `json:"authUser"`
	Model    string       `json:"model"`
}
type Call struct {
	Method     string  `json:"rpcMethod"`
	Body       []any   `json:"body"`
	Binding    string  `json:"ht"`
	PagePrompt *string `json:"proofText"`
}

var methods = map[string]bool{"GenerateContent": true, "CountTokens": true, "GetAiStudioBenefitTier": true, "ListModels": true, "GenerateAccessToken": true, "GetLoggingContext": true, "CreateApplet": true, "CodeAssistantOffline": true, "StreamCodeAssistantOfflineGeneration": true, "CancelCodeAssistantOfflineGeneration": true, "DeleteApplet": true}

func AllowedMethod(method string) bool { return methods[method] }
func NewSession(ctx context.Context, options SessionOptions, statePath string) (*Session, error) {
	if options.AuthUser < 0 || options.AuthUser > 100 {
		return nil, errors.New("invalid authUser")
	}
	// Reject incomplete credentials before any network or VM initialization.
	if _, err := NewSigner().Authorization(options.State); err != nil {
		return nil, err
	}
	if err := WriteStorageState(statePath, options.State); err != nil {
		return nil, err
	}
	r, err := newGoWAARuntime(ctx, camoufoxnative.Options{StorageStatePath: statePath, Proxy: options.Proxy, AuthUser: options.AuthUser, Model: options.Model, Locale: "en-US", Timezone: "America/Los_Angeles"})
	if err != nil {
		return nil, err
	}
	life, stop := context.WithCancel(context.Background())
	s := &Session{runtime: r, stop: stop, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-life.Done():
				return
			case <-ticker.C:
				refresh, cancel := context.WithTimeout(life, 30*time.Second)
				r.authWarmup(refresh)
				cancel()
			}
		}
	}()
	return s, nil
}
func (s *Session) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	s.stop()
	s.runtime.Close()
	s.runtime.client.CloseIdleConnections()
}
func (s *Session) State() StorageState                 { return s.runtime.cookies() }
func (s *Session) Catalog() camoufoxnative.PageCatalog { return s.runtime.PageCatalog() }
func (s *Session) headers(ctx context.Context) (http.Header, error) {
	h, err := s.runtime.ProtocolHeaders(ctx)
	if err != nil {
		return nil, err
	}
	auth, err := NewSigner().Authorization(s.State())
	if err != nil {
		return nil, err
	}
	h.Set("Authorization", auth)
	h.Set("Content-Type", "application/json+protobuf")
	return h, nil
}
func proofIndex(method string) int {
	switch method {
	case "GenerateContent":
		return 4
	case "CodeAssistantOffline":
		return 1
	}
	return -1
}
func (s *Session) Send(ctx context.Context, call Call) (*RPCResponse, error) {
	if !AllowedMethod(call.Method) {
		return nil, errors.New("unsupported RPC")
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("session closed")
	}
	if call.Method == "CodeAssistantOffline" {
		if err := s.uploadAttachments(ctx, &call); err != nil {
			s.mu.Unlock()
			return nil, err
		}
	}
	if call.Method == "GenerateContent" {
		binding, page, err := playgroundProofInputs(call.Body)
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		call.Binding, call.PagePrompt = binding, &page
	}
	index := proofIndex(call.Method)
	if index >= 0 {
		if len(call.Body) <= index {
			s.mu.Unlock()
			return nil, errors.New("missing proof field")
		}
		digest := sha256.Sum256([]byte(call.Binding))
		prompt := call.Binding
		if call.PagePrompt != nil {
			prompt = *call.PagePrompt
		}
		snapshot := s.runtime.Proof
		if call.Method == "GenerateContent" && prompt != "" {
			snapshot = s.runtime.RunProof
		}
		proof, err := snapshot(ctx, fmt.Sprintf("%x", digest), prompt)
		if err != nil {
			s.mu.Unlock()
			return nil, &LocalProofError{err}
		}
		call.Body[index] = proof
	}
	h, err := s.headers(ctx)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	if call.Method == "GenerateContent" || call.Method == "CountTokens" || call.Method == "CodeAssistantOffline" {
		tier, err := decodeBenefitTier(s.runtime.pageCatalog.Tier)
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		switch tier {
		case BenefitTierPro:
			h.Set("X-AIStudio-G1-Tier", "TIER1")
		case BenefitTierUltra:
			h.Set("X-AIStudio-G1-Tier", "TIER2")
		case BenefitTierPlus:
			h.Set("X-AIStudio-G1-Tier", "TIER0")
		}
	}
	body, err := json.Marshal(call.Body)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if call.Method == "GenerateContent" {
		h.Set("Priority", "u=0")
		if call.PagePrompt != nil && *call.PagePrompt != "" {
			companion, marshalErr := json.Marshal([]any{call.Body[0], []any{[]any{[]any{[]any{nil, *call.PagePrompt}}, "user"}}})
			if marshalErr == nil {
				ctx = withFollowUp(ctx, followUp{URL: makerSuiteRPCURL + "CountTokens", Body: companion, Delay: 2200 * time.Millisecond})
			}
		}
	}
	response, err := s.runtime.SendProtected(ctx, makerSuiteRPCURL+call.Method, h, body)
	if err != nil {
		return nil, err
	}
	return &RPCResponse{StatusCode: response.StatusCode, Header: response.Header, Body: response.Body}, nil
}
func (s *Session) uploadAttachments(ctx context.Context, call *Call) error {
	if len(call.Body) == 0 {
		return errors.New("missing Build contents")
	}
	// Build has different proof and prompt fields. Upload first, then bind the final parts.
	outer, ok := call.Body[0].([]any)
	if !ok || len(outer) == 0 {
		return errors.New("invalid Build contents")
	}
	turn, ok := outer[0].([]any)
	if !ok || len(turn) == 0 {
		return errors.New("invalid Build turn")
	}
	parts, ok := turn[0].([]any)
	if !ok {
		return errors.New("invalid Build parts")
	}
	texts := make([]string, 0, len(parts))
	for i, p := range parts {
		if upload, ok := p.(map[string]any); ok {
			values, ok := upload["__upload"].([]any)
			if !ok || len(values) != 3 {
				return errors.New("invalid Build attachment")
			}
			mime, _ := values[0].(string)
			data, _ := values[1].(string)
			name, _ := values[2].(string)
			raw, err := base64.StdEncoding.DecodeString(data)
			if err != nil || mime != "text/plain" || len(raw) > 8*1024*1024 {
				return errors.New("invalid Build attachment")
			}
			hash := sha256.Sum256(raw)
			h := http.Header{"X-Goog-Authuser": {fmt.Sprint(s.runtime.options.AuthUser)}, "X-Goog-Hash": {"sha256=" + base64.StdEncoding.EncodeToString(hash[:])}, "X-Goog-Upload-Command": {"start"}, "X-Goog-Upload-Header-Content-Length": {fmt.Sprint(len(raw))}, "X-Goog-Upload-Header-Content-Type": {mime}, "X-Goog-Upload-Protocol": {"resumable"}, "Origin": {aiStudioOrigin}, "Referer": {aiStudioOrigin + "/"}}
			h.Set("Sec-Fetch-Dest", "empty")
			h.Set("Sec-Fetch-Mode", "cors")
			h.Set("Sec-Fetch-Site", "same-origin")
			start, err := s.runtime.do(ctx, "POST", aiStudioOrigin+"/_/upload", nil, h)
			if err != nil {
				return err
			}
			io.Copy(io.Discard, start.Body)
			start.Body.Close()
			if start.StatusCode != 200 {
				return &RPCError{start.StatusCode}
			}
			target, err := url.Parse(start.Header.Get("X-Goog-Upload-URL"))
			if err != nil || target.Scheme != "https" || target.Host != "aistudio.google.com" || !strings.HasPrefix(target.Path, "/_/upload") || target.User != nil {
				return errors.New("unexpected upload target")
			}
			h.Set("Content-Type", mime)
			h.Set("X-Goog-Upload-Command", "upload, finalize")
			h.Set("X-Goog-Upload-Offset", "0")
			response, err := s.runtime.do(ctx, "POST", target.String(), raw, h)
			if err != nil {
				return err
			}
			path, err := io.ReadAll(io.LimitReader(response.Body, 4097))
			response.Body.Close()
			if err != nil || response.StatusCode != 200 || len(path) == 0 || len(path) > 4096 {
				return errors.New("Build upload finalize failed")
			}
			part := make([]any, 18)
			part[17] = []any{mime, strings.TrimSpace(string(path)), name, fmt.Sprint(len(raw))}
			parts[i] = part
			p = part
		}
		part, ok := p.([]any)
		if !ok {
			return errors.New("invalid Build part")
		}
		text := ""
		if len(part) > 1 {
			if v, ok := part[1].(string); ok {
				text = v
			} else if len(part) > 2 {
				if inline, ok := part[2].([]any); ok && len(inline) > 1 {
					text, _ = inline[1].(string)
				}
			}
		}
		texts = append(texts, text)
	}
	call.Binding = strings.Join(texts, " ")
	return nil
}

type DriveOperation struct {
	Method   string `json:"method"`
	FileID   string `json:"fileId"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
	Download bool   `json:"download"`
}

var fileID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func (s *Session) Drive(ctx context.Context, op DriveOperation) (map[string]any, error) {
	response, err := s.Send(ctx, Call{Method: "GenerateAccessToken", Body: []any{"users/me"}})
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		return nil, &RPCError{response.StatusCode}
	}
	var token []any
	if json.Unmarshal(raw, &token) != nil || len(token) == 0 {
		return nil, errors.New("Drive authorization unavailable")
	}
	bearer, ok := token[0].(string)
	if !ok || bearer == "" {
		return nil, errors.New("Drive authorization unavailable")
	}
	target := "https://www.googleapis.com/drive/v3/files"
	h := http.Header{"Authorization": {"Bearer " + bearer}, "Origin": {aiStudioOrigin}, "Referer": {aiStudioOrigin + "/"}, "Sec-Fetch-Dest": {"empty"}, "Sec-Fetch-Mode": {"cors"}, "Sec-Fetch-Site": {"cross-site"}}
	var body []byte
	switch op.Method {
	case "POST":
		data, err := base64.StdEncoding.DecodeString(op.Data)
		if err != nil || len(data) > 64*1024*1024 {
			return nil, errors.New("invalid Drive upload")
		}
		if strings.ContainsAny(op.MimeType, "\r\n") {
			return nil, errors.New("invalid mime type")
		}
		boundary := fmt.Sprintf("aistudio_%x", sha256.Sum256(data))
		meta, _ := json.Marshal(map[string]string{"name": op.Name, "mimeType": op.MimeType})
		var b bytes.Buffer
		fmt.Fprintf(&b, "--%s\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n%s\r\n--%s\r\nContent-Type: %s\r\n\r\n", boundary, meta, boundary, op.MimeType)
		b.Write(data)
		fmt.Fprintf(&b, "\r\n--%s--\r\n", boundary)
		body = b.Bytes()
		h.Set("Content-Type", "multipart/related; boundary="+boundary)
		target = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,createdTime"
	case "GET", "DELETE":
		if !fileID.MatchString(op.FileID) {
			return nil, errors.New("invalid file ID")
		}
		target += "/" + op.FileID
		if op.Download {
			target += "?alt=media"
		} else {
			target += "?fields=id,name,mimeType,size,createdTime"
		}
	default:
		return nil, errors.New("unsupported Drive method")
	}
	result, err := s.runtime.do(ctx, op.Method, target, body, h)
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()
	data, err := io.ReadAll(io.LimitReader(result.Body, 64*1024*1024+1))
	if err != nil || len(data) > 64*1024*1024 {
		return nil, errors.New("Drive response too large")
	}
	out := map[string]any{"status": result.StatusCode, "text": string(data)}
	if op.Download && result.StatusCode == 200 {
		out = map[string]any{"status": 200, "mimeType": result.Header.Get("Content-Type"), "data": base64.StdEncoding.EncodeToString(data)}
	}
	return out, nil
}

// SessionExpiredError is only emitted after an authenticated navigation redirects to Google login.
type SessionExpiredError struct{}

func (*SessionExpiredError) Error() string { return "Google session expired" }

// Match Mag1cFall's bindingPrompt/contentsText: bind all parts, but expose only
// the last turn's text in the Firefox prompt box. The proof remains field 5.
func playgroundProofInputs(body []any) (string, string, error) {
	if len(body) < 2 {
		return "", "", errors.New("missing Playground contents")
	}
	turns, ok := body[1].([]any)
	if !ok || len(turns) == 0 {
		return "", "", errors.New("invalid Playground contents")
	}
	var binding, page []string
	for turnIndex, item := range turns {
		turn, ok := item.([]any)
		if !ok || len(turn) == 0 {
			return "", "", errors.New("invalid Playground turn")
		}
		parts, ok := turn[0].([]any)
		if !ok {
			return "", "", errors.New("invalid Playground parts")
		}
		for _, item := range parts {
			part, ok := item.([]any)
			if !ok {
				return "", "", errors.New("invalid Playground part")
			}
			value := ""
			if len(part) > 1 {
				value, _ = part[1].(string)
			}
			if turnIndex == len(turns)-1 && value != "" {
				page = append(page, value)
			}
			if value == "" {
				for _, slot := range []struct{ field, index int }{{2, 1}, {5, 0}, {6, 1}} {
					if len(part) > slot.field {
						if fields, ok := part[slot.field].([]any); ok && len(fields) > slot.index {
							value, _ = fields[slot.index].(string)
							if value != "" {
								break
							}
						}
					}
				}
			}
			binding = append(binding, value)
		}
	}
	return strings.Join(binding, " "), strings.Join(page, " "), nil
}

func (s *Session) ApplyTier(raw []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.runtime.pageCatalog.Tier = append([]byte(nil), raw...)
	}
}

type LocalProofError struct{ Err error }

func (e *LocalProofError) Error() string { return "Local WAA proof failed" }
func (e *LocalProofError) Unwrap() error { return e.Err }
