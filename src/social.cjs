// Robô das redes sociais (Instagram agora; TikTok depois).
// Lê a variável SOCIAL_ACCOUNTS (secret do GitHub) e grava docs/social.json e docs/social-history.json.
const fs = require('fs');
const path = require('path');

let GRAPH = 'https://graph.facebook.com/v23.0'; // muda para graph.instagram.com nas contas com "api":"instagram"
const TZ = 'America/Sao_Paulo';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'social.json');
const HIST = path.join(ROOT, 'docs', 'social-history.json');
const MAX_POSTS = 150;      // quantos posts recentes acompanhar por conta
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

async function insights(id, token) {
  const want = ['views', 'reach', 'saved', 'shares', 'total_interactions'];
  const out = {};
  const parse = (j) => {
    for (const m of j.data || []) {
      const v = m.total_value?.value ?? m.values?.[0]?.value;
      if (typeof v === 'number') out[m.name] = v;
    }
  };
  try {
    parse(await api(`/${id}/insights`, token, { metric: want.join(',') }));
  } catch {
    // alguma métrica não vale para este tipo de post: tenta uma por uma
    for (const m of want) {
      try { parse(await api(`/${id}/insights`, token, { metric: m })); } catch {}
    }
  }
  return out;
}

function kind(m) {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'carrossel';
  if (m.media_type === 'VIDEO') return 'video';
  return 'foto';
}

async function instagram(acc, hist, d) {
  const { token } = acc;
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

  // métricas de cada post (em lotes de 5)
  const posts = [];
  for (let i = 0; i < media.length; i += 5) {
    const batch = media.slice(i, i + 5);
    const res = await Promise.all(batch.map((m) => insights(m.id, token)));
    batch.forEach((m, k) => {
      const x = res[k];
      posts.push({
        id: m.id,
        type: kind(m),
        caption: (m.caption || '').slice(0, 140),
        url: m.permalink,
        thumb: m.thumbnail_url || m.media_url || null,
        date: m.timestamp,
        likes: m.like_count ?? null,
        comments: m.comments_count ?? null,
        views: x.views ?? null,
        reach: x.reach ?? null,
        saved: x.saved ?? null,
        shares: x.shares ?? null,
        interactions: x.total_interactions ?? null
      });
    });
  }

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

  return {
    key: acc.key,
    platform: 'instagram',
    name: acc.name || prof.name || prof.username,
    username: prof.username,
    avatar: prof.profile_picture_url || null,
    followers: prof.followers_count,
    following: prof.follows_count,
    mediaCount: prof.media_count,
    gains,
    posts
  };
}

(async () => {
  let accounts;
  try { accounts = JSON.parse(process.env.SOCIAL_ACCOUNTS || '[]'); }
  catch { console.error('SOCIAL_ACCOUNTS não é um JSON válido.'); process.exit(1); }
  if (!accounts.length) { console.log('Nenhuma conta configurada em SOCIAL_ACCOUNTS. Nada a fazer.'); return; }

  const prev = readJson(OUT, { accounts: [] });
  const hist = readJson(HIST, { accounts: {} });
  hist.accounts ??= {};
  const d = today();
  const out = [];
  let ok = 0;

  for (const acc of accounts) {
    try {
      GRAPH = acc.api === 'instagram' ? 'https://graph.instagram.com/v23.0' : 'https://graph.facebook.com/v23.0';
      if (acc.platform !== 'instagram') throw new Error('plataforma ainda não suportada: ' + acc.platform);
      out.push(await instagram(acc, hist, d));
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
