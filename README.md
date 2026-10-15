# Chat Scribe

Webová aplikace (PWA) na nahrávání rozhovorů až do 2 hodin s AI přepisem, korekturou, shrnutím a překladem.

- **Frontend a server:** TanStack Start (React 19, Vite, Tailwind), běží na Cloudflare Workers
- **Databáze, přihlášení, úložiště zvuku:** Supabase
- **AI:** OpenAI (přepis `gpt-4o-transcribe`, text `gpt-5-mini`, záložní model `gpt-4.1-mini`)

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
| `OPENAI_API_KEY` | server (tajné) | Klíč OpenAI, nikdy s předponou `VITE_` |
| `OPENAI_TEXT_MODEL`, `OPENAI_FALLBACK_MODEL`, `OPENAI_TRANSCRIBE_MODEL` | server, volitelné | Změna modelů |

## Nastavení Supabase (jednou)

1. Založte projekt na [supabase.com](https://supabase.com).
2. **SQL Editor:** vložte celý soubor [`supabase/setup.sql`](supabase/setup.sql) a spusťte ho. Vytvoří tabulky, oprávnění a bucket na zvuk.
3. **Authentication → URL Configuration:** jako *Site URL* nastavte adresu aplikace na Cloudflare a do *Redirect URLs* přidejte i `http://localhost:8080`.
4. **Přihlášení přes Google:** v [Google Cloud Console](https://console.cloud.google.com/apis/credentials) vytvořte *OAuth client ID* (typ Web application) s *Authorized redirect URI* `https://<projekt>.supabase.co/auth/v1/callback`. Client ID a Secret vložte do Supabase → Authentication → Providers → Google.

## Nasazení na Cloudflare

Napojte repozitář v Cloudflare → Workers & Pages → Create → Import a repository.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Proměnné pro build (Build variables): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`
- Proměnné a tajné klíče workeru (Settings → Variables and Secrets): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `OPENAI_API_KEY` (jako *Secret*)

Ruční nasazení z počítače: `npx wrangler login` a pak `npm run deploy`.
