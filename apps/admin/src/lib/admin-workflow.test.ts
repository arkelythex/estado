import { describe, expect, test } from 'bun:test'
import type { IngestResult, ModerationCase } from './admin-api'
import {
  createScopeGuard,
  executeScopedDemoIngest,
  executeScopedModerationAction,
  loadScopedModerationQueue,
} from './admin-workflow'

const SAMPLE_CASE: ModerationCase = {
  id: 'case-1',
  report_id: 'rep-1',
  municipality_id: 'lima',
  status: 'SUBMITTED',
  category: 'OBRAS',
  description: 'Detalle ciudadano',
  assigned_to: null,
  notes: null,
  created_at: '2026-06-15T10:00:00Z',
  updated_at: '2026-06-15T10:00:00Z',
}

describe('admin-workflow scope isolation & async safety', () => {
  test('loadScopedModerationQueue drops stale response after token or municipality change', async () => {
    const guard = createScopeGuard()
    let resolveOld: ((items: ModerationCase[]) => void) | undefined

    const pendingOld = loadScopedModerationQueue(
      guard,
      'token-old',
      'lima',
      'ALL',
      () =>
        new Promise<ModerationCase[]>((resolve) => {
          resolveOld = resolve
        }),
    )

    // Simulate credential clear or municipality switch before old request finishes
    guard.invalidateScope()

    const currentResult = await loadScopedModerationQueue(
      guard,
      'token-new',
      'cusco',
      'ALL',
      async () => [{ ...SAMPLE_CASE, municipality_id: 'cusco' }],
    )
    expect(currentResult.status).toBe('ok')
    if (currentResult.status === 'ok') {
      expect(currentResult.cases[0]?.municipality_id).toBe('cusco')
    }

    resolveOld?.([SAMPLE_CASE])
    const staleResult = await pendingOld
    expect(staleResult).toEqual({ status: 'stale' })
  })

  test('executeScopedModerationAction marks completion stale if scope changes mid-flight', async () => {
    const guard = createScopeGuard()
    let resolveTriage: (() => void) | undefined

    const pendingAction = executeScopedModerationAction(
      guard,
      {
        token: 'mod-token',
        municipalityId: 'lima',
        reportId: 'rep-1',
        action: 'TRIAGE',
        reason: 'Revisión inicial',
        publicText: '',
      },
      {
        triage: async () =>
          new Promise((resolve) => {
            resolveTriage = () =>
              resolve({
                id: 'rep-1',
                municipality_id: 'lima',
                status: 'TRIAGED',
                category: 'OBRAS',
                description: 'Detalle',
                created_at: '2026-06-15T10:00:00Z',
              })
          }),
      },
    )

    guard.invalidateScope()
    resolveTriage?.()
    const outcome = await pendingAction
    expect(outcome).toEqual({ status: 'stale' })
  })

  test('executeScopedModerationAction applies publish with explicit redacted publicText', async () => {
    const guard = createScopeGuard()
    const captured: Array<{ reason: string; publicText: string }> = []

    const outcome = await executeScopedModerationAction(
      guard,
      {
        token: 'mod-token',
        municipalityId: 'arequipa',
        reportId: 'rep-2',
        action: 'PUBLISH',
        reason: 'Aprobado sin PII',
        publicText: 'Resumen público redactado',
      },
      {
        publish: async (_t, _id, input) => {
          captured.push({ reason: input.reason, publicText: input.publicText })
          return {
            report_id: 'rep-2',
            status: 'PUBLISHED',
            publication: {
              id: 'pub-1',
              report_id: 'rep-2',
              municipality_id: 'arequipa',
              public_text: input.publicText,
              published_at: '2026-06-16T12:00:00Z',
            },
          }
        },
      },
    )

    expect(outcome).toEqual({ status: 'applied' })
    expect(captured).toEqual([
      { reason: 'Aprobado sin PII', publicText: 'Resumen público redactado' },
    ])
  })

  test('executeScopedDemoIngest drops stale result when credentials or municipality change', async () => {
    const guard = createScopeGuard()
    let resolveIngest: ((res: IngestResult) => void) | undefined

    const pending = executeScopedDemoIngest(
      guard,
      'admin-old',
      'lima',
      () =>
        new Promise<IngestResult>((resolve) => {
          resolveIngest = resolve
        }),
    )

    guard.invalidateScope()
    resolveIngest?.({
      municipality_id: 'lima',
      dataset_version_id: 'ver-1',
      checksum_sha256: 'abc',
      rows_ingested: 3,
      deduplicated: false,
    })

    const outcome = await pending
    expect(outcome).toEqual({ status: 'stale' })
  })

  test('loadScopedModerationQueue treats stale same-scope rejection as stale after newer success', async () => {
    const guard = createScopeGuard()
    let rejectOld: ((err: Error) => void) | undefined

    const pendingOld = loadScopedModerationQueue(
      guard,
      'token-1',
      'lima',
      'ALL',
      () =>
        new Promise<ModerationCase[]>((_resolve, reject) => {
          rejectOld = reject
        }),
    )

    const newerResult = await loadScopedModerationQueue(
      guard,
      'token-1',
      'lima',
      'ALL',
      async () => [SAMPLE_CASE],
    )
    expect(newerResult.status).toBe('ok')

    rejectOld?.(new Error('network timeout'))
    const staleFailure = await pendingOld
    expect(staleFailure).toEqual({ status: 'stale' })
  })
})
