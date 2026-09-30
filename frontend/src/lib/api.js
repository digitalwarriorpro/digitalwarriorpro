async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  listProspects: () => request('/prospects'),
  createProspect: (body) => request('/prospects', { method: 'POST', body }),
  updateProspect: (id, body) => request(`/prospects/${id}`, { method: 'PATCH', body }),
  listKnocks: (prospectId) => request(`/prospects/${prospectId}/knocks`),
  createKnock: (body) => request('/knocks', { method: 'POST', body }),
  repLocations: () => request('/reps/locations'),
};
