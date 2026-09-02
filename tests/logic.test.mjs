/*
 * tests/logic.test.mjs — юнит-тесты для чистых, не зависящих от DOM/браузера
 * функций приложения: SM-2 lite (db.js), очередь "Слушать" (speech.js) и
 * CSV-парсер (app.js).
 *
 * Зависимостей нет (только fake-indexeddb для двух тестов db.js, которым
 * реально нужна БД, а не только чистая функция). Запуск:
 *
 *   cd tests && npm install fake-indexeddb --no-save && node logic.test.mjs
 *
 * (fake-indexeddb нужен только если ты не устанавливал его раньше в этой
 * папке — без него упадут ровно два теста БД, отмеченных ниже, остальные
 * отработают в любом случае.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✅ ${name}`); passed++; })
    .catch((err) => { console.log(`  ❌ ${name}\n     ${err.message}`); failed++; });
}

/* ---------------------------------------------------------------------- *
 * 1. SM-2 lite (db.js) — computeSm2Update, чистая функция без БД
 * ---------------------------------------------------------------------- */

async function runSm2Tests() {
  console.log('\n=== SM-2 lite (db.js: computeSm2Update) ===');
  const dbCode = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  const { computeSm2Update } = new Function(dbCode + '; return { computeSm2Update };')();

  await test('верный ответ поднимает уровень на 1', () => {
    const r = computeSm2Update(2, true);
    assert.equal(r.box, 3);
  });

  await test('неверный ответ сбрасывает уровень до 1 (не до 0)', () => {
    const r = computeSm2Update(4, false);
    assert.equal(r.box, 1);
  });

  await test('уровень не растёт выше 5 (максимум)', () => {
    const r = computeSm2Update(5, true);
    assert.equal(r.box, 5);
  });

  await test('неверный ответ на уровне 0 остаётся на уровне 1 (не уходит в минус)', () => {
    const r = computeSm2Update(0, false);
    assert.equal(r.box, 1);
  });

  await test('nextReview сдвигается на правильное число дней (уровень 2 -> 3 дня)', () => {
    const from = new Date('2026-01-01T12:00:00.000Z');
    const r = computeSm2Update(1, true, from); // 1 -> 2, интервал для уровня 2 = 3 дня
    const next = new Date(r.nextReview);
    const diffDays = Math.round((next - from) / 86400000);
    assert.equal(r.box, 2);
    assert.equal(diffDays, 3);
  });

  // Эти тесты реально пишут в (поддельную) БД — если fake-indexeddb не
  // установлен в этой папке, они просто упадут с понятной ошибкой импорта,
  // не затрагивая остальные тесты файла.
  try {
    await import('fake-indexeddb/auto');
    const names = ['ensureActiveDeck', 'createDeck', 'getDeck', 'addCard', 'getCardsByDeck', 'getCard',
      'updateCardProgress', 'mergeSimilarCards', 'addCardsBulk', 'mergeDecks', 'tx', 'now'];
    const db = new Function(dbCode + `; return { ${names.join(', ')} };`)();

    await test('updateCardProgress (через БД) использует ту же логику, что и computeSm2Update', async () => {
      const deckId = await db.ensureActiveDeck();
      await db.addCard(deckId, 'test-sm2', 'тест-sm2');
      const [card] = await db.getCardsByDeck(deckId);
      await db.updateCardProgress(card.id, true);
      const updated = await db.getCard(card.id);
      assert.equal(updated.box, 1);
    });

    await test('createDeck принимает явный цвет (нужно для точного восстановления удалённой колоды)', async () => {
      const id = await db.createDeck('color-test', { color: '#123456' });
      const deck = await db.getDeck(id);
      assert.equal(deck.color, '#123456');
    });

    await test('mergeSimilarCards объединяет одно слово с разными переводами (омоним)', async () => {
      const deckId = await db.createDeck('merge-test-1');
      await db.addCard(deckId, 'bank', 'берег');
      await db.addCard(deckId, 'bank', 'банк');
      const result = await db.mergeSimilarCards(deckId);
      const cards = await db.getCardsByDeck(deckId);
      assert.equal(result.mergedGroups, 1);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].translation, '1. берег\n2. банк');
    });

    await test('mergeSimilarCards объединяет разные слова с одним переводом (синонимы)', async () => {
      const deckId = await db.createDeck('merge-test-2');
      await db.addCard(deckId, 'shore', 'побережье');
      await db.addCard(deckId, 'coast', 'побережье');
      const result = await db.mergeSimilarCards(deckId);
      const cards = await db.getCardsByDeck(deckId);
      assert.equal(result.mergedGroups, 1);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].word, '1. shore\n2. coast');
    });

    await test('mergeSimilarCards не трогает точные дубли (это работа dedupDeck)', async () => {
      const deckId = await db.createDeck('merge-test-3');
      await db.addCard(deckId, 'dog', 'собака');
      const t = await db.tx('cards', 'readwrite');
      t.objectStore('cards').add({ deckId, word: 'dog', translation: 'собака', box: 0, nextReview: db.now(), createdAt: db.now(), tags: [] });
      await new Promise((res) => { t.oncomplete = res; });

      const result = await db.mergeSimilarCards(deckId);
      const cards = await db.getCardsByDeck(deckId);
      assert.equal(result.mergedGroups, 0);
      assert.equal(cards.length, 2);
    });

    await test('mergeSimilarCards идемпотентна — повторный вызов ничего не меняет и не задваивает нумерацию', async () => {
      const deckId = await db.createDeck('merge-test-4');
      await db.addCard(deckId, 'bank', 'берег');
      await db.addCard(deckId, 'bank', 'банк');
      await db.mergeSimilarCards(deckId);
      const second = await db.mergeSimilarCards(deckId);
      const cards = await db.getCardsByDeck(deckId);
      assert.equal(second.mergedGroups, 0);
      assert.equal(cards[0].translation, '1. берег\n2. банк');
    });

    await test('addCardsBulk (обычный импорт) автоматически объединяет похожие карточки', async () => {
      const deckId = await db.createDeck('merge-test-5');
      await db.addCard(deckId, 'bank', 'берег');
      const result = await db.addCardsBulk(deckId, [['bank', 'банк'], ['cat', 'кот']]);
      const cards = await db.getCardsByDeck(deckId);
      const bank = cards.find((c) => c.word === 'bank');
      assert.equal(result.mergedGroups, 1);
      assert.equal(bank.translation, '1. берег\n2. банк');
    });

    await test('mergeDecks автоматически объединяет похожие карточки после переноса', async () => {
      const deckA = await db.createDeck('merge-test-6a');
      const deckB = await db.createDeck('merge-test-6b');
      await db.addCard(deckA, 'bank', 'берег');
      await db.addCard(deckB, 'bank', 'банк');
      const result = await db.mergeDecks(deckB, deckA);
      const cards = await db.getCardsByDeck(deckA);
      assert.equal(result.mergedGroups, 1);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].translation, '1. берег\n2. банк');
    });
  } catch (err) {
    console.log('  ⚠️  Пропущены тесты БД — fake-indexeddb не установлен в tests/ (npm install fake-indexeddb --no-save)');
  }
}

/* ---------------------------------------------------------------------- *
 * 2. Очередь "Слушать" (speech.js) — buildPlayOrder, nextPosition, prevPosition
 * ---------------------------------------------------------------------- */

async function runListenQueueTests() {
  console.log('\n=== Очередь "Слушать" (speech.js) ===');
  const speechCode = fs.readFileSync(path.join(root, 'speech.js'), 'utf8');
  const { buildPlayOrder, nextPosition, prevPosition, CardSpeaker } = new Function(
    speechCode + '; return { buildPlayOrder, nextPosition, prevPosition, CardSpeaker };'
  )();

  await test('buildPlayOrder без перемешивания идёт по порядку 0..N-1', () => {
    assert.deepEqual(buildPlayOrder(5, false), [0, 1, 2, 3, 4]);
  });

  await test('buildPlayOrder с перемешиванием сохраняет тот же набор элементов', () => {
    const order = buildPlayOrder(6, true);
    assert.equal(order.length, 6);
    assert.equal(new Set(order).size, 6);
  });

  await test('nextPosition идёт по порядку и возвращает null в конце без repeat', () => {
    assert.equal(nextPosition(0, 3, false), 1);
    assert.equal(nextPosition(2, 3, false), null);
  });

  await test('nextPosition зацикливается на начало с repeat=true', () => {
    assert.equal(nextPosition(2, 3, true), 0);
  });

  await test('prevPosition возвращает null перед началом без repeat', () => {
    assert.equal(prevPosition(0, 3, false), null);
  });

  await test('prevPosition зацикливается на конец с repeat=true', () => {
    assert.equal(prevPosition(0, 3, true), 2);
  });

  await test('CardSpeaker: правильный порядок озвучки (слово -> перевод -> след. карточка)', async () => {
    const spoken = [];
    const fakeSynth = {
      speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 0); },
      cancel() {},
    };
    global.SpeechSynthesisUtterance = function (text) { this.text = text; this.lang = ''; this.onend = null; };
    const speaker = new CardSpeaker(fakeSynth);
    speaker.gapMs = 0; speaker.nextGapMs = 0;
    speaker.load([{ id: 1, word: 'hello', translation: 'привет' }, { id: 2, word: 'bye', translation: 'пока' }], { shuffle: false });

    let finished = false;
    speaker.onFinished = () => { finished = true; };
    speaker.play('en-US', 'ru-RU');
    await new Promise((resolve) => {
      const iv = setInterval(() => { if (finished) { clearInterval(iv); resolve(); } }, 5);
    });
    assert.deepEqual(spoken, ['hello', 'привет', 'bye', 'пока']);
  });

  await test('CardSpeaker.removeCard корректно убирает карточку и не ломает total', () => {
    const speaker = new CardSpeaker({ speak() {}, cancel() {} });
    speaker.load([{ id: 1, word: 'a', translation: 'а' }, { id: 2, word: 'b', translation: 'б' }], {});
    const wasCurrent = speaker.removeCard(1);
    assert.equal(wasCurrent, true);
    assert.equal(speaker.total, 1);
    assert.equal(speaker.currentCard.word, 'b');
  });
}

/* ---------------------------------------------------------------------- *
 * 3. CSV-парсер (app.js) — parseCsvPairs / parseCsvText
 * ---------------------------------------------------------------------- */

async function runCsvParserTests() {
  console.log('\n=== CSV-парсер (app.js) ===');
  const appCode = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  // Полный app.js нельзя выполнить в Node целиком (там есть верхнеуровневые
  // обращения к document/window) — вырезаем только сами функции парсера.
  const extractFn = (name) => {
    const start = appCode.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`Функция ${name} не найдена в app.js`);
    let depth = 0, i = appCode.indexOf('{', start), end = -1;
    for (; i < appCode.length; i++) {
      if (appCode[i] === '{') depth++;
      if (appCode[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return appCode.slice(start, end);
  };
  const src = [extractFn('parseCsvPairs'), extractFn('parseCsvText'), extractFn('csvEscape')].join('\n');
  const { parseCsvPairs } = new Function(src + '; return { parseCsvPairs };')();

  await test('базовый разбор CSV с запятой', () => {
    const res = parseCsvPairs('word,translation\ncat,кот\ndog,собака');
    assert.deepEqual(res, [['cat', 'кот'], ['dog', 'собака']]);
  });

  await test('заголовок пропускается, только если ОБЕ ячейки — служебные слова', () => {
    const withRealHeader = parseCsvPairs('word,translation\ncat,кот');
    assert.deepEqual(withRealHeader, [['cat', 'кот']]);

    // "word" совпало со служебным словом только в ОДНОЙ колонке — это не заголовок,
    // а настоящая пара (иначе слово "word" никогда нельзя было бы добавить как карточку)
    const falseHeader = parseCsvPairs('word,мир\ncat,кот');
    assert.deepEqual(falseHeader, [['word', 'мир'], ['cat', 'кот']]);
  });

  await test('перенос строки внутри кавычек не ломает структуру таблицы', () => {
    const res = parseCsvPairs('word,translation\n"hello\nworld",привет\nbye,пока');
    assert.deepEqual(res, [['hello\nworld', 'привет'], ['bye', 'пока']]);
  });

  await test('экранированные кавычки ("") внутри поля разбираются верно', () => {
    const res = parseCsvPairs('word,translation\n"say ""hi""",привет');
    assert.deepEqual(res, [['say "hi"', 'привет']]);
  });

  await test('точка с запятой определяется как разделитель, если её больше в тексте', () => {
    const res = parseCsvPairs('word;translation\ncat;кот');
    assert.deepEqual(res, [['cat', 'кот']]);
  });

  await test('пустые строки и строки без второй колонки пропускаются', () => {
    const res = parseCsvPairs('cat,кот\n\nlonely_word\ndog,собака');
    assert.deepEqual(res, [['cat', 'кот'], ['dog', 'собака']]);
  });
}

/* ---------------------------------------------------------------------- */

/* ---------------------------------------------------------------------- *
 * Согласование числительных (i18n.js) — pluralize/pluralWord
 * ---------------------------------------------------------------------- */

async function runPluralizeTests() {
  console.log('\n=== Согласование числительных (i18n.js: pluralize/pluralWord) ===');
  const i18nCode = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');
  const { setLang, pluralize, pluralWord } = new Function(i18nCode + '; return { setLang, pluralize, pluralWord };')();

  await test('RU: 1 → карточка', () => { setLang('ru'); assert.equal(pluralize(1, 'card'), '1 карточка'); });
  await test('RU: 2–4 → карточки', () => {
    setLang('ru');
    assert.equal(pluralize(2, 'card'), '2 карточки');
    assert.equal(pluralize(3, 'card'), '3 карточки');
    assert.equal(pluralize(4, 'card'), '4 карточки');
  });
  await test('RU: 0, 5–20 → карточек', () => {
    setLang('ru');
    assert.equal(pluralize(0, 'card'), '0 карточек');
    assert.equal(pluralize(5, 'card'), '5 карточек');
    assert.equal(pluralize(11, 'card'), '11 карточек');
    assert.equal(pluralize(20, 'card'), '20 карточек');
  });
  await test('RU: составные числа (21 → карточка, 22 → карточки, 25 → карточек)', () => {
    setLang('ru');
    assert.equal(pluralize(21, 'card'), '21 карточка');
    assert.equal(pluralize(22, 'card'), '22 карточки');
    assert.equal(pluralize(25, 'card'), '25 карточек');
  });
  await test('RU: 11–14 всегда "карточек", даже 111/112', () => {
    setLang('ru');
    assert.equal(pluralize(11, 'card'), '11 карточек');
    assert.equal(pluralize(111, 'card'), '111 карточек');
    assert.equal(pluralize(112, 'card'), '112 карточек');
  });
  await test('EN: 1 → card (единственное), иначе → cards', () => {
    setLang('en');
    assert.equal(pluralize(1, 'card'), '1 card');
    assert.equal(pluralize(2, 'card'), '2 cards');
    assert.equal(pluralize(0, 'card'), '0 cards');
  });
  await test('PL: 1 → fiszka, 2–4 → fiszki (кроме 12–14), 5+ → fiszek', () => {
    setLang('pl');
    assert.equal(pluralize(1, 'card'), '1 fiszka');
    assert.equal(pluralize(2, 'card'), '2 fiszki');
    assert.equal(pluralize(5, 'card'), '5 fiszek');
    assert.equal(pluralize(12, 'card'), '12 fiszek'); // исключение из "2-4"
    assert.equal(pluralize(22, 'card'), '22 fiszki');
  });
  await test('pluralWord возвращает только форму слова, без числа', () => {
    setLang('ru');
    assert.equal(pluralWord(1, 'card'), 'карточка');
    assert.equal(pluralWord(5, 'card'), 'карточек');
  });
  await test('работает для других существительных (deck/день/группа/дубль)', () => {
    setLang('ru');
    assert.equal(pluralize(1, 'deck'), '1 колода');
    assert.equal(pluralize(3, 'deck'), '3 колоды');
    assert.equal(pluralize(1, 'day'), '1 день');
    assert.equal(pluralize(2, 'day'), '2 дня');
    assert.equal(pluralize(5, 'day'), '5 дней');
  });
}

async function main() {
  await runSm2Tests();
  await runListenQueueTests();
  await runCsvParserTests();
  await runPluralizeTests();

  console.log(`\n${'-'.repeat(50)}`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failed > 0) process.exit(1);
}

main();
