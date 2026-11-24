import { useEffect, useState, type FormEvent } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ApiError,
  fetchPublishedReports,
  trackReportByReceipt,
  type PublicReportSummary,
  type ReportTracking,
} from '../../lib/api'
import { getMunicipalityLabel } from '../../lib/municipalities'

interface ReportsLoaderData {
  municipalityId: string
  reports: PublicReportSummary[]
  errorMessage: string | null
}

export const Route = createFileRoute('/reports/')({
  loaderDeps: ({ search }) => ({
    municipality_id: search.municipality_id,
  }),
  loader: async ({ deps }): Promise<ReportsLoaderData> => {
    try {
      const reports = await fetchPublishedReports(deps.municipality_id)
      return {
        municipalityId: deps.municipality_id,
        reports,
        errorMessage: null,
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'No se pudieron cargar los reportes públicos.'
      return {
        municipalityId: deps.municipality_id,
        reports: [],
        errorMessage: message,
      }
    }
  },
  component: PublishedReportsPage,
})

function PublishedReportsPage() {
  const { municipalityId, reports, errorMessage } = Route.useLoaderData()
  const muniLabel = getMunicipalityLabel(municipalityId)

  const [receiptCode, setReceiptCode] = useState('')
  const [isTracking, setIsTracking] = useState(false)
  const [trackingResult, setTrackingResult] = useState<ReportTracking | null>(null)
  const [trackingError, setTrackingError] = useState<string | null>(null)

  useEffect(() => {
    setTrackingResult(null)
    setTrackingError(null)
    setIsTracking(false)
  }, [municipalityId])

  const handleTrackSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTrackingError(null)
    setTrackingResult(null)

    const trimmed = receiptCode.trim()
    if (!trimmed) {
      setTrackingError('Ingresa tu código de recibo anónimo.')
      return
    }

    setIsTracking(true)
    try {
      const result = await trackReportByReceipt(municipalityId, trimmed)
      setTrackingResult(result)
    } catch (err: unknown) {
      setTrackingError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo consultar el estado del recibo.',
      )
    } finally {
      setIsTracking(false)
    }
  }

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="page-eyebrow">Registro Público · {muniLabel}</span>
          <h1>Reportes Públicos Verificados — {muniLabel}</h1>
          <p className="page-subtitle">
            Publicaciones verificadas y redactadas sin datos personales sensibles.
          </p>
        </div>
        <Link
          to="/report"
          search={{ municipality_id: municipalityId }}
          className="btn btn-primary"
        >
          + Nuevo Reporte
        </Link>
      </section>

      <section className="card" aria-label="Seguimiento anónimo por recibo">
        <div className="card-header-row">
          <div>
            <h2 className="section-label">SEGUIMIENTO ANÓNIMO POR RECIBO</h2>
            <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
              Consulta el estado y la línea de tiempo de tu reporte sin exponer datos personales ni incluir el código en la URL.
            </p>
          </div>
          <span className="badge badge-neutral">HEADER X-RECEIPT-CODE</span>
        </div>

        <form
          onSubmit={(e) => void handleTrackSubmit(e)}
          data-testid="receipt-tracker-form"
          className="tracker-form-row"
        >
          <div className="field">
            <label htmlFor="receipt-code-input">Código de Recibo Anónimo</label>
            <input
              id="receipt-code-input"
              data-testid="receipt-code-input"
              type="text"
              value={receiptCode}
              onChange={(e) => setReceiptCode(e.target.value)}
              placeholder="Ej. ABCD-EFGH-IJKL-MNOP"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isTracking}
            data-testid="receipt-track-btn"
          >
            {isTracking ? 'Consultando...' : 'Consultar estado'}
          </button>
        </form>

        <div
          className="tracker-result-box"
          data-testid="receipt-track-result"
          aria-live="polite"
        >
          {trackingError ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 0 }}>
              {trackingError}
            </div>
          ) : trackingResult ? (
            <div className="tracker-summary">
              <div className="report-item-header">
                <div className="actions-row">
                  <span className="badge">{trackingResult.category}</span>
                  <span className="badge badge-success">
                    <span className="status-dot" aria-hidden="true" />
                    {trackingResult.status}
                  </span>
                </div>
                <span className="field-hint mono">
                  {getMunicipalityLabel(trackingResult.municipality_id)} · Creado:{' '}
                  {trackingResult.created_at.slice(0, 10)}
                </span>
              </div>

              {trackingResult.timeline.length === 0 ? (
                <p className="field-hint" style={{ margin: 0 }}>
                  Reporte registrado en estado inicial sin transiciones adicionales todavía.
                </p>
              ) : (
                <div className="timeline-list">
                  {trackingResult.timeline.map((ev, idx) => (
                    <div
                      key={`${ev.action}-${ev.occurred_at}-${idx}`}
                      className="timeline-item"
                    >
                      <span className="timeline-node done" aria-hidden="true">
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <div className="timeline-title">
                        {ev.action} ({ev.from_status} → {ev.to_status})
                      </div>
                      <div className="timeline-meta mono">{ev.occurred_at}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error al cargar reportes públicos:</strong> {errorMessage}
        </div>
      ) : null}

      {reports.length === 0 && !errorMessage ? (
        <section className="card">
          <div className="empty-state">
            No hay reportes publicados todavía para {muniLabel}.
          </div>
        </section>
      ) : (
        <section className="report-list" aria-label="Listado de reportes públicos">
          {reports.map((report) => (
            <article
              key={report.id}
              className="report-item"
              data-testid="public-report-card"
            >
              <div className="report-item-header">
                <div className="actions-row">
                  <span className="badge">{report.category}</span>
                  <span className="badge badge-success">
                    <span className="status-dot" aria-hidden="true" />
                    {report.status}
                  </span>
                </div>
                <span className="field-hint mono">
                  Publicado: {report.published_at.slice(0, 10)}
                </span>
              </div>

              <p className="report-text">{report.public_text}</p>

              <div className="actions-row">
                <Link
                  to="/reports/$id"
                  params={{ id: report.id }}
                  search={{ municipality_id: municipalityId }}
                  className="btn btn-secondary"
                >
                  Ver detalle y evidencia →
                </Link>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}
