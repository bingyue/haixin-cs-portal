const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, getTokenStatus, WORKFLOW_ID, DEFAULT_BOT_ID } = require('../server');

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('chat maps portal input to the published dialogue flow and reads SSE answer', async () => {
  let upstreamRequest;
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async (url, options) => {
      upstreamRequest = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => [
          'event: conversation.chat.created',
          'data: {"conversation_id":"123456","status":"created"}',
          '',
          'event: conversation.message.completed',
          'data: {"id":"message-1","conversation_id":"123456","role":"assistant","type":"answer","content":"您好，订单正在配送中。"}',
          '',
          'event: done',
          'data: {}',
          '',
        ].join('\n'),
      };
    },
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '物流到哪里了？',
        history: [{ role: 'user', content: '您好' }, { role: 'assistant', content: '您好，请问有什么可以帮您？' }],
        productModel: 'BCD-500',
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: '您好，订单正在配送中。', conversationId: '123456' });
  });

  assert.equal(upstreamRequest.url, 'https://api.coze.cn/v1/workflows/chat');
  assert.equal(upstreamRequest.options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(upstreamRequest.options.body);
  assert.equal(body.workflow_id, WORKFLOW_ID);
  assert.equal(body.bot_id, DEFAULT_BOT_ID);
  assert.deepEqual(body.additional_messages, [{ role: 'user', content_type: 'text', content: '物流到哪里了？' }]);
  assert.deepEqual(body.parameters, {
    product_info: '海信冰箱；型号：BCD-500',
    robot_history: '用户：您好\n客服：您好，请问有什么可以帮您？\n用户：物流到哪里了？',
  });
});

test('follow-up request carries the Coze conversation ID', async () => {
  let payload;
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => 'event: conversation.message.completed\ndata: {"type":"answer","content":"继续回复"}\n\nevent: done\ndata: {}\n\n' };
    },
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '继续问', history: [], conversationId: '123456' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).conversationId, '123456');
  });
  assert.equal(payload.conversation_id, '123456');
});

test('chat unwraps the published workflow output from its JSON answer', async () => {
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => [
        'event: conversation.message.completed',
        'data: {"type":"answer","content":"{\\"output\\":\\"您好，保修期为一年。\\"}"}',
        '',
        'event: done',
        'data: {}',
        '',
      ].join('\n'),
    }),
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '保修期多久？', history: [] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, '您好，保修期为一年。');
  });
});

test('chat reports missing configuration instead of returning a simulated reply', async () => {
  const app = createApp({
    env: {},
    fetchImpl: async () => { throw new Error('should not call Coze'); },
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好', history: [] }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /尚未完成配置/);
  });
});

test('chat surfaces a Coze error without inventing an answer', async () => {
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: 4200, msg: 'workflow unpublished', detail: { logid: 'log-123' } }),
    }),
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好', history: [] }),
    });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.code, 4200);
    assert.equal(result.requestId, 'log-123');
    assert.equal(result.reply, undefined);
  });
});

test('an oversized Coze stream is rejected without exhausting server memory', async () => {
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1)),
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好', history: [] }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).reply, undefined);
  });
});

test('excess simultaneous chats get a retryable busy response', async () => {
  let releaseUpstream;
  const upstreamBlocked = new Promise((resolve) => { releaseUpstream = resolve; });
  let signalAllStarted;
  const allStarted = new Promise((resolve) => { signalAllStarted = resolve; });
  let started = 0;
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async () => {
      started += 1;
      if (started === 8) signalAllStarted();
      await upstreamBlocked;
      return new Response('event: conversation.message.completed\ndata: {"type":"answer","content":"您好"}\n\nevent: done\ndata: {}\n\n');
    },
  });
  await withServer(app, async (base) => {
    const post = () => fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好', history: [] }),
    });
    const active = Array.from({ length: 8 }, post);
    await allStarted;
    const busy = await post();
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('Retry-After'), '5');
    releaseUpstream();
    const replies = await Promise.all(active);
    assert.ok(replies.every((response) => response.status === 200));
  });
});

test('repeated requests from one client are rate limited before reaching Coze', async () => {
  let upstreamCalls = 0;
  const app = createApp({
    env: { COZE_ACCESS_TOKEN: 'test-token' },
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response('event: conversation.message.completed\ndata: {"type":"answer","content":"您好"}\n\nevent: done\ndata: {}\n\n');
    },
  });
  await withServer(app, async (base) => {
    const post = () => fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '您好', history: [] }),
    });
    for (let i = 0; i < 20; i += 1) assert.equal((await post()).status, 200);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('Retry-After'), '60');
    assert.equal(upstreamCalls, 20);
  });
});

test('health reports a token nearing expiry and rejects an expired token', async () => {
  const env = { COZE_ACCESS_TOKEN: 'test-token', COZE_TOKEN_EXPIRES_AT: '2026-10-26' };
  assert.equal(getTokenStatus(env, Date.parse('2026-10-23T00:00:00+08:00')).expiresSoon, true);
  assert.equal(getTokenStatus(env, Date.parse('2026-10-27T00:00:00+08:00')).configured, false);
  await withServer(createApp({ env }), async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).expiresAt, '2026-10-26');
  });
});
