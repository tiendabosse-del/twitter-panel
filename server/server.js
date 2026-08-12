const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// API Endpoint: Upload de Mídias pelo Painel
app.post('/api/upload-media', upload.array('files', 4), (req, res) => {
  try {
    const files = req.files || [];
    const fileUrls = files.map(f => {
      return {
        url: `/uploads/${f.filename}`,
        name: f.originalname,
        type: f.mimetype,
        size: f.size
      };
    });
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
  acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.current--;
    }
  }
}
const browserSemaphore = new Semaphore(MAX_CONCURRENT_BROWSERS);

// Executa um trabalho que abre um navegador Puppeteer respeitando o limite global
// de concorrência. Antes de conseguir uma vaga, avisa a UI que a conta está na fila.
async function runWithBrowserSlot(clientId, onProgress, fn) {
  if (browserSemaphore.current >= browserSemaphore.max) {
    onProgress(0, '⏳ Na fila, aguardando um navegador ficar livre...', 'running');
  }
  await browserSemaphore.acquire();
  try {
    return await fn();
  } finally {
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
  const invalid = accounts.filter(a => a.status === 'Inválido').length;

  res.json({
    success: true,
    metrics: { total, valid, invalid },
    accounts: accounts
  });
});

function parseInputTokens(input) {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : String(input).split(/[\r\n]+/);
  const extractedTokens = [];

  for (let item of rawList) {
    const line = String(item).trim();
    if (!line) continue;

    if (line.includes(':')) {
      const parts = line.split(':');
      const lastPart = parts[parts.length - 1].trim();
      const hexMatch = lastPart.match(/([a-f0-9]{40})/i);
      if (hexMatch) {
        extractedTokens.push(hexMatch[1].toLowerCase());
        continue;
      }
    }

    const generalHexMatch = line.match(/([a-f0-9]{40})/i);
    if (generalHexMatch) {
      extractedTokens.push(generalHexMatch[1].toLowerCase());
      continue;
    }

    const cleanToken = line.replace(/[^a-f0-9]/gi, '');
    if (cleanToken.length >= 32) {
      extractedTokens.push(cleanToken.toLowerCase());
    }
  }

  return Array.from(new Set(extractedTokens));
}

app.post('/api/accounts/add-tokens', async (req, res) => {
  try {
    const { tokens } = req.body;
    const parsedTokens = parseInputTokens(tokens);

    if (parsedTokens.length === 0) {
      return res.status(400).json({ success: false, error: 'Cole pelo menos 1 token auth_token válido ou formato de conta.' });
    }

    const currentAccounts = loadAccountsStore();
    const updatedList = [...currentAccounts];
    const addedResults = [];

    for (let cleanToken of parsedTokens) {
      const existingIdx = updatedList.findIndex(a => a.token === cleanToken);
      const val = await validateTokenWithTwitter(cleanToken);

      const accountObj = {
        id: existingIdx >= 0 ? updatedList[existingIdx].id : 'acc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        token: cleanToken,
        username: val.valid ? val.username : (existingIdx >= 0 ? updatedList[existingIdx].username : 'Desconhecido'),
        name: val.valid ? val.name : (existingIdx >= 0 ? updatedList[existingIdx].name : 'Sem nome'),
        avatar: val.valid ? val.avatar : (existingIdx >= 0 ? updatedList[existingIdx].avatar : ''),
        status: val.valid ? 'Válido' : 'Inválido',
        followersCount: val.valid ? val.followersCount : (existingIdx >= 0 ? updatedList[existingIdx].followersCount || 0 : 0),
        isProtected: val.valid ? (val.isProtected === true) : (existingIdx >= 0 ? (updatedList[existingIdx].isProtected === true) : false),
        unlocked: val.valid ? val.unlocked : (existingIdx >= 0 ? updatedList[existingIdx].unlocked : 'Sim'),
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

    saveAccountsStore(updatedList);
    notifyDashboardClientList();

    const validCount = updatedList.filter(a => a.status === 'Válido').length;
    const invalidCount = updatedList.filter(a => a.status === 'Inválido').length;

    res.json({
      success: true,
      added: addedResults.length,
      metrics: { total: updatedList.length, valid: validCount, invalid: invalidCount },
      accounts: updatedList
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/accounts/validate-all', async (req, res) => {
  try {
    const currentAccounts = loadAccountsStore(req.accessPass);
    for (let acc of currentAccounts) {
      const val = await validateTokenWithTwitter(acc.token);
      acc.status = val.valid ? 'Válido' : 'Inválido';
      if (val.valid) {
        acc.username = val.username;
        acc.name = val.name;
        acc.avatar = val.avatar;
        acc.followersCount = val.followersCount;
        acc.isProtected = val.isProtected === true;
        acc.unlocked = val.unlocked;
      }
      acc.updatedAt = new Date().toISOString();
    }
    saveAccountsStore(currentAccounts, req.accessPass);
    notifyDashboardClientList();

    const validCount = currentAccounts.filter(a => a.status === 'Válido').length;
    const invalidCount = currentAccounts.filter(a => a.status === 'Inválido').length;

    res.json({
      success: true,
      metrics: { total: currentAccounts.length, valid: validCount, invalid: invalidCount },
      accounts: currentAccounts
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/accounts/remove-invalid', (req, res) => {
  const currentAccounts = loadAccountsStore(req.accessPass);
  const filtered = currentAccounts.filter(a => a.status === 'Válido');
  saveAccountsStore(filtered, req.accessPass);
  notifyDashboardClientList();

  res.json({
    success: true,
    metrics: { total: filtered.length, valid: filtered.length, invalid: 0 },
    accounts: filtered
  });
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

        // Se views continuarem zeradas ou baixas, utiliza raspagem direta do DOM via Puppeteer
        if (!post.metrics || Number(post.metrics.views || 0) === 0) {
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

// Loop em segundo plano: Atualiza métricas automaticamente a cada 10 minutos
setInterval(async () => {
  try {
    const allPosts = loadPublishedPostsStore();
    if (allPosts.length === 0) return;
    const accounts = loadAccountsStore();
    const validToken = accounts.find(a => a.status === 'Válido' && a.token)?.token;

    console.log(`[AutoRefresh] Sincronizando métricas em segundo plano para ${allPosts.length} postagens...`);
    for (let post of allPosts) {
      if (!post.tweetUrl) continue;
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
    savePublishedPostsStore(allPosts);
    console.log(`[AutoRefresh] ✓ Métricas de ${allPosts.length} postagens atualizadas no banco de dados com sucesso!`);
  } catch (e) {
    console.error('[AutoRefresh] Erro no loop de sincronização:', e.message);
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

function getConnectedClientsList() {
  const list = [];
  const now = Date.now();
  const savedAccounts = loadAccountsStore();

  // 1. Contas de extensões ativas em tempo real
  for (const [clientId, client] of clientsMap.entries()) {
    const wsOpen = client.ws && client.ws.readyState === WebSocket.OPEN;
    const recentHeartbeat = client.lastSeen && (now - client.lastSeen < 30000);
    const isOnline = wsOpen || recentHeartbeat;

    if (isOnline) {
      list.push({
        clientId: clientId,
        account: client.info?.account || { username: 'Desconhecido', avatar: '' },
        browserProfile: client.info?.browserProfile || 'Navegador',
        extensionVersion: client.info?.extensionVersion || '3.1.0',
        isOnline: true,
        lastStatus: client.status || 'idle',
        connectedAt: client.connectedAt
      });
    }
  }

  // 2. Contas salvas via token auth_token
  for (const acc of savedAccounts) {
    if (acc.status === 'Válido') {
      const alreadyInList = list.some(l => l.account?.username?.toLowerCase() === acc.username?.toLowerCase());
      if (!alreadyInList) {
        list.push({
          clientId: 'token_' + acc.id,
          account: { username: acc.username, avatar: acc.avatar },
          browserProfile: 'Token (auth_token)',
          extensionVersion: '3.1.0',
          isOnline: true,
          token: acc.token,
          lastStatus: 'idle',
          connectedAt: acc.updatedAt
        });
      }
    }
  }

  return list;
}

function notifyDashboardClientList() {
  broadcastToDashboards({
    type: 'CLIENT_LIST_UPDATE',
    clients: getConnectedClientsList()
  });
}

// Incrementa o contador de posts publicados por uma conta (identificada por id ou token)
function bumpAccountPostCount(idOrToken) {
  if (!idOrToken) return;
  const currentAccounts = loadAccountsStore();
  const acc = currentAccounts.find(a => a.id === idOrToken || a.token === idOrToken);
  if (!acc) return;
  acc.postsCount = (acc.postsCount || 0) + 1;
  acc.updatedAt = new Date().toISOString();
  saveAccountsStore(currentAccounts);
  notifyDashboardClientList();
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
function dispatchMotherReposts(motherAccountIds, tweetUrl, originClientId, savedAccounts) {
  if (!tweetUrl || !Array.isArray(motherAccountIds) || motherAccountIds.length === 0) return;

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

    runWithBrowserSlot(progressId, onMotherProgress, () =>
      twitterEngine.repostTweetOnServer(motherAcc.token, tweetUrl, onMotherProgress)
    ).catch(err => {
      console.error(`[Server] Erro no repost da conta mãe @${motherAcc.username}:`, err.message);
    });
  }
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
        const { targetClientIds, postData, delayBetweenClientsSec, motherAccountIds = [] } = msg;
        console.log(`[ws] Disparando postagem para ${targetClientIds.length} conta(s). Stagger: ${delayBetweenClientsSec || 0}s. Contas mães: ${motherAccountIds.length}`);

        const savedAccounts = loadAccountsStore();
        // Se houver contas mães selecionadas, força a captura da URL do post
        // publicado (necessária para que as mães saibam o que repostar).
        const postDataForDispatch = motherAccountIds.length > 0 ? { ...postData, captureUrl: true } : postData;

        for (let i = 0; i < targetClientIds.length; i++) {
          const cId = targetClientIds[i];
          const delayMs = (delayBetweenClientsSec || 0) * 1000 * i;

          setTimeout(async () => {
            let tokenToUse = null;
            if (cId.startsWith('token_')) {
              const accId = cId.replace('token_', '');
              const acc = savedAccounts.find(a => a.id === accId);
              if (acc) tokenToUse = acc.token;
            } else {
              const client = clientsMap.get(cId);
              if (client && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(JSON.stringify({ type: 'EXECUTE_POST', postData: postDataForDispatch }));
                return;
              } else {
                const acc = savedAccounts.find(a => a.id === cId || a.username === cId);
                if (acc) tokenToUse = acc.token;
              }
            }

            if (tokenToUse) {
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

              runWithBrowserSlot(cId, onPostProgress, () =>
                twitterEngine.executePostOnServer(tokenToUse, postDataForDispatch, onPostProgress)
              ).then(result => {
                if (result && result.success) {
                  bumpAccountPostCount(cId);
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
                    dispatchMotherReposts(motherAccountIds, result.tweetUrl, cId, savedAccounts);
                  } else if (motherAccountIds.length > 0) {
                    console.warn(`[Server] Não foi possível obter a URL do post de ${cId} — contas mães não vão repostar essa publicação.`);
                  }
                }
              }).catch(err => {
                console.error(`[Server] Erro na postagem de ${cId}:`, err.message);
              });
            }
          }, delayMs);
        }
        return;
      }

      // 5.5 Painel Web solicitou disparo de postagem EM MASSA (Várias mídias e legendas para várias contas)
      if (msg.type === 'DISPATCH_MASS_POST') {
        const { items, staggerDelay = 0, motherAccountIds = [] } = msg;
        if (!Array.isArray(items) || items.length === 0) return;

        console.log(`[ws] Disparando postagem em massa para ${items.length} contas. Stagger: ${staggerDelay}s. Contas mães: ${motherAccountIds.length}`);
        const savedAccounts = loadAccountsStore();

        (async () => {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const acc = savedAccounts.find(a => a.token === item.token || a.id === item.token || a.username === item.username);
            const tokenToUse = acc ? acc.token : item.token;
            const clientId = acc ? acc.id : `mass_${i}`;

            if (!tokenToUse) continue;

            if (i > 0 && staggerDelay > 0) {
              console.log(`[Server] Aguardando stagger de ${staggerDelay}s antes da conta ${i + 1}/${items.length}...`);
              await new Promise(r => setTimeout(r, staggerDelay * 1000));
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
            ).catch(err => {
              console.error(`[Server] Erro no post em massa para ${clientId}:`, err.message);
              return null;
            });

            if (result && result.success) {
              bumpAccountPostCount(clientId);
              if (result.tweetUrl) {
                registerPublishedPost({
                  tweetUrl: result.tweetUrl,
                  username: acc ? acc.username : item.username || clientId,
                  name: acc ? acc.name : '',
                  avatar: acc ? acc.avatar : '',
                  caption: itemForDispatch.text || itemForDispatch.caption || '',
                  mediaUrls: itemForDispatch.mediaUrls || [],
                  hasVideo: itemForDispatch.hasVideo !== false
                });
                dispatchMotherReposts(motherAccountIds, result.tweetUrl, clientId, savedAccounts);
              } else if (motherAccountIds.length > 0) {
                console.warn(`[Server] Não foi possível obter a URL do post de ${clientId} — contas mães não vão repostar essa publicação.`);
              }
            }
          }
        })();
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
        const { targetClientIds, profileData, delayBetweenClientsSec } = msg;
        console.log(`[ws] Disparando alteração de perfil para ${targetClientIds.length} conta(s).`);

        const savedAccounts = loadAccountsStore();

        for (let i = 0; i < targetClientIds.length; i++) {
          const cId = targetClientIds[i];
          const delayMs = (delayBetweenClientsSec || 0) * 1000 * i;

          setTimeout(async () => {
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

              runWithBrowserSlot(cId, onProfileProgress, () =>
                twitterEngine.executeProfileEditOnServer(tokenToUse, profileData, onProfileProgress)
              ).then(result => {
                if (result && result.success) markProfileEdited(cId);
              }).catch(err => {
                console.error(`[Server] Erro na edição de perfil de ${cId}:`, err.message);
              });
            }
          }, delayMs);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Painel Web Central rodando em: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Server pronto em: ws://localhost:${PORT}`);
  console.log(`=======================================================`);
});
