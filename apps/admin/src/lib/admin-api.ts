import { normalizeMunicipalityId } from './municipalities'

export const DEFAULT_API_BASE_URL = 'http://localhost:8080'

export type ReportStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'TRIAGED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'PUBLISHED'

export type StatusFilter = 'ALL' | Exclude<ReportStatus, 'DRAFT'>

export type ModerationAction = 'TRIAGE' | 'VERIFY' | 'REJECT' | 'PUBLISH'

export const MODERATION_ACTION_LABELS: Record<ModerationAction, string> = {
  TRIAGE: 'Triaje',
  VERIFY: 'Verificar',
  REJECT: 'Rechazar',
  PUBLISH: 'Publicar',
}

export const MODERATION_ACTION_TEST_IDS: Record<ModerationAction, string> = {
  TRIAGE: 'case-action-triage',
  VERIFY: 'case-action-verify',
  REJECT: 'case-action-reject',
  PUBLISH: 'case-action-publish',
}

export function formatIngestDeduplicatedStatus(deduplicated: boolean): string {
  return deduplicated ? 'Deduplicado (idempotente)' : 'Ingesta nueva'
}

export const MODERATION_STATUS_FILTERS: readonly StatusFilter[] = [
  'ALL',
  'SUBMITTED',
  'TRIAGED',
  'VERIFIED',
  'REJECTED',
  'PUBLISHED',
] as const

export interface ModerationCase {
  id: string
  report_id: string
  municipality_id: string
  status: ReportStatus
  category: string
  description: string
  assigned_to: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Report {
  id: string
  municipality_id: string
  status: ReportStatus
  category: string
  description: string
  created_at: string
}

export interface Publication {
  id: string
  report_id: string
  municipality_id: string
  public_text: string
  published_at: string
}

export interface PublishReportResponse {
  report_id: string
  status: ReportStatus
  publication: Publication
}

export interface IngestResult {
  municipality_id: string
  dataset_version_id: string
  checksum_sha256: string
  rows_ingested: number
  deduplicated: boolean
}

export interface FetchModerationCasesParams {
  municipalityId: string
  status?: StatusFilter
}

export interface ModerationTransitionInput {
  municipalityId: string
  reason: string
}

export interface PublishReportInput {
  municipalityId: string
  reason: string
  publicText: string
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class ModerationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModerationValidationError'
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

export function validateModerationReason(reason: string): string {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    throw new ModerationValidationError(
      'Debes ingresar un motivo de auditoría (reason) no vacío.',
    )
  }
  return trimmed
}

export function validatePublicText(publicText: string): string {
  const trimmed = publicText.trim()
  if (trimmed.length === 0) {
    throw new ModerationValidationError(
      'Debes ingresar el texto público redactado (public_text) antes de publicar.',
    )
  }
  return trimmed
}

export function getAllowedActions(status: string): ModerationAction[] {
  switch (status.trim().toUpperCase()) {
    case 'SUBMITTED':
      return ['TRIAGE', 'REJECT']
    case 'TRIAGED':
      return ['VERIFY', 'REJECT']
    case 'VERIFIED':
      return ['PUBLISH']
    default:
      return []
  }
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

function readBoolean(obj: Record<string, unknown>, key: string): boolean {
  const value = obj[key]
  if (typeof value !== 'boolean') {
    throw new ApiError(502, `Invalid API response: expected boolean for ${key}`)
  }
  return value
}

function readReportStatus(obj: Record<string, unknown>, key: string): ReportStatus {
  const value = readString(obj, key).trim().toUpperCase()
  switch (value) {
    case 'DRAFT':
    case 'SUBMITTED':
    case 'TRIAGED':
    case 'VERIFIED':
    case 'REJECTED':
    case 'PUBLISHED':
      return value
    default:
      throw new ApiError(502, 'Respuesta inválida del servidor.')
  }
}

function decodeModerationCase(raw: unknown): ModerationCase {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected moderation case object')
  }
  return {
    id: readString(raw, 'id'),
    report_id: readString(raw, 'report_id'),
    municipality_id: readString(raw, 'municipality_id'),
    status: readReportStatus(raw, 'status'),
    category: readString(raw, 'category'),
    description: readString(raw, 'description'),
    assigned_to: readNullableString(raw, 'assigned_to'),
    notes: readNullableString(raw, 'notes'),
    created_at: readString(raw, 'created_at'),
    updated_at: readString(raw, 'updated_at'),
  }
}

function decodeModerationCaseArray(raw: unknown): ModerationCase[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(502, 'Invalid API response: expected moderation case array')
  }
  return raw.map(decodeModerationCase)
}

function decodeReport(raw: unknown): Report {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected report object')
  }
  return {
    id: readString(raw, 'id'),
    municipality_id: readString(raw, 'municipality_id'),
    status: readReportStatus(raw, 'status'),
    category: readString(raw, 'category'),
    description: readString(raw, 'description'),
    created_at: readString(raw, 'created_at'),
  }
}

function decodePublication(raw: unknown): Publication {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected publication object')
  }
  return {
    id: readString(raw, 'id'),
    report_id: readString(raw, 'report_id'),
    municipality_id: readString(raw, 'municipality_id'),
    public_text: readString(raw, 'public_text'),
    published_at: readString(raw, 'published_at'),
  }
}

function decodePublishReportResponse(raw: unknown): PublishReportResponse {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected publish report response')
  }
  return {
    report_id: readString(raw, 'report_id'),
    status: readReportStatus(raw, 'status'),
    publication: decodePublication(raw.publication),
  }
}

function decodeIngestResult(raw: unknown): IngestResult {
  if (!isRecord(raw)) {
    throw new ApiError(502, 'Invalid API response: expected ingest result')
  }
  return {
    municipality_id: readString(raw, 'municipality_id'),
    dataset_version_id: readString(raw, 'dataset_version_id'),
    checksum_sha256: readString(raw, 'checksum_sha256'),
    rows_ingested: readSafeInteger(raw, 'rows_ingested'),
    deduplicated: readBoolean(raw, 'deduplicated'),
  }
}

function mapSafeHttpErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Solicitud inválida. Verifica los datos ingresados.'
    case 401:
      return 'No autenticado. Verifica tu token Bearer.'
    case 403:
      return 'No tienes permisos para realizar esta acción.'
    case 404:
      return 'Recurso no encontrado.'
    case 409:
      return 'Conflicto con el estado actual del recurso.'
    case 422:
      return 'Transición de estado no permitida.'
    default:
      return `Error HTTP ${status}`
  }
}

function buildAuthHeaders(
  token: string,
  includeJsonContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const trimmedToken = token.trim()
  if (trimmedToken.length > 0) {
    headers.Authorization = `Bearer ${trimmedToken}`
  }
  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json'
  }
  return headers
}

async function requestJson<T>(
  pathWithQuery: string,
  decode: (raw: unknown) => T,
  init: RequestInit,
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

export async function fetchModerationCases(
  token: string,
  params: FetchModerationCasesParams,
  baseUrl?: string,
): Promise<ModerationCase[]> {
  const query = new URLSearchParams()
  query.set('municipality_id', normalizeMunicipalityId(params.municipalityId))
  const normalizedStatus = params.status?.trim().toUpperCase() ?? ''
  if (normalizedStatus.length > 0 && normalizedStatus !== 'ALL') {
    query.set('status', normalizedStatus)
  }

  return requestJson(
    `/moderation/cases?${query.toString()}`,
    decodeModerationCaseArray,
    {
      method: 'GET',
      headers: buildAuthHeaders(token, false),
    },
    baseUrl,
  )
}

function requireEntityId(id: string): string {
  const trimmed = id.trim()
  if (trimmed.length === 0) {
    throw new ModerationValidationError('El identificador del caso/reporte es obligatorio.')
  }
  return encodeURIComponent(trimmed)
}

export async function triageCase(
  token: string,
  id: string,
  input: ModerationTransitionInput,
  baseUrl?: string,
): Promise<Report> {
  const safeId = requireEntityId(id)
  const reason = validateModerationReason(input.reason)
  return requestJson(
    `/moderation/cases/${safeId}/triage`,
    decodeReport,
    {
      method: 'POST',
      headers: buildAuthHeaders(token, true),
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipalityId),
        reason,
      }),
    },
    baseUrl,
  )
}

export async function verifyCase(
  token: string,
  id: string,
  input: ModerationTransitionInput,
  baseUrl?: string,
): Promise<Report> {
  const safeId = requireEntityId(id)
  const reason = validateModerationReason(input.reason)
  return requestJson(
    `/moderation/cases/${safeId}/verify`,
    decodeReport,
    {
      method: 'POST',
      headers: buildAuthHeaders(token, true),
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipalityId),
        reason,
      }),
    },
    baseUrl,
  )
}

export async function rejectCase(
  token: string,
  id: string,
  input: ModerationTransitionInput,
  baseUrl?: string,
): Promise<Report> {
  const safeId = requireEntityId(id)
  const reason = validateModerationReason(input.reason)
  return requestJson(
    `/moderation/cases/${safeId}/reject`,
    decodeReport,
    {
      method: 'POST',
      headers: buildAuthHeaders(token, true),
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipalityId),
        reason,
      }),
    },
    baseUrl,
  )
}

export async function publishReport(
  token: string,
  id: string,
  input: PublishReportInput,
  baseUrl?: string,
): Promise<PublishReportResponse> {
  const safeId = requireEntityId(id)
  const reason = validateModerationReason(input.reason)
  const publicText = validatePublicText(input.publicText)
  return requestJson(
    `/moderation/reports/${safeId}/publish`,
    decodePublishReportResponse,
    {
      method: 'POST',
      headers: buildAuthHeaders(token, true),
      body: JSON.stringify({
        municipality_id: normalizeMunicipalityId(input.municipalityId),
        reason,
        public_text: publicText,
      }),
    },
    baseUrl,
  )
}

export async function runDemoIngest(
  token: string,
  municipalityId: string,
  baseUrl?: string,
): Promise<IngestResult> {
  const query = new URLSearchParams({
    municipality_id: normalizeMunicipalityId(municipalityId),
  })
  return requestJson(
    `/admin/ingest/demo?${query.toString()}`,
    decodeIngestResult,
    {
      method: 'POST',
      headers: buildAuthHeaders(token, false),
    },
    baseUrl,
  )
}
