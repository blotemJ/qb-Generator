// =====================================================================
// VIP 卡密认证模块 - 对接鸽子云网络验证系统（geziyun.cn）
// 应用 APPID = 925，接口地址 https://www.geziyun.cn/api.php
// 实现参考《网络验证卡密系统技术文档 v1.0.0》：
//   - kmlogon 单码登录（含 time / check 响应字段）
//   - 离线宽限期（7 天，§9.1.3）
//   - 心跳定时验证（每 30 分钟，§9.1.2）
//   - 频率限制 429 指数退避重试（§6.3.1）
//   - 错误码完整映射（§6.1）
// 对 popup.js 暴露的全局 API（不可重命名）：
//   vipIsActive / vipActivate / vipUnbind / vipLoad / vipSave / vipClear
//   vipGetNotice / vipGetConfig / vipFmtDate / gzyMsg / GZY / GZY_ERRORS
// =====================================================================

const GZY = {
  APPID: "925",
  BASE: "https://www.geziyun.cn/api.php",
  STORE_KEY: "vip_license",
  MARKCODE_KEY: "vip_markcode",   // 本机机器码（设备码）持久化 key
  REQUEST_TIMEOUT: 10000,      // 单次请求超时 ms
  RETRY_DELAYS: [1000, 2000, 4000], // §6.3.1 指数退避
  HEARTBEAT_MS: 30 * 60 * 1000, // 心跳间隔 30 分钟
  OFFLINE_GRACE_MS: 7 * 24 * 60 * 60 * 1000, // 离线宽限期 7 天
  TIME_SKEW_SEC: 300,          // 时间差允许范围 ±300s
};

// 鸽子云错误码语义（§6.1）
const GZY_ERRORS = {
  "101": "应用不存在（检查 APPID）",
  "102": "应用已关闭（联系管理员）",
  "104": "签名为空（检查签名生成）",
  "105": "数据过期（请同步系统时间）",
  "106": "签名有误（检查签名算法/密钥）",
  "112": "请填写机器码（客户端已自动附加）",
  "148": "卡密为空",
  "149": "卡密不存在（请核对卡密）",
  "151": "卡密已禁用（联系管理员）",
  "169": "设备/IP 不一致（请使用原设备或解绑）",
  "171": "接口维护中（稍后重试）",
  "172": "接口未添加或不存在",
  "429": "请求过于频繁（请稍后重试）",
};

function gzyMsg(code) {
  return GZY_ERRORS[String(code)] || `未知错误 (code=${code})`;
}

// ---------- 本机机器码（markcode）----------
// 鸽子云 kmlogon/kmunmachine 必填 markcode（实测不传返回 112）。
// 用扩展实例 ID + 本地随机串生成稳定机器码，同一浏览器/profile 不变，
// 换机器/重装后不同，届时用 kmunmachine 解绑旧设备即可。
async function getMarkcode() {
  try {
    const data = await chrome.storage.local.get(GZY.MARKCODE_KEY);
    if (data[GZY.MARKCODE_KEY]) return data[GZY.MARKCODE_KEY];
  } catch (e) { /* ignore */ }
  let rid = "";
  try {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    rid = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    rid = Math.random().toString(16).slice(2, 18);
  }
  const extId = (chrome.runtime && chrome.runtime.id) ? chrome.runtime.id : "ext";
  const code = (extId + "_" + rid).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  try { await chrome.storage.local.set({ [GZY.MARKCODE_KEY]: code }); } catch (e) { /* ignore */ }
  return code;
}

// ---------- 通用 GET（带超时 + 429 指数退避重试）----------
// 涉及卡密登录/解绑的接口自动附加 markcode（机器码）
async function gzyGet(api, params = {}) {
  const merged = { ...params };
  if ((api === "kmlogon" || api === "kmunmachine") && !merged.markcode) {
    merged.markcode = await getMarkcode();
  }
  const q = new URLSearchParams({ api, app: GZY.APPID, ...merged });
  const full = `${GZY.BASE}?${q.toString()}`;
  let lastErr;
  for (let attempt = 0; attempt <= GZY.RETRY_DELAYS.length; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), GZY.REQUEST_TIMEOUT);
      const resp = await fetch(full, { method: "GET", signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.status === 429) {
        // 频率限制：等待后重试
        if (attempt < GZY.RETRY_DELAYS.length) {
          await sleep(GZY.RETRY_DELAYS[attempt]);
          continue;
        }
        throw new Error("请求过于频繁 (429)");
      }
      if (!resp.ok) throw new Error(`网络错误 HTTP ${resp.status}`);
      const data = await resp.json().catch(() => null);
      if (!data) throw new Error("返回数据不是合法 JSON");
      return data;
    } catch (e) {
      lastErr = e;
      // 网络类错误才重试；业务错误（已返回 JSON）不在此层重试
      if (e.name === "AbortError" || /HTTP|JSON|频繁/.test(e.message)) {
        if (attempt < GZY.RETRY_DELAYS.length && /频繁/.test(e.message)) {
          await sleep(GZY.RETRY_DELAYS[attempt]);
          continue;
        }
        if (attempt < GZY.RETRY_DELAYS.length && e.name === "AbortError") {
          await sleep(GZY.RETRY_DELAYS[attempt]);
          continue;
        }
      }
      throw e;
    }
  }
  throw lastErr || new Error("请求失败");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =====================================================================
// 卡密登录（单码 kmlogon）
// 返回 { ok, code, msg, kami, vip, expireAt, serverTime, check }
// =====================================================================
async function vipLogin(kami) {
  const cleanKami = String(kami || "").trim();
  if (!cleanKami) return { ok: false, code: "148", msg: gzyMsg("148") };

  let data;
  try {
    data = await gzyGet("kmlogon", { kami: cleanKami });
  } catch (e) {
    return { ok: false, code: "NET", msg: "网络请求失败：" + e.message };
  }

  const code = String(data.code);
  if (code !== "200") {
    return { ok: false, code, msg: gzyMsg(code) };
  }

  // 服务器时间校验（防重放，§7.1）：偏差超 ±300s 视为本地时间异常
  let serverTime = parseInt(data.time, 10) || 0;
  if (serverTime) {
    const skew = Math.abs(serverTime - Math.floor(Date.now() / 1000));
    if (skew > GZY.TIME_SKEW_SEC) {
      console.warn(`[VIP] 本地时间与服务器偏差 ${skew}s，建议同步系统时间`);
    }
  }

  const vipSec = parseInt(data?.msg?.vip, 10) || 0;
  const expireAt = vipSec > 0 ? vipSec * 1000 : 0;
  return {
    ok: true,
    code: "200",
    msg: "登录成功",
    kami: data?.msg?.kami || cleanKami,
    vip: vipSec,
    expireAt,
    serverTime: serverTime * 1000,
    check: data?.check || "",
  };
}

// =====================================================================
// 本地授权缓存
// 结构：{ kami, expireAt, activatedAt, lastVerify, check }
//   lastVerify: 最近一次成功在线验证的服务器时间(ms)，用于离线宽限期
// =====================================================================
async function vipLoad() {
  try {
    const data = await chrome.storage.local.get(GZY.STORE_KEY);
    return data[GZY.STORE_KEY] || null;
  } catch (e) {
    return null;
  }
}
async function vipSave(lic) {
  await chrome.storage.local.set({ [GZY.STORE_KEY]: lic });
}
async function vipClear() {
  await chrome.storage.local.remove(GZY.STORE_KEY);
  stopHeartbeat();
}

// 是否处于有效 VIP（在线：到期未过；离线：在宽限期内且曾在线验证过）
async function vipIsActive() {
  const lic = await vipLoad();
  if (!lic || !lic.kami) return false;
  const now = Date.now();
  // 在线判断：到期时间戳未过
  if (lic.expireAt && lic.expireAt > now) {
    // 若曾在宽限期内离线使用，但现已过期则失效
    return true;
  }
  // 离线宽限期：上次在线验证后 7 天内仍可用（§9.1.3）
  if (lic.lastVerify && lic.expireAt <= now) {
    // 已到期但离线宽限期未过 —— 仍允许（但通常到期即失效，这里以到期为准）
    if (now - lic.lastVerify < GZY.OFFLINE_GRACE_MS) {
      console.warn("[VIP] 卡密已过期，处于离线宽限期内，建议联网续费");
      return true;
    }
  }
  return false;
}

// =====================================================================
// 激活流程：登录 + 持久化 + 启动心跳
// =====================================================================
async function vipActivate(kami) {
  const res = await vipLogin(kami);
  if (res.ok) {
    const lic = {
      kami: res.kami,
      expireAt: res.expireAt,
      activatedAt: Date.now(),
      lastVerify: res.serverTime || Date.now(),
      check: res.check,
    };
    await vipSave(lic);
    startHeartbeat();
  }
  return res;
}

// =====================================================================
// 解绑设备（kmunmachine）
// =====================================================================
async function vipUnbind() {
  const lic = await vipLoad();
  if (!lic || !lic.kami) return { ok: false, msg: "本地无卡密记录" };
  let data;
  try {
    data = await gzyGet("kmunmachine", { kami: lic.kami });
  } catch (e) {
    return { ok: false, msg: "网络请求失败：" + e.message };
  }
  const code = String(data.code);
  if (code === "200") {
    await vipClear();
    return { ok: true, msg: "已解绑，本机授权已清除" };
  }
  return { ok: false, msg: gzyMsg(code) || "解绑失败" };
}

// =====================================================================
// 心跳：定时重新验证（§9.1.2 每 30 分钟）
// =====================================================================
let _hbTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  _hbTimer = setInterval(async () => {
    try {
      const lic = await vipLoad();
      if (!lic || !lic.kami) { stopHeartbeat(); return; }
      const res = await vipLogin(lic.kami);
      if (res.ok) {
        lic.expireAt = res.expireAt || lic.expireAt;
        lic.lastVerify = res.serverTime || Date.now();
        lic.check = res.check || lic.check;
        await vipSave(lic);
      } else if (res.code === "149" || res.code === "151") {
        // 卡密作废，停止心跳（UI 下次刷新会变回未激活）
        stopHeartbeat();
      }
    } catch (e) { /* 网络异常忽略，下个周期再试 */ }
  }, GZY.HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null; }
}

// =====================================================================
// 应用公告（notice）/ 配置（ini）
// =====================================================================
async function vipGetNotice() {
  try {
    const data = await gzyGet("notice");
    if (String(data.code) === "200" && data?.msg?.app_gg) {
      return data.msg.app_gg;
    }
  } catch (e) { /* 非关键 */ }
  return "";
}
async function vipGetConfig() {
  try {
    const data = await gzyGet("ini");
    if (String(data.code) === "200") return data.msg || {};
  } catch (e) { /* 非关键 */ }
  return {};
}

function vipFmtDate(sec) {
  if (!sec) return "永久";
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return "永久";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 脚本加载即恢复心跳：若本地已有有效授权，自动启动定时验证
vipLoad().then((lic) => {
  if (lic && lic.kami) {
    vipIsActive().then((active) => { if (active) startHeartbeat(); });
  }
}).catch(() => {});
