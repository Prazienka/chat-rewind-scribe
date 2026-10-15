# Chat Scribe – poznámky pro vývoj

- Hosting: Cloudflare Workers (`wrangler.jsonc`, build přes Nitro – `nitro.config.ts`).
- Backend: vlastní Supabase projekt; schéma je v `supabase/migrations`, souhrnně v `supabase/setup.sql`.
- AI: Google Gemini API (`src/lib/gemini.ts`), bezplatná úroveň. Klíč `GEMINI_API_KEY` jen na serveru.
- Před pushem: `npm test` a `npm run build`.
