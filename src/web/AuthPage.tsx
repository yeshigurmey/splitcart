import { useState, type FormEvent } from "react";
import { api, type Me } from "./api";

type Mode = "signup" | "login";

export function AuthPage({ onDone }: { onDone: (me: Me) => void }) {
  const [mode, setMode] = useState<Mode>("signup");
  const [hasCode, setHasCode] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => String(form.get(name) ?? "");

    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        onDone(await api.login({ email: field("email"), password: field("password") }));
      } else {
        onDone(
          await api.signup({
            name: field("name"),
            email: field("email"),
            password: field("password"),
            ...(hasCode ? { buildingCode: field("buildingCode") } : { buildingName: field("buildingName") }),
          }),
        );
      }
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-pitch">
        <p className="brand">SplitCart</p>
        <h1>One delivery for the whole building. One fee, split.</h1>
        <p className="lede">
          A $5 delivery fee is a lot on a small order. Order together with the neighbours in your
          building and pay a fraction of it.
        </p>
      </div>

      <form className="card auth-form" onSubmit={submit}>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
            Sign up
          </button>
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
            Log in
          </button>
        </div>

        {mode === "signup" && (
          <label>
            Your name
            <input name="name" autoComplete="name" required maxLength={60} placeholder="What neighbours call you" />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <div className="field">
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
            />
          </label>
          {mode === "signup" && <p className="hint">At least 8 characters.</p>}
        </div>

        {mode === "signup" && (
          <fieldset>
            <legend>Your building</legend>
            <label className="choice">
              <input type="radio" checked={hasCode} onChange={() => setHasCode(true)} />
              A neighbour gave me a code
            </label>
            <label className="choice">
              <input type="radio" checked={!hasCode} onChange={() => setHasCode(false)} />
              I am the first one here
            </label>
            {hasCode ? (
              <label>
                Building code
                <input
                  name="buildingCode"
                  required
                  maxLength={6}
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="6 characters"
                  className="code-input"
                />
              </label>
            ) : (
              <div className="field">
                <label>
                  Building name or address
                  <input name="buildingName" required maxLength={80} placeholder="182 Maple Ave" />
                </label>
                <p className="hint">You will get a code to share with your neighbours.</p>
              </div>
            )}
          </fieldset>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "One moment…" : mode === "signup" ? "Create my account" : "Log in"}
        </button>
      </form>
    </div>
  );
}
