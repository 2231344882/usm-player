/**
 * USM 流式解码 worker。
 * 用站点同款 Rust→WASM 解码器（vendor/usm_decoder.js），把 USM 字节流解成：
 *   - init_segment + WebM clusters（VP9，可直接喂 MSE）
 *   - 每路音轨的 Float32 PCM 平面（给 WebAudio 排程）
 */
import init, { UsmStreamDecoder, decode_usm_to_mkv } from './vendor/usm_decoder.js';

const decoders = new Map();
let inited = null;

function ensure() {
  if (!inited) inited = init();
  return inited;
}

function pack(raw) {
  const pcm = [];
  for (const p of raw.audio_pcm_chunks || []) {
    const bytes = p.pcm_i16_bytes;
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const nch = p.channel_count | 0;
    const frames = Math.floor(i16.length / nch);
    const planes = [];
    for (let c = 0; c < nch; c++) {
      const plane = new Float32Array(frames);
      for (let i = 0; i < frames; i++) plane[i] = i16[i * nch + c] / 32768;
      planes.push(plane);
    }
    pcm.push({
      ch: p.channel, sr: p.sample_rate, nch,
      ts: Number(p.timestamp_ms), planes,
    });
  }
  return {
    init: raw.init_segment || null,
    clusters: raw.clusters || [],
    pcm,
    dur: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
    ivf: raw.ivf_header || null,
    hca: (raw.hca_headers || []).map(h => ({ ch: h.channel, header: h.header })),
    kf: raw.keyframes || [],
  };
}

function transferList(r) {
  const t = [];
  if (r.init) t.push(r.init.buffer);
  for (const c of r.clusters) t.push(c.buffer);
  for (const p of r.pcm) for (const pl of p.planes) t.push(pl.buffer);
  if (r.ivf) t.push(r.ivf.buffer);
  for (const h of r.hca) t.push(h.header.buffer);
  return t;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  const id = m.id;
  try {
    await ensure();
    if (m.t === 'mkv') {
      try {
        const out = decode_usm_to_mkv(new Uint8Array(m.data), m.key);
        self.postMessage({ t: 'mkv', rid: m.rid, data: out.buffer }, [out.buffer]);
      } catch (err) {
        self.postMessage({ t: 'mkverr', rid: m.rid, message: String((err && err.message) || err) });
      }
      return;
    }
    if (m.t === 'create') {
      if (decoders.has(id)) {
        try { decoders.get(id).free(); } catch (_) {}
        decoders.delete(id);
      }
      decoders.set(id, new UsmStreamDecoder(m.key));
      self.postMessage({ t: 'ok', id, kind: 'create' });
      return;
    }
    const dec = decoders.get(id);
    if (!dec) throw new Error('解码会话不存在');

    if (m.t === 'push') {
      const r = pack(dec.push(new Uint8Array(m.data)));
      self.postMessage({ t: 'res', id, ...r }, transferList(r));
      return;
    }
    if (m.t === 'finish') {
      const r = pack(dec.finish());
      self.postMessage({ t: 'res', id, ...r }, transferList(r));
      return;
    }
    if (m.t === 'reset') {
      dec.reset(
        new Uint8Array(m.ivf),
        (m.channels || []).map(c => ({ channel: c.channel, header: new Uint8Array(c.header), skip: c.skip })),
        BigInt(m.baseOffset),
      );
      self.postMessage({ t: 'ok', id, kind: 'reset' });
      return;
    }
    if (m.t === 'free') {
      try { dec.free(); } catch (_) {}
      decoders.delete(id);
      return;
    }
  } catch (err) {
    self.postMessage({ t: 'err', id, message: String((err && err.message) || err) });
  }
};
