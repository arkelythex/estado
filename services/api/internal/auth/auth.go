package auth

import (
	"context"
	"crypto/rsa"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/arkelythex/estado/services/api/internal/domain"
	"github.com/golang-jwt/jwt/v5"
)

type Mode string

const (
	ModeDisabled  Mode = "disabled"
	ModeDevStatic Mode = "dev_static"
	ModeOIDCJWKS  Mode = "oidc_jwks"
)

func ParseMode(raw string) Mode {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "disabled":
		return ModeDisabled
	case "oidc", "oidc_jwks":
		return ModeOIDCJWKS
	default:
		return ModeDevStatic
	}
}

type Config struct {
	Mode                Mode
	DevAdminToken       string
	DevModeratorToken   string
	OIDCIssuer          string
	OIDCJWKSURL         string
	OIDCAudience        string
	OIDCClientID        string
	JWKSCacheTTL        time.Duration
	JWKSRefreshCooldown time.Duration
	HTTPClient          *http.Client
}

type jwkKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwkSet struct {
	Keys []jwkKey `json:"keys"`
}

type jwksCacheEntry struct {
	fetchedAt  time.Time
	generation uint64
	keys       map[string]*rsa.PublicKey
}

type jwksRefreshCall struct {
	done       chan struct{}
	keys       map[string]*rsa.PublicKey
	err        error
	generation uint64
}

type Service struct {
	cfg          Config
	httpClient   *http.Client
	mu           sync.Mutex
	cache        *jwksCacheEntry
	inFlight     *jwksRefreshCall
	refreshGen   uint64
	lastForcedAt time.Time
}

func NewService(cfg Config) *Service {
	ttl := cfg.JWKSCacheTTL
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	cfg.JWKSCacheTTL = ttl

	cooldown := cfg.JWKSRefreshCooldown
	if cooldown <= 0 {
		cooldown = 15 * time.Second
	}
	cfg.JWKSRefreshCooldown = cooldown

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	return &Service{
		cfg:        cfg,
		httpClient: client,
	}
}

func (s *Service) Authenticate(ctx context.Context, authHeader string) (domain.Principal, error) {
	switch s.cfg.Mode {
	case ModeDisabled:
		return domain.Principal{
			Subject: "anonymous",
			Roles: map[domain.Role]bool{
				domain.RoleAdmin:     true,
				domain.RoleModerator: true,
			},
		}, nil
	case ModeDevStatic:
		return s.authenticateDevStatic(authHeader)
	case ModeOIDCJWKS:
		return s.authenticateOIDC(ctx, authHeader)
	default:
		return domain.Principal{}, domain.ErrUnauthorized
	}
}

func (s *Service) RequireRoles(principal domain.Principal, allowed ...domain.Role) error {
	if principal.HasAnyRole(allowed...) {
		return nil
	}
	return domain.ErrForbidden
}

func (s *Service) authenticateDevStatic(authHeader string) (domain.Principal, error) {
	token, err := parseBearer(authHeader)
	if err != nil {
		return domain.Principal{}, err
	}

	// Never allow empty configured tokens to match anything.
	if s.cfg.DevAdminToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.DevAdminToken)) == 1 {
		return domain.Principal{
			Subject: "dev-admin",
			Roles: map[domain.Role]bool{
				domain.RoleAdmin:     true,
				domain.RoleModerator: true,
			},
		}, nil
	}

	if s.cfg.DevModeratorToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.DevModeratorToken)) == 1 {
		return domain.Principal{
			Subject: "dev-moderator",
			Roles: map[domain.Role]bool{
				domain.RoleModerator: true,
			},
		}, nil
	}

	return domain.Principal{}, domain.ErrUnauthorized
}

type oidcClaims struct {
	jwt.RegisteredClaims
	Roles          []string                  `json:"roles"`
	RealmAccess    *realmAccessClaim         `json:"realm_access"`
	ResourceAccess map[string]resourceAccess `json:"resource_access"`
}

type realmAccessClaim struct {
	Roles []string `json:"roles"`
}

type resourceAccess struct {
	Roles []string `json:"roles"`
}

func (s *Service) authenticateOIDC(ctx context.Context, authHeader string) (domain.Principal, error) {
	tokenStr, err := parseBearer(authHeader)
	if err != nil {
		return domain.Principal{}, err
	}

	jwksURL := strings.TrimSpace(s.cfg.OIDCJWKSURL)
	issuer := strings.TrimSpace(s.cfg.OIDCIssuer)
	audience := strings.TrimSpace(s.cfg.OIDCAudience)
	if jwksURL == "" || issuer == "" || audience == "" {
		return domain.Principal{}, fmt.Errorf("%w: OIDC issuer, audience, and JWKS URL must be configured", domain.ErrUnauthorized)
	}

	parserOpts := []jwt.ParserOption{
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
	}

	claims := &oidcClaims{}
	token, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		kid = strings.TrimSpace(kid)
		if kid == "" {
			return nil, domain.ErrUnauthorized
		}
		keys, fromCache, err := s.getJWKSKeys(ctx, false)
		if err != nil {
			return nil, err
		}
		pubKey, ok := keys[kid]
		if !ok {
			if fromCache {
				// Unknown kid may indicate IdP key rotation; force a JWKS refresh (coalesced & cooldown-guarded).
				keys, _, err = s.getJWKSKeys(ctx, true)
				if err != nil {
					return nil, err
				}
				pubKey, ok = keys[kid]
			} else {
				// Arm unknown-kid cooldown after a fresh fetch so immediate retries cannot hammer JWKS.
				s.noteUnknownKidCooldown()
			}
			if !ok {
				return nil, domain.ErrUnauthorized
			}
		}
		return pubKey, nil
	}, parserOpts...)
	if err != nil || !token.Valid {
		return domain.Principal{}, domain.ErrUnauthorized
	}

	if strings.TrimSpace(claims.Subject) == "" {
		return domain.Principal{}, domain.ErrUnauthorized
	}

	roles := extractRoles(claims, s.cfg.OIDCClientID)
	return domain.Principal{
		Subject: claims.Subject,
		Roles:   roles,
	}, nil
}

func (s *Service) noteUnknownKidCooldown() {
	s.mu.Lock()
	if s.lastForcedAt.IsZero() || time.Since(s.lastForcedAt) >= s.cfg.JWKSRefreshCooldown {
		s.lastForcedAt = time.Now()
	}
	s.mu.Unlock()
}

func (s *Service) getJWKSKeys(ctx context.Context, forceRefresh bool) (map[string]*rsa.PublicKey, bool, error) {
	s.mu.Lock()
	cached := s.cache
	if !forceRefresh && cached != nil && time.Since(cached.fetchedAt) < s.cfg.JWKSCacheTTL {
		keys := cached.keys
		s.mu.Unlock()
		return keys, true, nil
	}

	// Singleflight: coalesce concurrent TTL expirations or unknown-kid bursts into one HTTP fetch.
	if s.inFlight != nil {
		call := s.inFlight
		s.mu.Unlock()
		select {
		case <-call.done:
			return call.keys, false, call.err
		case <-ctx.Done():
			return nil, false, ctx.Err()
		}
	}

	if forceRefresh {
		if !s.lastForcedAt.IsZero() && time.Since(s.lastForcedAt) < s.cfg.JWKSRefreshCooldown {
			var keys map[string]*rsa.PublicKey
			if cached != nil {
				keys = cached.keys
			}
			s.mu.Unlock()
			if keys != nil {
				return keys, true, nil
			}
			return nil, true, domain.ErrUnauthorized
		}
		s.lastForcedAt = time.Now()
	}

	s.refreshGen++
	gen := s.refreshGen
	call := &jwksRefreshCall{
		done:       make(chan struct{}),
		generation: gen,
	}
	s.inFlight = call
	s.mu.Unlock()

	fetchTimeout := 10 * time.Second
	if s.httpClient != nil && s.httpClient.Timeout > 0 {
		fetchTimeout = s.httpClient.Timeout
	}
	fetchCtx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	// Perform outbound HTTP fetch without holding s.mu.Lock() so concurrent verifications aren't stalled.
	parsed, fetchErr := s.fetchJWKS(fetchCtx)
	cancel()

	now := time.Now()
	s.mu.Lock()
	if s.inFlight == call {
		s.inFlight = nil
	}
	if fetchErr != nil {
		if s.cache != nil && len(s.cache.keys) > 0 {
			call.keys = s.cache.keys
			call.err = nil
		} else {
			call.err = fetchErr
		}
	} else {
		if s.cache == nil || (gen > s.cache.generation && !now.Before(s.cache.fetchedAt)) {
			s.cache = &jwksCacheEntry{
				fetchedAt:  now,
				generation: gen,
				keys:       parsed,
			}
		}
		call.keys = s.cache.keys
	}
	close(call.done)
	s.mu.Unlock()

	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	return call.keys, false, call.err
}

func (s *Service) fetchJWKS(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.OIDCJWKSURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build jwks request: %w", err)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch jwks: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks endpoint returned status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("read jwks body: %w", err)
	}

	var set jwkSet
	if err := json.Unmarshal(raw, &set); err != nil {
		return nil, fmt.Errorf("decode jwks: %w", err)
	}

	parsed := make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || strings.TrimSpace(k.Kid) == "" {
			continue
		}
		if k.Alg != "" && k.Alg != jwt.SigningMethodRS256.Alg() {
			continue
		}
		if k.Use != "" && k.Use != "sig" {
			continue
		}
		pub, err := parseRSAPublicKey(k.N, k.E)
		if err != nil {
			continue
		}
		parsed[k.Kid] = pub
	}
	return parsed, nil
}

func parseRSAPublicKey(nStr, eStr string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nStr)
	if err != nil {
		return nil, fmt.Errorf("decode jwk n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eStr)
	if err != nil {
		return nil, fmt.Errorf("decode jwk e: %w", err)
	}
	n := new(big.Int).SetBytes(nBytes)
	e := new(big.Int).SetBytes(eBytes)
	if n.Sign() <= 0 || !e.IsInt64() || e.Int64() <= 0 {
		return nil, fmt.Errorf("invalid rsa parameters")
	}
	return &rsa.PublicKey{
		N: n,
		E: int(e.Int64()),
	}, nil
}

func parseBearer(header string) (string, error) {
	if strings.TrimSpace(header) == "" {
		return "", domain.ErrUnauthorized
	}
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", domain.ErrUnauthorized
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", domain.ErrUnauthorized
	}
	return token, nil
}

func extractRoles(claims *oidcClaims, clientID string) map[domain.Role]bool {
	out := make(map[domain.Role]bool)
	addRaw := func(rawRoles []string) {
		for _, r := range rawRoles {
			switch strings.ToUpper(strings.TrimSpace(r)) {
			case "ADMIN", "REALM-ADMIN":
				out[domain.RoleAdmin] = true
			case "MODERATOR":
				out[domain.RoleModerator] = true
			}
		}
	}

	addRaw(claims.Roles)
	if claims.RealmAccess != nil {
		addRaw(claims.RealmAccess.Roles)
	}
	trimmedClientID := strings.TrimSpace(clientID)
	if claims.ResourceAccess != nil && trimmedClientID != "" {
		if ra, ok := claims.ResourceAccess[trimmedClientID]; ok {
			addRaw(ra.Roles)
		}
	}
	return out
}
