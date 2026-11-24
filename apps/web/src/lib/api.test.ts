import { afterEach, describe, expect, test } from 'bun:test'
import {
  ApiError,
  buildExpensesQuery,
  computeSha256Hex,
  createReport,
  fetchDatasets,
  fetchExpenses,
  fetchPublishedReport,
  fetchPublishedReports,
  formatBigIntCentsPEN,
  formatCentsPEN,
  requestEvidenceUpload,
  submitReport,
  sumExpenseCents,
  uploadEvidenceToPresignedUrl,
} from './api'

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

function mockFetchOnce(
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

describe('formatCentsPEN & exact integer arithmetic', () => {
  test('formats zero, single-digit cents, thousands, and negative cents', () => {
    expect(formatCentsPEN(0)).toBe('S/ 0.00')
    expect(formatCentsPEN(5)).toBe('S/ 0.05')
    expect(formatCentsPEN(99)).toBe('S/ 0.99')
    expect(formatCentsPEN(125075)).toBe('S/ 1,250.75')
    expect(formatCentsPEN(100000000)).toBe('S/ 1,000,000.00')
    expect(formatCentsPEN(-125075)).toBe('-S/ 1,250.75')
  })

  test('formats large safe integers without floating-point drift', () => {
    expect(formatCentsPEN(9007199254740991)).toBe('S/ 90,071,992,547,409.91')
    expect(formatBigIntCentsPEN(99999999999999999999n)).toBe(
      'S/ 999,999,999,999,999,999.99',
    )
  })

  test('rejects non-integer inputs', () => {
    expect(() => formatCentsPEN(12.34)).toThrow(RangeError)
    expect(() => formatCentsPEN(Number.NaN)).toThrow(RangeError)
  })

  test('sums expense cents exactly with BigInt', () => {
    const total = sumExpenseCents([
      { amount_cents: 10 },
      { amount_cents: 20 },
      { amount_cents: 125045 },
    ])
    expect(total).toBe(125075n)
    expect(formatBigIntCentsPEN(total)).toBe('S/ 1,250.75')
  })
})

describe('computeSha256Hex', () => {
  test('computes deterministic lowercase SHA-256 hex digest', async () => {
    const blob = new Blob(['hola civictech'], { type: 'text/plain' })
    const hash = await computeSha256Hex(blob)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    const second = await computeSha256Hex(new Blob(['hola civictech']))
    expect(second).toBe(hash)
  })
})

describe('API client URL construction, parsing, and error handling', () => {
  const baseUrl = 'http://localhost:8080/'

  test('fetchDatasets encodes municipality_id and parses response', async () => {
    const requests = mockFetchOnce(() =>
      Response.json([
        {
          id: 'ds-1',
          municipality_id: 'arequipa',
          name: 'Gastos 2026',
          kind: 'expenses',
          versions: 2,
          created_at: '2026-06-01T00:00:00Z',
        },
      ]),
    )

    const result = await fetchDatasets(' arequipa ', baseUrl)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/public/datasets?municipality_id=arequipa',
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.name).toBe('Gastos 2026')
  })

  test('buildExpensesQuery and fetchExpenses encode optional filters cleanly', async () => {
    expect(
      buildExpensesQuery({
        municipality_id: '',
        entity: ' Obras Públicas ',
        category: 'Infraestructura',
        from: '2026-01-01',
        to: '2026-06-30',
      }),
    ).toBe(
      'municipality_id=lima&entity=Obras+P%C3%BAblicas&category=Infraestructura&from=2026-01-01&to=2026-06-30',
    )

    const requests = mockFetchOnce(() =>
      Response.json([
        {
          id: 'exp-1',
          municipality_id: 'cusco',
          version_id: 'ver-1',
          entity: 'Gerencia de Obras',
          category: 'Infraestructura',
          amount_cents: 125075,
          amount: '1250.75',
          occurred_on: '2026-03-15',
          doc_ref: 'OC-2026-01',
        },
      ]),
    )

    const expenses = await fetchExpenses(
      {
        municipality_id: 'cusco',
        entity: 'Gerencia de Obras',
      },
      baseUrl,
    )
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/public/expenses?municipality_id=cusco&entity=Gerencia+de+Obras',
    )
    expect(expenses[0]?.amount_cents).toBe(125075)
  })

  test('fetchPublishedReports and fetchPublishedReport construct expected URLs', async () => {
    const requests = mockFetchOnce((req) => {
      if (req.url.includes('/public/reports/rep-123')) {
        return Response.json({
          id: 'pub-1',
          report_id: 'rep-123',
          municipality_id: 'trujillo',
          status: 'PUBLISHED',
          category: 'Contrataciones',
          public_text: 'Texto público redactado',
          published_at: '2026-06-10T12:00:00Z',
          evidence: [],
        })
      }
      return Response.json([])
    })

    await fetchPublishedReports('trujillo', baseUrl)
    const detail = await fetchPublishedReport('rep-123', 'trujillo', baseUrl)

    expect(requests[0]?.url).toBe(
      'http://localhost:8080/public/reports?municipality_id=trujillo',
    )
    expect(requests[1]?.url).toBe(
      'http://localhost:8080/public/reports/rep-123?municipality_id=trujillo',
    )
    expect(detail.public_text).toBe('Texto público redactado')
    expect(detail.evidence_count).toBe(0)

    mockFetchOnce(() =>
      Response.json({
        id: 'pub-2',
        report_id: 'rep-bad',
        municipality_id: 'trujillo',
        status: 'PUBLISHED',
        category: 'Contrataciones',
        public_text: 'Texto público',
        published_at: '2026-06-10T12:00:00Z',
        evidence_count: -1,
      }),
    )
    await expect(
      fetchPublishedReport('rep-bad', 'trujillo', baseUrl),
    ).rejects.toThrow(ApiError)
  })

  test('citizen report lifecycle endpoints send expected JSON payloads', async () => {
    const requests = mockFetchOnce((req) => {
      if (req.url.endsWith('/reports')) {
        return Response.json(
          {
            id: 'rep-9',
            municipality_id: 'lima',
            status: 'DRAFT',
            category: 'Infraestructura',
            description: 'Bache en avenida',
            created_at: '2026-06-15T10:00:00Z',
          },
          { status: 201 },
        )
      }
      if (req.url.endsWith('/reports/rep-9/evidence')) {
        return Response.json({
          report_id: 'rep-9',
          evidence_id: 'ev-1',
          upload_url: 'https://minio.local/presigned',
          object_key: 'reports/rep-9/ev-1.pdf',
          expires_in_seconds: 900,
          upload_headers: {
            'Content-Type': 'application/pdf',
            'x-amz-server-side-encryption': 'AES256',
          },
        })
      }
      if (req.url === 'https://minio.local/presigned') {
        return new Response(null, { status: 200 })
      }
      return Response.json({
        id: 'rep-9',
        municipality_id: 'lima',
        status: 'SUBMITTED',
        category: 'Infraestructura',
        description: 'Bache en avenida',
        created_at: '2026-06-15T10:00:00Z',
      })
    })

    const draft = await createReport(
      {
        municipality_id: 'lima',
        category: 'Infraestructura',
        description: 'Bache en avenida',
      },
      baseUrl,
    )
    expect(draft.status).toBe('DRAFT')

    const presigned = await requestEvidenceUpload(
      draft.id,
      {
        municipality_id: 'lima',
        content_type: 'application/pdf',
        size_bytes: 1024,
        sha256: 'a'.repeat(64),
      },
      baseUrl,
    )
    expect(presigned.upload_url).toBe('https://minio.local/presigned')
    expect(presigned.upload_headers).toEqual({
      'Content-Type': 'application/pdf',
      'x-amz-server-side-encryption': 'AES256',
    })

    await uploadEvidenceToPresignedUrl(
      presigned.upload_url,
      new Blob(['pdf-bytes'], { type: 'application/pdf' }),
      'application/pdf',
      presigned.upload_headers,
    )

    const submitted = await submitReport(draft.id, 'lima', baseUrl)
    expect(submitted.status).toBe('SUBMITTED')
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST http://localhost:8080/reports',
      'POST http://localhost:8080/reports/rep-9/evidence',
      'PUT https://minio.local/presigned',
      'POST http://localhost:8080/reports/rep-9/submit',
    ])
    expect(requests[2]?.headers).toEqual({
      'Content-Type': 'application/pdf',
      'x-amz-server-side-encryption': 'AES256',
    })
  })

  test('requestEvidenceUpload rejects non-string upload_headers values', async () => {
    mockFetchOnce(() =>
      Response.json({
        report_id: 'rep-9',
        evidence_id: 'ev-1',
        upload_url: 'https://minio.local/presigned',
        object_key: 'reports/rep-9/ev-1.pdf',
        expires_in_seconds: 900,
        upload_headers: {
          'x-amz-server-side-encryption': 123,
        },
      }),
    )

    await expect(
      requestEvidenceUpload(
        'rep-9',
        {
          municipality_id: 'lima',
          content_type: 'application/pdf',
          size_bytes: 1024,
          sha256: 'a'.repeat(64),
        },
        baseUrl,
      ),
    ).rejects.toThrow(ApiError)
  })

  test('throws ApiError with sanitized status message without leaking raw backend text', async () => {
    mockFetchOnce(() =>
      Response.json(
        { error: 'internal sql error containing sensitive-pii-value' },
        { status: 400 },
      ),
    )

    try {
      await fetchExpenses({ municipality_id: 'lima', from: 'bad-date' }, baseUrl)
      expect.unreachable('should have thrown ApiError')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError)
      if (err instanceof ApiError) {
        expect(err.status).toBe(400)
        expect(err.message).toBe('Solicitud inválida. Verifica los datos ingresados.')
        expect(err.message).not.toContain('sensitive-pii-value')
      }
    }

    mockFetchOnce(() => new Response('raw secret stack trace', { status: 503 }))
    try {
      await fetchDatasets('lima', baseUrl)
      expect.unreachable('should have thrown ApiError')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError)
      if (err instanceof ApiError) {
        expect(err.status).toBe(503)
        expect(err.message).toBe('Error HTTP 503')
        expect(err.message).not.toContain('secret')
      }
    }

    mockFetchOnce(
      () => new Response('{malformed-json-with-citizen-dni-99999999', { status: 200 }),
    )
    try {
      await fetchDatasets('lima', baseUrl)
      expect.unreachable('should have thrown ApiError')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError)
      if (err instanceof ApiError) {
        expect(err.status).toBe(502)
        expect(err.message).toBe('Respuesta inválida del servidor.')
        expect(err.message).not.toContain('99999999')
      }
    }
  })
})
