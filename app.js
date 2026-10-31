/* IMCO Sklad – hlavní aplikační logika (vanilla JS, bez buildu). */
(() => {
  'use strict';

  // ---------- Pomocné funkce ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const fmtDate = (ts) => new Date(ts).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const fmtQty = (n) => Number(n).toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
  const normCode = (c) => String(c ?? '').trim();

  const TYPE_LABEL = { receipt: 'Příjem', issue: 'Výdej', inventory: 'Inventura', adjust: 'Korekce', transfer: 'Přesun' };
  const ORDER_STATUS = { new: 'Nová', preparing: 'Připravuje se', ready: 'Připraveno', done: 'Vydáno', cancelled: 'Zrušeno' };
  const TYPE_BADGE = { receipt: 'ok', issue: 'warn', inventory: 'neutral', adjust: 'neutral', transfer: 'neutral' };
  const UNITS = ['ks', 'kg', 'g', 'l', 'ml', 'bal', 'krt', 'pal', 'm'];
  const APP_VERSION = '0.3.1';

  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function beep(ok = true) {
    try {
      const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = ok ? 1200 : 300; o.type = 'square'; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.08 : 0.25));
    } catch (_) { /* bez zvuku */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 40, 80]);
  }

  // ---------- Dialog ----------
  function dialog(html, { onOpen } = {}) {
    return new Promise((resolve) => {
      const m = $('#dlg'); const card = $('#dlgCard');
      card.innerHTML = html; m.classList.remove('hidden');
      const close = (val) => { m.classList.add('hidden'); card.innerHTML = ''; m.onclick = null; resolve(val); };
      m.onclick = (e) => { if (e.target === m) close(null); };
      $$('[data-close]', card).forEach(b => b.onclick = () => close(b.dataset.close === 'ok' ? collect(card) : null));
      const f = $('form', card);
      if (f) f.onsubmit = (e) => { e.preventDefault(); close(collect(card)); };
      if (onOpen) onOpen(card, close);
      const first = $('input:not([type=hidden]), select', card); if (first) setTimeout(() => { first.focus(); first.select && first.select(); }, 50);
    });
  }
  function collect(card) {
    const out = {};
    $$('input, select, textarea', card).forEach(el => { if (el.name) out[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
    return out;
  }
  async function confirmDlg(title, text, okLabel = 'Potvrdit', danger = false) {
    const r = await dialog(`
      <div class="modal-head"><strong>${esc(title)}</strong><button class="iconbtn" data-close>✕</button></div>
      <p>${esc(text)}</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn secondary" data-close>Zrušit</button>
        <button class="btn ${danger ? 'danger' : ''}" data-close="ok">${esc(okLabel)}</button>
      </div>`);
    return r !== null;
  }

  // ---------- Data ----------
  const state = { products: [], movements: [], orders: [], settings: {}, user: null, wh: 'CZ' };

  // ---------- Sklady (CZ / SK): každý má vlastní stavy, šarže, doklady i inventuru ----------
  const WAREHOUSES = [{ id: 'CZ', name: 'Sklad CZ', flag: '🇨🇿', currency: 'CZK' }, { id: 'SK', name: 'Sklad SK', flag: '🇸🇰', currency: 'EUR' }];
  const whInfo = (id) => WAREHOUSES.find(w => w.id === id) || { id, name: id, flag: '', currency: 'CZK' };
  const whName = (id) => whInfo(id).name;
  const otherWh = (id) => (WAREHOUSES.find(w => w.id !== id) || WAREHOUSES[0]).id;
  const whBadge = (id) => `<span class="badge wh-${esc(id)}">${esc(id)}</span>`;
  const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
  /** Stav produktu ve skladu (výchozí = právě vybraný sklad). */
  const stockOf = (p, wh = state.wh) => Number(((p && p.stocks) || {})[wh] || 0);
  function setStockOf(p, wh, v) {
    p.stocks = p.stocks || {}; p.stocks[wh] = round3(v);
    p.stock = round3(Object.values(p.stocks).reduce((s, x) => s + Number(x || 0), 0)); // součet všech skladů
  }
  /** Starší data měla jen jeden stav – bereme ho jako sklad CZ. */
  function migrateProduct(p) {
    if (!p.stocks) p.stocks = { CZ: round3(Number(p.stock || 0)) };
    (p.batches || []).forEach(b => { b.wh = b.wh || 'CZ'; });
    p.stock = round3(Object.values(p.stocks).reduce((s, x) => s + Number(x || 0), 0));
    return p;
  }
  function setWh(id) {
    state.wh = id; try { localStorage.setItem('wh', id); } catch (_) {}
    const b = $('#whBtn'); if (b) { b.textContent = `${whInfo(id).flag} ${id}`; b.title = whName(id); b.dataset.wh = id; }
  }
  // ---------- Ceny a fakturace: sklad CZ fakturuje v Kč, sklad SK v € (měnu lze změnit v Nastavení → Fakturace) ----------
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const invoiceCfg = (wh) => ((state.settings.invoice || {})[wh]) || {};
  const curOf = (wh) => invoiceCfg(wh).currency || whInfo(wh).currency;
  const curSym = (cur) => (cur === 'EUR' ? '€' : 'Kč');
  /** Cena bez DPH v měně skladu (CZK → `price`, EUR → `priceEur`); null, když chybí. */
  const priceOf = (p, wh) => { if (!p) return null; const v = curOf(wh) === 'EUR' ? p.priceEur : p.price; return v == null || v === '' ? null : Number(v); };
  const fmtMoney = (n, wh) => `${Number(n || 0).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${curSym(curOf(wh))}`;
  const dayStr = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  async function loadAll() {
    const [p, m, o, s] = await Promise.all([DB.getAll('products'), DB.getAll('movements'), DB.getAll('orders'), DB.getAll('settings')]);
    state.products = p.map(migrateProduct).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    state.movements = m.map(x => { x.wh = x.wh || 'CZ'; return x; }).sort((a, b) => b.ts - a.ts);
    state.orders = o.map(x => { x.wh = x.wh || 'CZ'; return x; }).sort((a, b) => b.ts - a.ts);
    state.settings = Object.fromEntries(s.map(x => [x.key, x.value]));
    updateBadges();
  }
  function updateBadges() {
    const n = state.orders.filter(o => o.status === 'new').length;
    $('#navOrders').textContent = n || ''; $('#tabOrders').textContent = n || '';
  }
  const productByCode = (code) => state.products.find(p => p.code === normCode(code) || (p.altCodes || []).includes(normCode(code)));
  const productById = (id) => state.products.find(p => p.id === id);
  async function setSetting(key, value) { state.settings[key] = value; await DB.put('settings', { key, value }); }

  async function saveProduct(p) {
    p.code = normCode(p.code); p.name = p.name.trim();
    if (!p.code) throw new Error('Kód je povinný.');
    if (!p.name) throw new Error('Název je povinný.');
    const dup = productByCode(p.code);
    if (dup && dup.id !== p.id) throw new Error(`Kód ${p.code} už má produkt „${dup.name}“.`);
    p.updatedAt = Date.now();
    await DB.put('products', p);
    await loadAll();
    return p;
  }

  // ---------- Šarže (datum výroby / trvanlivost), vážené zboží ----------
  const isWeighed = (p) => ['kg', 'g'].includes(p.unit);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDay = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('cs-CZ') : '';
  const daysTo = (d) => d ? Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000) : null;
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const expiryBadge = (useBy) => { const n = daysTo(useBy); if (n === null) return ''; if (n < 0) return '<span class="badge danger">prošlé</span>'; if (n <= 7) return `<span class="badge warn">${n === 0 ? 'dnes' : n + ' dní'}</span>`; return `<span class="badge ok">${n} dní</span>`; };
  /** Šarže seřazené tak, aby se nejdřív vydávalo zboží s nejkratší trvanlivostí (FEFO). */
  const sortedBatches = (p, wh = state.wh) => (p.batches || []).filter(b => !wh || b.wh === wh).slice().sort((a, b) => ((a.useBy || '9999') < (b.useBy || '9999') ? -1 : (a.useBy || '9999') > (b.useBy || '9999') ? 1 : (a.receivedAt || 0) - (b.receivedAt || 0)));
  function addBatch(p, b) { p.batches = p.batches || []; p.batches.push({ id: uid(), receivedAt: Date.now(), wh: state.wh, ...b }); }
  function takeFromBatches(p, qty, wh) {
    const taken = []; let left = round3(qty);
    for (const b of sortedBatches(p, wh)) {
      if (left <= 0) break;
      const t = Math.min(b.qty, left); if (t <= 0) continue;
      b.qty = round3(b.qty - t); left = round3(left - t); taken.push({ id: b.id, qty: t, useBy: b.useBy || null, prodDate: b.prodDate || null });
    }
    p.batches = (p.batches || []).filter(b => b.qty > 0);
    return taken;
  }
  function returnToBatches(p, taken, qty, wh) {
    p.batches = p.batches || [];
    if (!taken || !taken.length) { addBatch(p, { qty, prodDate: null, useBy: null, wh }); return; }
    for (const t of taken) { const b = p.batches.find(x => x.id === t.id); if (b) b.qty = round3(b.qty + t.qty); else p.batches.push({ id: t.id, qty: t.qty, useBy: t.useBy, prodDate: t.prodDate, receivedAt: Date.now(), wh }); }
  }
  /** Rozdíl trvanlivosti a vah u řádku dokladu (pro zobrazení). */
  const lineInfo = (i) => [
    i.weights && i.weights.length > 1 ? 'váhy ' + i.weights.map(fmtQty).join(' + ') : '',
    i.useBy ? 'spotřeba do ' + fmtDay(i.useBy) : '',
    i.batches && i.batches.some(b => b.useBy) ? 'šarže ' + [...new Set(i.batches.filter(b => b.useBy).map(b => fmtDay(b.useBy)))].join(', ') : '',
    i.manual ? 'bez skenu' : '',
    i.whTo ? `→ ${i.whTo}: před ${fmtQty(i.toBefore)}, po ${fmtQty(i.toAfter)}` : ''
  ].filter(Boolean).join(' · ');

  /** Číslo dokladu – každý sklad má vlastní řadu, např. P-CZ-2026-0001. */
  async function nextDocNo(type, wh = state.wh) {
    const key = `seq_${wh}`; const seq = (state.settings[key] || 0) + 1; await setSetting(key, seq);
    const prefix = { receipt: 'P', issue: 'V', inventory: 'I', adjust: 'K', transfer: 'T' }[type];
    return `${prefix}-${wh}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
  }
  /** Upraví stav a šarže produktu ve skladu `wh` podle řádku a vrátí řádek dokladu (stav před / změna / po). Přesun navíc přičte do `whTo`. */
  function applyLine(p, type, it, wh = state.wh, whTo = null) {
    const before = stockOf(p, wh); const qty = Number(it.qty);
    const after = round3(type === 'receipt' ? before + qty : (type === 'issue' || type === 'transfer') ? before - qty : qty); // inventura / korekce = nastavit stav
    const diff = round3(after - before);
    const line = { productId: p.id, code: p.code, name: p.name, unit: p.unit, qty, before, after, diff, wh };
    if (type === 'transfer' && whTo) {
      // Přesunuté šarže si nechají datum výroby i trvanlivost.
      const taken = takeFromBatches(p, qty, wh); line.batches = taken;
      const toBefore = stockOf(p, whTo); let moved = 0;
      taken.forEach(t => { addBatch(p, { qty: t.qty, prodDate: t.prodDate, useBy: t.useBy, wh: whTo }); moved = round3(moved + t.qty); });
      if (moved < qty) addBatch(p, { qty: round3(qty - moved), prodDate: null, useBy: null, wh: whTo });
      setStockOf(p, whTo, toBefore + qty);
      Object.assign(line, { whTo, toBefore, toAfter: round3(toBefore + qty) });
    }
    else if (diff > 0) { const b = { qty: diff, prodDate: it.prodDate || null, useBy: it.useBy || null, wh }; addBatch(p, b); line.prodDate = b.prodDate; line.useBy = b.useBy; }
    else if (diff < 0) line.batches = takeFromBatches(p, -diff, wh);
    if (it.weights) line.weights = it.weights;
    if (it.prodDate) p.lastProdDate = it.prodDate;
    if (it.useBy) p.lastUseBy = it.useBy;
    setStockOf(p, wh, after); p.updatedAt = Date.now();
    return line;
  }
  /** Zapíše pohyb (příjem/výdej/inventura/přesun) ve skladu meta.wh (výchozí vybraný sklad) a aktualizuje stavy produktů. */
  async function commitMovement(type, items, meta = {}) {
    const wh = meta.wh || state.wh; const whTo = meta.whTo || null;
    const touched = [];
    const lines = items.map(it => { const p = productById(it.productId); touched.push(p); return applyLine(p, type, it, wh, whTo); });
    const movement = { id: uid(), type, ts: Date.now(), docNo: await nextDocNo(type, wh), items: lines, by: state.user, ...meta, wh, whTo };
    await DB.applyMovement(movement, touched);
    await loadAll();
    return movement;
  }

  // ---------- Rozpracované doklady (přežijí zavření appky) ----------
  const drafts = {
    async get(key) { const d = await DB.get('drafts', key); return d ? d.value : null; },
    async set(key, value) { await DB.put('drafts', { key, value }); },
    async clear(key) { await DB.del('drafts', key); }
  };

  // ---------- Skener ----------
  const scanner = {
    html5: null, running: false, onCode: null, lastCode: null, lastAt: 0,
    async open(title, onCode) {
      this.onCode = onCode;
      $('#scanTitle').textContent = title;
      $('#scanLast').textContent = ''; $('#scanLast').className = 'scan-last';
      $('#scanManual').value = '';
      $('#scanModal').classList.remove('hidden');
      await this.start();
    },
    async start() {
      if (this.running) return;
      try {
        this.html5 = this.html5 || new Html5Qrcode('reader', {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
            Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.DATA_MATRIX
          ],
          experimentalFeatures: { useBarCodeDetectorIfSupported: true }, verbose: false
        });
        await this.html5.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: (w, h) => ({ width: Math.min(w * 0.9, 420), height: Math.min(h * 0.5, 180) }), aspectRatio: 1.5 },
          (text) => this.handle(text), () => {}
        );
        this.running = true;
      } catch (err) {
        $('#reader').innerHTML = `<div class="empty" style="color:#fff"><div class="big">📷</div>Kameru nelze spustit.<br><span class="small">${esc(err && err.message || err)}</span><br><span class="small">Zadej kód ručně níže.</span></div>`;
      }
    },
    handle(text) {
      const code = normCode(text); const now = Date.now();
      if (code === this.lastCode && now - this.lastAt < 1500) return; // ochrana proti opakovanému čtení
      this.lastCode = code; this.lastAt = now;
      if (this.onCode) this.onCode(code);
    },
    feedback(msg, ok) {
      const el = $('#scanLast'); el.textContent = msg; el.className = 'scan-last ' + (ok ? 'ok' : 'bad'); beep(ok);
    },
    async pause() { if (this.running && this.html5) { try { this.html5.pause(true); } catch (_) {} } },
    async resume() { if (this.running && this.html5) { try { this.html5.resume(); } catch (_) {} } },
    async close() {
      $('#scanModal').classList.add('hidden');
      if (this.html5 && this.running) { try { await this.html5.stop(); } catch (_) {} }
      this.running = false; this.onCode = null;
    }
  };
  $('#scanClose').onclick = () => scanner.close();
  $('#scanManualBtn').onclick = () => { const v = $('#scanManual').value; if (v.trim()) { scanner.handle(v); $('#scanManual').value = ''; } };
  $('#scanManual').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#scanManualBtn').click(); } };

  // ---------- Formulář produktu ----------
  async function productForm(product = {}, { codeLocked = false } = {}) {
    const cats = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
    const res = await dialog(`
      <div class="modal-head"><strong>${product.id ? 'Upravit produkt' : 'Nový produkt'}</strong><button class="iconbtn" data-close>✕</button></div>
      <form>
        <div class="field"><label>Kód (čárový kód / EAN) *</label>
          <div class="row"><input class="grow mono" name="code" value="${esc(product.code || '')}" required ${codeLocked ? 'readonly' : ''} placeholder="859…">
          ${codeLocked ? '' : '<button type="button" class="btn secondary" id="pfScan">📷</button>'}</div></div>
        <div class="field"><label>Název *</label><input name="name" value="${esc(product.name || '')}" required placeholder="Sýr Eidam 30% 1 kg"></div>
        <div class="grid2">
          <div class="field"><label>Jednotka</label><select name="unit">${UNITS.map(u => `<option ${u === (product.unit || 'ks') ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
          <div class="field"><label>Kategorie</label><input name="category" list="catList" value="${esc(product.category || '')}" placeholder="Mléčné výrobky"><datalist id="catList">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Minimální zásoba (upozornění)</label><input name="minStock" type="number" step="any" min="0" value="${esc(product.minStock ?? '')}" placeholder="0"></div>
          <div class="field"><label>Umístění ve skladu</label><input name="location" value="${esc(product.location || '')}" placeholder="Regál A3"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Dodavatel</label><input name="supplier" value="${esc(product.supplier || '')}"></div>
          <div class="field"><label>Cena bez DPH v Kč (sklad CZ)</label><input name="price" type="number" step="any" min="0" value="${esc(product.price ?? '')}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Cena bez DPH v € (sklad SK)</label><input name="priceEur" type="number" step="any" min="0" value="${esc(product.priceEur ?? '')}"></div>
          <div class="field"><label>DPH (%) – prázdné = výchozí z Nastavení</label><input name="vat" type="number" step="any" min="0" max="100" value="${esc(product.vat ?? '')}" placeholder="např. 12"></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Hmotnost 1 ks (kg)</label><input name="weight" type="number" step="any" min="0" value="${esc(product.weight ?? '')}" placeholder="např. 1"></div>
          <div class="field"><label>Trvanlivost (dní od data výroby)</label><input name="shelfLifeDays" type="number" min="0" value="${esc(product.shelfLifeDays ?? '')}" placeholder="např. 60"></div>
        </div>
        <div class="field"><label>Další čárové kódy (karton, starý EAN…), oddělené čárkou</label><input name="altCodes" class="mono" value="${esc((product.altCodes || []).join(', '))}"></div>
        ${product.id ? '' : `<div class="field"><label>Počáteční stav – ${esc(whName(state.wh))}</label><input name="stock" type="number" step="any" min="0" value="0"></div>`}
        <div class="field"><label>Poznámka</label><textarea name="note" rows="2">${esc(product.note || '')}</textarea></div>
        <div class="row" style="justify-content:flex-end">
          ${product.id ? '<button type="button" class="btn danger" id="pfDelete">Smazat</button><span class="grow"></span>' : ''}
          <button type="button" class="btn secondary" data-close>Zrušit</button>
          <button type="submit" class="btn">Uložit</button>
        </div>
      </form>`, {
      onOpen(card, close) {
        const sb = $('#pfScan', card);
        if (sb) sb.onclick = () => scanner.open('Naskenuj kód produktu', (code) => { $('[name=code]', card).value = code; scanner.feedback(`Kód: ${code}`, true); setTimeout(() => scanner.close(), 400); });
        const db = $('#pfDelete', card);
        if (db) db.onclick = async () => {
          close(null);
          if (await confirmDlg('Smazat produkt', `Opravdu smazat „${product.name}“? Historie pohybů zůstane zachována.`, 'Smazat', true)) {
            await DB.del('products', product.id); await loadAll(); toast('Produkt smazán'); render();
          }
        };
      }
    });
    if (!res) return null;
    const p = {
      ...product, id: product.id || uid(), code: res.code, name: res.name, unit: res.unit, category: res.category.trim(),
      minStock: res.minStock === '' ? null : Number(res.minStock), location: res.location.trim(), supplier: res.supplier.trim(),
      price: res.price === '' ? null : Number(res.price), note: res.note.trim(),
      weight: res.weight === '' ? null : Number(res.weight), shelfLifeDays: res.shelfLifeDays === '' ? null : Number(res.shelfLifeDays),
      altCodes: res.altCodes.split(/[,;\s]+/).map(normCode).filter(c => c && c !== normCode(res.code)),
      priceEur: res.priceEur === '' ? null : Number(res.priceEur), vat: res.vat === '' ? null : Number(res.vat),
      createdAt: product.createdAt || Date.now()
    };
    if (!product.id) {
      // Počáteční stav jde do právě vybraného skladu (jako šarže bez data).
      const init = round3(Number(res.stock || 0)); setStockOf(p, state.wh, init);
      if (init > 0) p.batches = [{ id: uid(), qty: init, prodDate: null, useBy: null, receivedAt: Date.now(), wh: state.wh }];
    } else migrateProduct(p);
    try { await saveProduct(p); toast(product.id ? 'Produkt uložen' : 'Produkt vytvořen'); return p; }
    catch (err) { toast(err.message, 3500); return productForm(p, { codeLocked }); }
  }

  /** Dotaz na množství. S `dates: true` (příjem) navíc datum výroby a trvanlivost a vrací objekt {qty, prodDate, useBy}. */
  async function qtyDialog(product, { title, defaultQty = 1, extraHtml = '', dates = false, prodDate = '', useBy = '', wh = state.wh } = {}) {
    const res = await dialog(`
      <div class="modal-head"><strong>${esc(title || product.name)}</strong><button class="iconbtn" data-close>✕</button></div>
      <div class="muted mono" style="margin-bottom:8px">${esc(product.code)} · skladem ${fmtQty(stockOf(product, wh))} ${esc(product.unit)} ${whBadge(wh)}</div>
      ${extraHtml}
      <form>
        <div class="field"><label>Množství (${esc(product.unit)})</label><input name="qty" type="number" step="any" min="0" inputmode="decimal" value="${defaultQty}" required></div>
        ${dates ? `<div class="grid2">
          <div class="field"><label>Datum výroby</label><input name="prodDate" type="date" value="${esc(prodDate)}"></div>
          <div class="field"><label>Spotřebujte do${product.shelfLifeDays ? ` (výroba + ${product.shelfLifeDays} dní)` : ''}</label><input name="useBy" type="date" value="${esc(useBy)}"></div>
        </div>` : ''}
        <div class="row" style="justify-content:flex-end">
          <button type="button" class="btn secondary" data-close>Zrušit</button>
          <button type="submit" class="btn">OK</button>
        </div>
      </form>`, {
      onOpen(card) {
        if (!dates) return;
        const pd = $('[name=prodDate]', card), ub = $('[name=useBy]', card);
        pd.onchange = () => { if (pd.value && product.shelfLifeDays && !ub.dataset.touched) ub.value = addDays(pd.value, Number(product.shelfLifeDays)); };
        ub.oninput = () => { ub.dataset.touched = '1'; };
      }
    });
    if (!res) return null;
    const q = Number(res.qty);
    if (!Number.isFinite(q)) return null;
    return dates ? { qty: q, prodDate: res.prodDate || null, useBy: res.useBy || null } : q;
  }

  /** Vážené zboží (kg): skladník zapíše váhu každého kusu, součet jde do objednávky. */
  function weighDialog(p, orderedQty, previous) {
    return new Promise((resolve) => {
      let weights = previous && previous.length ? previous.map(String) : [''];
      dialog(`
        <div class="modal-head"><strong>⚖️ Zvaž: ${esc(p.name)}</strong><button class="iconbtn" data-close>✕</button></div>
        <p class="muted small" style="margin-top:0">Objednáno <strong>${fmtQty(orderedQty)} ${esc(p.unit)}</strong>. Zapiš váhu každého kusu, součet se zapíše do objednávky.</p>
        <div id="wRows" class="list"></div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn secondary sm" id="wAdd">＋ Další kus</button><span class="grow"></span><div>Celkem <strong id="wTotal">0</strong> ${esc(p.unit)}</div></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button type="button" class="btn secondary" data-close>Zrušit</button><button type="button" class="btn" id="wOk">OK</button></div>`, {
        onOpen(card, close) {
          const num = (w) => Number(String(w).replace(',', '.')) || 0;
          const total = () => round3(weights.reduce((s, w) => s + num(w), 0));
          const draw = (focusLast) => {
            $('#wRows', card).innerHTML = weights.map((w, i) => `<div class="row weigh-row"><span class="muted small" style="width:52px">Kus ${i + 1}</span><input type="number" step="any" min="0" inputmode="decimal" data-w="${i}" value="${esc(w)}" placeholder="0"><span class="muted small">${esc(p.unit)}</span><button type="button" class="iconbtn" data-wdel="${i}" ${weights.length === 1 ? 'disabled' : ''}>🗑</button></div>`).join('');
            $('#wTotal', card).textContent = fmtQty(total());
            $$('[data-w]', card).forEach(inp => {
              inp.oninput = () => { weights[inp.dataset.w] = inp.value; $('#wTotal', card).textContent = fmtQty(total()); };
              inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#wAdd', card).click(); } };
            });
            $$('[data-wdel]', card).forEach(b => b.onclick = () => { weights.splice(Number(b.dataset.wdel), 1); draw(true); });
            if (focusLast) { const inputs = $$('[data-w]', card); const last = inputs[inputs.length - 1]; if (last) last.focus(); }
          };
          draw(true);
          $('#wAdd', card).onclick = () => { weights.push(''); draw(true); };
          $('#wOk', card).onclick = () => {
            const ws = weights.map(num).filter(w => w > 0);
            if (!ws.length) return toast('Zapiš aspoň jednu váhu');
            close('ok'); resolve({ weights: ws, total: round3(ws.reduce((s, w) => s + w, 0)) });
          };
        }
      }).then(r => { if (r !== 'ok') resolve(null); });
    });
  }

  // ---------- Routing ----------
  const routes = {};
  function currentRoute() { const h = location.hash.replace(/^#/, '') || '/'; const [path, qs] = h.split('?'); return { path, params: new URLSearchParams(qs || '') }; }
  let lastPath = null;
  async function render() {
    const { path, params } = currentRoute();
    const fn = routes[path] || routes['/'];
    if (path !== lastPath) { lastPath = path; window.scrollTo(0, 0); } // nová obrazovka začíná nahoře
    document.body.classList.toggle('print-label', path === '/stitek' || path === '/faktura');
    $$('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === path));
    $('#sidenav').classList.remove('open'); $('#backdrop').classList.remove('open');
    await fn($('#view'), params);
  }
  window.addEventListener('hashchange', render);
  $('#menuBtn').onclick = () => { $('#sidenav').classList.toggle('open'); $('#backdrop').classList.toggle('open'); };
  /** Přepnutí skladu pro toto zařízení: příjem, výdej, inventura a zobrazené stavy se pak týkají vybraného skladu. */
  $('#whBtn').onclick = async () => {
    const r = await dialog(`
      <div class="modal-head"><strong>Ve kterém skladu pracuješ?</strong><button class="iconbtn" data-close>✕</button></div>
      <p class="muted small" style="margin-top:0">Příjem, výdej, inventura a zobrazené stavy se budou týkat vybraného skladu. Objednávky mají svůj sklad určený už při zadání.</p>
      <div class="list">${WAREHOUSES.map(w => `<button type="button" class="btn big ${w.id === state.wh ? '' : 'secondary'}" data-pick-wh="${w.id}">${w.flag} ${esc(w.name)}${w.id === state.wh ? ' · vybraný' : ''}</button>`).join('')}</div>`, {
      onOpen(card, close) { $$('[data-pick-wh]', card).forEach(b => b.onclick = () => close(b.dataset.pickWh)); }
    });
    if (r && r !== state.wh) { setWh(r); toast(`${whInfo(r).flag} ${whName(r)}`); render(); }
  };
  $('#tabMore').onclick = (e) => { e.preventDefault(); $('#menuBtn').click(); };
  $('#backdrop').onclick = () => { $('#sidenav').classList.remove('open'); $('#backdrop').classList.remove('open'); };
  const setTitle = (t) => { $('#pageTitle').textContent = t; document.title = `${t} · IMCO Sklad`; };

  // ---------- Přehled ----------
  routes['/'] = async (el) => {
    setTitle('Přehled');
    const wh = state.wh;
    const low = state.products.filter(p => p.minStock != null && stockOf(p, wh) <= p.minStock);
    const zero = state.products.filter(p => stockOf(p, wh) <= 0);
    const totalValue = state.products.reduce((s, p) => s + (priceOf(p, wh) || 0) * stockOf(p, wh), 0);
    const recent = state.movements.filter(m => m.wh === wh || m.whTo === wh).slice(0, 8);
    const openOrders = state.orders.filter(o => o.status === 'new' || o.status === 'preparing');
    el.innerHTML = `
      ${openOrders.length ? `<div class="card"><div class="row between"><h2>🧾 Objednávky k vyřízení</h2><a href="#/objednavky" class="small">Vše →</a></div>
        <div class="list">${openOrders.slice(0, 5).map(o => `<div class="item clickable" data-oid="${o.id}"><div class="grow"><div class="name">${esc(o.no)} · ${esc(o.customer || 'bez odběratele')}</div><div class="code">${whBadge(o.wh)} ${o.items.length} položek · ${fmtDate(o.ts)}</div></div><span class="badge status-${o.status}">${ORDER_STATUS[o.status]}</span></div>`).join('')}</div></div>` : ''}
      <div class="row between" style="margin-bottom:10px"><h2>${whInfo(wh).flag} ${esc(whName(wh))}</h2><button class="btn sm secondary" id="dashWh">⇄ Přepnout sklad</button></div>
      <div class="stats">
        <div class="stat"><div class="num">${state.products.length}</div><div class="lbl">produktů</div></div>
        <div class="stat"><div class="num">${fmtQty(state.products.reduce((s, p) => s + stockOf(p, wh), 0))}</div><div class="lbl">jednotek skladem (${wh})</div></div>
        <div class="stat ${low.length ? 'warn' : ''}"><div class="num">${low.length}</div><div class="lbl">pod minimem</div></div>
        <div class="stat ${zero.length ? 'danger' : ''}"><div class="num">${zero.length}</div><div class="lbl">vyprodáno</div></div>
        ${totalValue ? `<div class="stat"><div class="num">${fmtMoney(totalValue, wh)}</div><div class="lbl">hodnota zásob bez DPH</div></div>` : ''}
      </div>
      <div class="card">
        <h2>Rychlé akce</h2>
        <div class="row">
          <a class="btn" href="#/prijem">⬇️ Nový příjem</a>
          <a class="btn secondary" href="#/vydej">⬆️ Nový výdej</a>
          <a class="btn secondary" href="#/inventura">📋 Inventura</a>
          <a class="btn secondary" href="#/presun">⇄ Přesun ${wh} → ${otherWh(wh)}</a>
          <button class="btn secondary" id="dashAdd">＋ Produkt</button>
        </div>
      </div>
      ${low.length ? `<div class="card"><h2>⚠️ Pod minimální zásobou</h2><div class="table-wrap"><table>
        <tr><th>Produkt</th><th class="num">Skladem</th><th class="num">Minimum</th></tr>
        ${low.map(p => `<tr class="clickable" data-pid="${p.id}"><td><div>${esc(p.name)}</div><div class="muted mono small">${esc(p.code)}</div></td><td class="num"><span class="badge ${stockOf(p, wh) <= 0 ? 'danger' : 'warn'}">${fmtQty(stockOf(p, wh))} ${esc(p.unit)}</span></td><td class="num">${fmtQty(p.minStock)}</td></tr>`).join('')}
      </table></div></div>` : ''}
      ${(() => {
        const soon = state.products.flatMap(p => (p.batches || []).filter(b => b.wh === wh && b.useBy && daysTo(b.useBy) <= 7).map(b => ({ p, b }))).sort((a, b) => a.b.useBy < b.b.useBy ? -1 : 1);
        return soon.length ? `<div class="card" style="border-color:var(--warn)"><h2>⏳ Končí trvanlivost</h2><div class="table-wrap"><table><tr><th>Produkt</th><th>Spotřebujte do</th><th class="num">Množství</th></tr>
          ${soon.slice(0, 10).map(({ p, b }) => `<tr class="clickable" data-pid="${p.id}"><td>${esc(p.name)}</td><td>${fmtDay(b.useBy)} ${expiryBadge(b.useBy)}</td><td class="num">${fmtQty(b.qty)} ${esc(p.unit)}</td></tr>`).join('')}</table></div></div>` : '';
      })()}
      <div class="card">
        <div class="row between"><h2>Poslední pohyby</h2><a href="#/historie" class="small">Vše →</a></div>
        ${recent.length ? `<div class="table-wrap"><table>
          <tr><th>Datum</th><th>Doklad</th><th>Typ</th><th class="num">Položek</th></tr>
          ${recent.map(m => `<tr class="clickable" data-mid="${m.id}"><td class="small">${fmtDate(m.ts)}</td><td class="mono small">${esc(m.docNo)}</td><td><span class="badge ${TYPE_BADGE[m.type]}">${TYPE_LABEL[m.type]}</span>${m.type === 'transfer' ? ` <span class="small muted">${esc(m.wh)} → ${esc(m.whTo)}</span>` : ''}</td><td class="num">${m.items.length}</td></tr>`).join('')}
        </table></div>` : `<div class="empty"><div class="big">📭</div>Zatím žádné pohyby. Začni tím, že přidáš produkty, nebo rovnou udělej první příjem.</div>`}
      </div>`;
    $('#dashAdd').onclick = async () => { if (await productForm()) render(); };
    $('#dashWh').onclick = () => $('#whBtn').click();
    $$('[data-oid]', el).forEach(d => d.onclick = () => location.hash = `#/objednavka?id=${d.dataset.oid}`);
    $$('[data-pid]', el).forEach(tr => tr.onclick = () => location.hash = `#/produkt?id=${tr.dataset.pid}`);
    $$('[data-mid]', el).forEach(tr => tr.onclick = () => showMovement(tr.dataset.mid));
  };

  // ---------- Produkty ----------
  let prodFilter = { q: '', cat: '' };
  routes['/produkty'] = async (el) => {
    setTitle('Produkty');
    const cats = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
    const draw = () => {
      const q = prodFilter.q.toLowerCase();
      const list = state.products.filter(p => (!prodFilter.cat || p.category === prodFilter.cat) &&
        (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || (p.location || '').toLowerCase().includes(q)));
      $('#prodList', el).innerHTML = list.length ? `<div class="table-wrap"><table class="prod-table">
        <tr><th>Produkt</th><th>Kategorie</th><th>Umístění</th><th class="num">Skladem</th></tr>
        ${list.map(p => {
          const cell = (w) => { const s = stockOf(p, w.id); const badge = s <= 0 ? 'danger' : (p.minStock != null && s <= p.minStock ? 'warn' : 'ok'); return `<span class="badge ${badge} ${w.id === state.wh ? 'wh-active' : ''}" title="${esc(w.name)}">${w.flag} ${fmtQty(s)} ${esc(p.unit)}</span>`; };
          return `<tr class="clickable" data-pid="${p.id}"><td><div><strong>${esc(p.name)}</strong></div><div class="muted mono small">${esc(p.code)}</div></td>
            <td class="small">${esc(p.category || '—')}</td><td class="small">${esc(p.location || '—')}</td><td class="num stock-cell">${WAREHOUSES.map(cell).join('<br>')}</td></tr>`;
        }).join('')}</table></div>`
        : `<div class="empty"><div class="big">📦</div>${state.products.length ? 'Nic nenalezeno.' : 'Zatím žádné produkty. Přidej první kliknutím na „＋ Nový produkt“ nebo naskenuj kód.'}</div>`;
      $$('[data-pid]', el).forEach(tr => tr.onclick = () => location.hash = `#/produkt?id=${tr.dataset.pid}`);
    };
    el.innerHTML = `
      <div class="searchbar">
        <input id="prodQ" placeholder="Hledat název, kód, umístění…" value="${esc(prodFilter.q)}">
        <button class="btn secondary" id="prodScan" title="Najít skenem">📷</button>
        <button class="btn" id="prodAdd">＋</button>
      </div>
      ${cats.length ? `<div class="chips"><span class="chip ${!prodFilter.cat ? 'active' : ''}" data-cat="">Vše</span>${cats.map(c => `<span class="chip ${prodFilter.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`).join('')}</div>` : ''}
      <div id="prodList"></div>
      <p class="muted small">${state.products.length} produktů celkem · zvýrazněný stav = sklad, ve kterém právě pracuješ (${esc(whName(state.wh))})</p>`;
    draw();
    $('#prodQ').oninput = (e) => { prodFilter.q = e.target.value; draw(); };
    $$('.chip', el).forEach(c => c.onclick = () => { prodFilter.cat = c.dataset.cat; render(); });
    $('#prodAdd').onclick = async () => { if (await productForm()) render(); };
    $('#prodScan').onclick = () => scanner.open('Najít produkt', async (code) => {
      const p = productByCode(code);
      if (p) { scanner.feedback(`${p.name}`, true); await scanner.close(); location.hash = `#/produkt?id=${p.id}`; }
      else { scanner.feedback(`Neznámý kód ${code}`, false); await scanner.close(); if (await productForm({ code }, { codeLocked: true })) render(); }
    });
  };

  routes['/produkt'] = async (el, params) => {
    const p = productById(params.get('id'));
    if (!p) { location.hash = '#/produkty'; return; }
    setTitle(p.name);
    const hist = state.movements.filter(m => m.items.some(i => i.productId === p.id)).slice(0, 30);
    const s = stockOf(p);
    el.innerHTML = `
      <div class="card">
        <div class="row between">
          <div><h2>${esc(p.name)}</h2><div class="muted mono">${esc(p.code)}</div></div>
          <div class="row" style="gap:8px">${WAREHOUSES.map(w => `<div class="stat" style="padding:10px 16px${w.id === state.wh ? ';border-color:var(--primary)' : ''}"><div class="num">${fmtQty(stockOf(p, w.id))} <span class="small muted">${esc(p.unit)}</span></div><div class="lbl">${w.flag} ${esc(w.name)}</div></div>`).join('')}</div>
        </div>
        <div class="grid2" style="margin-top:12px">
          <div><label>Kategorie</label>${esc(p.category || '—')}</div>
          <div><label>Umístění</label>${esc(p.location || '—')}</div>
          <div><label>Minimální zásoba</label>${p.minStock != null ? fmtQty(p.minStock) + ' ' + esc(p.unit) : '—'}</div>
          <div><label>Dodavatel</label>${esc(p.supplier || '—')}</div>
          <div><label>Cena bez DPH</label>${[p.price != null ? fmtQty(p.price) + ' Kč' : '', p.priceEur != null ? fmtQty(p.priceEur) + ' €' : ''].filter(Boolean).join(' · ') || '—'}${p.vat != null ? ` · DPH ${fmtQty(p.vat)} %` : ''}</div>
          <div><label>Hmotnost 1 ks</label>${p.weight != null ? fmtQty(p.weight) + ' kg' : '—'}</div>
          <div><label>Trvanlivost</label>${p.shelfLifeDays != null ? p.shelfLifeDays + ' dní od výroby' : '—'}</div>
          <div><label>Další kódy</label><span class="mono">${esc((p.altCodes || []).join(', ') || '—')}</span></div>
          <div><label>Poznámka</label>${esc(p.note || '—')}</div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn secondary" id="pEdit">✏️ Upravit</button>
          <button class="btn secondary" id="pAdjust">🔧 Opravit stav ${state.wh}</button>
          <a class="btn secondary" href="#/presun?pid=${p.id}">⇄ Přesun</a>
          <a class="btn secondary" href="#/produkty">← Zpět</a>
        </div>
      </div>
      <div class="card"><h2>Šarže na skladě</h2>
        ${(() => { const bs = sortedBatches(p, null); return bs.length ? `<div class="table-wrap"><table><tr><th>Sklad</th><th>Datum výroby</th><th>Spotřebujte do</th><th class="num">Množství</th></tr>
          ${bs.map(b => `<tr><td>${whBadge(b.wh)}</td><td>${fmtDay(b.prodDate) || '<span class="muted">—</span>'}</td><td>${b.useBy ? fmtDay(b.useBy) + ' ' + expiryBadge(b.useBy) : '<span class="muted">—</span>'}</td><td class="num">${fmtQty(b.qty)} ${esc(p.unit)}</td></tr>`).join('')}
        </table></div><p class="muted small">Vydává se nejdřív zboží s nejkratší trvanlivostí.</p>` : '<div class="empty small">Zatím žádné šarže. Data výroby a trvanlivost zadáš při příjmu.</div>'; })()}
      </div>
      <div class="card"><h2>Historie pohybů</h2>
        ${hist.length ? `<div class="table-wrap"><table><tr><th>Datum</th><th>Doklad</th><th>Typ</th><th>Sklad</th><th class="num">Změna</th><th class="num">Stav po</th></tr>
          ${hist.map(m => { const it = m.items.find(i => i.productId === p.id); return `<tr class="clickable" data-mid="${m.id}"><td class="small">${fmtDate(m.ts)}</td><td class="mono small">${esc(m.docNo)}</td><td><span class="badge ${TYPE_BADGE[m.type]}">${TYPE_LABEL[m.type]}</span></td><td>${whBadge(m.wh)}${m.whTo ? ' → ' + whBadge(m.whTo) : ''}</td><td class="num ${it.diff >= 0 ? 'diff-pos' : 'diff-neg'}">${it.diff >= 0 ? '+' : ''}${fmtQty(it.diff)}</td><td class="num">${fmtQty(it.after)}</td></tr>`; }).join('')}
        </table></div>` : '<div class="empty">Žádné pohyby.</div>'}
      </div>`;
    $('#pEdit').onclick = async () => { await productForm(p); render(); };
    $('#pAdjust').onclick = async () => {
      const q = await qtyDialog(p, { title: `Opravit stav – ${whName(state.wh)}`, defaultQty: s, extraHtml: `<p class="muted small">Zadej skutečný stav ve skladu ${esc(whName(state.wh))}. Rozdíl se zapíše jako korekce do historie.</p>` });
      if (q === null) return;
      await commitMovement('adjust', [{ productId: p.id, qty: q }], { note: 'Ruční oprava stavu', wh: state.wh });
      toast('Stav opraven'); render();
    };
    $$('[data-mid]', el).forEach(tr => tr.onclick = () => showMovement(tr.dataset.mid));
  };

  // ---------- Příjem / Výdej / Přesun (společná logika dokladu) ----------
  function docView(type) {
    const labels = {
      receipt: { title: 'Příjem', verb: 'Přijmout', scan: 'Skenuj přijímané zboží', partner: 'Dodavatel', whText: 'Příjem do skladu', icon: '⬇️', empty: 'Naskenuj kód zboží, které přijelo. Po načtení zadáš počet kusů.' },
      issue: { title: 'Výdej', verb: 'Vydat', scan: 'Skenuj vydávané zboží', partner: 'Odběratel / účel', whText: 'Výdej ze skladu', icon: '⬆️', empty: 'Naskenuj kód zboží, které vydáváš ze skladu.' },
      transfer: { title: 'Přesun CZ ⇄ SK', verb: 'Přesunout', scan: 'Skenuj přesouvané zboží', partner: null, whText: '', icon: '⇄', empty: 'Naskenuj kód zboží, které přesouváš do druhého skladu. Šarže si nechají datum výroby i trvanlivost.' }
    }[type];

    return async (el, params) => {
      setTitle(labels.title);
      // Rozpracovaný doklad je zvlášť pro každý sklad; přesun má jeden s vlastním směrem.
      const key = type === 'transfer' ? 'draft:transfer' : `draft:${type}:${state.wh}`;
      let draft = (await drafts.get(key)) || { items: [], partner: '', note: '', from: state.wh };
      if (!WAREHOUSES.some(w => w.id === draft.from)) draft.from = state.wh;
      const whFrom = () => (type === 'transfer' ? draft.from : state.wh);
      const whTo = () => otherWh(whFrom());
      const save = () => drafts.set(key, draft);

      const addCode = async (code) => {
        const scanning = !$('#scanModal').classList.contains('hidden');
        let p = productByCode(code);
        if (!p) {
          if (scanning) { scanner.feedback(`Neznámý kód ${code}`, false); await scanner.close(); }
          if (!await confirmDlg('Neznámý kód', `Kód ${code} v databázi není. Založit nový produkt?`, 'Založit')) return;
          p = await productForm({ code }, { codeLocked: true });
          if (!p) return;
        } else if (scanning) { scanner.feedback(`✓ ${p.name}`, true); await scanner.pause(); }
        const existing = draft.items.find(i => i.productId === p.id);
        const r = await qtyDialog(p, { title: `${labels.verb}: ${p.name}`, defaultQty: existing ? existing.qty : (state.settings.defaultQty || 1), wh: whFrom(),
          extraHtml: existing ? `<p class="muted small">Položka už je v dokladu (${fmtQty(existing.qty)} ${esc(p.unit)}). Zadané množství ji nahradí.</p>` : '',
          dates: type === 'receipt', prodDate: existing ? existing.prodDate || '' : '', useBy: existing ? existing.useBy || '' : '' });
        const q = r === null ? null : (typeof r === 'object' ? r.qty : r);
        if (q !== null && q > 0) {
          let row = existing;
          if (row) row.qty = q; else { row = { productId: p.id, qty: q }; draft.items.unshift(row); }
          if (typeof r === 'object') { row.prodDate = r.prodDate; row.useBy = r.useBy; }
          await save(); draw(); toast(`${p.name}: ${fmtQty(q)} ${p.unit}`);
        }
        if (scanner.running) await scanner.resume();
      };

      const drawDir = () => {
        const f = $('#docFrom', el), t = $('#docTo', el);
        if (f) f.innerHTML = `${whInfo(whFrom()).flag} ${esc(whName(whFrom()))}`;
        if (t) t.innerHTML = `${whInfo(whTo()).flag} ${esc(whName(whTo()))}`;
      };
      const draw = () => {
        const total = draft.items.reduce((s, i) => s + Number(i.qty), 0);
        $('#docItems', el).innerHTML = draft.items.length ? draft.items.map((it, idx) => {
          const p = productById(it.productId); if (!p) return '';
          const have = stockOf(p, whFrom()); const warn = type !== 'receipt' && have < it.qty;
          return `<div class="item">
            <div class="grow"><div class="name">${esc(p.name)}</div><div class="code mono">${esc(p.code)} · skladem ${fmtQty(have)} ${esc(p.unit)} (${esc(whFrom())})${warn ? ' <span class="badge danger">nedostatek</span>' : ''}${it.useBy ? ' · spotřeba do ' + fmtDay(it.useBy) : ''}${it.prodDate ? ' · výroba ' + fmtDay(it.prodDate) : ''}</div></div>
            <div class="qty-ctl"><button data-dec="${idx}">−</button><input type="number" step="any" min="0" data-qty="${idx}" value="${it.qty}"><button data-inc="${idx}">+</button></div>
            <button class="iconbtn" data-del="${idx}" title="Odebrat">🗑</button>
          </div>`;
        }).join('') : `<div class="empty"><div class="big">${labels.icon}</div>${labels.empty}</div>`;
        $('#docSummary', el).textContent = draft.items.length ? `${draft.items.length} položek · ${fmtQty(total)} jednotek` : '';
        $('#docCommit', el).disabled = !draft.items.length;
        $$('[data-qty]', el).forEach(i => i.onchange = async () => { const v = Number(i.value); if (v > 0) { draft.items[i.dataset.qty].qty = v; } await save(); draw(); });
        $$('[data-inc]', el).forEach(b => b.onclick = async () => { draft.items[b.dataset.inc].qty = Number(draft.items[b.dataset.inc].qty) + 1; await save(); draw(); });
        $$('[data-dec]', el).forEach(b => b.onclick = async () => { const it = draft.items[b.dataset.dec]; it.qty = Math.max(0, Number(it.qty) - 1); if (it.qty === 0) draft.items.splice(b.dataset.dec, 1); await save(); draw(); });
        $$('[data-del]', el).forEach(b => b.onclick = async () => { draft.items.splice(b.dataset.del, 1); await save(); draw(); });
      };

      el.innerHTML = `
        <div class="card">
          ${type === 'transfer'
            ? `<div class="row between" style="margin-bottom:10px"><div class="transfer-dir"><span class="muted small">Z</span> <strong id="docFrom"></strong> <span class="muted">→</span> <span class="muted small">do</span> <strong id="docTo"></strong></div><button class="btn sm secondary" id="docSwap">⇄ Otočit směr</button></div>`
            : `<div class="muted small" style="margin-bottom:10px">${labels.whText}: <strong>${whInfo(state.wh).flag} ${esc(whName(state.wh))}</strong> · <a href="#" id="docWh">přepnout sklad</a></div>`}
          <div class="row">
            <button class="btn big grow" id="docScan">📷 ${labels.scan}</button>
            <button class="btn secondary" id="docPick" title="Vybrat ze seznamu" style="min-height:52px">📋</button>
          </div>
          <div class="grid2" style="margin-top:12px">
            ${labels.partner ? `<div class="field"><label>${labels.partner}</label><input id="docPartner" value="${esc(draft.partner || '')}" placeholder="volitelné"></div>` : ''}
            <div class="field"><label>${type === 'transfer' ? 'Poznámka / důvod přesunu' : 'Poznámka / číslo dodacího listu'}</label><input id="docNote" value="${esc(draft.note || '')}" placeholder="volitelné"></div>
          </div>
        </div>
        <div class="list" id="docItems"></div>
        <div class="sticky-actions">
          <div class="row between" style="margin-bottom:6px"><span class="muted small" id="docSummary"></span><button class="btn sm secondary" id="docClear">Zahodit</button></div>
          <button class="btn big ok" id="docCommit">✅ ${labels.verb} a uložit doklad</button>
        </div>`;
      drawDir(); draw();

      const partner = $('#docPartner'); if (partner) partner.oninput = async (e) => { draft.partner = e.target.value; await save(); };
      $('#docNote').oninput = async (e) => { draft.note = e.target.value; await save(); };
      const whLink = $('#docWh'); if (whLink) whLink.onclick = (e) => { e.preventDefault(); $('#whBtn').click(); };
      const swap = $('#docSwap'); if (swap) swap.onclick = async () => { draft.from = whTo(); await save(); drawDir(); draw(); toast(`Přesun ${whFrom()} → ${whTo()}`); };
      $('#docScan').onclick = () => scanner.open(labels.scan, addCode);
      $('#docPick').onclick = async () => { const p = await pickProduct(); if (p) { await addCode(p.code); } };
      $('#docClear').onclick = async () => { if (draft.items.length && !await confirmDlg('Zahodit doklad', 'Rozpracovaný doklad bude smazán.', 'Zahodit', true)) return; draft = { items: [], partner: '', note: '', from: draft.from }; await drafts.clear(key); draw(); };
      $('#docCommit').onclick = async () => {
        if (!draft.items.length) return;
        if (type !== 'receipt') {
          const short = draft.items.filter(i => stockOf(productById(i.productId), whFrom()) < i.qty);
          if (short.length && !await confirmDlg('Nedostatek zásob', `${short.length} položek by ve skladu ${whName(whFrom())} šlo do mínusu. Přesto ${type === 'transfer' ? 'přesunout' : 'vydat'}?`, labels.verb)) return;
        }
        const m = await commitMovement(type, draft.items, { partner: (draft.partner || '').trim(), note: (draft.note || '').trim(), wh: whFrom(), whTo: type === 'transfer' ? whTo() : null });
        await drafts.clear(key);
        toast(`${labels.title} ${m.docNo} uložen`);
        showMovement(m.id); location.hash = '#/historie';
      };

      // Z karty produktu: „⇄ Přesun“ rovnou přidá produkt do dokladu.
      const pid = params && params.get('pid'); const pre = pid && productById(pid);
      if (pre) { history.replaceState(null, '', `#${location.hash.replace(/^#/, '').split('?')[0]}`); await addCode(pre.code); }
    };
  }
  routes['/prijem'] = docView('receipt');
  routes['/vydej'] = docView('issue');
  routes['/presun'] = docView('transfer');

  async function pickProduct() {
    return new Promise((resolve) => {
      dialog(`
        <div class="modal-head"><strong>Vybrat produkt</strong><button class="iconbtn" data-close>✕</button></div>
        <input id="pickQ" placeholder="Hledat…" autofocus>
        <div class="list" id="pickList" style="margin-top:10px;max-height:55vh;overflow:auto"></div>`, {
        onOpen(card, close) {
          const draw = () => {
            const q = $('#pickQ', card).value.toLowerCase();
            const list = state.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, 50);
            $('#pickList', card).innerHTML = list.map(p => `<div class="item clickable" data-id="${p.id}"><div class="grow"><div class="name">${esc(p.name)}</div><div class="code mono">${esc(p.code)} · ${WAREHOUSES.map(w => `${w.id} ${fmtQty(stockOf(p, w.id))}`).join(' · ')} ${esc(p.unit)}</div></div></div>`).join('') || '<div class="empty">Nic.</div>';
            $$('[data-id]', card).forEach(d => d.onclick = () => { close(null); resolve(productById(d.dataset.id)); });
          };
          $('#pickQ', card).oninput = draw; draw();
        }
      }).then(r => { if (r === null) resolve(null); });
    });
  }

  // ---------- Inventura ----------
  routes['/inventura'] = async (el) => {
    setTitle(`Inventura ${state.wh}`);
    const key = `draft:inventory:${state.wh}`;
    let draft = (await drafts.get(key)) || { counts: {}, note: '' }; // counts[productId] = spočítané množství
    const save = () => drafts.set(key, draft);
    let onlyCounted = false;

    const draw = () => {
      const counted = Object.keys(draft.counts).length;
      const list = state.products.filter(p => !onlyCounted || draft.counts[p.id] !== undefined);
      let diffCount = 0;
      $('#invList', el).innerHTML = list.length ? `<div class="table-wrap"><table>
        <tr><th>Produkt</th><th class="num">Evidence</th><th class="num">Spočteno</th><th class="num">Rozdíl</th></tr>
        ${list.map(p => {
          const c = draft.counts[p.id]; const s = stockOf(p);
          const d = c === undefined ? null : c - s; if (d) diffCount++;
          return `<tr><td><div>${esc(p.name)}</div><div class="muted mono small">${esc(p.code)}</div></td><td class="num">${fmtQty(s)}</td>
            <td class="num"><input type="number" step="any" min="0" data-cnt="${p.id}" value="${c === undefined ? '' : c}" style="width:90px;text-align:right;min-height:36px;padding:6px"></td>
            <td class="num">${d === null ? '<span class="muted">—</span>' : d === 0 ? '<span class="badge ok">OK</span>' : `<span class="${d > 0 ? 'diff-pos' : 'diff-neg'}">${d > 0 ? '+' : ''}${fmtQty(d)}</span>`}</td></tr>`;
        }).join('')}</table></div>` : '<div class="empty">Žádné produkty.</div>';
      $('#invSummary', el).textContent = `Spočteno ${counted} z ${state.products.length} · rozdílů: ${diffCount}`;
      $('#invCommit', el).disabled = !counted;
      $$('[data-cnt]', el).forEach(i => i.onchange = async () => { if (i.value === '') delete draft.counts[i.dataset.cnt]; else draft.counts[i.dataset.cnt] = Number(i.value); await save(); draw(); });
    };

    el.innerHTML = `
      <div class="card">
        <div style="margin-bottom:8px">Inventura skladu <strong>${whInfo(state.wh).flag} ${esc(whName(state.wh))}</strong> <a href="#" id="invWh" class="small">(přepnout sklad)</a></div>
        <p class="muted small" style="margin-top:0">Skenuj zboží v regálech – každé načtení přičte 1 ks (nebo zadej množství). Produkty, které nespočítáš, zůstanou beze změny. Druhý sklad se inventura netýká.</p>
        <div class="row">
          <button class="btn big grow" id="invScan">📷 Skenovat a počítat</button>
          <button class="btn secondary" id="invMode" style="min-height:52px" title="Režim: každý sken +1 nebo dotaz na množství">+1</button>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="row" style="margin:0;gap:6px"><input type="checkbox" id="invOnly" style="width:auto;min-height:auto"> jen spočítané</label>
          <span class="grow"></span>
          <button class="btn sm secondary" id="invZero">Nespočtené = 0</button>
          <button class="btn sm secondary" id="invClear">Zahodit</button>
        </div>
      </div>
      <div id="invList"></div>
      <div class="sticky-actions">
        <div class="muted small" id="invSummary" style="margin-bottom:6px"></div>
        <button class="btn big ok" id="invCommit">✅ Uzavřít inventuru a srovnat stavy</button>
      </div>`;
    draw();

    let plusOne = true;
    $('#invWh').onclick = (e) => { e.preventDefault(); $('#whBtn').click(); };
    $('#invMode').onclick = () => { plusOne = !plusOne; $('#invMode').textContent = plusOne ? '+1' : '#?'; toast(plusOne ? 'Režim: každý sken +1' : 'Režim: dotaz na množství'); };
    $('#invOnly').onchange = (e) => { onlyCounted = e.target.checked; draw(); };
    $('#invScan').onclick = () => scanner.open('Inventura – skenuj zboží', async (code) => {
      let p = productByCode(code);
      if (!p) {
        scanner.feedback(`Neznámý kód ${code}`, false); await scanner.close();
        if (await confirmDlg('Neznámý kód', `Kód ${code} v databázi není. Založit nový produkt?`, 'Založit')) { p = await productForm({ code }, { codeLocked: true }); }
        if (!p) return;
      }
      const cur = draft.counts[p.id] || 0;
      if (plusOne) { draft.counts[p.id] = cur + 1; scanner.feedback(`✓ ${p.name}: ${fmtQty(cur + 1)} ${p.unit}`, true); }
      else {
        scanner.feedback(`✓ ${p.name}`, true); await scanner.pause();
        const q = await qtyDialog(p, { title: `Spočteno: ${p.name}`, defaultQty: cur || '' , extraHtml: cur ? `<p class="muted small">Zatím spočteno ${fmtQty(cur)} ${esc(p.unit)}; nové množství ho nahradí.</p>` : '' });
        if (q !== null) draft.counts[p.id] = q;
        await scanner.resume();
      }
      await save(); draw();
    });
    $('#invZero').onclick = async () => {
      if (!await confirmDlg('Nespočtené = 0', 'Všem produktům bez zadaného počtu se nastaví spočteno 0. Hodí se pro úplnou inventuru.', 'Nastavit')) return;
      state.products.forEach(p => { if (draft.counts[p.id] === undefined) draft.counts[p.id] = 0; }); await save(); draw();
    };
    $('#invClear').onclick = async () => { if (!await confirmDlg('Zahodit inventuru', 'Všechny spočtené hodnoty budou smazány.', 'Zahodit', true)) return; draft = { counts: {}, note: '' }; await drafts.clear(key); draw(); };
    $('#invCommit').onclick = async () => {
      const items = Object.entries(draft.counts).map(([productId, qty]) => ({ productId, qty })).filter(i => productById(i.productId));
      const diffs = items.filter(i => stockOf(productById(i.productId)) !== i.qty);
      if (!await confirmDlg(`Uzavřít inventuru ${state.wh}`, `${items.length} produktů spočteno, u ${diffs.length} se stav ve skladu ${whName(state.wh)} změní. Pokračovat?`, 'Uzavřít')) return;
      const m = await commitMovement('inventory', items, { note: `Inventura ${whName(state.wh)}`, wh: state.wh });
      await drafts.clear(key); toast(`Inventura ${m.docNo} uzavřena`); showMovement(m.id); location.hash = '#/historie';
    };
  };

  // ---------- Objednávky ----------
  // Tok: kancl zadá objednávku (text / fotka / výběr) → sklad připravuje → „Připraveno“ odepíše ze skladu → Vydáno.
  const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = (s) => normTxt(s).split(/[^a-z0-9%]+/).filter(t => t.length > 1);

  /** Jednoduché rozpoznání bez AI: řádek = množství + název, shoda podle slov v názvu produktu. */
  function localParse(text) {
    const items = [];
    for (const rawLine of text.split(/\n|;/)) {
      const line = rawLine.trim(); if (!line) continue;
      let qty = 1, name = line, unit = '';
      const m = line.match(/^(\d+(?:[.,]\d+)?)\s*(ks|kg|g|l|ml|bal|krt|pal|m|x)?\s*[x×]?\s*(.+)$/i) || line.match(/^(.+?)\s*[-–:]?\s*(\d+(?:[.,]\d+)?)\s*(ks|kg|g|l|ml|bal|krt|pal|m)?\.?$/i);
      if (m) {
        if (/^\d/.test(m[1])) { qty = Number(m[1].replace(',', '.')); unit = (m[2] || '').toLowerCase(); name = m[3]; }
        else { name = m[1]; qty = Number(m[2].replace(',', '.')); unit = (m[3] || '').toLowerCase(); }
      }
      const byCode = productByCode(name.trim());
      let best = byCode ? { p: byCode, score: 1 } : { p: null, score: 0 };
      if (!byCode) {
        const q = tokens(name);
        for (const p of state.products) {
          const pt = tokens(p.name); if (!pt.length) continue;
          const hit = q.filter(t => pt.some(x => x.startsWith(t) || t.startsWith(x))).length;
          const score = hit / Math.max(q.length, 1) * 0.7 + hit / pt.length * 0.3;
          if (score > best.score) best = { p, score };
        }
      }
      const p = best.score >= 0.5 ? best.p : null;
      items.push({ productId: p ? p.id : null, code: p ? p.code : null, name: p ? p.name : name.trim(), qty, unit: p ? p.unit : (unit || 'ks'), raw: line, confidence: Math.round(best.score * 100) / 100 });
    }
    return { items, customer: '', note: '' };
  }

  async function aiParse({ text, image }) {
    const catalog = state.products.map(p => ({ code: p.code, name: p.name, unit: p.unit }));
    const r = await DB.callFunction('parse-order', { text, image, products: catalog });
    if (r && r.error) throw new Error(r.error);
    r.items = (r.items || []).map(it => { const p = it.code ? productByCode(it.code) : null; return { productId: p ? p.id : null, code: p ? p.code : null, name: p ? p.name : it.name, qty: Number(it.qty) || 1, unit: p ? p.unit : (it.unit || 'ks'), raw: it.raw || '', confidence: it.confidence ?? 0.5 }; });
    return r;
  }

  const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
  async function shrinkImage(file, max = 1600) {
    const bmp = await createImageBitmap(file); const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return { media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
  }

  async function saveOrder(o) { o.updatedAt = Date.now(); await DB.put('orders', o); await loadAll(); return o; }
  const orderById = (id) => state.orders.find(o => o.id === id);

  /** Formulář objednávky (nová / úprava). Vrací uloženou objednávku nebo null. */
  async function orderForm(order = null) {
    let o = order ? JSON.parse(JSON.stringify(order)) : { id: uid(), no: '', ts: Date.now(), status: 'new', customer: '', note: '', rawText: '', items: [], createdBy: state.user, wh: state.wh, custAddress: '', custIco: '', custDic: '' };
    if (!o.wh) o.wh = state.wh;
    const ai = DB.mode === 'remote';
    const whLocked = o.items.some(i => i.picked != null); // už se vydává → sklad nejde měnit
    const customers = [...new Set(state.orders.map(x => x.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'cs'));
    return new Promise((resolve) => {
      dialog(`
        <div class="modal-head"><strong>${order ? 'Upravit objednávku' : 'Nová objednávka'}</strong><button class="iconbtn" data-close>✕</button></div>
        <div class="grid2">
          <div class="field"><label>Sklad, ze kterého se vydává</label><select id="ofWh" ${whLocked ? 'disabled title="Už se vydává – sklad nejde změnit"' : ''}>${WAREHOUSES.map(w => `<option value="${w.id}" ${w.id === o.wh ? 'selected' : ''}>${w.flag} ${esc(w.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Odběratel / pro koho</label><input id="ofCustomer" list="custList" value="${esc(o.customer)}" placeholder="např. Prodejna Brno" autocomplete="off"><datalist id="custList">${customers.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
        </div>
        <details class="field" ${o.custAddress || o.custIco || o.custDic ? 'open' : ''}><summary class="small">Fakturační údaje odběratele (na fakturu)</summary>
          <div class="field" style="margin-top:8px"><label>Adresa</label><input id="ofAddr" value="${esc(o.custAddress || '')}" placeholder="Ulice 1, 602 00 Brno"></div>
          <div class="grid2"><div class="field"><label>IČO</label><input id="ofIco" value="${esc(o.custIco || '')}"></div><div class="field"><label>DIČ / IČ DPH</label><input id="ofDic" value="${esc(o.custDic || '')}"></div></div>
        </details>
        <div class="field"><label>Poznámka / termín</label><input id="ofNote" value="${esc(o.note)}" placeholder="např. do pátku"></div>
        <div class="field"><label>Text objednávky (vlož z e-mailu, každá položka na řádek)</label><textarea id="ofText" rows="4" placeholder="150 ks sýr eidam&#10;20 kg kuřecí prsa&#10;mouka 50">${esc(o.rawText)}</textarea></div>
        <div class="row" style="margin-bottom:12px">
          <button class="btn ${ai ? '' : 'secondary'}" id="ofParse">${ai ? '✨ Rozpoznat položky (AI)' : '🔍 Rozpoznat položky'}</button>
          ${ai ? '<button class="btn secondary" id="ofPhoto">📷 Z fotky</button>' : ''}
          <button class="btn secondary" id="ofPick">＋ Vybrat produkt</button>
          <input type="file" id="ofFile" accept="image/*" capture="environment" hidden>
        </div>
        <div id="ofItems"></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn secondary" data-close>Zrušit</button><button class="btn" id="ofSave">Uložit objednávku</button></div>`, {
        onOpen(card, close) {
          const whSel = () => $('#ofWh', card).value || o.wh;
          $('#ofWh', card).onchange = () => drawItems();
          // Známý odběratel → doplní se jeho fakturační údaje z poslední objednávky.
          $('#ofCustomer', card).onchange = () => {
            const prev = state.orders.find(x => x.customer === $('#ofCustomer', card).value.trim() && (x.custAddress || x.custIco || x.custDic));
            if (!prev) return;
            if (!$('#ofAddr', card).value) $('#ofAddr', card).value = prev.custAddress || '';
            if (!$('#ofIco', card).value) $('#ofIco', card).value = prev.custIco || '';
            if (!$('#ofDic', card).value) $('#ofDic', card).value = prev.custDic || '';
            $('details', card).open = true;
          };
          const drawItems = () => {
            $('#ofItems', card).innerHTML = o.items.length ? o.items.map((it, i) => `
              <div class="order-item">
                <div class="grow"><div class="name">${it.productId ? esc(it.name) : `<span class="badge danger">nenalezeno</span> ${esc(it.name)}`}</div>
                  <div class="muted small">${it.raw && it.raw !== it.name ? '„' + esc(it.raw) + '“ · ' : ''}${it.productId ? esc(it.code) + ' · skladem ' + fmtQty(stockOf(productById(it.productId), whSel())) + ' ' + esc(it.unit) + ' (' + esc(whSel()) + ')' : ''}${it.confidence != null && it.confidence < 0.8 && it.productId ? ' · <span class="badge warn">ověř</span>' : ''}</div></div>
                <div class="qty-ctl"><input type="number" step="any" min="0" data-oq="${i}" value="${it.qty}"><span class="small muted">${esc(it.unit)}</span></div>
                <button class="iconbtn" data-omap="${i}" title="Přiřadit produkt">🔗</button>
                ${it.picked != null ? '<span class="badge ok" title="Už vydáno ze skladu">vydáno</span>' : `<button class="iconbtn" data-odel="${i}" title="Odebrat">🗑</button>`}
              </div>`).join('') : '<div class="empty small">Zatím žádné položky. Vlož text a klikni „Rozpoznat“, nebo přidej produkty ručně.</div>';
            $$('[data-oq]', card).forEach(i => i.onchange = () => { o.items[i.dataset.oq].qty = Number(i.value) || 0; });
            $$('[data-odel]', card).forEach(b => b.onclick = () => { o.items.splice(b.dataset.odel, 1); drawItems(); });
            $$('[data-omap]', card).forEach(b => b.onclick = async () => { const p = await pickProduct(); if (p) { const it = o.items[b.dataset.omap]; it.productId = p.id; it.code = p.code; it.name = p.name; it.unit = p.unit; it.confidence = 1; drawItems(); } });
          };
          drawItems();
          const busy = (on) => { $$('button', card).forEach(b => b.disabled = on); };
          const applyParsed = (r, replace) => {
            if (replace) o.items = r.items; else o.items.push(...r.items);
            if (r.customer && !$('#ofCustomer', card).value) $('#ofCustomer', card).value = r.customer;
            if (r.note && !$('#ofNote', card).value) $('#ofNote', card).value = r.note;
            drawItems();
            const miss = r.items.filter(i => !i.productId).length;
            toast(`Rozpoznáno ${r.items.length} položek${miss ? `, ${miss} nenalezeno v katalogu` : ''}`, 3500);
          };
          $('#ofParse', card).onclick = async () => {
            const text = $('#ofText', card).value.trim(); if (!text) return toast('Nejdřív vlož text objednávky');
            busy(true);
            try { applyParsed(ai ? await aiParse({ text }) : localParse(text), true); }
            catch (err) { toast('AI selhalo: ' + err.message + ' – použito jednoduché rozpoznání', 4000); applyParsed(localParse(text), true); }
            busy(false);
          };
          const pb = $('#ofPhoto', card);
          if (pb) {
            pb.onclick = () => $('#ofFile', card).click();
            $('#ofFile', card).onchange = async () => {
              const f = $('#ofFile', card).files[0]; if (!f) return;
              busy(true); toast('Čtu fotku…');
              try { applyParsed(await aiParse({ image: await shrinkImage(f), text: $('#ofText', card).value.trim() || undefined }), o.items.length === 0); }
              catch (err) { toast('Nepodařilo se přečíst fotku: ' + err.message, 4000); }
              busy(false);
            };
          }
          $('#ofPick', card).onclick = async () => {
            const p = await pickProduct(); if (!p) return;
            const q = await qtyDialog(p, { title: `Objednat: ${p.name}`, wh: whSel() }); if (q === null) return;
            const ex = o.items.find(i => i.productId === p.id);
            if (ex) ex.qty = q; else o.items.push({ productId: p.id, code: p.code, name: p.name, qty: q, unit: p.unit, raw: '', confidence: 1 });
            drawItems();
          };
          $('#ofSave', card).onclick = async () => {
            o.customer = $('#ofCustomer', card).value.trim(); o.note = $('#ofNote', card).value.trim(); o.rawText = $('#ofText', card).value;
            if (!whLocked) o.wh = whSel();
            o.custAddress = $('#ofAddr', card).value.trim(); o.custIco = $('#ofIco', card).value.trim(); o.custDic = $('#ofDic', card).value.trim();
            o.items = o.items.filter(i => i.qty > 0 || i.picked != null);
            o.items.forEach(i => { i.id = i.id || uid(); });
            if (!o.items.length) return toast('Objednávka nemá žádné položky');
            if (!o.no) { const seq = (state.settings.orderSeq || 0) + 1; await setSetting('orderSeq', seq); o.no = `O-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`; }
            await saveOrder(o); close('saved'); resolve(o);
          };
        }
      }).then(r => { if (r !== 'saved') resolve(null); });
    });
  }

  let orderFilter = 'open';
  routes['/objednavky'] = async (el) => {
    setTitle('Objednávky');
    const list = state.orders.filter(o => orderFilter === 'all' || (orderFilter === 'open' ? (o.status === 'new' || o.status === 'preparing') : o.status === orderFilter));
    el.innerHTML = `
      <div class="row between" style="margin-bottom:12px">
        <div class="chips" style="margin:0">${[['open', 'K vyřízení'], ['ready', 'Připravené'], ['done', 'Vydané'], ['all', 'Vše']].map(([k, l]) => `<span class="chip ${orderFilter === k ? 'active' : ''}" data-f="${k}">${l}</span>`).join('')}</div>
        <button class="btn" id="ordNew">＋ Nová objednávka</button>
      </div>
      ${DB.mode !== 'remote' ? '<p class="muted small">Objednávky jsou zatím jen v tomto zařízení. Pro posílání z kanclu do mobilů nastav společnou databázi v Nastavení.</p>' : ''}
      ${list.length ? `<div class="list">${list.map(o => `<div class="item clickable" data-oid="${o.id}">
        <div class="grow"><div class="name">${esc(o.no)} · ${esc(o.customer || 'bez odběratele')}</div>
          <div class="code">${whBadge(o.wh)} ${o.items.length} položek · ${fmtDate(o.ts)}${o.note ? ' · ' + esc(o.note) : ''}${o.createdBy ? ' · ' + esc(o.createdBy) : ''}${o.invoiceNo ? ' · 🧾 ' + esc(o.invoiceNo) : ''}</div></div>
        <span class="badge status-${o.status}">${ORDER_STATUS[o.status]}</span></div>`).join('')}</div>`
        : '<div class="empty"><div class="big">🧾</div>Žádné objednávky.</div>'}`;
    $$('.chip', el).forEach(c => c.onclick = () => { orderFilter = c.dataset.f; render(); });
    $('#ordNew').onclick = async () => { const o = await orderForm(); if (o) location.hash = `#/objednavka?id=${o.id}`; };
    $$('[data-oid]', el).forEach(d => d.onclick = () => location.hash = `#/objednavka?id=${d.dataset.oid}`);
  };

  // ---------- Vychystávání objednávky (sken → vydáno → štítek) ----------
  const orderMovementOf = (o) => (o.movementId ? state.movements.find(x => x.id === o.movementId) : null);

  /** Vydá položku objednávky ze skladu (hned při skenu). Opakované vydání téže položky nejdřív vrátí předchozí množství. */
  async function orderPick(o, itemId, qty, extra = {}) {
    const it = o.items.find(i => i.id === itemId); const p = it && productById(it.productId); if (!p) return;
    let m = orderMovementOf(o);
    if (!m) { m = { id: uid(), type: 'issue', ts: Date.now(), docNo: await nextDocNo('issue', o.wh), items: [], by: state.user, partner: o.customer, note: `Objednávka ${o.no}`, orderId: o.id, wh: o.wh, whTo: null }; o.movementId = m.id; }
    const old = m.items.find(l => l.orderItemId === itemId);
    if (old) { setStockOf(p, o.wh, stockOf(p, o.wh) + old.qty); returnToBatches(p, old.batches, old.qty, o.wh); m.items = m.items.filter(l => l !== old); }
    const line = applyLine(p, 'issue', { qty, weights: extra.weights || null }, o.wh);
    Object.assign(line, { orderItemId: itemId, ts: Date.now(), by: state.user, manual: !!extra.manual });
    m.items.push(line); m.updatedAt = Date.now();
    Object.assign(it, { picked: qty, pickedAt: Date.now(), pickedBy: state.user, weights: extra.weights || null, manual: !!extra.manual });
    if (o.status === 'new') o.status = 'preparing';
    await DB.applyMovement(m, [p]);
    await saveOrder(o);
  }
  /** Vrátí vydanou položku zpět na sklad (skladník se spletl, zboží se vrátilo do regálu). */
  async function orderUnpick(o, itemId) {
    const it = o.items.find(i => i.id === itemId); const p = it && productById(it.productId);
    const m = orderMovementOf(o); const old = m && m.items.find(l => l.orderItemId === itemId);
    if (old && p) {
      setStockOf(p, o.wh, stockOf(p, o.wh) + old.qty); p.updatedAt = Date.now(); returnToBatches(p, old.batches, old.qty, o.wh);
      m.items = m.items.filter(l => l !== old); m.updatedAt = Date.now();
      await DB.applyMovement(m, [p]);
    }
    Object.assign(it, { picked: null, pickedAt: null, pickedBy: null, weights: null, manual: false });
    await saveOrder(o);
  }

  /** Červená obrazovka: naskenováno jiné zboží. Vyřeší se až po potvrzení, že je zboží vrácené na místo. */
  function wrongProductScreen(expected, scanned, code) {
    return new Promise((resolve) => {
      const s = $('#errScreen');
      $('#errTitle').textContent = expected ? 'ŠPATNÝ PRODUKT' : 'TOTO V OBJEDNÁVCE NENÍ';
      $('#errDetail').innerHTML = `
        <div><span class="lbl">Naskenováno</span><strong>${scanned ? esc(scanned.name) : 'neznámý kód'}</strong><span class="mono small">${esc(code)}</span></div>
        ${expected ? `<div><span class="lbl">Správně má být</span><strong>${esc(expected.name)}</strong><span class="mono small">${esc(expected.code)}${expected.location ? ' · ' + esc(expected.location) : ''}</span></div>` : ''}`;
      const btn = $('#errReturn'); let step = 0;
      btn.textContent = '↩ Vrátit zboží zpět na místo'; btn.classList.remove('ok');
      btn.onclick = () => {
        if (step === 0) { step = 1; btn.textContent = '✔ Potvrzuji: zboží je vrácené na místě'; btn.classList.add('ok'); return; }
        s.classList.add('hidden'); btn.classList.remove('ok'); resolve(true);
      };
      s.classList.remove('hidden'); beep(false);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    });
  }

  /** Po úspěšném skenu: u váženého zboží váhy kusů, jinak potvrzení množství. Pak vydání ze skladu. */
  async function pickQty(o, itemId, manual = false) {
    const it = o.items.find(i => i.id === itemId); const p = it && productById(it.productId); if (!p) return;
    let qty, weights = null;
    if (isWeighed(p)) { const r = await weighDialog(p, it.qty, it.weights); if (!r) return; qty = r.total; weights = r.weights; }
    else {
      const q = await qtyDialog(p, { title: `Vydat: ${p.name}`, defaultQty: it.picked ?? it.qty, wh: o.wh, extraHtml: `<p class="muted small" style="margin-top:0">Objednáno <strong>${fmtQty(it.qty)} ${esc(p.unit)}</strong>. Potvrď, nebo uprav skutečně vydané množství.</p>` });
      if (q === null || q <= 0) return; qty = q;
    }
    await orderPick(o, itemId, qty, { weights, manual });
    toast(`✓ ${p.name}: ${fmtQty(qty)} ${p.unit} vydáno`); render();
  }
  /** Ťuknutí na položku: spustí kameru, kontroluje, že naskenované zboží je to správné. */
  function pickScan(o, itemId) {
    const it = o.items.find(i => i.id === itemId); const p = it && productById(it.productId); if (!p) return;
    scanner.open(`Naskenuj: ${p.name}`, async (code) => {
      const scanned = productByCode(code);
      if (!scanned || scanned.id !== p.id) {
        await scanner.close();
        await wrongProductScreen(p, scanned, code);
        return pickScan(o, itemId);
      }
      scanner.feedback(`✓ ${p.name}`, true); await scanner.close();
      await pickQty(o, itemId, false);
    });
  }
  function drawBarcode(svg, text) {
    try { JsBarcode(svg, text, { format: 'CODE128', displayValue: true, fontSize: 16, height: 70, margin: 6, background: '#ffffff', lineColor: '#000000' }); }
    catch (err) { svg.outerHTML = `<div class="muted small">Čárový kód nelze vykreslit: ${esc(err.message || err)}</div>`; }
  }

  routes['/objednavka'] = async (el, params) => {
    const o = orderById(params.get('id'));
    if (!o) { location.hash = '#/objednavky'; return; }
    setTitle(o.no);
    o.items.forEach(i => { i.id = i.id || uid(); });
    const editable = o.status === 'new' || o.status === 'preparing';
    const unmatched = o.items.filter(i => !i.productId);
    const picked = o.items.filter(i => i.picked != null);
    const short = o.items.filter(i => i.picked == null && i.productId && stockOf(productById(i.productId), o.wh) < i.qty);
    const draw = () => {
      $('#ordItems', el).innerHTML = o.items.map(it => {
        const p = it.productId ? productById(it.productId) : null; const done = it.picked != null;
        return `<div class="order-item ${done ? 'done' : ''} ${editable && p ? 'clickable' : ''}" data-row="${it.id}">
          <div class="pick-mark">${done ? '✅' : (p ? (editable ? '📷' : '○') : '⚠️')}</div>
          <div class="grow"><div class="name">${esc(it.name)}${!p ? ' <span class="badge danger">není v katalogu</span>' : ''}</div>
            <div class="muted small">${p ? `${esc(p.location || 'bez umístění')} · ${esc(p.code)} · skladem ${fmtQty(stockOf(p, o.wh))} ${esc(p.unit)} (${esc(o.wh)})` : esc(it.raw || '')}</div>
            ${done ? `<div class="small picked-info">Vydáno ${fmtQty(it.picked)} ${esc(it.unit)}${it.weights && it.weights.length > 1 ? ' (' + it.weights.map(fmtQty).join(' + ') + ')' : ''}${it.manual ? ' · bez skenu' : ''}${it.pickedBy ? ' · ' + esc(it.pickedBy) : ''}</div>` : ''}</div>
          <div class="qty-big">${fmtQty(it.qty)} <span class="small muted">${esc(it.unit)}</span></div>
          ${editable && p ? `<button class="iconbtn" data-more="${it.id}" title="Další možnosti">⋯</button>` : ''}
        </div>`;
      }).join('');
      $('#ordProgress', el).textContent = editable ? `Vychystáno ${picked.length} z ${o.items.length}` : '';
      $$('[data-row]', el).forEach(r => r.onclick = (e) => {
        if (e.target.closest('[data-more]')) return;
        const it = o.items.find(i => i.id === r.dataset.row); if (!editable || !it || !it.productId) return;
        if (it.picked != null) rowMenu(it.id); else pickScan(o, it.id);
      });
      $$('[data-more]', el).forEach(b => b.onclick = () => rowMenu(b.dataset.more));
    };
    const rowMenu = async (itemId) => {
      const it = o.items.find(i => i.id === itemId); const p = productById(it.productId);
      const r = await dialog(`
        <div class="modal-head"><strong>${esc(p.name)}</strong><button class="iconbtn" data-close>✕</button></div>
        <div class="muted small" style="margin-bottom:10px">Objednáno ${fmtQty(it.qty)} ${esc(p.unit)}${it.picked != null ? ` · vydáno ${fmtQty(it.picked)} ${esc(p.unit)}` : ''}</div>
        <div class="list">
          <button type="button" class="btn big" id="rmScan">📷 ${it.picked != null ? 'Naskenovat a vydat znovu' : 'Naskenovat a vydat'}</button>
          <button type="button" class="btn secondary big" id="rmManual">✎ Vydat ručně bez skenu</button>
          ${it.picked != null ? '<button type="button" class="btn danger big" id="rmUndo">↩ Vrátit zpět na sklad</button>' : ''}
        </div>`, { onOpen(card, close) { $('#rmScan', card).onclick = () => close('scan'); $('#rmManual', card).onclick = () => close('manual'); const u = $('#rmUndo', card); if (u) u.onclick = () => close('undo'); } });
      if (r === 'scan') pickScan(o, itemId);
      else if (r === 'manual') { if (await confirmDlg('Vydat bez skenu', 'Položka se vydá bez kontroly čárovým kódem. Zkontroluj zboží očima.', 'Pokračovat')) await pickQty(o, itemId, true); }
      else if (r === 'undo') { if (await confirmDlg('Vrátit na sklad', `${p.name}: ${fmtQty(it.picked)} ${p.unit} se vrátí na sklad a položka bude znovu k vychystání.`, 'Vrátit', true)) { await orderUnpick(o, itemId); toast('Vráceno na sklad'); render(); } }
    };

    el.innerHTML = `
      <div class="card">
        <div class="row between">
          <div><h2>${esc(o.no)} ${whBadge(o.wh)}</h2><div class="muted">${esc(o.customer || 'bez odběratele')}${o.custIco ? ' · IČO ' + esc(o.custIco) : ''} · ${fmtDate(o.ts)}${o.createdBy ? ' · zadal ' + esc(o.createdBy) : ''}</div>${o.note ? `<div style="margin-top:6px">📝 ${esc(o.note)}</div>` : ''}</div>
          <span class="badge status-${o.status}" style="font-size:14px">${ORDER_STATUS[o.status]}</span>
        </div>
        ${o.status === 'ready' || o.status === 'done' ? `<div class="muted small" style="margin-top:8px">Připravil ${esc(o.preparedBy || '—')} ${o.preparedAt ? fmtDate(o.preparedAt) : ''}${o.movementId ? ' · výdejka <a href="#" id="ordMv">zobrazit</a>' : ''}${o.invoiceNo ? ' · faktura ' + esc(o.invoiceNo) : ''}</div>` : ''}
      </div>
      ${editable && o.wh !== state.wh ? `<div class="card" style="border-color:var(--primary)">ℹ️ Objednávka je ze skladu <strong>${whInfo(o.wh).flag} ${esc(whName(o.wh))}</strong>. Vydané zboží se odepíše z tohoto skladu, i když máš v zařízení vybraný ${esc(whName(state.wh))}.</div>` : ''}
      ${o.status === 'ready' || o.status === 'done' ? `<div class="card label-card"><div class="row between"><h2>🏷️ Štítek a faktura</h2><div class="row"><a class="btn" href="#/stitek?id=${o.id}">🖨 Štítek na paletu</a><a class="btn secondary" href="#/faktura?id=${o.id}">🧾 Faktura</a></div></div><svg id="ordBarcode"></svg><p class="muted small" style="margin:6px 0 0">Naskenováním štítku (📷 nahoře) se objednávka otevře v mobilu. Fakturu vytiskneš z počítače.</p></div>` : ''}
      ${editable ? `<p class="muted small" style="margin:0 0 10px">Ťukni na položku, naskenuj její čárový kód a potvrď množství. Vydané zboží se hned odepíše ze skladu.</p>` : ''}
      ${unmatched.length && editable ? `<div class="card" style="border-color:var(--danger)"><strong>⚠️ ${unmatched.length} položek není přiřazeno k produktu</strong><div class="muted small">Přiřaď je přes Upravit → 🔗, jinak je nejde vydat.</div></div>` : ''}
      ${short.length && editable ? `<div class="card" style="border-color:var(--warn)"><strong>⚠️ Nedostatek na skladě:</strong> ${short.map(i => esc(i.name)).join(', ')}</div>` : ''}
      <div class="card"><div class="row between"><h2>Položky</h2><span class="muted small" id="ordProgress"></span></div><div id="ordItems"></div>
        ${editable ? '<button class="btn secondary" id="ordScan" style="margin-top:12px">📷 Naskenovat cokoli z objednávky</button>' : ''}</div>
      <div class="sticky-actions">
        ${editable ? `<button class="btn big ok" id="ordReady" style="margin-bottom:8px">✅ Ukončeno – připraveno</button>` : ''}
        ${o.status === 'ready' ? `<button class="btn big" id="ordDone" style="margin-bottom:8px">🚚 Vydáno / předáno</button>` : ''}
        <div class="row">
          ${editable ? `<button class="btn secondary" id="ordEdit">✏️ Upravit</button><button class="btn secondary" id="ordCancel">Zrušit obj.</button>` : ''}
          ${o.status === 'done' || o.status === 'cancelled' ? `<button class="btn secondary" id="ordCopy">Kopírovat jako novou</button>` : ''}
          <span class="grow"></span><a class="btn secondary" href="#/objednavky">← Zpět</a>
        </div>
      </div>`;
    draw();
    const bc = $('#ordBarcode', el); if (bc) drawBarcode(bc, o.no);
    const mv = $('#ordMv', el); if (mv) mv.onclick = (e) => { e.preventDefault(); showMovement(o.movementId); };
    const ed = $('#ordEdit', el); if (ed) ed.onclick = async () => { await orderForm(o); render(); };
    const sc = $('#ordScan', el); if (sc) sc.onclick = () => scanner.open('Naskenuj zboží z objednávky', async (code) => {
      const p = productByCode(code);
      const it = p ? (o.items.find(i => i.productId === p.id && i.picked == null) || o.items.find(i => i.productId === p.id)) : null;
      await scanner.close();
      if (!it) { await wrongProductScreen(null, p, code); return sc.onclick(); }
      scanner.feedback(`✓ ${p.name}`, true);
      await pickQty(o, it.id, false);
    });
    const cn = $('#ordCancel', el); if (cn) cn.onclick = async () => {
      if (picked.length && !await confirmDlg('Zrušit objednávku', `${picked.length} položek už je vydaných. Vrátí se zpět na sklad a objednávka se zruší.`, 'Vrátit a zrušit', true)) return;
      if (!picked.length && !await confirmDlg('Zrušit objednávku', 'Objednávka se označí jako zrušená.', 'Zrušit objednávku', true)) return;
      for (const it of picked) await orderUnpick(o, it.id);
      o.status = 'cancelled'; await saveOrder(o); render();
    };
    const rd = $('#ordReady', el); if (rd) rd.onclick = async () => {
      const notPicked = o.items.filter(i => i.picked == null);
      if (!picked.length) { toast('Nejdřív naskenuj a vydej položky'); return; }
      if (notPicked.length && !await confirmDlg('Ukončit objednávku', `${notPicked.length} položek není vychystaných (${notPicked.map(i => i.name).join(', ')}). Nebudou odepsány ze skladu. Ukončit i tak?`, 'Ukončit')) return;
      o.status = 'ready'; o.preparedBy = state.user; o.preparedAt = Date.now();
      await assignInvoiceNo(o);
      await saveOrder(o); toast(`${o.no} připraveno – štítek i faktura jsou k tisku`); render();
    };
    const dn = $('#ordDone', el); if (dn) dn.onclick = async () => { o.status = 'done'; o.doneAt = Date.now(); await saveOrder(o); render(); };
    const cp = $('#ordCopy', el); if (cp) cp.onclick = async () => {
      const items = o.items.map(i => ({ ...i, id: uid(), picked: null, pickedAt: null, pickedBy: null, weights: null, manual: false }));
      const n = await orderForm({ ...o, id: uid(), no: '', ts: Date.now(), status: 'new', items, preparedBy: null, preparedAt: null, movementId: null, doneAt: null, invoiceNo: null, invoiceAt: null, createdBy: state.user });
      if (n) location.hash = `#/objednavka?id=${n.id}`;
    };
  };

  /** Tisková stránka štítku na paletu (z počítače: Tisk → nálepka). */
  routes['/stitek'] = async (el, params) => {
    const o = orderById(params.get('id'));
    if (!o) { location.hash = '#/objednavky'; return; }
    setTitle(`Štítek ${o.no}`);
    const issued = o.items.filter(i => i.picked != null);
    el.innerHTML = `
      <div class="label-sheet">
        <div class="label">
          <div class="label-head"><div class="label-no">${esc(o.no)}</div><div class="label-date"><strong>${whInfo(o.wh).flag} ${esc(whName(o.wh))}</strong><br>${fmtDate(o.preparedAt || o.ts)}</div></div>
          <div class="label-customer">${esc(o.customer || '')}</div>
          <svg id="lblBarcode"></svg>
          <div class="label-meta">${issued.length} položek · připravil ${esc(o.preparedBy || '—')}${o.note ? ' · ' + esc(o.note) : ''}</div>
          <ul class="label-items">${(issued.length ? issued : o.items).map(i => `<li>${fmtQty(i.picked ?? i.qty)} ${esc(i.unit)} ${esc(i.name)}</li>`).join('')}</ul>
        </div>
        <div class="row no-print" style="margin-top:14px"><button class="btn" id="lblPrint">🖨 Tisknout</button><a class="btn secondary" href="#/objednavka?id=${o.id}">← Zpět na objednávku</a></div>
        <p class="muted small no-print">Tip: v dialogu tisku vyber tiskárnu štítků nebo „Uložit jako PDF“. Velikost štítku 100 × 150 mm.</p>
      </div>`;
    drawBarcode($('#lblBarcode', el), o.no);
    $('#lblPrint', el).onclick = () => window.print();
  };

  // ---------- Faktura ke každé připravené objednávce ----------
  /** Číslo faktury se přidělí při „Ukončeno – připraveno“; každý sklad má vlastní řadu (FA-CZ-…, FA-SK-…). */
  async function assignInvoiceNo(o) {
    if (o.invoiceNo) return;
    const key = `invoiceSeq_${o.wh}`; const seq = (state.settings[key] || 0) + 1; await setSetting(key, seq);
    o.invoiceNo = `FA-${o.wh}-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`; o.invoiceAt = Date.now();
  }
  /** Řádky faktury: vydané množství × cena bez DPH v měně skladu, DPH podle produktu nebo výchozí sazby. */
  function invoiceLines(o) {
    const cfg = invoiceCfg(o.wh); const defVat = cfg.vat === '' || cfg.vat == null ? 0 : Number(cfg.vat);
    const picked = o.items.filter(i => i.picked != null && i.picked > 0);
    return (picked.length ? picked : o.items.filter(i => i.productId)).map(i => {
      const p = productById(i.productId); const qty = i.picked ?? i.qty; const price = priceOf(p, o.wh);
      const vat = p && p.vat != null ? Number(p.vat) : defVat;
      const net = price == null ? null : round2(qty * price); const vatAmt = net == null ? null : round2(net * vat / 100);
      return { name: i.name, code: i.code, unit: i.unit, qty, price, vat, net, vatAmt, gross: net == null ? null : round2(net + vatAmt), weights: i.weights };
    });
  }
  async function billingDialog(o) {
    const r = await dialog(`
      <div class="modal-head"><strong>Údaje odběratele na faktuře</strong><button class="iconbtn" data-close>✕</button></div>
      <form>
        <div class="field"><label>Název / jméno</label><input name="customer" value="${esc(o.customer || '')}" required></div>
        <div class="field"><label>Adresa</label><input name="custAddress" value="${esc(o.custAddress || '')}"></div>
        <div class="grid2"><div class="field"><label>IČO</label><input name="custIco" value="${esc(o.custIco || '')}"></div><div class="field"><label>DIČ / IČ DPH</label><input name="custDic" value="${esc(o.custDic || '')}"></div></div>
        <div class="field"><label>Text na faktuře (volitelné)</label><input name="invoiceNote" value="${esc(o.invoiceNote || '')}" placeholder="např. číslo vaší objednávky"></div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn secondary" data-close>Zrušit</button><button type="submit" class="btn">Uložit</button></div>
      </form>`);
    if (!r) return false;
    Object.assign(o, { customer: r.customer.trim(), custAddress: r.custAddress.trim(), custIco: r.custIco.trim(), custDic: r.custDic.trim(), invoiceNote: r.invoiceNote.trim() });
    await saveOrder(o); return true;
  }
  routes['/faktura'] = async (el, params) => {
    const o = orderById(params.get('id'));
    if (!o) { location.hash = '#/objednavky'; return; }
    if (!o.invoiceNo && (o.status === 'ready' || o.status === 'done')) { await assignInvoiceNo(o); await saveOrder(o); }
    setTitle(`Faktura ${o.invoiceNo || o.no}`);
    const cfg = invoiceCfg(o.wh); const wh = o.wh; const cur = curOf(wh);
    const lines = invoiceLines(o);
    const issue = dayStr(o.invoiceAt || o.preparedAt || Date.now());
    const due = addDays(issue, Number(cfg.dueDays) > 0 ? Number(cfg.dueDays) : 14);
    const vs = (o.invoiceNo || o.no).replace(/\D/g, '');
    const byVat = {}; lines.forEach(l => { if (l.net == null) return; const k = String(l.vat); byVat[k] = byVat[k] || { vat: l.vat, net: 0, vatAmt: 0 }; byVat[k].net = round2(byVat[k].net + l.net); byVat[k].vatAmt = round2(byVat[k].vatAmt + l.vatAmt); });
    const totalNet = round2(Object.values(byVat).reduce((s, x) => s + x.net, 0)), totalVat = round2(Object.values(byVat).reduce((s, x) => s + x.vatAmt, 0));
    const missing = lines.filter(l => l.price == null);
    const money = (n) => fmtMoney(n, wh);
    el.innerHTML = `
      ${!cfg.name ? `<div class="card no-print" style="border-color:var(--warn)">⚠️ Chybí údaje dodavatele (název, adresa, IČO…). Doplň je v <a href="#/nastaveni">Nastavení → Fakturace</a> pro ${esc(whName(wh))}.</div>` : ''}
      ${missing.length ? `<div class="card no-print" style="border-color:var(--warn)">⚠️ Bez ceny v ${esc(cur)}: ${missing.map(l => esc(l.name)).join(', ')}. Cenu bez DPH doplň v kartě produktu a fakturu znovu otevři.</div>` : ''}
      ${o.status !== 'ready' && o.status !== 'done' ? '<div class="card no-print" style="border-color:var(--warn)">⚠️ Objednávka ještě není připravená – toto je jen náhled, faktura dostane číslo při „Ukončeno – připraveno“.</div>' : ''}
      <div class="invoice">
        <div class="inv-head">
          <div><div class="inv-title">FAKTURA</div><div class="inv-no">${esc(o.invoiceNo || 'náhled')}</div><div class="small">${whInfo(wh).flag} ${esc(whName(wh))} · objednávka ${esc(o.no)}</div></div>
          <table class="inv-meta"><tr><td>Datum vystavení</td><td>${fmtDay(issue)}</td></tr><tr><td>Datum plnění</td><td>${fmtDay(issue)}</td></tr><tr><td>Datum splatnosti</td><td><strong>${fmtDay(due)}</strong></td></tr><tr><td>Variabilní symbol</td><td>${esc(vs)}</td></tr>${cfg.bank ? `<tr><td>Účet / IBAN</td><td>${esc(cfg.bank)}</td></tr>` : ''}</table>
        </div>
        <div class="inv-parties">
          <div class="inv-party"><div class="inv-lbl">Dodavatel</div><strong>${esc(cfg.name || '—')}</strong><div>${esc(cfg.address || '').replace(/\n/g, '<br>')}</div>${cfg.ico ? `<div>IČO: ${esc(cfg.ico)}</div>` : ''}${cfg.dic ? `<div>DIČ / IČ DPH: ${esc(cfg.dic)}</div>` : ''}</div>
          <div class="inv-party"><div class="inv-lbl">Odběratel</div><strong>${esc(o.customer || '—')}</strong><div>${esc(o.custAddress || '')}</div>${o.custIco ? `<div>IČO: ${esc(o.custIco)}</div>` : ''}${o.custDic ? `<div>DIČ / IČ DPH: ${esc(o.custDic)}</div>` : ''}</div>
        </div>
        <table class="inv-table">
          <tr><th>Položka</th><th class="num">Množství</th><th class="num">Cena / j. bez DPH</th><th class="num">DPH</th><th class="num">Bez DPH</th><th class="num">S DPH</th></tr>
          ${lines.map(l => `<tr><td>${esc(l.name)}<div class="small muted">${esc(l.code || '')}${l.weights && l.weights.length > 1 ? ' · ' + l.weights.map(fmtQty).join(' + ') + ' ' + esc(l.unit) : ''}</div></td><td class="num">${fmtQty(l.qty)} ${esc(l.unit)}</td><td class="num">${l.price == null ? '—' : money(l.price)}</td><td class="num">${fmtQty(l.vat)} %</td><td class="num">${l.net == null ? '—' : money(l.net)}</td><td class="num">${l.gross == null ? '—' : money(l.gross)}</td></tr>`).join('')}
        </table>
        <div class="inv-totals">
          <table>
            ${Object.values(byVat).sort((a, b) => a.vat - b.vat).map(x => `<tr><td>Základ DPH ${fmtQty(x.vat)} %</td><td class="num">${money(x.net)}</td><td>DPH ${fmtQty(x.vat)} %</td><td class="num">${money(x.vatAmt)}</td></tr>`).join('')}
            <tr><td>Celkem bez DPH</td><td class="num">${money(totalNet)}</td><td>DPH celkem</td><td class="num">${money(totalVat)}</td></tr>
            <tr class="inv-sum"><td colspan="3">Celkem k úhradě</td><td class="num">${money(round2(totalNet + totalVat))}</td></tr>
          </table>
        </div>
        ${o.invoiceNote ? `<div class="inv-note">${esc(o.invoiceNote)}</div>` : ''}
        <div class="inv-foot">${esc(cfg.footer || '')}${o.preparedBy ? `<div class="small muted">Vystavil: ${esc(o.preparedBy)}${o.preparedAt ? ' · ' + fmtDate(o.preparedAt) : ''}</div>` : ''}</div>
      </div>
      <div class="row no-print" style="margin-top:14px"><button class="btn" id="invPrint">🖨 Tisknout / uložit PDF</button><button class="btn secondary" id="invBilling">✏️ Údaje odběratele</button><a class="btn secondary" href="#/objednavka?id=${o.id}">← Zpět na objednávku</a></div>
      <p class="muted small no-print">Ceny bez DPH jsou z karty produktu (${cur === 'EUR' ? 'cena v €' : 'cena v Kč'}), sazba DPH z produktu nebo výchozí z Nastavení → Fakturace.</p>`;
    $('#invPrint', el).onclick = () => window.print();
    $('#invBilling', el).onclick = async () => { if (await billingDialog(o)) render(); };
  };

  // ---------- Historie ----------
  let histFilter = 'all', histWh = 'all';
  routes['/historie'] = async (el) => {
    setTitle('Historie');
    const list = state.movements.filter(m => (histFilter === 'all' || m.type === histFilter) && (histWh === 'all' || m.wh === histWh || m.whTo === histWh));
    el.innerHTML = `
      <div class="chips">${[['all', 'Vše'], ['receipt', 'Příjmy'], ['issue', 'Výdeje'], ['transfer', 'Přesuny'], ['inventory', 'Inventury'], ['adjust', 'Korekce']].map(([k, l]) => `<span class="chip ${histFilter === k ? 'active' : ''}" data-f="${k}">${l}</span>`).join('')}
        <span class="grow"></span>${[['all', 'Oba sklady'], ...WAREHOUSES.map(w => [w.id, `${w.flag} ${w.id}`])].map(([k, l]) => `<span class="chip ${histWh === k ? 'active' : ''}" data-wh="${k}">${l}</span>`).join('')}</div>
      ${list.length ? `<div class="table-wrap card" style="padding:0"><table>
        <tr><th>Datum</th><th>Doklad</th><th>Typ</th><th>Sklad</th><th>Partner / pozn.</th><th class="num">Položek</th><th class="num">Množství</th></tr>
        ${list.map(m => `<tr class="clickable" data-mid="${m.id}"><td class="small">${fmtDate(m.ts)}</td><td class="mono small">${esc(m.docNo)}</td><td><span class="badge ${TYPE_BADGE[m.type]}">${TYPE_LABEL[m.type]}</span></td><td>${whBadge(m.wh)}${m.whTo ? ' → ' + whBadge(m.whTo) : ''}</td><td class="small">${esc([m.partner, m.note].filter(Boolean).join(' · ') || '—')}</td><td class="num">${m.items.length}</td><td class="num">${fmtQty(m.items.reduce((s, i) => s + Math.abs(i.diff), 0))}</td></tr>`).join('')}
      </table></div>` : '<div class="empty"><div class="big">🕘</div>Žádné doklady.</div>'}`;
    $$('.chip[data-f]', el).forEach(c => c.onclick = () => { histFilter = c.dataset.f; render(); });
    $$('.chip[data-wh]', el).forEach(c => c.onclick = () => { histWh = c.dataset.wh; render(); });
    $$('[data-mid]', el).forEach(tr => tr.onclick = () => showMovement(tr.dataset.mid));
  };

  async function showMovement(id) {
    const m = state.movements.find(x => x.id === id); if (!m) return;
    await dialog(`
      <div class="modal-head"><strong><span class="badge ${TYPE_BADGE[m.type]}">${TYPE_LABEL[m.type]}</span> ${esc(m.docNo)}</strong><button class="iconbtn" data-close>✕</button></div>
      <div class="muted small">${whInfo(m.wh).flag} ${esc(whName(m.wh))}${m.whTo ? ` → ${whInfo(m.whTo).flag} ${esc(whName(m.whTo))}` : ''} · ${fmtDate(m.ts)}${m.partner ? ' · ' + esc(m.partner) : ''}${m.note ? ' · ' + esc(m.note) : ''}${m.by ? ' · ' + esc(m.by) : ''}</div>
      <div class="table-wrap" style="margin-top:10px"><table>
        <tr><th>Produkt</th><th class="num">Před</th><th class="num">Změna</th><th class="num">Po</th></tr>
        ${m.items.map(i => `<tr><td><div>${esc(i.name)}</div><div class="muted mono small">${esc(i.code)}</div>${lineInfo(i) ? `<div class="muted small">${esc(lineInfo(i))}</div>` : ''}</td><td class="num">${fmtQty(i.before)}</td><td class="num ${i.diff >= 0 ? 'diff-pos' : 'diff-neg'}">${i.diff >= 0 ? '+' : ''}${fmtQty(i.diff)} ${esc(i.unit || '')}</td><td class="num">${fmtQty(i.after)}</td></tr>`).join('')}
      </table></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn secondary" id="mvCsv">⬇ CSV</button><button class="btn" data-close>Zavřít</button></div>`, {
      onOpen(card) { $('#mvCsv', card).onclick = () => downloadText(`${m.docNo}.csv`, toCsv([['Doklad', 'Datum', 'Typ', 'Sklad', 'Do skladu', 'Kód', 'Produkt', 'Jednotka', 'Před', 'Změna', 'Po'], ...m.items.map(i => [m.docNo, fmtDate(m.ts), TYPE_LABEL[m.type], m.wh || '', m.whTo || '', i.code, i.name, i.unit || '', i.before, i.diff, i.after])])); }
    });
  }

  // ---------- Export / import ----------
  function toCsv(rows) { return '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(';')).join('\r\n'); }
  function downloadText(name, text, mime = 'text/plain') {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x.trim()));
  }

  routes['/nastaveni'] = async (el) => {
    setTitle('Nastavení');
    const theme = document.documentElement.dataset.theme || 'auto';
    const cfg = DB.config() || {};
    el.innerHTML = `
      <div class="card"><h2>Společná databáze (Supabase)</h2>
        <p class="muted small">Propojí kancl (PC) a sklad (mobily): objednávky a stavy se sdílí živě. ${DB.mode === 'remote' ? `<span class="badge ok">připojeno</span> ${state.user ? 'jako ' + esc(state.user) : ''}` : '<span class="badge neutral">jen toto zařízení</span>'} Návod je v souboru <span class="mono">supabase/NAVOD.md</span>.</p>
        <div class="grid2">
          <div class="field"><label>Project URL</label><input id="sbUrl" value="${esc(cfg.url || '')}" placeholder="https://xxxx.supabase.co"></div>
          <div class="field"><label>anon public key</label><input id="sbKey" value="${esc(cfg.key || '')}" placeholder="eyJ…"></div>
        </div>
        <div class="row"><button class="btn" id="sbSave">Uložit a připojit</button>${DB.mode === 'remote' ? '<button class="btn secondary" id="sbUpload">Nahrát lokální data do databáze</button><button class="btn secondary" id="sbLogout">Odhlásit</button><button class="btn secondary" id="sbOff">Odpojit</button>' : ''}</div>
      </div>
      <div class="card"><h2>Sklady CZ a SK</h2>
        <p class="muted small">Každý sklad má vlastní stavy, šarže, inventuru i číselnou řadu dokladů. Zboží mezi nimi přesuneš přes <a href="#/presun">Přesun CZ ⇄ SK</a>. Objednávka má svůj sklad určený při zadání.</p>
        <div class="field"><label>Sklad, ve kterém toto zařízení pracuje</label><select id="setWh">${WAREHOUSES.map(w => `<option value="${w.id}" ${w.id === state.wh ? 'selected' : ''}>${w.flag} ${esc(w.name)}</option>`).join('')}</select></div>
      </div>
      <div class="card"><h2>Fakturace</h2>
        <p class="muted small">Ke každé objednávce se po „Ukončeno – připraveno“ vystaví faktura (číslo FA-CZ-… nebo FA-SK-… podle skladu). Tady vyplň údaje dodavatele; ceny bez DPH a sazbu DPH má každý produkt ve své kartě.</p>
        ${WAREHOUSES.map(w => { const c = invoiceCfg(w.id); return `<details ${w.id === state.wh ? 'open' : ''} style="margin-bottom:10px"><summary><strong>${w.flag} ${esc(w.name)}</strong> – faktury v ${esc(c.currency || w.currency)}</summary>
          <div class="grid2" style="margin-top:8px">
            <div class="field"><label>Název firmy (dodavatel)</label><input data-inv="${w.id}.name" value="${esc(c.name || '')}"></div>
            <div class="field"><label>Měna faktur</label><select data-inv="${w.id}.currency">${['CZK', 'EUR'].map(x => `<option ${(c.currency || w.currency) === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div class="field"><label>Adresa</label><input data-inv="${w.id}.address" value="${esc(c.address || '')}" placeholder="Ulice 1, 110 00 Praha"></div>
            <div class="field"><label>IČO</label><input data-inv="${w.id}.ico" value="${esc(c.ico || '')}"></div>
            <div class="field"><label>DIČ / IČ DPH</label><input data-inv="${w.id}.dic" value="${esc(c.dic || '')}"></div>
            <div class="field"><label>Bankovní účet / IBAN</label><input data-inv="${w.id}.bank" value="${esc(c.bank || '')}"></div>
            <div class="field"><label>Výchozí DPH (%) – když ji produkt nemá</label><input data-inv="${w.id}.vat" type="number" step="any" min="0" max="100" value="${esc(c.vat ?? '')}" placeholder="0"></div>
            <div class="field"><label>Splatnost (dní)</label><input data-inv="${w.id}.dueDays" type="number" min="0" value="${esc(c.dueDays ?? 14)}"></div>
            <div class="field"><label>Text na konci faktury</label><input data-inv="${w.id}.footer" value="${esc(c.footer || '')}" placeholder="např. Děkujeme za objednávku."></div>
          </div></details>`; }).join('')}
        <div class="row"><button class="btn" id="invSave">Uložit fakturační údaje</button></div>
      </div>
      <div class="card"><h2>Vzhled a chování</h2>
        <div class="grid2">
          <div class="field"><label>Téma</label><select id="setTheme"><option value="auto" ${theme === 'auto' ? 'selected' : ''}>Podle systému</option><option value="light" ${theme === 'light' ? 'selected' : ''}>Světlé</option><option value="dark" ${theme === 'dark' ? 'selected' : ''}>Tmavé</option></select></div>
          <div class="field"><label>Výchozí množství při skenu</label><input id="setDefQty" type="number" step="any" min="0" value="${esc(state.settings.defaultQty || 1)}"></div>
        </div>
      </div>
      <div class="card"><h2>Produkty – hromadně</h2>
        <p class="muted small">CSV se sloupci: <span class="mono">kod;nazev;jednotka;kategorie;minimum;umisteni;dodavatel;cena;cena_eur;dph;stav_cz;stav_sk</span> (první řádek hlavička, oddělovač ; nebo ,). Existující kódy se aktualizují, nové se založí; stavy se nastaví jen novým produktům (sloupec <span class="mono">stav</span> = sklad, ve kterém právě pracuješ).</p>
        <div class="row"><button class="btn secondary" id="csvExport">⬇ Export produktů (CSV)</button><button class="btn secondary" id="csvImport">⬆ Import produktů (CSV)</button><button class="btn secondary" id="csvTemplate">Vzor CSV</button></div>
      </div>
      <div class="card"><h2>Záloha dat</h2>
        <p class="muted small">Data jsou uložená jen v tomto prohlížeči/zařízení. Pravidelně si udělej zálohu, nebo ji použij k přenosu mezi mobilem a počítačem.</p>
        <div class="row"><button class="btn" id="bkExport">⬇ Stáhnout zálohu (JSON)</button><button class="btn secondary" id="bkImport">⬆ Obnovit ze zálohy</button><button class="btn secondary" id="histCsv">⬇ Historie pohybů (CSV)</button></div>
      </div>
      <div class="card"><h2>Nebezpečná zóna</h2>
        <div class="row"><button class="btn danger" id="wipe">Smazat všechna data</button><button class="btn secondary" id="demo">Nahrát ukázková data</button></div>
      </div>
      <p class="muted small">IMCO Sklad · ${state.products.length} produktů · ${state.movements.length} dokladů · ${state.orders.length} objednávek · verze ${APP_VERSION}</p>
      <div class="row" style="margin-bottom:14px"><button class="btn secondary" id="updCheck">🔄 Zkontrolovat aktualizaci</button><span class="muted small">Appka si novou verzi stahuje sama při otevření; tlačítko ji vynutí hned.</span></div>
      <input type="file" id="fileIn" hidden>`;

    $('#sbSave').onclick = async () => {
      const url = $('#sbUrl').value.trim().replace(/\/$/, ''), key = $('#sbKey').value.trim();
      if (!url || !key) return toast('Vyplň URL i klíč');
      DB.setConfig({ url, key }); location.reload();
    };
    const off = $('#sbOff'); if (off) off.onclick = async () => { if (!await confirmDlg('Odpojit', 'Aplikace se vrátí k datům uloženým jen v tomto zařízení.', 'Odpojit')) return; await DB.signOut(); DB.setConfig(null); location.reload(); };
    const lo = $('#sbLogout'); if (lo) lo.onclick = async () => { await DB.signOut(); location.reload(); };
    const up = $('#sbUpload'); if (up) up.onclick = async () => {
      const [products, movements, orders] = await Promise.all([DB.local.getAll('products'), DB.local.getAll('movements'), DB.local.getAll('orders')]);
      if (!products.length && !movements.length) return toast('V tomto zařízení nejsou žádná lokální data');
      if (!await confirmDlg('Nahrát lokální data', `Do společné databáze se nahraje ${products.length} produktů, ${movements.length} dokladů a ${orders.length} objednávek (sloučí se s existujícími).`, 'Nahrát')) return;
      await DB.importAll({ products, movements, orders }, { replace: false }); await loadAll(); toast('Nahráno'); render();
    };
    $('#setWh').onchange = (e) => { setWh(e.target.value); toast(`Zařízení pracuje ve skladu ${whName(e.target.value)}`); };
    $('#updCheck').onclick = async () => { toast('Stahuji nejnovější verzi…'); try { if (swReg) await swReg.update(); } catch (_) {} setTimeout(() => location.reload(), 600); };
    $('#invSave').onclick = async () => {
      const inv = JSON.parse(JSON.stringify(state.settings.invoice || {}));
      $$('[data-inv]', el).forEach(i => { const [w, k] = i.dataset.inv.split('.'); inv[w] = inv[w] || {}; inv[w][k] = i.value.trim(); });
      await setSetting('invoice', inv); toast('Fakturační údaje uloženy');
    };
    $('#setTheme').onchange = (e) => { const v = e.target.value; if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v; try { localStorage.setItem('theme', v); } catch (_) {} };
    $('#setDefQty').onchange = (e) => setSetting('defaultQty', Number(e.target.value) || 1);

    const pickFile = (accept) => new Promise(res => { const f = $('#fileIn'); f.accept = accept; f.value = ''; f.onchange = () => res(f.files[0] || null); f.click(); });

    const CSV_HEAD = ['kod', 'nazev', 'jednotka', 'kategorie', 'minimum', 'umisteni', 'dodavatel', 'cena', 'cena_eur', 'dph', 'stav_cz', 'stav_sk'];
    $('#csvTemplate').onclick = () => downloadText('produkty-vzor.csv', toCsv([CSV_HEAD, ['8594001234567', 'Sýr Eidam 30% 1 kg', 'ks', 'Mléčné výrobky', '20', 'Chladírna 1', 'Madeta', '129', '5.2', '12', '0', '0']]), 'text/csv');
    $('#csvExport').onclick = () => downloadText(`produkty-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([CSV_HEAD, ...state.products.map(p => [p.code, p.name, p.unit, p.category || '', p.minStock ?? '', p.location || '', p.supplier || '', p.price ?? '', p.priceEur ?? '', p.vat ?? '', stockOf(p, 'CZ'), stockOf(p, 'SK')])]), 'text/csv');
    $('#csvImport').onclick = async () => {
      const f = await pickFile('.csv,text/csv'); if (!f) return;
      const rows = parseCsv(await f.text()); if (rows.length < 2) return toast('CSV je prázdné');
      const head = rows[0].map(h => h.trim().toLowerCase());
      const col = (names) => head.findIndex(h => names.includes(h));
      const ci = { code: col(['kod', 'kód', 'code', 'ean']), name: col(['nazev', 'název', 'name']), unit: col(['jednotka', 'unit', 'mj']), cat: col(['kategorie', 'category']), min: col(['minimum', 'min', 'minstock']), loc: col(['umisteni', 'umístění', 'location']), sup: col(['dodavatel', 'supplier']), price: col(['cena', 'price', 'cena_czk']), priceEur: col(['cena_eur', 'price_eur']), vat: col(['dph', 'vat']), stock: col(['stav', 'stock', 'mnozstvi', 'množství']), stock_CZ: col(['stav_cz', 'stock_cz']), stock_SK: col(['stav_sk', 'stock_sk']) };
      if (ci.code < 0 || ci.name < 0) return toast('CSV musí mít sloupce kod a nazev', 4000);
      let created = 0, updated = 0;
      for (const r of rows.slice(1)) {
        const code = normCode(r[ci.code]); if (!code) continue;
        const ex = productByCode(code);
        const num = (i) => (i >= 0 && r[i] !== undefined && r[i].trim() !== '') ? Number(String(r[i]).replace(',', '.')) : null;
        const p = { ...(ex || { id: uid(), createdAt: Date.now(), stocks: {} }), code, name: (r[ci.name] || '').trim() || (ex && ex.name) || code,
          unit: (ci.unit >= 0 && r[ci.unit]) || (ex && ex.unit) || 'ks', category: (ci.cat >= 0 && r[ci.cat] || (ex && ex.category) || '').trim(),
          minStock: ci.min >= 0 ? num(ci.min) : (ex ? ex.minStock : null), location: (ci.loc >= 0 && r[ci.loc] || (ex && ex.location) || '').trim(),
          supplier: (ci.sup >= 0 && r[ci.sup] || (ex && ex.supplier) || '').trim(), price: ci.price >= 0 ? num(ci.price) : (ex ? ex.price : null),
          priceEur: ci.priceEur >= 0 ? num(ci.priceEur) : (ex ? ex.priceEur : null), vat: ci.vat >= 0 ? num(ci.vat) : (ex ? ex.vat : null), updatedAt: Date.now() };
        if (!ex) {
          // Počáteční stavy: stav_cz / stav_sk, případně „stav“ = sklad, ve kterém právě pracuješ.
          const init = {}; WAREHOUSES.forEach(w => { const v = num(ci['stock_' + w.id]); if (v !== null) init[w.id] = v; });
          if (!Object.keys(init).length && num(ci.stock) !== null) init[state.wh] = num(ci.stock);
          Object.entries(init).forEach(([w, v]) => { setStockOf(p, w, v); if (v > 0) { p.batches = p.batches || []; p.batches.push({ id: uid(), qty: round3(v), prodDate: null, useBy: null, receivedAt: Date.now(), wh: w }); } });
          migrateProduct(p);
        }
        await DB.put('products', p); ex ? updated++ : created++;
      }
      await loadAll(); toast(`Import hotov: ${created} nových, ${updated} upraveno`, 4000); render();
    };
    $('#bkExport').onclick = async () => downloadText(`imco-sklad-zaloha-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await DB.exportAll(), null, 1), 'application/json');
    $('#bkImport').onclick = async () => {
      const f = await pickFile('.json,application/json'); if (!f) return;
      let data; try { data = JSON.parse(await f.text()); } catch (_) { return toast('Soubor není platný JSON'); }
      if (!data || !Array.isArray(data.products)) return toast('To není záloha IMCO Sklad');
      const r = await dialog(`<div class="modal-head"><strong>Obnovit zálohu</strong><button class="iconbtn" data-close>✕</button></div>
        <p>Záloha z ${esc(data.exportedAt ? fmtDate(data.exportedAt) : '?')}: ${data.products.length} produktů, ${(data.movements || []).length} dokladů.</p>
        <div class="row" style="justify-content:flex-end"><button class="btn secondary" data-close>Zrušit</button><button class="btn secondary" id="bkMerge">Sloučit</button><button class="btn danger" id="bkReplace">Nahradit vše</button></div>`, {
        onOpen(card, close) { $('#bkMerge', card).onclick = () => close('merge'); $('#bkReplace', card).onclick = () => close('replace'); }
      });
      if (!r) return;
      await DB.importAll(data, { replace: r === 'replace' }); await loadAll(); toast('Záloha obnovena'); render();
    };
    $('#histCsv').onclick = () => downloadText(`pohyby-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([['Doklad', 'Datum', 'Typ', 'Sklad', 'Do skladu', 'Partner', 'Poznámka', 'Kód', 'Produkt', 'Jednotka', 'Před', 'Změna', 'Po'], ...state.movements.flatMap(m => m.items.map(i => [m.docNo, fmtDate(m.ts), TYPE_LABEL[m.type], m.wh || '', m.whTo || '', m.partner || '', m.note || '', i.code, i.name, i.unit || '', i.before, i.diff, i.after]))]), 'text/csv');
    $('#wipe').onclick = async () => {
      if (!await confirmDlg('Smazat všechna data', 'Smažou se všechny produkty, doklady i rozpracované doklady. Nelze vrátit zpět – udělej si nejdřív zálohu.', 'Smazat vše', true)) return;
      await Promise.all(['products', 'movements', 'orders', 'drafts', 'settings'].map(s => DB.clear(s))); await loadAll(); toast('Data smazána'); render();
    };
    $('#demo').onclick = async () => {
      const demo = [
        ['8594001234567', 'Sýr Eidam 30% 1 kg', 'ks', 'Mléčné výrobky', 20, 'Chladírna 1', 'Madeta', 129],
        ['8594007654321', 'Máslo 250 g', 'ks', 'Mléčné výrobky', 30, 'Chladírna 1', 'Madeta', 49],
        ['8591234567890', 'Mouka hladká 1 kg', 'ks', 'Suché zboží', 50, 'Regál A1', 'Penam', 22],
        ['8590001112223', 'Olej slunečnicový 1 l', 'ks', 'Suché zboží', 24, 'Regál A2', 'Lukana', 59],
        ['8593334445556', 'Rajčata loupaná 400 g', 'ks', 'Konzervy', 48, 'Regál B1', 'Giana', 25],
        ['8597778889990', 'Kuřecí prsa', 'kg', 'Maso', 10, 'Mrazák', 'Vodňanské kuře', 189],
      ];
      for (const [code, name, unit, category, minStock, location, supplier, price] of demo) {
        if (!productByCode(code)) await DB.put('products', { id: uid(), code, name, unit, category, minStock, location, supplier, price, priceEur: round2(price / 25), vat: 12, stocks: {}, stock: 0, createdAt: Date.now() });
      }
      await loadAll();
      const demoProducts = state.products.filter(p => demo.some(d => d[0] === p.code));
      await commitMovement('receipt', demoProducts.map(p => ({ productId: p.id, qty: Math.round(Math.random() * 80 + 20) })), { partner: 'Ukázkový dodavatel', note: 'Ukázková data', wh: 'CZ' });
      await commitMovement('receipt', demoProducts.slice(0, 3).map(p => ({ productId: p.id, qty: Math.round(Math.random() * 30 + 10) })), { partner: 'Ukázkový dodavatel SK', note: 'Ukázková data', wh: 'SK' });
      toast('Ukázková data nahrána'); render();
    };
  };

  // ---------- Rychlý sken z horní lišty ----------
  $('#quickScanBtn').onclick = () => scanner.open('Rychlé hledání', async (code) => {
    const ord = state.orders.find(x => x.no === code.toUpperCase());
    if (ord) { scanner.feedback(`Objednávka ${ord.no}`, true); await scanner.close(); location.hash = `#/objednavka?id=${ord.id}`; return; }
    const p = productByCode(code);
    if (p) { scanner.feedback(p.name, true); await scanner.close(); location.hash = `#/produkt?id=${p.id}`; }
    else { scanner.feedback(`Neznámý kód ${code}`, false); await scanner.close(); if (await productForm({ code }, { codeLocked: true })) render(); }
  });

  // ---------- Přihlášení (jen se společnou databází) ----------
  async function loginScreen() {
    return new Promise((resolve) => {
      $('#view').innerHTML = `<div class="card login"><h2>Přihlášení</h2><p class="muted small">Účty zakládá správce v Supabase (Authentication → Users).</p>
        <form id="loginForm"><div class="field"><label>E-mail</label><input name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label>Heslo</label><input name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn big" type="submit">Přihlásit</button></form>
        <p class="small" style="margin-top:14px"><a href="#" id="loginOff">Pracovat bez společné databáze (jen toto zařízení)</a></p></div>`;
      setTitle('IMCO Sklad');
      $('#loginForm').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try { await DB.signIn(f.email.value.trim(), f.password.value); resolve(true); } catch (err) { toast('Přihlášení se nezdařilo: ' + err.message, 4000); }
      };
      $('#loginOff').onclick = (e) => { e.preventDefault(); DB.setConfig(null); location.reload(); };
    });
  }

  // ---------- Aktualizace aplikace (nová verze na serveru → lišta „Načíst“) ----------
  let swReg = null;
  function showUpdateBar() {
    const bar = $('#updBar'); if (!bar || !bar.classList.contains('hidden')) return;
    bar.classList.remove('hidden');
    $('#updReload').onclick = () => location.reload();
  }

  // ---------- Start ----------
  (async () => {
    try { const t = localStorage.getItem('theme'); if (t && t !== 'auto') document.documentElement.dataset.theme = t; } catch (_) {}
    let savedWh = null; try { savedWh = localStorage.getItem('wh'); } catch (_) {}
    setWh(WAREHOUSES.some(w => w.id === savedWh) ? savedWh : 'CZ');
    if (DB.mode === 'remote') {
      let s = await DB.session();
      if (!s) { await loginScreen(); s = await DB.session(); }
      state.user = s && s.user ? (s.user.email || '').split('@')[0] : null;
      $('#navUser').textContent = state.user ? `👤 ${state.user}` : '';
      // Živé změny z ostatních zařízení: nová objednávka z kanclu se objeví v mobilu hned.
      let timer;
      DB.subscribe((store, row) => {
        if (store === 'orders' && row.data && row.data.status === 'new' && !state.orders.some(o => o.id === row.id)) {
          toast(`🧾 Nová objednávka ${row.data.no} (${row.data.customer || 'bez odběratele'})`, 5000); beep(true);
        }
        clearTimeout(timer); timer = setTimeout(async () => { await loadAll(); if ($('#dlg').classList.contains('hidden') && $('#scanModal').classList.contains('hidden')) render(); }, 300);
      });
    }
    try { await loadAll(); } catch (err) { $('#view').innerHTML = `<div class="card"><h2>Nelze načíst data</h2><p>${esc(err.message)}</p><p class="muted small">Zkontroluj, že je v Supabase spuštěné <span class="mono">schema.sql</span>, nebo v Nastavení databázi odpoj.</p><a class="btn" href="#/nastaveni">Nastavení</a></div>`; }
    await render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').then(reg => {
        swReg = reg;
        const watch = (w) => { if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) showUpdateBar(); }); };
        reg.addEventListener('updatefound', () => { if (reg.active) watch(reg.installing); }); // při úplně prvním načtení lištu neukazovat
        // Nová verze se hledá při každém návratu do appky (mobil ji nechává běžet na pozadí).
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      }).catch(() => {});
    }
  })();
})();
