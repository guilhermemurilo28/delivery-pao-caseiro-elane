# Delivery — Pão Caseiro da Elane 🍞

Sistema de delivery completo (padrão **PedeJá v2**): cardápio digital + painel administrativo.

## Estrutura
| Arquivo | Função |
|---|---|
| `index.html` | Cardápio público (cliente monta o pedido e envia via WhatsApp) |
| `painel.html` | Painel do proprietário (vendas, status, cardápio, cupons, abandonados) |
| `_headers` | Headers de segurança (Cloudflare Pages) |
| `setup.sql` | Schema do banco Supabase (rodar no SQL Editor) — idempotente |
| `edge-function-pedido.ts` | Edge Function `pedido`: valida preços/cupons/estoque no servidor |
| `edge-function-painel.ts` | Edge Function `painel`: login com hash + token e ações administrativas |

## Infra
- **Site**: Cloudflare Pages (paocaseiro-elane.pages.dev) — deploy automático a cada commit na `main`
- **Banco/Backend**: Supabase (projeto `delivery-pao-caseiro-elane`)
- As Edge Functions são publicadas no Supabase (Functions → pedido / painel), não pelo Pages.

## Segurança
Preços recalculados no servidor · senha PBKDF2 + rate limit + sessão por token (12h) · RLS: anon só lê cardápio · anti-XSS no painel.

*Gerado com a skill `delivery-saas-generator` (PedeJá).*
