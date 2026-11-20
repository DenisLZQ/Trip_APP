// Vercel Serverless Function: /api/chat
// 对接 DeepSeek API，支持流式输出
// API Key 需在 Vercel 项目环境变量中配置 DEEPSEEK_API_KEY
//
// ─────────────────────────────────────────────────────────────
// 过渡版防护（四道阀 + 一个钩子）
//   第 1 道：只放行来自自己域名的请求（Origin / Referer 校验）
//   第 2 道：单来源每分钟请求数上限
//   第 3 道：单来源每天请求数上限
//   第 4 道：全站每天请求数上限（熔断，保命）
//   第 5 道（附加）：单条消息字符数上限
//   钩子：resolveIdentity(req) —— 现在返回 IP，将来账号模块上线后
//         改成返回用户 ID 即可，其余限流代码一行不动。
//
// 【重要说明 · 过渡实现的边界】
// Edge Runtime 是无状态的，同一个函数可能被同时跑在多个实例上，
// 因此下面用模块级内存计数，只能做到“单实例内”限流，属于尽力而为的
// 过渡方案：能挡住脚本狂刷、挡住慢速薅额度，但不能保证跨实例精确。
// 等账号模块 / 数据库就位后，把 store.get / store.set 换成
// KV（Vercel KV / Upstash Redis）即可获得精确的全局配额。
// 计数在实例被回收后重置，这是刻意的“软限流”设计。
// ─────────────────────────────────────────────────────────────

export const config = {
  runtime: 'edge',
  maxDuration: 300, // 5分钟超时，满足长回复需求
};

// ══════════════════════ 可调参数区 ══════════════════════
const POLICY = {
  // 允许的来源域名白名单（可自行增删）
  allowedHosts: [
    'lltrip.cn',
    'www.lltrip.cn',
    'tripapp-kappa.vercel.app',
  ],
  // 本地开发放行（vercel dev / localhost 调试时用）
  allowLocalhost: true,

  // 单来源每分钟上限（IP 维度防脚本狂刷，正常聊天碰不到）
  perMinuteLimit: 20,
  // 单来源每天上限（防慢速薅额度）
  perDayLimit: 200,
  // 全站每天上限（熔断保命，撞到就停，倒逼去排查）
  globalDayLimit: 1500,

  // 单条消息最大字符数（防止塞超长文本一次烧掉大量 token）
  maxMessageChars: 2000,
  // 发给模型的历史条数（原有逻辑：最近 20 条）
  maxHistoryMessages: 20,
};
// ══════════════════════════════════════════════════════

// ── 轻量内存计数器（过渡用；将来替换为 KV / Redis） ──
const store = {
  minute: new Map(), // key: `${id}|${minuteStamp}` -> count
  daily: new Map(),  // key: `${id}|${dayStamp}`    -> count
  global: new Map(), // key: `global|${dayStamp}`    -> count

  // 惰性清理：Map 里的过期键在读取时顺手删掉，避免无限增长
  prune(map, currentKey, prefixLen) {
    if (map.size < 500) return; // 量小就不扫，省 CPU
    for (const k of map.keys()) {
      if (k !== currentKey && map.get(k) !== undefined) {
        // 只保留当前键，其余历史键清理掉（过渡方案够用）
        if (!k.endsWith(currentKey.slice(-prefixLen))) map.delete(k);
      }
    }
  },
};

// ── 时间戳工具（统一用 UTC，避免时区漂移） ──
function stamps(now = Date.now()) {
  const d = new Date(now);
  const day = d.toISOString().slice(0, 10); // YYYY-MM-DD
  const minute = Math.floor(now / 60000);   // 分钟序号
  return { day, minute };
}

// ── 原子自增（JS 单线程，同步读写即原子） ──
function bump(map, key) {
  const n = (map.get(key) || 0) + 1;
  map.set(key, n);
  return n;
}

// ══════════════ 钩子：身份判定（将来在这里换成用户 ID） ══════════════
function resolveIdentity(req) {
  // 过渡期：按来源 IP 识别。Vercel 会带 x-forwarded-for，取第一段为真实客户端。
  const xff = req.headers.get('x-forwarded-for') || '';
  const ip = xff.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  return { type: 'ip', id: ip };
}
// ══════════════════════════════════════════════════════════════

// ── 来源域名校验（第 1 道阀） ──
function isAllowedOrigin(req) {
  const origin = req.headers.get('origin') || '';
  const referer = req.headers.get('referer') || '';
  const candidate = origin || referer;

  // 无来源信息（如 curl / 脚本直连）：按设计放行到后续限流环节去拦
  // —— 域名校验本就是“筛子不是保险柜”，真正的保命靠日预算熔断。
  if (!candidate) return true;

  let host = '';
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false; // 来源串格式非法，直接拒
  }

  if (POLICY.allowLocalhost && (host === 'localhost' || host === '127.0.0.1')) return true;

  return POLICY.allowedHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase())
  );
}

// ── 限流总检（第 2、3、4 道阀） ──
function checkRateLimit(identity) {
  const { day, minute } = stamps();

  // 第 4 道：全站日熔断（先查，撞线立刻拒，不消耗个人配额）
  const globalKey = `global|${day}`;
  const globalUsed = store.global.get(globalKey) || 0;
  if (globalUsed >= POLICY.globalDayLimit) {
    return { ok: false, scope: 'global', limit: POLICY.globalDayLimit };
  }

  // 第 2 道：单来源每分钟
  const minuteKey = `${identity.id}|m|${minute}`;
  const minuteUsed = store.minute.get(minuteKey) || 0;
  if (minuteUsed >= POLICY.perMinuteLimit) {
    return { ok: false, scope: 'minute', limit: POLICY.perMinuteLimit };
  }

  // 第 3 道：单来源每天
  const dayKey = `${identity.id}|d|${day}`;
  const dayUsed = store.daily.get(dayKey) || 0;
  if (dayUsed >= POLICY.perDayLimit) {
    return { ok: false, scope: 'day', limit: POLICY.perDayLimit };
  }

  // 全部通过 → 记账
  bump(store.minute, minuteKey);
  bump(store.daily, dayKey);
  bump(store.global, globalKey);

  // 顺手清理（过渡方案，量小不扫）
  store.prune(store.minute, minuteKey, 8);
  store.prune(store.daily, dayKey, 6);

  return { ok: true };
}

// ══════════ 系统提示词构建（行程数据来自前端传入的 tripContext） ══════════
// 数据源唯一：data/trips.json → 前端载入 → 聊天时经 tripContext 传到后端。
// 后端不再硬编码任何行程信息；改数据只需改 data/trips.json 一个文件。
function buildTripBrief(t){
  if(!t || typeof t !== 'object') return '';
  const lines = [];
  if(t.name) lines.push(`- 行程名称：${t.name}`);
  if(t.start && t.end) lines.push(`- 时间：${t.start} → ${t.end}`);
  if(t.fromCity || t.toCity){
    lines.push(`- 出发地：${t.fromCity||''}${t.fromSub||''}，目的地：${t.toCity||''}${t.toSub||''}`);
  }
  const fg = t.flightGo || {}, fr = t.flightRet || {};
  if(fg.no || fr.no){
    const seg = (f)=> `${f.no||''}${f.time?('（'+f.time+'）'):''}${f.info?('，'+f.info):''}`;
    lines.push(`- 往返航班：去程${seg(fg)}；返程${seg(fr)}`);
  }
  if(t.budget) lines.push(`- 总预算：${(t.budget/10000).toFixed(0)}万元`);
  if(Array.isArray(t.localPts) && t.localPts.length){
    lines.push(`- 住宿安排：${t.localPts.map(p=>`${p.label}${p.days?('（'+p.days+'）'):''}`).join(' → ')}`);
  }
  if(t.desc) lines.push(`- 一句话简介：${t.desc}`);
  return lines.join('\n');
}

function buildSystemPrompt(tripContext){
  const ctx = tripContext || {};
  const brief = buildTripBrief(ctx.currentTrip);
  const day = ctx.currentDay;
  const dayLine = (day && day.title) ? `\n【用户当前正在查看】${day.day||''} ${day.date||''} · ${day.title}` : '';
  const tripBlock = brief
    ? `【当前行程基本信息】\n${brief}${dayLine}`
    : `【当前行程基本信息】\n未收到行程数据。请提示用户刷新页面后重试，不要凭空编造行程安排。`;

  return `你是L.L的专属AI行程管家，专门负责私人度假行程的问答与调整。

${tripBlock}

【你的能力】
1. 回答关于行程的任何问题：第几天去哪、住什么酒店、吃什么餐厅、交通安排、预算构成等
2. 给出调整建议：根据用户需求推荐餐厅、景点、时间安排的优化
3. 风格友好、贴心、简洁，符合私人管家的定位
4. 所有回答严格基于上面提供的行程数据，不要编造不存在的安排
5. 如果用户提出修改需求，先给出修改预览方案，确认后再实际生效（当前阶段为只读问答，暂不直接修改数据）

【注意事项】
- 三亚冬季白天24-28℃，夜间19-22℃，紫外线强，提醒防晒
- 行程以慢节奏、松弛感为主，不赶景点，每天只安排1-2个主要活动
- 傍晚16:00后再出门活动，避开正午日晒
- 酒店选择优先安静、私密度假体验
- 当前为只读问答模式，修改行程的功能将在后续版本上线，你可以先给出修改建议供参考`;
}

function jsonError(message, status, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

// 给用户看的限流提示（中文、友好，前端原样展示）
function limitMessage(scope, limit) {
  if (scope === 'minute') return `问得有点快啦，请稍等一会儿再问（每分钟最多 ${limit} 次）～`;
  if (scope === 'day') return `今天和管家聊得够多啦，明天再来继续吧（每人每天最多 ${limit} 次）～`;
  if (scope === 'global') return '小管家今天有点忙不过来啦，请明天再来～';
  return '请求过于频繁，请稍后再试～';
}

export default async function handler(req) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // ── 第 1 道阀：来源域名 ──
    if (!isAllowedOrigin(req)) {
      return jsonError('Forbidden: 该接口仅允许本站页面调用', 403);
    }

    // ── 第 2/3/4 道阀：限流 ──
    const identity = resolveIdentity(req);
    const rl = checkRateLimit(identity);
    if (!rl.ok) {
      return jsonError(limitMessage(rl.scope, rl.limit), 429, {
        'Retry-After': '60',
      });
    }

    const { messages, tripContext } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return jsonError('Invalid request: messages is required', 400);
    }

    // ── 第 5 道阀：单条消息长度 ──
    const last = messages[messages.length - 1];
    const lastContent = typeof last?.content === 'string' ? last.content : '';
    if (lastContent.length > POLICY.maxMessageChars) {
      return jsonError(`消息太长啦，请控制在 ${POLICY.maxMessageChars} 字以内～`, 413);
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return jsonError('DEEPSEEK_API_KEY not configured in environment variables', 500);
    }

    // 构建系统提示词：行程数据来自请求体 tripContext（前端从 data/trips.json 载入后传入），
    // 后端不再硬编码行程，改数据只需改 data/trips.json 这一个文件。
    const systemMessage = {
      role: 'system',
      content: buildSystemPrompt(tripContext),
    };

    // 合并消息：系统提示 + 历史消息
    const recentMessages = messages.slice(-POLICY.maxHistoryMessages);
    const fullMessages = [systemMessage, ...recentMessages];

    // 调用 DeepSeek API
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: fullMessages,
        stream: true,
        temperature: 0.7,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('DeepSeek API error:', response.status, errorText);
      return jsonError(`API request failed: ${response.status}`, response.status);
    }

    // 返回流式响应
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Chat API error:', error);
    return jsonError('Internal server error: ' + error.message, 500);
  }
}
