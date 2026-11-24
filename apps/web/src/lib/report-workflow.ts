import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_SIZE_BYTES,
  computeSha256Hex,
  requestEvidenceUpload,
  submitReport,
  uploadEvidenceToPresignedUrl,
  type Report,
} from './api'

export interface ReadyEvidence {
  file: File
  sha256: string
}

export interface UploadedEvidenceItem {
  evidenceId: string
  fileName: string
  contentType: string
  sizeBytes: number
  sha256: string
  objectKey: string
}

export type EvidenceValidationResult =
  | { ok: true; contentType: string }
  | { ok: false; error: string }

export function validateEvidenceFile(file: Pick<File, 'type' | 'size'>): EvidenceValidationResult {
  const mimeType = file.type || 'application/octet-stream'
  if (
    !ALLOWED_EVIDENCE_MIME_TYPES.includes(
      mimeType as (typeof ALLOWED_EVIDENCE_MIME_TYPES)[number],
    )
  ) {
    return {
      ok: false,
      error: `Tipo de archivo no permitido (${mimeType}). Permitidos: PDF, JPEG, PNG, WEBP o TXT.`,
    }
  }

  if (file.size <= 0 || file.size > MAX_EVIDENCE_SIZE_BYTES) {
    return {
      ok: false,
      error: 'El archivo debe pesar entre 1 byte y 10 MB.',
    }
  }

  return { ok: true, contentType: mimeType }
}

export interface HashSequenceGuard {
  next(): number
  isCurrent(seq: number): boolean
  invalidate(): void
}

export function createHashSequenceGuard(): HashSequenceGuard {
  let current = 0
  return {
    next() {
      current += 1
      return current
    },
    isCurrent(seq: number) {
      return seq === current
    },
    invalidate() {
      current += 1
    },
  }
}

export async function prepareEvidenceWithGuard(
  file: File,
  guard: HashSequenceGuard,
  hashFn: (blob: Blob) => Promise<string> = computeSha256Hex,
): Promise<
  | { status: 'ready'; evidence: ReadyEvidence }
  | { status: 'invalid'; error: string }
  | { status: 'stale' }
> {
  const seq = guard.next()
  const validation = validateEvidenceFile(file)
  if (!validation.ok) {
    return { status: 'invalid', error: validation.error }
  }

  const sha256 = await hashFn(file)
  if (!guard.isCurrent(seq)) {
    return { status: 'stale' }
  }
  return { status: 'ready', evidence: { file, sha256 } }
}

export async function executeEvidenceUpload(
  draftReport: Pick<Report, 'id' | 'municipality_id'>,
  ready: ReadyEvidence,
  deps: {
    requestUpload?: typeof requestEvidenceUpload
    uploadToPresigned?: typeof uploadEvidenceToPresignedUrl
  } = {},
): Promise<UploadedEvidenceItem> {
  const requestUpload = deps.requestUpload ?? requestEvidenceUpload
  const uploadToPresigned = deps.uploadToPresigned ?? uploadEvidenceToPresignedUrl
  const contentType = ready.file.type || 'application/octet-stream'

  const presigned = await requestUpload(draftReport.id, {
    municipality_id: draftReport.municipality_id,
    content_type: contentType,
    size_bytes: ready.file.size,
    sha256: ready.sha256,
  })

  await uploadToPresigned(
    presigned.upload_url,
    ready.file,
    contentType,
    presigned.upload_headers,
  )

  return {
    evidenceId: presigned.evidence_id,
    fileName: ready.file.name,
    contentType,
    sizeBytes: ready.file.size,
    sha256: ready.sha256,
    objectKey: presigned.object_key,
  }
}

export async function executeReportSubmission(
  draftReport: Pick<Report, 'id' | 'municipality_id'>,
  submitFn: typeof submitReport = submitReport,
): Promise<Report> {
  return submitFn(draftReport.id, draftReport.municipality_id)
}
