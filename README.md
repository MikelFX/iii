# IMCO Sklad

Skladový systém se čtečkou čárových kódů. Jedna aplikace pro mobil i počítač (PWA), bez serveru – data jsou uložena v prohlížeči (IndexedDB), funguje offline.

## Spuštění

Stačí jakýkoli statický webserver (kamera v prohlížeči vyžaduje HTTPS nebo `localhost`):

```bash
cd sklad
python3 -m http.server 8080      # nebo: npx serve .
# otevři http://localhost:8080
```

Pro mobil: nahrát složku na libovolný HTTPS hosting (GitHub Pages, Netlify, Cloudflare Pages…) a v prohlížeči „Přidat na plochu“.

## Funkce

- **Produkty** – kód (EAN/čárový kód), název, jednotka, kategorie, minimální zásoba, umístění, dodavatel, cena; hledání, filtr, import/export CSV.
- **Příjem / Výdej** – skenování kamerou, po načtení kódu zadání množství (např. 150 ks), rozpracovaný doklad přežije zavření appky, kontrola nedostatku zásob, číslované doklady.
- **Inventura** – skenování v regálech (+1 za sken nebo zadání množství), porovnání s evidencí, uzavření srovná stavy.
- **Historie** – všechny doklady s položkami (stav před / změna / po), export CSV.
- **Přehled** – počty, produkty pod minimem, vyprodané, hodnota zásob, poslední pohyby.
- **Záloha** – export/import JSON pro přenos mezi zařízeními.

## Struktura

- `index.html`, `styles.css` – rozložení a vzhled (mobil: spodní lišta, PC: boční menu)
- `app.js` – logika obrazovek, skener, doklady
- `db.js` – vrstva nad IndexedDB
- `sw.js`, `manifest.json` – offline PWA
- `vendor/html5-qrcode.min.js` – dekodér čárových kódů (kamera)
