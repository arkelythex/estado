import type { ReactNode } from 'react'
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
      { title: 'CivicTech Perú — Transparencia y Reportes Ciudadanos' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { municipality_id } = Route.useSearch()
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

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

  return (
    <RootDocument>
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="brand">
              <Link
                to="/"
                search={{ municipality_id }}
                className="brand-title"
              >
                CivicTech Perú
              </Link>
              <span className="brand-subtitle">
                Portal Ciudadano de Transparencia Municipal
              </span>
            </div>

            <nav className="nav-links" aria-label="Navegación principal">
              <Link
                to="/"
                search={{ municipality_id }}
                className={`nav-link ${pathname === '/' ? 'active' : ''}`}
              >
                Transparencia
              </Link>
              <Link
                to="/expenses"
                search={{ municipality_id }}
                className={`nav-link ${pathname === '/expenses' ? 'active' : ''}`}
              >
                Gastos
              </Link>
              <Link
                to="/reports"
                search={{ municipality_id }}
                className={`nav-link ${pathname.startsWith('/reports') ? 'active' : ''}`}
              >
                Reportes Públicos
              </Link>
              <Link
                to="/report"
                search={{ municipality_id }}
                className={`nav-link ${pathname === '/report' ? 'active' : ''}`}
              >
                Nuevo Reporte
              </Link>
            </nav>

            <div className="muni-selector">
              <label htmlFor="municipality-select">Municipalidad:</label>
              <select
                id="municipality-select"
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
        </header>

        <main className="main-content">
          <Outlet />
        </main>

        <footer className="footer">
          <div className="footer-inner">
            <span>
              Datos públicos verificables y reportes con trazabilidad de auditoría.
            </span>
            <span>Montos expresados en Soles (PEN) con aritmética exacta.</span>
          </div>
        </footer>
      </div>
    </RootDocument>
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
