import { useState } from 'react';

/**
 * Shown while a reserved-name claim is pending. The guest shows the code to
 * the host in person; tapping it opens a full-screen version that's easy to read.
 */
export function ClaimBanner({ code }: { code: string }) {
  const [big, setBig] = useState(false);

  return (
    <>
      <button type="button" className="claim-banner" onClick={() => setBig(true)} aria-label={`Claim code ${code}, tap to enlarge`}>
        <span className="claim-banner__text">Prove you're really you: find SadGPT's human and show this code</span>
        <span className="claim-banner__code">{code}</span>
      </button>
      {big && (
        <div className="claim-overlay" role="dialog" aria-modal="true" aria-label="Claim code" onClick={() => setBig(false)}>
          <p className="claim-overlay__label">Show this to SadGPT's human</p>
          <p className="claim-overlay__code" data-testid="claim-code-big">
            {code}
          </p>
          <p className="claim-overlay__hint">You can keep chatting while you wait. Tap to close.</p>
        </div>
      )}
    </>
  );
}
