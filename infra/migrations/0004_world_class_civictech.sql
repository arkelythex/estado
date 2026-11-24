-- 0004: Cryptographic audit chain & anonymous whistleblower receipt hashes

alter table audit_events
  add column if not exists seq_no bigserial,
  add column if not exists prev_hash text not null default '',
  add column if not exists event_hash text not null default '';

create index if not exists idx_audit_events_seq_no
  on audit_events(seq_no asc);

alter table reports
  add column if not exists receipt_hash text;

create unique index if not exists uq_reports_receipt_hash
  on reports(receipt_hash) where receipt_hash is not null;
