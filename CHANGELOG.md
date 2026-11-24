# Changelog

All notable changes to this project are documented in this file.

This changelog is managed by `release-please` based on Conventional Commits.

## [0.2.0](https://github.com/arkelythex/estado/compare/v0.1.0...v0.2.0) (2026-11-24)


### Features

* **admin,ci:** moderation console in Bun/TanStack Start, CI, and contract hardening [4/4] ([11cb767](https://github.com/arkelythex/estado/commit/11cb767c9eea8f80e619ed1fd3ec5dc1ce8a3d1c))
* **admin:** build moderation and ingest console in Bun and TanStack Start ([7e16c44](https://github.com/arkelythex/estado/commit/7e16c44e892ac59897ca24d9607bf3f21603d9eb))
* **ai-first:** JWKS singleflight, OpenAPI/llms.txt/agent.json, UI agent semantics, and MCP server ([25b62fb](https://github.com/arkelythex/estado/commit/25b62fb7e6e98ebd2841b842cc111bcf0ae8e000))
* **api:** add cryptographic audit verify, anonymous receipt tracking, OCDS 1.1, red flags, and rate limiting ([898950d](https://github.com/arkelythex/estado/commit/898950da524f4d0096986f71018ce73c46a8d504))
* **api:** add Go hexagonal backend API with PG, S3, RBAC, and engine client ([3cd0367](https://github.com/arkelythex/estado/commit/3cd03678995c39ed53af7667891a24c3441ee889))
* **api:** add JWKS singleflight/cooldown, OpenAPI 3.1, llms.txt, agent.json, and Idempotency-Key ([ff802a7](https://github.com/arkelythex/estado/commit/ff802a75b102120410b01f814f285c8abe3cb37c))
* **api:** cryptographic audit verify, anonymous receipt tracking, OCDS 1.1, red flags, and rate limit [2/3] ([ad7a4b5](https://github.com/arkelythex/estado/commit/ad7a4b5e42961c7d8d53b4313e297f700f359e66))
* **ci:** add GGA AI review with DeepSeek V4 Flash ([9d4e72c](https://github.com/arkelythex/estado/commit/9d4e72cbb5b7e41b1476f75340f4d7eed836a41f))
* **engine:** add authenticated Rust engine HTTP service and exact-cents ingest ([133528f](https://github.com/arkelythex/estado/commit/133528fb486319b3924ce95a2d46b703e59c3833))
* **engine:** add cryptographic audit hash-chain and exact-integer fiscal red-flag analyzer ([df1af9a](https://github.com/arkelythex/estado/commit/df1af9a6198f047e105409ed411556d60a518350))
* **engine:** cryptographic audit hash-chain and exact-integer fiscal red-flag analyzer [1/3] ([687d89a](https://github.com/arkelythex/estado/commit/687d89afda84bba98383dccad2576cd2efa37435))
* **engine:** polyglot architecture, compliance migration, and Rust critical engine [1/4] ([3556ef5](https://github.com/arkelythex/estado/commit/3556ef57f78704e6092fe6527bf46affa3e9a06a))
* **mcp,web:** add world-class audit verify, red flags, OCDS 1.1, and anonymous receipt tracking ([1428933](https://github.com/arkelythex/estado/commit/14289333c7334d1d7da5b22ecddb24417b43cd45))
* **mcp,web:** audit chain badge, fiscal red flags, OCDS 1.1 export, and anonymous receipt tracker [3/3] ([a421a65](https://github.com/arkelythex/estado/commit/a421a65da5a6b858f15f7d8c489d4a9cae8ce149))
* **mcp:** add Bun TypeScript MCP server exposing 9 typed CivicTech tools ([47bfdbf](https://github.com/arkelythex/estado/commit/47bfdbfb30edaf5e2533e1607227310bc895f805))
* **mcp:** add Bun TypeScript MCP server exposing 9 typed CivicTech tools ([83a5c14](https://github.com/arkelythex/estado/commit/83a5c14c89de005dc9ce184e1f271af1a7d55d74))
* polyglot AI-First CivicTech platform (Rust engine + Go API + Bun/TanStack Start + MCP) ([bd120d4](https://github.com/arkelythex/estado/commit/bd120d447055c5efc9254bad78ecae54dd5d49df))
* **repo:** bootstrap civictech peru foundation ([6b142b8](https://github.com/arkelythex/estado/commit/6b142b8ed06048fed27a143d22fa892cc939b9a7))
* **ui:** add AI-agent data-testid/data-state semantics, Spanish labels, and web llms.txt ([18e9364](https://github.com/arkelythex/estado/commit/18e9364a7fd81dbbdb920b0dca93e3d9f3588f65))
* **ui:** apply CivicTech Dark Obsidian design system to web and admin ([89ca7e0](https://github.com/arkelythex/estado/commit/89ca7e085c4c3a36d28c0a0e527f863734a74723))
* **ui:** CivicTech Dark Obsidian design system for web and admin ([d5f86ed](https://github.com/arkelythex/estado/commit/d5f86edea6068bb6757f80ec12d25cb571865a1a))
* **web:** build citizen transparency app in Bun and TanStack Start ([455ca02](https://github.com/arkelythex/estado/commit/455ca02e885ea14e11a9541e52a9023c079a4825))
* **web:** citizen transparency app in Bun and TanStack Start [3/4] ([92fb769](https://github.com/arkelythex/estado/commit/92fb769f7fdb81fde336a5cdcb6020b569244704))


### Bug Fixes

* **api,web:** harden public detail privacy, DRAFT evidence guard, SSE upload headers, and JSON validation ([23441e6](https://github.com/arkelythex/estado/commit/23441e6400b3b4db47d51072c8bd48cc79c5619f))
* **api:** enforce DRAFT-only evidence upload and bound unmatched metrics route label ([0da95f2](https://github.com/arkelythex/estado/commit/0da95f276aafc2af240eb58139683a65d640912f))
* **ci:** emit ::add-mask:: for RUSTFS_SSE_S3_MASTER_KEY on stdout ([15d728f](https://github.com/arkelythex/estado/commit/15d728fb440efcc310aa8c74b101b7d741909739))
* **ci:** emit ::add-mask:: for RUSTFS_SSE_S3_MASTER_KEY on stdout ([6fe25e4](https://github.com/arkelythex/estado/commit/6fe25e41ec3e92df39fd573a6124f51bf1380e75))
* **security,resilience:** harden OIDC JWKS, mandatory evidence size, race-safe ingest, and UI guards ([f0ead7c](https://github.com/arkelythex/estado/commit/f0ead7c18fbf3718e185db22a42d02420897d4ba))
* **security,resilience:** harden OIDC JWKS, mandatory evidence size, race-safe ingest, and UI guards ([0950324](https://github.com/arkelythex/estado/commit/0950324e299db4d611cbcb4659034a091aa17af8))


### Documentation

* add archify architecture diagram for the hexagonal core ([#26](https://github.com/arkelythex/estado/issues/26)) ([02a5649](https://github.com/arkelythex/estado/commit/02a5649164e79f4bf24bf32c58c26d530a7ac6df))
* add interface screenshots to README ([#24](https://github.com/arkelythex/estado/issues/24)) ([606c5f1](https://github.com/arkelythex/estado/commit/606c5f1d20cc0561d1f03caea39ff6cbf3d93bd7))
* **readme:** add updated Dark Obsidian screenshots and full E2E walkthrough video ([ef9d1ba](https://github.com/arkelythex/estado/commit/ef9d1ba5f0ba399bba8a5c08873a25cb9fdfdf0c))
* **readme:** native 1440x810 HD demo video, crisp 1884x957 screenshots, and official reference docs ([b02e768](https://github.com/arkelythex/estado/commit/b02e768f1e99bb8cd4b25c892255de69d10132a0))
* **readme:** updated Dark Obsidian screenshots and full E2E walkthrough video ([8d6a987](https://github.com/arkelythex/estado/commit/8d6a987f2f4bc35d557e9d7bed2847098b781c73))
* **readme:** upgrade demo video to native 1440x810 HD, crisp screenshots, and full technical docs ([7ff3a46](https://github.com/arkelythex/estado/commit/7ff3a46ef9161fb876994a05a4a14e1909eed83b))


### CI

* let pnpm/action-setup read packageManager ([9b9af76](https://github.com/arkelythex/estado/commit/9b9af766de45f245c660d4a1b0e5ba820b5ab611))
* **smoke:** align integration workflows and smoke scripts to Go API, Rust engine, and Bun ([c2973b3](https://github.com/arkelythex/estado/commit/c2973b320f980e5dfcb1b79c1c39c14120d6eee4))
* **smoke:** align integration workflows and smoke scripts to Go API, Rust engine, and Bun ([dceecb6](https://github.com/arkelythex/estado/commit/dceecb660240ab83497dd586d4a967656a2be61a))

## [0.1.0] - 2026-02-27
### Bootstrap
- Established OSS governance, architecture docs, security baseline, and dual-MVP scaffolding.
- Added runnable monorepo structure (Rust API + Next apps + infra + OpenAPI).
- Added quality and supply-chain automation baselines.
