-- 0003: Multi-tenant municipality scoping, auditable moderation reasons, exact cents & idempotent ingest

alter table dataset_sources
  add column if not exists municipality_id text not null default 'lima';

alter table expense_records
  add column if not exists municipality_id text not null default 'lima',
  add column if not exists amount_cents bigint not null default 0;

update expense_records
  set amount_cents = round(amount * 100)::bigint
  where amount_cents = 0 and amount <> 0;

alter table reports
  add column if not exists municipality_id text not null default 'lima';

alter table report_status_events
  add column if not exists actor_id text,
  add column if not exists reason text not null default '';

alter table publications
  add column if not exists municipality_id text not null default 'lima';

create unique index if not exists uq_dataset_versions_source_checksum
  on dataset_versions(source_id, checksum_sha256);

create index if not exists idx_expense_records_municipality
  on expense_records(municipality_id, occurred_on desc);

create index if not exists idx_reports_municipality_status
  on reports(municipality_id, status, created_at desc);

create index if not exists idx_publications_municipality
  on publications(municipality_id, published_at desc);
