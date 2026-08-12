const STEPS = [
  { id: 'composer', label: 'Abrindo compositor' },
  { id: 'text',     label: 'Digitando texto' },
  { id: 'media',    label: 'Enviando mídia' },
  { id: 'reply',    label: 'Configurando respostas' },
  { id: 'publish',  label: 'Publicando' },
  { id: 'comment',  label: 'Comentando na publicação' },
  { id: 'repost',   label: 'Dando repost' },
];

let uiState = 'idle';
let stepsStatus = STEPS.map(() => 'pending');

const tweetText = document.getElementById('tweetText');
const charCount = document.getElementById('charCount');
const mediaFile = document.getElementById('mediaFile');
const fileName = document.getElementById('fileName');
const replyOption = document.getElementById('replyOption');
const commentText = document.getElementById('commentText');
const doRepost = document.getElementById('doRepost');
const startBtn = document.getElementById('startBtn');
const formSection = document.getElementById('formSection');
const progressSection = document.getElementById('progressSection');
const stepsList = document.getElementById('stepsList');
const pauseBtn = document.getElementById('pauseBtn');
const pauseIcon = document.getElementById('pauseIcon');
const resumeIcon = document.getElementById('resumeIcon');
const pauseLabel = document.getElementById('pauseLabel');
const cancelBtn = document.getElementById('cancelBtn');
const newPostBtn = document.getElementById('newPostBtn');
const errorBox = document.getElementById('errorBox');

tweetText.addEventListener('input', () => {
  const n = tweetText.value.length;
  charCount.textContent = n;
  charCount.style.color = n > 260 ? '#f4212e' : '#71767b';
});

let mediaDataUrl = null, mediaType = null, mediaName = null;
mediaFile.addEventListener('change', () => {
  const file = mediaFile.files[0];
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) { alert('Arquivo muito grande (máx. 512 MB).'); return; }
  fileName.textContent = file.name;
  mediaName = file.name; mediaType = file.type;
  const reader = new FileReader();
  reader.onload = e => { mediaDataUrl = e.target.result; };
  reader.readAsDataURL(file);
});

function renderSteps() {
  stepsList.innerHTML = '';
  STEPS.forEach((step, i) => {
    const status = stepsStatus[i];
    const div = document.createElement('div');
    div.className = `step ${status}`;
    const iconDiv = document.createElement('div');
    iconDiv.className = 'step-icon';
    if (status === 'active') { const s = document.createElement('div'); s.className = 'spin'; iconDiv.appendChild(s); }
    else if (status === 'done') iconDiv.textContent = '✓';
    else if (status === 'error') iconDiv.textContent = '✗';
    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = step.label;
    div.appendChild(iconDiv); div.appendChild(label);
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
  if (paused) { pauseIcon.classList.add('hidden'); resumeIcon.classList.remove('hidden'); pauseLabel.textContent = 'Retomar'; }
  else { pauseIcon.classList.remove('hidden'); resumeIcon.classList.add('hidden'); pauseLabel.textContent = 'Pausar'; }
}

startBtn.addEventListener('click', async () => {
  const text = tweetText.value.trim();
  const comment = commentText.value.trim();
  const reply = replyOption.value;
  const repost = doRepost.checked;
  if (!text && !mediaDataUrl) { alert('Escreva algo ou selecione uma mídia antes de iniciar.'); return; }
  uiState = 'running'; stepsStatus = STEPS.map(() => 'pending');
  showProgress(); setPauseUI(false);
  chrome.runtime.sendMessage({ action: 'POST_TWEET', payload: { text, comment, reply, repost, mediaDataUrl, mediaType, mediaName } }).catch(() => {});
});

pauseBtn.addEventListener('click', async () => {
  if (uiState === 'running') { uiState = 'paused'; setPauseUI(true); chrome.runtime.sendMessage({ action: 'PAUSE' }); }
  else if (uiState === 'paused') { uiState = 'running'; setPauseUI(false); chrome.runtime.sendMessage({ action: 'RESUME' }); }
});

cancelBtn.addEventListener('click', async () => {
  chrome.runtime.sendMessage({ action: 'CANCEL' });
  uiState = 'idle'; showForm();
});

newPostBtn.addEventListener('click', () => { uiState = 'idle'; showForm(); });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'STEP_UPDATE') { stepsStatus[msg.index] = msg.status; renderSteps(); return; }
  if (msg.action === 'FLOW_DONE') {
    stepsStatus = stepsStatus.map(s => s === 'active' || s === 'pending' ? 'done' : s);
    renderSteps(); uiState = 'done';
    pauseBtn.classList.add('hidden'); cancelBtn.classList.add('hidden'); newPostBtn.classList.remove('hidden');
    return;
  }
  if (msg.action === 'FLOW_CANCELLED') { uiState = 'idle'; showForm(); return; }
  if (msg.action === 'FLOW_ERROR') {
    const i = stepsStatus.findIndex(s => s === 'active');
    if (i >= 0) stepsStatus[i] = 'error';
    renderSteps(); errorBox.textContent = '⚠ ' + (msg.error || 'Erro desconhecido'); errorBox.classList.remove('hidden');
    uiState = 'error'; pauseBtn.classList.add('hidden'); cancelBtn.classList.add('hidden'); newPostBtn.classList.remove('hidden');
    return;
  }
  if (msg.action === 'PAUSED') { uiState = 'paused'; setPauseUI(true); return; }
  if (msg.action === 'RESUMED') { uiState = 'running'; setPauseUI(false); return; }
});

(async () => {
  const data = await chrome.storage.session.get(['tw_running', 'tw_step', 'tw_paused']);
  if (data.tw_running) {
    stepsStatus = STEPS.map((_, i) => i < data.tw_step ? 'done' : i === data.tw_step ? 'active' : 'pending');
    uiState = data.tw_paused ? 'paused' : 'running';
    showProgress(); setPauseUI(!!data.tw_paused);
  }
})();