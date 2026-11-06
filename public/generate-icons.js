/**
 * Generates every RemoteCLI brand image from one drawing: a monitor showing a terminal prompt, with
 * signal arcs leaving its corner. Run from the project root after changing the drawing:
 *
 *   node public/generate-icons.js
 *
 * Writes (all in public/):
 *   logo.svg, favicon.svg, icons/icon-template.svg, icons/icon-<size>.svg   (always)
 *   logo-<size>.png, favicon.png, icons/icon-<size>.png                     (when `sharp` is installed)
 *
 * The same geometry lives in src/shared/ui/RemoteCliLogo.tsx (the in-app mark).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRAND_BLUE = '#2563eb';
const PWA_SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const LOGO_PNG_SIZES = [32, 64, 128, 256, 512];

// The drawing is made on a 32-unit grid; its bounding box is x 3..30, y 4..27.5, centred on (16.5, 15.75).
const GLYPH = `<rect x="4" y="11" width="18" height="12" rx="2.5"/>
    <path d="M13 23v3M9 26.5h8"/>
    <path d="M8.5 15.5l3 2.5-3 2.5M13.5 20.5h4"/>
    <path d="M22 7a4 4 0 0 1 4 4M22 4a7 7 0 0 1 7 7"/>`;

/** White glyph centred on a canvas of `size` units, scaled so it spans `fill` of the canvas width. */
function glyphGroup(size, fill, strokeWidth) {
  const scale = (size * fill) / 29;
  return `<g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(-16.5 -15.75)" stroke="white" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    ${GLYPH}
  </g>`;
}

/** Brand-blue tile (rounded when `radius` > 0) with the glyph on it. */
function tileSvg(size, radius, fill, strokeWidth) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${BRAND_BLUE}"/>
  ${glyphGroup(size, fill, strokeWidth)}
</svg>
`;
}

const files = {
  'logo.svg': tileSvg(32, 8, 0.8, 2.3),
  'favicon.svg': tileSvg(64, 14, 0.8, 2.3),
  // Full-bleed squares for the PWA icons: the OS applies its own corner mask, and the glyph stays
  // inside the ~80% maskable safe zone.
  'icons/icon-template.svg': tileSvg(512, 0, 0.58, 2.2),
};
for (const size of PWA_SIZES) {
  files[`icons/icon-${size}x${size}.svg`] = tileSvg(size, 0, 0.58, 2.2);
}

for (const [relative, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(__dirname, relative), content);
  console.log(`Wrote ${relative}`);
}

let sharp;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  console.log('\nSVG files written. Install `sharp` (npm i -D sharp) to also write the PNG files.');
  process.exit(0);
}

const png = async (svgRelative, pngRelative, size) => {
  await sharp(path.join(__dirname, svgRelative), { density: 384 })
    .resize(size, size)
    .png()
    .toFile(path.join(__dirname, pngRelative));
  console.log(`Wrote ${pngRelative}`);
};

for (const size of LOGO_PNG_SIZES) await png('logo.svg', `logo-${size}.png`, size);
await png('favicon.svg', 'favicon.png', 32);
for (const size of PWA_SIZES) await png(`icons/icon-${size}x${size}.svg`, `icons/icon-${size}x${size}.png`, size);
