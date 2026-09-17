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

  const google = async () => {
    if (busy) return;
    setBusy(true);
    try {
      saveRemember();
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        const msg = result.error.message || "";
        console.error("Google sign-in error:", result.error);
        if (/popup|blocked|window/i.test(msg)) {
          toast.error(
            "Okno Google se nepodařilo otevřít – povolte vyskakovací okna, nebo aplikaci otevřete v samostatné záložce.",
          );
        } else if (/not supported|not enabled|provider/i.test(msg)) {
          toast.error("Přihlášení přes Google zatím není zapnuté. Zkuste e-mail a heslo.");
        } else {
          toast.error(`Přihlášení přes Google se nepodařilo: ${msg || "neznámá chyba"}`);
        }
        return;
      }
      if (result.redirected) return;
      void navigate({ to: "/" });
    } catch (err) {
      console.error("Google sign-in threw:", err);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(
        /popup|blocked|closed/i.test(msg)
          ? "Okno Google se zavřelo dřív, než přihlášení skončilo. Zkuste to prosím znovu."
          : `Přihlášení přes Google se nepodařilo: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };


  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
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


        <button
          type="button"
          className="mt-5 w-full text-sm text-muted-foreground underline"
          onClick={() => setMode(mode === "in" ? "up" : "in")}
        >
          {mode === "in" ? "Nemáte účet? Zaregistrujte se" : "Už máte účet? Přihlaste se"}
        </button>

        <Link to="/" className="mt-4 block text-center text-xs text-muted-foreground">
          Zpět do aplikace
        </Link>
      </Card>
    </main>
  );
}
