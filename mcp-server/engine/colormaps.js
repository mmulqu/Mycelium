export const COLORMAPS = {
  organic: (u, v) => {
    const r = Math.floor(Math.min(255, (1 - u) * 40 + v * 300));
    const g = Math.floor(Math.min(255, (1 - u) * 60 + v * 120));
    const b = Math.floor(Math.min(255, (1 - u) * 80 + v * 180));
    return [r, g, b];
  },
  heat: (u, v) => {
    const t = v * 4;
    const r = Math.floor(Math.min(255, t * 255));
    const g = Math.floor(Math.min(255, Math.max(0, (t - 0.4) * 400)));
    const b = Math.floor(Math.min(255, Math.max(0, (t - 0.7) * 600)));
    return [r, g, b];
  },
  acid: (u, v) => {
    const r = Math.floor(Math.min(255, v * 150 + (1 - u) * 30));
    const g = Math.floor(Math.min(255, v * 400));
    const b = Math.floor(Math.min(255, (1 - u) * 100 + v * 200));
    return [r, g, b];
  },
  bone: (u, v) => {
    const l = Math.floor(Math.min(255, (1 - v * 3) * 240));
    return [l, l, Math.floor(Math.min(255, l + 15))];
  },
  neon: (u, v) => {
    const t = v * 5;
    const r = Math.floor(Math.min(255, Math.sin(t * 2) * 127 + 128));
    const g = Math.floor(Math.min(255, Math.sin(t * 3 + 2) * 127 + 128));
    const b = Math.floor(Math.min(255, Math.sin(t * 5 + 4) * 127 + 128));
    return [r, g, b];
  },
};
