// ============================================
// TOKEN MANAGEMENT
// ============================================

async function getCachedAccessToken(env) {
  const cached = await env.AGENT_PHONE_MAP.get('dingtalk_access_token');
  
  if (cached) {
    try {
      const data = JSON.parse(cached);
      const remaining = Math.floor((data.expires_at - Date.now()) / 1000);
      
      console.log(`📊 Cached token found. Expires in: ${remaining} seconds`);
      
      if (data.expires_at > Date.now()) {
        console.log(`✅ Using cached token (${remaining}s remaining)`);
        console.log(`📋 Token preview: ${data.access_token.substring(0, 15)}...`);
        return {
          token: data.access_token,
          source: 'cached',
          expires_in: remaining,
          expires_at: data.expires_at
        };
      } else {
        console.log(`⚠️ Cached token EXPIRED (${Math.abs(remaining)}s ago)`);
      }
    } catch(e) {
      console.log('⚠️ Failed to parse cached token, fetching new one');
    }
  } else {
    console.log('📭 No cached token found');
  }
  
  console.log('🔄 Fetching NEW access_token from DingTalk...');
  const startTime = Date.now();
  
  const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${env.DINGTALK_APP_KEY}&appsecret=${env.DINGTALK_APP_SECRET}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();
  
  if (tokenData.errcode !== 0) {
    throw new Error(`Token error: ${tokenData.errmsg}`);
  }
  
  const elapsed = Date.now() - startTime;
  const expiresAt = Date.now() + 100 * 60 * 1000;
  
  await env.AGENT_PHONE_MAP.put('dingtalk_access_token', JSON.stringify({
    access_token: tokenData.access_token,
    expires_at: expiresAt
  }));
  
  console.log(`✅ New token fetched in ${elapsed}ms`);
  console.log(`📋 Token preview: ${tokenData.access_token.substring(0, 15)}...`);
  console.log(`⏰ Token expires at: ${new Date(expiresAt).toLocaleString()}`);
  
  return {
    token: tokenData.access_token,
    source: 'new',
    expires_in: 100 * 60,
    expires_at: expiresAt
  };
}

// ============================================
// MESSAGE SENDING (Unified with auto-retry)
// ============================================

async function sendDingTalkMessage(accessToken, agentId, userIds, title, text, env, retryCount = 0) {
  if (!userIds || userIds.length === 0) return null;
  
  const MAX_RETRIES = 2;
  const useridList = userIds.join('|');
  
  try {
    const sendRes = await fetch(`https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        userid_list: useridList,
        msg: {
          msgtype: 'markdown',
          markdown: {
            title: title,
            text: text
          }
        }
      })
    });
    
    const sendData = await sendRes.json();
    
    // Check if token is invalid
    if (sendData.errcode === 40014 || sendData.errcode === 40015) {
      console.warn(`⚠️ Token invalid (errcode: ${sendData.errcode}), refreshing...`);
      
      // Delete invalid token from cache
      await env.AGENT_PHONE_MAP.delete('dingtalk_access_token');
      
      if (retryCount < MAX_RETRIES) {
        console.log(`🔄 Retrying with new token (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        const newTokenResult = await getCachedAccessToken(env);
        // Retry with new token
        return await sendDingTalkMessage(newTokenResult.token, agentId, userIds, title, text, env, retryCount + 1);
      } else {
        console.error(`❌ Max retries (${MAX_RETRIES}) exceeded for invalid token`);
        return sendData;
      }
    }
    
    if (sendData.errcode !== 0) {
      console.error(`Send error: ${sendData.errmsg} (errcode: ${sendData.errcode})`);
    }
    return sendData;
    
  } catch (error) {
    console.error('Send error:', error);
    throw error;
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getParamFromLandingPage(landing_page, paramName) {
  if (!landing_page || typeof landing_page !== 'string') return '';
  try {
    const urlObj = new URL(landing_page);
    const value = urlObj.searchParams.get(paramName);
    return value || '';
  } catch (e) {
    return '';
  }
}

function getClientInfo(request) {
  return {
    user_ip: request.headers.get('CF-Connecting-IP') || 
             request.headers.get('X-Forwarded-For') || 
             request.headers.get('X-Real-IP') || 
             'unknown',
    user_country: request.headers.get('CF-IPCountry') || 'unknown',
    user_agent: request.headers.get('User-Agent') || 'unknown'
  };
}

function isValidClientId(id) {
  if (!id || id === 'unknown' || id === '') return false;
  const pattern = /^cid_\d{13,}_[a-z0-9]{8}$/;
  return pattern.test(id);
}

function calculateValue(type, range, baseRent, basePrice) {
  const extractNumber = (str) => {
    if (!str) return 0;
    const match = str.match(/(\d+(?:,\d+)?)/);
    return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
  };
  
  const rentNum = extractNumber(baseRent);
  const priceNum = extractNumber(basePrice);
  
  if (range === '0') return 0;
  if (range === '1') return 1;
  
  if (type === 'rent') {
    switch (range) {
      case 'below_20k': return 2000;
      case '20k_50k': return Math.round(35000 * 0.3);
      case '50k_80k': return Math.round(65000 * 0.3);
      case '80k_120k': return Math.round(100000 * 0.3);
      case '120k_160k': return Math.round(140000 * 0.3);
      case 'above_160k': return Math.round(200000 * 0.3);
      default: return rentNum > 0 ? Math.round(rentNum * 0.3) : 2000;
    }
  } else {
    switch (range) {
      case 'below_8m': return 2000;
      case '8m_15m': return Math.round(11500000 * 0.003);
      case '15m_20m': return Math.round(17500000 * 0.003);
      case '20m_50m': return Math.round(35000000 * 0.003);
      case 'above_50m': return Math.round(50000000 * 0.003);
      default: return priceNum > 0 ? Math.round(priceNum * 0.003) : 2000;
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// ============================================
// TEST MESSAGE HANDLER
// ============================================

async function handleTestMessage(env) {
  // ... (keep as is - useful for debugging)
  // You can uncomment the route when needed
}

// ============================================
// VERIFICATION HANDLERS
// ============================================

async function handleVerifyPage(env, url, request) {
  // ... (keep as is)
}

async function handleVerifyAction(request, env) {
  // ... (keep as is)
}

// ============================================
// MAIN FETCH HANDLER
// ============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Test route (uncomment when needed)
    // if (path === '/test' && request.method === 'GET') {
    //   return handleTestMessage(env);
    // }

    // IP Test Route
    if (path === '/test-ip' && request.method === 'GET') {
      const clientInfo = getClientInfo(request);
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>IP Capture Test</title>
          <style>
            body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
            h1 { color: #4ec9b0; }
            .info { background: #2d2d2d; padding: 20px; border-radius: 8px; margin-top: 20px; }
            .label { color: #9cdcfe; font-weight: bold; }
            .value { color: #4ec9b0; margin-left: 10px; }
          </style>
        </head>
        <body>
          <h1>🌐 IP Capture Test</h1>
          <div class="info">
            <div><span class="label">User IP:</span> <span class="value">${escapeHtml(clientInfo.user_ip)}</span></div>
            <div><span class="label">Country:</span> <span class="value">${escapeHtml(clientInfo.user_country)}</span></div>
            <div><span class="label">User Agent:</span> <span class="value">${escapeHtml(clientInfo.user_agent)}</span></div>
          </div>
        </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Verification routes
    if (path === '/verify' && request.method === 'GET') {
      return handleVerifyPage(env, url, request);
    }
    
    if (path === '/verify' && request.method === 'POST') {
      return handleVerifyAction(request, env);
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Only accept POST requests for lead data
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      const data = await request.json();
      const clientInfo = getClientInfo(request);
      
      const client_id = String(data.client_id || 'unknown');
      const rent = String(data.rent || '');
      const property_price = String(data.property_price || '');
      const size = String(data.size || '');
      const district = String(data.district || '');
      const property_type = String(data.property_type || '');
      const agent_code = String((data.agent || '').toLowerCase());
      const click_type = String(data.click_type || '');
      const page_location = String(data.page_location || '');
      const landing_page = String(data.landing_page || '');
      
      // Server-side validation
      let blockReason = null;
      if (!click_type || click_type === '') {
        blockReason = 'missing_click_type';
      } else if (!agent_code || agent_code === '') {
        blockReason = 'missing_agent';
      } else if (!isValidClientId(client_id)) {
        blockReason = 'invalid_client_id_format';
      }
      
      if (blockReason) {
        console.log(JSON.stringify({
          type: 'BLOCKED_BOT',
          reason: blockReason,
          ip: clientInfo.user_ip,
          country: clientInfo.user_country,
          client_id: client_id,
          click_type: click_type,
          agent: agent_code,
          user_agent: clientInfo.user_agent.substring(0, 200),
          timestamp: new Date().toISOString()
        }));
        
        return new Response(JSON.stringify({ 
          success: true,
          message: 'Lead received'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      
      const now = new Date();
      const isoTime = now.toISOString();
      const formattedTime = now.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
      
      const utm_source = String(data.utm_source || '');
      const utm_medium = String(data.utm_medium || '');
      const utm_campaign = String(data.utm_campaign || '');
      const utm_term = String(data.utm_term || '');
      const utm_content = String(data.utm_content || '');
      const gclid = String(data.gclid || '');
      const referrer = String(data.referrer || '');
      
      const traffic_type = String(data.traffic_type || '');
      const traffic_source = String(data.traffic_source || '');
      const traffic_detail = String(data.traffic_detail || '');
      const utm_id = getParamFromLandingPage(landing_page, 'utm_id');

      // Extract search query
      let search_query = '';
      if (referrer && referrer.includes('google.com')) {
        try {
          const referrerUrl = new URL(referrer);
          search_query = referrerUrl.searchParams.get('q') || '';
          if (search_query) search_query = decodeURIComponent(search_query);
        } catch (e) {}
      }
      if (landing_page && landing_page.includes('?') && !search_query) {
        search_query = getParamFromLandingPage(landing_page, 'q');
        if (search_query) search_query = decodeURIComponent(search_query);
      }

      // Query history
      let historyRecords = [];
      try {
        const historyStmt = await env.lead_db.prepare(`
          SELECT id, agent_name, click_type, status, created_at, verified_at, verified_by
          FROM leads WHERE client_id = ? ORDER BY id ASC LIMIT 10
        `);
        const { results } = await historyStmt.bind(client_id).all();
        historyRecords = results;
        console.log(`📋 Found ${historyRecords.length} history record(s) for client: ${client_id}`);
      } catch (historyError) {
        console.error('History query error:', historyError);
      }

      // Get agent info
      const DEFAULT_HOTLINE = env.DEFAULT_HOTLINE || '+85291333030';
      let agent_phone = DEFAULT_HOTLINE;
      let agent_dingtalk_id = null;
      let agent_display_name = agent_code;
      let agent_found = false;
      
      if (agent_code === 'general_enquiry') {
        let kvKey;
        if (click_type === 'tel') {
          kvKey = 'general_enquiry';
        } else if (click_type === 'form') {
          kvKey = 'general_enquiry_form';
        } else {
          kvKey = 'general_enquiry_msg';
        }
        try {
          const kvValue = await env.AGENT_PHONE_MAP.get(kvKey);
          if (kvValue) {
            let parsedValue;
            if (typeof kvValue === 'string' && kvValue.startsWith('[')) {
              parsedValue = JSON.parse(kvValue);
            } else {
              parsedValue = kvValue;
            }
            if (Array.isArray(parsedValue) && parsedValue.length >= 2) {
              agent_display_name = parsedValue[0];
              agent_dingtalk_id = parsedValue[1];
              agent_found = true;
              console.log(`✅ general_enquiry (${click_type}) → Agent: ${agent_display_name}, dingtalk_id: ${agent_dingtalk_id}`);
            } else {
              console.log(`⚠️ Invalid format for ${kvKey}, expected JSON array ["agent_name","dingtalk_id"]`);
            }
          } else {
            console.log(`⚠️ KV key ${kvKey} not found, using defaults`);
          }
        } catch (e) {
          console.error(`KV error for ${kvKey}:`, e);
        }
      } else if (agent_code) {
        try {
          const { results } = await env.lead_db.prepare(`
            SELECT agent_name, phone_number, dingtalk_id 
            FROM agents 
            WHERE agent_name = ? AND is_active = 1
          `).bind(agent_code).all();
          
          if (results.length > 0) {
            agent_display_name = results[0].agent_name;
            agent_phone = results[0].phone_number;
            agent_dingtalk_id = results[0].dingtalk_id;
            agent_found = true;
            console.log(`✅ Agent found: ${agent_code} → dingtalk_id: ${agent_dingtalk_id}`);
          } else {
            console.log(`⚠️ Agent not found in DB: ${agent_code}`);
          }
        } catch (dbError) {
          console.error('DB query error:', dbError);
        }
      }

      if (agent_phone && !agent_phone.startsWith('+')) {
        agent_phone = '+' + agent_phone;
      }

      // Save to database
      let leadId = null;
      let dbError = null;
      try {
        const insertStmt = await env.lead_db.prepare(`
          INSERT INTO leads (
            client_id, agent_name, agent_phone, click_type,
            rent, property_price, size, district, property_type,
            page_location, page_referrer, landing_page,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            gclid, traffic_type, traffic_source, traffic_detail,
            search_query, status, utm_id, created_at,
            user_ip, user_country, user_agent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = await insertStmt.bind(
          client_id, agent_display_name, agent_phone, click_type,
          rent, property_price, size, district, property_type,
          page_location, referrer, landing_page,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          gclid, traffic_type, traffic_source, traffic_detail,
          search_query, 'pending', utm_id, isoTime,
          clientInfo.user_ip, clientInfo.user_country, clientInfo.user_agent
        ).run();

        leadId = result.meta.last_row_id;
        console.log(`✅ Lead saved, ID: ${leadId} | Agent: ${agent_display_name} | IP: ${clientInfo.user_ip} | Country: ${clientInfo.user_country}`);
      } catch (error) {
        dbError = error;
        console.error('❌ Database insert error:', error);
      }

      // Get DingTalk token
      const DINGTALK_APP_KEY = env.DINGTALK_APP_KEY;
      const DINGTALK_APP_SECRET = env.DINGTALK_APP_SECRET;
      const DINGTALK_AGENT_ID = env.DINGTALK_AGENT_ID;

      if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET || !DINGTALK_AGENT_ID) {
        console.error('Missing DingTalk credentials');
        return new Response(JSON.stringify({ 
          success: true, 
          lead_id: leadId,
          warning: 'DingTalk credentials missing'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      let accessToken;
      let tokenSource = 'unknown';
      try {
        const tokenResult = await getCachedAccessToken(env);
        accessToken = tokenResult.token;
        tokenSource = tokenResult.source;
        console.log(`📊 Token source: ${tokenSource}`);
      } catch (tokenError) {
        console.error('Token error:', tokenError);
        return new Response(JSON.stringify({ 
          success: true, 
          lead_id: leadId,
          warning: 'DingTalk token error'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Build property info
      const propertyLines = [];
      if (rent) propertyLines.push(`💰 **租:** ${rent}`);
      if (property_price) propertyLines.push(`🏷️ **售:** ${property_price}`);
      if (size) propertyLines.push(`📐 **面积:** ${size}`);
      if (district) propertyLines.push(`📍 **区域:** ${district}`);
      if (property_type) propertyLines.push(`🏢 **类型:** ${property_type}`);
      
      const propertyInfo = propertyLines.length > 0 
        ? propertyLines.join('\n') 
        : '📋 暂无房源详细信息';

      // Build marketing info
      const marketingLines = [];
      if (traffic_type) marketingLines.push(`**流量类型:** ${traffic_type}`);
      if (traffic_source) marketingLines.push(`**来源:** ${traffic_source}`);
      if (traffic_detail) marketingLines.push(`**详情:** ${traffic_detail}`);
      if (utm_source) marketingLines.push(`**UTM来源:** ${utm_source}`);
      if (utm_medium) marketingLines.push(`**UTM媒介:** ${utm_medium}`);
      if (utm_campaign) marketingLines.push(`**UTM活动:** ${utm_campaign}`);
      if (utm_term) marketingLines.push(`**UTM关键词:** ${utm_term}`);
      if (gclid) marketingLines.push(`**GCLID:** \`${gclid.substring(0, 30)}...\``);
      
      const marketingInfo = marketingLines.length > 0 
        ? marketingLines.join('\n') 
        : '未检测到来源信息';

      // Build history section
      let historySection = '';
      if (historyRecords.length > 0) {
        const historyLines = [];
        historyLines.push(`\n\n---\n\n### 📜 历史记录 (同一客户)\n\n`);
        historyLines.push(`| ID | 日期 | 代理 | 来源 | 状态 | 处理人 | 处理时间 |`);
        historyLines.push(`|----|------|------|------|------|--------|----------|`);
        
        for (const record of historyRecords) {
          if (record.id === leadId) continue;
          
          let recordDate = record.created_at || '未知';
          if (recordDate && recordDate !== '未知') {
            try {
              recordDate = new Date(recordDate).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
            } catch (e) {}
          }
          
          const recordId = record.id;
          const recordAgent = record.agent_name || '未知';
          const recordClickType = record.click_type || '未知';
          let recordStatus = record.status === 'pending' ? '⏳ 待处理' : (record.status === 'verified' ? '✅ 确认有效' : '❌ 确认垃圾');
          if (record.value === 1) {
            recordStatus = '🚫 未有来电';
          }
          
          const recordVerifiedBy = record.verified_by || '-';
          
          let recordVerifiedDate = record.verified_at || '未处理';
          if (recordVerifiedDate && recordVerifiedDate !== '未处理') {
            try {
              recordVerifiedDate = new Date(recordVerifiedDate).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' });
            } catch (e) {}
          }
          
          historyLines.push(`| ${recordId} | ${recordDate} | ${recordAgent} | ${recordClickType} | ${recordStatus} | ${recordVerifiedBy} | ${recordVerifiedDate} |`);
        }
        
        if (historyLines.length > 2) {
          historySection = historyLines.join('\n');
          const historyCount = historyRecords.length - (leadId ? 1 : 0);
          if (historyCount > 0) {
            historySection += `\n\n⚠️ **注意：该客户已有 ${historyCount} 次历史咨询记录，请确认是否需要重复跟进！**`;
          }
        }
      }

      const repeatWarning = data.previous_conversion ? '\n\n⚠️ **该用户之前已点击过咨询按钮！**' : '';
      const host = request.headers.get('host');
      const verifyUrl = `https://${host}/verify?id=${leadId}`;

      // Build message
      let messageText = `## 📞 新线索通知\n\n` +
        `**线索ID:** \`#${leadId || 'N/A'}\`\n\n` +
        `${formattedTime}\n\n` +
        `---\n\n` +
        `**客号:** \`${client_id}\`\n\n` +
        `**IP:** ${clientInfo.user_ip}\n\n` +
        `**地区:** ${clientInfo.user_country}\n\n` +
        `---\n\n` +
        `${propertyInfo}\n\n` +
        `---\n\n` +
        `### 👤 ${agent_display_name}\n\n` +
        `---\n\n` +
        `### 🎯 线索来源\n\n` +
        `**接收模式:** ${click_type || '未知'}\n\n`;
      
      if (search_query) {
        messageText += `**🔍 搜索词:** ${search_query}\n\n`;
      }
      
      messageText += `${marketingInfo}\n\n` +
        `---\n\n` +
        `### 🌐 落地页\n\n` +
        `${landing_page || '未知'}\n\n` +
        `---\n\n` +
        `### 📍 点击页面\n\n` +
        `${page_location || '未知'}\n\n` +
        `---\n\n` +
        `### 🔗 [验证线索](${verifyUrl})\n\n` +
        `⚠️<font color="red">优先跟进权归首位确认线索者所有</font>\n\n` +
        `---\n\n` +
        `${repeatWarning}${historySection}`;
      
      // Send to agent
      let agentSentCount = 0;
      if (agent_dingtalk_id) {
        await sendDingTalkMessage(accessToken, parseInt(DINGTALK_AGENT_ID), [agent_dingtalk_id], '📞 新线索通知', messageText, env);
        agentSentCount = 1;
        console.log(`✅ Message sent to agent: ${agent_display_name} (${agent_dingtalk_id})`);
      } else {
        console.warn(`⚠️ No dingtalk_id for agent: ${agent_display_name}, message not sent.`);
      }

      // Send to admins
      const adminMessageText = `## 📋 线索副本 (管理员)\n\n` +
        `**线索ID:** \`#${leadId || 'N/A'}\`\n\n` +
        `${formattedTime}\n\n` +
        `---\n\n` +
        `**客号:** \`${client_id}\`\n\n` +
        `**IP:** ${clientInfo.user_ip}\n\n` +
        `**地区:** ${clientInfo.user_country}\n\n` +
        `**代理:** ${agent_display_name}\n\n` +
        `**代理电话:** ${agent_phone}\n\n` +
        `---\n\n` +
        `${propertyInfo}\n\n` +
        `---\n\n` +
        `### 🎯 线索来源\n\n` +
        `**接收模式:** ${click_type || '未知'}\n\n` +
        (search_query ? `**🔍 搜索词:** ${search_query}\n\n` : '') +
        `${marketingInfo}\n\n` +
        `---\n\n` +
        `### 🌐 落地页\n\n` +
        `${landing_page || '未知'}\n\n` +
        `---\n\n` +
        `### 📍 点击页面\n\n` +
        `${page_location || '未知'}\n\n` +
        `---\n\n` +
        `### 🔗 [验证线索](${verifyUrl})\n\n` +
        `⚠️<font color="red">优先跟进权归首位确认线索者所有</font>\n\n` +
        `---\n\n` +
        `⚠️ 此消息为系统自动发送的副本。${historySection}`;

      let adminSentCount = 0;
      try {
        const { results } = await env.lead_db.prepare(`
          SELECT dingtalk_id FROM agents WHERE admin = 1 AND is_active = 1 AND dingtalk_id IS NOT NULL
        `).all();
        
        const adminDingtalkIds = results.map(row => row.dingtalk_id);
        
        if (adminDingtalkIds.length > 0) {
          const sendResult = await sendDingTalkMessage(accessToken, parseInt(DINGTALK_AGENT_ID), adminDingtalkIds, '📋 线索副本', adminMessageText, env);
          if (sendResult && sendResult.errcode === 0) {
            adminSentCount = adminDingtalkIds.length;
            console.log(`✅ Message sent to ${adminSentCount} admin(s) (1 API call)`);
          }
        }
      } catch (adminError) {
        console.error('Admin query error:', adminError);
      }

      return new Response(JSON.stringify({ 
        success: true, 
        lead_id: leadId,
        client_id: client_id,
        agent_mapped: agent_found,
        agent_display_name: agent_display_name,
        agent_message_sent: agentSentCount,
        admin_copies_sent: adminSentCount,
        history_count: historyRecords.length,
        db_error: dbError ? dbError.message : null,
        user_ip: clientInfo.user_ip,
        user_country: clientInfo.user_country
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  },
};