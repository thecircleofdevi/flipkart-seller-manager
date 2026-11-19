drop policy if exists "sync_checkpoints_insert" on public.sync_checkpoints;
drop policy if exists "sync_checkpoints_select" on public.sync_checkpoints;
drop policy if exists "sync_checkpoints_update" on public.sync_checkpoints;

create policy "sync_checkpoints_owner" on public.sync_checkpoints
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create index if not exists idx_sync_checkpoints_user_updated
  on public.sync_checkpoints (user_id, updated_at desc);
