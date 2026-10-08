create table if not exists docs (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  primary key (collection, id)
);
alter table docs enable row level security;
create policy "public read/write" on docs for all using (true) with check (true);
