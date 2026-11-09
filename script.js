(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var RUN = { run: true }, ITEM = { item: true };
  var state = { items: [], run: 0, nextId: 1, dl: undefined, busy: false };
  var MIN_Q_RESIZE = 0.5, MIN_Q = 0.04, TOP_Q = 0.95;
  var EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  var TYPE_LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP' };

  var nf1 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmt(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) { var k = b / 1024; return (k >= 100 ? Math.round(k) : nf1.format(k)) + ' KB'; }
    return nf2.format(b / 1048576) + ' MB';
  }

  /* Pengaturan */
  var KMIN = 10, KMAX = 5000;
  function kbToT(kb) { return clamp(Math.log(kb / KMIN) / Math.log(KMAX / KMIN) * 100, 0, 100); }
  function tToKb(t) {
    var v = KMIN * Math.pow(KMAX / KMIN, t / 100);
    var step = v >= 1000 ? 50 : v >= 100 ? 10 : v >= 40 ? 5 : 1;
    return Math.max(5, Math.round(v / step) * step);
  }
  function getFmt() { var r = document.querySelector('input[name="fmt"]:checked'); return r ? r.value : 'auto'; }
  function getSettings() {
    var kb = parseFloat($('#kb').value);
    if (!(kb > 0)) return null;
    kb = clamp(kb, 5, 20000);
    var md = parseInt($('#maxDim').value, 10);
    return { kb: kb, fmt: getFmt(), maxDim: md > 0 ? md : 0, resize: $('#resize').checked };
  }
  var HINTS = {
    auto: 'Format asli dipertahankan. JPEG dan WebP dikecilkan lewat kualitas, PNG lewat dimensi.',
    jpeg: 'JPEG paling cocok untuk foto. Latar transparan diganti putih.',
    webp: 'WebP lebih kecil dari JPEG pada kualitas yang sama, tetapi tidak semua aplikasi bisa membukanya.',
    png: 'PNG tidak punya pengaturan kualitas. Ukuran hanya turun dengan memperkecil dimensi.'
  };
  function syncUI() {
    var kb = parseFloat($('#kb').value);
    if (kb > 0) $('#kbRange').value = kbToT(kb);
    document.querySelectorAll('#chips .chip').forEach(function (c) { c.setAttribute('aria-pressed', String(+c.dataset.kb === kb)); });
    $('#fmtHint').textContent = HINTS[getFmt()];
  }
  var timer = null;
  function schedule() {
    syncUI();
    clearTimeout(timer);
    timer = setTimeout(function () { if (getSettings()) runAll(true); }, 450);
  }

  /* Gambar */
  var encOK = {};
  function canEncode(type) {
    if (type in encOK) return encOK[type];
    var c = document.createElement('canvas'); c.width = c.height = 1;
    var ok = false;
    try { ok = c.toDataURL(type).indexOf('data:' + type) === 0; } catch (e) {}
    return (encOK[type] = ok);
  }
  async function decode(file) {
    try { return await createImageBitmap(file); } catch (e) {}
    return await new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
  }
  function toBlob(c, t, q) {
    return new Promise(function (res, rej) {
      c.toBlob(function (b) { b ? res(b) : rej(new Error('encode')); }, t, q);
    });
  }
  function draw(img, w, h, type) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d');
    if (type === 'image/jpeg') { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, w, h);
    return c;
  }
  function pickType(fileType, fmtSel) {
    if (fmtSel === 'jpeg') return 'image/jpeg';
    if (fmtSel === 'png') return 'image/png';
    if (fmtSel === 'webp') return canEncode('image/webp') ? 'image/webp' : 'image/jpeg';
    if (fileType === 'image/jpeg' || fileType === 'image/png') return fileType;
    if (fileType === 'image/webp' && canEncode('image/webp')) return fileType;
    return 'image/jpeg';
  }

  async function fitQuality(c, type, limit, qmin, chk) {
    var b = await toBlob(c, type, TOP_Q); chk();
    if (b.size <= limit) return { blob: b, q: TOP_Q, ok: true };
    var lo = qmin, hi = TOP_Q;
    var bl = await toBlob(c, type, lo); chk();
    if (bl.size > limit) return { blob: bl, q: lo, ok: false };
    var best = bl, bq = lo;
    for (var i = 0; i < 7; i++) {
      var mid = (lo + hi) / 2;
      var m = await toBlob(c, type, mid); chk();
      if (m.size <= limit) { best = m; bq = mid; lo = mid; } else { hi = mid; }
    }
    return { blob: best, q: bq, ok: true };
  }
  async function lossyFit(img, ow, oh, scale0, limit, type, resize, chk) {
    var qmin = resize ? MIN_Q_RESIZE : MIN_Q;
    var scale = scale0, last = null;
    for (var n = 0; n < 10; n++) {
      var w = Math.max(1, Math.round(ow * scale)), h = Math.max(1, Math.round(oh * scale));
      var r = await fitQuality(draw(img, w, h, type), type, limit, qmin, chk);
      last = { blob: r.blob, w: w, h: h, q: r.q, ok: r.ok };
      if (r.ok || !resize) return last;
      scale *= clamp(Math.sqrt(limit / r.blob.size) * 0.97, 0.4, 0.93);
      if (Math.max(ow, oh) * scale < 40) break;
    }
    return last;
  }
  async function pngFit(img, ow, oh, scale0, limit, resize, chk) {
    async function enc(sc) {
      var w = Math.max(1, Math.round(ow * sc)), h = Math.max(1, Math.round(oh * sc));
      var b = await toBlob(draw(img, w, h, 'image/png'), 'image/png'); chk();
      return { blob: b, w: w, h: h };
    }
    var r = await enc(scale0);
    if (r.blob.size <= limit) { r.ok = true; return r; }
    if (!resize) { r.ok = false; return r; }
    var hi = scale0, lo = 0.03, best = null, last = r;
    var sc = clamp(scale0 * Math.sqrt(limit / r.blob.size) * 0.95, lo, hi * 0.99);
    for (var i = 0; i < 9; i++) {
      var t = await enc(sc); last = t;
      if (t.blob.size <= limit) { best = t; lo = sc; } else { hi = sc; }
      if (best && best.blob.size >= limit * 0.93) break;
      sc = Math.sqrt(lo * hi);
    }
    if (best) { best.ok = true; return best; }
    last.ok = false; return last;
  }

  async function compress(item, s, chk) {
    var limit = Math.floor(s.kb * 1024 * 0.99);
    var img = await decode(item.file); chk();
    var ow = img.naturalWidth || img.width, oh = img.naturalHeight || img.height;
    item.ow = ow; item.oh = oh;
    var type = pickType(item.file.type, s.fmt), note = '';
    if (s.fmt === 'webp' && type !== 'image/webp') note = 'Browser ini tidak bisa membuat WebP, JPEG dipakai.';
    var scale0 = s.maxDim ? Math.min(1, s.maxDim / Math.max(ow, oh)) : 1;
    var res;
    try {
      if (item.file.size <= limit && type === item.file.type && scale0 === 1) {
        res = { blob: item.file, w: ow, h: oh, ok: true, kept: true, q: null };
        note = 'Sudah di bawah batas, file tidak diubah.';
      } else if (type === 'image/png') {
        res = await pngFit(img, ow, oh, scale0, limit, s.resize, chk);
      } else {
        res = await lossyFit(img, ow, oh, scale0, limit, type, s.resize, chk);
      }
    } finally {
      if (img.close) img.close();
    }
    res.type = type;
    if (!res.ok) {
      if (type === 'image/png' && !s.resize) note = 'PNG tidak bisa dikecilkan lagi tanpa mengubah dimensi.';
      else if (!s.resize) note = 'Kualitas sudah paling rendah. Aktifkan perkecil dimensi.';
      else note = 'Batas terlalu kecil untuk foto ini.';
    }
    res.note = note;
    return res;
  }

  /* Antrian */
  async function runAll(reset) {
    var run = ++state.run;
    var s = getSettings();
    if (!s) return;
    state.items.forEach(function (it) {
      if (reset || it.status === 'work') {
        it.status = 'wait';
        if (reset) { it.blob = null; it.note = ''; it.q = null; it.kept = false; }
        updateRow(it);
      }
    });
    state.busy = true; updateSummary();
    var queue = state.items.slice();
    for (var i = 0; i < queue.length; i++) {
      var it = queue[i];
      if (run !== state.run) return;
      if (it.status !== 'wait' || it.removed) continue;
      it.status = 'work'; updateRow(it); updateSummary();
      var chk = (function (item) { return function () {
        if (run !== state.run) throw RUN;
        if (item.removed) throw ITEM;
      }; })(it);
      var es = it.kbOverride ? Object.assign({}, s, { kb: it.kbOverride }) : s;
      try {
        var res = await compress(it, es, chk);
        it.blob = res.blob; it.w = res.w; it.h = res.h; it.q = res.q; it.type = res.type;
        it.kept = !!res.kept; it.note = res.note; it.targetBytes = Math.round(es.kb * 1024);
        it.status = res.kept ? 'skip' : (res.ok ? 'ok' : 'warn');
      } catch (e) {
        if (e === RUN) return;
        if (e === ITEM) continue;
        it.status = 'err';
        it.note = 'Foto tidak bisa dibaca browser.';
      }
      updateRow(it); updateSummary();
    }
    if (run === state.run) { state.busy = false; updateSummary(); }
  }

  var IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;
  var MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };
  function isZip(f) { return /\.zip$/i.test(f.name) || /zip/.test(f.type); }

  async function expand(list) {
    var out = [], extracted = 0, skipped = 0;
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!isZip(f)) { out.push(f); continue; }
      if (!window.JSZip) { toast('Pustaka ZIP gagal dimuat.'); continue; }
      toast('Mengekstrak ' + f.name + '…');
      try {
        var z = await window.JSZip.loadAsync(f);
        var names = Object.keys(z.files);
        for (var j = 0; j < names.length; j++) {
          var e = z.files[names[j]];
          var base = names[j].split('/').pop();
          if (e.dir || !base || base.charAt(0) === '.' || names[j].indexOf('__MACOSX/') === 0) continue;
          if (!IMG_RE.test(base)) { skipped++; continue; }
          var ext = (base.match(/\.([^.]+)$/) || [])[1] || '';
          var blob = await e.async('blob');
          out.push(new File([blob], base, { type: MIME[ext.toLowerCase()] || '' }));
          extracted++;
        }
      } catch (err) {
        toast(f.name + ' tidak bisa dibuka.');
      }
    }
    if (extracted || skipped) toast(extracted + ' foto diekstrak dari ZIP.');
    return out;
  }

  async function addFiles(list, example) {
    var raw = Array.prototype.slice.call(list);
    var src = example ? raw : await expand(raw);
    var files = src.filter(function (f) { return /^image\//.test(f.type) || IMG_RE.test(f.name); });
    if (!files.length) { toast('Tidak ada foto yang bisa diproses.'); return; }
    if (!example) state.items.filter(function (i) { return i.example; }).forEach(removeItem);
    files.forEach(function (f) {
      var it = { id: state.nextId++, file: f, status: 'wait', example: !!example, url: URL.createObjectURL(f), blob: null, note: '' };
      state.items.push(it); mountRow(it);
    });
    runAll(false);
  }

  function removeItem(it) {
    it.removed = true;
    try { URL.revokeObjectURL(it.url); } catch (e) {}
    if (it.el) it.el.remove();
    state.items = state.items.filter(function (x) { return x !== it; });
    updateSummary();
  }

  function mountRow(it) {
    var node = $('#rowT').content.firstElementChild.cloneNode(true);
    it.el = node;
    node.querySelector('.thumb img').src = it.url;
    node.querySelector('.name').textContent = it.file.name;
    node.querySelector('.save').addEventListener('click', function () { if (it.blob) saveBlob(outName(it), it.blob); });
    node.querySelector('.rm').addEventListener('click', function () { removeItem(it); });
    var own = node.querySelector('.own-kb');
    own.addEventListener('change', function () {
      var v = parseFloat(own.value);
      it.kbOverride = v > 0 ? clamp(v, 5, 20000) : null;
      own.value = it.kbOverride || '';
      it.status = 'wait'; it.blob = null; it.note = ''; updateRow(it);
      runAll(false);
    });
    $('#list').appendChild(node);
    updateRow(it); updateSummary();
  }

  var LABELS = { wait: 'Menunggu', work: 'Memproses', ok: 'Selesai', warn: 'Di atas batas', skip: 'Tidak diubah', err: 'Gagal' };
  var GLYPH = { wait: '…', work: '', ok: '✓', warn: '!', skip: '–', err: '×' };

  function updateRow(it) {
    var el = it.el; if (!el) return;
    var q = function (s) { return el.querySelector(s); };
    el.dataset.state = it.status;
    var gs = getSettings();
    q('.own-kb').placeholder = gs ? String(Math.round(gs.kb)) : '';
    q('.pill-t').textContent = LABELS[it.status];
    q('.pill .g').textContent = GLYPH[it.status];
    q('.note').textContent = it.note || '';
    q('.from').textContent = fmt(it.file.size);
    var done = !!it.blob && (it.status === 'ok' || it.status === 'warn' || it.status === 'skip');
    q('.to').textContent = done ? fmt(it.blob.size) : '…';
    var pct = done ? Math.round((1 - it.blob.size / it.file.size) * 100) : 0;
    q('.pct').textContent = !done ? '' : pct > 0 ? '−' + pct + '%' : pct < 0 ? '+' + Math.abs(pct) + '%' : '0%';
    q('.b-new').style.width = done ? clamp(it.blob.size / it.file.size * 100, 0.8, 100) + '%' : '0%';
    var bt = q('.b-target'), tg = it.targetBytes || 0;
    if (done && tg && tg < it.file.size) { bt.style.display = 'block'; bt.style.left = clamp(tg / it.file.size * 100, 0, 100) + '%'; }
    else bt.style.display = 'none';
    var meta = [];
    if (it.ow) {
      var dim = it.ow + '×' + it.oh;
      if (done && it.w && (it.w !== it.ow || it.h !== it.oh)) dim += ' → ' + it.w + '×' + it.h;
      meta.push(dim);
    }
    if (done && it.type) meta.push(TYPE_LABEL[it.type] || '');
    if (done && it.q) meta.push('kualitas ' + Math.round(it.q * 100));
    var m = q('.meta'); m.textContent = meta.filter(Boolean).join(' · ');
    var old = q('.tag'); if (old) old.remove();
    if (it.example) { var t = document.createElement('span'); t.className = 'tag'; t.textContent = 'Contoh'; q('.name').appendChild(t); }
  }

  function updateSummary() {
    var n = state.items.length;
    $('#count').textContent = n ? '(' + n + ' foto)' : '';
    $('#empty').hidden = n > 0;
    $('#zipBtn').hidden = n < 2; $('#clearBtn').hidden = n === 0;
    var done = state.items.filter(function (i) { return i.blob; });
    var pending = state.items.filter(function (i) { return i.status === 'wait' || i.status === 'work'; }).length;
    var box = $('#totals'); box.textContent = '';
    if (!n) return;
    if (pending) { box.textContent = 'Memproses...'; return; }
    var so = 0, sn = 0;
    done.forEach(function (i) { so += i.file.size; sn += i.blob.size; });
    if (!done.length) return;
    var saved = Math.round((1 - sn / so) * 100);
    var a = document.createElement('strong'); a.textContent = fmt(so);
    var b = document.createElement('strong'); b.textContent = fmt(sn);
    box.append('Total ', a, ' → ', b, saved > 0 ? ' · hemat ' + saved + '%' : '');
  }

  function outName(it) {
    if (it.kept) return it.file.name;
    var base = it.file.name.replace(/\.[^.]+$/, '') || 'foto';
    return base + '-kompres.' + (EXT[it.type] || 'jpg');
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  function saveBlob(name, blob) {
    var u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
    toast('Mengunduh: ' + name);
  }

  async function saveZip() {
    if (!window.JSZip) { toast('Pustaka ZIP gagal dimuat.'); return; }
    var items = state.items.filter(function (i) { return i.blob; });
    if (!items.length) return;
    var z = new window.JSZip(), used = {};
    items.forEach(function (i) {
      var nm = outName(i), k = 1, base = nm.replace(/(\.[^.]+)$/, ''), ext = (nm.match(/\.[^.]+$/) || [''])[0];
      while (used[nm.toLowerCase()]) { k++; nm = base + '-' + k + ext; }
      used[nm.toLowerCase()] = 1; z.file(nm, i.blob);
    });
    var blob = await z.generateAsync({ type: 'blob', compression: 'STORE' });
    saveBlob('foto-terkompres.zip', blob);
  }

  /* Event Listeners Foto */
  $('#file').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); if (drop.contains(e.target)) drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (ev === 'drop') e.preventDefault(); drop.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    if ($('#view-foto').hidden) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  $('#kb').addEventListener('input', schedule);
  $('#kbRange').addEventListener('input', function (e) { $('#kb').value = tToKb(parseFloat(e.target.value)); schedule(); });
  $('#chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    $('#kb').value = b.dataset.kb; schedule();
  });
  document.querySelectorAll('input[name="fmt"]').forEach(function (r) { r.addEventListener('change', schedule); });
  $('#maxDim').addEventListener('input', schedule);
  $('#resize').addEventListener('change', schedule);
  $('#zipBtn').addEventListener('click', saveZip);
  $('#clearBtn').addEventListener('click', function () { state.run++; state.items.slice().forEach(removeItem); state.busy = false; updateSummary(); });

  window.KompresApp = { fmt: fmt, toast: toast, clamp: clamp, saveBlob: saveBlob, fitQuality: fitQuality, kbToT: kbToT, tToKb: tToKb };
  syncUI(); updateSummary();
})();

/* ===================================================================
   Menu (tab) dan Kompres PDF
   =================================================================== */
(function () {
  'use strict';
  var K = window.KompresApp;
  var $ = function (s) { return document.querySelector(s); };
  if (!K) return;

  var names = ['foto', 'pdf'];
  function show(name) {
    names.forEach(function (n) {
      var on = n === name, t = $('#tab-' + n), v = $('#view-' + n);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      v.hidden = !on;
    });
  }
  function fromHash() {
    var h = (location.hash || '').replace('#', '');
    show(names.indexOf(h) >= 0 ? h : 'foto');
  }
  names.forEach(function (n, i) {
    var t = $('#tab-' + n);
    t.addEventListener('click', function () {
      show(n);
      try { history.replaceState(null, '', '#' + n); } catch (e) { try { location.hash = n; } catch (e2) {} }
    });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var j = (i + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
      show(names[j]); $('#tab-' + names[j]).focus(); e.preventDefault();
    });
  });
  window.addEventListener('hashchange', fromHash);
  fromHash();

  var RUN = { run: true }, ITEM = { item: true };
  var P = { items: [], run: 0, nextId: 1 };
  var WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
  var MIN_SCALE = 0.55, MIN_Q = 0.45, MAX_PIXELS = 14e6;

  function getS() {
    var kb = parseFloat($('#pdfKb').value);
    if (!(kb > 0)) return null;
    return { kb: K.clamp(kb, 10, 50000), dpi: parseInt($('#pdfDpi').value, 10) || 150, gray: $('#pdfGray').checked };
  }
  function syncUI() {
    var kb = parseFloat($('#pdfKb').value);
    if (kb > 0) $('#pdfRange').value = K.kbToT(kb);
    document.querySelectorAll('#pdfChips .chip').forEach(function (c) {
      c.setAttribute('aria-pressed', String(+c.dataset.kb === kb));
    });
  }
  var timer = null;
  function schedule() {
    syncUI();
    clearTimeout(timer);
    timer = setTimeout(function () { if (getS()) runAll(true); }, 600);
  }

  async function renderPage(page, scale, gray) {
    var vp = page.getViewport({ scale: scale });
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
    var ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (gray) {
      var d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        var g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
        p[i] = p[i + 1] = p[i + 2] = g;
      }
      ctx.putImageData(d, 0, 0);
    }
    return c;
  }

  async function encodePage(page, scale0, budget, gray, chk) {
    var v1 = page.getViewport({ scale: 1 });
    var scale = Math.min(scale0, Math.sqrt(MAX_PIXELS / (v1.width * v1.height))), last = null;
    for (var n = 0; n < 6; n++) {
      var c = await renderPage(page, scale, gray); chk();
      var r = await K.fitQuality(c, 'image/jpeg', budget, MIN_Q, chk);
      last = { blob: r.blob, q: r.q, ok: r.ok, scale: scale, w: v1.width, h: v1.height };
      if (r.ok || scale <= MIN_SCALE + 0.001) return last;
      scale = Math.max(MIN_SCALE, scale * K.clamp(Math.sqrt(budget / r.blob.size) * 0.97, 0.5, 0.93));
    }
    return last;
  }

  async function compress(it, s, chk, prog) {
    var limit = Math.floor(s.kb * 1024 * 0.99);
    if (it.file.size <= limit) return { blob: it.file, kept: true, ok: true, note: 'Sudah di bawah batas.' };
    if (!window.pdfjsLib || !window.PDFLib) throw { name: 'NoLib' };
    var data = new Uint8Array(await it.file.arrayBuffer()); chk();
    var pdf = await window.pdfjsLib.getDocument({ data: data, isEvalSupported: false }).promise; chk();
    try {
      var n = pdf.numPages; it.pages = n;
      if (!it.thumb) {
        var p1 = await pdf.getPage(1), v = p1.getViewport({ scale: 1 });
        var tc = await renderPage(p1, Math.min(1, 160 / v.width), false);
        it.thumb = tc.toDataURL('image/jpeg', 0.7); p1.cleanup();
      }
      var target = limit, best = null;
      for (var pass = 0; pass < 3; pass++) {
        var doc = await window.PDFLib.PDFDocument.create();
        var remaining = target - (1500 + 500 * n), qSum = 0, sMin = 99;
        for (var i = 1; i <= n; i++) {
          chk(); prog(i, n, pass);
          var page = await pdf.getPage(i);
          var budget = Math.max(2000, remaining / (n - i + 1));
          var r = await encodePage(page, s.dpi / 72, budget, s.gray, chk);
          var jpg = await doc.embedJpg(await r.blob.arrayBuffer());
          doc.addPage([r.w, r.h]).drawImage(jpg, { x: 0, y: 0, width: r.w, height: r.h });
          remaining -= r.blob.size; qSum += r.q; sMin = Math.min(sMin, r.scale);
          page.cleanup();
        }
        var bytes = await doc.save();
        best = { bytes: bytes, q: qSum / n, dpi: Math.round(sMin * 72), ok: bytes.length <= limit };
        if (best.ok) break;
        target = target * (limit / bytes.length) * 0.97;
      }
      if (best.bytes.length >= it.file.size) {
        return { blob: it.file, kept: true, ok: false, note: 'PDF ini tidak bisa dikecilkan lagi.' };
      }
      return {
        blob: new Blob([best.bytes], { type: 'application/pdf' }), kept: false, ok: best.ok, q: best.q, dpi: best.dpi,
        note: best.ok ? '' : 'Batas terlalu kecil untuk PDF ini.'
      };
    } finally {
      pdf.destroy();
    }
  }

  async function runAll(reset) {
    var run = ++P.run, s = getS();
    if (!s) return;
    P.items.forEach(function (it) {
      if (reset || it.status === 'work') {
        it.status = 'wait';
        if (reset) { it.blob = null; it.note = ''; it.q = null; it.dpi = null; it.kept = false; }
        updateRow(it);
      }
    });
    updateSummary();
    var queue = P.items.slice();
    for (var k = 0; k < queue.length; k++) {
      var it = queue[k];
      if (run !== P.run) return;
      if (it.status !== 'wait' || it.removed) continue;
      it.status = 'work'; it.note = 'Menyiapkan…'; updateRow(it); updateSummary();
      var chk = (function (item) { return function () {
        if (run !== P.run) throw RUN;
        if (item.removed) throw ITEM;
      }; })(it);
      var prog = (function (item) { return function (i, n, pass) {
        item.note = 'Halaman ' + i + ' dari ' + n;
        updateRow(item);
      }; })(it);
      var es = it.kbOverride ? Object.assign({}, s, { kb: it.kbOverride }) : s;
      try {
        var res = await compress(it, es, chk, prog);
        it.blob = res.blob; it.dpi = res.dpi; it.q = res.q; it.kept = !!res.kept; it.note = res.note || '';
        it.targetBytes = Math.round(es.kb * 1024);
        it.status = res.ok ? (res.kept ? 'skip' : 'ok') : 'warn';
      } catch (e) {
        if (e === RUN) return;
        if (e === ITEM) continue;
        it.status = 'err';
        it.note = 'PDF tidak bisa dibaca.';
      }
      updateRow(it); updateSummary();
    }
    updateSummary();
  }

  function addFiles(list) {
    var files = Array.prototype.slice.call(list).filter(function (f) { return /pdf/i.test(f.type) || /\.pdf$/i.test(f.name); });
    if (!files.length) { K.toast('Pilih file PDF.'); return; }
    files.forEach(function (f) {
      var it = { id: P.nextId++, file: f, status: 'wait', blob: null, note: '' };
      P.items.push(it); mountRow(it);
    });
    runAll(false);
  }

  function removeItem(it) {
    it.removed = true;
    if (it.el) it.el.remove();
    P.items = P.items.filter(function (x) { return x !== it; });
    updateSummary();
  }

  function outName(it) {
    if (it.kept) return it.file.name;
    return (it.file.name.replace(/\.[^.]+$/, '') || 'dokumen') + '-kompres.pdf';
  }

  function mountRow(it) {
    var node = $('#rowT').content.firstElementChild.cloneNode(true);
    it.el = node;
    node.querySelector('.thumb').dataset.kind = 'pdf';
    node.querySelector('.name').textContent = it.file.name;
    node.querySelector('.own span').textContent = 'Batas khusus PDF ini';
    node.querySelector('.own-kb').setAttribute('aria-label', 'Batas KB khusus PDF ini');
    node.querySelector('.save').addEventListener('click', function () { if (it.blob) K.saveBlob(outName(it), it.blob); });
    node.querySelector('.rm').addEventListener('click', function () { removeItem(it); });
    var own = node.querySelector('.own-kb');
    own.addEventListener('change', function () {
      var v = parseFloat(own.value);
      it.kbOverride = v > 0 ? K.clamp(v, 10, 50000) : null;
      own.value = it.kbOverride || '';
      it.status = 'wait'; it.blob = null; it.note = ''; updateRow(it);
      runAll(false);
    });
    $('#pdfList').appendChild(node);
    updateRow(it); updateSummary();
  }

  var LABELS = { wait: 'Menunggu', work: 'Memproses', ok: 'Selesai', warn: 'Di atas batas', skip: 'Tidak diubah', err: 'Gagal' };
  var GLYPH = { wait: '…', work: '', ok: '✓', warn: '!', skip: '–', err: '×' };

  function updateRow(it) {
    var el = it.el; if (!el) return;
    var q = function (s) { return el.querySelector(s); };
    el.dataset.state = it.status;
    var gs = getS();
    q('.own-kb').placeholder = gs ? String(Math.round(gs.kb)) : '';
    q('.pill-t').textContent = LABELS[it.status];
    q('.pill .g').textContent = GLYPH[it.status];
    q('.note').textContent = it.note || '';
    q('.from').textContent = K.fmt(it.file.size);
    var done = !!it.blob && (it.status === 'ok' || it.status === 'warn' || it.status === 'skip');
    q('.to').textContent = done ? K.fmt(it.blob.size) : '…';
    var pct = done ? Math.round((1 - it.blob.size / it.file.size) * 100) : 0;
    q('.pct').textContent = !done ? '' : pct > 0 ? '−' + pct + '%' : pct < 0 ? '+' + Math.abs(pct) + '%' : '0%';
    q('.b-new').style.width = done ? K.clamp(it.blob.size / it.file.size * 100, 0.8, 100) + '%' : '0%';
    var bt = q('.b-target'), tg = it.targetBytes || 0;
    if (done && tg && tg < it.file.size) { bt.style.display = 'block'; bt.style.left = K.clamp(tg / it.file.size * 100, 0, 100) + '%'; }
    else bt.style.display = 'none';
    var meta = [];
    if (it.pages) meta.push(it.pages + ' halaman');
    if (done && it.dpi) meta.push('maks. ' + it.dpi + ' dpi');
    if (done && it.q) meta.push('kualitas ' + Math.round(it.q * 100));
    q('.meta').textContent = meta.join(' · ');
    if (it.thumb && !it.thumbSet) { q('.thumb img').src = it.thumb; it.thumbSet = true; }
  }

  function updateSummary() {
    var n = P.items.length;
    $('#pdfCount').textContent = n ? '(' + n + ' PDF)' : '';
    $('#pdfEmpty').hidden = n > 0;
    $('#pdfZipBtn').hidden = n < 2; $('#pdfClearBtn').hidden = n === 0;
    var box = $('#pdfTotals'); box.textContent = '';
    if (!n) return;
    var pending = P.items.filter(function (i) { return i.status === 'wait' || i.status === 'work'; }).length;
    if (pending) { box.textContent = 'Memproses...'; return; }
    var so = 0, sn = 0, c = 0;
    P.items.forEach(function (i) { if (i.blob) { so += i.file.size; sn += i.blob.size; c++; } });
    if (!c) return;
    var saved = Math.round((1 - sn / so) * 100);
    var a = document.createElement('strong'); a.textContent = K.fmt(so);
    var b = document.createElement('strong'); b.textContent = K.fmt(sn);
    box.append('Total ', a, ' → ', b, saved > 0 ? ' · hemat ' + saved + '%' : '');
  }

  async function saveZip() {
    if (!window.JSZip) { K.toast('Pustaka ZIP gagal dimuat.'); return; }
    var items = P.items.filter(function (i) { return i.blob; });
    if (!items.length) return;
    var z = new window.JSZip(), used = {};
    items.forEach(function (i) {
      var nm = outName(i), k = 1, base = nm.replace(/(\.[^.]+)$/, ''), ext = (nm.match(/\.[^.]+$/) || [''])[0];
      while (used[nm.toLowerCase()]) { k++; nm = base + '-' + k + ext; }
      used[nm.toLowerCase()] = 1; z.file(nm, i.blob);
    });
    K.saveBlob('pdf-terkompres.zip', await z.generateAsync({ type: 'blob', compression: 'STORE' }));
  }

  var drop = $('#pdfDrop');
  function pdfActive() { return !$('#view-pdf').hidden; }
  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (pdfActive() && drop.contains(e.target)) drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    document.addEventListener(ev, function () { drop.classList.remove('over'); });
  });
  document.addEventListener('drop', function (e) {
    if (!pdfActive()) return;
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  $('#pdfFile').addEventListener('change', function (e) { addFiles(e.target.value = '', e.target.files); });
  $('#pdfFile').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
  $('#pdfKb').addEventListener('input', schedule);
  $('#pdfRange').addEventListener('input', function (e) { $('#pdfKb').value = K.tToKb(parseFloat(e.target.value)); schedule(); });
  $('#pdfChips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    $('#pdfKb').value = b.dataset.kb; schedule();
  });
  $('#pdfDpi').addEventListener('change', schedule);
  $('#pdfGray').addEventListener('change', schedule);
  $('#pdfZipBtn').addEventListener('click', saveZip);
  $('#pdfClearBtn').addEventListener('click', function () { P.run++; P.items.slice().forEach(removeItem); updateSummary(); });
  syncUI(); updateSummary();
})();
