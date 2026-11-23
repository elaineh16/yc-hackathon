// The frame around every signed-in page: navigation for the role, notifications, email preferences, a role guard.
import { Bell, Building2, ClipboardList, Gauge, Inbox, LogOut, Mail, Settings, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { logout } from "wasp/client/auth";
import { acknowledgeNotification, getMe, getNotifications, markNotificationsRead, updateMyNotifications, useQuery } from "wasp/client/operations";
import type { Role } from "../../shared/domain";
import type { Me } from "../../shared/views";
import { useAction, when } from "../lib";
import { Badge, Button, cn, Dialog, DialogContent, Hint, Input, Label, Notice, Spinner } from "../ui";

const HOME: Record<Role, string> = { RESIDENT: "/my", MANAGER: "/ops", CONTRACTOR: "/jobs" };
export const caseHref = (role: Role, caseId: string) => (role === "MANAGER" ? `/ops/cases/${caseId}` : role === "CONTRACTOR" ? `/jobs/${caseId}` : `/my/cases/${caseId}`);

/** Loads the signed-in user and sends anyone with the wrong role to their own home. */
export function useMe(role?: Role): Me | null {
  const { data } = useQuery(getMe);
  const navigate = useNavigate();
  useEffect(() => {
    if (data && role && data.role !== role) navigate(HOME[data.role], { replace: true });
  }, [data, role, navigate]);
  return data && (!role || data.role === role) ? data : null;
}

function Notifications({ role, onEmailSettings, dark }: { role: Role; onEmailSettings: () => void; dark?: boolean }) {
  const { data } = useQuery(getNotifications, undefined, { refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];
  const waiting = items.filter((n) => n.ackRequired && !n.acknowledged);
  return (
    <div className="relative" ref={ref}>
      <button
        className={cn("relative rounded-md p-2", dark ? "text-white/80 hover:bg-white/10 hover:text-white" : "hover:bg-white/10")}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && unread) void markNotificationsRead({});
        }}
      >
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-move text-[10px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className={cn("absolute z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface text-ink shadow-xl", role === "MANAGER" ? "top-full right-0 lg:top-auto lg:right-auto lg:bottom-0 lg:left-full lg:mt-0 lg:ml-3" : "right-0")}>
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            <span className="text-xs text-muted">{waiting.length ? `${waiting.length} need${waiting.length === 1 ? "s" : ""} you` : "All caught up"}</span>
          </div>
          <ul className="max-h-[26rem] overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Nothing yet.</li>}
            {items.map((n) => (
              <li key={n.id} className={cn("border-b border-line last:border-0", !n.read && "bg-move-soft/40")}>
                <Link to={n.caseId ? caseHref(role, n.caseId) : HOME[role]} onClick={() => setOpen(false)} className="block px-4 pt-3 pb-2 hover:bg-sunk">
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>
                </Link>
                <div className="flex items-center gap-2 px-4 pb-2.5 text-[11px] text-faint">
                  <span>{when(n.at)}</span>
                  {n.ackRequired && !n.acknowledged && (n.overdue ? <Badge tone="danger">Overdue</Badge> : <Badge tone="move">Needs you</Badge>)}
                  {n.ackRequired && n.acknowledged && <span className="text-ok">Acknowledged</span>}
                  {n.ackRequired && !n.acknowledged && (
                    <button className="ml-auto rounded px-1.5 py-0.5 font-medium text-ink-2 hover:bg-sunk" onClick={() => void acknowledgeNotification({ id: n.id })}>
                      Got it
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <button className="flex w-full items-center gap-2 border-t border-line px-4 py-2.5 text-left text-xs text-muted hover:bg-sunk hover:text-ink" onClick={() => (setOpen(false), onEmailSettings())}>
            <Mail className="size-3.5" /> Email notifications…
          </button>
        </div>
      )}
    </div>
  );
}

/** Email is optional and opt-in. In-app notifications always work. */
function EmailSettings({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (o: boolean) => void }) {
  const a = useAction();
  const [email, setEmail] = useState(me.email ?? "");
  const [on, setOn] = useState(me.emailNotifications);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Email notifications" description="In-app notifications are always on. Email is optional, and only for things that need you or change your plans.">
        <div className="space-y-3">
          {!me.emailChannel.configured && <Notice tone="warn">This server has no email configured, so nothing is emailed. In-app notifications still work.</Notice>}
          {me.emailChannel.configured && me.emailChannel.capture && <Notice tone="info">This is a test server: email goes to a local capture inbox and is not delivered to anyone.</Notice>}
          {a.error && <Notice tone="danger">{a.error}</Notice>}
          <div>
            <Label htmlFor="em">Email address</Label>
            <Input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            <Hint>Emails contain a link to sign in to Relay, never your full case details or any codes.</Hint>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-ink" checked={on} onChange={(e) => setOn(e.target.checked)} /> Email me as well as the in-app notification
          </label>
          <Button busy={a.busy === "save"} onClick={async () => (await a.run("save", () => updateMyNotifications({ email: email.trim() || null, emailNotifications: on }))) && onOpenChange(false)}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean };
const MANAGER_NAV: { section: string; items: NavItem[] }[] = [
  { section: "Overview", items: [{ to: "/ops", label: "Command center", icon: <Gauge />, end: true }] },
  {
    section: "Work",
    items: [
      { to: "/ops/cases", label: "Cases", icon: <Inbox /> },
      { to: "/ops/vendors", label: "Vendors", icon: <Building2 /> },
    ],
  },
  { section: "Admin", items: [{ to: "/ops/settings", label: "Settings", icon: <Settings /> }] },
];
const NAV: Record<Exclude<Role, "MANAGER">, NavItem[]> = {
  RESIDENT: [
    { to: "/my", label: "My requests", icon: <ClipboardList />, end: true },
    { to: "/my/report", label: "Report a problem", icon: <Wrench /> },
  ],
  CONTRACTOR: [{ to: "/jobs", label: "My jobs", icon: <ClipboardList />, end: true }],
};

export function Shell({ role, children, wide }: { role: Role; children: (me: Me) => ReactNode; wide?: boolean }) {
  const me = useMe(role);
  const [emailOpen, setEmailOpen] = useState(false);
  if (!me)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  const where = role === "MANAGER" ? me.properties.map((p) => p.name).join(", ") : role === "CONTRACTOR" ? me.vendor?.name : me.units.map((u) => `${u.propertyName}, ${u.label}`).join("; ");
  const signOut = (
    <button onClick={() => logout()} className="rounded-md p-2 text-current/80 hover:bg-white/10" aria-label="Sign out" title="Sign out">
      <LogOut className="size-4" />
    </button>
  );

  if (role === "MANAGER") {
    return (
      <div className="min-h-dvh bg-paper lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:bg-[linear-gradient(to_right,var(--color-night)_15.5rem,var(--color-paper)_15.5rem)]">
        <aside className="sticky top-0 z-20 flex items-center gap-2 bg-night px-3 py-2 text-white lg:h-dvh lg:flex-col lg:items-stretch lg:gap-0 lg:px-3 lg:py-4">
          <Link to="/ops" className="mr-2 flex items-center gap-2 px-2 lg:mb-5">
            <span className="grid size-7 place-items-center rounded-md bg-move text-[13px] font-bold">R</span>
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight">Relay</span>
              <span className="hidden text-[11px] text-white/50 lg:block">Operations</span>
            </span>
          </Link>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-4" aria-label="Main">
            {MANAGER_NAV.map((g) => (
              <div key={g.section} className="flex gap-1 lg:flex-col lg:gap-0.5">
                <p className="hidden px-2.5 pb-1 text-[10px] font-semibold tracking-[0.08em] text-white/40 uppercase lg:block">{g.section}</p>
                {g.items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    className={({ isActive }) =>
                      cn("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap [&_svg]:size-4", isActive ? "bg-night-2 font-medium text-white shadow-[inset_2px_0_0_var(--color-move)]" : "text-white/65 hover:bg-night-2 hover:text-white")
                    }
                  >
                    {n.icon}
                    <span className="max-sm:sr-only">{n.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 lg:mt-auto lg:ml-0 lg:items-center lg:border-t lg:border-night-line lg:pt-3">
            <div className="hidden min-w-0 flex-1 px-1 lg:block">
              <p className="truncate text-[13px] font-medium">{me.name}</p>
              <p className="truncate text-[11px] text-white/50">{where}</p>
            </div>
            <Notifications role={role} dark onEmailSettings={() => setEmailOpen(true)} />
            {signOut}
          </div>
        </aside>
        <main className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", wide ? "max-w-[92rem]" : "max-w-6xl")}>{children(me)}</main>
        <EmailSettings me={me} open={emailOpen} onOpenChange={setEmailOpen} />
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-paper">
      <header className="sticky top-0 z-20 bg-night text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">
          <Link to={HOME[role]} className="mr-2 flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-move text-[13px] font-bold">R</span>
            <span className="text-[15px] font-semibold tracking-tight">Relay</span>
          </Link>
          <nav className="flex gap-1" aria-label="Main">
            {NAV[role].map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm [&_svg]:size-4", isActive ? "bg-white/12 font-medium" : "text-white/75 hover:text-white")}>
                {n.icon}
                <span className="max-sm:sr-only">{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <div className="hidden max-w-48 text-right sm:block">
              <p className="truncate text-sm font-medium">{me.name}</p>
              <p className="truncate text-xs opacity-70">{where}</p>
            </div>
            <Notifications role={role} onEmailSettings={() => setEmailOpen(true)} />
            {signOut}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-6">{children(me)}</main>
      <EmailSettings me={me} open={emailOpen} onOpenChange={setEmailOpen} />
    </div>
  );
}

export const PageTitle = ({ title, children, action, eyebrow }: { title: ReactNode; children?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0">
      {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
    {action}
  </div>
);

export const RoleBadge = ({ role }: { role: Role }) => <Badge tone="outline">{role === "MANAGER" ? "Property manager" : role === "CONTRACTOR" ? "Contractor" : "Resident"}</Badge>;
