import { Link, createFileRoute } from '@tanstack/react-router'
import {
  ApiError,
  fetchPublishedReport,
  type PublicReportDetail,
} from '../../lib/api'
import { getMunicipalityLabel } from '../../lib/municipalities'

interface ReportDetailLoaderData {
  municipalityId: string
  report: PublicReportDetail | null
  errorMessage: string | null
}

export const Route = createFileRoute('/reports/$id')({
  loaderDeps: ({ search }) => ({
    municipality_id: search.municipality_id,
  }),
  loader: async ({ params, deps }): Promise<ReportDetailLoaderData> => {
    try {
      const report = await fetchPublishedReport(params.id, deps.municipality_id)
      return {
        municipalityId: deps.municipality_id,
        report,
        errorMessage: null,
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'No se pudo cargar el detalle del reporte.'
      return {
        municipalityId: deps.municipality_id,
        report: null,
        errorMessage: message,
      }
    }
  },
  component: PublishedReportDetailPage,
})

function PublishedReportDetailPage() {
  const { municipalityId, report, errorMessage } = Route.useLoaderData()
  const muniLabel = getMunicipalityLabel(municipalityId)

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="page-eyebrow">Expediente Público · {muniLabel}</span>
          <h1>Detalle de Reporte Público — {muniLabel}</h1>
          <p className="page-subtitle">
            Información verificada y cadena de evidencia inmutable.
          </p>
        </div>
        <Link
          to="/reports"
          search={{ municipality_id: municipalityId }}
          className="btn btn-secondary"
        >
          ← Volver a Reportes Públicos
        </Link>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error:</strong> {errorMessage}
        </div>
      ) : null}

      {report ? (
        <div data-testid="public-report-detail">
          <section className="card">
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

            <p className="report-text" style={{ fontSize: '1.02rem', marginTop: '0.85rem', marginBottom: 0 }}>
              {report.public_text}
            </p>
          </section>

          <section className="card">
            <div className="card-header-row">
              <h2 className="section-label">EVIDENCIA VERIFICADA</h2>
              <span
                className="badge badge-neutral"
                data-testid="public-evidence-count"
              >
                {report.evidence_count} {report.evidence_count === 1 ? 'archivo' : 'archivos'}
              </span>
            </div>
            {report.evidence_count === 0 ? (
              <div className="empty-state">
                Este reporte público no tiene archivos de evidencia adjuntos.
              </div>
            ) : (
              <div className="alert alert-info" style={{ marginBottom: 0 }}>
                Este reporte cuenta con{' '}
                <strong>{report.evidence_count}</strong> archivo(s) de evidencia
                resguardados en custodia inmutable. Los identificadores internos y
                metadatos de almacenamiento se omiten en la vista pública por
                política de privacidad.
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
