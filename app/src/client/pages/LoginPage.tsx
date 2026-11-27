import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { login } from "wasp/client/auth";
import { Button, Input, Label, Notice } from "../ui";

const DEMO = [
  { username: "priya", who: "Resident, Maple Court 4B" },
  { username: "morgan", who: "Property manager, Maple Court" },
  { username: "sam", who: "Contractor, Northside Plumbing" },
  { username: "ana", who: "Contractor, BrightSpark Appliance" },
];

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ username: username.trim().toLowerCase(), password });
      navigate("/", { replace: true });
    } catch {
      setError("That username and password do not match an account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_32rem]">
      <section className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <p className="text-xl font-bold tracking-tight">Relay</p>
        <div className="max-w-lg">
          <p className="text-3xl leading-tight font-semibold tracking-tight">Every repair has a status, an owner and a next step.</p>
          <p className="mt-4 text-white/70">Residents report problems in their own words. Relay files them, finds the right vendor, keeps approvals and visits on track, and follows up until the resident confirms the fix.</p>
        </div>
        <p className="text-sm text-white/50">Local demo build. All people, properties and vendors are fictional.</p>
      </section>
      <section className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <p className="mb-8 text-xl font-bold tracking-tight lg:hidden">Relay</p>
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Accounts are created by your property. There is no self sign-up.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="username">Username</Label>
            <Input id="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          <Button type="submit" size="lg" className="w-full" busy={busy}>
            Sign in
          </Button>
        </form>
        <div className="mt-10 rounded-lg border border-line bg-surface p-4">
          <p className="text-sm font-medium">Demo accounts</p>
          <p className="mt-0.5 text-xs text-muted">
            Password for all: <code className="rounded bg-sunk px-1">relay-demo-2026</code>
          </p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {DEMO.map((d) => (
              <li key={d.username}>
                <button type="button" className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-ink-2" onClick={() => (setUsername(d.username), setPassword("relay-demo-2026"))}>
                  <span className="font-medium">{d.username}</span>
                  <span className="text-xs text-muted">{d.who}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
