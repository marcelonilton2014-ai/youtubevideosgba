import { readFile, writeFile, mkdir } from 'node:fs/promises';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YOUTUBE_API_KEY;
const P = (f) => new URL(`../${f}`, import.meta.url);

if (!KEY) {
  console.error('Faltou a variável YOUTUBE_API_KEY.');
  process.exit(1);
}

async function yt(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `YouTube API (${endpoint}) ${res.status}: ${await res.text()}`
    );
  }
  return res.json();
}

async function resolveChannel(ref) {
  const params = { part: 'snippet,contentDetails' };

  if (ref.startsWith('@')) {
    params.forHandle = ref;
  } else {
    params.id = ref;
  }

  const item = (await yt('channels', params)).items?.[0];

  if (!item) {
    throw new Error(`Canal não encontrado: ${ref}`);
  }

  return {
    id: item.id,
    title: item.snippet.title,
    uploads: item.contentDetails.relatedPlaylists.uploads
  };
}

// Busca os IDs dos vídeos do canal
async function listVideoIds(playlist, max) {
  const ids = [];
  let pageToken;

  do {
    const d = await yt('playlistItems', {
      part: 'contentDetails',
      playlistId: playlist,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {})
    });

    for (const it of d.items ?? []) {
      ids.push(it.contentDetails.videoId);
    }

    pageToken = d.nextPageToken;
  } while (pageToken && ids.length < max);

  return ids.slice(0, max);
}

// Busca estatísticas e filtra vídeos curtos
async function getStats(ids) {
  const out = [];

  for (let i = 0; i < ids.length; i += 50) {
    const d = await yt('videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.slice(i, i + 50).join(',')
    });

    for (const v of d.items ?? []) {
      if (v.statistics?.viewCount === undefined) continue;

      const duration = v.contentDetails?.duration || '';

      const match = duration.match(
        /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
      );

      if (!match) continue;

      const seconds =
        Number(match[1] || 0) * 86400 +
        Number(match[2] || 0) * 3600 +
        Number(match[3] || 0) * 60 +
        Number(match[4] || 0);

      // Somente vídeos com mais de 2 minutos e 28 segundos
      if (seconds <= 148) continue;

      out.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        views: Number(v.statistics.viewCount),
        likes:
          v.statistics.likeCount !== undefined
            ? Number(v.statistics.likeCount)
            : null
      });
    }
  }

  return out;
}

// Carrega configurações e histórico
const config = JSON.parse(
  await readFile(P('config.json'), 'utf8')
);

const state = JSON.parse(
  await readFile(P('state/state.json'), 'utf8')
);

state.channels ??= {};
state.videos ??= {};

const milestones = [...config.milestones].sort((a, b) => a - b);
const nearRatio = config.nearRatio ?? 0.9;
const maxVideos = config.maxVideosPerChannel ?? 500;

const today = new Date().toISOString().slice(0, 10);

const dayDiff = (a, b) =>
  (new Date(b) - new Date(a)) / 86400000;

const out = [];
const errors = [];

// Processa os canais configurados
for (const ch of config.channels) {
  if (
    !ch.channel ||
    ch.channel.includes('xxxx') ||
    ch.channel === '@handleDoCanal'
  ) {
    continue;
  }

  try {
    const info = await resolveChannel(ch.channel);

    const firstTime = !state.channels[info.id]?.baselined;

    const videos = await getStats(
      await listVideoIds(info.uploads, maxVideos)
    );

    const who = ch.name || info.title;

    for (const v of videos) {
      const reached =
        milestones.filter((m) => v.views >= m).pop() ?? 0;

      const next =
        milestones.find((m) => m > v.views) ?? null;

      const prev = state.videos[v.id];

      const e = prev ?? {
        lastMilestone: reached,
        reachedAt: null,
        history: []
      };

      if (!firstTime && reached > e.lastMilestone) {
        e.reachedAt = today;
      }

      e.lastMilestone = reached;

      e.history = [
        ...(e.history ?? []).filter((h) => h[0] !== today),
        [today, v.views]
      ].slice(-30);

      // Média diária dos últimos 7 dias de histórico
      const ref = e.history[
        Math.max(0, e.history.length - 8)
      ];

      const days = dayDiff(ref[0], today);

      const perDay =
        days > 0
          ? Math.max(0, (v.views - ref[1]) / days)
          : null;

      const etaDays =
        next && perDay > 0
          ? Math.ceil((next - v.views) / perDay)
          : null;

      state.videos[v.id] = e;

      out.push({
        id: v.id,
        title: v.title,
        channel: who,
        publishedAt: v.publishedAt,
        views: v.views,
        likes: v.likes,
        lastMilestone: reached,
        reachedAt: e.reachedAt,
        next,
        progress: next ? v.views / next : 1,
        remaining: next ? next - v.views : 0,
        perDay: perDay === null
          ? null
          : Math.round(perDay),
        etaDays
      });
    }

    state.channels[info.id] = {
      name: who,
      baselined: true
    };

    console.log(`✔ ${who}: ${videos.length} vídeos`);
  } catch (e) {
    console.error(
      `✖ ${ch.name || ch.channel}: ${e.message}`
    );

    errors.push(e.message);
  }
}

// Salva o estado e atualiza o painel
state.lastRun = new Date().toISOString();

await writeFile(
  P('state/state.json'),
  JSON.stringify(state, null, 2) + '\n'
);

await mkdir(P('docs'), { recursive: true });

await writeFile(
  P('docs/data.json'),
  JSON.stringify({
    updatedAt: state.lastRun,
    nearRatio,
    milestones,
    videos: out
  }) + '\n'
);

// HISTÓRICO DIÁRIO
// docs/history.json

try {
  const HIST = P('docs/history.json');

  const idx = (a, b) =>
    Math.round(
      (
        Date.parse(b + 'T00:00:00Z') -
        Date.parse(a + 'T00:00:00Z')
      ) / 864e5
    );

  let hist = null;

  try {
    hist = JSON.parse(
      await readFile(HIST, 'utf8')
    );
  } catch {
    // Histórico ainda não existe
  }

  const put = (id, date, views) => {
    const i = idx(hist.base, date);

    if (i < 0) return;

    const e = (
      hist.v[id] ??= {
        s: i,
        v: []
      }
    );

    const j = i - e.s;

    if (j < 0) return;

    while (e.v.length < j) {
      e.v.push(null);
    }

    e.v[j] = views;
  };

  if (!hist) {
    // Aproveita o histórico salvo no state.json
    const datas = Object.values(state.videos).flatMap(
      (e) => (e.history ?? []).map((h) => h[0])
    );

    hist = {
      base: [...datas, today].sort()[0],
      v: {}
    };

    for (const [id, e] of Object.entries(state.videos)) {
      for (const [d, views] of e.history ?? []) {
        put(id, d, views);
      }
    }

    console.log(
      `Histórico criado. Dia 0 = ${hist.base}`
    );
  }

  // Registra as visualizações do dia
  for (const v of out) {
    put(v.id, today, v.views);
  }

  hist.updatedAt = state.lastRun;

  await writeFile(
    HIST,
    JSON.stringify(hist) + '\n'
  );

  console.log(
    `Histórico: dia ${idx(hist.base, today)} gravado (${out.length} vídeos).`
  );
} catch (e) {
  // Falha no histórico não interrompe o robô
  console.error(
    'Aviso: não consegui gravar o histórico:',
    e.message
  );
}

if (errors.length) {
  process.exit(1);
}
