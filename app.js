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
    deckIds: [],            // из каких колод набрана сессия (может быть несколько — режим "Учить всё")
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
    theme: 'system',              // 'system' | 'light' | 'dark'
    dailyGoal: 20,                 // сколько карточек в день считается выполненной целью
    reminderEnabled: false,
    reminderTime: '20:00',
  },
  reminderCheckTimer: null,
  pendingShareImport: null,       // данные колоды из #import=... в ссылке, ждущие подтверждения
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

/** Обновляет плашку серии дней и полосу дневной цели (экран "Колоды"), и краткую
 * строку прогресса на экране "Учить" — везде используется общий счётчик за сегодня. */
async function renderDailyGoalUI() {
  const goal = state.settings.dailyGoal;
  const todayCount = await getTodayReviewCount();
  const streak = (await getSetting('streak')) || { current: 0, longest: 0, lastCompletedDate: null };

  const streakBadge = $('#streak-badge');
  const streakText = $('#streak-text');
  if (streakBadge && streakText) {
    if (streak.current > 0) {
      streakText.textContent = t('decks.streakText', { n: streak.current });
      streakBadge.hidden = false;
    } else {
      streakBadge.hidden = true;
    }
  }

  const goalLabel = $('#daily-goal-label');
  const goalFill = $('#daily-goal-fill');
  if (goalLabel && goalFill) {
    goalLabel.textContent = t('decks.dailyGoalLabel', { count: todayCount, goal });
    goalFill.style.width = Math.min(100, Math.round((todayCount / goal) * 100)) + '%';
  }

  const learnGoalInline = $('#learn-daily-goal-inline');
  if (learnGoalInline) {
    learnGoalInline.textContent = t('learn.dailyGoalProgress', { count: todayCount, goal });
  }
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
  await renderDailyGoalUI();
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
    const tags = c.tags || [];
    const tagsHtml = tags.length
      ? `<div class="entry-tags">${tags.map((tg) => `<span class="tag-chip">${escapeHtml(tg)}</span>`).join('')}</div>`
      : '';
    row.innerHTML = `
      <span class="entry-num">${i + 1}</span>
      <span class="entry-word">${escapeHtml(c.word)}</span>
      <span class="entry-arrow">→</span>
      <span class="entry-translation">${escapeHtml(c.translation)}</span>
      <span class="entry-box">${escapeHtml(t('cards.levelLabel', { n: c.box }))}</span>
      <button class="entry-edit" data-id="${c.id}">✏️</button>
      <button class="entry-del" data-id="${c.id}">✕</button>
      ${tagsHtml}
    `;
    row.querySelector('.entry-edit').addEventListener('click', () => openEditCardModal(c));
    row.querySelector('.entry-del').addEventListener('click', () => {
      askConfirm(t('cards.deleteConfirmTitle'), `«${c.word}» → «${c.translation}»`, t('common.delete'), async () => {
        const cardSnapshot = { deckId: c.deckId, word: c.word, translation: c.translation, box: c.box, nextReview: c.nextReview, createdAt: c.createdAt, tags: c.tags };
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
  $('#input-edit-card-tags').value = (card.tags || []).join(', ');
  openModal('modal-edit-card');
  setTimeout(() => $('#input-edit-card-word').focus(), 50);
}

$('#confirm-edit-card').addEventListener('click', async () => {
  const word = $('#input-edit-card-word').value.trim();
  const translation = $('#input-edit-card-translation').value.trim();
  const tags = $('#input-edit-card-tags').value;
  if (!word || !translation) { toast(t('cards.fillBothToast')); return; }

  const ok = await updateCard(editingCardId, word, translation, tags);
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
  $('#input-card-tags').value = '';
  openModal('modal-add-card');
  setTimeout(() => $('#input-card-word').focus(), 50);
});

$('#confirm-add-card').addEventListener('click', async () => {
  const word = $('#input-card-word').value.trim();
  const translation = $('#input-card-translation').value.trim();
  const tags = $('#input-card-tags').value;
  if (!word || !translation) { toast(t('cards.fillBothToast')); return; }
  const deckId = await ensureActiveDeck();
  const added = await addCard(deckId, word, translation, tags);
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

  // Полный бэкап (.kdeck.json, схема с прогрессом) — определяем по содержимому,
  // а не по расширению файла, т.к. это тоже .json. Обычный импорт (только
  // слово+перевод, без схемы) как работал, так и работает — веткой ниже.
  let backupData = null;
  try {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.schemaVersion && Array.isArray(parsed.cards)) backupData = parsed;
    }
  } catch (err) { /* не JSON или не та схема — пойдёт по обычной ветке импорта ниже */ }

  if (backupData) {
    toast(t('import.fullBackupDetected'), { duration: 3800 });
    const deckId = await ensureActiveDeck();
    const { added, skipped } = await importFullBackupCards(deckId, backupData.cards);
    toast(t('import.fullBackupAddedToast', { added }) + (skipped ? t('import.skippedSuffix', { skipped }) : ''), { duration: 3800 });
    renderCards();
    return;
  }

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

/* --- Полный бэкап (.kdeck.json) — с прогрессом (уровни, даты повторения, теги) ------- */

$('#export-full-backup').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  const backup = {
    schemaVersion: 1,
    name: deck.name,
    wordLang: deck.wordLang,
    translationLang: deck.translationLang,
    cards: cards.map((c) => ({
      word: c.word, translation: c.translation, box: c.box, nextReview: c.nextReview, tags: c.tags || [],
    })),
    exportedAt: new Date().toISOString(),
  };
  downloadFile(`${sanitizeFilename(deck.name)}.kdeck.json`, JSON.stringify(backup, null, 2), 'application/json');
  closeModal();
  toast(t('export.backupDownloadedToast', { n: cards.length }), { duration: 3800 });
});

/* --- Шаринг колоды по ссылке (без бэкенда — данные прямо в URL) --------------------- */

function arrayBufferToBase64Url(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToArrayBuffer(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function compressToBase64Url(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return arrayBufferToBase64Url(buf);
}

async function decompressFromBase64Url(b64url) {
  const buf = base64UrlToArrayBuffer(b64url);
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  const outBuf = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(outBuf));
}

const SHARE_LINK_MAX_LENGTH = 1800; // безопасный предел длины URL для мессенджеров/адресной строки

$('#export-share-link').addEventListener('click', async () => {
  if (typeof CompressionStream === 'undefined') {
    toast(t('shareLink.unsupportedToast'), { duration: 3800 });
    return;
  }
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);
  // Без прогресса — только то, что нужно, чтобы получатель мог начать учить с нуля
  const payload = {
    schemaVersion: 1,
    name: deck.name,
    wordLang: deck.wordLang,
    translationLang: deck.translationLang,
    cards: cards.map((c) => ({ word: c.word, translation: c.translation, tags: c.tags || [] })),
  };

  let encoded;
  try {
    encoded = await compressToBase64Url(payload);
  } catch (err) {
    toast(t('shareLink.unsupportedToast'), { duration: 3800 });
    return;
  }

  const url = `${location.origin}${location.pathname}#import=${encoded}`;
  if (url.length > SHARE_LINK_MAX_LENGTH) {
    toast(t('shareLink.tooLongToast'), { duration: 4500 });
    return;
  }

  closeModal();
  $('#share-link-output').value = url;
  openModal('modal-share-link');
});

$('#share-link-copy').addEventListener('click', async () => {
  const url = $('#share-link-output').value;
  try {
    await navigator.clipboard.writeText(url);
  } catch (err) {
    $('#share-link-output').select();
    try { document.execCommand('copy'); } catch (err2) { /* совсем без буфера обмена — ссылка уже видна в поле */ }
  }
  toast(t('shareLink.copiedToast'));
});

/** Проверяет #import=... в адресе при открытии приложения (переход по ссылке шаринга) —
 * данные никуда не отправляются, всё уже лежит прямо в самом URL. */
async function checkForShareImportInUrl() {
  const hash = location.hash;
  if (!hash.startsWith('#import=')) return;
  const encoded = hash.slice('#import='.length);
  if (!encoded) return;

  if (typeof DecompressionStream === 'undefined') {
    toast(t('shareLink.unsupportedToast'), { duration: 4500 });
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  let payload;
  try {
    payload = await decompressFromBase64Url(encoded);
    if (!payload || !Array.isArray(payload.cards)) throw new Error('bad payload');
  } catch (err) {
    toast(t('shareLink.invalidToast'), { duration: 4500 });
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  history.replaceState(null, '', location.pathname + location.search); // убираем hash сразу, чтобы не сработало повторно при перезагрузке
  state.pendingShareImport = payload;
  const wordLangLabel = t('lang.' + payload.wordLang) || payload.wordLang;
  const trLangLabel = t('lang.' + payload.translationLang) || payload.translationLang;
  $('#import-link-summary').textContent = t('shareLink.importSummary', {
    name: payload.name || '—', count: payload.cards.length, wordLang: wordLangLabel, trLang: trLangLabel,
  });
  openModal('modal-import-link');
}

$('#import-link-cancel').addEventListener('click', () => { state.pendingShareImport = null; });

$('#import-link-confirm').addEventListener('click', async () => {
  const payload = state.pendingShareImport;
  if (!payload) { closeModal(); return; }
  closeModal();

  const name = (payload.name || 'Imported deck').slice(0, 60);
  const deckId = await createDeck(name, { wordLang: payload.wordLang, translationLang: payload.translationLang });
  const cardsForImport = payload.cards.map((c) => ({ word: c.word, translation: c.translation, tags: c.tags || [] }));
  const { added } = await importFullBackupCards(deckId, cardsForImport);

  stopActiveSessions();
  await setActiveDeck(deckId);
  state.pendingShareImport = null;
  toast(t('shareLink.importedToast', { name, count: added }), { duration: 3800 });
  renderDecks();
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
  await renderDailyGoalUI();

  // "Учить всё" — показываем переключатель, только если есть ещё колоды с той же языковой парой
  const sameLangDecks = await getDecksWithSameLangPair(deck.wordLang, deck.translationLang);
  const otherDecks = sameLangDecks.filter((d) => d.id !== deckId);
  const allToggleRow = $('#learn-all-toggle-row');
  const allToggle = $('#learn-all-decks-toggle');
  if (otherDecks.length > 0) {
    allToggleRow.hidden = false;
  } else {
    allToggleRow.hidden = true;
    allToggle.checked = false;
  }

  await refreshLearnTagFilter();
  allToggle.onchange = refreshLearnTagFilter;

  $all('.btn-direction').forEach((b) => (b.onclick = () => startLearnSession(b.dataset.dir)));

  if (due === 0 && !allToggle.checked) {
    $('#learn-setup').hidden = true;
    $('#learn-empty-text').textContent = t('learn.noDueText', { name: deck.name });
    $('#btn-learn-again').hidden = true;
    $('#learn-empty').hidden = false;
  }
}

/** Пересобирает список тегов в выпадающем списке фильтра сессии — либо только
 * активной колоды, либо объединённо по всем колодам с тем же языком (режим "Учить всё"). */
async function refreshLearnTagFilter() {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const useAll = $('#learn-all-decks-toggle').checked;

  let tags;
  if (useAll) {
    const sameLangDecks = await getDecksWithSameLangPair(deck.wordLang, deck.translationLang);
    const tagSet = new Set();
    for (const d of sameLangDecks) (await getAllTagsForDeck(d.id)).forEach((tg) => tagSet.add(tg));
    tags = [...tagSet].sort((a, b) => a.localeCompare(b));
  } else {
    tags = await getAllTagsForDeck(deckId);
  }

  const label = $('#learn-tag-filter-label');
  const select = $('#learn-tag-filter');
  if (tags.length === 0) {
    label.hidden = true;
    select.hidden = true;
    select.innerHTML = '';
    return;
  }
  label.hidden = false;
  select.hidden = false;
  select.innerHTML = `<option value="">${escapeHtml(t('learn.tagFilterAll'))}</option>`
    + tags.map((tg) => `<option value="${escapeHtml(tg)}">${escapeHtml(tg)}</option>`).join('');
}

async function startLearnSession(mode) {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const useAllDecks = $('#learn-all-decks-toggle').checked && !$('#learn-all-toggle-row').hidden;
  const tagFilter = $('#learn-tag-filter').hidden ? null : ($('#learn-tag-filter').value || null);

  let due, deckIds, trueDueCount;
  if (useAllDecks) {
    const sameLangDecks = await getDecksWithSameLangPair(deck.wordLang, deck.translationLang);
    deckIds = sameLangDecks.map((d) => d.id);
    due = await getDueCardsAcrossDecks(deckIds, 20, tagFilter);
    trueDueCount = due.length; // для мультиколодного режима считаем точно, без отдельного тяжёлого подсчёта
  } else {
    deckIds = [deckId];
    const counts = await countCards(deckId);
    trueDueCount = counts.due;
    due = await getDueCards(deckId, 20, tagFilter);
  }
  if (due.length === 0) { renderLearnSetup(); return; }

  const ids = due.map((c) => c.id);
  const directions = {};
  for (const id of ids) {
    directions[id] = mode === 'mix' ? (Math.random() < 0.5 ? 'wt' : 'tw') : mode;
  }

  state.learn.deck = deck; // используется для языков озвучки — у всех колод в наборе он одинаковый
  state.learn.deckIds = deckIds;
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

  state.learn.current = { id: cardId, deckId: card.deckId, front, back, frontLang, backLang };
  state.learn.revealed = false;
  state.learn.hasRevealedOnce = false;

  $('#session-progress').textContent = t('learn.progressLabel', { n: new Set(queue).size });
  renderCardFace(true);
}

/** Отрисовывает текущую сторону карточки (лицевую или обратную) согласно state.learn.revealed.
 * instant=true — для НОВОЙ карточки (после ответа): сбрасывает поворот без анимации,
 * иначе на мгновение было бы видно, как уже подставленный новый текст "доворачивается"
 * с предыдущего (перевёрнутого) состояния карточки. Обычный клик по карточке (flipCurrentCard)
 * всегда анимируется как обычно. */
function renderCardFace(instant = false) {
  const cur = state.learn.current;
  if (!cur) return;
  const revealed = state.learn.revealed;

  $('#card-front-text').textContent = cur.front;
  $('#card-back-text').textContent = cur.back;
  // Обе стороны всегда присутствуют в раскладке (нужно для 3D-переворота —
  // они наложены друг на друга и повёрнуты на 180° одна относительно другой,
  // видимость управляется через transform + backface-visibility в CSS, не
  // через display:none/hidden). Для скринридеров скрываем невидимую сторону
  // через aria-hidden, а не через "hidden", чтобы не сломать раскладку.
  $('#card-front-text').hidden = false;
  $('#card-back-text').hidden = false;
  $('#card-front-text').setAttribute('aria-hidden', revealed ? 'true' : 'false');
  $('#card-back-text').setAttribute('aria-hidden', revealed ? 'false' : 'true');

  const flipCard = $('#flip-card');
  if (instant) {
    flipCard.classList.add('no-flip-anim');
    flipCard.classList.toggle('is-flipped', revealed);
    flipCard.offsetHeight; // форсируем reflow — иначе браузер может "схлопнуть" смену transition и transform в один кадр и всё равно анимировать
    flipCard.classList.remove('no-flip-anim');
  } else {
    flipCard.classList.toggle('is-flipped', revealed);
  }

  $('#card-tap-hint').textContent = revealed ? t('learn.tapToFlipBack') : t('learn.tapToFlip');
  $('#card-tap-hint').hidden = false;
  flipCard.setAttribute('aria-label', t('learn.cardAriaLabel', { text: revealed ? cur.back : cur.front }));
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
  // выученных с первого раза. Тот же момент — единственно верный для записи
  // в журнал ответов (retention/heatmap/дневная цель): считаем реальные
  // попытки вспомнить слово, а не технические повторы одной и той же карточки.
  const isFirstAttempt = !state.learn.scoredCards.has(cur.id);
  let streakInfo = null;
  if (isFirstAttempt) {
    await updateCardProgress(cur.id, correct);
    await logReview(cur.id, cur.deckId, correct);
    state.learn.scoredCards.add(cur.id);
    streakInfo = await updateStreakIfGoalReached(state.settings.dailyGoal);
  }

  const { queue } = state.learn;
  if (queue[0] === cur.id) {
    queue.shift();
    if (!correct) queue.push(cur.id); // не знал — вернём в конец очереди
  }

  // Оба тоста одновременно не поместятся (второй вызов toast() тут же
  // перекроет первый) — приоритет отдаём редкому и приятному поздравлению
  // со стриком, обычный тост ответа в этом случае просто пропускаем.
  if (streakInfo && streakInfo.justCompleted) {
    toast(t('decks.streakText', { n: streakInfo.streak.current }), { duration: 3800 });
  } else {
    toast(correct ? t('learn.answerKnowToast') : t('learn.answerDontKnowToast'));
  }
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
    const cardSnapshot = { deckId: card.deckId, word: card.word, translation: card.translation, box: card.box, nextReview: card.nextReview, createdAt: card.createdAt, tags: card.tags };
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

  // --- Прогноз ---
  const forecast = await getForecastBuckets(deckId);
  const forecastItems = [
    ['stats.forecastToday', forecast.today],
    ['stats.forecastTomorrow', forecast.tomorrow],
    ['stats.forecastWeek', forecast.week],
    ['stats.forecastMonth', forecast.month],
    ['stats.forecastLater', forecast.later],
  ];
  $('#forecast-row').innerHTML = forecastItems.map(([key, n]) => `
    <div class="forecast-chip">
      <span class="forecast-chip-value">${n}</span>
      <span class="forecast-chip-label">${escapeHtml(t(key))}</span>
    </div>
  `).join('');

  // --- Retention ---
  const ret7 = await getRetention(deckId, 7);
  const ret30 = await getRetention(deckId, 30);
  const renderRetentionValue = (r) => r.rate === null
    ? t('stats.retentionNoData')
    : t('stats.retentionValue', { rate: Math.round(r.rate * 100), correct: r.correct, total: r.total });
  $('#retention-row').innerHTML = `
    <div class="retention-item"><span class="retention-period">${escapeHtml(t('stats.retention7d'))}</span><span class="retention-value">${escapeHtml(renderRetentionValue(ret7))}</span></div>
    <div class="retention-item"><span class="retention-period">${escapeHtml(t('stats.retention30d'))}</span><span class="retention-value">${escapeHtml(renderRetentionValue(ret30))}</span></div>
  `;

  // --- Распределение по уровням ---
  const dist = await getBoxDistribution(deckId);
  const maxLevelCount = Math.max(1, ...dist);
  $('#levels-bar').innerHTML = dist.map((n, level) => `
    <div class="level-row">
      <span class="level-label">${level}</span>
      <div class="level-track"><div class="level-fill" style="width:${Math.round((n / maxLevelCount) * 100)}%"></div></div>
      <span class="level-count">${n}</span>
    </div>
  `).join('');

  // --- Heatmap активности за 90 дней ---
  const heatmapData = await getHeatmapData(deckId, 90);
  const hasAnyActivity = Object.keys(heatmapData).length > 0;
  const heatmapGrid = $('#heatmap-grid');
  if (!hasAnyActivity) {
    heatmapGrid.innerHTML = `<p class="heatmap-empty">${escapeHtml(t('stats.heatmapEmpty'))}</p>`;
  } else {
    const maxCount = Math.max(1, ...Object.values(heatmapData));
    const days = 90;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cells = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      const key = dayKey(d);
      const count = heatmapData[key] || 0;
      const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / maxCount) * 4));
      cells.push(`<div class="heatmap-cell" data-level="${level}" title="${key}: ${count}"></div>`);
    }
    heatmapGrid.innerHTML = cells.join('');
  }
}

/* ---------------------------------------------------------------------- *
 * Настройки
 * ---------------------------------------------------------------------- */

async function loadSettings() {
  const confirmDelete = await getSetting('confirmDeleteCard');
  const delPos = await getSetting('deleteButtonPosition');
  const appLang = await getSetting('appLanguage');
  const theme = await getSetting('theme');
  const dailyGoal = await getSetting('dailyGoal');
  const reminderEnabled = await getSetting('reminderEnabled');
  const reminderTime = await getSetting('reminderTime');
  state.settings.confirmDeleteCard = confirmDelete === null ? true : !!confirmDelete;
  state.settings.deleteButtonPosition = delPos === null ? 'top' : delPos;
  state.settings.appLanguage = appLang === null ? 'ru' : appLang;
  state.settings.theme = theme === null ? 'system' : theme;
  state.settings.dailyGoal = (dailyGoal === null || !Number.isFinite(dailyGoal) || dailyGoal < 1) ? 20 : dailyGoal;
  state.settings.reminderEnabled = reminderEnabled === null ? false : !!reminderEnabled;
  state.settings.reminderTime = reminderTime === null ? '20:00' : reminderTime;
  setLang(state.settings.appLanguage);
  applyTheme(state.settings.theme);
}

/**
 * Применяет тему оформления. 'system' — ничего не форсируем, работает
 * автоматика по prefers-color-scheme из CSS; 'light'/'dark' — жёстко
 * фиксируем через [data-theme] на <html>, независимо от системных настроек
 * устройства (специфичность атрибутного селектора в CSS выше, чем у
 * ":root" внутри media-запроса, поэтому это всегда побеждает).
 */
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  // Подстраиваем цвет системной шторки/статус-бара под реально применённую тему
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const meta = $('#meta-theme-color');
  if (meta && bg) meta.setAttribute('content', bg);
}

function renderSettingsView() {
  $('#setting-confirm-delete').checked = state.settings.confirmDeleteCard;
  $('#setting-delpos-top').checked = state.settings.deleteButtonPosition === 'top';
  $('#setting-delpos-stamps').checked = state.settings.deleteButtonPosition === 'stamps';
  $('#setting-lang-ru').checked = state.settings.appLanguage === 'ru';
  $('#setting-lang-en').checked = state.settings.appLanguage === 'en';
  $('#setting-lang-pl').checked = state.settings.appLanguage === 'pl';
  $('#setting-theme-system').checked = state.settings.theme === 'system';
  $('#setting-theme-light').checked = state.settings.theme === 'light';
  $('#setting-theme-dark').checked = state.settings.theme === 'dark';
  $('#setting-daily-goal').value = state.settings.dailyGoal;
  $('#setting-reminder-enabled').checked = state.settings.reminderEnabled;
  $('#setting-reminder-time').value = state.settings.reminderTime;
  renderNotificationStatusHint();
}

function renderNotificationStatusHint() {
  const hint = $('#notification-status-hint');
  if (!hint) return;
  if (typeof Notification === 'undefined') {
    hint.textContent = t('notifications.unsupported');
  } else if (Notification.permission === 'granted') {
    hint.textContent = t('notifications.granted');
  } else if (Notification.permission === 'denied') {
    hint.textContent = t('notifications.denied');
  } else {
    hint.textContent = t('notifications.default');
  }
}

$('#setting-daily-goal').addEventListener('change', async (e) => {
  const val = Math.max(1, Math.min(500, parseInt(e.target.value, 10) || 20));
  state.settings.dailyGoal = val;
  e.target.value = val;
  await setSetting('dailyGoal', val);
  renderDailyGoalUI();
});

$('#setting-reminder-enabled').addEventListener('change', async (e) => {
  state.settings.reminderEnabled = e.target.checked;
  await setSetting('reminderEnabled', e.target.checked);
  scheduleReminderChecks();
});

$('#setting-reminder-time').addEventListener('change', async (e) => {
  state.settings.reminderTime = e.target.value || '20:00';
  await setSetting('reminderTime', state.settings.reminderTime);
});

$('#btn-request-notifications').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') { renderNotificationStatusHint(); return; }
  try {
    await Notification.requestPermission();
  } catch (err) { /* пользователь закрыл диалог и т.п. — молча игнорируем */ }
  renderNotificationStatusHint();
});

/**
 * Раз в минуту проверяет, не наступило ли время напоминания — и если да
 * (и уведомления разрешены, и сегодня ещё не показывали) — показывает
 * уведомление "Пора повторить N карточек". Работает только пока страница
 * открыта (хотя бы в фоновой вкладке) — без сервера настоящий push для
 * закрытого приложения на iOS невозможен.
 */
function scheduleReminderChecks() {
  if (state.reminderCheckTimer) { clearInterval(state.reminderCheckTimer); state.reminderCheckTimer = null; }
  if (!state.settings.reminderEnabled) return;
  const check = () => checkReminderDue();
  check();
  state.reminderCheckTimer = setInterval(check, 60 * 1000);
}

async function checkReminderDue() {
  if (!state.settings.reminderEnabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (hhmm !== state.settings.reminderTime) return;

  const todayKey = dayKey(now);
  const lastFired = await getSetting('reminderLastFiredDay');
  if (lastFired === todayKey) return; // уже показывали сегодня

  const deckId = await ensureActiveDeck();
  const { due } = await countCards(deckId);
  if (due === 0) return; // нечего повторять — не дёргаем пользователя зря

  await setSetting('reminderLastFiredDay', todayKey);
  const title = t('app.title');
  const body = t('notifications.reminderFired', { n: due });
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) { await reg.showNotification(title, { body, icon: 'icons/icon-192.png' }); return; }
    }
    new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch (err) { /* уведомления могут быть недоступны в этот момент — просто пропускаем */ }
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

async function changeTheme(theme) {
  state.settings.theme = theme;
  applyTheme(theme);
  await setSetting('theme', theme);
}

$('#setting-theme-system').addEventListener('change', () => changeTheme('system'));
$('#setting-theme-light').addEventListener('change', () => changeTheme('light'));
$('#setting-theme-dark').addEventListener('change', () => changeTheme('dark'));

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
  scheduleReminderChecks();
  checkForShareImportInUrl();

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
