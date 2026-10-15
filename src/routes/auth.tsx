import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AudioLines, ChevronLeft, Loader2 } from "lucide-react";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Přihlášení – Chat Scribe" },
      {
        name: "description",
        content:
          "Přihlaste se do Chat Scribe a mějte své nahrávky, přepisy i AI shrnutí ve všech zařízeních.",
      },
      { property: "og:title", content: "Přihlášení – Chat Scribe" },
      {
        property: "og:description",
        content: "Nahrávky a přepisy dostupné na všech vašich zařízeních.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

const REMEMBER_KEY = "zapisnik.remember";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  const saveRemember = () => {
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? "1" : "0");
      sessionStorage.setItem("zapisnik.session-alive", "1");
    } catch {
      /* ignore */
    }
  };


  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          toast.error("Přihlášení se nepodařilo. Zkontrolujte e-mail a heslo.");
          return;
        }
        saveRemember();
        void navigate({ to: "/" });
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) {
          toast.error(
            error.message.includes("already")
              ? "Tento e-mail už je zaregistrovaný – přihlaste se."
              : "Registrace se nepodařila.",
          );
          return;
        }
        if (data.session) {
          saveRemember();
          void navigate({ to: "/" });
        } else {
          toast.success("Poslali jsme vám potvrzovací e-mail. Klikněte na odkaz a pak se přihlaste.");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const googleError = (err: unknown): { title: string; hint: string } => {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    const m = msg.toLowerCase();
    if (/popup|blocked|opener/i.test(m)) {
      return {
        title: "Vyskakovací okno se neotevřelo",
        hint: "Prohlížeč zablokoval okno Google. Povolte vyskakovací okna pro tuto stránku (ikona v adresním řádku) a zkuste to znovu – nebo aplikaci otevřete v samostatné záložce.",
      };
    }
    if (/closed|dismissed/i.test(m)) {
      return {
        title: "Přihlášení se nedokončilo",
        hint: "Okno Google se zavřelo dřív, než se přihlášení dokončilo. Zkuste to prosím znovu a okno během přihlašování nezavírejte.",
      };
    }
    if (/access_denied|denied|consent/i.test(m)) {
      return {
        title: "Přístup k účtu byl odepřen",
        hint: "Přihlášení přes Google jste zrušili, nebo jste neudělili souhlas. Zkuste to znovu a v okně Google přihlášení potvrďte.",
      };
    }
    if (/not supported|not enabled|not configured|unsupported|provider/i.test(m)) {
      return {
        title: "Přihlášení přes Google není k dispozici",
        hint: "Přihlašování přes Google právě nefunguje. Přihlaste se prosím e-mailem a heslem – pokud heslo nemáte, zaregistrujte se jím.",
      };
    }
    if (/redirect|invalid_client|unauthorized_client|invalid_request/i.test(m)) {
      return {
        title: "Google přihlášení je špatně nastavené",
        hint: "Přihlášení selhalo kvůli technickému nastavení. Zkuste se prosím přihlásit e-mailem a heslem a chybu nám dejte vědět – opravíme ji.",
      };
    }
    if (/network|fetch|timeout|timed out|failed to fetch|load failed/i.test(m)) {
      return {
        title: "Nepodařilo se spojit s Google",
        hint: "Zkontrolujte připojení k internetu a zkuste to znovu. Případně se přihlaste e-mailem a heslem.",
      };
    }
    return {
      title: "Přihlášení přes Google se nepodařilo",
      hint: msg
        ? `Důvod: ${msg}. Zkuste to znovu, nebo se přihlaste e-mailem a heslem.`
        : "Zkuste to prosím znovu, nebo se přihlaste e-mailem a heslem.",
    };
  };

  const google = async () => {
    if (busy) return;
    setBusy(true);
    try {
      saveRemember();
      // Přihlášení přes Google přímo v Supabase: prohlížeč odejde na Google
      // a po potvrzení se vrátí na úvodní stránku už přihlášený.
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) {
        console.error("Google sign-in error:", error);
        const { title, hint } = googleError(error);
        toast.error(title, { description: hint, duration: 12000 });
        return;
      }
    } catch (err) {
      console.error("Google sign-in threw:", err);
      const { title, hint } = googleError(err);
      toast.error(title, { description: hint, duration: 12000 });
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="min-h-dvh bg-background px-4 pb-12 pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="mx-auto w-full max-w-sm">
        <Link to="/" className="press -ml-2 inline-flex h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-[1.0625rem] text-primary">
          <ChevronLeft className="size-6" aria-hidden="true" /> Zpět
        </Link>

        <div className="mt-6 flex flex-col items-center text-center">
          <span className="grid size-16 place-items-center rounded-[1.125rem] bg-record text-white shadow-[0_8px_24px_-8px_var(--record)]">
            <AudioLines className="size-8" aria-hidden="true" />
          </span>
          <h1 className="large-title mt-5 text-foreground">{mode === "in" ? "Přihlášení" : "Nový účet"}</h1>
          <p className="footnote mt-2 max-w-xs text-[0.9375rem]">
            Nahrávky, přepisy i shrnutí se pak samy synchronizují mezi vašimi zařízeními.
          </p>
        </div>

        <button
          type="button"
          className="press mt-8 flex h-12 w-full items-center justify-center gap-2.5 rounded-[0.875rem] bg-foreground text-[1.0625rem] font-semibold text-background disabled:opacity-40"
          disabled={busy}
          onClick={() => void google()}
        >
          <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
            <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.9-5.5 3.9-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.3 14.6 2.3 12 2.3 6.7 2.3 2.4 6.6 2.4 12s4.3 9.7 9.6 9.7c5.5 0 9.2-3.9 9.2-9.4 0-.6-.1-1.1-.2-1.6H12z" />
          </svg>
          Pokračovat s Googlem
        </button>

        <div className="my-6 flex items-center gap-3 footnote">
          <span className="h-px flex-1 bg-separator" />
          nebo e-mailem
          <span className="h-px flex-1 bg-separator" />
        </div>

        <form onSubmit={submit}>
          <div className="grouped">
            <label className="grouped-row flex min-h-11 items-center gap-3 px-4">
              <span className="w-16 shrink-0 text-[1.0625rem] text-foreground">E-mail</span>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="jmeno@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 min-w-0 flex-1 bg-transparent text-[1.0625rem] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <label className="grouped-row flex min-h-11 items-center gap-3 px-4">
              <span className="w-16 shrink-0 text-[1.0625rem] text-foreground">Heslo</span>
              <input
                id="password"
                type="password"
                required
                minLength={6}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                placeholder={mode === "in" ? "Vaše heslo" : "Alespoň 6 znaků"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 min-w-0 flex-1 bg-transparent text-[1.0625rem] text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <label className="grouped-row flex min-h-11 items-center justify-between gap-3 px-4">
              <span className="text-[1.0625rem] text-foreground">Zůstat přihlášen</span>
              <input
                type="checkbox"
                role="switch"
                className="peer sr-only"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span
                aria-hidden="true"
                className="relative h-[1.9375rem] w-[3.1875rem] shrink-0 rounded-full bg-fill transition-colors duration-200 peer-checked:bg-success peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring after:absolute after:left-[2px] after:top-[2px] after:size-[1.6875rem] after:rounded-full after:bg-white after:shadow-[0_3px_8px_rgb(0_0_0/0.15),0_1px_1px_rgb(0_0_0/0.16)] after:transition-transform after:duration-200 after:ease-[var(--ease-ios)] peer-checked:after:translate-x-[1.25rem]"
              />
            </label>
          </div>

          <button
            type="submit"
            className="press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-[0.875rem] bg-primary text-[1.0625rem] font-semibold text-primary-foreground disabled:opacity-40"
            disabled={busy}
          >
            {busy ? <Loader2 className="size-5 animate-spin" aria-hidden="true" /> : null}
            {mode === "in" ? "Přihlásit se" : "Vytvořit účet"}
          </button>
        </form>

        <button
          type="button"
          className="press mt-4 h-11 w-full rounded-full text-[0.9375rem] text-primary"
          onClick={() => setMode(mode === "in" ? "up" : "in")}
        >
          {mode === "in" ? "Nemáte účet? Zaregistrujte se" : "Už máte účet? Přihlaste se"}
        </button>
      </div>
    </div>
  );
}
