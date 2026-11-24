import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
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

function ShieldIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function DashboardIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
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

function ExpensesIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 14v-3" />
      <path d="M12 14V8" />
      <path d="M17 14v-5" />
    </svg>
  )
}

function ReportsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  )
}

function NewReportIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M12 18v-6" />
      <path d="M9 15h6" />
    </svg>
  )
}

function PlusIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function ChevronDownIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function RootComponent() {
  const { municipality_id } = Route.useSearch()
  const navigate = useNavigate()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  const [searchQuery, setSearchQuery] = useState('')
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const desktopSearchRef = useRef<HTMLInputElement>(null)
  const mobileSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (desktopSearchRef.current && desktopSearchRef.current.offsetParent !== null) {
          desktopSearchRef.current.focus()
        } else {
          setMobileSearchOpen(true)
          window.setTimeout(() => {
            mobileSearchRef.current?.focus()
          }, 0)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = searchQuery.trim()
    setMobileSearchOpen(false)
    void navigate({
      to: '/expenses',
      search: {
        municipality_id,
        entity: trimmed.length > 0 ? trimmed : undefined,
      },
    })
  }

  const handleToggleMobileSearch = () => {
    setMobileSearchOpen((prev) => {
      const next = !prev
      if (next) {
        window.setTimeout(() => {
          mobileSearchRef.current?.focus()
        }, 0)
      }
      return next
    })
  }

  return (
    <RootDocument>
      <div className="obsidian-shell">
        <aside className="sidebar" aria-label="Barra lateral de navegación">
          <Link
            to="/"
            search={{ municipality_id }}
            className="sidebar-brand"
          >
            <span className="brand-shield">
              <ShieldIcon size={18} />
            </span>
            <span className="brand-meta">
              <span className="brand-title">CIVICTECH</span>
              <span className="brand-subtitle">Transparency Engine</span>
            </span>
          </Link>

          <p className="sidebar-section-label">MAIN MENU</p>
          <nav className="sidebar-nav" aria-label="Navegación principal">
            <Link
              to="/"
              search={{ municipality_id }}
              className={`sidebar-link ${pathname === '/' ? 'active' : ''}`}
            >
              <DashboardIcon />
              <span>Dashboard</span>
            </Link>
            <Link
              to="/expenses"
              search={{ municipality_id }}
              className={`sidebar-link ${pathname === '/expenses' ? 'active' : ''}`}
            >
              <ExpensesIcon />
              <span>Gastos Públicos</span>
            </Link>
            <Link
              to="/reports"
              search={{ municipality_id }}
              className={`sidebar-link ${pathname.startsWith('/reports') ? 'active' : ''}`}
            >
              <ReportsIcon />
              <span>Reportes Públicos</span>
            </Link>
            <Link
              to="/report"
              search={{ municipality_id }}
              className={`sidebar-link ${pathname === '/report' ? 'active' : ''}`}
            >
              <NewReportIcon />
              <span>Nuevo Reporte</span>
            </Link>
          </nav>

          <div className="sidebar-muni-box">
            <label
              htmlFor="municipality-select"
              className="sidebar-section-label"
              style={{ display: 'block', marginBottom: '0.55rem' }}
            >
              MUNICIPALIDAD
            </label>
            <div className="muni-pill-wrap">
              <select
                id="municipality-select"
                className="muni-select"
                value={municipality_id}
                onChange={(e) => handleMunicipalityChange(e.target.value)}
              >
                {MUNICIPALITIES.map((muni) => (
                  <option key={muni.id} value={muni.id}>
                    {muni.label}
                  </option>
                ))}
              </select>
              <span className="muni-chevron">
                <ChevronDownIcon />
              </span>
            </div>
          </div>

          <div className="sidebar-status-card" aria-label="Estado del motor de transparencia">
            <div className="sidebar-status-head">
              <span className="sidebar-status-title">Engine Status</span>
              <span className="status-dot" aria-hidden="true" />
            </div>
            <div className="progress-track" aria-hidden="true">
              <div className="progress-fill" />
            </div>
            <div className="sidebar-status-sub">Rust + Go · LIVE SYNC</div>
          </div>
        </aside>

        <div className="workspace-column">
          <header className="topbar">
            <Link
              to="/"
              search={{ municipality_id }}
              className="mobile-brand-group"
            >
              <span className="brand-shield" style={{ width: 30, height: 30 }}>
                <ShieldIcon size={16} />
              </span>
              <span className="brand-meta">
                <span className="brand-title" style={{ fontSize: '0.88rem' }}>
                  CIVICTECH
                </span>
              </span>
            </Link>

            <form
              className="topbar-search"
              onSubmit={handleSearchSubmit}
              role="search"
            >
              <span className="topbar-search-icon">
                <SearchIcon size={15} />
              </span>
              <input
                ref={desktopSearchRef}
                type="search"
                className="topbar-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar gastos o reportes..."
                aria-label="Buscar gastos o reportes"
              />
              <span className="topbar-kbd" aria-hidden="true">
                ⌘K
              </span>
            </form>

            <div className="topbar-actions">
              <div className="mobile-muni-compact">
                <div className="muni-pill-wrap">
                  <select
                    id="municipality-select-mobile"
                    aria-label="Seleccionar municipalidad"
                    className="muni-select"
                    value={municipality_id}
                    onChange={(e) => handleMunicipalityChange(e.target.value)}
                  >
                    {MUNICIPALITIES.map((muni) => (
                      <option key={muni.id} value={muni.id}>
                        {muni.label}
                      </option>
                    ))}
                  </select>
                  <span className="muni-chevron">
                    <ChevronDownIcon size={12} />
                  </span>
                </div>
              </div>

              <button
                type="button"
                className="mobile-search-toggle"
                onClick={handleToggleMobileSearch}
                aria-label="Buscar gastos"
                aria-expanded={mobileSearchOpen}
              >
                <SearchIcon size={16} />
              </button>

              <span className="live-sync-pill topbar-desktop-only">
                <span className="status-dot" aria-hidden="true" />
                LIVE SYNC
              </span>

              <Link
                to="/report"
                search={{ municipality_id }}
                className="btn btn-primary topbar-desktop-only"
              >
                <PlusIcon size={15} />
                Nuevo Reporte
              </Link>
            </div>
          </header>

          {mobileSearchOpen ? (
            <div className="mobile-search-drawer">
              <form
                className="topbar-search"
                onSubmit={handleSearchSubmit}
                role="search"
              >
                <span className="topbar-search-icon">
                  <SearchIcon size={15} />
                </span>
                <input
                  ref={mobileSearchRef}
                  type="search"
                  className="topbar-search-input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar gastos por entidad..."
                  aria-label="Buscar gastos por entidad"
                />
              </form>
            </div>
          ) : null}

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

        <nav className="mobile-bottom-nav" aria-label="Navegación móvil">
          <Link
            to="/"
            search={{ municipality_id }}
            className={`mobile-nav-item ${pathname === '/' ? 'active' : ''}`}
          >
            <DashboardIcon size={18} />
            <span>Inicio</span>
          </Link>

          <Link
            to="/expenses"
            search={{ municipality_id }}
            className={`mobile-nav-item ${pathname === '/expenses' ? 'active' : ''}`}
          >
            <ExpensesIcon size={18} />
            <span>Gastos</span>
          </Link>

          <div className="mobile-fab-slot">
            <Link
              to="/report"
              search={{ municipality_id }}
              className="mobile-fab"
              aria-label="Nuevo Reporte"
            >
              <PlusIcon size={24} />
            </Link>
          </div>

          <Link
            to="/reports"
            search={{ municipality_id }}
            className={`mobile-nav-item ${pathname.startsWith('/reports') ? 'active' : ''}`}
          >
            <ReportsIcon size={18} />
            <span>Reportes</span>
          </Link>

          <button
            type="button"
            className={`mobile-nav-item ${mobileSearchOpen ? 'active' : ''}`}
            onClick={handleToggleMobileSearch}
          >
            <SearchIcon size={18} />
            <span>Buscar</span>
          </button>
        </nav>
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
