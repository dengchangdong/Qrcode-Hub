let KV_BINDING;
let DB;
const banPath = [
  'login', 'dash', '__total_count',
  // static files
  'dash.html', 'login.html',
  'daisyui@5.css', 'tailwindcss@4.js',
  'qr-code-styling.js', 'zxing.js',
  'robots.txt', 'wechat.svg',
  'favicon.svg',
];

// 数据库初始化
async function initDatabase() {
  // 创建表
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS mappings (
      path TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      name TEXT,
      expiry TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // 创建 API tokens 表
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      enabled INTEGER DEFAULT 1
    )
  `).run();

  // 检查是否需要添加新列
  const tableInfo = await DB.prepare("PRAGMA table_info(mappings)").all();
  const columns = tableInfo.results.map(col => col.name);

  // 添加 isWechat 列（如果不存在）
  if (!columns.includes('isWechat')) {
    await DB.prepare(`
      ALTER TABLE mappings 
      ADD COLUMN isWechat INTEGER DEFAULT 0
    `).run();
  }

  // 添加 qrCodeData 列（如果不存在）
  if (!columns.includes('qrCodeData')) {
    await DB.prepare(`
      ALTER TABLE mappings 
      ADD COLUMN qrCodeData TEXT
    `).run();
  }

  // 添加索引
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_expiry ON mappings(expiry)
  `).run();

  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_created_at ON mappings(created_at)
  `).run();

  // 组合索引：用于启用状态和过期时间的组合查询
  await DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_enabled_expiry ON mappings(enabled, expiry)
  `).run();
}

// Cookie 相关函数
function verifyAuthCookie(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const authToken = cookie.split(';').find(c => c.trim().startsWith('token='));
  if (!authToken) return false;
  return authToken.split('=')[1].trim() === env.PASSWORD;
}

function setAuthCookie(password) {
  return {
    'Set-Cookie': `token=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
    'Content-Type': 'application/json'
  };
}

function clearAuthCookie() {
  return {
    'Set-Cookie': 'token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    'Content-Type': 'application/json'
  };
}

// 数据库操作相关函数
async function listMappings(page = 1, pageSize = 10) {
  const offset = (page - 1) * pageSize;
  
  // 使用单个查询获取分页数据和总数
  const results = await DB.prepare(`
    WITH filtered_mappings AS (
      SELECT * FROM mappings 
      WHERE path NOT IN (${banPath.map(() => '?').join(',')})
    )
    SELECT 
      filtered.*,
      (SELECT COUNT(*) FROM filtered_mappings) as total_count
    FROM filtered_mappings as filtered
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...banPath, pageSize, offset).all();

  if (!results.results || results.results.length === 0) {
    return {
      mappings: {},
      total: 0,
      page,
      pageSize,
      totalPages: 0
    };
  }

  const total = results.results[0].total_count;
  const mappings = {};

  for (const row of results.results) {
    mappings[row.path] = {
      target: row.target,
      name: row.name,
      expiry: row.expiry,
      enabled: row.enabled === 1,
      isWechat: row.isWechat === 1,
      qrCodeData: row.qrCodeData
    };
  }

  return {
    mappings,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize)
  };
}

async function createMapping(path, target, name, expiry, enabled = true, isWechat = false, qrCodeData = null) {
  if (!path || !target || typeof path !== 'string' || typeof target !== 'string') {
    throw new Error('Invalid input');
  }

  // 如果path为空，自动生成6位随机字符串
  if (path === '') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    path = result;
  }

  // 检查短链名是否在禁用列表中
  if (banPath.includes(path)) {
    throw new Error('该短链名已被系统保留，请使用其他名称');
  }

  if (expiry && isNaN(Date.parse(expiry))) {
    throw new Error('Invalid expiry date');
  }

  // 如果是微信二维码，必须提供二维码数据
  if (isWechat && !qrCodeData) {
    throw new Error('微信二维码必须提供原始二维码数据');
  }

  await DB.prepare(`
    INSERT INTO mappings (path, target, name, expiry, enabled, isWechat, qrCodeData)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    path,
    target,
    name || null,
    expiry || null,
    enabled ? 1 : 0,
    isWechat ? 1 : 0,
    qrCodeData
  ).run();
}

async function deleteMapping(path) {
  if (!path || typeof path !== 'string') {
    throw new Error('Invalid input');
  }

  // 检查是否在禁用列表中
  if (banPath.includes(path)) {
    throw new Error('系统保留的短链名无法删除');
  }

  await DB.prepare('DELETE FROM mappings WHERE path = ?').bind(path).run();
}

async function updateMapping(originalPath, newPath, target, name, expiry, enabled = true, isWechat = false, qrCodeData = null) {
  if (!originalPath || !newPath || !target) {
    throw new Error('Invalid input');
  }

  // 检查新短链名是否在禁用列表中
  if (banPath.includes(newPath)) {
    throw new Error('该短链名已被系统保留，请使用其他名称');
  }

  if (expiry && isNaN(Date.parse(expiry))) {
    throw new Error('Invalid expiry date');
  }

  // 如果没有提供新的二维码数据，获取原有的二维码数据
  if (!qrCodeData && isWechat) {
    const existingMapping = await DB.prepare(`
      SELECT qrCodeData
      FROM mappings
      WHERE path = ?
    `).bind(originalPath).first();

    if (existingMapping) {
      qrCodeData = existingMapping.qrCodeData;
    }
  }

  // 如果是微信二维码，必须有二维码数据
  if (isWechat && !qrCodeData) {
    throw new Error('微信二维码必须提供原始二维码数据');
  }

  const stmt = DB.prepare(`
    UPDATE mappings 
    SET path = ?, target = ?, name = ?, expiry = ?, enabled = ?, isWechat = ?, qrCodeData = ?
    WHERE path = ?
  `);

  await stmt.bind(
    newPath,
    target,
    name || null,
    expiry || null,
    enabled ? 1 : 0,
    isWechat ? 1 : 0,
    qrCodeData,
    originalPath
  ).run();
}

async function getExpiringMappings() {
  // 获取今天的日期（设置为今天的23:59:59）
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const now = today.toISOString();
  
  // 获取今天的开始时间（00:00:00）
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dayStart = todayStart.toISOString();
  
  // 修改为3天后的23:59:59
  const threeDaysFromNow = new Date(todayStart);
  threeDaysFromNow.setDate(todayStart.getDate() + 3);
  threeDaysFromNow.setHours(23, 59, 59, 999);
  const threeDaysLater = threeDaysFromNow.toISOString();

  // 使用单个查询获取所有过期和即将过期的映射
  const results = await DB.prepare(`
    WITH categorized_mappings AS (
      SELECT 
        path, name, target, expiry, enabled, isWechat, qrCodeData,
        CASE 
          WHEN datetime(expiry) < datetime(?) THEN 'expired'
          WHEN datetime(expiry) <= datetime(?) THEN 'expiring'
        END as status
      FROM mappings 
      WHERE expiry IS NOT NULL 
        AND datetime(expiry) <= datetime(?) 
        AND enabled = 1
    )
    SELECT * FROM categorized_mappings
    ORDER BY expiry ASC
  `).bind(dayStart, threeDaysLater, threeDaysLater).all();

  const mappings = {
    expiring: [],
    expired: []
  };
  
  for (const row of results.results) {
    const mapping = {
      path: row.path,
      name: row.name,
      target: row.target,
      expiry: row.expiry,
      enabled: row.enabled === 1,
      isWechat: row.isWechat === 1,
      qrCodeData: row.qrCodeData
    };

    if (row.status === 'expired') {
      mappings.expired.push(mapping);
    } else {
      mappings.expiring.push(mapping);
    }
  }

  return mappings;
}

// 添加新的批量清理过期映射的函数
async function cleanupExpiredMappings(batchSize = 100) {
  const now = new Date().toISOString();
  
  while (true) {
    // 获取一批过期的映射
    const batch = await DB.prepare(`
      SELECT path 
      FROM mappings 
      WHERE expiry IS NOT NULL 
        AND expiry < ? 
      LIMIT ?
    `).bind(now, batchSize).all();

    if (!batch.results || batch.results.length === 0) {
      break;
    }

    // 批量删除这些映射
    const paths = batch.results.map(row => row.path);
    const placeholders = paths.map(() => '?').join(',');
    await DB.prepare(`
      DELETE FROM mappings 
      WHERE path IN (${placeholders})
    `).bind(...paths).run();

    // 如果获取的数量小于 batchSize，说明已经处理完所有过期映射
    if (batch.results.length < batchSize) {
      break;
    }
  }
}

// 数据迁移函数
async function migrateFromKV() {
  let cursor = null;
  do {
    const listResult = await KV_BINDING.list({ cursor, limit: 1000 });
    
    for (const key of listResult.keys) {
      if (!banPath.includes(key.name)) {
        const value = await KV_BINDING.get(key.name, { type: "json" });
        if (value) {
          try {
            await createMapping(
              key.name,
              value.target,
              value.name,
              value.expiry,
              value.enabled,
              value.isWechat,
              value.qrCodeData
            );
          } catch (e) {
            console.error(`Failed to migrate ${key.name}:`, e);
          }
        }
      }
    }
    
    cursor = listResult.cursor;
  } while (cursor);
}

// API Token 相关函数
async function createApiToken(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid token name');
  }
  
  const token = crypto.randomUUID();
  await DB.prepare(`
    INSERT INTO api_tokens (token, name)
    VALUES (?, ?)
  `).bind(token, name).run();
  
  return token;
}

async function listApiTokens() {
  const results = await DB.prepare(`
    SELECT token, name, created_at, last_used_at, enabled
    FROM api_tokens
    ORDER BY created_at DESC
  `).all();
  
  return results.results || [];
}

async function deleteApiToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid token');
  }
  
  await DB.prepare('DELETE FROM api_tokens WHERE token = ?').bind(token).run();
}

async function updateApiTokenStatus(token, enabled) {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid token');
  }
  
  await DB.prepare(`
    UPDATE api_tokens 
    SET enabled = ?, last_used_at = CURRENT_TIMESTAMP
    WHERE token = ?
  `).bind(enabled ? 1 : 0, token).run();
}

async function verifyApiToken(token) {
  if (!token) return false;
  
  const result = await DB.prepare(`
    SELECT enabled 
    FROM api_tokens 
    WHERE token = ?
  `).bind(token).first();
  
  if (!result) return false;
  
  // 更新最后使用时间
  await DB.prepare(`
    UPDATE api_tokens 
    SET last_used_at = CURRENT_TIMESTAMP
    WHERE token = ?
  `).bind(token).run();
  
  return result.enabled === 1;
}

export default {
  async fetch(request, env) {
    // 初始化数据库
    DB = env.DB;
    KV_BINDING = env.KV_BINDING;
    await initDatabase();

    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    // API 路由处理
    if (path.startsWith('api/')) {
      // 验证 API token
      const apiToken = request.headers.get('X-API-Token');
      if (!apiToken || !(await verifyApiToken(apiToken))) {
        return new Response(JSON.stringify({ error: 'Invalid or missing API token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // API 路由
      if (path === 'api/mappings' && request.method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '10');
        const result = await listMappings(page, pageSize);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path === 'api/mappings' && request.method === 'POST') {
        const data = await request.json();
        try {
          await createMapping(
            data.path || '',
            data.target,
            data.name,
            data.expiry,
            data.enabled !== false,
            data.isWechat || false,
            data.qrCodeData
          );
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (path.startsWith('api/mappings/') && request.method === 'PUT') {
        const originalPath = path.split('/')[2];
        const data = await request.json();
        try {
          await updateMapping(
            originalPath,
            data.path || originalPath,
            data.target,
            data.name,
            data.expiry,
            data.enabled !== false,
            data.isWechat || false,
            data.qrCodeData
          );
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (path.startsWith('api/mappings/') && request.method === 'DELETE') {
        const shortPath = path.split('/')[2];
        try {
          await deleteMapping(shortPath);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // API Token 管理路由
      if (path === 'api/tokens' && request.method === 'GET') {
        const tokens = await listApiTokens();
        return new Response(JSON.stringify(tokens), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path === 'api/tokens' && request.method === 'POST') {
        const data = await request.json();
        try {
          const token = await createApiToken(data.name);
          return new Response(JSON.stringify({ token }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (path.startsWith('api/tokens/') && request.method === 'DELETE') {
        const token = path.split('/')[2];
        try {
          await deleteApiToken(token);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      if (path.startsWith('api/tokens/') && request.method === 'PUT') {
        const token = path.split('/')[2];
        const data = await request.json();
        try {
          await updateApiTokenStatus(token, data.enabled);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 根目录跳转到 管理后台
    if (path === '') {
      return Response.redirect(url.origin + '/dash.html', 302);
    }

    // URL 重定向处理
    if (path) {
      try {
        const mapping = await DB.prepare(`
          SELECT path, target, name, expiry, enabled, isWechat, qrCodeData
          FROM mappings
          WHERE path = ?
        `).bind(path).first();
        if (mapping) {
          // 检查是否启用
          if (!mapping.enabled) {
            return new Response('Not Found', { status: 404 });
          }

          // 检查是否过期 - 使用当天23:59:59作为失效判断时间
          if (mapping.expiry) {
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (new Date(mapping.expiry) < today) {
              const expiredHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>链接已过期</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            padding: 16px;
            min-height: 100vh;
            display: flex;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f7f7f7;
            box-sizing: border-box;
        }
        .container {
            margin: auto;
            padding: 24px 16px;
            width: calc(100% - 32px);
            max-width: 320px;
            text-align: center;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .title {
            font-size: 22px;
            font-weight: 600;
            margin: 0 0 16px;
            color: #333;
        }
        .message {
            font-size: 16px;
            color: #666;
            margin: 16px 0;
            line-height: 1.5;
        }
        .info {
            font-size: 14px;
            color: #999;
            margin-top: 20px;
        }
        @media (prefers-color-scheme: dark) {
            body {
                background: #1a1a1a;
            }
            .container {
                background: #2a2a2a;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .title {
                color: #e0e0e0;
            }
            .message {
                color: #aaa;
            }
            .info {
                color: #777;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="title">${mapping.name ? mapping.name + ' 已过期' : '链接已过期'}</h1>
        <p class="info">过期时间：${new Date(mapping.expiry).toLocaleDateString()}</p>
        <p class="info">如需访问，请联系管理员更新链接</p>
    </div>
</body>
</html>`;
              return new Response(expiredHtml, {
                status: 404,
                headers: {
                  'Content-Type': 'text/html;charset=UTF-8',
                  'Cache-Control': 'no-store'
                }
              });
            }
          }

          // 如果是微信二维码，返回活码页面
          if (mapping.isWechat === 1 && mapping.qrCodeData) {
            const wechatHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${mapping.name || '微信群二维码'}</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        body {
            margin: 0;
            padding: 16px;
            min-height: 100vh;
            display: flex;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f7f7f7;
            box-sizing: border-box;
        }
        .container {
            margin: auto;
            padding: 24px 16px;
            width: calc(100% - 32px);
            max-width: 320px;
            text-align: center;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }
        .wechat-icon {
            width: 32px;
            height: 32px;
            margin-bottom: 12px;
        }
        .title {
            font-size: 22px;
            font-weight: 600;
            margin: 0 0 8px;
            color: #333;
        }
        .qr-code {
            width: 100%;
            max-width: 240px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .notice {
            font-size: 16px;
            color: #666;
            margin: 16px 0 0;
            line-height: 1.5;
        }
        .footer {
            font-size: 14px;
            color: #999;
            margin-top: 20px;
        }

        @media (prefers-color-scheme: dark) {
            body {
                background: #1a1a1a;
            }
            .container {
                background: #2a2a2a;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            }
            .title {
                color: #e0e0e0;
            }
            .notice {
                color: #aaa;
            }
            .footer {
                color: #777;
            }
            .qr-code {
                background: white;
                padding: 8px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <img class="wechat-icon" src="wechat.svg" alt="WeChat">
        <h1 class="title">${mapping.name ? mapping.name : '微信二维码'}</h1>
        <p class="notice">请长按识别下方二维码</p>
        <img class="qr-code" src="${mapping.qrCodeData}" alt="微信群二维码">
        <p class="footer">二维码失效请联系作者更新</p>
    </div>
</body>
</html>`;
            return new Response(wechatHtml, {
              headers: {
                'Content-Type': 'text/html;charset=UTF-8',
                'Cache-Control': 'no-store'
              }
            });
          }

          // 如果不是微信二维码，执行普通重定向
          return Response.redirect(mapping.target, 302);
        }
        return new Response('Not Found', { status: 404 });
      } catch (error) {
        console.error('Redirect error:', error);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
  },

  async scheduled(controller, env, ctx) {
    KV_BINDING = env.KV_BINDING;
    DB = env.DB;
    
    // 初始化数据库
    await initDatabase();
        
    // 获取过期和即将过期的映射报告
    const result = await getExpiringMappings();

    console.log(`Cron job report: Found ${result.expired.length} expired mappings`);
    if (result.expired.length > 0) {
      console.log('Expired mappings:', JSON.stringify(result.expired, null, 2));
    }

    console.log(`Found ${result.expiring.length} mappings expiring in 2 days`);
    if (result.expiring.length > 0) {
      console.log('Expiring soon mappings:', JSON.stringify(result.expiring, null, 2));
    }
  },

};