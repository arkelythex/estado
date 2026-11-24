import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const PUBLIC_LLMS_PATH = resolve(import.meta.dir, '../../public/llms.txt')
const ROUTES_DIR = resolve(import.meta.dir, '../routes')

describe('AI-first public /llms.txt & route semantics', () => {
  test('apps/web/public/llms.txt documents portal routes, Go discovery URLs, privacy rules, and integer-cent policy', async () => {
    const file = Bun.file(PUBLIC_LLMS_PATH)
    expect(await file.exists()).toBe(true)

    const content = await file.text()
    for (const token of [
      '/expenses',
      '/report',
      '/reports',
      '/reports/$id',
      '/openapi.json',
      '/llms.txt',
      '/.well-known/agent.json',
      'amount_cents',
      'BigInt',
      'PII',
      'municipality_id',
      '/public/audit/verify',
      '/public/reports/track',
      '/public/ocds/releases.json',
      '/public/anomalies',
      'X-Receipt-Code',
    ]) {
      expect(content).toContain(token)
    }
  })

  test('apps/web routes expose deterministic agent testids and aria-live semantics', async () => {
    const rootSrc = await Bun.file(resolve(ROUTES_DIR, '__root.tsx')).text()
    for (const attr of [
      'data-testid="municipality-select"',
      'data-testid="topbar-search-input"',
      'data-testid="cta-new-report"',
      'data-testid="live-sync-badge"',
      'data-testid="mobile-bottom-nav"',
    ]) {
      expect(rootSrc).toContain(attr)
    }

    const indexSrc = await Bun.file(resolve(ROUTES_DIR, 'index.tsx')).text()
    for (const attr of [
      'data-testid="kpi-datasets"',
      'data-testid="kpi-versions"',
      'data-testid="kpi-integrity"',
      'data-testid="dataset-card"',
      'data-testid="audit-chain-status"',
      'data-testid="anomalies-panel"',
      'data-testid="ocds-export-link"',
    ]) {
      expect(indexSrc).toContain(attr)
    }

    const expensesSrc = await Bun.file(resolve(ROUTES_DIR, 'expenses.tsx')).text()
    for (const attr of [
      'data-testid="expenses-total"',
      'data-testid="filter-category"',
      'data-testid="filter-submit"',
      'data-testid="expenses-table"',
      'data-testid="expense-row"',
      'data-testid="expenses-ocds-link"',
    ]) {
      expect(expensesSrc).toContain(attr)
    }

    const reportSrc = await Bun.file(resolve(ROUTES_DIR, 'report.tsx')).text()
    for (const attr of [
      'data-testid="report-step"',
      'data-step={step}',
      'data-testid="report-category"',
      'data-testid="report-description"',
      'data-testid="report-create-btn"',
      'data-testid="report-continue-btn"',
      'data-testid="report-submit-btn"',
      'data-testid="report-status-alert"',
      'data-testid="report-receipt-code"',
      'aria-live="polite"',
    ]) {
      expect(reportSrc).toContain(attr)
    }

    const reportsIndexSrc = await Bun.file(resolve(ROUTES_DIR, 'reports/index.tsx')).text()
    for (const attr of [
      'data-testid="public-report-card"',
      'data-testid="receipt-tracker-form"',
      'data-testid="receipt-code-input"',
      'data-testid="receipt-track-btn"',
      'data-testid="receipt-track-result"',
    ]) {
      expect(reportsIndexSrc).toContain(attr)
    }

    const reportDetailSrc = await Bun.file(resolve(ROUTES_DIR, 'reports/$id.tsx')).text()
    expect(reportDetailSrc).toContain('data-testid="public-report-detail"')
    expect(reportDetailSrc).toContain('data-testid="public-evidence-count"')
  })
})
