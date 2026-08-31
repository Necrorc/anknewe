/*
 * db.js — вся работа с IndexedDB: колоды, карточки, активная колода,
 * интервальное повторение (тот же алгоритм SM-2 lite, что и в телеграм-боте).
 * Никакой сети — всё хранится локально на устройстве.
 */

const DB_NAME = 'flashcards_pwa';
const DB_VERSION = 1;

// Интервалы повторения (в днях) по уровню карточки (box 0..5)
const INTERVALS = { 0: 0, 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('decks')) {
        db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('cards')) {
        const store = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
        store.createIndex('by_deck', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked (another tab may be using an older version)'));
  });
  // Если открытие не удалось — не кэшируем неудачу навсегда, следующий вызов попробует снова
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function tx(storeNames, mode) {
  return openDB().then((db) => db.transaction(storeNames, mode));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const now = () => new Date().toISOString();

// Палитра цветов колод — назначается один раз при создании и хранится в записи
// колоды, а не вычисляется по индексу в списке (иначе цвет "прыгал" бы при
// удалении/пересортировке других колод).
const DECK_COLOR_PALETTE = ['#C9974A', '#4F7A63', '#B5493C', '#5C7DA6', '#8A6FAE', '#B08A3E'];

/* ---------------------------------------------------------------------- *
 * Колоды
 * ---------------------------------------------------------------------- */

async function getAllDecks() {
  const t = await tx('decks', 'readonly');
  const decks = await reqToPromise(t.objectStore('decks').getAll());
  decks.sort((a, b) => a.id - b.id);
  const withCounts = await Promise.all(
    decks.map(async (d) => ({ ...withDeckDefaults(d), cardCount: await countCardsInDeck(d.id) }))
  );
  return withCounts;
}

async function countCardsInDeck(deckId) {
  const t = await tx('cards', 'readonly');
  const idx = t.objectStore('cards').index('by_deck');
  const all = await reqToPromise(idx.getAll(IDBKeyRange.only(deckId)));
  return all.length;
}

function withLangDefaults(deck) {
  if (!deck) return deck;
  return {
    ...deck,
    wordLang: deck.wordLang || 'pl-PL',
    translationLang: deck.translationLang || 'ru-RU',
  };
}

/** Добавляет язык по умолчанию и стабильный цвет (по id, не по позиции в списке)
 * для колод, созданных до появления этих полей. */
function withDeckDefaults(deck) {
  const withLang = withLangDefaults(deck);
  if (!withLang) return withLang;
  if (withLang.color) return withLang;
  return { ...withLang, color: DECK_COLOR_PALETTE[withLang.id % DECK_COLOR_PALETTE.length] };
}

async function getDeck(id) {
  const t = await tx('decks', 'readonly');
  const deck = await reqToPromise(t.objectStore('decks').get(id));
  return withDeckDefaults(deck);
}

async function createDeck(name, opts = {}) {
  const t = await tx('decks', 'readwrite');
  const store = t.objectStore('decks');
  const existingCount = await reqToPromise(store.count());
  const color = DECK_COLOR_PALETTE[existingCount % DECK_COLOR_PALETTE.length];
  const id = await reqToPromise(store.add({
    name: name.trim().slice(0, 60),
    wordLang: opts.wordLang || 'pl-PL',
    translationLang: opts.translationLang || 'ru-RU',
    color,
    createdAt: now(),
  }));
  return id;
}

async function updateDeck(id, fields) {
  const t = await tx('decks', 'readwrite');
  const store = t.objectStore('decks');
  const deck = await reqToPromise(store.get(id));
  if (!deck) return false;
  Object.assign(deck, fields);
  store.put(deck);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return true;
}

async function deleteDeck(deckId) {
  const cards = await getCardsByDeck(deckId);
  const t = await tx(['decks', 'cards'], 'readwrite');
  for (const c of cards) t.objectStore('cards').delete(c.id);
  t.objectStore('decks').delete(deckId);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/**
 * Переносит все карточки из sourceId в targetId (пропуская дубли — те же
 * правила, что и при обычном импорте), затем удаляет исходную колоду.
 * Возвращает { moved, skipped }.
 */
async function mergeDecks(sourceId, targetId) {
  if (sourceId === targetId) return { moved: 0, skipped: 0 };
  const sourceCards = await getCardsByDeck(sourceId);
  const pairs = sourceCards.map((c) => [c.word, c.translation]);
  const { added, skipped } = await addCardsBulk(targetId, pairs);
  await deleteDeck(sourceId);
  return { moved: added, skipped };
}

async function getSetting(key) {
  const t = await tx('settings', 'readonly');
  const row = await reqToPromise(t.objectStore('settings').get(key));
  return row ? row.value : null;
}

async function setSetting(key, value) {
  const t = await tx('settings', 'readwrite');
  t.objectStore('settings').put({ key, value });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

async function ensureActiveDeck() {
  let activeId = await getSetting('activeDeckId');
  if (activeId != null) {
    const d = await getDeck(activeId);
    if (d) return activeId;
  }
  const decks = await getAllDecks();
  if (decks.length > 0) {
    await setSetting('activeDeckId', decks[0].id);
    return decks[0].id;
  }
  const newId = await createDeck('Колода 1');
  await setSetting('activeDeckId', newId);
  return newId;
}

async function setActiveDeck(deckId) {
  await setSetting('activeDeckId', deckId);
}

/* ---------------------------------------------------------------------- *
 * Карточки
 * ---------------------------------------------------------------------- */

async function getCardsByDeck(deckId) {
  const t = await tx('cards', 'readonly');
  const idx = t.objectStore('cards').index('by_deck');
  const all = await reqToPromise(idx.getAll(IDBKeyRange.only(deckId)));
  all.sort((a, b) => a.id - b.id);
  return all;
}

async function getCard(id) {
  const t = await tx('cards', 'readonly');
  return reqToPromise(t.objectStore('cards').get(id));
}

async function cardExists(deckId, word, translation) {
  const cards = await getCardsByDeck(deckId);
  const w = word.trim(), tr = translation.trim();
  return cards.some((c) => c.word === w && c.translation === tr);
}

async function addCard(deckId, word, translation) {
  if (await cardExists(deckId, word, translation)) return false;
  const t = await tx('cards', 'readwrite');
  const n = now();
  t.objectStore('cards').add({
    deckId, word: word.trim(), translation: translation.trim(),
    box: 0, nextReview: n, createdAt: n,
  });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return true;
}

async function addCardsBulk(deckId, pairs) {
  const existing = new Set((await getCardsByDeck(deckId)).map((c) => c.word + '\u0001' + c.translation));
  const seenInBatch = new Set();
  const n = now();
  const toInsert = [];
  let skipped = 0;
  for (const [wordRaw, trRaw] of pairs) {
    const word = wordRaw.trim(), translation = trRaw.trim();
    if (!word || !translation) { skipped++; continue; }
    const key = word + '\u0001' + translation;
    if (existing.has(key) || seenInBatch.has(key)) { skipped++; continue; }
    seenInBatch.add(key);
    toInsert.push({ deckId, word, translation, box: 0, nextReview: n, createdAt: n });
  }
  if (toInsert.length) {
    const t = await tx('cards', 'readwrite');
    const store = t.objectStore('cards');
    for (const c of toInsert) store.add(c);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  return { added: toInsert.length, skipped };
}

async function deleteCard(id) {
  const t = await tx('cards', 'readwrite');
  t.objectStore('cards').delete(id);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/**
 * Восстанавливает ранее удалённую карточку с теми же данными (используется
 * для отмены удаления — "Undo" в тосте). Получает новый id, но сохраняет
 * слово/перевод/колоду/уровень/дату следующего повторения.
 */
async function restoreCard(cardData) {
  const t = await tx('cards', 'readwrite');
  const id = await reqToPromise(t.objectStore('cards').add({
    deckId: cardData.deckId,
    word: cardData.word,
    translation: cardData.translation,
    box: cardData.box,
    nextReview: cardData.nextReview,
    createdAt: cardData.createdAt || now(),
  }));
  return id;
}

/**
 * Меняет слово/перевод существующей карточки. Если в той же колоде уже есть
 * другая карточка с такой же парой слово+перевод — правка отклоняется как дубль.
 * Возвращает true при успехе, false если это создало бы дубль.
 */
async function updateCard(id, word, translation) {
  const card = await getCard(id);
  if (!card) return false;

  const w = word.trim(), tr = translation.trim();
  const siblings = await getCardsByDeck(card.deckId);
  const wouldDuplicate = siblings.some((c) => c.id !== id && c.word === w && c.translation === tr);
  if (wouldDuplicate) return false;

  const t = await tx('cards', 'readwrite');
  t.objectStore('cards').put({ ...card, word: w, translation: tr });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return true;
}

async function deleteAllCardsInDeck(deckId) {
  const cards = await getCardsByDeck(deckId);
  const t = await tx('cards', 'readwrite');
  for (const c of cards) t.objectStore('cards').delete(c.id);
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return cards.length;
}

async function dedupDeck(deckId) {
  const cards = await getCardsByDeck(deckId); // уже отсортированы по id (= по времени добавления)
  const seen = new Set();
  const dupIds = [];
  for (const c of cards) {
    const key = c.word + '\u0001' + c.translation;
    if (seen.has(key)) dupIds.push(c.id);
    else seen.add(key);
  }
  if (dupIds.length) {
    const t = await tx('cards', 'readwrite');
    for (const id of dupIds) t.objectStore('cards').delete(id);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  return dupIds.length;
}

async function countCards(deckId) {
  const cards = await getCardsByDeck(deckId);
  const n = new Date();
  const due = cards.filter((c) => new Date(c.nextReview) <= n).length;
  return { total: cards.length, due };
}

async function getDueCards(deckId, limit = 20) {
  const cards = await getCardsByDeck(deckId);
  const n = new Date();
  const due = cards.filter((c) => new Date(c.nextReview) <= n);
  // случайная выборка, а не "первые N" — иначе всегда попадались бы одни
  // и те же старые по дате добавления карточки
  for (let i = due.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [due[i], due[j]] = [due[j], due[i]];
  }
  return due.slice(0, limit);
}

async function updateCardProgress(id, correct) {
  const card = await getCard(id);
  if (!card) return;
  let box = correct ? Math.min(card.box + 1, 5) : 1;
  const days = INTERVALS[box];
  const next = new Date();
  next.setDate(next.getDate() + days);
  const t = await tx('cards', 'readwrite');
  t.objectStore('cards').put({ ...card, box, nextReview: next.toISOString() });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

/**
 * Сбрасывает уровень (box) всех карточек колоды до targetBox и делает их
 * сразу доступными к повторению (nextReview = сейчас). Сами карточки не
 * удаляются — только прогресс повторения. Возвращает количество изменённых карточек.
 */
async function resetDeckLevels(deckId, targetBox) {
  const cards = await getCardsByDeck(deckId);
  if (!cards.length) return 0;
  const now = new Date().toISOString();
  const t = await tx('cards', 'readwrite');
  const store = t.objectStore('cards');
  for (const c of cards) {
    store.put({ ...c, box: targetBox, nextReview: now });
  }
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  return cards.length;
}
