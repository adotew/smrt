import { useEffect, useState } from "react";
import type { Account } from "../electron/assistant.ts";
import type { Theme } from "../electron/main.ts";
import { Button } from "$lib/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "$lib/components/ui/toggle-group";

const api = window.smrt;

export default function Settings() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setTheme(await api.readTheme());
      setAccount(await api.readAccount());
    })();
  }, []);

  async function signIn() {
    setSigningIn(true);
    setError("");
    try {
      await api.signIn();
      setAccount(await api.readAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, "") : String(e));
    }
    setSigningIn(false);
    setCode("");
  }

  return (
    <main className="flex flex-1 flex-col justify-center gap-5 px-8 text-(--foreground)">
      <div className="flex items-center justify-between gap-6">
        <span>Appearance</span>
        {theme && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={theme}
            onValueChange={(value) => {
              if (!value) return;
              setTheme(value as Theme);
              api.setTheme(value as Theme);
            }}
          >
            <ToggleGroupItem value="system">System</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      <div className="flex items-center justify-between gap-6">
        <span>Claude</span>
        {account?.loggedIn ? (
          <span className="truncate text-sm text-muted-foreground">
            {account.email}
            {account.subscriptionType ? ` · ${account.subscriptionType[0].toUpperCase()}${account.subscriptionType.slice(1)}` : ""}
          </span>
        ) : (
          account && (
            <Button size="sm" onClick={signIn} disabled={signingIn}>
              {signingIn ? "Waiting for Browser…" : "Sign In"}
            </Button>
          )
        )}
      </div>
      {signingIn ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            api.enterSignInCode(code);
          }}
        >
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Paste the code from your browser"
            className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!code.trim()}>
            Enter
          </Button>
        </form>
      ) : (
        error && <p className="m-0 text-sm text-destructive">{error}</p>
      )}
    </main>
  );
}
