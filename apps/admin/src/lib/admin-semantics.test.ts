import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const ROUTES_DIR = resolve(import.meta.dir, '../routes')

describe('apps/admin route AI-agent semantics', () => {
  test('__root.tsx exposes auth state and token/municipality testids', async () => {
    const rootSrc = await Bun.file(resolve(ROUTES_DIR, '__root.tsx')).text()
    for (const attr of [
      'data-testid="admin-auth-state"',
      "data-state={hasToken ? 'authenticated' : 'unauthenticated'}",
      'data-testid="admin-token-input"',
      'data-testid="admin-token-apply"',
      'data-testid="admin-token-clear"',
      'data-testid="admin-municipality-select"',
    ]) {
      expect(rootSrc).toContain(attr)
    }
  })

  test('index.tsx exposes moderation table, case rows, Spanish action testids, aria-live, and Actualizar Cola button', async () => {
    const indexSrc = await Bun.file(resolve(ROUTES_DIR, 'index.tsx')).text()
    for (const attr of [
      'data-testid="moderation-queue-table"',
      'data-testid="case-row"',
      'data-status={item.status}',
      'data-testid="moderation-reason-input"',
      'data-testid="moderation-public-text-input"',
      'data-testid="moderation-submit-btn"',
      'aria-live="polite"',
      'Actualizar Cola',
      'disabled={!hasToken || isLoading}',
    ]) {
      expect(indexSrc).toContain(attr)
    }
    expect(indexSrc).not.toContain('Triaje (Triage)')
  })

  test('ingest.tsx exposes ingest run button, checksum, deduplicated badge, and aria-live', async () => {
    const ingestSrc = await Bun.file(resolve(ROUTES_DIR, 'ingest.tsx')).text()
    for (const attr of [
      'data-testid="ingest-run-btn"',
      'data-testid="ingest-checksum"',
      'data-testid="ingest-deduplicated"',
      'data-deduplicated={String(latestResult.deduplicated)}',
      'aria-live="polite"',
      'Ejecutar Ingesta Demo',
      'disabled={!hasToken || isRunning}',
    ]) {
      expect(ingestSrc).toContain(attr)
    }
  })
})
