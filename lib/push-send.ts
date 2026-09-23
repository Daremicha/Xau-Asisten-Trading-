import webpush from 'web-push';
import type { PushMessage, StoredSubscription } from './push-watch';

function vapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  // Push services contact this address if the sender misbehaves; it must be a
  // mailto: or an https URL.
  const subject =
    process.env.VAPID_SUBJECT?.trim() ||
    (process.env.APP_URL?.startsWith('https://') ? process.env.APP_URL : 'https://xau-asisten-trading-fz2o.vercel.app');
  return { publicKey, privateKey, subject };
}

export function vapidPublicKey(): string | null {
  return vapid()?.publicKey ?? null;
}

export type SendOutcome = 'sent' | 'gone' | 'failed';

/** Delivers one message. 'gone' means the phone unsubscribed and the record can go. */
export async function sendPush(subscription: StoredSubscription, message: PushMessage): Promise<SendOutcome> {
  const keys = vapid();
  if (!keys) return 'failed';
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({ title: message.title, body: message.body, tag: message.tag }),
      {
        vapidDetails: keys,
        TTL: 60 * 60,
        urgency: 'high',
      }
    );
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'gone';
    console.warn('Push delivery failed:', status ?? err);
    return 'failed';
  }
}
