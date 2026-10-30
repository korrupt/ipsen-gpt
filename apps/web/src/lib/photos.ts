import { ApiError, authHeaders, checkResponse, NETWORK_ERROR } from './session';

export interface GateView {
  id: string;
  /** What SadGPT demands, in character. */
  prompt: string;
  /** When the gate expires (ms since epoch), or null. */
  deadlineAt: number | null;
}

export type VerifyResult =
  | {
      kind: 'verdict';
      attemptId: string;
      result: 'passed' | 'failed' | 'unverified';
      message: string;
      /** What the model saw, on a failed photo. */
      reason: string | null;
      /** The gate the guest faces now (the next one, or null when free). */
      gate: GateView | null;
    }
  /** The gate expired, was cancelled or already passed meanwhile. */
  | { kind: 'closed'; gate: GateView | null };

/** Longest side of the copy sent for verification. The server would shrink it anyway. */
export const VERIFY_MAX_SIDE = 768;
/** Same limit as the server; bigger originals aren't uploaded at all. */
export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

/** Decodes with EXIF orientation applied. createImageBitmap first, <img> as a fallback (older Safari). */
async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch {
      // fall through to <img>
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** A JPEG of at most 768 px on the long side: quick to send over party Wi-Fi. */
export async function resizeForVerify(file: Blob): Promise<Blob> {
  const img = await decode(file);
  try {
    const scale = Math.min(1, VERIFY_MAX_SIDE / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), 'image/jpeg', 0.85),
    );
  } finally {
    img.done();
  }
}

/** Sends the resized photo and waits for the verdict. Throws SessionGoneError or ApiError. */
export async function verifyPhoto(gateId: string, photo: Blob): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(`/api/photos/verify?gate=${encodeURIComponent(gateId)}&consent=1`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'image/jpeg' },
      body: photo,
    });
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }
  if (res.status === 409) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string; gate?: GateView | null } | null;
    if (body?.code === 'gate_closed') return { kind: 'closed', gate: body.gate ?? null };
  }
  await checkResponse(res);
  return { kind: 'verdict', ...((await res.json()) as Omit<Extract<VerifyResult, { kind: 'verdict' }>, 'kind'>) };
}

/** Uploads the full-size photo for the album. Best effort: the gate never depends on it. */
export async function uploadOriginal(attemptId: string, file: Blob): Promise<void> {
  if (file.size > MAX_ORIGINAL_BYTES) return;
  try {
    await fetch(`/api/photos/${encodeURIComponent(attemptId)}/original`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'content-type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    // The verdict already counted; a lost original only means a missing album photo.
  }
}
