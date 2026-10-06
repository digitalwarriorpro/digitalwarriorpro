// Office CRM on the team database: pipeline board, job page (claim, value, tasks, activity), contacts and reports.
// Field data (doors, visits) comes from the reps' phones; office data lives in jobs, tasks and notes.
import { CONFIG } from "./config.js";
import { sync } from "./sync.js";
import { toCsv } from "./addresses.js";
import { totals, usd, newDoc, nextNumber, linesFromVehicles, statusAfterPayments, STATUS_LABEL, printHtml } from "./billing.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n || n === 0) && n !== "" ? "$" + Math.round(Number(n)).toLocaleString() : "";
const digits = (s) => String(s || "").replace(/\D/g, "");
const fmtPhone = (s) => { const d = digits(s).slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : s || ""; };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: CONFIG.timeZone });
const fmtDate = (s) => s ? new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
const fmtWhen = (s) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const slotLabel = (s) => s ? new Date(s).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const daysSince = (s) => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null;

const STAGES = CONFIG.pipeline;
const ALL_STAGES = [...STAGES, { key: "lost", label: "Lost" }];
const stageLabel = (k) => ALL_STAGES.find((s) => s.key === k)?.label || k;
const OUTCOME = { nothome: "Not home", no: "Not interested", back: "Come back", lead: "Lead · wants quote", booked: "Inspection booked", dnk: "Do not knock", none: "Not knocked" };

let sb = null, me = { id: null, name: "" };
let doors = new Map(), jobs = new Map(), tasks = [], reps = [], periodVisits = [], docs = [];
let editDoc = null, billFilter = "open";
let view = "pipeline", q = "", repFilter = "", period = "30", openId = null, showLost = false;

/* ---------- data ---------- */
const stageOf = (d) => jobs.get(d.id)?.stage || (d.status === "booked" ? "booked" : "new");
const inCrm = (d) => ["lead", "booked", "back"].includes(d.status) || jobs.has(d.id);
const repOf = (d) => jobs.get(d.id)?.assigned_to || d.updated_by_name || "";
function matchesFilters(d) {
  if (repFilter && repOf(d) !== repFilter && d.updated_by_name !== repFilter) return false;
  if (!q) return true;
  const j = jobs.get(d.id) || {};
  return [d.name, d.phone, digits(d.phone), d.email, d.address, d.city, d.zip, j.claim_number, j.insurer, d.notes].join(" ").toLowerCase().includes(q.toLowerCase());
}

async function loadAll() {
  const since = period === "all" ? "2000-01-01" : new Date(Date.now() - (period === "today" ? 0 : Number(period)) * 86400000).toLocaleDateString("en-CA", { timeZone: CONFIG.timeZone });
  const sinceIso = new Date(`${since}T00:00:00`).toISOString();
  const [jr, dr, tr, vr, rr, kr] = await Promise.all([
    sb.from("jobs").select("*"),
    sb.from("doors").select("*").in("status", ["lead", "booked", "back"]),
    sb.from("tasks").select("*").order("due", { ascending: true, nullsFirst: false }),
    sb.from("visits").select("id,door_id,rep_name,outcome,at").gte("at", sinceIso).limit(20000),
    sync.reps(),
    sb.from("documents").select("*").order("created_at", { ascending: false }),
  ]);
  for (const r of [jr, dr, tr, vr]) if (r.error) throw r.error;
  docs = kr.error ? [] : kr.data; // before schema.sql adds the table, billing just shows empty
  jobs = new Map(jr.data.map((j) => [j.door_id, j]));
  doors = new Map(dr.data.map((d) => [d.id, d]));
  const missing = [...new Set([...jobs.keys(), ...docs.map((k) => k.door_id)])].filter((id) => !doors.has(id));
  if (missing.length) {
    const { data } = await sb.from("doors").select("*").in("id", missing);
    (data || []).forEach((d) => doors.set(d.id, d));
  }
  tasks = tr.data; periodVisits = vr.data; reps = rr || [];
  $("#live").textContent = `Updated ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}
let reloadTimer = null;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(async () => { try { await loadAll(); render(); if (openId) renderDrawer(); } catch {} }, 600); }

async function saveJob(id, patch) {
  const cur = jobs.get(id) || { door_id: id, stage: stageOf(doors.get(id)) };
  const row = { ...cur, ...patch, door_id: id, updated_by_name: me.name };
  delete row.created_at; delete row.updated_at;
  const { data, error } = await sb.from("jobs").upsert(row).select().single();
  if (error) throw error;
  jobs.set(id, data);
  return data;
}
async function addNote(doorId, kind, body) {
  const { data, error } = await sb.from("notes").insert({ door_id: doorId, kind, body, by_name: me.name }).select().single();
  if (error) throw error;
  return data;
}
async function setStage(id, stage) {
  const d = doors.get(id); if (!d || stageOf(d) === stage) return;
  let patch = { stage, stage_changed_at: new Date().toISOString() };
  if (stage === "lost") {
    const why = prompt("Why was this job lost? (price, went elsewhere, no damage, no answer…)");
    if (why === null) return render();
    patch.lost_reason = why;
  }
  try {
    await saveJob(id, patch);
    await addNote(id, "note", `Moved to ${stageLabel(stage)}${patch.lost_reason ? `: ${patch.lost_reason}` : ""}`);
    toast(`${d.name || d.address} → ${stageLabel(stage)}`);
  } catch (e) { toast(errText(e)); }
  render(); if (openId === id) renderDrawer();
}
const errText = (e) => /42501|permission/i.test(e?.message || e?.code || "") ? "The database refused the change. Run schema.sql in Supabase, then try again." : e?.message || "Something went wrong.";

/* ---------- views ---------- */
function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === view));
  const open = tasks.filter((t) => !t.done && t.due && t.due <= today()).length;
  $("#task-badge").hidden = !open; $("#task-badge").textContent = open;
  const sel = $("#rep-filter"), names = [...new Set([...reps.map((r) => r.name), ...[...doors.values()].map((d) => d.updated_by_name)].filter(Boolean))].sort();
  sel.innerHTML = `<option value="">All reps</option>${names.map((n) => `<option ${n === repFilter ? "selected" : ""}>${esc(n)}</option>`).join("")}`;
  $("#main").innerHTML = view === "pipeline" ? pipelineView() : view === "contacts" ? contactsView() : view === "tasks" ? tasksView() : view === "billing" ? billingView() : reportsView();
}

function card(d) {
  const j = jobs.get(d.id) || {};
  const v = (d.vehicles || []).filter((x) => x.ymm);
  const due = j.next_step_due && j.next_step_due <= today();
  const days = daysSince(j.stage_changed_at || d.updated_at);
  return `<div class="card" draggable="true" data-id="${esc(d.id)}">
    <div class="name">${esc(d.name || d.address)}</div>
    <div class="line">${esc(d.address)}${d.city ? ", " + esc(d.city) : ""}</div>
    ${d.phone ? `<div class="line">${esc(fmtPhone(d.phone))}</div>` : ""}
    ${v.length ? `<div class="line">${esc(v.map((x) => x.ymm).join(", "))}</div>` : ""}
    <div class="tags">
      ${d.status === "booked" && d.slot && stageOf(d) === "booked" ? `<span class="tag when">${esc(slotLabel(d.slot))}</span>` : ""}
      ${j.value ? `<span class="tag money">${money(j.value)}</span>` : ""}
      ${j.next_step ? `<span class="tag ${due ? "due" : ""}">${esc(j.next_step)}${j.next_step_due ? " · " + fmtDate(j.next_step_due) : ""}</span>` : ""}
      ${repOf(d) ? `<span class="tag">${esc(repOf(d))}</span>` : ""}
      ${days != null && days >= 3 ? `<span class="tag">${days}d in stage</span>` : ""}
    </div></div>`;
}
function pipelineView() {
  const list = [...doors.values()].filter((d) => inCrm(d) && matchesFilters(d));
  const cols = [...STAGES, ...(showLost ? [{ key: "lost", label: "Lost" }] : [])];
  if (!list.length && !q && !repFilter) return `<p class="empty">No leads yet. When a rep books an inspection or saves a lead in the field app, it shows up here.</p>`;
  const lostN = list.filter((d) => stageOf(d) === "lost").length;
  return `<div class="row-actions"><span class="muted">${list.filter((d) => stageOf(d) !== "lost").length} open jobs · drag a card to move it</span>
    <button class="btn small" data-act="toggle-lost">${showLost ? "Hide lost" : `Show lost (${lostN})`}</button></div>
    <div class="board">${cols.map((s) => {
      const items = list.filter((d) => stageOf(d) === s.key).sort((a, b) => (a.slot || "9") < (b.slot || "9") ? -1 : 1);
      const total = items.reduce((t, d) => t + (Number(jobs.get(d.id)?.value) || 0), 0);
      return `<section class="col" data-stage="${s.key}"><div class="col-head"><b>${esc(s.label)}</b> <span class="sub">· ${items.length}${total ? " · " + money(total) : ""}</span></div>
        <div class="col-body">${items.map(card).join("")}</div></section>`;
    }).join("")}</div>`;
}

function contactRows() {
  return [...doors.values()].filter((d) => inCrm(d) && matchesFilters(d)).sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}
function contactsView() {
  const rows = contactRows();
  return `<div class="row-actions"><span class="muted">${rows.length} customers</span><button class="btn small" data-act="export">Export CSV</button></div>
    <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Phone</th><th>Address</th><th>Stage</th><th>Vehicles</th><th>Insurer</th><th class="num">Value</th><th>Rep</th><th>Updated</th></tr></thead><tbody>
    ${rows.map((d) => { const j = jobs.get(d.id) || {}; const ins = j.insurer || [...new Set((d.vehicles || []).map((v) => v.insurer).filter(Boolean))].join(", ");
      return `<tr data-id="${esc(d.id)}"><td><b>${esc(d.name || "—")}</b>${d.email ? `<div class="muted">${esc(d.email)}</div>` : ""}</td><td>${esc(fmtPhone(d.phone))}</td><td>${esc(d.address)}${d.city ? `<div class="muted">${esc(d.city)} ${esc(d.zip)}</div>` : ""}</td>
        <td>${esc(stageLabel(stageOf(d)))}</td><td>${esc((d.vehicles || []).map((v) => v.ymm).filter(Boolean).join(", "))}</td><td>${esc(ins)}</td><td class="num">${money(j.value)}</td><td>${esc(repOf(d))}</td><td>${esc(fmtDate(d.updated_at))}</td></tr>`; }).join("")}
    </tbody></table></div>`;
}
function exportCsv() {
  const rows = contactRows().map((d) => { const j = jobs.get(d.id) || {};
    return { stage: stageLabel(stageOf(d)), customer: d.name, phone: d.phone, email: d.email, address: d.address, city: d.city, zip: d.zip,
      inspection: d.slot || "", vehicles: (d.vehicles || []).map((v) => [v.ymm, (v.panels || []).join("/"), v.sev].filter(Boolean).join(" ")).join("; "),
      insurer: j.insurer || [...new Set((d.vehicles || []).map((v) => v.insurer).filter(Boolean))].join(", "), claim_number: j.claim_number || "", value: j.value ?? "",
      next_step: j.next_step || "", next_step_due: j.next_step_due || "", rep: repOf(d), field_notes: d.notes || "", updated: d.updated_at }; });
  const csv = toCsv(rows, ["stage", "customer", "phone", "email", "address", "city", "zip", "inspection", "vehicles", "insurer", "claim_number", "value", "next_step", "next_step_due", "rep", "field_notes", "updated"]);
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = `customers-${today()}.csv`; a.click();
}

function taskRow(t) {
  const d = doors.get(t.door_id), late = !t.done && t.due && t.due < today();
  return `<div class="task ${t.done ? "done" : ""}"><input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""} aria-label="Done">
    <div class="t-main"><div class="t-title">${esc(t.title)}</div>
    <div class="t-sub">${t.due ? `<span class="${late ? "warn" : ""}">${late ? "Overdue · " : ""}${fmtDate(t.due)}</span> · ` : ""}${d ? `<a href="#" data-open="${esc(d.id)}">${esc(d.name || d.address)}</a>` : ""}${t.assigned_to ? " · " + esc(t.assigned_to) : ""}</div></div></div>`;
}
function tasksView() {
  const open = tasks.filter((t) => !t.done && (!repFilter || t.assigned_to === repFilter));
  const groups = [["Overdue", open.filter((t) => t.due && t.due < today())], ["Today", open.filter((t) => t.due === today())],
    ["Upcoming", open.filter((t) => t.due && t.due > today())], ["No date", open.filter((t) => !t.due)]];
  const done = tasks.filter((t) => t.done && t.done_at && daysSince(t.done_at) <= 7);
  return `<form class="row-actions inline" id="f-task-general" style="max-width:720px"><input class="btn" style="font-weight:400" id="tg-title" placeholder="New task (e.g. Order parts for the Rivera F-150)" required>
      <input class="btn" style="font-weight:400" type="date" id="tg-due" value="${today()}"><button class="btn go">Add task</button></form>
    ${groups.filter(([, l]) => l.length).map(([h, l]) => `<div class="task-group"><div class="label">${h} · ${l.length}</div>${l.map(taskRow).join("")}</div>`).join("") || `<p class="empty">No open tasks.</p>`}
    ${done.length ? `<details><summary class="muted">Done in the last 7 days (${done.length})</summary>${done.map(taskRow).join("")}</details>` : ""}`;
}

function reportsView() {
  const v = periodVisits.filter((x) => !repFilter || x.rep_name === repFilter);
  const count = (o) => v.filter((x) => o.includes(x.outcome)).length;
  const knocks = v.length, talks = count(["no", "back", "lead", "booked"]), leads = count(["lead", "booked"]), booked = count(["booked"]);
  const pct = (a, b) => b ? Math.round((a / b) * 100) + "%" : "–";
  const byRep = {};
  for (const x of v) { const r = (byRep[x.rep_name || "Unknown"] ||= { knocks: 0, talks: 0, leads: 0, booked: 0, doors: new Set() }); r.knocks++; r.doors.add(x.door_id); if (["no", "back", "lead", "booked"].includes(x.outcome)) r.talks++; if (["lead", "booked"].includes(x.outcome)) r.leads++; if (x.outcome === "booked") r.booked++; }
  const all = [...doors.values()].filter((d) => inCrm(d) && (!repFilter || repOf(d) === repFilter));
  const stageRows = ALL_STAGES.map((s) => { const items = all.filter((d) => stageOf(d) === s.key); return { s, n: items.length, value: items.reduce((t, d) => t + (Number(jobs.get(d.id)?.value) || 0), 0) }; });
  const openValue = stageRows.filter((r) => !["paid", "lost"].includes(r.s.key)).reduce((t, r) => t + r.value, 0);
  const paid = stageRows.find((r) => r.s.key === "paid")?.value || 0;
  const max = Math.max(1, knocks);
  return `<div class="row-actions"><div class="period">${[["today", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All time"]].map(([k, l]) => `<button data-period="${k}" aria-pressed="${period === k}">${l}</button>`).join("")}</div></div>
    <div class="kpis">
      <div class="kpi"><div class="v">${knocks}</div><div class="k">Knocks</div></div>
      <div class="kpi"><div class="v">${talks}</div><div class="k">Conversations · ${pct(talks, knocks)}</div></div>
      <div class="kpi"><div class="v">${leads}</div><div class="k">Leads + bookings · ${pct(leads, talks)} of talks</div></div>
      <div class="kpi"><div class="v">${booked}</div><div class="k">Inspections booked · ${pct(booked, knocks)} of knocks</div></div>
      <div class="kpi"><div class="v">${money(openValue) || "$0"}</div><div class="k">Open pipeline value</div></div>
      <div class="kpi"><div class="v">${money(paid) || "$0"}</div><div class="k">Paid (all time)</div></div>
    </div>
    <div class="grid2"><div><div class="label">Field funnel</div><div class="funnel">
      ${[["Knocks", knocks], ["Conversations", talks], ["Leads + bookings", leads], ["Booked", booked]].map(([l, n]) => `<div class="f"><span>${l}</span><div class="bar" style="width:${Math.max(2, (n / max) * 100)}%"></div><b>${n}</b></div>`).join("")}</div>
      <div class="label">Pipeline now</div>
      <table><thead><tr><th>Stage</th><th class="num">Jobs</th><th class="num">Value</th></tr></thead><tbody>${stageRows.map((r) => `<tr><td>${esc(r.s.label)}</td><td class="num">${r.n}</td><td class="num">${money(r.value)}</td></tr>`).join("")}</tbody></table></div>
    <div><div class="label">By rep</div><div class="table-wrap"><table><thead><tr><th>Rep</th><th class="num">Knocks</th><th class="num">Talks</th><th class="num">Leads</th><th class="num">Booked</th><th class="num">Book rate</th></tr></thead><tbody>
      ${Object.entries(byRep).sort((a, b) => b[1].booked - a[1].booked || b[1].knocks - a[1].knocks).map(([n, r]) => `<tr><td>${esc(n)}</td><td class="num">${r.knocks}</td><td class="num">${r.talks}</td><td class="num">${r.leads}</td><td class="num">${r.booked}</td><td class="num">${pct(r.booked, r.knocks)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No knocks in this period.</td></tr>`}
    </tbody></table></div></div></div>`;
}

/* ---------- job drawer ---------- */
let drawerData = { visits: [], notes: [], photos: [] }, noteKind = "call";
async function openJob(id) {
  openId = id; drawerData = { visits: [], notes: [], photos: [] };
  $("#drawer").hidden = false; $("#scrim").hidden = false; renderDrawer();
  const d = doors.get(id);
  const [vr, nr] = await Promise.all([sb.from("visits").select("*").eq("door_id", id).order("at"), sb.from("notes").select("*").eq("door_id", id).order("at")]);
  const photos = await Promise.all((d?.photos || []).map((p) => sync.photoUrl(p).catch(() => null)));
  if (openId !== id) return;
  drawerData = { visits: vr.data || [], notes: nr.data || [], photos: photos.filter(Boolean) };
  renderDrawer();
}
function closeJob() { openId = null; $("#drawer").hidden = true; $("#drawer").innerHTML = ""; $("#scrim").hidden = true; }
function renderDrawer() {
  const d = doors.get(openId); if (!d) return closeJob();
  const j = jobs.get(d.id) || {}, st = stageOf(d);
  const repNames = [...new Set(reps.map((r) => r.name).filter(Boolean))];
  const dTasks = tasks.filter((t) => t.door_id === d.id);
  const events = [
    ...drawerData.visits.map((v) => ({ at: v.at, who: v.rep_name, kind: OUTCOME[v.outcome] || v.outcome, body: [v.details?.reason, v.details?.slot ? "Inspection " + slotLabel(v.details.slot) : ""].filter(Boolean).join(" · "), field: true })),
    ...drawerData.notes.map((n) => ({ at: n.at, who: n.by_name, kind: { note: "Note", call: "Call", text: "Text", email: "Email" }[n.kind] || n.kind, body: n.body })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const ph = digits(d.phone);
  $("#drawer").innerHTML = `<div class="d-head"><div><h2>${esc(d.name || d.address)}</h2><div class="muted">${esc(d.address)}${d.city ? ", " + esc(d.city) : ""} ${esc(d.zip || "")}</div></div><button class="x" data-act="close" aria-label="Close">×</button></div>
    <div class="contact-links">
      ${ph ? `<a class="btn small" href="tel:${ph}">Call</a><a class="btn small" href="sms:${ph}">Text</a>` : ""}
      ${d.email ? `<a class="btn small" href="mailto:${esc(d.email)}">Email</a>` : ""}
      <a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${d.address}, ${d.city || ""} ${d.zip || ""}`)}">Directions</a>
    </div>
    <div class="sec"><div class="fields">
      <div class="field"><label for="j-stage">Stage</label><select id="j-stage">${ALL_STAGES.map((s) => `<option value="${s.key}" ${s.key === st ? "selected" : ""}>${esc(s.label)}</option>`).join("")}</select></div>
      <div class="field"><label>Field outcome</label><input value="${esc(OUTCOME[d.status] || d.status)}${d.slot ? " · " + esc(slotLabel(d.slot)) : ""}" disabled></div>
    </div>${st === "lost" && j.lost_reason ? `<p class="muted">Lost: ${esc(j.lost_reason)}</p>` : ""}</div>

    <form class="sec" id="f-job"><div class="label">Job</div><div class="fields">
      <div class="field"><label for="j-value">Job value ($)</label><input id="j-value" type="number" inputmode="decimal" min="0" step="1" value="${esc(j.value ?? "")}"></div>
      <div class="field"><label for="j-assigned">Owner</label><select id="j-assigned"><option value="">—</option>${repNames.map((n) => `<option ${n === (j.assigned_to || "") ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
      <div class="field"><label for="j-insurer">Insurance company</label><input id="j-insurer" value="${esc(j.insurer || [...new Set((d.vehicles || []).map((v) => v.insurer).filter(Boolean))].join(", "))}"></div>
      <div class="field"><label for="j-claim">Claim #</label><input id="j-claim" value="${esc(j.claim_number || "")}"></div>
      <div class="field"><label for="j-adjuster">Adjuster</label><input id="j-adjuster" value="${esc(j.adjuster || "")}"></div>
      <div class="field"><label for="j-adjphone">Adjuster phone</label><input id="j-adjphone" type="tel" value="${esc(j.adjuster_phone || "")}"></div>
      <div class="field"><label for="j-deductible">Deductible ($)</label><input id="j-deductible" type="number" min="0" step="1" value="${esc(j.deductible ?? "")}"></div>
      <div class="field"><label for="j-next-due">Next step due</label><input id="j-next-due" type="date" value="${esc(j.next_step_due || "")}"></div>
      <div class="field wide"><label for="j-next">Next step</label><input id="j-next" placeholder="e.g. Call adjuster for approval" value="${esc(j.next_step || "")}"></div>
    </div><div style="margin-top:10px"><button class="btn go">Save job</button></div></form>

    <form class="sec" id="f-contact"><div class="label">Customer</div><div class="fields">
      <div class="field"><label for="c-name">Name</label><input id="c-name" value="${esc(d.name || "")}"></div>
      <div class="field"><label for="c-phone">Phone</label><input id="c-phone" type="tel" value="${esc(d.phone || "")}"></div>
      <div class="field wide"><label for="c-email">Email</label><input id="c-email" type="email" value="${esc(d.email || "")}"></div>
    </div><p class="muted" style="margin:8px 0 0">Prefers ${esc(d.contact_pref || "text")} · ${d.consent ? "OK to text reminders" : "no text consent"}</p>
    <div style="margin-top:8px"><button class="btn">Save customer</button></div></form>

    <div class="sec"><div class="label">Vehicles and damage</div>
      ${(d.vehicles || []).filter((v) => v.ymm || v.panels?.length).map((v) => `<div class="veh"><b>${esc(v.ymm || "Vehicle")}</b>${v.vin ? ` · <span class="muted">VIN ${esc(v.vin)}</span>` : ""}<br>${esc((v.panels || []).join(", ") || "No panels marked")}${v.sev ? ` · ${esc(v.sev)}` : ""}${v.insurer ? ` · ${esc(v.insurer)}` : ""}${v.claim ? ` · claim ${esc(v.claim)}` : ""}</div>`).join("") || `<p class="muted">No vehicles logged yet.</p>`}
      ${drawerData.photos.length ? `<div class="photos">${drawerData.photos.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Damage photo"></a>`).join("")}</div>` : ""}
      ${d.notes ? `<p><span class="muted">Field notes:</span> ${esc(d.notes)}</p>` : ""}
    </div>

    <div class="sec"><div class="label">Estimates and invoices</div>
      ${docs.filter((k) => k.door_id === d.id).map(docRow).join("") || `<p class="muted">None yet.</p>`}
      <div class="inline" style="margin-top:6px"><button class="btn small" data-act="new-estimate">New estimate</button><button class="btn small" data-act="new-invoice">New invoice</button></div>
    </div>

    <div class="sec"><div class="label">Tasks</div>
      ${dTasks.map(taskRow).join("") || `<p class="muted">No tasks.</p>`}
      <form class="inline" id="f-task"><input id="t-title" placeholder="Add a task" required><input id="t-due" type="date" value="${today()}" style="flex:0 0 150px"><button class="btn">Add</button></form>
    </div>

    <div class="sec"><div class="label">Activity</div>
      <form class="note-form" id="f-note"><div class="kinds">${["call", "text", "email", "note"].map((k) => `<button type="button" data-kind="${k}" aria-pressed="${noteKind === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join("")}</div>
        <div class="field"><textarea id="n-body" placeholder="What happened? e.g. Talked to Mike, adjuster coming Thursday" required></textarea></div><div><button class="btn">Log ${noteKind}</button></div></form>
      <div class="timeline">${events.map((e) => `<div class="ev"><time>${esc(fmtWhen(e.at))}</time><div><span class="kind">${esc(e.kind)}</span>${e.field ? ' <span class="muted">· field</span>' : ""}${e.who ? ` <span class="muted">· ${esc(e.who)}</span>` : ""}${e.body ? `<div>${esc(e.body)}</div>` : ""}</div></div>`).join("") || `<p class="muted">Loading…</p>`}</div>
    </div>`;
}

/* ---------- billing ---------- */
const kindLabel = (k) => (k.kind === "invoice" ? "Invoice" : "Estimate");
function docRow(k) {
  const t = totals(k), d = doors.get(k.door_id);
  return `<div class="task" data-doc="${k.id}" style="cursor:pointer"><div class="t-main"><div class="t-title"><b>${esc(kindLabel(k))} ${esc(k.number)}</b> · ${usd(t.total)}</div>
    <div class="t-sub">${esc(STATUS_LABEL[k.status] || k.status)}${k.kind === "invoice" && t.paid && t.balance > 0 ? ` · ${usd(t.balance)} due` : ""} · ${esc(fmtDate(k.issued))}${view === "billing" && d ? ` · ${esc(d.name || d.address)}` : ""}</div></div></div>`;
}
function billingView() {
  const month = today().slice(0, 7);
  const inv = docs.filter((k) => k.kind === "invoice" && k.status !== "void");
  const outstanding = inv.reduce((t, k) => t + Math.max(0, totals(k).balance), 0);
  const invoicedMonth = inv.filter((k) => (k.issued || "").startsWith(month)).reduce((t, k) => t + totals(k).total, 0);
  const collectedMonth = inv.reduce((t, k) => t + (k.payments || []).filter((p) => (p.date || "").startsWith(month)).reduce((a, p) => a + (Number(p.amount) || 0), 0), 0);
  const openEst = docs.filter((k) => k.kind === "estimate" && ["draft", "sent"].includes(k.status));
  const overdue = inv.filter((k) => k.due && k.due < today() && totals(k).balance > 0 && k.status !== "draft");
  const list = docs.filter((k) => {
    const d = doors.get(k.door_id);
    if (q && ![k.number, d?.name, d?.address, d?.phone].join(" ").toLowerCase().includes(q.toLowerCase())) return false;
    if (billFilter === "open") return k.kind === "estimate" ? ["draft", "sent"].includes(k.status) : !["paid", "void"].includes(k.status);
    if (billFilter === "estimates") return k.kind === "estimate";
    if (billFilter === "invoices") return k.kind === "invoice";
    return true;
  });
  return `<div class="kpis">
      <div class="kpi"><div class="v">${usd(outstanding)}</div><div class="k">Unpaid invoices${overdue.length ? ` · <b style="color:var(--bad)">${overdue.length} overdue</b>` : ""}</div></div>
      <div class="kpi"><div class="v">${usd(invoicedMonth)}</div><div class="k">Invoiced this month</div></div>
      <div class="kpi"><div class="v">${usd(collectedMonth)}</div><div class="k">Collected this month</div></div>
      <div class="kpi"><div class="v">${usd(openEst.reduce((t, k) => t + totals(k).total, 0))}</div><div class="k">${openEst.length} open estimate${openEst.length === 1 ? "" : "s"}</div></div>
    </div>
    <div class="row-actions"><div class="period">${[["open", "Open"], ["estimates", "Estimates"], ["invoices", "Invoices"], ["all", "All"]].map(([k, l]) => `<button data-bill="${k}" aria-pressed="${billFilter === k}">${l}</button>`).join("")}</div>
      <span class="muted">Create estimates and invoices from a job: open it in Pipeline or Contacts.</span></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Balance</th></tr></thead><tbody>
      ${list.map((k) => { const t = totals(k), d = doors.get(k.door_id), late = k.kind === "invoice" && k.due && k.due < today() && t.balance > 0 && !["draft", "void"].includes(k.status);
        return `<tr data-doc="${k.id}"><td><b>${esc(k.number)}</b><div class="muted">${esc(kindLabel(k))}</div></td><td>${esc(d?.name || d?.address || "")}</td><td>${esc(fmtDate(k.issued))}</td>
          <td ${late ? 'style="color:var(--bad);font-weight:700"' : ""}>${esc(fmtDate(k.due))}${late ? " · overdue" : ""}</td><td>${esc(STATUS_LABEL[k.status] || k.status)}</td>
          <td class="num">${usd(t.total)}</td><td class="num">${k.kind === "invoice" ? usd(t.balance) : ""}</td></tr>`; }).join("") || `<tr><td colspan="7" class="muted">Nothing here yet.</td></tr>`}
    </tbody></table></div>`;
}

function openDoc(doc) { editDoc = JSON.parse(JSON.stringify(doc)); renderDoc(); $("#docmodal").hidden = false; }
function closeDoc() { editDoc = null; $("#docmodal").hidden = true; $("#docmodal").innerHTML = ""; }
function startDoc(kind, fromEstimate) {
  const d = doors.get(fromEstimate?.door_id || openId);
  openDoc(newDoc(kind, { door: d, job: jobs.get(d.id), docs, today: today(), by: me.name, fromEstimate }));
  if (!editDoc.lines.length) toast("No damaged panels logged for this customer, so add the lines yourself.");
}
function docTotalsHtml() {
  const t = totals(editDoc), inv = editDoc.kind === "invoice";
  return `<div><span>Subtotal</span><b>${usd(t.subtotal)}</b></div>${t.discount ? `<div><span>Discount</span><b>−${usd(t.discount)}</b></div>` : ""}${t.tax ? `<div><span>Tax</span><b>${usd(t.tax)}</b></div>` : ""}
    <div class="grand"><span>Total</span><b>${usd(t.total)}</b></div>
    ${inv ? `<div><span>Paid</span><b>${usd(t.paid)}</b></div><div class="grand"><span>Balance due</span><b>${usd(t.balance)}</b></div>` : ""}
    ${t.deductible !== null ? `<div class="muted"><span>Insurance pays</span><b>${usd(t.insurance)}</b></div><div class="muted"><span>Customer deductible</span><b>${usd(t.deductible)}</b></div>` : ""}`;
}
function renderDoc() {
  const k = editDoc, d = doors.get(k.door_id), inv = k.kind === "invoice";
  const statuses = inv ? ["draft", "sent", "void"] : ["draft", "sent", "accepted", "declined"];
  const auto = inv && ["partial", "paid"].includes(k.status);
  $("#docmodal").innerHTML = `<div class="doc-card">
    <div class="d-head"><div><h2>${inv ? "Invoice" : "Estimate"} ${esc(k.number)}</h2><div class="muted">${esc(d?.name || "")} · ${esc(d?.address || "")}</div></div><button class="x" data-act="close-doc" aria-label="Close">×</button></div>
    <div class="fields" style="grid-template-columns:repeat(4,1fr);margin-top:12px">
      <div class="field"><label>Status</label>${auto ? `<input value="${esc(STATUS_LABEL[k.status])}" disabled>` : `<select data-doc-f="status">${statuses.map((x) => `<option value="${x}" ${x === k.status ? "selected" : ""}>${STATUS_LABEL[x]}</option>`).join("")}</select>`}</div>
      <div class="field"><label>${inv ? "Issued" : "Date"}</label><input type="date" data-doc-f="issued" value="${esc(k.issued)}"></div>
      <div class="field"><label>${inv ? "Due" : "Valid until"}</label><input type="date" data-doc-f="due" value="${esc(k.due || "")}"></div>
      <div class="field"><label>Number</label><input data-doc-f="number" value="${esc(k.number)}"></div>
    </div>
    <table class="lines"><thead><tr><th>Description</th><th class="num" style="width:80px">Qty</th><th class="num" style="width:120px">Price</th><th class="num" style="width:110px">Amount</th><th style="width:36px"></th></tr></thead><tbody>
      ${k.lines.map((l, i) => `<tr><td><input data-line="${i}" data-lf="desc" value="${esc(l.desc)}" placeholder="e.g. 2021 Ford F-150: Hood, paintless dent repair"></td>
        <td><input data-line="${i}" data-lf="qty" type="number" step="any" min="0" value="${esc(l.qty)}" class="num"></td>
        <td><input data-line="${i}" data-lf="price" type="number" step="0.01" value="${esc(l.price)}" class="num"></td>
        <td class="num" data-amt="${i}">${usd((Number(l.qty) || 0) * (Number(l.price) || 0))}</td><td><button class="x" style="font-size:20px" data-act="del-line" data-i="${i}" aria-label="Remove line">×</button></td></tr>`).join("")}
    </tbody></table>
    <div class="inline" style="margin:8px 0 14px"><button class="btn small" data-act="add-line">Add line</button><button class="btn small" data-act="fill-lines">Fill from damage logged</button></div>
    <div class="doc-bottom"><div class="fields" style="grid-template-columns:1fr 1fr 1fr;align-content:start">
        <div class="field"><label>Discount ($)</label><input type="number" min="0" step="0.01" data-doc-f="discount" value="${esc(k.discount || 0)}"></div>
        <div class="field"><label>Tax rate (%)</label><input type="number" min="0" step="0.001" data-doc-f="tax_rate" value="${esc(k.tax_rate || 0)}"></div>
        <div class="field"><label>Customer deductible ($)</label><input type="number" min="0" step="0.01" data-doc-f="deductible" value="${esc(k.deductible ?? "")}" placeholder="if insurance pays"></div>
        <div class="field wide"><label>Notes for the customer</label><textarea data-doc-f="notes">${esc(k.notes || "")}</textarea></div>
        <div class="field wide"><label>Terms</label><textarea data-doc-f="terms">${esc(k.terms || "")}</textarea></div>
      </div><div class="doc-totals" id="doc-totals">${docTotalsHtml()}</div></div>
    ${inv ? `<div class="sec"><div class="label">Payments</div>
      ${(k.payments || []).map((p, i) => `<div class="task"><div class="t-main"><b>${usd(p.amount)}</b> · ${esc(p.method || "")} · ${esc(fmtDate(p.date))}${p.note ? ` · ${esc(p.note)}` : ""}</div><button class="x" style="font-size:20px" data-act="del-pay" data-i="${i}" aria-label="Remove payment">×</button></div>`).join("") || `<p class="muted">No payments yet.</p>`}
      <div class="inline pay-form"><input type="date" id="pay-date" value="${today()}" style="flex:0 0 150px"><input type="number" id="pay-amt" step="0.01" min="0" placeholder="Amount" value="${Math.max(0, totals(k).balance) || ""}" style="flex:0 0 120px">
        <select id="pay-method">${CONFIG.billing.paymentMethods.map((m) => `<option>${esc(m)}</option>`).join("")}</select><input id="pay-note" placeholder="Check # / note"><button class="btn small" data-act="add-pay">Record payment</button></div></div>` : ""}
    <div class="doc-actions"><button class="btn go" data-act="save-doc">Save</button><button class="btn" data-act="print-doc">Print / PDF</button>
      ${d?.email ? `<button class="btn" data-act="email-doc">Email</button>` : ""}${digits(d?.phone) ? `<button class="btn" data-act="text-doc">Text</button>` : ""}
      ${!inv && k.id ? `<button class="btn" data-act="to-invoice">Convert to invoice</button>` : ""}
      ${k.id && k.status === "draft" ? `<button class="btn danger" data-act="del-doc">Delete draft</button>` : ""}</div>
  </div>`;
}
async function saveDoc(quiet) {
  const k = editDoc, before = docs.find((x) => x.id === k.id);
  k.lines = k.lines.filter((l) => String(l.desc).trim() || Number(l.price));
  k.status = statusAfterPayments(k);
  const row = { ...k }; delete row.created_at; delete row.updated_at;
  for (const f of ["discount", "tax_rate"]) row[f] = Number(row[f]) || 0;
  row.deductible = row.deductible === "" || row.deductible === null || row.deductible === undefined ? null : Number(row.deductible);
  row.due = row.due || null;
  let res = await sb.from("documents").upsert(row).select().single();
  if (res.error && /23505|duplicate/i.test(res.error.code + res.error.message) && !k.id) { row.number = nextNumber(docs, k.kind); res = await sb.from("documents").upsert(row).select().single(); }
  if (res.error) throw res.error;
  const saved = res.data;
  docs = [saved, ...docs.filter((x) => x.id !== saved.id)];
  editDoc = JSON.parse(JSON.stringify(saved));
  // Keep the job in step: accepted estimates and invoices set the job value; a paid invoice moves the job to Paid
  const t = totals(saved), label = `${kindLabel(saved)} ${saved.number}`;
  const was = before?.status;
  if (saved.kind === "estimate" && saved.status === "accepted" && was !== "accepted") { await saveJob(saved.door_id, { value: t.total }); await addNote(saved.door_id, "note", `${label} accepted · ${usd(t.total)}`); }
  if (saved.kind === "invoice" && !before) await saveJob(saved.door_id, { value: t.total });
  if (saved.status === "sent" && was !== "sent" && saved.kind) await addNote(saved.door_id, "note", `${label} marked sent · ${usd(t.total)}`);
  if (saved.kind === "invoice" && saved.status === "paid" && was !== "paid") {
    await saveJob(saved.door_id, { value: t.total, ...(CONFIG.pipeline.some((s) => s.key === "paid") ? { stage: "paid", stage_changed_at: new Date().toISOString() } : {}) });
    await addNote(saved.door_id, "note", `${label} paid in full · ${usd(t.total)}`);
  }
  if (!quiet) toast(`${label} saved`);
  render(); if (openId) renderDrawer();
  return saved;
}
function printDoc() {
  const d = doors.get(editDoc.door_id);
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.srcdoc = printHtml(editDoc, d, jobs.get(d.id));
  f.onload = () => { const img = f.contentDocument.querySelector("img"); const go = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); }; img && !img.complete ? (img.onload = img.onerror = go) : go(); };
  document.body.append(f);
}
function docMessage() {
  const k = editDoc, d = doors.get(k.door_id), t = totals(k), first = (d?.name || "").split(" ")[0] || "there";
  return k.kind === "invoice"
    ? `Hi ${first}, here is invoice ${k.number} from ${CONFIG.company} for ${usd(t.total)}${t.paid ? ` (balance ${usd(t.balance)})` : ""}${k.due ? `, due ${fmtDate(k.due)}` : ""}. Thank you for your business!`
    : `Hi ${first}, here is estimate ${k.number} from ${CONFIG.company} for your hail repair: ${usd(t.total)}${t.deductible !== null ? ` (your deductible ${usd(t.deductible)}, insurance ${usd(t.insurance)})` : ""}. Reply with any questions or to schedule the repair.`;
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target;
  const tab = t.closest("#tabs button"); if (tab) { view = tab.dataset.view; render(); return; }
  const per = t.closest("[data-period]"); if (per) { period = per.dataset.period; await loadAll().catch((er) => toast(errText(er))); render(); return; }
  const open = t.closest("[data-open]"); if (open) { e.preventDefault(); openJob(open.dataset.open); return; }
  const kind = t.closest("[data-kind]"); if (kind) { noteKind = kind.dataset.kind; renderDrawer(); return; }
  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "close" || t.id === "scrim") return closeJob();
  if (act === "toggle-lost") { showLost = !showLost; return render(); }
  if (act === "export") return exportCsv();
  const bill = t.closest("[data-bill]"); if (bill) { billFilter = bill.dataset.bill; return render(); }
  if (act === "new-estimate" || act === "new-invoice") return startDoc(act === "new-invoice" ? "invoice" : "estimate");
  if (act === "close-doc") return closeDoc();
  if (editDoc && act) {
    try {
      if (act === "add-line") { editDoc.lines.push({ desc: "", qty: 1, price: 0 }); renderDoc(); $(`[data-line="${editDoc.lines.length - 1}"][data-lf="desc"]`)?.focus(); }
      if (act === "del-line") { editDoc.lines.splice(+t.closest("[data-i]").dataset.i, 1); renderDoc(); }
      if (act === "fill-lines") { const add = linesFromVehicles(doors.get(editDoc.door_id)?.vehicles); if (!add.length) toast("No damaged panels logged for this customer."); editDoc.lines.push(...add); renderDoc(); }
      if (act === "add-pay") {
        const amount = Number($("#pay-amt").value); if (!amount) return toast("Enter the payment amount");
        editDoc.payments = [...(editDoc.payments || []), { date: $("#pay-date").value || today(), amount, method: $("#pay-method").value, note: $("#pay-note").value.trim() }];
        await saveDoc(true); await addNote(editDoc.door_id, "note", `Payment ${usd(amount)} · ${$("#pay-method")?.value || ""} on ${editDoc.number}`.trim()); renderDoc(); toast("Payment recorded");
      }
      if (act === "del-pay") { if (!confirm("Remove this payment?")) return; editDoc.payments.splice(+t.closest("[data-i]").dataset.i, 1); await saveDoc(true); renderDoc(); }
      if (act === "save-doc") { await saveDoc(); renderDoc(); }
      if (act === "print-doc") { await saveDoc(true); renderDoc(); printDoc(); }
      if (act === "email-doc" || act === "text-doc") {
        if (editDoc.status === "draft") editDoc.status = "sent";
        await saveDoc(true); renderDoc();
        const d = doors.get(editDoc.door_id), msg = docMessage();
        if (act === "email-doc") { location.href = `mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent(`${kindLabel(editDoc)} ${editDoc.number} from ${CONFIG.company}`)}&body=${encodeURIComponent(msg + "\n\n(PDF attached)")}`; toast("Email opened. Use Print / PDF to save the PDF and attach it."); }
        else location.href = `sms:${digits(d.phone)}&body=${encodeURIComponent(msg)}`;
      }
      if (act === "to-invoice") { const est = await saveDoc(true); const existing = docs.find((x) => x.kind === "invoice" && x.from_estimate === est.id); if (existing) { toast(`Already invoiced as ${existing.number}`); return openDoc(existing); } closeDoc(); startDoc("invoice", est); }
      if (act === "del-doc") { if (!confirm(`Delete draft ${editDoc.number}?`)) return; const { error } = await sb.from("documents").delete().eq("id", editDoc.id); if (error) throw error; docs = docs.filter((x) => x.id !== editDoc.id); closeDoc(); render(); if (openId) renderDrawer(); }
    } catch (er) { toast(errText(er)); }
    return;
  }
  const docEl = t.closest("[data-doc]"); if (docEl) { const k = docs.find((x) => x.id === docEl.dataset.doc); if (k) openDoc(k); return; }
  if (act === "signout") { await sync.signOut(); location.reload(); return; }
  const c = t.closest(".card, tbody tr[data-id]"); if (c && !t.closest("a")) openJob(c.dataset.id);
});
$("#scrim").addEventListener("click", closeJob);
document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; if (editDoc) closeDoc(); else if (openId) closeJob(); });
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "j-stage") return setStage(openId, t.value);
  if (t.id === "rep-filter") { repFilter = t.value; return render(); }
  if (t.dataset.task) {
    const done = t.checked;
    const { error } = await sb.from("tasks").update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", t.dataset.task);
    if (error) return toast(errText(error));
    const tk = tasks.find((x) => x.id === t.dataset.task); if (tk) Object.assign(tk, { done, done_at: done ? new Date().toISOString() : null });
    render(); if (openId) renderDrawer();
  }
});
$("#q").addEventListener("input", (e) => { q = e.target.value.trim(); render(); });
// Document editor: fields update in place and the totals follow as you type
document.addEventListener("input", (e) => {
  const t = e.target; if (!editDoc || !t.closest("#docmodal")) return;
  if (t.dataset.line != null) { const l = editDoc.lines[+t.dataset.line]; l[t.dataset.lf] = t.dataset.lf === "desc" ? t.value : t.value === "" ? "" : Number(t.value); const a = $(`[data-amt="${t.dataset.line}"]`); if (a) a.textContent = usd((Number(l.qty) || 0) * (Number(l.price) || 0)); }
  else if (t.dataset.docF) editDoc[t.dataset.docF] = t.value;
  else return;
  $("#doc-totals").innerHTML = docTotalsHtml();
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.id, num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Number(v); };
  try {
    if (f === "f-signin") {
      await sync.signInPassword($("#g-email").value.trim(), $("#g-pass").value);
      return afterSignIn();
    }
    if (f === "f-name") { await sync.saveProfile($("#g-name").value.trim()); return afterSignIn(); }
    if (f === "f-job") {
      await saveJob(openId, { value: num("#j-value"), deductible: num("#j-deductible"), insurer: $("#j-insurer").value.trim(), claim_number: $("#j-claim").value.trim(),
        adjuster: $("#j-adjuster").value.trim(), adjuster_phone: $("#j-adjphone").value.trim(), assigned_to: $("#j-assigned").value, next_step: $("#j-next").value.trim(), next_step_due: $("#j-next-due").value || null });
      toast("Job saved"); render(); renderDrawer();
    }
    if (f === "f-contact") {
      const patch = { name: $("#c-name").value.trim(), phone: $("#c-phone").value.trim(), email: $("#c-email").value.trim() };
      const { error } = await sb.from("doors").update(patch).eq("id", openId); if (error) throw error;
      Object.assign(doors.get(openId), patch); toast("Customer saved"); render(); renderDrawer();
    }
    if (f === "f-task" || f === "f-task-general") {
      const gen = f === "f-task-general";
      const row = { title: $(gen ? "#tg-title" : "#t-title").value.trim(), due: $(gen ? "#tg-due" : "#t-due").value || null, door_id: gen ? null : openId, assigned_to: jobs.get(openId)?.assigned_to || me.name, created_by_name: me.name };
      const { data, error } = await sb.from("tasks").insert(row).select().single(); if (error) throw error;
      tasks.push(data); toast("Task added"); render(); if (openId) renderDrawer();
    }
    if (f === "f-note") {
      const body = $("#n-body").value.trim(); if (!body) return;
      drawerData.notes.push(await addNote(openId, noteKind, body)); renderDrawer();
    }
  } catch (er) {
    if (f === "f-signin" || f === "f-name") return gate(/invalid login/i.test(er.message) ? "Email or password is wrong." : errText(er), f === "f-name");
    toast(errText(er));
  }
});

/* ---------- drag and drop between stages ---------- */
document.addEventListener("dragstart", (e) => { const c = e.target.closest?.(".card"); if (!c) return; e.dataTransfer.setData("text/plain", c.dataset.id); c.classList.add("dragging"); });
document.addEventListener("dragend", (e) => e.target.closest?.(".card")?.classList.remove("dragging"));
document.addEventListener("dragover", (e) => { const col = e.target.closest?.(".col"); if (!col) return; e.preventDefault(); document.querySelectorAll(".col.over").forEach((x) => x !== col && x.classList.remove("over")); col.classList.add("over"); });
document.addEventListener("dragleave", (e) => { const col = e.target.closest?.(".col"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("over"); });
document.addEventListener("drop", (e) => { const col = e.target.closest?.(".col"); if (!col) return; e.preventDefault(); col.classList.remove("over"); const id = e.dataTransfer.getData("text/plain"); if (id) setStage(id, col.dataset.stage); });

/* ---------- sign-in ---------- */
function toast(m) { const el = $("#toast"); el.textContent = m; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 3500); }
function gate(msg, askName) {
  $("#tabs").hidden = true; $("#toolbar").hidden = true;
  $("#main").innerHTML = askName ? `<form class="gate" id="f-name"><h1>What's your name?</h1>${msg ? `<div class="notice err">${esc(msg)}</div>` : ""}
      <div class="field"><label for="g-name">First and last name</label><input id="g-name" required></div><button class="btn go">Continue</button></form>`
    : `<form class="gate" id="f-signin"><h1>Office sign-in</h1><p class="muted">Same email and password as the Knock app.</p>${msg ? `<div class="notice err">${esc(msg)}</div>` : ""}
      <div class="field"><label for="g-email">Email</label><input id="g-email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="g-pass">Password</label><input id="g-pass" type="password" autocomplete="current-password" required></div>
      <button class="btn go">Sign in</button></form>`;
}
async function afterSignIn() {
  const p = await Promise.race([sync.loadProfile(), new Promise((r) => setTimeout(r, 8000, null))]).catch(() => null);
  if (!p?.name) return gate("", true);
  me = { id: sync.user.id, name: p.name };
  $("#who").innerHTML = `${esc(me.name)}<button data-act="signout">Sign out</button>`;
  $("#tabs").hidden = false; $("#toolbar").hidden = false;
  try { await loadAll(); } catch (e) { $("#main").innerHTML = `<div class="gate"><div class="notice err">${esc(errText(e))}</div></div>`; return; }
  render();
  sb.channel("office").on("postgres_changes", { event: "*", schema: "public", table: "doors" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, scheduleReload).subscribe();
  setInterval(scheduleReload, 60000);
}
(async function start() {
  const live = await sync.init();
  if (!live) { $("#main").innerHTML = `<div class="gate"><div class="notice err">The office needs the team database. Check the Supabase settings in js/config.js.</div></div>`; return; }
  sb = sync.client;
  if (!sync.user) return gate();
  afterSignIn();
})();
