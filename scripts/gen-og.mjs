// One-off: generate public/og.png (1200x630) social card from an SVG.
// Run with: node scripts/gen-og.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, '..', 'public', 'og.png');

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#08090a"/>
  <rect x="0" y="0" width="1200" height="630" fill="none" stroke="#1a1d1f" stroke-width="2"/>
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
    <circle cx="96" cy="120" r="9" fill="#7af2a0"/>
    <text x="120" y="128" fill="#8a8f98" font-size="26" font-family="monospace" letter-spacing="2">ruslanshulga.com</text>
    <text x="92" y="330" fill="#e6e7e8" font-size="104" font-weight="600" letter-spacing="-2">Ruslan Shulga</text>
    <text x="96" y="400" fill="#cdd2d8" font-size="40" font-weight="500">VP Engineering, AI Platform · JPMorgan Chase</text>
    <text x="96" y="470" fill="#8a8f98" font-size="28">Production AI platforms used by thousands of internal users every day.</text>
    <text x="96" y="560" fill="#5e6469" font-size="24" font-family="monospace">Astro · React islands · Claude · WebGL</text>
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log('wrote', out);
