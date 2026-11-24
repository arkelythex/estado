import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  ApiError,
  MODERATION_ACTION_LABELS,
  MODERATION_ACTION_TEST_IDS,
  MODERATION_STATUS_FILTERS,
  ModerationValidationError,
  getAllowedActions,
  type ModerationAction,
  type ModerationCase,
  type StatusFilter,
} from '../lib/admin-api'
import { useAdminAuth } from '../lib/admin-auth'
import {
  createScopeGuard,
  executeScopedModerationAction,
  loadScopedModerationQueue,
} from '../lib/admin-workflow'
import { getMunicipalityLabel } from '../lib/municipalities'

export const Route = createFileRoute('/')({
  component: ModerationQueuePage,
})

const FILTER_LABELS: Record<StatusFilter, string> = {
  ALL: 'Todos',
  SUBMITTED: 'Submitted',
  TRIAGED: 'Triaged',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  PUBLISHED: 'Published',
}

function getStatusBadgeClass(status: string): string {
  switch (status.trim().toUpperCase()) {
    case 'SUBMITTED':
      return 'badge badge-submitted'
    case 'TRIAGED':
      return 'badge badge-triaged'
    case 'VERIFIED':
      return 'badge badge-verified'
    case 'PUBLISHED':
      return 'badge badge-published'
    case 'REJECTED':
      return 'badge badge-rejected'
    default:
      return 'badge badge-neutral'
  }
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    return `Error ${err.status}: ${err.message}`
  }
  if (err instanceof ModerationValidationError) {
    return err.message
  }
  return 'Ocurrió un error inesperado al comunicarse con la API.'
}

function RefreshIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  )
}

function TotalCasesIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function PendingIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  )
}

function ReviewIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  )
}

function PublishedIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function ModerationQueuePage() {
  const { municipality_id } = Route.useSearch()
  const { token, hasToken } = useAdminAuth()
  const muniLabel = getMunicipalityLabel(municipality_id)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [cases, setCases] = useState<ModerationCase[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const scopeGuardRef = useRef(createScopeGuard())

  const [selectedCase, setSelectedCase] = useState<ModerationCase | null>(null)
  const [selectedAction, setSelectedAction] = useState<ModerationAction | null>(
    null,
  )
  const [reason, setReason] = useState('')
  const [publicText, setPublicText] = useState('')
  const [isSubmittingAction, setIsSubmittingAction] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  const resetSensitiveState = useCallback(() => {
    setSelectedCase(null)
    setSelectedAction(null)
    setReason('')
    setPublicText('')
    setActionError(null)
    setActionSuccess(null)
  }, [])

  const loadQueue = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    const outcome = await loadScopedModerationQueue(
      scopeGuardRef.current,
      token,
      municipality_id,
      statusFilter,
    )
    if (outcome.status === 'stale') {
      return
    }
    if (outcome.status === 'error') {
      setCases([])
      setLoadError(formatError(outcome.error))
      setIsLoading(false)
      return
    }
    setCases(outcome.cases)
    setIsLoading(false)
  }, [token, municipality_id, statusFilter])

  useEffect(() => {
    const guard = scopeGuardRef.current
    guard.invalidateScope()
    setCases([])
    setLoadError(null)
    setIsSubmittingAction(false)
    resetSensitiveState()
    if (hasToken) {
      void loadQueue()
    } else {
      setIsLoading(false)
    }
    return () => {
      guard.invalidateScope()
    }
  }, [hasToken, token, municipality_id, statusFilter, loadQueue, resetSensitiveState])

  const openActionPanel = (
    moderationCase: ModerationCase,
    action: ModerationAction,
  ) => {
    setSelectedCase(moderationCase)
    setSelectedAction(action)
    setReason('')
    setPublicText('')
    setActionError(null)
    setActionSuccess(null)
  }

  const closeActionPanel = () => {
    setSelectedCase(null)
    setSelectedAction(null)
    setReason('')
    setPublicText('')
    setActionError(null)
  }

  const handleSubmitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedCase || !selectedAction) {
      return
    }

    const startScopeGen = scopeGuardRef.current.currentScope()
    setIsSubmittingAction(true)
    setActionError(null)
    setActionSuccess(null)

    try {
      const reportId = selectedCase.report_id
      const outcome = await executeScopedModerationAction(
        scopeGuardRef.current,
        {
          token,
          municipalityId: municipality_id,
          reportId,
          action: selectedAction,
          reason,
          publicText,
        },
      )

      if (outcome.status === 'stale') {
        return
      }

      setActionSuccess(
        `Acción ${selectedAction} aplicada al reporte ${reportId}.`,
      )
      setSelectedCase(null)
      setSelectedAction(null)
      setReason('')
      setPublicText('')
      await loadQueue()
    } catch (err: unknown) {
      if (!scopeGuardRef.current.isScopeCurrent(startScopeGen)) {
        return
      }
      setActionError(formatError(err))
    } finally {
      if (scopeGuardRef.current.isScopeCurrent(startScopeGen)) {
        setIsSubmittingAction(false)
      }
    }
  }

  const totalCount = cases.length
  const pendingCount = cases.filter((item) => item.status === 'SUBMITTED').length
  const inReviewCount = cases.filter(
    (item) => item.status === 'TRIAGED' || item.status === 'VERIFIED',
  ).length
  const publishedCount = cases.filter(
    (item) => item.status === 'PUBLISHED',
  ).length

  const pct = (value: number): string => {
    if (totalCount <= 0 || value <= 0) {
      return '0%'
    }
    const numerator = BigInt(value) * 100n + BigInt(totalCount) / 2n
    return `${(numerator / BigInt(totalCount)).toString()}%`
  }

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="section-kicker">MODERATION QUEUE</span>
          <h1>Cola de Moderación — {muniLabel}</h1>
          <p className="page-subtitle">
            Revisa reportes ciudadanos, ejecuta transiciones válidas con motivo auditable y publica versiones redactadas.
          </p>
        </div>

        <div className="actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void loadQueue()}
            disabled={!hasToken || isLoading}
          >
            <RefreshIcon />
            {isLoading ? 'Actualizando...' : 'Actualizar Cola'}
          </button>
        </div>
      </section>

      {!hasToken ? (
        <div className="alert alert-warning" role="status" aria-live="polite">
          <span className="alert-icon">
            <AlertIcon />
          </span>
          <span>
            Ingresa y aplica un Bearer token (moderador o administrador) en la barra superior para consultar la cola de moderación.
          </span>
        </div>
      ) : null}

      <section className="kpi-grid" aria-label="Resumen de cola de moderación">
        <article className="kpi-card">
          <div className="kpi-card-top">
            <span className="kpi-icon-badge">
              <TotalCasesIcon />
            </span>
            <span className="kpi-tag">{muniLabel}</span>
          </div>
          <div>
            <div className="kpi-label">Total Casos</div>
            <div className="kpi-value tabular-nums">{totalCount}</div>
          </div>
          <div className="kpi-meter" aria-hidden="true">
            <div
              className="kpi-meter-fill"
              style={{ width: totalCount > 0 ? '100%' : '0%' }}
            />
          </div>
        </article>

        <article className="kpi-card">
          <div className="kpi-card-top">
            <span className="kpi-icon-badge accent">
              <PendingIcon />
            </span>
            <span className="kpi-tag accent">SUBMITTED</span>
          </div>
          <div>
            <div className="kpi-label">Pendientes</div>
            <div className="kpi-value tabular-nums">{pendingCount}</div>
          </div>
          <div className="kpi-meter" aria-hidden="true">
            <div
              className="kpi-meter-fill accent"
              style={{ width: pct(pendingCount) }}
            />
          </div>
        </article>

        <article className="kpi-card">
          <div className="kpi-card-top">
            <span className="kpi-icon-badge amber">
              <ReviewIcon />
            </span>
            <span className="kpi-tag amber">TRIAGED / VERIFIED</span>
          </div>
          <div>
            <div className="kpi-label">En Revisión</div>
            <div className="kpi-value tabular-nums">{inReviewCount}</div>
          </div>
          <div className="kpi-meter" aria-hidden="true">
            <div
              className="kpi-meter-fill amber"
              style={{ width: pct(inReviewCount) }}
            />
          </div>
        </article>

        <article className="kpi-card">
          <div className="kpi-card-top">
            <span className="kpi-icon-badge emerald">
              <PublishedIcon />
            </span>
            <span className="kpi-tag emerald">PUBLISHED</span>
          </div>
          <div>
            <div className="kpi-label">Publicados</div>
            <div className="kpi-value tabular-nums">{publishedCount}</div>
          </div>
          <div className="kpi-meter" aria-hidden="true">
            <div
              className="kpi-meter-fill emerald"
              style={{ width: pct(publishedCount) }}
            />
          </div>
        </article>
      </section>

      <section className="card">
        <div className="filter-toolbar">
          <div
            className="pill-group"
            role="group"
            aria-label="Filtrar casos por estado"
          >
            {MODERATION_STATUS_FILTERS.map((statusOption) => {
              const isActive = statusFilter === statusOption
              return (
                <button
                  key={statusOption}
                  type="button"
                  aria-pressed={isActive}
                  className={`filter-pill ${isActive ? 'active' : ''}`}
                  onClick={() => setStatusFilter(statusOption)}
                >
                  {FILTER_LABELS[statusOption]}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {loadError ? (
        <div className="alert alert-error" role="alert" aria-live="polite">
          <span className="alert-icon">
            <AlertIcon />
          </span>
          <span>
            <strong>Error al cargar cola:</strong> {loadError}
          </span>
        </div>
      ) : null}

      {actionSuccess ? (
        <div className="alert alert-success" role="status" aria-live="polite">
          <span className="alert-icon">
            <PublishedIcon />
          </span>
          <span>{actionSuccess}</span>
        </div>
      ) : null}

      {selectedCase && selectedAction ? (
        <section
          className="card-elevated"
          aria-label="Panel de decisión de moderación"
        >
          <div className="card-header">
            <div>
              <span className="section-kicker">AUDIT ACTION</span>
              <h2>Ejecutar {MODERATION_ACTION_LABELS[selectedAction]}</h2>
              <p className="page-subtitle">
                Reporte <span className="mono">{selectedCase.report_id}</span> · Estado actual:{' '}
                <span className={getStatusBadgeClass(selectedCase.status)}>
                  {selectedCase.status}
                </span>
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={closeActionPanel}
            >
              Cancelar
            </button>
          </div>

          <div className="alert alert-info">
            <span className="alert-icon">
              <ReviewIcon />
            </span>
            <span>
              <strong>{selectedCase.category}:</strong> {selectedCase.description}
            </span>
          </div>

          {actionError ? (
            <div className="alert alert-error" role="alert" aria-live="polite">
              <span className="alert-icon">
                <AlertIcon />
              </span>
              <span>{actionError}</span>
            </div>
          ) : null}

          <form onSubmit={(e) => void handleSubmitAction(e)}>
            <div className="field">
              <label htmlFor="moderation-action-select">Acción</label>
              <select
                id="moderation-action-select"
                value={selectedAction}
                onChange={(e) =>
                  setSelectedAction(e.target.value as ModerationAction)
                }
              >
                {getAllowedActions(selectedCase.status).map((allowed) => (
                  <option key={allowed} value={allowed}>
                    {MODERATION_ACTION_LABELS[allowed]}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="moderation-reason-input">
                Motivo auditable (obligatorio)
              </label>
              <textarea
                id="moderation-reason-input"
                data-testid="moderation-reason-input"
                rows={3}
                required
                placeholder="Describe el sustento de esta decisión para el registro de auditoría..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>

            {selectedAction === 'PUBLISH' ? (
              <div className="field">
                <label htmlFor="moderation-public-text-input">
                  Texto público redactado (obligatorio para publicar)
                </label>
                <textarea
                  id="moderation-public-text-input"
                  data-testid="moderation-public-text-input"
                  rows={4}
                  required
                  placeholder="Redacta el resumen público sin datos personales ni PII..."
                  value={publicText}
                  onChange={(e) => setPublicText(e.target.value)}
                />
              </div>
            ) : null}

            <div className="actions-row">
              <button
                type="submit"
                data-testid="moderation-submit-btn"
                className={
                  selectedAction === 'REJECT'
                    ? 'btn btn-danger'
                    : selectedAction === 'PUBLISH'
                      ? 'btn btn-success'
                      : 'btn btn-primary'
                }
                disabled={isSubmittingAction}
              >
                {isSubmittingAction
                  ? 'Procesando...'
                  : `Confirmar ${MODERATION_ACTION_LABELS[selectedAction]}`}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeActionPanel}
                disabled={isSubmittingAction}
              >
                Cerrar
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <span className="section-kicker">MODERATION QUEUE</span>
            <h2>
              Casos en Moderación (<span className="tabular-nums">{cases.length}</span>)
            </h2>
          </div>
        </div>

        {cases.length === 0 ? (
          <div className="empty-state">
            {isLoading
              ? 'Cargando casos de moderación...'
              : 'No se encontraron casos para los filtros seleccionados.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table data-testid="moderation-queue-table">
              <thead>
                <tr>
                  <th>Reporte ID</th>
                  <th>Estado</th>
                  <th>Categoría</th>
                  <th>Descripción</th>
                  <th>Creado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((item) => {
                  const allowed = getAllowedActions(item.status)
                  const isSelected = selectedCase?.report_id === item.report_id
                  return (
                    <tr
                      key={item.id}
                      data-testid="case-row"
                      data-status={item.status}
                      className={isSelected ? 'selected-row' : undefined}
                    >
                      <td className="mono">{item.report_id}</td>
                      <td>
                        <span className={getStatusBadgeClass(item.status)}>
                          {item.status}
                        </span>
                      </td>
                      <td>
                        <strong>{item.category}</strong>
                      </td>
                      <td>
                        <div className="case-desc">{item.description}</div>
                        {item.notes ? (
                          <div className="case-note">Nota: {item.notes}</div>
                        ) : null}
                      </td>
                      <td className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                        {item.created_at.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td>
                        {allowed.length === 0 ? (
                          <span className="badge badge-neutral">
                            Sin acciones
                          </span>
                        ) : (
                          <div className="actions-row">
                            {allowed.map((action) => (
                              <button
                                key={action}
                                type="button"
                                data-testid={MODERATION_ACTION_TEST_IDS[action]}
                                className={
                                  action === 'REJECT'
                                    ? 'btn btn-danger btn-sm'
                                    : action === 'PUBLISH'
                                      ? 'btn btn-success btn-sm'
                                      : 'btn btn-accent btn-sm'
                                }
                                onClick={() => openActionPanel(item, action)}
                              >
                                {MODERATION_ACTION_LABELS[action]}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
