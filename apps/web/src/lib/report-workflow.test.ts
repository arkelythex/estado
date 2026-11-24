import { describe, expect, test } from 'bun:test'
import { ApiError, MAX_EVIDENCE_SIZE_BYTES } from './api'
import {
  createHashSequenceGuard,
  executeEvidenceUpload,
  executeReportSubmission,
  prepareEvidenceWithGuard,
  validateEvidenceFile,
} from './report-workflow'

describe('report-workflow validation & async safety', () => {
  test('validateEvidenceFile rejects disallowed MIME types and out-of-range sizes', () => {
    const badMime = validateEvidenceFile({ type: 'application/x-msdownload', size: 100 })
    expect(badMime.ok).toBe(false)

    const empty = validateEvidenceFile({ type: 'application/pdf', size: 0 })
    expect(empty.ok).toBe(false)

    const tooLarge = validateEvidenceFile({
      type: 'image/png',
      size: MAX_EVIDENCE_SIZE_BYTES + 1,
    })
    expect(tooLarge.ok).toBe(false)

    const valid = validateEvidenceFile({ type: 'application/pdf', size: 2048 })
    expect(valid).toEqual({ ok: true, contentType: 'application/pdf' })
  })

  test('prepareEvidenceWithGuard drops stale out-of-order hash completions', async () => {
    const guard = createHashSequenceGuard()
    const fileA = new File(['file-a'], 'a.pdf', { type: 'application/pdf' })
    const fileB = new File(['file-b'], 'b.pdf', { type: 'application/pdf' })

    let resolveA: ((hash: string) => void) | undefined
    const pendingA = prepareEvidenceWithGuard(
      fileA,
      guard,
      () =>
        new Promise<string>((resolve) => {
          resolveA = resolve
        }),
    )

    const resultB = await prepareEvidenceWithGuard(fileB, guard, async () => 'b'.repeat(64))
    expect(resultB.status).toBe('ready')
    if (resultB.status === 'ready') {
      expect(resultB.evidence.file).toBe(fileB)
      expect(resultB.evidence.sha256).toBe('b'.repeat(64))
    }

    resolveA?.('a'.repeat(64))
    const resultA = await pendingA
    expect(resultA).toEqual({ status: 'stale' })
  })

  test('executeEvidenceUpload propagates presigned request and PUT upload failures', async () => {
    const draft = { id: 'rep-1', municipality_id: 'lima' }
    const ready = {
      file: new File(['doc'], 'doc.pdf', { type: 'application/pdf' }),
      sha256: 'c'.repeat(64),
    }

    await expect(
      executeEvidenceUpload(draft, ready, {
        requestUpload: async () => {
          throw new ApiError(400, 'Solicitud inválida. Verifica los datos ingresados.')
        },
      }),
    ).rejects.toThrow(ApiError)

    await expect(
      executeEvidenceUpload(draft, ready, {
        requestUpload: async () => ({
          report_id: 'rep-1',
          evidence_id: 'ev-1',
          upload_url: 'https://minio.local/put',
          object_key: 'reports/rep-1/ev-1.pdf',
          expires_in_seconds: 900,
        }),
        uploadToPresigned: async () => {
          throw new ApiError(500, 'Error al subir archivo de evidencia al almacenamiento (HTTP 500)')
        },
      }),
    ).rejects.toThrow(ApiError)
  })

  test('executeReportSubmission uses draft municipality_id and propagates failures', async () => {
    const calls: Array<{ id: string; municipalityId: string }> = []
    const submitted = await executeReportSubmission(
      { id: 'rep-7', municipality_id: 'cusco' },
      async (id, municipalityId) => {
        calls.push({ id, municipalityId })
        return {
          id,
          municipality_id: municipalityId,
          status: 'SUBMITTED',
          category: 'Obras',
          description: 'Detalle',
          created_at: '2026-06-15T10:00:00Z',
        }
      },
    )

    expect(calls).toEqual([{ id: 'rep-7', municipalityId: 'cusco' }])
    expect(submitted.status).toBe('SUBMITTED')

    await expect(
      executeReportSubmission({ id: 'rep-7', municipality_id: 'cusco' }, async () => {
        throw new ApiError(422, 'La operación no es válida para el estado actual.')
      }),
    ).rejects.toThrow(ApiError)
  })
})
