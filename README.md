# Chat Scribe

Webová aplikace (PWA) na nahrávání rozhovorů až do 2 hodin s AI přepisem, korekturou, shrnutím a překladem.

- **Frontend a server:** TanStack Start (React 19, Vite, Tailwind), běží na Cloudflare Workers
- **Databáze, přihlášení, úložiště zvuku:** Supabase
- **AI:** Google Gemini API, bezplatná úroveň (přepis i text `gemini-3.8-flash`, záložní model pro překlad `gemini-3.5-flash-lite`)

## Lokální vývoj

```sh
npm install
cp .env.example .env   # doplňte hodnoty
npm run dev            # http://localhost:8080
npm test
```

## Proměnné prostředí

| Proměnná | Kde | Popis |
| --- | --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | build | Veřejné údaje Supabase pro prohlížeč |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | server | Totéž pro serverové vykreslování |
| `GEMINI_API_KEY` | server (tajné) | Klíč z [Google AI Studio](https://aistudio.google.com/apikey), nikdy s předponou `VITE_` |
| `GEMINI_TEXT_MODEL`, `GEMINI_FALLBACK_MODEL`, `GEMINI_TRANSCRIBE_MODEL` | server, volitelné | Změna modelů |

> Bezplatná úroveň Gemini má limity požadavků a Google na ní může obsah používat ke zlepšování svých produktů. Placená úroveň (zapnutí fakturace v AI Studiu) to nedělá.

## Nastavení Supabase (jednou)

1. Založte projekt na [supabase.com](https://supabase.com).
2. **SQL Editor:** vložte celý soubor [`supabase/setup.sql`](supabase/setup.sql) a spusťte ho. Vytvoří tabulky, oprávnění a bucket na zvuk.
3. **Authentication → URL Configuration:** jako *Site URL* nastavte adresu aplikace na Cloudflare a do *Redirect URLs* přidejte i `http://localhost:8080`.
4. **Přihlášení přes Google:** v [Google Cloud Console](https://console.cloud.google.com/apis/credentials) vytvořte *OAuth client ID* (typ Web application) s *Authorized redirect URI* `https://<projekt>.supabase.co/auth/v1/callback`. Client ID a Secret vložte do Supabase → Authentication → Providers → Google.

## Nasazení na Cloudflare

Napojte repozitář v Cloudflare → Workers & Pages → Create → Import a repository.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Veřejné údaje Supabase jsou v repozitáři (`.env.production`, `vars` v `wrangler.jsonc`).
- Jediný tajný klíč: `GEMINI_API_KEY` – Worker → Settings → Variables and Secrets → typ *Secret*.

Ruční nasazení z počítače: `npx wrangler login` a pak `npm run deploy`.
