create or replace function public.credit_talent_funds_for_completed_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Multiparty PayPal already routes proceeds to the seller at capture.
  -- Do not create a second spendable StarRise balance on completion.
  if new.payment_provider = 'paypal_live' then
    return new;
  end if;
  if new.status = 'completed'
     and new.payment_status = 'paid'
     and new.provider_amount_cents > 0
     and (old.status is distinct from new.status or old.payment_status is distinct from new.payment_status)
  then
    insert into public.talent_funds_ledger (user_id, order_id, amount_cents, status)
    values (new.seller_id, new.id, new.provider_amount_cents, 'available')
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$function$;

