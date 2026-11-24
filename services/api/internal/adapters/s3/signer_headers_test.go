package s3_test

import (
	"context"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/google/uuid"
)

func TestPresignPutUploadHeadersMatchSignedHeaders(t *testing.T) {
	signer, err := s3.NewSigner(context.Background(), s3.Config{
		Endpoint:         "http://127.0.0.1:9000",
		Region:           "us-east-1",
		Bucket:           "evidence",
		AccessKey:        "test-access",
		SecretKey:        "test-secret",
		ExpiresInSeconds: 300,
	})
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}

	res, err := signer.PresignPut(context.Background(), uuid.New(), "Application/PDF; charset=utf-8", 2048)
	if err != nil {
		t.Fatalf("presign put: %v", err)
	}

	if got := res.UploadHeaders["Content-Type"]; got != "application/pdf" {
		t.Fatalf("expected normalized Content-Type application/pdf, got %q", got)
	}
	if got := res.UploadHeaders["x-amz-server-side-encryption"]; got != "AES256" {
		t.Fatalf("expected x-amz-server-side-encryption AES256, got %q", got)
	}

	parsedURL, err := url.Parse(res.UploadURL)
	if err != nil {
		t.Fatalf("parse presigned url: %v", err)
	}
	signedHeadersRaw := parsedURL.Query().Get("X-Amz-SignedHeaders")
	if signedHeadersRaw == "" {
		t.Fatalf("missing X-Amz-SignedHeaders query parameter in %s", res.UploadURL)
	}
	signedHeaders := strings.Split(strings.ToLower(signedHeadersRaw), ";")
	for headerName := range res.UploadHeaders {
		lowerName := strings.ToLower(headerName)
		if !slices.Contains(signedHeaders, lowerName) {
			t.Fatalf("upload header %q not present in X-Amz-SignedHeaders (%v)", lowerName, signedHeaders)
		}
	}
	if !slices.Contains(signedHeaders, "x-amz-server-side-encryption") {
		t.Fatalf("expected x-amz-server-side-encryption in X-Amz-SignedHeaders (%v)", signedHeaders)
	}
}
