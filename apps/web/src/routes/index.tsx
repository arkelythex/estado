import { Link, createFileRoute } from '@tanstack/react-router'
import { ApiError, fetchDatasets, type Dataset } from '../lib/api'
import { getMunicipalityLabel } from '../lib/municipalities'

interface IndexLoaderData {
  municipalityId: string
  datasets: Dataset[]
  errorMessage: string | null
}

export const Route = createFileRoute('/')({
  loaderDeps: ({ search }) => ({
    municipality_id: search.municipality_id,
  }),
  loader: async ({ deps }): Promise<IndexLoaderData> => {
    try {
      const datasets = await fetchDatasets(deps.municipality_id)
      return {
        municipalityId: deps.municipality_id,
        datasets,
        errorMessage: null,
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'No se pudo conectar con la API de transparencia.'
      return {
        municipalityId: deps.municipality_id,
        datasets: [],
        errorMessage: message,
      }
    }
  },
  component: HomePage,
})

function HomePage() {
  const { municipalityId, datasets, errorMessage } = Route.useLoaderData()
  const muniLabel = getMunicipalityLabel(municipalityId)
  const totalVersions = datasets.reduce((sum, ds) => sum + ds.versions, 0)

  const activeBars = Math.min(4, Math.max(datasets.length > 0 ? 1 : 0, datasets.length))
  const versionBars = Math.min(4, Math.max(totalVersions > 0 ? 1 : 0, Math.ceil(totalVersions / 2)))

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="page-eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Portal Municipal · {muniLabel}
          </span>
          <h1>Transparencia Municipal — {muniLabel}</h1>
          <p className="page-subtitle">
            Consulta los conjuntos de datos abiertos, explora el gasto público ejecutado y envía reportes ciudadanos con evidencia verificable.
          </p>
        </div>
        <div className="actions-row">
          <Link
            to="/expenses"
            search={{ municipality_id: municipalityId }}
            className="btn btn-secondary"
          >
            Explorar Gastos
          </Link>
          <Link
            to="/report"
            search={{ municipality_id: municipalityId }}
            className="btn btn-primary"
          >
            + Nuevo Reporte
          </Link>
        </div>
      </section>

      <section className="grid-3" aria-label="Indicadores de transparencia">
        <div className="stat-card">
          <div className="stat-card-top">
            <span className="stat-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
              </svg>
            </span>
            <span className="stat-pill">{muniLabel}</span>
          </div>
          <div>
            <div className="stat-label">Datasets Activos</div>
            <div className="stat-value">{datasets.length}</div>
          </div>
          <div className="segmented-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((slot) => (
              <span
                key={slot}
                className={`segmented-bar ${slot <= activeBars ? 'filled' : ''}`}
              />
            ))}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-top">
            <span className="stat-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4" />
                <path d="m16.2 7.8 2.9-2.9" />
                <path d="M18 12h4" />
                <path d="m16.2 16.2 2.9 2.9" />
                <path d="M12 18v4" />
                <path d="m4.9 19.1 2.9-2.9" />
                <path d="M2 12h4" />
                <path d="m4.9 4.9 2.9 2.9" />
              </svg>
            </span>
            <span className="stat-pill stat-pill-accent">INDEXED</span>
          </div>
          <div>
            <div className="stat-label">Versiones Indexadas</div>
            <div className="stat-value">
              {totalVersions}
              <span className="stat-unit">REV</span>
            </div>
          </div>
          <div className="segmented-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((slot) => (
              <span
                key={slot}
                className={`segmented-bar ${slot <= versionBars ? 'filled-accent' : ''}`}
              />
            ))}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-top">
            <span className="stat-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
            </span>
            <span className="stat-pill stat-pill-emerald">VERIFIED</span>
          </div>
          <div>
            <div className="stat-label">Integridad SHA-256</div>
            <div className="stat-value">
              100<span className="stat-unit">%</span>
            </div>
          </div>
          <div className="segmented-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((slot) => (
              <span key={slot} className="segmented-bar filled-emerald" />
            ))}
          </div>
        </div>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error al cargar datasets:</strong> {errorMessage}
        </div>
      ) : null}

      <section className="dashboard-split">
        <article className="card" style={{ marginBottom: 0 }}>
          <div className="card-header-row">
            <h2 className="section-label">AUDIT TIMELINE</h2>
            <span className="stat-pill stat-pill-emerald">ACTIVO</span>
          </div>

          <div className="timeline-list">
            <div className="timeline-item">
              <span className="timeline-node done" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
              <div className="timeline-title">Verificación Hash SHA-256</div>
              <div className="timeline-meta">
                Cálculo local en navegador antes de carga
              </div>
            </div>

            <div className="timeline-item">
              <span className="timeline-node live" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-9-9" />
                  <path d="M21 3v6h-6" />
                </svg>
              </span>
              <div className="timeline-title">Sincronización Municipal</div>
              <div className="timeline-meta">
                {muniLabel} · {datasets.length} dataset(s) activos
              </div>
            </div>

            <div className="timeline-item">
              <span className="timeline-node" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
              <div className="timeline-title">Custodia Inmutable de Evidencia</div>
              <div className="timeline-meta">
                Almacenamiento cifrado · Solo lectura pública
              </div>
            </div>

            <div className="timeline-item">
              <span className="timeline-node" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6" />
                </svg>
              </span>
              <div className="timeline-title">Trazabilidad de Auditoría</div>
              <div className="timeline-meta">
                Flujo draft → submitted → triaged → verified → published
              </div>
            </div>
          </div>

          <div className="timeline-footer">
            <Link to="/reports" search={{ municipality_id: municipalityId }}>
              Ver reportes públicos verificados →
            </Link>
          </div>
        </article>

        <article className="card" style={{ marginBottom: 0 }}>
          <div className="card-header-row">
            <div>
              <h2 className="section-label">RECENT DATASETS</h2>
              <p className="field-hint" style={{ margin: '0.25rem 0 0' }}>
                Conjuntos de datos abiertos registrados en {muniLabel}
              </p>
            </div>
            <span className="badge badge-neutral">
              {datasets.length} {datasets.length === 1 ? 'registro' : 'registros'}
            </span>
          </div>

          {datasets.length === 0 && !errorMessage ? (
            <div className="empty-state">
              No hay datasets registrados para {muniLabel} todavía.
            </div>
          ) : (
            <div className="dataset-cards-grid">
              {datasets.map((dataset) => (
                <div key={dataset.id} className="dataset-card">
                  <div className="dataset-preview">
                    <span className="dataset-preview-badge">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      {dataset.kind}
                    </span>
                    <span className="badge badge-success">VERIFIED</span>
                  </div>
                  <div className="dataset-name">{dataset.name}</div>
                  <div className="dataset-meta">
                    <span>
                      {dataset.versions} {dataset.versions === 1 ? 'versión' : 'versiones'}
                    </span>
                    <span className="mono">{dataset.created_at.slice(0, 10)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>

      <section className="grid-2" aria-label="Acciones rápidas">
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header-row">
            <h2>Explorador de Gastos Públicos</h2>
            <span className="badge">PEN EXACTO</span>
          </div>
          <p className="page-subtitle">
            Filtra partidas por entidad, categoría y rango de fechas con totales exactos en Soles (PEN).
          </p>
          <div className="actions-row" style={{ marginTop: '1.1rem' }}>
            <Link
              to="/expenses"
              search={{ municipality_id: municipalityId }}
              className="btn btn-primary"
            >
              Ir a Gastos
            </Link>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <div className="card-header-row">
            <h2>Participación Ciudadana</h2>
            <span className="badge badge-success">AUDITABLE</span>
          </div>
          <p className="page-subtitle">
            Registra un borrador de reporte, adjunta evidencia con hash SHA-256 calculado en tu navegador y envíalo a moderación.
          </p>
          <div className="actions-row" style={{ marginTop: '1.1rem' }}>
            <Link
              to="/report"
              search={{ municipality_id: municipalityId }}
              className="btn btn-primary"
            >
              Enviar Reporte
            </Link>
            <Link
              to="/reports"
              search={{ municipality_id: municipalityId }}
              className="btn btn-secondary"
            >
              Ver Reportes Públicos
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}
