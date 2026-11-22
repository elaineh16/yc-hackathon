import type { DB } from "./types.js";

// EDIT THESE PHONE NUMBERS to your teammates' real phones (E.164).
// Trial Twilio accounts can only call verified numbers — verify each one.
export const seed: DB = {
  tenants: [
    { id: "t1", name: "Priya", phone: "+15195550101", unit: "4B" },
    { id: "t2", name: "Jordan", phone: "+15195550102", unit: "2A" },
    { id: "t3", name: "Sam", phone: "+15195550103", unit: "7C" },
  ],
  contractors: [
    // Demo: plumber 1 declines, plumber 2 accepts
    { id: "c1", name: "Marco", company: "Marco's Plumbing", phone: "+15195550201", trade: "plumbing", priority: 1, maxBudget: 300 },
    { id: "c2", name: "Dana", company: "Waterloo Rooter", phone: "+15195550202", trade: "plumbing", priority: 2, maxBudget: 300 },
    { id: "c3", name: "Lee", company: "Bright Spark Electric", phone: "+15195550203", trade: "electrical", priority: 1, maxBudget: 400 },
    { id: "c4", name: "Ana", company: "CoolAir HVAC", phone: "+15195550204", trade: "hvac", priority: 1, maxBudget: 500 },
    { id: "c5", name: "Chris", company: "Handy Chris", phone: "+15195550205", trade: "general", priority: 1, maxBudget: 200 },
  ],
  tickets: [],
  calls: [],
};
