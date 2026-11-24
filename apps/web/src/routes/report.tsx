import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ApiError, createReport, type Report } from '../lib/api'
import { getMunicipalityLabel } from '../lib/municipalities'
import {
  createHashSequenceGuard,
  executeEvidenceUpload,
  executeReportSubmission,
  prepareEvidenceWithGuard,
  type ReadyEvidence,
  type UploadedEvidenceItem,
} from '../lib/report-workflow'

const REPORT_CATEGORIES = [
  'Infraestructura',
  'Contrataciones',
  'Servicios Públicos',
  'Presupuesto',
  'Transparencia',
  'Otro',
] as const

export const Route = createFileRoute('/report')({
  component: NewReportPage,
})

function NewReportPage() {
  const { municipality_id } = Route.useSearch()
  const muniLabel = getMunicipalityLabel(municipality_id)

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [category, setCategory] = useState<string>(REPORT_CATEGORIES[0])
  const [description, setDescription] = useState('')
  const [draftReport, setDraftReport] = useState<Report | null>(null)
  const [submittedReport, setSubmittedReport] = useState<Report | null>(null)

  const scopeGenRef = useRef(0)
  const hashGuardRef = useRef(createHashSequenceGuard())
  const [readyEvidence, setReadyEvidence] = useState<ReadyEvidence | null>(null)
  const [uploadedEvidence, setUploadedEvidence] = useState<UploadedEvidenceItem[]>([])

  const [isBusy, setIsBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    scopeGenRef.current += 1
    hashGuardRef.current.invalidate()
    setStep(1)
    setDraftReport(null)
    setSubmittedReport(null)
    setReadyEvidence(null)
    setUploadedEvidence([])
    setIsBusy(false)
    setStatusMessage(null)
    setErrorMessage(null)
    return () => {
      scopeGenRef.current += 1
      hashGuardRef.current.invalidate()
    }
  }, [municipality_id])

  const handleCreateDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setErrorMessage(null)
    setStatusMessage(null)

    const trimmedDesc = description.trim()
    if (!category.trim() || !trimmedDesc) {
      setErrorMessage('Debes ingresar una categoría y una descripción.')
      return
    }

    const startScope = scopeGenRef.current
    setIsBusy(true)
    try {
      const created = await createReport({
        municipality_id,
        category: category.trim(),
        description: trimmedDesc,
      })
      if (startScope !== scopeGenRef.current) {
        return
      }
      setDraftReport(created)
      setStatusMessage(`Borrador creado (${created.id}). Puedes adjuntar evidencia o continuar al envío.`)
      setStep(2)
    } catch (err: unknown) {
      if (startScope !== scopeGenRef.current) {
        return
      }
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'No se pudo crear el borrador del reporte.',
      )
    } finally {
      if (startScope === scopeGenRef.current) {
        setIsBusy(false)
      }
    }
  }

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    setErrorMessage(null)
    setStatusMessage(null)
    const file = event.target.files?.[0] ?? null
    setReadyEvidence(null)

    if (!file) {
      hashGuardRef.current.invalidate()
      return
    }

    const startScope = scopeGenRef.current
    try {
      const outcome = await prepareEvidenceWithGuard(file, hashGuardRef.current)
      if (startScope !== scopeGenRef.current) {
        return
      }
      if (outcome.status === 'invalid') {
        setErrorMessage(outcome.error)
      } else if (outcome.status === 'ready') {
        setReadyEvidence(outcome.evidence)
      }
    } catch {
      if (startScope !== scopeGenRef.current) {
        return
      }
      setErrorMessage('No se pudo calcular el SHA-256 en el navegador.')
    }
  }

  const handleUploadEvidence = async () => {
    if (!draftReport || !readyEvidence) {
      return
    }
    const startScope = scopeGenRef.current
    setErrorMessage(null)
    setStatusMessage(null)
    setIsBusy(true)

    try {
      const uploaded = await executeEvidenceUpload(draftReport, readyEvidence)
      if (startScope !== scopeGenRef.current) {
        return
      }
      setUploadedEvidence((prev) => [...prev, uploaded])
      hashGuardRef.current.invalidate()
      setReadyEvidence(null)
      setStatusMessage('Evidencia subida y registrada correctamente.')
    } catch (err: unknown) {
      if (startScope !== scopeGenRef.current) {
        return
      }
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'Error al subir la evidencia.',
      )
    } finally {
      if (startScope === scopeGenRef.current) {
        setIsBusy(false)
      }
    }
  }

  const handleSubmitReport = async () => {
    if (!draftReport) {
      return
    }
    const startScope = scopeGenRef.current
    setErrorMessage(null)
    setStatusMessage(null)
    setIsBusy(true)

    try {
      const submitted = await executeReportSubmission(draftReport)
      if (startScope !== scopeGenRef.current) {
        return
      }
      setSubmittedReport(submitted)
      setStep(4)
      setStatusMessage('Tu reporte ha sido enviado a la cola de moderación.')
    } catch (err: unknown) {
      if (startScope !== scopeGenRef.current) {
        return
      }
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'No se pudo enviar el reporte.',
      )
    } finally {
      if (startScope === scopeGenRef.current) {
        setIsBusy(false)
      }
    }
  }

  const handleReset = () => {
    setStep(1)
    setCategory(REPORT_CATEGORIES[0])
    setDescription('')
    setDraftReport(null)
    setSubmittedReport(null)
    hashGuardRef.current.invalidate()
    setReadyEvidence(null)
    setUploadedEvidence([])
    setStatusMessage(null)
    setErrorMessage(null)
  }

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="page-eyebrow">Canal Ciudadano Seguro · {muniLabel}</span>
          <h1>Nuevo Reporte Ciudadano — {muniLabel}</h1>
          <p className="page-subtitle">
            Crea un borrador anónimo, adjunta evidencia opcional con huella SHA-256 y envía el reporte a revisión.
          </p>
        </div>
      </section>

      <div className="stepper" aria-label="Progreso del reporte">
        <div className={`step-item ${step === 1 ? 'active' : step > 1 ? 'done' : ''}`}>
          <span className="step-badge-num" aria-hidden="true">01</span>
          <div>
            <div className="step-num">Paso 1</div>
            <div className="step-title">Crear borrador</div>
          </div>
        </div>
        <div className={`step-item ${step === 2 ? 'active' : step > 2 ? 'done' : ''}`}>
          <span className="step-badge-num" aria-hidden="true">02</span>
          <div>
            <div className="step-num">Paso 2</div>
            <div className="step-title">Evidencia (opcional)</div>
          </div>
        </div>
        <div className={`step-item ${step === 3 ? 'active' : step > 3 ? 'done' : ''}`}>
          <span className="step-badge-num" aria-hidden="true">03</span>
          <div>
            <div className="step-num">Paso 3</div>
            <div className="step-title">Enviar reporte</div>
          </div>
        </div>
      </div>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          {errorMessage}
        </div>
      ) : null}

      {statusMessage ? (
        <div className="alert alert-info" role="status">
          {statusMessage}
        </div>
      ) : null}

      {step === 1 ? (
        <section className="card">
          <div className="card-header-row">
            <h2>Paso 1: Descripción del Reporte</h2>
            <span className="badge badge-neutral">BORRADOR</span>
          </div>
          <form onSubmit={handleCreateDraft}>
            <div className="grid-2" style={{ marginBottom: '1rem' }}>
              <div className="field">
                <label htmlFor="report-muni">Municipalidad</label>
                <input
                  id="report-muni"
                  type="text"
                  value={muniLabel}
                  disabled
                />
                <span className="field-hint">
                  Cambia la municipalidad desde el selector lateral o superior si corresponde.
                </span>
              </div>

              <div className="field">
                <label htmlFor="report-category">Categoría</label>
                <select
                  id="report-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {REPORT_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="report-description">Descripción</label>
              <textarea
                id="report-description"
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe el hecho observado, obra, contrato o irregularidad sin incluir datos personales sensibles."
                required
              />
              <span className="field-hint">
                Evita incluir nombres de testigos, teléfonos o datos personales (PII).
              </span>
            </div>

            <div className="actions-row">
              <button type="submit" className="btn btn-primary" disabled={isBusy}>
                {isBusy ? 'Creando borrador...' : 'Crear borrador y continuar'}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {step === 2 && draftReport ? (
        <section className="card">
          <div className="card-header-row">
            <h2>Paso 2: Adjuntar Evidencia (Opcional)</h2>
            <span className="badge">{draftReport.status}</span>
          </div>
          <p className="page-subtitle" style={{ marginBottom: '1.15rem' }}>
            Borrador <span className="mono">{draftReport.id}</span> listo para recibir respaldos criptográficos.
          </p>

          <div className="field file-dropzone" style={{ marginBottom: '1.1rem' }}>
            <label htmlFor="evidence-file">Archivo de respaldo</label>
            <input
              id="evidence-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.txt"
              onChange={(e) => void handleFileChange(e)}
              disabled={isBusy}
            />
            <span className="field-hint">
              Formatos permitidos: PDF, JPEG, PNG, WEBP, TXT (máx. 10 MB). El hash SHA-256 se calcula localmente antes de subir.
            </span>
          </div>

          {readyEvidence ? (
            <div className="alert alert-info">
              <div>
                <strong>Archivo listo:</strong> {readyEvidence.file.name} ({readyEvidence.file.size} bytes)
              </div>
              <div className="mono" style={{ marginTop: '0.35rem', color: 'var(--accent)' }}>
                SHA-256: {readyEvidence.sha256}
              </div>
              <div className="actions-row" style={{ marginTop: '0.85rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleUploadEvidence()}
                  disabled={isBusy}
                >
                  {isBusy ? 'Subiendo...' : 'Subir evidencia'}
                </button>
              </div>
            </div>
          ) : null}

          {uploadedEvidence.length > 0 ? (
            <div style={{ marginBottom: '1.25rem' }}>
              <h3 className="section-label" style={{ marginBottom: '0.65rem' }}>
                EVIDENCIA ADJUNTA ({uploadedEvidence.length})
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Archivo</th>
                      <th>Tipo</th>
                      <th>SHA-256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadedEvidence.map((item) => (
                      <tr key={item.evidenceId}>
                        <td style={{ color: '#ffffff', fontWeight: 500 }}>{item.fileName}</td>
                        <td>
                          <span className="badge badge-neutral">{item.contentType}</span>
                        </td>
                        <td className="mono" style={{ color: 'var(--emerald-text)' }}>
                          {item.sha256}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="actions-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStep(3)}
              disabled={isBusy}
            >
              Continuar al envío
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 && draftReport ? (
        <section className="card">
          <div className="card-header-row">
            <h2>Paso 3: Confirmar y Enviar Reporte</h2>
            <span className="badge badge-warning">REVISIÓN FINAL</span>
          </div>
          <p className="page-subtitle" style={{ marginBottom: '1.15rem' }}>
            Revisa los datos antes de enviar el reporte a moderación. Una vez enviado, la evidencia adjunta es inmutable.
          </p>

          <dl className="summary-dl">
            <div>
              <dt>ID de borrador</dt>
              <dd className="mono">{draftReport.id}</dd>
            </div>
            <div>
              <dt>Municipalidad</dt>
              <dd>{getMunicipalityLabel(draftReport.municipality_id)}</dd>
            </div>
            <div>
              <dt>Categoría</dt>
              <dd>
                <span className="badge">{draftReport.category}</span>
              </dd>
            </div>
            <div>
              <dt>Evidencia adjunta</dt>
              <dd>{uploadedEvidence.length} archivo(s)</dd>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>Descripción</dt>
              <dd style={{ lineHeight: 1.55 }}>{draftReport.description}</dd>
            </div>
          </dl>

          <div className="actions-row" style={{ marginTop: '1.25rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setStep(2)}
              disabled={isBusy}
            >
              Volver a evidencia
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSubmitReport()}
              disabled={isBusy}
            >
              {isBusy ? 'Enviando...' : 'Enviar reporte'}
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 && submittedReport ? (
        <section className="card">
          <div className="alert alert-success">
            <strong>¡Reporte enviado correctamente!</strong> Tu reporte pasó al estado{' '}
            <span className="badge badge-success">{submittedReport.status}</span>.
          </div>

          <dl className="summary-dl" style={{ marginBottom: '1.25rem' }}>
            <div>
              <dt>Código de seguimiento</dt>
              <dd className="mono">{submittedReport.id}</dd>
            </div>
            <div>
              <dt>Municipalidad</dt>
              <dd>{getMunicipalityLabel(submittedReport.municipality_id)}</dd>
            </div>
            <div>
              <dt>Categoría</dt>
              <dd>{submittedReport.category}</dd>
            </div>
            <div>
              <dt>Evidencia adjunta</dt>
              <dd>{uploadedEvidence.length} archivo(s)</dd>
            </div>
          </dl>

          <div className="actions-row">
            <button type="button" className="btn btn-primary" onClick={handleReset}>
              Crear otro reporte
            </button>
            <Link
              to="/reports"
              search={{ municipality_id }}
              className="btn btn-secondary"
            >
              Ver Reportes Públicos
            </Link>
          </div>
        </section>
      ) : null}
    </div>
  )
}
