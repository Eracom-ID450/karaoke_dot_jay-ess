/*!
 * karaoke.js — a tiny .lrc player.
 *
 *   const k = new Karaoke(document.getElementById('stage'), { compressWhitespace: true });
 *   await k.load('song.lrc');   // or k.loadText(lrcString)
 *   k.play();
 *
 * Options:
 *   compressWhitespace (true)  Empty stretches (intro, blank [mm:ss] lines) last at most `maxGap` seconds.
 *   maxGap             (1)     Max seconds an empty stretch may last when compressing.
 *   oneLine            (true)  Show only the current line, big and monospaced
 *                              (homage to YOUNG-HAE CHANG HEAVY INDUSTRIES).
 *   oneWord            (true)  In one-line mode, show only the current word when the file has
 *                              word timing (enhanced LRC). Lines without word timing show whole.
 *   autoplay           (false) Start playing as soon as lyrics are loaded.
 *   loop               (false) Restart from the top when the song ends (onEnd is not called).
 *   onLine(line, index)        Called whenever the current line changes (index -1 = nothing showing).
 *   onWord(word, index)        Called whenever the current word changes (word timing only).
 *   onEnd()                    Called when playback finishes.
 *
 * Enhanced LRC (word timing) looks like `[00:08.40]Johnny's <00:08.85>in <00:09.05>the ...`.
 * Outside one-word mode, each word is a <span class="karaoke-word"> that gets `karaoke-sung`
 * once its time comes.
 */
(function (global) {
	'use strict';

	const TIME_TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
	const WORD_TAG = /<(\d+):(\d+(?:\.\d+)?)>/g;
	const META_TAG = /^\[([a-z]+):\s*(.*?)\s*\]$/i;
	const NBSP = ' ';
	const toSeconds = (m, s) => Number(m) * 60 + Number(s);

	// "Johnny's <00:08.85>in <00:09.05>the" -> [{ text, at }], `at` = seconds after the line starts.
	// Returns null when the line has no word tags.
	function parseWords(lyric, lineTime) {
		const tags = [...lyric.matchAll(WORD_TAG)];
		if (!tags.length) return null;
		const words = [];
		let at = 0;
		let last = 0;
		for (const tag of tags) {
			const text = lyric.slice(last, tag.index);
			if (text.trim()) words.push({ text, at });
			at = Math.max(0, toSeconds(tag[1], tag[2]) - lineTime);
			last = tag.index + tag[0].length;
		}
		const tail = lyric.slice(last);
		if (tail.trim()) words.push({ text: tail, at });
		// Keep word times in order even if the file has a typo (a word stamped before the previous one).
		for (let i = 1; i < words.length; i++) words[i].at = Math.max(words[i].at, words[i - 1].at);
		return words;
	}

	function parse(text) {
		const meta = {};
		const lines = [];

		for (const raw of text.split(/\r?\n/)) {
			const row = raw.trim();
			if (!row) continue;

			const stamps = [...row.matchAll(TIME_TAG)];
			if (stamps.length) {
				const lyric = row.replace(TIME_TAG, '').trim();
				const words = parseWords(lyric, toSeconds(stamps[0][1], stamps[0][2]));
				const plain = words ? words.map((w) => w.text).join('').trim() : lyric;
				for (const [, m, s] of stamps) lines.push({ time: toSeconds(m, s), text: plain, words });
				continue;
			}

			const metaMatch = row.match(META_TAG);
			if (metaMatch) meta[metaMatch[1].toLowerCase()] = metaMatch[2];
		}

		const offset = Number(meta.offset) / 1000 || 0; // [offset:+/-ms]
		for (const l of lines) l.time = Math.max(0, l.time + offset);
		lines.sort((a, b) => a.time - b.time);

		return { meta, lines };
	}

	// Build the playback timeline: each line (and word) gets a `start` in playback seconds.
	// Without compression start === time. With compression, any empty stretch
	// (the intro before the first lyric, or a blank line until the next one)
	// is capped at maxGap. Timing inside a line is never changed.
	function buildTimeline(lines, { compressWhitespace, maxGap }) {
		const out = [];
		let cursor = 0;
		let prevTime = 0;
		let prevEmpty = true; // the intro counts as an empty stretch

		for (const line of lines) {
			let gap = line.time - prevTime;
			if (compressWhitespace && prevEmpty) gap = Math.min(gap, maxGap);
			cursor += gap;
			const start = cursor;
			const words = line.words && line.words.map((w) => ({ text: w.text, start: start + w.at }));
			out.push({ time: line.time, text: line.text, start, words });
			prevTime = line.time;
			prevEmpty = line.text === '';
		}
		return out;
	}

	// Default look. Injected once at the top of <head>, so page styles override it.
	const DEFAULT_CSS = `
.karaoke-oneline {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; margin: 0; padding: 0 4vw; box-sizing: border-box;
}
.karaoke-oneline .karaoke-line {
	margin: 0; font-family: Monaco, Menlo, "Courier New", monospace;
	font-size: 10vh; line-height: 1.1; text-align: center; overflow-wrap: anywhere;
}
.karaoke-current .karaoke-word { transition: opacity .08s; }
.karaoke-current .karaoke-word:not(.karaoke-sung) { opacity: .2; }`;

	function injectStyles() {
		if (typeof document === 'undefined' || !document.head || document.getElementById('karaoke-js-styles')) return;
		const style = document.createElement('style');
		style.id = 'karaoke-js-styles';
		style.textContent = DEFAULT_CSS;
		document.head.prepend(style);
	}

	// Put a line's text into `el`, as word <span>s when it has word timing. Returns the spans.
	function fillLine(el, line) {
		if (!line || !line.text) {
			el.textContent = NBSP;
			return [];
		}
		if (!line.words) {
			el.textContent = line.text;
			return [];
		}
		const spans = line.words.map((w) => {
			const span = document.createElement('span');
			span.className = 'karaoke-word';
			span.textContent = w.text;
			return span;
		});
		el.replaceChildren(...spans);
		return spans;
	}

	class Karaoke {
		constructor(container, options = {}) {
			this.container = container;
			this.options = Object.assign(
				{
					compressWhitespace: true, maxGap: 1, oneLine: true, oneWord: true,
					autoplay: false, loop: false,
					onLine: null, onWord: null, onEnd: null,
				},
				options
			);
			injectStyles();
			this.meta = {};
			this.timeline = [];
			this.index = -1;        // current line
			this.word = -1;         // current word within that line
			this.playing = false;
			this._wordEls = [];     // word <span>s of the current line
			this._elapsed = 0;      // playback seconds accumulated before the last resume
			this._startedAt = 0;    // performance.now() at last resume
			this._raf = 0;
			this._tick = this._tick.bind(this);
		}

		static parse(text) { return parse(text); }

		async load(url) {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`karaoke.js: failed to load ${url} (${res.status})`);
			return this.loadText(await res.text());
		}

		loadText(text) {
			this.stop();
			const { meta, lines } = parse(text);
			this.meta = meta;
			this.timeline = buildTimeline(lines, this.options);
			this._render();
			if (this.options.autoplay) this.play();
			return this;
		}

		get currentTime() {
			return this.playing
				? this._elapsed + (performance.now() - this._startedAt) / 1000
				: this._elapsed;
		}

		get duration() {
			const last = this.timeline[this.timeline.length - 1];
			return last ? last.start : 0;
		}

		play() {
			if (this.playing || !this.timeline.length) return this;
			if (this._elapsed >= this.duration) this._elapsed = 0;
			this.playing = true;
			this._startedAt = performance.now();
			this._raf = requestAnimationFrame(this._tick);
			return this;
		}

		pause() {
			if (!this.playing) return this;
			this._elapsed = this.currentTime;
			this.playing = false;
			cancelAnimationFrame(this._raf);
			return this;
		}

		toggle() { return this.playing ? this.pause() : this.play(); }

		stop() {
			this.pause();
			this._elapsed = 0;
			this._update(0);
			return this;
		}

		seek(seconds) {
			this._elapsed = Math.max(0, Math.min(seconds, this.duration));
			if (this.playing) this._startedAt = performance.now();
			this._update(this._elapsed);
			return this;
		}

		get _showOneWord() {
			const line = this.timeline[this.index];
			return this.options.oneLine && this.options.oneWord && !!(line && line.words);
		}

		_update(t) {
			let i = -1;
			while (i + 1 < this.timeline.length && this.timeline[i + 1].start <= t) i++;
			if (i !== this.index) this._setLine(i);

			const line = this.timeline[i];
			let w = -1;
			if (line && line.words) {
				while (w + 1 < line.words.length && line.words[w + 1].start <= t) w++;
			}
			if (w !== this.word) this._setWord(w);
		}

		_tick() {
			const t = this.currentTime;
			this._update(t);
			if (t >= this.duration && this.options.loop) {
				this._elapsed = 0;
				this._startedAt = performance.now();
				this._update(0);
			} else if (t >= this.duration) {
				this.pause();
				this._elapsed = this.duration;
				if (this.options.onEnd) this.options.onEnd();
				return;
			}
			this._raf = requestAnimationFrame(this._tick);
		}

		_setLine(i) {
			const line = this.timeline[i];
			this.index = i;
			this.word = -1;

			if (this.options.oneLine) {
				if (this._showOneWord) {
					this._lineEl.textContent = NBSP;
					this._wordEls = [];
				} else {
					this._wordEls = fillLine(this._lineEl, line);
				}
			} else {
				const els = this.container.children;
				for (let j = 0; j < els.length; j++) {
					els[j].classList.toggle('karaoke-past', j < i);
					els[j].classList.toggle('karaoke-current', j === i);
				}
				this._wordEls = els[i] ? [...els[i].children] : [];
				if (els[i]) els[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
			for (const el of this._wordEls) el.classList.remove('karaoke-sung');

			if (this.options.onLine) this.options.onLine(line || null, i);
		}

		_setWord(w) {
			this.word = w;
			const line = this.timeline[this.index];
			const word = line && line.words && line.words[w];

			if (this._showOneWord) {
				this._lineEl.textContent = word ? word.text.trim() : NBSP;
			} else {
				this._wordEls.forEach((el, j) => el.classList.toggle('karaoke-sung', j <= w));
			}

			if (word && this.options.onWord) this.options.onWord(word, w);
		}

		_render() {
			this.index = -1;
			this.word = -1;
			this._wordEls = [];
			this.container.classList.add('karaoke');
			this.container.classList.toggle('karaoke-oneline', !!this.options.oneLine);
			if (this.options.oneLine) {
				this._lineEl = document.createElement('p');
				this._lineEl.className = 'karaoke-line karaoke-current';
				this._lineEl.textContent = NBSP;
				this.container.replaceChildren(this._lineEl);
				return;
			}
			this.container.replaceChildren(
				...this.timeline.map((line) => {
					const el = document.createElement('p');
					el.className = 'karaoke-line' + (line.text ? '' : ' karaoke-empty');
					fillLine(el, line);
					return el;
				})
			);
		}
	}

	global.Karaoke = Karaoke;
	if (typeof module === 'object' && module.exports) module.exports = Karaoke;
})(typeof window !== 'undefined' ? window : globalThis);
