import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;

test('uses the monochrome Kedabra favicon assets with browser fallbacks', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/favicon\.svg\?v=3"/);
  assert.match(html, /rel="icon" type="image\/png" sizes="64x64" href="\/favicon\.png\?v=3"/);
  assert.match(html, /rel="shortcut icon" href="\/favicon\.ico\?v=3"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png\?v=3"/);
  assert.match(html, /name="theme-color" content="#111214"/);
  assert.doesNotMatch(html, /data:image\/svg\+xml/);
  for (const name of ['favicon.svg', 'favicon.png', 'favicon.ico', 'apple-touch-icon.png']) {
    assert.ok(existsSync(join(root, name)), `${name} should exist at the project root`);
  }
});
