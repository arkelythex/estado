package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/arkelythex/estado/services/api/internal/auth"
	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/golang-jwt/jwt/v5"
)

func TestDevStaticAuthentication(t *testing.T) {
	svc := auth.NewService(auth.Config{
		Mode:              auth.ModeDevStatic,
		DevAdminToken:     "test-admin-secret",
		DevModeratorToken: "test-mod-secret",
	})

	ctx := context.Background()

	adminPrincipal, err := svc.Authenticate(ctx, "Bearer test-admin-secret")
	if err != nil {
		t.Fatalf("admin auth failed: %v", err)
	}
	if err := svc.RequireRoles(adminPrincipal, domain.RoleAdmin); err != nil {
		t.Fatalf("admin should have ADMIN role: %v", err)
	}

	modPrincipal, err := svc.Authenticate(ctx, "Bearer test-mod-secret")
	if err != nil {
		t.Fatalf("moderator auth failed: %v", err)
	}
	if err := svc.RequireRoles(modPrincipal, domain.RoleModerator); err != nil {
		t.Fatalf("moderator should have MODERATOR role: %v", err)
	}
	if err := svc.RequireRoles(modPrincipal, domain.RoleAdmin); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("expected ErrForbidden for moderator on ADMIN route, got %v", err)
	}

	for _, bad := range []string{"", "Basic xyz", "Bearer ", "Bearer wrong-token"} {
		if _, err := svc.Authenticate(ctx, bad); !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatalf("expected ErrUnauthorized for %q, got %v", bad, err)
		}
	}
}

func TestDevStaticEmptyEnvTokensNeverMatch(t *testing.T) {
	svc := auth.NewService(auth.Config{
		Mode: auth.ModeDevStatic,
	})
	if _, err := svc.Authenticate(context.Background(), "Bearer "); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized when tokens are unset, got %v", err)
	}
	if _, err := svc.Authenticate(context.Background(), "Bearer dev-admin-token"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for unconfigured token, got %v", err)
	}
}

func TestDisabledMode(t *testing.T) {
	svc := auth.NewService(auth.Config{Mode: auth.ModeDisabled})
	p, err := svc.Authenticate(context.Background(), "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := svc.RequireRoles(p, domain.RoleAdmin, domain.RoleModerator); err != nil {
		t.Fatalf("disabled mode should allow roles: %v", err)
	}
}

func TestOIDCJWKSAuthenticationAndCaching(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}

	const kid = "test-key-1"
	const issuer = "https://issuer.example.test"
	const audience = "civictech-api"

	var fetchCount atomic.Int32
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount.Add(1)
		nEnc := base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes())
		eEnc := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{
				{
					"kid": kid,
					"kty": "RSA",
					"alg": "RS256",
					"use": "sig",
					"n":   nEnc,
					"e":   eEnc,
				},
			},
		})
	}))
	defer jwksServer.Close()

	svc := auth.NewService(auth.Config{
		Mode:         auth.ModeOIDCJWKS,
		OIDCIssuer:   issuer,
		OIDCAudience: audience,
		OIDCJWKSURL:  jwksServer.URL,
		OIDCClientID: "civictech-api",
		JWKSCacheTTL: 5 * time.Minute,
		HTTPClient:   jwksServer.Client(),
	})

	signToken := func(exp time.Time, iss string, aud string) string {
		claims := jwt.MapClaims{
			"sub": "mod-user-42",
			"iss": iss,
			"aud": aud,
			"exp": exp.Unix(),
			"realm_access": map[string]any{
				"roles": []string{"MODERATOR"},
			},
		}
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		tok.Header["kid"] = kid
		signed, err := tok.SignedString(privateKey)
		if err != nil {
			t.Fatalf("sign token: %v", err)
		}
		return signed
	}

	validJWT := signToken(time.Now().Add(10*time.Minute), issuer, audience)
	p, err := svc.Authenticate(context.Background(), "Bearer "+validJWT)
	if err != nil {
		t.Fatalf("oidc auth failed: %v", err)
	}
	if p.Subject != "mod-user-42" || !p.HasAnyRole(domain.RoleModerator) || p.HasAnyRole(domain.RoleAdmin) {
		t.Fatalf("unexpected principal: %#v", p)
	}

	// Second call should hit cache.
	if _, err := svc.Authenticate(context.Background(), "Bearer "+validJWT); err != nil {
		t.Fatalf("cached oidc auth failed: %v", err)
	}
	if fetchCount.Load() != 1 {
		t.Fatalf("expected 1 JWKS fetch due to caching, got %d", fetchCount.Load())
	}

	expiredJWT := signToken(time.Now().Add(-5*time.Minute), issuer, audience)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+expiredJWT); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for expired jwt, got %v", err)
	}

	wrongIssuerJWT := signToken(time.Now().Add(10*time.Minute), "https://evil.test", audience)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+wrongIssuerJWT); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for wrong issuer, got %v", err)
	}
}
