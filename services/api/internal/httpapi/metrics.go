package httpapi

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

type Metrics struct {
	mu              sync.Mutex
	httpRequests    map[string]uint64
	httpDurationSum map[string]float64
	httpDurationCnt map[string]uint64
	transitions     map[string]uint64
	ingestRuns      map[string]uint64
	ingestRowsTotal uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		httpRequests:    make(map[string]uint64),
		httpDurationSum: make(map[string]float64),
		httpDurationCnt: make(map[string]uint64),
		transitions:     make(map[string]uint64),
		ingestRuns:      make(map[string]uint64),
	}
}

func (m *Metrics) ObserveHTTP(method, route string, status int, dur time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := fmt.Sprintf(`method="%s",route="%s",status="%d"`, method, route, status)
	m.httpRequests[key]++
	durKey := fmt.Sprintf(`method="%s",route="%s"`, method, route)
	m.httpDurationSum[durKey] += dur.Seconds()
	m.httpDurationCnt[durKey]++
}

func (m *Metrics) ObserveTransition(fromStatus, toStatus, action string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := fmt.Sprintf(`from_status="%s",to_status="%s",action="%s"`, fromStatus, toStatus, action)
	m.transitions[key]++
}

func (m *Metrics) ObserveIngest(outcome string, rows int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := fmt.Sprintf(`status="%s"`, outcome)
	m.ingestRuns[key]++
	if rows > 0 {
		m.ingestRowsTotal += uint64(rows)
	}
}

func (m *Metrics) Render() string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var sb strings.Builder
	sb.WriteString("# HELP civictech_http_requests_total Total HTTP requests processed\n")
	sb.WriteString("# TYPE civictech_http_requests_total counter\n")
	for _, k := range sortedKeys(m.httpRequests) {
		sb.WriteString(fmt.Sprintf("civictech_http_requests_total{%s} %d\n", k, m.httpRequests[k]))
	}

	sb.WriteString("# HELP civictech_http_request_duration_seconds Total HTTP request duration in seconds\n")
	sb.WriteString("# TYPE civictech_http_request_duration_seconds summary\n")
	for _, k := range sortedKeys(m.httpDurationCnt) {
		sb.WriteString(fmt.Sprintf("civictech_http_request_duration_seconds_sum{%s} %.6f\n", k, m.httpDurationSum[k]))
		sb.WriteString(fmt.Sprintf("civictech_http_request_duration_seconds_count{%s} %d\n", k, m.httpDurationCnt[k]))
	}

	sb.WriteString("# HELP civictech_report_transitions_total Total report state transitions\n")
	sb.WriteString("# TYPE civictech_report_transitions_total counter\n")
	for _, k := range sortedKeys(m.transitions) {
		sb.WriteString(fmt.Sprintf("civictech_report_transitions_total{%s} %d\n", k, m.transitions[k]))
	}

	sb.WriteString("# HELP civictech_ingest_runs_total Total dataset ingestion attempts\n")
	sb.WriteString("# TYPE civictech_ingest_runs_total counter\n")
	for _, k := range sortedKeys(m.ingestRuns) {
		sb.WriteString(fmt.Sprintf("civictech_ingest_runs_total{%s} %d\n", k, m.ingestRuns[k]))
	}

	sb.WriteString("# HELP civictech_ingest_rows_total Total expense rows ingested\n")
	sb.WriteString("# TYPE civictech_ingest_rows_total counter\n")
	sb.WriteString(fmt.Sprintf("civictech_ingest_rows_total %d\n", m.ingestRowsTotal))

	return sb.String()
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
