import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  ApiError,
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

const ACTION_LABELS: Record<ModerationAction, string> = {
  TRIAGE: 'Triaje (Triage)',
  VERIFY: 'Verificar (Verify)',
  REJECT: 'Rechazar (Reject)',
  PUBLISH: 'Publicar (Publish)',
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

  return (
    <div>
      <section className="page-header">
        <div>
          <h1>Cola de Moderación — {muniLabel}</h1>
          <p className="page-subtitle">
            Revisa reportes ciudadanos, ejecuta transiciones válidas con motivo auditable y publica versiones redactadas.
          </p>
        </div>
      </section>

      {!hasToken ? (
        <div className="alert alert-warning" role="status">
          Ingresa y aplica un Bearer token (moderador o administrador) en la barra superior para consultar la cola de moderación.
        </div>
      ) : null}

      <section className="card">
        <div className="toolbar">
          <div className="toolbar-group">
            <div className="field">
              <label htmlFor="status-filter-select">Filtrar por estado</label>
              <select
                id="status-filter-select"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                {MODERATION_STATUS_FILTERS.map((statusOption) => (
                  <option key={statusOption} value={statusOption}>
                    {statusOption}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="actions-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void loadQueue()}
              disabled={isLoading}
            >
              {isLoading ? 'Actualizando...' : 'Actualizar Cola'}
            </button>
          </div>
        </div>
      </section>

      {loadError ? (
        <div className="alert alert-error" role="alert">
          <strong>Error al cargar cola:</strong> {loadError}
        </div>
      ) : null}

      {actionSuccess ? (
        <div className="alert alert-success" role="status">
          {actionSuccess}
        </div>
      ) : null}

      {selectedCase && selectedAction ? (
        <section className="card" aria-label="Panel de decisión de moderación">
          <div className="page-header" style={{ marginBottom: '0.85rem' }}>
            <div>
              <h2>
                Ejecutar {ACTION_LABELS[selectedAction]}
              </h2>
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

          <div className="alert alert-info" style={{ marginBottom: '1rem' }}>
            <strong>{selectedCase.category}:</strong> {selectedCase.description}
          </div>

          {actionError ? (
            <div className="alert alert-error" role="alert">
              {actionError}
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
                    {ACTION_LABELS[allowed]}
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
                  : `Confirmar ${selectedAction}`}
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
        <h2>Casos en Moderación ({cases.length})</h2>
        {cases.length === 0 ? (
          <div className="empty-state">
            {isLoading
              ? 'Cargando casos de moderación...'
              : 'No se encontraron casos para los filtros seleccionados.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
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
                        <div>{item.description}</div>
                        {item.notes ? (
                          <div
                            className="page-subtitle"
                            style={{ fontSize: '0.8rem' }}
                          >
                            Nota: {item.notes}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
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
                                className={
                                  action === 'REJECT'
                                    ? 'btn btn-danger btn-sm'
                                    : action === 'PUBLISH'
                                      ? 'btn btn-success btn-sm'
                                      : 'btn btn-primary btn-sm'
                                }
                                onClick={() => openActionPanel(item, action)}
                              >
                                {action === 'TRIAGE'
                                  ? 'Triage'
                                  : action === 'VERIFY'
                                    ? 'Verify'
                                    : action === 'REJECT'
                                      ? 'Reject'
                                      : 'Publish'}
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
