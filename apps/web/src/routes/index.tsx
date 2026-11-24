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

  return (
    <div>
      <section className="page-header">
        <div>
          <h1>Transparencia Municipal — {muniLabel}</h1>
          <p className="page-subtitle">
            Consulta los conjuntos de datos abiertos, explora el gasto público ejecutado y envía reportes ciudadanos con evidencia verificable.
          </p>
        </div>
        <div className="actions-row">
          <Link
            to="/expenses"
            search={{ municipality_id: municipalityId }}
            className="btn btn-primary"
          >
            Explorar Gastos
          </Link>
          <Link
            to="/report"
            search={{ municipality_id: municipalityId }}
            className="btn btn-secondary"
          >
            Nuevo Reporte
          </Link>
        </div>
      </section>

      <section className="grid-3">
        <div className="stat-card">
          <div className="stat-label">Municipalidad activa</div>
          <div className="stat-value">{muniLabel}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Datasets publicados</div>
          <div className="stat-value">{datasets.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Versiones registradas</div>
          <div className="stat-value">{totalVersions}</div>
        </div>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error al cargar datasets:</strong> {errorMessage}
        </div>
      ) : null}

      <section className="card">
        <h2>Conjuntos de Datos Activos</h2>
        {datasets.length === 0 && !errorMessage ? (
          <div className="empty-state">
            No hay datasets registrados para {muniLabel} todavía.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Tipo</th>
                  <th>Versiones</th>
                  <th>Fecha de registro</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map((dataset) => (
                  <tr key={dataset.id}>
                    <td>
                      <strong>{dataset.name}</strong>
                    </td>
                    <td>
                      <span className="badge">{dataset.kind}</span>
                    </td>
                    <td>{dataset.versions}</td>
                    <td>{dataset.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid-2">
        <div className="card">
          <h2>Explorador de Gastos Públicos</h2>
          <p className="page-subtitle">
            Filtra partidas por entidad, categoría y rango de fechas con totales exactos en Soles (PEN).
          </p>
          <div className="actions-row" style={{ marginTop: '1rem' }}>
            <Link
              to="/expenses"
              search={{ municipality_id: municipalityId }}
              className="btn btn-primary"
            >
              Ir a Gastos
            </Link>
          </div>
        </div>

        <div className="card">
          <h2>Participación Ciudadana</h2>
          <p className="page-subtitle">
            Registra un borrador de reporte, adjunta evidencia con hash SHA-256 calculado en tu navegador y envíalo a moderación.
          </p>
          <div className="actions-row" style={{ marginTop: '1rem' }}>
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
