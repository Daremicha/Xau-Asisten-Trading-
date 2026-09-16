'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Catches a render error anywhere below the layout. Without this, one thrown
 * error blanks the entire page with no explanation and no way back.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Trading terminal render error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 px-4">
      <div className="max-w-md w-full border border-rose-500/40 bg-rose-500/10 rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="p-2 rounded-lg bg-black/30 text-rose-400">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-bold">Something broke on this screen</h1>
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">
          Your saved balance and trade history are untouched. Only this view failed to render.
        </p>
        {error.digest && (
          <p className="text-xs font-mono text-slate-500 mt-2">Reference: {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold px-4 py-2 rounded-xl text-sm cursor-pointer"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
      </div>
    </div>
  );
}
