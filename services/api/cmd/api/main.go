package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/arkelythex/estado/services/api/internal/adapters/engine"
	"github.com/arkelythex/estado/services/api/internal/adapters/pg"
	"github.com/arkelythex/estado/services/api/internal/adapters/s3"
	"github.com/arkelythex/estado/services/api/internal/auth"
	"github.com/arkelythex/estado/services/api/internal/httpapi"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	bindAddr := envOrDefault("API_BIND_ADDR", "0.0.0.0:8080")
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		logger.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	engineURL := envOrDefault("ENGINE_URL", "http://127.0.0.1:8090")
	demoCSVPath := envOrDefault("DEMO_EXPENSES_CSV_PATH", "fixtures/demo_expenses.csv")

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		logger.Error("failed to initialize pgx pool", slog.String("error", err.Error()))
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		logger.Error("failed to ping postgres", slog.String("error", err.Error()))
		os.Exit(1)
	}

	s3Bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	if s3Bucket == "" {
		s3Bucket = envOrDefault("S3_EVIDENCE_BUCKET", "evidence")
	}
	s3ExpiresSec := envInt64OrDefault("S3_PRESIGN_EXPIRES_SECONDS", 900)
	signer, err := s3.NewSigner(ctx, s3.Config{
		Endpoint:         strings.TrimSpace(os.Getenv("S3_ENDPOINT")),
		Region:           envOrDefault("S3_REGION", "us-east-1"),
		Bucket:           s3Bucket,
		AccessKey:        strings.TrimSpace(os.Getenv("S3_ACCESS_KEY")),
		SecretKey:        strings.TrimSpace(os.Getenv("S3_SECRET_KEY")),
		ExpiresInSeconds: s3ExpiresSec,
	})
	if err != nil {
		logger.Error("failed to initialize S3 signer", slog.String("error", err.Error()))
		os.Exit(1)
	}

	jwksTTLSec := envInt64OrDefault("AUTH_JWKS_CACHE_TTL_SECONDS", 300)
	authService := auth.NewService(auth.Config{
		Mode:              auth.ParseMode(envOrDefault("AUTH_MODE", "dev_static")),
		DevAdminToken:     strings.TrimSpace(os.Getenv("AUTH_DEV_ADMIN_TOKEN")),
		DevModeratorToken: strings.TrimSpace(os.Getenv("AUTH_DEV_MODERATOR_TOKEN")),
		OIDCIssuer:        strings.TrimSpace(os.Getenv("AUTH_OIDC_ISSUER")),
		OIDCJWKSURL:       strings.TrimSpace(os.Getenv("AUTH_OIDC_JWKS_URL")),
		OIDCAudience:      strings.TrimSpace(os.Getenv("AUTH_OIDC_AUDIENCE")),
		OIDCClientID:      strings.TrimSpace(os.Getenv("AUTH_OIDC_CLIENT_ID")),
		JWKSCacheTTL:      time.Duration(jwksTTLSec) * time.Second,
	})

	store := pg.NewStore(pool)
	engineToken := strings.TrimSpace(os.Getenv("ENGINE_INTERNAL_TOKEN"))
	engineClient := engine.NewClient(engineURL, nil).WithInternalToken(engineToken)

	srv := httpapi.NewServer(store, engineClient, signer, authService, logger, httpapi.Config{
		DemoExpensesCSVPath: demoCSVPath,
		AllowedOrigins:      []string{"http://localhost:3000", "http://localhost:3001"},
	})

	httpServer := &http.Server{
		Addr:              bindAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverErrCh := make(chan error, 1)
	go func() {
		logger.Info("starting api server", slog.String("bind_addr", bindAddr), slog.String("engine_url", engineURL))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server failed", slog.String("error", err.Error()))
			serverErrCh <- err
			stop()
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown error", slog.String("error", err.Error()))
	}
	cancel()

	select {
	case <-serverErrCh:
		pool.Close()
		os.Exit(1)
	default:
	}
}

func envOrDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt64OrDefault(key string, fallback int64) int64 {
	if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return fallback
}
