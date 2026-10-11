-- Every synthetic account and nomination rolls back. No public spotlights persist.
begin;
do $$
declare test_id uuid; label text;
begin
  foreach label in array array['member','other','admin','anonymous'] loop
    test_id:=gen_random_uuid();perform set_config('spotlight_test.'||label,test_id::text,true);
    insert into auth.users(id,is_anonymous,raw_user_meta_data) values(test_id,label='anonymous',jsonb_build_object('display_name','Spotlight access test '||label));
    if label='admin' then insert into public.platform_admins(user_id,access_level) values(test_id,'admin'); end if;
  end loop;
end $$;
set local role authenticated;
do $$
declare member uuid:=current_setting('spotlight_test.member')::uuid; other uuid:=current_setting('spotlight_test.other')::uuid; admin_id uuid:=current_setting('spotlight_test.admin')::uuid; nomination uuid; denied boolean; i integer;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',member,'role','authenticated','is_anonymous',false)::text,true);
  insert into public.spotlight_nominations(creator_name,category,work_url,reason) values('Synthetic independent creator','Music','https://example.com/original-work','Original creative work deserves recognition.') returning id into nomination;
  perform set_config('spotlight_test.nomination',nomination::text,true);
  if (select count(*) from public.spotlight_nominations where id=nomination)<>1 then raise exception 'Member cannot see own nomination'; end if;
  denied:=false;begin perform public.review_creator_spotlight(nomination,'publish','A public recognition of this original creator.');exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Ordinary member published a spotlight'; end if;
  denied:=false;begin update public.spotlight_nominations set status='selected' where id=nomination;exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Member directly changed review state'; end if;
  denied:=false;begin insert into public.spotlight_nominations(creator_name,category,work_url,reason,nominator_id) values('Spoofed creator','Music','https://example.com/','Enough characters for a nomination.',other);exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Member spoofed nominator'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',other,'role','authenticated','is_anonymous',false)::text,true);
  if exists(select 1 from public.spotlight_nominations where id=nomination) then raise exception 'Stranger read a private nomination'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',current_setting('spotlight_test.anonymous'),'role','authenticated','is_anonymous',true)::text,true);
  denied:=false;begin insert into public.spotlight_nominations(creator_name,category,work_url,reason) values('Anonymous creator','Music','https://example.com/','Anonymous accounts cannot nominate.');exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Anonymous auth user nominated'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated','is_anonymous',false)::text,true);
  if not exists(select 1 from public.spotlight_nominations where id=nomination) then raise exception 'Admin cannot see queue'; end if;
  perform public.review_creator_spotlight(nomination,'publish','This independent creator deserves recognition for original work.');
  if not exists(select 1 from public.creator_spotlights where id=nomination and status='published') then raise exception 'Admin publication failed'; end if;
  perform public.review_creator_spotlight(nomination,'hide');
  if not exists(select 1 from public.creator_spotlights where id=nomination and status='hidden') then raise exception 'Hide failed'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',other,'role','authenticated','is_anonymous',false)::text,true);
  if exists(select 1 from public.creator_spotlights where id=nomination) then raise exception 'Hidden spotlight visible to member'; end if;
  perform set_config('request.jwt.claims',json_build_object('sub',admin_id,'role','authenticated','is_anonymous',false)::text,true);
  perform public.review_creator_spotlight(nomination,'publish','An updated public recognition of the creator and their work.');
  perform set_config('request.jwt.claims',json_build_object('sub',member,'role','authenticated','is_anonymous',false)::text,true);
  for i in 1..4 loop insert into public.spotlight_nominations(creator_name,category,work_url,reason) values('Rate limit fixture','Music','https://example.com/','These are temporary nominations for access testing.');end loop;
  denied:=false;begin insert into public.spotlight_nominations(creator_name,category,work_url,reason) values('Over limit fixture','Music','https://example.com/','The sixth nomination must be rejected.');exception when check_violation then denied:=true;end;
  if not denied then raise exception 'Daily nomination limit bypassed'; end if;
end $$;
set local role anon;
do $$
declare denied boolean:=false; nomination uuid:=current_setting('spotlight_test.nomination')::uuid;
begin
  perform set_config('request.jwt.claims','{"role":"anon"}',true);
  if not exists(select 1 from public.creator_spotlights where id=nomination) then raise exception 'Public cannot read published recognition'; end if;
  begin perform 1 from public.spotlight_nominations;exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Public accessed nominations'; end if;
  denied:=false;begin perform public.review_creator_spotlight(nomination,'hide');exception when insufficient_privilege then denied:=true;end;
  if not denied then raise exception 'Public executed review RPC'; end if;
  raise notice 'PASS: private nominations, authenticated submission, independent creators, admin review, public published feed, hidden visibility, spoofing and daily limits';
end $$;
reset role;
rollback;
