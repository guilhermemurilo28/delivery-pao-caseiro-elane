-- ============================================================
-- PÃO CASEIRO DA ELANE — MIGRAÇÃO v2.1 -> v2.2 (jul/2026)
-- Já aplicada no projeto Supabase. Idempotente.
-- ============================================================

-- grupos de opções nos produtos (proteína, molho etc.)
alter table produtos add column if not exists opcoes jsonb;

-- identidade visual / dados da loja no banco
alter table config add column if not exists nome text;
alter table config add column if not exists tagline text;
alter table config add column if not exists cidade text;
alter table config add column if not exists emoji text;
alter table config add column if not exists whatsapp text;
alter table config add column if not exists pix text;
alter table config add column if not exists cor1 text;
alter table config add column if not exists cor2 text;
alter table config add column if not exists cor3 text;
alter table config add column if not exists cor4 text;
alter table config add column if not exists cor5 text;

-- SEGURANÇA: remove senha em texto puro (login usa senha_hash/PBKDF2)
alter table config drop column if exists senha_painel;

-- índices (rate limit e listagens)
create index if not exists idx_pedidos_tel_data on pedidos (telefone, created_at);
create index if not exists idx_pedidos_created on pedidos (created_at desc);
create index if not exists idx_login_ip_quando on login_tentativas (ip, quando);

-- bucket público de fotos do cardápio (escrita só via edge function)
insert into storage.buckets (id, name, public)
values ('fotos','fotos', true)
on conflict (id) do update set public = true;

-- view pública com dados da loja
drop view if exists config_publica;
create view config_publica as
  select loja_aberta, cashback_pct, pixel_meta, ga4, nome, tagline, cidade,
         emoji, whatsapp, pix, cor1, cor2, cor3, cor4, cor5
  from config where id = 1;
grant select on config_publica to anon;
