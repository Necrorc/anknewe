/*
 * app.js — UI-логика: переключение экранов, колоды, список карточек,
 * импорт CSV/JSON, сессия обучения с повтором до полного выучивания.
 */

const state = {
  activeDeckId: null,
  editingDeckId: null,   // null = создаём новую колоду, id = редактируем существующую
  currentView: 'decks',
  learn: {
    queue: [],           // очередь id карточек в текущей сессии
    directions: {},       // id -> 'wt' | 'tw'
    sessionTotal: 0,
    current: null,        // карточка, которая сейчас показана
    revealed: false,
    hasRevealedOnce: false, // была ли карточка хоть раз перевёрнута в этом показе (для печатей знал/не знал)
    sessionActive: false,   // сессия идёт — не сбрасывать на экран выбора направления при возврате на вкладку
  },
  listen: {
    speaker: null,        // экземпляр CardSpeaker
    deck: null,
    sessionActive: false,
  },
  pendingConfirm: null,   // функция, которая выполнится по подтверждению в модалке
  settings: {
    confirmDeleteCard: true,      // спрашивать подтверждение перед удалением карточки
    deleteButtonPosition: 'top',  // 'top' | 'stamps' — где показывать 🗑 в режиме "Учить"
    appLanguage: 'ru',            // 'ru' | 'en' | 'pl'
  },
};

/* ---------------------------------------------------------------------- *
 * Утилиты интерфейса
 * ---------------------------------------------------------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function showView(name) {
  state.currentView = name;
  $all('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  $all('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.target === name));
  if (name === 'decks') renderDecks();
  if (name === 'cards') renderCards();
  if (name === 'learn') renderLearnSetup();
  if (name === 'listen') renderListenSetup();
  if (name === 'more') { renderStats(); renderSettingsView(); }
}

let toastTimer = null;

/**
 * Показывает тост. По умолчанию 2200мс; передай `duration` длиннее для сообщений
 * с числами (их нужно успеть прочитать), или `undoLabel`+`onUndo` — тогда в тосте
 * появится кнопка отмены действия (например, восстановление удалённой карточки),
 * и он покажется на более долгий срок автоматически (если duration не задан явно).
 */
function toast(msg, { duration, undoLabel, onUndo } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);

  if (undoLabel && onUndo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo-btn';
    btn.textContent = undoLabel;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.classList.remove('is-visible');
      onUndo();
    });
    el.appendChild(btn);
  }

  el.classList.add('is-visible');
  const finalDuration = duration || (undoLabel ? 6500 : 2200);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), finalDuration);
}

let lastFocusedBeforeModal = null;

function getFocusableIn(container) {
  return Array.from(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}

function openModal(id) {
  lastFocusedBeforeModal = document.activeElement;
  $('#modal-backdrop').hidden = false;
  $all('.modal').forEach((m) => (m.hidden = m.id !== id));
  const modalEl = document.getElementById(id);
  // фокус на первый интерактивный элемент модалки (или на неё саму, если таких нет)
  setTimeout(() => {
    const focusables = getFocusableIn(modalEl);
    (focusables[0] || modalEl).focus();
  }, 0);
}
function closeModal() {
  $('#modal-backdrop').hidden = true;
  state.pendingConfirm = null;
  state.editingDeckId = null;
  // возвращаем фокус туда, откуда открыли модалку — важно для клавиатурной навигации
  if (lastFocusedBeforeModal && document.body.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

// Escape закрывает открытую модалку; Tab/Shift+Tab не даёт фокусу уйти за её пределы
document.addEventListener('keydown', (e) => {
  if ($('#modal-backdrop').hidden) return;
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key !== 'Tab') return;

  const visibleModal = $all('.modal').find((m) => !m.hidden);
  if (!visibleModal) return;
  const focusables = getFocusableIn(visibleModal);
  if (focusables.length === 0) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function askConfirm(title, text, actionLabel, onConfirm) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-action-btn').textContent = actionLabel;
  state.pendingConfirm = onConfirm;
  openModal('modal-confirm');
}

/* ---------------------------------------------------------------------- *
 * Колоды
 * ---------------------------------------------------------------------- */

/** Останавливает активные сессии "Учить"/"Слушать" — вызывается при смене активной колоды,
 * чтобы не возникало рассинхрона "активная колода ≠ то, что сейчас играет/показывается". */
function stopActiveSessions() {
  if (state.listen.speaker) {
    state.listen.speaker.pause();
  }
  state.listen.sessionActive = false;
  state.listen.speaker = null;
  state.listen.deck = null;

  state.learn.sessionActive = false;
  state.learn.queue = [];
  state.learn.current = null;
}

async function renderDecks() {
  const decks = await getAllDecks();
  const activeId = await ensureActiveDeck();
  state.activeDeckId = activeId;

  const list = $('#deck-list');
  list.innerHTML = '';

  decks.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'deck-row' + (d.id === activeId ? ' is-active' : '');
    row.style.setProperty('--deck-color', d.color);
    const wordLangLabel = t('lang.' + d.wordLang) || d.wordLang;
    const trLangLabel = t('lang.' + d.translationLang) || d.translationLang;
    row.innerHTML = `
      <div class="deck-main">
        <div class="deck-name">${d.id === activeId ? '<span class="star">★</span>' : ''}${escapeHtml(d.name)}</div>
        <div class="deck-count">${escapeHtml(t('decks.rowInfo', { count: d.cardCount, wordLang: wordLangLabel, trLang: trLangLabel }))}</div>
      </div>
      <button class="deck-edit" data-id="${d.id}">✏️</button>
      <button class="deck-del" data-id="${d.id}" data-name="${escapeHtml(d.name)}">🗑</button>
    `;
    row.querySelector('.deck-main').addEventListener('click', async () => {
      stopActiveSessions();
      await setActiveDeck(d.id);
      toast(t('decks.activeToast', { name: d.name }));
      renderDecks();
    });
    row.querySelector('.deck-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openDeckModal(d);
    });
    row.querySelector('.deck-del').addEventListener('click', (e) => {
      e.stopPropagation();
      askConfirm(
        t('decks.deleteConfirmTitle'),
        t('decks.deleteConfirmText', { name: d.name, count: d.cardCount }),
        t('common.delete'),
        async () => {
          stopActiveSessions();
          await deleteDeck(d.id);
          await ensureActiveDeck();
          toast(t('decks.deletedToast', { name: d.name }));
          renderDecks();
        }
      );
    });
    list.appendChild(row);
  });

  const activeDeck = decks.find((d) => d.id === activeId);
  const hint = $('#decks-onboarding-hint');
  if (activeDeck && activeDeck.cardCount === 0) {
    hint.textContent = t('decks.onboardingHint');
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }

  $('#btn-merge-decks').disabled = decks.length < 2;
}

function fillLangSelect(selectEl, selectedCode) {
  selectEl.innerHTML = SPEECH_LANGUAGES.map(
    (l) => `<option value="${l.code}"${l.code === selectedCode ? ' selected' : ''}>${escapeHtml(t('lang.' + l.code))}</option>`
  ).join('');
}

function openDeckModal(deck /* undefined = создание новой */) {
  state.editingDeckId = deck ? deck.id : null;
  $('#deck-modal-title').textContent = deck ? t('deckModal.titleEdit') : t('deckModal.titleNew');
  $('#confirm-new-deck').textContent = deck ? t('deckModal.saveBtn') : t('deckModal.createBtn');
  $('#input-new-deck-name').value = deck ? deck.name : '';
  fillLangSelect($('#select-word-lang'), deck ? deck.wordLang : 'pl-PL');
  fillLangSelect($('#select-translation-lang'), deck ? deck.translationLang : 'ru-RU');
  openModal('modal-new-deck');
  setTimeout(() => $('#input-new-deck-name').focus(), 50);
}

$('#btn-new-deck').addEventListener('click', () => openDeckModal(null));

$('#confirm-new-deck').addEventListener('click', async () => {
  const name = $('#input-new-deck-name').value.trim();
  const wordLang = $('#select-word-lang').value;
  const translationLang = $('#select-translation-lang').value;
  if (!name) { toast(t('deckModal.nameEmptyToast')); return; }

  if (state.editingDeckId) {
    await updateDeck(state.editingDeckId, { name, wordLang, translationLang });
    closeModal();
    toast(t('deckModal.updatedToast', { name }));
  } else {
    const id = await createDeck(name, { wordLang, translationLang });
    stopActiveSessions();
    await setActiveDeck(id);
    closeModal();
    toast(t('deckModal.createdToast', { name }));
  }
  state.editingDeckId = null;
  renderDecks();
});

/* --- Объединение колод ------------------------------------------------------ */

function langLabel(code) {
  return t('lang.' + code) || code;
}

function deckOptionLabel(d) {
  return t('merge.optionLabel', { name: d.name, wordLang: langLabel(d.wordLang), trLang: langLabel(d.translationLang), count: d.cardCount });
}

$('#btn-merge-decks').addEventListener('click', async () => {
  const decks = await getAllDecks();
  if (decks.length < 2) { toast(t('decks.needTwoDecksToast')); return; }

  const fill = (selectEl, defaultIndex) => {
    selectEl.innerHTML = decks.map((d, i) =>
      `<option value="${d.id}"${i === defaultIndex ? ' selected' : ''}>${escapeHtml(deckOptionLabel(d))}</option>`
    ).join('');
  };
  fill($('#select-merge-source'), 0);
  fill($('#select-merge-target'), 1);

  openModal('modal-merge');
});

$('#confirm-merge-decks').addEventListener('click', async () => {
  const sourceId = Number($('#select-merge-source').value);
  const targetId = Number($('#select-merge-target').value);

  if (sourceId === targetId) { toast(t('merge.sameDeckToast')); return; }

  const source = await getDeck(sourceId);
  const target = await getDeck(targetId);

  if (source.wordLang !== target.wordLang || source.translationLang !== target.translationLang) {
    toast(t('merge.diffLangToast'));
    return;
  }

  closeModal();
  askConfirm(
    t('merge.confirmTitle'),
    t('merge.confirmText', { source: source.name, target: target.name }),
    t('merge.confirmBtn'),
    async () => {
      stopActiveSessions();
      const { moved, skipped } = await mergeDecks(sourceId, targetId);
      await ensureActiveDeck();
      toast(t('merge.doneToast', { moved }) + (skipped ? t('merge.doneSkippedSuffix', { skipped }) : ''), { duration: 3800 });
      renderDecks();
    }
  );
});

/* ---------------------------------------------------------------------- *
 * Список карточек активной колоды
 * ---------------------------------------------------------------------- */

async function renderCards() {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);

  $('#cards-deck-name').textContent = deck.name;
  $('#cards-count-sub').textContent = t('cards.countLabel', { count: cards.length });

  const list = $('#entry-list');
  list.innerHTML = '';

  if (cards.length === 0) {
    list.innerHTML = `<div class="empty-hint">${t('cards.emptyHint')}</div>`;
    return;
  }

  cards.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'entry-row';
    row.innerHTML = `
      <span class="entry-num">${i + 1}</span>
      <span class="entry-word">${escapeHtml(c.word)}</span>
      <span class="entry-arrow">→</span>
      <span class="entry-translation">${escapeHtml(c.translation)}</span>
      <span class="entry-box">${escapeHtml(t('cards.levelLabel', { n: c.box }))}</span>
      <button class="entry-edit" data-id="${c.id}">✏️</button>
      <button class="entry-del" data-id="${c.id}">✕</button>
    `;
    row.querySelector('.entry-edit').addEventListener('click', () => openEditCardModal(c));
    row.querySelector('.entry-del').addEventListener('click', () => {
      askConfirm(t('cards.deleteConfirmTitle'), `«${c.word}» → «${c.translation}»`, t('common.delete'), async () => {
        const cardSnapshot = { deckId: c.deckId, word: c.word, translation: c.translation, box: c.box, nextReview: c.nextReview, createdAt: c.createdAt };
        await deleteCard(c.id);
        renderCards();
        toast(t('cards.deletedToast'), {
          undoLabel: t('common.undo'),
          onUndo: async () => {
            await restoreCard(cardSnapshot);
            toast(t('common.restoredToast'));
            renderCards();
          },
        });
      });
    });
    list.appendChild(row);
  });
}

let editingCardId = null;
let editCardSavedCallback = null;

function openEditCardModal(card, onSaved) {
  editingCardId = card.id;
  editCardSavedCallback = onSaved || renderCards;
  $('#input-edit-card-word').value = card.word;
  $('#input-edit-card-translation').value = card.translation;
  openModal('modal-edit-card');
  setTimeout(() => $('#input-edit-card-word').focus(), 50);
}

$('#confirm-edit-card').addEventListener('click', async () => {
  const word = $('#input-edit-card-word').value.trim();
  const translation = $('#input-edit-card-translation').value.trim();
  if (!word || !translation) { toast(t('cards.fillBothToast')); return; }

  const ok = await updateCard(editingCardId, word, translation);
  closeModal();
  if (ok) {
    toast(t('cards.updatedToast'));
    if (editCardSavedCallback) await editCardSavedCallback();
  } else {
    toast(t('cards.duplicateToast'));
  }
});

$('#btn-cards-overflow').addEventListener('click', () => openModal('modal-cards-overflow'));

$('#btn-add-card').addEventListener('click', () => {
  $('#input-card-word').value = '';
  $('#input-card-translation').value = '';
  openModal('modal-add-card');
  setTimeout(() => $('#input-card-word').focus(), 50);
});

$('#confirm-add-card').addEventListener('click', async () => {
  const word = $('#input-card-word').value.trim();
  const translation = $('#input-card-translation').value.trim();
  if (!word || !translation) { toast(t('cards.fillBothToast')); return; }
  const deckId = await ensureActiveDeck();
  const added = await addCard(deckId, word, translation);
  closeModal();
  toast(added ? t('cards.addedToast') : t('cards.alreadyExistsToast'));
  renderCards();
});

$('#btn-dedup').addEventListener('click', async () => {
  closeModal();
  const deckId = await ensureActiveDeck();
  const removed = await dedupDeck(deckId);
  toast(removed ? t('cards.dedupRemovedToast', { n: removed }) : t('cards.dedupNoneToast'), { duration: removed ? 3800 : 2200 });
  renderCards();
});

$('#btn-reset-levels').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const { total } = await countCards(deckId);
  if (total === 0) { toast(t('cards.noCardsToast')); return; }
  openModal('modal-reset-levels');
});

function confirmResetLevels(targetBox) {
  closeModal();
  askConfirm(
    t('resetModal.confirmTitle'),
    t('resetModal.confirmText', { target: targetBox }),
    t('resetModal.confirmBtn'),
    async () => {
      const deckId = await ensureActiveDeck();
      const n = await resetDeckLevels(deckId, targetBox);
      toast(t('resetModal.doneToast', { target: targetBox, n }), { duration: 3800 });
      renderCards();
    }
  );
}

$('#reset-levels-to-1').addEventListener('click', () => confirmResetLevels(1));
$('#reset-levels-to-0').addEventListener('click', () => confirmResetLevels(0));

$('#btn-delete-all').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { total } = await countCards(deckId);
  if (total === 0) { toast(t('cards.noCardsToast')); return; }
  askConfirm(
    t('cards.clearConfirmTitle'),
    t('cards.clearConfirmText', { count: total, name: deck.name }),
    t('cards.clearBtn'),
    async () => {
      const n = await deleteAllCardsInDeck(deckId);
      toast(t('cards.clearedToast', { n }), { duration: 3800 });
      renderCards();
    }
  );
});

/* --- Импорт CSV / JSON ---------------------------------------------------- */

$('#btn-import-cards').addEventListener('click', () => $('#import-file-input').click());

$('#import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  let pairs = [];
  try {
    if (file.name.toLowerCase().endsWith('.json')) {
      pairs = parseJsonPairs(text);
    } else if (file.name.toLowerCase().endsWith('.csv')) {
      pairs = parseCsvPairs(text);
    } else {
      const trimmed = text.trim();
      pairs = (trimmed.startsWith('{') || trimmed.startsWith('[')) ? parseJsonPairs(text) : parseCsvPairs(text);
    }
  } catch (err) {
    toast(t('import.parseErrorToast', { error: err.message }));
    return;
  }
  if (pairs.length === 0) {
    toast(t('import.noPairsToast'));
    return;
  }
  const deckId = await ensureActiveDeck();
  const { added, skipped } = await addCardsBulk(deckId, pairs);
  toast(t('import.addedToast', { added }) + (skipped ? t('import.skippedSuffix', { skipped }) : ''), { duration: 3800 });
  renderCards();
});

/* --- Экспорт колоды -------------------------------------------------------- */

function sanitizeFilename(name) {
  return name.replace(/[^\p{L}\p{N}\-_ ]/gu, '_').trim() || 'deck';
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvEscape(s) {
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

$('#btn-export-cards').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const { total } = await countCards(deckId);
  if (total === 0) { toast(t('cards.noCardsForExportToast')); return; }
  openModal('modal-export');
});

$('#export-as-json').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  const data = cards.map((c) => ({ word: c.word, translation: c.translation }));
  downloadFile(`${sanitizeFilename(deck.name)}.json`, JSON.stringify(data, null, 2), 'application/json');
  closeModal();
  toast(t('export.downloadedToast', { n: cards.length }), { duration: 3800 });
});

$('#export-as-csv').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  const lines = ['word,translation', ...cards.map((c) => `${csvEscape(c.word)},${csvEscape(c.translation)}`)];
  // UTF-8 BOM + CRLF — иначе Excel по умолчанию ломает кириллицу и не всегда распознаёт переносы строк
  const csvContent = '\uFEFF' + lines.join('\r\n');
  downloadFile(`${sanitizeFilename(deck.name)}.csv`, csvContent, 'text/csv');
  closeModal();
  toast(t('export.downloadedToast', { n: cards.length }), { duration: 3800 });
});

function parseCsvPairs(text) {
  const sample = text.slice(0, 200);
  const delim = (sample.match(/;/g) || []).length >= (sample.match(/,/g) || []).length ? ';' : ',';
  let rows = parseCsvText(text, delim).filter((row) => row.some((cell) => cell.trim().length > 0));

  if (rows.length) {
    const header = rows[0].map((c) => c.trim().toLowerCase());
    const headerWords = ['word', 'слово', 'front', 'translation', 'перевод', 'back'];
    // Пропускаем заголовок, только если ОБЕ первые ячейки — служебные слова
    // (а не одна, иначе легко принять настоящую пару слово/перевод за заголовок,
    // если слово случайно совпало с одним из этих названий колонок)
    if (header.length >= 2 && headerWords.includes(header[0]) && headerWords.includes(header[1])) {
      rows = rows.slice(1);
    }
  }

  const pairs = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    const word = row[0].trim(), translation = row[1].trim();
    if (word && translation) pairs.push([word, translation]);
  }
  return pairs;
}

/**
 * Полноценный разбор CSV-текста целиком (а не построчно) — так поля в кавычках
 * могут содержать переносы строк, запятые/точки с запятой и экранированные
 * кавычки (""), не ломая структуру таблицы.
 */
function parseCsvText(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; } // перевод строки распознаём по \n, \r просто пропускаем
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseJsonPairs(text) {
  const data = JSON.parse(text);
  const pairs = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (Array.isArray(item) && item.length >= 2) {
        pairs.push([String(item[0]), String(item[1])]);
      } else if (item && typeof item === 'object') {
        const word = item.word || item.front || item['слово'];
        const translation = item.translation || item.back || item['перевод'];
        if (word && translation) pairs.push([String(word), String(translation)]);
      }
    }
  } else if (data && typeof data === 'object') {
    for (const [word, translation] of Object.entries(data)) {
      if (typeof translation === 'string') pairs.push([word, translation]);
    }
  }
  return pairs;
}

/* ---------------------------------------------------------------------- *
 * Учить (сессия)
 * ---------------------------------------------------------------------- */

async function renderLearnSetup() {
  // если сессия уже идёт (например, вернулись на вкладку) — не сбрасываем её на экран выбора направления
  if (state.learn.sessionActive) return;

  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { due } = await countCards(deckId);

  $('#learn-session').hidden = true;
  $('#learn-empty').hidden = true;
  $('#learn-setup').hidden = false;
  $('#learn-deck-info').textContent = t('learn.deckInfo', { name: deck.name, due });

  $all('.btn-direction').forEach((b) => (b.onclick = () => startLearnSession(b.dataset.dir)));

  if (due === 0) {
    $('#learn-setup').hidden = true;
    $('#learn-empty-text').textContent = t('learn.noDueText', { name: deck.name });
    $('#btn-learn-again').hidden = true;
    $('#learn-empty').hidden = false;
  }
}

async function startLearnSession(mode) {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { due: trueDueCount } = await countCards(deckId);
  const due = await getDueCards(deckId, 20);
  if (due.length === 0) { renderLearnSetup(); return; }

  const ids = due.map((c) => c.id);
  const directions = {};
  for (const id of ids) {
    directions[id] = mode === 'mix' ? (Math.random() < 0.5 ? 'wt' : 'tw') : mode;
  }

  state.learn.deck = deck;
  state.learn.queue = ids;
  state.learn.directions = directions;
  state.learn.sessionTotal = ids.length;
  state.learn.dueAtStart = trueDueCount; // может быть больше 20 — для сообщения "выучено N из M"
  state.learn.scoredCards = new Set(); // карточки, для которых уже учтена первая попытка
  state.learn.sessionActive = true;

  $('#learn-setup').hidden = true;
  $('#learn-empty').hidden = true;
  $('#learn-session').hidden = false;
  $('#card-speak-btn').hidden = !SPEECH_SUPPORTED;

  await showNextCard();
}

async function showNextCard() {
  const { queue } = state.learn;
  if (queue.length === 0) {
    state.learn.sessionActive = false;
    $('#learn-session').hidden = true;
    $('#learn-empty-text').textContent = state.learn.dueAtStart > 20
      ? t('learn.sessionCompleteOf', { n: state.learn.sessionTotal, total: state.learn.dueAtStart })
      : t('learn.sessionComplete', { n: state.learn.sessionTotal });
    $('#btn-learn-again').hidden = false;
    $('#learn-empty').hidden = false;
    return;
  }

  const cardId = queue[0];
  const card = await getCard(cardId);
  if (!card) { queue.shift(); return showNextCard(); }

  const direction = state.learn.directions[cardId] || 'wt';
  const deck = state.learn.deck || {};
  const wordLang = deck.wordLang || 'pl-PL';
  const translationLang = deck.translationLang || 'ru-RU';
  const front = direction === 'tw' ? card.translation : card.word;
  const back = direction === 'tw' ? card.word : card.translation;
  const frontLang = direction === 'tw' ? translationLang : wordLang;
  const backLang = direction === 'tw' ? wordLang : translationLang;

  state.learn.current = { id: cardId, front, back, frontLang, backLang };
  state.learn.revealed = false;
  state.learn.hasRevealedOnce = false;

  $('#session-progress').textContent = t('learn.progressLabel', { n: new Set(queue).size });
  renderCardFace();
}

/** Отрисовывает текущую сторону карточки (лицевую или обратную) согласно state.learn.revealed. */
function renderCardFace() {
  const cur = state.learn.current;
  if (!cur) return;
  const revealed = state.learn.revealed;

  $('#card-front-text').textContent = cur.front;
  $('#card-back-text').textContent = cur.back;
  $('#card-front-text').hidden = revealed;
  $('#card-back-text').hidden = !revealed;
  $('#card-tap-hint').textContent = revealed ? t('learn.tapToFlipBack') : t('learn.tapToFlip');
  $('#card-tap-hint').hidden = false;
  $('#flip-card').setAttribute('aria-label', t('learn.cardAriaLabel', { text: revealed ? cur.back : cur.front }));
  // Пока карточка не перевёрнута ни разу — печатей "знал/не знал" ещё не видно,
  // но дальше при перелистывании туда-обратно они остаются на месте
  $('#stamp-row').hidden = !state.learn.hasRevealedOnce;
  applyDeleteButtonPosition();
}

function flipCurrentCard() {
  if (!state.learn.current) return;
  state.learn.revealed = !state.learn.revealed;
  if (state.learn.revealed) state.learn.hasRevealedOnce = true;
  renderCardFace();
}

$('#flip-card').addEventListener('click', flipCurrentCard);
$('#flip-card').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault(); // чтобы пробел не прокручивал страницу
    flipCurrentCard();
  }
});

$('#card-speak-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const cur = state.learn.current;
  if (!cur || !SPEECH_SUPPORTED) return;
  const text = state.learn.revealed ? cur.back : cur.front;
  const lang = state.learn.revealed ? cur.backLang : cur.frontLang;
  speakOnce(text, lang);
});

async function answerCurrent(correct) {
  const cur = state.learn.current;
  if (!cur) return;

  // Интервал повторения обновляем только по ПЕРВОЙ попытке за сессию —
  // иначе при "повторяем, пока не выучишь" итог всегда почти положительный
  // (последний ответ), и по-настоящему сложные слова не отличались бы от
  // выученных с первого раза.
  if (!state.learn.scoredCards.has(cur.id)) {
    await updateCardProgress(cur.id, correct);
    state.learn.scoredCards.add(cur.id);
  }

  const { queue } = state.learn;
  if (queue[0] === cur.id) {
    queue.shift();
    if (!correct) queue.push(cur.id); // не знал — вернём в конец очереди
  }
  toast(correct ? t('learn.answerKnowToast') : t('learn.answerDontKnowToast'));
  await showNextCard();
}

$('#btn-know').addEventListener('click', () => answerCurrent(true));
$('#btn-dont-know').addEventListener('click', () => answerCurrent(false));
$('#btn-learn-again').addEventListener('click', renderLearnSetup);

async function deleteCurrentLearnCard() {
  const cur = state.learn.current;
  if (!cur) return;
  const fullCard = await getCard(cur.id);
  await deleteCard(cur.id);

  const { queue } = state.learn;
  if (queue[0] === cur.id) queue.shift();
  // удалённая карточка никогда не будет "выучена" — не учитываем её в итоговом счёте сессии
  if (state.learn.sessionTotal > 0) state.learn.sessionTotal -= 1;

  toast(t('learn.deletedToast'), {
    undoLabel: t('common.undo'),
    onUndo: async () => {
      if (fullCard) await restoreCard(fullCard);
      toast(t('common.restoredToast'));
    },
  });
  await showNextCard();
}

function handleDeleteCardClick() {
  const cur = state.learn.current;
  if (!cur) return;

  if (!state.settings.confirmDeleteCard) {
    deleteCurrentLearnCard();
    return;
  }

  askConfirm(
    t('cards.deleteConfirmTitle'),
    t('learn.deleteConfirmText', { front: cur.front, back: cur.back }),
    t('common.delete'),
    deleteCurrentLearnCard
  );
}

$('#card-delete-btn-top').addEventListener('click', handleDeleteCardClick);
$('#card-delete-btn-bottom').addEventListener('click', handleDeleteCardClick);

async function openEditFromLearn() {
  const cur = state.learn.current;
  if (!cur) return;
  const card = await getCard(cur.id);
  if (!card) return;

  openEditCardModal(card, async () => {
    // Карточка сохранена — обновляем то, что уже показано на экране, без перезапуска сессии
    const updated = await getCard(cur.id);
    if (!updated) return;
    const direction = state.learn.directions[cur.id] || 'wt';
    const front = direction === 'tw' ? updated.translation : updated.word;
    const back = direction === 'tw' ? updated.word : updated.translation;
    state.learn.current = { ...cur, front, back };
    $('#card-front-text').textContent = front;
    $('#card-back-text').textContent = back;
  });
}

$('#card-edit-btn-top').addEventListener('click', openEditFromLearn);
$('#card-edit-btn-bottom').addEventListener('click', openEditFromLearn);

/* ---------------------------------------------------------------------- *
 * Слушать (озвучка карточек подряд)
 * ---------------------------------------------------------------------- */

const SPEECH_SUPPORTED = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

/** Разово озвучивает один кусок текста (используется кнопкой 🔊 на карточке в «Учить»). */
function speakOnce(text, lang) {
  if (!SPEECH_SUPPORTED || !text) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  speechSynthesis.speak(utter);
}

async function renderListenSetup() {
  // если сессия уже идёт (например, вернулись на вкладку) — не сбрасываем её
  if (state.listen.sessionActive) return;

  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);

  $('#listen-session').hidden = true;
  $('#listen-empty').hidden = true;
  $('#listen-setup').hidden = false;
  $('#listen-deck-info').textContent = t('listen.deckInfo', { name: deck.name, count: cards.length });

  if (!SPEECH_SUPPORTED) {
    $('#listen-setup').hidden = true;
    $('#listen-empty-text').textContent = t('listen.notSupportedText');
    $('#btn-listen-again').hidden = true;
    $('#listen-empty').hidden = false;
    return;
  }

  if (cards.length === 0) {
    $('#listen-setup').hidden = true;
    $('#listen-empty-text').textContent = t('listen.noCardsText', { name: deck.name });
    $('#btn-listen-again').hidden = true;
    $('#listen-empty').hidden = false;
  }
}

$('#btn-start-listen').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  if (cards.length === 0) return;

  const shuffle = $('#listen-shuffle').checked;
  const repeat = $('#listen-repeat').checked;

  const speaker = new CardSpeaker();
  speaker.onCardStart = (pos, card) => {
    $('#listen-progress').textContent = `${pos + 1} / ${speaker.total}`;
    $('#listen-word-text').textContent = card.word;
    $('#listen-translation-text').textContent = card.translation;
  };
  speaker.onFinished = () => {
    state.listen.sessionActive = false;
    $('#listen-session').hidden = true;
    $('#listen-empty-text').textContent = t('listen.finishedText', { n: speaker.total });
    $('#btn-listen-again').hidden = false;
    $('#listen-empty').hidden = false;
  };

  state.listen.speaker = speaker;
  state.listen.deck = deck;
  state.listen.sessionActive = true;

  speaker.load(cards, { shuffle, repeat });

  $('#listen-setup').hidden = true;
  $('#listen-empty').hidden = true;
  $('#listen-session').hidden = false;
  $('#btn-listen-playpause').textContent = '⏸';

  speaker.play(deck.wordLang, deck.translationLang);
});

$('#btn-listen-again').addEventListener('click', renderListenSetup);

$('#btn-listen-playpause').addEventListener('click', () => {
  const speaker = state.listen.speaker;
  const deck = state.listen.deck;
  if (!speaker) return;
  if (speaker.isPlaying) {
    speaker.pause();
    $('#btn-listen-playpause').textContent = '▶';
  } else {
    speaker.play(deck.wordLang, deck.translationLang);
    $('#btn-listen-playpause').textContent = '⏸';
  }
});

$('#btn-listen-next').addEventListener('click', () => {
  const speaker = state.listen.speaker;
  const deck = state.listen.deck;
  if (!speaker) return;
  speaker.next(deck.wordLang, deck.translationLang);
});

$('#btn-listen-prev').addEventListener('click', () => {
  const speaker = state.listen.speaker;
  const deck = state.listen.deck;
  if (!speaker) return;
  speaker.prev(deck.wordLang, deck.translationLang);
});

$('#btn-listen-stop').addEventListener('click', () => {
  const speaker = state.listen.speaker;
  if (speaker) speaker.pause();
  state.listen.sessionActive = false;
  renderListenSetup();
});

$('#listen-edit-btn').addEventListener('click', async () => {
  const speaker = state.listen.speaker;
  if (!speaker) return;
  const card = speaker.currentCard;
  if (!card) return;

  // Ставим на паузу сразу — иначе озвучка в фоне уйдёт на следующую карточку,
  // пока открыто окно редактирования
  const wasPlaying = speaker.isPlaying;
  speaker.pause();
  $('#btn-listen-playpause').textContent = '▶';

  const fresh = await getCard(card.id);
  if (!fresh) return;

  openEditCardModal(fresh, async () => {
    const updated = await getCard(card.id);
    if (!updated) return;
    speaker.updateCardData(card.id, { word: updated.word, translation: updated.translation });
    $('#listen-word-text').textContent = updated.word;
    $('#listen-translation-text').textContent = updated.translation;

    if (wasPlaying) {
      const deck = state.listen.deck;
      speaker.play(deck.wordLang, deck.translationLang);
      $('#btn-listen-playpause').textContent = '⏸';
    }
  });
});

$('#listen-delete-btn').addEventListener('click', () => {
  const speaker = state.listen.speaker;
  if (!speaker) return;
  const card = speaker.currentCard;
  if (!card) return;

  // Ставим на паузу сразу — иначе озвучка в фоне уйдёт на следующую карточку,
  // пока открыто окно подтверждения
  const wasPlaying = speaker.isPlaying;
  speaker.pause();
  $('#btn-listen-playpause').textContent = '▶';

  const doDelete = async () => {
    const deck = state.listen.deck;
    const cardSnapshot = { deckId: card.deckId, word: card.word, translation: card.translation, box: card.box, nextReview: card.nextReview, createdAt: card.createdAt };
    await deleteCard(card.id);
    const wasCurrent = speaker.removeCard(card.id);
    toast(t('listen.deletedToast'), {
      undoLabel: t('common.undo'),
      onUndo: async () => {
        await restoreCard(cardSnapshot);
        toast(t('common.restoredToast'));
      },
    });

    if (speaker.total === 0) {
      state.listen.sessionActive = false;
      $('#listen-session').hidden = true;
      $('#listen-empty-text').textContent = t('listen.emptyAfterDeleteText');
      $('#btn-listen-again').hidden = true;
      $('#listen-empty').hidden = false;
      return;
    }

    if (wasCurrent && !wasPlaying) {
      const c = speaker.currentCard;
      $('#listen-progress').textContent = `${speaker.position + 1} / ${speaker.total}`;
      $('#listen-word-text').textContent = c.word;
      $('#listen-translation-text').textContent = c.translation;
    }
    if (wasPlaying) {
      speaker.play(deck.wordLang, deck.translationLang);
      $('#btn-listen-playpause').textContent = '⏸';
    }
  };

  if (!state.settings.confirmDeleteCard) {
    doDelete();
    return;
  }
  askConfirm(t('cards.deleteConfirmTitle'), t('listen.deleteConfirmText', { word: card.word, translation: card.translation }), t('common.delete'), doDelete);
});

/* ---------------------------------------------------------------------- *
 * Статистика
 * ---------------------------------------------------------------------- */

async function renderStats() {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { total, due } = await countCards(deckId);

  $('#stats-deck-name').textContent = t('stats.deckName', { name: deck.name });
  $('#stat-grid').innerHTML = `
    <div class="stat-row"><span class="stat-label">${escapeHtml(t('stats.totalLabel'))}</span><span class="stat-value">${total}</span></div>
    <div class="stat-row"><span class="stat-label">${escapeHtml(t('stats.dueLabel'))}</span><span class="stat-value">${due}</span></div>
  `;
}

/* ---------------------------------------------------------------------- *
 * Настройки
 * ---------------------------------------------------------------------- */

async function loadSettings() {
  const confirmDelete = await getSetting('confirmDeleteCard');
  const delPos = await getSetting('deleteButtonPosition');
  const appLang = await getSetting('appLanguage');
  state.settings.confirmDeleteCard = confirmDelete === null ? true : !!confirmDelete;
  state.settings.deleteButtonPosition = delPos === null ? 'top' : delPos;
  state.settings.appLanguage = appLang === null ? 'ru' : appLang;
  setLang(state.settings.appLanguage);
}

function renderSettingsView() {
  $('#setting-confirm-delete').checked = state.settings.confirmDeleteCard;
  $('#setting-delpos-top').checked = state.settings.deleteButtonPosition === 'top';
  $('#setting-delpos-stamps').checked = state.settings.deleteButtonPosition === 'stamps';
  $('#setting-lang-ru').checked = state.settings.appLanguage === 'ru';
  $('#setting-lang-en').checked = state.settings.appLanguage === 'en';
  $('#setting-lang-pl').checked = state.settings.appLanguage === 'pl';
}

/** Показывает верхние/нижние кнопки удаления и редактирования согласно настройке и состоянию карточки. */
function applyDeleteButtonPosition() {
  const isTop = state.settings.deleteButtonPosition !== 'stamps';
  const revealed = !!state.learn.revealed;
  $('#card-delete-btn-top').hidden = !isTop;
  $('#card-delete-btn-bottom').hidden = isTop;
  // Кнопку редактирования показываем только когда виден ответ (карточка перевёрнута)
  $('#card-edit-btn-top').hidden = !isTop || !revealed;
  $('#card-edit-btn-bottom').hidden = isTop || !revealed;
}

$('#setting-confirm-delete').addEventListener('change', async (e) => {
  state.settings.confirmDeleteCard = e.target.checked;
  await setSetting('confirmDeleteCard', e.target.checked);
});

$('#setting-delpos-top').addEventListener('change', async () => {
  state.settings.deleteButtonPosition = 'top';
  await setSetting('deleteButtonPosition', 'top');
  applyDeleteButtonPosition();
});
$('#setting-delpos-stamps').addEventListener('change', async () => {
  state.settings.deleteButtonPosition = 'stamps';
  await setSetting('deleteButtonPosition', 'stamps');
  applyDeleteButtonPosition();
});

async function changeAppLanguage(lang) {
  state.settings.appLanguage = lang;
  setLang(lang);
  await setSetting('appLanguage', lang);
  applyStaticTranslations();
  // перерисовываем текущий экран, чтобы динамический текст тоже обновился сразу
  showView(state.currentView || 'settings');
}

$('#setting-lang-ru').addEventListener('change', () => changeAppLanguage('ru'));
$('#setting-lang-en').addEventListener('change', () => changeAppLanguage('en'));
$('#setting-lang-pl').addEventListener('change', () => changeAppLanguage('pl'));

/* ---------------------------------------------------------------------- *
 * Общая инициализация
 * ---------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$all('.tab-btn').forEach((btn) => btn.addEventListener('click', () => showView(btn.dataset.target)));

$all('[data-close]').forEach((btn) => btn.addEventListener('click', closeModal));
$('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

$('#confirm-action-btn').addEventListener('click', async () => {
  const btn = $('#confirm-action-btn');
  if (btn.disabled) return; // защита от повторного клика, пока выполняется действие
  btn.disabled = true;
  const fn = state.pendingConfirm;
  try {
    closeModal();
    if (fn) await fn();
  } finally {
    btn.disabled = false;
  }
});

async function initApp() {
  try {
    await ensureActiveDeck();
    await loadSettings();  // внутри уже вызывает setLang() с сохранённым языком
  } catch (err) {
    console.error('Storage init failed:', err);
    showStorageError();
    return;
  }
  applyStaticTranslations();
  applyDeleteButtonPosition();
  showView('decks');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

function showStorageError() {
  // язык мог не успеть загрузиться — используем язык браузера как лучшее приближение
  const browserLang = (navigator.language || 'ru').slice(0, 2);
  setLang(['ru', 'en', 'pl'].includes(browserLang) ? browserLang : 'ru');
  applyStaticTranslations();
  $('#app').hidden = true;
  $('#storage-error-screen').hidden = false;
}

$('#storage-error-retry').addEventListener('click', () => {
  $('#storage-error-screen').hidden = true;
  $('#app').hidden = false;
  initApp();
});

window.addEventListener('DOMContentLoaded', initApp);
