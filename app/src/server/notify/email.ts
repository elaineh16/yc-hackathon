// The email channel: plain SMTP through nodemailer. Locally that is Mailpit (a capture server, nothing leaves the
// machine). No paid service is involved. What a send proves is recorded exactly:
//   - SMTP_CAPTURE=true (Mailpit): CAPTURED, "not delivered to anyone"
//   - a real SMTP server: ACCEPTED, "accepted by the mail server; delivery to the mailbox is not confirmed"
// Nothing in Relay ever reports an email as delivered to a person's inbox.
import nodemailer, { type Transporter } from "nodemailer";
import { prisma } from "wasp/server";
import { mark } from "../tracing";
import { emailConfig } from "./config";
import { emailBlocker } from "./notify";

export { emailConfig };

let transport: Transporter | null = null;
let transportKey = "";
function transporter() {
  const c = emailConfig();
  const k = `${c.host}:${c.port}:${c.user}:${c.secure}`;
  if (!transport || transportKey !== k) {
    transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      ...(c.user ? { auth: { user: c.user, pass: c.pass } } : {}),
      // A password is never sent in the clear: with credentials, the connection must be TLS (or upgrade to it).
      ...(c.capture ? { ignoreTLS: true } : c.user && !c.secure ? { requireTLS: true } : {}),
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
    transportKey = k;
  }
  return transport;
}

function render(n: { title: string; body: string; actionUrl: string | null }, appUrl: string) {
  const link = n.actionUrl ? `${appUrl}${n.actionUrl}` : appUrl;
  const text = `${n.body}\n\nOpen it in Relay (you will be asked to sign in): ${link}\n\n—\nYou get these emails because you turned on email notifications in Relay. Your in-app notifications are always available.`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#18212b;max-width:560px">
<p style="margin:0 0 16px">${esc(n.body)}</p>
<p style="margin:0 0 24px"><a href="${esc(link)}" style="display:inline-block;background:#18212b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open in Relay</a></p>
<p style="margin:0;color:#5a6570;font-size:13px">You will be asked to sign in. You get these emails because you turned on email notifications in Relay.</p></div>`;
  return { text, html };
}

let delivering: Promise<unknown> | null = null;
/** Sends due email rows. Safe to call from anywhere, any number of times: rows are claimed with SKIP LOCKED. */
export function kickEmail() {
  if (!emailConfig().enabled) return;
  if (delivering) return;
  delivering = deliverPendingEmails()
    .catch((e) => console.warn("[email] delivery pass failed; the sweep will retry:", (e as Error)?.name))
    .finally(() => {
      delivering = null;
    });
}

/** Waits for any delivery pass already running in this process, then runs one more (used by the sweep and tests). */
export async function deliverNow(): Promise<DeliveryResult> {
  if (delivering) await delivering.catch(() => undefined);
  return deliverPendingEmails();
}

export type DeliveryResult = { claimed: number; captured: number; accepted: number; failed: number; retrying: number; skipped: number };

export async function deliverPendingEmails(limit = 20): Promise<DeliveryResult> {
  const c = emailConfig();
  const out: DeliveryResult = { claimed: 0, captured: 0, accepted: 0, failed: 0, retrying: 0, skipped: 0 };
  if (!c.enabled) return out;
  // A send that was claimed but never finished (the server stopped mid-send) is retried after its lease runs out.
  await prisma.$executeRaw`UPDATE "Notification" SET "status" = 'PENDING' WHERE "channel" = 'EMAIL' AND "status" = 'SENDING' AND "nextAttemptAt" < now() - interval '1 minute'`;
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Notification" SET "status" = 'SENDING', "attempts" = "attempts" + 1, "nextAttemptAt" = now() + interval '2 minutes'
    WHERE "id" IN (
      SELECT "id" FROM "Notification"
      WHERE "channel" = 'EMAIL' AND "status" = 'PENDING' AND "scheduledFor" <= now() AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "createdAt" LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING "id"`;
  out.claimed = claimed.length;
  for (const { id } of claimed) {
    try {
      await deliverOne(id, c, out);
    } catch (e) {
      // One row's failure (for example a row deleted while the pass ran) never stops the others; a row left
      // SENDING is picked up again when its lease runs out.
      console.warn("[email] could not process a notification:", (e as Error)?.name);
    }
  }
  if (out.claimed) mark("relay.email.delivery", { ...out });
  return out;
}

/** Sends one claimed row, or records why it was skipped, retried or failed. */
async function deliverOne(id: string, c: ReturnType<typeof emailConfig>, out: DeliveryResult) {
  const n = await prisma.notification.findUnique({ where: { id }, include: { user: { select: { email: true, emailNotifications: true } } } });
  if (!n) return;
  // Preferences may have changed since the row was queued.
  const blocked = emailBlocker(n.user);
  if (blocked) {
    await prisma.notification.update({ where: { id }, data: { status: "SKIPPED", statusNote: blocked } });
    out.skipped++;
    return;
  }
  const sentLastHour = await prisma.notification.count({ where: { userId: n.userId, channel: "EMAIL", status: { in: ["ACCEPTED", "CAPTURED"] }, sentAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (sentLastHour >= c.maxPerHour) {
    await prisma.notification.update({ where: { id }, data: { status: "SKIPPED", statusNote: `Send limit reached (${c.maxPerHour} emails per hour). The in-app notification was delivered.` } });
    out.skipped++;
    return;
  }
  // Still ours? A slow batch can outlive the claim's lease, and then another pass has re-claimed the row (counting an
  // attempt): this pass must not send it too. Refreshing the lease here also covers the send itself.
  const ours = await prisma.notification.updateMany({ where: { id, status: "SENDING", attempts: n.attempts }, data: { nextAttemptAt: new Date(Date.now() + 2 * 60_000) } });
  if (ours.count === 0) return;
  try {
    const body = render(n, c.appUrl);
    // A stable Message-ID: if a send is ever retried after an unrecorded success, mail systems can drop the copy.
    const info = await transporter().sendMail({ from: c.from, to: n.user.email!, subject: n.title, text: body.text, html: body.html, messageId: `<${n.id}@relay.local>`, headers: { "X-Relay-Event": n.eventType } });
    const accepted = (info.accepted ?? []).length > 0;
    if (!accepted) throw new Error("The mail server did not accept the recipient.");
    await prisma.notification.update({
      where: { id },
      data: {
        status: c.capture ? "CAPTURED" : "ACCEPTED",
        sentAt: new Date(),
        providerMessageId: String(info.messageId ?? "").slice(0, 200) || null,
        lastError: null,
        statusNote: c.capture ? "Captured by the local test mail server (Mailpit). It was not delivered to anyone." : `Accepted by the mail server at ${c.host}. Delivery to the mailbox is not confirmed.`,
      },
    });
    if (c.capture) out.captured++;
    else out.accepted++;
  } catch (e) {
    const message = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300);
    const last = n.attempts >= c.maxAttempts;
    await prisma.notification.update({
      where: { id },
      data: last
        ? { status: "FAILED", lastError: message, statusNote: `Not sent after ${n.attempts} attempts.` }
        : { status: "PENDING", lastError: message, nextAttemptAt: new Date(Date.now() + (n.attempts === 1 ? 60_000 : 300_000)) },
    });
    if (last) out.failed++;
    else out.retrying++;
  }
}
