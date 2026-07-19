// Edge Function: pedido — validação de pedidos no SERVIDOR (v2.1: grupos de opções)
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type ItemReq = { id: number; qtd: number; tamanho?: string; adicionais?: string[]; opcoes?: Record<string, string[]> };

async function calcular(body: any) {
  const itensReq: ItemReq[] = Array.isArray(body.itens) ? body.itens.slice(0, 40) : [];
  if (!itensReq.length) throw { s: 400, m: "Pedido vazio." };

  const cfg = (await db.from("config").select("loja_aberta,cashback_pct,cashback_dias").eq("id", 1).single()).data!;
  if (!cfg.loja_aberta) throw { s: 409, m: "A loja está fechada no momento." };

  const ids = itensReq.map(i => Number(i.id)).filter(Boolean);
  const { data: prods } = await db.from("produtos")
    .select("id,nome,preco,tamanhos,adicionais,opcoes,ativo,esgotado,estoque,categoria_id,categorias(hora_ini,hora_fim,ativa)")
    .in("id", ids);

  let subtotal = 0;
  const itensOk: any[] = [];
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Fortaleza" }));
  const hhmm = agora.toTimeString().slice(0, 8);

  for (const req of itensReq) {
    const p: any = prods?.find(x => x.id === Number(req.id));
    if (!p || !p.ativo) throw { s: 422, m: "Item indisponível no cardápio." };
    if (p.esgotado) throw { s: 422, m: `"${p.nome}" está esgotado.` };
    const cat = p.categorias;
    if (cat && (!cat.ativa || (cat.hora_ini && cat.hora_fim && (hhmm < cat.hora_ini || hhmm > cat.hora_fim))))
      throw { s: 422, m: `"${p.nome}" não está disponível neste horário.` };
    const qtd = Math.max(1, Math.min(50, Number(req.qtd) || 1));
    if (p.estoque !== null && p.estoque < qtd) throw { s: 422, m: `Estoque insuficiente de "${p.nome}".` };

    let unit = Number(p.preco) || 0;
    let detalhe = "";
    if (Array.isArray(p.tamanhos) && p.tamanhos.length) {
      const t = p.tamanhos.find((t: any) => t.nome === req.tamanho) || p.tamanhos[0];
      unit = Number(t.preco); detalhe = t.nome;
    }
    if (Array.isArray(req.adicionais) && Array.isArray(p.adicionais)) {
      for (const nome of req.adicionais.slice(0, 15)) {
        const ad = p.adicionais.find((a: any) => a.nome === nome);
        if (ad) { unit += Number(ad.preco) || 0; detalhe += (detalhe ? " | " : "") + "+" + ad.nome; }
      }
    }
    // grupos de opções (proteína, molho, acompanhamentos — sem custo extra)
    if (Array.isArray(p.opcoes)) {
      const sel = (req.opcoes && typeof req.opcoes === "object") ? req.opcoes : {};
      for (const g of p.opcoes) {
        const lista = Array.isArray((sel as any)[g.titulo])
          ? (sel as any)[g.titulo].filter((x: string) => (g.itens || []).includes(x)).slice(0, g.max || 99) : [];
        if ((g.min || 0) > lista.length)
          throw { s: 422, m: `Escolha ${g.min === 1 ? "1 opção" : g.min + " opções"} de ${g.titulo} em "${p.nome}".` };
        if (lista.length) detalhe += (detalhe ? " | " : "") + g.titulo + ": " + lista.join(", ");
      }
    }
    subtotal += unit * qtd;
    itensOk.push({ id: p.id, nome: p.nome, detalhe, preco: unit, qtd });
  }

  let taxa = 0;
  if (body.tipo === "Entrega") {
    const { data: b } = await db.from("bairros").select("taxa").eq("nome", body.bairro).eq("ativo", true).single();
    if (!b) throw { s: 422, m: "Selecione um bairro atendido." };
    taxa = Number(b.taxa);
  }

  let desconto = 0, cupom: string | null = null, creditoUsado = 0;
  if (body.cupom) {
    const { data: c } = await db.from("cupons").select("*").eq("codigo", String(body.cupom).toUpperCase().trim()).single();
    if (!c || !c.ativo) throw { s: 422, m: "Cupom inválido." };
    if (c.validade && new Date(c.validade + "T23:59:59") < new Date()) throw { s: 422, m: "Cupom vencido." };
    if (c.limite_uso && c.usados >= c.limite_uso) throw { s: 422, m: "Cupom esgotado." };
    if (subtotal < Number(c.minimo)) throw { s: 422, m: `Pedido mínimo do cupom: R$ ${Number(c.minimo).toFixed(2)}.` };
    desconto = c.tipo === "pct" ? subtotal * Number(c.valor) / 100 : Number(c.valor);
    cupom = c.codigo;
  } else if (body.usar_credito && body.telefone) {
    const { data: cli } = await db.from("clientes").select("creditos").eq("telefone", body.telefone).single();
    creditoUsado = Math.min(Number(cli?.creditos || 0), subtotal);
    desconto = creditoUsado;
  }
  desconto = Math.min(desconto, subtotal);
  const total = Math.max(0, subtotal - desconto) + taxa;
  return { itensOk, subtotal, taxa, desconto, cupom, creditoUsado, total };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const acao = body.acao;

    if (acao === "preview") {
      const r = await calcular(body);
      return json({ subtotal: r.subtotal, taxa: r.taxa, desconto: r.desconto, total: r.total });
    }

    if (acao === "criar") {
      if (body.telefone) {
        const dez = new Date(Date.now() - 10 * 60000).toISOString();
        const { count } = await db.from("pedidos").select("id", { count: "exact", head: true })
          .eq("telefone", body.telefone).gte("created_at", dez);
        if ((count || 0) >= 5) return json({ error: "Muitos pedidos seguidos. Aguarde alguns minutos." }, 429);
      }
      const r = await calcular(body);
      const { data: ped, error } = await db.from("pedidos").insert({
        cliente: String(body.cliente || "").slice(0, 80), telefone: String(body.telefone || "").slice(0, 20),
        tipo: body.tipo === "Entrega" ? "Entrega" : "Retirada", bairro: body.tipo === "Entrega" ? body.bairro : null,
        itens: r.itensOk, subtotal: r.subtotal, taxa_entrega: r.taxa, desconto: r.desconto, cupom: r.cupom,
        total: r.total, pagamento: String(body.pagamento || "").slice(0, 30),
        localizacao: String(body.localizacao || "").slice(0, 200) || null,
        referencia: String(body.referencia || "").slice(0, 200) || null,
        endereco: String(body.endereco || "").slice(0, 200) || null,
        obs: String(body.obs || "").slice(0, 300) || null,
        agendado_para: String(body.agendado_para || "").slice(0, 40) || null,
        origem: "cardapio", status: "abandonado",
      }).select("id").single();
      if (error) throw { s: 500, m: "Erro ao registrar o pedido." };
      return json({ id: ped.id, subtotal: r.subtotal, taxa: r.taxa, desconto: r.desconto, total: r.total });
    }

    if (acao === "confirmar") {
      const { data: p } = await db.from("pedidos").select("*").eq("id", body.id).eq("status", "abandonado").single();
      if (!p) return json({ ok: true });
      await db.from("pedidos").update({ status: "recebido" }).eq("id", p.id);
      for (const it of (p.itens as any[]) || []) {
        const { data: prod } = await db.from("produtos").select("estoque").eq("id", it.id).single();
        if (prod && prod.estoque !== null) {
          const novo = Math.max(0, prod.estoque - it.qtd);
          await db.from("produtos").update({ estoque: novo, esgotado: novo === 0 }).eq("id", it.id);
        }
      }
      if (p.cupom) {
        const { data: c } = await db.from("cupons").select("usados").eq("codigo", p.cupom).single();
        if (c) await db.from("cupons").update({ usados: (c.usados || 0) + 1 }).eq("codigo", p.cupom);
      }
      if (p.telefone) {
        const { data: cli } = await db.from("clientes").select("*").eq("telefone", p.telefone).single();
        const cfg = (await db.from("config").select("cashback_pct,cashback_dias").eq("id", 1).single()).data!;
        const dia = new Date().getDay();
        const ganha = (Number(cfg.cashback_pct) > 0 && (cfg.cashback_dias || []).includes(dia))
          ? Number(p.total) * Number(cfg.cashback_pct) / 100 : 0;
        const usado = !p.cupom ? Number(p.desconto || 0) : 0;
        await db.from("clientes").upsert({
          telefone: p.telefone, nome: p.cliente,
          creditos: Math.max(0, Number(cli?.creditos || 0) - usado + ganha),
          pedidos: Number(cli?.pedidos || 0) + 1,
          total_gasto: Number(cli?.total_gasto || 0) + Number(p.total),
          ultimo_pedido: new Date().toISOString(),
        });
      }
      return json({ ok: true });
    }

    if (acao === "consultar") {
      const { data: p } = await db.from("pedidos")
        .select("id,created_at,cliente,itens,total,status,tipo,agendado_para").eq("id", body.id).single();
      if (!p) return json({ error: "Pedido não encontrado." }, 404);
      return json(p);
    }

    if (acao === "credito") {
      const { data: cli } = await db.from("clientes").select("creditos").eq("telefone", body.telefone).single();
      return json({ creditos: Number(cli?.creditos || 0) });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (e: any) {
    if (e?.s) return json({ error: e.m }, e.s);
    return json({ error: "Erro interno." }, 500);
  }
});
