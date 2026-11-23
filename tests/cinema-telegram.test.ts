import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseTorrentReceipt, sendTorrentDocument, TelegramDeliveryError } from '../src/cinema/telegram.ts';

const token = '91:mock-token';
const peer = '7000001234';
const chat = { id: Number(peer), type: 'private' };
const from = { id: Number(peer), is_bot: true };
const bytes = Buffer.from([0x64, 0xff, 0, 0x65]);
const command = 'abcdef12-3456-4789-8123-456789abcdef';
const digest = createHash('sha256').update(bytes).digest('hex');
const caption = `jarvis.torrent/1 ${command} ${digest}`;
const stored = `filmobot.torrent/1 ${command} ${digest} stored`;
const receipt = { from, chat, text: stored };
const sent = { message_id: 72, chat, caption, document: { file_id: 'tg-file' } };

test('sendDocument загружает исходные байты с точной подписью в личный чат Filmobot', async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, `https://api.telegram.org/bot${token}/sendDocument`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get('chat_id'), peer);
    assert.equal(init.body.get('caption'), caption);
    const document = init.body.get('document');
    assert.ok(document instanceof File);
    assert.equal(document.name, `${command}.torrent`);
    assert.equal(document.type, 'application/x-bittorrent');
    assert.deepEqual(Buffer.from(await document.arrayBuffer()), bytes);
    return Response.json({ ok: true, result: sent });
  };
  await sendTorrentDocument(token, peer, command, digest, bytes, request);
  assert.equal(calls, 1);
});

function deliveryCode(code: TelegramDeliveryError['code']) {
  return (error: unknown) => error instanceof TelegramDeliveryError && error.code === code &&
    !error.message.includes(token) && error.cause === undefined;
}

test('при первом контакте только приветствие идёт по username, обе попытки отправки файла адресованы числовому ID', async () => {
  const username = '@cinema_bot';
  const missing = () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 });
  for (const openedChat of [chat, { ...chat, id: 42 }, { ...chat, type: 'group' }]) {
    const calls: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const method = String(url).split('/').pop()!;
      calls.push(method);
      if (method === 'sendMessage') {
        assert.ok(init?.body instanceof URLSearchParams);
        assert.deepEqual([...init.body], [['chat_id', username], ['text', 'Hello.']]);
        return Response.json({ ok: true, result: { message_id: 1, chat: openedChat, text: 'Hello.' } });
      }
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('chat_id'), peer);
      assert.equal(init.body.get('caption'), caption);
      assert.ok(init.body.get('document') instanceof File);
      return calls.length === 1 ? missing() : Response.json({ ok: true, result: sent });
    };
    const delivery = sendTorrentDocument(token, peer, command, digest, bytes, request, username);
    if (openedChat === chat) {
      await delivery;
      assert.deepEqual(calls, ['sendDocument', 'sendMessage', 'sendDocument']);
    } else {
      await assert.rejects(delivery, deliveryCode('rejected'));
      assert.deepEqual(calls, ['sendDocument', 'sendMessage']);
    }
  }
});

test('инициализация через username требует точного ответа 400 о неизвестном чате', async () => {
  for (const [status, errorCode, description, username, expected] of [
    [400, 400, 'Bad Request: other', '@cinema_bot', 'rejected'],
    [400, 403, 'Bad Request: chat not found', '@cinema_bot', 'uncertain'],
    [500, 500, 'Bad Request: chat not found', '@cinema_bot', 'uncertain'],
    [400, 400, 'Bad Request: chat not found', undefined, 'rejected'],
  ] as const) {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return Response.json({ ok: false, error_code: errorCode, description }, { status });
    };
    await assert.rejects(sendTorrentDocument(token, peer, command, digest, bytes, request, username), deliveryCode(expected));
    assert.equal(calls, 1);
  }
});

test('ошибка или неполный ответ Telegram не подтверждают доставку', async () => {
  const failed = (status: number) => Response.json({ ok: false, error_code: status, description: token }, { status });
  for (const [code, response] of [
    ['rejected', failed(403)], ['transient', failed(429)], ['uncertain', failed(500)],
    ['uncertain', failed(408)], ['uncertain', new Response('invalid response')],
    ['uncertain', Response.json({ ok: true, result: { ...sent, chat: { ...chat, id: 42 } } })],
    ['uncertain', Response.json({ ok: true, result: { ...sent, chat: { ...chat, type: 'group' } } })],
    ['uncertain', Response.json({ ok: true, result: { ...sent, caption: '', document: {} } })],
  ] as const) {
    await assert.rejects(sendTorrentDocument(token, peer, command, digest, bytes, async () => response), deliveryCode(code));
  }
  await assert.rejects(sendTorrentDocument(token, peer, command, digest, bytes, async () => {
    throw new TypeError(`network failure /bot${token}`);
  }), deliveryCode('uncertain'));
});

test('недопустимые адресаты, идентификаторы и несовпадающий digest отклоняются до обращения в сеть', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response(); };
  for (const [recipient, id, hash] of [
    ['@bot', command, digest], ['-123', command, digest], ['9007199254740992', command, digest],
    [peer, command.toUpperCase(), digest], [peer, command, '0'.repeat(64)], [peer, command, digest.toUpperCase()],
  ] as const) {
    await assert.rejects(sendTorrentDocument(token, recipient, id, hash, bytes, request), deliveryCode('rejected'));
  }
  assert.equal(calls, 0);
});

test('принимаются три статуса только в собственном сообщении бота из его личного чата', () => {
  for (const status of ['stored', 'rejected', 'uncertain']) {
    const text = `filmobot.torrent/1 ${command} ${digest} ${status}`;
    assert.deepEqual(parseTorrentReceipt({ message: { from, chat, text } }, peer), { command, digest, status });
  }
  for (const fields of [
    { from: { ...from, id: 41 } }, { from: { ...from, is_bot: false } }, { from: undefined },
    { chat: { ...chat, id: 42 } }, { chat: { ...chat, type: 'group' } },
    { forward_origin: { type: 'user' } }, { forward_date: 1 }, { is_automatic_forward: true },
    { via_bot: from }, { sender_chat: chat }, { business_connection_id: 'business' },
  ]) assert.equal(parseTorrentReceipt({ message: { ...receipt, ...fields } }, peer), null);

  for (const update of [null, [], {}, { edited_message: receipt }, { channel_post: receipt },
    { business_message: receipt }, { callback_query: { message: receipt } }]) {
    assert.equal(parseTorrentReceipt(update, peer), null);
  }
  assert.equal(parseTorrentReceipt({ message: receipt }, '@filmobot'), null);
});

test('парсер требует точный протокол квитанции, UUID, digest и статус', () => {
  for (const text of [
    caption, stored.toUpperCase(), stored + '\n', ' ' + stored, stored + ' ',
    stored.replace('/1', '/2'), stored.replace(command, command.toUpperCase()),
    stored.replace(command, 'not-a-uuid'), stored.replace(digest, digest.slice(1)),
    stored.replace('stored', 'delivered'), stored.replace(' stored', '  stored'),
  ]) assert.equal(parseTorrentReceipt({ message: { ...receipt, text } }, peer), null);
});
