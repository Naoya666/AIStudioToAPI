package aistudio

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const publicDiscoveryUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0"

var makerSuiteAPIKeyPattern = regexp.MustCompile(`"WIu0Nc":"([^"]+)"`)

func sendHTTP(client *http.Client, request *http.Request) (*http.Response, error) {
	response, err := client.Do(request)
	var requestErr *url.Error
	if errors.As(err, &requestErr) {
		requestErr.URL, _, _ = strings.Cut(requestErr.URL, "?")
	}
	return response, err
}

// DiscoverPublicHeaders 从 AI Studio 首页读取普通 RPC 所需的公开头
func newVisitID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("生成 AI Studio visit ID: %w", err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	uuid := fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16],
	)
	return "v1_" + base64.StdEncoding.EncodeToString([]byte(uuid)), nil
}

// NewProxyHTTPClient 创建普通 HTTP、HTTPS 或 SOCKS5 固定出口客户端
func NewProxyHTTPClient(proxyURL string) (*http.Client, error) {
	roundTripper, err := newBrowserRoundTripper(proxyURL)
	if err != nil {
		return nil, err
	}
	return &http.Client{Transport: roundTripper}, nil
}

// UploadAssistantFile 以账户身份按官网对话面板的 /_/upload 可续传协议上传附件，返回上传路径

type RPCResponse struct {
	StatusCode int
	Header     http.Header
	Body       io.ReadCloser
}
type RPCError struct{ StatusCode int }

func (e *RPCError) Error() string                             { return fmt.Sprintf("Google RPC HTTP %d", e.StatusCode) }
func DecodeRPCError(_ string, status int, _ []byte) *RPCError { return &RPCError{status} }

type BenefitTier int64

const (
	BenefitTierFree BenefitTier = iota
	BenefitTierPro
	BenefitTierUltra
	BenefitTierPlus
)

func decodeBenefitTier(b []byte) (BenefitTier, error) {
	var v []json.RawMessage
	if err := json.Unmarshal(b, &v); err != nil {
		return 0, err
	}
	if len(v) == 0 || string(v[0]) == "null" {
		return 0, nil
	}
	var n int64
	err := json.Unmarshal(v[0], &n)
	return BenefitTier(n), err
}
func decodeJSONValue(b []byte) (json.RawMessage, error) {
	if !json.Valid(b) {
		return nil, errors.New("invalid JSON")
	}
	return b, nil
}
