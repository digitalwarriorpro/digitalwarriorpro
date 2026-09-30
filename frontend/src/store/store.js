import { create } from 'zustand';

export const STAGES = ['new', 'contacted', 'qualified', 'completed'];
export const OUTCOMES = ['no_answer', 'not_interested', 'callback', 'interested', 'sold'];

export const useStore = create((set) => ({
  prospects: [],
  reps: {},
  myLocation: null,
  selectedId: null,
  pickedPoint: null,

  setProspects: (prospects) => set({ prospects }),
  upsertProspect: (p) =>
    set((s) => {
      const exists = s.prospects.some((x) => x.id === p.id);
      return { prospects: exists ? s.prospects.map((x) => (x.id === p.id ? p : x)) : [p, ...s.prospects] };
    }),
  setRepLocation: (loc) => set((s) => ({ reps: { ...s.reps, [loc.rep_id]: loc } })),
  removeRep: (repId) =>
    set((s) => {
      const { [repId]: _removed, ...rest } = s.reps;
      return { reps: rest };
    }),
  setMyLocation: (myLocation) => set({ myLocation }),
  select: (selectedId) => set({ selectedId }),
  setPickedPoint: (pickedPoint) => set({ pickedPoint }),
}));
