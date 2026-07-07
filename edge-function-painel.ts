// Edge Function: painel — login com hash + token de sessão + ações administrativas (v2)
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const enc = new TextEncoder();

async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// PBKDF2-SHA256 (nativo, sem dependências) — formato: pbkdf2$iter$saltHex$hashHex
async function hashSenha(senha: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const hex = (u: Uint8Array) => [...u].map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$100000$${hex(salt)}$${hex(new Uint8Array(bits))}`;
}
async function verificaSenha(senha: string, stored: string) {
  const [alg, iterS, saltHex, hashHex] = (stored || "").split("$");
  if (alg !== "pbkdf2") return false;
  const salt = new Uint8Array(saltHex.match(/../g)!.map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: +iterS, hash: "SHA-256" }, key, 256);
  const calc = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
  return calc === hashHex; // strings mesmas dimensões
}

async function exigirToken(body: any) {
  if (!body.token) throw { s: 401, m: "Sessão expirada. Entre de novo." };
  const th = await sha256(body.token);
  const { data } = await db.from("sessoes").select("expira").eq("token_hash", th).single();
  if (!data || new Date(data.expira) < new Date()) throw { s: 401, m: "Sessão expirada. Entre de novo." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const acao = body.acao;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "0.0.0.0";

    // ---------- AUTENTICAÇÃO ----------
    if (acao === "bootstrap_senha") { // só funciona enquanto não existe senha
      const cfg = (await db.from("config").select("senha_hash").eq("id", 1).single()).data!;
      if (cfg.senha_hash) return json({ error: "Senha já definida." }, 409);
      if (String(body.nova || "").length < 8) return json({ error: "Mínimo 8 caracteres." }, 400);
      await db.from("config").update({ senha_hash: await hashSenha(body.nova) }).eq("id", 1);
      return json({ ok: true });
    }

    if (acao === "login") {
      const quinze = new Date(Date.now() - 15 * 60000).toISOString();
      const { count } = await db.from("login_tentativas").select("*", { count: "exact", head: true })
        .eq("ip", ip).gte("quando", quinze);
      if ((count || 0) >= 6) return json({ error: "Muitas tentativas. Aguarde 15 minutos." }, 429);

      const cfg = (await db.from("config").select("senha_hash").eq("id", 1).single()).data!;
      if (!cfg.senha_hash || !(await verificaSenha(String(body.senha || ""), cfg.senha_hash))) {
        await db.from("login_tentativas").insert({ ip });
        return json({ error: "Senha incorreta." }, 401);
      }
      const token = crypto.randomUUID() + crypto.randomUUID();
      await db.from("sessoes").insert({ token_hash: await sha256(token), expira: new Date(Date.now() + 12 * 3600000).toISOString() });
      await db.from("sessoes").delete().lt("expira", new Date().toISOString()); // limpeza
      return json({ token });
    }

    await exigirToken(body); // ---------- daqui pra baixo: só autenticado ----------

    if (acao === "trocar_senha") {
      const cfg = (await db.from("config").select("senha_hash").eq("id", 1).single()).data!;
      if (!(await verificaSenha(String(body.atual || ""), cfg.senha_hash))) return json({ error: "Senha atual incorreta." }, 401);
      if (String(body.nova || "").length < 8) return json({ error: "Mínimo 8 caracteres." }, 400);
      await db.from("config").update({ senha_hash: await hashSenha(body.nova) }).eq("id", 1);
      return json({ ok: true });
    }

    if (acao === "listar") {
      const { data: pedidos } = await db.from("pedidos").select("*").order("created_at", { ascending: false }).limit(1000);
      const { data: clientes } = await db.from("clientes").select("*").order("total_gasto", { ascending: false }).limit(500);
      return json({ pedidos, clientes });
    }

    if (acao === "set_status") {
      const ok = ["recebido", "preparo", "entrega", "concluido", "cancelado"];
      if (!ok.includes(body.status)) return json({ error: "Status inválido." }, 400);
      await db.from("pedidos").update({ status: body.status }).eq("id", body.id);
      return json({ ok: true });
    }

    if (acao === "add_venda") {
      await db.from("pedidos").insert({
        cliente: body.cliente || "Venda manual", telefone: body.telefone || null,
        itens: body.itens || null, total: Number(body.total), subtotal: Number(body.total),
        pagamento: body.pagamento, obs: body.obs || null, origem: "manual", status: "concluido",
        created_at: body.created_at || new Date().toISOString(),
      });
      return json({ ok: true });
    }

    if (acao === "excluir") { await db.from("pedidos").delete().eq("id", body.id); return json({ ok: true }); }

    if (acao === "set_loja") { await db.from("config").update({ loja_aberta: !!body.aberta }).eq("id", 1); return json({ ok: true }); }

    if (acao === "set_cashback") {
      await db.from("config").update({ cashback_pct: Number(body.pct) || 0, cashback_dias: body.dias || [] }).eq("id", 1);
      return json({ ok: true });
    }

    // ---------- CARDÁPIO (CRUD) ----------
    if (acao === "cardapio") {
      const { data: categorias } = await db.from("categorias").select("*").order("ordem");
      const { data: produtos } = await db.from("produtos").select("*").order("ordem");
      return json({ categorias, produtos });
    }
    if (acao === "produto_save") {
      const p = body.produto || {};
      const campos = {
        categoria_id: p.categoria_id, nome: String(p.nome || "").slice(0, 120), descricao: p.descricao,
        preco: p.preco, tamanhos: p.tamanhos, adicionais: p.adicionais, img: p.img, selos: p.selos,
        destaque: !!p.destaque, ativo: p.ativo !== false, esgotado: !!p.esgotado,
        estoque: p.estoque === "" || p.estoque == null ? null : Number(p.estoque),
        custo: p.custo || null, ordem: Number(p.ordem) || 0,
      };
      if (p.id) await db.from("produtos").update(campos).eq("id", p.id);
      else await db.from("produtos").insert(campos);
      return json({ ok: true });
    }
    if (acao === "produto_del") { await db.from("produtos").delete().eq("id", body.id); return json({ ok: true }); }
    if (acao === "categoria_save") {
      const c = body.categoria || {};
      const campos = { nome: c.nome, emoji: c.emoji, sub: c.sub, ordem: Number(c.ordem) || 0, ativa: c.ativa !== false, hora_ini: c.hora_ini || null, hora_fim: c.hora_fim || null };
      if (c.id) await db.from("categorias").update(campos).eq("id", c.id);
      else await db.from("categorias").insert(campos);
      return json({ ok: true });
    }

    // ---------- CUPONS ----------
    if (acao === "cupons") { const { data } = await db.from("cupons").select("*").order("codigo"); return json({ cupons: data }); }
    if (acao === "cupom_save") {
      const c = body.cupom || {};
      await db.from("cupons").upsert({
        codigo: String(c.codigo || "").toUpperCase().trim(), tipo: c.tipo === "pct" ? "pct" : "valor",
        valor: Number(c.valor), minimo: Number(c.minimo) || 0, validade: c.validade || null,
        limite_uso: c.limite_uso ? Number(c.limite_uso) : null, ativo: c.ativo !== false,
      });
      return json({ ok: true });
    }
    if (acao === "cupom_del") { await db.from("cupons").delete().eq("codigo", body.codigo); return json({ ok: true }); }

    // ---------- CAIXA ----------
    if (acao === "caixa_status") {
      const { data } = await db.from("caixa").select("*").is("fechado_em", null).order("aberto_em", { ascending: false }).limit(1);
      const aberto = data?.[0] || null;
      let movimentos: any[] = [];
      if (aberto) movimentos = (await db.from("caixa_movimentos").select("*").eq("caixa_id", aberto.id).order("quando")).data || [];
      return json({ caixa: aberto, movimentos });
    }
    if (acao === "caixa_abrir") { await db.from("caixa").insert({ valor_inicial: Number(body.valor) || 0 }); return json({ ok: true }); }
    if (acao === "caixa_mov") {
      await db.from("caixa_movimentos").insert({ caixa_id: body.caixa_id, tipo: body.tipo, valor: Number(body.valor), descricao: body.descricao });
      return json({ ok: true });
    }
    if (acao === "caixa_fechar") {
      await db.from("caixa").update({ fechado_em: new Date().toISOString(), valor_conferido: Number(body.conferido) || null }).eq("id", body.caixa_id);
      return json({ ok: true });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (e: any) {
    if (e?.s) return json({ error: e.m }, e.s);
    return json({ error: "Erro interno." }, 500);
  }
});
