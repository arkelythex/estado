import { afterEach, describe, expect, test } from 'bun:test'
import {
  ApiError,
  buildExpensesQuery,
  computeSha256Hex,
  createReport,
  fetchAuditVerify,
  fetchDatasets,
  fetchExpenses,
  fetchPublishedReport,
  fetchPublishedReports,
  fetchSpendingAnomalies,
  formatBigIntCentsPEN,
  formatBpsPercent,
  formatCentsPEN,
  getOcdsReleasesUrl,
  requestEvidenceUpload,
  submitReport,
  sumExpenseCents,
  trackReportByReceipt,
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
    expect(() => formatBpsPercent(75.5)).toThrow(RangeError)
  })

  test('formats basis points with BigInt integer math', () => {
    expect(formatBpsPercent(0)).toBe('0.00%')
    expect(formatBpsPercent(7000)).toBe('70.00%')
    expect(formatBpsPercent(8425)).toBe('84.25%')
    expect(formatBpsPercent(10000)).toBe('100.00%')
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

  test('requestEvidenceUpload treats null upload_headers identically to undefined', async () => {
    mockFetchOnce(() =>
      Response.json({
        report_id: 'rep-9',
        evidence_id: 'ev-1',
        upload_url: 'https://minio.local/presigned',
        object_key: 'reports/rep-9/ev-1.pdf',
        expires_in_seconds: 900,
        upload_headers: null,
      }),
    )

    const res = await requestEvidenceUpload(
      'rep-9',
      {
        municipality_id: 'lima',
        content_type: 'application/pdf',
        size_bytes: 1024,
        sha256: 'a'.repeat(64),
      },
      baseUrl,
    )
    expect(res.upload_headers).toBeUndefined()
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

  test('createReport decodes optional one-time receipt_code when present and rejects non-string', async () => {
    mockFetchOnce(() =>
      Response.json(
        {
          id: 'rep-10',
          municipality_id: 'lima',
          status: 'DRAFT',
          category: 'Transparencia',
          description: 'Reporte con recibo',
          created_at: '2026-06-20T10:00:00Z',
          receipt_code: 'ABCD-EFGH-IJKL-MNOP',
        },
        { status: 201 },
      ),
    )

    const created = await createReport(
      {
        municipality_id: 'lima',
        category: 'Transparencia',
        description: 'Reporte con recibo',
      },
      baseUrl,
    )
    expect(created.receipt_code).toBe('ABCD-EFGH-IJKL-MNOP')

    mockFetchOnce(() =>
      Response.json(
        {
          id: 'rep-11',
          municipality_id: 'lima',
          status: 'DRAFT',
          category: 'Transparencia',
          description: 'Sin recibo',
          created_at: '2026-06-20T10:00:00Z',
          receipt_code: 12345,
        },
        { status: 201 },
      ),
    )

    await expect(
      createReport(
        {
          municipality_id: 'lima',
          category: 'Transparencia',
          description: 'Sin recibo',
        },
        baseUrl,
      ),
    ).rejects.toThrow(ApiError)
  })

  test('fetchAuditVerify calls /public/audit/verify and validates ChainVerification fields', async () => {
    const requests = mockFetchOnce(() =>
      Response.json({
        valid: true,
        checked_events: 14,
        head_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        broken_at_seq: null,
        reason: null,
      }),
    )

    const result = await fetchAuditVerify(baseUrl)
    expect(requests[0]?.url).toBe('http://localhost:8080/public/audit/verify')
    expect(result.valid).toBe(true)
    expect(result.checked_events).toBe(14)
    expect(result.head_hash.startsWith('abcdef123456')).toBe(true)
    expect(result.broken_at_seq).toBeNull()

    mockFetchOnce(() =>
      Response.json({
        valid: true,
        checked_events: -2,
        head_hash: 'abc',
        broken_at_seq: null,
        reason: null,
      }),
    )
    await expect(fetchAuditVerify(baseUrl)).rejects.toThrow(ApiError)
  })

  test('fetchSpendingAnomalies validates safe integers and optional threshold_cents', async () => {
    const requests = mockFetchOnce(() =>
      Response.json({
        total_expenses: 5,
        total_amount_cents: 500000,
        threshold_cents: 200000,
        flag_count: 1,
        flags: [
          {
            rule_code: 'CONTRACT_SPLITTING',
            severity: 'HIGH',
            entity: 'Proveedora Sur SAC',
            category: 'Obras',
            total_cents: 240000,
            expense_count: 3,
            affected_ids: ['e1', 'e2', 'e3'],
            share_bps: 4800,
            summary: 'Posible fraccionamiento debajo del umbral.',
          },
        ],
      }),
    )

    const res = await fetchSpendingAnomalies(' arequipa ', 200000, baseUrl)
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/public/anomalies?municipality_id=arequipa&threshold_cents=200000',
    )
    expect(res.flag_count).toBe(1)
    expect(res.flags[0]?.rule_code).toBe('CONTRACT_SPLITTING')
    expect(res.flags[0]?.total_cents).toBe(240000)
    expect(res.flags[0]?.share_bps).toBe(4800)

    await expect(
      fetchSpendingAnomalies('lima', 12.5, baseUrl),
    ).rejects.toThrow(ApiError)

    mockFetchOnce(() =>
      Response.json({
        total_expenses: 1,
        total_amount_cents: 100.5,
        threshold_cents: 200000,
        flag_count: 0,
        flags: [],
      }),
    )
    await expect(fetchSpendingAnomalies('lima', undefined, baseUrl)).rejects.toThrow(
      ApiError,
    )
  })

  test('trackReportByReceipt sends X-Receipt-Code header and never puts code in URL query', async () => {
    const requests = mockFetchOnce(() =>
      Response.json({
        municipality_id: 'cusco',
        status: 'TRIAGED',
        category: 'Contrataciones',
        created_at: '2026-06-18T08:30:00Z',
        timeline: [
          {
            from_status: 'DRAFT',
            to_status: 'SUBMITTED',
            action: 'SUBMIT',
            occurred_at: '2026-06-18T08:35:00Z',
          },
          {
            from_status: 'SUBMITTED',
            to_status: 'TRIAGED',
            action: 'TRIAGE',
            occurred_at: '2026-06-19T11:00:00Z',
          },
        ],
      }),
    )

    const receipt = 'WXYZ-1234-ABCD-5678'
    const tracking = await trackReportByReceipt('cusco', ` ${receipt} `, baseUrl)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      'http://localhost:8080/public/reports/track?municipality_id=cusco',
    )
    expect(requests[0]?.url).not.toContain(receipt)
    expect(requests[0]?.headers).toEqual({
      'X-Receipt-Code': receipt,
    })
    expect(tracking.status).toBe('TRIAGED')
    expect(tracking.timeline).toHaveLength(2)

    await expect(trackReportByReceipt('cusco', '   ', baseUrl)).rejects.toThrow(ApiError)
  })

  test('getOcdsReleasesUrl builds normalized OCDS 1.1 release package URL', () => {
    expect(getOcdsReleasesUrl(' Trujillo ', baseUrl)).toBe(
      'http://localhost:8080/public/ocds/releases.json?municipality_id=trujillo',
    )
  })
})
