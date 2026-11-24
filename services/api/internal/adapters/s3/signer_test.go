package s3_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/google/uuid"
)

func TestValidateEvidenceUpload(t *testing.T) {
	for _, mime := range []string{"application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain"} {
		if _, _, err := s3.ValidateEvidenceUpload(mime, 1024); err != nil {
			t.Fatalf("expected valid mime %s, got %v", mime, err)
		}
	}

	if _, _, err := s3.ValidateEvidenceUpload("application/javascript", 100); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected ErrValidation for disallowed mime, got %v", err)
	}

	if _, _, err := s3.ValidateEvidenceUpload("application/pdf", s3.MaxEvidenceSizeBytes+1); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("expected ErrValidation for oversized file, got %v", err)
	}
}

func TestPresignPutUsesPathStyleAndSSE(t *testing.T) {
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

	reportID := uuid.New()
	res, err := signer.PresignPut(context.Background(), reportID, "image/png", 2048)
	if err != nil {
		t.Fatalf("presign put: %v", err)
	}
	if !strings.HasPrefix(res.ObjectKey, "reports/"+reportID.String()+"/") || !strings.HasSuffix(res.ObjectKey, ".png") {
		t.Fatalf("unexpected object key: %s", res.ObjectKey)
	}
	if !strings.Contains(res.UploadURL, "http://127.0.0.1:9000/evidence/reports/") {
		t.Fatalf("expected path-style URL, got %s", res.UploadURL)
	}
	if !strings.Contains(res.UploadURL, "X-Amz-SignedHeaders") {
		t.Fatalf("expected signed headers in presigned URL, got %s", res.UploadURL)
	}
	if got := signer.StorageRef(res.ObjectKey); got != "s3://evidence/"+res.ObjectKey {
		t.Fatalf("unexpected storage ref: %s", got)
	}
}
