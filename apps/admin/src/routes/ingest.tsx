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

function IngestIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function FingerprintIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
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
          <span className="section-kicker">IDEMPOTENT INGEST</span>
          <h1>Consola de Ingesta Admin — {muniLabel}</h1>
          <p className="page-subtitle">
            Ejecuta la ingesta CSV idempotente a través de la API Go y el motor exacto en Rust (requiere rol ADMIN).
          </p>
        </div>
      </section>

      {!hasToken ? (
        <div className="alert alert-warning" role="status">
          <span className="alert-icon">
            <AlertIcon />
          </span>
          <span>
            Ingresa y aplica un Bearer token con rol ADMIN en la barra superior antes de ejecutar la ingesta.
          </span>
        </div>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <span className="section-kicker">IDEMPOTENT INGEST</span>
            <h2>Ingesta Demo de Gastos Municipales</h2>
          </div>
          <span className="badge badge-submitted">{muniLabel}</span>
        </div>

        <p className="page-subtitle" style={{ marginBottom: '1.15rem' }}>
          Municipalidad destino: <strong>{muniLabel}</strong> (<span className="mono">{municipality_id}</span>). Si el archivo CSV ya fue procesado con el mismo SHA-256 para esta municipalidad, la API devolverá <span className="mono">deduplicated: true</span> sin duplicar filas.
        </p>

        <div className="actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleRunDemoIngest()}
            disabled={!hasToken || isRunning}
          >
            <IngestIcon />
            {isRunning ? 'Ejecutando ingesta...' : 'Ejecutar Ingesta Demo'}
          </button>
        </div>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">
            <AlertIcon />
          </span>
          <span>
            <strong>Error en ingesta:</strong> {errorMessage}
          </span>
        </div>
      ) : null}

      {latestResult ? (
        <section
          className="card-elevated"
          aria-label="Resultado de la última ingesta"
        >
          <div className="card-header">
            <div>
              <span className="section-kicker">EXECUTION RESULT</span>
              <h2>Resultado de Ingesta</h2>
            </div>
            <span
              className={
                latestResult.deduplicated
                  ? 'badge badge-published'
                  : 'badge badge-submitted'
              }
            >
              {latestResult.deduplicated
                ? 'deduplicated: true (idempotente)'
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
              <div className="kv-value tabular-nums">
                {latestResult.rows_ingested}
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">deduplicated</div>
              <div className="kv-value">
                <span
                  className={
                    latestResult.deduplicated
                      ? 'badge badge-published'
                      : 'badge badge-neutral'
                  }
                >
                  {latestResult.deduplicated ? 'true' : 'false'}
                </span>
              </div>
            </div>
            <div className="kv-item">
              <div className="kv-label">municipality_id</div>
              <div className="kv-value mono">{latestResult.municipality_id}</div>
            </div>
          </div>

          <div className="checksum-card">
            <span className="checksum-icon">
              <FingerprintIcon />
            </span>
            <div>
              <div className="kv-label">checksum_sha256</div>
              <div className="kv-value mono">{latestResult.checksum_sha256}</div>
            </div>
          </div>
        </section>
      ) : null}

      {history.length > 0 ? (
        <section className="card">
          <div className="card-header">
            <div>
              <span className="section-kicker">SESSION LOG</span>
              <h2>
                Historial de Ejecuciones en esta Sesión (
                <span className="tabular-nums">{history.length}</span>)
              </h2>
            </div>
          </div>
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
                    <td className="tabular-nums">{entry.rows_ingested}</td>
                    <td className="mono">{entry.checksum_sha256}</td>
                    <td>
                      <span
                        className={
                          entry.deduplicated
                            ? 'badge badge-published'
                            : 'badge badge-submitted'
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
