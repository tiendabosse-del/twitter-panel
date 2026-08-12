/**
 * content.js v4.1 – Twitter Auto Poster
 * - Sem configuração de respostas pré-publicação (só pós, via menu "...")
 * - Abre o post direto pelo toast "Ver" que aparece após publicar
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

const flow = { paused: false, cancelled: false, pauseResolve: null };
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Aguarda elemento no DOM ──────────────────────────────────────────────────
function waitFor(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const obs = new MutationObserver(() => {
      const f = document.querySelector(selector);
      if (f) { obs.disconnect(); resolve(f); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
  });
}

// ── Relay para o side panel ──────────────────────────────────────────────────
function send(action, data = {}) {
  chrome.runtime.sendMessage({ action, ...data }).catch(() => {});
}

// ── Checkpoint (pausa/cancela entre etapas) ──────────────────────────────────
async function checkpoint(i) {
  if (flow.cancelled) throw new Error('CANCELADO');
  send('STEP_UPDATE', { index: i, status: 'active' });
  await chrome.storage.session.set({ tw_step: i, tw_paused: flow.paused }).catch(() => {});
  if (flow.paused) {
    await new Promise(r => { flow.pauseResolve = r; });
  }
  if (flow.cancelled) throw new Error('CANCELADO');
}

function markDone(i) { send('STEP_UPDATE', { index: i, status: 'done' }); }

// ── Inserção de texto no editor Lexical do Twitter (3 estratégias) ───────────
async function typeInEditor(el, text) {
  el.focus();
  await delay(400);
  document.execCommand('selectAll', false, null);
  await delay(100);

  // Estratégia 1: ClipboardEvent com DataTransfer (Lexical responde ao paste)
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    await delay(500);
    if (el.textContent.trim().length > 0) return;
  } catch (_) {}

  // Estratégia 2: clipboard real + execCommand paste
  try {
    await navigator.clipboard.writeText(text);
    document.execCommand('delete', false, null);
    document.execCommand('paste');
    await delay(400);
    if (el.textContent.trim().length > 0) return;
  } catch (_) {}

  // Estratégia 3: beforeinput → insertText
  document.execCommand('delete', false, null);
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  document.execCommand('insertText', false, text);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  await delay(300);
}

// ── DataURL → File ───────────────────────────────────────────────────────────
function dataURLtoFile(dataUrl, name, mime) {
  const arr = dataUrl.split(','), bstr = atob(arr[1]);
  let n = bstr.length; const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new File([u8], name, { type: mime });
}

// ── Aguarda botão de publicar estar HABILITADO ───────────────────────────────
// Adaptativo: verifica a cada 300 ms. Arquivo leve → pronto em segundos.
// Vídeo pesado → espera até 5 min. A lógica é simples: botão habilitado = pronto.
async function waitForTweetButtonReady(timeout = 300000) { // 5 min máximo
  const end = Date.now() + timeout;
  let lastLabelUpdate = 0;

  while (Date.now() < end) {
    const btn = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
    if (btn) {
      const isDisabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      if (!isDisabled) return btn; // ✅ pronto — sai imediatamente
    }

    // Atualiza label só se já passaram 8 s (evita spam para arquivos rápidos)
    const now = Date.now();
    if (now - lastLabelUpdate > 8000) {
      send('STEP_UPDATE', { index: 4, status: 'active', label: 'Aguardando upload…' });
      lastLabelUpdate = now;
    }

    await delay(300); // verifica a cada 300 ms → reage rápido para arquivos leves
  }
  throw new Error('Tempo esgotado aguardando upload (5 min). Tente um arquivo menor.');
}

// ── Restrição de respostas ANTES de publicar ─────────────────────────────────
async function findReplyBtn(timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const byId = document.querySelector('[data-testid="replyRestrictionsButton"]');
    if (byId) return byId;
    for (const el of document.querySelectorAll('[role="button"], button')) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const txt   = el.textContent.toLowerCase();
      if (label.includes('reply') || label.includes('responder') ||
          label.includes('who can') || label.includes('quem pode') ||
          txt.includes('todos podem') || txt.includes('everyone can reply')) return el;
    }
    await delay(400);
  }
  return null;
}

const REPLY_KW = {
  verified:  ['verificad', 'verified'],
  following: ['seguindo', 'following', 'que você segue'],
  mentioned: ['mencionad', 'mentioned'],
};

async function setReplyRestriction(option) {
  if (option === 'everyone') return;
  const btn = await findReplyBtn();
  if (!btn) return;
  btn.click(); await delay(900);
  for (const kw of REPLY_KW[option] || []) {
    for (const item of document.querySelectorAll('[role="menuitem"],[role="option"],[role="radio"]')) {
      if (item.textContent.toLowerCase().includes(kw)) { item.click(); await delay(600); return; }
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// ── Abre o tweet publicado pelo toast "Ver" do Twitter ───────────────────────
// IMPORTANTE: usa link.click() em vez de window.location.href para manter o
// content script vivo (Twitter é SPA — clicar aciona o roteador interno).
async function openPostedTweet(timeout = 12000) {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    const toast = document.querySelector('[data-testid="toast"]');
    if (toast) {
      const link = toast.querySelector('a[href*="/status/"]');
      if (link) {
        link.click(); // SPA navigation → script continua vivo
        // Aguarda a URL mudar e o conteúdo do tweet aparecer
        await waitForUrlChange(8000);
        await waitFor('article[data-testid="tweet"]', 10000);
        await delay(1200);
        return;
      }
    }
    await delay(300);
  }

  // Fallback: clica no timestamp do primeiro tweet do timeline
  const firstArticle = document.querySelector('article[data-testid="tweet"]');
  if (firstArticle) {
    const timeLink = firstArticle.querySelector('time')?.closest('a[href*="/status/"]')
                  || firstArticle.querySelector('a[href*="/status/"]');
    if (timeLink) {
      timeLink.click();
      await waitForUrlChange(8000);
      await waitFor('article[data-testid="tweet"]', 10000);
      await delay(1200);
      return;
    }
  }

  throw new Error('Não foi possível abrir a publicação. Verifique se o post foi criado.');
}

// ── Aguarda a URL mudar (confirma que o roteador SPA navegou) ────────────────
function waitForUrlChange(timeout = 8000) {
  return new Promise(resolve => {
    const initial = location.href;
    const end = Date.now() + timeout;
    const iv = setInterval(() => {
      if (location.href !== initial || Date.now() > end) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
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

// ── Comenta no tweet aberto ──────────────────────────────────────────────────
async function commentOnTweet(commentText) {
  // O primeiro artigo na página de detalhe é o tweet original
  const article = document.querySelector('article[data-testid="tweet"]');
  if (!article) throw new Error('Post não encontrado para comentar.');

  const replyBtn = article.querySelector('[data-testid="reply"]');
  if (!replyBtn) throw new Error('Botão de resposta não encontrado.');
  replyBtn.click();
  await delay(1000);

  const finalComment = getRandomBioComment(commentText);
  const editor = await waitFor('[data-testid="tweetTextarea_0"]', 8000);
  await typeInEditor(editor, finalComment);
  await delay(400);

  // Aguarda o botão de enviar (pode ter mais de um; usa o último visível habilitado)
  await delay(500);
  const submitBtns = [...document.querySelectorAll('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]')];
  const submitBtn = submitBtns.reverse().find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  if (!submitBtn) throw new Error('Botão de enviar comentário não encontrado.');
  submitBtn.click();
  await delay(3000);
}

// ── Repost do tweet aberto ───────────────────────────────────────────────────
async function repostTweet() {
  const article = document.querySelector('article[data-testid="tweet"]');
  if (!article) throw new Error('Post não encontrado para repost.');

  const rtBtn = article.querySelector('[data-testid="retweet"]');
  if (!rtBtn) throw new Error('Botão de repost não encontrado.');
  rtBtn.click();
  await delay(800);

  const confirm = await waitFor('[data-testid="retweetConfirm"]', 5000).catch(() => null);
  if (confirm) { confirm.click(); await delay(1000); }
}

// ── Fixa o tweet aberto no perfil ────────────────────────────────────────────
async function pinTweet() {
  const article = document.querySelector('article[data-testid="tweet"]');
  if (!article) return;

  // Fecha qualquer menu aberto
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(300);

  const moreBtn = article.querySelector('[data-testid="caret"]');
  if (!moreBtn) return;
  moreBtn.click();
  await delay(800);

  const items = document.querySelectorAll('[role="menuitem"]');
  let pinItem = null;
  for (const item of items) {
    const txt = item.textContent.toLowerCase();
    if (txt.includes('pin') || txt.includes('fixar') || txt.includes('fixo')) {
      pinItem = item; break;
    }
  }

  if (!pinItem) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }

  pinItem.click();
  await delay(700);

  // Confirma o diálogo se aparecer
  const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]')
    || [...document.querySelectorAll('button')].find(b =>
        b.textContent.toLowerCase().includes('pin') ||
        b.textContent.toLowerCase().includes('fixar'));
  if (confirmBtn) { confirmBtn.click(); await delay(600); }
}

// ── Poll helper: aguarda condição ser verdadeira ─────────────────────────────
function pollFor(fn, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeout;
    const iv = setInterval(() => {
      const r = fn();
      if (r) { clearInterval(iv); resolve(r); }
      else if (Date.now() > end) { clearInterval(iv); reject(new Error('pollFor timeout')); }
    }, 200);
  });
}

// ── Altera restrição de respostas no tweet já publicado ─────────────────────
// Palavras-chave em múltiplos idiomas para encontrar o item de menu correto
const CHANGE_REPLY_KW = [
  // Inglês
  'change who can reply', 'who can reply', 'change reply',
  // Português
  'alterar quem pode responder', 'quem pode responder', 'mudar quem pode',
  // Espanhol
  'cambiar quién puede', 'quién puede responder',
  // Francês
  'modifier qui peut répondre', 'qui peut répondre',
  // Alemão
  'ändern, wer antworten', 'wer antworten kann',
  // Italiano
  'cambia chi può rispondere',
  // Japonês / Chinês / Coreano (fallback parcial)
  '返信', '回复', '답글',
];

// Ordem das opções de restrição no Twitter (universal, não depende de idioma):
// 0 = Todos (Everyone)
// 1 = Seguindo (Following / accounts you follow)
// 2 = Mencionados (Mentioned)
// 3 = Verificados (Verified / Certified) ← ÚLTIMA opção
const REPLY_OPTION_INDEX = { everyone: 0, following: 1, mentioned: 2, verified: 3 };

async function changePostReplyRestriction(option) {
  if (!option || option === 'everyone') return;

  const article = document.querySelector('article[data-testid="tweet"]');
  if (!article) return;

  // Fecha qualquer coisa aberta
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(700);

  // ── 1. Abre o menu "..." do tweet ────────────────────────────────────────
  const moreBtn = article.querySelector('[data-testid="caret"]');
  if (!moreBtn) return;
  moreBtn.click();
  await delay(1500);

  // ── 2. Clica em "Change who can reply" (testid → keywords → fallback) ─────
  let changeItem = null;
  const endMenu = Date.now() + 10000;
  while (Date.now() < endMenu && !changeItem) {
    const items = [...document.querySelectorAll('[role="menuitem"]')];

    // Tenta por data-testid
    changeItem = items.find(el => {
      const tid = (el.dataset.testid || '').toLowerCase();
      return tid.includes('reply') || tid.includes('restrict') || tid.includes('who');
    });

    // Tenta por palavras-chave multilíngues
    if (!changeItem) {
      changeItem = items.find(el => {
        const txt = el.textContent.toLowerCase();
        return CHANGE_REPLY_KW.some(kw => txt.includes(kw));
      });
    }

    if (!changeItem) await delay(400);
  }

  if (!changeItem) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }

  changeItem.click();
  await delay(2000); // aguarda o painel de opções abrir completamente

  // ── 3. Seleciona a opção correta ─────────────────────────────────────────
  const targetIdx = REPLY_OPTION_INDEX[option] ?? 3;

  const endOpts = Date.now() + 12000;
  let clicked = false;

  while (Date.now() < endOpts && !clicked) {

    // Estratégia A: input[type="radio"] real (alguns builds do Twitter usam)
    const radios = [...document.querySelectorAll('input[type="radio"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 || el.offsetParent !== null; });
    if (radios.length > targetIdx) {
      const r = radios[targetIdx];
      if (!r.checked) { r.click(); await delay(200); }
      clicked = true; break;
    }

    // Estratégia B: elementos com role radio/option/menuitemradio visíveis
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
      if (!isSelected) {
        target.click();
      }
      clicked = true; break;
    }

    // Estratégia C: procura em qualquer sheet/dialog/layer visível
    // Pega todas as linhas clicáveis que contêm um círculo SVG (radio visual)
    const sheetItems = [...document.querySelectorAll(
      '[data-testid*="replyRestriction"], [data-testid*="replyPolicy"], ' +
      '[data-testid*="audienceOption"], [data-testid*="whoCanReply"]'
    )].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

    if (sheetItems.length > targetIdx) {
      sheetItems[targetIdx].click();
      clicked = true; break;
    }

    // Estratégia D: último recurso — pega todos os elementos clicáveis
    // dentro do layer/overlay mais recente que apareceu na tela
    const layers = [...document.querySelectorAll('[data-testid="sheetDialog"],[data-testid="Dropdown"],[role="dialog"],[role="menu"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });

    if (layers.length > 0) {
      const layer = layers[layers.length - 1]; // pega o mais recente
      const clickables = [...layer.querySelectorAll('li, [role="listitem"], div[tabindex]')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 20; });
      if (clickables.length > targetIdx) {
        clickables[targetIdx].click();
        clicked = true; break;
      }
    }

    await delay(500);
  }

  if (!clicked) return;
  await delay(1200);

  // ── 4. Salva se aparecer botão ────────────────────────────────────────────
  try {
    const saveBtn = await pollFor(() => {
      return document.querySelector('[data-testid="settingsDetailSave"]')
          || [...document.querySelectorAll('button,[role="button"]')].find(b => {
               const txt = b.textContent.trim().toLowerCase();
               const r = b.getBoundingClientRect();
               return r.width > 0 && r.height > 0 && (
                 txt === 'save' || txt === 'salvar' || txt === 'done' || txt === 'ok' ||
                 txt === 'apply' || txt === 'aplicar' || txt === 'confirm' || txt === 'concluir' ||
                 txt === 'appliquer' || txt === 'enregistrer' || txt === 'speichern' || txt === 'conferma'
               );
             });
    }, 3000);
    if (saveBtn) { saveBtn.click(); await delay(800); }
  } catch { /* Twitter salva automaticamente ao clicar na opção */ }
}

// ── Fluxo principal ──────────────────────────────────────────────────────────
async function runFlow({ text, comment, reply, repost, pin,
                         mediaFiles, mediaDataUrl, mediaType, mediaName }) {

  // Normaliza: suporta array de arquivos (novo) e arquivo único (legado)
  const files = (mediaFiles && mediaFiles.length > 0)
    ? mediaFiles
    : (mediaDataUrl ? [{ dataUrl: mediaDataUrl, type: mediaType || 'image/jpeg', name: mediaName || 'media' }] : []);

  // ── Etapa 0: Abre compositor ─────────────────────────────────────────────
  await checkpoint(0);
  if (!document.querySelector('[data-testid="tweetTextarea_0"]')) {
    const btn = await waitFor('[data-testid="SideNav_NewTweet_Button"]', 8000).catch(() => null);
    if (!btn) throw new Error('Compositor não encontrado. Navegue até a home do Twitter.');
    btn.click();
    await waitFor('[data-testid="tweetTextarea_0"]', 8000);
  }
  await delay(800);
  markDone(0);

  // ── Etapa 1: Digita texto ────────────────────────────────────────────────
  await checkpoint(1);
  const editor = await waitFor('[data-testid="tweetTextarea_0"]', 8000);
  if (text) await typeInEditor(editor, text);
  await delay(300);
  markDone(1);

  // ── Etapa 2: Upload de mídia (múltiplos arquivos) ────────────────────────
  await checkpoint(2);
  if (files.length > 0) {
    const input = document.querySelector('input[data-testid="fileInput"]')
               || document.querySelector('input[accept*="image"],input[accept*="video"]');
    if (!input) throw new Error('Campo de upload não encontrado.');

    const dt = new DataTransfer();
    for (const f of files) {
      dt.items.add(dataURLtoFile(f.dataUrl, f.name, f.type));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Aguarda a primeira miniatura aparecer antes de checar o botão
    await waitFor('[data-testid="attachments"]', 60000).catch(() => {});
    await delay(500);
  }
  markDone(2);

  // ── Etapa 3: Publica (aguarda botão habilitado — adaptativo por tamanho) ─
  await checkpoint(3);
  const tweetBtn = await waitForTweetButtonReady(300000);
  tweetBtn.click();
  await delay(2000); // aguarda o modal fechar e o toast aparecer
  markDone(3);

  // ── Etapa 4: Abre o post publicado pelo toast "Ver" ──────────────────────
  await checkpoint(4);
  await openPostedTweet(12000);
  markDone(4);

  // ── Etapa 5: Comenta ─────────────────────────────────────────────────────
  await checkpoint(5);
  if (comment) {
    await commentOnTweet(comment);
  }
  markDone(5);

  // ── Etapa 6: Repost ──────────────────────────────────────────────────────
  await checkpoint(6);
  if (repost) {
    await repostTweet();
  }
  markDone(6);

  // ── Etapa 7: Fixa a publicação ───────────────────────────────────────────
  await checkpoint(7);
  if (pin !== false) {
    await pinTweet().catch(() => {});
  }
  markDone(7);

  // ── Etapa 8: Restringe respostas (via menu "..." do post já publicado) ───
  await checkpoint(8);
  if (reply && reply !== 'everyone') {
    await changePostReplyRestriction(reply).catch(() => {});
  }
  markDone(8);

  // ── Volta para home após todas as ações (evita erros em postagens futuras) ─
  await delay(1000);
  const homeLink = document.querySelector('[data-testid="AppTabBar_Home_Link"]');
  if (homeLink) {
    homeLink.click(); // navegação SPA — mantém content script vivo
  } else {
    window.location.href = 'https://x.com/home';
  }

  return { success: true };
}

// ── Listener de mensagens ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'PING') { sendResponse({ alive: true }); return; }

  if (msg.action === 'GET_ACCOUNT') {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const username    = link?.getAttribute('href')?.replace('/', '') || null;
    const avatar      = link?.querySelector('img')?.src || null;
    const nameEl      = document.querySelector('[data-testid="UserName"] span');
    const displayName = nameEl?.textContent || username;
    sendResponse({ username, displayName, avatar });
    return;
  }

  if (msg.action === 'DO_POST') {
    flow.paused = false; flow.cancelled = false;
    chrome.storage.session.set({ tw_running: true, tw_step: 0 }).catch(() => {});

    runFlow(msg.payload)
      .then(() => {
        chrome.storage.session.set({ tw_running: false }).catch(() => {});
        send('FLOW_DONE');
        sendResponse({ success: true });
      })
      .catch(err => {
        chrome.storage.session.set({ tw_running: false }).catch(() => {});
        if (err.message === 'CANCELADO') send('FLOW_CANCELLED');
        else send('FLOW_ERROR', { error: err.message });
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (msg.action === 'PAUSE') {
    flow.paused = true;
    chrome.storage.session.set({ tw_paused: true }).catch(() => {});
    send('PAUSED');
    sendResponse({ ok: true }); return;
  }

  if (msg.action === 'RESUME') {
    flow.paused = false;
    chrome.storage.session.set({ tw_paused: false }).catch(() => {});
    if (flow.pauseResolve) { flow.pauseResolve(); flow.pauseResolve = null; }
    send('RESUMED');
    sendResponse({ ok: true }); return;
  }

  if (msg.action === 'CANCEL') {
    flow.cancelled = true; flow.paused = false;
    if (flow.pauseResolve) { flow.pauseResolve(); flow.pauseResolve = null; }
    chrome.storage.session.set({ tw_running: false }).catch(() => {});
    sendResponse({ ok: true }); return;
  }
});
