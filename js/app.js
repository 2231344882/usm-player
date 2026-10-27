'use strict';

import { LivePlayer } from './live.js';

const $ = (id) => document.getElementById(id);
const LANGS = [['chi', '汉语'], ['eng', 'English'], ['jpn', '日本語'], ['kor', '한국어']];

// 默认代理：作者部署的 Deno Deploy 实例（可在「代理设置」里改成自己的）
const DEFAULT_PROXY = 'https://usm-proxy.xyh223.deno.net/?url=';

const S = {
  items: [], meta: null, filter: '', mode: 'direct', item: null, player: null,
  proxy: localStorage.getItem('usm.proxy') ?? DEFAULT_PROXY, lang: 'chi',
  local: null,           // {file, name, key, keyHex}
  busy: false,
};

const fmtMB = (n) => (n ? (n / 1048576).toFixed(1) : '0');
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return `${m}:${String(x).padStart(2, '0')}`;
};
let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ------------------------------------------------------------------ 目录
async function loadCatalog() {
  const r = await fetch('data/catalog.json');
  const data = await r.json();
  S.items = data.items || [];
  S.meta = data.meta || {};
  $('stat').textContent = `${S.meta.count} 部 · 直链 ${S.meta.direct} · 分块 ${S.meta.chunk}`;
  $('nDirect').textContent = S.meta.direct;
  $('nChunk').textContent = S.meta.chunk;
  $('nAll').textContent = S.meta.count;
  renderList();
}

function renderList() {
  const q = S.filter.trim().toLowerCase();
  const box = $('list');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const it of S.items) {
    if (S.mode === 'direct' && it.mode !== 'direct') continue;
    if (S.mode === 'chunk' && it.mode !== 'chunk') continue;
    if (q && !((it.desc || '') + ' ' + it.name).toLowerCase().includes(q)) continue;
    shown++;
    const row = document.createElement('div');
    row.className = 'item' + (S.item === it ? ' active' : '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.desc || it.name;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = `${it.name} · ${it.entry} · ${(it.size / 1048576).toFixed(1)} MB`;
    meta.append(t, s);
    const tag = document.createElement('span');
    const ok = it.mode === 'direct';
    tag.className = 'tag ' + (ok ? 'ok' : 'warn');
    tag.textContent = ok ? '可播' : (it.mode === 'chunk' ? '分块' : '无源');
    row.append(meta, tag);
    row.onclick = () => onPick(it);
    frag.appendChild(row);
  }
  if (!shown) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = '没有匹配的条目';
    frag.appendChild(d);
  }
  box.appendChild(frag);
}

// ------------------------------------------------------------------ 选片
async function onPick(it) {
  S.item = it;
  renderList();
  if (it.mode !== 'direct') {
    if (it.mode === 'chunk') {
      toast('这一部官方只发「分块包」，纯静态站没法自己解分块；用本地版播放器，或先把文件下载下来再拖进来。', 5200);
    } else {
      toast('这一部官方已经下架（无直链、无分块）。');
    }
    return;
  }
  if (!S.proxy) {
    openProxy();
    toast('先配一个代理，才能在线播放（官方 CDN 不让跨域）', 4200);
    return;
  }
  S.local = null;
  await startPlay({
    title: it.desc || it.name,
    sub: `${it.name} · ${it.entry} · ${(it.size / 1048576).toFixed(1)} MB`,
    url: S.proxy + encodeURIComponent(it.url),
    size: it.size,
    keyHex: it.key,
    keyA: it.keyA,
    keyB: it.keyB,
    remote: it.url,
  });
}

// ------------------------------------------------------------------ 播放器
function resetStage() {
  $('empty').classList.add('hidden');
  $('frame').classList.remove('hidden');
  $('err').classList.add('hidden');
  $('bigbtn').classList.remove('hidden');
  $('title').textContent = '—';
  $('sub').textContent = '';
  $('dl').textContent = '0';
  $('buf').textContent = '0.0';
  $('tm').textContent = '0:00 / 0:00';
}

function destroyPlayer() {
  if (S.player) {
    try { S.player.destroy(); } catch (_) {}
    S.player = null;
  }
}

async function startPlay(info) {
  destroyPlayer();
  resetStage();
  $('title').textContent = info.title;
  $('sub').textContent = info.sub || '';

  const player = new LivePlayer({
    video: $('v'),
    on: {
      state: (s) => {
        if (s === 'buffering') $('hint').innerHTML = '缓冲中…（边下边解密）';
        if (s === 'seeking') $('hint').innerHTML = '跳转中…';
        if (s === 'playing') { $('bigbtn').classList.add('hidden'); $('play').textContent = '暂停'; }
        if (s === 'paused') $('play').textContent = '播放';
      },
      duration: (d) => {
        $('seek').max = String(Math.max(1, Math.round(d * 10)));
        renderTime(d);
      },
      time: (t) => {
        $('seek').value = String(Math.round(t * 10));
        renderTime();
      },
      stats: ({ received, ahead }) => {
        $('dl').textContent = fmtMB(received);
        $('buf').textContent = (ahead || 0).toFixed(1);
      },
      channels: (list) => {
        [...$('langs').children].forEach((b) => { b.disabled = !list.includes(b.dataset.code); });
      },
      error: (m) => { $('err').textContent = m; $('err').classList.remove('hidden'); },
    },
  });
  S.player = player;
  try {
    await player.load(info, 0);
  } catch (e) {
    $('err').textContent = '初始化失败：' + e.message;
    $('err').classList.remove('hidden');
  }
  buildLangs();
}

let duration = 0;
function renderTime() {
  const t = $('v').currentTime || 0;
  $('tm').textContent = `${fmtTime(t)} / ${fmtTime(S.player && S.player.duration ? S.player.duration : duration)}`;
}

function buildLangs() {
  const box = $('langs');
  box.innerHTML = '';
  for (const [code, label] of LANGS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.code = code;
    b.className = code === S.lang ? 'on' : '';
    b.disabled = code !== 'chi';       // 实际有几路以解码结果为准，channels 回调会放开
    b.onclick = () => {
      if (!S.player) return;
      S.lang = code;
      S.player.setLang(code);
      [...box.children].forEach((x) => x.classList.toggle('on', x.dataset.code === code));
    };
    box.appendChild(b);
  }
}

// ------------------------------------------------------------------ 本地文件
function keyForName(name) {
  const base = name.replace(/\.usm$/i, '');
  const it = S.items.find((x) => x.name === base);
  return it ? { keyHex: it.key, keyA: it.keyA, keyB: it.keyB, item: it } : null;
}

async function playLocal(file) {
  let k = keyForName(file.name);
  if (!k || !k.keyHex) {
    const hex = prompt(`本地文件 ${file.name}\n\n密钥库里没有它，请填 16 位密钥（8 字节 hex）：`, '');
    if (!hex) return;
    if (!/^[0-9a-fA-F]{16}$/.test(hex)) { toast('密钥格式不对，应为 16 位 hex'); return; }
    const raw = hex.match(/../g).map((h) => parseInt(h, 16));
    const u32 = (arr) => (arr[3] << 24 | arr[2] << 16 | arr[1] << 8 | arr[0]) >>> 0;
    k = { keyHex: hex.toUpperCase(), keyA: u32(raw.slice(4, 8)).toString(16).toUpperCase().padStart(8, '0'),
          keyB: u32(raw.slice(0, 4)).toString(16).toUpperCase().padStart(8, '0') };
  }
  S.local = { file, name: file.name, keyHex: k.keyHex };
  S.item = k.item || null;
  renderList();
  await startPlay({
    title: k.item ? (k.item.desc || file.name) : file.name,
    sub: '本地文件 · ' + (file.size / 1048576).toFixed(1) + ' MB',
    size: file.size,
    keyHex: k.keyHex,
    localFile: file,
    makeUrl: (from) => ({ url: URL.createObjectURL(file.slice(from)), ranged: false }),
    scanRange: async (from, len) => new Uint8Array(await file.slice(from, from + len).arrayBuffer()),
  });
}

// ------------------------------------------------------------------ 导出 MKV（纯前端）
async function exportMkv() {
  if (!S.player) { toast('先播一部'); return; }
  const btn = $('exp');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '准备中…';
  try {
    let bytes;
    if (S.local && S.local.file) {
      btn.textContent = '读取文件…';
      bytes = new Uint8Array(await S.local.file.arrayBuffer());
    } else {
      const info = S.player.info;
      if (!info || !info.remote) { toast('当前没有可导出的源'); return; }
      btn.textContent = '下载中…';
      const res = await fetch(S.proxy + encodeURIComponent(info.remote));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    btn.textContent = '封装 MKV…';
    const mkv = await S.player.exportMkv(bytes);
    const blob = new Blob([mkv], { type: 'video/x-matroska' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.item ? S.item.name : (S.local ? S.local.name.replace(/\.usm$/i, '') : 'video')) + '.mkv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('已导出 ' + a.download);
  } catch (e) {
    toast('导出失败：' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ------------------------------------------------------------------ 代理
function openProxy() {
  $('proxyInput').value = S.proxy;
  $('proxyTest').textContent = '';
  $('proxyModal').classList.remove('hidden');
}
$('proxySave').onclick = () => {
  S.proxy = $('proxyInput').value.trim();
  localStorage.setItem('usm.proxy', S.proxy);   // 空字符串 = 显式关闭代理
  $('proxyModal').classList.add('hidden');
  toast(S.proxy ? '代理已保存' : '已清空代理');
};
$('proxyClear').onclick = () => { $('proxyInput').value = ''; };
$('proxyTestBtn').onclick = async () => {
  const p = $('proxyInput').value.trim();
  if (!p) { $('proxyTest').textContent = '先填地址'; return; }
  $('proxyTest').textContent = '测试中…';
  try {
    const probe = p + encodeURIComponent('https://autopatchcn.yuanshen.com/client_app/download/pc_zip/20220625003700_3RiwWggLSQ14iInN/ScatteredFiles/YuanShen_Data/StreamingAssets/VideoAssets/StandaloneWindows64/Cs_MD_EQ400671001_KazuhaMemory.usm');
    const r = await fetch(probe, { headers: { Range: 'bytes=0-31' } });
    const n = (await r.arrayBuffer()).byteLength;
    $('proxyTest').textContent = `OK：HTTP ${r.status}，拿到 ${n} 字节`;
  } catch (e) {
    $('proxyTest').textContent = '失败：' + e.message;
  }
};

// ------------------------------------------------------------------ 交互
$('search').oninput = (e) => { S.filter = e.target.value; renderList(); };
$('seg').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.mode = b.dataset.mode;
  [...$('seg').children].forEach((x) => x.classList.toggle('on', x === b));
  renderList();
};
$('btnProxy').onclick = openProxy;
$('btnLocal').onclick = () => $('file').click();
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) playLocal(f); e.target.value = ''; };

$('play').onclick = () => {
  if (!S.player) return;
  if ($('v').paused) S.player.play(); else S.player.pause();
};
$('bigbtn').onclick = () => S.player && S.player.play();
$('v').addEventListener('click', () => { if (!S.player) return; $('v').paused ? S.player.play() : S.player.pause(); });
$('vol').oninput = () => S.player && S.player.setVolume(Number($('vol').value) / 100);
$('full').onclick = () => {
  const s = $('stage');
  document.fullscreenElement ? document.exitFullscreen() : s.requestFullscreen && s.requestFullscreen();
};
$('exp').onclick = exportMkv;

$('seek').addEventListener('change', () => {
  if (!S.player) return;
  S.player.seek(Number($('seek').value) / 10);
});

// 拖拽
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('drop').classList.remove('hidden'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.add('hidden');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  if (!/\.usm$/i.test(f.name)) { toast('只支持 .usm 文件'); return; }
  playLocal(f);
});

document.addEventListener('keydown', (e) => {
  if (!S.player || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); $('v').paused ? S.player.play() : S.player.pause(); }
  else if (e.code === 'ArrowRight') S.player.seek(($('v').currentTime || 0) + 5);
  else if (e.code === 'ArrowLeft') S.player.seek(Math.max(0, ($('v').currentTime || 0) - 5));
  else if (e.code === 'KeyF') $('full').click();
});

window.__usm = S;   // 调试用

loadCatalog().catch((e) => { $('stat').textContent = '目录加载失败：' + e.message; });
