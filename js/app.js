/* ===== DISKTREK CORE APP ===== */

const DT = {
  store: {
    get: (key, fallback = null) => {
      try { return JSON.parse(localStorage.getItem('dt_' + key)) ?? fallback; }
      catch { return fallback; }
    },
    set: (key, val) => localStorage.setItem('dt_' + key, JSON.stringify(val)),
  },

  discs: {
    getAll: () => DT.store.get('discs', []),
    get: (id) => DT.store.get('discs', []).find(d => d.id === id) || null,
    save: (disc) => {
      const discs = DT.discs.getAll();
      const idx = discs.findIndex(d => d.id === disc.id);
      if (idx >= 0) discs[idx] = disc; else discs.push(disc);
      DT.store.set('discs', discs);
      return disc;
    },
    delete: (id) => {
      DT.store.set('discs', DT.discs.getAll().filter(d => d.id !== id));
    },
    stats: () => {
      const discs = DT.discs.getAll();
      const rounds = discs.flatMap(d => d.rounds || []);
      const players = [...new Set(rounds.flatMap(r => r.players || []))];
      const courses = [...new Set(rounds.map(r => r.course).filter(Boolean))];
      return {
        total: discs.length,
        active: discs.filter(d => d.status === 'active').length,
        lost: discs.filter(d => d.status === 'lost').length,
        rounds: rounds.length,
        players: players.length,
        courses: courses.length,
      };
    }
  },

  uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),

  toast: (msg, type = 'success') => {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.innerHTML = `<span>${icons[type] || '•'}</span> ${msg}`;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3100);
  },

  fmt: {
    date: (s) => {
      if (!s) return '—';
      const d = new Date(s);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    score: (n) => n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`,
  },

  typeInfo: {
    putter:   { label: 'Putter',          emoji: '🟤', speed: '1-3'  },
    midrange: { label: 'Mid-Range',       emoji: '🟠', speed: '4-5'  },
    fairway:  { label: 'Fairway Driver',  emoji: '🟡', speed: '6-8'  },
    distance: { label: 'Distance Driver', emoji: '🔴', speed: '9-15' },
  },

  statusInfo: {
    active:  { label: 'Active',  css: 'disc-status--active'  },
    lost:    { label: 'Lost',    css: 'disc-status--lost'    },
    found:   { label: 'Found',   css: 'disc-status--found'   },
    retired: { label: 'Retired', css: 'disc-status--retired' },
  },

  colorMap: {
    'Red':    '#ef4444', 'Orange':  '#f97316', 'Yellow':  '#eab308',
    'Green':  '#22c55e', 'Blue':    '#3b82f6', 'Purple':  '#a855f7',
    'Pink':   '#ec4899', 'White':   '#e5e7eb', 'Black':   '#1f2937',
    'Teal':   '#14b8a6', 'Gray':    '#6b7280',
    'Tie-Dye': 'linear-gradient(135deg,#f97316,#a855f7,#3b82f6)',
  },

  getDiscUrl: (id) => {
    const base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    return `${base}found.html?id=${id}`;
  },

  seedDemo: () => {
    if (DT.discs.getAll().length > 0) return;
    const demo = [
      {
        id: 'demo1', name: 'Destroyer', brand: 'Innova', type: 'distance',
        plastic: 'Star', weight: '175', color: 'Blue', status: 'active', condition: 'good',
        notes: 'My go-to distance disc for hyzer shots',
        owner: { name: 'Alex Johnson', email: 'alex@email.com', phone: '555-0101', udisc: '@alexj' },
        registeredDate: '2024-09-12',
        rounds: [
          { id: 'r1', date: '2025-03-15', course: 'Maple Hill', location: 'Leicester, MA', score: -4, par: 54, throws: 50, players: ['Alex Johnson', 'Sam Rivera'], notes: 'Great round' },
          { id: 'r2', date: '2025-04-02', course: 'Hawk Island', location: 'Lansing, MI', score: -2, par: 54, throws: 52, players: ['Alex Johnson'], notes: '' },
          { id: 'r3', date: '2025-06-01', course: 'Copper Creek', location: 'Columbus, OH', score: -6, par: 63, throws: 57, players: ['Alex Johnson', 'Jordan Lee', 'Sam Rivera'], notes: 'Personal best round' },
        ],
        transfers: [],
      },
      {
        id: 'demo2', name: 'Luna', brand: 'Discraft', type: 'putter',
        plastic: 'ESP', weight: '173', color: 'Pink', status: 'active', condition: 'new',
        notes: 'Putting machine',
        owner: { name: 'Alex Johnson', email: 'alex@email.com', phone: '555-0101', udisc: '@alexj' },
        registeredDate: '2025-01-20',
        rounds: [
          { id: 'r4', date: '2025-02-10', course: 'Renny Road', location: 'Madison, WI', score: 1, par: 54, throws: 55, players: ['Alex Johnson'], notes: '' },
        ],
        transfers: [],
      },
      {
        id: 'demo3', name: 'Zone', brand: 'Discraft', type: 'midrange',
        plastic: 'Z Line', weight: '174', color: 'Orange', status: 'lost', condition: 'worn',
        notes: 'Lost in the woods at Hawk Island hole 12',
        owner: { name: 'Alex Johnson', email: 'alex@email.com', phone: '555-0101', udisc: '@alexj' },
        registeredDate: '2024-11-05',
        rounds: [
          { id: 'r5', date: '2025-04-02', course: 'Hawk Island', location: 'Lansing, MI', score: 3, par: 54, throws: 57, players: ['Alex Johnson'], notes: 'Lost this disc on hole 12' },
        ],
        transfers: [],
      },
    ];
    DT.store.set('discs', demo);
  }
};

(function() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === path || (path === '' && href === 'index.html')) a.classList.add('nav-active');
  });
})();

window.addEventListener('scroll', () => {
  document.querySelector('.nav')?.classList.toggle('nav--scrolled', window.scrollY > 10);
}, { passive: true });

document.getElementById('navToggle')?.addEventListener('click', () => {
  document.querySelector('.nav-links')?.classList.toggle('open');
});

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});
document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('.modal-backdrop')?.classList.remove('open'));
});

function generateQR(url, canvasId, size = 200) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const container = document.getElementById(canvasId);
  if (container) container.innerHTML = qr.createImgTag(5, 8);
}

function discBg(color) {
  const val = DT.colorMap[color] || '#40916C';
  if (val.startsWith('linear-gradient')) return val;
  return `linear-gradient(135deg, ${val}cc, ${val})`;
}