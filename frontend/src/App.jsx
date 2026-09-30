import { useEffect, useState } from 'react';
import MapComponent from './components/MapComponent.jsx';
import { useStore, STAGES, OUTCOMES } from './store/store.js';
import { startLocationTracking } from './socket/client.js';
import { api } from './lib/api.js';

const label = (s) => s.replace(/_/g, ' ');

function ProspectForm({ onError }) {
  const pickedPoint = useStore((s) => s.pickedPoint);
  const myLocation = useStore((s) => s.myLocation);
  const setPickedPoint = useStore((s) => s.setPickedPoint);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });
  const [saving, setSaving] = useState(false);

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createProspect({ ...form, lat: pickedPoint?.lat, lng: pickedPoint?.lng });
      setForm({ name: '', phone: '', email: '', address: '' });
      setPickedPoint(null);
    } catch (err) {
      onError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const input = 'w-full rounded border border-slate-300 px-2 py-1 text-sm';
  return (
    <form onSubmit={submit} className="space-y-2">
      <h2 className="font-semibold">New prospect</h2>
      <input className={input} placeholder="Name *" value={form.name} onChange={update('name')} required />
      <input className={input} placeholder="Address *" value={form.address} onChange={update('address')} required />
      <div className="flex gap-2">
        <input className={input} placeholder="Phone" value={form.phone} onChange={update('phone')} />
        <input className={input} placeholder="Email" type="email" value={form.email} onChange={update('email')} />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>
          {pickedPoint ? `📍 ${pickedPoint.lat.toFixed(5)}, ${pickedPoint.lng.toFixed(5)}` : 'Click the map to set location'}
        </span>
        {myLocation && (
          <button type="button" className="text-sky-600 underline" onClick={() => setPickedPoint(myLocation)}>
            Use my GPS
          </button>
        )}
      </div>
      <button disabled={saving} className="w-full rounded bg-slate-900 py-1.5 text-sm font-medium text-white disabled:opacity-50">
        {saving ? 'Saving…' : 'Add prospect'}
      </button>
    </form>
  );
}

function ProspectDetail({ prospect, onError }) {
  const myLocation = useStore((s) => s.myLocation);
  const [knocks, setKnocks] = useState([]);
  const [outcome, setOutcome] = useState('no_answer');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    api.listKnocks(prospect.id).then(setKnocks).catch((e) => onError(e.message));
  }, [prospect.id, onError]);

  async function logKnock(e) {
    e.preventDefault();
    try {
      const knock = await api.createKnock({
        prospect_id: prospect.id, outcome, notes: notes || undefined, lat: myLocation?.lat, lng: myLocation?.lng,
      });
      setKnocks((k) => [knock, ...k]);
      setNotes('');
    } catch (err) {
      onError(err.message);
    }
  }

  async function setStage(stage) {
    try {
      await api.updateProspect(prospect.id, { stage });
    } catch (err) {
      onError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">{prospect.name}</h2>
        <p className="text-sm text-slate-600">{prospect.address}</p>
        {(prospect.phone || prospect.email) && (
          <p className="text-sm text-slate-600">{[prospect.phone, prospect.email].filter(Boolean).join(' · ')}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {STAGES.map((s) => (
          <button
            key={s}
            onClick={() => setStage(s)}
            className={`rounded px-2 py-0.5 text-xs capitalize ${s === prospect.stage ? 'bg-slate-900 text-white' : 'bg-slate-200'}`}
          >
            {s}
          </button>
        ))}
      </div>
      <form onSubmit={logKnock} className="space-y-2">
        <h3 className="text-sm font-semibold">Log a knock</h3>
        <select className="w-full rounded border border-slate-300 px-2 py-1 text-sm capitalize" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {OUTCOMES.map((o) => <option key={o} value={o}>{label(o)}</option>)}
        </select>
        <textarea className="w-full rounded border border-slate-300 px-2 py-1 text-sm" rows={2} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <button className="w-full rounded bg-emerald-600 py-1.5 text-sm font-medium text-white">Log knock</button>
      </form>
      <ul className="space-y-1 text-sm">
        {knocks.map((k) => (
          <li key={k.id} className="rounded bg-slate-100 px-2 py-1">
            <span className="font-medium capitalize">{label(k.outcome)}</span>
            <span className="text-slate-500"> · {new Date(k.created_at).toLocaleString()}</span>
            {k.notes && <p className="text-slate-600">{k.notes}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  const prospects = useStore((s) => s.prospects);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setProspects = useStore((s) => s.setProspects);
  const setRepLocation = useStore((s) => s.setRepLocation);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listProspects().then(setProspects).catch((e) => setError(e.message));
    api.repLocations().then((locs) => locs.forEach(setRepLocation)).catch(() => {});
    return startLocationTracking();
  }, [setProspects, setRepLocation]);

  const selected = prospects.find((p) => p.id === selectedId);

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex w-full flex-col gap-4 overflow-y-auto border-r border-slate-200 bg-white p-4 md:w-96">
        <h1 className="text-lg font-bold">DTD CRM</h1>
        {error && (
          <div className="rounded bg-red-100 px-2 py-1 text-sm text-red-700">
            {error} <button className="underline" onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        <div className="grid grid-cols-4 gap-1 text-center text-xs">
          {STAGES.map((s) => (
            <div key={s} className="rounded bg-slate-100 py-1">
              <div className="text-base font-semibold">{prospects.filter((p) => p.stage === s).length}</div>
              <div className="capitalize text-slate-600">{s}</div>
            </div>
          ))}
        </div>

        {selected ? (
          <>
            <button className="self-start text-sm text-sky-600 underline" onClick={() => select(null)}>← All prospects</button>
            <ProspectDetail prospect={selected} onError={setError} />
          </>
        ) : (
          <>
            <ProspectForm onError={setError} />
            <ul className="space-y-1">
              {prospects.map((p) => (
                <li key={p.id}>
                  <button onClick={() => select(p.id)} className="w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-100">
                    <span className="font-medium">{p.name}</span>
                    <span className="ml-2 rounded bg-slate-200 px-1.5 text-xs capitalize">{p.stage}</span>
                    <div className="text-xs text-slate-500">{p.address}</div>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
      <main className="h-[50vh] flex-1 md:h-full">
        <MapComponent />
      </main>
    </div>
  );
}
