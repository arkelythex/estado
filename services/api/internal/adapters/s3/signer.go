package s3

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/google/uuid"
)

const MaxEvidenceSizeBytes int64 = 10 * 1024 * 1024

var allowedMimeTypes = map[string]string{
	"application/pdf": ".pdf",
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"text/plain":      ".txt",
}

type Config struct {
	Endpoint         string
	Region           string
	Bucket           string
	AccessKey        string
	SecretKey        string
	ExpiresInSeconds int64
}

type Signer struct {
	presignClient *s3.PresignClient
	bucket        string
	expiresIn     time.Duration
}

func NewSigner(ctx context.Context, cfg Config) (*Signer, error) {
	if strings.TrimSpace(cfg.Bucket) == "" {
		return nil, fmt.Errorf("S3_BUCKET is required")
	}
	region := cfg.Region
	if strings.TrimSpace(region) == "" {
		region = "us-east-1"
	}
	expiresSec := cfg.ExpiresInSeconds
	if expiresSec <= 0 {
		expiresSec = 900
	}

	loadOpts := []func(*config.LoadOptions) error{
		config.WithRegion(region),
	}
	if cfg.AccessKey != "" && cfg.SecretKey != "" {
		loadOpts = append(loadOpts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		))
	}

	awsCfg, err := config.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = true
		if strings.TrimSpace(cfg.Endpoint) != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	})

	return &Signer{
		presignClient: s3.NewPresignClient(client),
		bucket:        cfg.Bucket,
		expiresIn:     time.Duration(expiresSec) * time.Second,
	}, nil
}

func ValidateEvidenceUpload(contentType string, sizeBytes int64) (string, string, error) {
	normalized := strings.ToLower(strings.TrimSpace(contentType))
	if idx := strings.Index(normalized, ";"); idx != -1 {
		normalized = strings.TrimSpace(normalized[:idx])
	}

	ext, ok := allowedMimeTypes[normalized]
	if !ok {
		return "", "", fmt.Errorf("%w: unsupported content_type %q; allowed: application/pdf, image/jpeg, image/png, image/webp, text/plain", domain.ErrValidation, contentType)
	}

	if sizeBytes <= 0 || sizeBytes > MaxEvidenceSizeBytes {
		return "", "", fmt.Errorf("%w: size_bytes must be between 1 and %d", domain.ErrValidation, MaxEvidenceSizeBytes)
	}

	return normalized, ext, nil
}

func (s *Signer) PresignPut(ctx context.Context, reportID uuid.UUID, contentType string, sizeBytes int64) (domain.PresignedUpload, error) {
	normalizedType, ext, err := ValidateEvidenceUpload(contentType, sizeBytes)
	if err != nil {
		return domain.PresignedUpload{}, err
	}

	objectKey := fmt.Sprintf("reports/%s/%s%s", reportID.String(), uuid.NewString(), ext)
	input := &s3.PutObjectInput{
		Bucket:               aws.String(s.bucket),
		Key:                  aws.String(objectKey),
		ContentType:          aws.String(normalizedType),
		ContentLength:        aws.Int64(sizeBytes),
		ServerSideEncryption: types.ServerSideEncryptionAes256,
	}

	presigned, err := s.presignClient.PresignPutObject(ctx, input, func(opts *s3.PresignOptions) {
		opts.Expires = s.expiresIn
	})
	if err != nil {
		return domain.PresignedUpload{}, fmt.Errorf("presign put object: %w", err)
	}

	uploadHeaders := map[string]string{
		"Content-Type":                 normalizedType,
		"x-amz-server-side-encryption": string(types.ServerSideEncryptionAes256),
	}

	return domain.PresignedUpload{
		ObjectKey:        objectKey,
		UploadURL:        presigned.URL,
		ExpiresInSeconds: int64(s.expiresIn.Seconds()),
		UploadHeaders:    uploadHeaders,
	}, nil
}

func (s *Signer) StorageRef(objectKey string) string {
	return fmt.Sprintf("s3://%s/%s", s.bucket, objectKey)
}
