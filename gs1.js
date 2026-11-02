/* IMCO Sklad – čtení etiket GS1-128 / GS1 DataMatrix / GS1 QR (kartony a palety).
 * Rozpozná aplikační identifikátory (AI): (00) SSCC palety, (01)/(02) GTIN, (10) šarže, (11) datum výroby,
 * (15)/(17) trvanlivost, (37) počet kusů, (310n) čistá hmotnost v kg a další běžné.
 * Vstup může být ve tvaru „(01)0123…(15)…“, se znakem GS (FNC1), se symbologií „]C1“, nebo jen holá čísla
 * bez oddělovačů (některé čtečky FNC1 nepošlou) – pak se proměnná pole dopočítají zpětným hledáním. */
(function (root) {
  'use strict';
  const GS = '\x1D';

  // Pevná délka dat (bez AI). Nepřítomné = proměnná délka (max).
  const FIXED = { '00': 18, '01': 14, '02': 14, '03': 14, '04': 16, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
  const VAR_MAX = { '10': 20, '21': 20, '22': 20, '30': 8, '37': 8, '90': 30, '91': 90, '92': 90, '93': 90, '94': 90, '95': 90, '96': 90, '97': 90, '98': 90, '99': 90,
    '240': 30, '241': 30, '242': 6, '250': 30, '251': 30, '253': 30, '254': 20, '400': 30, '401': 30, '402': 17, '403': 30, '420': 20, '421': 12, '422': 3, '423': 15, '424': 3, '425': 15, '426': 3,
    '7001': 13, '7002': 30, '7003': 10, '7004': 4, '8001': 14, '8002': 20, '8003': 30, '8004': 30, '8005': 6, '8006': 18, '8007': 34, '8008': 12, '8020': 25, '8200': 70 };
  const NUMERIC = new Set(['00', '01', '02', '03', '04', '11', '12', '13', '15', '16', '17', '20', '30', '37', '242', '402', '421', '422', '424', '426', '7001', '7003', '7004', '8001', '8005', '8006', '8008']);
  const DATE_AIS = new Set(['11', '12', '13', '15', '16', '17']);
  const GTIN_AIS = new Set(['01', '02', '03']);

  /** Délka AI a délka dat na pozici i (null = neznámý AI). */
  function aiAt(s, i) {
    const two = s.substr(i, 2);
    if (!/^\d\d$/.test(two)) return null;
    if (FIXED[two]) return { ai: two, fixed: FIXED[two] };
    if (VAR_MAX[two]) return { ai: two, max: VAR_MAX[two] };
    const three = s.substr(i, 3), four = s.substr(i, 4);
    const t = Number(two);
    if (t >= 31 && t <= 36 && /^\d{4}$/.test(four)) return { ai: four, fixed: 6 };           // 310n–369n míry (váha, délka…)
    if (two === '41' && /^41[0-7]$/.test(three)) return { ai: three, fixed: 13 };          // 410–417 GLN
    if (VAR_MAX[three]) return { ai: three, max: VAR_MAX[three] };
    if (VAR_MAX[four]) return { ai: four, max: VAR_MAX[four] };
    return null;
  }

  function checkDigit(body) { // body bez kontrolní číslice
    let sum = 0;
    for (let i = 0; i < body.length; i++) { const d = Number(body[body.length - 1 - i]); sum += i % 2 === 0 ? d * 3 : d; }
    return String((10 - (sum % 10)) % 10);
  }
  const validCheck = (num) => /^\d{8,18}$/.test(num) && checkDigit(num.slice(0, -1)) === num.slice(-1);

  function validValue(ai, v) {
    if (!v.length) return false;
    if ((NUMERIC.has(ai) || /^3[1-6]\d\d$/.test(ai) || /^41[0-7]$/.test(ai)) && !/^\d+$/.test(v)) return false;
    if (DATE_AIS.has(ai)) { const m = Number(v.substr(2, 2)), d = Number(v.substr(4, 2)); if (m < 1 || m > 12 || d > 31) return false; }
    if (GTIN_AIS.has(ai) && !validCheck(v)) return false;
    if (ai === '00' && !validCheck(v)) return false;
    return /^[\x21-\x7E]+$/.test(v); // GS1 povoluje jen tisknutelné ASCII bez mezer
  }

  /** Rozdělí řetězec bez závorek na [[ai, hodnota], …]. GS ukončuje proměnné pole; bez GS se zkouší délky odzadu. */
  function parseRaw(s, i = 0, depth = 0) {
    if (i >= s.length) return [];
    if (s[i] === GS) return parseRaw(s, i + 1, depth);
    if (depth > 40) return null;
    const a = aiAt(s, i); if (!a) return null;
    const start = i + a.ai.length;
    if (a.fixed) {
      const v = s.substr(start, a.fixed);
      if (v.length !== a.fixed || !validValue(a.ai, v)) return null;
      const rest = parseRaw(s, start + a.fixed, depth + 1);
      return rest ? [[a.ai, v], ...rest] : null;
    }
    const gs = s.indexOf(GS, start);
    if (gs !== -1) {
      const v = s.slice(start, gs);
      if (v.length > a.max || !validValue(a.ai, v)) return null;
      const rest = parseRaw(s, gs + 1, depth + 1);
      return rest ? [[a.ai, v], ...rest] : null;
    }
    // Bez oddělovače: nejdelší hodnota, za kterou zbytek dává smysl (nebo nic nezbývá).
    for (let len = Math.min(a.max, s.length - start); len >= 1; len--) {
      const v = s.substr(start, len);
      if (!validValue(a.ai, v)) continue;
      if (start + len === s.length) return [[a.ai, v]];
      const rest = parseRaw(s, start + len, depth + 1);
      if (rest && rest.length) return [[a.ai, v], ...rest];
    }
    return null;
  }

  function parseParens(s) {
    const re = /\((\d{2,4})\)([^()]*)/g; const out = []; let m, pos = 0;
    while ((m = re.exec(s))) {
      if (s.slice(pos, m.index).trim()) return null;
      const v = m[2].replace(/\s+$/, '').replace(new RegExp(GS, 'g'), '');
      if (!validValue(m[1], v.replace(/^\s+/, ''))) return null;
      out.push([m[1], v.replace(/^\s+/, '')]); pos = re.lastIndex;
    }
    return out.length && !s.slice(pos).trim() ? out : null;
  }

  /** YYMMDD → YYYY-MM-DD (DD 00 = poslední den měsíce). */
  function toDate(v) {
    const yy = Number(v.substr(0, 2)), mm = Number(v.substr(2, 2)); let dd = Number(v.substr(4, 2));
    const y = (yy >= 51 ? 1900 : 2000) + yy;
    if (dd === 0) dd = new Date(Date.UTC(y, mm, 0)).getUTCDate();
    return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  /** Převede čtený text na GS1 objekt, nebo vrátí null, když to GS1 etiketa není (obyčejné EAN apod.). */
  function parse(input) {
    if (input == null) return null;
    let s = String(input).replace(/\r|\n/g, '').trim();
    s = s.replace(/<GS>|\{GS\}|␝|\u001D/gi, GS); // různé zápisy oddělovače
    let forced = false;
    const sym = s.match(/^\][A-Za-z]\d/);
    if (sym) { forced = /^\](C1|e0|d2|Q3|J1)$/.test(sym[0]); s = s.slice(3); if (!forced) return null; }
    if (s[0] === GS) { forced = true; s = s.slice(1); } // FNC1 na začátku
    let pairs = null;
    if (s.startsWith('(')) pairs = parseParens(s);
    else {
      const compact = s.replace(/ /g, '');
      if (!forced && !compact.includes(GS)) {
        // Holá čísla: bereme jako GS1 jen když to jednoznačně vypadá na etiketu kartonu/palety.
        if (compact.length < 16) return null;
        if (!(/^0[0-3]/.test(compact))) return null;
      }
      pairs = parseRaw(compact);
    }
    if (!pairs || !pairs.length) return null;
    const ais = {}; pairs.forEach(([a, v]) => { if (!(a in ais)) ais[a] = v; });
    const g = { ais, hri: pairs.map(([a, v]) => `(${a})${v}`).join('') };
    if (ais['01']) g.gtin = ais['01'];
    if (ais['02']) { g.contentGtin = ais['02']; if (!g.gtin) g.gtin = ais['02']; }
    if (ais['00']) g.sscc = ais['00'];
    if (ais['10']) g.lot = ais['10'];
    if (ais['21']) g.serial = ais['21'];
    if (ais['11']) g.prodDate = toDate(ais['11']);
    if (ais['13']) g.packDate = toDate(ais['13']);
    if (ais['15']) g.bestBefore = toDate(ais['15']);
    if (ais['16']) g.sellBy = toDate(ais['16']);
    if (ais['17']) g.expiry = toDate(ais['17']);
    g.useBy = g.expiry || g.bestBefore || g.sellBy || null;
    if (ais['37']) g.count = Number(ais['37']);
    const kgAi = Object.keys(ais).find(a => /^310[0-5]$/.test(a));
    if (kgAi) g.netKg = Number(ais[kgAi]) / Math.pow(10, Number(kgAi[3]));
    const grossAi = Object.keys(ais).find(a => /^330[0-5]$/.test(a));
    if (grossAi) g.grossKg = Number(ais[grossAi]) / Math.pow(10, Number(grossAi[3]));
    return g;
  }

  /** Kódy, pod kterými může být produkt uložen: GTIN-14, GTIN-13 (EAN), GTIN-12 (UPC), GTIN-8 a EAN odvozený
   *  ze GTIN-14 bez indikátoru balení (např. 73176580996012 → 3176580996012). */
  function candidates(gtin) {
    if (!gtin) return [];
    const g = String(gtin); const out = [{ code: g, derived: false }];
    if (/^0/.test(g)) out.push({ code: g.slice(1), derived: false });
    if (/^00/.test(g)) out.push({ code: g.slice(2), derived: false });
    if (/^000000/.test(g)) out.push({ code: g.slice(6), derived: false });
    if (/^[1-9]/.test(g) && g.length === 14) { const body = g.slice(1, 13); out.push({ code: body + checkDigit(body), derived: true }); }
    return out;
  }

  /** Kód pro uložení k produktu: z GS1 etikety GTIN, jinak text beze změny. */
  function keyOf(code) { const g = parse(code); return g && g.gtin ? g.gtin : String(code ?? '').trim(); }

  const api = { parse, candidates, keyOf, checkDigit, validCheck, GS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GS1 = api;
})(typeof window !== 'undefined' ? window : globalThis);
