const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Rede de segurança: uma promise rejeitada sem .catch() em qualquer lugar
// (ex: browser.close() falhando por um arquivo temporário do Chrome travado
// pelo Windows) derrubava o processo inteiro do servidor, matando todas as
// postagens/validações em andamento para todo mundo. Loga o erro em vez de
// crashar — perder a limpeza de um perfil temporário do Chrome é inofensivo,
// crashar o servidor inteiro por causa disso não é.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Rejection (processo continua rodando):', reason && reason.message ? reason.message : reason);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Diretório de uploads para mídias enviadas pelo painel
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer para mídias
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'media-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage });

// Servir arquivos estáticos do painel dashboard
app.use(express.static(path.join(__dirname, 'public')));

const { uploadFileToR2 } = require('./r2');

// API Endpoint: Upload de Mídias pelo Painel (suporta até 100 arquivos para disparo em massa)
app.post('/api/upload-media', upload.array('files', 100), async (req, res) => {
  try {
    const files = req.files || [];
    const fileUrls = [];

    for (const f of files) {
      let publicMediaUrl;
      try {
        publicMediaUrl = await uploadFileToR2(f.path, f.originalname, f.mimetype);
        // Apaga o arquivo local temporario apos salvar com sucesso no Cloudflare R2
        fs.promises.unlink(f.path).catch(() => {});
      } catch (r2Err) {
        console.error('[Upload] Falha no R2, usando fallback local:', r2Err.message);
        publicMediaUrl = `/uploads/${f.filename}`;
      }

      fileUrls.push({
        url: publicMediaUrl,
        name: f.originalname,
        type: f.mimetype,
        size: f.size
      });
    }

    res.json({ success: true, files: fileUrls });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API Endpoint: Status do servidor
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    connectedExtensions: clientsMap.size,
    timestamp: new Date().toISOString()
  });
});

// fetch() do Node não tem timeout por padrão — evita que uma API externa lenta
// deixe a requisição do usuário travada para sempre.
function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// Algoritmo de token de sindicação do X/Twitter
function getSyndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function extractTweetId(url) {
  const match = String(url).match(/status(?:es)?\/(\d+)/);
  return match ? match[1] : null;
}

// API Endpoint: Buscar Mídias (Fotos & Vídeos) de Postagem do X/Twitter (Multi-provedor)
app.post('/api/fetch-tweet-video', async (req, res) => {
  try {
    const { link } = req.body;
    if (!link) {
      return res.status(400).json({ success: false, error: 'Link não informado.' });
    }

    const match = String(link).match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\/(\d+)/) || String(link).match(/status(?:es)?\/(\d+)/);
    if (!match) {
      return res.status(400).json({ success: false, error: 'Link inválido. Cole o link completo de uma postagem do X (ex: https://x.com/user/status/123...)' });
    }

    const username = match.length > 2 ? match[1] : 'i';
    const id = match.length > 2 ? match[2] : match[1];

    // Provedor 1: API do VxTwitter (retorna fotos e vídeos estendidos)
    try {
      const vxRes = await fetchWithTimeout(`https://api.vxtwitter.com/${username}/status/${id}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
      });
      if (vxRes.ok) {
        const vxData = await vxRes.json();
        const mediaList = vxData.media_extended || [];
        
        if (mediaList.length > 0) {
          const formattedMedia = mediaList.map(m => {
            const isVid = m.type === 'video' || m.type === 'gif';
            return {
              type: isVid ? 'video' : 'image',
              url: m.url,
              thumbnailUrl: m.thumbnail_url || (isVid ? '' : m.url)
            };
          });

          const firstVid = formattedMedia.find(m => m.type === 'video');

          return res.json({
            success: true,
            media: formattedMedia,
            videoUrl: firstVid ? firstVid.url : (formattedMedia[0]?.url || ''),
            thumbnailUrl: firstVid ? firstVid.thumbnailUrl : (formattedMedia[0]?.thumbnailUrl || ''),
            caption: vxData.text || '',
            author: {
              name: vxData.user_name || username,
              screen_name: vxData.user_screen_name || username,
              avatar: vxData.user_profile_image_url || ''
            },
            tweetId: id
          });
        }
      }
    } catch (e) {
      console.log('[server] Provedor VxTwitter falhou, tentando Syndication...', e.message);
    }

    // Provedor 2: Twitter Syndication API (Fallback)
    const token = getSyndicationToken(id);
    const synUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`;
    const synRes = await fetchWithTimeout(synUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    if (!synRes.ok) {
      return res.status(404).json({ success: false, error: 'Não foi possível buscar a postagem (privada, excluída ou bloqueada).' });
    }

    const synData = await synRes.json();
    if (synData.__typename === 'TweetTombstone') {
      return res.status(404).json({ success: false, error: 'Esta postagem é restrita ou requer login no Twitter para visualização.' });
    }

    const mediaList = synData.mediaDetails || synData.mediaSummary || [];
    if (!mediaList.length) {
      return res.status(404).json({ success: false, error: 'Nenhuma foto ou vídeo encontrado nessa postagem.' });
    }

    const formattedMedia = mediaList.map(m => {
      const isVid = m.type === 'video' || m.type === 'animated_gif';
      let vidUrl = m.media_url_https;
      if (isVid && m.video_info?.variants) {
        const mp4s = m.video_info.variants.filter(v => v.content_type === 'video/mp4' && v.url);
        if (mp4s.length) {
          vidUrl = mp4s.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a).url;
        }
      }
      return {
        type: isVid ? 'video' : 'image',
        url: vidUrl,
        thumbnailUrl: m.media_url_https || vidUrl
      };
    });

    const firstVid = formattedMedia.find(m => m.type === 'video');

    res.json({
      success: true,
      media: formattedMedia,
      videoUrl: firstVid ? firstVid.url : (formattedMedia[0]?.url || ''),
      thumbnailUrl: firstVid ? firstVid.thumbnailUrl : (formattedMedia[0]?.thumbnailUrl || ''),
      caption: synData.text || synData.full_text || '',
      author: synData.user ? { name: synData.user.name, screen_name: synData.user.screen_name, avatar: synData.user.profile_image_url_https } : null,
      tweetId: id
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API Endpoint: Heartbeat HTTP de Fallback das Extensões
app.post('/api/heartbeat', (req, res) => {
  const { clientId, info } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId obrigatório' });

  const existing = clientsMap.get(clientId) || {};
  clientsMap.set(clientId, {
    ws: existing.ws || null,
    info: info || existing.info || {},
    status: existing.status || 'idle',
    lastSeen: Date.now(),
    connectedAt: existing.connectedAt || new Date().toISOString()
  });

  notifyDashboardClientList();
  res.json({ success: true, registered: clientId });
});

// ── Gerenciador de WebSocket ──────────────────────────────────────────────────
// Conexões registradas: clientId -> { ws, info, status, lastSeen }
const clientsMap = new Map();
// Sockets do Painel Web UI: Set<WebSocket>
const dashboardSockets = new Set();
// Estado global persistido das atividades do monitor em tempo real (Persistente no F5)
const globalProgressMap = new Map();

function broadcastToDashboards(payload) {
  if (payload && payload.type === 'STEP_UPDATE' && payload.clientId) {
    globalProgressMap.set(payload.clientId, payload);
  }
  const msg = JSON.stringify(payload);
  for (const socket of dashboardSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(msg);
    }
  }
}

// ── AUTENTICAÇÃO E SUPORTE A DOIS PAINÉIS (adm123 x user123) ──────────────────
app.use((req, res, next) => {
  // Rotas públicas que não requerem senha
  if (req.path === '/api/login' || req.path === '/api/status' || !req.path.startsWith('/api/')) {
    return next();
  }

  const pass = String(req.headers['x-access-pass'] || req.query.pass || (req.body && req.body.pass) || '').trim();
  if (pass !== 'adm123' && pass !== 'user123') {
    return res.status(401).json({ success: false, error: 'Acesso não autorizado. Informe a senha de acesso.' });
  }

  req.accessPass = pass;
  next();
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const cleanPass = String(password || '').trim();
  if (cleanPass === 'adm123') {
    return res.json({ success: true, role: 'admin', pass: 'adm123', label: '👑 Administrador (Master)' });
  } else if (cleanPass === 'user123') {
    return res.json({ success: true, role: 'user', pass: 'user123', label: '👤 Usuário (Painel Limpo)' });
  } else {
    return res.status(401).json({ success: false, error: 'Senha incorreta! Digite "adm123" ou "user123".' });
  }
});

function getAccountsFilePath(pass) {
  if (String(pass || '').trim() === 'user123') {
    return path.join(__dirname, 'accounts_user.json');
  }
  return path.join(__dirname, 'accounts.json');
}

function getPublishedPostsFilePath(pass) {
  if (String(pass || '').trim() === 'user123') {
    return path.join(__dirname, 'published_posts_user.json');
  }
  return path.join(__dirname, 'published_posts.json');
}

function loadAccountsStore(pass = 'adm123') {
  try {
    const fPath = getAccountsFilePath(pass);
    if (fs.existsSync(fPath)) {
      const data = fs.readFileSync(fPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Erro ao ler accounts:', err);
  }
  return [];
}

function saveAccountsStore(accounts, pass = 'adm123') {
  try {
    const fPath = getAccountsFilePath(pass);
    fs.writeFileSync(fPath, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar accounts:', err);
  }
}

function loadPublishedPostsStore(pass = 'adm123') {
  try {
    const fPath = getPublishedPostsFilePath(pass);
    if (fs.existsSync(fPath)) {
      const data = fs.readFileSync(fPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Erro ao ler published_posts:', err);
  }
  return [];
}

function savePublishedPostsStore(posts, pass = 'adm123') {
  try {
    const fPath = getPublishedPostsFilePath(pass);
    fs.writeFileSync(fPath, JSON.stringify(posts, null, 2), 'utf8');
  } catch (err) {
    console.error('Erro ao salvar published_posts:', err);
  }
}

function registerPublishedPost(postObj) {
  try {
    const posts = loadPublishedPostsStore();
    const cleanUrl = String(postObj.tweetUrl || postObj.url || '').trim();
    if (!cleanUrl) return;

    const existingIdx = posts.findIndex(p => p.tweetUrl === cleanUrl);
    const newEntry = {
      id: postObj.id || ('post_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)),
      tweetUrl: cleanUrl,
      username: postObj.username || 'Desconhecido',
      name: postObj.name || postObj.username || 'Conta do Twitter',
      avatar: postObj.avatar || '',
      caption: postObj.caption || postObj.text || '',
      mediaUrls: postObj.mediaUrls || [],
      hasVideo: postObj.hasVideo !== false,
      publishedAt: postObj.publishedAt || new Date().toISOString(),
      metrics: postObj.metrics || { views: 0, likes: 0, retweets: 0, replies: 0 }
    };

    if (existingIdx >= 0) {
      posts[existingIdx] = { ...posts[existingIdx], ...newEntry };
    } else {
      posts.unshift(newEntry);
    }

    savePublishedPostsStore(posts);
  } catch (err) {
    console.error('Erro ao registrar post publicado:', err);
  }
}

function filterPostsByPeriod(posts, period = 'today') {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - (24 * 60 * 60 * 1000);
  const weekStart = now.getTime() - (7 * 24 * 60 * 60 * 1000);
  const monthStart = now.getTime() - (30 * 24 * 60 * 60 * 1000);

  const res = posts.filter(post => {
    const postTime = new Date(post.publishedAt || Date.now()).getTime();
    if (period === 'today') return postTime >= todayStart;
    if (period === 'yesterday') return postTime >= yesterdayStart && postTime < todayStart;
    if (period === 'week') return postTime >= weekStart;
    if (period === 'month') return postTime >= monthStart;
    return true; // 'all'
  });

  if (res.length === 0 && posts.length > 0 && period === 'today') return posts;
  return res;
}

const twitterEngine = require('./twitterEngine');

// Limite global de navegadores Puppeteer simultâneos em paralelo (Acelerado para alta performance)
const MAX_CONCURRENT_BROWSERS = 8;
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  acquire(clientId) {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push({ resolve, clientId }));
  }
  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next.resolve();
    } else {
      this.current--;
    }
  }
}
const browserSemaphore = new Semaphore(MAX_CONCURRENT_BROWSERS);

// Pool DEDICADO e separado só pra validar/testar token de conta nova (ou
// "Validar Todas") — antes usava o mesmo pool de 8 navegadores da postagem/
// edição em massa, então adicionar uma conta nova ficava preso em "Validando..."
// por muito tempo sempre que o painel estivesse ocupado com um disparo grande.
// Validar é rápido e o usuário costuma estar esperando na hora, então merece
// prioridade própria em vez de entrar na fila atrás de dezenas de postagens.
const VALIDATION_CONCURRENCY = 3;
const validationSemaphore = new Semaphore(VALIDATION_CONCURRENCY);
async function runWithValidationSlot(fn) {
  await validationSemaphore.acquire();
  try {
    return await fn();
  } finally {
    validationSemaphore.release();
  }
}

// Valida um token e grava o resultado na conta salva (casada por token, que é
// sempre único) — usada por "Adicionar Contas", "Validar Todas" e pela
// recuperação automática de contas presas em "Validando..." ao reiniciar o
// servidor. Centralizada aqui porque as 3 versões antigas (uma por endpoint)
// tinham um bug em comum: um catch(_) {} silencioso que, em erro inesperado
// (não apenas token inválido), NUNCA desligava pendingValidation — a conta
// ficava mostrando "Validando..." pra sempre, mesmo depois de reiniciar o
// servidor (o estado fica salvo em disco).
async function validateAndPersistAccount(token, pass) {
  let val;
  try {
    val = await runWithValidationSlot(() => validateTokenWithTwitter(token));
  } catch (err) {
    val = { valid: false, error: err.message };
  }

  await withAccountsWriteLock(() => {
    const accs = loadAccountsStore(pass);
    const idx = accs.findIndex(a => a.token === token);
    if (idx < 0) return;

    if (val && val.valid) {
      accs[idx].username = val.username || accs[idx].username;
      accs[idx].name = val.name || accs[idx].name;
      accs[idx].avatar = val.avatar || accs[idx].avatar;
      accs[idx].status = 'Válido';
      accs[idx].isProtected = val.isProtected === true;
      accs[idx].unlocked = val.isProtected ? 'Não (🔒 Protegida)' : 'Sim (🔓 Pública)';
      if (val.followersCount !== undefined) accs[idx].followersCount = val.followersCount;
    } else {
      accs[idx].status = (val && (val.status === 'Suspensa' || val.status === 'Bloqueada')) ? 'Suspensa' : 'Inválido';
      if (val && val.unlocked) accs[idx].unlocked = val.unlocked;
    }
    accs[idx].pendingValidation = false;
    accs[idx].updatedAt = new Date().toISOString();
    saveAccountsStore(accs, pass);
  });

  notifyDashboardClientList(pass);
  return val;
}

// Valida um lote de tokens em paralelo (respeitando o pool de validação) e
// avisa o painel do progresso (%, quantos faltam, tempo estimado) a cada
// conta concluída — sem isso, o usuário só via "Validando e Adicionando N
// conta(s)..." parado no botão, sem noção de quanto faltava.
async function validateBatchWithProgress(tokens, pass) {
  const total = tokens.length;
  if (total === 0) return;
  let completed = 0;
  const startedAt = Date.now();

  broadcastToDashboards({ type: 'VALIDATION_BATCH_PROGRESS', total, completed: 0, percent: 0, etaSeconds: null });

  await Promise.all(tokens.map(async (token) => {
    await validateAndPersistAccount(token, pass);
    completed++;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const avgPerAccount = elapsedSec / completed;
    const etaSeconds = completed < total ? Math.round(avgPerAccount * (total - completed)) : 0;
    broadcastToDashboards({
      type: 'VALIDATION_BATCH_PROGRESS',
      total,
      completed,
      percent: Math.round((completed / total) * 100),
      etaSeconds
    });
  }));
}

// Incrementado toda vez que "Pausar Ações" é acionado. Os laços sequenciais do
// modo "Postagem Padrão" guardam o valor no início e checam antes de cada
// conta — se mudou, é porque uma pausa foi pedida enquanto o laço rodava, e
// ele para em vez de seguir postando nas contas seguintes. Sem isso, pausar
// só derrubava o navegador da conta atual (que dava erro) mas o laço
// continuava tentando postar normalmente na próxima conta da lista.
let dispatchEpoch = 0;

// Guarda os timers de disparos ainda não iniciados (aguardando o atraso entre
// contas) junto com o clientId de cada um, para o botão "Pausar Ações" do
// painel conseguir cancelá-los na hora e avisar a UI de quais contas ficaram
// paradas.
const pendingDispatchTimers = new Map(); // timerId -> clientId
function scheduleDispatch(fn, delayMs, clientId) {
  const timerId = setTimeout(() => {
    pendingDispatchTimers.delete(timerId);
    fn();
  }, delayMs);
  pendingDispatchTimers.set(timerId, clientId);
  return timerId;
}

// Fila simples para serializar leitura+escrita do accounts.json. Validações em
// paralelo (várias contas ao mesmo tempo) fariam load→modify→save concorrentes
// nesse arquivo — sem essa fila, uma escrita podia sobrescrever/perder o
// resultado de outra que terminou quase ao mesmo tempo.
let accountsWriteLock = Promise.resolve();
function withAccountsWriteLock(fn) {
  const result = accountsWriteLock.then(fn, fn);
  accountsWriteLock = result.catch(() => {});
  return result;
}

// Rastreia o que está rodando em cada slot de navegador ocupado agora — usado
// só para dar uma mensagem de fila útil (o que está rodando, há quanto tempo,
// e como cancelar) em vez de um "Na fila..." genérico e sem contexto.
const activeSlotOccupants = new Map(); // clientId -> { label, startedAt }
const AVG_ACTION_SECONDS = 45; // estimativa grosseira de duração média de 1 ação (post/edição)

// Executa um trabalho que abre um navegador Puppeteer respeitando o limite global
// de concorrência. Antes de conseguir uma vaga, avisa a UI o que está ocupando
// os navegadores agora, uma estimativa de espera, e como cancelar pra priorizar.
async function runWithBrowserSlot(clientId, onProgress, fn, actionLabel = 'uma ação') {
  if (browserSemaphore.current >= browserSemaphore.max) {
    const occupants = Array.from(activeSlotOccupants.values());
    const oldestStart = occupants.length > 0 ? Math.min(...occupants.map(o => o.startedAt)) : Date.now();
    const elapsedOldestSec = Math.round((Date.now() - oldestStart) / 1000);
    const etaSec = Math.max(AVG_ACTION_SECONDS - elapsedOldestSec, 5);
    const summaryList = occupants.slice(0, 3).map(o => {
      const elapsed = Math.round((Date.now() - o.startedAt) / 1000);
      return `${o.label} (${elapsed}s atrás)`;
    });
    const summary = summaryList.join(', ') + (occupants.length > 3 ? ` e mais ${occupants.length - 3}` : '');
    onProgress(
      0,
      `⏳ Todos os ${browserSemaphore.max} navegadores estão ocupados agora com: ${summary}. Tempo estimado até liberar uma vaga: ~${etaSec}s. Para cancelar o que está em andamento e priorizar esta ação, use "⏸ Pausar Todas as Ações" no Monitor de Atividades.`,
      'running'
    );
  }
  await browserSemaphore.acquire(clientId);
  activeSlotOccupants.set(clientId, { label: actionLabel, startedAt: Date.now() });
  try {
    return await fn();
  } finally {
    activeSlotOccupants.delete(clientId);
    browserSemaphore.release();
  }
}

// Valida token com a API do X/Twitter usando o motor autônomo do servidor
async function validateTokenWithTwitter(token) {
  return await twitterEngine.validateAndExtractAccount(token);
}

// Endpoint para a extensão registrar o @username real e foto de perfil real capturados do Twitter
app.post('/api/accounts/sync-detected', async (req, res) => {
  try {
    const { token, username, name, avatar, followersCount } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token não informado' });

    const currentAccounts = loadAccountsStore(req.accessPass);
    const cleanToken = String(token).trim();
    const idx = currentAccounts.findIndex(a => a.token === cleanToken);

    // Verifica se a conta tem publicações protegidas (mesma checagem usada ao adicionar/revalidar tokens)
    const val = await validateTokenWithTwitter(cleanToken);
    const isProtected = val.valid ? (val.isProtected === true) : (idx >= 0 ? (currentAccounts[idx].isProtected === true) : false);

    const updatedObj = {
      id: idx >= 0 ? currentAccounts[idx].id : 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      token: cleanToken,
      username: username || (idx >= 0 ? currentAccounts[idx].username : 'Conta do Twitter'),
      name: name || username || 'Conta do Twitter',
      avatar: avatar || (idx >= 0 ? currentAccounts[idx].avatar : ''),
      status: 'Válido',
      followersCount: followersCount || (idx >= 0 ? currentAccounts[idx].followersCount || 0 : 0),
      isProtected: isProtected,
      unlocked: isProtected ? 'Não (🔒 Protegida)' : 'Sim (🔓 Pública)',
      isMother: idx >= 0 ? (currentAccounts[idx].isMother === true) : false,
      postsCount: idx >= 0 ? (currentAccounts[idx].postsCount || 0) : 0,
      profileEdited: idx >= 0 ? (currentAccounts[idx].profileEdited === true) : false,
      updatedAt: new Date().toISOString()
    };

    if (idx >= 0) {
      currentAccounts[idx] = updatedObj;
    } else {
      currentAccounts.push(updatedObj);
    }

    saveAccountsStore(currentAccounts, req.accessPass);
    notifyDashboardClientList();

    res.json({ success: true, account: updatedObj });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// REST Endpoints de Contas
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccountsStore(req.accessPass);
  const total = accounts.length;
  const valid = accounts.filter(a => a.status === 'Válido').length;
  const suspended = accounts.filter(a => a.status === 'Suspensa' || a.status === 'Bloqueada').length;
  const invalid = accounts.filter(a => a.status === 'Inválido').length;

  res.json({
    success: true,
    metrics: { total, valid, suspended, invalid },
    accounts: accounts
  });
});

function parseInputTokens(input) {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : String(input).split(/[\r\n]+/);
  const items = [];
  const seenTokens = new Set();

  for (let rawItem of rawList) {
    const line = String(rawItem).trim();
    if (!line) continue;

    let token = null;
    let username = null;

    if (line.includes(':')) {
      const parts = line.split(':').map(p => p.trim());
      // 1. Procura qual parte contém os 40 caracteres hexadecimal do auth_token
      for (let i = parts.length - 1; i >= 0; i--) {
        const hexMatch = parts[i].match(/([a-f0-9]{40})/i);
        if (hexMatch) {
          token = hexMatch[1].toLowerCase();
          break;
        }
      }

      // 2. Se a primeira parte não for e-mail e nem o token hex, ela é o @username da conta!
      if (parts[0] && !parts[0].includes('@') && !parts[0].match(/^[a-f0-9]{40}$/i)) {
        username = parts[0].replace(/^@/, '').trim();
      }
    }

    if (!token) {
      const generalHexMatch = line.match(/([a-f0-9]{40})/i);
      if (generalHexMatch) {
        token = generalHexMatch[1].toLowerCase();
      } else {
        const cleanToken = line.replace(/[^a-f0-9]/gi, '');
        if (cleanToken.length >= 32) {
          token = cleanToken.toLowerCase();
        }
      }
    }

    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      items.push({
        token: token,
        username: username || null
      });
    }
  }

  return items;
}

app.post('/api/accounts/add-tokens', async (req, res) => {
  try {
    const { tokens } = req.body;
    const parsedTokens = parseInputTokens(tokens);

    if (parsedTokens.length === 0) {
      return res.status(400).json({ success: false, error: 'Cole pelo menos 1 token auth_token válido ou formato de conta.' });
    }

    const pass = req.accessPass || 'adm123';
    const currentAccounts = loadAccountsStore(pass);
    const updatedList = [...currentAccounts];
    const addedResults = [];

    // Adiciona todas as contas instantaneamente ao JSON sem travar o HTTP request no Render
    for (let item of parsedTokens) {
      const cleanToken = item.token;
      const parsedUsername = item.username;
      const existingIdx = updatedList.findIndex(a => a.token === cleanToken);

      const usernameToUse = parsedUsername
        || (existingIdx >= 0 && updatedList[existingIdx].username && !updatedList[existingIdx].username.startsWith('acc_') ? updatedList[existingIdx].username : null)
        || `acc_${cleanToken.substring(0, 8)}`;

      const nameToUse = (parsedUsername && parsedUsername !== usernameToUse) ? parsedUsername
        : (existingIdx >= 0 && updatedList[existingIdx].name && updatedList[existingIdx].name !== 'Conta do Twitter' ? updatedList[existingIdx].name : (usernameToUse.startsWith('acc_') ? 'Conta do Twitter' : usernameToUse));

      const accountObj = {
        id: existingIdx >= 0 ? updatedList[existingIdx].id : 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        token: cleanToken,
        username: usernameToUse,
        name: nameToUse,
        avatar: existingIdx >= 0 ? updatedList[existingIdx].avatar : '',
        status: existingIdx >= 0 ? updatedList[existingIdx].status : 'Válido',
        // Marca como "ainda validando" até a checagem real em segundo plano
        // terminar — sem isso, uma conta nova/suspensa/inválida ficava mostrando
        // "🟢 Ativa" com nome provisório (acc_XXXXXXXX) indefinidamente enquanto
        // esperava sua vez na fila de validação.
        pendingValidation: true,
        followersCount: existingIdx >= 0 ? (updatedList[existingIdx].followersCount || 0) : 0,
        isProtected: existingIdx >= 0 ? (updatedList[existingIdx].isProtected === true) : false,
        unlocked: existingIdx >= 0 ? updatedList[existingIdx].unlocked : 'Sim (🔓 Pública)',
        isMother: existingIdx >= 0 ? (updatedList[existingIdx].isMother === true) : false,
        postsCount: existingIdx >= 0 ? (updatedList[existingIdx].postsCount || 0) : 0,
        profileEdited: existingIdx >= 0 ? (updatedList[existingIdx].profileEdited === true) : false,
        updatedAt: new Date().toISOString()
      };

      if (existingIdx >= 0) {
        updatedList[existingIdx] = accountObj;
      } else {
        updatedList.push(accountObj);
      }
      addedResults.push(accountObj);
    }

    saveAccountsStore(updatedList, pass);
    notifyDashboardClientList(pass);

    const validCount = updatedList.filter(a => a.status === 'Válido').length;
    const invalidCount = updatedList.filter(a => a.status === 'Inválido').length;

    // Retorna a resposta HTTP de imediato (< 50ms)
    res.json({
      success: true,
      added: addedResults.length,
      metrics: { total: updatedList.length, valid: validCount, invalid: invalidCount },
      accounts: updatedList
    });

    // Enriquece nome/avatar das contas em segundo plano, EM PARALELO (respeitando
    // o pool de validação), reportando progresso (%, tempo estimado) ao painel.
    // IMPORTANTE: atualiza o status mesmo quando a validação vier inválida/
    // suspensa/erro inesperado — senão a conta ficava presa para sempre como
    // "Validando..." (era exatamente isso que estava travando várias contas).
    validateBatchWithProgress(parsedTokens.map(item => item.token), pass);

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/validate-all', async (req, res) => {
  try {
    const pass = req.accessPass;
    const currentAccounts = loadAccountsStore(pass);
    currentAccounts.forEach(acc => { acc.pendingValidation = true; });
    saveAccountsStore(currentAccounts, pass);
    notifyDashboardClientList(pass);

    const validCount = currentAccounts.filter(a => a.status === 'Válido').length;
    const suspendedCount = currentAccounts.filter(a => a.status === 'Suspensa' || a.status === 'Bloqueada').length;
    const invalidCount = currentAccounts.filter(a => a.status === 'Inválido').length;

    // Responde imediatamente — com centenas de contas, validar tudo antes de
    // responder faria a requisição estourar o timeout (e travar o botão "Validar
    // Todas" indefinidamente sem nunca salvar nada, já que o save só acontecia
    // no final do laço inteiro).
    res.json({
      success: true,
      metrics: { total: currentAccounts.length, valid: validCount, suspended: suspendedCount, invalid: invalidCount },
      accounts: currentAccounts
    });

    // Valida todas em paralelo (respeitando o pool de validação), reportando
    // progresso (%, tempo estimado) ao painel.
    validateBatchWithProgress(currentAccounts.map(acc => acc.token), pass);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/remove-suspended', (req, res) => {
  const currentAccounts = loadAccountsStore(req.accessPass);
  const filtered = currentAccounts.filter(a => a.status !== 'Suspensa' && a.status !== 'Bloqueada');
  saveAccountsStore(filtered, req.accessPass);
  notifyDashboardClientList(req.accessPass);

  const validCount = filtered.filter(a => a.status === 'Válido').length;
  const invalidCount = filtered.filter(a => a.status === 'Inválido').length;

  res.json({
    success: true,
    metrics: { total: filtered.length, valid: validCount, suspended: 0, invalid: invalidCount },
    accounts: filtered
  });
});

app.delete('/api/accounts/remove-invalid', (req, res) => {
  const currentAccounts = loadAccountsStore(req.accessPass);
  const filtered = currentAccounts.filter(a => a.status === 'Válido');
  saveAccountsStore(filtered, req.accessPass);
  notifyDashboardClientList(req.accessPass);

  res.json({
    success: true,
    metrics: { total: filtered.length, valid: filtered.length, suspended: 0, invalid: 0 },
    accounts: filtered
  });
});

app.post('/api/accounts/bulk-delete', (req, res) => {
  try {
    const { accountIds } = req.body;
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhuma conta selecionada para exclusão.' });
    }

    const currentAccounts = loadAccountsStore(req.accessPass);
    const toDeleteSet = new Set(accountIds);
    const filtered = currentAccounts.filter(a => !toDeleteSet.has(a.id) && !toDeleteSet.has(a.token));
    const removedCount = currentAccounts.length - filtered.length;

    saveAccountsStore(filtered, req.accessPass);
    notifyDashboardClientList(req.accessPass);

    const validCount = filtered.filter(a => a.status === 'Válido').length;
    const invalidCount = filtered.filter(a => a.status === 'Inválido').length;

    res.json({
      success: true,
      removed: removedCount,
      metrics: { total: filtered.length, valid: validCount, invalid: invalidCount },
      accounts: filtered
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/unprotect', async (req, res) => {
  try {
    const { accountIds } = req.body;
    if (!accountIds || !Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ success: false, error: 'IDs de contas não informados' });
    }

    const currentAccounts = loadAccountsStore(req.accessPass);
    const updatedResults = [];

    for (const accId of accountIds) {
      const acc = currentAccounts.find(a => a.id === accId || a.token === accId);
      if (acc && acc.token) {
        console.log(`[Server] Tirando proteção da conta: ${acc.username}`);
        const result = await twitterEngine.unprotectAccountOnServer(acc.token, (stepIndex, statusText, state, errorDetail) => {
          broadcastToDashboards({
            type: 'STEP_UPDATE',
            clientId: acc.id,
            account: { username: acc.username, avatar: acc.avatar },
            stepIndex,
            totalSteps: 8,
            statusText,
            state,
            errorDetail
          });
        });

        if (result.success || result.isProtected === false) {
          acc.isProtected = false;
          acc.unlocked = 'Sim (🔓 Pública)';
        }
        acc.updatedAt = new Date().toISOString();
        updatedResults.push(acc);
      }
    }

    saveAccountsStore(currentAccounts, req.accessPass);
    notifyDashboardClientList();

    const validCount = currentAccounts.filter(a => a.status === 'Válido').length;
    const invalidCount = currentAccounts.filter(a => a.status === 'Inválido').length;

    res.json({
      success: true,
      unprotected: updatedResults.length,
      metrics: { total: currentAccounts.length, valid: validCount, invalid: invalidCount },
      accounts: currentAccounts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint para extrair mídias e legendas de múltiplos links em massa
app.post('/api/media-search/bulk', async (req, res) => {
  try {
    const { links } = req.body;
    if (!links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum link informado' });
    }

    console.log(`[Server] Extraindo mídias em massa de ${links.length} links...`);
    const results = await twitterEngine.extractBulkLinksData(links);

    res.json({
      success: true,
      count: results.length,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint da Aba Resultados: Retorna os posts publicados filtrados por período e ordenados por engajamento
app.get('/api/results', (req, res) => {
  try {
    const period = String(req.query.period || 'today').toLowerCase();
    const allPosts = loadPublishedPostsStore(req.accessPass);

    // Filtra pelo período selecionado
    const filteredPosts = filterPostsByPeriod(allPosts, period);

    // Score de engajamento viral (Likes * 100 + Views * 10 + Reposts * 50 + Replies * 30)
    const getEngagementScore = (p) => {
      const m = p.metrics || {};
      return (Number(m.views || 0) * 10) + (Number(m.likes || 0) * 100) + (Number(m.retweets || 0) * 50) + (Number(m.replies || 0) * 30);
    };

    // Ordena por engajamento real em ordem decrescente
    const sortedByViral = [...filteredPosts].sort((a, b) => getEngagementScore(b) - getEngagementScore(a));

    // Pega o Top 1, Top 2 e Top 3
    const topPosts = sortedByViral.slice(0, 3);

    res.json({
      success: true,
      period: period,
      totalCount: filteredPosts.length,
      topPosts: topPosts,
      posts: sortedByViral
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint para atualizar métricas (Views, Likes, Reposts, Replies) dos posts publicados
app.post('/api/results/refresh', async (req, res) => {
  try {
    const allPosts = loadPublishedPostsStore(req.accessPass);
    if (allPosts.length === 0) {
      return res.json({ success: true, updated: 0, posts: [] });
    }

    console.log(`[Server] Atualizando métricas ao vivo de ${allPosts.length} postagens salvas...`);
    let updatedCount = 0;
    const accounts = loadAccountsStore(req.accessPass);
    const validToken = accounts.find(a => a.status === 'Válido' && a.token)?.token;

    for (let post of allPosts) {
      if (!post.tweetUrl) continue;
      try {
        const freshData = await twitterEngine.fetchSingleTweetDataInternal(post.tweetUrl);
        if (freshData && freshData.metrics) {
          post.metrics = {
            views: Math.max(freshData.metrics.views || 0, post.metrics?.views || 0),
            likes: Math.max(freshData.metrics.likes || 0, post.metrics?.likes || 0),
            retweets: Math.max(freshData.metrics.retweets || 0, post.metrics?.retweets || 0),
            replies: Math.max(freshData.metrics.replies || 0, post.metrics?.replies || 0)
          };
          if (freshData.caption && !post.caption) post.caption = freshData.caption;
          if (freshData.mediaUrls && freshData.mediaUrls.length > 0 && (!post.mediaUrls || post.mediaUrls.length === 0)) {
            post.mediaUrls = freshData.mediaUrls;
          }
          if (freshData.mediaDetails && freshData.mediaDetails[0]?.thumbnailUrl) {
            post.thumbnailUrl = freshData.mediaDetails[0].thumbnailUrl;
          }
          updatedCount++;
        }

        // Se views forem 0 ou se a API retornar valor menor que a página real, faz raspagem direta do DOM do Twitter
        if (!post.metrics || Number(post.metrics.views || 0) === 0 || Number(post.metrics.likes || 0) === 0) {
          const domMetrics = await twitterEngine.scrapeRealMetricsFromDOM(post.tweetUrl, validToken);
          if (domMetrics) {
            post.metrics = {
              views: Math.max(domMetrics.views || 0, post.metrics?.views || 0),
              likes: Math.max(domMetrics.likes || 0, post.metrics?.likes || 0),
              retweets: Math.max(domMetrics.retweets || 0, post.metrics?.retweets || 0),
              replies: Math.max(domMetrics.replies || 0, post.metrics?.replies || 0)
            };
          }
        }
      } catch (errPost) {
        console.error(`[Server] Erro ao atualizar métricas de ${post.tweetUrl}:`, errPost.message);
      }
    }

    savePublishedPostsStore(allPosts, req.accessPass);

    const period = String(req.body.period || 'today').toLowerCase();
    const filteredPosts = filterPostsByPeriod(allPosts, period);
    const sortedByViral = [...filteredPosts].sort((a, b) => {
      const vA = Number(a.metrics?.views || 0);
      const vB = Number(b.metrics?.views || 0);
      if (vB !== vA) return vB - vA;
      return Number(b.metrics?.likes || 0) - Number(a.metrics?.likes || 0);
    });
    const topPosts = sortedByViral.slice(0, 3);

    res.json({
      success: true,
      updated: updatedCount,
      period: period,
      totalCount: filteredPosts.length,
      topPosts: topPosts,
      posts: sortedByViral
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Loop em segundo plano: Atualiza métricas automaticamente a cada 10 minutos.
// Duas proteções importantes que faltavam:
// 1. autoRefreshRunning: com uma base grande (ex: 1377 posts), um ciclo inteiro
//    (1 navegador aberto por post, um de cada vez) podia levar bem mais que os
//    10 minutos do intervalo — sem essa trava, o próximo tick do setInterval
//    começava OUTRO ciclo por cima do anterior (ainda rodando), empilhando
//    ciclos sobrepostos indefinidamente.
// 2. runWithBrowserSlot: antes, cada navegador de métrica era aberto por FORA
//    do limite de 8 usado por postagem/edição — ou seja, se o usuário já
//    estivesse usando os 8 navegadores pra postar, esse loop abria um 9º (e um
//    10º, 11º...) por cima, competindo por CPU/memória e derrubando as
//    postagens reais em andamento. Agora ele respeita o mesmo limite e fica na
//    fila atrás de ações do usuário em vez de rodar por cima delas.
let autoRefreshRunning = false;
setInterval(async () => {
  if (autoRefreshRunning) {
    console.log('[AutoRefresh] Ciclo anterior ainda em andamento, pulando esta rodada.');
    return;
  }
  autoRefreshRunning = true;
  try {
    const allPosts = loadPublishedPostsStore();
    if (allPosts.length === 0) return;
    const accounts = loadAccountsStore();
    const validToken = accounts.find(a => a.status === 'Válido' && a.token)?.token;

    console.log(`[AutoRefresh] Sincronizando métricas em segundo plano para ${allPosts.length} postagens...`);
    for (let post of allPosts) {
      if (!post.tweetUrl) continue;
      const domMetrics = await runWithBrowserSlot(`autorefresh_${post.tweetUrl}`, () => {}, () =>
        twitterEngine.scrapeRealMetricsFromDOM(post.tweetUrl, validToken)
      , 'Sincronização de métricas (segundo plano)').catch(() => null);
      if (domMetrics) {
        post.metrics = {
          views: Math.max(domMetrics.views || 0, post.metrics?.views || 0),
          likes: Math.max(domMetrics.likes || 0, post.metrics?.likes || 0),
          retweets: Math.max(domMetrics.retweets || 0, post.metrics?.retweets || 0),
          replies: Math.max(domMetrics.replies || 0, post.metrics?.replies || 0)
        };
      }
    }
    savePublishedPostsStore(allPosts);
    console.log(`[AutoRefresh] ✓ Métricas de ${allPosts.length} postagens atualizadas no banco de dados com sucesso!`);
  } catch (e) {
    console.error('[AutoRefresh] Erro no loop de sincronização:', e.message);
  } finally {
    autoRefreshRunning = false;
  }
}, 10 * 60 * 1000);

app.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  const currentAccounts = loadAccountsStore();
  const filtered = currentAccounts.filter(a => a.id !== id);
  saveAccountsStore(filtered);
  notifyDashboardClientList();

  const validCount = filtered.filter(a => a.status === 'Válido').length;
  const invalidCount = filtered.filter(a => a.status === 'Inválido').length;

  res.json({
    success: true,
    metrics: { total: filtered.length, valid: filtered.length, invalid: invalidCount },
    accounts: filtered
  });
});

// Ativa/desativa uma conta como "Conta Mãe" (usada para dar repost automático
// nos posts publicados por outras contas — ver DISPATCH_POST/DISPATCH_MASS_POST)
app.post('/api/accounts/:id/toggle-mother', (req, res) => {
  try {
    const { id } = req.params;
    const currentAccounts = loadAccountsStore();
    const acc = currentAccounts.find(a => a.id === id);
    if (!acc) {
      return res.status(404).json({ success: false, error: 'Conta não encontrada' });
    }

    acc.isMother = !(acc.isMother === true);
    acc.updatedAt = new Date().toISOString();
    saveAccountsStore(currentAccounts);
    notifyDashboardClientList();
    saveAccountsStore(currentAccounts, req.accessPass);
    notifyDashboardClientList(req.accessPass);

    const validCount = currentAccounts.filter(a => a.status === 'Válido').length;
    const invalidCount = currentAccounts.filter(a => a.status === 'Inválido').length;

    res.json({
      success: true,
      account: acc,
      metrics: { total: currentAccounts.length, valid: validCount, invalid: invalidCount },
      accounts: currentAccounts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function getConnectedClientsList(pass = 'adm123') {
  const list = [];
  const now = Date.now();
  const savedAccounts = loadAccountsStore(pass);

  // 1. Contas salvas via token auth_token no banco do ambiente específico (pass)
  for (const acc of savedAccounts) {
    if (acc.status === 'Válido') {
      list.push({
        clientId: acc.id || ('token_' + acc.token),
        account: { username: acc.username, name: acc.name, avatar: acc.avatar },
        browserProfile: 'Token (auth_token)',
        extensionVersion: '3.1.0',
        isOnline: true,
        token: acc.token,
        lastStatus: 'idle',
        connectedAt: acc.updatedAt
      });
    }
  }

  // 2. Apenas no ambiente ADM Master incluímos extensões locais registradas
  if (pass === 'adm123') {
    for (const [clientId, client] of clientsMap.entries()) {
      const wsOpen = client.ws && client.ws.readyState === WebSocket.OPEN;
      const recentHeartbeat = client.lastSeen && (now - client.lastSeen < 30000);
      const isOnline = wsOpen || recentHeartbeat;

      if (isOnline && !list.some(l => l.clientId === clientId)) {
        list.push({
          clientId: clientId,
          account: client.info?.account || { username: 'Desconhecido', avatar: '' },
          browserProfile: client.info?.browserProfile || 'Navegador',
          extensionVersion: '3.1.0',
          isOnline: true,
          lastStatus: client.status || 'idle',
          connectedAt: client.connectedAt
        });
      }
    }
  }

  return list;
}

function notifyDashboardClientList(pass = 'adm123') {
  const payload = JSON.stringify({
    type: 'CLIENT_LIST_UPDATE',
    clients: getConnectedClientsList(pass)
  });
  dashboardSockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && (ws.accessPass === pass || (!ws.accessPass && pass === 'adm123'))) {
      ws.send(payload);
    }
  });
}

// Incrementa o contador de posts publicados por uma conta (identificada por id ou token)
function bumpAccountPostCount(idOrToken, pass = 'adm123') {
  if (!idOrToken) return;
  const currentAccounts = loadAccountsStore(pass);
  const acc = currentAccounts.find(a => a.id === idOrToken || a.token === idOrToken);
  if (!acc) return;

  acc.postsCount = (acc.postsCount || 0) + 1;
  saveAccountsStore(currentAccounts, pass);
  notifyDashboardClientList(pass);
}

// Atualiza o status de uma conta (ex: 'Suspensa') quando isso é detectado durante
// uma postagem — sem essa função, o código que chamava markAccountStatus() lançava
// um erro (função inexistente) sempre que uma conta suspensa era detectada, o que
// podia derrubar o processo do servidor (unhandled rejection) e também explicava
// por que contas suspensas nunca ficavam marcadas como tal automaticamente.
function markAccountStatus(idOrToken, status, pass = 'adm123') {
  if (!idOrToken || !status) return;
  const currentAccounts = loadAccountsStore(pass);
  const acc = currentAccounts.find(a => a.id === idOrToken || a.token === idOrToken);
  if (!acc || acc.status === status) return;

  console.log(`[Server] Conta @${acc.username || idOrToken} mudou de status: ${acc.status} → ${status}`);
  acc.status = status;
  acc.updatedAt = new Date().toISOString();
  saveAccountsStore(currentAccounts, pass);
  notifyDashboardClientList(pass);
}

// Marca que o perfil de uma conta foi editado com sucesso (identificada por id ou token)
function markProfileEdited(idOrToken) {
  if (!idOrToken) return;
  const currentAccounts = loadAccountsStore();
  const acc = currentAccounts.find(a => a.id === idOrToken || a.token === idOrToken);
  if (!acc) return;
  acc.profileEdited = true;
  acc.updatedAt = new Date().toISOString();
  saveAccountsStore(currentAccounts);
  notifyDashboardClientList();
}

// Dispara, em segundo plano (sem bloquear o restante do fluxo de postagem), o
// repost do tweet recém-publicado em cada "Conta Mãe" selecionada. Cada conta
// mãe reporta seu próprio progresso no monitor de atividade, identificada com
// o prefixo "mother_" para diferenciá-la das contas normais.
function buildMotherRepostPromises(motherAccountIds, tweetUrl, originClientId, savedAccounts) {
  if (!tweetUrl || !Array.isArray(motherAccountIds) || motherAccountIds.length === 0) return [];

  const promises = [];
  for (const motherId of motherAccountIds) {
    const motherAcc = savedAccounts.find(a => a.id === motherId);
    if (!motherAcc || !motherAcc.token) continue;

    const progressId = `mother_${motherAcc.id}__${originClientId}`;
    console.log(`[Server] Conta mãe @${motherAcc.username} vai repostar: ${tweetUrl}`);

    const onMotherProgress = (stepIndex, label, stepStatus, error) => {
      broadcastToDashboards({
        type: 'STEP_UPDATE',
        clientId: progressId,
        stepIndex: stepIndex,
        label: label,
        stepStatus: stepStatus,
        error: error,
        overallStatus: stepStatus === 'error' ? 'error' : (stepStatus === 'completed' ? 'completed' : 'running'),
        isMotherAction: true,
        motherUsername: motherAcc.username,
        motherAvatar: motherAcc.avatar
      });
    };

    promises.push(
      runWithBrowserSlot(progressId, onMotherProgress, () =>
        twitterEngine.repostTweetOnServer(motherAcc.token, tweetUrl, onMotherProgress)
      , `Repost (conta mãe @${motherAcc.username})`).catch(err => {
        console.error(`[Server] Erro no repost da conta mãe @${motherAcc.username}:`, err.message);
      })
    );
  }
  return promises;
}

// Modo "fast": dispara os reposts das mães e não espera terminar — a próxima
// conta do disparo já pode seguir em paralelo.
function dispatchMotherReposts(motherAccountIds, tweetUrl, originClientId, savedAccounts) {
  buildMotherRepostPromises(motherAccountIds, tweetUrl, originClientId, savedAccounts);
}

// Modo "padrão": espera todos os reposts das mães terminarem antes de deixar
// o chamador seguir pra próxima conta — é o que garante a ordem post→repost→
// próxima conta, em vez de todas as contas postarem primeiro e os reposts
// ficarem pra depois (que é o que "fast" faz).
async function dispatchMotherRepostsAndWait(motherAccountIds, tweetUrl, originClientId, savedAccounts) {
  await Promise.all(buildMotherRepostPromises(motherAccountIds, tweetUrl, originClientId, savedAccounts));
}

wss.on('connection', (ws, req) => {
  let isDashboard = false;
  let currentClientId = null;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // 1. Registro da Interface do Painel Web (Autenticado)
      if (msg.type === 'REGISTER_DASHBOARD') {
        const clientPass = String(msg.pass || '').trim();
        if (clientPass !== 'adm123' && clientPass !== 'user123') {
          ws.send(JSON.stringify({
            type: 'AUTH_REQUIRED',
            error: 'Senha de acesso inválida ou ausente. Faça o login primeiro.'
          }));
          return;
        }

        isDashboard = true;
        ws.accessPass = clientPass;
        dashboardSockets.add(ws);
        // Envia lista atual de clientes conectados para o painel
        ws.send(JSON.stringify({
          type: 'CLIENT_LIST_UPDATE',
          clients: getConnectedClientsList(clientPass)
        }));
        // Envia estado atual persistido do monitor de atividades (F5 safe)
        ws.send(JSON.stringify({
          type: 'INIT_PROGRESS_STATE',
          progressMap: Array.from(globalProgressMap.entries())
        }));
        return;
      }

      if (msg.type === 'CLEAR_PROGRESS_STATE') {
        globalProgressMap.clear();
        broadcastToDashboards({
          type: 'INIT_PROGRESS_STATE',
          progressMap: []
        });
        return;
      }

      // 2. Registro da Extensão de um Navegador
      if (msg.type === 'REGISTER_CLIENT') {
        currentClientId = msg.clientId;
        clientsMap.set(currentClientId, {
          ws: ws,
          info: msg.info || {},
          status: 'idle',
          connectedAt: new Date().toISOString()
        });
        console.log(`[ws] Extensão conectada/registrada: ${currentClientId} (@${msg.info?.account?.username || 'desconhecido'})`);
        notifyDashboardClientList();
        return;
      }

      // 3. Extensão enviou atualização de perfil de conta do Twitter
      if (msg.type === 'ACCOUNT_SYNC') {
        if (currentClientId && clientsMap.has(currentClientId)) {
          const client = clientsMap.get(currentClientId);
          client.info = { ...client.info, account: msg.account };
          notifyDashboardClientList();
        }
        return;
      }

      // 4. Extensão enviou progresso de execução de passos (Passos 0 a 8)
      if (msg.type === 'STEP_UPDATE') {
        if (currentClientId && clientsMap.has(currentClientId)) {
          const client = clientsMap.get(currentClientId);
          client.status = msg.status || client.status;
        }
        // Repassa para a UI do Painel Web
        broadcastToDashboards({
          type: 'STEP_UPDATE',
          clientId: currentClientId,
          stepIndex: msg.stepIndex,
          stepId: msg.stepId,
          label: msg.label,
          stepStatus: msg.stepStatus,
          error: msg.error,
          message: msg.message,
          overallStatus: msg.overallStatus
        });
        return;
      }

      // 5. Painel Web solicitou disparo de postagem para contas selecionadas
      if (msg.type === 'DISPATCH_POST') {
        const { targetClientIds, postData, delayBetweenClientsSec, motherAccountIds = [], postMode = 'fast' } = msg;
        console.log(`[ws] Disparando postagem para ${targetClientIds.length} conta(s). Stagger: ${delayBetweenClientsSec || 0}s. Contas mães: ${motherAccountIds.length}. Modo: ${postMode}.`);

        const pass = ws.accessPass || 'adm123';
        const savedAccounts = loadAccountsStore(pass);
        // Se houver contas mães selecionadas, força a captura da URL do post
        // publicado (necessária para que as mães saibam o que repostar).
        const postDataForDispatch = motherAccountIds.length > 0 ? { ...postData, captureUrl: true } : postData;

        const runOneAccount = async (cId) => {
          let tokenToUse = null;
          let targetExtClient = null;

          if (cId.startsWith('token_')) {
            const accId = cId.replace('token_', '');
            const acc = savedAccounts.find(a => a.id === accId || a.token === accId);
            if (acc) {
              tokenToUse = acc.token;
              targetExtClient = Array.from(clientsMap.values()).find(c =>
                c.ws && c.ws.readyState === WebSocket.OPEN && c.info?.account?.username && acc.username &&
                c.info.account.username.toLowerCase() === acc.username.toLowerCase()
              );
            }
          } else {
            targetExtClient = clientsMap.get(cId);
            if (!targetExtClient) {
              const acc = savedAccounts.find(a => a.id === cId || a.username === cId);
              if (acc) tokenToUse = acc.token;
            }
          }

          if (targetExtClient && targetExtClient.ws && targetExtClient.ws.readyState === WebSocket.OPEN) {
            console.log(`[ws] Roteando post diretamente para a extensão ativa da conta: @${targetExtClient.info?.account?.username || cId}`);
            targetExtClient.ws.send(JSON.stringify({ type: 'EXECUTE_POST', postData: postDataForDispatch }));
            return;
          }

          if (!tokenToUse) return;

          const onPostProgress = (stepIndex, label, stepStatus, error) => {
            broadcastToDashboards({
              type: 'STEP_UPDATE',
              clientId: cId,
              stepIndex: stepIndex,
              label: label,
              stepStatus: stepStatus,
              error: error,
              overallStatus: stepStatus === 'error' ? 'error' : stepIndex === 8 ? 'completed' : 'running'
            });
          };

          const accForLabel = savedAccounts.find(a => a.id === cId || a.token === tokenToUse || a.username === cId);
          try {
            const result = await runWithBrowserSlot(cId, onPostProgress, () =>
              twitterEngine.executePostOnServer(tokenToUse, postDataForDispatch, onPostProgress)
            , `Postagem em @${accForLabel ? accForLabel.username : cId}`);

            if (result && result.success) {
              bumpAccountPostCount(cId, pass);
              const acc = savedAccounts.find(a => a.id === cId || a.token === tokenToUse);
              if (result.tweetUrl) {
                registerPublishedPost({
                  tweetUrl: result.tweetUrl,
                  username: acc ? acc.username : cId,
                  name: acc ? acc.name : '',
                  avatar: acc ? acc.avatar : '',
                  caption: postDataForDispatch.text || '',
                  mediaUrls: postDataForDispatch.mediaUrls || [],
                  hasVideo: postDataForDispatch.hasVideo !== false
                });
                // Modo padrão: espera os reposts das mães terminarem antes de
                // seguir pra próxima conta. Modo fast: dispara e não espera.
                if (postMode === 'standard') {
                  await dispatchMotherRepostsAndWait(motherAccountIds, result.tweetUrl, cId, savedAccounts);
                } else {
                  dispatchMotherReposts(motherAccountIds, result.tweetUrl, cId, savedAccounts);
                }
              } else if (motherAccountIds.length > 0) {
                console.warn(`[Server] Não foi possível obter a URL do post de ${cId} — contas mães não vão repostar essa publicação.`);
              }
            } else if (result && result.error && (result.error.includes('suspens') || result.error.includes('bloquead') || result.error.includes('suspended') || result.error.includes('locked'))) {
              markAccountStatus(cId, 'Suspensa', pass);
            }
          } catch (err) {
            console.error(`[Server] Erro na postagem de ${cId}:`, err.message);
            if (err.message && (err.message.includes('suspens') || err.message.includes('bloquead') || err.message.includes('suspended') || err.message.includes('locked'))) {
              markAccountStatus(cId, 'Suspensa', pass);
            }
          }
        };

        if (postMode === 'standard') {
          // Pool de workers em paralelo (até MAX_CONCURRENT_BROWSERS por vez,
          // igual ao modo Fast) — mas cada worker só pega a PRÓXIMA conta da
          // fila depois de terminar o post + os reposts das mães da conta
          // anterior. Isso mantém a mesma velocidade "8 em 8" de antes, sem
          // perder a ordem post→repost de cada conta (que era o ponto do modo
          // Padrão) — só o modo 100% sequencial (1 por vez) foi trocado por isso.
          const myEpoch = dispatchEpoch;
          const concurrency = Math.min(MAX_CONCURRENT_BROWSERS, targetClientIds.length);
          let nextIndex = 0;
          const worker = async () => {
            while (true) {
              if (myEpoch !== dispatchEpoch) {
                console.log('[Server] Worker de postagem (modo Padrão) interrompido por Pausar Ações.');
                break;
              }
              const i = nextIndex++;
              if (i >= targetClientIds.length) break;
              await runOneAccount(targetClientIds[i]);
              if (delayBetweenClientsSec > 0 && nextIndex < targetClientIds.length) {
                await new Promise(r => setTimeout(r, delayBetweenClientsSec * 1000));
              }
            }
          };
          Promise.all(Array.from({ length: concurrency }, worker));
        } else {
          targetClientIds.forEach((cId, i) => {
            const delayMs = (delayBetweenClientsSec || 0) * 1000 * i;
            scheduleDispatch(() => runOneAccount(cId), delayMs, cId);
          });
        }
        return;
      }

      // 5.5 Painel Web solicitou disparo de postagem EM MASSA (Várias mídias e legendas para várias contas)
      if (msg.type === 'DISPATCH_MASS_POST') {
        const { items, staggerDelay = 0, motherAccountIds = [], postMode = 'fast' } = msg;
        if (!Array.isArray(items) || items.length === 0) return;

        console.log(`[ws] Disparando postagem em massa para ${items.length} contas. Stagger: ${staggerDelay}s. Contas mães: ${motherAccountIds.length}. Modo: ${postMode}.`);
        const pass = ws.accessPass || 'adm123';
        const savedAccounts = loadAccountsStore(pass);

        const resolveMassItem = (item, i) => {
          const acc = savedAccounts.find(a => a.token === item.token || a.id === item.token || a.username === item.username);
          const tokenToUse = acc ? acc.token : item.token;
          const clientId = acc ? acc.id : `mass_${i}`;
          return { acc, tokenToUse, clientId };
        };

        const runOneItem = async (item, i) => {
          const { acc, tokenToUse, clientId } = resolveMassItem(item, i);

          if (!tokenToUse) return;

          // 1. CHECAGEM PREVENTIVA: Se a conta estiver marcada como Suspensa ou Bloqueada, PULA AUTOMATICAMENTE!
          if (acc && (acc.status === 'Suspensa' || acc.status === 'Bloqueada')) {
            console.log(`[MassPost] 🚫 Conta @${acc.username || clientId} está SUSPENSA pelo Twitter. Pulando para a próxima conta...`);
            broadcastToDashboards({
              type: 'STEP_UPDATE',
              clientId: clientId,
              stepIndex: 0,
              label: `🚫 Conta @${acc.username || clientId} SUSPENSA pelo Twitter. Pulada automaticamente!`,
              stepStatus: 'error',
              error: 'Conta suspensa pelo Twitter (pulada automaticamente)',
              overallStatus: 'error'
            });
            return; // Pula imediatamente, não bloqueia as demais
          }

          const itemForDispatch = motherAccountIds.length > 0 ? { ...item, captureUrl: true } : item;
          const onMassPostProgress = (stepIndex, label, stepStatus, error) => {
            broadcastToDashboards({
              type: 'STEP_UPDATE',
              clientId: clientId,
              stepIndex: stepIndex,
              label: label,
              stepStatus: stepStatus,
              error: error,
              overallStatus: stepStatus === 'error' ? 'error' : stepIndex === 8 ? 'completed' : 'running'
            });
          };

          const result = await runWithBrowserSlot(clientId, onMassPostProgress, () =>
            twitterEngine.executePostOnServer(tokenToUse, itemForDispatch, onMassPostProgress)
          , `Postagem em massa em @${item.username || clientId}`).catch(err => {
            console.error(`[Server] Erro no post em massa para ${clientId}:`, err.message);
            if (err.message && (err.message.includes('suspens') || err.message.includes('bloquead') || err.message.includes('suspended') || err.message.includes('locked'))) {
              markAccountStatus(clientId, 'Suspensa', pass);
            }
            return null;
          });

          if (result && result.error && (result.error.includes('suspens') || result.error.includes('bloquead') || result.error.includes('suspended'))) {
            markAccountStatus(clientId, 'Suspensa', pass);
          }

          if (result && result.success) {
            bumpAccountPostCount(clientId, pass);
            if (result.tweetUrl) {
              registerPublishedPost({
                tweetUrl: result.tweetUrl,
                username: acc ? acc.username : item.username || clientId,
                name: acc ? acc.name : '',
                avatar: acc ? acc.avatar : '',
                caption: itemForDispatch.text || itemForDispatch.caption || '',
                mediaUrls: itemForDispatch.mediaUrls || [],
                hasVideo: itemForDispatch.hasVideo !== false
              }, pass);
              // Modo padrão: espera os reposts das mães terminarem antes de
              // seguir pra próxima conta. Modo fast: dispara e não espera.
              if (postMode === 'standard') {
                await dispatchMotherRepostsAndWait(motherAccountIds, result.tweetUrl, clientId, savedAccounts);
              } else {
                dispatchMotherReposts(motherAccountIds, result.tweetUrl, clientId, savedAccounts);
              }
            } else if (motherAccountIds.length > 0) {
              console.warn(`[Server] Não foi possível obter a URL do post de ${clientId} — contas mães não vão repostar essa publicação.`);
            }
          }
        };

        if (postMode === 'standard') {
          // Pool de workers em paralelo (até MAX_CONCURRENT_BROWSERS por vez,
          // igual ao modo Fast) — cada worker só pega a PRÓXIMA conta da fila
          // depois de terminar o post + os reposts das mães da conta anterior.
          // Mantém a mesma velocidade "8 em 8" de antes, sem perder a ordem
          // post→repost por conta.
          const myEpoch = dispatchEpoch;
          const concurrency = Math.min(MAX_CONCURRENT_BROWSERS, items.length);
          let nextIndex = 0;
          const worker = async () => {
            while (true) {
              if (myEpoch !== dispatchEpoch) {
                console.log('[Server] Worker de postagem em massa (modo Padrão) interrompido por Pausar Ações.');
                break;
              }
              const i = nextIndex++;
              if (i >= items.length) break;
              await runOneItem(items[i], i);
              if (staggerDelay > 0 && nextIndex < items.length) {
                await new Promise(r => setTimeout(r, staggerDelay * 1000));
              }
            }
          };
          Promise.all(Array.from({ length: concurrency }, worker));
        } else {
          // Fast: dispara todas em paralelo/escalonado, mães disparadas em
          // segundo plano assim que cada post individual termina.
          items.forEach((item, i) => {
            const { clientId } = resolveMassItem(item, i);
            const delayMs = (staggerDelay || 0) * 1000 * i;
            scheduleDispatch(() => runOneItem(item, i), delayMs, clientId);
          });
        }
        return;
      }

      // 6. Painel Web solicitou cancelamento/pausa em uma conta
      if (msg.type === 'CANCEL_POST') {
        const client = clientsMap.get(msg.targetClientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'CANCEL_POST' }));
        }
        return;
      }

      // 6.5 Painel Web pediu para PAUSAR TODAS as ações em andamento (postagem,
      // disparo em massa, edição de perfil). Cancela tudo que ainda não começou
      // (aguardando o atraso entre contas ou esperando vaga de navegador livre)
      // e força o fechamento de qualquer navegador headless já aberto no meio
      // de uma ação — que é a única forma de parar algo que já está rodando.
      if (msg.type === 'PAUSE_ALL_ACTIONS') {
        // Invalida qualquer laço sequencial (modo "Postagem Padrão") em
        // andamento — ele vai checar isso e parar em vez de seguir pra
        // próxima conta depois que a atual for interrompida abaixo.
        dispatchEpoch++;

        const pendingCount = pendingDispatchTimers.size;
        pendingDispatchTimers.forEach((cId, timerId) => {
          clearTimeout(timerId);
          broadcastToDashboards({
            type: 'STEP_UPDATE',
            clientId: cId,
            stepIndex: -1,
            label: '⏸ Ação pausada pelo usuário antes de começar.',
            stepStatus: 'error',
            error: 'Pausado pelo usuário',
            overallStatus: 'error'
          });
        });
        pendingDispatchTimers.clear();

        const queuedCount = browserSemaphore.queue.length;
        browserSemaphore.queue.forEach(({ clientId: cId }) => {
          if (!cId) return;
          broadcastToDashboards({
            type: 'STEP_UPDATE',
            clientId: cId,
            stepIndex: -1,
            label: '⏸ Ação pausada pelo usuário (aguardava vaga de navegador).',
            stepStatus: 'error',
            error: 'Pausado pelo usuário',
            overallStatus: 'error'
          });
        });
        browserSemaphore.queue.length = 0;

        const activeCount = twitterEngine.cancelAllActiveSessions();

        console.log(`[ws] ⏸ PAUSA solicitada: ${pendingCount} agendada(s) canceladas, ${queuedCount} na fila descartadas, ${activeCount} em andamento interrompidas.`);
        broadcastToDashboards({
          type: 'ACTIONS_PAUSED',
          pendingCount,
          queuedCount,
          activeCount
        });
        return;
      }

      // 7. Painel Web solicitou acionamento de Login 2FA
      if (msg.type === 'TRIGGER_LOGIN') {
        const client = clientsMap.get(msg.targetClientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'TRIGGER_LOGIN',
            account: msg.account
          }));
        }
        return;
      }

      // 8. Painel Web solicitou edição de perfil (avatar, banner, bio, siteLink)
      if (msg.type === 'DISPATCH_EDIT_PROFILE') {
        const { targetClientIds, profileData } = msg;
        // O formulário de edição de perfil não tem controle de atraso na UI, então
        // delayBetweenClientsSec sempre chegava 0/undefined — todas as contas abriam
        // o navegador e acessavam x.com/settings/profile NO MESMO INSTANTE, a partir
        // do mesmo IP do servidor. Esse padrão de rajada é reconhecido como tráfego
        // automatizado suspeito pelo X, que passa a travar/bloquear a tela de
        // configurações para TODAS as contas (mesmo saudáveis). Forçamos aqui um
        // atraso mínimo entre o início de cada edição para evitar esse bloqueio.
        const MIN_PROFILE_EDIT_STAGGER_SEC = 8;
        const delayBetweenClientsSec = Math.max(msg.delayBetweenClientsSec || 0, MIN_PROFILE_EDIT_STAGGER_SEC);
        console.log(`[ws] Disparando alteração de perfil para ${targetClientIds.length} conta(s). Stagger: ${delayBetweenClientsSec}s.`);

        const savedAccounts = loadAccountsStore();

        for (let i = 0; i < targetClientIds.length; i++) {
          const cId = targetClientIds[i];
          const delayMs = delayBetweenClientsSec * 1000 * i;

          scheduleDispatch(async () => {
            let tokenToUse = null;
            if (cId.startsWith('token_')) {
              const accId = cId.replace('token_', '');
              const acc = savedAccounts.find(a => a.id === accId);
              if (acc) tokenToUse = acc.token;
            } else {
              const client = clientsMap.get(cId);
              if (client && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'EXECUTE_EDIT_PROFILE', profileData: profileData }));
                return;
              } else {
                const acc = savedAccounts.find(a => a.id === cId || a.username === cId);
                if (acc) tokenToUse = acc.token;
              }
            }

            if (tokenToUse) {
              const onProfileProgress = (stepIndex, label, stepStatus, error) => {
                broadcastToDashboards({
                  type: 'STEP_UPDATE',
                  clientId: cId,
                  stepIndex: stepIndex,
                  label: label,
                  stepStatus: stepStatus,
                  error: error,
                  overallStatus: stepStatus === 'error' ? 'error' : stepIndex === 8 ? 'completed' : 'running'
                });
              };

              const accForLabel = savedAccounts.find(a => a.id === cId || a.token === tokenToUse || a.username === cId);
              runWithBrowserSlot(cId, onProfileProgress, () =>
                twitterEngine.executeProfileEditOnServer(tokenToUse, profileData, onProfileProgress)
              , `Edição de perfil de @${accForLabel ? accForLabel.username : cId}`).then(result => {
                if (result && result.success) markProfileEdited(cId);
              }).catch(err => {
                console.error(`[Server] Erro na edição de perfil de ${cId}:`, err.message);
              });
            }
          }, delayMs, cId);
        }
        return;
      }

      // 9. Painel Web solicitou login via Token (auth_token)
      if (msg.type === 'DISPATCH_TOKEN_LOGIN') {
        const { targetClientId, token } = msg;
        console.log(`[ws] Solicitando login por token no client: ${targetClientId}`);
        const client = clientsMap.get(targetClientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({
            type: 'EXECUTE_TOKEN_LOGIN',
            token: token
          }));
        }
        return;
      }

    } catch (err) {
      console.error('[ws] Erro processando mensagem:', err);
    }
  });

  ws.on('close', () => {
    if (isDashboard) {
      dashboardSockets.delete(ws);
    }
    if (currentClientId && clientsMap.has(currentClientId)) {
      console.log(`[ws] Extensão desconectada: ${currentClientId}`);
      clientsMap.delete(currentClientId);
      notifyDashboardClientList();
    }
  });
});

// Contas presas em "Validando..." (pendingValidation: true) que ficam salvas
// assim no accounts.json — normalmente porque o servidor foi reiniciado (ou
// travou) no meio da validação delas. Sem isso, ficavam presas nesse estado
// pra sempre, já que nada nunca voltava pra desligar a flag. Roda uma vez ao
// iniciar o servidor, pra cada arquivo de contas (admin e usuário).
function recoverStuckValidations() {
  for (const pass of ['adm123', 'user123']) {
    const accs = loadAccountsStore(pass);
    const stuck = accs.filter(a => a.pendingValidation === true);
    if (stuck.length === 0) continue;
    console.log(`[Server] 🔄 Recuperando ${stuck.length} conta(s) presa(s) em "Validando..." (${pass})...`);
    validateBatchWithProgress(stuck.map(a => a.token), pass);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Painel Web Central rodando em: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Server pronto em: ws://localhost:${PORT}`);
  console.log(`=======================================================`);
  recoverStuckValidations();
});
