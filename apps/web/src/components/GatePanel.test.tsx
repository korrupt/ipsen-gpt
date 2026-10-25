import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { setToken } from '../lib/session';
import { fakeServer, guestSession, json, sse, streamResponse, tokens } from '../test-utils';
import { CONSENT_LABEL, UNREADABLE_PHOTO } from './GatePanel';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

const GATE = { id: 'g1', prompt: 'Bring me a pumpkin!', deadlineAt: null };

/**
 * jsdom can't decode images or draw: fake createImageBitmap and the canvas,
 * and record the canvas size the photo is drawn at.
 */
function stubImages({ width = 2000, height = 1000, decodable = true } = {}) {
  const drawn: [number, number][] = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => {
      if (!decodable) throw new Error('cannot decode');
      return { width, height, close: vi.fn() };
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { drawImage: () => drawn.push([this.width, this.height]) } as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => cb(new Blob(['small-jpeg'], { type: 'image/jpeg' })));
  return drawn;
}

const photo = () => new File(['full-size-original'], 'IMG_0001.JPG', { type: 'image/jpeg' });
const takePhoto = () => screen.getByRole('button', { name: /take photo/i });
const consent = () => screen.getByRole('checkbox', { name: CONSENT_LABEL });

function returningGuest(routes: Parameters<typeof fakeServer>[0], gate: unknown = GATE) {
  setToken('tok');
  return fakeServer({ 'GET /api/session': () => json({ session: guestSession(), messages: [], gate }), ...routes });
}

async function upload(file = photo()) {
  await userEvent.click(consent());
  await userEvent.upload(screen.getByTestId('gate-file'), file);
}

describe('photo gate', () => {
  it('a new guest facing a gate sees the demand; the camera needs consent first', async () => {
    fakeServer({ 'POST /api/session': () => json({ token: 't', session: guestSession(), gate: GATE }, 201) });
    render(<App />);
    await userEvent.type(screen.getByRole('textbox', { name: /your name/i }), 'Kari{Enter}');
    expect(await screen.findByText('Bring me a pumpkin!')).toBeTruthy();
    expect(takePhoto()).toHaveProperty('disabled', true);
    await userEvent.click(consent());
    expect(takePhoto()).toHaveProperty('disabled', false);
    // Chat stays open: messages get in-character refusals from the server.
    expect(screen.getByRole('textbox', { name: /message ipsengpt/i })).toBeTruthy();
  });

  it('sends a resized copy, then the original; a pass removes the gate and IpsenGPT speaks', async () => {
    const drawn = stubImages({ width: 4000, height: 3000 });
    const fetch = returningGuest({
      'POST /api/photos/verify': () =>
        json({ attemptId: 'a1', result: 'passed', message: 'The spirits accept your offering.', reason: null, gate: null }),
      'PUT /api/photos/a1/original': () => json({ ok: true, processed: true }),
    });
    render(<App />);
    await screen.findByText('Bring me a pumpkin!');
    const original = photo();
    await upload(original);

    expect(await screen.findByText('The spirits accept your offering.')).toBeTruthy();
    expect(screen.queryByText('Bring me a pumpkin!')).toBeNull();
    expect(drawn).toEqual([[768, 576]]);

    const verify = fetch.mock.calls.find(([url]) => url.startsWith('/api/photos/verify'))!;
    expect(verify[0]).toBe('/api/photos/verify?gate=g1&consent=1');
    expect(verify[1].headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'image/jpeg' });
    expect(await (verify[1].body as Blob).text()).toBe('small-jpeg');
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/photos/a1/original')).toBe(true));
    const orig = fetch.mock.calls.find(([url]) => url === '/api/photos/a1/original')!;
    expect(orig[1].body).toBe(original);
  });

  it('a failed photo shows the line and what IpsenGPT saw; the gate stays', async () => {
    stubImages();
    returningGuest({
      'POST /api/photos/verify': () =>
        json({ attemptId: 'a1', result: 'failed', message: 'That is not what I asked for.', reason: 'A cat on a sofa.', gate: GATE }),
      'PUT /api/photos/a1/original': () => json({ ok: true, processed: true }),
    });
    render(<App />);
    await screen.findByText('Bring me a pumpkin!');
    await upload();
    const status = await screen.findByRole('status');
    expect(status.textContent).toBe('That is not what I asked for.IpsenGPT saw: A cat on a sofa.');
    expect(screen.getByText('Bring me a pumpkin!')).toBeTruthy();
    expect(takePhoto()).toHaveProperty('disabled', false);
  });

  it('a photo the browser cannot read is never sent', async () => {
    // createImageBitmap fails, and so does the <img> fallback (jsdom can't decode either).
    stubImages({ decodable: false });
    const fetch = returningGuest({});
    render(<App />);
    await screen.findByText('Bring me a pumpkin!');
    await upload();
    expect((await screen.findByRole('status')).textContent).toBe(UNREADABLE_PHOTO);
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/photos'))).toBe(false);
  });

  it('server errors are shown in the panel', async () => {
    stubImages();
    returningGuest({ 'POST /api/photos/verify': () => json({ error: 'Slow down, mortal.' }, 429) });
    render(<App />);
    await screen.findByText('Bring me a pumpkin!');
    await upload();
    expect((await screen.findByRole('status')).textContent).toBe('Slow down, mortal.');
  });

  it('if the gate closed meanwhile, the next one (or none) takes its place', async () => {
    stubImages();
    returningGuest({
      'POST /api/photos/verify': () =>
        json({ error: 'That gate is no longer open.', code: 'gate_closed', gate: { id: 'g2', prompt: 'Now a candle.', deadlineAt: null } }, 409),
    });
    render(<App />);
    await screen.findByText('Bring me a pumpkin!');
    await upload();
    expect(await screen.findByText('Now a candle.')).toBeTruthy();
    expect(screen.queryByText('Bring me a pumpkin!')).toBeNull();
  });

  it('a gate that appears mid-chat shows up with the refusal', async () => {
    returningGuest(
      {
        'POST /api/chat': () => streamResponse([sse('gate', GATE), tokens('No pumpkin, no talk.'), sse('done', {})]).response,
      },
      null,
    );
    render(<App />);
    await userEvent.type(await screen.findByRole('textbox', { name: /message ipsengpt/i }), 'hello{Enter}');
    expect(await screen.findByText('Bring me a pumpkin!')).toBeTruthy();
    expect(screen.getByTestId('msg-assistant').textContent).toBe('No pumpkin, no talk.');
  });

  it('counts down to the deadline, then asks the server what is next', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let gate: unknown = { ...GATE, deadlineAt: Date.now() + 65_000 };
    returningGuest({ 'GET /api/session': () => json({ session: guestSession(), messages: [], gate }) });
    render(<App />);
    expect((await screen.findByTestId('gate-deadline')).textContent).toBe('1:05 left');
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(screen.getByTestId('gate-deadline').textContent).toBe('0:59 left');
    gate = null;
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await waitFor(() => expect(screen.queryByText('Bring me a pumpkin!')).toBeNull());
  });
});
