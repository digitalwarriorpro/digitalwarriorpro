import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

export const STAGES = ['new', 'contacted', 'qualified', 'completed'];
export const OUTCOMES = ['no_answer', 'not_interested', 'callback', 'interested', 'sold'];

const PROSPECT_FIELDS = ['name', 'phone', 'email', 'address', 'lat', 'lng', 'stage', 'notes'];

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

// A knock moves a prospect forward in the pipeline, never backward.
function stageAfterKnock(current, outcome) {
  const target = outcome === 'sold' ? 'completed'
    : outcome === 'interested' ? 'qualified'
    : 'contacted';
  return STAGES.indexOf(target) > STAGES.indexOf(current) ? target : current;
}

export function createRouter(io) {
  const router = Router();

  router.get('/prospects', async (req, res) => {
    let query = supabase.from('prospects').select('*').order('created_at', { ascending: false });
    if (req.query.stage) query = query.eq('stage', req.query.stage);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.post('/prospects', async (req, res) => {
    const body = pick(req.body || {}, PROSPECT_FIELDS);
    if (!body.name || !body.address) return res.status(400).json({ error: 'name and address are required' });
    if (body.stage && !STAGES.includes(body.stage)) return res.status(400).json({ error: 'invalid stage' });

    const { data, error } = await supabase.from('prospects').insert(body).select().single();
    if (error) return res.status(500).json({ error: error.message });
    io.emit('prospect:created', data);
    res.status(201).json(data);
  });

  router.patch('/prospects/:id', async (req, res) => {
    const body = pick(req.body || {}, PROSPECT_FIELDS);
    if (body.stage && !STAGES.includes(body.stage)) return res.status(400).json({ error: 'invalid stage' });

    const { data, error } = await supabase.from('prospects').update(body).eq('id', req.params.id).select().single();
    if (error) return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    io.emit('prospect:updated', data);
    res.json(data);
  });

  router.get('/prospects/:id/knocks', async (req, res) => {
    const { data, error } = await supabase
      .from('knocks').select('*').eq('prospect_id', req.params.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  router.post('/knocks', async (req, res) => {
    const { prospect_id, outcome, notes, lat, lng } = req.body || {};
    if (!prospect_id || !OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: 'prospect_id and a valid outcome are required' });
    }

    const { data: prospect, error: findError } = await supabase
      .from('prospects').select('*').eq('id', prospect_id).single();
    if (findError) return res.status(404).json({ error: 'prospect not found' });

    const { data: knock, error } = await supabase
      .from('knocks').insert({ prospect_id, outcome, notes, lat, lng, rep_id: req.user.id }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    io.emit('knock:created', knock);

    const nextStage = stageAfterKnock(prospect.stage, outcome);
    if (nextStage !== prospect.stage) {
      const { data: updated } = await supabase
        .from('prospects').update({ stage: nextStage }).eq('id', prospect_id).select().single();
      if (updated) io.emit('prospect:updated', updated);
    }

    res.status(201).json(knock);
  });

  router.get('/pipeline', async (_req, res) => {
    const { data, error } = await supabase.from('prospects').select('stage');
    if (error) return res.status(500).json({ error: error.message });
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const row of data) counts[row.stage] += 1;
    res.json(counts);
  });

  router.get('/reps/locations', async (_req, res) => {
    const { data, error } = await supabase.from('rep_locations').select('*');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  return router;
}
