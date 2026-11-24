package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

type Client struct {
	baseURL       string
	internalToken string
	httpClient    *http.Client
}

func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: httpClient,
	}
}

func (c *Client) WithInternalToken(token string) *Client {
	c.internalToken = strings.TrimSpace(token)
	return c
}

type transitionReq struct {
	CurrentStatus string `json:"current_status"`
	Action        string `json:"action"`
}

type parseExpensesReq struct {
	CSV string `json:"csv"`
}

type auditHashResp struct {
	EventHash string `json:"event_hash"`
}

type verifyChainReq struct {
	Entries []domain.AuditChainEntry `json:"entries"`
}

type analyzeExpensesReq struct {
	ThresholdCents *int64                         `json:"threshold_cents,omitempty"`
	Expenses       []domain.ExpenseAnalyticsInput `json:"expenses"`
}

type engineErrorResp struct {
	Error string `json:"error"`
}

func (c *Client) TransitionReport(ctx context.Context, currentStatus, action string) (domain.TransitionResult, error) {
	payload := transitionReq{
		CurrentStatus: currentStatus,
		Action:        action,
	}
	var out domain.TransitionResult
	if err := c.postJSON(ctx, "/internal/v1/reports/transition", payload, &out); err != nil {
		return domain.TransitionResult{}, err
	}
	return out, nil
}

func (c *Client) ParseExpenses(ctx context.Context, csvContent string) (domain.ParsedExpenses, error) {
	payload := parseExpensesReq{CSV: csvContent}
	var out domain.ParsedExpenses
	if err := c.postJSON(ctx, "/internal/v1/ingest/parse-expenses", payload, &out); err != nil {
		return domain.ParsedExpenses{}, err
	}
	return out, nil
}

func (c *Client) ComputeAuditHash(ctx context.Context, input domain.AuditChainInput) (string, error) {
	var out auditHashResp
	if err := c.postJSON(ctx, "/internal/v1/audit/hash", input, &out); err != nil {
		return "", err
	}
	return out.EventHash, nil
}

func (c *Client) VerifyAuditChain(ctx context.Context, entries []domain.AuditChainEntry) (domain.ChainVerification, error) {
	if entries == nil {
		entries = make([]domain.AuditChainEntry, 0)
	}
	payload := verifyChainReq{Entries: entries}
	var out domain.ChainVerification
	if err := c.postJSON(ctx, "/internal/v1/audit/verify-chain", payload, &out); err != nil {
		return domain.ChainVerification{}, err
	}
	return out, nil
}

func (c *Client) AnalyzeExpenses(ctx context.Context, thresholdCents *int64, expenses []domain.ExpenseAnalyticsInput) (domain.AnalyzeExpensesResponse, error) {
	if expenses == nil {
		expenses = make([]domain.ExpenseAnalyticsInput, 0)
	}
	payload := analyzeExpensesReq{
		ThresholdCents: thresholdCents,
		Expenses:       expenses,
	}
	var out domain.AnalyzeExpensesResponse
	if err := c.postJSON(ctx, "/internal/v1/analytics/red-flags", payload, &out); err != nil {
		return domain.AnalyzeExpensesResponse{}, err
	}
	if out.Flags == nil {
		out.Flags = make([]domain.FiscalRedFlag, 0)
	}
	return out, nil
}

func (c *Client) postJSON(ctx context.Context, path string, reqBody any, dst any) error {
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("marshal engine request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build engine request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.internalToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.internalToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("call engine %s: %w", path, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("read engine response: %w", err)
	}

	if resp.StatusCode == http.StatusOK {
		if err := json.Unmarshal(body, dst); err != nil {
			return fmt.Errorf("decode engine response: %w", err)
		}
		return nil
	}

	var errPayload engineErrorResp
	_ = json.Unmarshal(body, &errPayload)
	msg := strings.TrimSpace(errPayload.Error)
	if msg == "" {
		msg = fmt.Sprintf("engine returned status %d", resp.StatusCode)
	}

	switch resp.StatusCode {
	case http.StatusUnprocessableEntity:
		return fmt.Errorf("%w: %s", domain.ErrInvalidTransition, msg)
	case http.StatusBadRequest:
		return fmt.Errorf("%w: %s", domain.ErrValidation, msg)
	default:
		return fmt.Errorf("engine error (%d): %s", resp.StatusCode, msg)
	}
}
