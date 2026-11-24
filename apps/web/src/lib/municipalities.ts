export interface MunicipalityOption {
  id: string
  label: string
}

export const MUNICIPALITIES: readonly MunicipalityOption[] = [
  { id: 'lima', label: 'Lima' },
  { id: 'arequipa', label: 'Arequipa' },
  { id: 'cusco', label: 'Cusco' },
  { id: 'trujillo', label: 'Trujillo' },
] as const

export const DEFAULT_MUNICIPALITY_ID = 'lima'

export function normalizeMunicipalityId(raw: unknown): string {
  if (typeof raw !== 'string') {
    return DEFAULT_MUNICIPALITY_ID
  }
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : DEFAULT_MUNICIPALITY_ID
}

export function getMunicipalityLabel(id: string): string {
  const normalized = normalizeMunicipalityId(id)
  const found = MUNICIPALITIES.find((m) => m.id === normalized)
  return found ? found.label : normalized
}
