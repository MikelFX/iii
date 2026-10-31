# IMCO Sklad

Skladový systém se čtečkou čárových kódů. Jedna aplikace pro mobil i počítač (PWA), bez serveru – data jsou uložena v prohlížeči (IndexedDB), funguje offline.

## Spuštění

Aplikace běží na **https://mikelfx.github.io/iii/** (GitHub Pages, nasazuje se automaticky z větve `main`). Na mobilu otevři adresu v prohlížeči a zvol „Přidat na plochu“.

Lokálně:

Stačí jakýkoli statický webserver (kamera v prohlížeči vyžaduje HTTPS nebo `localhost`):

```bash
cd sklad
python3 -m http.server 8080      # nebo: npx serve .
# otevři http://localhost:8080
```

Pro mobil: nahrát složku na libovolný HTTPS hosting (GitHub Pages, Netlify, Cloudflare Pages…) a v prohlížeči „Přidat na plochu“.

## Funkce

- **Dva sklady – CZ a SK** – každý má vlastní stavy, šarže, inventuru i číselnou řadu dokladů. Sklad, ve kterém zařízení pracuje, se přepíná tlačítkem v horní liště. **Přesun CZ ⇄ SK** převede zboží (včetně dat výroby a trvanlivosti) a zapíše se do historie.
- **Objednávky** – kancl zadá objednávku na PC (s určením skladu a fakturačními údaji odběratele), skladník ji vychystá skenem na mobilu; po „Ukončeno – připraveno“ vznikne štítek na paletu a **faktura** (číslo FA-CZ-… / FA-SK-…, ceny bez DPH z karty produktu, DPH, splatnost; údaje dodavatele v Nastavení → Fakturace).
- **Produkty** – kód (EAN/čárový kód), název, jednotka, kategorie, minimální zásoba, umístění, dodavatel, cena v Kč a v €, DPH; hledání, filtr, import/export CSV (stavy CZ/SK).
- **Příjem / Výdej** – skenování kamerou, po načtení kódu zadání množství (např. 150 ks), rozpracovaný doklad přežije zavření appky, kontrola nedostatku zásob, číslované doklady.
- **Inventura** – zvlášť pro sklad CZ a SK: skenování v regálech (+1 za sken nebo zadání množství), porovnání s evidencí, uzavření srovná stavy jen ve vybraném skladu.
- **Historie** – všechny doklady s položkami (stav před / změna / po), export CSV.
- **Přehled** – počty, produkty pod minimem, vyprodané, hodnota zásob, poslední pohyby.
- **Záloha** – export/import JSON pro přenos mezi zařízeními.

## Struktura

- `index.html`, `styles.css` – rozložení a vzhled (mobil: spodní lišta, PC: boční menu)
- `app.js` – logika obrazovek, skener, doklady
- `db.js` – vrstva nad IndexedDB
- `sw.js`, `manifest.json` – offline PWA
- `vendor/html5-qrcode.min.js` – dekodér čárových kódů (kamera)
