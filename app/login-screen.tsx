"use client";

import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginScreen() {
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "magic">("password");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    const result = mode === "password"
      ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
      : await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin } });

    setBusy(false);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }
    if (mode === "magic") {
      setMessage("Check your email. The secure sign-in link will open Seller Manager.");
      return;
    }
    window.location.assign("/");
  }

  return (
    <main className="login-page">
      <div className="login-glow glow-one" />
      <div className="login-glow glow-two" />
      <section className="login-card">
        <div className="login-brand"><div className="brand-mark">FK</div><span>Seller Manager</span></div>
        <div className="login-copy"><span className="eyebrow">Private workspace</span><h1>Welcome back.</h1><p>Your marketplace command centre is ready when you are.</p></div>
        <div className="login-tabs" role="tablist">
          <button type="button" className={mode === "password" ? "login-tab active" : "login-tab"} onClick={() => { setMode("password"); setMessage(""); }}>Password</button>
          <button type="button" className={mode === "magic" ? "login-tab active" : "login-tab"} onClick={() => { setMode("magic"); setMessage(""); }}>Email link</button>
        </div>
        <form onSubmit={submit} className="login-form">
          <label><span>Email</span><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required /></label>
          {mode === "password" && <label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required /></label>}
          <button className="login-submit" disabled={busy}>{busy ? "Connecting…" : mode === "password" ? "Sign in" : "Send secure link"}{!busy && <span>↗</span>}</button>
        </form>
        {message && <div className={"login-message " + (message.includes("Check your email") ? "success" : "")}>{message}</div>}
        <div className="login-foot"><span>Protected by Supabase Auth</span><span>•</span><span>Seller workspace</span></div>
      </section>
    </main>
  );
}
