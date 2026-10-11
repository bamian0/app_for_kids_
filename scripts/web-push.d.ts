// Types for the parts of web-push 3.6 the reminders job uses (the package ships none).
declare module 'web-push' {
  export interface PushSubscription {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }

  export interface RequestOptions {
    /** Seconds the push service keeps an undelivered message. */
    TTL?: number
    urgency?: 'very-low' | 'low' | 'normal' | 'high'
    topic?: string
    timeout?: number
  }

  export interface SendResult {
    statusCode: number
    body: string
    headers: Record<string, string>
  }

  export interface VapidKeys {
    publicKey: string
    privateKey: string
  }

  export class WebPushError extends Error {
    statusCode: number
    body: string
    endpoint: string
  }

  export function generateVAPIDKeys(): VapidKeys
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void
  export function sendNotification(subscription: PushSubscription, payload?: string | null, options?: RequestOptions): Promise<SendResult>

  const webpush: {
    generateVAPIDKeys: typeof generateVAPIDKeys
    setVapidDetails: typeof setVapidDetails
    sendNotification: typeof sendNotification
    WebPushError: typeof WebPushError
  }
  export default webpush
}
