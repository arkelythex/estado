import { afterEach, describe, expect, test } from 'bun:test'
import {
  ApiError,
  ModerationValidationError,
  fetchModerationCases,
  getAllowedActions,
  publishReport,
  rejectCase,
  runDemoIngest,
  triageCase,
  verifyCase,
  validateModerationReason,
  validatePublicText,
} from './admin-api'

interface CapturedRequest {
  url: string
  method: string
  headers: HeadersInit | undefined
  body: string | null
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : null
    const record: CapturedRequest = {
      url,
      method,
      headers: init?.headers,
      body,
    }
    captured.push(record)
    return handler(record)
  }

  Object.assign(fakeFetch, {
    preconnect: originalFetch.preconnect,
  })
  globalThis.fetch = fakeFetch as typeof fetch
  return captured
}

function getHeaderValue(
  headers: HeadersInit | undefined,
  key: string,
): string | null {
  if (!headers) {
    return null
  }
  if (headers instanceof Headers) {
    return headers.get(key)
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([k]) => k.toLowerCase() === key.toLowerCase())
    return match ? match[1] : null
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === key.toLowerCase()) {
      return v
    }
  }
  return null
}

describe('validateModerationReason & validatePublicText', () => {
  test('rejects empty or whitespace-only reason', () => {
    expect(() => validateModerationReason('')).toThrow(ModerationValidationError)
    expect(() => validateModerationReason('   \n\t  ')).toThrow(
      ModerationValidationError,
    )
  })

  test('accepts and trims valid reason', () => {
    expect(validateModerationReason('  Evidencia revisada por comité  ')).toBe(
      'Evidencia revisada por comité',
    )
  })

  test('rejects empty public text and trims valid public text', () => {
    expect(() => validatePublicText('   ')).toThrow(ModerationValidationError)
    expect(validatePublicText('  Resumen público sin PII  ')).toBe(
      'Resumen público sin PII',
    )
  })
})

describe('getAllowedActions', () => {
  test('returns valid next actions per report status', () => {
    expect(getAllowedActions('SUBMITTED')).toEqual(['TRIAGE', 'REJECT'])
    expect(getAllowedActions(' submitted ')).toEqual(['TRIAGE', 'REJECT'])
    expect(getAllowedActions('TRIAGED')).toEqual(['VERIFY', 'REJECT'])
    expect(getAllowedActions('VERIFIED')).toEqual(['PUBLISH'])
    expect(getAllowedActions('DRAFT')).toEqual([])
    expect(getAllowedActions('REJECTED')).toEqual([])
    expect(getAllowedActions('PUBLISHED')).toEqual([])
    expect(getAllowedActions('UNKNOWN')).toEqual([])
  })
})

describe('admin API client', () => {
  const baseUrl = 'http://localhost:8080/'

  test('fetchModerationCases attaches Authorization header and encodes query', async () => {
    const requests = mockFetch(() =>
      Response.json([
        {
          id: 'case-1',
          report_id: 'rep-1',
          municipality_id: 'cusco',
          status: 'SUBMITTED',
          category: 'OBRAS',
          description: 'Obra inconclusa',
          assigned_to: null,
          notes: null,
          created_at: '2026-06-15T10:00:00Z',
          updated_at: '2026-06-15T10:00:00Z',
        },
      ]),
    )

    const cases = await fetchModerationCases(
      ' mod-token-abc ',
      { municipalityId: ' cusco ', status: 'SUBMITTED' },
      baseUrl,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/moderation/cases?municipality_id=cusco&status=SUBMITTED',
    )
    expect(getHeaderValue(requests[0]?.headers, 'Authorization')).toBe(
      'Bearer mod-token-abc',
    )
    expect(cases).toHaveLength(1)
    expect(cases[0]?.report_id).toBe('rep-1')
  })

  test('fetchModerationCases omits status query when filter is ALL', async () => {
    const requests = mockFetch(() => Response.json([]))

    await fetchModerationCases(
      'mod-token-abc',
      { municipalityId: '', status: 'ALL' },
      baseUrl,
    )

    expect(requests[0]?.url).toBe(
      'http://localhost:8080/moderation/cases?municipality_id=lima',
    )
  })

  test('triageCase, verifyCase, rejectCase, and publishReport send expected payloads', async () => {
    const requests = mockFetch((req) => {
      if (req.url.endsWith('/publish')) {
        return Response.json({
          report_id: 'rep-42',
          status: 'PUBLISHED',
          publication: {
            id: 'pub-1',
            report_id: 'rep-42',
            municipality_id: 'arequipa',
            public_text: 'Resumen público redactado',
            published_at: '2026-06-16T12:00:00Z',
          },
        })
      }
      return Response.json({
        id: 'rep-42',
        municipality_id: 'arequipa',
        status: 'TRIAGED',
        category: 'OBRAS',
        description: 'Detalle',
        created_at: '2026-06-15T10:00:00Z',
      })
    })

    await triageCase(
      'mod-jwt',
      'rep-42',
      { municipalityId: 'arequipa', reason: '  Revisión inicial  ' },
      baseUrl,
    )
    await verifyCase(
      'mod-jwt',
      'rep-42',
      { municipalityId: 'arequipa', reason: 'Evidencia comprobada' },
      baseUrl,
    )
    await rejectCase(
      'mod-jwt',
      'rep-42',
      { municipalityId: 'arequipa', reason: 'Falta sustento documental' },
      baseUrl,
    )
    const published = await publishReport(
      'mod-jwt',
      'rep-42',
      {
        municipalityId: 'arequipa',
        reason: 'Aprobado para portal público',
        publicText: 'Resumen público redactado',
      },
      baseUrl,
    )

    expect(requests).toHaveLength(4)
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST http://localhost:8080/moderation/cases/rep-42/triage',
      'POST http://localhost:8080/moderation/cases/rep-42/verify',
      'POST http://localhost:8080/moderation/cases/rep-42/reject',
      'POST http://localhost:8080/moderation/reports/rep-42/publish',
    ])

    for (const req of requests) {
      expect(getHeaderValue(req.headers, 'Authorization')).toBe('Bearer mod-jwt')
      expect(getHeaderValue(req.headers, 'Content-Type')).toBe(
        'application/json',
      )
    }

    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      municipality_id: 'arequipa',
      reason: 'Revisión inicial',
    })
    expect(JSON.parse(requests[1]?.body ?? '{}')).toEqual({
      municipality_id: 'arequipa',
      reason: 'Evidencia comprobada',
    })
    expect(JSON.parse(requests[2]?.body ?? '{}')).toEqual({
      municipality_id: 'arequipa',
      reason: 'Falta sustento documental',
    })
    expect(JSON.parse(requests[3]?.body ?? '{}')).toEqual({
      municipality_id: 'arequipa',
      reason: 'Aprobado para portal público',
      public_text: 'Resumen público redactado',
    })
    expect(published.status).toBe('PUBLISHED')
  })

  test('mutations reject blank reason before calling fetch', async () => {
    const requests = mockFetch(() => Response.json({}))

    await expect(
      triageCase('mod-jwt', 'rep-1', { municipalityId: 'lima', reason: '   ' }, baseUrl),
    ).rejects.toThrow(ModerationValidationError)
    await expect(
      publishReport(
        'mod-jwt',
        'rep-1',
        { municipalityId: 'lima', reason: 'ok', publicText: '   ' },
        baseUrl,
      ),
    ).rejects.toThrow(ModerationValidationError)

    expect(requests).toHaveLength(0)
  })

  test('runDemoIngest sends POST with municipality_id and parses IngestResult', async () => {
    const requests = mockFetch(() =>
      Response.json({
        municipality_id: 'trujillo',
        dataset_version_id: 'ver-99',
        checksum_sha256: 'abc123',
        rows_ingested: 0,
        deduplicated: true,
      }),
    )

    const res = await runDemoIngest('admin-jwt', 'trujillo', baseUrl)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/admin/ingest/demo?municipality_id=trujillo',
    )
    expect(getHeaderValue(requests[0]?.headers, 'Authorization')).toBe(
      'Bearer admin-jwt',
    )
    expect(res.deduplicated).toBe(true)
    expect(res.dataset_version_id).toBe('ver-99')
    expect(res.checksum_sha256).toBe('abc123')
    expect(res.rows_ingested).toBe(0)
  })

  test('handles 401, 403, and 422 HTTP error responses cleanly without leaking raw backend text', async () => {
    for (const [status, expectedMsg] of [
      [401, 'No autenticado. Verifica tu token Bearer.'],
      [403, 'No tienes permisos para realizar esta acción.'],
      [422, 'Transición de estado no permitida.'],
    ] as const) {
      mockFetch(() => Response.json({ error: 'raw-sensitive-backend-error' }, { status }))
      try {
        await fetchModerationCases('bad-token', { municipalityId: 'lima' }, baseUrl)
        expect.unreachable('should have thrown ApiError')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ApiError)
        if (err instanceof ApiError) {
          expect(err.status).toBe(status)
          expect(err.message).toBe(expectedMsg)
          expect(err.message).not.toContain('raw-sensitive-backend-error')
        }
      }
    }
  })
})
