// Robô das redes sociais (Instagram agora; TikTok depois).
// Lê a variável SOCIAL_ACCOUNTS (secret do GitHub) e grava docs/social.json e docs/social-history.json.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

let GRAPH = 'https://graph.facebook.com/v23.0'; // muda para graph.instagram.com nas contas com "api":"instagram"
const TZ = 'America/Sao_Paulo';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'social.json');
const HIST = path.join(ROOT, 'docs', 'social-history.json');
const MAX_POSTS = 3000;     // limite de segurança de posts por conta (busca todos)
const FRESH = 150;          // os 150 mais recentes têm as métricas atualizadas a cada rodada
const MAX_NEW = 400;        // posts antigos novos (sem métricas ainda) preenchidos por rodada
const HIST_DAYS = 120;      // guarda histórico diário dos posts com até 120 dias

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const dayBefore = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);

async function api(p, token, params = {}) {
  const u = new URL(p.startsWith('http') ? p : GRAPH + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', token);
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const e = new Error(j.error?.message || 'HTTP ' + r.status);
        e.code = j.error?.code;
        e.noRetry = !(r.status >= 500 || [1, 2, 4, 17, 32, 613].includes(e.code));
        throw e;
      }
      return j;
    } catch (e) {
      last = e;
      if (e.noRetry) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

const ERRS = new Map(); // mensagens de erro mais comuns ao buscar métricas (para diagnóstico no log)
const noteErr = (e) => ERRS.set(e.message, (ERRS.get(e.message) || 0) + 1);

async function insights(id, token, type) {
  const want = type === 'reel'
    ? ['views', 'reach', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time']
    : ['views', 'reach', 'saved', 'shares', 'total_interactions', 'follows', 'profile_visits'];
  const out = {};
  const parse = (j) => {
    for (const m of j.data || []) {
      const v = m.total_value?.value ?? m.values?.[0]?.value;
      if (typeof v === 'number') out[m.name] = v;
    }
  };
  try {
    parse(await api(`/${id}/insights`, token, { metric: want.join(',') }));
  } catch (e) {
    noteErr(e);
    if (type === 'carrossel') return out; // carrosséis costumam não ter insights
    // alguma métrica não vale para este tipo de post: tenta uma por uma
    for (const m of want) {
      try { parse(await api(`/${id}/insights`, token, { metric: m })); } catch (e2) { noteErr(e2); }
    }
  }
  // posts antigos: o Instagram só informa "impressões" (a métrica antiga de visualizações)
  if (out.views == null) {
    try {
      parse(await api(`/${id}/insights`, token, { metric: 'impressions' }));
      if (out.impressions != null) { out.views = out.impressions; out.legacy = true; }
    } catch (e) { noteErr(e); }
  }
  return out;
}

function kind(m) {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'carrossel';
  if (m.media_type === 'VIDEO') return 'video';
  return 'foto';
}

const dayShift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Ganhos e perdas de seguidores por dia (métrica follows_and_unfollows, dia a dia).
async function followFlow(userId, token, h, d, gains) {
  h.fu ??= {};
  const days = [];
  for (let i = 30; i >= 1; i--) days.push(dayShift(d, -i));
  const todo = days.filter((x) => !h.fu[x] || x >= dayShift(d, -3));
  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(todo.slice(i, i + 5).map(async (day) => {
      const since = Math.floor(Date.parse(day + 'T00:00:00-03:00') / 1000);
      const j = await api(`/${userId}/insights`, token, {
        metric: 'follows_and_unfollows', metric_type: 'total_value', breakdown: 'follow_type',
        period: 'day', since, until: since + 86399
      });
      const tv = j.data?.[0]?.total_value;
      const o = {};
      for (const r of tv?.breakdowns?.[0]?.results || []) o[r.dimension_values?.[0]] = r.value;
      if (Object.keys(o).length) h.fu[day] = o;
    }));
  }
  const rows = days.filter((x) => h.fu[x]);
  if (!rows.length) return { flow: [], map: null };
  // A API não diz qual lado é ganho e qual é perda; descobrimos comparando com o saldo diário (follower_count)
  const net = Object.fromEntries(gains);
  let a = 0, b = 0;
  for (const x of rows) { a += (h.fu[x].FOLLOWER || 0) - (h.fu[x].NON_FOLLOWER || 0); b += net[x] || 0; }
  const gainKey = a * b < 0 ? 'NON_FOLLOWER' : 'FOLLOWER';
  const lossKey = gainKey === 'FOLLOWER' ? 'NON_FOLLOWER' : 'FOLLOWER';
  return { flow: rows.map((x) => [x, h.fu[x][gainKey] || 0, h.fu[x][lossKey] || 0]), map: gainKey };
}


// ============ Renovação automática do token do Instagram (login do Instagram) ============
// O token dura 60 dias, mas pode ser renovado a qualquer momento depois de 24h de vida.
// O robô renova e guarda o novo token CRIPTOGRAFADO no repositório (chave = appSecret, que fica só no GitHub Secrets).
async function igToken(acc) {
  if (acc.api !== 'instagram' || !acc.appSecret) return acc.token;
  const file = path.join(ROOT, 'state', `ig-${acc.key}.enc`);
  const sig = crypto.createHash('sha256').update(acc.token).digest('hex');
  let st = null;
  try { st = openTokens(fs.readFileSync(file, 'utf8'), acc.appSecret); } catch {}
  if (st && st.orig !== sig) st = null;              // você colou um token novo no segredo: ele vale mais
  let token = st ? st.token : acc.token;
  const idade = st ? Date.now() - Date.parse(st.at) : Infinity;
  if (idade > 864e5) {
    try {
      const u = new URL('https://graph.instagram.com/refresh_access_token');
      u.searchParams.set('grant_type', 'ig_refresh_token');
      u.searchParams.set('access_token', token);
      const r = await fetch(u);
      const j = await r.json().catch(() => ({}));
      if (j.access_token) {
        token = j.access_token;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, sealTokens({ orig: sig, token, at: new Date().toISOString() }, acc.appSecret));
        console.log('token do Instagram renovado (vale mais ' + Math.round((j.expires_in || 0) / 86400) + ' dias)');
      } else {
        console.error('não consegui renovar o token do Instagram:', j.error?.message || r.status);
      }
    } catch (e) { console.error('renovação do token falhou:', e.message); }
  }
  return token;
}

async function instagram(acc, hist, d, prevPosts) {
  const token = await igToken(acc);
  const userId = acc.userId || 'me';
  const prof = await api(`/${userId}`, token, {
    fields: 'username,name,followers_count,follows_count,media_count,profile_picture_url'
  });

  // posts (paginado)
  const media = [];
  let page = await api(`/${userId}/media`, token, {
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url',
    limit: 50
  });
  while (page) {
    media.push(...(page.data || []));
    if (media.length >= MAX_POSTS || !page.paging?.next) break;
    page = await api(page.paging.next, token);
  }
  media.length = Math.min(media.length, MAX_POSTS);
  console.log(media.length + ' posts encontrados');

  // métricas: os mais recentes sempre atualizam; os antigos reaproveitam o que já foi salvo
  const old = new Map((prevPosts || []).map((p) => [p.id, p]));
  let budget = MAX_NEW;
  const plan = media.map((m, i) => {
    const o = old.get(m.id);
    let fetchIt = i < FRESH;
    const stale = o && o.views == null && (!o.fetchedAt || Date.now() - Date.parse(o.fetchedAt) > 7 * 864e5);
    if (!fetchIt && (!o || stale) && budget > 0) { fetchIt = true; budget--; }
    return { m, o, fetchIt };
  });
  const posts = [];
  for (let i = 0; i < plan.length; i += 5) {
    const batch = plan.slice(i, i + 5);
    const res = await Promise.all(batch.map(({ m, fetchIt }) => (fetchIt ? insights(m.id, token, kind(m)) : null)));
    batch.forEach(({ m, o }, k) => {
      const x = res[k];
      const base = {
        id: m.id,
        type: kind(m),
        caption: (m.caption || '').slice(0, 140),
        url: m.permalink,
        thumb: m.thumbnail_url || m.media_url || null,
        date: m.timestamp,
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null
      };
      const got = x && Object.keys(x).length > 0;
      const keep = o || {};
      const now = new Date().toISOString();
      if (got) {
        posts.push({
          ...base,
          views: x.views ?? null,
          legacy: x.legacy ? true : undefined,
          reach: x.reach ?? null,
          saved: x.saved ?? null,
          shares: x.shares ?? null,
          follows: x.follows ?? null,
          visits: x.profile_visits ?? null,
          watch: x.ig_reels_avg_watch_time != null ? Math.round(x.ig_reels_avg_watch_time / 100) / 10 : null,
          interactions: x.total_interactions ?? null,
          fetchedAt: now
        });
      } else {
        // sem métricas novas (post antigo ou falha passageira): mantém o que já tinha
        posts.push({
          ...base,
          views: keep.views ?? null, legacy: keep.legacy, reach: keep.reach ?? null, saved: keep.saved ?? null,
          shares: keep.shares ?? null, follows: keep.follows ?? null, visits: keep.visits ?? null,
          watch: keep.watch ?? null, interactions: keep.interactions ?? null,
          fetchedAt: x ? now : keep.fetchedAt
        });
      }
    });
  }

  const semViews = posts.filter((p) => p.views == null).length;
  console.log(`${posts.length - semViews} posts com views, ${semViews} sem views`);
  [...ERRS.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([m, n]) => console.log(`  erro (${n}x): ${m}`));

  // ganho diário de seguidores (a API entrega os últimos 30 dias)
  let gains = [];
  try {
    const until = Math.floor(Date.now() / 1000);
    const j = await api(`/${userId}/insights`, token, {
      metric: 'follower_count', period: 'day', since: until - 29 * 86400, until
    });
    gains = (j.data?.[0]?.values || [])
      .filter((v) => v.end_time)
      .map((v) => [dayBefore(v.end_time.slice(0, 10)), v.value]);
  } catch {}

  let flow = [], flowMap = null, flowError = null;
  try {
    const hh = (hist.accounts[acc.key] ??= { followers: {}, posts: {} });
    ({ flow, map: flowMap } = await followFlow(userId, token, hh, d, gains));
  } catch (e) { flowError = e.message; console.error('perdas de seguidores indisponíveis:', e.message); }

  // histórico diário (a API não devolve o passado, então o robô guarda dia a dia)
  const h = (hist.accounts[acc.key] ??= { followers: {}, posts: {} });
  h.followers[d] = prof.followers_count;
  const limit = Date.now() - HIST_DAYS * 864e5;
  for (const p of posts) {
    if (Date.parse(p.date) < limit) continue;
    (h.posts[p.id] ??= {})[d] = [p.views, p.likes];
  }
  for (const id of Object.keys(h.posts)) {
    if (!posts.find((p) => p.id === id)) delete h.posts[id];
  }

  // validade estimada do token: 60 dias a partir do dia em que o robô viu este token pela primeira vez
  // (guarda só um "carimbo" curto do token, nunca o token). Com renovação automática (appSecret) não vence.
  const tk = crypto.createHash('sha256').update(String(acc.token)).digest('hex').slice(0, 12);
  h.tok ??= {};
  h.tok[tk] ??= d;
  const tokenExpires = acc.appSecret ? null : new Date(Date.parse(h.tok[tk] + 'T12:00:00Z') + 60 * 864e5).toISOString().slice(0, 10);

  return {
    key: acc.key,
    platform: 'instagram',
    name: acc.name || prof.name || prof.username,
    username: prof.username,
    avatar: prof.profile_picture_url || null,
    followers: prof.followers_count,
    following: prof.follows_count,
    mediaCount: prof.media_count,
    tokenExpires,
    gains,
    flow,
    flowMap,
    flowError,
    posts
  };
}


// ============ TikTok (Display API) ============
const TT = 'https://open.tiktokapis.com/v2';
// Os tokens ficam no repositório, mas CRIPTOGRAFADOS com a chave secreta do app (que só existe no GitHub Secrets).
const encKey = (secret) => crypto.createHash('sha256').update('gba-tiktok:' + secret).digest();
function sealTokens(obj, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function openTokens(b64, secret) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
async function ttToken(params) {
  const r = await fetch(TT + '/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('TikTok: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  return j;
}
async function ttApi(path, access, opts = {}) {
  const r = await fetch(TT + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json; charset=UTF-8' }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.error && j.error.code && j.error.code !== 'ok')) {
    throw new Error('TikTok: ' + (j.error?.message || j.error?.code || 'HTTP ' + r.status));
  }
  return j.data || {};
}

async function tiktok(acc, hist, d, prevPosts) {
  const secret = acc.clientSecret;
  if (!acc.clientKey || !secret) throw new Error('TikTok: faltam clientKey e clientSecret no SOCIAL_ACCOUNTS');
  const file = path.join(ROOT, 'state', `tiktok-${acc.key}.enc`);
  let tok = null;
  try { tok = openTokens(fs.readFileSync(file, 'utf8'), secret); } catch {}

  const code = (process.env.TIKTOK_CODE || '').trim();
  let r;
  if (code && !tok) {
    if (!acc.redirectUri) throw new Error('TikTok: falta redirectUri no SOCIAL_ACCOUNTS');
    r = await ttToken({
      client_key: acc.clientKey, client_secret: secret, grant_type: 'authorization_code',
      code: decodeURIComponent(code), redirect_uri: acc.redirectUri
    });
  } else if (tok) {
    r = await ttToken({
      client_key: acc.clientKey, client_secret: secret, grant_type: 'refresh_token', refresh_token: tok.refresh_token
    });
  } else {
    throw new Error('TikTok ainda não conectado: gere o código em tiktok-conectar.html e rode o robô com ele.');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sealTokens({ refresh_token: r.refresh_token || tok?.refresh_token, open_id: r.open_id || tok?.open_id }, secret));
  const access = r.access_token;

  // perfil
  let user = {};
  const base = 'open_id,avatar_url,display_name';
  try {
    user = (await ttApi(`/user/info/?fields=${base},username,follower_count,following_count,likes_count,video_count`, access)).user || {};
  } catch (e) {
    console.error('perfil completo indisponível, tentando o básico:', e.message);
    user = (await ttApi(`/user/info/?fields=${base}`, access)).user || {};
  }

  // vídeos (20 por página)
  const vids = [];
  let cursor, more = true;
  while (more && vids.length < MAX_POSTS) {
    const data = await ttApi(
      '/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,duration,like_count,comment_count,share_count,view_count',
      access,
      { method: 'POST', body: JSON.stringify(cursor ? { max_count: 20, cursor } : { max_count: 20 }) }
    );
    vids.push(...(data.videos || []));
    more = !!data.has_more && data.cursor != null;
    cursor = data.cursor;
  }
  console.log(vids.length + ' vídeos do TikTok encontrados');

  const posts = vids.map((v) => ({
    id: String(v.id),
    type: 'tiktok',
    caption: (v.video_description || v.title || '').slice(0, 140),
    url: v.share_url,
    thumb: v.cover_image_url || null,
    date: new Date(v.create_time * 1000).toISOString(),
    likes: v.like_count ?? null,
    comments: v.comment_count ?? null,
    views: v.view_count ?? null,
    shares: v.share_count ?? null,
    duration: v.duration ?? null,
    reach: null, saved: null, follows: null, visits: null, watch: null, interactions: null
  }));

  const h = (hist.accounts[acc.key] ??= { followers: {}, posts: {} });
  if (user.follower_count != null) h.followers[d] = user.follower_count;
  const limit = Date.now() - HIST_DAYS * 864e5;
  for (const p of posts) {
    if (Date.parse(p.date) < limit) continue;
    (h.posts[p.id] ??= {})[d] = [p.views, p.likes];
  }
  for (const id of Object.keys(h.posts)) if (!posts.find((p) => p.id === id)) delete h.posts[id];

  return {
    key: acc.key,
    platform: 'tiktok',
    name: acc.name || user.display_name || user.username,
    username: user.username || user.display_name,
    avatar: user.avatar_url || null,
    followers: user.follower_count ?? null,
    following: user.following_count ?? null,
    mediaCount: user.video_count ?? posts.length,
    likesTotal: user.likes_count ?? null,
    gains: [], flow: [], posts
  };
}

(async () => {
  // lê a lista de contas, tolerando erros comuns de colagem (aspas curvas, ``` do chat, espaços invisíveis)
  const lerLista = (nome) => {
    let raw = process.env[nome] || '';
    if (!raw.trim()) return [];
    raw = raw
      .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
      .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/```[a-z]*/gi, '')
      .replace(/`/g, '')
      .trim();
    if (raw.startsWith('{')) raw = '[' + raw + ']';
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [v];
    } catch (e) {
      console.error(`${nome} não é um JSON válido (${raw.length} caracteres).`);
      console.error('  erro: ' + e.message.slice(0, 140));
      console.error('  começa com: ' + raw.slice(0, 14) + ' | termina com: ' + raw.slice(-4));
      console.error('  dicas: o texto deve começar com [{ e terminar com }] ; entre cada campo vai vírgula ; sem aspas duplas repetidas ("") ; não deixe os textos SUA_CLIENT_KEY.');
      process.exit(1);
    }
  };
  const accounts = [...lerLista('SOCIAL_ACCOUNTS'), ...lerLista('SOCIAL_ACCOUNTS_EXTRA')];
  if (!accounts.length) { console.log('Nenhuma conta configurada em SOCIAL_ACCOUNTS. Nada a fazer.'); return; }
  console.log('Contas lidas: ' + accounts.map((a) => `${a && a.platform}:${a && a.key}`).join(', ') + ' | EXTRA tem ' + (process.env.SOCIAL_ACCOUNTS_EXTRA || '').length + ' caracteres');

  const prev = readJson(OUT, { accounts: [] });
  const hist = readJson(HIST, { accounts: {} });
  hist.accounts ??= {};
  const d = today();
  const out = [];
  let ok = 0;

  for (const acc of accounts) {
    try {
      const before = prev.accounts.find((a) => a.key === acc.key)?.posts;
      if (acc.platform === 'tiktok') out.push(await tiktok(acc, hist, d, before));
      else if (acc.platform === 'instagram') {
        GRAPH = acc.api === 'instagram' ? 'https://graph.instagram.com/v23.0' : 'https://graph.facebook.com/v23.0';
        out.push(await instagram(acc, hist, d, before));
      } else throw new Error('plataforma não suportada: ' + acc.platform);
      ok++;
      console.log('OK', acc.key);
    } catch (e) {
      console.error('FALHOU', acc.key, '-', e.message);
      const old = prev.accounts.find((a) => a.key === acc.key);
      out.push({ ...(old || { key: acc.key, platform: acc.platform, name: acc.name, posts: [], gains: [] }), error: e.message });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), accounts: out }));
  fs.writeFileSync(HIST, JSON.stringify(hist));
  if (!ok) process.exit(1);
})();
