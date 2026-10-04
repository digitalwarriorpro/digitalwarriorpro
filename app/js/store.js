// Local database on the phone (IndexedDB). Everything is saved here first, so the app works
// with no signal; sync.js pushes the outbox to Supabase when a connection comes back.

const DB_NAME = "knock";
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("doors")) db.createObjectStore("doors", { keyPath: "id" });
      if (!db.objectStoreNames.contains("visits")) {
        const v = db.createObjectStore("visits", { keyPath: "id" });
        v.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let out;
        Promise.resolve(fn(t)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  allDoors: () => tx(["doors"], "readonly", (t) => reqP(t.objectStore("doors").getAll())),
  putDoors: (doors) => tx(["doors"], "readwrite", (t) => { const s = t.objectStore("doors"); doors.forEach((d) => s.put(d)); }),
  allVisits: () => tx(["visits"], "readonly", (t) => reqP(t.objectStore("visits").getAll())),
  putVisits: (visits) => tx(["visits"], "readwrite", (t) => { const s = t.objectStore("visits"); visits.forEach((v) => s.put(v)); }),
  deleteVisit: (id) => tx(["visits"], "readwrite", (t) => t.objectStore("visits").delete(id)),

  // outbox: ordered list of changes waiting to reach the server
  enqueue: (op) => tx(["outbox"], "readwrite", (t) => reqP(t.objectStore("outbox").add({ ...op, queuedAt: new Date().toISOString() }))),
  outbox: () => tx(["outbox"], "readonly", (t) => reqP(t.objectStore("outbox").getAll())),
  dequeue: (seq) => tx(["outbox"], "readwrite", (t) => t.objectStore("outbox").delete(seq)),
  outboxCount: () => tx(["outbox"], "readonly", (t) => reqP(t.objectStore("outbox").count())),

  getMeta: (k) => tx(["meta"], "readonly", (t) => reqP(t.objectStore("meta").get(k))),
  setMeta: (k, v) => tx(["meta"], "readwrite", (t) => t.objectStore("meta").put(v, k)),
};
