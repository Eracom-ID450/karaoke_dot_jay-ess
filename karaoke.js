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
 *   autoplay           (false) Start playing as soon as lyrics are loaded.
 *   loop               (false) Restart from the top when the song ends (onEnd is not called).
 *   onLine(line, index)        Called whenever the current line changes (index -1 = nothing showing).
 *   onEnd()                    Called when playback finishes.
 */
(function (global) {
	'use strict';

	const TIME_TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
	const META_TAG = /^\[([a-z]+):\s*(.*?)\s*\]$/i;

	function parse(text) {
		const meta = {};
		const lines = [];

		for (const raw of text.split(/\r?\n/)) {
			const row = raw.trim();
			if (!row) continue;

			const stamps = [...row.matchAll(TIME_TAG)];
			if (stamps.length) {
				const lyric = row.replace(TIME_TAG, '').trim();
				for (const [, m, s] of stamps) {
					lines.push({ time: Number(m) * 60 + Number(s), text: lyric });
				}
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

	// Build the playback timeline: each line gets a `start` in playback seconds.
	// Without compression start === time. With compression, any empty stretch
	// (the intro before the first lyric, or a blank line until the next one)
	// is capped at maxGap.
	function buildTimeline(lines, { compressWhitespace, maxGap }) {
		const out = [];
		let cursor = 0;
		let prevTime = 0;
		let prevEmpty = true; // the intro counts as an empty stretch

		for (const line of lines) {
			let gap = line.time - prevTime;
			if (compressWhitespace && prevEmpty) gap = Math.min(gap, maxGap);
			cursor += gap;
			out.push({ ...line, start: cursor });
			prevTime = line.time;
			prevEmpty = line.text === '';
		}
		return out;
	}

	// Default look for one-line mode. Injected once, low specificity so pages can override it.
	const ONE_LINE_CSS = `
.karaoke-oneline {
	display: flex; align-items: center; justify-content: center;
	min-height: 100vh; margin: 0; padding: 0 4vw; box-sizing: border-box;
}
.karaoke-oneline .karaoke-line {
	margin: 0; font-family: Monaco, Menlo, "Courier New", monospace;
	font-size: 10vh; line-height: 1.1; text-align: center; overflow-wrap: anywhere;
}`;

	function injectStyles() {
		if (typeof document === 'undefined' || !document.head || document.getElementById('karaoke-js-styles')) return;
		const style = document.createElement('style');
		style.id = 'karaoke-js-styles';
		style.textContent = ONE_LINE_CSS;
		document.head.prepend(style);
	}

	class Karaoke {
		constructor(container, options = {}) {
			this.container = container;
			this.options = Object.assign(
				{
					compressWhitespace: true, maxGap: 1, oneLine: true,
					autoplay: false, loop: false,
					onLine: null, onEnd: null,
				},
				options
			);
			if (this.options.oneLine) injectStyles();
			this.meta = {};
			this.timeline = [];
			this.index = -1;
			this.playing = false;
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
			this._setIndex(-1);
			return this;
		}

		seek(seconds) {
			this._elapsed = Math.max(0, Math.min(seconds, this.duration));
			if (this.playing) this._startedAt = performance.now();
			this._setIndex(this._indexAt(this._elapsed));
			return this;
		}

		_indexAt(t) {
			let i = -1;
			while (i + 1 < this.timeline.length && this.timeline[i + 1].start <= t) i++;
			return i;
		}

		_tick() {
			const t = this.currentTime;
			this._setIndex(this._indexAt(t));
			if (t >= this.duration && this.options.loop) {
				this._elapsed = 0;
				this._startedAt = performance.now();
				this._setIndex(-1);
			} else if (t >= this.duration) {
				this.pause();
				this._elapsed = this.duration;
				if (this.options.onEnd) this.options.onEnd();
				return;
			}
			this._raf = requestAnimationFrame(this._tick);
		}

		_setIndex(i) {
			if (i === this.index) return;
			if (this.options.oneLine) {
				this.index = i;
				const line = this.timeline[i];
				this._lineEl.textContent = (line && line.text) || ' ';
				if (this.options.onLine) this.options.onLine(line || null, i);
				return;
			}
			const els = this.container.children;
			if (els[this.index]) els[this.index].classList.remove('karaoke-current');
			for (let j = 0; j < els.length; j++) els[j].classList.toggle('karaoke-past', j < i);
			this.index = i;
			if (els[i]) {
				els[i].classList.add('karaoke-current');
				els[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
			if (this.options.onLine) this.options.onLine(this.timeline[i] || null, i);
		}

		_render() {
			this.index = -1;
			this.container.classList.add('karaoke');
			this.container.classList.toggle('karaoke-oneline', !!this.options.oneLine);
			if (this.options.oneLine) {
				this._lineEl = document.createElement('p');
				this._lineEl.className = 'karaoke-line karaoke-current';
				this._lineEl.textContent = ' ';
				this.container.replaceChildren(this._lineEl);
				return;
			}
			this.container.replaceChildren(
				...this.timeline.map((line) => {
					const el = document.createElement('p');
					el.className = 'karaoke-line' + (line.text ? '' : ' karaoke-empty');
					el.textContent = line.text || ' ';
					return el;
				})
			);
		}
	}

	global.Karaoke = Karaoke;
	if (typeof module === 'object' && module.exports) module.exports = Karaoke;
})(typeof window !== 'undefined' ? window : globalThis);
