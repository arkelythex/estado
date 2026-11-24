import { useState, type FormEvent, type ReactNode } from 'react'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import appCss from '../styles.css?url'
import { AdminAuthProvider, useAdminAuth } from '../lib/admin-auth'
import {
  MUNICIPALITIES,
  normalizeMunicipalityId,
} from '../lib/municipalities'

export interface RootSearch {
  municipality_id: string
}

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    municipality_id: normalizeMunicipalityId(search.municipality_id),
  }),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'CivicTech Perú — Consola de Moderación y Administración' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <AdminAuthProvider>
        <AdminShell />
      </AdminAuthProvider>
    </RootDocument>
  )
}

function AdminShell() {
  const { municipality_id } = Route.useSearch()
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const { hasToken, applyToken, clearToken } = useAdminAuth()
  const [draftToken, setDraftToken] = useState('')

  const handleMunicipalityChange = (nextMunicipality: string) => {
    const normalized = normalizeMunicipalityId(nextMunicipality)
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        municipality_id: normalized,
      }),
    })
  }

  const handleApplyToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    applyToken(draftToken)
  }

  const handleClearToken = () => {
    setDraftToken('')
    clearToken()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <Link
              to="/"
              search={{ municipality_id }}
              className="brand-title"
            >
              CivicTech Perú — Admin
            </Link>
            <span className="brand-subtitle">
              Consola de Moderación y Gestión de Ingesta
            </span>
          </div>

          <nav className="nav-links" aria-label="Navegación administrativa">
            <Link
              to="/"
              search={{ municipality_id }}
              className={`nav-link ${pathname === '/' ? 'active' : ''}`}
            >
              Cola de Moderación
            </Link>
            <Link
              to="/ingest"
              search={{ municipality_id }}
              className={`nav-link ${pathname === '/ingest' ? 'active' : ''}`}
            >
              Ingesta Admin
            </Link>
          </nav>

          <div className="topbar-controls">
            <div className="muni-selector">
              <label htmlFor="admin-municipality-select">Municipalidad:</label>
              <select
                id="admin-municipality-select"
                value={municipality_id}
                onChange={(e) => handleMunicipalityChange(e.target.value)}
              >
                {MUNICIPALITIES.map((muni) => (
                  <option key={muni.id} value={muni.id}>
                    {muni.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="token-bar">
          <div className="token-bar-inner">
            <form className="token-form" onSubmit={handleApplyToken}>
              <label htmlFor="bearer-token-input">Bearer Token:</label>
              <input
                id="bearer-token-input"
                className="token-input"
                type="password"
                autoComplete="off"
                placeholder="Ingresa token de moderador/admin o JWT OIDC"
                value={draftToken}
                onChange={(e) => setDraftToken(e.target.value)}
              />
              <button type="submit" className="btn btn-sm btn-ghost-light">
                Aplicar
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost-light"
                onClick={handleClearToken}
              >
                Limpiar
              </button>
            </form>

            <span
              className={`token-status ${hasToken ? 'active' : 'inactive'}`}
              role="status"
            >
              {hasToken ? 'Token aplicado (en memoria)' : 'Sin token aplicado'}
            </span>
          </div>
        </div>
      </header>

      <main className="main-content">
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>
            Todas las transiciones de moderación requieren motivo de auditoría.
          </span>
          <span>Las credenciales no se almacenan en localStorage ni en código.</span>
        </div>
      </footer>
    </div>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
