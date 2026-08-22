alter table public.paypal_sandbox_orders
  drop constraint if exists paypal_sandbox_orders_status_check;

alter table public.paypal_sandbox_orders
  add constraint paypal_sandbox_orders_status_check
  check (
    status = any (
      array[
        'CREATED'::text,
        'APPROVED'::text,
        'PENDING'::text,
        'COMPLETED'::text,
        'CANCELLED'::text,
        'FAILED'::text
      ]
    )
  );

comment on column public.paypal_sandbox_orders.status is
  'Local PayPal sandbox lifecycle: CREATED, APPROVED, PENDING, COMPLETED, CANCELLED, or FAILED.';
