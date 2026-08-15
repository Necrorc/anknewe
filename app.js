/*
 * app.js — UI-логика: переключение экранов, колоды, список карточек,
 * импорт CSV/JSON, сессия обучения с повтором до полного выучивания.
 */

const state = {
  activeDeckId: null,
  learn: {
    queue: [],           // очередь id карточек в текущей сессии
    directions: {},       // id -> 'wt' | 'tw'
    sessionTotal: 0,
    current: null,        // карточка, которая сейчас показана
    revealed: false,
  },
  pendingConfirm: null,   // функция, которая выполнится по подтверждению в модалке
};

/* ---------------------------------------------------------------------- *
 * Утилиты интерфейса
 * ---------------------------------------------------------------------- */

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function showView(name) {
  $all('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  $all('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.target === name));
  if (name === 'decks') renderDecks();
  if (name === 'cards') renderCards();
  if (name === 'learn') renderLearnSetup();
  if (name === 'stats') renderStats();
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

function openModal(id) {
  $('#modal-backdrop').hidden = false;
  $all('.modal').forEach((m) => (m.hidden = m.id !== id));
}
function closeModal() {
  $('#modal-backdrop').hidden = true;
  state.pendingConfirm = null;
}

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

async function renderDecks() {
  const decks = await getAllDecks();
  const activeId = await ensureActiveDeck();
  state.activeDeckId = activeId;

  const palette = ['#C9974A', '#4F7A63', '#B5493C', '#5C7DA6', '#8A6FAE', '#B08A3E'];
  const list = $('#deck-list');
  list.innerHTML = '';

  decks.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'deck-row' + (d.id === activeId ? ' is-active' : '');
    row.style.setProperty('--deck-color', palette[i % palette.length]);
    row.innerHTML = `
      <div class="deck-main">
        <div class="deck-name">${d.id === activeId ? '<span class="star">★</span>' : ''}${escapeHtml(d.name)}</div>
        <div class="deck-count">${d.cardCount} карточек</div>
      </div>
      <button class="deck-del" data-id="${d.id}" data-name="${escapeHtml(d.name)}">🗑</button>
    `;
    row.querySelector('.deck-main').addEventListener('click', async () => {
      await setActiveDeck(d.id);
      toast(`Активная колода: «${d.name}»`);
      renderDecks();
    });
    row.querySelector('.deck-del').addEventListener('click', (e) => {
      e.stopPropagation();
      askConfirm(
        'Удалить колоду?',
        `Колода «${d.name}» и все ${d.cardCount} карточек в ней будут удалены безвозвратно.`,
        'Удалить',
        async () => {
          await deleteDeck(d.id);
          await ensureActiveDeck();
          toast(`Колода «${d.name}» удалена`);
          renderDecks();
        }
      );
    });
    list.appendChild(row);
  });
}

$('#btn-new-deck').addEventListener('click', () => {
  $('#input-new-deck-name').value = '';
  openModal('modal-new-deck');
  setTimeout(() => $('#input-new-deck-name').focus(), 50);
});

$('#confirm-new-deck').addEventListener('click', async () => {
  const name = $('#input-new-deck-name').value.trim();
  if (!name) { toast('Название не может быть пустым'); return; }
  const id = await createDeck(name);
  await setActiveDeck(id);
  closeModal();
  toast(`Колода «${name}» создана`);
  renderDecks();
});

/* ---------------------------------------------------------------------- *
 * Список карточек активной колоды
 * ---------------------------------------------------------------------- */

async function renderCards() {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const cards = await getCardsByDeck(deckId);

  $('#cards-deck-name').textContent = deck.name;
  $('#cards-count-sub').textContent = `${cards.length} карточек`;

  const list = $('#entry-list');
  list.innerHTML = '';

  if (cards.length === 0) {
    list.innerHTML = `<div class="empty-hint">В этой колоде пока нет карточек.<br>Добавь первую или импортируй файл.</div>`;
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
      <span class="entry-box">ур.${c.box}</span>
      <button class="entry-del" data-id="${c.id}">✕</button>
    `;
    row.querySelector('.entry-del').addEventListener('click', () => {
      askConfirm('Удалить карточку?', `«${c.word}» → «${c.translation}»`, 'Удалить', async () => {
        await deleteCard(c.id);
        toast('Карточка удалена');
        renderCards();
      });
    });
    list.appendChild(row);
  });
}

$('#btn-add-card').addEventListener('click', () => {
  $('#input-card-word').value = '';
  $('#input-card-translation').value = '';
  openModal('modal-add-card');
  setTimeout(() => $('#input-card-word').focus(), 50);
});

$('#confirm-add-card').addEventListener('click', async () => {
  const word = $('#input-card-word').value.trim();
  const translation = $('#input-card-translation').value.trim();
  if (!word || !translation) { toast('Заполни оба поля'); return; }
  const deckId = await ensureActiveDeck();
  const added = await addCard(deckId, word, translation);
  closeModal();
  toast(added ? 'Карточка добавлена' : 'Такая карточка уже есть — пропущено');
  renderCards();
});

$('#btn-dedup').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const removed = await dedupDeck(deckId);
  toast(removed ? `Удалено дублей: ${removed}` : 'Дублей не найдено');
  renderCards();
});

$('#btn-delete-all').addEventListener('click', async () => {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { total } = await countCards(deckId);
  if (total === 0) { toast('В колоде и так нет карточек'); return; }
  askConfirm(
    'Очистить колоду?',
    `Все ${total} карточек в колоде «${deck.name}» будут удалены безвозвратно. Другие колоды это не затронет.`,
    'Удалить всё',
    async () => {
      const n = await deleteAllCardsInDeck(deckId);
      toast(`Удалено карточек: ${n}`);
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
    toast('Не получилось разобрать файл: ' + err.message);
    return;
  }
  if (pairs.length === 0) {
    toast('В файле не нашлось пар слово/перевод');
    return;
  }
  const deckId = await ensureActiveDeck();
  const { added, skipped } = await addCardsBulk(deckId, pairs);
  toast(`Добавлено: ${added}${skipped ? `, пропущено дублей: ${skipped}` : ''}`);
  renderCards();
});

function parseCsvPairs(text) {
  const sample = text.slice(0, 200);
  const delim = (sample.match(/;/g) || []).length >= (sample.match(/,/g) || []).length ? ';' : ',';
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let rows = lines.map((line) => splitCsvLine(line, delim));

  if (rows.length) {
    const header = rows[0].map((c) => c.trim().toLowerCase());
    const headerWords = ['word', 'слово', 'front', 'translation', 'перевод', 'back'];
    if (header.length >= 2 && (headerWords.includes(header[0]) || headerWords.includes(header[1]))) {
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

function splitCsvLine(line, delim) {
  // простой разбор CSV-строки с поддержкой кавычек
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
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
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { due } = await countCards(deckId);

  $('#learn-session').hidden = true;
  $('#learn-empty').hidden = true;
  $('#learn-setup').hidden = false;
  $('#learn-deck-info').textContent = `Колода «${deck.name}» · к повторению: ${due}`;

  $all('.btn-direction').forEach((b) => (b.onclick = () => startLearnSession(b.dataset.dir)));

  if (due === 0) {
    $('#learn-setup').hidden = true;
    $('#learn-empty-text').textContent =
      `В колоде «${deck.name}» сейчас нет карточек, которые пора повторить. 🎉\nДобавь новые или загляни позже.`;
    $('#btn-learn-again').hidden = true;
    $('#learn-empty').hidden = false;
  }
}

async function startLearnSession(mode) {
  const deckId = await ensureActiveDeck();
  const due = await getDueCards(deckId, 20);
  if (due.length === 0) { renderLearnSetup(); return; }

  const ids = due.map((c) => c.id);
  const directions = {};
  for (const id of ids) {
    directions[id] = mode === 'mix' ? (Math.random() < 0.5 ? 'wt' : 'tw') : mode;
  }

  state.learn.queue = ids;
  state.learn.directions = directions;
  state.learn.sessionTotal = ids.length;

  $('#learn-setup').hidden = true;
  $('#learn-empty').hidden = true;
  $('#learn-session').hidden = false;

  await showNextCard();
}

async function showNextCard() {
  const { queue } = state.learn;
  if (queue.length === 0) {
    $('#learn-session').hidden = true;
    $('#learn-empty-text').textContent = `Сессия повторения завершена!\nВыучено карточек: ${state.learn.sessionTotal} 👏`;
    $('#btn-learn-again').hidden = false;
    $('#learn-empty').hidden = false;
    return;
  }

  const cardId = queue[0];
  const card = await getCard(cardId);
  if (!card) { queue.shift(); return showNextCard(); }

  const direction = state.learn.directions[cardId] || 'wt';
  const front = direction === 'tw' ? card.translation : card.word;
  const back = direction === 'tw' ? card.word : card.translation;

  state.learn.current = { id: cardId, front, back };
  state.learn.revealed = false;

  $('#session-progress').textContent = `осталось выучить: ${new Set(queue).size}`;
  $('#card-front-text').textContent = front;
  $('#card-front-text').hidden = false;
  $('#card-back-text').hidden = true;
  $('#card-tap-hint').hidden = false;
  $('#stamp-row').hidden = true;
}

$('#flip-card').addEventListener('click', () => {
  if (!state.learn.current || state.learn.revealed) return;
  state.learn.revealed = true;
  $('#card-back-text').textContent = state.learn.current.back;
  $('#card-front-text').hidden = true;
  $('#card-back-text').hidden = false;
  $('#card-tap-hint').hidden = true;
  $('#stamp-row').hidden = false;
});

async function answerCurrent(correct) {
  const cur = state.learn.current;
  if (!cur) return;
  await updateCardProgress(cur.id, correct);

  const { queue } = state.learn;
  if (queue[0] === cur.id) {
    queue.shift();
    if (!correct) queue.push(cur.id); // не знал — вернём в конец очереди
  }
  toast(correct ? '✓ Знал' : '✗ Повторим ещё раз в этой сессии');
  await showNextCard();
}

$('#btn-know').addEventListener('click', () => answerCurrent(true));
$('#btn-dont-know').addEventListener('click', () => answerCurrent(false));
$('#btn-learn-again').addEventListener('click', renderLearnSetup);

/* ---------------------------------------------------------------------- *
 * Статистика
 * ---------------------------------------------------------------------- */

async function renderStats() {
  const deckId = await ensureActiveDeck();
  const deck = await getDeck(deckId);
  const { total, due } = await countCards(deckId);

  $('#stats-deck-name').textContent = `Колода «${deck.name}»`;
  $('#stat-grid').innerHTML = `
    <div class="stat-row"><span class="stat-label">Всего карточек</span><span class="stat-value">${total}</span></div>
    <div class="stat-row"><span class="stat-label">Готово к повторению</span><span class="stat-value">${due}</span></div>
  `;
}

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
  const fn = state.pendingConfirm;
  closeModal();
  if (fn) await fn();
});

window.addEventListener('DOMContentLoaded', async () => {
  await ensureActiveDeck();
  showView('decks');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});
