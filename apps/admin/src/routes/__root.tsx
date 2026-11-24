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

function ShieldMarkIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function QueueNavIcon() {
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
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function IngestNavIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  )
}

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
      <aside className="sidebar" aria-label="Panel lateral administrativo">
        <Link
          to="/"
          search={{ municipality_id }}
          className="sidebar-brand"
        >
          <span className="brand-mark">
            <ShieldMarkIcon />
          </span>
          <span className="brand-copy">
            <span className="brand-title">CIVICTECH</span>
            <span className="brand-subtitle">Moderation Console</span>
          </span>
        </Link>

        <div className="sidebar-section">
          <span className="section-kicker">MODERATION MENU</span>
          <nav className="sidebar-nav" aria-label="Navegación administrativa">
            <Link
              to="/"
              search={{ municipality_id }}
              className={`nav-link ${pathname === '/' ? 'active' : ''}`}
            >
              <span className="nav-link-icon">
                <QueueNavIcon />
              </span>
              <span>Cola de Moderación</span>
            </Link>
            <Link
              to="/ingest"
              search={{ municipality_id }}
              className={`nav-link ${pathname === '/ingest' ? 'active' : ''}`}
            >
              <span className="nav-link-icon">
                <IngestNavIcon />
              </span>
              <span>Ingesta Admin</span>
            </Link>
          </nav>
        </div>

        <div className="sidebar-muni">
          <label htmlFor="admin-municipality-select">Municipalidad</label>
          <div className="muni-select-wrap">
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

        <div className="sidebar-footer-widget" aria-label="Estado de sesión">
          <div className="status-widget-top">
            <span className="status-widget-title">Sesión Bearer</span>
            <span
              className={`status-dot ${hasToken ? 'emerald' : 'amber'}`}
              aria-hidden="true"
            />
          </div>
          <div
            className={`status-widget-state ${hasToken ? 'emerald' : 'amber'}`}
          >
            {hasToken ? 'Autenticado' : 'Sin token'}
          </div>
          <div className="status-widget-bar" aria-hidden="true">
            <div
              className={`status-widget-bar-fill ${hasToken ? 'emerald' : 'amber'}`}
            />
          </div>
          <span className="status-widget-caption">
            {hasToken
              ? 'Credencial en memoria React'
              : 'Ingresa token en barra superior'}
          </span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-inner">
            <form className="token-form" onSubmit={handleApplyToken}>
              <div className="token-input-group">
                <span className="token-input-icon">
                  <KeyIcon />
                </span>
                <label htmlFor="bearer-token-input" className="token-sr-label">
                  Bearer Token
                </label>
                <input
                  id="bearer-token-input"
                  className="token-input"
                  type="password"
                  autoComplete="off"
                  placeholder="Bearer token de moderador o admin (solo en memoria)..."
                  value={draftToken}
                  onChange={(e) => setDraftToken(e.target.value)}
                />
              </div>

              <div className="token-actions">
                <button type="submit" className="btn btn-sm btn-primary">
                  Aplicar
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost-dark"
                  onClick={handleClearToken}
                >
                  Limpiar
                </button>
              </div>
            </form>

            <span
              className={`token-status ${hasToken ? 'active' : 'inactive'}`}
              role="status"
            >
              <span
                className={`status-dot ${hasToken ? 'emerald' : 'amber'}`}
                aria-hidden="true"
              />
              {hasToken ? 'Autenticado' : 'Sin token'}
            </span>
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
            <span>
              Las credenciales no se almacenan en localStorage ni en código.
            </span>
          </div>
        </footer>
      </div>

      <nav
        className="mobile-bottom-nav"
        aria-label="Navegación móvil administrativa"
      >
        <Link
          to="/"
          search={{ municipality_id }}
          className={`mobile-nav-item ${pathname === '/' ? 'active' : ''}`}
        >
          <QueueNavIcon />
          <span>Cola de Moderación</span>
        </Link>
        <Link
          to="/ingest"
          search={{ municipality_id }}
          className={`mobile-nav-item ${pathname === '/ingest' ? 'active' : ''}`}
        >
          <IngestNavIcon />
          <span>Ingesta Admin</span>
        </Link>
      </nav>
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
