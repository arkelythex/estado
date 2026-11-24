# Citizen Web App (`apps/web`)

Portal ciudadano de **CivicTech Perú** construido con **Bun + TanStack Start** (TypeScript estricto, puerto `3000`) conectado a la API Go (`VITE_API_URL`, por defecto `http://localhost:8080`).

## Rutas

- `/` — Resumen de datasets activos por municipalidad y accesos rápidos.
- `/expenses` — Explorador de gastos con filtros (`entity`, `category`, `from`, `to`, `municipality_id`) y totales exactos en céntimos (`amount_cents`).
- `/report` — Formulario ciudadano en 3 pasos: crear borrador (`POST /reports`), subir evidencia opcional con SHA-256 calculado en el navegador (`POST /reports/{id}/evidence` + `PUT` a URL prefirmada) y enviar (`POST /reports/{id}/submit`).
- `/reports` — Feed público de reportes verificados (`GET /public/reports`).
- `/reports/$id` — Detalle de reporte público con evidencia inmutable (`GET /public/reports/{id}`).

## Comandos

```bash
bun install
bun run dev
bunx tsc --noEmit
bun test
bun run build
```
