import { createContext, useContext, useState, type ReactNode } from 'react'

export interface AdminAuthState {
  token: string
  hasToken: boolean
  applyToken: (nextToken: string) => void
  clearToken: () => void
}

const AdminAuthContext = createContext<AdminAuthState | null>(null)

export function AdminAuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  // Stored exclusively in React memory state so credentials are never written to localStorage.
  const [token, setToken] = useState('')

  const applyToken = (nextToken: string) => {
    setToken(nextToken.trim())
  }

  const clearToken = () => {
    setToken('')
  }

  return (
    <AdminAuthContext.Provider
      value={{
        token,
        hasToken: token.length > 0,
        applyToken,
        clearToken,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext)
  if (!ctx) {
    throw new Error('useAdminAuth debe usarse dentro de AdminAuthProvider')
  }
  return ctx
}
