# Admin Moderation App (`apps/admin`)

Consola de moderación y administración de **CivicTech Perú** construida con **Bun + TanStack Start** (TypeScript estricto, puerto `3001`) conectada a la API Go (`VITE_API_URL`, por defecto `http://localhost:8080`).

## Seguridad de credenciales

- No hay tokens ni secretos hardcodeados en el código fuente.
- El operador ingresa su Bearer token (token dev de moderador/administrador o JWT OIDC) en el campo enmascarado de la barra superior.
- El token se conserva únicamente en memoria (estado de React) y puede limpiarse en cualquier momento con el botón **Limpiar**.

## Rutas

- `/` — Cola de moderación (`GET /moderation/cases`) con filtro por estado (`ALL`, `SUBMITTED`, `TRIAGED`, `VERIFIED`, `REJECTED`, `PUBLISHED`), panel de decisión con motivo auditable obligatorio (`Triage`, `Verify`, `Reject`, `Publish` con `public_text`).
- `/ingest` — Consola de ingesta demo (`POST /admin/ingest/demo`) que muestra `checksum_sha256`, `dataset_version_id`, `rows_ingested` y el indicador de idempotencia (`deduplicated`).

## Comandos

```bash
bun install
bun run dev
bunx tsc --noEmit
bun test
bun run build
```
