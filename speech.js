/*
 * speech.js — озвучка карточек через встроенный в браузер синтезатор речи
 * (SpeechSynthesis). На iOS голоса встроены в систему, интернет не нужен.
 *
 * Чистая логика очерёдности (buildPlayOrder/nextPosition/prevPosition)
 * вынесена отдельно от самой речи, чтобы её можно было протестировать
 * без реального аудио.
 */

const SPEECH_LANGUAGES = [
  { code: 'pl-PL', label: 'Польский' },
  { code: 'en-US', label: 'Английский' },
  { code: 'ru-RU', label: 'Русский' },
  { code: 'de-DE', label: 'Немецкий' },
  { code: 'fr-FR', label: 'Французский' },
  { code: 'es-ES', label: 'Испанский' },
  { code: 'it-IT', label: 'Итальянский' },
  { code: 'uk-UA', label: 'Украинский' },
];

function buildPlayOrder(count, shuffle) {
  const order = Array.from({ length: count }, (_, i) => i);
  if (!shuffle) return order;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function nextPosition(pos, total, repeat) {
  const next = pos + 1;
  if (next < total) return next;
  return repeat ? 0 : null;
}

function prevPosition(pos, total, repeat) {
  const prev = pos - 1;
  if (prev >= 0) return prev;
  return repeat ? total - 1 : null;
}

/**
 * CardSpeaker — проигрывает список карточек по очереди: слово -> пауза ->
 * перевод -> пауза -> следующая карточка. Использует глобальный
 * `speechSynthesis`, чтобы его можно было подменить в тестах.
 */
class CardSpeaker {
  constructor(synth = (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null)) {
    this.synth = synth;
    this.onCardStart = null;  // (position, card) => void — вызывается при переходе на карточку
    this.onFinished = null;   // () => void — вызывается по завершении (если repeat выключен)
    this.gapMs = 350;         // пауза между словом и переводом
    this.nextGapMs = 700;     // пауза перед следующей карточкой

    this._cards = [];
    this._order = [];
    this._pos = 0;
    this._playing = false;
    this._repeat = false;
  }

  load(cards, { shuffle = false, repeat = false } = {}) {
    this._cards = cards;
    this._order = buildPlayOrder(cards.length, shuffle);
    this._pos = 0;
    this._repeat = repeat;
    this._playing = false;
  }

  get total() { return this._order.length; }
  get position() { return this._pos; }
  get currentCard() { return this._cards[this._order[this._pos]]; }
  get isPlaying() { return this._playing; }

  play(wordLang, translationLang) {
    if (this.total === 0) return;
    this._playing = true;
    this._speakFrom(this._pos, wordLang, translationLang);
  }

  pause() {
    this._playing = false;
    if (this.synth) this.synth.cancel();
  }

  next(wordLang, translationLang) {
    const np = nextPosition(this._pos, this.total, this._repeat);
    if (this.synth) this.synth.cancel();
    if (np == null) { this._playing = false; if (this.onFinished) this.onFinished(); return; }
    this._pos = np;
    if (this._playing) this._speakFrom(this._pos, wordLang, translationLang);
    else if (this.onCardStart) this.onCardStart(this._pos, this.currentCard);
  }

  prev(wordLang, translationLang) {
    const pp = prevPosition(this._pos, this.total, this._repeat);
    if (pp == null) return;
    if (this.synth) this.synth.cancel();
    this._pos = pp;
    if (this._playing) this._speakFrom(this._pos, wordLang, translationLang);
    else if (this.onCardStart) this.onCardStart(this._pos, this.currentCard);
  }

  _speakFrom(pos, wordLang, translationLang) {
    this._pos = pos;
    const card = this.currentCard;
    if (!card) { this._playing = false; if (this.onFinished) this.onFinished(); return; }
    if (this.onCardStart) this.onCardStart(this._pos, card);

    const synth = this.synth;
    const utterWord = new SpeechSynthesisUtterance(card.word);
    utterWord.lang = wordLang;
    const utterTr = new SpeechSynthesisUtterance(card.translation);
    utterTr.lang = translationLang;

    utterWord.onend = () => {
      if (!this._playing) return;
      setTimeout(() => {
        if (!this._playing) return;
        synth.speak(utterTr);
      }, this.gapMs);
    };
    utterTr.onend = () => {
      if (!this._playing) return;
      setTimeout(() => {
        if (!this._playing) return;
        const np = nextPosition(this._pos, this.total, this._repeat);
        if (np == null) { this._playing = false; if (this.onFinished) this.onFinished(); return; }
        this._speakFrom(np, wordLang, translationLang);
      }, this.nextGapMs);
    };

    synth.cancel();
    synth.speak(utterWord);
  }
}
