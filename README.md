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
- **Objednávky** – kancl zadá objednávku na PC (s určením skladu a fakturačními údaji odběratele; má-li produkt na skladě víc šarží, vybere se u řádku **trvanlivost**, ze které se vydá – jinak se vydává automaticky nejkratší), skladník ji vychystá skenem na mobilu (u položky vidí, kterou trvanlivost vzít); po „Ukončeno – připraveno“ vznikne štítek na paletu a **faktura** (číslo FA-CZ-… / FA-SK-…, ceny bez DPH z karty produktu, DPH, splatnost; údaje dodavatele v Nastavení → Fakturace).
- **Produkty** – kód (EAN/čárový kód), název, jednotka, kategorie, minimální zásoba, umístění, dodavatel, cena v Kč a v €, DPH; hledání, filtr, import/export CSV (stavy CZ/SK).
- **Příjem / Výdej** – skenování kamerou, po načtení kódu zadání množství (např. 150 ks), rozpracovaný doklad přežije zavření appky, kontrola nedostatku zásob, číslované doklady.
- **Kartony / balení** – produkt může mít další čárové kódy s počtem kusů (karton 12 ks, karton 6 ks…). Sken kartonu při příjmu, výdeji, inventuře i vychystávání přičte celé balení (zadá se počet kartonů). Neznámý kód jde při skenu rovnou uložit jako karton existujícího produktu.
- **Etikety GS1-128 (kartony, palety)** – kamera i externí čtečka přečtou dlouhé kódy typu `(01)…(15)…(10)…`. Zboží se najde podle GTIN (kód kartonu / EAN), trvanlivost (15/17), datum výroby (11), šarže (10), čistá váha (310x) a počet balení na paletě (37) se doplní samy. Při příjmu se karton nebo celá paleta přidá bez psaní, u váženého zboží se váha z etikety předvyplní při vychystávání.
- **Externí čtečka** – USB/Bluetooth čtečka v režimu klávesnice funguje kdekoli v aplikaci (včetně oddělovače GS / FNC1 a čísel z české klávesnice). Test v Nastavení → Čtečka čárových kódů.
- **Škody** – skladník v mobilu naskenuje rozbitý karton nebo rozbitý / shnilý / prošlý kus, vybere důvod, počet kartonů nebo kusů, šarži, může přidat fotku a poznámku. Zboží se hned odepíše ze skladu dokladem `S-CZ-…` / `S-SK-…`. Poškozené zboží z dodávky jde zapsat přímo v Příjmu (odepíše se po uložení příjmu s odkazem na příjemku – podklad k reklamaci). Kancl na PC vidí přehled škod (období, sklad, důvod, hodnota bez DPH, export CSV).
- **Inventura** – zvlášť pro sklad CZ a SK: skenování v regálech (+1 za sken nebo zadání množství), porovnání s evidencí, uzavření srovná stavy jen ve vybraném skladu.
- **Historie** – všechny doklady s položkami (stav před / změna / po), export CSV.
- **Přehled** – počty, produkty pod minimem, vyprodané, hodnota zásob, poslední pohyby.
- **Záloha** – export/import JSON pro přenos mezi zařízeními.

## Struktura

- `index.html`, `styles.css` – rozložení a vzhled (mobil: spodní lišta, PC: boční menu)
- `app.js` – logika obrazovek, skener, doklady
- `db.js` – vrstva nad IndexedDB
- `sw.js`, `manifest.json` – offline PWA
- `gs1.js` – rozbor etiket GS1 (aplikační identifikátory)
- `vendor/zxing-reader.js`, `vendor/zxing_reader.wasm` – dekodér čárových kódů ZXing-C++ (zxing-wasm 2.2.4, licence MIT/Apache-2.0)
- `vendor/html5-qrcode.min.js` – záložní dekodér pro staré prohlížeče
