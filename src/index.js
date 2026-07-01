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
  const DINGTALK_APP_KEY = env.DINGTALK_APP_KEY;
  const DINGTALK_APP_SECRET = env.DINGTALK_APP_SECRET;
  const DINGTALK_AGENT_ID = env.DINGTALK_AGENT_ID;
  const TEST_USER_ID = "235618443822-2024983294";
  
  let logs = [];
  let requestId = null;
  let taskId = null;
  let sendSuccess = false;
  
  function addLog(msg, isError = false) {
    logs.push({ msg, isError });
    console.log(msg);
  }
  
  try {
    addLog('🔄 1. 获取 Access Token...');
    const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${DINGTALK_APP_KEY}&appsecret=${DINGTALK_APP_SECRET}`;
    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    
    if (tokenData.errcode !== 0) {
      throw new Error(`Token 失败: ${tokenData.errmsg}`);
    }
    const accessToken = tokenData.access_token;
    addLog(`✅ Token 获取成功: ${accessToken.substring(0, 20)}...`);
    
    addLog(`🔄 2. 发送消息给 ${TEST_USER_ID}...`);
    const sendUrl = `https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=${accessToken}`;
    const sendRes = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: parseInt(DINGTALK_AGENT_ID),
        userid_list: TEST_USER_ID,
        msg: {
          msgtype: 'text',
          text: { content: `🧪 测试消息\n时间: ${new Date().toLocaleString()}\n\n如果你看到这条消息，说明钉钉配置正确！` }
        }
      })
    });
    
    const sendData = await sendRes.json();
    
    requestId = sendData.request_id || sendData.requestId || '未获取到';
    taskId = sendData.task_id;
    
    addLog(`📋 发送响应体: ${JSON.stringify(sendData)}`);
    
    if (sendData.errcode !== 0) {
      throw new Error(`发送失败: ${sendData.errmsg} (errcode: ${sendData.errcode})`);
    }
    
    sendSuccess = true;
    addLog(`✅ 消息发送成功！`);
    addLog(`📋 request_id: ${requestId}`);
    addLog(`📋 task_id: ${taskId}`);
    
    if (taskId) {
      addLog(`\n🔄 3. 查询消息投递状态...`);
      addLog(`⏳ 等待 3 秒让消息处理完成...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const statusResult = await checkMessageStatus(accessToken, parseInt(DINGTALK_AGENT_ID), taskId);
      
      addLog(`📋 投递状态响应: ${JSON.stringify(statusResult, null, 2)}`);
      
      if (statusResult.errcode === 0) {
        addLog(`✅ 状态查询成功！`);
        
        if (statusResult.send_result) {
          const sendResult = statusResult.send_result;
          
          if (sendResult.failed_userid_list && sendResult.failed_userid_list.length > 0) {
            addLog(`❌ 投递失败的用户: ${sendResult.failed_userid_list.join(', ')}`, true);
            addLog(`💡 可能原因: 用户不在应用可见范围内`, true);
          } else if (sendResult.success_userid_list && sendResult.success_userid_list.length > 0) {
            addLog(`✅ 消息成功投递到: ${sendResult.success_userid_list.join(', ')}`);
          }
          
          if (sendResult.invalid_userid_list && sendResult.invalid_userid_list.length > 0) {
            addLog(`⚠️ 无效的用户ID: ${sendResult.invalid_userid_list.join(', ')}`, true);
            addLog(`💡 请检查用户ID是否正确`, true);
          }
          
          if (sendResult.send_progress !== undefined) {
            addLog(`📊 发送进度: ${sendResult.send_progress}%`);
          }
        }
      } else {
        addLog(`❌ 状态查询失败: ${statusResult.errmsg} (errcode: ${statusResult.errcode})`, true);
        addLog(`💡 可能原因: task_id 无效或超过查询时限(24小时)`, true);
      }
    }
    
  } catch (err) {
    addLog(`❌ 错误: ${err.message}`, true);
  }
  
  async function checkMessageStatus(accessToken, agentId, taskId) {
    const url = `https://oapi.dingtalk.com/topapi/message/corpconversation/getsendresult?access_token=${accessToken}`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          task_id: taskId
        })
      });
      
      return await response.json();
    } catch (error) {
      return { errcode: -1, errmsg: `查询失败: ${error.message}` };
    }
  }
  
  return new Response(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>钉钉消息测试</title>
      <style>
        body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
        h1 { color: #4ec9b0; }
        .log { background: #2d2d2d; padding: 15px; border-radius: 8px; margin-top: 20px; max-height: 600px; overflow: auto; }
        .log-line { font-family: monospace; margin: 5px 0; white-space: pre-wrap; word-break: break-all; }
        .success { color: #4ec9b0; }
        .error { color: #f48771; }
        .info { color: #9cdcfe; }
        .warning { color: #dcdcaa; }
        button { background: #0e639c; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 20px; }
        button:hover { background: #1177bb; }
        .status-box { 
          background: #2d2d2d; 
          padding: 15px; 
          border-radius: 8px; 
          margin-top: 10px;
          border-left: 4px solid #4ec9b0;
        }
        .status-box.error { border-left-color: #f48771; }
        .status-box.warning { border-left-color: #dcdcaa; }
        .summary { margin-top: 10px; padding: 10px; background: #252525; border-radius: 5px; }
        .label { color: #9cdcfe; }
        .value { color: #4ec9b0; }
      </style>
    </head>
    <body>
      <h1>🧪 钉钉消息测试</h1>
      <p>目标 User ID: <code style="background:#2d2d2d;padding:2px 8px;border-radius:4px">${TEST_USER_ID}</code></p>
      
      <div class="log">
        ${logs.map(log => {
          let className = 'info';
          if (log.msg.includes('✅')) className = 'success';
          else if (log.msg.includes('❌')) className = 'error';
          else if (log.msg.includes('⚠️')) className = 'warning';
          else if (log.msg.includes('📋') || log.msg.includes('📊')) className = 'info';
          return `<div class="log-line ${className}">${escapeHtml(log.msg)}</div>`;
        }).join('')}
      </div>
      
      ${!sendSuccess ? `
        <div class="status-box error" style="margin-top:20px;">
          <strong>⚠️ 消息发送失败</strong>
          <p>请检查上面的错误信息进行排查。</p>
        </div>
      ` : `
        <div class="status-box" style="margin-top:20px;">
          <strong>✅ 测试完成</strong>
          <div class="summary">
            <div><span class="label">Task ID:</span> <span class="value">${taskId || 'N/A'}</span></div>
            <div><span class="label">Request ID:</span> <span class="value">${requestId || 'N/A'}</span></div>
          </div>
          <p style="margin-top:10px;font-size:13px;color:#808080;">
            💡 如果消息未收到，请检查：
            <br>• 用户是否在应用的<a href="https://open.dingtalk.com/document/orgapp/issue-faq" target="_blank" style="color:#4ec9b0;">可见范围</a>内
            <br>• 用户ID是否正确
            <br>• 应用是否有足够的权限
          </p>
        </div>
      `}
      
      <button onclick="location.reload()">🔄 再次测试</button>
      <p style="margin-top:20px;font-size:12px;color:#808080;">测试时间: ${new Date().toLocaleString()}</p>
    </body>
    </html>
  `, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ============================================
// VERIFICATION HANDLERS
// ============================================

async function handleVerifyPage(env, url, request) {
  const leadId = url.searchParams.get('id');
  
  if (!leadId) {
    return new Response('缺少线索ID参数', { status: 400 });
  }
  
  const lead = await env.lead_db.prepare(`
    SELECT id, client_id, agent_name, click_type, 
           rent, property_price, size, district, property_type,
           landing_page, page_location, status, created_at, verified_at, verified_by, value
    FROM leads 
    WHERE id = ?
  `).bind(leadId).first();
  
  if (!lead) {
    return new Response('线索不存在', { status: 404 });
  }
  
  const mode = url.searchParams.get('mode');
  const isRecoveryMode = (mode === 'recovery');
  
  const verifiedRecord = await env.lead_db.prepare(`
    SELECT id, agent_name, verified_by, verified_at, status, value
    FROM leads 
    WHERE client_id = ? AND value > 1
    ORDER BY verified_at DESC
    LIMIT 1
  `).bind(lead.client_id).first();
  
  const rejectedOrNoshowRecord = await env.lead_db.prepare(`
    SELECT id, agent_name, verified_by, verified_at, status, value
    FROM leads 
    WHERE client_id = ? AND (value = 0 OR value = 1)
    ORDER BY verified_at DESC
    LIMIT 1
  `).bind(lead.client_id).first();
  
  if (verifiedRecord) {
    const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>线索验证 - 已锁定</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px;display:flex;justify-content:center;align-items:center}.container{max-width:500px;margin:0 auto;background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden}.header{background:linear-gradient(135deg,#da196e,#b9155e);color:white;padding:30px;text-align:center}.header h1{font-size:24px;margin-bottom:8px}.content{padding:30px}.warning-icon{font-size:60px;text-align:center;margin-bottom:20px}.warning-message{background:#fff3cd;border-left:4px solid #ffc107;padding:16px;border-radius:8px;margin-bottom:20px}.info-row{padding:8px 0;border-bottom:1px solid #e9ecef}.info-label{font-weight:600;color:#495057;display:inline-block;width:100px}.info-value{color:#212529}.button-group{display:flex;gap:16px;margin-top:24px}.btn{flex:1;padding:12px 20px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:transform 0.2s,opacity 0.2s}.btn:hover{transform:translateY(-2px);opacity:0.9}.btn-back{background:#6c757d;color:white}.footer{background:#f8f9fa;padding:16px 30px;text-align:center;font-size:12px;color:#6c757d}</style>
</head>
<body>
<div class="container"><div class="header"><h1>🔍 线索验证</h1></div>
<div class="content"><div class="warning-icon">⚠️</div>
<div class="warning-message"><strong>此客户已被其他代理确认为有效线索！</strong><br><br>
<div class="info-row"><span class="info-label">处理代理：</span><span class="info-value">${escapeHtml(verifiedRecord.agent_name) || '未知'}</span></div>
<div class="info-row"><span class="info-label">处理时间：</span><span class="info-value">${new Date(verifiedRecord.verified_at).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })}</span></div></div>
</div>
<div class="footer">此线索来自 LeasingHub 系统<br><font color="red">该客户已被确认有效，无法再次修改</font></div></div>
</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  
  if (isRecoveryMode && rejectedOrNoshowRecord) {
    // 继续往下执行
  } else if (rejectedOrNoshowRecord && !isRecoveryMode) {
    const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>线索验证 - 可恢复</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px;display:flex;justify-content:center;align-items:center}.container{max-width:500px;margin:0 auto;background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden}.header{background:linear-gradient(135deg,#da196e,#b9155e);color:white;padding:30px;text-align:center}.header h1{font-size:24px;margin-bottom:8px}.content{padding:30px}.warning-icon{font-size:60px;text-align:center;margin-bottom:20px}.warning-message{background:#fff3cd;border-left:4px solid #ffc107;padding:16px;border-radius:8px;margin-bottom:20px}.info-row{padding:8px 0;border-bottom:1px solid #e9ecef}.info-label{font-weight:600;color:#495057;display:inline-block;width:100px}.info-value{color:#212529}.button-group{display:flex;gap:16px;margin-top:24px;justify-content:center}.btn{flex:1;padding:12px 20px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:transform 0.2s,opacity 0.2s;text-decoration:none;text-align:center;display:inline-block;max-width:200px}.btn-verify{background:#28a745;color:white}.footer{background:#f8f9fa;padding:16px 30px;text-align:center;font-size:12px;color:#6c757d}</style>
</head>
<body>
<div class="container"><div class="header"><h1>🔍 线索验证</h1></div>
<div class="content"><div class="warning-icon">⚠️</div>
<div class="warning-message"><strong>此线索曾被标记为垃圾线索/未有来电！</strong><br><br>
<div class="info-row"><span class="info-label">原处理代理：</span><span class="info-value">${escapeHtml(rejectedOrNoshowRecord.agent_name) || '未知'}</span></div>
<div class="info-row"><span class="info-label">原处理时间：</span><span class="info-value">${new Date(rejectedOrNoshowRecord.verified_at).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong' })}</span></div></div>
<p style="margin-bottom:20px;color:#666;">该线索曾被标记为无效，如需重新确认，请点击下方按钮继续。</p>
<div class="button-group"><a href="/verify?id=${leadId}&mode=recovery" class="btn btn-verify" style="text-decoration:none;text-align:center;display:inline-block;">✅ 继续验证此线索</a></div></div>
<div class="footer">此线索来自 LeasingHub 系统</div></div>
</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  
  const districtsJson = await env.AGENT_PHONE_MAP.get('districts');
  let districts = ['Central', 'Sheung_Wan', 'Causeway_Bay', 'Tsimshatsui', 'Mongkok', 'Kwun_Tong', 'Kowloon_Bay'];
  if (districtsJson) {
    try { districts = JSON.parse(districtsJson); } catch (e) {}
  }
  
  const rentOptions = [
    { value: '0', label: '0 (拒绝/垃圾)', baseValue: 0 },
    { value: '1', label: '未有来电', baseValue: 1 },
    { value: 'below_20k', label: 'Below 2萬', baseValue: 20000 },
    { value: '20k_50k', label: '2萬 - 5萬', baseValue: 35000 },
    { value: '50k_80k', label: '5萬 - 8萬', baseValue: 65000 },
    { value: '80k_120k', label: '8萬 - 12萬', baseValue: 100000 },
    { value: '120k_160k', label: '12萬 - 16萬', baseValue: 140000 },
    { value: 'above_160k', label: 'Above 16萬', baseValue: 200000 }
  ];
  
  const buyOptions = [
    { value: '0', label: '0 (拒绝/垃圾)', baseValue: 0 },
    { value: '1', label: '未有来电', baseValue: 1 },
    { value: 'below_8m', label: 'Below 800萬', baseValue: 8000000 },
    { value: '8m_15m', label: '800萬 - 1500萬', baseValue: 11500000 },
    { value: '15m_20m', label: '1500萬 - 2000萬', baseValue: 17500000 },
    { value: '20m_50m', label: '2000萬 - 5000萬', baseValue: 35000000 },
    { value: 'above_50m', label: 'Above 5000萬', baseValue: 50000000 }
  ];
  
  const html = `<!DOCTYPE html>
<html lang="zh-HK">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>线索验证 - LeasingHub</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:20px}.container{max-width:600px;margin:0 auto;background:white;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden}.header{background:linear-gradient(135deg,#da196e,#b9155e);color:white;padding:30px;text-align:center}.header h1{font-size:24px;margin-bottom:8px}.header p{opacity:0.9;font-size:14px}.content{padding:30px}.info-section{background:#f8f9fa;border-radius:12px;padding:20px;margin-bottom:24px}.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e9ecef}.info-row:last-child{border-bottom:none}.info-label{font-weight:600;color:#495057;width:120px}.info-value{color:#212529;flex:1;word-break:break-word}.status-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}.status-pending{background:#ffc107;color:#856404}.form-group{margin-bottom:20px}.form-group label{display:block;font-weight:600;color:#495057;margin-bottom:8px}.form-group select{width:100%;padding:12px;border:1px solid #ced4da;border-radius:8px;font-size:16px;background:white}.button-group{display:flex;gap:16px;margin-top:24px}.btn{flex:1;padding:14px 20px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:transform 0.2s,opacity 0.2s}.btn:hover{transform:translateY(-2px);opacity:0.9}.btn-verify{background:#28a745;color:white}.btn-reject{background:#dc3545;color:white}.btn-cancel{background:#6c757d;color:white}.footer{background:#f8f9fa;padding:16px 30px;text-align:center;font-size:12px;color:#6c757d}.message{padding:12px 16px;border-radius:8px;margin-bottom:20px;display:none}.message.success{background:#d4edda;color:#155724;border:1px solid #c3e6cb}.message.error{background:#f8d7da;color:#721c24;border:1px solid #f5c6cb}.value-display{background:#e9ecef;padding:12px;border-radius:8px;margin-top:16px;text-align:center;font-size:18px;font-weight:bold;color:#da196e}@media (max-width:480px){.info-row{flex-direction:column}.info-label{width:100%;margin-bottom:4px}.button-group{flex-direction:column}}</style>
</head>
<body><div class="container"><div class="header"><h1>🔍 线索验证</h1><p id="headerSubtitle">${isRecoveryMode ? '⚠️ 此线索曾被标记为无效，请重新确认客户需求' : '请确认客户咨询信息并设置价值'}</p></div>
<div class="content"><div id="message" class="message"></div>
<div class="info-section"><div class="info-row"><span class="info-label">线索ID：</span><span class="info-value">#${lead.id}</span></div>
<div class="info-row"><span class="info-label">客号：</span><span class="info-value">${escapeHtml(lead.client_id)}</span></div>
<div class="info-row"><span class="info-label">状态：</span><span class="info-value"><span class="status-badge status-pending">${isRecoveryMode ? '待重新确认' : '⏳ 待处理'}</span></span></div></div>
<form id="verifyForm"><input type="hidden" id="agentName" value="${escapeHtml(lead.agent_name) || 'unknown'}">
<div class="form-group"><label>📍 区域</label><select id="district">${districts.map(d => `<option value="${escapeHtml(d)}" ${lead.district === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('')}</select></div>
<div class="form-group"><label>📋 租 / 买</label><select id="type" onchange="updateBudgetOptions()"><option value="rent" ${lead.rent ? 'selected' : ''}>租用 (Rent)</option><option value="buy" ${lead.property_price ? 'selected' : ''}>购买 (Buy)</option></select></div>
<div class="form-group"><label>💰 预算范围</label><select id="budgetRange"></select></div>
<div id="valueDisplay" class="value-display">预计价值: 计算中...</div>
<div class="button-group"><button type="button" class="btn btn-verify" onclick="submitVerify()">✅ 验证</button></div></form></div>
<div class="footer">此线索来自 LeasingHub 系统</div></div>
<script>
  const leadId = ${lead.id};
  const originalRent = ${lead.rent ? parseFloat(lead.rent.replace(/,/g, '')) : 0};
  const originalPrice = ${lead.property_price ? parseFloat(lead.property_price.replace(/,/g, '')) : 0};
  const isRecoveryMode = ${isRecoveryMode};
  
  function getAgentName() {
    return document.getElementById('agentName').value;
  }
  
  const rentOptions = ${JSON.stringify(rentOptions)};
  const buyOptions = ${JSON.stringify(buyOptions)};
  
  function updateBudgetOptions() {
    const type = document.getElementById('type').value;
    const select = document.getElementById('budgetRange');
    const options = type === 'rent' ? rentOptions : buyOptions;
    
    select.innerHTML = '';
    for (var i = 0; i < options.length; i++) {
      var opt = options[i];
      var option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === '0' || opt.value === '1') {
        option.style.color = opt.value === '0' ? '#dc3545' : '#6c757d';
        option.style.fontWeight = 'bold';
      }
      select.appendChild(option);
    }
    
    setDefaultBudgetRange();
  }
  
  function calculateValue() {
    const type = document.getElementById('type').value;
    const range = document.getElementById('budgetRange').value;
    let value = 0;
    
    if (range === '0') {
      value = 0;
    } else if (range === '1') {
      value = 1;
    } else if (type === 'rent') {
      switch(range) {
        case 'below_20k': value = 2000; break;
        case '20k_50k': value = Math.round(35000 * 0.3); break;
        case '50k_80k': value = Math.round(65000 * 0.3); break;
        case '80k_120k': value = Math.round(100000 * 0.3); break;
        case '120k_160k': value = Math.round(140000 * 0.3); break;
        case 'above_160k': value = Math.round(200000 * 0.3); break;
        default: value = Math.round((originalRent || 35000) * 0.3);
      }
    } else {
      switch(range) {
        case 'below_8m': value = 2000; break;
        case '8m_15m': value = Math.round(11500000 * 0.003); break;
        case '15m_20m': value = Math.round(17500000 * 0.003); break;
        case '20m_50m': value = Math.round(35000000 * 0.003); break;
        case 'above_50m': value = Math.round(50000000 * 0.003); break;
        default: value = Math.round((originalPrice || 11500000) * 0.003);
      }
    }
    
    if (value === 1) {
      document.getElementById('valueDisplay').innerHTML = '🚫 未有来电/讯息';
      document.getElementById('valueDisplay').style.color = '#6c757d';
    } else if (value === 0) {
      document.getElementById('valueDisplay').innerHTML = '❌ 拒绝/垃圾';
      document.getElementById('valueDisplay').style.color = '#dc3545';
    } else {
      document.getElementById('valueDisplay').innerHTML = '💰 估值: HK$ ' + value.toLocaleString();
      document.getElementById('valueDisplay').style.color = '#da196e';
    }
    return value;
  }
  
  function setDefaultBudgetRange() {
    const type = document.getElementById('type').value;
    const select = document.getElementById('budgetRange');
    
    if (type === 'rent' && originalRent > 0) {
      const monthlyRent = originalRent;
      var defaultRange = null;
      
      if (monthlyRent < 20000) {
        defaultRange = 'below_20k';
      } else if (monthlyRent >= 20000 && monthlyRent < 50000) {
        defaultRange = '20k_50k';
      } else if (monthlyRent >= 50000 && monthlyRent < 80000) {
        defaultRange = '50k_80k';
      } else if (monthlyRent >= 80000 && monthlyRent < 120000) {
        defaultRange = '80k_120k';
      } else if (monthlyRent >= 120000 && monthlyRent < 160000) {
        defaultRange = '120k_160k';
      } else if (monthlyRent >= 160000) {
        defaultRange = 'above_160k';
      }
      
      if (defaultRange) {
        for (var i = 0; i < select.options.length; i++) {
          if (select.options[i].value === defaultRange) {
            select.selectedIndex = i;
            break;
          }
        }
      }
    } else if (type === 'buy' && originalPrice > 0) {
      const salePrice = originalPrice;
      var defaultRange = null;
      
      if (salePrice < 8000000) {
        defaultRange = 'below_8m';
      } else if (salePrice >= 8000000 && salePrice < 15000000) {
        defaultRange = '8m_15m';
      } else if (salePrice >= 15000000 && salePrice < 20000000) {
        defaultRange = '15m_20m';
      } else if (salePrice >= 20000000 && salePrice < 50000000) {
        defaultRange = '20m_50m';
      } else if (salePrice >= 50000000) {
        defaultRange = 'above_50m';
      }
      
      if (defaultRange) {
        for (var i = 0; i < select.options.length; i++) {
          if (select.options[i].value === defaultRange) {
            select.selectedIndex = i;
            break;
          }
        }
      }
    }
    
    calculateValue();
  }
  
  document.addEventListener('DOMContentLoaded', function() { 
    updateBudgetOptions();
    setDefaultBudgetRange();
    document.getElementById('budgetRange').addEventListener('change', calculateValue);
  });

  async function submitVerify() {
    const district = document.getElementById('district').value;
    const type = document.getElementById('type').value;
    const budgetRange = document.getElementById('budgetRange').value;
    const value = calculateValue();
    const agentName = getAgentName();
    const messageDiv = document.getElementById('message');
    const submitBtn = event.target;
    const form = document.getElementById('verifyForm');
    const headerSubtitle = document.getElementById('headerSubtitle');
    const infoSection = document.querySelector('.info-section');
    
    submitBtn.disabled = true;
    submitBtn.textContent = '处理中...';
    
    if (headerSubtitle) headerSubtitle.style.display = 'none';
    if (infoSection) infoSection.style.display = 'none';

    try {
      const response = await fetch('/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: leadId,
          district: district,
          transaction_type: type,
          budget_range: budgetRange,
          value: value,
          verified_by: agentName,
          is_recovery: isRecoveryMode
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        if (form) form.style.display = 'none';
        messageDiv.className = 'message success';
        messageDiv.style.display = 'block';
        messageDiv.innerHTML = '<strong>✅ 确认成功！</strong><br>价值已记录。<br>请手动关闭此页面。';
        
        window.history.replaceState(null, '', window.location.pathname + '?id=' + leadId + '&processed=1');
      } else {
        throw new Error(result.error || '操作失败');
      }
    } catch (error) {
      messageDiv.className = 'message error';
      messageDiv.style.display = 'block';
      messageDiv.innerText = '操作失败：' + error.message;
      submitBtn.disabled = false;
      submitBtn.textContent = '✅ 验证';
      if (headerSubtitle) headerSubtitle.style.display = 'block';
      if (infoSection) infoSection.style.display = 'block';
    }
  }

  window.updateBudgetOptions = updateBudgetOptions;
  window.calculateValue = calculateValue;
  window.submitVerify = submitVerify;
</script>
</body>
</html>`;
  
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleVerifyAction(request, env) {
  try {
    const { id, district, transaction_type, budget_range, value, verified_by, is_recovery } = await request.json();
    
    if (!id) {
      return new Response(JSON.stringify({ error: '参数错误' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const now = new Date().toISOString();
    const verifiedBy = verified_by || 'system';
    
    let finalValue = value;
    let finalTransactionType = transaction_type;
    
    if (value === 0 || value === 1) {
      finalTransactionType = 'rent';
    }
    
    if (is_recovery) {
      finalValue = value;
      finalTransactionType = 'rent';
    }
    
    let status;
    if (finalValue === 0) {
      status = 'rejected';
    } else if (finalValue === 1) {
      status = 'noshow';
    } else {
      status = 'verified';
    }
    
    const result = await env.lead_db.prepare(`
      UPDATE leads 
      SET status = ?, verified_at = ?, verified_by = ?,
          district = ?, transaction_type = ?, budget_range = ?, value = ?
      WHERE id = ?
    `).bind(status, now, verifiedBy, district, finalTransactionType, budget_range, finalValue, id).run();
    
    if (result.meta.rows_written === 0) {
      return new Response(JSON.stringify({ error: '线索不存在' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Verify action error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
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
          
          console.log(`📋 Admin IDs found: [${adminDingtalkIds.join(', ')}]`);
          console.log(`📋 Admin count: ${adminDingtalkIds.length}`);
          
          if (adminDingtalkIds.length > 0) {
            // 🔥 BATCH SEND - Log the request
            console.log(`📤 Sending batch to: ${adminDingtalkIds.join('|')}`);
            
            const sendResult = await sendDingTalkMessage(accessToken, parseInt(DINGTALK_AGENT_ID), adminDingtalkIds, '📋 线索副本', adminMessageText, env);
            
            // 🔥 Log the FULL response
            console.log(`📊 Full admin send response: ${JSON.stringify(sendResult)}`);
            
            if (sendResult && sendResult.errcode === 0) {
              adminSentCount = adminDingtalkIds.length;
              console.log(`✅ Message sent to ${adminSentCount} admin(s) (1 API call)`);
            } else if (sendResult) {
              console.error(`❌ Admin batch send FAILED:`);
              console.error(`   errcode: ${sendResult.errcode}`);
              console.error(`   errmsg: ${sendResult.errmsg}`);
              console.error(`   Full response: ${JSON.stringify(sendResult)}`);
              
              // 🔥 FALLBACK: Try sending individually to identify the problem
              console.log(`🔄 Attempting individual sends...`);
              for (const adminId of adminDingtalkIds) {
                try {
                  const singleResult = await sendDingTalkMessage(accessToken, parseInt(DINGTALK_AGENT_ID), [adminId], '📋 线索副本', adminMessageText, env);
                  if (singleResult && singleResult.errcode === 0) {
                    adminSentCount++;
                    console.log(`✅ Admin ${adminId} - SUCCESS`);
                  } else {
                    console.error(`❌ Admin ${adminId} - FAILED: ${singleResult ? singleResult.errmsg : 'Unknown'}`);
                  }
                } catch (e) {
                  console.error(`❌ Admin ${adminId} - ERROR:`, e.message);
                }
              }
              console.log(`📊 Individual send summary: ${adminSentCount}/${adminDingtalkIds.length} admins received`);
            }
          } else {
            console.log('📭 No admins found');
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