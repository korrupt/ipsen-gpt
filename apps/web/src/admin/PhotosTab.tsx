import { useState } from 'react';
import { adminApi, ago, PHOTO_STATUS_LABELS, photoUrl, type AdminPhoto, type PhotoStatus } from './api';
import { usePoll } from './usePoll';

interface Props {
  toast: (msg: string) => void;
}

const FILTERS: (PhotoStatus | 'all')[] = ['all', 'passed', 'failed', 'unverified'];

export function PhotoGrid({ photos, onOpen }: { photos: AdminPhoto[]; onOpen: (p: AdminPhoto) => void }) {
  return (
    <ul className="photo-grid">
      {photos.map((p) => (
        <li key={p.id}>
          <button className="photo-grid__item" onClick={() => onOpen(p)} aria-label={`${p.sessionName ?? 'Guest'}: ${p.target}`}>
            {p.hasResized ? <img src={photoUrl(p.id, 'resized')} alt="" loading="lazy" /> : <span className="photo-grid__missing">?</span>}
            <span className={`badge badge--photo-${p.status}`}>{PHOTO_STATUS_LABELS[p.status]}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PhotoDetail({ photo, onBack, onDeleted, toast }: { photo: AdminPhoto; onBack: () => void; onDeleted: () => void; toast: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (!window.confirm('Delete this photo for good? The original and the small copy are both removed.')) return;
    setBusy(true);
    try {
      await adminApi.deletePhoto(photo.id);
      toast('Photo deleted');
      onDeleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  };

  return (
    <section className="admin-tab">
      <button className="btn btn--ghost" onClick={onBack}>
        ← Photos
      </button>
      {photo.hasResized && <img className="photo-detail__img" src={photoUrl(photo.id, 'resized')} alt={`Photo for: ${photo.target}`} />}
      <div className="card">
        <div className="card__row">
          <strong>{photo.sessionName ?? <em>no name</em>}</strong>
          <span className={`badge badge--photo-${photo.status}`}>{PHOTO_STATUS_LABELS[photo.status]}</span>
        </div>
        <div>Asked for: {photo.target}</div>
        {photo.reason && (
          <div>
            Model saw: <em>{photo.reason}</em>
            {photo.confidence !== null && <span className="admin-muted"> ({Math.round(photo.confidence * 100)}% sure)</span>}
          </div>
        )}
        {photo.error && <div className="admin-error admin-error-detail">{photo.error}</div>}
        <div className="admin-muted">
          {ago(photo.createdAt)} · consent given {new Date(photo.consentAt).toLocaleTimeString('nb-NO')}
        </div>
      </div>
      <div className="card">
        {photo.hasOriginal ? (
          <>
            <div className="card__actions">
              <a className="btn" href={photoUrl(photo.id, 'original')} target="_blank" rel="noreferrer">
                Open original
              </a>
              <a className="btn" href={photoUrl(photo.id, 'original', true)}>
                Download
              </a>
            </div>
            <div className="admin-muted">
              {photo.originalMime} · {((photo.originalBytes ?? 0) / 1024 / 1024).toFixed(1)} MB
            </div>
            {photo.originalProcessed === false && (
              <div className="admin-error" role="note">
                Stored as uploaded (the server couldn't read this format), so it may still contain location data. Check before
                sharing.
              </div>
            )}
          </>
        ) : (
          <div className="admin-muted">No original uploaded (only the small copy).</div>
        )}
      </div>
      <button className="btn btn--danger" disabled={busy} onClick={() => void remove()}>
        Delete photo
      </button>
    </section>
  );
}

export function PhotosTab({ toast }: Props) {
  const { data: photos, reload, error } = usePoll(adminApi.photos, 10000);
  const [filter, setFilter] = useState<PhotoStatus | 'all'>('all');
  const [open, setOpen] = useState<AdminPhoto | null>(null);

  if (open) {
    return (
      <PhotoDetail
        photo={open}
        toast={toast}
        onBack={() => setOpen(null)}
        onDeleted={() => {
          setOpen(null);
          void reload();
        }}
      />
    );
  }

  const shown = (photos ?? []).filter((p) => filter === 'all' || p.status === filter);

  return (
    <section className="admin-tab">
      <div className="chips" role="group" aria-label="Filter photos">
        {FILTERS.map((f) => (
          <button key={f} className={`chip${filter === f ? ' chip--active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : PHOTO_STATUS_LABELS[f]}
            {photos && ` ${f === 'all' ? photos.length : photos.filter((p) => p.status === f).length}`}
          </button>
        ))}
      </div>
      {photos === null && <p className="admin-muted">{error ?? 'Loading…'}</p>}
      {photos !== null && shown.length === 0 && <p className="admin-muted">No photos yet.</p>}
      <PhotoGrid photos={shown} onOpen={setOpen} />
    </section>
  );
}
