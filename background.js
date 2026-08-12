/**
 * background.js v4.2
 * - Popup (compatível com qualquer Chromium: Chrome, AdsPower, Multilogin, etc.)
 * - Relay content script ↔ popup
 * - Login automático no Twitter com 2FA via 2fa.live
 */

const delay = ms => new Promise(r => setTimeout(r, ms));
let activeTabId = null;

// ════════════════════════════════════════════════════════════════════════════
//  PAINEL WEB CENTRAL — WEBSOCKET CLIENT & AUTO-DISCOVERY
// ════════════════════════════════════════════════════════════════════════════

let centralWS = null;
let clientId = null;
let activeAccountInfo = { username: null, avatar: null };

// Obtém ou gera um ID único e persistente para este perfil de navegador
async function getOrCreateClientId() {
  const data = await chrome.storage.local.get(['browser_client_id', 'browser_profile_name']);
  if (data.browser_client_id) {
    clientId = data.browser_client_id;
  } else {
    clientId = 'nav_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    await chrome.storage.local.set({ browser_client_id: clientId });
  }
  return clientId;
}

// Tenta detectar a conta ativa do Twitter (via abas abertas, storage ou cookies)
async function autoDetectTwitterAccount() {
  try {
    // 1. Tenta por abas abertas do Twitter
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    if (tabs.length > 0) {
      const tabId = tabs[0].id;
      await ensureContent(tabId);
      const acc = await chrome.tabs.sendMessage(tabId, { action: 'GET_ACCOUNT' }).catch(() => null);
      if (acc && acc.username) {
        activeAccountInfo = { username: acc.username, avatar: acc.avatar || '' };
        await chrome.storage.local.set({ active_twitter_account: activeAccountInfo });
        syncAccountWithServer();
        return;
      }
    }

    // 2. Se não achou em abas, recupera do storage
    const store = await chrome.storage.local.get(['active_twitter_account']);
    if (store.active_twitter_account && store.active_twitter_account.username) {
      activeAccountInfo = store.active_twitter_account;
      syncAccountWithServer();
      return;
    }

    // 3. Tenta extrair ID do usuário logado via cookies do Twitter (se permissão dada)
    if (chrome.cookies) {
      chrome.cookies.get({ url: 'https://x.com', name: 'twid' }, (cookie) => {
        if (cookie && cookie.value) {
          const match = cookie.value.match(/u%3D(\d+)/) || cookie.value.match(/u=(\d+)/);
          if (match) {
            const uid = match[1];
            if (!activeAccountInfo.username) {
              activeAccountInfo = { username: `user_${uid.substring(0, 6)}`, avatar: '' };
              syncAccountWithServer();
            }
          }
        }
      });
    }
  } catch (_) {}
}

function syncAccountWithServer() {
  if (centralWS && centralWS.readyState === WebSocket.OPEN) {
    centralWS.send(JSON.stringify({
      type: 'ACCOUNT_SYNC',
      account: activeAccountInfo
    }));
  }
}

// Heartbeat HTTP (garante registro mesmo que WebSocket caia ou oscile)
async function sendHttpHeartbeat() {
  await getOrCreateClientId();
  await autoDetectTwitterAccount();

  const store = await chrome.storage.local.get(['central_server_url', 'browser_profile_name']);
  const httpUrl = (store.central_server_url || 'ws://localhost:3000')
    .replace('ws://', 'http://')
    .replace('wss://', 'https://');
  const profileName = store.browser_profile_name || 'Navegador';

  try {
    await fetch(`${httpUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId,
        info: {
          account: activeAccountInfo,
          browserProfile: profileName,
          extensionVersion: '3.1.0'
        }
      })
    });
  } catch (_) {}
}

// Configura alarme de keep-alive para Service Worker do Chrome (executa a cada 15 seg)
chrome.alarms.create('central_keepalive_alarm', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'central_keepalive_alarm') {
    sendHttpHeartbeat();
    if (!centralWS || centralWS.readyState !== WebSocket.OPEN) {
      connectToCentralDashboard();
    }
  }
});

// Inicializa a conexão com o Painel Web Central
async function connectToCentralDashboard() {
  await getOrCreateClientId();

  // Envia heartbeat HTTP de imediato
  sendHttpHeartbeat();

  // Recupera URL do servidor do painel (padrão: ws://localhost:3000)
  const store = await chrome.storage.local.get(['central_server_url', 'active_twitter_account', 'browser_profile_name']);
  const serverUrl = store.central_server_url || 'wss://twitter-panel.onrender.com';
  if (store.active_twitter_account) activeAccountInfo = store.active_twitter_account;
  const profileName = store.browser_profile_name || 'Navegador';

  try {
    if (centralWS && centralWS.readyState === WebSocket.OPEN) return;

    centralWS = new WebSocket(serverUrl);

    centralWS.onopen = async () => {
      console.log(`[Central Dashboard] Conectado a ${serverUrl} com ClientId: ${clientId}`);
      await autoDetectTwitterAccount();

      // Registra a extensão no Painel Web
      centralWS.send(JSON.stringify({
        type: 'REGISTER_CLIENT',
        clientId: clientId,
        info: {
          account: activeAccountInfo,
          browserProfile: profileName,
          extensionVersion: '3.1.0'
        }
      }));
    };

    centralWS.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[Central Dashboard] Comando recebido:', msg.type);

        if (msg.type === 'EXECUTE_POST') {
          await handleRemotePostCommand(msg.postData);
        }

        if (msg.type === 'EXECUTE_EDIT_PROFILE') {
          await handleRemoteEditProfileCommand(msg.profileData);
        }

        if (msg.type === 'EXECUTE_TOKEN_LOGIN' && msg.token) {
          try {
            sendStepUpdateToCentral(0, 'Iniciando login por token...', 'running');
            await loginWithAuthToken(msg.token);
            sendStepUpdateToCentral(8, '✓ Login por token concluído!', 'completed');
          } catch (err) {
            sendStepUpdateToCentral(-1, 'Erro no login por token', 'error', err.message);
          }
        }

        if (msg.type === 'CANCEL_POST') {
          if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { action: 'CANCEL' }).catch(() => {});
          }
        }

        if (msg.type === 'TRIGGER_LOGIN' && msg.account) {
          if (msg.account.token || msg.account.authToken) {
            await loginWithAuthToken(msg.account.token || msg.account.authToken);
          } else {
            chrome.runtime.sendMessage({ action: 'LOGIN_TWITTER', payload: msg.account }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('[Central Dashboard] Erro no comando recebido:', err);
      }
    };

    centralWS.onclose = () => {
      console.log('[Central Dashboard] Conexão encerrada. Tentando reconectar em 5s...');
      setTimeout(connectToCentralDashboard, 5000);
    };

    centralWS.onerror = () => {
      try { centralWS.close(); } catch (_) {}
    };

  } catch (err) {
    setTimeout(connectToCentralDashboard, 5000);
  }
}

// Executa um post solicitado pelo Painel Web Central
async function handleRemotePostCommand(postData) {
  try {
    let mediaFiles = [];

    // Se houver mídias enviadas via URL do servidor central, baixa e prepara
    if (postData.mediaUrls && postData.mediaUrls.length > 0) {
      for (const url of postData.mediaUrls) {
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          mediaFiles.push({
            dataUrl: dataUrl,
            type: blob.type || 'image/jpeg',
            name: 'media_remote_' + Date.now() + (blob.type.includes('video') ? '.mp4' : '.jpg')
          });
        } catch (e) {
          console.error('Erro ao baixar mídia remota:', e);
        }
      }
    }

    const payload = {
      text: postData.text || '',
      mediaFiles: mediaFiles,
      commentText: postData.comment || '',
      doRepost: !!postData.repost,
      doPin: !!postData.pin,
      replyOption: postData.replyRestriction || 'everyone'
    };

    const tab = await getOrOpenTwitterTab();
    setActiveTabId(tab.id);
    await delay(1200);
    await ensureContent(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'DO_POST', payload: payload }).catch(() => {});

  } catch (err) {
    console.error('Erro ao processar post remoto:', err);
    sendStepUpdateToCentral(-1, 'erro', 'error', err.message);
  }
}

// Executa edição de perfil solicitada pelo Painel Web Central
async function handleRemoteEditProfileCommand(profileData) {
  try {
    let avatar = null;
    let banner = null;

    if (profileData.avatarUrl) {
      try {
        const res = await fetch(profileData.avatarUrl);
        const blob = await res.blob();
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        avatar = { dataUrl, type: blob.type || 'image/jpeg', name: 'avatar.jpg' };
      } catch (e) { console.error('Erro ao carregar avatar:', e); }
    }

    if (profileData.bannerUrl) {
      try {
        const res = await fetch(profileData.bannerUrl);
        const blob = await res.blob();
        const dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        banner = { dataUrl, type: blob.type || 'image/jpeg', name: 'banner.jpg' };
      } catch (e) { console.error('Erro ao carregar banner:', e); }
    }

    const payload = {
      bio: profileData.bio || '',
      siteLink: profileData.siteLink || '',
      avatar: avatar,
      banner: banner
    };

    chrome.runtime.sendMessage({ action: 'EDIT_PROFILE', payload }).catch(() => {});

  } catch (err) {
    console.error('Erro ao processar edição de perfil remota:', err);
    sendStepUpdateToCentral(-1, 'Erro de edição de perfil', 'error', err.message);
  }
}

// ── Login no X/Twitter usando auth_token (1-Click) ──────────────────────────
async function loginWithAuthToken(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken || cleanToken.length < 15) {
    throw new Error('Token inválido. Informe a chave auth_token de 40 caracteres.');
  }

  const expirationDate = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60); // 1 ano de validade

  const domains = ['.x.com', '.twitter.com'];
  for (const domain of domains) {
    if (chrome.cookies) {
      await chrome.cookies.set({
        url: `https://${domain.replace('.', '')}`,
        name: 'auth_token',
        value: cleanToken,
        domain: domain,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: expirationDate
      }).catch(err => console.error('Erro ao definir cookie auth_token:', err));
    }
  }

  // Abre ou recarrega a aba do X/Twitter
  const tab = await getOrOpenTwitterTab();
  await chrome.tabs.update(tab.id, { url: 'https://x.com/home', active: true });
  await delay(3500);
  await ensureContent(tab.id);

  // Captura as informações reais do perfil do Twitter (handle + foto)
  const acc = await chrome.tabs.sendMessage(tab.id, { action: 'GET_ACCOUNT' }).catch(() => null);
  if (acc && acc.username) {
    activeAccountInfo = { username: acc.username, avatar: acc.avatar || '' };
    await chrome.storage.local.set({ active_twitter_account: activeAccountInfo });
    syncAccountWithServer();

    // Notifica o painel central para atualizar a tabela com o @username e foto REAIS!
    const store = await chrome.storage.local.get(['central_server_url']);
    const httpUrl = (store.central_server_url || 'http://localhost:3000').replace('ws://', 'http://');
    await fetch(`${httpUrl}/api/accounts/sync-detected`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: cleanToken,
        username: acc.username,
        name: acc.displayName || acc.username,
        avatar: acc.avatar || '',
        followersCount: 0
      })
    }).catch(() => {});
  }

  return { ok: true, account: activeAccountInfo };
}

// Envia atualizações de etapas (0 a 8) para o Painel Web Central via WebSocket
function sendStepUpdateToCentral(stepIndex, label, stepStatus, error = null) {
  if (centralWS && centralWS.readyState === WebSocket.OPEN) {
    centralWS.send(JSON.stringify({
      type: 'STEP_UPDATE',
      clientId: clientId,
      stepIndex: stepIndex,
      label: label,
      stepStatus: stepStatus,
      error: error,
      overallStatus: stepStatus === 'error' ? 'error' : stepIndex === 8 ? 'completed' : 'running'
    }));
  }
}

// Inicia a conexão assim que o background script é carregado
connectToCentralDashboard();

// Restaura estado ao iniciar o service worker (sobrevive a restarts)
chrome.storage.session.get(['bg_activeTabId']).then(d => {
  if (d.bg_activeTabId) activeTabId = d.bg_activeTabId;
}).catch(() => {});

function setActiveTabId(id) {
  activeTabId = id;
  chrome.storage.session.set({ bg_activeTabId: id }).catch(() => {});
}

// ── IndexedDB para mídias agendadas ──────────────────────────────────────────
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TAPMediaDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('media', { keyPath: 'id' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function getMediaFromIDB(id) {
  if (!id) return [];
  try {
    const db = await openMediaDB();
    return new Promise(resolve => {
      const tx = db.transaction('media', 'readonly');
      const req = tx.objectStore('media').get(id);
      req.onsuccess = () => resolve(req.result?.files || []);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}
async function deleteMediaFromIDB(id) {
  if (!id) return;
  try {
    const db = await openMediaDB();
    return new Promise(resolve => {
      const tx = db.transaction('media', 'readwrite');
      tx.objectStore('media').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch { return; }
}

// ── Aguarda aba carregar completamente ───────────────────────────────────────
function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeout;
    function check() {
      if (Date.now() > end) { reject(new Error('Tab load timeout')); return; }
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (tab.status === 'complete') { resolve(); }
        else { setTimeout(check, 300); }
      });
    }
    check();
  });
}

// ── Abre ou foca aba do Twitter ──────────────────────────────────────────────
async function getOrOpenTwitterTab() {
  // Tenta reusar a tab ativa anterior (mais rápido e evita abrir janela errada)
  if (activeTabId) {
    try {
      const tab = await chrome.tabs.get(activeTabId);
      if (tab && (tab.url || '').match(/https:\/\/(twitter|x)\.com/)) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return tab;
      }
    } catch (_) {
      // Tab não existe mais — limpa o id armazenado
      setActiveTabId(null);
    }
  }

  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  if (tabs.length > 0) {
    // Prefere a aba já ativa; senão pega a primeira
    const tab = tabs.find(t => t.active) || tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  const newTab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
  await waitForTabComplete(newTab.id);
  await delay(2500);
  return newTab;
}

// ── Injeta content script se necessário ─────────────────────────────────────
async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await delay(600);
  }
}

// ── Envia status de login para o side panel ──────────────────────────────────
function sendLoginStatus(step, message, type = 'info') {
  chrome.runtime.sendMessage({ action: 'LOGIN_STATUS', step, message, type }).catch(() => {});
}

// ── Termos multilíngues reutilizados em várias automações ────────────────────
const SKIP_TERMS_GLOBAL = [
  'skip', 'skip for now', 'skip this', 'pular', 'pular por agora', 'ignorar',
  'omitir', 'saltar', 'ignorer', 'passer', 'überspringen', 'salta',
  'スキップ', '跳过', '건너뛰기', 'later', 'depois', 'não agora',
];
const SAVE_TERMS_GLOBAL = [
  'save', 'salvar', 'done', 'concluir', 'finish', 'finalizar',
  'guardar', 'enregistrer', 'speichern', 'salvare', '保存', '저장', '保存する',
];
const APPLY_TERMS_GLOBAL = [
  'apply', 'aplicar', 'appliquer', 'anwenden', 'applica', '適用', '应用', '적용', 'ok',
];

// ── Clica em botão visível — tenta testid, texto multilíngue e fallback estrutural ─
async function clickBtn(tabId, terms, timeout = 12000, fallbackStrategy = null) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (terms, strategy) => {
        const allBtns = [...document.querySelectorAll('button,[role="button"],a[role="button"]')]
          .filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });

        // 1. Tenta por data-testid
        const byTestId = allBtns.find(b =>
          terms.some(kw => (b.dataset.testid || '').toLowerCase().includes(kw))
        );
        if (byTestId) { byTestId.click(); return true; }

        // 2. Tenta por texto (cobre múltiplos idiomas passados em `terms`)
        const byText = allBtns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return terms.some(kw => t.includes(kw));
        });
        if (byText) { byText.click(); return true; }

        // 3. Fallback estrutural: botão secundário (não-primário) perto de um botão azul
        if (strategy === 'secondary') {
          const secondary = allBtns.find(b => {
            const style = window.getComputedStyle(b);
            const bg = style.backgroundColor;
            return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ||
                   bg.includes('29, 31, 35') || bg.includes('47, 51, 54') ||
                   style.border.includes('rgb(');
          });
          if (secondary) { secondary.click(); return true; }
          if (allBtns.length >= 2) { allBtns[1].click(); return true; }
        }

        return false;
      },
      args: [terms, fallbackStrategy],
    });
    if (res[0]?.result) return true;
    await delay(700);
  }
  return false;
}

// ── Alarmes: dispara posts agendados ────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('scheduled_post_')) return;

  const data = await chrome.storage.local.get('scheduled_posts');
  const posts = data.scheduled_posts || {};
  const post = posts[alarm.name];
  if (!post) return;

  // Remove da lista de agendados
  delete posts[alarm.name];
  await chrome.storage.local.set({ scheduled_posts: posts });

  // Recupera mídias do IndexedDB
  if (post.mediaKey) {
    post.mediaFiles = await getMediaFromIDB(post.mediaKey);

    // Só apaga a mídia do IDB se nenhum outro post agendado ainda a referencia
    const remainingPosts = Object.values(posts);
    const stillNeeded = remainingPosts.some(p => p.mediaKey === post.mediaKey);
    if (!stillNeeded) {
      await deleteMediaFromIDB(post.mediaKey);
    }
  }

  // Executa o post
  try {
    const tab = await getOrOpenTwitterTab();
    setActiveTabId(tab.id);
    await delay(1500);
    await ensureContent(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'DO_POST', payload: post }).catch(() => {});
  } catch (err) {
    console.error('Erro ao executar post agendado:', err);
  }
});

// ── Função auxiliar de status de perfil ─────────────────────────────────────
function sendProfileStatus(message, type = 'info') {
  chrome.runtime.sendMessage({ action: 'PROFILE_STATUS', message, type }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
//  VÍDEOS DO X/TWITTER
// ════════════════════════════════════════════════════════════════════════════

// Extrai o ID numérico da postagem a partir de qualquer link do X/Twitter
function extractTweetId(link) {
  const match = String(link).match(/status(?:es)?\/(\d+)/);
  return match ? match[1] : null;
}

// Token exigido pela API pública de sindicação do Twitter (algoritmo conhecido,
// não requer autenticação — usado por diversas ferramentas de download de vídeo).
function getSyndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

// Converte um ArrayBuffer em base64 sem estourar a pilha de chamadas (chunked)
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Busca metadados + variantes de vídeo de uma postagem via API pública de sindicação
async function fetchTweetVideoInfo(link) {
  const match = String(link).match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status\/(\d+)/) || String(link).match(/status(?:es)?\/(\d+)/);
  if (!match) throw new Error('Link inválido. Cole o link completo de uma postagem do X.');

  const username = match.length > 2 ? match[1] : 'i';
  const id = match.length > 2 ? match[2] : match[1];

  // Provedor 1: VxTwitter API
  try {
    const vxRes = await fetch(`https://api.vxtwitter.com/${username}/status/${id}`);
    if (vxRes.ok) {
      const vxData = await vxRes.json();
      const mediaList = vxData.media_extended || [];
      const videoMedia = mediaList.find(m => m.type === 'video' || m.type === 'gif');
      if (videoMedia && videoMedia.url) {
        return {
          videoUrl: videoMedia.url,
          thumbnailUrl: videoMedia.thumbnail_url || '',
          caption: vxData.text || '',
          width: videoMedia.size?.width || null,
          height: videoMedia.size?.height || null,
        };
      }
    }
  } catch (_) {}

  // Provedor 2: Syndication API (fallback)
  const token = getSyndicationToken(id);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Não foi possível buscar a postagem (link inválido, privado ou removido).');
  const data = await res.json();
  if (data.__typename === 'TweetTombstone') throw new Error('Esta postagem requer login ou é restrita no Twitter.');

  const mediaList = data.mediaDetails || data.mediaSummary || [];
  const videoMedia = mediaList.find(m => m.type === 'video' || m.type === 'animated_gif');
  if (!videoMedia || !videoMedia.video_info) {
    throw new Error('Nenhum vídeo encontrado nessa postagem.');
  }

  const variants = (videoMedia.video_info.variants || [])
    .filter(v => v.content_type === 'video/mp4' && v.url);
  if (!variants.length) throw new Error('Nenhuma versão em mp4 disponível para esse vídeo.');

  const best = variants.reduce((a, b) => (b.bitrate || 0) > (a.bitrate || 0) ? b : a);

  return {
    videoUrl: best.url,
    thumbnailUrl: videoMedia.media_url_https || '',
    caption: data.text || data.full_text || '',
    width: videoMedia.original_info?.width || null,
    height: videoMedia.original_info?.height || null,
  };
}

// ── Listener único ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Mensagens do content script → relay para o side panel e Painel Web Central
  if (sender.tab) {
    if (msg.action === 'STEP_STATUS') {
      sendStepUpdateToCentral(msg.stepIndex, msg.label, msg.status, msg.error);
    }
    chrome.runtime.sendMessage(msg).catch(() => {});
    return;
  }

  // ── CREATE_ALARM ────────────────────────────────────────────────────────────
  if (msg.action === 'CREATE_ALARM') {
    chrome.alarms.create(msg.alarmName, { when: msg.scheduledAt });
    sendResponse({ ok: true });
    return true;
  }

  // ── LOGIN_WITH_TOKEN ───────────────────────────────────────────────────────
  if (msg.action === 'LOGIN_WITH_TOKEN') {
    (async () => {
      try {
        const res = await loginWithAuthToken(msg.token);
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── CANCEL_ALARM ────────────────────────────────────────────────────────────
  if (msg.action === 'CANCEL_ALARM') {
    chrome.alarms.clear(msg.alarmName);
    sendResponse({ ok: true });
    return true;
  }

  // ── POST_TWEET ─────────────────────────────────────────────────────────────
  if (msg.action === 'POST_TWEET') {
    (async () => {
      try {
        const tab = await getOrOpenTwitterTab();
        setActiveTabId(tab.id);
        await delay(800);
        await ensureContent(tab.id);
        chrome.tabs.sendMessage(tab.id, { action: 'DO_POST', payload: msg.payload }).catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // ── DETECT_ACCOUNT ─────────────────────────────────────────────────────────
  if (msg.action === 'DETECT_ACCOUNT') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        if (!tabs.length) { sendResponse({ error: 'Abra o Twitter primeiro.' }); return; }
        const tabId = tabs[0].id;
        await ensureContent(tabId);
        const result = await chrome.tabs.sendMessage(tabId, { action: 'GET_ACCOUNT' });
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── LOGIN_TWITTER ──────────────────────────────────────────────────────────
  // Fluxo completo: usuário/senha + código 2FA gerado via 2fa.live (quando informado)
  if (msg.action === 'LOGIN_TWITTER') {
    (async () => {
      const { username, password, twoFASecret } = msg.payload;
      let loginTabId = null;

      // Preenche um input visível (username/senha/código) simulando digitação real
      async function fillInput(tabId, value, timeout = 15000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (val) => {
              const delay = ms => new Promise(r => setTimeout(r, ms));
              const candidates = [...document.querySelectorAll('input[type="text"], input[type="password"], input[autocomplete], input:not([type])')]
                .filter(el => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && !el.disabled;
                });
              const input = candidates[0];
              if (!input) return false;

              input.click(); await delay(200);
              input.focus(); await delay(200);
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              await delay(100);
              document.execCommand('insertText', false, val);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              await delay(300);
              return input.value && input.value.length > 0;
            },
            args: [value],
          });
          if (res[0]?.result) return true;
          await delay(500);
        }
        return false;
      }

      const NEXT_TERMS = [
        'next', 'próximo', 'continuar', 'continue', 'avançar', 'entrar', 'log in', 'login',
        'siguiente', 'suivant', 'weiter', 'avanti', '次へ', '下一步', '다음',
      ];
      const VERIFY_TERMS = [
        'verify', 'verificar', 'confirm', 'confirmar', 'next', 'próximo', 'submit', 'enviar',
      ];

      try {
        // 1. Encontra ou abre a aba do X/Twitter
        sendLoginStatus(1, 'Abrindo tela de login do X…');
        const existing = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        if (existing.length) {
          loginTabId = (existing.find(t => t.active) || existing[0]).id;
          await chrome.tabs.update(loginTabId, { url: 'https://x.com/i/flow/login', active: true });
        } else {
          const t = await chrome.tabs.create({ url: 'https://x.com/i/flow/login', active: true });
          loginTabId = t.id;
        }
        await waitForTabComplete(loginTabId);
        await delay(2500);

        // 2. Preenche usuário/e-mail
        sendLoginStatus(2, 'Digitando usuário…');
        const userOk = await fillInput(loginTabId, username);
        if (!userOk) throw new Error('Campo de usuário não encontrado.');
        await delay(500);
        await clickBtn(loginTabId, NEXT_TERMS, 10000);
        await delay(2000);

        // 2.1 Twitter às vezes pede confirmação extra de usuário/telefone (atividade incomum)
        //     Detecta se ainda não chegou no campo de senha e tenta preencher usuário de novo.
        const passwordVisible = await chrome.scripting.executeScript({
          target: { tabId: loginTabId },
          world: 'MAIN',
          func: () => !!document.querySelector('input[type="password"]'),
        });
        if (!passwordVisible[0]?.result) {
          const retryOk = await fillInput(loginTabId, username, 6000).catch(() => false);
          if (retryOk) {
            await delay(400);
            await clickBtn(loginTabId, NEXT_TERMS, 8000);
            await delay(2000);
          }
        }

        // 3. Preenche senha
        sendLoginStatus(3, 'Digitando senha…');
        const passOk = await fillInput(loginTabId, password);
        if (!passOk) throw new Error('Campo de senha não encontrado.');
        await delay(500);
        await clickBtn(loginTabId, NEXT_TERMS, 10000);
        await delay(2500);

        // 4. Verificação em duas etapas (2FA), se aplicável
        const needsCode = await chrome.scripting.executeScript({
          target: { tabId: loginTabId },
          world: 'MAIN',
          func: () => !!document.querySelector('input[type="text"], input[autocomplete="one-time-code"]')
                       && !document.querySelector('input[type="password"]'),
        });

        if (needsCode[0]?.result) {
          if (!twoFASecret) {
            throw new Error('A conta pede código 2FA. Informe a chave secreta 2FA e tente novamente.');
          }
          sendLoginStatus(4, 'Gerando código 2FA…');
          const tokenRes = await fetch(`https://2fa.live/tok/${encodeURIComponent(twoFASecret)}`);
          if (!tokenRes.ok) throw new Error('Não foi possível gerar o código 2FA (2fa.live).');
          const tokenData = await tokenRes.json();
          const code = tokenData?.token;
          if (!code) throw new Error('Código 2FA inválido retornado por 2fa.live.');

          sendLoginStatus(5, 'Digitando código 2FA…');
          const codeOk = await fillInput(loginTabId, code);
          if (!codeOk) throw new Error('Campo de código 2FA não encontrado.');
          await delay(500);
          await clickBtn(loginTabId, VERIFY_TERMS, 10000);
          await delay(2500);
        }

        sendLoginStatus(6, '✓ Login concluído!', 'success');
        sendResponse({ ok: true });

      } catch (err) {
        sendLoginStatus(0, 'Erro: ' + err.message, 'error');
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── EDIT_PROFILE ───────────────────────────────────────────────────────────
  if (msg.action === 'EDIT_PROFILE') {
    (async () => {
      const { bio, siteLink, avatar, banner } = msg.payload;
      let profileTabId = null;

      const NEXT_TERMS = [
        'next', 'próximo', 'continuar', 'continue', 'avançar',
        'siguiente', 'suivant', 'weiter', 'avanti', '次へ', '下一步', '다음',
      ];

      // Envia uma imagem (avatar ou banner) na etapa atual do fluxo de onboarding,
      // confirma o recorte (Apply) e avança para a próxima etapa (Next).
      async function uploadProfileImage(tabId, image, timeout = 15000) {
        const end = Date.now() + timeout;
        let uploaded = false;
        while (Date.now() < end && !uploaded) {
          const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (dataUrl, mime, name) => {
              function dataURLtoFile(dataUrl, name, mime) {
                const arr = dataUrl.split(','), bstr = atob(arr[1]);
                let n = bstr.length; const u8 = new Uint8Array(n);
                while (n--) u8[n] = bstr.charCodeAt(n);
                return new File([u8], name, { type: mime });
              }
              const input = [...document.querySelectorAll('input[type="file"]')]
                .find(el => (el.accept || '').includes('image'));
              if (!input) return false;
              const file = dataURLtoFile(dataUrl, name || 'image.jpg', mime || 'image/jpeg');
              const dt = new DataTransfer();
              dt.items.add(file);
              input.files = dt.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            },
            args: [image.dataUrl, image.type, image.name],
          });
          if (res[0]?.result) { uploaded = true; break; }
          await delay(500);
        }
        if (!uploaded) return false;

        await delay(1500);
        // Confirma o recorte (crop), se um diálogo "Apply" aparecer
        await clickBtn(tabId, APPLY_TERMS_GLOBAL, 6000).catch(() => {});
        await delay(1000);
        // Avança para a próxima etapa (alguns fluxos avançam sozinhos após aplicar)
        await clickBtn(tabId, NEXT_TERMS, 6000).catch(() => {});
        return true;
      }

      try {
        if (bio || avatar || banner) {
          // 1. Abre o fluxo de configuração do perfil
          sendProfileStatus('Abrindo configuração de perfil…');
          const t = await chrome.tabs.create({ url: 'https://x.com/i/flow/setup_profile', active: true });
          profileTabId = t.id;
          await waitForTabComplete(profileTabId);
          await delay(2500);

          // 2. Etapa da foto de perfil: envia a imagem escolhida ou pula
          if (avatar) {
            sendProfileStatus('Enviando foto de perfil…');
            await uploadProfileImage(profileTabId, avatar);
          } else {
            await clickBtn(profileTabId, SKIP_TERMS_GLOBAL, 10000, 'secondary');
          }
          await delay(2000);

          // 3. Etapa do banner: envia a imagem escolhida ou pula
          if (banner) {
            sendProfileStatus('Enviando banner…');
            await uploadProfileImage(profileTabId, banner);
          } else {
            await clickBtn(profileTabId, SKIP_TERMS_GLOBAL, 10000, 'secondary');
          }
          await delay(2000);

          // 4. Etapa da bio: preenche se houver texto, senão pula
          if (bio) {
            sendProfileStatus('Preenchendo bio…');
            const bioRes = await chrome.scripting.executeScript({
              target: { tabId: profileTabId },
              world: 'MAIN',
              func: async (bioText) => {
                const delay = ms => new Promise(r => setTimeout(r, ms));
                const end = Date.now() + 15000;
                let ta = null;
                while (Date.now() < end) {
                  const candidate = document.querySelector('textarea');
                  if (candidate) {
                    const rect = candidate.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) { ta = candidate; break; }
                  }
                  await delay(500);
                }
                if (!ta) return { error: 'Textarea de bio não encontrada.' };
                ta.click(); await delay(400);
                ta.focus(); await delay(400);
                ta.select(); await delay(200);
                document.execCommand('insertText', false, bioText);
                await delay(600);
                return { ok: true };
              },
              args: [bio],
            });
            if (bioRes[0]?.result?.error) throw new Error(bioRes[0].result.error);
            await delay(800);

            // Clica em Next (botão primário)
            sendProfileStatus('Clicando em Next…');
            await clickBtn(profileTabId, NEXT_TERMS, 10000);
            await delay(2000);
          } else {
            await clickBtn(profileTabId, SKIP_TERMS_GLOBAL, 10000, 'secondary');
            await delay(2000);
          }

          // 5. Pula 1 vez (etapa final antes de salvar)
          await clickBtn(profileTabId, SKIP_TERMS_GLOBAL, 10000, 'secondary');
          await delay(2000);

          // 6. Clica em Save / Done
          sendProfileStatus('Salvando…');
          await clickBtn(profileTabId, SAVE_TERMS_GLOBAL, 10000);
          await delay(2500);
        }

        if (siteLink) {
          // 7. Abre diretamente a página de configurações do perfil
          sendProfileStatus('Abrindo configurações do perfil…');
          if (profileTabId) {
            await chrome.tabs.update(profileTabId, { url: 'https://x.com/settings/profile', active: true });
          } else {
            const t2 = await chrome.tabs.create({ url: 'https://x.com/settings/profile', active: true });
            profileTabId = t2.id;
          }
          await waitForTabComplete(profileTabId);
          await delay(3000);

          // 8. Preenche o campo "Site web / Website / URL" na página de settings
          sendProfileStatus('Preenchendo site link…');
          const siteRes = await chrome.scripting.executeScript({
            target: { tabId: profileTabId },
            world: 'MAIN',
            func: async (link) => {
              const delay = ms => new Promise(r => setTimeout(r, ms));
              const end = Date.now() + 15000;
              let input = null;
              while (Date.now() < end) {
                // Tenta por name/testid/placeholder em vários idiomas
                input = document.querySelector('input[name="url"]')
                      || document.querySelector('input[name="website"]')
                      || document.querySelector('[data-testid="profileEditWebsite"]')
                      || document.querySelector('[data-testid*="website" i]')
                      || document.querySelector('[data-testid*="url" i]');

                // Se não achou por testid, busca por placeholder/label em vários idiomas
                if (!input) {
                  const SITE_LABELS = ['website', 'site web', 'site', 'url', 'web', 'link', 'ウェブサイト', '网站', '웹사이트'];
                  input = [...document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])')].find(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return false;
                    const ph    = (el.placeholder || '').toLowerCase();
                    const name  = (el.name || '').toLowerCase();
                    const label = (el.closest('label, [class*="label"]')?.textContent || '').toLowerCase();
                    // Procura o label/rótulo acima do input também
                    const prevLabel = (el.previousElementSibling?.textContent || '').toLowerCase();
                    return SITE_LABELS.some(kw =>
                      ph.includes(kw) || name.includes(kw) || label.includes(kw) || prevLabel.includes(kw)
                    );
                  });
                }

                if (input) break;
                await delay(600);
              }
              if (!input) return { error: 'Campo de website não encontrado na página de configurações.' };

              // Limpa o campo e insere o novo link
              input.click(); await delay(400);
              input.focus(); await delay(400);
              input.select(); await delay(200);
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
              await delay(200);
              document.execCommand('insertText', false, link);
              await delay(600);
              return { ok: true };
            },
            args: [siteLink],
          });
          if (siteRes[0]?.result?.error) throw new Error(siteRes[0].result.error);
          await delay(800);

          // 9. Salva as configurações do perfil
          sendProfileStatus('Salvando perfil…');
          await clickBtn(profileTabId, SAVE_TERMS_GLOBAL, 10000);
          await delay(2000);
        }

        sendProfileStatus('✓ Perfil atualizado!', 'success');
        sendResponse({ ok: true });

      } catch (err) {
        sendProfileStatus('Erro: ' + err.message, 'error');
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── FETCH_TWEET_VIDEO ──────────────────────────────────────────────────────
  // Busca apenas metadados (url do mp4 de melhor qualidade, thumbnail e legenda)
  if (msg.action === 'FETCH_TWEET_VIDEO') {
    (async () => {
      try {
        const info = await fetchTweetVideoInfo(msg.payload.link);
        sendResponse(info);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── DOWNLOAD_TWEET_VIDEO ───────────────────────────────────────────────────
  // Baixa os bytes do vídeo e devolve como dataURL para uso no compositor
  if (msg.action === 'DOWNLOAD_TWEET_VIDEO') {
    (async () => {
      try {
        const { videoUrl } = msg.payload;
        const res = await fetch(videoUrl);
        if (!res.ok) throw new Error('Falha ao baixar o vídeo.');
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > 512 * 1024 * 1024) {
          throw new Error('Vídeo muito grande (máx. 512 MB).');
        }
        const base64 = arrayBufferToBase64(buffer);
        const dataUrl = `data:video/mp4;base64,${base64}`;
        sendResponse({ dataUrl, type: 'video/mp4', name: `tweet_video_${Date.now()}.mp4` });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // ── PAUSE / RESUME / CANCEL ────────────────────────────────────────────────
  if (['PAUSE', 'RESUME', 'CANCEL'].includes(msg.action)) {
    (async () => {
      let tabId = activeTabId;

      // Se activeTabId foi perdido (service worker reiniciou), busca a aba do Twitter
      if (!tabId) {
        try {
          const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
          if (tabs.length > 0) {
            tabId = (tabs.find(t => t.active) || tabs[0]).id;
            setActiveTabId(tabId);
          }
        } catch (_) {}
      }

      if (!tabId) { sendResponse({ ok: false }); return; }

      chrome.tabs.sendMessage(tabId, msg)
        .then(r => sendResponse(r))
        .catch(() => sendResponse({ ok: false }));
    })();
    return true;
  }
});
