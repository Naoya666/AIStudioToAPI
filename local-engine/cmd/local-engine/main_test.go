package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type oversized struct{}

func (oversized) Read(_ []byte) (int, error) { return 0, &http.MaxBytesError{Limit: 100 * 1024 * 1024} }
func TestOversizedPayloadHasExplicitNonAuthError(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/sessions", oversized{})
	writer := httptest.NewRecorder()
	var body map[string]any
	if decode(writer, request, &body) {
		t.Fatal("oversized body accepted")
	}
	if writer.Code != 413 {
		t.Fatal(writer.Code)
	}
	var result map[string]any
	json.Unmarshal(writer.Body.Bytes(), &result)
	if result["kind"] != "payload_limit" {
		t.Fatal(result)
	}
}
