import { useEffect, useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  ApiError,
  fetchExpenses,
  formatBigIntCentsPEN,
  formatCentsPEN,
  sumExpenseCents,
  type Expense,
} from '../lib/api'
import { getMunicipalityLabel } from '../lib/municipalities'

interface ExpensesSearch {
  entity?: string
  category?: string
  from?: string
  to?: string
}

interface ExpensesLoaderData {
  municipalityId: string
  filters: ExpensesSearch
  expenses: Expense[]
  errorMessage: string | null
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const Route = createFileRoute('/expenses')({
  validateSearch: (search: Record<string, unknown>): ExpensesSearch => ({
    entity: readOptionalString(search.entity),
    category: readOptionalString(search.category),
    from: readOptionalString(search.from),
    to: readOptionalString(search.to),
  }),
  loaderDeps: ({ search }) => ({
    municipality_id: search.municipality_id,
    entity: search.entity,
    category: search.category,
    from: search.from,
    to: search.to,
  }),
  loader: async ({ deps }): Promise<ExpensesLoaderData> => {
    try {
      const expenses = await fetchExpenses({
        municipality_id: deps.municipality_id,
        entity: deps.entity,
        category: deps.category,
        from: deps.from,
        to: deps.to,
      })
      return {
        municipalityId: deps.municipality_id,
        filters: {
          entity: deps.entity,
          category: deps.category,
          from: deps.from,
          to: deps.to,
        },
        expenses,
        errorMessage: null,
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'No se pudieron cargar los gastos.'
      return {
        municipalityId: deps.municipality_id,
        filters: {
          entity: deps.entity,
          category: deps.category,
          from: deps.from,
          to: deps.to,
        },
        expenses: [],
        errorMessage: message,
      }
    }
  },
  component: ExpensesPage,
})

function ExpensesPage() {
  const { municipalityId, filters, expenses, errorMessage } = Route.useLoaderData()
  const navigate = useNavigate({ from: '/expenses' })
  const muniLabel = getMunicipalityLabel(municipalityId)

  const [entity, setEntity] = useState(filters.entity ?? '')
  const [category, setCategory] = useState(filters.category ?? '')
  const [fromDate, setFromDate] = useState(filters.from ?? '')
  const [toDate, setToDate] = useState(filters.to ?? '')

  useEffect(() => {
    setEntity(filters.entity ?? '')
    setCategory(filters.category ?? '')
    setFromDate(filters.from ?? '')
    setToDate(filters.to ?? '')
  }, [filters.entity, filters.category, filters.from, filters.to])

  const totalCents = sumExpenseCents(expenses)
  const formattedTotal = formatBigIntCentsPEN(totalCents)

  const handleApplyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate({
      search: {
        municipality_id: municipalityId,
        entity: entity.trim() || undefined,
        category: category.trim() || undefined,
        from: fromDate.trim() || undefined,
        to: toDate.trim() || undefined,
      },
    })
  }

  const handleClearFilters = () => {
    setEntity('')
    setCategory('')
    setFromDate('')
    setToDate('')
    void navigate({
      search: {
        municipality_id: municipalityId,
        entity: undefined,
        category: undefined,
        from: undefined,
        to: undefined,
      },
    })
  }

  return (
    <div>
      <section className="page-header">
        <div>
          <span className="page-eyebrow">Ledger Fiscal · {muniLabel}</span>
          <h1>Explorador de Gastos — {muniLabel}</h1>
          <p className="page-subtitle">
            Consulta los egresos municipales filtrando por entidad, categoría o rango de fechas.
          </p>
        </div>
      </section>

      <section className="grid-2" aria-label="Resumen de gastos">
        <div className="stat-card">
          <div className="stat-card-top">
            <span className="stat-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 6h13" />
                <path d="M8 12h13" />
                <path d="M8 18h13" />
                <path d="M3 6h.01" />
                <path d="M3 12h.01" />
                <path d="M3 18h.01" />
              </svg>
            </span>
            <span className="stat-pill">{muniLabel}</span>
          </div>
          <div>
            <div className="stat-label">Registros encontrados</div>
            <div className="stat-value">{expenses.length}</div>
          </div>
          <div className="segmented-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((slot) => (
              <span
                key={slot}
                className={`segmented-bar ${expenses.length > 0 ? 'filled' : ''}`}
              />
            ))}
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-top">
            <span className="stat-icon-badge" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <circle cx="12" cy="12" r="2" />
                <path d="M6 12h.01M18 12h.01" />
              </svg>
            </span>
            <span className="stat-pill stat-pill-accent">EXACT PEN</span>
          </div>
          <div>
            <div className="stat-label">Monto total (exacto)</div>
            <div className="stat-value stat-value-accent mono" style={{ fontSize: '1.75rem' }}>
              {formattedTotal}
            </div>
          </div>
          <div className="segmented-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((slot) => (
              <span key={slot} className="segmented-bar filled-accent" />
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header-row">
          <h2 className="section-label">FILTROS DE BÚSQUEDA</h2>
          <span className="field-hint">Aritmética exacta BigInt en céntimos</span>
        </div>
        <form onSubmit={handleApplyFilters} className="filter-grid">
          <div className="field">
            <label htmlFor="filter-entity">Entidad</label>
            <input
              id="filter-entity"
              type="text"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="Ej. Gerencia de Obras"
            />
          </div>

          <div className="field">
            <label htmlFor="filter-category">Categoría</label>
            <input
              id="filter-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Ej. Infraestructura"
            />
          </div>

          <div className="field">
            <label htmlFor="filter-from">Desde</label>
            <input
              id="filter-from"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="filter-to">Hasta</label>
            <input
              id="filter-to"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>

          <div className="actions-row">
            <button type="submit" className="btn btn-primary">
              Filtrar
            </button>
            <button
              type="button"
              onClick={handleClearFilters}
              className="btn btn-secondary"
            >
              Limpiar
            </button>
          </div>
        </form>
      </section>

      {errorMessage ? (
        <div className="alert alert-error" role="alert">
          <strong>Error al consultar gastos:</strong> {errorMessage}
        </div>
      ) : null}

      <section className="card">
        <div className="card-header-row">
          <h2 className="section-label">DETALLE DE GASTOS</h2>
          <span className="badge badge-neutral">{expenses.length} partidas</span>
        </div>
        {expenses.length === 0 && !errorMessage ? (
          <div className="empty-state">
            No se encontraron gastos con los filtros actuales para {muniLabel}.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entidad</th>
                  <th>Categoría</th>
                  <th>Fecha</th>
                  <th>Doc. Ref</th>
                  <th style={{ textAlign: 'right' }}>Monto</th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td style={{ fontWeight: 500, color: '#ffffff' }}>
                      {expense.entity}
                    </td>
                    <td>
                      <span className="badge">{expense.category}</span>
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>
                      {expense.occurred_on ?? '—'}
                    </td>
                    <td className="mono" style={{ color: 'var(--text-muted)' }}>
                      {expense.doc_ref ?? '—'}
                    </td>
                    <td className="amount-cell">
                      {formatCentsPEN(expense.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={4} style={{ textAlign: 'right' }}>
                    Total
                  </th>
                  <th className="amount-cell" style={{ color: 'var(--accent)' }}>
                    {formattedTotal}
                  </th>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
