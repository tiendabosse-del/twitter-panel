/**
 * sidepanel.js v4.1 – Twitter Auto Poster
 * Suporte: múltiplos arquivos (até 4), colar imagem (Ctrl+V),
 *          10 etapas com fixar e restringir respostas pós-publicação.
 */

const STEPS = [
  { id: 'composer', label: 'Abrindo compositor'    }, // 0
  { id: 'text',     label: 'Digitando texto'        }, // 1
  { id: 'media',    label: 'Enviando mídia'         }, // 2
  { id: 'publish',  label: 'Publicando'             }, // 3
  { id: 'open',     label: 'Abrindo publicação'     }, // 4
  { id: 'comment',  label: 'Comentando'             }, // 5
  { id: 'repost',   label: 'Dando repost'           }, // 6
  { id: 'pin',      label: 'Fixando publicação'     }, // 7
  { id: 'restrict', label: 'Restringindo respostas' }, // 8
];

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── IndexedDB para mídias agendadas (sem limite de tamanho) ──────────────────
function openMediaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('TAPMediaDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('media', { keyPath: 'id' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
async function saveMediaToIDB(id, files) {
  const db = await openMediaDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put({ id, files });
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
async function deleteMediaFromIDB(id) {
  if (!id) return;
  const db = await openMediaDB();
  return new Promise(resolve => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// Lê mídia do IDB (espelho da função do background.js para uso no sidepanel)
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

// Converte dataUrl → Blob (para recriar objectUrl ao restaurar mídia)
function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bin = atob(data);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Chave fixa para o rascunho de mídia do formulário
const DRAFT_MEDIA_KEY = 'media_draft_form';

// Persiste a lista atual de mídias no IDB como rascunho
function saveDraftMedia() {
  const toSave = mediaFiles
    .filter(f => f.dataUrl)
    .map(f => ({ dataUrl: f.dataUrl, type: f.type, name: f.name }));
  if (toSave.length > 0) {
    saveMediaToIDB(DRAFT_MEDIA_KEY, toSave).catch(() => {});
  } else {
    deleteMediaFromIDB(DRAFT_MEDIA_KEY).catch(() => {});
  }
}

let uiState = 'idle';
let stepsStatus = STEPS.map(() => 'pending');

// Array de arquivos de mídia: [{dataUrl, type, name, objectUrl}]
let mediaFiles = [];

// ── Elementos ────────────────────────────────────────────────────────────────
const tweetText       = document.getElementById('tweetText');
const charCount       = document.getElementById('charCount');
const mediaFileInput  = document.getElementById('mediaFile');
const fileDrop        = document.getElementById('fileDrop');
const filePrompt      = document.getElementById('filePrompt');
const mediaPreview    = document.getElementById('mediaPreview');
const clearMedia      = document.getElementById('clearMedia');
const replyOption     = document.getElementById('replyOption');
const commentText     = document.getElementById('commentText');
const doRepost        = document.getElementById('doRepost');
const doPin           = document.getElementById('doPin');
const startBtn        = document.getElementById('startBtn');
const formSection     = document.getElementById('formSection');
const progressSection = document.getElementById('progressSection');
const stepsList       = document.getElementById('stepsList');
const pauseBtn        = document.getElementById('pauseBtn');
const pauseIcon       = document.getElementById('pauseIcon');
const resumeIcon      = document.getElementById('resumeIcon');
const pauseLabel      = document.getElementById('pauseLabel');
const cancelBtn       = document.getElementById('cancelBtn');
const newPostBtn      = document.getElementById('newPostBtn');
const errorBox        = document.getElementById('errorBox');
const activeAccountChip = document.getElementById('activeAccountChip');
const chipAvatar      = document.getElementById('chipAvatar');
const chipName        = document.getElementById('chipName');

// ── Abas ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});

// ── Autosave do rascunho ──────────────────────────────────────────────────────
let _saveTimer = null;
function autoSaveForm() {
  chrome.storage.local.set({
    form_draft: {
      text:    tweetText.value,
      comment: commentText.value,
      reply:   replyOption.value,
      repost:  doRepost.checked,
      pin:     doPin.checked,
    }
  }).catch(() => {});
}
function debouncedSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(autoSaveForm, 600);
}

// ── Contador de caracteres ────────────────────────────────────────────────────
tweetText.addEventListener('input', () => {
  const n = tweetText.value.length;
  charCount.textContent = n;
  charCount.style.color = n > 260 ? '#f4212e' : '#71767b';
  debouncedSave();
});

// ════════════════════════════════════════════════════════════════════════════
//  GERENCIAMENTO DE MÚLTIPLAS MÍDIAS
// ════════════════════════════════════════════════════════════════════════════

function renderMediaGrid() {
  if (mediaFiles.length === 0) {
    filePrompt.classList.remove('hidden');
    mediaPreview.classList.add('hidden');
    mediaPreview.innerHTML = '';
    clearMedia.classList.add('hidden');
    return;
  }

  filePrompt.classList.add('hidden');
  mediaPreview.classList.remove('hidden');
  clearMedia.classList.remove('hidden');

  const thumbs = mediaFiles.map((f, i) => {
    const isVideo = f.type.startsWith('video/');
    return `
      <div class="media-thumb">
        ${isVideo
          ? `<video src="${f.objectUrl}" muted playsinline></video>`
          : `<img src="${f.objectUrl}" alt="${escHtml(f.name)}" />`}
        <button class="thumb-remove" data-index="${i}" title="Remover">✕</button>
        <span class="thumb-label">${isVideo ? '🎬' : '🖼'} ${escHtml(f.name.length > 14 ? f.name.substring(0,12)+'…' : f.name)}</span>
      </div>`;
  }).join('');

  const addMore = mediaFiles.length < 4
    ? `<label class="thumb-add" title="Adicionar mais">
         <input type="file" class="extra-file-input" accept="image/*,video/*" multiple />
         <span>+</span>
       </label>`
    : '';

  mediaPreview.innerHTML = `<div class="media-grid">${thumbs}${addMore}</div>`;

  // Botões de remover
  mediaPreview.querySelectorAll('.thumb-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      if (mediaFiles[idx]?.objectUrl) URL.revokeObjectURL(mediaFiles[idx].objectUrl);
      mediaFiles.splice(idx, 1);
      renderMediaGrid();
      saveDraftMedia(); // atualiza IDB ao remover arquivo individual
    });
  });

  // Input "adicionar mais"
  const extraInput = mediaPreview.querySelector('.extra-file-input');
  if (extraInput) {
    extraInput.addEventListener('change', () => handleFileList(extraInput.files));
  }
}

function handleFileList(fileList) {
  if (!fileList || fileList.length === 0) return;
  const remaining = 4 - mediaFiles.length;
  const toAdd = Array.from(fileList).slice(0, remaining);

  for (const file of toAdd) {
    if (file.size > 512 * 1024 * 1024) {
      alert(`"${file.name}" é muito grande (máx. 512 MB).`);
      continue;
    }
    const objectUrl = URL.createObjectURL(file);
    const reader = new FileReader();
    reader.onload = e => {
      mediaFiles.push({ dataUrl: e.target.result, type: file.type, name: file.name, objectUrl });
      renderMediaGrid();
      saveDraftMedia(); // persiste no IDB para sobreviver ao fechamento da extensão
    };
    reader.readAsDataURL(file);
  }
}

// Input principal de arquivo
mediaFileInput.addEventListener('change', () => {
  handleFileList(mediaFileInput.files);
  mediaFileInput.value = ''; // permite re-selecionar o mesmo arquivo
});

// Clique na área de drop abre o seletor
fileDrop.addEventListener('click', e => {
  if (e.target.closest('.thumb-remove') || e.target.closest('.thumb-add') || e.target.closest('.extra-file-input')) return;
  if (mediaFiles.length < 4) mediaFileInput.click();
});

// Drag & Drop
fileDrop.addEventListener('dragover', e => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  handleFileList(e.dataTransfer.files);
});

// ── Colar imagem (Ctrl+V) ────────────────────────────────────────────────────
document.addEventListener('paste', e => {
  if (mediaFiles.length >= 4) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [...items].filter(it => it.type.startsWith('image/'));
  if (imageItems.length === 0) return;
  e.preventDefault();
  const files = imageItems.map(it => it.getAsFile()).filter(Boolean);
  handleFileList(files);
});

// Remover todas as mídias
clearMedia.addEventListener('click', () => {
  mediaFiles.forEach(f => { if (f.objectUrl) URL.revokeObjectURL(f.objectUrl); });
  mediaFiles = [];
  mediaFileInput.value = '';
  renderMediaGrid();
  deleteMediaFromIDB(DRAFT_MEDIA_KEY).catch(() => {}); // remove rascunho do IDB
});

// ════════════════════════════════════════════════════════════════════════════
//  PROGRESSO
// ════════════════════════════════════════════════════════════════════════════

function renderSteps() {
  stepsList.innerHTML = '';
  STEPS.forEach((step, i) => {
    const st  = stepsStatus[i];
    const div = document.createElement('div');
    div.className = 'step ' + st;

    const ico = document.createElement('div');
    ico.className = 'step-icon';
    if (st === 'active') {
      const s = document.createElement('div'); s.className = 'spin'; ico.appendChild(s);
    } else if (st === 'done')  ico.textContent = '✓';
    else if (st === 'error')   ico.textContent = '✗';

    const lbl = document.createElement('span');
    lbl.className = 'step-label';
    // Usa label dinâmica se vier na mensagem
    lbl.textContent = step.label;

    div.appendChild(ico); div.appendChild(lbl);
    stepsList.appendChild(div);
  });
}

function showProgress() {
  formSection.classList.add('hidden');
  progressSection.classList.remove('hidden');
  newPostBtn.classList.add('hidden');
  errorBox.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  cancelBtn.classList.remove('hidden');
  renderSteps();
}

function showForm() {
  formSection.classList.remove('hidden');
  progressSection.classList.add('hidden');
  stepsStatus = STEPS.map(() => 'pending');
}

function setPauseUI(paused) {
  if (paused) {
    pauseIcon.classList.add('hidden'); resumeIcon.classList.remove('hidden');
    pauseLabel.textContent = 'Retomar';
  } else {
    pauseIcon.classList.remove('hidden'); resumeIcon.classList.add('hidden');
    pauseLabel.textContent = 'Pausar';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  INICIAR / PAUSAR / CANCELAR
// ════════════════════════════════════════════════════════════════════════════

startBtn.addEventListener('click', async () => {
  const text    = tweetText.value.trim();
  const comment = commentText.value.trim();
  const reply   = replyOption.value;
  const repost  = doRepost.checked;
  const pin     = doPin.checked;

  if (!text && mediaFiles.length === 0) {
    alert('Escreva algo ou selecione uma mídia antes de iniciar.');
    return;
  }

  uiState = 'running';
  stepsStatus = STEPS.map(() => 'pending');
  showProgress(); setPauseUI(false);

  // Remove objectUrl antes de enviar (não serializável)
  const filesToSend = mediaFiles.map(f => ({ dataUrl: f.dataUrl, type: f.type, name: f.name }));

  chrome.runtime.sendMessage({
    action: 'POST_TWEET',
    payload: { text, comment, reply, repost, pin, mediaFiles: filesToSend },
  }).catch(err => {
    uiState = 'error';
    errorBox.textContent = '⚠ ' + err.message;
    errorBox.classList.remove('hidden');
    pauseBtn.classList.add('hidden'); cancelBtn.classList.add('hidden');
    newPostBtn.classList.remove('hidden');
  });
});

pauseBtn.addEventListener('click', () => {
  if (uiState === 'running') {
    uiState = 'paused'; setPauseUI(true);
    chrome.runtime.sendMessage({ action: 'PAUSE' }).catch(() => {});
  } else if (uiState === 'paused') {
    uiState = 'running'; setPauseUI(false);
    chrome.runtime.sendMessage({ action: 'RESUME' }).catch(() => {});
  }
});

cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'CANCEL' }).catch(() => {});
  uiState = 'idle'; showForm();
});

newPostBtn.addEventListener('click', () => { uiState = 'idle'; showForm(); });

// ════════════════════════════════════════════════════════════════════════════
//  MENSAGENS DO CONTENT SCRIPT
// ════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'LOGIN_STATUS') {
    showLoginStatus(msg.message, msg.type || 'info');
    return;
  }
  if (msg.action === 'STEP_UPDATE') {
    stepsStatus[msg.index] = msg.status;
    // Atualiza label dinâmica se vier
    if (msg.label) STEPS[msg.index].label = msg.label;
    renderSteps();
    return;
  }
  if (msg.action === 'FLOW_DONE') {
    stepsStatus = stepsStatus.map(s => (s === 'active' || s === 'pending') ? 'done' : s);
    renderSteps(); uiState = 'done';
    pauseBtn.classList.add('hidden'); cancelBtn.classList.add('hidden');
    newPostBtn.classList.remove('hidden'); return;
  }
  if (msg.action === 'FLOW_CANCELLED') { uiState = 'idle'; showForm(); return; }
  if (msg.action === 'FLOW_ERROR') {
    const i = stepsStatus.findIndex(s => s === 'active');
    if (i >= 0) stepsStatus[i] = 'error';
    renderSteps();
    errorBox.textContent = '⚠ ' + (msg.error || 'Erro desconhecido');
    errorBox.classList.remove('hidden');
    uiState = 'error';
    pauseBtn.classList.add('hidden'); cancelBtn.classList.add('hidden');
    newPostBtn.classList.remove('hidden'); return;
  }
  if (msg.action === 'PAUSED')  { uiState = 'paused';  setPauseUI(true);  return; }
  if (msg.action === 'RESUMED') { uiState = 'running'; setPauseUI(false); return; }
});

// ── Restaura estado ao reabrir o painel ──────────────────────────────────────
(async () => {
  try {
    const data = await chrome.storage.session.get(['tw_running', 'tw_step', 'tw_paused']);
    if (data.tw_running) {
      stepsStatus = STEPS.map((_, i) =>
        i < data.tw_step ? 'done' : i === data.tw_step ? 'active' : 'pending');
      uiState = data.tw_paused ? 'paused' : 'running';
      showProgress(); setPauseUI(!!data.tw_paused);
    }
  } catch (_) {}
  await loadAccounts();

  // ── Restaura rascunho do formulário ────────────────────────────────────────
  try {
    const saved = await chrome.storage.local.get('form_draft');
    if (saved.form_draft) {
      const d = saved.form_draft;
      if (d.text)    { tweetText.value = d.text; charCount.textContent = d.text.length; }
      if (d.comment) commentText.value = d.comment;
      if (d.reply)   replyOption.value = d.reply;
      if (typeof d.repost === 'boolean') doRepost.checked = d.repost;
      if (typeof d.pin    === 'boolean') doPin.checked    = d.pin;
    }
  } catch (_) {}

  // ── Restaura mídia do rascunho salvo no IDB ────────────────────────────────
  try {
    const draftFiles = await getMediaFromIDB(DRAFT_MEDIA_KEY);
    if (draftFiles && draftFiles.length > 0) {
      for (const f of draftFiles) {
        const blob      = dataUrlToBlob(f.dataUrl);
        const objectUrl = URL.createObjectURL(blob);
        mediaFiles.push({ dataUrl: f.dataUrl, type: f.type, name: f.name, objectUrl });
      }
      renderMediaGrid();
    }
  } catch (_) {}
})();

// ════════════════════════════════════════════════════════════════════════════
//  CONTAS
// ════════════════════════════════════════════════════════════════════════════

const detectBtn    = document.getElementById('detectBtn');
const accountsList = document.getElementById('accountsList');
const accountToast = document.getElementById('accountToast');
let toastTimer = null;

function showToast(msg, type = 'info') {
  accountToast.textContent = msg;
  accountToast.className = `toast ${type}`;
  accountToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => accountToast.classList.add('hidden'), 3000);
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadAccounts() {
  const data = await chrome.storage.local.get(['accounts', 'selectedAccount']);
  const accounts = data.accounts || [];
  const sel = data.selectedAccount || null;
  renderAccounts(accounts, sel);
  updateHeaderChip(accounts, sel);
}

function updateHeaderChip(accounts, sel) {
  if (!sel) { activeAccountChip.classList.add('hidden'); return; }
  const acc = accounts.find(a => a.username === sel);
  if (!acc) { activeAccountChip.classList.add('hidden'); return; }
  activeAccountChip.classList.remove('hidden');
  chipName.textContent = '@' + acc.username;
  if (acc.avatar) { chipAvatar.src = acc.avatar; chipAvatar.style.display = 'block'; }
  else chipAvatar.style.display = 'none';
}

function renderAccounts(accounts, selected) {
  if (!accounts.length) {
    accountsList.innerHTML = '<p style="font-size:12px;color:#71767b;text-align:center;padding:16px 0;">Nenhuma conta adicionada ainda.</p>';
    return;
  }
  accountsList.innerHTML = '';
  accounts.forEach(acc => {
    const isActive = acc.username === selected;
    const card = document.createElement('div');
    card.className = 'account-card' + (isActive ? ' selected' : '');

    if (acc.avatar) {
      const img = document.createElement('img');
      img.className = 'acc-avatar'; img.src = acc.avatar; img.alt = acc.username;
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'acc-avatar-placeholder';
      ph.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
      card.appendChild(ph);
    }

    const info = document.createElement('div');
    info.className = 'acc-info';
    info.innerHTML = `
      <div class="acc-name">${escHtml(acc.displayName || acc.username)}${isActive ? '<span class="acc-badge">Ativa</span>' : ''}</div>
      <div class="acc-handle">@${escHtml(acc.username)}</div>`;
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'acc-actions';
    if (!isActive) {
      const useBtn = document.createElement('button');
      useBtn.className = 'btn-sm use'; useBtn.textContent = 'Usar';
      useBtn.addEventListener('click', () => setActiveAccount(acc.username));
      actions.appendChild(useBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-sm del'; delBtn.textContent = '✕';
    delBtn.addEventListener('click', () => deleteAccount(acc.username));
    actions.appendChild(delBtn);
    card.appendChild(actions);
    accountsList.appendChild(card);
  });
}

async function setActiveAccount(username) {
  await chrome.storage.local.set({ selectedAccount: username });
  showToast('Conta @' + username + ' selecionada.', 'success');
  await loadAccounts();
}

async function deleteAccount(username) {
  const data = await chrome.storage.local.get(['accounts', 'selectedAccount']);
  const accounts = (data.accounts || []).filter(a => a.username !== username);
  const updates = { accounts };
  if (data.selectedAccount === username) updates.selectedAccount = null;
  await chrome.storage.local.set(updates);
  showToast('Conta @' + username + ' removida.', 'info');
  await loadAccounts();
}

// ════════════════════════════════════════════════════════════════════════════
//  LOGIN COM NOVA CONTA
// ════════════════════════════════════════════════════════════════════════════

const toggleLoginBtn = document.getElementById('toggleLoginBtn');
const loginForm      = document.getElementById('loginForm');
const loginUserEl    = document.getElementById('loginUser');
const loginPassEl    = document.getElementById('loginPass');
const login2FAEl     = document.getElementById('login2FA');
const loginBtn       = document.getElementById('loginBtn');
const loginStatusBox = document.getElementById('loginStatusBox');

function showLoginStatus(msg, type = 'info') {
  loginStatusBox.textContent = msg;
  loginStatusBox.className = `toast ${type}`;
  loginStatusBox.classList.remove('hidden');
}

toggleLoginBtn.addEventListener('click', () => {
  const isOpen = !loginForm.classList.contains('hidden');
  loginForm.classList.toggle('hidden');
  toggleLoginBtn.innerHTML = isOpen
    ? `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg> Entrar agora`
    : `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> Cancelar`;
});

loginBtn.addEventListener('click', async () => {
  const username    = loginUserEl.value.trim();
  const password    = loginPassEl.value;
  const twoFASecret = login2FAEl.value.trim();

  if (!username || !password) {
    showLoginStatus('Informe usuário e senha.', 'error');
    return;
  }

  loginBtn.disabled = true;
  showLoginStatus('Abrindo X.com e iniciando login…', 'info');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'LOGIN_TWITTER',
      payload: { username, password, twoFASecret },
    });

    if (result?.error) {
      showLoginStatus('Erro: ' + result.error, 'error');
    } else {
      showLoginStatus('✓ Login concluído! Detectando conta…', 'success');
      loginPassEl.value = '';
      await delay(2000);
      loginForm.classList.add('hidden');
      toggleLoginBtn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/></svg> Entrar agora`;
      detectBtn.click(); // detecta e salva a conta automaticamente
    }
  } catch (err) {
    showLoginStatus('Erro: ' + err.message, 'error');
  } finally {
    loginBtn.disabled = false;
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  AGENDAMENTO
// ════════════════════════════════════════════════════════════════════════════

const doScheduleChk  = document.getElementById('doSchedule');
const scheduleSection= document.getElementById('scheduleSection');
const scheduleTimeEl = document.getElementById('scheduleTime');
const scheduleBtn    = document.getElementById('scheduleBtn');
const scheduledList  = document.getElementById('scheduledList');

// Define o mínimo como "agora + 1 min" quando abrir
function updateMinScheduleTime() {
  const now = new Date(Date.now() + 60000);
  const pad = n => String(n).padStart(2,'0');
  scheduleTimeEl.min = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

commentText.addEventListener('input', debouncedSave);
replyOption.addEventListener('change', autoSaveForm);
doRepost.addEventListener('change', autoSaveForm);
doPin.addEventListener('change', autoSaveForm);

doScheduleChk.addEventListener('change', () => {
  if (doScheduleChk.checked) {
    scheduleSection.classList.remove('hidden');
    updateMinScheduleTime();
  } else {
    scheduleSection.classList.add('hidden');
  }
});

scheduleBtn.addEventListener('click', async () => {
  const text    = tweetText.value.trim();
  const comment = commentText.value.trim();
  const reply   = replyOption.value;
  const repost  = doRepost.checked;
  const pin     = doPin.checked;
  const timeVal = scheduleTimeEl.value;

  if (!text && mediaFiles.length === 0) {
    alert('Escreva algo ou selecione uma mídia antes de agendar.'); return;
  }
  if (!timeVal) {
    alert('Escolha uma data e horário para o agendamento.'); return;
  }
  const scheduledAt = new Date(timeVal).getTime();
  if (scheduledAt <= Date.now() + 30000) {
    alert('Escolha um horário com pelo menos 1 minuto no futuro.'); return;
  }

  const alarmName = 'scheduled_post_' + scheduledAt + '_' + Math.random().toString(36).slice(2,7);
  const filesToSend = mediaFiles.map(f => ({ dataUrl: f.dataUrl, type: f.type, name: f.name }));

  // Salva mídias no IndexedDB para não ocupar o limite do storage.local
  let mediaKey = null;
  if (filesToSend.length > 0) {
    mediaKey = 'media_' + alarmName;
    await saveMediaToIDB(mediaKey, filesToSend);
  }

  // Apenas metadados leves ficam no storage.local (sem os dataUrls)
  const postData = { text, comment, reply, repost, pin, mediaKey, mediaCount: filesToSend.length, scheduledAt };

  // Salva no storage e cria alarme
  const data = await chrome.storage.local.get('scheduled_posts');
  const posts = data.scheduled_posts || {};
  posts[alarmName] = postData;
  await chrome.storage.local.set({ scheduled_posts: posts });
  await chrome.runtime.sendMessage({ action: 'CREATE_ALARM', alarmName, scheduledAt });

  alert(`✓ Agendado para ${new Date(scheduledAt).toLocaleString('pt-BR')}`);
  scheduleTimeEl.value = '';
  await renderScheduledList();
});

async function renderScheduledList() {
  const data = await chrome.storage.local.get('scheduled_posts');
  const posts = data.scheduled_posts || {};
  const entries = Object.entries(posts).sort((a,b) => a[1].scheduledAt - b[1].scheduledAt);

  const wrapper = document.getElementById('scheduledListWrapper');
  const countBadge = document.getElementById('scheduledCount');

  if (entries.length === 0) {
    scheduledList.innerHTML = '';
    wrapper.classList.add('hidden');
    return;
  }

  wrapper.classList.remove('hidden');
  countBadge.textContent = entries.length;

  const REPLY_LABELS = {
    everyone:  'Todos',
    verified:  'Verificados',
    following: 'Seguindo',
    mentioned: 'Mencionados',
  };

  scheduledList.innerHTML = entries.map(([key, post]) => {
    const d = new Date(post.scheduledAt);
    const dateStr = d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    const preview = post.text ? post.text.slice(0, 80) + (post.text.length > 80 ? '…' : '') : '(sem texto)';
    const hasMedia = (post.mediaCount && post.mediaCount > 0) || (post.mediaFiles && post.mediaFiles.length > 0);
    const mediaCount = post.mediaCount || (post.mediaFiles ? post.mediaFiles.length : 0);
    const replyLabel = REPLY_LABELS[post.reply] || '';
    const safeKey = escHtml(key);

    const badges = [
      hasMedia ? `<span class="scheduled-item-badge media">📎 ${mediaCount} mídia${mediaCount > 1 ? 's' : ''}</span>` : '',
      post.comment ? `<span class="scheduled-item-badge">💬 comentário</span>` : '',
      post.repost  ? `<span class="scheduled-item-badge">🔁 repost</span>` : '',
      post.pin     ? `<span class="scheduled-item-badge">📌 fixar</span>` : '',
      replyLabel   ? `<span class="scheduled-item-badge">🔒 ${replyLabel}</span>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="scheduled-item">
        <div class="scheduled-item-bar"></div>
        <div class="scheduled-item-body">
          <div class="scheduled-item-time">
            <svg viewBox="0 0 24 24"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>
            ${dateStr} às ${timeStr}
          </div>
          <div class="scheduled-item-text">${escHtml(preview)}</div>
          ${badges ? `<div class="scheduled-item-meta">${badges}</div>` : ''}
        </div>
        <button class="scheduled-item-del" data-key="${safeKey}" title="Cancelar agendamento">✕</button>
      </div>`;
  }).join('');

  scheduledList.querySelectorAll('.scheduled-item-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      const d = await chrome.storage.local.get('scheduled_posts');
      const p = d.scheduled_posts || {};
      // Remove mídias do IndexedDB se existirem
      if (p[key]?.mediaKey) await deleteMediaFromIDB(p[key].mediaKey);
      delete p[key];
      await chrome.storage.local.set({ scheduled_posts: p });
      await chrome.runtime.sendMessage({ action: 'CANCEL_ALARM', alarmName: key }).catch(() => {});
      await renderScheduledList();
    });
  });
}

// Carrega lista de agendados ao iniciar
renderScheduledList();

// ════════════════════════════════════════════════════════════════════════════
//  ABA PERFIL
// ════════════════════════════════════════════════════════════════════════════

const toggleProfileFormBtn = document.getElementById('toggleProfileFormBtn');
const profileForm          = document.getElementById('profileForm');
const profileBio           = document.getElementById('profileBio');
const profileSite          = document.getElementById('profileSite');
const editProfileBtn       = document.getElementById('editProfileBtn');
const profileStatusBox     = document.getElementById('profileStatusBox');

const avatarPreviewWrap        = document.getElementById('avatarPreviewWrap');
const avatarPreviewImg         = document.getElementById('avatarPreviewImg');
const avatarPreviewPlaceholder = document.getElementById('avatarPreviewPlaceholder');
const avatarPickBtn            = document.getElementById('avatarPickBtn');
const avatarClearBtn           = document.getElementById('avatarClearBtn');
const avatarFileInput          = document.getElementById('avatarFileInput');

const bannerPreviewWrap        = document.getElementById('bannerPreviewWrap');
const bannerPreviewImg         = document.getElementById('bannerPreviewImg');
const bannerPreviewPlaceholder = document.getElementById('bannerPreviewPlaceholder');
const bannerPickBtn            = document.getElementById('bannerPickBtn');
const bannerClearBtn           = document.getElementById('bannerClearBtn');
const bannerFileInput          = document.getElementById('bannerFileInput');

let selectedAvatar = null; // { dataUrl, type, name }
let selectedBanner = null; // { dataUrl, type, name }

function showProfileStatus(msg, type = 'info') {
  profileStatusBox.textContent = msg;
  profileStatusBox.className = `toast ${type}`;
  profileStatusBox.classList.remove('hidden');
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve({ dataUrl: e.target.result, type: file.type, name: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

avatarPickBtn.addEventListener('click', () => avatarFileInput.click());
avatarFileInput.addEventListener('change', async () => {
  const file = avatarFileInput.files?.[0];
  if (!file) return;
  selectedAvatar = await readImageFile(file);
  avatarPreviewImg.src = selectedAvatar.dataUrl;
  avatarPreviewImg.classList.remove('hidden');
  avatarPreviewPlaceholder.classList.add('hidden');
  avatarClearBtn.classList.remove('hidden');
  avatarFileInput.value = '';
});
avatarClearBtn.addEventListener('click', () => {
  selectedAvatar = null;
  avatarPreviewImg.classList.add('hidden');
  avatarPreviewImg.src = '';
  avatarPreviewPlaceholder.classList.remove('hidden');
  avatarClearBtn.classList.add('hidden');
});

bannerPickBtn.addEventListener('click', () => bannerFileInput.click());
bannerFileInput.addEventListener('change', async () => {
  const file = bannerFileInput.files?.[0];
  if (!file) return;
  selectedBanner = await readImageFile(file);
  bannerPreviewImg.src = selectedBanner.dataUrl;
  bannerPreviewImg.classList.remove('hidden');
  bannerPreviewPlaceholder.classList.add('hidden');
  bannerClearBtn.classList.remove('hidden');
  bannerFileInput.value = '';
});
bannerClearBtn.addEventListener('click', () => {
  selectedBanner = null;
  bannerPreviewImg.classList.add('hidden');
  bannerPreviewImg.src = '';
  bannerPreviewPlaceholder.classList.remove('hidden');
  bannerClearBtn.classList.add('hidden');
});

toggleProfileFormBtn.addEventListener('click', () => {
  const isOpen = !profileForm.classList.contains('hidden');
  profileForm.classList.toggle('hidden');
  toggleProfileFormBtn.innerHTML = isOpen
    ? `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg> Editar perfil`
    : `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg> Fechar`;
});

editProfileBtn.addEventListener('click', async () => {
  const bio      = profileBio.value.trim();
  const siteLink = profileSite.value.trim();

  if (!bio && !siteLink && !selectedAvatar && !selectedBanner) {
    showProfileStatus('Escolha uma foto/banner ou preencha a bio/site.', 'error'); return;
  }

  editProfileBtn.disabled = true;
  showProfileStatus('Iniciando edição do perfil…', 'info');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'EDIT_PROFILE',
      payload: { bio, siteLink, avatar: selectedAvatar, banner: selectedBanner },
    });
    if (result?.error) {
      showProfileStatus('Erro: ' + result.error, 'error');
    } else {
      showProfileStatus('✓ Perfil atualizado com sucesso!', 'success');
    }
  } catch (err) {
    showProfileStatus('Erro: ' + err.message, 'error');
  } finally {
    editProfileBtn.disabled = false;
  }
});

// Também recebe status de perfil via mensagem
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PROFILE_STATUS') {
    showProfileStatus(msg.message, msg.type || 'info');
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ABA AGENTE IA
// ════════════════════════════════════════════════════════════════════════════

const agentInput     = document.getElementById('agentInput');
const agentSendBtn   = document.getElementById('agentSendBtn');
const agentMessages  = document.getElementById('agentMessages');
const agentNodetect  = document.getElementById('agentNodetect');

// Salva/restaura estado do nodetect
chrome.storage.local.get('agent_nodetect').then(d => {
  if (typeof d.agent_nodetect === 'boolean') agentNodetect.checked = d.agent_nodetect;
}).catch(() => {});
agentNodetect.addEventListener('change', () => {
  chrome.storage.local.set({ agent_nodetect: agentNodetect.checked }).catch(() => {});
});

function addAgentMsg(text, type = 'bot') {
  const div = document.createElement('div');
  div.className = 'agent-message ' + type;
  div.textContent = text;
  agentMessages.appendChild(div);
  agentMessages.scrollTop = agentMessages.scrollHeight;
}

/**
 * Extrai intervalo e range de horário de um comando em português.
 * Suporta formatos como:
 *   "de 5 em 5 minutos das 21:00 até as 22:00"
 *   "a cada 10 minutos das 20h às 21h30"
 *   "5 em 5 min de 21:00 a 22:00"
 */
function parseAgentCommand(raw) {
  // Normaliza: "21h" → "21:00",  "21h30" → "21:30"
  const t = raw.toLowerCase()
    .replace(/(\d{1,2})h(\d{2})/g, '$1:$2')
    .replace(/(\d{1,2})h(?!\d)/g, '$1:00');

  // ── Intervalo ──────────────────────────────────────────────────────────────
  let interval = null;
  const intMatch =
    t.match(/de\s+(\d+)\s+em\s+\d+\s+minuto/i)  ||  // "de 5 em 5 minutos"
    t.match(/(\d+)\s+em\s+\d+\s+min/i)           ||  // "5 em 5 min"
    t.match(/a\s*cada\s*(\d+)\s*min/i)           ||  // "a cada 5 min"
    t.match(/cada\s*(\d+)\s*min/i)               ||  // "cada 5 min"
    t.match(/intervalo\s*(?:de\s*)?(\d+)\s*min/i);   // "intervalo de 5 min"
  if (intMatch) interval = parseInt(intMatch[1]);

  // ── Range de horário ───────────────────────────────────────────────────────
  // Aceita: "das 21:00 até as 22:00" / "de 21:00 a 22:00" / "21:00 até 22:00"
  const rangeMatch =
    t.match(/das?\s*(\d{1,2}):(\d{2})\s*(?:horas?\s*)?(?:até|ate|a)\s*(?:as?\s*)?(\d{1,2}):(\d{2})/i) ||
    t.match(/de\s*(\d{1,2}):(\d{2})\s*(?:horas?\s*)?(?:até|ate|a)\s*(?:as?\s*)?(\d{1,2}):(\d{2})/i)   ||
    t.match(/(\d{1,2}):(\d{2})\s*(?:até|ate|a)\s*(\d{1,2}):(\d{2})/i);

  let startTime = null, endTime = null;
  if (rangeMatch) {
    startTime = { h: parseInt(rangeMatch[1]), m: parseInt(rangeMatch[2]) };
    endTime   = { h: parseInt(rangeMatch[3]), m: parseInt(rangeMatch[4]) };
  }

  return { interval, startTime, endTime };
}

agentSendBtn.addEventListener('click', processAgentCommand);
agentInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); processAgentCommand(); }
});

/**
 * Aplica marcador único e invisível ao texto para evitar rejeição por duplicata.
 * Usa 8 caracteres invisíveis diferentes (via String.fromCharCode) combinados
 * de forma única por índice. O marcador é inserido ANTES da última palavra,
 * pois inserções no final do texto podem ser removidas pela normalização do Twitter.
 */
function applyNodetect(text, index) {
  if (!text) return text;

  // Pool de 8 chars invisíveis usando fromCharCode (encoding 100% seguro no arquivo JS)
  const pool = [
    String.fromCharCode(0x2060), // word joiner
    String.fromCharCode(0x2061), // function application (invisible)
    String.fromCharCode(0x2062), // invisible times
    String.fromCharCode(0x2063), // invisible separator
    String.fromCharCode(0x2064), // invisible plus
    String.fromCharCode(0x200B), // zero-width space
    String.fromCharCode(0x200C), // zero-width non-joiner
    String.fromCharCode(0x200D), // zero-width joiner
  ];

  // Gera 4 chars únicos para este índice (256^4 combinações possíveis)
  const n = pool.length;
  const marker =
    pool[index % n] +
    pool[(index * 3 + 1) % n] +
    pool[(index * 5 + 2) % n] +
    pool[(index * 7 + 3) % n];

  // Insere ANTES da última palavra (resistente a strip de trailing chars)
  const lastSpace = text.lastIndexOf(' ');
  if (lastSpace > 0) {
    return text.slice(0, lastSpace + 1) + marker + text.slice(lastSpace + 1);
  }
  // Texto sem espaços: insere no meio
  const mid = Math.floor(text.length / 2);
  return text.slice(0, mid) + marker + text.slice(mid);
}

async function processAgentCommand() {
  const msg = agentInput.value.trim();
  if (!msg) return;
  agentInput.value = '';
  addAgentMsg(msg, 'user');

  const { interval, startTime, endTime } = parseAgentCommand(msg);

  if (!startTime || !endTime || !interval) {
    addAgentMsg(
      'Não entendi o comando. Tente algo como:\n' +
      '"agende de 5 em 5 minutos das 21:00 até as 22:00"\n' +
      '"a cada 10 minutos das 20h às 21h30"',
      'error'
    );
    return;
  }

  // ── Captura o conteúdo exato do formulário ────────────────────────────────
  const baseText = tweetText.value.trim();
  const comment  = commentText.value.trim();
  const reply    = replyOption.value;
  const repost   = doRepost.checked;
  const pin      = doPin.checked;

  // Pega mídias da memória (só as que já foram totalmente lidas pelo FileReader)
  let filesToSend = mediaFiles
    .filter(f => f.dataUrl)
    .map(f => ({ dataUrl: f.dataUrl, type: f.type, name: f.name }));

  // Fallback: se não houver mídia em memória (extensão foi fechada/reaberta),
  // usa o rascunho salvo no IDB
  if (filesToSend.length === 0) {
    const draftFiles = await getMediaFromIDB(DRAFT_MEDIA_KEY);
    if (draftFiles && draftFiles.length > 0) {
      filesToSend = draftFiles;
      addAgentMsg('📂 Usando mídia do rascunho salvo (extensão foi reaberta).', 'bot');
    }
  }

  if (!baseText && filesToSend.length === 0) {
    addAgentMsg('Preencha o texto ou selecione uma mídia na aba Publicar antes de agendar.', 'error');
    return;
  }

  const useNodetect = agentNodetect.checked;

  // ── Gera lista de horários ────────────────────────────────────────────────
  let base = new Date();
  base.setHours(startTime.h, startTime.m, 0, 0);
  if (base.getTime() <= Date.now() + 60000) base.setDate(base.getDate() + 1);

  const endDate = new Date(base);
  endDate.setHours(endTime.h, endTime.m, 0, 0);
  if (endDate < base) endDate.setDate(endDate.getDate() + 1);

  const times = [];
  let cur = new Date(base);
  while (cur <= endDate) {
    times.push(new Date(cur));
    cur = new Date(cur.getTime() + interval * 60000);
  }

  if (times.length === 0) {
    addAgentMsg('Nenhum horário foi gerado. Verifique o intervalo e o range de tempo.', 'error');
    return;
  }

  addAgentMsg(`Agendando ${times.length} postagem${times.length > 1 ? 's' : ''}…`, 'bot');

  // ── Salva mídia uma vez (chave compartilhada para a sessão) ──────────────
  // Todas as postagens do lote referenciam a mesma mídia para economizar espaço.
  // Um contador de referências garante que a mídia só é deletada após o último post.
  let sharedMediaKey = null;
  if (filesToSend.length > 0) {
    sharedMediaKey = 'media_agent_batch_' + Date.now();
    await saveMediaToIDB(sharedMediaKey, filesToSend);
  }

  const stored = await chrome.storage.local.get('scheduled_posts');
  const posts  = stored.scheduled_posts || {};
  let scheduled = 0;

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const scheduledAt = t.getTime();
    if (scheduledAt <= Date.now() + 30000) continue;

    // Aplica marcador único invisível (só quando nodetect está ativo)
    const text = useNodetect && baseText
      ? applyNodetect(baseText, i)
      : baseText;

    const alarmName = 'scheduled_post_' + scheduledAt + '_' + Math.random().toString(36).slice(2, 7);

    posts[alarmName] = {
      text,
      comment,
      reply,
      repost,
      pin,
      // Todos os posts do lote compartilham a mesma chave de mídia
      mediaKey:   sharedMediaKey,
      mediaCount: filesToSend.length,
      // Índice do lote: o último post deleta a mídia compartilhada
      batchIndex: i,
      batchTotal: times.length,
      scheduledAt,
    };
    await chrome.runtime.sendMessage({ action: 'CREATE_ALARM', alarmName, scheduledAt });
    scheduled++;
  }

  await chrome.storage.local.set({ scheduled_posts: posts });
  await renderScheduledList();

  const preview = times.slice(0, 5)
    .map(t => t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
    .join(', ');
  const extra = times.length > 5 ? ` e mais ${times.length - 5}…` : '';

  addAgentMsg(
    `✅ ${scheduled} postagem${scheduled > 1 ? 's' : ''} agendada${scheduled > 1 ? 's' : ''}!\n` +
    `Horários: ${preview}${extra}\n` +
    (useNodetect ? '🔒 Nodetect ativo: cada post tem um marcador único invisível.\n' : '') +
    `\nVeja a lista completa na aba Publicar.`,
    'bot'
  );
}

// ════════════════════════════════════════════════════════════════════════════
//  ABA VÍDEOS
// ════════════════════════════════════════════════════════════════════════════

const videoLinkInput       = document.getElementById('videoLinkInput');
const videoFetchBtn        = document.getElementById('videoFetchBtn');
const videoPreviewBox      = document.getElementById('videoPreviewBox');
const videoThumb           = document.getElementById('videoThumb');
const videoQualityLabel    = document.getElementById('videoQualityLabel');
const videoCaptionPreview  = document.getElementById('videoCaptionPreview');
const videoWithCaptionBtn  = document.getElementById('videoWithCaptionBtn');
const videoOnlyBtn         = document.getElementById('videoOnlyBtn');
const videoDownloadOnlyBtn = document.getElementById('videoDownloadOnlyBtn');
const videoToast           = document.getElementById('videoToast');

let currentVideoInfo = null; // { videoUrl, thumbnailUrl, caption, width, height }

function showVideoToast(msg, type = 'info') {
  videoToast.textContent = msg;
  videoToast.className = `toast ${type}`;
  videoToast.classList.remove('hidden');
  setTimeout(() => videoToast.classList.add('hidden'), 6000);
}

function setVideoButtonsBusy(busy, label) {
  [videoWithCaptionBtn, videoOnlyBtn, videoDownloadOnlyBtn].forEach(b => b.disabled = busy);
  if (busy && label) showVideoToast(label, 'info');
}

videoFetchBtn.addEventListener('click', async () => {
  const link = videoLinkInput.value.trim();
  if (!link) { showVideoToast('Cole o link de uma postagem do X.', 'error'); return; }

  videoFetchBtn.disabled = true;
  videoPreviewBox.classList.add('hidden');
  showVideoToast('Buscando vídeo…', 'info');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'FETCH_TWEET_VIDEO', payload: { link } });
    if (result?.error) {
      showVideoToast('❌ ' + result.error, 'error');
      return;
    }
    currentVideoInfo = result;
    videoThumb.src = result.thumbnailUrl || '';
    videoQualityLabel.textContent = result.width && result.height
      ? `Melhor qualidade encontrada: ${result.width}x${result.height}`
      : 'Melhor qualidade disponível encontrada.';
    videoCaptionPreview.textContent = result.caption ? result.caption : '(sem legenda/texto no post)';
    videoPreviewBox.classList.remove('hidden');
    showVideoToast('✓ Vídeo encontrado!', 'success');
  } catch (err) {
    showVideoToast('Erro: ' + err.message, 'error');
  } finally {
    videoFetchBtn.disabled = false;
  }
});

// Baixa o vídeo (blob) e injeta na aba Publicar
async function loadVideoIntoComposer(withCaption) {
  if (!currentVideoInfo) return;
  setVideoButtonsBusy(true, 'Baixando vídeo…');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'DOWNLOAD_TWEET_VIDEO',
      payload: { videoUrl: currentVideoInfo.videoUrl },
    });
    if (result?.error) { showVideoToast('❌ ' + result.error, 'error'); return; }

    const objectUrl = URL.createObjectURL(dataUrlToBlob(result.dataUrl));
    mediaFiles.push({ dataUrl: result.dataUrl, type: result.type, name: result.name, objectUrl });
    renderMediaGrid();
    saveDraftMedia();

    if (withCaption && currentVideoInfo.caption) {
      tweetText.value = currentVideoInfo.caption;
      charCount.textContent = currentVideoInfo.caption.length;
      autoSaveForm();
    }

    showVideoToast('✓ Vídeo adicionado à aba Publicar!', 'success');

    // Leva o usuário até a aba Publicar para ver o resultado
    document.querySelector('.tab[data-tab="post"]').click();
  } catch (err) {
    showVideoToast('Erro: ' + err.message, 'error');
  } finally {
    setVideoButtonsBusy(false);
  }
}

videoWithCaptionBtn.addEventListener('click', () => loadVideoIntoComposer(true));
videoOnlyBtn.addEventListener('click', () => loadVideoIntoComposer(false));

videoDownloadOnlyBtn.addEventListener('click', async () => {
  if (!currentVideoInfo) return;
  videoDownloadOnlyBtn.disabled = true;
  showVideoToast('Iniciando download…', 'info');
  try {
    await chrome.downloads.download({
      url: currentVideoInfo.videoUrl,
      filename: `tweet_video_${Date.now()}.mp4`,
      saveAs: true,
    });
    showVideoToast('✓ Download iniciado!', 'success');
  } catch (err) {
    showVideoToast('Erro: ' + err.message, 'error');
  } finally {
    videoDownloadOnlyBtn.disabled = false;
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  MENSAGEM DE BOAS-VINDAS (AGENTE)
// ════════════════════════════════════════════════════════════════════════════

// Mensagem de boas-vindas
addAgentMsg(
  'Olá! Preencha o texto e/ou mídia na aba Publicar e me diga quando agendar.\n\n' +
  'Exemplos:\n' +
  '• "agende de 5 em 5 minutos das 21:00 até as 22:00"\n' +
  '• "a cada 10 minutos das 20h às 21h30"\n' +
  '• "de 15 em 15 min das 18:00 até as 20:00"',
  'bot'
);

detectBtn.addEventListener('click', async () => {
  detectBtn.disabled = true;
  detectBtn.textContent = 'Detectando…';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'DETECT_ACCOUNT' });
    if (result.error) { showToast(result.error, 'error'); return; }
    const { username, displayName, avatar } = result;
    if (!username) { showToast('Conta não detectada. Certifique-se de estar logado no Twitter.', 'error'); return; }

    const data = await chrome.storage.local.get('accounts');
    const accounts = data.accounts || [];
    if (!accounts.find(a => a.username === username)) {
      accounts.push({ username, displayName: displayName || username, avatar: avatar || null, addedAt: Date.now() });
      await chrome.storage.local.set({ accounts });
      showToast('Conta @' + username + ' adicionada!', 'success');
    } else {
      showToast('@' + username + ' já está na lista.', 'info');
    }
    await setActiveAccount(username);
  } catch (err) {
    showToast('Erro: ' + err.message, 'error');
  } finally {
    detectBtn.disabled = false;
    detectBtn.innerHTML = `<svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg> Detectar conta ativa do Twitter`;
  }
});
