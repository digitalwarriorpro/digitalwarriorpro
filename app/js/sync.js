// Team sync through Supabase. The phone's local database is the source of truth while
// offline; queued changes are pushed in order, and other reps' changes are pulled in.
import { CONFIG } from "./config.js";
import { store } from "./store.js";

let sb = null;
let user = null;
let profile = null;
let handlers = { doors: () => {}, visits: () => {}, status: () => {} };
let pushing = false;
let channel = null;

export function connection() {
  let url = CONFIG.supabaseUrl, key = CONFIG.supabaseAnonKey;
  try {
    url = localStorage.getItem("knock.sbUrl") || url;
    key = localStorage.getItem("knock.sbKey") || key;
  } catch {}
  return { url, key, configured: !!(url && key) };
}
export function saveConnection(url, key) {
  try {
    localStorage.setItem("knock.sbUrl", url.trim());
    localStorage.setItem("knock.sbKey", key.trim());
  } catch {}
}

export const sync = {
  get enabled() { return !!sb; },
  get user() { return user; },
  get profile() { return profile; },
  on(evt, fn) { handlers[evt] = fn; },

  async init() {
    const c = connection();
    if (!c.configured || !window.supabase) return false;
    sb = window.supabase.createClient(c.url, c.key, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await sb.auth.getSession();
    user = data.session?.user || null;
    sb.auth.onAuthStateChange((_e, s) => { user = s?.user || null; });
    return true;
  },

  // Sign-in is email + password (set when Dano adds the rep). A 6-digit email code is the backup,
  // since Supabase's built-in mailer only sends a few emails an hour.
  async signInPassword(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    user = data.user;
  },
  async sendCode(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) throw error;
  },
  async verifyCode(email, token) {
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: "email" });
    if (error) throw error;
    user = data.user;
  },
  async signOut() { await sb?.auth.signOut(); user = null; profile = null; },

  async loadProfile() {
    if (!sb || !user) return null;
    const { data } = await sb.from("reps").select("*").eq("id", user.id).maybeSingle();
    profile = data;
    return profile;
  },
  // The rep row is what lets this account write team data. It's retried before every push,
  // so a slow or failed first save never blocks a rep from knocking.
  profileError: null,
  async saveProfile(name, ms = 10000) {
    const row = { id: user.id, name, email: user.email };
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try {
      const { data, error } = await sb.from("reps").upsert(row).select().abortSignal(ctl.signal).single();
      if (error) throw error;
      profile = data; this.profileError = null;
      return profile;
    } catch (e) {
      this.profileError = ctl.signal.aborted ? new Error("The team database didn't answer in time.") : e;
      throw this.profileError;
    } finally { clearTimeout(t); }
  },
  async reps() {
    if (!sb || !user) return [];
    const { data } = await sb.from("reps").select("id,name,active").order("name");
    return data || [];
  },

  // Team-wide settings (e.g. the property data key) live in the database, not in the published code.
  async getTeamSetting(key) {
    if (!sb || !user) return null;
    const { data } = await sb.from("app_settings").select("value").eq("key", key).maybeSingle();
    return data?.value ?? null;
  },
  async setTeamSetting(key, value) {
    const { error } = await sb.from("app_settings").upsert({ key, value });
    if (error) throw error;
  },

  async photoUrl(path) {
    if (!sb) return null;
    const { data } = await sb.storage.from("damage").createSignedUrl(path, 3600);
    return data?.signedUrl || null;
  },

  // Push queued changes in order. Stops at the first network failure and retries later.
  async push() {
    if (!sb || !user || pushing || !navigator.onLine) return;
    pushing = true;
    try {
      if (!profile) {
        let name = ""; try { name = localStorage.getItem("knock.repName") || ""; } catch {}
        if (!name) return;
        try { await this.saveProfile(name); } catch { return; }
      }
      const ops = await store.outbox();
      for (const op of ops) {
        let error = null;
        if (op.type === "door") ({ error } = await sb.from("doors").upsert(stripLocal(op.door)));
        else if (op.type === "doors_import") ({ error } = await sb.from("doors").upsert(op.doors.map(stripLocal), { onConflict: "id", ignoreDuplicates: true }));
        else if (op.type === "visit") ({ error } = await sb.from("visits").upsert(op.visit));
        else if (op.type === "visit_delete") ({ error } = await sb.from("visits").delete().eq("id", op.id));
        else if (op.type === "photo") ({ error } = await sb.storage.from("damage").upload(op.path, op.blob, { upsert: true, contentType: op.contentType }));
        if (error) {
          // A rejected row (bad data, permissions) would block the queue forever: park it and move on.
          if (isPermanent(error)) {
            console.warn("Dropped change the server refused", op, error);
            await store.setMeta("rejected:" + op.seq, { op: { ...op, blob: undefined }, error: error.message });
            await store.dequeue(op.seq);
            continue;
          }
          break;
        }
        await store.dequeue(op.seq);
      }
    } finally {
      pushing = false;
      handlers.status();
    }
  },

  async pull() {
    if (!sb || !user || !navigator.onLine) return;
    const since = (await store.getMeta("lastPull")) || "1970-01-01T00:00:00Z";
    const startedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // overlap guards clock skew
    let from = 0, all = [];
    for (;;) {
      const { data, error } = await sb.from("doors").select("*").gt("updated_at", since).order("updated_at").range(from, from + 999);
      if (error) return;
      all = all.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    if (all.length) await mergeDoors(all);
    await store.setMeta("lastPull", startedAt);

    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const { data: visits } = await sb.from("visits").select("*").gte("at", dayStart.toISOString());
    if (visits?.length) { await store.putVisits(visits); handlers.visits(); }
  },

  live() {
    if (!sb || !user || channel) return;
    channel = sb.channel("team")
      .on("postgres_changes", { event: "*", schema: "public", table: "doors" }, (p) => { if (p.new?.id) mergeDoors([p.new]); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "visits" }, async (p) => { await store.putVisits([p.new]); handlers.visits(); })
      .subscribe();
  },
};

function stripLocal(d) {
  const out = {};
  for (const k in d) if (!k.startsWith("_")) out[k] = d[k];
  return out;
}
function isPermanent(err) {
  const s = String(err.status || err.statusCode || err.code || "");
  return /^(4\d\d|22|23|42|PGRST)/.test(s) && !/^(401|408|429)$/.test(s);
}
// Remote rows win unless this phone still has unsent changes for that door.
async function mergeDoors(rows) {
  const pending = new Set((await store.outbox()).filter((o) => o.type === "door").map((o) => o.door.id));
  const take = rows.filter((r) => !pending.has(r.id));
  if (!take.length) return;
  await store.putDoors(take);
  handlers.doors(take);
}

window.addEventListener("online", () => { sync.push().then(() => sync.pull()); });
