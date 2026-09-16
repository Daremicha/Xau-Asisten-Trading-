'use client';

/**
 * Last line of defence: catches an error thrown by the root layout itself,
 * where app/error.tsx cannot help because the layout never mounted.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#020617', color: '#e2e8f0', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ maxWidth: 420, border: '1px solid rgba(244,63,94,0.4)', background: 'rgba(244,63,94,0.1)', borderRadius: 16, padding: 24 }}>
            <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>The application failed to start</h1>
            <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.6, margin: 0 }}>
              Your saved data is untouched. Reloading usually clears this.
            </p>
            {error.digest && (
              <p style={{ fontSize: 12, fontFamily: 'monospace', color: '#64748b', marginTop: 8 }}>
                Reference: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              style={{ marginTop: 16, background: '#f59e0b', color: '#020617', fontWeight: 700, border: 0, padding: '8px 16px', borderRadius: 12, fontSize: 14, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
