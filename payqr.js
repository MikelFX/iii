/* QR platba na fakturách:
 *  - CZ: „QR Platba“ (formát SPD 1.0 České bankovní asociace) – čtou ji všechny české bankovní aplikace.
 *  - SK: „PAY by square“ (Slovenská banková asociácia) – čtou ho všechny slovenské bankovní aplikace.
 * Vše běží offline (vendor/qrcode-generator.js, vendor/bysquare.min.js). */
(function () {
  'use strict';
  const deburr = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const compact = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

  /** Kontrola IBAN (mod 97). */
  function ibanValid(iban) {
    const s = compact(iban);
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
    if (s.startsWith('CZ') && s.length !== 24) return false;
    if (s.startsWith('SK') && s.length !== 24) return false;
    const r = s.slice(4) + s.slice(0, 4);
    let m = 0;
    for (const ch of r) { const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55); for (const d of v) m = (m * 10 + Number(d)) % 97; }
    return m === 1;
  }
  /** Tuzemské číslo účtu „předčíslí-číslo/kód banky“ (CZ i SK mají stejný tvar) → IBAN. */
  function domesticToIban(acc, country) {
    const m = String(acc || '').replace(/\s+/g, '').match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
    if (!m) return null;
    const bban = m[3] + (m[1] || '').padStart(6, '0') + m[2].padStart(10, '0');
    const num = bban + String(country.charCodeAt(0) - 55) + String(country.charCodeAt(1) - 55) + '00';
    let r = 0; for (const d of num) r = (r * 10 + Number(d)) % 97;
    return country + String(98 - r).padStart(2, '0') + bban;
  }
  /** IBAN z nastavení: pole IBAN, jinak z pole „Bankovní účet“ (IBAN nebo tuzemský tvar 123456789/0800). */
  function resolveIban(cfg, wh) {
    for (const src of [cfg.iban, cfg.bank]) {
      if (!src) continue;
      const c = compact(src);
      if (/^[A-Z]{2}\d{2}/.test(c)) return c;
      const d = domesticToIban(src, wh === 'SK' ? 'SK' : 'CZ');
      if (d) return d;
    }
    return '';
  }
  const fmtIban = (iban) => compact(iban).replace(/(.{4})/g, '$1 ').trim();
  const amountStr = (n) => (Math.round(n * 100) / 100).toFixed(2);

  /** QR Platba (SPD 1.0). Hodnoty nesmí obsahovat „*“; zprávu bez diakritiky kvůli starším aplikacím. */
  function spd({ iban, bic, amount, currency, vs, due, msg, name }) {
    const clean = (s, max) => deburr(s).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const parts = ['SPD', '1.0', 'ACC:' + compact(iban) + (bic ? '+' + compact(bic) : ''), 'AM:' + amountStr(amount), 'CC:' + currency];
    if (due) parts.push('DT:' + due.replace(/-/g, ''));
    if (vs) parts.push('X-VS:' + String(vs).slice(0, 10));
    if (name) parts.push('RN:' + clean(name, 35));
    if (msg) parts.push('MSG:' + clean(msg, 60));
    return parts.join('*');
  }
  /** PAY by square 1.2.0 (LZMA + CRC32 + base32hex, ověřená knihovna bysquare). */
  function bySquare({ iban, bic, amount, currency, vs, due, msg, name, invoiceId }) {
    return BySquare.encode({
      invoiceId: invoiceId || undefined,
      payments: [{
        type: BySquare.PaymentOptions.PaymentOrder,
        amount: Math.round(amount * 100) / 100,
        currencyCode: currency,
        paymentDueDate: due ? due.replace(/-/g, '') : undefined,
        variableSymbol: vs ? String(vs).slice(0, 10) : undefined,
        paymentNote: msg ? deburr(msg).slice(0, 140) : undefined,
        bankAccounts: [{ iban: compact(iban), bic: bic ? compact(bic) : undefined }],
        beneficiary: { name: deburr(name || '').slice(0, 70) || 'Prijemca' },
      }],
    }, { validate: false });
  }
  /** SVG kód QR. Alfanumerický režim pro PAY by square (base32hex), jinak UTF-8 bajty. Oprava chyb M (doporučení obou standardů). */
  function svg(text, alphanumeric) {
    const q = qrcode(0, 'M');
    if (alphanumeric) q.addData(text, 'Alphanumeric');
    else { qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']; q.addData(text, 'Byte'); }
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true, alt: 'QR platba' });
  }
  /**
   * Vrátí { kind: 'spd'|'bysquare', label, payload, svg, iban } nebo { error }.
   * SK sklad → PAY by square (slovenské banky), ostatní → QR Platba (české banky).
   */
  function build(p) {
    const iban = compact(p.iban);
    if (!iban) return { error: 'Chybí IBAN – doplň ho v Nastavení → Fakturace.' };
    if (!ibanValid(iban)) return { error: `IBAN ${fmtIban(iban)} není platný – zkontroluj ho v Nastavení → Fakturace.` };
    if (!(p.amount > 0)) return { error: 'Faktura nemá částku k úhradě.' };
    try {
      if (p.wh === 'SK') { const payload = bySquare(p); return { kind: 'bysquare', label: 'PAY by square', payload, svg: svg(payload, true), iban }; }
      const payload = spd(p); return { kind: 'spd', label: 'QR Platba', payload, svg: svg(payload, false), iban };
    } catch (e) { return { error: 'QR kód se nepodařilo vytvořit: ' + (e && e.message || e) }; }
  }
  window.PayQR = { build, resolveIban, ibanValid, domesticToIban, fmtIban, spd };
})();
