import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PeopleError, PeopleStore, parsePersonFile, serializePerson, slugify } from '../src/people.js';
import { tempDir, writePerson } from './helpers.js';

describe('person files', () => {
  it('round-trip through serialize/parse', () => {
    const p = { name: 'Ola Nordmann', aliases: ['Ola', 'Olsen: the Great'], info: 'Likes *bats*.\n\nHates garlic.' };
    expect(parsePersonFile('ola', serializePerson(p))).toEqual({ slug: 'ola', ...p });
  });

  it('rejects files without valid frontmatter', () => {
    expect(() => parsePersonFile('x', 'just text')).toThrow(/frontmatter/);
    expect(() => parsePersonFile('x', '---\naliases: [a]\n---\nbody')).toThrow(/name/);
  });

  it('slugifies Norwegian names', () => {
    expect(slugify('Åse Ørnebråten')).toBe('ase-ornebraten');
    expect(slugify('Ærlige Jørgen!')).toBe('aerlige-jorgen');
    expect(slugify('***')).toBe('person');
  });
});

describe('PeopleStore', () => {
  it('loads folders, reserves names and aliases case-insensitively, and reports broken folders', () => {
    const dir = tempDir();
    writePerson(dir, 'ola', 'Ola Nordmann', ['Ola'], 'Info about Ola');
    writePerson(dir, 'zkari', 'Kari', ['ola'], 'Clashes with Ola'); // alias collides; loaded after ola
    fs.mkdirSync(path.join(dir, 'Bad Folder'));
    fs.mkdirSync(path.join(dir, 'empty'));
    const store = new PeopleStore(dir);

    expect(store.list().map((p) => p.slug)).toEqual(['ola']);
    expect(store.findByName('  OLA ')?.slug).toBe('ola');
    expect(store.findByName('ola nordmann')?.slug).toBe('ola');
    expect(store.findByName('Kari')).toBeUndefined();
    expect(store.errors).toHaveLength(3);
    expect(store.errors.join('\n')).toMatch(/zkari: name "ola" is already used by ola/);
  });

  it('creates folders with person.md and gates.json, with unique slugs', () => {
    const dir = tempDir();
    const store = new PeopleStore(dir);
    const a = store.save({ name: 'Ola Nordmann', aliases: ['Ola'], info: 'A' });
    const b = store.save({ name: 'Ola  Nordmann.', aliases: [], info: 'B' });
    expect(a.slug).toBe('ola-nordmann');
    expect(b.slug).toBe('ola-nordmann-2');
    expect(fs.readFileSync(path.join(dir, 'ola-nordmann', 'gates.json'), 'utf8').trim()).toBe('[]');
    // A fresh store reads the same thing back from disk.
    expect(new PeopleStore(dir).get('ola-nordmann')).toEqual(a);
  });

  it('updates in place and keeps an existing gates.json', () => {
    const dir = tempDir();
    const store = new PeopleStore(dir);
    const p = store.save({ name: 'Kari', aliases: [], info: 'old' });
    fs.writeFileSync(path.join(dir, p.slug, 'gates.json'), '[{"id":"custom"}]');
    store.save({ name: 'Kari Nordmann', aliases: ['Kari'], info: 'new' }, p.slug);
    expect(store.get(p.slug)).toMatchObject({ name: 'Kari Nordmann', info: 'new' });
    expect(fs.readFileSync(path.join(dir, p.slug, 'gates.json'), 'utf8')).toContain('custom');
  });

  it('refuses names already used by someone else, and invalid names', () => {
    const store = new PeopleStore(tempDir());
    store.save({ name: 'Ola', aliases: ['Olsen'], info: '' });
    expect(() => store.save({ name: 'Kari', aliases: ['OLSEN'], info: '' })).toThrow(/already used by Ola/);
    expect(() => store.save({ name: '<b>', aliases: [], info: '' })).toThrow(PeopleError);
  });

  it('delete moves the folder to .trash and refuses path tricks', () => {
    const dir = tempDir();
    const store = new PeopleStore(dir);
    const p = store.save({ name: 'Ola', aliases: [], info: '' });
    store.delete(p.slug);
    expect(store.get(p.slug)).toBeUndefined();
    expect(store.findByName('Ola')).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, '.trash'))[0]).toMatch(/^ola-\d+$/);
    expect(() => store.delete('../etc')).toThrow(/No such person/);
    expect(() => store.save({ name: 'X', aliases: [], info: '' }, '../../x')).toThrow(/No such person/);
  });
});
