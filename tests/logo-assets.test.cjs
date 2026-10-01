const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const iconDir = path.join(root, 'src/assets/icons');
// Pin the reviewed 0.4 artwork. Regenerate with tools/build-icons.cjs, inspect
// white, dark and mint backgrounds at 16px, then update these hashes if intentional.
const approved = {
  'tidy-white-16.png': '0ad60f288689f8e0b1fabdd24dfca1ad5e6d119031146adc1742dc7e045fab65',
  'tidy-white-32.png': '314a70d9dab004b84a067087ccf656b88e0fe5454212be05e46c29ef9a0b95ed',
  'tidy-white-48.png': '1a5dff6fd05cf7a7b7002b5a2e861ae22859a7d42008e64fa801ff267748f5a8',
  'tidy-white-128.png': '119ce032a5bed51edc954ec8743edefa0ce8b9986f1b5e83468fb0463a634687',
  'tidy-outlined-16.png': '662ceb6038d70677d765fd9d78ff890ca4f9c5ee8451bcedeedb167ba89005bd',
  'tidy-outlined-32.png': 'ef6c1bd7144ee5692b8beeb33b220d6426fee86a4dfe76c390e3d4b9de686cab',
  'tidy-outlined-48.png': 'f8293ab876820d859d879c9435efead116cd96b74ef25a94eb91ef6b8a318dc4',
  'tidy-outlined-128.png': '1a9c05dd48f47ff2256feaa5ae160916c8d3edc057d56d48f22dee35ea67b28f',
};

// Decode the browser's ordinary RGBA PNG without adding a test-only dependency.
// Pixel checks catch the old transparent hand even if someone updates a hash.
function readPixels(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8, '8 bits per channel');
  assert.equal(bytes[25], 6, 'RGBA');
  assert.equal(bytes[28], 0, 'non-interlaced PNG');
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter >= 0 && filter <= 4, 'PNG filter');
    for (let x = 0; x < stride; x++) {
      const offset = y * stride + x;
      const left = x >= 4 ? pixels[offset - 4] : 0;
      const above = y ? pixels[offset - stride] : 0;
      const diagonal = y && x >= 4 ? pixels[offset - stride - 4] : 0;
      const correction = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, diagonal)][filter];
      pixels[offset] = (raw[y * (stride + 1) + 1 + x] + correction) & 255;
    }
  }
  return { width, height, at: (x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4)] };
}

test('both icon variants retain reviewed artwork, sizes, and transparent backgrounds', () => {
  for (const [name, hash] of Object.entries(approved)) {
    const bytes = fs.readFileSync(path.join(iconDir, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
    const size = Number(name.match(/(\d+)\.png$/)[1]);
    const pixels = readPixels(bytes);
    assert.equal(pixels.width, size);
    assert.equal(pixels.height, size);
    assert.equal(pixels.at(0, 0)[3], 0, `${name}: transparent outer background`);
    // Sample the straight hand, away from the six petals' shared center point.
    // At 16px the center pixel spans SVG [12,13.5] in both directions and crosses
    // the r=1 circle's edge; separately antialiased petals there composite to 253.
    // The straight hand must be fully opaque at every size, unlike the old mask.
    assert.equal(pixels.at(size / 2, Math.floor(size * 15 / 24))[3], 255, `${name}: solid hand, not a hole`);
  }
});

test('128px artwork contains a white solid hand (or black on the white variant)', () => {
  for (const prefix of ['tidy-white', 'tidy-outlined']) {
    const pixels = readPixels(fs.readFileSync(path.join(iconDir, `${prefix}-128.png`)));
    const hand = prefix === 'tidy-white' ? 0 : 255, body = 255 - hand;
    assert.deepEqual(pixels.at(64, 64), [hand, hand, hand, 255], `${prefix}: hand center`);
    assert.deepEqual(pixels.at(64, 32), [body, body, body, 255], `${prefix}: petal interior`);
  }
});

test('both 16px variants remain visible on white, dark and mint toolbar backgrounds', () => {
  // Test composited PNG pixels rather than assuming an opaque foreground. This
  // catches a lost contrasting outline on a same-color or tinted toolbar.
  const backgrounds = [[255, 255, 255], [37, 39, 39], [213, 235, 231]];
  const luminance = rgb => rgb.map(c => c / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  for (const prefix of ['tidy-outlined', 'tidy-white']) {
    const pixels = readPixels(fs.readFileSync(path.join(iconDir, `${prefix}-16.png`)));
    for (const background of backgrounds) {
      const backgroundLuminance = luminance(background);
      let visiblePixels = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const rgba = pixels.at(x, y), alpha = rgba[3] / 255;
        const composite = rgba.slice(0, 3).map((c, index) => c * alpha + background[index] * (1 - alpha));
        const value = luminance(composite);
        const contrast = (Math.max(value, backgroundLuminance) + 0.05) / (Math.min(value, backgroundLuminance) + 0.05);
        if (contrast >= 3) visiblePixels++;
      }
      assert.ok(visiblePixels >= 24, `${prefix}: contrasting outline/body lost on ${background}`);
    }
  }
});

test('SVG sources preserve the six original petals and original hand geometry', () => {
  const petal = 'M12 12C9.4 10.3 7.9 7.8 8.2 5.6C8.5 3.4 10 2 12 2C14 2 15.5 3.4 15.8 5.6C16.1 7.8 14.6 10.3 12 12Z';
  for (const variant of ['white', 'outlined']) {
    const svg = fs.readFileSync(path.join(iconDir, `tidy-${variant}.svg`), 'utf8');
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.equal(svg.split(`d="${petal}"`).length - 1, 6);
    for (const angle of [0, 60, 120, 180, 240, 300]) assert.ok(svg.includes(`transform="rotate(${angle} 12 12)"`));
    assert.match(svg, /d="M12 17V12L16\.3 7\.7"[^>]+stroke-width="1\.65"/);
    assert.match(svg, /<circle cx="12" cy="12" r="1"/);
    assert.doesNotMatch(svg, /<(?:mask|rect)\b/, 'no hand cutout and no background plate');
    const outline = variant === 'white' ? '#000000' : '#ffffff';
    const body = variant === 'white' ? '#ffffff' : '#000000';
    assert.ok(svg.includes(`<use href="#flower" fill="${outline}" stroke="${outline}" stroke-width="1.3" stroke-linejoin="round"/>`));
    assert.ok(svg.indexOf(`stroke-width="1.3"`) < svg.indexOf(`<use href="#flower" fill="${body}"/>`),
      `${variant}: paint the contrasting outline before the unchanged solid silhouette`);
  }
});

test('native side panel and toolbar default share the contrast-safe black icon', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.icons[size], `assets/icons/tidy-outlined-${size}.png`);
    assert.equal(manifest.action.default_icon[size], `assets/icons/tidy-outlined-${size}.png`);
  }
  assert.equal(Object.hasOwn(manifest, 'icon_variants'), false);
  assert.equal(Object.hasOwn(manifest.action, 'icon_variants'), false);
  assert.equal(fs.existsSync(path.join(root, 'tools/build-icons.ps1')), false);
});

test('icon builder lists every source and output size without extra dependencies', () => {
  const { sizes, variants } = require('../tools/build-icons.cjs');
  assert.deepEqual(sizes, [16, 32, 48, 128]);
  assert.deepEqual(variants.map(variant => variant.source), ['tidy-outlined.svg', 'tidy-white.svg']);
  for (const variant of variants) {
    assert.ok(fs.existsSync(path.join(iconDir, variant.source)));
    for (const size of sizes) assert.ok(Object.hasOwn(approved, `${variant.prefix}-${size}.png`));
  }
  assert.equal(fs.existsSync(path.join(iconDir, 'tidy-black.svg')), false, 'no obsolete third SVG');
  for (const size of sizes) assert.equal(fs.existsSync(path.join(iconDir, `tidy-${size}.png`)), false, 'no obsolete third PNG');
});
