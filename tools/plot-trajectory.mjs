// Renders tools/out/trajectory.json as a top-down SVG with a z profile.
// Output: tools/out/trajectory.svg
import { readFileSync, writeFileSync } from 'node:fs';

const track = JSON.parse(readFileSync(new URL('./out/trajectory.json', import.meta.url), 'utf8'));

const xs = track.map((t) => t.x);
const ys = track.map((t) => t.y);
const zs = track.map((t) => t.z);
const speeds = track.map((t) => Math.hypot(t.vx, t.vy));
const minX = Math.min(...xs),
  maxX = Math.max(...xs);
const minY = Math.min(...ys),
  maxY = Math.max(...ys);
const maxSpeed = Math.max(...speeds);

const W = 1000,
  H = 700,
  PAD = 40;
const sx = (x) => PAD + ((x - minX) / (maxX - minX)) * (W - 2 * PAD);
// Source maps: +y is "north"; flip so the plot reads like a map
const sy = (y) => H - PAD - ((y - minY) / (maxY - minY)) * (H - 2 * PAD);

function speedColor(s) {
  const t = Math.min(1, s / maxSpeed);
  const hue = 240 - t * 240; // blue (slow) to red (fast)
  return `hsl(${hue.toFixed(0)} 90% 50%)`;
}

const ZONE_TICKS = [0, 23, 1064, 1079, 1806, 1819, 2468, 2479, 3385];

let segs = '';
for (let i = 1; i < track.length; i++) {
  const a = track[i - 1],
    b = track[i];
  if (Math.hypot(b.x - a.x, b.y - a.y) > 200) continue; // teleport, skip line
  segs += `<line x1="${sx(a.x).toFixed(1)}" y1="${sy(a.y).toFixed(1)}" x2="${sx(b.x).toFixed(1)}" y2="${sy(b.y).toFixed(1)}" stroke="${speedColor(speeds[i])}" stroke-width="2"/>\n`;
}
let markers = '';
for (const zt of ZONE_TICKS) {
  const p = track.find((t) => t.tick === zt);
  if (!p) continue;
  markers += `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="6" fill="none" stroke="#111" stroke-width="2"/>
<text x="${(sx(p.x) + 9).toFixed(1)}" y="${(sy(p.y) - 6).toFixed(1)}" font-size="12" fill="#111">t${zt}</text>\n`;
}

// z profile strip at the bottom
const ZH = 120;
const minZ = Math.min(...zs),
  maxZ = Math.max(...zs);
let zline = '';
for (let i = 0; i < track.length; i += 2) {
  const px = PAD + (i / track.length) * (W - 2 * PAD);
  const py = H + ZH - 15 - ((zs[i] - minZ) / (maxZ - minZ || 1)) * (ZH - 30);
  zline += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ' ' + py.toFixed(1) + ' ';
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + ZH}" viewBox="0 0 ${W} ${H + ZH}">
<rect width="${W}" height="${H + ZH}" fill="#fafafa"/>
<text x="${PAD}" y="24" font-size="16" font-family="sans-serif" fill="#111">bhop_eazy, ${track.length} ticks, top-down (color = horizontal speed, max ${maxSpeed.toFixed(0)} u/s)</text>
${segs}
${markers}
<text x="${PAD}" y="${H + 18}" font-size="13" font-family="sans-serif" fill="#111">z over time (${minZ.toFixed(0)} to ${maxZ.toFixed(0)})</text>
<path d="${zline}" fill="none" stroke="#444" stroke-width="1.5"/>
</svg>`;

writeFileSync(new URL('./out/trajectory.svg', import.meta.url), svg);
console.log(`wrote tools/out/trajectory.svg (${(svg.length / 1024).toFixed(0)} KB)`);
console.log(
  `bounds x [${minX.toFixed(0)}, ${maxX.toFixed(0)}] y [${minY.toFixed(0)}, ${maxY.toFixed(0)}] z [${minZ.toFixed(0)}, ${maxZ.toFixed(0)}]`,
);
