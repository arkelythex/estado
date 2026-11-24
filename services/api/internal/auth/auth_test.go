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
	"sync"
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

func TestOIDCEmptyClientIDIgnoresUnrelatedResourceAccessRoles(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}

	const kid = "key-client-scope"
	const issuer = "https://issuer.example.test"
	const audience = "civictech-api"

	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	// Empty OIDCClientID: must NOT grant roles from resource_access["other-app"].
	svcNoClient := auth.NewService(auth.Config{
		Mode:         auth.ModeOIDCJWKS,
		OIDCIssuer:   issuer,
		OIDCAudience: audience,
		OIDCJWKSURL:  jwksServer.URL,
		OIDCClientID: "",
		HTTPClient:   jwksServer.Client(),
	})

	claims := jwt.MapClaims{
		"sub": "user-other-client",
		"iss": issuer,
		"aud": audience,
		"exp": time.Now().Add(10 * time.Minute).Unix(),
		"resource_access": map[string]any{
			"other-app": map[string]any{
				"roles": []string{"ADMIN", "MODERATOR"},
			},
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = kid
	signed, err := tok.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	p, err := svcNoClient.Authenticate(context.Background(), "Bearer "+signed)
	if err != nil {
		t.Fatalf("authenticate failed: %v", err)
	}
	if p.HasAnyRole(domain.RoleAdmin, domain.RoleModerator) {
		t.Fatalf("expected unrelated resource_access roles to be ignored when OIDCClientID is empty, got %#v", p.Roles)
	}

	// RealmAccess and direct roles still work when OIDCClientID is empty.
	realmClaims := jwt.MapClaims{
		"sub":   "user-realm-role",
		"iss":   issuer,
		"aud":   audience,
		"exp":   time.Now().Add(10 * time.Minute).Unix(),
		"roles": []string{"MODERATOR"},
		"resource_access": map[string]any{
			"other-app": map[string]any{
				"roles": []string{"ADMIN"},
			},
		},
	}
	realmTok := jwt.NewWithClaims(jwt.SigningMethodRS256, realmClaims)
	realmTok.Header["kid"] = kid
	realmSigned, err := realmTok.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign realm token: %v", err)
	}
	p2, err := svcNoClient.Authenticate(context.Background(), "Bearer "+realmSigned)
	if err != nil {
		t.Fatalf("authenticate failed: %v", err)
	}
	if !p2.HasAnyRole(domain.RoleModerator) || p2.HasAnyRole(domain.RoleAdmin) {
		t.Fatalf("expected only direct/realm MODERATOR role, got %#v", p2.Roles)
	}
}

func TestOIDCKeyRotationAndStaleCacheFallback(t *testing.T) {
	key1, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key1: %v", err)
	}
	key2, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key2: %v", err)
	}

	const issuer = "https://issuer.example.test"
	const audience = "civictech-api"

	var activePhase atomic.Int32 // 0 = key1 only, 1 = key2 added, 2 = transient 500
	var fetchCount atomic.Int32
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetchCount.Add(1)
		phase := activePhase.Load()
		if phase == 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		encodeKey := func(kid string, pub rsa.PublicKey) map[string]string {
			return map[string]string{
				"kid": kid,
				"kty": "RSA",
				"alg": "RS256",
				"use": "sig",
				"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
			}
		}
		keys := []map[string]string{encodeKey("kid-1", key1.PublicKey)}
		if phase == 1 {
			keys = append(keys, encodeKey("kid-2", key2.PublicKey))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
	}))
	defer jwksServer.Close()

	svc := auth.NewService(auth.Config{
		Mode:         auth.ModeOIDCJWKS,
		OIDCIssuer:   issuer,
		OIDCAudience: audience,
		OIDCJWKSURL:  jwksServer.URL,
		JWKSCacheTTL: 50 * time.Millisecond,
		HTTPClient:   jwksServer.Client(),
	})

	signWithKey := func(kid string, k *rsa.PrivateKey) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"sub":   "user-rotate",
			"iss":   issuer,
			"aud":   audience,
			"exp":   time.Now().Add(10 * time.Minute).Unix(),
			"roles": []string{"ADMIN"},
		})
		tok.Header["kid"] = kid
		signed, err := tok.SignedString(k)
		if err != nil {
			t.Fatalf("sign token: %v", err)
		}
		return signed
	}

	tok1 := signWithKey("kid-1", key1)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+tok1); err != nil {
		t.Fatalf("initial kid-1 auth failed: %v", err)
	}

	// Rotate to kid-2 while cache for kid-1 is still fresh: unknown kid must trigger refresh.
	activePhase.Store(1)
	tok2 := signWithKey("kid-2", key2)
	p2, err := svc.Authenticate(context.Background(), "Bearer "+tok2)
	if err != nil {
		t.Fatalf("rotated kid-2 auth failed: %v", err)
	}
	if !p2.HasAnyRole(domain.RoleAdmin) {
		t.Fatalf("expected ADMIN role after key rotation, got %#v", p2.Roles)
	}
	if fetchCount.Load() < 2 {
		t.Fatalf("expected JWKS refresh on unknown kid, fetchCount=%d", fetchCount.Load())
	}

	// Expire TTL and simulate transient IdP 500: stale cached keys should still verify tok2.
	time.Sleep(60 * time.Millisecond)
	activePhase.Store(2)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+tok2); err != nil {
		t.Fatalf("expected stale cache fallback on transient JWKS failure, got %v", err)
	}
}

func TestOIDCRejectsInvalidAlgWrongAudienceAndMisconfiguredIssuerOrAudience(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}

	const kid = "kid-strict"
	const issuer = "https://issuer.example.test"
	const audience = "civictech-api"

	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{
				{
					"kid": kid,
					"kty": "RSA",
					"alg": "RS256",
					"use": "sig",
					"n":   base64.RawURLEncoding.EncodeToString(privateKey.PublicKey.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(privateKey.PublicKey.E)).Bytes()),
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
		HTTPClient:   jwksServer.Client(),
	})

	// Non-RS256 alg (HS256) rejected.
	hsTok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "user-hs",
		"iss": issuer,
		"aud": audience,
		"exp": time.Now().Add(10 * time.Minute).Unix(),
	})
	hsTok.Header["kid"] = kid
	hsSigned, err := hsTok.SignedString([]byte("hmac-secret"))
	if err != nil {
		t.Fatalf("sign hs256 token: %v", err)
	}
	if _, err := svc.Authenticate(context.Background(), "Bearer "+hsSigned); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for HS256 alg, got %v", err)
	}

	// Wrong audience rejected.
	wrongAudTok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "user-wrong-aud",
		"iss": issuer,
		"aud": "other-service",
		"exp": time.Now().Add(10 * time.Minute).Unix(),
	})
	wrongAudTok.Header["kid"] = kid
	wrongAudSigned, err := wrongAudTok.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign wrong aud token: %v", err)
	}
	if _, err := svc.Authenticate(context.Background(), "Bearer "+wrongAudSigned); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized for wrong audience, got %v", err)
	}

	// Misconfigured empty OIDCIssuer / OIDCAudience fails closed with ErrUnauthorized.
	validTok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "user-ok",
		"iss": issuer,
		"aud": audience,
		"exp": time.Now().Add(10 * time.Minute).Unix(),
	})
	validTok.Header["kid"] = kid
	validSigned, err := validTok.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign valid token: %v", err)
	}

	noIssuerSvc := auth.NewService(auth.Config{
		Mode:         auth.ModeOIDCJWKS,
		OIDCIssuer:   "",
		OIDCAudience: audience,
		OIDCJWKSURL:  jwksServer.URL,
		HTTPClient:   jwksServer.Client(),
	})
	if _, err := noIssuerSvc.Authenticate(context.Background(), "Bearer "+validSigned); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized when OIDCIssuer is empty, got %v", err)
	}

	noAudSvc := auth.NewService(auth.Config{
		Mode:         auth.ModeOIDCJWKS,
		OIDCIssuer:   issuer,
		OIDCAudience: "",
		OIDCJWKSURL:  jwksServer.URL,
		HTTPClient:   jwksServer.Client(),
	})
	if _, err := noAudSvc.Authenticate(context.Background(), "Bearer "+validSigned); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized when OIDCAudience is empty, got %v", err)
	}
}

func TestOIDCJWKSSingleflightAndCooldown(t *testing.T) {
	key1, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key1: %v", err)
	}
	unknownKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate unknownKey: %v", err)
	}

	const issuer = "https://issuer.example.test"
	const audience = "civictech-api"

	var fetchCount atomic.Int32
	fetchEntered := make(chan struct{}, 10)
	releaseFetch := make(chan struct{})

	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := fetchCount.Add(1)
		if n == 2 {
			select {
			case fetchEntered <- struct{}{}:
			default:
			}
			<-releaseFetch
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]string{
				{
					"kid": "kid-1",
					"kty": "RSA",
					"alg": "RS256",
					"use": "sig",
					"n":   base64.RawURLEncoding.EncodeToString(key1.PublicKey.N.Bytes()),
					"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key1.PublicKey.E)).Bytes()),
				},
			},
		})
	}))
	defer jwksServer.Close()

	svc := auth.NewService(auth.Config{
		Mode:                auth.ModeOIDCJWKS,
		OIDCIssuer:          issuer,
		OIDCAudience:        audience,
		OIDCJWKSURL:         jwksServer.URL,
		JWKSCacheTTL:        5 * time.Minute,
		JWKSRefreshCooldown: 150 * time.Millisecond,
		HTTPClient:          jwksServer.Client(),
	})

	signWithKey := func(kid string, k *rsa.PrivateKey) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
			"sub":   "user-concurrent",
			"iss":   issuer,
			"aud":   audience,
			"exp":   time.Now().Add(10 * time.Minute).Unix(),
			"roles": []string{"MODERATOR"},
		})
		tok.Header["kid"] = kid
		signed, err := tok.SignedString(k)
		if err != nil {
			t.Fatalf("sign token: %v", err)
		}
		return signed
	}

	// Warm the cache with valid kid-1 (1 fetch).
	validTok := signWithKey("kid-1", key1)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+validTok); err != nil {
		t.Fatalf("warm cache failed: %v", err)
	}
	if got := fetchCount.Load(); got != 1 {
		t.Fatalf("expected 1 fetch during cache warm, got %d", got)
	}

	// (a) 10 concurrent unknown-kid requests must coalesce into at most 1 JWKS fetch.
	unknownTok := signWithKey("kid-unknown", unknownKey)
	const workers = 10
	startGate := make(chan struct{})
	var wg sync.WaitGroup
	errs := make([]error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-startGate
			_, errs[idx] = svc.Authenticate(context.Background(), "Bearer "+unknownTok)
		}(i)
	}
	close(startGate)

	select {
	case <-fetchEntered:
	case <-time.After(2 * time.Second):
		close(releaseFetch)
		t.Fatal("timed out waiting for coalesced JWKS fetch")
	}
	// Give remaining goroutines a brief moment to hit the in-flight singleflight barrier.
	time.Sleep(20 * time.Millisecond)
	close(releaseFetch)
	wg.Wait()

	for i, authErr := range errs {
		if !errors.Is(authErr, domain.ErrUnauthorized) {
			t.Fatalf("worker %d expected ErrUnauthorized, got %v", i, authErr)
		}
	}
	if got := fetchCount.Load(); got != 2 {
		t.Fatalf("expected 10 concurrent unknown-kid requests to trigger at most 1 refresh fetch (total=2), got %d", got)
	}

	// (b) A second unknown-kid within cooldown must trigger 0 fetches.
	unknownTok2 := signWithKey("kid-unknown-2", unknownKey)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+unknownTok2); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized during cooldown, got %v", err)
	}
	if got := fetchCount.Load(); got != 2 {
		t.Fatalf("expected 0 additional fetches within cooldown (total=2), got %d", got)
	}

	// After cooldown elapses, another unknown-kid is allowed to refresh once.
	time.Sleep(170 * time.Millisecond)
	if _, err := svc.Authenticate(context.Background(), "Bearer "+unknownTok2); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("expected ErrUnauthorized after cooldown, got %v", err)
	}
	if got := fetchCount.Load(); got != 3 {
		t.Fatalf("expected 1 fetch after cooldown elapsed (total=3), got %d", got)
	}
}
