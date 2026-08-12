/**
 * app.js — Lógica da Interface do Painel Web Central
 * Gerencia conexões WebSocket, lista de contas conectadas, upload de mídia e dispatching de ações.
 */

// ── Estado da Aplicação ───────────────────────────────────────────────────────
let ws = null;
let connectedClients = []; // Array de clientes de extensões
let selectedClientIds = new Set(); // Set de IDs de navegadores selecionados
let uploadedMediaFiles = []; // Mídias enviadas: [{ url, name, type, size }]
let clientProgressMap = new Map(); // clientId -> { stepIndex, label, status, error }

// ── Elementos do DOM ─────────────────────────────────────────────────────────
const serverBadge       = document.getElementById('serverBadge');
const connectedCount    = document.getElementById('connectedCount');
const activeAccountsBadge = document.getElementById('activeAccountsBadge');
const accountsList      = document.getElementById('accountsList');
const selectAllBtn      = document.getElementById('selectAllBtn');
const deselectAllBtn    = document.getElementById('deselectAllBtn');

const targetAccountsText = document.getElementById('targetAccountsText');
const postForm          = document.getElementById('postForm');
const tweetText         = document.getElementById('tweetText');
const charCount         = document.getElementById('charCount');
const dropZone          = document.getElementById('dropZone');
const mediaInput        = document.getElementById('mediaInput');
const dropzonePrompt    = document.getElementById('dropzonePrompt');
const mediaPreviewGrid  = document.getElementById('mediaPreviewGrid');

const commentText       = document.getElementById('commentText');
const doRepost          = document.getElementById('doRepost');
const doPin             = document.getElementById('doPin');
const replyRestriction  = document.getElementById('replyRestriction');
const staggerRange      = document.getElementById('staggerRange');
const staggerValue      = document.getElementById('staggerValue');
const publishBtn        = document.getElementById('publishBtn');

const executionMonitor  = document.getElementById('executionMonitor');

// ── Conexão WebSocket com o Backend Server ───────────────────────────────────
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[Dashboard] Conectado ao servidor WebSocket');
    serverBadge.innerHTML = `
      <span class="status-dot green"></span>
      <span class="status-text">Painel Conectado</span>`;
    
    // Registra a UI do Painel no servidor
    ws.send(JSON.stringify({ type: 'REGISTER_DASHBOARD' }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'CLIENT_LIST_UPDATE') {
        connectedClients = msg.clients || [];
        renderAccountsList();
      }

      if (msg.type === 'INIT_PROGRESS_STATE') {
        clientProgressMap.clear();
        if (msg.progressMap && Array.isArray(msg.progressMap)) {
          msg.progressMap.forEach(([cId, pData]) => {
            clientProgressMap.set(cId, pData);
          });
        }
        renderExecutionMonitor();
      }

      if (msg.type === 'STEP_UPDATE') {
        handleStepUpdate(msg);
      }

      if (msg.type === 'POST_DISPATCHED') {
        console.log(`[Dashboard] Comando despachado para cliente: ${msg.clientId}`);
      }
    } catch (err) {
      console.error('[Dashboard] Erro ao ler mensagem WS:', err);
    }
  };

  ws.onclose = () => {
    console.warn('[Dashboard] Conexão WebSocket perdida. Reconectando em 3s...');
    serverBadge.innerHTML = `
      <span class="status-dot red" style="background: var(--error); box-shadow: 0 0 10px var(--error);"></span>
      <span class="status-text" style="color: var(--error)">Reconectando...</span>`;
    setTimeout(connectWebSocket, 3000);
  };
}

// ── Renderiza o card de uma conta (barra lateral) com selo de status e atividade ─
function renderAccountCard(acc) {
  const accId = acc.id || acc.token;
  const isSelected = selectedClientIds.has(accId);
  const isProtected = acc.isProtected === true;
  const isBlocked = acc.status === 'Bloqueada';
  const isMother = acc.isMother === true;
  const lockIcon = isBlocked ? ' 🚫' : (isProtected ? ' 🔒' : '');
  const handle = acc.username && acc.username !== 'Desconhecido' ? `@${acc.username}${lockIcon}` : 'Token não validado';
  const avatar = acc.avatar || '';
  const canBeMother = !!acc.token;

  const badges = [`<span>${isBlocked ? '🚫 Bloqueada' : (isProtected ? '🔒 Protegida' : '🟢 Ativa')}</span>`];
  if (acc.postsCount) badges.push(`<span>📝 ${acc.postsCount} post${acc.postsCount > 1 ? 's' : ''}</span>`);
  if (acc.profileEdited) badges.push(`<span>✏️ Perfil editado</span>`);

  return `
    <div class="account-card ${isSelected ? 'selected' : ''}" data-id="${accId}">
      <input type="checkbox" class="account-checkbox" ${isSelected ? 'checked' : ''} data-id="${accId}">
      ${avatar
        ? `<img src="${avatar}" class="account-avatar" alt="Avatar">`
        : `<div class="account-avatar">${handle.substring(1, 3).toUpperCase()}</div>`}
      <div class="account-details">
        <div class="account-name">${handle}</div>
        <div class="account-meta">${badges.join('')}</div>
      </div>
      ${canBeMother ? `<button type="button" class="mother-toggle-btn ${isMother ? 'active' : ''}" data-id="${accId}" title="${isMother ? 'Remover como Conta Mãe' : 'Marcar como Conta Mãe (repost automático)'}">👑</button>` : ''}
    </div>`;
}

// ── Renderiza Lista de Contas/Navegadores ────────────────────────────────────
function renderAccountsList() {
  const accountsToRender = allSavedAccountsList.length > 0 ? allSavedAccountsList : connectedClients;

  if (connectedCount) connectedCount.textContent = accountsToRender.length;
  if (activeAccountsBadge) activeAccountsBadge.textContent = `${accountsToRender.length} conectadas`;

  if (accountsToRender.length === 0) {
    if (accountsList) {
      accountsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔑</div>
          <h3>Nenhuma conta vinculada</h3>
          <p>Clique abaixo para adicionar tokens (auth_token) e vincular contas do Twitter ao servidor.</p>
        </div>`;
    }
    selectedClientIds.clear();
    updateTargetIndicator();
    return;
  }

  // Remove IDs que não existem mais
  const validIds = new Set(accountsToRender.map(a => a.id || a.token));
  for (const id of selectedClientIds) {
    if (!validIds.has(id)) selectedClientIds.delete(id);
  }

  if (accountsList) {
    const motherAccounts = accountsToRender.filter(a => a.isMother === true);
    const normalAccounts = accountsToRender.filter(a => a.isMother !== true);

    const sections = [];
    if (motherAccounts.length > 0) {
      sections.push(`<div class="accounts-section-label">👑 Contas Mães (${motherAccounts.length})</div>`);
      sections.push(motherAccounts.map(renderAccountCard).join(''));
    }
    if (normalAccounts.length > 0) {
      if (motherAccounts.length > 0) sections.push(`<div class="accounts-section-label">Contas Normais (${normalAccounts.length})</div>`);
      sections.push(normalAccounts.map(renderAccountCard).join(''));
    }
    accountsList.innerHTML = sections.join('');

    accountsList.querySelectorAll('.account-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mother-toggle-btn')) return;
        const id = card.dataset.id;
        if (!id) return;

        if (selectedClientIds.has(id)) {
          selectedClientIds.delete(id);
          card.classList.remove('selected');
          const cb = card.querySelector('.account-checkbox');
          if (cb) cb.checked = false;
        } else {
          selectedClientIds.add(id);
          card.classList.add('selected');
          const cb = card.querySelector('.account-checkbox');
          if (cb) cb.checked = true;
        }
        updateTargetIndicator();
      });
    });

    accountsList.querySelectorAll('.mother-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMotherAccount(btn.dataset.id);
      });
    });
  }

  updateTargetIndicator();
}

// ── Contas Mães (marca/desmarca uma conta para dar repost automático) ───────
async function toggleMotherAccount(accId) {
  if (!accId) return;
  try {
    const res = await fetch(`/api/accounts/${accId}/toggle-mother`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      allSavedAccountsList = data.accounts;
      renderAccountsList();
      if (tabPaneAccounts && !tabPaneAccounts.classList.contains('hidden')) {
        renderAccountsTable(allSavedAccountsList);
      }
    } else {
      alert('Erro ao alternar conta mãe: ' + (data.error || 'Falha desconhecida'));
    }
  } catch (err) {
    alert('Erro de conexão ao alternar conta mãe: ' + err.message);
  }
}

function updateTargetIndicator() {
  const count = selectedClientIds.size;
  const targetText = count === 0 ? 'Nenhuma conta selecionada' : `${count} conta(s) selecionada(s)`;
  
  if (targetAccountsText) targetAccountsText.textContent = targetText;
  if (document.getElementById('targetProfileAccountsText')) {
    document.getElementById('targetProfileAccountsText').textContent = targetText;
  }
  
  if (publishBtn) publishBtn.disabled = (count === 0);
  if (document.getElementById('saveProfileBtn')) {
    document.getElementById('saveProfileBtn').disabled = (count === 0);
  }
}

// ── Troca de Abas (Compositor / Buscador / Perfil / Gerenciar Contas) ────────
const tabBtns          = document.querySelectorAll('.tab-btn');
const tabPaneComposer  = document.getElementById('tabContentComposer');
const tabPaneVideos    = document.getElementById('tabContentVideos');
const tabPaneProfile   = document.getElementById('tabContentProfile');
const tabPaneAccounts  = document.getElementById('tabContentAccounts');
const tabPaneResults   = document.getElementById('tabContentResults');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const tab = btn.dataset.tab;
    if (tabPaneComposer) tabPaneComposer.classList.add('hidden');
    if (tabPaneVideos) tabPaneVideos.classList.add('hidden');
    if (tabPaneProfile) tabPaneProfile.classList.add('hidden');
    if (tabPaneAccounts) tabPaneAccounts.classList.add('hidden');
    if (tabPaneResults) tabPaneResults.classList.add('hidden');

    if (tab === 'composer' && tabPaneComposer) tabPaneComposer.classList.remove('hidden');
    if (tab === 'videos' && tabPaneVideos) tabPaneVideos.classList.remove('hidden');
    if (tab === 'profile' && tabPaneProfile) tabPaneProfile.classList.remove('hidden');
    if (tab === 'accounts' && tabPaneAccounts) {
      tabPaneAccounts.classList.remove('hidden');
      loadAccountsManagerData();
    }
    if (tab === 'results' && tabPaneResults) {
      tabPaneResults.classList.remove('hidden');
      loadResultsData(currentSelectedPeriod);
    }
  });
});

// ── Aba Resultados & Viralização ──────────────────────────────────────────────
let currentSelectedPeriod = 'today';

const periodBtns = document.querySelectorAll('.period-btn');
periodBtns.forEach(pBtn => {
  pBtn.addEventListener('click', () => {
    periodBtns.forEach(b => b.classList.remove('active'));
    pBtn.classList.add('active');
    currentSelectedPeriod = pBtn.dataset.period || 'today';
    loadResultsData(currentSelectedPeriod);
  });
});

const refreshResultsBtn = document.getElementById('refreshResultsBtn');
if (refreshResultsBtn) {
  refreshResultsBtn.addEventListener('click', async () => {
    const icon = document.getElementById('refreshResultsIcon');
    if (icon) icon.classList.add('spin-icon');
    refreshResultsBtn.disabled = true;
    try {
      const res = await fetch('/api/results/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: currentSelectedPeriod })
      });
      const data = await res.json();
      if (data.success) {
        renderResultsDashboard(data);
      }
    } catch (err) {
      console.error('Erro ao atualizar métricas:', err);
    } finally {
      if (icon) icon.classList.remove('spin-icon');
      refreshResultsBtn.disabled = false;
    }
  });
}

async function loadResultsData(period = 'today') {
  try {
    const res = await fetch(`/api/results?period=${period}`);
    const data = await res.json();
    if (data.success) {
      renderResultsDashboard(data);
    }
  } catch (err) {
    console.error('Erro ao carregar dados da aba Resultados:', err);
  }
}

function formatNumber(num) {
  num = Number(num || 0);
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function renderResultsDashboard(data) {
  const countBadge = document.getElementById('resultsCountBadge');
  if (countBadge) countBadge.textContent = `${data.totalCount || 0} postagens registradas`;

  const topContainer = document.getElementById('topPodiumContainer');
  const topPosts = data.topPosts || [];

  if (topContainer) {
    if (topPosts.length === 0) {
      topContainer.innerHTML = `
        <div style="grid-column: 1 / -1; padding:30px; text-align:center; background:rgba(255,255,255,0.02); border-radius:12px; border:1px dashed var(--border-color); color:var(--text-muted);">
          <span>📌 Nenhuma postagem com métricas registrada no período selecionado.</span>
        </div>`;
    } else {
      const podiumBadges = [
        { label: '🥇 TOP 1 DO DIA', color: '#FFD700', border: 'rgba(255,215,0,0.5)', bg: 'rgba(255,215,0,0.1)' },
        { label: '🥈 TOP 2 DO DIA', color: '#C0C0C0', border: 'rgba(192,192,192,0.5)', bg: 'rgba(192,192,192,0.1)' },
        { label: '🥉 TOP 3 DO DIA', color: '#CD7F32', border: 'rgba(205,127,50,0.5)', bg: 'rgba(205,127,50,0.1)' }
      ];

      topContainer.innerHTML = topPosts.map((post, idx) => {
        const badge = podiumBadges[idx] || podiumBadges[2];
        const firstMedia = (post.mediaUrls && post.mediaUrls[0]) ? post.mediaUrls[0] : '';
        const isVid = post.hasVideo || firstMedia.includes('.mp4');

        const mediaPreview = isVid && firstMedia
          ? `<video src="${firstMedia}#t=0.5" poster="${post.thumbnailUrl || ''}" preload="metadata" controls playsinline style="width:100%; height:160px; object-fit:cover; border-radius:8px; background:#000;"></video>`
          : (firstMedia ? `<img src="${firstMedia}" style="width:100%; height:160px; object-fit:cover; border-radius:8px;">` : `<div style="height:160px; background:rgba(0,0,0,0.4); display:flex; align-items:center; justify-content:center; border-radius:8px; color:var(--text-dim);">Sem Mídia</div>`);

        const m = post.metrics || { views: 0, likes: 0, retweets: 0, replies: 0 };

        return `
          <div class="podium-card" style="background:${badge.bg}; border:1px solid ${badge.border}; border-radius:14px; padding:16px; display:flex; flex-direction:column; gap:12px; transition:transform 0.2s;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="background:${badge.color}; color:#000; font-weight:900; font-size:11px; padding:4px 10px; border-radius:20px; letter-spacing:0.5px;">${badge.label}</span>
              <a href="${post.tweetUrl}" target="_blank" style="color:var(--primary); font-size:11px; text-decoration:none; font-weight:bold;">🔗 Ver no Twitter</a>
            </div>

            ${mediaPreview}

            <div style="display:flex; align-items:center; gap:10px;">
              ${post.avatar ? `<img src="${post.avatar}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">` : `<div style="width:32px; height:32px; border-radius:50%; background:var(--primary); display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:12px;">@</div>`}
              <div>
                <div style="font-weight:bold; color:#fff; font-size:13px;">@${post.username}</div>
                <div style="font-size:11px; color:var(--text-muted); text-overflow:ellipsis; overflow:hidden; max-width:200px; white-space:nowrap;">${post.caption || 'Sem legenda'}</div>
              </div>
            </div>

            <!-- GRID DE MÉTRICAS -->
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:6px; background:rgba(0,0,0,0.4); padding:10px; border-radius:8px; text-align:center;">
              <div>
                <div style="font-size:10px; color:var(--text-muted);">👁️ Views</div>
                <div style="font-weight:bold; color:#00f2fe; font-size:13px;">${formatNumber(m.views)}</div>
              </div>
              <div>
                <div style="font-size:10px; color:var(--text-muted);">❤️ Likes</div>
                <div style="font-weight:bold; color:#ff007f; font-size:13px;">${formatNumber(m.likes)}</div>
              </div>
              <div>
                <div style="font-size:10px; color:var(--text-muted);">🔁 Reposts</div>
                <div style="font-weight:bold; color:#00ff87; font-size:13px;">${formatNumber(m.retweets)}</div>
              </div>
              <div>
                <div style="font-size:10px; color:var(--text-muted);">💬 Replies</div>
                <div style="font-weight:bold; color:#ffb703; font-size:13px;">${formatNumber(m.replies)}</div>
              </div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // TABELA COMPLETA
  const tbody = document.getElementById('resultsTableBody');
  const posts = data.posts || [];
  if (tbody) {
    if (posts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">Nenhuma postagem encontrada no período selecionado.</td></tr>`;
    } else {
      tbody.innerHTML = posts.map(post => {
        const firstMedia = (post.mediaUrls && post.mediaUrls[0]) ? post.mediaUrls[0] : '';
        const isVid = post.hasVideo || firstMedia.includes('.mp4');
        const m = post.metrics || { views: 0, likes: 0, retweets: 0, replies: 0 };
        const dateStr = post.publishedAt ? new Date(post.publishedAt).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '-';

        const mediaThumb = post.thumbnailUrl
          ? `<div style="position:relative; width:60px; height:45px; border-radius:6px; overflow:hidden;"><img src="${post.thumbnailUrl}" style="width:100%; height:100%; object-fit:cover;">${isVid ? '<span style="position:absolute; bottom:2px; right:2px; background:rgba(0,0,0,0.7); color:#fff; font-size:8px; padding:1px 3px; border-radius:3px;">🎬</span>' : ''}</div>`
          : (isVid && firstMedia
              ? `<video src="${firstMedia}#t=0.5" preload="metadata" style="width:60px; height:45px; object-fit:cover; border-radius:6px; background:#000;"></video>`
              : (firstMedia ? `<img src="${firstMedia}" style="width:60px; height:45px; object-fit:cover; border-radius:6px;">` : `<span style="font-size:11px; color:var(--text-dim);">Sem Mídia</span>`));

        return `
          <tr>
            <td>${mediaThumb}</td>
            <td>
              <div style="display:flex; align-items:center; gap:6px;">
                ${post.avatar ? `<img src="${post.avatar}" style="width:24px; height:24px; border-radius:50%;">` : ''}
                <span style="font-weight:bold; font-size:12px; color:#fff;">@${post.username}</span>
              </div>
            </td>
            <td style="max-width:200px; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--text-muted);">${post.caption || 'Sem legenda'}</td>
            <td><strong style="color:#00f2fe;">${formatNumber(m.views)}</strong></td>
            <td><strong style="color:#ff007f;">${formatNumber(m.likes)}</strong></td>
            <td><strong style="color:#00ff87;">${formatNumber(m.retweets)}</strong></td>
            <td><strong style="color:#ffb703;">${formatNumber(m.replies)}</strong></td>
            <td style="font-size:11px; color:var(--text-muted);">${dateStr}</td>
            <td><a href="${post.tweetUrl}" target="_blank" class="btn-text" style="font-size:11px;">🔗 Abrir</a></td>
          </tr>`;
      }).join('');
    }
  }
}

// ── Aba Editar Perfil ────────────────────────────────────────────────────────
const profileForm       = document.getElementById('profileForm');
const pickAvatarBtn     = document.getElementById('pickAvatarBtn');
const avatarInput       = document.getElementById('avatarInput');
const avatarPreviewBox  = document.getElementById('avatarPreviewBox');
const pickBannerBtn     = document.getElementById('pickBannerBtn');
const bannerInput       = document.getElementById('bannerInput');
const bannerPreviewBox  = document.getElementById('bannerPreviewBox');
const bioText           = document.getElementById('bioText');
const siteLinkInput     = document.getElementById('siteLinkInput');
const saveProfileBtn    = document.getElementById('saveProfileBtn');

let selectedAvatarUrl = null;
let selectedBannerUrl = null;

if (pickAvatarBtn && avatarInput) {
  pickAvatarBtn.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    if (avatarInput.files.length) {
      const file = avatarInput.files[0];
      const formData = new FormData();
      formData.append('files', file);
      try {
        const res = await fetch('/api/upload-media', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success && data.files[0]) {
          selectedAvatarUrl = location.origin + data.files[0].url;
          avatarPreviewBox.innerHTML = `<img src="${data.files[0].url}">`;
        }
      } catch (err) { alert('Erro ao carregar avatar: ' + err.message); }
    }
  });
}

if (pickBannerBtn && bannerInput) {
  pickBannerBtn.addEventListener('click', () => bannerInput.click());
  bannerInput.addEventListener('change', async () => {
    if (bannerInput.files.length) {
      const file = bannerInput.files[0];
      const formData = new FormData();
      formData.append('files', file);
      try {
        const res = await fetch('/api/upload-media', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success && data.files[0]) {
          selectedBannerUrl = location.origin + data.files[0].url;
          bannerPreviewBox.innerHTML = `<img src="${data.files[0].url}">`;
        }
      } catch (err) { alert('Erro ao carregar banner: ' + err.message); }
    }
  });
}

if (profileForm) {
  profileForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (selectedClientIds.size === 0) {
      alert('Selecione pelo menos 1 conta na lista para editar o perfil.');
      return;
    }

    const bio = bioText.value.trim();
    const siteLink = siteLinkInput.value.trim();

    if (!bio && !siteLink && !selectedAvatarUrl && !selectedBannerUrl) {
      alert('Preencha pelo menos um campo (Foto, Banner, Bio ou Site) para salvar.');
      return;
    }

    const payload = {
      type: 'DISPATCH_EDIT_PROFILE',
      targetClientIds: Array.from(selectedClientIds),
      profileData: {
        bio: bio,
        siteLink: siteLink,
        avatarUrl: selectedAvatarUrl,
        bannerUrl: selectedBannerUrl
      }
    };

    ws.send(JSON.stringify(payload));
    console.log('[Dashboard] Comando de edição de perfil disparado:', payload);

    selectedClientIds.forEach(clientId => {
      clientProgressMap.set(clientId, {
        stepIndex: 0,
        label: 'Iniciando edição de perfil...',
        stepStatus: 'running',
        error: null
      });
    });
    renderExecutionMonitor();

    executionMonitor.scrollIntoView({ behavior: 'smooth' });
  });
}

// Botões Selecionar Todas / Limpar
if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    const list = allSavedAccountsList.length > 0 ? allSavedAccountsList : connectedClients;
    list.forEach(c => selectedClientIds.add(c.id || c.token || c.clientId));
    renderAccountsList();
  });
}

if (deselectAllBtn) {
  deselectAllBtn.addEventListener('click', () => {
    selectedClientIds.clear();
    renderAccountsList();
  });
}

// ── Contador de Caracteres ────────────────────────────────────────────────────
tweetText.addEventListener('input', () => {
  const len = tweetText.value.length;
  charCount.textContent = len;
  charCount.style.color = len > 280 ? 'var(--error)' : 'var(--text-dim)';
});

// ── Upload de Mídias ──────────────────────────────────────────────────────────
dropZone.addEventListener('click', (e) => {
  if (e.target.closest('.thumb-remove-btn')) return;
  mediaInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    uploadFiles(e.dataTransfer.files);
  }
});

mediaInput.addEventListener('change', () => {
  if (mediaInput.files.length) {
    uploadFiles(mediaInput.files);
  }
});

// Suporte a Colar Imagem/Vídeo (Ctrl+V) em qualquer lugar da página ou na área do compositor
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items || [];
  const filesToUpload = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
      const file = item.getAsFile();
      if (file) filesToUpload.push(file);
    }
  }

  if (filesToUpload.length > 0) {
    e.preventDefault();
    uploadFiles(filesToUpload);
  }
});

async function uploadFiles(files) {
  if (uploadedMediaFiles.length + files.length > 4) {
    alert('Você só pode enviar até 4 mídias por postagem.');
    return;
  }

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  try {
    const res = await fetch('/api/upload-media', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      uploadedMediaFiles = [...uploadedMediaFiles, ...data.files];
      renderMediaPreviews();
    } else {
      alert('Erro no upload: ' + data.error);
    }
  } catch (err) {
    alert('Falha ao enviar arquivo: ' + err.message);
  }
}

function renderMediaPreviews() {
  if (uploadedMediaFiles.length === 0) {
    dropzonePrompt.classList.remove('hidden');
    mediaPreviewGrid.classList.add('hidden');
    mediaPreviewGrid.innerHTML = '';
    return;
  }

  dropzonePrompt.classList.add('hidden');
  mediaPreviewGrid.classList.remove('hidden');

  mediaPreviewGrid.innerHTML = uploadedMediaFiles.map((f, i) => {
    const isVideo = f.type.startsWith('video/');
    return `
      <div class="media-thumb-item">
        ${isVideo 
          ? (f.thumbnailUrl 
              ? `<img src="${f.thumbnailUrl}" alt="${f.name}"><span class="thumb-badge">🎬 Vídeo</span>` 
              : `<video src="${f.url}#t=0.5" preload="metadata" muted playsinline></video><span class="thumb-badge">🎬 Vídeo</span>`)
          : `<img src="${f.url}" alt="${f.name}">`}
        <button type="button" class="thumb-remove-btn" data-index="${i}" title="Remover">✕</button>
      </div>`;
  }).join('');

  document.querySelectorAll('.thumb-remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      uploadedMediaFiles.splice(idx, 1);
      renderMediaPreviews();
    });
  });
}

// ── Slider de Atraso (Staggering) ─────────────────────────────────────────────
staggerRange.addEventListener('input', () => {
  const val = staggerRange.value;
  if (val == 0) {
    staggerValue.textContent = '0 segundos (Simultâneo)';
  } else {
    staggerValue.textContent = `${val} segundos entre cada conta`;
  }
});

// ── Modal "Postar com Repost em Contas Mães" ─────────────────────────────────
const motherAccountsModal        = document.getElementById('motherAccountsModal');
const motherAccountsListContainer = document.getElementById('motherAccountsListContainer');
const closeMotherModalBtn        = document.getElementById('closeMotherModalBtn');
const skipMotherRepostBtn        = document.getElementById('skipMotherRepostBtn');
const confirmMotherRepostBtn     = document.getElementById('confirmMotherRepostBtn');

// Antes de disparar uma postagem (única ou em massa), verifica se há Contas
// Mães cadastradas. Se houver, pergunta quais delas devem repostar os posts
// que serão publicados agora. onConfirm recebe o array de IDs selecionados
// (vazio se o usuário optar por publicar sem repost nas mães).
function promptMotherRepostThenDispatch(onConfirm) {
  const motherAccounts = allSavedAccountsList.filter(a => a.isMother === true && a.status === 'Válido');

  if (!motherAccountsModal || motherAccounts.length === 0) {
    onConfirm([]);
    return;
  }

  motherAccountsListContainer.innerHTML = motherAccounts.map(acc => `
    <label class="mother-account-option">
      <input type="checkbox" class="mother-select-checkbox" data-id="${acc.id}">
      ${acc.avatar ? `<img src="${acc.avatar}" alt="Avatar">` : ''}
      <span>👑 @${acc.username}</span>
    </label>
  `).join('');

  motherAccountsModal.classList.remove('hidden');

  const cleanup = () => {
    motherAccountsModal.classList.add('hidden');
    closeMotherModalBtn.onclick = null;
    skipMotherRepostBtn.onclick = null;
    confirmMotherRepostBtn.onclick = null;
  };

  closeMotherModalBtn.onclick = () => cleanup();

  skipMotherRepostBtn.onclick = () => {
    cleanup();
    onConfirm([]);
  };

  confirmMotherRepostBtn.onclick = () => {
    const selectedIds = Array.from(motherAccountsListContainer.querySelectorAll('.mother-select-checkbox:checked')).map(cb => cb.dataset.id);
    if (selectedIds.length === 0) {
      alert('Selecione pelo menos 1 conta mãe, ou clique em "Publicar sem Repost nas Mães".');
      return;
    }
    cleanup();
    onConfirm(selectedIds);
  };
}

// ── Envio do Formulário (Disparo para Contas) ──────────────────────────────────
postForm.addEventListener('submit', (e) => {
  e.preventDefault();

  if (selectedClientIds.size === 0) {
    alert('Selecione pelo menos 1 conta na barra lateral esquerda para publicar.');
    return;
  }

  const selectedAccIds = Array.from(selectedClientIds);

  // MODO EM MASSA ATIVO
  if (massDispatchItems && massDispatchItems.length > 0) {
    const activePosts = massDispatchItems.filter(item => item.selected !== false);
    if (activePosts.length === 0) {
      alert('Selecione pelo menos 1 post (Post 1, Post 2...) na lista para publicar.');
      return;
    }

    const comment = (commentText && commentText.value.trim()) ? commentText.value.trim() : 'CHECK BIO';
    const repost = doRepost ? doRepost.checked : false;
    const pin = doPin ? doPin.checked : false;
    const reply = replyRestriction ? replyRestriction.value : 'everyone';
    const staggerDelay = parseInt(staggerRange.value, 10) || 0;

    // Distribui os posts selecionados entre as contas da barra lateral selecionadas
    const itemsToDispatch = activePosts.map((post, index) => {
      const accId = selectedAccIds[index % selectedAccIds.length];
      const acc = allSavedAccountsList.find(a => a.id === accId || a.token === accId);
      const isVid = post.hasVideo || (post.mediaUrls && post.mediaUrls.some(u => String(u).includes('.mp4') || String(u).includes('video')));

      return {
        token: acc ? acc.token : accId,
        username: acc ? acc.username : '',
        text: post.caption || '',
        mediaUrls: post.mediaUrls || [],
        hasVideo: isVid,
        comment: comment,
        repost: repost,
        pin: pin,
        replyRestriction: reply,
        reply: reply
      };
    });

    promptMotherRepostThenDispatch((motherAccountIds) => {
      ws.send(JSON.stringify({
        type: 'DISPATCH_MASS_POST',
        items: itemsToDispatch,
        staggerDelay,
        motherAccountIds
      }));

      itemsToDispatch.forEach(item => {
        const acc = allSavedAccountsList.find(a => a.token === item.token || a.id === item.token);
        const cId = acc ? acc.id : item.token;
        clientProgressMap.set(cId, {
          stepIndex: 0,
          label: 'Disparo em massa iniciado...',
          stepStatus: 'running',
          error: null
        });
      });

      renderExecutionMonitor();
      if (executionMonitor) executionMonitor.scrollIntoView({ behavior: 'smooth' });

      const motherMsg = motherAccountIds.length > 0 ? ` + repost automático em ${motherAccountIds.length} conta(s) mãe(s)` : '';
      alert(`Disparo em massa de ${itemsToDispatch.length} post(s) iniciado para ${selectedAccIds.length} conta(s) selecionada(s)${motherMsg}! Acompanhe no monitor abaixo.`);
    });
    return;
  }

  if (selectedClientIds.size === 0) {
    alert('Selecione pelo menos 1 conta na lista para publicar.');
    return;
  }

  const text = tweetText.value.trim();
  if (!text && uploadedMediaFiles.length === 0) {
    alert('Digite um texto ou adicione pelo menos uma mídia para publicar.');
    return;
  }

  promptMotherRepostThenDispatch((motherAccountIds) => {
    const payload = {
      type: 'DISPATCH_POST',
      targetClientIds: Array.from(selectedClientIds),
      delayBetweenClientsSec: parseInt(staggerRange.value) || 0,
      motherAccountIds,
      postData: {
        text: text,
        mediaUrls: uploadedMediaFiles.map(f => f.url.startsWith('http') ? f.url : location.origin + f.url),
        comment: commentText.value.trim() || 'CHECK BIO',
        repost: doRepost.checked,
        pin: doPin.checked,
        replyRestriction: replyRestriction.value
      }
    };

    ws.send(JSON.stringify(payload));
    console.log('[Dashboard] Comando de postagem disparado:', payload);

    // Inicializa visualizador de progresso para os clientes selecionados
    selectedClientIds.forEach(clientId => {
      clientProgressMap.set(clientId, {
        stepIndex: 0,
        label: 'Agendado / Iniciando...',
        stepStatus: 'running',
        error: null
      });
    });
    renderExecutionMonitor();

    // Scroll suave para o monitor
    executionMonitor.scrollIntoView({ behavior: 'smooth' });
  });
});

// ── Atualização do Monitor de Atividade ───────────────────────────────────────
function handleStepUpdate(msg) {
  clientProgressMap.set(msg.clientId, {
    stepIndex: msg.stepIndex || 0,
    label: msg.label || 'Em andamento...',
    stepStatus: msg.stepStatus || 'running',
    error: msg.error || null,
    overallStatus: msg.overallStatus,
    isMotherAction: msg.isMotherAction || false,
    motherUsername: msg.motherUsername || null,
    motherAvatar: msg.motherAvatar || null
  });
  renderExecutionMonitor();
}

function renderExecutionMonitor() {
  const containers = [
    document.getElementById('executionMonitor'),
    document.getElementById('executionMonitorTab')
  ].filter(Boolean);

  if (containers.length === 0) return;

  if (clientProgressMap.size === 0) {
    const emptyHtml = `
      <div class="empty-activity">
        <span>Nenhuma postagem ou atividade em andamento no momento.</span>
      </div>`;
    containers.forEach(c => c.innerHTML = emptyHtml);
    updateActiveBadge(0);
    return;
  }

  const totalSteps = 8;
  const cards = [];
  let runningCount = 0;

  for (const [clientId, prog] of clientProgressMap.entries()) {
    let handle;
    if (prog.isMotherAction && prog.motherUsername) {
      handle = `👑 @${prog.motherUsername} (conta mãe)`;
    } else {
      const acc = allSavedAccountsList.find(a => a.id === clientId || a.token === clientId || a.username === clientId);
      const extClient = connectedClients.find(c => c.clientId === clientId || c.account?.username === clientId);
      const username = acc?.username || extClient?.account?.username;
      handle = username && username !== 'Desconhecido'
        ? `@${username}`
        : (acc?.name || (clientId.startsWith('acc_') ? `Conta (${clientId.substring(0, 10)})` : `@${clientId}`));
    }

    const pct = Math.min(100, Math.round(((prog.stepIndex + 1) / totalSteps) * 100));

    let statusText = prog.label;
    let isError = prog.stepStatus === 'error' || prog.overallStatus === 'error';
    let isSuccess = prog.stepStatus === 'completed' || prog.overallStatus === 'completed';

    if (!isError && !isSuccess) runningCount++;

    cards.push(`
      <div class="client-progress-card">
        <div class="progress-header">
          <div class="progress-account">
            <span>👤 ${handle}</span>
          </div>
          <div class="progress-step-label" style="color: ${isError ? 'var(--error)' : isSuccess ? 'var(--success)' : 'var(--primary)'}">
            ${isError ? '❌ Erro: ' + (prog.error || 'Falha') : isSuccess ? '✅ Concluído com sucesso!' : `[Passo ${prog.stepIndex + 1}/${totalSteps}] ${statusText}`}
          </div>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${isSuccess ? 100 : pct}%; background: ${isError ? 'var(--error)' : isSuccess ? 'var(--success)' : ''}"></div>
        </div>
      </div>`);
  }

  const htmlContent = cards.join('');
  containers.forEach(c => c.innerHTML = htmlContent);
  updateActiveBadge(runningCount);
}

function updateActiveBadge(runningCount = 0) {
  const badge = document.getElementById('activeJobsBadge');
  const summary = document.getElementById('monitorActiveSummary');
  if (badge) {
    if (runningCount > 0) {
      badge.textContent = runningCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
  if (summary) {
    summary.textContent = runningCount > 0 ? `${runningCount} ação(ões) em andamento` : `${clientProgressMap.size} atividade(s) registradas`;
  }
}

function clearMonitorHistory() {
  clientProgressMap.clear();
  renderExecutionMonitor();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CLEAR_PROGRESS_STATE' }));
  }
}

const clearMonitorHistoryBtn = document.getElementById('clearMonitorHistoryBtn');
const clearMonitorHistoryBottomBtn = document.getElementById('clearMonitorHistoryBottomBtn');
if (clearMonitorHistoryBtn) clearMonitorHistoryBtn.addEventListener('click', clearMonitorHistory);
if (clearMonitorHistoryBottomBtn) clearMonitorHistoryBottomBtn.addEventListener('click', clearMonitorHistory);

// Inicializa Conexão no carregamento da página
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  loadAccountsManagerData();

  // Restaura disparo em massa do localStorage caso exista
  try {
    const savedMass = localStorage.getItem('massDispatchItems');
    if (savedMass) {
      massDispatchItems = JSON.parse(savedMass);
      if (massDispatchItems && massDispatchItems.length > 0) {
        const singleFields = document.getElementById('singlePostComposerFields');
        const massFields = document.getElementById('massPostComposerFields');
        if (singleFields) singleFields.classList.add('hidden');
        if (massFields) massFields.classList.remove('hidden');
        renderMassPostComposerCards();

        const publishBtn = document.getElementById('publishBtn');
        if (publishBtn) {
          const btnText = publishBtn.querySelector('.btn-text');
          if (btnText) btnText.textContent = '🚀 PUBLICAR DISPARO EM MASSA';
        }
      }
    }
  } catch (e) {}
});

// ── Buscador de Mídias do X/Twitter (Fotos + Vídeos) ─────────────────────────
const videoSearchForm       = document.getElementById('videoSearchForm');
const videoPostUrl          = document.getElementById('videoPostUrl');
const searchVideoBtn        = document.getElementById('searchVideoBtn');
const videoResultCard       = document.getElementById('videoResultCard');

const videoAuthorHeader     = document.getElementById('videoAuthorHeader');
const videoAuthorAvatar     = document.getElementById('videoAuthorAvatar');
const videoAuthorName       = document.getElementById('videoAuthorName');
const videoAuthorHandle     = document.getElementById('videoAuthorHandle');
const videoCaptionText      = document.getElementById('videoCaptionText');
const extractedMediaGrid    = document.getElementById('extractedMediaGrid');
const downloadVideoBtn      = document.getElementById('downloadVideoBtn');
const useVideoInComposerBtn  = document.getElementById('useVideoInComposerBtn');

let currentFoundMediaData = null;

if (videoSearchForm) {
  videoSearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = videoPostUrl.value.trim();
    if (!link) return;

    searchVideoBtn.disabled = true;
    searchVideoBtn.innerHTML = '<span class="btn-icon">⏳</span> Buscando mídias e legenda...';

    try {
      const res = await fetch('/api/fetch-tweet-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link })
      });
      const data = await res.json();

      if (data.success) {
        currentFoundMediaData = data;
        videoResultCard.classList.remove('hidden');

        if (data.author) {
          videoAuthorHeader.classList.remove('hidden');
          videoAuthorAvatar.src = data.author.avatar || '';
          videoAuthorName.textContent = data.author.name || '';
          videoAuthorHandle.textContent = `@${data.author.screen_name || ''}`;
        } else {
          videoAuthorHeader.classList.add('hidden');
        }

        videoCaptionText.textContent = data.caption || 'Sem legenda.';

        // Renderiza o grid de mídias extraídas (fotos e/ou vídeos)
        const mediaItems = data.media || [{ type: 'video', url: data.videoUrl, thumbnailUrl: data.thumbnailUrl }];
        extractedMediaGrid.innerHTML = mediaItems.map(m => {
          if (m.type === 'video') {
            return `
              <div class="extracted-media-item">
                <span class="media-type-badge">🎬 Vídeo</span>
                <video src="${m.url}" controls playsinline poster="${m.thumbnailUrl || ''}"></video>
              </div>`;
          } else {
            return `
              <div class="extracted-media-item">
                <span class="media-type-badge">🖼️ Foto</span>
                <img src="${m.url}" alt="Foto do X">
              </div>`;
          }
        }).join('');

        downloadVideoBtn.href = data.videoUrl || (mediaItems[0] ? mediaItems[0].url : '#');

      } else {
        alert('Erro ao buscar mídias: ' + data.error);
        videoResultCard.classList.add('hidden');
      }
    } catch (err) {
      alert('Falha na requisição: ' + err.message);
      videoResultCard.classList.add('hidden');
    } finally {
      searchVideoBtn.disabled = false;
      searchVideoBtn.innerHTML = '<span class="btn-icon">👁️</span> Buscar mídias e legenda';
    }
  });
}

// Botão "Importar Mídias & Legenda para o Compositor Central"
if (useVideoInComposerBtn) {
  useVideoInComposerBtn.addEventListener('click', () => {
    if (!currentFoundMediaData) return;

    const mediaItems = currentFoundMediaData.media || [{ type: 'video', url: currentFoundMediaData.videoUrl, thumbnailUrl: currentFoundMediaData.thumbnailUrl }];
    
    if (uploadedMediaFiles.length + mediaItems.length > 4) {
      alert('Atenção: O compositor aceita no máximo 4 mídias por postagem.');
    }

    // Adiciona as mídias ao compositor
    for (const m of mediaItems) {
      if (uploadedMediaFiles.length < 4) {
        uploadedMediaFiles.push({
          url: m.url,
          thumbnailUrl: m.thumbnailUrl || '',
          name: `x_media_${Date.now()}_${uploadedMediaFiles.length + 1}.${m.type === 'video' ? 'mp4' : 'jpg'}`,
          type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          size: 0
        });
      }
    }
    renderMediaPreviews();

    // Preenche o texto do tweet com a legenda se o campo estiver vazio
    if (!tweetText.value.trim() && currentFoundMediaData.caption) {
      tweetText.value = currentFoundMediaData.caption;
      tweetText.dispatchEvent(new Event('input'));
    }

    // Alterna para a aba do compositor
    document.querySelector('[data-tab="composer"]').click();
    alert('Mídias e legenda importadas com sucesso para o Compositor Central!');
  });
}

// ── Busca de Mídias e Legendas em Massa (Múltiplos Links) ──────────────────────
let bulkExtractedResults = [];
let massDispatchItems = null;

const singleSearchModeBtn   = document.getElementById('singleSearchModeBtn');
const bulkSearchModeBtn     = document.getElementById('bulkSearchModeBtn');
const bulkVideoSearchForm   = document.getElementById('bulkVideoSearchForm');
const searchBulkVideoBtn    = document.getElementById('searchBulkVideoBtn');
const bulkPostUrls          = document.getElementById('bulkPostUrls');
const bulkResultCard        = document.getElementById('bulkResultCard');
const bulkExtractedGrid     = document.getElementById('bulkExtractedGrid');
const sendBulkToComposerBtn = document.getElementById('sendBulkToComposerBtn');

if (singleSearchModeBtn && bulkSearchModeBtn) {
  singleSearchModeBtn.addEventListener('click', () => {
    singleSearchModeBtn.classList.add('active');
    bulkSearchModeBtn.classList.remove('active');
    videoSearchForm.classList.remove('hidden');
    bulkVideoSearchForm.classList.add('hidden');
  });

  bulkSearchModeBtn.addEventListener('click', () => {
    bulkSearchModeBtn.classList.add('active');
    singleSearchModeBtn.classList.remove('active');
    bulkVideoSearchForm.classList.remove('hidden');
    videoSearchForm.classList.add('hidden');
  });
}

if (bulkVideoSearchForm) {
  bulkVideoSearchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const textUrls = bulkPostUrls.value.trim();
    if (!textUrls) {
      alert('Cole pelo menos 1 link de postagem do X/Twitter.');
      return;
    }

    const linksArray = textUrls.split('\n').map(l => l.trim()).filter(l => l.includes('/status/'));
    if (linksArray.length === 0) {
      alert('Nenhum link válido contendo /status/ foi encontrado.');
      return;
    }

    searchBulkVideoBtn.disabled = true;
    searchBulkVideoBtn.innerHTML = '<span class="btn-icon">⏳</span> Extraindo Mídias e Legendas em Massa...';

    try {
      const res = await fetch('/api/media-search/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links: linksArray })
      });
      const data = await res.json();

      if (data.success && data.results && data.results.length > 0) {
        bulkExtractedResults = data.results;
        renderBulkExtractedGrid(bulkExtractedResults);
        bulkResultCard.classList.remove('hidden');
      } else {
        alert('Nenhuma mídia extraída dos links informados.');
        bulkResultCard.classList.add('hidden');
      }
    } catch (err) {
      alert('Erro ao extrair mídias em massa: ' + err.message);
      bulkResultCard.classList.add('hidden');
    } finally {
      searchBulkVideoBtn.disabled = false;
      searchBulkVideoBtn.innerHTML = '<span class="btn-icon">⚡</span> Buscar Mídias dos Links em Massa';
    }
  });
}

function renderBulkExtractedGrid(results) {
  if (!bulkExtractedGrid) return;

  bulkExtractedGrid.innerHTML = results.map((item, index) => {
    const details = item.mediaDetails && item.mediaDetails.length > 0
      ? item.mediaDetails
      : (item.mediaUrls || []).map(u => ({ url: u, type: u.includes('.mp4') || item.hasVideo ? 'video' : 'image' }));

    const mediaHtml = details.map(m => {
      const isVid = m.type === 'video' || m.url.includes('.mp4');
      if (isVid) {
        return `
          <div style="position:relative; width:160px; height:120px; border-radius:8px; overflow:hidden; background:#000; border:1px solid var(--border-color); flex-shrink:0;">
            <video src="${m.url}" poster="${m.thumbnailUrl || ''}" controls playsinline style="width:100%; height:100%; object-fit:cover;"></video>
            <span style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:bold; pointer-events:none;">🎬 Vídeo</span>
          </div>`;
      } else {
        return `
          <div style="position:relative; width:160px; height:120px; border-radius:8px; overflow:hidden; border:1px solid var(--border-color); flex-shrink:0;">
            <img src="${m.url}" style="width:100%; height:100%; object-fit:cover;">
            <span style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:bold; pointer-events:none;">🖼️ Foto</span>
          </div>`;
      }
    }).join('');

    return `
      <div class="bulk-item-card" style="display:flex; flex-direction:column; gap:12px; background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:12px; padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:13px; color:var(--primary); font-weight:bold;">Post ${index + 1} — ${item.url}</span>
          <span style="font-size:11px; color:var(--text-muted);">${details.length} mídia(s) extraída(s)</span>
        </div>

        <div style="display:flex; gap:12px; overflow-x:auto; padding-bottom:8px;">
          ${mediaHtml || '<div style="padding:20px; background:rgba(255,255,255,0.05); border-radius:8px; text-align:center;">Sem mídia</div>'}
        </div>

        <div>
          <label style="font-size:11px; font-weight:bold; color:var(--text-muted); display:block; margin-bottom:4px;">LEGENDA EXTRAÍDA:</label>
          <div style="width:100%; border-radius:8px; padding:10px; background:rgba(0,0,0,0.25); color:#fff; border:1px solid var(--border-color); font-size:13px; min-height:42px; max-height:90px; overflow-y:auto;">${item.caption || 'Sem legenda.'}</div>
        </div>
      </div>`;
  }).join('');
}

if (sendBulkToComposerBtn) {
  sendBulkToComposerBtn.addEventListener('click', () => {
    if (!bulkExtractedResults || bulkExtractedResults.length === 0) return;

    const items = bulkExtractedResults.map((orig, i) => ({
      id: `post_${i + 1}`,
      url: orig.url,
      caption: orig.caption || '',
      mediaUrls: orig.mediaUrls || [],
      mediaDetails: orig.mediaDetails || [],
      hasVideo: orig.hasVideo || false,
      selected: true
    }));

    massDispatchItems = items;
    renderMassPostComposerCards();

    const singleFields = document.getElementById('singlePostComposerFields');
    const massFields = document.getElementById('massPostComposerFields');
    if (singleFields) singleFields.classList.add('hidden');
    if (massFields) massFields.classList.remove('hidden');

    const publishBtn = document.getElementById('publishBtn');
    if (publishBtn) {
      const btnText = publishBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = '🚀 PUBLICAR DISPARO EM MASSA';
    }

    document.querySelector('[data-tab="composer"]').click();
    alert(`⚡ ${items.length} postagens em massa importadas para o Compositor Central! Altere a legenda caso necessário, selecione as contas no painel esquerdo e clique em Publicar!`);
  });
}

function renderMassPostComposerCards() {
  const container = document.getElementById('massPostsListContainer');
  const countText = document.getElementById('massPostCountText');
  if (!container || !massDispatchItems) return;

  if (countText) countText.textContent = massDispatchItems.length;

  container.innerHTML = massDispatchItems.map((item, index) => {
    const details = item.mediaDetails && item.mediaDetails.length > 0
      ? item.mediaDetails
      : (item.mediaUrls || []).map(u => ({ url: u, type: u.includes('.mp4') || item.hasVideo ? 'video' : 'image' }));

    const mediaHtml = details.map(m => {
      const isVid = m.type === 'video' || m.url.includes('.mp4');
      if (isVid) {
        return `
          <div style="position:relative; width:140px; height:105px; border-radius:8px; overflow:hidden; background:#000; border:1px solid var(--border-color); flex-shrink:0;">
            <video src="${m.url}" poster="${m.thumbnailUrl || ''}" controls playsinline style="width:100%; height:100%; object-fit:cover;"></video>
            <span style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); color:#fff; font-size:9px; padding:2px 4px; border-radius:4px; pointer-events:none;">🎬 Vídeo</span>
          </div>`;
      } else {
        return `
          <div style="position:relative; width:140px; height:105px; border-radius:8px; overflow:hidden; border:1px solid var(--border-color); flex-shrink:0;">
            <img src="${m.url}" style="width:100%; height:100%; object-fit:cover;">
            <span style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); color:#fff; font-size:9px; padding:2px 4px; border-radius:4px; pointer-events:none;">🖼️ Foto</span>
          </div>`;
      }
    }).join('');

    return `
      <div class="mass-post-card" data-index="${index}" style="background:rgba(255,255,255,0.03); border:1px solid ${item.selected ? 'var(--primary)' : 'var(--border-color)'}; border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <label style="display:flex; align-items:center; gap:8px; font-weight:bold; color:#fff; cursor:pointer;">
            <input type="checkbox" class="mass-post-checkbox" data-index="${index}" ${item.selected ? 'checked' : ''} style="width:18px; height:18px;">
            <span>Post ${index + 1}</span>
          </label>
          <span style="font-size:11px; color:var(--text-muted);">${item.url}</span>
        </div>

        <div style="display:flex; gap:10px; overflow-x:auto; padding-bottom:6px;">
          ${mediaHtml || '<div style="padding:10px; color:var(--text-dim); font-size:12px;">Sem mídias</div>'}
        </div>

        <div>
          <label style="font-size:11px; font-weight:bold; color:var(--text-muted); display:block; margin-bottom:4px;">LEGENDA DO POST (EDITÁVEL CASO NECESSÁRIO):</label>
          <textarea class="mass-post-caption" data-index="${index}" rows="2" style="width:100%; border-radius:8px; padding:8px; background:rgba(0,0,0,0.3); color:#fff; border:1px solid var(--border-color); font-size:13px;">${item.caption || ''}</textarea>
        </div>
      </div>`;
  }).join('');

  try {
    localStorage.setItem('massDispatchItems', JSON.stringify(massDispatchItems));
  } catch (e) {}

  container.querySelectorAll('.mass-post-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.index, 10);
      if (massDispatchItems[idx]) {
        massDispatchItems[idx].selected = cb.checked;
        try { localStorage.setItem('massDispatchItems', JSON.stringify(massDispatchItems)); } catch (e) {}
        const card = container.querySelector(`.mass-post-card[data-index="${idx}"]`);
        if (card) {
          card.style.borderColor = cb.checked ? 'var(--primary)' : 'var(--border-color)';
        }
      }
    });
  });

  container.querySelectorAll('.mass-post-caption').forEach(ta => {
    ta.addEventListener('input', () => {
      const idx = parseInt(ta.dataset.index, 10);
      if (massDispatchItems[idx]) {
        massDispatchItems[idx].caption = ta.value.trim();
        try { localStorage.setItem('massDispatchItems', JSON.stringify(massDispatchItems)); } catch (e) {}
      }
    });
  });
}

const cancelMassModeBtn = document.getElementById('cancelMassModeBtn');
if (cancelMassModeBtn) {
  cancelMassModeBtn.addEventListener('click', () => {
    massDispatchItems = null;
    try { localStorage.removeItem('massDispatchItems'); } catch (e) {}
    const singleFields = document.getElementById('singlePostComposerFields');
    const massFields = document.getElementById('massPostComposerFields');
    if (singleFields) singleFields.classList.remove('hidden');
    if (massFields) massFields.classList.add('hidden');

    const publishBtn = document.getElementById('publishBtn');
    if (publishBtn) {
      const btnText = publishBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = 'PUBLICAR NAS CONTAS SELECIONADAS';
    }
  });
}

// ── Modal de Login via Token (auth_token 1-Click) ────────────────────────────
const tokenModal           = document.getElementById('tokenModal');
const openTokenModalBtn    = document.getElementById('openTokenModalBtn');
const closeTokenModalBtn   = document.getElementById('closeTokenModalBtn');
const cancelTokenBtn       = document.getElementById('cancelTokenBtn');
const tokenLoginForm       = document.getElementById('tokenLoginForm');
const tokenBrowserSelect   = document.getElementById('tokenBrowserSelect');
const authTokenInput       = document.getElementById('authTokenInput');

if (openTokenModalBtn && tokenModal) {
  openTokenModalBtn.addEventListener('click', () => {
    tokenModal.classList.remove('hidden');
  });
}

function closeTokenModal() {
  if (tokenModal) tokenModal.classList.add('hidden');
}

if (closeTokenModalBtn) closeTokenModalBtn.addEventListener('click', closeTokenModal);
if (cancelTokenBtn) cancelTokenBtn.addEventListener('click', closeTokenModal);

if (tokenLoginForm) {
  tokenLoginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const targetId = tokenBrowserSelect ? tokenBrowserSelect.value : null;
    const token = authTokenInput.value.trim();

    if (!targetId && connectedClients.length > 0) {
      targetId = connectedClients[0].clientId;
    }

    if (!token || token.length < 15) {
      alert('Digite um token de autenticação válido (ex: 4935f4a94133184f1966f846d02acde31c87f39e).');
      return;
    }

    const payload = {
      type: 'DISPATCH_TOKEN_LOGIN',
      targetClientId: targetId,
      token: token
    };

    ws.send(JSON.stringify(payload));
    console.log('[Dashboard] Comando de login por token enviado:', payload);

    if (targetId) {
      clientProgressMap.set(targetId, {
        stepIndex: 0,
        label: 'Executando login por token (auth_token)...',
        stepStatus: 'running',
        error: null
      });
      renderExecutionMonitor();
    }

    closeTokenModal();
    authTokenInput.value = '';
    alert('Comando de login por token enviado! A página do Twitter no navegador será atualizada e a nova conta aparecerá logada no painel.');
  });
}

// ── Gerenciador de Contas (Screenshot 3 & Screenshot 2) ──────────────────────
const openAddAccountsModalBtn  = document.getElementById('openAddAccountsModalBtn');
const sidebarAddAccountsBtn    = document.getElementById('sidebarAddAccountsBtn');
const closeAddAccountsModalBtn = document.getElementById('closeAddAccountsModalBtn');
const cancelAddAccountsBtn     = document.getElementById('cancelAddAccountsBtn');
const addAccountsModal         = document.getElementById('addAccountsModal');
const addAccountsForm          = document.getElementById('addAccountsForm');
const bulkTokensInput          = document.getElementById('bulkTokensInput');
const submitAddAccountsBtn     = document.getElementById('submitAddAccountsBtn');

const metricTotal              = document.getElementById('metricTotal');
const metricValid              = document.getElementById('metricValid');
const metricInvalid            = document.getElementById('metricInvalid');
const accountsSearchInput      = document.getElementById('accountsSearchInput');
const accountsTableBody        = document.getElementById('accountsTableBody');

const validateAllAccountsBtn   = document.getElementById('validateAllAccountsBtn');
const exportAllTokensBtn       = document.getElementById('exportAllTokensBtn');
const exportAccountsHeaderBtn  = document.getElementById('exportAccountsHeaderBtn');
const removeInvalidAccountsBtn = document.getElementById('removeInvalidAccountsBtn');

let allSavedAccountsList = [];

async function loadAccountsManagerData() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    if (data.success) {
      allSavedAccountsList = data.accounts || [];
      updateAccountsMetrics(data.metrics);
      renderAccountsTable(allSavedAccountsList);
    }
  } catch (err) {
    console.error('Erro ao carregar contas:', err);
  }
}

function updateAccountsMetrics(metrics) {
  if (metricTotal) metricTotal.textContent = metrics?.total || 0;
  if (metricValid) metricValid.textContent = metrics?.valid || 0;
  if (metricInvalid) metricInvalid.textContent = metrics?.invalid || 0;
}

function renderAccountsTable(accounts) {
  if (!accountsTableBody) return;
  if (accounts.length === 0) {
    accountsTableBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 28px; color: var(--text-muted);">
          Nenhuma conta adicionada. Clique em "+ Adicionar" para colar os tokens (auth_token).
        </td>
      </tr>`;
    return;
  }

  accountsTableBody.innerHTML = accounts.map(acc => {
    const isProtected = acc.isProtected === true;
    const isMother = acc.isMother === true;
    const usernameDisplay = acc.username && acc.username !== 'Desconhecido' ? `@${acc.username}${isProtected ? ' 🔒' : ''}${isMother ? ' 👑' : ''}` : 'Token não validado';
    const avatarSrc = acc.avatar || '';
    const maskedToken = acc.token ? (acc.token.substring(0, 14) + '...') : '---';
    const isValid = acc.status === 'Válido';
    const followers = acc.followersCount || 0;
    const unlockHtml = isProtected
      ? `<span class="unlock-badge locked" style="background: rgba(239, 68, 68, 0.2); color: #f87171; padding: 4px 8px; border-radius: 6px; font-weight: bold;">🔒 Protegida</span>`
      : `<span class="unlock-badge unlocked" style="background: rgba(34, 197, 94, 0.2); color: #4ade80; padding: 4px 8px; border-radius: 6px; font-weight: bold;">🔓 Pública</span>`;

    return `
      <tr>
        <td>
          <div class="user-cell">
            ${avatarSrc ? `<img src="${avatarSrc}" alt="Avatar">` : `<div class="account-avatar">${usernameDisplay.substring(1, 3).toUpperCase()}</div>`}
            <span class="user-handle">${usernameDisplay}</span>
          </div>
        </td>
        <td>
          <div class="token-cell">
            <span>${maskedToken}</span>
            <button type="button" class="btn-copy-token" data-token="${acc.token}" title="Copiar Token">📋</button>
          </div>
        </td>
        <td>
          <span class="status-pill ${isValid ? 'valid' : 'invalid'}">
            ${isValid ? 'Válido' : 'Inválido'}
          </span>
        </td>
        <td>
          ${unlockHtml}
        </td>
        <td>
          <strong>${followers}</strong>
        </td>
        <td>
          <div class="action-btns-row">
            <button type="button" class="mother-toggle-btn ${isMother ? 'active' : ''}" data-id="${acc.id}" title="${isMother ? 'Remover como Conta Mãe' : 'Marcar como Conta Mãe (repost automático)'}">👑</button>
            ${isProtected ? `<button type="button" class="btn-icon-action unprotect-single" data-id="${acc.id}" data-token="${acc.token}" title="Tirar Proteção da Conta (Protect your posts)">🔓</button>` : ''}
            <button type="button" class="btn-icon-action validate-single" data-token="${acc.token}" title="Revalidar">🔄</button>
            <button type="button" class="btn-icon-action delete delete-single" data-id="${acc.id}" title="Excluir">🗑️</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  // Copiar Token
  document.querySelectorAll('.btn-copy-token').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.token);
      alert('Token copiado para a área de transferência!');
    });
  });

  // Marcar/Desmarcar Conta Mãe
  accountsTableBody.querySelectorAll('.mother-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMotherAccount(btn.dataset.id);
    });
  });

  // Tirar Proteção Única
  document.querySelectorAll('.unprotect-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const accId = btn.dataset.id || btn.dataset.token;
      if (confirm('Deseja desativar a opção "Protect your posts" para esta conta?')) {
        btn.textContent = '⏳';

        clientProgressMap.set(accId, {
          stepIndex: 0,
          label: 'Iniciando remoção de proteção...',
          stepStatus: 'running',
          error: null
        });
        renderExecutionMonitor();
        if (executionMonitor) executionMonitor.scrollIntoView({ behavior: 'smooth' });

        try {
          const res = await fetch('/api/accounts/unprotect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountIds: [accId] })
          });
          const data = await res.json();
          if (data.success) {
            alert('Proteção removida com sucesso!');
          } else {
            alert('Erro ao tirar proteção: ' + (data.error || 'Falha ao desativar'));
          }
        } catch (err) {
          alert('Erro de conexão: ' + err.message);
        } finally {
          loadAccountsManagerData();
        }
      }
    });
  });

  // Revalidar Único
  document.querySelectorAll('.validate-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.textContent = '⏳';
      await fetch('/api/accounts/add-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: [btn.dataset.token] })
      });
      loadAccountsManagerData();
    });
  });

  // Deletar Único
  document.querySelectorAll('.delete-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Tem certeza que deseja remover esta conta?')) {
        await fetch(`/api/accounts/${btn.dataset.id}`, { method: 'DELETE' });
        loadAccountsManagerData();
      }
    });
  });
}

// Filtro de Busca por @username ou token
if (accountsSearchInput) {
  accountsSearchInput.addEventListener('input', () => {
    const q = accountsSearchInput.value.toLowerCase().trim();
    if (!q) {
      renderAccountsTable(allSavedAccountsList);
      return;
    }
    const filtered = allSavedAccountsList.filter(a => 
      (a.username && a.username.toLowerCase().includes(q)) ||
      (a.token && a.token.toLowerCase().includes(q))
    );
    renderAccountsTable(filtered);
  });
}

// Abrir e Fechar Modal Adicionar Contas (Cole os tokens por linha)
function openAddModal() {
  if (addAccountsModal) addAccountsModal.classList.remove('hidden');
}
function closeAddModal() {
  if (addAccountsModal) addAccountsModal.classList.add('hidden');
}

if (openAddAccountsModalBtn) openAddAccountsModalBtn.addEventListener('click', openAddModal);
if (sidebarAddAccountsBtn) sidebarAddAccountsBtn.addEventListener('click', openAddModal);
if (openTokenModalBtn) openTokenModalBtn.addEventListener('click', openAddModal);
if (closeAddAccountsModalBtn) closeAddAccountsModalBtn.addEventListener('click', closeAddModal);
if (cancelAddAccountsBtn) cancelAddAccountsBtn.addEventListener('click', closeAddModal);

function parseInputTokens(inputText = '') {
  if (!inputText) return [];
  const lines = String(inputText).split(/[\r\n]+/);
  const extractedTokens = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Regra 1: Se contiver ':', pega os caracteres após o ÚLTIMO ':'
    if (line.includes(':')) {
      const parts = line.split(':');
      const lastPart = parts[parts.length - 1].trim();
      const hexMatch = lastPart.match(/([a-f0-9]{40})/i);
      if (hexMatch) {
        extractedTokens.push(hexMatch[1].toLowerCase());
        continue;
      }
    }

    // Regra 2: Procura por token hex de 40 caracteres em qualquer lugar da linha
    const generalHexMatch = line.match(/([a-f0-9]{40})/i);
    if (generalHexMatch) {
      extractedTokens.push(generalHexMatch[1].toLowerCase());
      continue;
    }

    // Regra 3: Token puro em texto
    const cleanToken = line.replace(/[^a-f0-9]/gi, '');
    if (cleanToken.length >= 32) {
      extractedTokens.push(cleanToken.toLowerCase());
    }
  }

  return Array.from(new Set(extractedTokens));
}

// Submit Adicionar Contas
if (addAccountsForm) {
  addAccountsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rawText = bulkTokensInput.value.trim();
    if (!rawText) return;

    const tokenArray = parseInputTokens(rawText);

    if (tokenArray.length === 0) {
      alert('Nenhum token válido encontrado no texto fornecido. Verifique se copiou a linha completa com os 40 caracteres do token ao final.');
      return;
    }

    submitAddAccountsBtn.disabled = true;
    submitAddAccountsBtn.textContent = `⏳ Validando e Adicionando ${tokenArray.length} conta(s)...`;

    try {
      const res = await fetch('/api/accounts/add-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: tokenArray })
      });
      const data = await res.json();
      if (data.success) {
        closeAddModal();
        bulkTokensInput.value = '';
        allSavedAccountsList = data.accounts;
        updateAccountsMetrics(data.metrics);
        renderAccountsTable(data.accounts);

        // Abre a aba de contas
        const accTabBtn = document.querySelector('[data-tab="accounts"]');
        if (accTabBtn) accTabBtn.click();
        alert(`✅ ${data.added} conta(s) processada(s) e validadas com sucesso!`);
      } else {
        alert('Erro ao adicionar contas: ' + data.error);
      }
    } catch (err) {
      alert('Falha na requisição: ' + err.message);
    } finally {
      submitAddAccountsBtn.disabled = false;
      submitAddAccountsBtn.textContent = '+ Adicionar e Validar Contas';
    }
  });
}

// Botão Tirar Proteção das Selecionadas
const unprotectSelectedAccountsBtn = document.getElementById('unprotectSelectedAccountsBtn');
if (unprotectSelectedAccountsBtn) {
  unprotectSelectedAccountsBtn.addEventListener('click', async () => {
    const selectedAccounts = Array.from(selectedClientIds);
    let targetIds = [];

    if (selectedAccounts.length > 0) {
      targetIds = selectedAccounts;
    } else if (allSavedAccountsList.length > 0) {
      targetIds = allSavedAccountsList.map(a => a.id);
    }

    if (targetIds.length === 0) {
      alert('Nenhuma conta cadastrada ou selecionada para desproteger.');
      return;
    }

    if (confirm(`Deseja desativar a opção "Protect your posts" para ${targetIds.length} conta(s)?`)) {
      unprotectSelectedAccountsBtn.disabled = true;
      unprotectSelectedAccountsBtn.textContent = '⏳ Desprotegendo...';
      try {
        const res = await fetch('/api/accounts/unprotect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountIds: targetIds })
        });
        const data = await res.json();
        if (data.success) {
          alert(`Proteção removida com sucesso de ${data.unprotected} conta(s)!`);
          allSavedAccountsList = data.accounts;
          updateAccountsMetrics(data.metrics);
          renderAccountsTable(data.accounts);
        } else {
          alert('Erro ao tirar proteção: ' + (data.error || 'Falha ao desativar'));
        }
      } catch (err) {
        alert('Erro de comunicação: ' + err.message);
      } finally {
        unprotectSelectedAccountsBtn.disabled = false;
        unprotectSelectedAccountsBtn.textContent = '🔓 Tirar Proteção';
      }
    }
  });
}

// Botão Validar Todas
if (validateAllAccountsBtn) {
  validateAllAccountsBtn.addEventListener('click', async () => {
    validateAllAccountsBtn.disabled = true;
    validateAllAccountsBtn.textContent = '⏳ Validando...';
    try {
      const res = await fetch('/api/accounts/validate-all', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        allSavedAccountsList = data.accounts;
        updateAccountsMetrics(data.metrics);
        renderAccountsTable(data.accounts);
      }
    } catch (err) {
      alert('Erro ao revalidar: ' + err.message);
    } finally {
      validateAllAccountsBtn.disabled = false;
      validateAllAccountsBtn.textContent = '🔄 Validar Todas';
    }
  });
}

// Botão Remover Inválidas
if (removeInvalidAccountsBtn) {
  removeInvalidAccountsBtn.addEventListener('click', async () => {
    if (!confirm('Deseja remover todas as contas marcadas como inválidas?')) return;
    try {
      const res = await fetch('/api/accounts/remove-invalid', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        allSavedAccountsList = data.accounts;
        updateAccountsMetrics(data.metrics);
        renderAccountsTable(data.accounts);
      }
    } catch (err) {
      alert('Erro ao remover inválidas: ' + err.message);
    }
  });
}

// Exportar Tokens em TXT
function exportTokens() {
  if (allSavedAccountsList.length === 0) {
    alert('Nenhuma conta cadastrada para exportar.');
    return;
  }
  const txt = allSavedAccountsList.map(a => a.token).join('\n');
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `twitter_tokens_${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

if (exportAllTokensBtn) exportAllTokensBtn.addEventListener('click', exportTokens);
if (exportAccountsHeaderBtn) exportAccountsHeaderBtn.addEventListener('click', exportTokens);

window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  loadAccountsManagerData();
});
