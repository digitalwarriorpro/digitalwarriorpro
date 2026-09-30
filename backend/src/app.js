import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

// Imported after dotenv so the Supabase client sees the env vars.
const { default: express } = await import('express');
const { default: cors } = await import('cors');
const { Server } = await import('socket.io');
const { authenticate } = await import('./middleware/auth.js');
const { createRouter } = await import('./api/routes.js');
const { registerSocketEvents } = await import('./socket/events.js');

const port = Number(process.env.PORT) || 3000;
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin } });

app.use(cors({ origin }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', authenticate, createRouter(io));

registerSocketEvents(io);

server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
