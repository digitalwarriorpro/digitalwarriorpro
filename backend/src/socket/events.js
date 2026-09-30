import { supabase } from '../lib/supabase.js';

export function registerSocketEvents(io) {
  io.on('connection', (socket) => {
    const repId = socket.handshake.auth?.repId || socket.id;

    // Live GPS ping from a rep's browser: broadcast it and keep the latest position.
    socket.on('rep:location', async ({ lat, lng, accuracy } = {}) => {
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      const location = { rep_id: repId, lat, lng, accuracy, updated_at: new Date().toISOString() };
      socket.broadcast.emit('rep:location', location);
      const { error } = await supabase.from('rep_locations').upsert(location);
      if (error) console.error('Failed to save rep location:', error.message);
    });

    socket.on('disconnect', () => {
      io.emit('rep:offline', { rep_id: repId });
    });
  });
}
