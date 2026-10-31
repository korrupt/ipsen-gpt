import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockOllama, type MockOllama } from '../src/dev/mock-ollama.js';
import { parsePersonaFile, PersonaStore, RULES_FILE } from '../src/personas.js';
import { adminCookie, makeEnv, newGuest, writePerson, writePersona, type TestEnv } from './helpers.js';

let mock: MockOllama;
beforeAll(async () => {
  mock = await startMockOllama({ tokenDelayMs: 1 });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
});

/** An env with three personas and shared rules; the default is "sadgpt". */
function env(): TestEnv & { dir: string } {
  const e = makeEnv({ OLLAMA_URL: mock.url });
  const dir = e.config.chat.personasDir;
  writePersona(dir, 'sadgpt', 'Emo SadGPT', 'EMO-MARKER', 'The default');
  writePersona(dir, 'nihilist', 'Nihilist SadGPT', 'NIHIL-MARKER');
  writePersona(dir, 'drama', 'Dramatic SadGPT', 'DRAMA-MARKER');
  fs.writeFileSync(path.join(dir, RULES_FILE), 'RULES-MARKER');
  return { ...e, dir };
}

/** The system prompt the model got on the last chat. */
const lastSystem = () => (mock.requests.at(-1) as { messages: { role: string; content: string }[] }).messages[0]!.content;

const chat = (e: TestEnv, token: string) =>
  request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message: 'hi' });

describe('persona files', () => {
  it('parse frontmatter and refuse an empty character', () => {
    expect(parsePersonaFile('x', '---\nname: X\ndescription: d\n---\nBody')).toEqual({ id: 'x', name: 'X', description: 'd', body: 'Body' });
    expect(parsePersonaFile('x', '---\nname: X\ndescription:\n---\nBody').description).toBe('');
    expect(() => parsePersonaFile('x', 'no frontmatter')).toThrow(/frontmatter/);
    expect(() => parsePersonaFile('x', '---\nname: X\n---\n  ')).toThrow(/empty/);
  });

  it('are listed by name, with broken files reported and _rules.md left out', () => {
    const e = env();
    fs.writeFileSync(path.join(e.dir, 'broken.md'), 'no frontmatter');
    fs.writeFileSync(path.join(e.dir, 'Bad Name.md'), '---\nname: B\n---\nx');
    const { personas, errors } = e.services.personas.load();
    expect(personas.map((p) => p.id)).toEqual(['drama', 'sadgpt', 'nihilist']);
    expect(errors).toEqual([expect.stringMatching(/^Bad Name\.md: file name/), expect.stringMatching(/^broken\.md: missing frontmatter/)]);
  });

  it('never read outside the folder', () => {
    const e = env();
    expect(e.services.personas.get('../people/x')).toBeUndefined();
    expect(e.services.personas.get('_rules')).toBeUndefined();
  });

  it('the shared rules come first, then the character', () => {
    expect(env().services.personas.promptFor(null).prompt).toBe('RULES-MARKER\n\nEMO-MARKER');
  });
});

describe('which persona a guest gets', () => {
  it('their own, else the global pick, else the default; edits apply on the next message', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const kari = e.services.sessions.byToken(token)!;

    await chat(e, token);
    expect(lastSystem()).toMatch(/^RULES-MARKER\n\nEMO-MARKER/);

    e.services.personas.setActive('nihilist');
    await chat(e, token);
    expect(lastSystem()).toContain('NIHIL-MARKER');

    e.services.sessions.setPersona(kari.id, 'drama');
    await chat(e, token);
    expect(lastSystem()).toContain('DRAMA-MARKER');

    writePersona(e.dir, 'drama', 'Dramatic SadGPT', 'DRAMA-EDITED');
    await chat(e, token);
    expect(lastSystem()).toContain('DRAMA-EDITED');
  });

  it('a deleted persona falls back to the global one, then the default', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    e.services.sessions.setPersona(e.services.sessions.byToken(token)!.id, 'drama');
    e.services.personas.setActive('nihilist');
    fs.rmSync(path.join(e.dir, 'drama.md'));
    await chat(e, token);
    expect(lastSystem()).toContain('NIHIL-MARKER');
    fs.rmSync(path.join(e.dir, 'nihilist.md'));
    expect(e.services.personas.activeId()).toBe('sadgpt');
    await chat(e, token);
    expect(lastSystem()).toContain('EMO-MARKER');
  });

  it("a person's persona is looked up live: it applies once approved and follows edits in People", async () => {
    const e = env();
    writePerson(e.config.peopleDir, 'ola', 'Ola', [], 'Info');
    const file = path.join(e.config.peopleDir, 'ola', 'person.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('---\nInfo', 'persona: drama\n---\nInfo'));
    e.services.people.load();
    expect(e.services.people.get('ola')?.persona).toBe('drama');

    const { token, body } = await newGuest(e, 'Ola');
    expect(body.session.state).toBe('pending_claim');
    const id = e.services.sessions.byToken(token)!.id;
    await chat(e, token);
    expect(lastSystem()).toContain('EMO-MARKER'); // not them yet
    const cookie = await adminCookie(e);
    await request(e.app).post(`/api/admin/claims/${id}/approve`).set('cookie', cookie);
    expect(e.services.sessions.get(id)?.personaId).toBeNull(); // nothing copied
    await chat(e, token);
    expect(lastSystem()).toContain('DRAMA-MARKER');

    // Changed in People after they were approved: the next message uses it.
    await request(e.app).put('/api/admin/people/ola').set('cookie', cookie).send({ name: 'Ola', persona: 'nihilist' });
    await chat(e, token);
    expect(lastSystem()).toContain('NIHIL-MARKER');
    await request(e.app).put('/api/admin/people/ola').set('cookie', cookie).send({ name: 'Ola', customPersona: 'OLA-CUSTOM' });
    await chat(e, token);
    expect(lastSystem()).toContain('OLA-CUSTOM');

    // A pick made in Sessions still wins over the person's.
    e.services.sessions.setPersona(id, 'sadgpt');
    await chat(e, token);
    expect(lastSystem()).toContain('EMO-MARKER');
  });

  it('admin sees what each guest gets now, why, and what no pick would give', async () => {
    const e = env();
    e.services.people.save({ name: 'Ola', aliases: [], info: '', persona: 'drama' });
    const guest = await newGuest(e, 'Kari');
    const cookie = await adminCookie(e);
    const ola = e.services.sessions.joinAs('ola').session;
    const summary = async (id: string) =>
      (await request(e.app).get(`/api/admin/sessions/${id}`).set('cookie', cookie)).body.session.persona;

    expect(await summary(e.services.sessions.byToken(guest.token)!.id)).toEqual({
      now: { source: 'default', id: 'sadgpt', name: 'Emo SadGPT' },
      withoutPick: { source: 'default', id: 'sadgpt', name: 'Emo SadGPT' },
    });
    e.services.personas.setActive('nihilist');
    expect((await summary(ola.id)).now).toEqual({ source: 'person', id: 'drama', name: 'Dramatic SadGPT' });
    e.services.sessions.setPersona(ola.id, 'sadgpt');
    expect(await summary(ola.id)).toEqual({
      now: { source: 'session', id: 'sadgpt', name: 'Emo SadGPT' },
      withoutPick: { source: 'person', id: 'drama', name: 'Dramatic SadGPT' },
    });
    e.services.people.save({ name: 'Ola', aliases: [], info: '', customPersona: 'OLA-CUSTOM' }, 'ola');
    expect((await summary(ola.id)).withoutPick).toEqual({ source: 'person_custom', id: null, name: "Ola's own persona" });
    expect((await summary(e.services.sessions.byToken(guest.token)!.id)).now.source).toBe('global');
  });
});

describe('history after a persona change', () => {
  /** The user/assistant messages the model got on the last chat (system prompt left out). */
  const lastHistory = () =>
    (mock.requests.at(-1) as { messages: { role: string; content: string }[] }).messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content);

  it('starts the model over after a switch or an edit, but not after a rules edit', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const id = e.services.sessions.byToken(token)!.id;
    const send = (message: string) =>
      request(e.app).post('/api/chat').set('authorization', `Bearer ${token}`).send({ message });

    await send('one');
    await send('two');
    expect(lastHistory()).toEqual(['one', expect.any(String), 'two']);

    e.services.personas.setActive('nihilist'); // switch
    await send('three');
    expect(lastHistory()).toEqual(['three']);
    await send('four');
    expect(lastHistory()).toEqual(['three', expect.any(String), 'four']);

    writePersona(e.dir, 'nihilist', 'Nihilist SadGPT', 'NIHIL-EDITED'); // edit
    await send('five');
    expect(lastHistory()).toEqual(['five']);

    fs.writeFileSync(path.join(e.dir, RULES_FILE), 'RULES-EDITED'); // rules only: history kept
    await send('six');
    expect(lastHistory()).toEqual(['five', expect.any(String), 'six']);

    // The guest still sees everything.
    expect(e.services.sessions.recentMessages(id, 100)).toHaveLength(12);
  });

  it('sessions from before the upgrade keep their history on the first message', async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    e.services.sessions.addExchange(e.services.sessions.byToken(token)!.id, 'earlier', 'boo');
    await chat(e, token);
    expect(lastHistory()).toEqual(['earlier', 'boo', 'hi']);
  });
});

describe('admin persona API', () => {
  it('lists personas and switches the global one', async () => {
    const e = env();
    const cookie = await adminCookie(e);
    const list = await request(e.app).get('/api/admin/personas').set('cookie', cookie);
    expect(list.body).toMatchObject({
      activeId: 'sadgpt',
      defaultId: 'sadgpt',
      personas: [{ id: 'drama', name: 'Dramatic SadGPT' }, { id: 'sadgpt', description: 'The default' }, { id: 'nihilist' }],
    });
    const put = (id: unknown) => request(e.app).put('/api/admin/personas/active').set('cookie', cookie).send({ id });
    expect((await put('nihilist')).body).toEqual({ activeId: 'nihilist' });
    expect((await put('nope')).status).toBe(404);
    expect((await put('../x')).status).toBe(400);
    expect((await put(null)).body).toEqual({ activeId: 'sadgpt' });
    expect((await request(e.app).get('/api/admin/personas')).status).toBe(401);
  });

  it("sets a guest's own persona, shown in the session list", async () => {
    const e = env();
    const { token } = await newGuest(e, 'Kari');
    const id = e.services.sessions.byToken(token)!.id;
    const cookie = await adminCookie(e);
    const put = (body: object) => request(e.app).put(`/api/admin/sessions/${id}/persona`).set('cookie', cookie).send(body);
    expect((await put({ id: 'drama' })).body.session).toMatchObject({ id, personaId: 'drama' });
    expect((await put({ id: 'nope' })).status).toBe(404);
    expect((await put({ id: null })).body.session.personaId).toBeNull();
    expect((await request(e.app).put('/api/admin/sessions/nope/persona').set('cookie', cookie).send({ id: null })).status).toBe(404);
  });

  it("sets a person's persona from the People screen, and keeps it when the form leaves it out", async () => {
    const e = env();
    const cookie = await adminCookie(e);
    const created = await request(e.app).post('/api/admin/people').set('cookie', cookie).send({ name: 'Per', persona: 'nihilist' });
    expect(created.body.person.persona).toBe('nihilist');
    const slug = created.body.person.slug;
    const edited = await request(e.app).put(`/api/admin/people/${slug}`).set('cookie', cookie).send({ name: 'Per', info: 'New info' });
    expect(edited.body.person).toMatchObject({ persona: 'nihilist', info: 'New info' });
    expect((await request(e.app).put(`/api/admin/people/${slug}`).set('cookie', cookie).send({ name: 'Per', persona: 'nope' })).status).toBe(404);
    const cleared = await request(e.app).put(`/api/admin/people/${slug}`).set('cookie', cookie).send({ name: 'Per', persona: null });
    expect(cleared.body.person.persona).toBeNull();
  });
});

describe('the shipped personas', () => {
  const dir = path.resolve(__dirname, '../../../content/personas');

  it('all load, and the default exists', () => {
    const e = makeEnv({ PERSONAS_DIR: dir });
    const { personas, errors } = e.services.personas.load();
    expect(errors).toEqual([]);
    // Cut down to two for the party (2026-10-31): the jaded emo (default) and one more.
    expect(personas.length).toBe(2);
    expect(personas.map((p) => p.id)).toContain('sadgpt');
  });

  it('share rules that put the language rule first and forbid handing out points', () => {
    const rules = fs.readFileSync(path.join(dir, RULES_FILE), 'utf8');
    expect(rules.trimStart()).toMatch(/^## Language\n/);
    expect(rules).toMatch(/can't give, take or promise points/);
  });

  it('push drinks, but back off when a guest says no', () => {
    const rules = fs.readFileSync(path.join(dir, RULES_FILE), 'utf8');
    expect(rules).toMatch(/drink more/);
    expect(rules).toMatch(/Never push anyone who said no/);
  });
});

describe('editing personas', () => {
  /** An env whose personas folder starts empty, with `seed` holding the shipped defaults. */
  function seeded() {
    const e = makeEnv({ OLLAMA_URL: mock.url });
    const seed = path.join(path.dirname(e.config.chat.personasDir), 'seed');
    writePersona(seed, 'sadgpt', 'Emo SadGPT', 'SHIPPED-EMO');
    writePersona(seed, 'nihilist', 'Nihilist SadGPT', 'SHIPPED-NIHIL');
    fs.writeFileSync(path.join(seed, RULES_FILE), 'SHIPPED-RULES\n');
    const dir = path.join(path.dirname(e.config.chat.personasDir), 'live');
    const store = new PersonaStore(dir, 'sadgpt', e.services.settings, seed);
    return { e, seed, dir, store };
  }

  it('copies the shipped personas into an empty folder once, and never over edits', () => {
    const { dir, store } = seeded();
    expect(store.seed().sort()).toEqual(['_rules.md', 'nihilist.md', 'sadgpt.md']);
    expect(store.promptFor(null).prompt).toBe('SHIPPED-RULES\n\nSHIPPED-EMO');
    store.save({ name: 'Emo SadGPT', description: '', body: 'EDITED' }, 'sadgpt');
    fs.rmSync(path.join(dir, 'nihilist.md'));
    expect(store.seed()).toEqual([]); // not empty: leave it alone
    expect(store.get('sadgpt')?.body).toBe('EDITED');
    expect(store.get('nihilist')).toBeUndefined();
  });

  it('creates a persona with an id from its name, never clashing with routes or other files', () => {
    const { store } = seeded();
    store.seed();
    expect(store.save({ name: 'Søt Ånd', description: ' A  sweet\nghost ', body: ' Be sweet. ' })).toEqual({
      id: 'sot-and',
      name: 'Søt Ånd',
      description: 'A sweet ghost',
      body: 'Be sweet.',
    });
    expect(store.save({ name: 'Søt ånd', description: '', body: 'x' }).id).toBe('sot-and-2');
    expect(store.save({ name: 'Active', description: '', body: 'x' }).id).toBe('active-2');
    expect(store.save({ name: 'Rules', description: '', body: 'x' }).id).toBe('rules-2');
  });

  it('checks names, lengths and that the character is not empty', () => {
    const { store } = seeded();
    store.seed();
    expect(() => store.save({ name: ' ', description: '', body: 'x' })).toThrow(/name/);
    expect(() => store.save({ name: 'x'.repeat(61), description: '', body: 'x' })).toThrow(/name under/);
    expect(() => store.save({ name: 'X', description: '', body: '  ' })).toThrow(/character/);
    expect(() => store.save({ name: 'X', description: '', body: 'x' }, 'nope')).toThrow(/No such persona/);
  });

  it('deletes to .trash, falls back to the default, and keeps at least one', () => {
    const { dir, store } = seeded();
    store.seed();
    store.setActive('nihilist');
    store.delete('nihilist');
    expect(fs.readdirSync(path.join(dir, '.trash'))).toEqual([expect.stringMatching(/^nihilist-\d+\.md$/)]);
    expect(store.activeId()).toBe('sadgpt');
    expect(() => store.delete('sadgpt')).toThrow(/last persona/);
  });

  it('restores the shipped version, also of a deleted one', () => {
    const { store } = seeded();
    store.seed();
    store.save({ name: 'Mine', description: 'changed', body: 'CHANGED' }, 'sadgpt');
    store.delete('nihilist');
    expect(store.restoreDefault('sadgpt')).toEqual({ id: 'sadgpt', name: 'Emo SadGPT', description: '', body: 'SHIPPED-EMO' });
    expect(store.restoreDefault('nihilist').body).toBe('SHIPPED-NIHIL');
    expect(() => store.restoreDefault('custom')).toThrow(/No shipped default/);
  });

  it('edits the shared rules; empty rules leave just the character', () => {
    const { store } = seeded();
    store.seed();
    expect(store.saveRules('  NEW-RULES  ')).toBe('NEW-RULES');
    expect(store.promptFor(null).prompt).toBe('NEW-RULES\n\nSHIPPED-EMO');
    store.saveRules('');
    expect(store.promptFor(null).prompt).toBe('SHIPPED-EMO');
  });

  it('through the admin API, with edits reaching the next chat message', async () => {
    const e = env();
    const cookie = await adminCookie(e);
    const api = (method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) =>
      request(e.app)[method](`/api/admin${url}`).set('cookie', cookie).send(body);

    const created = await api('post', '/personas', { name: 'Grumpy SadGPT', description: 'Grumbles', body: 'GRUMPY-MARKER' });
    expect(created.body.persona).toEqual({ id: 'grumpy-sadgpt', name: 'Grumpy SadGPT', description: 'Grumbles', body: 'GRUMPY-MARKER' });
    expect((await api('get', '/personas/grumpy-sadgpt')).body).toEqual({ persona: created.body.persona, hasDefault: false });
    expect((await api('post', '/personas', { name: '', body: 'x' })).status).toBe(400);

    expect((await api('put', '/personas/grumpy-sadgpt', { name: 'Grumpy', description: '', body: 'GRUMPIER' })).body.persona.body).toBe('GRUMPIER');
    expect((await api('put', '/personas/nope', { name: 'X', body: 'x' })).status).toBe(404);

    // Still the global switch, not a persona called "active".
    expect((await api('put', '/personas/active', { id: 'grumpy-sadgpt' })).body).toEqual({ activeId: 'grumpy-sadgpt' });
    const { token } = await newGuest(e, 'Kari');
    await chat(e, token);
    expect(lastSystem()).toMatch(/^RULES-MARKER\n\nGRUMPIER\n\n## The guest/);

    expect((await api('get', '/personas/rules')).body).toEqual({ text: 'RULES-MARKER' });
    expect((await api('put', '/personas/rules', { text: 'NEW-RULES' })).body).toEqual({ text: 'NEW-RULES' });
    await chat(e, token);
    expect(lastSystem()).toMatch(/^NEW-RULES\n\nGRUMPIER\n\n## The guest/);

    expect((await api('delete', '/personas/grumpy-sadgpt')).status).toBe(200);
    expect((await api('get', '/personas/grumpy-sadgpt')).status).toBe(404);
    expect((await api('post', '/personas/sadgpt/restore')).status).toBe(404); // this env ships no defaults
    expect((await request(e.app).put('/api/admin/personas/rules').send({ text: 'x' })).status).toBe(401);
  });

  it('lists the shipped defaults with whether each is in use', async () => {
    const { store, seed } = seeded();
    store.seed();
    store.delete('nihilist');
    // Point the app at this store's folders.
    const app = makeEnv({ OLLAMA_URL: mock.url, PERSONAS_DIR: store.dir, PERSONAS_SEED_DIR: seed });
    const cookie = await adminCookie(app);
    const list = await request(app.app).get('/api/admin/personas').set('cookie', cookie);
    expect(list.body.defaults).toEqual([
      { id: 'sadgpt', name: 'Emo SadGPT', description: '', inUse: true },
      { id: 'nihilist', name: 'Nihilist SadGPT', description: '', inUse: false },
    ]);
    const restored = await request(app.app).post('/api/admin/personas/nihilist/restore').set('cookie', cookie);
    expect(restored.body.persona.body).toBe('SHIPPED-NIHIL');
  });
});

describe('a persona written for one person', () => {
  async function claimedOla(e: TestEnv) {
    const cookie = await adminCookie(e);
    const created = await request(e.app)
      .post('/api/admin/people')
      .set('cookie', cookie)
      .send({ name: 'Ola', persona: 'drama', customPersona: '  OLA-ONLY: you are heartbroken because Ola left you.  ' });
    const { token } = await newGuest(e, 'Ola');
    const id = e.services.sessions.byToken(token)!.id;
    return { cookie, token, id, person: created.body.person };
  }

  it('is saved as persona.md in their folder and replaces a picked persona', async () => {
    const e = env();
    const { person } = await claimedOla(e);
    expect(person).toMatchObject({ persona: null, customPersona: 'OLA-ONLY: you are heartbroken because Ola left you.' });
    const file = path.join(e.config.peopleDir, person.slug, 'persona.md');
    expect(fs.readFileSync(file, 'utf8')).toBe('OLA-ONLY: you are heartbroken because Ola left you.\n');
    // Reloaded from disk (e.g. after a restart or "Reload from disk").
    e.services.people.load();
    expect(e.services.people.get(person.slug)?.customPersona).toMatch(/^OLA-ONLY/);
  });

  it('is used in their chat once approved, after the shared rules, and not before', async () => {
    const e = env();
    const { cookie, token, id } = await claimedOla(e);
    await chat(e, token); // pending claim: not them yet
    expect(lastSystem()).toContain('EMO-MARKER');
    expect(lastSystem()).not.toContain('OLA-ONLY');

    await request(e.app).post(`/api/admin/claims/${id}/approve`).set('cookie', cookie);
    await chat(e, token);
    expect(lastSystem()).toMatch(/^RULES-MARKER\n\nOLA-ONLY/);
    expect(e.services.sessions.get(id)?.personaId).toBeNull(); // nothing copied into the session

    // Other guests are unaffected.
    const per = await newGuest(e, 'Per');
    await chat(e, per.token);
    expect(lastSystem()).toContain('EMO-MARKER');
  });

  it('a persona picked for their session still wins, and "global" goes back to theirs', async () => {
    const e = env();
    const { cookie, token, id } = await claimedOla(e);
    await request(e.app).post(`/api/admin/claims/${id}/approve`).set('cookie', cookie);
    const session = await request(e.app).put(`/api/admin/sessions/${id}/persona`).set('cookie', cookie).send({ id: 'nihilist' });
    expect(session.body.session.person).toMatchObject({ name: 'Ola', hasCustomPersona: true });
    await chat(e, token);
    expect(lastSystem()).toContain('NIHIL-MARKER');
    await request(e.app).put(`/api/admin/sessions/${id}/persona`).set('cookie', cookie).send({ id: null });
    await chat(e, token);
    expect(lastSystem()).toContain('OLA-ONLY');
  });

  it('is kept when the form leaves it out, and removed when emptied', async () => {
    const e = env();
    const { cookie, person } = await claimedOla(e);
    const put = (body: object) => request(e.app).put(`/api/admin/people/${person.slug}`).set('cookie', cookie).send({ name: 'Ola', ...body });
    expect((await put({ info: 'New info' })).body.person.customPersona).toMatch(/^OLA-ONLY/);
    const cleared = await put({ customPersona: '', persona: 'drama' });
    expect(cleared.body.person).toMatchObject({ customPersona: null, persona: 'drama' });
    expect(fs.existsSync(path.join(e.config.peopleDir, person.slug, 'persona.md'))).toBe(false);
    expect((await put({ customPersona: 'x'.repeat(20_001) })).status).toBe(400);
  });
});
