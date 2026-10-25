import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Db } from './db.js';

// One party, one small droplet: decode one image at a time and keep no cache.
sharp.concurrency(1);
sharp.cache(false);

export type ImageType = 'jpeg' | 'png' | 'webp' | 'heif';

const MIME: Record<ImageType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heif: 'image/heif',
};

/** ISO-BMFF brands of HEIC/HEIF/AVIF stills. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/** Identifies an image by its first bytes; the name and Content-Type are never trusted. */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(buf.toString('latin1', 8, 12))) return 'heif';
  return null;
}

/** Longest side of the image the model sees. */
export const VERIFY_MAX_SIDE = 768;

/**
 * The copy the model judges and admin thumbnails show: upright, at most
 * 768 px, JPEG, no metadata (sharp drops it unless asked to keep it).
 */
export async function makeResized(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize(VERIFY_MAX_SIDE, VERIFY_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * The full-size photo, upright and without EXIF (GPS, device). Formats sharp
 * can't decode (HEIC) are kept as uploaded and flagged for the admin.
 */
export async function processOriginal(
  buf: Buffer,
  type: ImageType,
): Promise<{ data: Buffer; ext: string; mime: string; processed: boolean }> {
  try {
    const data = await sharp(buf).rotate().jpeg({ quality: 92 }).toBuffer();
    return { data, ext: 'jpg', mime: 'image/jpeg', processed: true };
  } catch {
    return { data: buf, ext: type === 'heif' ? 'heic' : type, mime: MIME[type], processed: false };
  }
}

export type AttemptStatus = 'verifying' | 'passed' | 'failed' | 'unverified';

export interface PhotoAttempt {
  id: string;
  sessionId: string;
  gateId: string | null;
  target: string;
  status: AttemptStatus;
  containsTarget: boolean | null;
  confidence: number | null;
  reason: string | null;
  error: string | null;
  resizedFile: string | null;
  originalFile: string | null;
  originalMime: string | null;
  originalBytes: number | null;
  originalProcessed: boolean | null;
  consentAt: number;
  createdAt: number;
  verifiedAt: number | null;
  deletedAt: number | null;
}

interface Row {
  id: string;
  session_id: string;
  gate_id: string | null;
  target: string;
  status: AttemptStatus;
  contains_target: number | null;
  confidence: number | null;
  reason: string | null;
  error: string | null;
  resized_file: string | null;
  original_file: string | null;
  original_mime: string | null;
  original_bytes: number | null;
  original_processed: number | null;
  consent_at: number;
  created_at: number;
  verified_at: number | null;
  deleted_at: number | null;
}

const bool = (v: number | null) => (v === null ? null : v === 1);

const toAttempt = (r: Row): PhotoAttempt => ({
  id: r.id,
  sessionId: r.session_id,
  gateId: r.gate_id,
  target: r.target,
  status: r.status,
  containsTarget: bool(r.contains_target),
  confidence: r.confidence,
  reason: r.reason,
  error: r.error,
  resizedFile: r.resized_file,
  originalFile: r.original_file,
  originalMime: r.original_mime,
  originalBytes: r.original_bytes,
  originalProcessed: bool(r.original_processed),
  consentAt: r.consent_at,
  createdAt: r.created_at,
  verifiedAt: r.verified_at,
  deletedAt: r.deleted_at,
});

export interface Verdict {
  containsTarget: boolean;
  confidence: number;
  reason: string;
}

/**
 * Every attempt is kept (passed, failed, unverified) with its files under
 * `dir`, named randomly. Files are only ever served to the admin.
 */
export class PhotoStore {
  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  get(id: string): PhotoAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM photo_attempts WHERE id = ?').get(id) as Row | undefined;
    return row && toAttempt(row);
  }

  /** Not deleted, newest first, with the session's name. */
  list(limit = 500): (PhotoAttempt & { sessionName: string | null })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, s.name AS session_name FROM photo_attempts p JOIN sessions s ON s.id = p.session_id
         WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
      )
      .all(limit) as (Row & { session_name: string | null })[];
    return rows.map((r) => ({ ...toAttempt(r), sessionName: r.session_name }));
  }

  forSession(sessionId: string): PhotoAttempt[] {
    return (
      this.db
        .prepare('SELECT * FROM photo_attempts WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC')
        .all(sessionId) as Row[]
    ).map(toAttempt);
  }

  /**
   * Records a new attempt with its resized photo, before verification starts.
   * Consent was checked in the same request, so it's timestamped now.
   */
  create(a: { sessionId: string; gateId: string; target: string; resized: Buffer }): PhotoAttempt {
    const id = crypto.randomUUID();
    const file = this.write(a.resized, 'jpg');
    this.db
      .prepare(
        `INSERT INTO photo_attempts (id, session_id, gate_id, target, status, resized_file, consent_at, created_at)
         VALUES (?, ?, ?, ?, 'verifying', ?, ?, ?)`,
      )
      .run(id, a.sessionId, a.gateId, a.target, file, this.now(), this.now());
    return this.get(id)!;
  }

  setVerdict(id: string, status: 'passed' | 'failed', v: Verdict): void {
    this.db
      .prepare(
        `UPDATE photo_attempts SET status = ?, contains_target = ?, confidence = ?, reason = ?, verified_at = ? WHERE id = ?`,
      )
      .run(status, v.containsTarget ? 1 : 0, v.confidence, v.reason, this.now(), id);
  }

  setUnverified(id: string, error: string): void {
    this.db
      .prepare(`UPDATE photo_attempts SET status = 'unverified', error = ?, verified_at = ? WHERE id = ?`)
      .run(error.slice(0, 500), this.now(), id);
  }

  /** Stores the original once per attempt; false if one is already stored. */
  setOriginal(id: string, o: { data: Buffer; ext: string; mime: string; processed: boolean }): boolean {
    const file = this.write(o.data, o.ext);
    const r = this.db
      .prepare(
        `UPDATE photo_attempts SET original_file = ?, original_mime = ?, original_bytes = ?, original_processed = ?
         WHERE id = ? AND original_file IS NULL AND deleted_at IS NULL`,
      )
      .run(file, o.mime, o.data.length, o.processed ? 1 : 0, id);
    if (r.changes === 0) fs.rmSync(path.join(this.dir, file), { force: true });
    return r.changes === 1;
  }

  /** Absolute path of a stored file, if it still exists. */
  filePath(file: string | null): string | null {
    if (!file) return null;
    const p = path.join(this.dir, file);
    return fs.existsSync(p) ? p : null;
  }

  /** Deletes the files; the record stays (marked deleted) so the gate history still adds up. */
  delete(id: string): boolean {
    const a = this.get(id);
    if (!a || a.deletedAt !== null) return false;
    for (const f of [a.resizedFile, a.originalFile]) if (f) fs.rmSync(path.join(this.dir, f), { force: true });
    this.db
      .prepare('UPDATE photo_attempts SET deleted_at = ?, resized_file = NULL, original_file = NULL WHERE id = ?')
      .run(this.now(), id);
    return true;
  }

  private write(data: Buffer, ext: string): string {
    const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(this.dir, file), data, { mode: 0o640 });
    return file;
  }
}
