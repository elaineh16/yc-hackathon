// The case "story": what was reported, what Relay understood, and the facts gathered. Shared by every role.
import { Bot, Mic, PenLine, ShieldAlert } from "lucide-react";
import type { CaseDetail } from "../../shared/views";
import { categoryLabel, when } from "../lib";
import { Badge, Notice, Panel, PanelHeader } from "../ui";

const SOURCE: Record<CaseDetail["triageSource"], string> = {
  RULES: "Classified by Relay's rules from the form",
  AGENT: "Understood by Relay's assistant in conversation",
  VOICE_AGENT: "Understood by Relay's voice assistant",
  MANAGER: "Classified by a manager",
};

export function IssuePanel({ c }: { c: CaseDetail }) {
  const channelIcon = c.channel === "VOICE" ? <Mic /> : c.channel === "CHAT" ? <Bot /> : <PenLine />;
  return (
    <Panel>
      <PanelHeader title="Reported problem">
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
          {channelIcon}
          {c.channel === "VOICE" ? "Voice" : c.channel === "CHAT" ? "Chat with Relay" : "Form"}, {when(c.createdAt)} by {c.residentName}
        </span>
      </PanelHeader>
      <div className="space-y-4 p-4">
        {c.emergency && (
          <Notice tone="danger" icon={<ShieldAlert />} title="Treated as an emergency">
            {c.viewerRole === "RESIDENT" ? c.emergencyInstructions : "Routine dispatch is blocked until a manager handles the escalation."}
          </Notice>
        )}
        <blockquote className="border-l-2 border-line-strong pl-3 text-[15px] whitespace-pre-line text-ink">{c.description}</blockquote>
        {c.viewerRole !== "CONTRACTOR" && (
          <div className="rounded-md bg-sunk px-3 py-2.5">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              {c.triageSource !== "RULES" && c.triageSource !== "MANAGER" && (
                <Badge tone="ai">
                  <Bot /> AI
                </Badge>
              )}
              {SOURCE[c.triageSource]}
            </p>
            <p className="mt-1 text-sm text-ink">{c.summary}</p>
            {c.triageReasons.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted">
                {c.triageReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {c.answers.length > 0 && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {c.answers.map((a) => (
              <div key={a.key} className="flex justify-between gap-3 border-b border-line pb-1.5">
                <dt className="text-muted">{a.question.replace(/\?$/, "")}</dt>
                <dd className={a.safety && a.answer === "Yes" ? "font-semibold text-danger" : "font-medium"}>{a.answer}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone="outline">{categoryLabel(c.category)}</Badge>
          <Badge tone={c.permissionToEnter ? "ok" : "outline"}>{c.permissionToEnter ? "Permission to enter if out" : "Resident must be home"}</Badge>
          {c.accessNotes && <Badge tone="outline">Access: {c.accessNotes}</Badge>}
        </div>
      </div>
    </Panel>
  );
}
