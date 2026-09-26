const conversation = document.getElementById('conversation');
const chatScroll = document.getElementById('chatScroll');
const welcome = document.getElementById('welcome');
const form = document.getElementById('chatForm');
const input = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const newChatButton = document.getElementById('newChatButton');
const productModel = document.getElementById('productModel');
const errorBanner = document.getElementById('errorBanner');
const availabilityText = document.getElementById('availabilityText');
const headerStatus = document.getElementById('headerStatus');
const promptButtons = [...document.querySelectorAll('.quick-prompt')];

let ready = false;
let busy = false;
let history = [];
let conversationId = null;

function updateControls() {
  input.disabled = !ready || busy;
  sendButton.disabled = !ready || busy || !input.value.trim();
  newChatButton.disabled = busy;
  promptButtons.forEach((button) => { button.disabled = !ready || busy; });
}

function setAvailability(isReady, label) {
  const wasReady = ready;
  ready = isReady;
  availabilityText.textContent = label;
  headerStatus.classList.toggle('offline', !isReady);
  input.placeholder = isReady ? '说说您遇到的问题…' : '客服服务暂不可用';
  updateControls();
  if (isReady && !wasReady) input.focus();
}

async function checkAvailability() {
  try {
    const response = await fetch('/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    const health = await response.json();
    if (!response.ok || !health.configured) {
      setAvailability(false, health.expiresAt ? '服务暂不可用' : '服务待配置');
      return;
    }
    setAvailability(true, '在线服务中');
  } catch {
    setAvailability(false, '服务暂不可用');
  }
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = '';
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function appendMessage(role, content) {
  const item = document.createElement('div');
  item.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? '您' : '信';

  const body = document.createElement('div');
  body.className = 'message-body';
  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? '您' : '小信';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = content;

  body.append(label, bubble);
  item.append(avatar, body);
  conversation.append(item);
  scrollToBottom();
  return item;
}

function appendTyping() {
  const item = appendMessage('assistant', '');
  item.classList.add('typing');
  item.setAttribute('aria-label', '小信正在回复');
  const bubble = item.querySelector('.message-bubble');
  bubble.textContent = '';
  const dots = document.createElement('div');
  dots.className = 'typing-dots';
  for (let i = 0; i < 3; i += 1) dots.append(document.createElement('span'));
  bubble.append(dots);
  return item;
}

async function sendMessage() {
  const message = input.value.trim();
  if (!ready || busy || !message) return;

  clearError();
  busy = true;
  updateControls();
  welcome.hidden = true;
  const userItem = appendMessage('user', message);
  const typingItem = appendTyping();
  input.value = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history,
        productModel: productModel.value.trim(),
        conversationId,
      }),
    });
    const data = await response.json();
    if (!response.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error(data.error || '客服暂时无法回答，请稍后重试。');
    }
    typingItem.remove();
    appendMessage('assistant', data.reply);
    history = [...history, { role: 'user', content: message }, { role: 'assistant', content: data.reply }].slice(-16);
    if (typeof data.conversationId === 'string' && /^\d+$/.test(data.conversationId)) {
      conversationId = data.conversationId;
    }
  } catch (error) {
    typingItem.remove();
    userItem.remove();
    welcome.hidden = conversation.querySelectorAll('.message').length > 0;
    input.value = message;
    showError(error.message || '客服暂时无法回答，请稍后重试。');
  } finally {
    busy = false;
    updateControls();
    input.focus();
    scrollToBottom();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
  updateControls();
  clearError();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
});

promptButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (!ready || busy) return;
    input.value = button.dataset.prompt;
    updateControls();
    sendMessage();
  });
});

newChatButton.addEventListener('click', () => {
  if (busy) return;
  history = [];
  conversationId = null;
  conversation.querySelectorAll('.message').forEach((item) => item.remove());
  welcome.hidden = false;
  input.value = '';
  input.style.height = 'auto';
  clearError();
  updateControls();
  input.focus();
});

checkAvailability();
setInterval(checkAvailability, 30_000);
window.addEventListener('online', checkAvailability);
