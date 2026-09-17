import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Přihlášení – Zápisník" },
      {
        name: "description",
        content:
          "Přihlaste se do Zápisníku a mějte své nahrávky, přepisy i AI shrnutí ve všech zařízeních.",
      },
      { property: "og:title", content: "Přihlášení – Zápisník" },
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
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        console.error("Google sign-in error:", result.error);
        const { title, hint } = googleError(result.error);
        toast.error(title, { description: hint, duration: 12000 });
        return;
      }
      if (result.redirected) return;
      void navigate({ to: "/" });
    } catch (err) {
      console.error("Google sign-in threw:", err);
      const { title, hint } = googleError(err);
      toast.error(title, { description: hint, duration: 12000 });
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-5 py-12">
      <Card className="w-full max-w-sm border-border/70 p-6">
        <h1 className="font-display text-2xl text-foreground">
          {mode === "in" ? "Přihlášení" : "Vytvořit účet"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Nahrávky, přepisy i shrnutí se pak samy synchronizují mezi vašimi zařízeními.
        </p>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Heslo</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={6}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Zapamatovat si mě a zůstat přihlášen
          </label>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {mode === "in" ? "Přihlásit se" : "Zaregistrovat se"}
          </Button>
        </form>

        <Button
          variant="outline"
          className="mt-3 w-full"
          disabled={busy}
          onClick={() => void google()}
        >
          Pokračovat s Google
        </Button>


        <Button
          type="button"
          variant="link"
          className="mt-3 h-11 w-full text-muted-foreground"
          onClick={() => setMode(mode === "in" ? "up" : "in")}
        >
          {mode === "in" ? "Nemáte účet? Zaregistrujte se" : "Už máte účet? Přihlaste se"}
        </Button>

        <Link to="/" className="mt-4 block text-center text-xs text-muted-foreground">
          Zpět do aplikace
        </Link>
      </Card>
    </div>
  );
}
