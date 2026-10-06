// Estimates and invoices: math, line items from the field's damage notes, numbering, and the printable page.
import { CONFIG } from "./config.js";

const B = CONFIG.billing;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const usd = (n) => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const phone = (s) => { const d = String(s || "").replace(/\D/g, "").slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : s; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function totals(doc) {
  const subtotal = r2((doc.lines || []).reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.price) || 0), 0));
  const discount = r2(Math.min(Number(doc.discount) || 0, subtotal));
  const tax = r2(((subtotal - discount) * (Number(doc.tax_rate) || 0)) / 100);
  const total = r2(subtotal - discount + tax);
  const paid = r2((doc.payments || []).reduce((t, p) => t + (Number(p.amount) || 0), 0));
  const deductible = doc.deductible === null || doc.deductible === "" || doc.deductible === undefined ? null : r2(doc.deductible);
  return { subtotal, discount, tax, total, paid, balance: r2(total - paid), deductible, insurance: deductible === null ? null : r2(Math.max(0, total - deductible)) };
}

// One line per damaged panel: base price × severity factor. A starting point the office edits.
export function linesFromVehicles(vehicles) {
  const lines = [];
  for (const v of vehicles || []) {
    const mult = B.severity[v.sev] ?? 1;
    for (const p of v.panels || []) {
      if (!(p in B.panelPrices) || !B.panelPrices[p]) continue;
      lines.push({ desc: `${v.ymm || "Vehicle"}: ${p}, paintless dent repair${v.sev ? ` (${v.sev.toLowerCase()} damage)` : ""}`, qty: 1, price: Math.round(B.panelPrices[p] * mult) });
    }
  }
  return lines;
}

export function nextNumber(docs, kind) {
  const prefix = kind === "invoice" ? "INV-" : "E-";
  const max = docs.filter((d) => d.kind === kind).reduce((m, d) => Math.max(m, parseInt(String(d.number).replace(/\D/g, ""), 10) || 0), 1000);
  return prefix + (max + 1);
}

const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
export function newDoc(kind, { door, job, docs, today, by, fromEstimate }) {
  const base = fromEstimate ? { lines: fromEstimate.lines.map((l) => ({ ...l })), discount: fromEstimate.discount, tax_rate: fromEstimate.tax_rate, deductible: fromEstimate.deductible, notes: fromEstimate.notes }
    : { lines: linesFromVehicles(door.vehicles), discount: 0, tax_rate: B.taxRate, deductible: job?.deductible ?? null, notes: "" };
  return {
    door_id: door.id, kind, number: nextNumber(docs, kind), status: "draft", issued: today,
    due: addDays(today, kind === "invoice" ? B.invoiceDueDays : B.estimateValidDays),
    payments: [], terms: kind === "invoice" ? B.invoiceTerms : B.estimateTerms, from_estimate: fromEstimate?.id || null, created_by_name: by, ...base,
  };
}

// Invoice status follows the payments; estimates keep the status the office set
export function statusAfterPayments(doc) {
  if (doc.kind !== "invoice" || doc.status === "void") return doc.status;
  const t = totals(doc);
  return t.total > 0 && t.balance <= 0 ? "paid" : t.paid > 0 ? "partial" : doc.status === "paid" || doc.status === "partial" ? "sent" : doc.status;
}

export const STATUS_LABEL = { draft: "Draft", sent: "Sent", accepted: "Accepted", declined: "Declined", partial: "Partly paid", paid: "Paid", void: "Void" };
const fmt = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";

// A self-contained printable page (print it or "Save as PDF" from the print dialog)
export function printHtml(doc, door, job) {
  const t = totals(doc), title = doc.kind === "invoice" ? "Invoice" : "Estimate";
  const logo = new URL("icon-512.png", location.href).href;
  const vehicles = (door.vehicles || []).filter((v) => v.ymm || v.vin);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} ${esc(doc.number)} · ${esc(CONFIG.company)}</title>
<style>
  @page{margin:16mm}
  body{font:13px/1.45 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#141A21;margin:0}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:3px solid #F2A900;padding-bottom:12px}
  .co{display:flex;gap:12px;align-items:center}.co img{width:96px;height:96px;object-fit:contain}
  .co b{font-size:18px}.muted{color:#56616E}
  h1{margin:0;font-size:28px;letter-spacing:.02em;text-align:right}
  .meta{text-align:right}
  .two{display:flex;gap:30px;margin:18px 0}.two>div{flex:1}
  .label{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#56616E;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#56616E;text-align:left;border-bottom:1px solid #D5DAE1;padding:6px 4px}
  td{padding:7px 4px;border-bottom:1px solid #EEF0F3;vertical-align:top}
  .num{text-align:right;white-space:nowrap}
  .sum{margin-left:auto;width:300px;margin-top:10px}.sum div{display:flex;justify-content:space-between;padding:3px 0}
  .sum .total{font-size:17px;font-weight:800;border-top:2px solid #141A21;margin-top:4px;padding-top:6px}
  .sum .split{display:block;background:#FFF6DB;border-radius:6px;padding:6px 10px;margin-top:8px}
  .terms{margin-top:24px;font-size:11.5px;color:#56616E}
  .sign{margin-top:36px;display:flex;gap:30px}.sign div{flex:1;border-top:1px solid #141A21;padding-top:4px;font-size:11px;color:#56616E}
  .stamp{display:inline-block;border:2px solid #167A43;color:#167A43;font-weight:800;padding:2px 10px;border-radius:6px;transform:rotate(-4deg);margin-top:6px}
</style></head><body>
<div class="head"><div class="co"><img src="${logo}" alt=""><div><b>${esc(CONFIG.company)}</b><div class="muted">Paintless dent repair</div>
  ${CONFIG.shopAddress ? `<div class="muted">${esc(CONFIG.shopAddress)}</div>` : ""}${CONFIG.shopPhone ? `<div class="muted">${esc(CONFIG.shopPhone)}</div>` : ""}</div></div>
  <div class="meta"><h1>${title.toUpperCase()}</h1><div><b>${esc(doc.number)}</b></div><div class="muted">${doc.kind === "invoice" ? "Issued" : "Date"}: ${fmt(doc.issued)}</div>
  ${doc.due ? `<div class="muted">${doc.kind === "invoice" ? "Due" : "Valid until"}: ${fmt(doc.due)}</div>` : ""}
  ${doc.status === "paid" ? `<div class="stamp">PAID</div>` : doc.status === "void" ? `<div class="stamp" style="color:#C2372F;border-color:#C2372F">VOID</div>` : ""}</div></div>
<div class="two"><div><div class="label">${doc.kind === "invoice" ? "Bill to" : "Prepared for"}</div><b>${esc(door.name || "")}</b><div>${esc(door.address || "")}</div><div>${esc([door.city, door.zip].filter(Boolean).join(" "))}</div>
  ${door.phone ? `<div>${esc(phone(door.phone))}</div>` : ""}${door.email ? `<div>${esc(door.email)}</div>` : ""}</div>
  <div><div class="label">Vehicle${vehicles.length === 1 ? "" : "s"}</div>${vehicles.map((v) => `<div>${esc(v.ymm || "")}${v.vin ? ` <span class="muted">VIN ${esc(v.vin)}</span>` : ""}</div>`).join("") || '<div class="muted">—</div>'}
  ${job?.insurer || job?.claim_number ? `<div class="label" style="margin-top:8px">Insurance</div><div>${esc(job.insurer || "")}${job.claim_number ? ` · Claim ${esc(job.claim_number)}` : ""}</div>` : ""}</div></div>
<table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
${(doc.lines || []).map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${esc(l.qty)}</td><td class="num">${usd(l.price)}</td><td class="num">${usd((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`).join("")}
</tbody></table>
<div class="sum"><div><span>Subtotal</span><span>${usd(t.subtotal)}</span></div>
  ${t.discount ? `<div><span>Discount</span><span>−${usd(t.discount)}</span></div>` : ""}
  ${t.tax ? `<div><span>Tax (${esc(doc.tax_rate)}%)</span><span>${usd(t.tax)}</span></div>` : ""}
  <div class="total"><span>Total</span><span>${usd(t.total)}</span></div>
  ${doc.kind === "invoice" && t.paid ? `<div><span>Paid</span><span>−${usd(t.paid)}</span></div><div style="font-weight:800"><span>Balance due</span><span>${usd(t.balance)}</span></div>` : ""}
  ${t.deductible !== null ? `<div class="split"><div><span>Insurance portion</span><span>${usd(t.insurance)}</span></div><div><span>Customer deductible</span><span>${usd(t.deductible)}</span></div></div>` : ""}
</div>
${doc.kind === "invoice" && (doc.payments || []).length ? `<div class="label" style="margin-top:18px">Payments</div><table><tbody>${doc.payments.map((p) => `<tr><td>${fmt(p.date)}</td><td>${esc(p.method || "")}${p.note ? ` · ${esc(p.note)}` : ""}</td><td class="num">${usd(p.amount)}</td></tr>`).join("")}</tbody></table>` : ""}
${doc.notes ? `<div class="label" style="margin-top:18px">Notes</div><div>${esc(doc.notes).replace(/\n/g, "<br>")}</div>` : ""}
${doc.terms ? `<div class="terms">${esc(doc.terms)}</div>` : ""}
${doc.kind === "estimate" ? `<div class="sign"><div>Customer approval</div><div>Date</div></div>` : ""}
</body></html>`;
}
