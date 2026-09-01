/*
 * db.js — вся работа с IndexedDB: колоды, карточки, активная колода,
 * интервальное повторение (тот же алгоритм SM-2 lite, что и в телеграм-боте).
 * Никакой сети — всё хранится локально на устройстве.
 */

const DB_NAME = 'flashcards_pwa';
const DB_VERSION = 2;

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
      // v2: журнал ответов — для retention, heatmap активности и серии дней (streak)
      if (!db.objectStoreNames.contains('review_log')) {
        const logStore = db.createObjectStore('review_log', { keyPath: 'id', autoIncrement: true });
        logStore.createIndex('by_deck', 'deckId', { unique: false });
        logStore.createIndex('by_day', 'day', { unique: false });
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
  const color = opts.color || DECK_COLOR_PALETTE[existingCount % DECK_COLOR_PALETTE.length];
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
  if (sourceId === targetId) return { moved: 0, skipped: 0, mergedGroups: 0 };
  const sourceCards = await getCardsByDeck(sourceId);
  const pairs = sourceCards.map((c) => [c.word, c.translation]);
  // addCardsBulk сама сводит похожие карточки (общее слово/перевод) в конце —
  // этого достаточно и для сценария объединения двух колод.
  const { added, skipped, mergedGroups } = await addCardsBulk(targetId, pairs);
  await deleteDeck(sourceId);
  return { moved: added, skipped, mergedGroups };
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

/** Приводит теги к чистому массиву уникальных непустых строк — принимает и массив, и строку через запятую. */
function normalizeTags(tags) {
  if (Array.isArray(tags)) return [...new Set(tags.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof tags === 'string') return normalizeTags(tags.split(','));
  return [];
}

async function addCard(deckId, word, translation, tags = []) {
  if (await cardExists(deckId, word, translation)) return false;
  const t = await tx('cards', 'readwrite');
  const n = now();
  t.objectStore('cards').add({
    deckId, word: word.trim(), translation: translation.trim(),
    box: 0, nextReview: n, createdAt: n, tags: normalizeTags(tags),
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
  let mergedGroups = 0;
  if (toInsert.length) {
    const t = await tx('cards', 'readwrite');
    const store = t.objectStore('cards');
    for (const c of toInsert) store.add(c);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    // Обычный импорт CSV/JSON часто приносит и разные переводы уже известного
    // слова, и разные слова с уже известным переводом — сразу сводим такие
    // в одну карточку с нумерованными значениями, а не оставляем как есть.
    ({ mergedGroups } = await mergeSimilarCards(deckId));
  }
  return { added: toInsert.length, skipped, mergedGroups };
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
    tags: normalizeTags(cardData.tags),
    createdAt: cardData.createdAt || now(),
  }));
  return id;
}

/**
 * Меняет слово/перевод (и опционально теги) существующей карточки. Если в той
 * же колоде уже есть другая карточка с такой же парой слово+перевод — правка
 * отклоняется как дубль. Возвращает true при успехе, false если это создало
 * бы дубль. Если tags не передан — теги карточки остаются как были.
 */
async function updateCard(id, word, translation, tags) {
  const card = await getCard(id);
  if (!card) return false;

  const w = word.trim(), tr = translation.trim();
  const siblings = await getCardsByDeck(card.deckId);
  const wouldDuplicate = siblings.some((c) => c.id !== id && c.word === w && c.translation === tr);
  if (wouldDuplicate) return false;

  const newTags = tags !== undefined ? normalizeTags(tags) : (card.tags || []);
  const t = await tx('cards', 'readwrite');
  t.objectStore('cards').put({ ...card, word: w, translation: tr, tags: newTags });
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

/** Форматирует список значений как нумерованный список "1. x\n2. y\n...". */
function formatNumberedValues(values) {
  return values.map((v, i) => `${i + 1}. ${v}`).join('\n');
}

/**
 * Обратная операция: если строка уже похожа на нумерованный список
 * ("1. x\n2. y\n..."), возвращает массив исходных значений; иначе — массив
 * из одного элемента (сама строка). Нужна, чтобы повторное слияние (например,
 * при последующем объединении колод) не заворачивало уже объединённое
 * значение в дополнительный уровень нумерации.
 */
function parseNumberedValues(str) {
  const lines = String(str).split('\n');
  if (lines.length < 2) return [str];
  const matches = lines.map((line) => line.match(/^\d+\.\s(.*)$/));
  if (matches.every((m) => m !== null)) return matches.map((m) => m[1]);
  return [str];
}

/**
 * Объединяет в колоде карточки с ОДИНАКОВЫМ словом, но разными переводами
 * (перевод становится нумерованным списком "1. .. 2. .."), а также карточки
 * с одинаковым переводом, но разными словами (аналогично — слово становится
 * нумерованным списком). Точные дубли (совпадает и слово, и перевод) эта
 * функция не трогает — для них есть dedupDeck.
 *
 * "Выживает" самая старая карточка группы (наименьший id); уровень (box)
 * объединённой карточки — минимальный среди группы (осторожная оценка: раз
 * значений теперь несколько, значит объём для запоминания вырос), дата
 * следующего повторения — самая ранняя из группы; теги объединяются.
 *
 * Возвращает { mergedGroups, removedCards }.
 */
async function mergeSimilarCards(deckId) {
  const cards = await getCardsByDeck(deckId); // уже отсортированы по id
  const cardsById = new Map(cards.map((c) => [c.id, c]));

  const toDeleteIds = new Set();
  const updates = new Map(); // id -> { word, translation, box, nextReview, tags }
  let mergedGroups = 0;

  function mergeGroup(group, sharedField, otherField) {
    // group уже отсортирована по id (т.к. исходный массив cards был отсортирован)
    const survivor = group[0];
    // Разворачиваем уже объединённые значения обратно в отдельные пункты —
    // иначе повторное слияние задваивало бы нумерацию ("1. 1. берег...").
    const allValues = group.flatMap((c) => parseNumberedValues(c[otherField]));
    const distinctOther = [...new Set(allValues)];
    const mergedTags = [...new Set(group.flatMap((c) => c.tags || []))];
    const minBox = Math.min(...group.map((c) => c.box || 0));
    const earliestNextReview = group.reduce(
      (min, c) => (new Date(c.nextReview) < new Date(min) ? c.nextReview : min),
      group[0].nextReview
    );
    updates.set(survivor.id, {
      [sharedField]: survivor[sharedField],
      [otherField]: distinctOther.length > 1 ? formatNumberedValues(distinctOther) : distinctOther[0],
      box: minBox,
      nextReview: earliestNextReview,
      tags: mergedTags,
    });
    for (const c of group) if (c.id !== survivor.id) toDeleteIds.add(c.id);
    mergedGroups++;
  }

  // --- Шаг 1: группировка по слову — разные переводы одного слова ---
  const byWord = new Map();
  for (const c of cards) {
    if (!byWord.has(c.word)) byWord.set(c.word, []);
    byWord.get(c.word).push(c);
  }
  for (const group of byWord.values()) {
    const distinctTranslations = new Set(group.map((c) => c.translation));
    if (group.length > 1 && distinctTranslations.size > 1) mergeGroup(group, 'word', 'translation');
  }

  // --- Шаг 2: группировка ОСТАВШИХСЯ (после шага 1) карточек по переводу ---
  const remaining = cards.filter((c) => !toDeleteIds.has(c.id));
  const byTranslation = new Map();
  for (const c of remaining) {
    // если карточка уже обновлена на шаге 1, группируем по её НОВОМУ переводу
    const effectiveTranslation = updates.has(c.id) ? updates.get(c.id).translation : c.translation;
    if (!byTranslation.has(effectiveTranslation)) byTranslation.set(effectiveTranslation, []);
    byTranslation.get(effectiveTranslation).push({ ...c, translation: effectiveTranslation, word: updates.has(c.id) ? updates.get(c.id).word : c.word });
  }
  for (const group of byTranslation.values()) {
    const distinctWords = new Set(group.map((c) => c.word));
    // пропускаем карточки, уже объединённые на шаге 1 (у них составное значение
    // в word/translation — сравнивать их дальше по слову смысла не имеет)
    if (group.length > 1 && distinctWords.size > 1 && !group.some((c) => updates.has(c.id))) {
      mergeGroup(group, 'translation', 'word');
    }
  }

  if (updates.size || toDeleteIds.size) {
    const t = await tx('cards', 'readwrite');
    const store = t.objectStore('cards');
    for (const [id, patch] of updates) {
      const original = cardsById.get(id);
      if (original) store.put({ ...original, ...patch });
    }
    for (const id of toDeleteIds) store.delete(id);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }

  return { mergedGroups, removedCards: toDeleteIds.size };
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

async function getDueCards(deckId, limit = 20, tag = null) {
  const cards = await getCardsByDeck(deckId);
  const n = new Date();
  let due = cards.filter((c) => new Date(c.nextReview) <= n);
  if (tag) due = due.filter((c) => (c.tags || []).includes(tag));
  // случайная выборка, а не "первые N" — иначе всегда попадались бы одни
  // и те же старые по дате добавления карточки
  for (let i = due.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [due[i], due[j]] = [due[j], due[i]];
  }
  return due.slice(0, limit);
}

/**
 * Чистая функция SM-2 lite: по текущему уровню карточки и результату ответа
 * считает новый уровень и дату следующего повторения. Не трогает БД —
 * специально вынесена отдельно, чтобы её можно было протестировать
 * изолированно (см. tests/logic.test.mjs).
 */
function computeSm2Update(currentBox, correct, fromDate = new Date()) {
  const box = correct ? Math.min(currentBox + 1, 5) : 1;
  const days = INTERVALS[box];
  const next = new Date(fromDate);
  next.setDate(next.getDate() + days);
  return { box, nextReview: next.toISOString() };
}

async function updateCardProgress(id, correct) {
  const card = await getCard(id);
  if (!card) return;
  const { box, nextReview } = computeSm2Update(card.box, correct);
  const t = await tx('cards', 'readwrite');
  t.objectStore('cards').put({ ...card, box, nextReview });
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

/* ---------------------------------------------------------------------- *
 * Теги
 * ---------------------------------------------------------------------- */

/** Все уникальные теги, встречающиеся у карточек колоды (отсортированы). */
async function getAllTagsForDeck(deckId) {
  const cards = await getCardsByDeck(deckId);
  const set = new Set();
  for (const c of cards) (c.tags || []).forEach((tg) => set.add(tg));
  return [...set].sort((a, b) => a.localeCompare(b));
}

/* ---------------------------------------------------------------------- *
 * Обзор по нескольким колодам ("Учить всё")
 * ---------------------------------------------------------------------- */

/** Колоды с той же языковой парой слово/перевод, что и у переданной (включая её саму). */
async function getDecksWithSameLangPair(wordLang, translationLang) {
  const decks = await getAllDecks();
  return decks.filter((d) => d.wordLang === wordLang && d.translationLang === translationLang);
}

/** То же, что getDueCards, но собирает карточки сразу из нескольких колод (каждая карточка
 * сохраняет свой настоящий deckId — прогресс/лог по-прежнему пишутся в "родную" колоду). */
async function getDueCardsAcrossDecks(deckIds, limit = 20, tag = null) {
  let all = [];
  for (const id of deckIds) {
    const cards = await getCardsByDeck(id);
    all = all.concat(cards);
  }
  const n = new Date();
  let due = all.filter((c) => new Date(c.nextReview) <= n);
  if (tag) due = due.filter((c) => (c.tags || []).includes(tag));
  for (let i = due.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [due[i], due[j]] = [due[j], due[i]];
  }
  return due.slice(0, limit);
}

/* ---------------------------------------------------------------------- *
 * Журнал ответов: retention, heatmap, дневная цель и серия дней (streak)
 * ---------------------------------------------------------------------- */

/** Локальный (не UTC) ключ дня 'YYYY-MM-DD' — иначе heatmap/streak "съезжали" бы у пользователей
 * восточнее/западнее UTC около полуночи. */
function dayKey(d = new Date()) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** Пишет в журнал факт ответа по карточке — вызывается один раз на карточку за
 * сессию (по первой попытке — см. app.js), не на каждый повтор внутри сессии. */
async function logReview(cardId, deckId, correct) {
  const t = await tx('review_log', 'readwrite');
  t.objectStore('review_log').add({
    cardId, deckId, correct: !!correct,
    timestamp: now(),
    day: dayKey(),
  });
  await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
}

async function getAllReviewLogs() {
  const t = await tx('review_log', 'readonly');
  return reqToPromise(t.objectStore('review_log').getAll());
}

async function getReviewLogsForDeckSince(deckId, sinceDay) {
  const t = await tx('review_log', 'readonly');
  const idx = t.objectStore('review_log').index('by_deck');
  const all = await reqToPromise(idx.getAll(IDBKeyRange.only(deckId)));
  return all.filter((r) => r.day >= sinceDay);
}

/** Доля правильных ответов в активной колоде за последние `days` дней. rate=null, если ответов не было. */
async function getRetention(deckId, days) {
  const since = dayKey(new Date(Date.now() - (days - 1) * 86400000));
  const logs = await getReviewLogsForDeckSince(deckId, since);
  if (logs.length === 0) return { total: 0, correct: 0, rate: null };
  const correct = logs.filter((l) => l.correct).length;
  return { total: logs.length, correct, rate: correct / logs.length };
}

/** { 'YYYY-MM-DD': количество ответов } за последние `days` дней в колоде — для тепловой карты. */
async function getHeatmapData(deckId, days = 90) {
  const since = dayKey(new Date(Date.now() - (days - 1) * 86400000));
  const logs = await getReviewLogsForDeckSince(deckId, since);
  const counts = {};
  for (const l of logs) counts[l.day] = (counts[l.day] || 0) + 1;
  return counts;
}

/** Сколько карточек отвечено СЕГОДНЯ по всем колодам (для дневной цели/серии — это общая привычка,
 * не привязанная к конкретной колоде). */
async function getTodayReviewCount() {
  const today = dayKey();
  const all = await getAllReviewLogs();
  return all.filter((r) => r.day === today).length;
}

/**
 * Обновляет серию дней (streak), если дневная цель на сегодня достигнута и ещё не была
 * засчитана. Возвращает { streak, todayCount, justCompleted }.
 */
async function updateStreakIfGoalReached(dailyGoal) {
  const today = dayKey();
  const todayCount = await getTodayReviewCount();
  const streak = (await getSetting('streak')) || { current: 0, longest: 0, lastCompletedDate: null };

  if (todayCount >= dailyGoal && streak.lastCompletedDate !== today) {
    const yesterday = dayKey(new Date(Date.now() - 86400000));
    const newCurrent = streak.lastCompletedDate === yesterday ? streak.current + 1 : 1;
    const newStreak = { current: newCurrent, longest: Math.max(streak.longest, newCurrent), lastCompletedDate: today };
    await setSetting('streak', newStreak);
    return { streak: newStreak, todayCount, justCompleted: true };
  }
  return { streak, todayCount, justCompleted: false };
}

/* ---------------------------------------------------------------------- *
 * Прогноз нагрузки повторений
 * ---------------------------------------------------------------------- */

/** Сколько карточек колоды будет к повторению сегодня/завтра/за неделю/за месяц/позже. */
async function getForecastBuckets(deckId) {
  const cards = await getCardsByDeck(deckId);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const buckets = { today: 0, tomorrow: 0, week: 0, month: 0, later: 0 };
  for (const c of cards) {
    const nr = new Date(c.nextReview);
    const diffDays = Math.floor((nr - startOfToday) / 86400000);
    if (diffDays <= 0) buckets.today++;
    else if (diffDays === 1) buckets.tomorrow++;
    else if (diffDays <= 7) buckets.week++;
    else if (diffDays <= 30) buckets.month++;
    else buckets.later++;
  }
  return buckets;
}

/** Массив [{day:'YYYY-MM-DD', count}] на `horizonDays` вперёд, начиная с сегодня (для графика 7/30 дней). */
async function getForecastByDay(deckId, horizonDays) {
  const cards = await getCardsByDeck(deckId);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const order = [];
  const buckets = {};
  for (let i = 0; i < horizonDays; i++) {
    const key = dayKey(new Date(start.getTime() + i * 86400000));
    order.push(key);
    buckets[key] = 0;
  }
  const horizonEnd = new Date(start.getTime() + horizonDays * 86400000);
  const todayKey = order[0];
  for (const c of cards) {
    const nr = new Date(c.nextReview);
    if (nr < start) { buckets[todayKey]++; continue; } // просроченные — считаем "на сегодня"
    if (nr < horizonEnd) {
      const key = dayKey(nr);
      if (key in buckets) buckets[key]++;
    }
  }
  return order.map((day) => ({ day, count: buckets[day] }));
}

/** Сколько карточек колоды на каждом уровне box 0..5. */
async function getBoxDistribution(deckId) {
  const cards = await getCardsByDeck(deckId);
  const dist = [0, 0, 0, 0, 0, 0];
  for (const c of cards) dist[Math.max(0, Math.min(5, c.box || 0))]++;
  return dist;
}

/* ---------------------------------------------------------------------- *
 * Полный бэкап (экспорт/импорт с прогрессом) — формат .kdeck.json
 * ---------------------------------------------------------------------- */

/** Импортирует карточки С прогрессом (box/nextReview/tags) — для полного бэкапа
 * и шаринга колод. Дубли (по слову+переводу) пропускаются, как и везде. */
async function importFullBackupCards(deckId, cards) {
  const existing = new Set((await getCardsByDeck(deckId)).map((c) => c.word + '\u0001' + c.translation));
  const seenInBatch = new Set();
  const nowIso = now();
  const toInsert = [];
  let skipped = 0;

  for (const c of (cards || [])) {
    const word = String(c.word || '').trim();
    const translation = String(c.translation || '').trim();
    if (!word || !translation) { skipped++; continue; }
    const key = word + '\u0001' + translation;
    if (existing.has(key) || seenInBatch.has(key)) { skipped++; continue; }
    seenInBatch.add(key);

    const box = Number.isInteger(c.box) ? Math.max(0, Math.min(5, c.box)) : 0;
    const nextReview = (c.nextReview && !isNaN(Date.parse(c.nextReview))) ? c.nextReview : nowIso;
    toInsert.push({
      deckId, word, translation, box, nextReview,
      tags: normalizeTags(c.tags), createdAt: nowIso,
    });
  }

  if (toInsert.length) {
    const t = await tx('cards', 'readwrite');
    const store = t.objectStore('cards');
    for (const c of toInsert) store.add(c);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  return { added: toInsert.length, skipped };
}

/**
 * Импортирует бэкап СРАЗУ ВСЕХ колод (массив decks, каждая со своими cards
 * и прогрессом) — каждая колода в бэкапе создаётся заново (не мёржится с
 * уже существующими, чтобы не было риска случайно перемешать чужие данные).
 * Возвращает { decksCount, cardsAdded }.
 */
async function importAllDecksBackup(decksArray) {
  let cardsAdded = 0;
  let decksCount = 0;
  for (const d of (decksArray || [])) {
    if (!d || typeof d !== 'object') continue;
    const newDeckId = await createDeck(d.name || 'Imported deck', {
      wordLang: d.wordLang, translationLang: d.translationLang, color: d.color,
    });
    const { added } = await importFullBackupCards(newDeckId, d.cards || []);
    cardsAdded += added;
    decksCount++;
  }
  return { decksCount, cardsAdded };
}
