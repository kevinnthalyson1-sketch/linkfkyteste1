// Robô de afiliados (WhatsApp via Evolution API) + painel (pasta public/)
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import dns from 'dns/promises';
import net from 'net';
import { fileURLToPath } from 'url';

const { EVO_URL, EVO_KEY, PUBLIC_URL = '', PORT = 3000 } = process.env; // PUBLIC_URL ex.: https://ofertas.seudominio.com
const dir = path.dirname(fileURLToPath(import.meta.url));
const SHOPEE = process.env.SHOPEE_URL || 'https://open-api.affiliate.shopee.com.br/graphql';
const ESC = +(process.env.ESCALA_TEMPO || 1); // só para testes: 0.01 deixa os tempos 100x mais curtos
const DB = process.env.DB_PATH || 'data.json';
const DELAYS = [10, 30, 60], EVERY = [30, 60, 120, 240], MAXES = [1, 3, 5];
const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest()); // comparação sem vazar tempo

// ---------- planos ----------
// teste = período grátis (10 dias). plano1 / plano2 = assinaturas. Qualquer conta pode testar o Plano Pro por 5 dias (uma vez). O administrador sempre tem os recursos do plano2.
const TRIAL_DIAS = 10;
const TRIAL_P2_DIAS = 5; // teste do Plano Pro: uma vez por conta, o cliente começa quando quiser (painel > Planos)
const TETO = 100000; // "ilimitado": nenhum plano chega a esse valor na prática
const PLANOS = {
  teste:  { anuncio: true, nome: 'Plano grátis (teste de 10 dias)', preco: 0,     origens: 2,  destinos: 1,  enviosDia: 50,  delays: [60],         ofertas: { keywords: 1,  max: 1, everyMin: 120 }, horarios: false, modeloCustom: false, relatorios: false, horasDia: 3 }, // horasDia: o robô só trabalha 3 h por dia
  plano1: { anuncio: true, nome: 'Plano Plus',                         preco: 35.9,  origens: 5,  destinos: 2,  enviosDia: 150, delays: [30, 60],     ofertas: { keywords: 3,  max: 3, everyMin: 60 },  horarios: true,  modeloCustom: true,  relatorios: false, agoraDia: 5 }, // agoraDia: usos do "Enviar agora" por dia
  plano2: { anuncio: false, nome: 'Plano Pro',                         preco: 69.9,  origens: 10, destinos: 10, enviosDia: TETO, delays: [10, 30, 60], ofertas: { keywords: 10, max: 5, everyMin: 30 },  horarios: true,  modeloCustom: true,  relatorios: true }
};
const listaEnv = s => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const PRODUTOS = { plano1: listaEnv(process.env.PRODUTO_PLANO1), plano2: listaEnv(process.env.PRODUTO_PLANO2) }; // IDs de produto/oferta da Hotmart ou Kiwify
const WARN = {
  10: 'Risco alto de bloqueio do número. Use só com número dedicado.',
  30: 'Risco moderado de bloqueio.',
  60: 'Menor risco, mas nenhum intervalo elimina a chance de bloqueio.'
};

if (process.env.SEGREDO_CHAVE && !/^[0-9a-fA-F]{64}$/.test(process.env.SEGREDO_CHAVE)) { console.error('ERRO: SEGREDO_CHAVE precisa ter exatamente 64 caracteres hexadecimais (gere com: openssl rand -hex 32). Corrija o arquivo .env.'); process.exit(1); }
const KEY = process.env.SEGREDO_CHAVE ? Buffer.from(process.env.SEGREDO_CHAVE, 'hex') : null; // 64 caracteres hex (openssl rand -hex 32)
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const e = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('hex')).join('.'); };
const dec = t => { const [iv, tag, e] = t.split('.').map(x => Buffer.from(x, 'hex')); const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); };
let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { users: {} };
db.links ||= {}; db.clicks ||= []; db.sessions ||= {};
// migração: tokens antigos (texto puro e sem validade) deixam de existir; todos entram de novo e recebem sessão com hash e validade
for (const u of Object.values(db.users)) delete u.token;
// migração: contas criadas com limite de 50/dia (valor do plano grátis) ficavam presas nele ao assinar; o plano já limita sozinho
for (const u of Object.values(db.users)) if (u.protecao?.limiteDia === 50 && !u.protecao.migrado) { u.protecao.limiteDia = 150; u.protecao.migrado = true; }
for (const u of Object.values(db.users)) if (u.shopee?.secretEnc) { try { u.shopee.secret = dec(u.shopee.secretEnc); } catch { console.error('Não consegui abrir o segredo da Shopee: confira SEGREDO_CHAVE'); } }
/* db.users[instancia] = { token, active, delay, rastrear, sources[], dests[], names{},
     ids{amazon,ml,magalu}, templates{aliexpress,shein}, shopee{appId,secret},
     ofertas{active,everyMin,max,minDiscount,keywords[]}, log[] } */
let timer;
const flush = () => { try {
  const k = Object.keys(db.links); if (k.length > 30000) k.slice(0, k.length - 30000).forEach(c => delete db.links[c]);
  if (db.clicks.length > 100000) db.clicks = db.clicks.slice(-100000);
  // grava o arquivo inteiro ou nada (arquivo temporário + troca)
  const out = { ...db, users: Object.fromEntries(Object.entries(db.users).map(([k, u]) =>
    [k, KEY && u.shopee?.secret ? { ...u, shopee: { appId: u.shopee.appId, secretEnc: enc(u.shopee.secret) } } : u])) };
  fs.writeFileSync(DB + '.tmp', JSON.stringify(out), { mode: 0o600 }); fs.renameSync(DB + '.tmp', DB); } catch (e) { console.error('Erro ao gravar o banco:', e.message); } };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 1500); };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { clearTimeout(timer); flush(); process.exit(0); }); // docker stop não perde dados

const mem = {};
const M = i => (mem[i] ||= { recent: new Map(), sent: new Set(), next: 0, q: [], running: false, inbox: [], diag: [], recebidas: 0, ultimoWebhook: 0 });
function note(inst, motivo, ok = false, grupo = '') { // registra por que o robô enviou ou ignorou algo (aparece em Automação)
  const s = M(inst), last = s.diag[0];
  if (last && last.motivo === motivo && last.grupo === grupo && Date.now() - last.t < 60e3) { last.n++; return; }
  s.diag.unshift({ t: Date.now(), motivo, ok, grupo, n: 1 }); s.diag.length = Math.min(s.diag.length, 40);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mensagens e horários ----------
const PRESETS = {
  classico: '🔥 {titulo}\n\n💰 De {de} por {preco} ({desconto}% OFF)\n⭐ {avaliacao} | {vendidos} vendidos\n\n🎟️ Cupom: {cupom}\n\n🛒 {link}',
  minimal: '{titulo}\n{preco} ({desconto}% OFF)\n{cupom}\n{link}',
  urgencia: '🚨 ACABANDO! {titulo}\n\n❌ {de}\n✅ {preco} ({desconto}% OFF)\n\n🎟️ Cupom: {cupom}\n⏳ Corre que o estoque some!\n👉 {link}'
};
function build(p, u, parcial = false) { // parcial: some a linha se QUALQUER campo dela estiver vazio (usado quando só temos título/preço da página) // monta a mensagem de uma oferta achada pelo robô
  const m = u.mensagem || {}, v = { ...p, cupom: m.cupom || '' };
  const tpl = m.modelo === 'custom' && m.custom && P(u).modeloCustom ? m.custom : PRESETS[m.modelo] || PRESETS.classico;
  const vazio = k => v[k] === undefined || v[k] === null || v[k] === '';
  const body = tpl.split('\n').filter(l => { const ks = [...l.matchAll(/\{(\w+)\}/g)].map(m => m[1]); return !(ks.length && (parcial ? ks.some(vazio) : ks.every(vazio))); }) // some só a linha em que todos os campos estão vazios
    .map(l => l.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return [m.topo, body, m.rodape].filter(Boolean).join('\n\n');
}
const INVITE = /https?:\/\/(chat\.whatsapp\.com|whatsapp\.com\/channel|t\.me|wa\.me)\/\S*/gi;
function wrap(text, u) { // mensagem copiada: tira convites de outros grupos e põe seu topo e rodapé
  const m = u.mensagem || {};
  const t = m.limparConvites === false ? text : text.replace(INVITE, '').replace(/\n{3,}/g, '\n\n').trim();
  return [m.topo, t, m.rodape].filter(Boolean).join('\n\n');
}
const inWindow = u => !P(u).horarios || !u.horarios?.ativo || u.horarios.horas?.includes(br(Date.now()).h);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const isAdmin = u => !!ADMIN_EMAIL && u.email === ADMIN_EMAIL;
const planoBase = u => isAdmin(u) ? 'plano2' : PLANOS[u.plano] ? u.plano : u.plano === 'pago' ? 'plano1' : 'teste'; // o plano da conta ('pago' = contas antigas)
const testeP2Ativo = u => !isAdmin(u) && acesso(u) === 'ok' && (u.testeP2?.ate || 0) > Date.now() && planoBase(u) !== 'plano2';
const podeTesteP2 = u => !isAdmin(u) && !u.testeP2?.usado && acesso(u) === 'ok' && planoBase(u) !== 'plano2';
const planoDe = u => testeP2Ativo(u) ? 'plano2' : planoBase(u); // plano que vale agora (durante o teste do Plano Pro, os limites são os do Plano Pro)
const P = u => PLANOS[planoDe(u)];
// Anúncio do Linkfly: nos planos com anuncio:true, a cada ANUNCIO_A_CADA ofertas enviadas posta um aviso no mesmo grupo. O Plano Pro não tem anúncio.
const ANUNCIO_A_CADA = Number(process.env.ANUNCIO_A_CADA) || 20;
let anuncioImg = null; // arte do anúncio (public/anuncio.png ou ANUNCIO_IMAGEM), lida uma vez
const lerAnuncioImg = () => { if (anuncioImg === null) { try { anuncioImg = fs.readFileSync(process.env.ANUNCIO_IMAGEM || path.join(dir, 'public', 'anuncio.png')).toString('base64'); } catch { anuncioImg = ''; } } return anuncioImg; };
async function enviarAnuncio(inst, to) { // post com a arte e legenda; se a imagem falhar, vai só o texto
  const img = lerAnuncioImg();
  if (img) { try { await evo(`/message/sendMedia/${inst}`, 'POST', { number: to, mediatype: 'image', mimetype: 'image/png', media: img, caption: anuncioTexto(), fileName: 'linkfly.png' }); return; } catch (e) { console.error(`[${inst}] arte do anúncio falhou, enviando só texto:`, e.message); } }
  await evo(`/message/sendText/${inst}`, 'POST', { number: to, text: anuncioTexto() });
}
const anuncioTexto = () => process.env.ANUNCIO_TEXTO || `📢 *Quer postar ofertas assim, sem copiar e colar?*\nO *Linkfly* copia as ofertas, troca pelo seu link de afiliado e posta nos seus grupos, sozinho.\n🎁 Teste grátis por 10 dias: ${process.env.SITE_URL || PUBLIC_URL || 'https://wa.me/5581973295943'}`;
const efDelay = u => { const d = P(u).delays; return d.find(x => x >= u.delay) ?? d[d.length - 1]; }; // intervalo permitido pelo plano
const acesso = u => isAdmin(u) ? 'ok' : u.bloqueado ? 'bloqueado' : u.expira && u.expira < Date.now() ? 'vencido' : 'ok';
// proteção contra bloqueio do número: limite por dia, aquecimento de número novo e intervalo variável
function limiteHoje(u) {
  const p = u.protecao || {}, base = Math.min(+p.limiteDia || 150, TETO, P(u).enviosDia);
  if (p.aquecimento === false) return base;
  const dias = Math.floor((Date.now() - (u.conectadoEm || u.criado || Date.now())) / 864e5);
  return Math.min(base, [20, 40, 60, 90, 120][dias] ?? base);
}
const atLimit = u => { const d = br(Date.now()).d; if (u.cont?.d !== d) u.cont = { d, n: 0 }; return u.cont.n >= limiteHoje(u); };
const bump = u => { atLimit(u); u.cont.n++; };
// plano grátis: o robô só trabalha algumas horas por dia (conta o tempo em que ele fica ligado)
const usoHoje = u => { const d = br(Date.now()).d; if (u.uso?.d !== d) u.uso = { d, ms: 0 }; return u.uso; };
const tempoMs = u => (P(u).horasDia || 0) * 3600e3 * ESC;
const semTempo = u => !!P(u).horasDia && usoHoje(u).ms >= tempoMs(u);
const jitter = u => efDelay(u) * 1000 * ESC * (u.protecao?.variar === false ? 1 : 0.8 + Math.random() * 0.5);

// ---------- Shopee Open API ----------
async function shopeeQL(c, query) {
  const body = JSON.stringify({ query }), ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256').update(c.appId + ts + body + c.secret).digest('hex');
  const r = await fetch(SHOPEE, { method: 'POST', body, headers: { 'Content-Type': 'application/json',
    Authorization: `SHA256 Credential=${c.appId}, Timestamp=${ts}, Signature=${sig}` } });
  const j = await r.json();
  if (j.errors) throw new Error('Shopee: ' + JSON.stringify(j.errors));
  return j.data;
}
const cleanSub = s => String(s || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
const shortCache = new Map(); // o mesmo link com o mesmo Sub ID não precisa ir à Shopee de novo
const shopeeLink = async (c, url, sub = 'robo') => {
  const k = `${c.appId}|${sub}|${url}`, hit = shortCache.get(k);
  if (hit && Date.now() - hit.t < 3600e3) return hit.v;
  const v = (await shopeeQL(c, `mutation{generateShortLink(input:{originUrl:${JSON.stringify(url)},subIds:[${JSON.stringify(cleanSub(sub) || 'robo')}]}){shortLink}}`)).generateShortLink.shortLink;
  if (shortCache.size > 500) shortCache.clear();
  shortCache.set(k, { v, t: Date.now() }); return v;
};
// Sub ID de cada grupo de destino: aparece na coluna Sub ID do relatório da Shopee e mostra qual grupo vendeu
const novoSub = u => { const usados = new Set(Object.values(u.subids || {}).map(x => x.toLowerCase())); let c; do c = 'lf' + crypto.randomBytes(2).toString('hex'); while (usados.has(c)); return c; };
const subOf = (u, to) => { if (!to) return 'robo'; u.subids ||= {}; if (!u.subids[to]) { u.subids[to] = novoSub(u); save(); } return u.subids[to]; };

// ---------- conversão por loja ----------
const tpl = (t, url) => t.replace('{url_enc}', encodeURIComponent(url)).replace('{url}', url);
const STORES = [
  { k: 'amazon', test: h => /(^|\.)amazon\.com(\.br)?$/.test(h), need: u => u.ids?.amazon,
    go: (url, u) => { url.searchParams.set('tag', u.ids.amazon); return url.toString(); } },
  { k: 'ml', test: h => /(^|\.)mercadolivre\.com\.br$/.test(h), need: u => u.ids?.ml,
    go: (url, u) => { url.searchParams.set('matt_tool', u.ids.ml); return url.toString(); } },
  { k: 'magalu', test: h => /(^|\.)magazineluiza\.com\.br$/.test(h), need: u => u.ids?.magalu,
    go: (url, u) => `https://www.magazinevoce.com.br/magazine${u.ids.magalu}${url.pathname}` },
  { k: 'shopee', test: h => /(^|\.)shopee\.com\.br$/.test(h), need: u => u.shopee?.secret,
    go: (url, u, sub) => shopeeLink(u.shopee, `${url.origin}${url.pathname}`, sub) },
  { k: 'aliexpress', test: h => /(^|\.)aliexpress\.(com|us)$/.test(h), need: u => u.templates?.aliexpress,
    go: (url, u) => tpl(u.templates.aliexpress, `${url.origin}${url.pathname}`) },
  { k: 'shein', test: h => /(^|\.)(shein\.com|shein\.com\.br)$/.test(h), need: u => u.templates?.shein,
    go: (url, u) => tpl(u.templates.shein, `${url.origin}${url.pathname}`) }
];
const SHORT = /(^|\.)(amzn\.to|amzn\.com|s\.shopee\.com\.br|shope\.ee|a\.aliexpress\.com|s\.click\.aliexpress\.com)$/;

const expCache = new Map();
// ---- proteção contra SSRF: só fala com endereços públicos, segue redirecionamentos um a um e confere cada destino
function privIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) { const r = x.slice(7); return net.isIPv4(r) ? privIp(r) : true; }
  return x === '::1' || x === '::' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}
async function publicHost(h) {
  h = String(h || '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !privIp(h);
  if (!/^[a-z0-9.-]+$/i.test(h) || !h.includes('.')) return false;
  try { const r = await dns.lookup(h, { all: true }); return r.length > 0 && r.every(x => !privIp(x.address)); } catch { return false; }
}
async function safeFetch(raw, opts = {}, stop) { // devolve { res, url }; stop(host) encerra sem baixar a página quando já chegou numa loja conhecida
  let url = String(raw);
  for (let i = 0; i < 5; i++) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || !(await publicHost(u.hostname))) throw new Error('destino não permitido');
    if (i > 0 && stop?.(u.hostname.toLowerCase())) return { res: null, url: u.toString() };
    const res = await fetch(u, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(6000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { res.body?.cancel().catch(() => {}); url = new URL(loc, u).toString(); continue; }
    return { res, url: u.toString() };
  }
  throw new Error('redirecionamentos demais');
}
async function readLimited(res, max) {
  const rd = res.body.getReader(), parts = []; let n = 0;
  while (n < max) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
  rd.cancel().catch(() => {}); return Buffer.concat(parts).toString('utf8').slice(0, max);
}
const isStore = h => STORES.some(s => s.test(h));
async function expand(raw) { // links curtos (amzn.to etc.): descobre o endereço final uma vez só
  const hit = expCache.get(raw); if (hit && Date.now() - hit.t < 600e3) return hit.v;
  const { res, url } = await safeFetch(raw, {}, isStore);
  res?.body?.cancel().catch(() => {});
  if (expCache.size > 300) expCache.clear(); expCache.set(raw, { v: url, t: Date.now() }); return url;
}
async function convertOne(raw, u, sub) {
  let url;
  try { url = new URL(raw); if (SHORT.test(url.hostname)) url = new URL(await expand(raw)); } catch { return null; }
  const s = STORES.find(s => s.test(url.hostname.toLowerCase()));
  if (!s || !s.need(u)) return null;
  try { return { link: await s.go(url, u, sub), loja: s.k, key: url.hostname + url.pathname, orig: url.origin + url.pathname }; } catch { return null; }
}
async function convert(text, u, sub, strict = false) { // strict: remove da mensagem todo link que não virou link do usuário (mensagens vindas de outros grupos)
  let out = text; const links = [], keys = [];
  for (const raw of new Set(text.match(/https?:\/\/[^\s<>"]+/g) || [])) {
    const tail = (raw.match(/[.,;:!?)\]]+$/) || [''])[0];
    const r = await convertOne(tail ? raw.slice(0, -tail.length) : raw, u, sub);
    if (r) { out = out.split(raw).join(r.link + tail); links.push({ link: r.link, loja: r.loja, orig: r.orig }); keys.push(r.key); }
    else if (strict) out = out.split(raw).join('');
  }
  if (strict) out = out.split('\n').map(l => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { out, n: links.length, links, keys };
}

// "Enviar agora": monta a mensagem no modelo do cliente. Se vier só o link, busca título, preço e foto na página do produto.
const soLink = raw => raw.replace(/https?:\/\/[^\s<>"]+/g, '').replace(/[^\p{L}\p{N}]/gu, '').length < 8;
async function compor(raw, u, sub, strict, itemImage) {
  const r = await convert(raw, u, sub, strict);
  if (!r.links.length) return { ...r, text: r.out, image: null };
  const linkOnly = soLink(raw) && r.links.length === 1, foto = u.mensagem?.buscarFoto !== false;
  const info = linkOnly || (!itemImage && foto) ? await ogInfo(r.links[0].orig) : null;
  let text = linkOnly ? build({ titulo: info?.title || '', preco: info?.preco || '', de: info?.de || '', desconto: info?.desc || '', link: r.links[0].link }, u, true) : wrap(r.out, u);
  if (linkOnly && info?.preco && !text.includes(info.preco)) { // o modelo só mostra o preço junto de "De/Desconto"; sem esses dados, põe o preço numa linha própria antes do link
    const ls = text.split('\n'), i = ls.findIndex(l => l.includes(r.links[0].link)); ls.splice(i < 0 ? ls.length : i, 0, `💰 ${info.preco}`); text = ls.join('\n');
  }
  return { ...r, text, image: itemImage || (foto ? info?.image : null) || null, linkOnly };
}

// ---------- Evolution ----------
async function evo(p, method = 'GET', body) {
  if (!EVO_URL || !EVO_KEY) throw new Error(`Falta ${[!EVO_URL && 'EVO_URL', !EVO_KEY && 'EVO_KEY'].filter(Boolean).join(' e ')} no arquivo .env. Use o RECOMECAR.bat e reinicie o sistema.`);
  const r = await fetch(EVO_URL.replace(/\/+$/, '') + p, { method, headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(Number(process.env.EVO_TIMEOUT_MS) || 60000) })
    .catch(e => { throw e.name === 'TimeoutError' || e.name === 'AbortError' ? new Error('O Evolution (WhatsApp) demorou demais para responder. Ele pode estar dormindo, reiniciando ou sem memória no servidor. Tente de novo em 1 minuto.') : e; });
  if (!r.ok) { const e = new Error(`Evolution ${r.status}: ${await r.text()}`); e.status = r.status; throw e; }
  return r.json();
}

// ---------- foto do produto ----------
const infoCache = new Map();
const deEnt = t => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const GENERIC = /^(mercado\s*(livre|libre)|amazon(\.com\.br)?|magalu|magazine\s*luiza|shopee|aliexpress|shein)$/i; // título genérico = página bloqueada, não é o produto
const fmtPreco = n => Number.isFinite(n) && n > 0 ? brl(n) : '';
const mlId = url => { const u = new URL(url); return (u.searchParams.get('wid') || (decodeURIComponent(u.search + u.hash).match(/MLB\d{6,}/) || [])[0] || (u.pathname.match(/MLB-?\d{6,}/) || [])[0] || '').replace('-', ''); };
async function mlItem(url) { // Mercado Livre: a página costuma bloquear servidores; tenta a API pública do anúncio (título, foto, preço e preço antigo)
  try {
    const id = mlId(url); if (!/^MLB\d+$/.test(id)) return null;
    const r = await fetch(`https://api.mercadolibre.com/items/${id}`, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (!r.ok) return null; const j = await r.json();
    return { title: String(j.title || '').slice(0, 120), image: String(j.pictures?.[0]?.secure_url || j.secure_thumbnail || j.thumbnail || '').replace(/^http:/, 'https:') || null, price: Number(j.price), old: Number(j.original_price) };
  } catch { return null; }
}
async function ogInfo(url) { // título, foto e preço da página do produto (melhor esforço; só em página de loja conhecida)
  const hit = infoCache.get(url); if (hit && Date.now() - hit.t < 600e3) return hit.v;
  try { if (/mercadoli(vre|bre)\./.test(new URL(url).hostname.toLowerCase())) { const m = await mlItem(url); if (m?.title) { const off = m.old > m.price; const v = { image: m.image, title: m.title, preco: fmtPreco(m.price), de: off ? fmtPreco(m.old) : '', desc: off ? Math.round((1 - m.price / m.old) * 100) : '' }; infoCache.set(url, { v, t: Date.now() }); return v; } } } catch {}
  let v = null;
  try {
    if (!isStore(new URL(url).hostname.toLowerCase())) return null;
    const { res, url: final } = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    const html = await readLimited(res, 200000);
    const meta = k => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, 'i')); return m ? deEnt(m[1]) : null; };
    const ld = (() => { for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { const j = JSON.parse(m[1]); const p = [].concat(j, j['@graph'] || []).find(x => x && /Product/.test([].concat(x['@type']).join())); if (p) return p; } catch {} } return null; })();
    const ldImg = [].concat(ld?.image || []).map(x => typeof x === 'string' ? x : x?.url).find(Boolean);
    let image = null;
    const im = meta('og:image') || meta('twitter:image') || ldImg;
    if (im) { try { const iu = new URL(im, final); if (iu.protocol === 'https:' && await publicHost(iu.hostname)) image = iu.toString(); } catch {} }
    let title = deEnt(meta('og:title') || ld?.name || (html.match(/<title[^>]*>([^<]*)/i) || [])[1]);
    title = title.replace(/^(Amazon\.com\.br|Amazon)\s*:\s*/i, '').replace(/\s*[|\-–:]\s*(Amazon|Mercado Livre|Magalu|Magazine Luiza|Shopee|AliExpress|Shein)[^|]*$/i, '').slice(0, 120);
    if (GENERIC.test(title.trim()) || title.trim().length < 4) title = '';
    const off = [].concat(ld?.offers || [])[0] || {};
    const n = Number(String(meta('product:price:amount') || meta('og:price:amount') || off.price || off.lowPrice || '').replace(',', '.'));
    v = { image, title, preco: fmtPreco(n) };
  } catch { v = null; }
  if (infoCache.size > 300) infoCache.clear(); infoCache.set(url, { v, t: Date.now() }); return v;
}
const ogImage = async url => (await ogInfo(url))?.image || null;
async function sendOffer(inst, to, text, image) { // foto com legenda; se a foto falhar, vai só o texto
  let cap = false, ok = false;
  if (image) {
    cap = text.length <= 1000; // limite de legenda do WhatsApp
    try { await evo(`/message/sendMedia/${inst}`, 'POST', { number: to, mediatype: 'image', mimetype: 'image/jpeg', media: image, ...(cap && { caption: text }), fileName: 'oferta.jpg' }); ok = true; }
    catch (e) { console.error(`[${inst}] foto falhou, enviando só texto:`, e.message); }
  }
  if (!ok || !cap) await evo(`/message/sendText/${inst}`, 'POST', { number: to, text });
}

const WH_KEY = process.env.WEBHOOK_SEGREDO || EVO_KEY || '';
const whSig = inst => crypto.createHmac('sha256', WH_KEY).update('wh:' + inst).digest('hex').slice(0, 32);
const whUrl = inst => `${process.env.WEBHOOK_BASE || PUBLIC_URL}/webhook/${inst}?k=${whSig(inst)}`; // só o Evolution conhece esta chave
const redact = x => String(x || '').replace(/k=[0-9a-f]+/, 'k=•••');
async function ensureWebhook(inst) { // garante que o Evolution entrega as mensagens ao painel
  const base = process.env.WEBHOOK_BASE || PUBLIC_URL;
  if (!base) throw new Error('Defina WEBHOOK_BASE ou PUBLIC_URL para o recebimento das mensagens.');
  await evo(`/webhook/set/${inst}`, 'POST', { webhook: { enabled: true, url: whUrl(inst), byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] } });
}

// ---------- fila, envio e histórico ----------
function enqueue(inst, job, first) { const s = M(inst); job = { t: Date.now(), ...job }; first ? s.q.unshift(job) : s.q.push(job); if (s.q.length > 40) s.q.splice(0, s.q.length - 40); if (!s.running) run(inst, s); }
async function deliver(inst, u, job) { // envia uma oferta (com link rastreável) e registra no histórico; lança erro se falhar
  let text = job.text; const codes = [];
  if (PUBLIC_URL && u.rastrear !== false) for (const l of job.links) {
    const c = crypto.randomBytes(4).toString('hex');
    db.links[c] = { u: inst, url: l.link, t: Date.now() }; codes.push({ c, loja: l.loja });
    text = text.split(l.link).join(`${PUBLIC_URL}/r/${c}`);
  }
  try { await sendOffer(inst, job.to, text, job.image); }
  catch (e) { codes.forEach(x => delete db.links[x.c]); throw e; }
  bump(u); (u.log ||= []).unshift({ t: Date.now(), tipo: job.tipo, to: job.to, sub: job.sub || '', src: job.src || '', txt: job.text.slice(0, 160), lojas: [...new Set(job.links.map(l => l.loja))], codes, n: job.links.length });
  u.log.length = Math.min(u.log.length, 1000);
  if (P(u).anuncio && !isAdmin(u)) { // anúncio a cada N ofertas (não conta nos limites do plano)
    u.anuncioN = (u.anuncioN || 0) + 1;
    if (u.anuncioN % ANUNCIO_A_CADA === 0) { try { await enviarAnuncio(inst, job.to); } catch (e) { console.error(`[${inst}] anúncio falhou:`, e.message); } }
  }
  save();
}
function friendly(e) { // traduz erros técnicos para algo que o cliente entende
  const m = String(e?.message || e);
  if (/EVO_URL|EVO_KEY/.test(m)) return m;
  if (/fetch failed|ECONN|ENOTFOUND|timed? ?out|abort/i.test(m)) return 'Não consegui falar com o Evolution API. Confira EVO_URL e se ele está no ar (no Render gratuito ele dorme e leva cerca de 1 minuto para acordar).';
  if (/Evolution (401|403)/.test(m)) return 'O Evolution recusou a chave. Confira EVO_KEY.';
  if (/Evolution 404/.test(m)) return 'Instância do WhatsApp não encontrada. Abra “WhatsApp e grupos” e gere o QR code.';
  if (/Connection Closed|not connected|disconnected|state.{0,10}close/i.test(m)) return 'O WhatsApp está desconectado. Gere um novo QR code em “WhatsApp e grupos”.';
  if (/"exists":\s*false|not found|jid/i.test(m)) return 'Grupo não encontrado nessa conta. Carregue os grupos de novo e escolha outra vez.';
  return m.slice(0, 300);
}
async function run(inst, s) {
  s.running = true;
  try {
    while (s.q.length) {
      const job = s.q.shift(), u = db.users[inst];
      if (!u || acesso(u) !== 'ok' || !u.active) continue;
      s.atual = job;
      while (u.active && (semTempo(u) || !inWindow(u) || atLimit(u))) { note(inst, semTempo(u) ? 'Plano grátis: as 3 horas de robô de hoje acabaram. Volta amanhã.' : !inWindow(u) ? 'Aguardando o horário de pico escolhido para enviar.' : 'Aguardando: limite de envios do dia atingido.'); await sleep(30e3 * ESC); } // espera na fila
      if (!u.active) { s.atual = null; continue; }
      try { await deliver(inst, u, job); console.log(`[${inst}] postado (${job.tipo})`); note(inst, `Enviada para ${u.names?.[job.to] || job.to}.`, true); }
      catch (e) { console.error(`[${inst}] erro ao postar:`, e.message); note(inst, 'Falha ao enviar: ' + friendly(e)); }
      s.atual = null;
      await sleep(jitter(u));
    }
  } finally { s.running = false; s.atual = null; }
}
async function post(inst, u, base, opts = {}) { // um envio por grupo de destino, cada um com o seu Sub ID
  for (const to of (u.dests || []).slice(0, P(u).destinos)) { // o plano limita quantos grupos recebem
    try {
      const sub = subOf(u, to); let job;
      if (base.raw !== undefined) { // mensagem copiada: converte os links de novo para este grupo
        const r = await convert(base.raw, u, sub, true); if (!r.links.length) continue;
        const { raw, ...rest } = base; job = { ...rest, text: wrap(r.out, u), links: r.links };
      } else if (base.deal) { // oferta do robô: refaz o link da Shopee com o Sub ID do grupo (se falhar, usa o link padrão)
        let l = base.deal.offerLink;
        if (base.deal.productLink) { try { l = await shopeeLink(u.shopee, base.deal.productLink, sub); } catch { /* usa offerLink */ } }
        const { deal, ...rest } = base; job = { ...rest, text: base.text.split(deal.offerLink).join(l), links: [{ link: l, loja: 'shopee' }] };
      } else job = base;
      enqueue(inst, { ...job, to, sub }, opts.first);
    } catch (e) { console.error(`[${inst}] erro ao preparar envio:`, e.message); note(inst, 'Erro ao preparar o envio: ' + friendly(e), false, u.names?.[to] || ''); }
  }
}

// ---------- webhook: copiar dos grupos de origem ----------
const seenMsg = new Set();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "frame-ancestors 'none'" });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  next();
});
const bodyPadrao = express.json({ limit: '1mb', verify: (req, _res, buf) => { req.raw = buf; } });
app.use((req, res, next) => /^\/webhook\/[^/]+$/.test(req.path) ? next() : bodyPadrao(req, res, next)); // o webhook do Evolution tem corpo grande (fotos) e confere a chave antes de ler
app.use(express.static(path.join(dir, 'public')));

const whAuth = (req, res, next) => { const k = String(req.query.k || ''); if (!WH_KEY || !safeEq(k, whSig(req.params.inst))) return res.sendStatus(403); next(); };
app.post('/webhook/:inst', whAuth, express.json({ limit: '25mb' }), async (req, res) => {
  res.sendStatus(200);
  const inst = req.params.inst, u = db.users[inst], { event, data } = req.body || {};
  if (!u || !data || !/messages[._]upsert/i.test(event || '')) return;
  const s = M(inst); s.recebidas++; s.ultimoWebhook = Date.now();
  const src = data.key?.remoteJid, nome = u.names?.[src] || src || '';
  if (acesso(u) !== 'ok') return note(inst, 'Conta vencida ou bloqueada: o robô está parado.', false, nome);
  if (!u.sources?.slice(0, P(u).origens).includes(src)) { if (String(src).endsWith('@g.us')) note(inst, 'Mensagem de um grupo que não está marcado em “Copiar”.', false, nome); return; }
  if (!data.key?.id || seenMsg.has(data.key.id)) return;
  seenMsg.add(data.key.id); if (seenMsg.size > 5000) seenMsg.clear();
  const m = data.message || {};
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '';
  if (!/https?:\/\//.test(text)) return note(inst, 'Mensagem sem link, ignorada.', false, nome);
  const bloq = (u.mensagem?.bloquear || []).find(w => w && text.toLowerCase().includes(w.toLowerCase()));
  if (bloq) return note(inst, `Mensagem ignorada: tem a palavra bloqueada “${bloq}”.`, false, nome);
  const image = m.imageMessage ? m.base64 : null;
  s.inbox.unshift({ id: data.key.id, src, t: Date.now(), text, image }); s.inbox.length = Math.min(s.inbox.length, 40);
  if (!u.active) return note(inst, 'O robô está pausado. Ative em Automação.', false, nome);
  if (semTempo(u)) return note(inst, 'Plano grátis: as 3 horas de robô de hoje acabaram. Volta amanhã.', false, nome);
  if (!u.dests?.length) return note(inst, 'Não há grupo de destino marcado em “Postar”.', false, nome);
  const { links, keys } = await convert(text, u, subOf(u, u.dests[0]), true);
  if (!links.length) return note(inst, semLink(text), false, nome);
  const now = Date.now();
  for (const [k, t] of s.recent) if (now - t > 6 * 3600e3) s.recent.delete(k);
  if (keys.some(k => s.recent.has(k))) return note(inst, 'Oferta repetida (já enviada nas últimas 6 horas).', false, nome); // a mesma oferta em vários grupos sai uma vez
  keys.forEach(k => s.recent.set(k, now));
  const img = image || (u.mensagem?.buscarFoto !== false ? await ogImage(links[0].orig) : null); // sem foto na mensagem: tenta achar a do produto
  await post(inst, u, { raw: text, image: img, tipo: 'cópia', src });
  note(inst, 'Oferta recebida e colocada na fila de envio.', true, nome);
});

// ---------- robô de ofertas (Shopee) ----------
async function findDeals(inst, u) {
  const o = u.ofertas, s = M(inst), found = [];
  const pl = P(u).ofertas;
  for (const kw of o.keywords?.length ? o.keywords.slice(0, pl.keywords) : ['']) {
    const d = await shopeeQL(u.shopee, `{productOfferV2(${kw ? `keyword:${JSON.stringify(kw)},` : ''}sortType:2,page:1,limit:30){nodes{itemId productName offerLink productLink imageUrl priceMin priceMax priceDiscountRate commissionRate sales ratingStar}}}`);
    found.push(...(d.productOfferV2?.nodes || []));
  }
  return found.filter((p, i, a) => p.offerLink && Number(p.priceDiscountRate) >= o.minDiscount && Number(p.ratingStar) >= 4.5 && (!o.precoMin || Number(p.priceMin) >= o.precoMin) && (!o.precoMax || Number(p.priceMin) <= o.precoMax) && !s.sent.has(p.itemId) && a.findIndex(x => x.itemId === p.itemId) === i)
    .sort((a, b) => b.priceDiscountRate * Math.log10(b.sales + 10) - a.priceDiscountRate * Math.log10(a.sales + 10)).slice(0, Math.min(o.max, pl.max));
}
setInterval(async () => {
  for (const [inst, u] of Object.entries(db.users)) {
    const o = u.ofertas, s = M(inst);
    if (acesso(u) !== 'ok' || semTempo(u) || !u.active || !o?.active || !u.shopee?.secret || !u.dests?.length || !inWindow(u) || Date.now() < s.next) continue;
    s.next = Date.now() + Math.max(o.everyMin, P(u).ofertas.everyMin) * 60e3 * ESC;
    try {
      const deals = await findDeals(inst, u);
      note(inst, deals.length ? `Busca de ofertas: ${deals.length} oferta(s) da Shopee encontrada(s).` : 'Busca de ofertas: nenhuma oferta nova passou nos seus filtros.', deals.length > 0);
      for (const p of deals) {
        s.sent.add(p.itemId); if (s.sent.size > 3000) s.sent.clear();
        const preco = p.priceMin === p.priceMax || !p.priceMax ? brl(p.priceMin) : `${brl(p.priceMin)} a ${brl(p.priceMax)}`;
        const de = brl(p.priceMin / (1 - p.priceDiscountRate / 100));
        await post(inst, u, { deal: { offerLink: p.offerLink, productLink: p.productLink }, text: build({ titulo: String(p.productName).slice(0, 120), preco, de, desconto: p.priceDiscountRate, avaliacao: p.ratingStar, vendidos: p.sales, link: p.offerLink }, u), image: p.imageUrl, tipo: 'oferta' });
      }
    } catch (e) { console.error(`[${inst}] erro ao buscar ofertas:`, e.message); note(inst, 'Erro na busca de ofertas: ' + friendly(e)); }
  }
}, 60e3 * ESC);

// ---------- rastreio de cliques ----------
const BOT = /whatsapp|facebookexternalhit|bot|crawler|preview|curl/i;
app.get('/r/:c', (req, res) => {
  const l = db.links[req.params.c];
  if (!l) return res.status(404).send('Link não encontrado');
  if (!BOT.test(req.get('user-agent') || '')) { db.clicks.push({ c: req.params.c, t: Date.now() }); save(); }
  res.redirect(302, l.url);
});

// ---------- desempenho ----------
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
const br = t => { const p = Object.fromEntries(fmt.formatToParts(t).map(x => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, h: +p.hour, w: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) }; };
function stats(inst, u) {
  const cc = {}; for (const k of db.clicks) if (db.links[k.c]?.u === inst) cc[k.c] = (cc[k.c] || 0) + 1;
  const log = (u.log || []).map(e => ({ ...e, cl: e.codes.reduce((a, x) => a + (cc[x.c] || 0), 0) }));
  const dias = {}; for (let i = 13; i >= 0; i--) dias[br(Date.now() - i * 864e5).d] = { posts: 0, links: 0, cliques: 0 };
  const horas = Array.from({ length: 24 }, (_, h) => ({ h, posts: 0, cliques: 0 }));
  const semana = Array.from({ length: 7 }, (_, d) => ({ d, posts: 0, cliques: 0 }));
  const lojas = {}, dests = {}, srcs = {};
  for (const e of log) {
    const b = br(e.t), d = dias[b.d];
    if (d) { d.posts++; d.links += e.n; d.cliques += e.cl; }
    horas[b.h].posts++; horas[b.h].cliques += e.cl; semana[b.w].posts++; semana[b.w].cliques += e.cl;
    for (const x of e.codes) { (lojas[x.loja] ||= { links: 0, cliques: 0 }); lojas[x.loja].links++; lojas[x.loja].cliques += cc[x.c] || 0; }
    for (const l of e.lojas) if (!e.codes.length) (lojas[l] ||= { links: 0, cliques: 0 }).links++;
    const g = (dests[e.to] ||= { posts: 0, links: 0, cliques: 0 }); g.posts++; g.links += e.n; g.cliques += e.cl;
    if (e.src) { const s = (srcs[e.src] ||= { posts: 0, cliques: 0 }); s.posts++; s.cliques += e.cl; }
  }
  const nm = id => u.names?.[id] || id;
  const lst = o => Object.entries(o).map(([id, v]) => ({ id, nome: nm(id), sub: u.subids?.[id] || '', ...v, media: v.posts ? +(v.cliques / v.posts).toFixed(2) : 0 })).sort((a, b) => b.cliques - a.cliques);
  return { rastreio: !!PUBLIC_URL && u.rastrear !== false,
    total: { posts: log.length, links: log.reduce((a, e) => a + e.n, 0), cliques: log.reduce((a, e) => a + e.cl, 0) },
    dias: Object.entries(dias).map(([d, v]) => ({ d, ...v })),
    horas: horas.map(x => ({ ...x, media: x.posts ? +(x.cliques / x.posts).toFixed(2) : 0 })),
    lojas: Object.entries(lojas).map(([k, v]) => ({ loja: k, ...v })), grupos: lst(dests), origens: lst(srcs),
    semana: semana.map(x => ({ ...x, media: x.posts ? +(x.cliques / x.posts).toFixed(2) : 0 })),
    top: log.filter(e => e.cl > 0).sort((a, b) => b.cl - a.cl).slice(0, 8).map(e => ({ t: e.t, txt: e.txt, lojas: e.lojas, grupo: nm(e.to), cl: e.cl })) };
}

// ---------- API do painel ----------
const SESSAO_DIAS = 30;
const novaSessao = inst => { // o token vai só para o navegador; no servidor fica apenas o hash, com validade
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(t)] = { inst, criado: Date.now(), exp: Date.now() + SESSAO_DIAS * 864e5 };
  Object.entries(db.sessions).filter(([, x]) => x.inst === inst).sort((a, b) => b[1].criado - a[1].criado).slice(10).forEach(([h]) => delete db.sessions[h]);
  save(); return t;
};
const fimSessoes = inst => { for (const [h, x] of Object.entries(db.sessions)) if (x.inst === inst) delete db.sessions[h]; };
setInterval(() => { // conta o tempo de robô ligado dos planos com limite de horas por dia
  const now = Date.now();
  for (const [inst, u] of Object.entries(db.users)) {
    const s = M(inst), dt = Math.min(now - (s.tUso || now), 60e3); s.tUso = now;
    if (!P(u).horasDia || !u.active || acesso(u) !== 'ok') continue;
    const x = usoHoje(u), antes = x.ms; x.ms += dt;
    if (antes < tempoMs(u) && x.ms >= tempoMs(u)) { s.q.length = 0; note(inst, 'Plano grátis: as 3 horas de robô de hoje acabaram. As ofertas na fila foram descartadas. Volta amanhã.'); }
    save();
  }
}, 15e3);
setInterval(() => { const n = Date.now(); for (const [h, x] of Object.entries(db.sessions)) if (x.exp < n) delete db.sessions[h]; for (const [h, x] of Object.entries(db.resets || {})) if (x.exp < n) delete db.resets[h]; save(); }, 3600e3);
const auth = (req, res, next) => {
  const t = req.get('x-token'), h = typeof t === 'string' && t.length >= 32 && t.length <= 128 ? sha(t) : null, ss = h && db.sessions[h];
  if (!ss || ss.exp < Date.now() || !db.users[ss.inst]) { if (ss) { delete db.sessions[h]; save(); } return res.status(401).json({ erro: 'Sessão expirada. Entre de novo.' }); }
  if (ss.exp - Date.now() < SESSAO_DIAS * 432e5) { ss.exp = Date.now() + SESSAO_DIAS * 864e5; save(); } // renova quando passou da metade
  req.inst = ss.inst; req.u = db.users[ss.inst]; req.sessao = h; next();
};
// ---------- conta: cadastro, entrada e recuperação de senha ----------
const CADASTRO_ABERTO = process.env.CADASTRO_ABERTO === '1'; // 1 = qualquer pessoa cria conta pelo site; o convite vale só para o admin
const { SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS, SMTP_FROM, CONVITE } = process.env;
const mailer = SMTP_HOST ? nodemailer.createTransport({ host: SMTP_HOST, port: +SMTP_PORT, secure: +SMTP_PORT === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const okPw = (u, pw) => { const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const findEmail = e => Object.entries(db.users).find(([, u]) => u.email === e);
const tries = new Map();
function limited(key) { if (tries.size > 5000) tries.clear(); const now = Date.now(), t = (tries.get(key) || []).filter(x => now - x < 15 * 60e3); t.push(now); tries.set(key, t); return t.length > 8; }
const limpaNome = n => String(n || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 40);
const tooMany = res => res.status(429).json({ erro: 'Muitas tentativas. Tente de novo em alguns minutos.' });

app.post('/api/register', (req, res) => {
  const { email = '', senha = '', convite = '', aceito = false, nome = '' } = req.body || {}, e = String(email).trim().toLowerCase();
  const erro = m => res.status(400).json({ erro: m });
  if (limited(req.ip + 'r')) return tooMany(res);
  const ehAdmin = ADMIN_EMAIL && e === ADMIN_EMAIL;
  if (CONVITE && (!CADASTRO_ABERTO || ehAdmin) && !safeEq(String(convite), CONVITE)) return erro('Código de convite inválido');
  if (ADMIN_EMAIL && e === ADMIN_EMAIL && (!CONVITE || CONVITE.length < 12)) return erro('Para criar a conta de administrador, defina no .env um CONVITE forte (mínimo 12 caracteres) e reinicie.');
  if (aceito !== true) return erro('Aceite os termos para criar a conta');
  if (!emailOk(e)) return erro('E-mail inválido');
  if (String(senha).length < 8) return erro('A senha precisa ter pelo menos 8 caracteres');
  if (findEmail(e)) return erro('Este e-mail já está cadastrado');
  const salt = crypto.randomBytes(16).toString('hex'), inst = 'u' + crypto.randomBytes(5).toString('hex');
  db.users[inst] = { email: e, nome: limpaNome(nome), salt, hash: hashPw(String(senha), salt), criado: Date.now(), termosEm: Date.now(), expira: Date.now() + TRIAL_DIAS * 864e5, plano: 'teste', protecao: { limiteDia: 150, aquecimento: true, variar: true }, active: false, delay: 60, rastrear: true,
    sources: [], dests: [], ids: {}, templates: {}, shopee: {}, log: [],
    ofertas: { active: false, everyMin: PLANOS.teste.ofertas.everyMin, max: PLANOS.teste.ofertas.max, minDiscount: 30, keywords: [] },
    mensagem: { modelo: 'classico', limparConvites: true, buscarFoto: true }, horarios: { ativo: false, horas: [] } };
  res.json({ token: novaSessao(inst) });
});
app.post('/api/login', (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  if (limited(req.ip + 'l') || limited('em:' + em)) return tooMany(res);
  const f = findEmail(em);
  if (!f || !f[1].hash) { hashPw(String(req.body?.senha || ''), 'x'.repeat(32)); return res.status(401).json({ erro: 'E-mail ou senha incorretos' }); } // gasta o mesmo tempo para não revelar quais e-mails existem
  if (!okPw(f[1], String(req.body.senha || ''))) return res.status(401).json({ erro: 'E-mail ou senha incorretos' });
  res.json({ token: novaSessao(f[0]) });
});
app.post('/api/forgot', async (req, res) => {
  res.json({ ok: true }); // sempre a mesma resposta, para não revelar quem tem conta
  if (limited(req.ip + 'f')) return;
  const f = findEmail(String(req.body.email || '').trim().toLowerCase());
  if (!f) return;
  const raw = crypto.randomBytes(24).toString('hex');
  (db.resets ||= {})[sha(raw)] = { inst: f[0], exp: Date.now() + 3600e3 }; save();
  const link = `${PUBLIC_URL}/?reset=${raw}`;
  try {
    if (mailer) await mailer.sendMail({ from: SMTP_FROM || SMTP_USER, to: f[1].email, subject: 'Recuperação de senha',
      text: `Para criar uma nova senha, abra o link (vale por 1 hora):\n${link}\n\nSe você não pediu isso, ignore este e-mail.` });
    else console.log('[recuperação de senha] SMTP não configurado. Link:', link);
  } catch (e) { console.error('erro ao enviar e-mail:', e.message); }
});
app.post('/api/reset', (req, res) => {
  const { token = '', senha = '' } = req.body, r = db.resets?.[sha(String(token))];
  if (!r || r.exp < Date.now()) return res.status(400).json({ erro: 'Link inválido ou expirado' });
  if (String(senha).length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres' });
  const u = db.users[r.inst];
  if (!u) return res.status(400).json({ erro: 'Link inválido ou expirado' });
  u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(String(senha), u.salt);
  fimSessoes(r.inst); // sessões antigas deixam de valer
  delete db.resets[sha(String(token))]; res.json({ token: novaSessao(r.inst) });
});

async function mail(to, subject, text) {
  try { if (mailer) await mailer.sendMail({ from: SMTP_FROM || SMTP_USER, to, subject, text }); else console.log('[e-mail]', to, '|', subject, '|', text); }
  catch (e) { console.error('erro ao enviar e-mail:', e.message); }
}

// Webhook de pagamento (Hotmart ou Kiwify). URL: PUBLIC_URL/webhook/pagamento/PAGAMENTO_SEGREDO
// Além do segredo na URL, exige a assinatura da plataforma: Hotmart envia o "hottok" (HOTMART_HOTTOK); Kiwify assina o corpo com HMAC (KIWIFY_TOKEN).
const HOTTOK = process.env.HOTMART_HOTTOK || '', KIWIFY_TOKEN = process.env.KIWIFY_TOKEN || '';
const APROVADO = new Set(['purchase_approved', 'order_approved', 'subscription_renewed', 'approved', 'paid']); // igualdade exata: "not_approved" e "not_paid" NÃO contam
const ENCERRA = new Set(['purchase_refunded', 'purchase_chargeback', 'order_refunded', 'refunded', 'chargeback', 'chargedback']);
function pagamentoAutentico(req) {
  const hot = req.get('x-hotmart-hottok') || req.body?.hottok;
  if (hot) return !!HOTTOK && safeEq(String(hot), HOTTOK);
  const sig = req.query.signature;
  if (sig && KIWIFY_TOKEN && req.raw) return safeEq(String(sig), crypto.createHmac('sha1', KIWIFY_TOKEN).update(req.raw).digest('hex'));
  return false;
}
app.post('/webhook/pagamento/:segredo', (req, res) => {
  if (!process.env.PAGAMENTO_SEGREDO || !safeEq(req.params.segredo, process.env.PAGAMENTO_SEGREDO)) return res.sendStatus(403);
  if (!pagamentoAutentico(req)) { console.error('[pagamento] recusado: assinatura da plataforma ausente ou inválida (confira HOTMART_HOTTOK / KIWIFY_TOKEN)'); return res.sendStatus(403); }
  res.sendStatus(200);
  const b = req.body || {};
  const email = String(b.data?.buyer?.email || b.Customer?.email || b.customer?.email || b.email || '').trim().toLowerCase();
  const status = String(b.event || b.webhook_event_type || b.order_status || b.status || b.data?.purchase?.status || '').trim().toLowerCase();
  const f = findEmail(email);
  if (!f) return console.log('[pagamento] e-mail sem conta:', email || '(não encontrado no corpo)', '| status:', status);
  const u = f[1];
  const tx = String(b.data?.purchase?.transaction || b.data?.transaction || b.order_id || b.id || ''), chave = tx && tx + ':' + status;
  db.pagamentos ||= [];
  if (chave && db.pagamentos.includes(chave)) return console.log('[pagamento] evento repetido, ignorado:', chave); // a plataforma pode reenviar o mesmo aviso
  if (chave) { db.pagamentos.push(chave); if (db.pagamentos.length > 2000) db.pagamentos.shift(); }
  if (APROVADO.has(status)) { // PURCHASE_COMPLETE (Hotmart) não soma de novo; renovações somam
    const ids = [b.data?.product?.id, b.data?.product?.ucode, b.data?.purchase?.offer?.code, b.Product?.product_id, b.Subscription?.plan?.id, b.Subscription?.plan?.name].map(x => String(x ?? '').trim().toLowerCase()).filter(Boolean);
    const plano = ids.some(i => PRODUTOS.plano2.includes(i)) ? 'plano2' : ids.some(i => PRODUTOS.plano1.includes(i)) ? 'plano1' : null;
    if (!plano) console.log('[pagamento] produto não identificado (confira PRODUTO_PLANO1/PRODUTO_PLANO2). IDs recebidos:', ids.join(', ') || '(nenhum)');
    u.plano = plano || (['plano1', 'plano2'].includes(u.plano) ? u.plano : 'plano1');
    u.expira = Math.max(u.expira || 0, Date.now()) + 30 * 864e5; console.log('[pagamento] +30 dias para', email, '→', u.plano);
  } else if (ENCERRA.has(status)) { u.expira = Date.now(); fimSessoes(f[0]); console.log('[pagamento] acesso encerrado para', email); }
  else console.log('[pagamento] evento sem efeito:', status, '| e-mail:', email);
  save();
});

// ---------- teste grátis: pergunta no dia 7, resumo de valor e bônus no último dia ----------
const MIN_POR_POST = +(process.env.MINUTOS_POR_POST || 3); // minutos que uma oferta leva para ser achada, convertida, escrita e postada à mão (estimativa)
const CUPOM = { codigo: process.env.CUPOM_CODIGO || 'PRO10', pct: +(process.env.CUPOM_PERCENTUAL || 10), link: process.env.LINK_PLANO2_CUPOM || process.env.LINK_PLANO2 || process.env.LINK_ASSINATURA || '' };
const diaDoTeste = u => Math.floor((Date.now() - (u.criado || 0)) / 864e5) + 1;
function valorTeste(u) {
  const ini = u.criado || 0, l = (u.log || []).filter(e => e.t >= ini), codes = new Set(l.flatMap(e => (e.codes || []).map(x => x.c)));
  let cliques = 0; if (codes.size) for (const k of db.clicks) if (codes.has(k.c)) cliques++;
  const dias = Math.max(1, Math.min(TRIAL_DIAS, Math.ceil((Date.now() - ini) / 864e5))), horas = l.length * MIN_POR_POST / 60;
  return { posts: l.length, links: l.reduce((a, e) => a + e.n, 0), cliques, horas: +horas.toFixed(1), horasMes: +(horas / dias * 30).toFixed(1), minPorPost: MIN_POR_POST };
}
const resumoValor = v => v.posts ? `Nestes dias o Linkfly postou ${v.posts} oferta(s) com ${v.links} link(s) com o SEU ID${v.cliques ? `, que já receberam ${v.cliques} clique(s)` : ''}. Isso equivale a cerca de ${String(v.horas).replace('.', ',')} h de trabalho poupado (estimativa de ${v.minPorPost} min por oferta). No mesmo ritmo, seriam ~${String(v.horasMes).replace('.', ',')} h por mês.` : 'Você ainda não postou ofertas pelo Linkfly. Conecte o WhatsApp, escolha os grupos e ligue o robô: em poucos minutos ele começa a postar com o seu ID.';
const precoPlanos = `Plano Plus: ${brl(PLANOS.plano1.preco)}/mês (cerca de ${brl(PLANOS.plano1.preco / 30)} por dia). Plano Pro (Pro): ${brl(PLANOS.plano2.preco)}/mês (cerca de ${brl(PLANOS.plano2.preco / 30)} por dia), com envios ilimitados, "Enviar agora" ilimitado, ${PLANOS.plano2.destinos} grupos de destino, busca de ofertas mais rápida e relatórios. Você pode testar o Plano Pro por ${TRIAL_P2_DIAS} dias, grátis, em Planos no painel.`;
const painel = PUBLIC_URL ? `\n\nAbrir o painel: ${PUBLIC_URL}` : '';
async function campanhas() {
  const now = Date.now();
  for (const u of Object.values(db.users)) {
    if (isAdmin(u) || u.bloqueado || !u.email) continue;
    const m = (u.msgs ||= {}), nome = u.nome ? `Olá, ${u.nome}!` : 'Olá!';
    if (u.testeP2?.ate > now && u.testeP2.ate - now <= 864e5 && !m.p2aviso && planoBase(u) !== 'plano2') { // o teste do Plano Pro acaba em menos de 24 h
      m.p2aviso = now; save();
      await mail(u.email, 'Linkfly: seu teste do Plano Pro termina em breve', `${nome}\n\nSeu teste do Plano Pro termina em menos de 24 horas. Depois disso a sua conta volta aos limites do ${PLANOS[planoBase(u)].nome}.\n\n${resumoValor(valorTeste(u))}\n\n${precoPlanos}${painel}`);
    }
    if (planoBase(u) !== 'teste' || !u.expira) continue;
    const v = valorTeste(u);
    if (diaDoTeste(u) >= 7 && !m.dia7 && u.expira > now) {
      m.dia7 = now; save();
      await mail(u.email, 'Linkfly: o que você está achando?', `${nome}\n\nVocê está no dia ${diaDoTeste(u)} do seu teste grátis. Queremos saber: o que achou até agora? O que está faltando? Responda no próprio painel (aparece um aviso logo no topo).\n\n${resumoValor(v)}\n\n${precoPlanos}${painel}`);
    }
    if (u.expira - now <= 864e5 && u.expira - now > -864e5 && m.ultimo !== u.expira) {
      m.ultimo = u.expira; u.bonus = { codigo: CUPOM.codigo, pct: CUPOM.pct, ate: now + 864e5 }; save();
      await mail(u.email, 'Linkfly: seu teste termina hoje (bônus de 24 horas)', `${nome}\n\nSeu teste grátis termina hoje e, depois disso, o robô será pausado.\n\n${resumoValor(v)}\n\nBônus só pelas próximas 24 horas: ${CUPOM.pct}% de desconto no Plano Pro (Pro) com o cupom ${CUPOM.codigo}.\n\n${precoPlanos}${painel}${CUPOM.link ? `\nAssinar o Pro com desconto: ${CUPOM.link}` : ''}`);
    }
  }
}
setInterval(campanhas, 3600e3 * ESC); setTimeout(campanhas, 30e3);
function campanhaDe(u) { // o que o painel mostra: pergunta do dia 7 ou bônus do último dia
  if (isAdmin(u) || planoBase(u) !== 'teste') return null;
  const now = Date.now(), m = u.msgs || {}, bonus = u.bonus && u.bonus.ate > now ? { ...u.bonus, link: CUPOM.link } : null;
  const feedback = !bonus && diaDoTeste(u) >= 7 && !m.feedbackEm && !m.feedbackFechado && (u.expira || 0) > now;
  if (!bonus && !feedback) return null;
  return { dia: diaDoTeste(u), valor: valorTeste(u), bonus, feedback, restamMs: (u.expira || 0) - now };
}

// avisa por e-mail quando o WhatsApp do cliente desconecta
setInterval(async () => {
  for (const [inst, u] of Object.entries(db.users)) {
    if (!u.sources?.length && !u.dests?.length) continue;
    try {
      const st = (await evo(`/instance/connectionState/${inst}`)).instance?.state;
      if (st === 'open') { if (!u.conectadoEm) { u.conectadoEm = Date.now(); save(); } u.desconAlerta = false; }
      else if (u.active && u.conectadoEm && !u.desconAlerta && u.email) {
        u.desconAlerta = true; save();
        mail(u.email, 'Linkfly: seu WhatsApp desconectou', 'O robô parou de postar porque o WhatsApp foi desconectado. Entre no painel, abra "WhatsApp e grupos" e gere um novo QR code.');
      }
    } catch { /* Evolution fora do ar: tenta de novo no próximo ciclo */ }
  }
}, 5 * 60e3 * ESC);

// cópia diária do banco (guarda as últimas 7)
const backup = () => {
  try {
    const d = new Date().toISOString().slice(0, 10), f = `${DB}.bak-${d}`, dir0 = path.dirname(path.resolve(DB));
    if (!fs.existsSync(DB) || fs.existsSync(f)) return;
    fs.copyFileSync(DB, f);
    fs.readdirSync(dir0).filter(x => x.startsWith(path.basename(DB) + '.bak-')).sort().slice(0, -7).forEach(x => fs.unlinkSync(path.join(dir0, x)));
  } catch (e) { console.error('backup:', e.message); }
};
setInterval(backup, 6 * 3600e3); setTimeout(backup, 60e3);

const api = express.Router(); api.use(auth); app.use('/api', api);

api.post('/logout', (req, res) => { delete db.sessions[req.sessao]; save(); res.json({ ok: true }); });
api.post('/feedback', (req, res) => {
  const nota = Math.round(+req.body?.nota), u = req.u;
  if (!(nota >= 1 && nota <= 5)) return res.status(400).json({ erro: 'Escolha uma nota de 1 a 5' });
  (db.feedback ||= []).push({ inst: req.inst, email: u.email, t: Date.now(), dia: diaDoTeste(u), nota, comentario: txt(req.body?.comentario, 500) });
  if (db.feedback.length > 2000) db.feedback.shift();
  (u.msgs ||= {}).feedbackEm = Date.now(); save(); res.json({ ok: true });
});
api.post('/teste-plano2', (req, res) => { // começa o teste de 5 dias do Plano Pro (uma vez por conta)
  const u = req.u;
  if (!podeTesteP2(u)) return res.status(400).json({ erro: planoBase(u) === 'plano2' ? 'Você já está no Plano Pro.' : u.testeP2?.usado ? `Você já usou o teste de ${TRIAL_P2_DIAS} dias do Plano Pro.` : 'Sua conta está vencida ou bloqueada. Assine um plano para continuar.' });
  const now = Date.now(), ate = now + TRIAL_P2_DIAS * 864e5;
  u.testeP2 = { desde: now, ate, usado: true };
  if (planoBase(u) === 'teste') u.expira = Math.max(u.expira || 0, ate); // quem está no teste grátis não perde dias do Plano Pro por o prazo grátis acabar antes
  save(); res.json({ ok: true, ate });
});
api.post('/campanha/fechar', (req, res) => { (req.u.msgs ||= {}).feedbackFechado = true; save(); res.json({ ok: true }); });
api.get('/me', (req, res) => {
  (req.u.dests || []).forEach(d => subOf(req.u, d)); // todo grupo de destino já aparece com o seu Sub ID
  const { shopee, hash, salt, ...cfg } = req.u; delete cfg.log; delete cfg.nota; // a anotação do administrador não vai para o cliente
  res.json({ ...cfg, shopee: { appId: shopee?.appId || '', temSecret: !!shopee?.secret }, rastreioDisponivel: !!PUBLIC_URL, avisos: WARN, admin: isAdmin(req.u), acesso: acesso(req.u), linkAssinatura: process.env.LINK_ASSINATURA || '',
    campanha: campanhaDe(req.u), plano: planoBase(req.u), planoEfetivo: planoDe(req.u), planoInfo: P(req.u),
    testeP2: { ativo: testeP2Ativo(req.u), ate: testeP2Ativo(req.u) ? req.u.testeP2.ate : null, usado: !!req.u.testeP2?.usado, disponivel: podeTesteP2(req.u), dias: TRIAL_P2_DIAS }, planos: PLANOS, linksPlano: { plano1: process.env.LINK_PLANO1 || process.env.LINK_ASSINATURA || '', plano2: process.env.LINK_PLANO2 || process.env.LINK_ASSINATURA || '' } });
});
const txt = (v, n) => String(v ?? '').slice(0, n);
const lista = (v, n, t) => (Array.isArray(v) ? v : []).map(x => txt(x, t)).slice(0, n);
api.put('/config', (req, res) => {
  const u = req.u, b = req.body || {}, erro = e => res.status(400).json({ erro: e }), pl = P(u), up = ' Veja os planos no menu Planos.';
  if (b.delay !== undefined && !DELAYS.includes(b.delay)) return erro('Intervalo deve ser 10, 30 ou 60 segundos');
  if (b.delay !== undefined && !pl.delays.includes(b.delay)) return erro('Esse intervalo não está disponível no seu plano.' + up);
  if (b.sources !== undefined) b.sources = lista(b.sources, 50, 100);
  if (b.dests !== undefined) b.dests = lista(b.dests, 50, 100);
  const src = b.sources ?? u.sources ?? [], dst = b.dests ?? u.dests ?? [];
  if (src.length > 10) return erro('Escolha de 1 a 10 grupos de origem');
  if (b.sources !== undefined && src.length > pl.origens) return erro(`Seu plano permite ${pl.origens} grupo(s) de origem (copiar).` + up);
  if (b.dests !== undefined && dst.length > pl.destinos) return erro(`Seu plano permite ${pl.destinos} grupo(s) de destino (postar).` + up);
  if (src.some(g => dst.includes(g))) return erro('Um grupo não pode ser origem e destino ao mesmo tempo');
  const o = b.ofertas;
  if (o) {
    if (!EVERY.includes(o.everyMin) || !MAXES.includes(o.max) || !(o.minDiscount >= 10 && o.minDiscount <= 90)) return erro('Configuração de ofertas inválida');
    const kw = lista(o.keywords, 10, 60).filter(Boolean);
    if (kw.length > pl.ofertas.keywords) return erro(`Seu plano permite ${pl.ofertas.keywords} palavra(s)-chave na busca de ofertas.` + up);
    if (o.max > pl.ofertas.max) return erro(`Seu plano permite até ${pl.ofertas.max} oferta(s) por busca.` + up);
    if (o.everyMin < pl.ofertas.everyMin) return erro(`Seu plano busca ofertas no mínimo a cada ${pl.ofertas.everyMin} minutos.` + up);
    b.ofertas = { active: !!o.active, everyMin: o.everyMin, max: o.max, minDiscount: +o.minDiscount, keywords: kw, precoMin: Math.max(0, +o.precoMin || 0), precoMax: Math.max(0, +o.precoMax || 0) };
    if (o.active && !(b.shopee?.secret || u.shopee?.secret)) return erro('Para buscar ofertas, informe o App ID e o Secret da Shopee');
  }
  if (b.protecao) b.protecao = { limiteDia: Math.min(pl.enviosDia, TETO, Math.max(10, +b.protecao.limiteDia || 150)), aquecimento: b.protecao.aquecimento !== false, variar: b.protecao.variar !== false };
  if (b.horarios) {
    if (!Array.isArray(b.horarios.horas) || b.horarios.horas.some(h => !Number.isInteger(h) || h < 0 || h > 23)) return erro('Horários inválidos');
    if (b.horarios.ativo && !pl.horarios) return erro('Horários de pico estão disponíveis a partir do Plano Plus.' + up);
    b.horarios = { ativo: !!b.horarios.ativo, horas: [...new Set(b.horarios.horas)] };
  }
  if (b.mensagem) {
    const m = b.mensagem;
    if (m.modelo === 'custom' && !pl.modeloCustom) return erro('Mensagem personalizada está disponível a partir do Plano Plus.' + up);
    b.mensagem = { modelo: ['classico', 'minimal', 'urgencia', 'custom'].includes(m.modelo) ? m.modelo : 'classico', limparConvites: m.limparConvites !== false, buscarFoto: m.buscarFoto !== false, bloquear: lista(m.bloquear, 20, 60) };
    for (const k of ['custom', 'topo', 'rodape', 'cupom']) b.mensagem[k] = txt(m[k], 800);
  }
  if (b.ids) b.ids = Object.fromEntries(['amazon', 'ml', 'magalu'].map(k => [k, txt(b.ids[k], 80).trim()]));
  if (b.templates) b.templates = Object.fromEntries(['aliexpress', 'shein'].map(k => [k, /^https?:\/\//.test(txt(b.templates[k], 600).trim()) ? txt(b.templates[k], 600).trim() : '']));
  if (b.shopee?.secret && !KEY) return erro('O servidor está sem SEGREDO_CHAVE; defina no .env para guardar o Secret da Shopee com criptografia.');
  if (b.subids) {
    if (!pl.relatorios) return erro('Sub ID personalizado está disponível no Plano Pro. O código automático de cada grupo continua funcionando.' + up);
    const novo = {};
    for (const [g, v] of Object.entries(b.subids)) {
      const c = cleanSub(v); if (!c) continue;
      if (c.length < 3) return erro('O Sub ID precisa ter de 3 a 20 letras ou números (sem espaços ou símbolos)');
      novo[g] = c;
    }
    const junto = { ...u.subids, ...novo }, vistos = new Set();
    for (const c of Object.values(junto)) { if (vistos.has(c.toLowerCase())) return erro('Dois grupos estão com o mesmo Sub ID. Cada grupo precisa de um diferente.'); vistos.add(c.toLowerCase()); }
    b.subids = junto;
  }
  if (b.nome !== undefined) u.nome = limpaNome(b.nome);
  if (b.tema === 'light' || b.tema === 'dark') u.tema = b.tema;
  Object.assign(u, { sources: src, dests: dst });
  for (const k of ['subids', 'ids', 'templates', 'delay', 'rastrear', 'ofertas', 'mensagem', 'horarios', 'protecao']) if (b[k] !== undefined) u[k] = b[k];
  if (b.active !== undefined) u.active = !!b.active;
  if (b.shopee) u.shopee = { appId: txt(b.shopee.appId ?? u.shopee?.appId, 80), secret: b.shopee.secret ? txt(b.shopee.secret, 200) : u.shopee?.secret };
  dst.forEach(d => subOf(u, d)); save(); res.json({ ok: true, aviso: WARN[u.delay] });
});
api.get('/status', async (req, res) => {
  try { res.json({ estado: (await evo(`/instance/connectionState/${req.inst}`)).instance?.state || 'desconhecido' }); }
  catch (e) { res.json({ estado: e.status === 404 ? 'sem_instancia' : 'erro' }); }
});
api.get('/qr', async (req, res) => {
  try {
    try { const c = await evo(`/instance/connect/${req.inst}`); ensureWebhook(req.inst).catch(e => console.error('webhook/set:', e.message)); return res.json(c); }
    catch (e) { if (e.status !== 404) throw e; }
    await evo('/instance/create', 'POST', { instanceName: req.inst, integration: 'WHATSAPP-BAILEYS', qrcode: true,
      webhook: { enabled: true, url: whUrl(req.inst), byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] } });
    await ensureWebhook(req.inst).catch(e => console.error('webhook/set:', e.message));
    res.json(await evo(`/instance/connect/${req.inst}`));
  } catch (e) { res.status(502).json({ erro: e.message }); }
});
api.get('/groups', async (req, res) => {
  try {
    const g = await evo(`/group/fetchAllGroups/${req.inst}?getParticipants=false`);
    req.u.names = { ...req.u.names, ...Object.fromEntries(g.map(x => [x.id, x.subject])) }; save();
    res.json(g.map(x => ({ id: x.id, nome: x.subject })));
  } catch (e) { res.status(502).json({ erro: e.message }); }
});
api.get('/inbox', (req, res) => res.json(M(req.inst).inbox.map(({ image, ...m }) => ({ ...m, imagem: !!image, grupo: req.u.names?.[m.src] || m.src }))));
api.post('/convert', async (req, res) => { try { const r = await compor(String(req.body?.text || ''), req.u, subOf(req.u, req.u.dests?.[0]), false, null); res.json({ out: r.text, n: r.n, lojas: [...new Set(r.links.map(l => l.loja))], foto: !!r.image, modelo: !!r.linkOnly }); } catch (e) { res.status(500).json({ erro: friendly(e) }); } });
const NOME = { amazon: 'Amazon', ml: 'Mercado Livre', magalu: 'Magazine Luiza', shopee: 'Shopee (App ID e Secret)', aliexpress: 'AliExpress', shein: 'Shein' };
function semLink(raw) {
  const hosts = (raw.match(/https?:\/\/[^\s<>"]+/g) || []).map(x => { try { return new URL(x).hostname.toLowerCase(); } catch { return ''; } });
  if (!hosts.length) return 'Não encontrei nenhum link na mensagem.';
  const lojas = STORES.filter(st => hosts.some(h => st.test(h)));
  if (lojas.length) return `Falta cadastrar o ID de ${lojas.map(st => NOME[st.k]).join(', ')} no menu Lojas.`;
  return 'Não reconheci a loja desse link. Se for um link encurtado, cole o link completo do produto.';
}
api.post('/send', async (req, res) => { // enviar uma oferta agora: não passa pela fila nem pelos horários
  try {
    const { text, inboxId, to } = req.body || {}, u = req.u;
    if (acesso(u) !== 'ok') return res.status(403).json({ erro: 'Assinatura vencida ou conta bloqueada' });
    const dests = (Array.isArray(to) && to.length ? to.map(x => txt(x, 100)) : u.dests || []);
    if (dests.length > P(u).destinos) return res.status(400).json({ erro: `Seu plano permite enviar para ${P(u).destinos} grupo(s) por vez. Veja os planos no menu Planos.` });
    if (!dests.length) return res.status(400).json({ erro: 'Escolha ao menos um grupo de destino' });
    const ag = P(u).agoraDia; if (ag) { const d = br(Date.now()).d; if (u.agora?.d !== d) u.agora = { d, n: 0 }; if (u.agora.n >= ag) return res.status(429).json({ erro: `Seu plano permite ${ag} envios por dia no “Enviar agora” e você já usou todos hoje. Amanhã libera de novo, ou assine o Plano Pro para ter envios ilimitados.` }); }
    const item = inboxId ? M(req.inst).inbox.find(m => m.id === inboxId) : null;
    const raw = String(text || item?.text || ''), strict = !text || (!!item && String(text) === item.text); // texto de outro grupo: só passam links convertidos
    const first = await compor(raw, u, subOf(u, dests[0]), strict, item?.image);
    if (!first.links.length) return res.status(400).json({ erro: semLink(raw) });
    const falhas = []; let enviados = 0;
    for (const [i, d] of dests.entries()) {
      if (i) await sleep(Math.min(jitter(u), 15e3)); // pausa curta entre grupos
      try { const r = i ? await compor(raw, u, subOf(u, d), strict, item?.image) : first; await deliver(req.inst, u, { text: r.text, links: r.links, image: r.image, tipo: 'manual', to: d, sub: subOf(u, d) }); enviados++; }
      catch (e) { console.error(`[${req.inst}] envio manual falhou:`, e.message); falhas.push({ grupo: u.names?.[d] || d, erro: friendly(e) }); }
    }
    if (!enviados) return res.status(502).json({ erro: falhas[0].erro });
    if (ag) { u.agora.n++; save(); }
    res.json({ ok: true, enviados, falhas, restam: ag ? ag - u.agora.n : null });
  } catch (e) { console.error('erro em /send:', e); res.status(500).json({ erro: friendly(e) }); }
});
api.get('/diagnostico', async (req, res) => {
  const s = M(req.inst); let webhook, estado = 'desconhecido';
  try { const r = await evo(`/webhook/find/${req.inst}`), w = r?.webhook || r || {}; webhook = { url: w.url || '', enabled: !!w.url && w.enabled !== false, events: w.events || [] }; } catch (e) { webhook = { erro: friendly(e) }; }
  try { estado = (await evo(`/instance/connectionState/${req.inst}`)).instance?.state || 'desconhecido'; } catch (e) { estado = e.status === 404 ? 'sem_instancia' : 'erro'; }
  res.json({ estado, webhook: { ...webhook, url: redact(webhook.url) }, webhookOk: !!webhook.enabled && webhook.url === whUrl(req.inst), esperado: redact(whUrl(req.inst)), recebidas: s.recebidas, ultimoWebhook: s.ultimoWebhook, fila: s.q.length, eventos: s.diag });
});
api.post('/webhook/reset', async (req, res) => { try { await ensureWebhook(req.inst); res.json({ ok: true }); } catch (e) { res.status(502).json({ erro: friendly(e) }); } });
api.get('/log', (req, res) => { const cc = {}; for (const k of db.clicks) cc[k.c] = (cc[k.c] || 0) + 1; res.json((req.u.log || []).slice(0, 200).map(e => ({ ...e, grupo: req.u.names?.[e.to] || e.to, cliques: e.codes.reduce((a, x) => a + (cc[x.c] || 0), 0) }))); });
api.get('/stats', (req, res) => res.json(stats(req.inst, req.u)));

// ---------- saúde do robô, fila de envio e resumo da semana ----------
api.get('/saude', async (req, res) => {
  const u = req.u, s = M(req.inst), now = Date.now();
  const [st, wh] = await Promise.allSettled([evo(`/instance/connectionState/${req.inst}`), evo(`/webhook/find/${req.inst}`)]);
  const estado = st.status === 'fulfilled' ? st.value.instance?.state || 'desconhecido' : (st.reason?.status === 404 ? 'sem_instancia' : 'erro');
  const w = wh.status === 'fulfilled' ? wh.value?.webhook || wh.value || {} : null;
  const webhookOk = !!w && !!w.url && w.enabled !== false && w.url === whUrl(req.inst);
  const temLoja = !!(Object.values(u.ids || {}).some(Boolean) || Object.values(u.templates || {}).some(Boolean) || u.shopee?.secret);
  const copia = !!u.sources?.length, ofe = !!(u.ofertas?.active && u.shopee?.secret);
  const passos = [
    { id: 'acesso', ok: acesso(u) === 'ok', txt: acesso(u) === 'bloqueado' ? 'Conta bloqueada' : 'Assinatura em dia', acao: 'assinatura' },
    { id: 'whatsapp', ok: estado === 'open', txt: estado === 'open' ? 'WhatsApp conectado' : 'Conectar o WhatsApp', acao: 'conexao' },
    { id: 'grupos', ok: !!u.dests?.length && (copia || ofe), txt: u.dests?.length ? (copia || ofe ? 'Grupos escolhidos' : 'Escolher um grupo para copiar (ou ligar a busca de ofertas)') : 'Escolher o grupo onde postar', acao: 'grupos' },
    { id: 'lojas', ok: temLoja, txt: temLoja ? 'ID de afiliado cadastrado' : 'Cadastrar seu ID de afiliado de uma loja', acao: 'lojas' },
    { id: 'ativo', ok: !!u.active, txt: u.active ? 'Robô ligado' : 'Ligar o robô', acao: 'ativar' },
    ...(copia ? [{ id: 'webhook', ok: webhookOk, txt: webhookOk ? 'Recebendo as mensagens dos grupos' : 'Ainda não estou recebendo as mensagens dos grupos', acao: 'webhook' }] : [])
  ];
  const cand = [];
  const ev = s.diag.find(e => /^(Enviada|Falha ao enviar)/.test(e.motivo));
  if (ev) cand.push({ t: ev.t, ok: ev.ok, motivo: ev.motivo });
  if (u.log?.[0]) cand.push({ t: u.log[0].t, ok: true, motivo: `Enviada para ${u.names?.[u.log[0].to] || u.log[0].to}.` });
  const ultimo = cand.sort((a, b) => b.t - a.t)[0] || null;
  const faltam = passos.filter(p => !p.ok);
  const nivel = !faltam.length ? (ultimo && !ultimo.ok ? 'atencao' : 'ok') : faltam[0].id === 'acesso' ? 'parado' : 'falta';
  atLimit(u);
  res.json({ nivel, passos, faltam: faltam.length, proximo: faltam[0] || null, ultimo, fila: s.q.length + (s.atual ? 1 : 0), hoje: { n: u.cont?.n || 0, limite: limiteHoje(u) }, estado });
});

const proxHora = u => { const h0 = br(Date.now()).h; for (let i = 1; i <= 24; i++) { const h = (h0 + i) % 24; if (u.horarios?.horas?.includes(h)) return h; } return null; };
api.get('/fila', (req, res) => {
  const u = req.u, s = M(req.inst), now = Date.now(), lim = limiteHoje(u), noLimite = atLimit(u), usados = u.cont?.n || 0;
  let bloqueio = null;
  if (acesso(u) !== 'ok') bloqueio = { tipo: 'acesso', txt: 'Conta vencida ou bloqueada: o robô está parado e a fila não anda.' };
  else if (!u.active) bloqueio = { tipo: 'pausado', txt: 'O robô está pausado. Ligue o robô para a fila voltar a andar.' };
  else if (semTempo(u)) bloqueio = { tipo: 'tempo', txt: 'Você usou as 3 horas de robô do plano grátis hoje. Ele volta a trabalhar amanhã, depois da meia-noite. Nos planos pagos o robô trabalha o dia todo.' };
  else if (!inWindow(u)) { const h = proxHora(u); bloqueio = { tipo: 'horario', txt: `Fora do horário de pico que você escolheu. As ofertas esperam e saem ${h === null ? 'quando você escolher um horário' : `a partir das ${h}h`}.` }; }
  else if (noLimite) bloqueio = { tipo: 'limite', txt: `Você chegou no limite do dia (${usados} de ${lim} postagens). A fila volta a andar amanhã, depois da meia-noite.` };
  else if (s.q.length || s.atual) bloqueio = { tipo: 'intervalo', txt: `Tudo certo: o robô envia uma de cada vez, com cerca de ${efDelay(u)} segundos de intervalo para proteger o seu número.` };
  const mk = j => ({ t: j.t, tipo: j.tipo, grupo: u.names?.[j.to] || j.to, sub: j.sub || '', txt: String(j.text || '').slice(0, 140), lojas: [...new Set((j.links || []).map(l => l.loja))] });
  const itens = [...(s.atual ? [{ ...mk(s.atual), atual: true }] : []), ...s.q.map(j => mk(j))];
  res.json({ bloqueio, itens, hoje: { n: usados, limite: lim }, delay: efDelay(u),
    ofertas: u.ofertas?.active && u.active ? { proxima: s.next > now ? s.next : null, cadaMin: u.ofertas.everyMin } : null,
    horarios: u.horarios?.ativo ? u.horarios.horas : null });
});

api.get('/resumo-semana', (req, res) => {
  if (!P(req.u).relatorios) return res.status(403).json({ erro: 'Resumo da semana está disponível no Plano Pro.' });
  const u = req.u, now = Date.now(), hoje = br(now);
  const ini = br(now - (hoje.w + 7) * 864e5).d, fim = br(now - (hoje.w + 1) * 864e5).d; // segunda a domingo da semana passada
  const dentro = t => { const d = br(t).d; return d >= ini && d <= fim; };
  const porCodigo = {}, g = {};
  const grupo = id => (g[id] ||= { id, nome: u.names?.[id] || id, sub: u.subids?.[id] || '', posts: 0, cliques: 0 });
  for (const e of u.log || []) { for (const x of e.codes || []) porCodigo[x.c] = e.to; if (dentro(e.t)) grupo(e.to).posts++; }
  const rastreio = !!PUBLIC_URL && u.rastrear !== false;
  if (rastreio) for (const k of db.clicks) if (k.t > now - 16 * 864e5 && porCodigo[k.c] && dentro(k.t)) grupo(porCodigo[k.c]).cliques++;
  for (const d of u.dests || []) grupo(d); // todo grupo de destino aparece, com o seu Sub ID
  const grupos = Object.values(g).sort((a, b) => b.cliques - a.cliques || b.posts - a.posts);
  const posts = grupos.reduce((a, x) => a + x.posts, 0), cliques = grupos.reduce((a, x) => a + x.cliques, 0);
  res.json({ de: ini, ate: fim, rastreio, posts, cliques, grupos, campeao: cliques ? grupos[0] : null });
});

const adm = (req, res, next) => isAdmin(req.u) ? next() : res.status(403).json({ erro: 'Apenas o administrador' });
api.get('/admin/users', adm, (req, res) => {
  const cc = {}; for (const k of db.clicks) { const l = db.links[k.c]; if (l) cc[l.u] = (cc[l.u] || 0) + 1; }
  res.json(Object.entries(db.users).map(([id, u]) => ({ id, email: u.email || '(sem e-mail)', criado: u.criado, expira: u.expira || null,
    plano: planoBase(u), testeP2: testeP2Ativo(u), acesso: acesso(u), bloqueado: !!u.bloqueado, ativo: !!u.active, posts: (u.log || []).length, ultimo: u.log?.[0]?.t || null, cliques: cc[id] || 0, nota: u.nota || '' })));
});
api.get('/admin/feedback', adm, (req, res) => res.json((db.feedback || []).slice(-100).reverse()));
api.put('/admin/users/:id', adm, (req, res) => {
  const u = db.users[req.params.id], b = req.body;
  if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });
  if (b.bloqueado !== undefined) { u.bloqueado = !!b.bloqueado; if (u.bloqueado) fimSessoes(req.params.id); }
  if (b.addDias !== undefined) { if (![10, 30].includes(+b.addDias)) return res.status(400).json({ erro: 'Escolha +10 ou +30 dias' }); u.expira = Math.max(u.expira || 0, Date.now()) + +b.addDias * 864e5; }
  if (b.plano !== undefined) { if (!PLANOS[b.plano]) return res.status(400).json({ erro: 'Plano inválido' }); u.plano = b.plano; }
  if (b.nota !== undefined) u.nota = String(b.nota).slice(0, 200);
  save(); res.json({ ok: true });
});
api.post('/admin/users/:id/reset', adm, (req, res) => {
  if (!db.users[req.params.id]) return res.status(404).json({ erro: 'Usuário não encontrado' });
  const raw = crypto.randomBytes(24).toString('hex');
  (db.resets ||= {})[sha(raw)] = { inst: req.params.id, exp: Date.now() + 3600e3 }; save();
  res.json({ link: `${PUBLIC_URL}/?reset=${raw}` });
});
api.get('/export.csv', (req, res) => {
  if (!P(req.u).relatorios) return res.status(403).json({ erro: 'Exportar planilha está disponível no Plano Pro.' });
  const q = v => { let t = String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' '); if (/^[=+\-@]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const cc = {}; for (const k of db.clicks) cc[k.c] = (cc[k.c] || 0) + 1;
  const nm = id => req.u.names?.[id] || id || '';
  const rows = (req.u.log || []).map(e => [new Date(e.t).toISOString(), e.tipo, e.lojas.join('+'), nm(e.to), nm(e.src), e.n, e.codes.reduce((a, x) => a + (cc[x.c] || 0), 0), e.sub || '', e.txt].map(q).join(','));
  res.type('text/csv').send('\ufeff' + ['data,tipo,lojas,grupo_destino,grupo_origem,links,cliques,sub_id,oferta', ...rows].join('\n'));
});

if (!EVO_URL || !EVO_KEY) console.error('ATENÇÃO: EVO_URL e/ou EVO_KEY não definidas. O QR code e o envio não vão funcionar. Confira o arquivo .env.');

if (!KEY) console.error('ATENÇÃO: SEGREDO_CHAVE não definida. Defina no .env para guardar o Secret da Shopee criptografado.');
if (process.env.PAGAMENTO_SEGREDO && !HOTTOK && !KIWIFY_TOKEN) console.error('ATENÇÃO: defina HOTMART_HOTTOK (ou KIWIFY_TOKEN). Sem isso o webhook de pagamento recusa todos os avisos.');
setTimeout(async () => { for (const inst of Object.keys(db.users)) { try { await ensureWebhook(inst); } catch { /* sem instância ou Evolution fora do ar */ } } }, 20e3); // aplica a URL nova (com chave) nas instâncias já criadas
if (ADMIN_EMAIL && !CONVITE) console.error('ATENÇÃO: CONVITE está vazio. Qualquer pessoa pode criar conta, inclusive com o e-mail do administrador. Preencha CONVITE no .env e crie a sua conta de administrador logo depois de ligar o sistema.');

process.on('unhandledRejection', e => console.error('erro não tratado:', e)); // um erro isolado não derruba o servidor

app.listen(PORT, () => console.log('Rodando na porta', PORT));
