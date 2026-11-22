export {};
// Runs the whole flow against a local backend WITHOUT phones:
// intake -> plumber 1 declines -> plumber 2 accepts -> tenant confirms.
// Usage: npm run dev   (in another terminal)   then   npm run simulate
const BASE = process.env.BASE_URL || "http://localhost:3001";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`POST ${path} ->`, json);
  return json as Record<string, any>;
}

async function get(path: string) {
  return (await (await fetch(`${BASE}${path}`)).json()) as Record<string, any>;
}

async function lastAttempt(ticketId: string) {
  const t = await get(`/api/tickets/${ticketId}`);
  return t.attemptedContractorIds.at(-1) as string;
}

const { ticket_id } = await post("/tools/create_ticket", {
  caller_phone: "+15195550101",
  category: "plumbing",
  urgency: "urgent",
  summary: "Water dripping through bathroom ceiling, getting worse",
  location: "Bathroom ceiling",
  access_windows: "Today after 3 PM",
  conversation_id: `sim_${Date.now()}`,
});

await sleep(3000);
await post("/tools/record_contractor_response", {
  ticket_id,
  contractor_id: await lastAttempt(ticket_id),
  accepted: false,
  notes: "Booked all day",
});

await sleep(5000);
await post("/tools/record_contractor_response", {
  ticket_id,
  contractor_id: await lastAttempt(ticket_id),
  accepted: true,
  slot: "Today 4:00 PM",
  quote: "$150 call-out",
});

await sleep(10000);
await post("/tools/confirm_booking", { ticket_id, confirmed: true, notes: "Tenant will be home" });

const final = await get(`/api/tickets/${ticket_id}`);
console.log(`\nFinal status: ${final.status}, contractor: ${final.contractor?.name}, slot: ${final.slot}`);
console.log(`Calls: ${final.calls.map((c: any) => `${c.agent}:${c.outcome}`).join(" -> ")}`);
