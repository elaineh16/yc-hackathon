// The frame around every signed-in page: navigation for the role, notifications, and a role guard.
import { Bell, ClipboardList, Gauge, Inbox, LogOut, Settings, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { logout } from "wasp/client/auth";
import { getMe, getNotifications, markNotificationsRead, useQuery } from "wasp/client/operations";
import type { Role } from "../../shared/domain";
import type { Me } from "../../shared/views";
import { when } from "../lib";
import { Badge, cn, Spinner } from "../ui";

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

function Notifications({ role }: { role: Role }) {
  const { data } = useQuery(getNotifications, undefined, { refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const unread = data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button
        className="relative rounded-md p-2 text-current hover:bg-white/10"
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
        <div className="absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface text-ink shadow-lg">
          <p className="border-b border-line px-4 py-2.5 text-sm font-semibold">Notifications</p>
          <ul className="max-h-96 overflow-y-auto">
            {(data?.items ?? []).length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Nothing yet.</li>}
            {(data?.items ?? []).map((n) => (
              <li key={n.id} className="border-b border-line last:border-0">
                <Link to={n.caseId ? caseHref(role, n.caseId) : HOME[role]} onClick={() => setOpen(false)} className={cn("block px-4 py-3 hover:bg-sunk", !n.read && "bg-move-soft/50")}>
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>
                  <p className="mt-1 text-[11px] text-faint">{when(n.at)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const NAV: Record<Role, { to: string; label: string; icon: ReactNode; end?: boolean }[]> = {
  MANAGER: [
    { to: "/ops", label: "Command center", icon: <Gauge />, end: true },
    { to: "/ops/cases", label: "Cases", icon: <Inbox /> },
    { to: "/ops/settings", label: "Settings", icon: <Settings /> },
  ],
  RESIDENT: [
    { to: "/my", label: "My requests", icon: <ClipboardList />, end: true },
    { to: "/my/report", label: "Report a problem", icon: <Wrench /> },
  ],
  CONTRACTOR: [{ to: "/jobs", label: "My jobs", icon: <ClipboardList />, end: true }],
};

export function Shell({ role, children, wide }: { role: Role; children: (me: Me) => ReactNode; wide?: boolean }) {
  const me = useMe(role);
  if (!me)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  const who = (
    <div className="min-w-0 text-sm">
      <p className="truncate font-medium">{me.name}</p>
      <p className="truncate text-xs opacity-70">{role === "MANAGER" ? me.properties.map((p) => p.name).join(", ") : role === "CONTRACTOR" ? me.vendor?.name : me.units.map((u) => `${u.propertyName}, ${u.label}`).join("; ")}</p>
    </div>
  );
  const signOut = (
    <button onClick={() => logout()} className="rounded-md p-2 hover:bg-white/10" aria-label="Sign out" title="Sign out">
      <LogOut className="size-4" />
    </button>
  );

  if (role === "MANAGER") {
    return (
      <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="sticky top-0 z-20 flex items-center gap-2 bg-ink px-3 py-2 text-white lg:h-dvh lg:flex-col lg:items-stretch lg:gap-1 lg:px-3 lg:py-5">
          <Link to="/ops" className="mr-2 px-2 text-lg font-bold tracking-tight lg:mb-6">
            Relay
          </Link>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Main">
            {NAV.MANAGER.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cn("flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm whitespace-nowrap [&_svg]:size-4", isActive ? "bg-white/12 font-medium text-white" : "text-white/70 hover:text-white")}>
                {n.icon}
                <span className="max-sm:sr-only">{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 lg:mt-auto lg:ml-0 lg:items-center lg:border-t lg:border-white/10 lg:pt-3">
            <div className="hidden flex-1 lg:block">{who}</div>
            <Notifications role={role} />
            {signOut}
          </div>
        </aside>
        <main className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", wide ? "max-w-[90rem]" : "max-w-6xl")}>{children(me)}</main>
      </div>
    );
  }
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 bg-ink text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2">
          <Link to={HOME[role]} className="mr-2 text-lg font-bold tracking-tight">
            Relay
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
            <div className="hidden max-w-48 sm:block">{who}</div>
            <Notifications role={role} />
            {signOut}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-6">{children(me)}</main>
    </div>
  );
}

export const PageTitle = ({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
    {action}
  </div>
);

export const RoleBadge = ({ role }: { role: Role }) => <Badge tone="outline">{role === "MANAGER" ? "Property manager" : role === "CONTRACTOR" ? "Contractor" : "Resident"}</Badge>;
