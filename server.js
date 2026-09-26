const express = require('express');
const path = require('path');

const WORKFLOW_ID = '7528646254000488498';
const DEFAULT_BOT_ID = '7527602171085504564';
const DEFAULT_API_URL = 'https://api.coze.cn/v1/workflows/chat';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PRODUCT_LENGTH = 120;
const MAX_HISTORY_ITEMS = 16;
const MAX_ACTIVE_CHAT_REQUESTS = 8;
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const COZE_TIMEOUT_MS = 85_000;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function buildHistory(history, message) {
  const previous = history
    .slice(-MAX_HISTORY_ITEMS)
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .map((item) => ({
      role: item.role,
      content: cleanText(item.content, MAX_MESSAGE_LENGTH),
    }))
    .filter((item) => item.content);

  previous.push({ role: 'user', content: message });
  return previous.map((item) => `${item.role === 'user' ? '用户' : '客服'}：${item.content}`).join('\n');
}

function unwrapWorkflowAnswer(content) {
  try {
    const value = JSON.parse(content);
    if (value && typeof value === 'object' && typeof value.output === 'string') {
      return value.output.trim();
    }
  } catch {
    // A normal text answer does not need parsing.
  }
  return content;
}

function getTokenStatus(env, now = Date.now()) {
  const date = env.COZE_TOKEN_EXPIRES_AT || '';
  const expiresAtMs = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T23:59:59+08:00`)
    : NaN;
  const expiresAt = Number.isFinite(expiresAtMs) ? date : null;
  const expired = Number.isFinite(expiresAtMs) && now > expiresAtMs;
  return {
    configured: Boolean(env.COZE_ACCESS_TOKEN) && !expired,
    expiresAt,
    expiresSoon: Boolean(env.COZE_ACCESS_TOKEN) && !expired && Number.isFinite(expiresAtMs)
      && expiresAtMs - now <= 7 * 24 * 60 * 60 * 1000,
  };
}

async function readLimitedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_UPSTREAM_BYTES) throw new Error('UPSTREAM_TOO_LARGE');
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('UPSTREAM_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function parseChatStream(raw) {
  const answers = [];
  const completedIds = new Set();
  let conversationId = '';
  let error = null;
  let done = false;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const payload = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!event) continue;
    if (event === 'done') {
      done = true;
      continue;
    }
    if (!payload) continue;

    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof data.conversation_id === 'string') conversationId = data.conversation_id;
    if (event === 'conversation.message.completed' && data.type === 'answer' && typeof data.content === 'string') {
      if (!data.id || !completedIds.has(data.id)) answers.push(data.content);
      if (data.id) completedIds.add(data.id);
    }
    if (event === 'error' || event === 'conversation.chat.failed') {
      error = { code: data.code ?? data.last_error?.code, message: data.msg ?? data.last_error?.msg };
    }
    if (event === 'conversation.chat.requires_action') {
      error = { message: '对话需要额外操作，当前页面暂不支持。' };
    }
    if (event === 'conversation.chat.completed' && data.last_error?.code) {
      error = { code: data.last_error.code, message: data.last_error.msg };
    }
  }
  return { reply: answers.map(unwrapWorkflowAnswer).join('\n\n').trim(), conversationId, error, done };
}

function createApp({ fetchImpl = fetch, env = process.env } = {}) {
  const app = express();
  let activeChatRequests = 0;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/styles.css', (_req, res) => {
    res.type('css').sendFile(path.join(__dirname, 'styles.css'));
  });

  app.get('/app.js', (_req, res) => {
    res.type('js').sendFile(path.join(__dirname, 'app.js'));
  });

  app.get('/health', (_req, res) => {
    const token = getTokenStatus(env);
    res.set('Cache-Control', 'no-store');
    res.status(token.configured ? 200 : 503).json({
      status: token.configured ? 'ok' : 'unavailable',
      ...token,
    });
  });

  app.post('/api/chat', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const message = cleanText(req.body?.message, MAX_MESSAGE_LENGTH);
    const history = req.body?.history;
    const productModel = cleanText(req.body?.productModel, MAX_PRODUCT_LENGTH);
    const conversationId = cleanText(req.body?.conversationId, 80);

    if (!message || typeof req.body?.message !== 'string' || req.body.message.trim().length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: '请输入 1–2000 字的问题。' });
    }
    if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) {
      return res.status(400).json({ error: '会话记录格式无效，请新建会话后重试。' });
    }
    if (typeof req.body?.productModel === 'string' && req.body.productModel.trim().length > MAX_PRODUCT_LENGTH) {
      return res.status(400).json({ error: '产品型号不能超过 120 字。' });
    }
    if (conversationId && !/^\d{1,80}$/.test(conversationId)) {
      return res.status(400).json({ error: '会话编号格式无效，请新建会话后重试。' });
    }

    if (!getTokenStatus(env).configured) {
      return res.status(503).json({ error: '客服服务尚未完成配置或凭证已过期。' });
    }
    if (activeChatRequests >= MAX_ACTIVE_CHAT_REQUESTS) {
      return res.status(503).set('Retry-After', '5').json({ error: '客服当前繁忙，请稍后重试。' });
    }

    const parameters = {
      product_info: productModel ? `海信冰箱；型号：${productModel}` : '海信冰箱；具体型号暂未提供',
      robot_history: buildHistory(history, message),
    };
    const payload = {
      workflow_id: WORKFLOW_ID,
      bot_id: env.COZE_BOT_ID || DEFAULT_BOT_ID,
      additional_messages: [{ role: 'user', content_type: 'text', content: message }],
      parameters,
    };
    if (conversationId) payload.conversation_id = conversationId;

    activeChatRequests += 1;
    const clientAbort = new AbortController();
    const timeoutSignal = AbortSignal.timeout(COZE_TIMEOUT_MS);
    const onClientClose = () => {
      if (!res.writableEnded) clientAbort.abort();
    };
    res.on('close', onClientClose);
    try {
      let upstream;
      try {
        upstream = await fetchImpl(env.COZE_API_URL || DEFAULT_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.COZE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([timeoutSignal, clientAbort.signal]),
        });
      } catch (error) {
        if (res.destroyed || clientAbort.signal.aborted) return;
        const timeout = timeoutSignal.aborted || error.name === 'TimeoutError';
        console.error('Coze request failed:', error.name);
        return res.status(timeout ? 504 : 502).json({
          error: timeout ? '客服响应超时，请稍后重试。' : '暂时无法连接客服服务，请稍后重试。',
        });
      }

      let raw;
      try {
        raw = await readLimitedText(upstream);
      } catch (error) {
        if (res.destroyed || clientAbort.signal.aborted) return;
        const timeout = timeoutSignal.aborted || error.name === 'TimeoutError';
        console.error('Coze response read failed:', error.message, upstream.status);
        return res.status(timeout ? 504 : 502).json({
          error: timeout ? '客服响应超时，请稍后重试。' : '客服服务响应中断，请稍后重试。',
        });
      }

      if (!upstream.ok) {
        let result;
        try { result = JSON.parse(raw); } catch { result = {}; }
        console.error('Coze API error:', {
          status: upstream.status,
          code: result?.code,
          message: result?.msg,
          logid: result?.detail?.logid,
        });
        return res.status(502).json({
          error: '客服服务暂时无法回答，请稍后重试。',
          code: result?.code,
          requestId: result?.detail?.logid,
        });
      }

      const result = parseChatStream(raw);
      if (result.error || !result.done || !result.reply) {
        console.error('Coze conversation failed:', result.error || 'Missing completion or answer');
        return res.status(502).json({
          error: '客服服务未返回回答，请稍后重试。',
          code: result.error?.code,
        });
      }
      return res.json({ reply: result.reply, conversationId: result.conversationId || conversationId });
    } finally {
      activeChatRequests -= 1;
      res.off('close', onClientClose);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ error: '请求格式无效。' });
    }
    if (error.status === 413) {
      return res.status(413).json({ error: '请求内容过长。' });
    }
    console.error('Portal error:', error);
    return res.status(500).json({ error: '服务暂时不可用。' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3005;
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp().listen(port, host, () => {
    console.log(`海信智能客服 portal 已启动：http://${host}:${port}`);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('error', (error) => {
    console.error('Portal startup failed:', error.message);
    process.exitCode = 1;
  });
  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp, buildHistory, parseChatStream, getTokenStatus, WORKFLOW_ID, DEFAULT_BOT_ID };
