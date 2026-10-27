'use strict';

/**
 * USM 边下边播引擎
 *   fetch(Range) → wasm 解码 → MSE(VP9) 播视频 + WebAudio 播 PCM 音轨
 * 不落盘：整个播放过程只在内存里转，不写缓存文件。
 */
export class LivePlayer {
  constructor(opts) {
    this.video = opts.video;
    this.on = opts.on || {};         // {state, time, duration, error, lang, stats}
    this.info = null;
    this.lang = 'chi';
    this.volume = 1;

    this.worker = null;
    this.session = 0;
    this.gen = 0;

    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.appending = false;

    this.offset = 0;                 // 已消费的字节
    this.received = 0;
    this.duration = null;
    this.ivf = null;
    this.hca = null;

    this.ac = null;
    this.master = null;
    this.gains = {};                 // channel -> GainNode
    this.pcm = { chi: [], eng: [], jpn: [], kor: [] };  // 每路 {ts, ch, sr, nch, planes}
    this.sources = [];
    this.pcm = { chi: [], eng: [], jpn: [], kor: [] };
    this.anchorMedia = 0;
    this.anchorCtx = 0;
    this.anchored = false;
    this.schedTimer = null;

    this.stats = { bytes: 0, clusters: 0, pcm: 0 };
    this.seen = new Set();
  }

  // ---------------------------------------------------------------- 打开
  async load(info, startAt) {
    this.info = info;
    this.startAt = startAt || 0;
    this.offset = 0;
    this.received = 0;
    this.ivf = null;
    this.hca = null;
    this.duration = null;
    this.stats = { bytes: 0, clusters: 0, pcm: 0 };
    this.lang = 'chi';

    this._initAudio();
    this._initWorker();
    this._initMse();
    if (!this._wireStall) {
      this._wireStall = true;
      this.video.addEventListener('waiting', () => this._onStall(true));
      this.video.addEventListener('playing', () => this._onStall(false));
      this.video.addEventListener('ended', () => { this._flushAudio(); this.ac && this.ac.suspend().catch(() => {}); });
    }

    await this._newSession();
    this._startFetch(0);
    this.on.state && this.on.state('buffering');
  }

  _initWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./usm-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this._onWorker(e.data);
    this.worker.onerror = (e) => this.on.error && this.on.error('解码器加载失败：' + (e.message || ''));
  }

  _initMse() {
    if (this.ms && this.ms.readyState === 'open') return;
    const v = this.video;
    const ms = new MediaSource();
    this.ms = ms;
    this.sb = null;
    v.src = URL.createObjectURL(ms);
    ms.addEventListener('sourceopen', () => {
      try {
        this.sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
        this.sb.addEventListener('updateend', () => { this.appending = false; this._pump(); });
        this._pump();
      } catch (err) {
        this.on.error && this.on.error('MSE 初始化失败：' + err.message);
      }
    }, { once: true });
  }

  _initAudio() {
    if (this.ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
    this.master = this.ac.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ac.destination);
    for (const c of ['chi', 'eng', 'jpn', 'kor']) {
      const g = this.ac.createGain();
      g.gain.value = c === this.lang ? 1 : 0;
      g.connect(this.master);
      this.gains[c] = g;
    }
  }

  // ---------------------------------------------------------------- 会话
  async _newSession() {
    this.session++;
    const id = this.session;
    await this._call({ t: 'create', id, key: this.info.keyHex });
    return id;
  }

  _call(msg, transfer) {
    return new Promise((res, rej) => {
      const w = this.worker;
      const onMsg = (e) => {
        const d = e.data;
        if (d.id !== msg.id) return;
        w.removeEventListener('message', onMsg);
        if (d.t === 'err') rej(new Error(d.message));
        else res(d);
      };
      w.addEventListener('message', onMsg);
      w.postMessage(msg, transfer || []);
    });
  }

  _dbg(m) { this.on.debug && this.on.debug(m); }

  /** d.kf 是扁平数组 [ptsMs, offset, ...]（绝对字节偏移） */
  _mergeKeyframes(flat) {
    this.keyframes = this.keyframes || [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const kf = { pts: flat[i], off: flat[i + 1] };
      let dup = false;
      for (const k of this.keyframes) if (k.off === kf.off) { dup = true; break; }
      if (!dup) this.keyframes.push(kf);
    }
    this.keyframes.sort((a, b) => a.pts - b.pts);
  }

  _keyframeBefore(ms) {
    if (!this.keyframes) return null;
    let best = null;
    for (const k of this.keyframes) {
      if (k.pts <= ms + 50 && (!best || k.pts > best.pts)) best = k;
    }
    return best;
  }

  _isBuffered(t) {
    const sb = this.sb;
    if (!sb || !sb.buffered) return false;
    for (let i = 0; i < sb.buffered.length; i++) {
      if (t >= sb.buffered.start(i) - 0.05 && t <= sb.buffered.end(i) - 0.05) return true;
    }
    return false;
  }

  _onWorker(d) {
    if (d.t === 'err') {
      this.on.error && this.on.error(d.message);
      return;
    }
    if (d.t !== 'res' || d.id !== this.session) return;

    if (d.clusters.length || d.init) this._dbg(`res init=${d.init ? 1 : 0} clusters=${d.clusters.length} pcm=${d.pcm.length}`);
    if (d.dur && !this.duration) {
      this.duration = d.dur / 1000;
      try { if (this.ms.readyState === 'open') this.ms.duration = this.duration; } catch (_) {}
      this.on.duration && this.on.duration(this.duration);
    }
    if (d.kf && d.kf.length) this._mergeKeyframes(d.kf);
    if (d.ivf && !this.ivf) this.ivf = d.ivf;
    if (d.hca && d.hca.length) this.hca = d.hca;

    if (d.init) this._queue(d.init);
    for (const c of d.clusters) { this._queue(c); this.stats.clusters++; }
    for (const p of d.pcm) {
      this._enqueueAudio(p);
      this.seen.add(this._chName(p.ch));
    }
    if (d.pcm && d.pcm.length && this.on.channels) {
      const list = [...this.seen];
      if (list.length !== this._lastSeen) {
        this._lastSeen = list.length;
        this.on.channels(list);
      }
    }
    this.stats.pcm += (d.pcm || []).length;

    this._pump();
    this._scheduleAudio();
  }

  // ---------------------------------------------------------------- 网络
  async _startFetch(from) {
    const gen = ++this.gen;
    if (this._ctrl) this._ctrl.abort();
    const ctrl = new AbortController();
    this._ctrl = ctrl;
    this.offset = from;

    const size = this.info.size || 0;
    // 分段拉取：每段 16MB。有些代理/网关对单次响应体有上限（比如 CF Worker 100MB），
    // 分段后大文件也能过；顺带还能在弱网下自动续传。
    const SEG = this.info.segSize || (typeof window !== 'undefined' && window.USM_SEG) || 16 * 1024 * 1024;
    let batch = new Uint8Array(0);

    try {
      for (;;) {
        if (gen !== this.gen) return;
        const reqFrom = this.offset;

        let target = this.info.url;
        let ranged = true;
        if (typeof this.info.makeUrl === 'function') {
          const t = this.info.makeUrl(reqFrom);
          target = t.url;
          ranged = !!t.ranged;
        }

        const headers = {};
        if (ranged) {
          const last = size ? Math.min(size - 1, reqFrom + SEG - 1) : reqFrom + SEG - 1;
          headers.Range = `bytes=${reqFrom}-${last}`;
        }

        let resp;
        try {
          resp = await fetch(target, { headers, signal: ctrl.signal, cache: 'no-store' });
        } catch (err) {
          if (err.name !== 'AbortError') this.on.error && this.on.error('下载失败：' + err.message);
          return;
        }
        if (ranged && reqFrom > 0 && resp.status === 200) {
          this.on.error && this.on.error('这个代理不支持分段读取（Range），换个代理或改用本地版');
          return;
        }
        if (!resp.ok && resp.status !== 206) {
          this.on.error && this.on.error(`下载失败 HTTP ${resp.status}`);
          return;
        }
        if (typeof this.info.releaseUrl === 'function') this.info.releaseUrl(target);

        const reader = resp.body.getReader();
        let got = 0;
        for (;;) {
          if (gen !== this.gen) return;
          const { value, done } = await reader.read();
          if (done) break;
          got += value.byteLength;
          this.received += value.byteLength;
          this.offset += value.byteLength;
          this.stats.bytes = this.received;

          const merged = new Uint8Array(batch.length + value.byteLength);
          merged.set(batch, 0);
          merged.set(value, batch.length);
          if (merged.length >= 768 * 1024) {
            await this._push(merged, gen);
            batch = new Uint8Array(0);
          } else {
            batch = merged;
          }

          const ahead = this._bufferedAhead();
          if (ahead > 10) await sleep(250);
          if (this.queue.length > 24) await sleep(80);
          while (!this.video.paused && this.ac && this.ac.state === 'running'
                 && this._pcm(this.lang).length > 400 && gen === this.gen) {
            await sleep(100);
          }
          this.on.stats && this.on.stats({
            received: this.received, total: size, ahead,
          });
        }

        if (batch.length) { await this._push(batch, gen); batch = new Uint8Array(0); }
        if (!size || this.offset >= size || got === 0 || !ranged) break;
        if (this._pcm(this.lang).length > 400) await sleep(200);
      }

      if (gen === this.gen) {
        await this._call({ t: 'finish', id: this.session }).catch(() => {});
        this.on.state && this.on.state('ended');
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.on.error && this.on.error('读取失败：' + err.message);
    }
  }

  async _push(data, gen) {
    if (gen !== this.gen) return;
    try {
      await this._call({ t: 'push', id: this.session, data: data.buffer }, [data.buffer]);
    } catch (err) {
      this.on.error && this.on.error('解码失败：' + err.message);
    }
  }

  // ---------------------------------------------------------------- MSE 队列
  _bufferedAhead() {
    const sb = this.sb, v = this.video;
    if (!sb || !sb.buffered || !sb.buffered.length) return 0;
    try { return sb.buffered.end(sb.buffered.length - 1) - v.currentTime; } catch (_) { return 0; }
  }

  _queue(buf) {
    this.queue.push(buf);
    if (this.queue.length > 40) this.queue.shift();
  }

  _pump() {
    const sb = this.sb;
    if (!sb || this.appending || !this.queue.length || sb.updating) return;
    const buf = this.queue.shift();
    this.appending = true;
    try {
      sb.appendBuffer(buf);
    } catch (err) {
      this.appending = false;
      if (err.name === 'QuotaExceededError') {
        this._trim();
        this.queue.unshift(buf);
        setTimeout(() => this._pump(), 300);
      } else {
        this.on.error && this.on.error('append 失败：' + err.message);
      }
    }
  }

  _trim() {
    const sb = this.sb, v = this.video;
    if (!sb || !sb.buffered.length || sb.updating) return;
    try {
      if (sb.buffered.start(0) < v.currentTime - 60) sb.remove(0, v.currentTime - 30);
    } catch (_) {}
  }

  // ---------------------------------------------------------------- 音频
  // 设计要点：
  //  · 每个 chunk 用绝对时间戳排程，晚到 30ms 以上直接丢弃（补着播 = 叠音 = 呲呲声）
  //  · 只排「当前语言」一条，CPU 直接降到 1/4，避免主线程饿死音频线程导致断续
  //  · 只有 pause / seek / stall 才整体 flush，平时绝不打断已排程的声音
  _pcm(ch) {
    if (!this.pcm) this.pcm = { chi: [], eng: [], jpn: [], kor: [] };
    if (!this.pcm[ch]) this.pcm[ch] = [];
    return this.pcm[ch];
  }

  _enqueueAudio(p) {
    this._seenPcm = this._seenPcm || {};
    const k = this._chName(p.ch);
    this._seenPcm[k] = (this._seenPcm[k] || 0) + 1;
    if (this._seenPcm[k] <= 2) {
      this._dbg(`pcm ${k} ts=${p.ts} sr=${p.sr} nch=${p.nch} frames=${p.planes[0].length} v=${this.video.currentTime.toFixed(2)}`);
    }
    const arr = this._pcm(this._chName(p.ch));
    // 诊断：重复 / 跳变
    this._tsStat = this._tsStat || {};
    const st = this._tsStat[this._chName(p.ch)] || (this._tsStat[this._chName(p.ch)] = { last: null, dup: 0, gap: 0, back: 0, n: 0 });
    st.n++;
    if (st.last != null) {
      const d = p.ts - st.last;
      if (d === 0) st.dup++;
      else if (d < 0) st.back++;
      else if (d > 40) st.gap++;
    }
    st.last = p.ts;
    arr.push(p);
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  }

  _anchor() {
    this.anchorMedia = this.video.currentTime;
    this.anchorCtx = this.ac.currentTime + 0.08;
    this.anchored = true;
    this._lateStreak = 0;
  }

  _flushAudio() {
    for (const s of this.sources) { try { s.stop(); } catch (_) {} }
    this.sources = [];
    this.pcm = { chi: [], eng: [], jpn: [], kor: [] };
    this._lastEnd = 0;
    this._lateStreak = 0;
  }

  /**
   * 音频排程：把 PCM 小片攒成 ~1.2s 的整块再播。
   * · 块内无缝（一次 copyToChannel），块与块之间按「视频当前时间」重新对齐，
   *   所以视频卡一下、慢一点都不会累积漂移，也不需要 flush（flush 就是那声「咔」）。
   * · 小块（21ms）逐个 start() 会有几十微秒的缝和叠音，正是呲呲声的来源。
   */
  _scheduleAudio() {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const list = this._pcm(this.lang);
    if (!list.length) return;

    const v = this.video.currentTime;

    // 已经落在播放位置之后的块直接丢（迟到的补播必然叠音）
    while (list.length && list[0].ts / 1000 < v - 0.15) {
      list.shift();
      this.audioSkipped = (this.audioSkipped || 0) + 1;
    }
    if (!list.length) return;

    // 最多只排到「视频位置 + 4 秒」，别把整段音频都塞进排程
    if (list[0].ts / 1000 > v + 4) return;
    if (this._lastEnd > ac.currentTime + 4.5) return;

    const SR = list[0].sr || 48000;
    const NCH = list[0].nch || 2;
    const needSamples = Math.floor(1.2 * SR);

    let cnt = 0, have = 0;
    while (cnt < list.length && have < needSamples) {
      have += list[cnt].planes[0].length;
      cnt++;
    }
    // 攒太少就先等（除非已经落后视频，那就先塞一小块顶住）
    const behind = list[0].ts / 1000 < v + 0.05;
    if (have < Math.floor(0.35 * SR) && !behind) return;

    const buf = ac.createBuffer(NCH, have, SR);
    const planes = [];
    for (let c = 0; c < NCH; c++) planes.push(new Float32Array(have));
    let off = 0;
    for (let i = 0; i < cnt; i++) {
      const p = list[i];
      for (let c = 0; c < NCH; c++) {
        if (p.planes[c]) planes[c].set(p.planes[c], off);
      }
      off += p.planes[0].length;
    }
    for (let c = 0; c < NCH; c++) {
      try { buf.copyToChannel(planes[c], c); } catch (_) {}
    }
    const startMedia = list[0].ts / 1000;
    list.splice(0, cnt);

    let at = ac.currentTime + (startMedia - v);
    const now = ac.currentTime;
    if (at < now + 0.02) at = now + 0.02;
    // 与上一块接缝：差得不多就贴上去（无缝），差太多就让它自然留白
    if (this._lastEnd) {
      const miss = at - this._lastEnd;
      if (Math.abs(miss) < 0.06) at = this._lastEnd;
      else if (miss > 0.06) this.audioGaps = (this.audioGaps || 0) + 1;
      else this.audioOverlaps = (this.audioOverlaps || 0) + 1;
      if (at < this._lastEnd - 0.06) at = this._lastEnd;
    }

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.gains[this.lang] || this.master);
    src._at = at;
    try { src.start(at); } catch (_) { return; }
    this._lastEnd = at + buf.duration;
    this.audioScheduled = (this.audioScheduled || 0) + cnt;
    this.sources.push(src);
    src.onended = () => {
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
    };
    if (this.sources.length > 8) this.sources.splice(0, this.sources.length - 8);
  }

  _chName(idx) {
    return ['chi', 'eng', 'jpn', 'kor'][idx] || 'chi';
  }

  _driftCheck() {
    if (!this.anchored || this.video.paused || !this.ac || this.ac.state !== 'running') return;
    const expected = this.anchorMedia + (this.ac.currentTime - this.anchorCtx);
    const drift = Math.abs(expected - this.video.currentTime);
    if (drift <= 2.5) return;
    // 音频块每 1.2s 都会按视频时钟重对齐，这里只处理极端情况，不 flush 保平滑
    const now = performance.now();
    if (this._lastReanchor && now - this._lastReanchor < 3000) return;
    this._lastReanchor = now;
    this._dbg(`drift ${drift.toFixed(2)}s -> reset queue`);
    this.pcm = { chi: [], eng: [], jpn: [], kor: [] };
    this._lastEnd = 0;
  }

  _onStall(stalled) {
    if (!this.ac) return;
    this._stalled = stalled;
    if (stalled) {
      // 视频等数据时把音频时钟一起冻住，避免「音频跑飞→反复重锚→声音被切碎」
      this._flushAudio();
      this.ac.suspend().catch(() => {});
    } else if (!this.video.paused) {
      this.ac.resume().catch(() => {});
      this._anchor();
    }
  }

  // ---------------------------------------------------------------- 控制
  async play() {
    if (!this.ac) this._initAudio();
    await Promise.race([this.ac.resume().catch(() => {}), sleep(300)]);
    await this.video.play().catch(() => {});
    this._anchor();
    this._startTimers();
    this.on.state && this.on.state('playing');
  }

  pause() {
    this.video.pause();
    this._flushAudio();
    this.ac && this.ac.suspend().catch(() => {});
    this._stopTimers();
    this.on.state && this.on.state('paused');
  }

  setLang(code) {
    this.lang = code;
    for (const [c, g] of Object.entries(this.gains)) {
      g.gain.value = c === code ? 1 : 0;
    }
    this.on.lang && this.on.lang(code);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  async seek(t) {
    const dur = this.duration || 0;
    const size = this.info.size || 0;
    if (!size || !dur) { this.video.currentTime = t; return; }
    const target = Math.max(0, Math.min(t, dur - 0.3));

    // 1) 目标已经在缓冲里：直接跳，不用重新拉流
    if (this._isBuffered(target)) {
      this._dbg(`seek-in-buffer ${target.toFixed(2)}`);
      this.video.currentTime = target;
      this._flushAudio();
      this.pcm = { chi: [], eng: [], jpn: [], kor: [] };
      this._anchor();
      return;
    }

    this._flushAudio();
    this.queue = [];
    this.gen++;
    if (this._ctrl) this._ctrl.abort();
    this.on.state && this.on.state('seeking');

    // 2) 找关键帧（有索引就用索引，没有就线性估算 + 扫描对齐到分块头）
    let offset;
    const kf = this._keyframeBefore(target * 1000);
    if (kf) {
      offset = kf.off;
    } else {
      const est = Math.floor(size * (target / dur) / 4096) * 4096;
      offset = await this._alignOffset(est, target);
    }
    this._dbg(`seek ${target.toFixed(2)}s -> byte ${offset}`);

    try {
      if (this.ivf && this.hca) {
        await this._call({
          t: 'reset', id: this.session,
          ivf: this.ivf.buffer.slice(0),
          channels: this.hca.map(h => ({ channel: h.ch, header: h.header.buffer.slice(0), skip: 0 })),
          baseOffset: offset,
        });
      } else {
        await this._newSession();
      }
    } catch (err) {
      this.on.error && this.on.error('跳转失败：' + err.message);
      return;
    }

    this.video.currentTime = target;
    this._anchor();
    this._startFetch(offset);
    if (this.video.paused) this.play();
  }

  /** 用 wasm 把整段 USM 转成 MKV（纯前端导出，不需要服务端） */
  exportMkv(bytes) {
    return new Promise((res, rej) => {
      const rid = 'mkv' + Date.now() + Math.random();
      const to = setTimeout(() => { this.worker.removeEventListener('message', onMsg); rej(new Error('导出超时')); }, 180000);
      const onMsg = (e) => {
        const d = e.data;
        if (d.t === 'mkverr' && d.rid === rid) { clearTimeout(to); this.worker.removeEventListener('message', onMsg); rej(new Error(d.message)); return; }
        if (d.t !== 'mkv' || d.rid !== rid) return;
        clearTimeout(to);
        this.worker.removeEventListener('message', onMsg);
        res(new Uint8Array(d.data));
      };
      this.worker.addEventListener('message', onMsg);
      this.worker.postMessage({ t: 'mkv', rid, key: this.info.keyHex, data: bytes.buffer }, [bytes.buffer]);
    });
  }

  /** 从估算位置找最近的一个 @SFV 分块头，保证解码器从合法的 chunk 边界开始 */
  async _alignOffset(est, target) {
    const size = this.info.size || 0;
    const from = Math.max(0, Math.min(est, Math.max(0, size - 512 * 1024)));

    // 本地文件：直接从 File 切片扫，不用网络
    if (typeof this.info.scanRange === 'function') {
      const buf = await this.info.scanRange(from, 512 * 1024);
      for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === 0x40 && buf[i + 1] === 0x53 && buf[i + 2] === 0x46 && buf[i + 3] === 0x56) {
          this._dbg(`align(local) ${from} +${i}`);
          return from + i;
        }
      }
      return from;
    }

    try {
      const r = await fetch(this.info.url, { headers: { Range: `bytes=${from}-${Math.min(size - 1, from + 512 * 1024)}` } });
      if (!r.ok && r.status !== 206) return from;
      const buf = new Uint8Array(await r.arrayBuffer());
      const magic = [0x40, 0x53, 0x46, 0x56]; // @SFV
      for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
          this._dbg(`align ${from} +${i}`);
          return from + i;
        }
      }
      return from;
    } catch (_) {
      return from;
    }
  }

  _startTimers() {
    this._stopTimers();
    this.schedTimer = setInterval(() => {
      if (!this.video.paused && !this._stalled && this.ac && this.ac.state === 'suspended') this.ac.resume().catch(() => {});
      this._scheduleAudio();
      this._driftCheck();
      this.on.time && this.on.time(this.video.currentTime);
    }, 100);
  }

  _stopTimers() {
    if (this.schedTimer) { clearInterval(this.schedTimer); this.schedTimer = null; }
  }

  destroy() {
    this.gen++;
    if (this._ctrl) this._ctrl.abort();
    this._stopTimers();
    this._flushAudio();
    try { this.worker && this.worker.postMessage({ t: 'free', id: this.session }); } catch (_) {}
    try { this.ac && this.ac.close(); } catch (_) {}
    try { this.video.removeAttribute('src'); this.video.load(); } catch (_) {}
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
