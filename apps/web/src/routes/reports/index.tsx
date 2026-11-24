import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ApiError,
  fetchPublishedReports,
  type PublicReportSummary,
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

  return (
    <div>
      <section className="page-header">
        <div>
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
          Nuevo Reporte
        </Link>
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
        <section className="report-list">
          {reports.map((report) => (
            <article key={report.id} className="report-item">
              <div className="report-item-header">
                <div className="actions-row">
                  <span className="badge">{report.category}</span>
                  <span className="badge badge-success">{report.status}</span>
                </div>
                <span className="field-hint">
                  Publicado: {report.published_at.slice(0, 10)}
                </span>
              </div>

              <p style={{ margin: '0.5rem 0 0.85rem' }}>{report.public_text}</p>

              <div className="actions-row">
                <Link
                  to="/reports/$id"
                  params={{ id: report.id }}
                  search={{ municipality_id: municipalityId }}
                  className="btn btn-secondary"
                >
                  Ver detalle y evidencia
                </Link>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}
