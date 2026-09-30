import { io } from 'socket.io-client';
import { useStore } from '../store/store.js';

function repId() {
  try {
    let id = localStorage.getItem('dtdcrm-rep-id');
    if (!id) {
      id = `rep-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem('dtdcrm-rep-id', id);
    }
    return id;
  } catch {
    return `rep-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const socket = io({ auth: { repId: repId() } });

const { getState } = useStore;
socket.on('prospect:created', (p) => getState().upsertProspect(p));
socket.on('prospect:updated', (p) => getState().upsertProspect(p));
socket.on('rep:location', (loc) => getState().setRepLocation(loc));
socket.on('rep:offline', ({ rep_id }) => getState().removeRep(rep_id));

// Watch this device's GPS and stream it to the server.
export function startLocationTracking() {
  if (!('geolocation' in navigator)) return () => {};
  const watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      const loc = { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy };
      getState().setMyLocation(loc);
      socket.emit('rep:location', loc);
    },
    (err) => console.warn('GPS unavailable:', err.message),
    { enableHighAccuracy: true, maximumAge: 10_000 },
  );
  return () => navigator.geolocation.clearWatch(watchId);
}
