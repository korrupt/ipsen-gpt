import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = path.resolve(__dirname, '../public');
const svgs = fs.readdirSync(publicDir).filter((f) => f.endsWith('.svg'));

describe('public SVG assets', () => {
  it.each(svgs)('%s is well-formed XML (browsers refuse to render it otherwise)', (file) => {
    const doc = new DOMParser().parseFromString(fs.readFileSync(path.join(publicDir, file), 'utf8'), 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.nodeName).toBe('svg');
  });
});
