export function createLineController(panel, bounds, loader) {
  const initial = panel.series.map((item) => ({
    ...item,
    points: item.points.map((pair) => ({ t: pair[0], v: pair[1] })),
  }));
  const listeners = new Set();
  const state = {
    selectedId: null,
    loadingId: null,
    error: null,
    generation: 0,
    series: initial,
    visible: new Set(initial.map((item) => item.id)),
    range: bounds ? { ...bounds } : null,
    autoY: false,
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const unpack = (item) => ({ ...item, points: item.points.map((pair) => ({ t: pair[0], v: pair[1] })) });
  async function select(entry) {
    const generation = ++state.generation;
    state.loadingId = entry.id;
    state.error = null;
    notify();
    try {
      const item = unpack(await loader(entry.detailKey, entry.detailFile));
      if (generation !== state.generation) return false;
      state.series = [item];
      state.visible = new Set([item.id]);
      state.selectedId = item.id;
      state.autoY = true;
      return true;
    } catch (error) {
      if (generation === state.generation) state.error = error.message;
      return false;
    } finally {
      if (generation === state.generation) {
        state.loadingId = null;
        notify();
      }
    }
  }
  async function setRange(range) {
    if (!bounds || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return false;
    const clamped = { min: Math.max(bounds.min, range.min), max: Math.min(bounds.max, range.max) };
    if (clamped.max <= clamped.min) return false;
    const generation = ++state.generation;
    state.loadingId = 'window';
    state.error = null;
    notify();
    try {
      const visible = state.series.filter((item) => state.visible.has(item.id));
      const full = await Promise.all(
        visible.map(async (item) => {
          const entry = panel.catalog.find((value) => value.id === item.id);
          return unpack(await loader(entry.detailKey, entry.detailFile));
        }),
      );
      if (generation !== state.generation) return false;
      const replacements = new Map(full.map((item) => [item.id, item]));
      state.series = state.series.map((item) => replacements.get(item.id) ?? item);
      state.range = clamped;
      state.autoY = true;
      return true;
    } catch (error) {
      if (generation === state.generation) state.error = error.message;
      return false;
    } finally {
      if (generation === state.generation) {
        state.loadingId = null;
        notify();
      }
    }
  }
  function reset() {
    state.generation++;
    state.loadingId = null;
    state.error = null;
    state.selectedId = null;
    state.series = initial;
    state.visible = new Set(initial.map((item) => item.id));
    state.range = bounds ? { ...bounds } : null;
    state.autoY = false;
    notify();
  }
  function toggle(id) {
    if (state.visible.has(id)) state.visible.delete(id);
    else state.visible.add(id);
    notify();
    if (bounds && state.visible.has(id) && (state.range.min !== bounds.min || state.range.max !== bounds.max))
      void setRange(state.range);
  }
  function yDomain() {
    if (!state.autoY) return panel.yDomain;
    let min = Infinity,
      max = -Infinity;
    for (const item of state.series) {
      if (!state.visible.has(item.id)) continue;
      for (const point of item.points) {
        if (!Number.isFinite(point.v) || point.t < state.range.min || point.t > state.range.max) continue;
        min = Math.min(min, point.v);
        max = Math.max(max, point.v);
      }
    }
    if (!Number.isFinite(min)) return panel.yDomain;
    if (min === max) {
      const pad = Math.abs(min) * 0.05 || 1;
      return { min: min === 0 ? 0 : min - pad, max: max + pad };
    }
    return { min, max };
  }
  return {
    state,
    bounds,
    select,
    setRange,
    reset,
    toggle,
    yDomain,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggleScale() {
      state.autoY = !state.autoY;
      notify();
    },
    fullPeriod() {
      state.generation++;
      state.loadingId = null;
      state.error = null;
      state.range = bounds ? { ...bounds } : null;
      notify();
    },
  };
}
