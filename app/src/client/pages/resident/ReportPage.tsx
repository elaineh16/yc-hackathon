import { Bot, ClipboardList, Mic, Send, ShieldAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { getAiStatus, getIntakeConversation, reportIssue, sendIntakeMessage, useQuery } from "wasp/client/operations";
import { CATEGORIES, type Category, CATEGORY_LABEL } from "../../../shared/domain";
import { type Answer, QUESTIONS } from "../../../shared/intake";
import type { Me } from "../../../shared/views";
import { PageTitle, Shell } from "../../components/shell";
import { errorText, requestId } from "../../lib";
import { Badge, Button, cn, Hint, Input, Label, Notice, Panel, Select, Spinner, Textarea } from "../../ui";
import { VoiceIntake } from "./VoiceIntake";

export function ReportPage() {
  return <Shell role="RESIDENT">{(me) => <Report me={me} />}</Shell>;
}

type Mode = "chat" | "form" | "voice";

function Report({ me }: { me: Me }) {
  const { data: ai } = useQuery(getAiStatus);
  const [unitId, setUnitId] = useState(me.units[0]?.id ?? "");
  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState("");
  const effective: Mode = mode ?? (ai?.available === false ? "form" : "chat");
  if (me.units.length === 0) return <Notice tone="warn">Your account is not linked to a unit yet. Ask your property manager to add you.</Notice>;
  return (
    <>
      <PageTitle title="Report a problem">Describe it in your own words. Relay files it with your property manager and keeps you updated here.</PageTitle>
      {me.units.length > 1 && (
        <div className="mb-4 max-w-xs">
          <Label htmlFor="unit">Unit</Label>
          <Select id="unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            {me.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.propertyName}, {u.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="How to report">
        {(
          [
            ["chat", "Chat with Relay", <Bot key="b" />],
            ...(me.voiceAvailable ? [["voice", "Talk to Relay", <Mic key="m" />]] : []),
            ["form", "Use the form", <ClipboardList key="c" />],
          ] as [Mode, string, ReactNode][]
        ).map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={effective === k} onClick={() => setMode(k)} className={cn("flex items-center gap-2 rounded-full px-3 py-1.5 text-sm [&_svg]:size-4", effective === k ? "bg-ink text-white" : "text-muted hover:bg-sunk hover:text-ink")}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      {effective === "chat" && ai?.available === false && (
        <Notice tone="warn" className="mb-4" title="Relay's assistant is offline">
          {ai.reason} The form below works without it.
        </Notice>
      )}
      {effective === "chat" && <Chat unitId={unitId} onUnavailable={(text) => (setDraft(text), setMode("form"))} />}
      {effective === "voice" && <VoiceIntake unitId={unitId} />}
      {effective === "form" && <ReportForm unitId={unitId} initialText={draft} />}
    </>
  );
}

/** Real time since Relay started on the reply: a clock, not an animation. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tnum">{Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000))} s</span>;
}

function Chat({ unitId, onUnavailable }: { unitId: string; onUnavailable: (text: string) => void }) {
  const navigate = useNavigate();
  const [poll, setPoll] = useState(false);
  // Follow one conversation by id, so a filed conversation keeps showing its result instead of a fresh greeting.
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  // While a reply is being produced (a background job), poll for it; the request that sent the message returned at once.
  const { data: view, refetch } = useQuery(getIntakeConversation, { unitId, conversationId }, { enabled: !!unitId, refetchInterval: poll ? 1500 : false });
  useEffect(() => {
    if (view?.id && view.id !== conversationId) setConversationId(view.id);
  }, [view?.id, conversationId]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPoll(!!view?.pending);
  }, [view?.pending]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [view?.messages.length, view?.pending]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || !view || view.pending) return;
    setText("");
    setSending(true);
    setError(null);
    try {
      await sendIntakeMessage({ conversationId: view.id, text: message });
      setPoll(true);
      await refetch();
    } catch (err) {
      setError(errorText(err));
      setText(message);
    } finally {
      setSending(false);
    }
  }
  async function restart() {
    const fresh = await getIntakeConversation({ unitId, fresh: true });
    setConversationId(fresh.id);
  }
  if (!view) return <Spinner />;
  const done = view.status === "SUBMITTED";
  const offline = view.lastError === "ai_unavailable" && !view.pending && !done;
  const words = view.messages.filter((m) => m.role === "resident").map((m) => m.text).join("\n");
  return (
    <Panel className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <Bot className="size-4 text-ai" /> Relay <Badge tone="ai">AI assistant</Badge>
        </span>
        <Button size="sm" variant="ghost" onClick={restart} disabled={view.pending}>
          Start over
        </Button>
      </div>
      <div className="max-h-[60dvh] min-h-64 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite" data-testid="chat-log">
        {view.messages.map((m, i) => (
          <div key={i} className={cn("max-w-[85%] rounded-lg px-3 py-2 text-[15px] whitespace-pre-line", m.role === "resident" ? "ml-auto bg-ink text-white" : "bg-sunk text-ink")}>
            {m.text}
          </div>
        ))}
        {view.pending && view.pendingSince && (
          <p className="flex items-start gap-2 text-sm text-muted" data-testid="chat-pending">
            <Bot className="mt-0.5 size-4 shrink-0 text-ai" />
            <span>
              Message saved. Relay is writing a reply (<Elapsed since={view.pendingSince} />). On this local model it can take up to a minute.
            </span>
          </p>
        )}
        <div ref={end} />
      </div>
      {error && <Notice tone="danger" className="mx-4 mb-3">{error}</Notice>}
      {offline && (
        <Notice tone="warn" className="mx-4 mb-3" title="Relay's assistant is offline">
          Your messages are saved. The form works without the assistant.
          <span className="mt-2 block">
            <Button size="sm" onClick={() => onUnavailable(words)}>
              Use the form with my words
            </Button>
          </span>
        </Notice>
      )}
      {done ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <Notice tone="ok" className="flex-1">
            {view.filed.length > 1 ? `Filed as ${view.filed.map((f) => f.ref).join(" and ")}.` : view.filed[0]?.action === "reopened" ? `Reopened ${view.filed[0].ref}.` : `Filed as ${view.caseRef ?? view.filed[0]?.ref}.`}
          </Notice>
          {(view.caseId || view.filed[0]?.caseId) && <Button onClick={() => navigate(`/my/cases/${view.caseId ?? view.filed[0].caseId}`)}>Follow this request</Button>}
        </div>
      ) : (
        <form onSubmit={send} className="flex gap-2 border-t border-line p-3">
          <Textarea
            className="min-h-11 flex-1 resize-none"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) send(e as unknown as FormEvent);
            }}
            placeholder={view.pending ? "Relay is replying…" : "Describe the problem"}
            aria-label="Message to Relay"
            disabled={sending || view.pending}
          />
          <Button type="submit" size="icon" aria-label="Send" disabled={!text.trim() || sending || view.pending}>
            <Send />
          </Button>
        </form>
      )}
    </Panel>
  );
}

/** The fallback: the category's questions, triaged by deterministic rules. Works with no AI at all. */
function ReportForm({ unitId, initialText }: { unitId: string; initialText: string }) {
  const navigate = useNavigate();
  const [category, setCategory] = useState<Category>("PLUMBING");
  const [description, setDescription] = useState(initialText);
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [enter, setEnter] = useState(false);
  const [access, setAccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt] = useState(requestId);
  const [result, setResult] = useState<{ caseId: string; message: string; emergency: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await reportIssue({ unitId, clientRequestId: attempt, channel: "TEXT", description, categoryHint: category, details: answers, title: title || null, permissionToEnter: enter, accessNotes: access || null });
      setResult({ caseId: r.caseId, message: r.message, emergency: r.emergency });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  if (result) {
    return (
      <Panel className="p-5">
        <Notice tone={result.emergency ? "danger" : "ok"} icon={result.emergency ? <ShieldAlert /> : undefined}>
          {result.message}
        </Notice>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => navigate(`/my/cases/${result.caseId}`)}>Follow this request</Button>
          <Button asChild variant="outline">
            <Link to="/my">All requests</Link>
          </Button>
        </div>
      </Panel>
    );
  }
  const set = (k: string, v: Answer) => setAnswers({ ...answers, [k]: v });
  return (
    <Panel>
      <form onSubmit={submit} className="space-y-5 p-4">
        <div>
          <Label htmlFor="cat">What kind of problem?</Label>
          <Select id="cat" value={category} onChange={(e) => (setCategory(e.target.value as Category), setAnswers({}))}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          {category === "OTHER" && <Hint>A person will read it and decide who should handle it.</Hint>}
        </div>
        <div>
          <Label htmlFor="desc">Describe it</Label>
          <Textarea id="desc" required minLength={8} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is happening, where, and since when" />
        </div>
        <div>
          <Label htmlFor="title">Short title (optional)</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Relay writes one if you leave this empty" />
        </div>
        {QUESTIONS[category].map((q) => (
          <div key={q.key} data-testid={`q-${q.key}`}>
            <Label htmlFor={q.key} className={q.safety ? "text-danger" : ""}>
              {q.label}
              {q.required && <span className="text-muted"> (required)</span>}
            </Label>
            {q.kind === "choice" && (
              <Select id={q.key} required={q.required} value={(answers[q.key] as string) ?? ""} onChange={(e) => set(q.key, e.target.value || null)}>
                <option value="">Choose…</option>
                {q.options!.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
            {q.kind === "yesno" && (
              <div className="flex gap-2" role="radiogroup" aria-labelledby={q.key}>
                {(
                  [
                    ["Yes", true],
                    ["No", false],
                    ["Not sure", null],
                  ] as [string, boolean | null][]
                ).map(([label, v]) => (
                  <label key={label} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm", q.key in answers && answers[q.key] === v ? "border-ink bg-sunk" : "border-line")}>
                    <input type="radio" name={q.key} className="accent-ink" required={q.required} checked={q.key in answers && answers[q.key] === v} onChange={() => set(q.key, v)} />
                    {label}
                  </label>
                ))}
              </div>
            )}
            {(q.kind === "text" || q.kind === "number") && <Input id={q.key} inputMode={q.kind === "number" ? "decimal" : undefined} value={(answers[q.key] as string) ?? ""} onChange={(e) => set(q.key, e.target.value)} placeholder={q.hint} />}
          </div>
        ))}
        <div className="space-y-3 rounded-md bg-sunk p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-ink" checked={enter} onChange={(e) => setEnter(e.target.checked)} />
            The vendor may enter if I am not home
          </label>
          <Input value={access} onChange={(e) => setAccess(e.target.value)} placeholder="Access notes: pets, times to avoid (optional)" aria-label="Access notes" />
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button type="submit" variant="move" size="lg" busy={busy}>
          Submit report
        </Button>
      </form>
    </Panel>
  );
}
