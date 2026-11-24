import { useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { ApiError, type IngestResult } from '../lib/admin-api'
import { useAdminAuth } from '../lib/admin-auth'
import { createScopeGuard, executeScopedDemoIngest } from '../lib/admin-workflow'
import { getMunicipalityLabel } from '../lib/municipalities'

export const Route = createFileRoute('/ingest')({
  component: IngestAdminPage,
})

function formatIngestError(err: unknown): string {
  if (err instanceof ApiError) {
    return `Error ${err.status}: ${err.message}`
  }
  return 'No se pudo ejecutar la ingesta demo.'
}

function IngestAdminPage() {
  const { municipality_id } = Route.useSearch()
  const { token, hasToken } = useAdminAuth()
  const muniLabel = getMunicipalityLabel(municipality_id)

  const scopeGuardRef = useRef(createScopeGuard())
  const [isRunning, setIsRunning] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [latestResult, setLatestResult] = useState<IngestResult | null>(null)
  const [history, setHistory] = useState<IngestResult[]>([])

  useEffect(() => {
    const guard = scopeGuardRef.current
    guard.invalidateScope()
    setIsRunning(false)
    setErrorMessage(null)
    setLatestResult(null)
    setHistory([])
    return () => {
      guard.invalidateScope()
    }
  }, [hasToken, token, municipality_id])

  const handleRunDemoIngest = async () => {
    const startScopeGen = scopeGuardRef.current.currentScope()
    setIsRunning(true)
    setErrorMessage(null)
    try {
      const outcome = await executeScopedDemoIngest(
        scopeGuardRef.current,
        token,
        municipality_id,
      )
      if (outcome.status === 'stale') {
        return
      }
      setLatestResult(outcome.result)
      setHistory((prev) => [outcome.result, ...prev])
    } catch (err: unknown) {
      if (!scopeGuardRef.current.isScopeCurrent(startScopeGen)) {
        return
      }
      setErrorMessage(formatIngestError(err))
    } finally {
      if (scopeGuardRef.current.isScopeCurrent(startScopeGen)) {
        setIsRunning(false)
      }
    }
  }

  return (
    <div>
      <section className="page-header">
        <div>
          <h1>Consola de Ingesta Admin — {muniLabel}</h1>
          <p className="page-subtitle">
            Ejecuta la ingesta CSV idempotente a través de la API Go y el motor exacto en Rust (requiere rol ADMIN).
          </p>
        </div>
      </section>

      {!hasToken ? (
        <div className="alert alert-warning" role="status">
          Ingresa y aplica un Bearer token con rol ADMIN en la barra superior antes de ejecutar la ingesta.
        </div>
      ) : null}

      <section className="card">
        <h2>Ingesta Demo de Gastos Municipales</h2>
        <p className="page-subtitle" style={{ marginBottom: '1rem' }}>
          Municipalidad destino: <strong>{muniLabel}</strong> (<span className="mono">{municipality_id}</span>). Si el archivo CSV ya fue procesado con el mismo SHA-256 para esta municipalidad, la API devolverá <span className="mono">deduplicated: true</span> sin duplicar filas.
        </p>

        <div className="actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleRunDemoIngest()}
            disabled={!hasToken || isRunning}
          >
            {isRunning ? 'Ejecutando ingesta...' : 'Ejecutar Ingesta Demo'}
          </button>
        </div>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error en ingesta:</strong> {errorMessage}
        </div>
      ) : null}

      {latestResult ? (
        <section className="card" aria-label="Resultado de la última ingesta">
          <div className="page-header" style={{ marginBottom: '0.9rem' }}>
            <h2>Resultado de Ingesta</h2>
            <span
              className={
                latestResult.deduplicated
                  ? 'badge badge-triaged'
                  : 'badge badge-published'
              }
            >
              {latestResult.deduplicated
                ? 'Deduplicated (idempotente)'
                : 'Ingesta nueva registrada'}
            </span>
          </div>

          <div className="kv-list">
            <div className="kv-item">
              <div className="kv-label">version_id</div>
              <div className="kv-value mono">
                {latestResult.dataset_version_id}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">row_count</div>
              <div className="kv-value">{latestResult.rows_ingested}</div>
            </div>
            <div className="kv-item">
              <div className="kv-label">deduplicated</div>
              <div className="kv-value">
                {latestResult.deduplicated ? 'true' : 'false'}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">municipality_id</div>
              <div className="kv-value mono">{latestResult.municipality_id}</div>
            </div>
          </div>

          <div className="kv-item" style={{ marginTop: '0.9rem' }}>
            <div className="kv-label">checksum_sha256</div>
            <div className="kv-value mono">{latestResult.checksum_sha256}</div>
          </div>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="card">
          <h2>Historial de Ejecuciones en esta Sesión ({history.length})</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Municipalidad</th>
                  <th>version_id</th>
                  <th>row_count</th>
                  <th>checksum_sha256</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry, idx) => (
                  <tr key={`${entry.dataset_version_id}-${idx}`}>
                    <td className="mono">{entry.municipality_id}</td>
                    <td className="mono">{entry.dataset_version_id}</td>
                    <td>{entry.rows_ingested}</td>
                    <td className="mono">{entry.checksum_sha256}</td>
                    <td>
                      <span
                        className={
                          entry.deduplicated
                            ? 'badge badge-triaged'
                            : 'badge badge-published'
                        }
                      >
                        {entry.deduplicated ? 'Deduplicated' : 'Ingestado'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
