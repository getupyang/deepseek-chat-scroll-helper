// DeepSeek Chat Scroll Helper - Content Script
// 严格按照 PRD.md 和 Project_rules.md 实现

// Debug 模式：URL 含 ?debug=1 时启用
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === '1';

// 重试配置
const MAX_RETRIES = 5;
const RETRY_DELAYS = [200, 400, 800, 1600, 1600]; // ms

// 消息结构缓存
let messagesCache = null;
let scrollContainer = null;
let containerInitialized = false;

/**
 * 检查当前焦点是否在输入元素上
 */
function isInputFocused() {
  const activeElement = document.activeElement;
  if (!activeElement) return false;
  
  const tagName = activeElement.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') {
    return true;
  }
  
  const contentEditable = activeElement.getAttribute('contenteditable');
  if (contentEditable === 'true' || contentEditable === '') {
    return true;
  }
  
  return false;
}

/**
 * 查找滚动容器
 * 优先查找聊天内部的滚动容器，否则回退到 window
 */
function findScrollContainer() {
  if (scrollContainer) return scrollContainer;
  
  // 查找包含 ds-message 的滚动容器
  const messages = document.querySelectorAll('div.ds-message');
  if (messages.length === 0) return window;
  
  let element = messages[0];
  while (element && element !== document.body && element !== document.documentElement) {
    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    
    if (overflowY === 'scroll' || overflowY === 'auto') {
      const scrollHeight = element.scrollHeight;
      const clientHeight = element.clientHeight;
      
      if (scrollHeight > clientHeight) {
        scrollContainer = element;
        return element;
      }
    }
    
    element = element.parentElement;
  }
  
  return window;
}

/**
 * 计算滚动偏移量
 * offset = clamp(24px, viewportHeight * 0.18, 96px)
 */
function calculateOffset() {
  const viewportHeight = window.innerHeight;
  const offsetPercentage = viewportHeight * 0.18;
  
  return Math.max(24, Math.min(96, offsetPercentage));
}

/**
 * 平滑滚动到目标元素
 */
function scrollToElement(element, container) {
  if (!element) return;
  
  const rect = element.getBoundingClientRect();
  const containerRect = container === window 
    ? { top: 0, left: 0 }
    : container.getBoundingClientRect();
  
  const offset = calculateOffset();
  let targetTop;
  
  if (container === window) {
    targetTop = window.scrollY + rect.top - offset;
    window.scrollTo({
      top: targetTop,
      behavior: 'smooth'
    });
  } else {
    targetTop = container.scrollTop + (rect.top - containerRect.top) - offset;
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: 'smooth'
    });
  }
}

/**
 * 识别消息结构：Uₙ, Tₙ, Aₙ
 */
function parseMessage(messageElement) {
  const result = {
    element: messageElement,
    userMessage: null,    // Uₙ
    thinkContent: null,  // Tₙ
    answerContent: null  // Aₙ
  };
  
  // 查找深度思考 Tₙ
  const thinkContent = messageElement.querySelector('div.ds-think-content');
  if (thinkContent) {
    result.thinkContent = thinkContent;
  } else {
    // 兜底：查找包含"已深度思考"文本的元素
    const walker = document.createTreeWalker(
      messageElement,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes('已深度思考')) {
        result.thinkContent = node.parentElement.closest('div');
        break;
      }
    }
  }
  
  // 查找正文 Aₙ（优先取第一个不在 Tₙ 里的 div.ds-markdown）
  const allMarkdowns = messageElement.querySelectorAll('div.ds-markdown');
  for (const markdown of allMarkdowns) {
    // 确保不在 Tₙ 内部
    if (!result.thinkContent || !result.thinkContent.contains(markdown)) {
      result.answerContent = markdown;
      break;
    }
  }
  
  // 判断用户消息：如果没有 Aₙ 和 Tₙ，或者消息块本身就是用户消息
  // 有 Aₙ 或 Tₙ 的是 AI 消息，否则是用户消息
  // 用户消息通常就是 messageElement 本身，或者其中的文本节点容器
  if (!result.answerContent && !result.thinkContent) {
    result.userMessage = messageElement;
  } else {
    // 对于 AI 消息，用户消息通常是这条消息之前的上一条消息
    // 但我们这里只解析当前消息，用户消息需要从上下文获取
    // 用户消息实际上是上一条消息，这里先标记为 null，后续在消息列表中处理
    result.userMessage = null;
  }
  
  return result;
}

/**
 * 获取所有消息并解析结构
 */
function getAllMessages() {
  const messageElements = document.querySelectorAll('div.ds-message');
  const messages = [];
  
  let lastUserMessage = null;
  
  for (const msgElement of messageElements) {
    const parsed = parseMessage(msgElement);
    
    // 如果当前消息没有 Aₙ 和 Tₙ，说明是用户消息
    if (!parsed.answerContent && !parsed.thinkContent) {
      parsed.userMessage = msgElement;
      lastUserMessage = parsed;
      messages.push(parsed);
    } else {
      // AI 消息：关联上一个用户消息
      parsed.userMessage = lastUserMessage ? lastUserMessage.element : null;
      messages.push(parsed);
      
      // 如果这条 AI 消息后面还有新的用户消息，lastUserMessage 会被更新
      // 这里我们需要检查下一条消息是否是用户消息
    }
  }
  
  // 重新关联用户消息：每个 AI 消息应该关联到它前面的用户消息
  let prevUserMsg = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.answerContent && !msg.thinkContent) {
      // 用户消息
      prevUserMsg = msg.element;
    } else {
      // AI 消息，关联上一个用户消息
      msg.userMessage = prevUserMsg;
    }
  }
  
  return messages;
}

/**
 * 判断元素是否在视口中可见（顶部部分）
 */
function isElementAtTop(element, container) {
  if (!element) return false;
  
  const rect = element.getBoundingClientRect();
  const containerRect = container === window 
    ? { top: 0, height: window.innerHeight }
    : container.getBoundingClientRect();
  
  const offset = calculateOffset();
  const threshold = offset + 10; // 允许 10px 误差
  
  // 元素顶部在容器顶部 + offset 的范围内
  return rect.top >= containerRect.top && rect.top <= containerRect.top + threshold;
}

/**
 * 判断当前视口位置在哪个消息的哪个部分
 */
function getCurrentPosition(messages, container) {
  if (messages.length === 0) return null;
  
  // 获取视口顶部位置（相对于容器）
  const viewportTop = container === window 
    ? window.scrollY 
    : container.scrollTop;
  
  // 从后往前找，找到最接近视口的消息部分
  let closestPosition = null;
  let closestDistance = Infinity;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    
    // 检查 Aₙ（正文）- 优先检查
    if (msg.answerContent) {
      const answerRect = msg.answerContent.getBoundingClientRect();
      const answerTop = container === window
        ? answerRect.top + window.scrollY
        : answerRect.top - container.getBoundingClientRect().top + container.scrollTop;
      const answerBottom = answerTop + answerRect.height;
      
      // 如果 Aₙ 在视口中或视口上方
      if (answerBottom >= viewportTop && answerTop <= viewportTop + (container === window ? window.innerHeight : container.clientHeight)) {
        const distance = Math.abs(answerTop - viewportTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          if (isElementAtTop(msg.answerContent, container)) {
            closestPosition = { type: 'answer-top', message: msg, index: i };
          } else {
            closestPosition = { type: 'answer-middle', message: msg, index: i };
          }
        }
      }
    }
    
    // 检查 Tₙ（深度思考）
    if (msg.thinkContent) {
      const thinkRect = msg.thinkContent.getBoundingClientRect();
      const thinkTop = container === window
        ? thinkRect.top + window.scrollY
        : thinkRect.top - container.getBoundingClientRect().top + container.scrollTop;
      const thinkBottom = thinkTop + thinkRect.height;
      
      if (thinkBottom >= viewportTop && thinkTop <= viewportTop + (container === window ? window.innerHeight : container.clientHeight)) {
        const distance = Math.abs(thinkTop - viewportTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPosition = { type: 'think', message: msg, index: i };
        }
      }
    }
    
    // 检查 Uₙ（用户消息）
    if (msg.userMessage || (!msg.answerContent && !msg.thinkContent)) {
      const userElement = msg.userMessage || msg.element;
      const userRect = userElement.getBoundingClientRect();
      const userTop = container === window
        ? userRect.top + window.scrollY
        : userRect.top - container.getBoundingClientRect().top + container.scrollTop;
      const userBottom = userTop + userRect.height;
      
      if (userBottom >= viewportTop && userTop <= viewportTop + (container === window ? window.innerHeight : container.clientHeight)) {
        const distance = Math.abs(userTop - viewportTop);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestPosition = { type: 'user', message: msg, index: i };
        }
      }
    }
  }
  
  if (closestPosition) {
    return closestPosition;
  }
  
  // 初始态：没有定位到任何一条
  return { type: 'initial', message: null, index: -1 };
}

/**
 * Debug 模式：给识别到的元素加 outline
 */
function applyDebugStyles(messages) {
  if (!DEBUG_MODE) return;
  
  // 清除之前的样式
  const styleId = 'deepseek-scroll-helper-debug';
  let existingStyle = document.getElementById(styleId);
  if (existingStyle) {
    existingStyle.remove();
  }
  
  const style = document.createElement('style');
  style.id = styleId;
  let css = '';
  
  for (const msg of messages) {
    if (msg.userMessage) {
      css += `[data-debug-user-${msg.element.getAttribute('data-debug-id') || ''}] { outline: 2px solid blue !important; }`;
    }
    if (msg.thinkContent) {
      css += `[data-debug-think-${msg.thinkContent.getAttribute('data-debug-id') || ''}] { outline: 2px solid orange !important; }`;
    }
    if (msg.answerContent) {
      css += `[data-debug-answer-${msg.answerContent.getAttribute('data-debug-id') || ''}] { outline: 2px solid green !important; }`;
    }
  }
  
  style.textContent = css;
  document.head.appendChild(style);
  
  // 给元素添加 data 属性
  for (const msg of messages) {
    const id = Math.random().toString(36).substr(2, 9);
    if (msg.userMessage) {
      msg.userMessage.setAttribute('data-debug-user-' + id, '');
    }
    if (msg.thinkContent) {
      msg.thinkContent.setAttribute('data-debug-think-' + id, '');
    }
    if (msg.answerContent) {
      msg.answerContent.setAttribute('data-debug-answer-' + id, '');
    }
  }
}

/**
 * 限次重试查找消息和容器
 */
async function findMessagesWithRetry(retryCount = 0) {
  const messages = getAllMessages();
  const container = findScrollContainer();
  
  if (messages.length > 0 && container) {
    messagesCache = messages;
    scrollContainer = container;
    containerInitialized = true;
    
    if (DEBUG_MODE) {
      applyDebugStyles(messages);
    }
    
    return { messages, container };
  }
  
  if (retryCount >= MAX_RETRIES) {
    console.log('[DeepSeek Scroll Helper] 对话还没加载好，请稍后再试');
    return { messages: [], container: window };
  }
  
  await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[retryCount]));
  return findMessagesWithRetry(retryCount + 1);
}

/**
 * 查找上一轮用户消息
 */
function findPreviousUserMessage(messages, currentIndex) {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.userMessage || (!msg.answerContent && !msg.thinkContent)) {
      return msg.userMessage || msg.element;
    }
  }
  return null;
}

/**
 * 查找上一条可定位消息
 */
function findPreviousLocatableMessage(messages, currentIndex) {
  for (let i = currentIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.answerContent) {
      return msg.answerContent;
    }
    if (msg.userMessage || (!msg.answerContent && !msg.thinkContent)) {
      return msg.userMessage || msg.element;
    }
  }
  return null;
}

/**
 * 处理 Shift + ↑ 的滚动逻辑
 */
async function handleShiftUp() {
  // 1. 检查焦点
  if (isInputFocused()) {
    return;
  }
  
  // 2. 获取消息和容器（带重试）
  let messages, container;
  if (containerInitialized && messagesCache) {
    messages = messagesCache;
    container = scrollContainer || findScrollContainer();
  } else {
    const result = await findMessagesWithRetry();
    messages = result.messages;
    container = result.container;
  }
  
  // 如果还是没找到消息，退出
  if (messages.length === 0) {
    console.log('[DeepSeek Scroll Helper] 暂无可定位对话/请稍后重试');
    return;
  }
  
  // 3. 判断当前位置
  const position = getCurrentPosition(messages, container);
  
  if (!position) {
    return;
  }
  
  // 4. 按上行顺序滚动（严格按照 PRD 第 7 章规则）
  
  if (position.type === 'answer-middle') {
    // 规则 1：当前在 Aₙ 的中/尾部 → 滚动到 Aₙ 顶部
    scrollToElement(position.message.answerContent, container);
    return;
  }
  
  if (position.type === 'answer-top') {
    // 规则 2：当前已经在 Aₙ 顶部 → 滚动到本轮用户 Uₙ
    if (position.message.userMessage) {
      scrollToElement(position.message.userMessage, container);
    } else {
      // 如果本轮 Aₙ 暂不可见时的处理：尝试滚动到本轮 Uₙ
      // 这里实际上 Aₙ 存在，但 userMessage 可能不存在，继续向下处理
      const prevUser = findPreviousUserMessage(messages, position.index);
      if (prevUser) {
        scrollToElement(prevUser, container);
      }
    }
    return;
  }
  
  if (position.type === 'think') {
    // 规则 3：当前在 Tₙ → 滚动到本轮用户 Uₙ（不能往下滚到 Aₙ）
    if (position.message.userMessage) {
      scrollToElement(position.message.userMessage, container);
    } else {
      // 若 Uₙ 不存在，退化为"滚动到上一条可定位消息"
      const prevLocatable = findPreviousLocatableMessage(messages, position.index);
      if (prevLocatable) {
        scrollToElement(prevLocatable, container);
      }
    }
    return;
  }
  
  if (position.type === 'user') {
    // 规则 4：当前在 Uₙ
    const userElement = position.message.userMessage || position.message.element;
    const userIndex = messages.findIndex(m => 
      (m.userMessage || (!m.answerContent && !m.thinkContent)) && 
      (m.userMessage === userElement || m.element === userElement)
    );
    
    // 使用归一化后的用户索引作为查找起点
    const currentUserIndex = userIndex >= 0 ? userIndex : position.index;
    
    if (currentUserIndex > 0) {
      // n > 1：滚动到上一轮用户发言 Uₙ₋₁
      const prevUser = findPreviousUserMessage(messages, currentUserIndex);
      if (prevUser) {
        scrollToElement(prevUser, container);
      } else {
        // 找不到上一轮用户，尝试找上一条可定位消息
        const prevLocatable = findPreviousLocatableMessage(messages, currentUserIndex);
        if (prevLocatable) {
          scrollToElement(prevLocatable, container);
        }
      }
    } else {
      // n = 1：不动
      console.log('already at first turn');
    }
    return;
  }
  
  if (position.type === 'initial') {
    // 规则 5：当前还没定位到任何一条（初始态）
    // 优先：滚动到最新一轮的 U
    let latestUser = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.userMessage || (!msg.answerContent && !msg.thinkContent)) {
        latestUser = msg.userMessage || msg.element;
        break;
      }
    }
    
    if (latestUser) {
      scrollToElement(latestUser, container);
      return;
    }
    
    // 若不存在任何 U 但存在 A → 滚动到最新一条 A
    let latestAnswer = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].answerContent) {
        latestAnswer = messages[i].answerContent;
        break;
      }
    }
    
    if (latestAnswer) {
      scrollToElement(latestAnswer, container);
      return;
    }
    
    // 若 U/A 都不存在 → 不滚动
    console.log('[DeepSeek Scroll Helper] 暂无可定位对话/请稍后重试');
    return;
  }
  
  // 规则 6：Aₙ 暂不存在的兜底（在规则 1 和 2 中已处理）
  // 如果规则 1 或 2 要滚到 Aₙ，但本轮 Aₙ 暂不可见
  // 这种情况在 answer-middle 和 answer-top 的判断中已经处理了
  // 但如果 position.type 不是 answer-*，但 message.answerContent 不存在，则需要特殊处理
  
  // 实际上，如果 Aₙ 不存在，getCurrentPosition 不会返回 answer-middle 或 answer-top
  // 所以这里不需要额外处理
}

/**
 * 监听 DOM 变化，更新消息缓存
 */
function setupMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    let shouldUpdate = false;
    
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList && node.classList.contains('ds-message')) {
              shouldUpdate = true;
              break;
            }
            if (node.querySelector && node.querySelector('div.ds-message')) {
              shouldUpdate = true;
              break;
            }
          }
        }
      }
    }
    
    if (shouldUpdate) {
      // 延迟更新，避免频繁计算
      setTimeout(() => {
        messagesCache = getAllMessages();
        if (DEBUG_MODE) {
          applyDebugStyles(messagesCache);
        }
      }, 100);
    }
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

/**
 * 初始化
 */
function init() {
  // 监听键盘事件
  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'ArrowUp') {
      e.preventDefault();
      handleShiftUp();
    }
  });
  
  // 设置 MutationObserver
  setupMutationObserver();
  
  // 预加载消息（延迟执行，避免阻塞页面加载）
  setTimeout(() => {
    findMessagesWithRetry();
  }, 500);
}

// 页面加载完成后初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

