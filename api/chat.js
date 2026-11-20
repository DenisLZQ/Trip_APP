// Vercel Serverless Function: /api/chat
// 对接 DeepSeek API，支持流式输出
// API Key 需在 Vercel 项目环境变量中配置 DEEPSEEK_API_KEY

export const config = {
  runtime: 'edge',
  maxDuration: 300, // 5分钟超时，满足长回复需求
};

export default async function handler(req) {
  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const { messages, tripContext } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request: messages is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not configured in environment variables' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 构建系统提示词，注入行程上下文
    const systemMessage = {
      role: 'system',
      content: `你是L.L的专属AI行程管家，专门负责三亚40天海岛慢度假行程的问答与调整。

【当前行程基本信息】
- 行程名称：三亚40天·海岛慢度假
- 时间：2026年12月28日 → 2027年2月5日，共40天
- 出发地：上海虹桥机场，目的地：三亚凤凰机场
- 往返航班：去程MU5375（12/28 虹桥16:10→凤凰19:30），返程MU5378（2/5 凤凰17:50→虹桥21:00，除夕落地）
- 总预算：65万元
- 住宿安排：七段换湾——天涯小镇8晚→三亚湾中段5晚→珊瑚湾文华东方5晚→亚龙湾4晚→太阳湾柏悦4晚→海棠湾5晚→清水湾5晚→三亚湾收尾3晚

【你的能力】
1. 回答关于行程的任何问题：第几天去哪、住什么酒店、吃什么餐厅、交通安排、预算构成等
2. 给出调整建议：根据用户需求推荐餐厅、景点、时间安排的优化
3. 风格友好、贴心、简洁，符合私人管家的定位
4. 所有回答基于提供的行程数据，不要编造不存在的安排
5. 如果用户提出修改需求，先给出修改预览方案，确认后再实际生效（当前阶段为只读问答，暂不直接修改数据）

【注意事项】
- 三亚冬季白天24-28℃，夜间19-22℃，紫外线强，提醒防晒
- 行程以慢节奏、松弛感为主，不赶景点，每天只安排1-2个主要活动
- 傍晚16:00后再出门活动，避开正午日晒
- 酒店选择优先安静、私密度假体验
- 当前为只读问答模式，修改行程的功能将在后续版本上线，你可以先给出修改建议供参考`
    };

    // 合并消息：系统提示 + 历史消息（最多保留最近10轮）
    const recentMessages = messages.slice(-20); // 最近20条消息
    const fullMessages = [systemMessage, ...recentMessages];

    // 调用 DeepSeek API（使用beta通道支持strict tools模式，当前阶段先用纯对话）
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
      return new Response(JSON.stringify({ error: `API request failed: ${response.status}` }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 返回流式响应
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });

  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error: ' + error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
