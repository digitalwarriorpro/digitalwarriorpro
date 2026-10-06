// Office CRM on the team database: pipeline board, job page (claim, value, tasks, activity), contacts and reports.
// Field data (doors, visits) comes from the reps' phones; office data lives in jobs, tasks and notes.
import { CONFIG } from "./config.js";
import { sync } from "./sync.js";
import { toCsv } from "./addresses.js";

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
let doors = new Map(), jobs = new Map(), tasks = [], reps = [], periodVisits = [];
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
  const [jr, dr, tr, vr, rr] = await Promise.all([
    sb.from("jobs").select("*"),
    sb.from("doors").select("*").in("status", ["lead", "booked", "back"]),
    sb.from("tasks").select("*").order("due", { ascending: true, nullsFirst: false }),
    sb.from("visits").select("id,door_id,rep_name,outcome,at").gte("at", sinceIso).limit(20000),
    sync.reps(),
  ]);
  for (const r of [jr, dr, tr, vr]) if (r.error) throw r.error;
  jobs = new Map(jr.data.map((j) => [j.door_id, j]));
  doors = new Map(dr.data.map((d) => [d.id, d]));
  const missing = [...jobs.keys()].filter((id) => !doors.has(id));
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
  $("#main").innerHTML = view === "pipeline" ? pipelineView() : view === "contacts" ? contactsView() : view === "tasks" ? tasksView() : reportsView();
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
  if (act === "signout") { await sync.signOut(); location.reload(); return; }
  const c = t.closest(".card, tbody tr[data-id]"); if (c && !t.closest("a")) openJob(c.dataset.id);
});
$("#scrim").addEventListener("click", closeJob);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openId) closeJob(); });
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
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleReload).subscribe();
  setInterval(scheduleReload, 60000);
}
(async function start() {
  const live = await sync.init();
  if (!live) { $("#main").innerHTML = `<div class="gate"><div class="notice err">The office needs the team database. Check the Supabase settings in js/config.js.</div></div>`; return; }
  sb = sync.client;
  if (!sync.user) return gate();
  afterSignIn();
})();
