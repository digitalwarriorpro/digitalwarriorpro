import { supabase } from '../lib/supabase.js';

const requireAuth = process.env.REQUIRE_AUTH === 'true';

// Resolves the Supabase user from a Bearer token. When REQUIRE_AUTH is off
// (local dev), requests without a token run as an anonymous "dev" rep.
export async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    if (requireAuth) return res.status(401).json({ error: 'Missing bearer token' });
    req.user = { id: 'dev-rep' };
    return next();
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });
  req.user = data.user;
  next();
}
