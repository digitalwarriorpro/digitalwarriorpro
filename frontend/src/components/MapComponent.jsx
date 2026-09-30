import { useEffect } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, useMapEvents } from 'react-leaflet';
import { useStore } from '../store/store.js';

const STAGE_COLORS = {
  new: '#64748b',
  contacted: '#2563eb',
  qualified: '#d97706',
  completed: '#16a34a',
};

function ClickToPick() {
  const setPickedPoint = useStore((s) => s.setPickedPoint);
  useMapEvents({ click: (e) => setPickedPoint({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

function CenterOnFirstFix() {
  const map = useMap();
  const myLocation = useStore((s) => s.myLocation);
  const hasLocation = Boolean(myLocation);
  useEffect(() => {
    if (myLocation) map.setView([myLocation.lat, myLocation.lng], 16);
    // Only recenter on the first fix, not on every GPS update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLocation]);
  return null;
}

export default function MapComponent() {
  const prospects = useStore((s) => s.prospects);
  const reps = useStore((s) => s.reps);
  const myLocation = useStore((s) => s.myLocation);
  const pickedPoint = useStore((s) => s.pickedPoint);
  const select = useStore((s) => s.select);

  return (
    <MapContainer center={[39.5, -98.35]} zoom={4} className="h-full w-full">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickToPick />
      <CenterOnFirstFix />

      {prospects.filter((p) => p.lat != null && p.lng != null).map((p) => (
        <CircleMarker
          key={p.id}
          center={[p.lat, p.lng]}
          radius={9}
          pathOptions={{ color: STAGE_COLORS[p.stage], fillOpacity: 0.8 }}
          eventHandlers={{ click: () => select(p.id) }}
        >
          <Popup>
            <strong>{p.name}</strong><br />{p.address}<br />Stage: {p.stage}
          </Popup>
        </CircleMarker>
      ))}

      {Object.values(reps).map((r) => (
        <CircleMarker key={r.rep_id} center={[r.lat, r.lng]} radius={6} pathOptions={{ color: '#9333ea', fillOpacity: 1 }}>
          <Popup>{r.rep_id}</Popup>
        </CircleMarker>
      ))}

      {myLocation && (
        <CircleMarker center={[myLocation.lat, myLocation.lng]} radius={7} pathOptions={{ color: '#0ea5e9', fillOpacity: 1 }}>
          <Popup>You</Popup>
        </CircleMarker>
      )}

      {pickedPoint && (
        <CircleMarker center={[pickedPoint.lat, pickedPoint.lng]} radius={5} pathOptions={{ color: '#dc2626', dashArray: '3' }} />
      )}
    </MapContainer>
  );
}
