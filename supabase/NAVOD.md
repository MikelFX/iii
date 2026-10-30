# Napojení na Supabase (společná databáze pro kancl a sklad)

1. **Projekt** – na https://supabase.com založ projekt (region Frankfurt). Z *Project Settings → API* si opiš **Project URL** a **anon public key**.
2. **Databáze** – *SQL Editor → New query*, vlož obsah `schema.sql` a spusť (Run).
3. **Uživatelé** – *Authentication → Users → Add user* založ účty (e-mail + heslo) pro kancl a skladníky. V *Authentication → Providers → Email* vypni „Confirm email“, ať nemusí potvrzovat.
4. **Aplikace** – v appce *Nastavení → Společná databáze (Supabase)* zadej URL a anon key, ulož, přihlas se.
5. **AI rozpoznání objednávek** (volitelné) – potřebuje klíč k Claude API (https://platform.claude.com):
   - nainstaluj Supabase CLI, `supabase login`, `supabase link --project-ref <ref>`
   - `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`
   - `supabase functions deploy parse-order`
   Bez toho appka použije jednoduché rozpoznání podle názvů přímo v zařízení (bez AI, bez fotky).

Zálohy: v Nastavení jde kdykoliv stáhnout JSON; při přechodu z lokálního režimu na Supabase appka nabídne nahrání stávajících dat.
