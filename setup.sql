-- ============================================================
-- PÃO CASEIRO DA ELANE — MIGRAÇÃO v1 -> v2
-- Rodar no SQL Editor do projeto Supabase existente.
-- Preserva pedidos antigos. Idempotente (pode rodar 2x).
-- ============================================================

-- 1) CARDÁPIO NO BANCO ---------------------------------------
create table if not exists categorias (
  id serial primary key, nome text not null unique, emoji text, sub text,
  ordem int default 0, ativa boolean default true, hora_ini time, hora_fim time
);
create table if not exists produtos (
  id serial primary key, categoria_id int references categorias(id) on delete cascade,
  nome text not null, descricao text, preco numeric(10,2),
  tamanhos jsonb, adicionais jsonb, img text, selos text[],
  destaque boolean default false, ativo boolean default true,
  esgotado boolean default false, estoque int, custo numeric(10,2), ordem int default 0
);
create table if not exists bairros (
  id serial primary key, nome text not null unique, taxa numeric(10,2) not null, ativo boolean default true
);

-- 2) PEDIDOS: colunas novas ----------------------------------
alter table pedidos add column if not exists subtotal numeric(10,2);
alter table pedidos add column if not exists desconto numeric(10,2) default 0;
alter table pedidos add column if not exists cupom text;
alter table pedidos add column if not exists status text default 'recebido';
alter table pedidos add column if not exists agendado_para text;
update pedidos set status='recebido' where status is null;

-- 3) CONFIG: colunas novas -----------------------------------
alter table config add column if not exists senha_hash text;
alter table config add column if not exists cashback_pct numeric(5,2) default 0;
alter table config add column if not exists cashback_dias int[] default '{}';
alter table config add column if not exists pixel_meta text;
alter table config add column if not exists ga4 text;

-- 4) MARKETING / SEGURANÇA -----------------------------------
create table if not exists cupons (
  codigo text primary key, tipo text check (tipo in ('valor','pct')),
  valor numeric(10,2) not null, minimo numeric(10,2) default 0,
  validade date, limite_uso int, usados int default 0, ativo boolean default true
);
create table if not exists clientes (
  telefone text primary key, nome text, creditos numeric(10,2) default 0,
  pedidos int default 0, total_gasto numeric(12,2) default 0, ultimo_pedido timestamptz
);
create table if not exists login_tentativas ( ip text, quando timestamptz default now() );
create table if not exists sessoes ( token_hash text primary key, expira timestamptz not null );

-- 5) GESTÃO (caixa / despesas) -------------------------------
create table if not exists caixa (
  id serial primary key, aberto_em timestamptz default now(), fechado_em timestamptz,
  valor_inicial numeric(10,2) default 0, valor_conferido numeric(10,2)
);
create table if not exists caixa_movimentos (
  id serial primary key, caixa_id int references caixa(id) on delete cascade,
  quando timestamptz default now(), tipo text check (tipo in ('entrada','saida','retirada')),
  valor numeric(10,2) not null, descricao text
);
create table if not exists despesas (
  id serial primary key, data date default current_date, categoria text,
  descricao text, valor numeric(10,2) not null, recorrente boolean default false
);

-- 6) RLS: remove policies antigas e aplica o modelo v2 -------
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
    where schemaname='public' and tablename in
    ('pedidos','config','categorias','produtos','bairros','cupons','clientes',
     'login_tentativas','sessoes','caixa','caixa_movimentos','despesas')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

alter table pedidos enable row level security;
alter table config enable row level security;
alter table categorias enable row level security;
alter table produtos enable row level security;
alter table bairros enable row level security;
alter table cupons enable row level security;
alter table clientes enable row level security;
alter table login_tentativas enable row level security;
alter table sessoes enable row level security;
alter table caixa enable row level security;
alter table caixa_movimentos enable row level security;
alter table despesas enable row level security;

-- anon: SÓ leitura do cardápio e da view pública de config
create policy cat_pub  on categorias for select using (ativa);
create policy prod_pub on produtos  for select using (ativo);
create policy bai_pub  on bairros   for select using (ativo);
-- (pedidos, cupons, clientes etc.: NENHUMA policy -> só Edge Functions/service role)

drop view if exists config_publica;
create view config_publica as
  select loja_aberta, cashback_pct, pixel_meta, ga4 from config where id=1;
grant select on config_publica to anon;

-- 7) CARDÁPIO DA ELANE ---------------------------------------
insert into categorias (nome, emoji, sub, ordem) values
 ('Marmitas','🍱','Feijão, arroz, farofa, salada, macarrão e a proteína à sua escolha — 500ml ou 750ml',1),
 ('Lasanhas','🍝',null,2), ('Empadão','🥧',null,3), ('Pratos Especiais','⭐',null,4),
 ('Cremes','🍲',null,5), ('Yakisoba','🍜',null,6), ('Espaguetes','🍝',null,7),
 ('Pastéis','🥟',null,8), ('Sanduíches','🍔','No pão caseiro da casa',9),
 ('Pães por Encomenda','🍞','Fale no WhatsApp para encomendas!',10)
on conflict (nome) do nothing;

with c as (select id, nome from categorias)
insert into produtos (categoria_id, nome, descricao, preco, tamanhos, ordem)
select c.id, p.nome, p.descricao, p.preco, p.tamanhos::jsonb, p.ordem
from (values
 ('Marmitas','Proteína','Marmita completa com proteína à escolha',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',1),
 ('Marmitas','Frango Molho Limão','Frango suculento ao molho de limão siciliano com ervas',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',2),
 ('Marmitas','Frango Xadrez','Frango ao estilo xadrez com legumes e molho agridoce',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',3),
 ('Marmitas','Strogonoff de Frango','Cremoso strogonoff de frango com batata palha',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',4),
 ('Marmitas','Frango Curry','Frango ao curry com leite de coco e especiarias',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',5),
 ('Marmitas','Filé de Peixe no Alecrim','Filé de peixe grelhado com alecrim e azeite',null,'[{"nome":"500ml","preco":15},{"nome":"750ml","preco":18}]',6),
 ('Lasanhas','Lasanha de Carne','Lasanha tradicional à bolonhesa com queijo gratinado',null,'[{"nome":"500ml","preco":20},{"nome":"750ml","preco":24}]',1),
 ('Lasanhas','Lasanha de Frango','Lasanha cremosa de frango com catupiry e queijo',null,'[{"nome":"500ml","preco":20},{"nome":"750ml","preco":24}]',2),
 ('Empadão','Empadão de Frango','Empadão caseiro recheado de frango desfiado com catupiry',40,null,1),
 ('Empadão','Empadão de Camarão','Empadão especial recheado de camarão ao molho de tomate',50,null,2),
 ('Pratos Especiais','Filé à Parmegiana','Filé empanado com molho de tomate e queijo gratinado',28,null,1),
 ('Pratos Especiais','Filé de Peixe ao Molho de Coco','Filé de peixe cremoso com molho de coco e gengibre',30,null,2),
 ('Cremes','Creme de Camarão','Creme espesso de camarão com requeijão e temperos frescos',22,null,1),
 ('Cremes','Creme de Galinha','Creme encorpado de galinha caipira com legumes',18,null,2),
 ('Yakisoba','Yakisoba de Frango','Macarrão oriental com frango, legumes e molho shoyu',null,'[{"nome":"500ml","preco":20},{"nome":"750ml","preco":25}]',1),
 ('Yakisoba','Yakisoba de Camarão','Macarrão oriental com camarão e legumes frescos',null,'[{"nome":"500ml","preco":24},{"nome":"750ml","preco":29}]',2),
 ('Yakisoba','Yakisoba de Carne','Macarrão oriental com carne macia e legumes ao shoyu',null,'[{"nome":"500ml","preco":22},{"nome":"750ml","preco":27}]',3),
 ('Yakisoba','Yakisoba Misto','Combinação de frango, carne e camarão com legumes',null,'[{"nome":"500ml","preco":26},{"nome":"750ml","preco":32}]',4),
 ('Espaguetes','Espaguete à Bolonhesa','Molho bolonhesa tradicional com carne moída e ervas',null,'[{"nome":"500ml","preco":18},{"nome":"750ml","preco":22}]',1),
 ('Espaguetes','Espaguete de Camarão','Espaguete ao alho e óleo com camarão grelhado',null,'[{"nome":"500ml","preco":25},{"nome":"750ml","preco":30}]',2),
 ('Espaguetes','Espaguete de Frango ao Molho Branco','Espaguete ao molho branco com frango desfiado',null,'[{"nome":"500ml","preco":20},{"nome":"750ml","preco":24}]',3),
 ('Espaguetes','Espaguete Cheddar com Bacon','Espaguete cremoso de cheddar com bacon crocante',null,'[{"nome":"500ml","preco":22},{"nome":"750ml","preco":26}]',4),
 ('Espaguetes','Espaguete de Brócolis ao Molho Branco','Espaguete vegetariano com brócolis e molho bechamel',null,'[{"nome":"500ml","preco":18},{"nome":"750ml","preco":22}]',5),
 ('Espaguetes','Espaguete Carbonara','Carbonara clássica com ovos, queijo, pancetta e pimenta',null,'[{"nome":"500ml","preco":22},{"nome":"750ml","preco":26}]',6),
 ('Espaguetes','Rigatoni de Camarão','Rigatoni ao molho cremoso de camarão com tomate seco',null,'[{"nome":"500ml","preco":26},{"nome":"750ml","preco":31}]',7),
 ('Espaguetes','Rigatoni de Filé','Rigatoni com filé de carne ao molho de vinho tinto',null,'[{"nome":"500ml","preco":26},{"nome":"750ml","preco":31}]',8),
 ('Pastéis','Pastel Carne Azeitona Milho Catupiry','Pastel crocante de carne moída, azeitona, milho e catupiry',8,null,1),
 ('Pastéis','Pastel Frango Catupiry e Queijo','Pastel crocante de frango desfiado com catupiry e queijo',8,null,2),
 ('Pastéis','Pastel Camarão Catupiry e Queijo','Pastel especial de camarão com catupiry e queijo derretido',10,null,3),
 ('Pastéis','Pastel Bacon Cheddar e Frango','Pastel duplo de bacon crocante, cheddar e frango',10,null,4),
 ('Sanduíches','Hambúrguer','Hambúrguer artesanal 150g, queijo, alface e tomate no pão caseiro',12,null,1),
 ('Sanduíches','X-Bacon','Hambúrguer com queijo, bacon crocante e maionese da casa',14,null,2),
 ('Sanduíches','X-Calabresa','Hambúrguer com calabresa grelhada, queijo e cebola caramelizada',13,null,3),
 ('Sanduíches','X-Frango','Frango grelhado, queijo, alface, tomate e molho especial',12,null,4),
 ('Sanduíches','X-Pão Caseiro da Elane','Especial da casa: pão caseiro artesanal com recheio surpresa do dia',16,null,5)
) as p(cat,nome,descricao,preco,tamanhos,ordem)
join c on c.nome = p.cat
where not exists (select 1 from produtos px where px.nome = p.nome);

insert into bairros (nome, taxa) values ('Canoa Quebrada', 4.00) on conflict (nome) do nothing;
