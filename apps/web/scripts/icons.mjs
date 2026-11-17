// Renders all PWA icons from public/icon.svg: 192, 512, maskable 512 (full bleed, mark in the safe zone)
// and the 180 px apple-touch-icon. Run after changing the SVG: pnpm --filter @trips/web icons
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const dir = new URL('../public/', import.meta.url);
const svg = readFileSync(new URL('icon.svg', dir), 'utf8');
// Maskable and Apple: no own corners (the platform masks), mark scaled into the safe zone.
const square = (scale) =>
  svg.replace(/rx="112"/, 'rx="0"').replace('<g id="mark">', `<g id="mark" transform="translate(256 256) scale(${scale}) translate(-256 -256)">`);

const render = (source, size, file) => sharp(Buffer.from(source), { density: 300 }).resize(size, size).png().toFile(new URL(file, dir).pathname);

await render(svg, 192, 'icon-192.png');
await render(svg, 512, 'icon-512.png');
await render(square(0.72), 512, 'icon-maskable-512.png');
await render(square(0.86), 180, 'apple-touch-icon.png');
console.log('icons written');
