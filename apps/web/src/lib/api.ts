import { normalizeMunicipalityId } from './municipalities'

export const DEFAULT_API_BASE_URL = 'http://localhost:8080'

export const ALLOWED_EVIDENCE_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
] as const

export const MAX_EVIDENCE_SIZE_BYTES = 10 * 1024 * 1024

export interface Dataset {
  id: string
  municipality_id: string
  name: string
  kind: string
  versions: number
  created_at: string
}

export interface Expense {
  id: string
  municipality_id: string
  version_id: string
  entity: string
  category: string
  amount_cents: number
  amount: string
  occurred_on: string | null
  doc_ref: string | null
}

export interface ExpenseFilters {
  municipality_id: string
  entity?: string
  category?: string
  from?: string
  to?: string
}

export interface Report {
  id: string
  municipality_id: string
  status: string
  category: string
  description: string
  created_at: string
}

export interface PublicReportSummary {
  id: string
  municipality_id: string
  status: string
  category: string
  public_text: string
  published_at: string
}

export interface PublicReportDetail {
  id: string
  municipality_id: string
  status: string
  category: string
  public_text: string
  published_at: string
  evidence_count: number
}

export interface CreateReportInput {
  municipality_id: string
  category: string
  description: string
}

export interface RequestEvidenceUploadInput {
  municipality_id: string
  content_type: string
  size_bytes: number
  sha256: string
}

export interface AddEvidenceResponse {
  report_id: string
  evidence_id: string
  upload_url: string
  object_key: string
  expires_in_seconds: number
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function getApiBaseUrl(): string {
  const envUrl =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    typeof import.meta.env.VITE_API_URL === 'string'
      ? import.meta.env.VITE_API_URL.trim()
      : ''
  const raw = envUrl.length > 0 ? envUrl : DEFAULT_API_BASE_URL
  return raw.replace(/\/+$/, '')
}

function formatThousands(digits: string): string {
  const parts: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3)
    parts.push(digits.slice(start, end))
  }
  return parts.reverse().join(',')
}

/**
 * Formats integer cents (PEN) into `S/ 1,250.75` without any floating-point arithmetic.
 */
export function formatCentsPEN(amountCents: number): string {
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError('amountCents must be a safe integer')
  }
  return formatBigIntCentsPEN(BigInt(amountCents))
}

export function formatBigIntCentsPEN(amountCents: bigint): string {
  const isNegative = amountCents < 0n
  const abs = isNegative ? -amountCents : amountCents
  const whole = abs / 100n
  const frac = abs % 100n
  const wholeFormatted = formatThousands(whole.toString())
  const fracFormatted = frac.toString().padStart(2, '0')
  return `${isNegative ? '-' : ''}S/ ${wholeFormatted}.${fracFormatted}`
}

export function sumExpenseCents(expenses: readonly Pick<Expense, 'amount_cents'>[]): bigint {
  let total = 0n
  for (const item of expenses) {
    if (!Number.isSafeInteger(item.amount_cents)) {
      throw new RangeError('expense amount_cents must be a safe integer')
    }
    total += BigInt(item.amount_cents)
  }
  return total
}

export async function computeSha256Hex(file: Blob): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) no disponible en este entorno')
  }
  const buffer = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]
    if (byte !== undefined) {
      hex += byte.toString(16).padStart(2, '0')
    }
  }
  return hex
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string') {
    throw new ApiError(502, `Invalid API response: expected string for ${key}`)
  }
  return value
}

function readNullableString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new ApiError(502, `Invalid API response: expected nullable string for ${key}`)
  }
  return value
}

function readSafeInteger(obj: Record<string, unknown>, key: string): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ApiError(502, `Invalid API response: expected integer for ${key}`)
  }
  return value
}

function decodeArray<T>(raw: unknown, decodeItem: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(502, 'Invalid API response: expected JSON array')
  }
  return raw.map(decodeItem)
}

function decodeDataset(raw: unknown): Dataset {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected dataset object')
  }
  return {
    id: readString(raw, 'id'),
    municipality_id: readString(raw, 'municipality_id'),
    name: readString(raw, 'name'),
    kind: readString(raw, 'kind'),
    versions: readSafeInteger(raw, 'versions'),
    created_at: readString(raw, 'created_at'),
  }
}

function decodeExpense(raw: unknown): Expense {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected expense object')
  }
  return {
    id: readString(raw, 'id'),
    municipality_id: readString(raw, 'municipality_id'),
    version_id: readString(raw, 'version_id'),
    entity: readString(raw, 'entity'),
    category: readString(raw, 'category'),
    amount_cents: readSafeInteger(raw, 'amount_cents'),
    amount: readString(raw, 'amount'),
    occurred_on: readNullableString(raw, 'occurred_on'),
    doc_ref: readNullableString(raw, 'doc_ref'),
  }
}

function decodeReport(raw: unknown): Report {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected report object')
  }
  return {
    id: readString(raw, 'id'),
    municipality_id: readString(raw, 'municipality_id'),
    status: readString(raw, 'status'),
    category: readString(raw, 'category'),
    description: readString(raw, 'description'),
    created_at: readString(raw, 'created_at'),
  }
}

function decodePublicReportSummary(raw: unknown): PublicReportSummary {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected public report summary')
  }
  const publicId =
    typeof raw.report_id === 'string' && raw.report_id.trim().length > 0
      ? raw.report_id
      : readString(raw, 'id')
  return {
    id: publicId,
    municipality_id: readString(raw, 'municipality_id'),
    status: readString(raw, 'status'),
    category: readString(raw, 'category'),
    public_text: readString(raw, 'public_text'),
    published_at: readString(raw, 'published_at'),
  }
}

function decodePublicReportDetail(raw: unknown): PublicReportDetail {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected public report detail')
  }
  const summary = decodePublicReportSummary(raw)
  let evidenceCount: number
  if ('evidence_count' in raw && raw.evidence_count !== undefined) {
    if (
      typeof raw.evidence_count !== 'number' ||
      !Number.isSafeInteger(raw.evidence_count) ||
      raw.evidence_count < 0
    ) {
      throw new ApiError(502, 'Respuesta inválida del servidor.')
    }
    evidenceCount = raw.evidence_count
  } else if (Array.isArray(raw.evidence)) {
    evidenceCount = raw.evidence.length
  } else {
    throw new ApiError(502, 'Respuesta inválida del servidor.')
  }
  return { ...summary, evidence_count: evidenceCount }
}

function decodeAddEvidenceResponse(raw: unknown): AddEvidenceResponse {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected add evidence response')
  }
  return {
    report_id: readString(raw, 'report_id'),
    evidence_id: readString(raw, 'evidence_id'),
    upload_url: readString(raw, 'upload_url'),
    object_key: readString(raw, 'object_key'),
    expires_in_seconds: readSafeInteger(raw, 'expires_in_seconds'),
  }
}

function mapSafeHttpErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Solicitud inválida. Verifica los datos ingresados.'
    case 401:
      return 'No autenticado. Verifica tus credenciales.'
    case 403:
      return 'No tienes permisos para realizar esta acción.'
    case 404:
      return 'Recurso no encontrado.'
    case 409:
      return 'Conflicto con el estado actual del recurso.'
    case 422:
      return 'La operación no es válida para el estado actual.'
    case 429:
      return 'Demasiadas solicitudes. Intenta nuevamente en unos momentos.'
    default:
      return `Error HTTP ${status}`
  }
}

async function requestJson<T>(
  pathWithQuery: string,
  decode: (raw: unknown) => T,
  init?: RequestInit,
  baseUrl = getApiBaseUrl(),
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathWithQuery}`
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new ApiError(response.status, mapSafeHttpErrorMessage(response.status))
  }
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ApiError(502, 'Respuesta inválida del servidor.')
  }
  return decode(raw)
}

export function buildExpensesQuery(filters: ExpenseFilters): string {
  const params = new URLSearchParams()
  params.set('municipality_id', normalizeMunicipalityId(filters.municipality_id))

  const entity = filters.entity?.trim()
  if (entity) {
    params.set('entity', entity)
  }
  const category = filters.category?.trim()
  if (category) {
    params.set('category', category)
  }
  const from = filters.from?.trim()
  if (from) {
    params.set('from', from)
  }
  const to = filters.to?.trim()
  if (to) {
    params.set('to', to)
  }
  return params.toString()
}

export async function fetchDatasets(
  municipalityId: string,
  baseUrl?: string,
): Promise<Dataset[]> {
  const params = new URLSearchParams({
    municipality_id: normalizeMunicipalityId(municipalityId),
  })
  return requestJson(
    `/public/datasets?${params.toString()}`,
    (raw) => decodeArray(raw, decodeDataset),
    undefined,
    baseUrl,
  )
}

export async function fetchExpenses(
  filters: ExpenseFilters,
  baseUrl?: string,
): Promise<Expense[]> {
  const query = buildExpensesQuery(filters)
  return requestJson(
    `/public/expenses?${query}`,
    (raw) => decodeArray(raw, decodeExpense),
    undefined,
    baseUrl,
  )
}

export async function fetchPublishedReports(
  municipalityId: string,
  baseUrl?: string,
): Promise<PublicReportSummary[]> {
  const params = new URLSearchParams({
    municipality_id: normalizeMunicipalityId(municipalityId),
  })
  return requestJson(
    `/public/reports?${params.toString()}`,
    (raw) => decodeArray(raw, decodePublicReportSummary),
    undefined,
    baseUrl,
  )
}

export async function fetchPublishedReport(
  id: string,
  municipalityId: string,
  baseUrl?: string,
): Promise<PublicReportDetail> {
  const trimmedId = id.trim()
  if (!trimmedId) {
    throw new ApiError(400, 'report id is required')
  }
  const params = new URLSearchParams({
    municipality_id: normalizeMunicipalityId(municipalityId),
  })
  return requestJson(
    `/public/reports/${encodeURIComponent(trimmedId)}?${params.toString()}`,
    decodePublicReportDetail,
    undefined,
    baseUrl,
  )
}

export async function createReport(
  input: CreateReportInput,
  baseUrl?: string,
): Promise<Report> {
  return requestJson(
    '/reports',
    decodeReport,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipality_id),
        category: input.category,
        description: input.description,
      }),
    },
    baseUrl,
  )
}

export async function requestEvidenceUpload(
  reportId: string,
  input: RequestEvidenceUploadInput,
  baseUrl?: string,
): Promise<AddEvidenceResponse> {
  const trimmedId = reportId.trim()
  if (!trimmedId) {
    throw new ApiError(400, 'report id is required')
  }
  return requestJson(
    `/reports/${encodeURIComponent(trimmedId)}/evidence`,
    decodeAddEvidenceResponse,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipality_id),
        content_type: input.content_type,
        size_bytes: input.size_bytes,
        sha256: input.sha256,
      }),
    },
    baseUrl,
  )
}

export async function uploadEvidenceToPresignedUrl(
  uploadUrl: string,
  file: Blob,
  contentType: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body: file,
  })
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `Error al subir archivo de evidencia al almacenamiento (HTTP ${response.status})`,
    )
  }
}

export async function submitReport(
  reportId: string,
  municipalityId: string,
  baseUrl?: string,
): Promise<Report> {
  const trimmedId = reportId.trim()
  if (!trimmedId) {
    throw new ApiError(400, 'report id is required')
  }
  return requestJson(
    `/reports/${encodeURIComponent(trimmedId)}/submit`,
    decodeReport,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(municipalityId),
      }),
    },
    baseUrl,
  )
}
