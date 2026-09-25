'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, CheckCircle2, AlertTriangle, Send } from 'lucide-react';
import { closedAppAlertStatus, sendTestPush, type ClosedAppAlertStatus } from '@/lib/push-client';

/** A watcher that has not run for this long has stopped; it runs every minute. */
const STALE_AFTER_MS = 5 * 60_000;

interface AlertsStatusProps {
  /** Changes when the user grants permission, so the panel re-reads its state. */
  permission: string;
  onRequestNotification: () => void;
  theme?: 'dark' | 'light';
}

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Whether trade alerts will reach this phone with the app closed, and a way
 * to prove it. Two things must both work: the phone must be signed up, and the
 * server's scheduled watcher must be running. Either one failing looks the same
 * from the phone, alerts that appear only once the app is opened, so each is
 * shown on its own.
 */
export default function AlertsStatus({ permission, onRequestNotification, theme = 'dark' }: AlertsStatusProps) {
  const isDark = theme === 'dark';
  // Read together with the moment it was read, so the age of the last check
  // is worked out when the status arrives rather than on every render.
  const [status, setStatus] = useState<(ClosedAppAlertStatus & { readAt: number }) | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const refresh = useCallback(() => {
    void closedAppAlertStatus().then((next) => setStatus({ ...next, readAt: Date.now() }));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh, permission]);

  const handleTest = async () => {
    setTesting(true);
    const error = await sendTestPush();
    setTesting(false);
    setTestNote(
      error ??
        'Test on its way in 10 seconds. Close the app now: if the notification appears with the app closed, alerts work on this phone.'
    );
  };

  if (!status || !status.supported) return null;

  const watcherAlive = status.lastCheckAt !== null && status.readAt - Date.parse(status.lastCheckAt) < STALE_AFTER_MS;
  const phoneReady = status.permission === 'granted' && status.subscribed;
  const allGood = status.serverEnabled && watcherAlive && phoneReady;

  const muted = isDark ? 'text-slate-400' : 'text-slate-600';
  const good = 'text-emerald-500';
  const bad = 'text-rose-500';

  return (
    <div
      id="closed-app-alerts-status"
      className={`border rounded-2xl p-4 text-xs space-y-2 ${
        isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      <div className="flex items-center gap-2">
        <BellRing className={`w-4 h-4 ${allGood ? good : 'text-amber-500'}`} />
        <span className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
          Alerts with the app closed
        </span>
        <span className={`ml-auto font-bold ${allGood ? good : bad}`}>{allGood ? 'Working' : 'Not working'}</span>
      </div>

      <div className="flex items-start gap-1.5">
        {phoneReady ? <CheckCircle2 className={`w-3.5 h-3.5 mt-0.5 ${good}`} /> : <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 ${bad}`} />}
        <span className={muted}>
          <strong>This phone:</strong>{' '}
          {phoneReady
            ? 'signed up for alerts.'
            : status.permission === 'denied'
              ? 'notifications are blocked. Allow them in the phone settings for this app.'
              : 'not signed up yet.'}
          {!phoneReady && status.permission !== 'denied' && (
            <button
              type="button"
              onClick={onRequestNotification}
              className="ml-2 px-2 py-0.5 rounded-md bg-sky-500 text-slate-950 font-bold cursor-pointer"
            >
              Allow alerts
            </button>
          )}
        </span>
      </div>

      <div className="flex items-start gap-1.5">
        {status.serverEnabled && watcherAlive ? (
          <CheckCircle2 className={`w-3.5 h-3.5 mt-0.5 ${good}`} />
        ) : (
          <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 ${bad}`} />
        )}
        <span className={muted}>
          <strong>Server watch:</strong>{' '}
          {!status.serverEnabled
            ? 'not configured on the server.'
            : watcherAlive
              ? `running, last check ${ago(status.lastCheckAt!, status.readAt)}.`
              : `stopped${status.lastCheckAt ? `, last check ${ago(status.lastCheckAt, status.readAt)}` : ', it has never run'}. The scheduler (cron-job.org) must call /api/push/check every minute; until it does, alerts only appear once the app is opened.`}
        </span>
      </div>

      {phoneReady && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            id="push-test-btn"
            disabled={testing}
            onClick={handleTest}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold cursor-pointer disabled:opacity-50"
          >
            <Send className="w-3 h-3" /> {testing ? 'Sending…' : 'Send a test notification'}
          </button>
          {testNote && <span className={muted}>{testNote}</span>}
        </div>
      )}

      <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
        If the test only shows after you open the app, the phone is holding Chrome back. On Xiaomi, Oppo, Vivo and
        Samsung: Settings → Apps → Chrome → Battery → No restrictions, turn Autostart on, and allow notifications.
      </p>
    </div>
  );
}
