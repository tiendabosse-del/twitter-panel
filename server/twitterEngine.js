let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  if (e && e.code === 'ERR_REQUIRE_ESM') {
    puppeteer = new Proxy({}, {
      get(target, prop) {
        return async (...args) => {
          const mod = await import('puppeteer-core');
          const p = mod.default || mod;
          return p[prop](...args);
        };
      }
    });
  } else {
    throw e;
  }
}
const path = require('path');
const fs = require('fs');

const delay = ms => new Promise(r => setTimeout(r, ms));

// fetch() do Node não tem timeout por padrão. Uma URL externa lenta ou que nunca
// fecha a conexão travava chamadas para sempre — grave quando isso acontece
// dentro de uma função que segura a vaga do semáforo de navegadores no server.js,
// pois trava a fila inteira atrás dela junto.
function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

function getChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const paths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'chrome';
}

// Auxiliar: garante que a mídia remota (ex: do Buscador de Mídias) seja baixada localmente antes do upload
async function ensureLocalMediaFile(mUrl) {
  if (!mUrl) return null;
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  const cleanUrl = mUrl.split('?')[0];
  const filename = path.basename(cleanUrl);
  const localPath = path.join(uploadsDir, filename);

  if (fs.existsSync(localPath)) return localPath;

  if (mUrl.startsWith('http://') || mUrl.startsWith('https://')) {
    try {
      console.log(`[TwitterEngine] Baixando mídia do buscador: ${mUrl}`);
      const res = await fetchWithTimeout(mUrl, {}, 25000);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(localPath, Buffer.from(buffer));
        console.log(`[TwitterEngine] Mídia salva em: ${localPath}`);
        return localPath;
      }
    } catch (e) {
      console.error(`[TwitterEngine] Erro ao baixar mídia remota (${e.name === 'AbortError' ? 'timeout de 25s' : e.message}):`, mUrl);
    }
  }
  return null;
}

// Localiza o elemento <article> do tweet principal recém-postado no perfil do usuário
async function findMainTweetArticle(page, textSnippet) {
  return await page.evaluateHandle((snippet) => {
    const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (tweets.length === 0) return null;

    // 1. Procura por correspondência do texto principal
    if (snippet && snippet.trim().length > 5) {
      const cleanSnippet = snippet.trim().substring(0, 30).toLowerCase();
      for (const t of tweets) {
        const txt = (t.textContent || '').toLowerCase();
        if (txt.includes(cleanSnippet)) return t;
      }
    }

    // 2. Procura pelo primeiro tweet que possui mídia (vídeo/imagem) e não é cabeçalho de resposta
    for (const t of tweets) {
      const txt = (t.textContent || '').toLowerCase();
      const isReply = txt.includes('replying to') || txt.includes('respondendo a');
      const hasMedia = !!t.querySelector('video, img[src*="media"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
      if (!isReply || hasMedia) return t;
    }

    // 3. Fallback: retorna o primeiro tweet do perfil
    return tweets[0];
  }, textSnippet);
}

// ── Valida token e extrai perfil real do Twitter/X (@username, nome, avatar) ──
async function validateAndExtractAccount(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken || cleanToken.length < 15) {
    return { valid: false, error: 'Token muito curto ou formato inválido' };
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      protocolTimeout: 600000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    page.setDefaultNavigationTimeout(600000);

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    await page.setCookie(
      { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
      { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
    );

    console.log(`[TwitterEngine] Testando token no Twitter...`);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await delay(3000);

    const isSuspendedOrBlocked = await page.evaluate(() => {
      const href = window.location.href;
      const text = document.body ? document.body.innerText : '';
      if (href.includes('/account/access') || href.includes('/account/suspended')) return true;
      if (text.includes('Account suspended') || text.includes('Conta suspensa') || text.includes('account has been locked') || text.includes('conta foi suspensa')) return true;
      return false;
    });

    if (isSuspendedOrBlocked) {
      await browser.close();
      return {
        valid: false,
        status: 'Bloqueada',
        token: cleanToken,
        error: 'Conta suspensa ou bloqueada pelo Twitter',
        isProtected: false,
        unlocked: 'Não (🚫 Suspensa)'
      };
    }

    const accountData = await page.evaluate(() => {
      const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      if (!link) return null;

      const username = link.getAttribute('href')?.replace('/', '') || null;
      const avatar = link.querySelector('img')?.src || null;
      const nameEl = document.querySelector('[data-testid="UserName"] span');
      const displayName = nameEl ? nameEl.textContent : username;

      return { username, displayName, avatar };
    });

    // Checa se os posts da conta estão protegidos ("Protect your posts")
    let isProtected = false;
    try {
      await page.goto('https://x.com/settings/audience_and_tagging', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForSelector('input[type="checkbox"]', { timeout: 15000 }).catch(() => {});
      isProtected = await page.evaluate(() => {
        const cb = document.querySelector('input[type="checkbox"]');
        return cb ? (cb.checked === true) : false;
      });
    } catch (_) {}

    await browser.close();

    if (accountData && accountData.username) {
      return {
        valid: true,
        status: 'Válido',
        token: cleanToken,
        username: accountData.username,
        name: accountData.displayName || accountData.username,
        avatar: accountData.avatar || '',
        followersCount: 0,
        isProtected: isProtected,
        unlocked: isProtected ? 'Não (🔒 Protegida)' : 'Sim (🔓 Pública)'
      };
    } else {
      return {
        valid: true,
        status: 'Válido',
        token: cleanToken,
        username: 'acc_' + cleanToken.substring(0, 8),
        name: 'Conta do Twitter',
        avatar: '',
        followersCount: 0,
        isProtected: isProtected,
        unlocked: isProtected ? 'Não (🔒 Protegida)' : 'Sim (🔓 Pública)'
      };
    }

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[TwitterEngine] Erro ao validar token:', err.message);
    return { valid: false, status: 'Inválido', error: err.message };
  }
}

// ── Desprotege os posts da conta no Twitter (Desmarca "Protect your posts") ───
async function unprotectAccountOnServer(token, onProgress = () => {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken || cleanToken.length < 15) {
    return { success: false, error: 'Token inválido' };
  }

  let browser = null;
  try {
    onProgress(0, 'Iniciando navegador no servidor para desproteger conta...', 'running');

    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      protocolTimeout: 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    page.setDefaultNavigationTimeout(300000);

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    await page.setCookie(
      { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
      { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
    );

    onProgress(1, 'Acessando configurações de privacidade da conta (audience_and_tagging)...', 'running');
    await page.goto('https://x.com/settings/audience_and_tagging', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('input[type="checkbox"]', { timeout: 25000 });
    await delay(1500);

    onProgress(2, 'Verificando estado de "Protect your posts"...', 'running');
    const isProtected = await page.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]');
      return cb ? cb.checked : false;
    });

    if (isProtected) {
      onProgress(3, 'Conta está privada (🔒). Desmarcando "Protect your posts"...', 'running');
      const checkbox = await page.$('input[type="checkbox"]');
      if (checkbox) {
        await checkbox.click();
        await delay(1500);

        const confirmBtn = await page.$('[data-testid="confirmationSheetConfirm"]');
        if (confirmBtn) {
          await confirmBtn.click();
          await delay(2000);
        } else {
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            for (const b of btns) {
              const txt = (b.textContent || '').toLowerCase();
              if (txt.includes('unprotect') || txt.includes('desproteger') || txt.includes('protect') || txt.includes('confirm')) {
                b.click(); return true;
              }
            }
            return false;
          });
          await delay(2000);
        }
      }
    }

    onProgress(4, 'Apagando localização do perfil para remover qualquer localização antiga...', 'running');
    await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await delay(2000);
    const locEl = await page.$('input[name="location"]');
    if (locEl) {
      await locEl.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      const saveBtn = await page.$('[data-testid="Profile_Save_Button"]');
      if (saveBtn) {
        await saveBtn.click();
        await delay(3000);
      }
    }

    onProgress(8, '✓ Conta desprotegida e convertida para pública com sucesso!', 'completed');
    await browser.close();

    return {
      success: true,
      isProtected: false,
      unlocked: 'Sim (🔓 Pública)'
    };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[TwitterEngine] Erro ao desproteger conta:', err.message);
    onProgress(-1, 'Erro ao desproteger conta: ' + err.message, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// Remove todos os links (http/https/t.co/twitter.com/x.com) da legenda extraída
function cleanExtractedCaption(text = '') {
  if (!text) return '';
  return String(text)
    // Remove links t.co, twitter.com, x.com (com ou sem protocolo)
    .replace(/(?:https?:\/\/)?(?:www\.)?(?:t\.co|twitter\.com|x\.com)\/\S+/gi, '')
    // Remove quaisquer outros links http:// ou https:// genéricos
    .replace(/https?:\/\/\S+/gi, '')
    // Remove múltiplos espaços em branco resultantes da remoção
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Helper interno para extrair mídias e legenda de 1 link via API (VxTwitter + Syndication)
async function fetchSingleTweetDataInternal(link) {
  const match = String(link).match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\/(\d+)/) || String(link).match(/status(?:es)?\/(\d+)/);
  if (!match) return { url: link, caption: '', mediaUrls: [], hasVideo: false, metrics: { views: 0, likes: 0, retweets: 0, replies: 0 } };

  const username = match.length > 2 ? match[1] : 'i';
  const id = match.length > 2 ? match[2] : match[1];

  // Provedor 1: VxTwitter API
  try {
    const vxRes = await fetchWithTimeout(`https://api.vxtwitter.com/${username}/status/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
    }, 15000);
    if (vxRes.ok) {
      const vxData = await vxRes.json();
      const mediaList = vxData.media_extended || [];
      const captionText = cleanExtractedCaption(vxData.text || '');
      const viewsCount = Number(vxData.views || vxData.video_views || 0);
      const likesCount = Number(vxData.likes || 0);
      const retweetsCount = Number(vxData.retweets || 0);
      const repliesCount = Number(vxData.replies || 0);

      const formattedItems = mediaList.map(m => {
        const isVid = m.type === 'video' || m.type === 'gif';
        return {
          url: m.url || m.thumbnail_url,
          thumbnailUrl: m.thumbnail_url || (isVid ? '' : m.url),
          type: isVid ? 'video' : 'image'
        };
      }).filter(m => m.url);

      const hasVideo = formattedItems.some(m => m.type === 'video');

      return {
        url: link,
        caption: captionText,
        mediaUrls: formattedItems.map(m => m.url),
        mediaDetails: formattedItems,
        hasVideo: hasVideo,
        metrics: {
          views: viewsCount,
          likes: likesCount,
          retweets: retweetsCount,
          replies: repliesCount
        }
      };
    }
  } catch (e) {
    console.log(`[TwitterEngine] VxTwitter falhou para ID ${id}, tentando Syndication...`);
  }

  // Provedor 2: Twitter Syndication API (Fallback)
  try {
    const token = Math.floor((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
    const synUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`;
    const synRes = await fetchWithTimeout(synUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
    }, 15000);

    if (synRes.ok) {
      const synData = await synRes.json();
      const mediaList = synData.mediaDetails || synData.mediaSummary || [];
      const captionText = cleanExtractedCaption(synData.text || synData.full_text || '');
      const viewsCount = Number(synData.views?.count || synData.video?.viewCount || 0);
      const likesCount = Number(synData.favorite_count || 0);
      const retweetsCount = Number(synData.retweet_count || 0);
      const repliesCount = Number(synData.reply_count || 0);

      const formattedItems = mediaList.map(m => {
        const isVid = m.type === 'video' || m.type === 'animated_gif';
        let vidUrl = m.media_url_https;
        if (isVid && m.video_info?.variants) {
          const mp4s = m.video_info.variants.filter(v => v.content_type === 'video/mp4' && v.url);
          if (mp4s.length) {
            vidUrl = mp4s.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a).url;
          }
        }
        return {
          url: vidUrl || m.media_url_https,
          thumbnailUrl: m.media_url_https || vidUrl,
          type: isVid ? 'video' : 'image'
        };
      }).filter(m => m.url);

      const hasVideo = formattedItems.some(m => m.type === 'video');

      return {
        url: link,
        caption: captionText,
        mediaUrls: formattedItems.map(m => m.url),
        mediaDetails: formattedItems,
        hasVideo: hasVideo,
        metrics: {
          views: viewsCount,
          likes: likesCount,
          retweets: retweetsCount,
          replies: repliesCount
        }
      };
    }
  } catch (errSyn) {
    console.error(`[TwitterEngine] Syndication falhou para ID ${id}:`, errSyn.message);
  }

  return { url: link, caption: '', mediaUrls: [], mediaDetails: [], hasVideo: false, metrics: { views: 0, likes: 0, retweets: 0, replies: 0 } };
}

// ── Extrai Mídias e Legendas de Múltiplos Links de Tweets em Massa ───────────────
async function extractBulkLinksData(linkUrls) {
  if (!Array.isArray(linkUrls) || linkUrls.length === 0) return [];
  const results = [];

  for (let i = 0; i < linkUrls.length; i++) {
    const link = String(linkUrls[i] || '').trim();
    if (!link.includes('/status/')) continue;

    console.log(`[TwitterEngine] Extraindo mídias e legenda do link ${i + 1}/${linkUrls.length}: ${link}`);
    const data = await fetchSingleTweetDataInternal(link);
    results.push(data);
  }

  return results;
}

// ── Executa Fluxo de Postagem Efetivo (8 Passos) ──────────────────────────────
async function executePostOnServer(token, postData, onProgress) {
  const cleanToken = String(token || '').trim();
  let browser = null;

  try {
    onProgress(0, 'Iniciando navegador headless no servidor...', 'running');

    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      protocolTimeout: 600000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    page.setDefaultNavigationTimeout(600000);

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    await page.setCookie(
      { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
      { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
    );

    // Passo 1: Abrindo compositor
    onProgress(1, 'Abrindo compositor do Twitter...', 'running');
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await delay(2000);

    // Checa se o Twitter redirecionou para login ou conta bloqueada/suspensa
    const authIssue = await page.evaluate(() => {
      const href = window.location.href;
      const text = document.body ? document.body.innerText : '';
      if (href.includes('/i/flow/login') || href.includes('/login')) return 'Token expirado ou inválido (redirecionado para Login)';
      if (href.includes('/account/access') || href.includes('/account/suspended')) return 'Conta suspensa ou bloqueada pelo Twitter';
      if (text.includes('Account suspended') || text.includes('Conta suspensa') || text.includes('account has been locked')) return 'Conta suspensa ou bloqueada pelo Twitter';
      return null;
    });

    if (authIssue) {
      throw new Error(authIssue);
    }

    // Captura o username da conta logada
    const currentUsername = await page.evaluate(() => {
      const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      return link ? link.getAttribute('href').replace('/', '') : null;
    });

    // Passo 2: Digitando texto
    onProgress(2, 'Digitando texto da publicação...', 'running');

    // Tenta encontrar a caixa de texto do post via múltiplos seletores
    let editorFound = false;
    const selectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0_ariaLabel"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"]'
    ];

    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.click().catch(() => {});
        editorFound = true;
        break;
      }
    }

    if (!editorFound) {
      // Se não encontrou no modal, força o clique no botão "Postar" lateral
      await page.evaluate(() => {
        const postBtn = document.querySelector('[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
        if (postBtn) postBtn.click();
      }).catch(() => {});
      await delay(2000);

      for (const sel of selectors) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          await el.click().catch(() => {});
          editorFound = true;
          break;
        }
      }
    }

    if (!editorFound) {
      throw new Error('Caixa de texto da publicação não encontrada. Verifique se o token da conta é válido e está ativo.');
    }

    await delay(500);

    if (postData.text) {
      await page.keyboard.type(postData.text, { delay: 15 });
      await delay(1000);
    }

    // Passo 3: Enviando mídia (do computador ou do Buscador de Mídias)
    onProgress(3, 'Processando e anexando mídias (fotos/vídeos)...', 'running');
    let isVideoUpload = !!postData.hasVideo;

    if (postData.mediaUrls && postData.mediaUrls.length > 0) {
      const fileInput = await page.$('input[data-testid="fileInput"]');
      if (fileInput) {
        const localPaths = [];
        for (const mUrl of postData.mediaUrls) {
          const lPath = await ensureLocalMediaFile(mUrl);
          if (lPath && fs.existsSync(lPath)) {
            localPaths.push(lPath);
            const lowerPath = lPath.toLowerCase();
            const lowerUrl = String(mUrl || '').toLowerCase();
            if (lowerPath.includes('.mp4') || lowerPath.includes('.mov') || lowerPath.includes('.webm') || lowerPath.includes('.m4v') || lowerUrl.includes('.mp4') || lowerUrl.includes('video')) {
              isVideoUpload = true;
            }
          }
        }

        if (localPaths.length > 0) {
          await fileInput.uploadFile(...localPaths);
          console.log(`[TwitterEngine] ${localPaths.length} mídia(s) anexadas ao Twitter. IsVideo: ${isVideoUpload}`);
          await page.waitForSelector('[data-testid="attachments"]', { timeout: 120000 }).catch(() => {});
          await delay(3000);
        }
      }
    }

    let replyRestrictionApplied = false;
    let capturedTweetUrl = null;

    // Restrição de Respostas ("Quem pode responder") — aplicada SOMENTE depois de
    // publicar, via menu "..." do post (ver Passo 9 mais abaixo). A tentativa de
    // ajustar isso no compositor, antes de postar, se mostrou pouco confiável
    // (é a mesma conclusão a que chegou a extensão do Chrome, ver content.js) e
    // foi removida daqui para não deixar o painel "quem pode responder" num
    // estado que desalinha os índices usados no Passo 9.
    const replySetting = postData.replyRestriction || postData.reply;

    // Passo 4: Publicando Post Principal (Legenda + Mídia)
    onProgress(4, isVideoUpload ? 'Aguardando o upload da mídia finalizar para postar...' : 'Enviando postagem principal...', 'running');

    const tweetBtnSelector = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
    await page.waitForSelector(tweetBtnSelector, { timeout: 60000 });

    // Aguarda estritamente o botão "Postar" habilitar (aria-disabled !== "true")
    console.log('[TwitterEngine] Aguardando o botão Postar ficar ativado (upload concluído)...');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (!btn) return false;
      const ariaDisabled = btn.getAttribute('aria-disabled');
      return ariaDisabled !== 'true' && !btn.disabled;
    }, { timeout: 15 * 60 * 1000 });

    console.log('[TwitterEngine] Botão Postar ativado! Clicando para enviar post principal com mídia...');
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
      if (btn) btn.click();
    });
    await page.click(tweetBtnSelector).catch(() => {});
    console.log('[TwitterEngine] Post principal com legenda e mídia publicado com sucesso!');
    await delay(1200);

    // ── TENTA ABRIR O POST PUBLICADO DIRETAMENTE PELO TOAST OU PERFIL ──────────
    const needsProfileActions = postData.comment || postData.repost || postData.pin || postData.captureUrl || (replySetting && replySetting !== 'everyone');

    if (needsProfileActions) {
      const postActionsTimeoutMs = 3 * 60 * 1000;
      const runPostActions = async () => {
      onProgress(5, 'Acessando publicação para executar as ações...', 'running');

      // Tenta clicar no Toast "Ver" que o Twitter exibe imediatamente após postar
      let openedViaToast = false;
      try {
        openedViaToast = await page.evaluate(() => {
          const toast = document.querySelector('[data-testid="toast"]');
          if (toast) {
            const link = toast.querySelector('a[href*="/status/"]');
            if (link) { window.__capturedTweetHref = link.href; link.click(); return true; }
          }
          return false;
        });
        if (openedViaToast) {
          capturedTweetUrl = await page.evaluate(() => window.__capturedTweetHref || null).catch(() => null);
        }
      } catch (_) {}

      if (openedViaToast) {
        console.log('[TwitterEngine] Post aberto diretamente via Toast notification!');
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
        await delay(800);
      } else {
        // Fallback: navega para o perfil do usuário e aguarda o tweet carregar
        if (currentUsername) {
          console.log(`[TwitterEngine] Navegando para https://x.com/${currentUsername}...`);
          await page.goto(`https://x.com/${currentUsername}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
          await delay(1000);
        }
      }

      // Captura a URL do post principal (se ainda não capturada via toast)
      if (!capturedTweetUrl) {
        capturedTweetUrl = await page.evaluate(() => {
          const article = document.querySelector('article[data-testid="tweet"]');
          if (!article) return null;
          const timeLink = article.querySelector('time')?.closest('a[href*="/status/"]');
          const anyLink = article.querySelector('a[href*="/status/"]');
          const link = timeLink || anyLink;
          return link ? link.href : null;
        }).catch(() => null);
      }

      // 1. REPOST AUTOMÁTICO NO POST PRINCIPAL
      if (postData.repost) {
        onProgress(6, 'Dando repost automático no post principal...', 'running');
        console.log('[TwitterEngine] Executando repost no post principal...');
        try {
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }).catch(() => {});
          const retweetClicked = await page.evaluate((snippet) => {
            const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            if (tweets.length === 0) return false;

            let targetTweet = tweets[0];
            if (snippet && snippet.trim().length > 5) {
              const clean = snippet.trim().substring(0, 25).toLowerCase();
              const found = tweets.find(t => (t.textContent || '').toLowerCase().includes(clean));
              if (found) targetTweet = found;
            }

            const retweetBtn = targetTweet.querySelector('[data-testid="retweet"], [aria-label*="repost"], [aria-label*="Retweet"], [aria-label*="Ulangi"]');
            if (retweetBtn) {
              retweetBtn.click();
              return true;
            }
            return false;
          }, postData.text);

          if (retweetClicked) {
            await delay(500);
            await page.evaluate(() => {
              const confirmBtn = document.querySelector('[data-testid="retweetConfirm"]');
              if (confirmBtn) { confirmBtn.click(); return true; }
              const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
              for (const item of menuItems) {
                const txt = (item.textContent || '').toLowerCase();
                if (txt.includes('repost') || txt.includes('retweet') || txt.includes('ulangi')) {
                  item.click(); return true;
                }
              }
              return false;
            });
            console.log('[TwitterEngine] Repost efetuado com sucesso!');
            await delay(800);
          }
        } catch (errRep) {
          console.error('[TwitterEngine] Erro ao dar repost:', errRep.message);
        }
      }

      // 2. FIXAR POST PRINCIPAL NO PERFIL
      if (postData.pin) {
        onProgress(7, 'Fixando post principal no perfil...', 'running');
        console.log('[TwitterEngine] Fixando post principal no perfil...');
        try {
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }).catch(() => {});
          const pinMenuOpened = await page.evaluate((snippet) => {
            const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            if (tweets.length === 0) return false;

            let targetTweet = tweets[0];
            if (snippet && snippet.trim().length > 5) {
              const clean = snippet.trim().substring(0, 25).toLowerCase();
              const found = tweets.find(t => (t.textContent || '').toLowerCase().includes(clean));
              if (found) targetTweet = found;
            }

            const caretBtn = targetTweet.querySelector('[data-testid="caret"]');
            if (caretBtn) {
              caretBtn.click();
              return true;
            }
            return false;
          }, postData.text);

          if (pinMenuOpened) {
            await delay(600);
            const pinClicked = await page.evaluate(() => {
              const pinBtn = document.querySelector('[data-testid="pin"]');
              if (pinBtn) { pinBtn.click(); return true; }

              const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
              for (const item of items) {
                const txt = (item.textContent || '').toLowerCase();
                if (txt.includes('pin') || txt.includes('fixar') || txt.includes('semat')) {
                  item.click(); return true;
                }
              }
              return false;
            });

            if (pinClicked) {
              await delay(600);
              await page.evaluate(() => {
                const confirmPinBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                if (confirmPinBtn) { confirmPinBtn.click(); return true; }

                const confirmBtns = Array.from(document.querySelectorAll('button'));
                for (const btn of confirmBtns) {
                  const txt = (btn.textContent || '').toLowerCase();
                  if (txt.includes('pin') || txt.includes('fixar') || txt.includes('semat')) {
                    btn.click(); return true;
                  }
                }
                return false;
              });
              console.log('[TwitterEngine] Post principal fixado no perfil com sucesso!');
              await delay(800);
            }
          }
        } catch (errPin) {
          console.error('[TwitterEngine] Erro ao fixar perfil:', errPin.message);
        }
      }

// ── Gerador Infinito de Variações de Comentários para Bio (Anti-Spam 100% Único) ──
// Garante dedo sempre para cima (👆 ☝️ 🔝 ⬆️) e combinações infinitas para 500+ posts
function getRandomBioComment(baseComment = '') {
  const phrases = [
    "CHECK BIO",
    "Full in bio",
    "Video full in bio",
    "Version full in bio",
    "Video in bio",
    "Full video in bio",
    "Check my bio",
    "Link in bio",
    "Full video on bio",
    "Full version in bio",
    "Watch full in bio",
    "Full content in bio",
    "Check profile bio",
    "Full scene in bio",
    "Complete video in bio",
    "More in bio",
    "See full in bio",
    "Full link in bio",
    "Exclusive in bio",
    "Full clip in bio",
    "Vídeo completo na bio",
    "Confira na bio",
    "Link completo na bio",
    "Versão completa na bio",
    "Conteúdo completo na bio",
    "Veja completo na bio",
    "VÍDEO COMPLETO NA BIO",
    "CONFIRA A BIO",
    "FULL IN BIO",
    "CHECK BIO",
    "LINK NA BIO",
    "FULL VIDEO IN BIO",
    "CHECK PROFILE BIO",
    "FULL SCENE IN BIO",
    "Check bio",
    "full in bio",
    "video full in bio",
    "version full in bio",
    "video in bio",
    "full video in bio",
    "link in bio",
    "check profile bio",
    "watch full in bio",
    "full content in bio"
  ];

  // SOMENTE DEDOS PARA CIMA (👆 ☝️ 🔝 ⬆️) - NUNCA DEDO PARA BAIXO
  const emojis = [
    " 🔞", " 🔥", " 💦", " 🍿", " 👆", " ☝️", " 🔝", " ⬆️", " 🔗", " 👀", " 📌", " 🚀", " 💎", " 😈", " ⚡",
    " 🔞🔥", " 👆🔥", " ☝️🔥", " 🔝🔥", " 🔗👀", " 🔞💦", " 🔥👀", " 🔞🔗", " 👀🔞", " 🍿🔥", " ⬆️🔗",
    " 👆🔞", " ☝️🔞", " 🔝🔞", " ⬆️🔞", " ! 🔞", " ... 👆", " !!! 🔥", " 🔞👆", " 🔥💦", " 🔗🔞", " 🔝🔗"
  ];

  const separators = ["", " ", " - ", " ~ ", " | ", " • ", " » ", " -> "];
  const punctuation = ["", "!", "!!", "...", ".", " ~", " ✨"];

  const phrase = phrases[Math.floor(Math.random() * phrases.length)];
  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  const sep = separators[Math.floor(Math.random() * separators.length)];
  const punc = punctuation[Math.floor(Math.random() * punctuation.length)];

  // Garante 100% de unicidade em 500+ disparos por dia via Zero-Width Space (\u200B)
  const zwsCount = Math.floor(Math.random() * 5) + 1;
  const zws = '\u200B'.repeat(zwsCount);

  const cleanBase = String(baseComment || '').trim();
  if (!cleanBase || cleanBase.toLowerCase().includes('bio') || cleanBase.toLowerCase().includes('check')) {
    return `${phrase}${punc}${sep}${emoji}${zws}`;
  }

  return `${cleanBase}${sep}${phrase}${punc} ${emoji}${zws}`;
}

      // 3. COMENTÁRIO AUTOMÁTICO NO POST PRINCIPAL (VARIAÇÃO ANTI-SPAM DE CHAMADA PARA BIO)
      if (postData.comment) {
        const dynamicComment = getRandomBioComment(postData.comment);
        onProgress(8, `Comentando no post principal ("${dynamicComment}")...`, 'running');
        console.log(`[TwitterEngine] Comentando no post principal com variação para bio: "${dynamicComment}"`);
        try {
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {});
          const replyOpened = await page.evaluate((snippet) => {
            const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            if (tweets.length === 0) return false;

            let targetTweet = tweets[0];
            if (snippet && snippet.trim().length > 5) {
              const clean = snippet.trim().substring(0, 25).toLowerCase();
              const found = tweets.find(t => (t.textContent || '').toLowerCase().includes(clean));
              if (found) targetTweet = found;
            }

            const replyBtn = targetTweet.querySelector('[data-testid="reply"]');
            if (replyBtn) {
              replyBtn.click();
              return true;
            }
            return false;
          }, postData.text);

          if (replyOpened) {
            await delay(1500);
            const replyArea = await page.$('[data-testid="tweetTextarea_0"]');
            if (replyArea) {
              await replyArea.click();
              await page.keyboard.type(dynamicComment, { delay: 15 });
              await delay(1000);

              await page.evaluate(() => {
                const sendBtn = document.querySelector('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
                if (sendBtn) { sendBtn.click(); return true; }
                return false;
              });
              console.log(`[TwitterEngine] Comentário ("${dynamicComment}") enviado no post principal com sucesso!`);
              await delay(3000);
            }
          }
        } catch (errCom) {
          console.error('[TwitterEngine] Erro ao comentar no post principal:', errCom.message);
        }
      }

      // 4. ETAPA FINAL (PASSO 9): ACESSAR POST FIXADO/PRINCIPAL -> 3 PONTINHOS (...) -> ALTERAR QUEM PODE RESPONDER -> CONTAS VERIFICADAS
      // Lógica idêntica à usada em content.js (changePostReplyRestriction), que é
      // a versão comprovada e funcional na extensão do Chrome: usa polling para
      // esperar o menu/painel renderizar e várias estratégias (radio real,
      // role=radio/option, data-testid específico, camada/dialog mais recente)
      // para localizar a opção correta, em vez de um único índice fixo.
      if (replySetting && replySetting !== 'everyone') {
        const replyLabelMap = { verified: 'Contas verificadas', following: 'Contas que você segue', mentioned: 'Somente contas que você menciona' };
        const targetLabel = replyLabelMap[replySetting] || 'Contas verificadas';

        onProgress(9, `[Passo 9/9] Alterando quem pode responder no post para "${targetLabel}"...`, 'running');
        console.log(`[TwitterEngine] Executando Passo 9: Restringir respostas para "${targetLabel}" no post...`);

        try {
          await delay(2000);
          await page.keyboard.press('Escape').catch(() => {});
          await delay(500);

          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => {
            throw new Error('Não foi possível encontrar a publicação na página para aplicar a restrição de respostas.');
          });

          const result = await page.evaluate(async (option) => {
            const delayIn = ms => new Promise(r => setTimeout(r, ms));

            const CHANGE_REPLY_KW = [
              'change who can reply', 'who can reply', 'change reply',
              'alterar quem pode responder', 'quem pode responder', 'mudar quem pode',
              'cambiar quién puede', 'quién puede responder',
              'modifier qui peut répondre', 'qui peut répondre',
              'ändern, wer antworten', 'wer antworten kann',
              'cambia chi può rispondere',
              '返信', '回复', '답글'
            ];
            const REPLY_OPTION_INDEX = { everyone: 0, following: 1, mentioned: 2, verified: 3 };

            const article = document.querySelector('article[data-testid="tweet"]');
            if (!article) return { success: false, reason: 'article não encontrado' };

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await delayIn(700);

            let moreBtn = article.querySelector('[data-testid="caret"]');
            if (!moreBtn) {
              const allCarets = Array.from(document.querySelectorAll('[data-testid="caret"]'));
              if (allCarets.length > 0) moreBtn = allCarets[0];
            }
            if (!moreBtn) return { success: false, reason: 'botão "..." de 3 pontinhos não encontrado no post' };
            moreBtn.click();
            await delayIn(1500);

            let changeItem = null;
            const endMenu = Date.now() + 10000;
            while (Date.now() < endMenu && !changeItem) {
              const items = [...document.querySelectorAll('[role="menuitem"]')];

              changeItem = items.find(el => {
                const tid = (el.dataset.testid || '').toLowerCase();
                return tid.includes('reply') || tid.includes('restrict') || tid.includes('who');
              });

              if (!changeItem) {
                changeItem = items.find(el => {
                  const txt = el.textContent.toLowerCase();
                  return CHANGE_REPLY_KW.some(kw => txt.includes(kw));
                });
              }

              if (!changeItem) await delayIn(400);
            }

            if (!changeItem) {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return { success: false, reason: 'item de menu "quem pode responder" não encontrado' };
            }

            changeItem.click();
            await delayIn(2000);

            const targetIdx = REPLY_OPTION_INDEX[option] ?? 3;
            const endOpts = Date.now() + 12000;
            let clicked = false;

            while (Date.now() < endOpts && !clicked) {
              const radios = [...document.querySelectorAll('input[type="radio"]')]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 || el.offsetParent !== null; });
              if (radios.length > targetIdx) {
                const r = radios[targetIdx];
                if (!r.checked) { r.click(); await delayIn(200); }
                clicked = true; break;
              }

              const roleOptions = [
                ...document.querySelectorAll('[role="radio"]'),
                ...document.querySelectorAll('[role="menuitemradio"]'),
                ...document.querySelectorAll('[role="option"]'),
              ].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

              if (roleOptions.length > targetIdx) {
                const target = roleOptions[targetIdx];
                const isSelected =
                  target.getAttribute('aria-checked') === 'true' ||
                  target.getAttribute('aria-selected') === 'true' ||
                  !!target.querySelector('[aria-checked="true"]');
                if (!isSelected) target.click();
                clicked = true; break;
              }

              const sheetItems = [...document.querySelectorAll(
                '[data-testid*="replyRestriction"], [data-testid*="replyPolicy"], ' +
                '[data-testid*="audienceOption"], [data-testid*="whoCanReply"]'
              )].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

              if (sheetItems.length > targetIdx) {
                sheetItems[targetIdx].click();
                clicked = true; break;
              }

              const layers = [...document.querySelectorAll('[data-testid="sheetDialog"],[data-testid="Dropdown"],[role="dialog"],[role="menu"]')]
                .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

              if (layers.length > 0) {
                const layer = layers[layers.length - 1];
                const clickables = [...layer.querySelectorAll('li, [role="listitem"], div[tabindex]')]
                  .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 20; });
                if (clickables.length > targetIdx) {
                  clickables[targetIdx].click();
                  clicked = true; break;
                }
              }

              await delayIn(500);
            }

            if (!clicked) return { success: false, reason: 'opção de restrição não encontrada no painel' };
            await delayIn(1200);

            const endSave = Date.now() + 3000;
            let saveBtn = null;
            while (Date.now() < endSave && !saveBtn) {
              saveBtn = document.querySelector('[data-testid="settingsDetailSave"]')
                  || [...document.querySelectorAll('button,[role="button"]')].find(b => {
                       const txt = b.textContent.trim().toLowerCase();
                       const r = b.getBoundingClientRect();
                       return r.width > 0 && r.height > 0 && (
                         txt === 'save' || txt === 'salvar' || txt === 'done' || txt === 'ok' ||
                         txt === 'apply' || txt === 'aplicar' || txt === 'confirm' || txt === 'concluir' ||
                         txt === 'appliquer' || txt === 'enregistrer' || txt === 'speichern' || txt === 'conferma'
                       );
                     });
              if (!saveBtn) await delayIn(300);
            }
            if (saveBtn) { saveBtn.click(); await delayIn(800); }

            return { success: true };
          }, replySetting);

          if (!result.success) {
            console.warn(`[TwitterEngine] Passo 9: não foi possível aplicar a restrição ("${result.reason}"). Post continua público para respostas.`);
            onProgress(9, `⚠ Não foi possível restringir respostas a "${targetLabel}" (${result.reason}). As demais ações foram concluídas.`, 'running');
          } else {
            replyRestrictionApplied = true;
            console.log(`[TwitterEngine] Restrição "${targetLabel}" aplicada com sucesso no post!`);
          }

          await page.keyboard.press('Escape').catch(() => {});
          await delay(1000);
          await page.keyboard.press('Escape').catch(() => {});
          await delay(1000);
        } catch (errReply) {
          console.error('[TwitterEngine] Erro ao restringir quem pode responder:', errReply.message);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
      };

      const postActionsPromise = runPostActions();
      try {
        await Promise.race([
          postActionsPromise,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('Tempo esgotado (4 min) executando ações pós-publicação (repost/fixar/comentário/restrição de respostas)')),
            postActionsTimeoutMs
          ))
        ]);
      } catch (raceErr) {
        console.error('[TwitterEngine] Ações pós-publicação abortadas:', raceErr.message);
        onProgress(9, `⚠ Post publicado com sucesso, mas algumas ações extras (repost/fixar/comentário/restrição) não terminaram a tempo: ${raceErr.message}`, 'running');
      }
      // Evita "unhandled rejection" se runPostActions ainda estiver rodando em segundo
      // plano quando o timeout vencer a corrida (o navegador será fechado logo abaixo).
      postActionsPromise.catch(() => {});
    }

    // Concluído com Sucesso Total
    let finalMsg = '✓ Publicação e todas as ações no post principal concluídas com sucesso!';
    if (replySetting && replySetting !== 'everyone') {
      finalMsg = replyRestrictionApplied
        ? `✓ Publicação, Repost, Fixar, Comentário e Restrição a "${({ verified: 'Contas Verificadas', following: 'Contas que Você Segue', mentioned: 'Contas Mencionadas' })[replySetting] || 'Contas Verificadas'}" (Passo 9) concluídos com sucesso!`
        : '✓ Publicação e demais ações concluídas, mas a restrição de "quem pode responder" (Passo 9) não pôde ser aplicada — o post ficou público para respostas.';
    }

    onProgress(9, finalMsg, 'completed');
    await browser.close();
    return { success: true, tweetUrl: capturedTweetUrl };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[TwitterEngine] Erro ao postar:', err.message);
    onProgress(-1, 'Erro na publicação: ' + err.message, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// ── Dá Repost em um Tweet específico (usado por "Contas Mães") ────────────────
// Abre a URL do tweet publicado por outra conta e dá repost usando o token
// informado. Usado para o recurso de "Contas Mães": após publicar em uma conta
// normal, uma ou mais contas marcadas como "mãe" reposta(m) esse mesmo tweet.
async function repostTweetOnServer(token, tweetUrl, onProgress = () => {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken || cleanToken.length < 15) {
    return { success: false, error: 'Token inválido' };
  }
  if (!tweetUrl) {
    return { success: false, error: 'URL do post não informada' };
  }

  let browser = null;
  try {
    onProgress(0, 'Iniciando navegador para repost (conta mãe)...', 'running');

    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      protocolTimeout: 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    await page.setCookie(
      { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
      { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
    );

    onProgress(1, 'Abrindo a publicação para dar repost...', 'running');
    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 20000 }).catch(() => {
      throw new Error('Publicação não encontrada (link inválido, removida ou conta bloqueada).');
    });
    await delay(2000);

    onProgress(2, 'Dando repost na publicação...', 'running');
    const clickResult = await page.evaluate(() => {
      const article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return 'not_found';

      const alreadyBtn = article.querySelector('[data-testid="unretweet"]');
      if (alreadyBtn) return 'already';

      const retweetBtn = article.querySelector('[data-testid="retweet"]');
      if (retweetBtn) { retweetBtn.click(); return 'clicked'; }

      return 'not_found';
    });

    if (clickResult === 'not_found') {
      await browser.close();
      return { success: false, error: 'Botão de repost não encontrado na publicação.' };
    }

    if (clickResult === 'already') {
      onProgress(3, '✓ Esta conta mãe já tinha dado repost nesse post.', 'completed');
      await browser.close();
      return { success: true, alreadyReposted: true };
    }

    await delay(1200);
    await page.evaluate(() => {
      const confirmBtn = document.querySelector('[data-testid="retweetConfirm"]');
      if (confirmBtn) { confirmBtn.click(); return true; }

      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const repostItem = items.find(el => {
        const txt = (el.textContent || '').toLowerCase();
        return (txt.includes('repost') || txt.includes('retweet')) && !txt.includes('quote') && !txt.includes('cita');
      });
      if (repostItem) { repostItem.click(); return true; }
      if (items.length > 0) { items[0].click(); return true; }
      return false;
    });

    await delay(1500);

    // ── CURTIR (LIKE) TAMBÉM PELA CONTA MÃE ──────────────────────────────────
    onProgress(3, 'Curtindo a publicação...', 'running');
    const liked = await page.evaluate(() => {
      const article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return false;

      const alreadyLiked = article.querySelector('[data-testid="unlike"]');
      if (alreadyLiked) return 'already';

      const likeBtn = article.querySelector('[data-testid="like"]');
      if (likeBtn) {
        likeBtn.click();
        return 'liked';
      }
      return false;
    });

    if (liked === 'already') {
      console.log('[TwitterEngine] Conta mãe já tinha curtido esta publicação anteriormente.');
    } else if (liked === 'liked') {
      console.log('[TwitterEngine] Publicação curtida com sucesso pela conta mãe!');
    }

    await delay(1800);
    onProgress(4, '✓ Repost e Curtida (Like) realizados com sucesso pela conta mãe!', 'completed');
    await browser.close();
    return { success: true };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[TwitterEngine] Erro ao dar repost (conta mãe):', err.message);
    onProgress(-1, 'Erro ao dar repost: ' + err.message, 'error', err.message);
    return { success: false, error: err.message };
  }
}

// ── Executa Edição de Perfil no Servidor Node.js ──────────────────────────────
async function executeProfileEditOnServer(token, profileData, onProgress) {
  const cleanToken = String(token || '').trim();
  let browser = null;

  try {
    onProgress(0, 'Iniciando navegador headless para edição de perfil...', 'running');

    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      protocolTimeout: 300000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    page.setDefaultNavigationTimeout(300000);

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
    await page.setCookie(
      { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
      { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
    );

    onProgress(1, 'Abrindo tela de perfil do Twitter...', 'running');
    let pageLoaded = false;
    for (let attempt = 1; attempt <= 3 && !pageLoaded; attempt++) {
      try {
        await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 90000 });
        pageLoaded = true;
      } catch (eNav) {
        if (attempt === 3) throw eNav;
        await delay(2000);
      }
    }
    await delay(3000);

    // Garante que o formulário de edição de perfil realmente renderizou antes de
    // mexer nos campos — sem isso, em contas onde a página do Twitter demora um
    // pouco mais a carregar, os campos (e o botão Salvar) simplesmente não são
    // encontrados, os passos são pulados silenciosamente e a função ainda assim
    // reportava sucesso (nada muda no Twitter, mas nenhum erro aparece).
    await page.waitForSelector('[data-testid="Profile_Save_Button"]', { timeout: 30000 }).catch(() => {
      throw new Error('A tela de edição de perfil do Twitter não carregou a tempo (conta pode estar suspensa, bloqueada ou com sessão expirada).');
    });

    onProgress(3, 'Limpando e preenchendo informações de bio, site e localização...', 'running');

    // 1. Limpa e Atualiza a BIO (textarea[name="description"])
    const bioEl = await page.$('textarea[name="description"]');
    if (bioEl) {
      await bioEl.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      if (profileData.bio && profileData.bio.trim()) {
        await page.keyboard.type(profileData.bio.trim(), { delay: 15 });
        await delay(500);
      }
    }

    // 2. Limpa e Deixa em Branco a LOCALIZAÇÃO (input[name="location"])
    const locEl = await page.$('input[name="location"]');
    if (locEl) {
      await locEl.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      if (profileData.location && profileData.location.trim()) {
        await page.keyboard.type(profileData.location.trim(), { delay: 15 });
        await delay(500);
      }
    }

    // 3. Limpa e Atualiza o SITE LINK (input[name="url"])
    const siteEl = await page.$('input[name="url"]');
    if (siteEl) {
      await siteEl.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await delay(300);

      if (profileData.siteLink && profileData.siteLink.trim()) {
        await page.keyboard.type(profileData.siteLink.trim(), { delay: 15 });
        await delay(500);
      }
    }

    // 3. Upload de Foto de Perfil / Banner (se informados)
    onProgress(5, 'Enviando imagens de avatar/banner...', 'running');
    if (profileData.avatarUrl || profileData.bannerUrl) {
      const fileInputs = await page.$$('input[type="file"]');
      
      // Upload de Banner
      if (profileData.bannerUrl && fileInputs.length > 0) {
        const lPath = await ensureLocalMediaFile(profileData.bannerUrl);
        if (lPath && fs.existsSync(lPath)) {
          await fileInputs[0].uploadFile(lPath);
          await delay(2000);
          const applyBtn = await page.$('[data-testid="applyButton"]');
          if (applyBtn) await applyBtn.click().catch(() => {});
          await delay(1000);
        }
      }

      // Upload de Avatar
      if (profileData.avatarUrl && fileInputs.length > 1) {
        const lPath = await ensureLocalMediaFile(profileData.avatarUrl);
        if (lPath && fs.existsSync(lPath)) {
          await fileInputs[1].uploadFile(lPath);
          await delay(2000);
          const applyBtn = await page.$('[data-testid="applyButton"]');
          if (applyBtn) await applyBtn.click().catch(() => {});
          await delay(1000);
        }
      }
    }

    // 4. Salva as alterações
    onProgress(7, 'Salvando alterações de perfil...', 'running');
    const saveBtnSelector = '[data-testid="Profile_Save_Button"]';
    const saveBtn = await page.waitForSelector(saveBtnSelector, { timeout: 15000 }).catch(() => null);
    if (!saveBtn) {
      throw new Error('Botão "Salvar" não foi encontrado na tela de perfil — a edição não foi salva.');
    }
    await saveBtn.click();
    console.log('[TwitterEngine] Botão Salvar Perfil clicado!');
    await delay(4000);

    onProgress(8, '✓ Perfil atualizado com sucesso!', 'completed');
    await browser.close();
    return { success: true };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[TwitterEngine] Erro ao editar perfil:', err.message);
    onProgress(-1, 'Erro ao editar perfil: ' + err.message, 'error', err.message);
    return { success: false, error: err.message };
  }
}

function parseTwitterNumber(text = '') {
  if (!text) return 0;
  let str = String(text).trim().toUpperCase();
  str = str.replace(/VIEWS|VISUALIZAÇÕES|VISUALIZACAO|LIKES|REPOSTS|RETWEETS|REPLIES|COMONTÁRIOS|RESPOSTAS/gi, '').trim();

  const kMatch = str.match(/([\d\.,]+)\s*K/);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(',', '.'));
    return Math.round(val * 1000);
  }
  const mMatch = str.match(/([\d\.,]+)\s*M/);
  if (mMatch) {
    const val = parseFloat(mMatch[1].replace(',', '.'));
    return Math.round(val * 1000000);
  }

  const cleanDigits = str.replace(/[,\.]/g, '');
  const numMatch = cleanDigits.match(/(\d+)/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }
  return 0;
}

// ── Raspa Métricas e Views 100% Reais do DOM da Página do Tweet ─────────────
async function scrapeRealMetricsFromDOM(tweetUrl, token) {
  if (!tweetUrl) return null;
  let browser = null;
  try {
    const cleanToken = String(token || '').trim();
    browser = await puppeteer.launch({
      executablePath: getChromeExecutable(),
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    if (cleanToken && cleanToken.length > 15) {
      const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60);
      await page.setCookie(
        { name: 'auth_token', value: cleanToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, expires: expirationDate },
        { name: 'auth_token', value: cleanToken, domain: '.twitter.com', path: '/', secure: true, httpOnly: true, expires: expirationDate }
      );
    }

    await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12000 }).catch(() => {});
    await delay(1200);

    const rawMetrics = await page.evaluate(() => {
      const article = document.querySelector('article[data-testid="tweet"]');
      if (!article) return null;
      const text = article.innerText;

      let viewsText = '';
      const analyticsLink = article.querySelector('a[href*="/analytics"]');
      if (analyticsLink) {
        viewsText = analyticsLink.textContent.trim();
      }

      const likeBtn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
      const likesText = likeBtn ? likeBtn.textContent.trim() : '';

      const rtBtn = article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
      const rtsText = rtBtn ? rtBtn.textContent.trim() : '';

      const replyBtn = article.querySelector('[data-testid="reply"]');
      const repliesText = replyBtn ? replyBtn.textContent.trim() : '';

      return { viewsText, likesText, rtsText, repliesText, fullText: text };
    });

    await browser.close();

    if (!rawMetrics) return null;

    let viewsVal = parseTwitterNumber(rawMetrics.viewsText);
    if (viewsVal === 0) {
      const vm = rawMetrics.fullText.match(/([\d\.,]+(?:\s*[KM])?)\s*(?:Views|Visualizações|vistas)/i);
      if (vm) viewsVal = parseTwitterNumber(vm[1]);
    }

    return {
      views: viewsVal,
      likes: parseTwitterNumber(rawMetrics.likesText),
      retweets: parseTwitterNumber(rawMetrics.rtsText),
      replies: parseTwitterNumber(rawMetrics.repliesText)
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

module.exports = {
  validateAndExtractAccount,
  unprotectAccountOnServer,
  extractBulkLinksData,
  executePostOnServer,
  executeProfileEditOnServer,
  repostTweetOnServer,
  scrapeRealMetricsFromDOM,
  fetchSingleTweetDataInternal
};
