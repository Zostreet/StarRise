drop policy if exists "Sellers can update non-completed service status"
on public.service_orders;

create policy "Sellers can update non-completed service status"
on public.service_orders
for update
to authenticated
using (
  seller_id = (select auth.uid())
  and status <> 'completed'
)
with check (
  seller_id = (select auth.uid())
  and status <> 'completed'
);