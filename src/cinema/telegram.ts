import { createHash } from 'node:crypto';

type DeliveryCode = 'transient' | 'rejected' | 'uncertain';

export class TelegramDeliveryError extends Error {
  readonly code: DeliveryCode;

  constructor(code: DeliveryCode) {
    // Fetch errors and Bot API descriptions can include the token or private metadata.
    super(`Telegram document delivery: ${code}`);
    this.name = 'TelegramDeliveryError';
    this.code = code;
  }
}

export interface TorrentReceipt {
  command: string;
  digest: string;
  status: 'stored' | 'rejected' | 'uncertain';
}

const commandId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const telegramTimeoutMs = 15_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPeer(peerId: string): boolean {
  return /^[1-9]\d{0,15}$/.test(peerId) && Number.isSafeInteger(Number(peerId));
}

function privatePeer(chat: unknown, peerId: string): boolean {
  return record(chat) && chat.type === 'private' && chat.id === Number(peerId);
}

interface TelegramAnswer {
  response: Response;
  payload: unknown;
}

function returnedMessage({ response, payload }: TelegramAnswer, ambiguous: DeliveryCode): Record<string, unknown> {
  if (record(payload) && payload.ok === false && payload.error_code === response.status) {
    if (response.status === 429) throw new TelegramDeliveryError('transient');
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new TelegramDeliveryError('rejected');
    }
  }
  if (!response.ok || !record(payload) || payload.ok !== true || !record(payload.result)) {
    throw new TelegramDeliveryError(ambiguous);
  }
  return payload.result;
}

export async function sendTorrentDocument(
  token: string, peerId: string, command: string, digest: string, bytes: Buffer,
  fetchImpl: typeof fetch = fetch, peerUsername?: string,
): Promise<void> {
  if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token) || !validPeer(peerId) ||
      !commandId.test(command) || !sha256.test(digest) || !bytes.length ||
      createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new TelegramDeliveryError('rejected');
  }

  const caption = `jarvis.torrent/1 ${command} ${digest}`;
  const body = new FormData();
  body.set('chat_id', peerId);
  body.set('caption', caption);
  body.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/x-bittorrent' }), `${command}.torrent`);

  const signal = AbortSignal.timeout(telegramTimeoutMs);
  async function post(method: 'sendDocument' | 'sendMessage', form: FormData | URLSearchParams): Promise<TelegramAnswer> {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', body: form, redirect: 'error', signal,
      });
      return { response, payload: await response.json() };
    } catch {
      throw new TelegramDeliveryError(method === 'sendMessage' ? 'transient' : 'uncertain');
    }
  }

  let reply = await post('sendDocument', body);
  if (peerUsername && /^@[a-zA-Z0-9_]{1,32}$/.test(peerUsername) && reply.response.status === 400 &&
      record(reply.payload) && reply.payload.ok === false && reply.payload.error_code === 400 &&
      reply.payload.description === 'Bad Request: chat not found') {
    // A username can change owners. Only a neutral greeting may be sent to that address.
    const greeting = new URLSearchParams({ chat_id: peerUsername, text: 'Hello.' });
    const opened = returnedMessage(await post('sendMessage', greeting), 'transient');
    if (!privatePeer(opened.chat, peerId)) throw new TelegramDeliveryError('rejected');
    reply = await post('sendDocument', body);
  }
  const message = returnedMessage(reply, 'uncertain');
  if (!privatePeer(message.chat, peerId) ||
      typeof message.message_id !== 'number' || !Number.isSafeInteger(message.message_id) || message.message_id <= 0 ||
      message.caption !== caption || !record(message.document) || typeof message.document.file_id !== 'string' ||
      !message.document.file_id) {
    throw new TelegramDeliveryError('uncertain');
  }
}

export function parseTorrentReceipt(update: unknown, peerId: string): TorrentReceipt | null {
  if (!validPeer(peerId) || !record(update) || !record(update.message)) return null;
  const message = update.message;
  if (!privatePeer(message.chat, peerId) || !record(message.from) || message.from.id !== Number(peerId) ||
      message.from.is_bot !== true || typeof message.text !== 'string' ||
      'forward_origin' in message || 'forward_date' in message || 'is_automatic_forward' in message ||
      'sender_chat' in message || 'via_bot' in message || 'sender_business_bot' in message ||
      'business_connection_id' in message) return null;

  const fields = message.text.split(' ');
  const [protocol, command, digest, status] = fields;
  if (fields.length !== 4 || protocol !== 'filmobot.torrent/1' ||
      !command || !commandId.test(command) || !digest || !sha256.test(digest) ||
      (status !== 'stored' && status !== 'rejected' && status !== 'uncertain')) return null;
  return { command, digest, status };
}
