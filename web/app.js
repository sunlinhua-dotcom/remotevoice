// RemoteVoice 手机端（PWA）
// 配对 + 按住说话（PTT）+ 实时把 PCM 推到中继。

const $ = (id) => document.getElementById(id);

// 默认中继地址（开发用同源 /ws；部署时可在设置里改）
let relayUrl = localStorage.getItem("rv.relay") || (() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
})();

let ws = null;
let paired = false;

// 音频
let audioCtx = null;
let micStream = null;
let workletNode = null;
let recording = false;

// 音量电平
let analyser = null;
let levelRAF = 0;

// ---------- DOM ----------
const elConn = $("connState"), elPeer = $("peerState");
const elPairPanel = $("pairPanel"), elTalkPanel = $("talkPanel");
const elScanBtn = $("scanBtn"), elPairMsg = $("pairMsg");
const elScanBox = $("scanBox"), elScanVideo = $("scanVideo"), elScanCancel = $("scanCancel");

// ---------- 配对凭证（设备信任）----------
// 扫码得到的一次性令牌(URL ?m=&p=)，或本地记住的长期 device_token。
const _params = new URLSearchParams(location.search);
let pairMacId = _params.get("m");
let pairToken = _params.get("p");
let savedMacId = localStorage.getItem("rv.macId");
let savedDeviceToken = localStorage.getItem("rv.deviceToken");

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android 手机";
  if (/Macintosh/.test(ua)) return "Mac 浏览器";
  return "手机";
}
function clearCreds() {
  savedMacId = null; savedDeviceToken = null;
  localStorage.removeItem("rv.macId");
  localStorage.removeItem("rv.deviceToken");
}
const elTalkBtn = $("talkBtn"), elPartial = $("partial"), elFinal = $("final");
const elTalkLabel = $("talkLabel"), elTalkStage = document.querySelector(".talk-stage");
const elLlmFlag = $("llmFlag"), elMeter = $("levelMeter"), elMeterBar = elMeter.querySelector("i");
const elSettingsBtn = $("settingsBtn"), elSettingsPanel = $("settingsPanel"), elSettingsClose = $("settingsClose");
const elRelayInput = $("relayInput"), elLlmSwitch = $("llmSwitch");

init();

function init() {
  elRelayInput.value = relayUrl;
  elScanBtn.onclick = startScan;
  elScanCancel.onclick = stopScan;
  // iOS Safari 没有 BarcodeDetector，内置扫码用不了：藏掉按钮，改成引导用系统相机。
  if (!("BarcodeDetector" in window)) {
    elScanBtn.classList.add("hidden");
    elPairMsg.textContent = "用 iPhone 自带「相机」App 对准 Mac 上的二维码即可配对（本页无需操作）。";
  }

  // PTT：pointerdown/up（兼容鼠标+触摸）。
  // 不绑 pointerleave：录音中手指轻微移出按钮不应误判松手；改用 setPointerCapture 锁定指针。
  elTalkBtn.addEventListener("pointerdown", onTalkDown);
  elTalkBtn.addEventListener("pointerup", onTalkUp);
  elTalkBtn.addEventListener("pointercancel", onTalkUp);
  // 阻止移动端长按选中菜单
  elTalkBtn.addEventListener("contextmenu", (e) => e.preventDefault());

  elSettingsBtn.onclick = () => { elSettingsPanel.classList.remove("hidden"); };
  elSettingsClose.onclick = () => {
    const next = elRelayInput.value.trim();
    if (next && next !== relayUrl) {
      relayUrl = next;
      localStorage.setItem("rv.relay", relayUrl);
      // 主动换服务器：先摘掉旧 socket 的 onclose，避免它再调度一次重连。
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      paired = false;
      showPair();
    }
    elSettingsPanel.classList.add("hidden");
  };
  elLlmSwitch.onchange = () => {
    send({ type: "config", llm_postprocess: elLlmSwitch.checked });
  };
}

// ---------- 连接 ----------
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return; // 始终只保留一个待执行的重连，避免并发 socket 风暴
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
}

function connect() {
  // 幂等：已有正在连接/已连接的 socket 时不再新开一条。
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return Promise.resolve(ws);
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  setConn("连接中…", "off");
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(relayUrl);
    sock.binaryType = "arraybuffer";
    ws = sock;
    let settled = false;
    sock.onopen = () => { setConn("已连接", "on"); settled = true; resolve(sock); tryAutoPair(); };
    sock.onclose = () => {
      setConn("未连接", "off");
      if (paired) showPair();
      if (ws === sock) ws = null;       // 仅当它仍是当前活动 socket 才清空
      if (!settled) { settled = true; reject(new Error("ws closed")); } // 解除 await connect() 挂起
      scheduleReconnect();
    };
    sock.onerror = () => { if (!settled) { settled = true; reject(new Error("ws error")); } };
    sock.onmessage = onMessage;
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  switch (msg.type) {
    case "assign": // 给 mac 的，phone 忽略
      break;
    case "paired":
      if (msg.peer === "mac") {
        // 首次扫码配对：服务端下发长期 device_token，存本地，以后免扫码自动连。
        if (msg.device_token) {
          savedDeviceToken = msg.device_token;
          savedMacId = msg.mac_id || pairMacId;
          localStorage.setItem("rv.deviceToken", savedDeviceToken);
          localStorage.setItem("rv.macId", savedMacId);
          // 清掉 URL 里的一次性令牌，避免刷新重复使用。
          try { history.replaceState(null, "", location.pathname); } catch {}
          pairToken = null; pairMacId = savedMacId;
        }
        paired = true; elPairMsg.textContent = ""; showTalk();
      }
      break;
    case "peer_gone":
      // Mac 暂时离线，但本机仍是受信设备：保持已配对，等 Mac 回来自动续上。
      elPeer.textContent = "等待 Mac"; elPeer.className = "badge badge-muted";
      break;
    case "unpaired":
      paired = false; clearCreds(); showPair();
      elPairMsg.textContent = "已被移除授权，请重新扫码配对";
      break;
    case "config":
      elLlmSwitch.checked = !!msg.llm_postprocess;
      updateLlmFlag();
      break;
    case "status":
      if (msg.peer === "mac") { elPeer.textContent = "Mac 已就绪"; elPeer.className = "badge badge-on"; }
      break;
    case "partial":
      elPartial.textContent = msg.text || "";
      break;
    case "final":
      elFinal.textContent = msg.text || "";
      elPartial.textContent = "";
      break;
    case "error":
      if (msg.code === "untrusted") {
        // 本地存的设备凭证失效（被吊销/换了 Mac）→ 清掉，回到扫码。
        paired = false; clearCreds(); showPair();
        elPairMsg.textContent = "需要重新扫码配对";
      } else if (msg.code === "bad_pair") {
        showPair();
        elPairMsg.textContent = "二维码已过期，请在 Mac 上重新生成";
      } else if (!paired) {
        elPairMsg.textContent = msg.message || "出错了";
      }
      break;
    case "asr_error":
      elPartial.textContent = "识别异常：" + (msg.message || "");
      break;
  }
}

function updateLlmFlag() {
  const on = elLlmSwitch.checked;
  elLlmFlag.textContent = "标点纠错：" + (on ? "开" : "关");
  elLlmFlag.className = "badge " + (on ? "badge-on" : "badge-muted");
}

// ---------- 配对（设备信任）----------
// 连接打开后自动调用：优先用刚扫到的一次性令牌；否则用本地记住的设备凭证；都没有就显示扫码界面。
function tryAutoPair() {
  if (pairMacId && pairToken) {
    elPairMsg.textContent = "正在配对…";
    send({ type: "hello", role: "phone", macId: pairMacId, pairToken, name: deviceName() });
  } else if (savedMacId && savedDeviceToken) {
    send({ type: "hello", role: "phone", macId: savedMacId, deviceToken: savedDeviceToken, name: deviceName() });
  } else if (!paired) {
    showPair();
  }
}

async function pairNow() {
  try { if (!ws || ws.readyState !== WebSocket.OPEN) await connect(); } catch { elPairMsg.textContent = "无法连接服务器"; return; }
  tryAutoPair();
}

// ---------- 内置扫一扫（系统相机扫 URL 是主路径；这是兜底）----------
let scanStream = null, scanRAF = 0, barcodeDetector = null;

async function startScan() {
  if (!("BarcodeDetector" in window)) {
    elPairMsg.textContent = "此浏览器不支持内置扫码。请直接用手机相机扫 Mac 上的二维码。";
    return;
  }
  try {
    barcodeDetector = barcodeDetector || new BarcodeDetector({ formats: ["qr_code"] });
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    elScanVideo.srcObject = scanStream;
    await elScanVideo.play();
    elScanBox.classList.remove("hidden");
    elPairMsg.textContent = "对准 Mac 上的二维码";
    scanLoop();
  } catch (e) {
    elPairMsg.textContent = "无法打开相机：" + (e.message || e);
    stopScan();
  }
}

async function scanLoop() {
  if (!scanStream) return;
  try {
    const codes = await barcodeDetector.detect(elScanVideo);
    const hit = codes.find((c) => c.rawValue && /[?&]m=/.test(c.rawValue) && /[?&]p=/.test(c.rawValue));
    if (hit) { onScanned(hit.rawValue); return; }
  } catch { /* 偶发检测异常，继续下一帧 */ }
  scanRAF = requestAnimationFrame(scanLoop);
}

function onScanned(raw) {
  stopScan();
  try {
    const u = new URL(raw);
    const m = u.searchParams.get("m"), p = u.searchParams.get("p");
    if (m && p) { pairMacId = m; pairToken = p; pairNow(); }
    else elPairMsg.textContent = "二维码无效";
  } catch { elPairMsg.textContent = "二维码无效"; }
}

function stopScan() {
  if (scanRAF) { cancelAnimationFrame(scanRAF); scanRAF = 0; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  elScanBox.classList.add("hidden");
}

function showPair() {
  elPairPanel.classList.remove("hidden");
  elTalkPanel.classList.add("hidden");
}
function showTalk() {
  elPairPanel.classList.add("hidden");
  elTalkPanel.classList.remove("hidden");
  elFinal.textContent = "";
  elPartial.textContent = "按住下方按钮说话";
}

function setConn(text, cls) {
  elConn.textContent = text;
  elConn.className = "badge " + (cls === "off" ? "badge-off" : cls === "on" ? "badge-on" : "badge-muted");
}

// ---------- PTT 录音 ----------
// 触感：安卓 Chrome 支持 navigator.vibrate；iOS Safari 无网页振动 API（系统限制），只能靠视觉/动效。
function haptic(pattern) { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} }

// 按住态的视觉切换（声呐脉冲 + 辉光 + 文案），与是否真正录音解耦——
// 这样"按下去到底按住没有"立刻有反馈，不必等麦克风权限/配对。
function setHolding(on) {
  elTalkBtn.classList.toggle("holding", on);
  elTalkStage && elTalkStage.classList.toggle("holding-stage", on);
  elTalkLabel.textContent = on ? "松开发送" : "按住说话";
  if (!on) elTalkBtn.style.setProperty("--level", 0);
}

async function onTalkDown(e) {
  if (recording) return;
  e.preventDefault();
  // 1) 立刻给反馈：陷入动效 + 振动（哪怕还没配对/没拿到麦克风）
  setHolding(true);
  haptic(18);
  try { if (e.pointerId != null) elTalkBtn.setPointerCapture(e.pointerId); } catch {}
  if (!paired) { elPartial.textContent = "请先扫码 / 输码配对"; return; }

  // 2) 真正起录音
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    await audioCtx.audioWorklet.addModule("/pcm-worker.js");
    workletNode = new AudioWorkletNode(audioCtx, "pcm-pump", {
      processorOptions: { targetRate: 16000 },
    });

    const src = audioCtx.createMediaStreamSource(micStream);
    src.connect(workletNode);
    // 不接 destination，避免回声

    // 音量电平
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    startMeter();

    workletNode.port.onmessage = (ev) => {
      // ev.data = Int16Array PCM(16k)
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(ev.data.buffer);
    };

    recording = true;
    elFinal.textContent = "";
    elPartial.textContent = "正在聆听…";
    send({ type: "start", format: { sampleRate: 16000, channels: 1, bits: 16 }, ts: Date.now() });
  } catch (err) {
    elPartial.textContent = "无法访问麦克风：" + err.message;
    setHolding(false);
    cleanupAudio();
  }
}

function onTalkUp(e) {
  try {
    if (e.pointerId != null && elTalkBtn.hasPointerCapture?.(e.pointerId)) {
      elTalkBtn.releasePointerCapture(e.pointerId);
    }
  } catch {}
  setHolding(false);
  if (!recording) return; // 未配对时按了一下：上面已复位，这里直接收
  e.preventDefault();
  recording = false;
  haptic(12);
  // 松手的"发送"反馈：绿色闪一下
  elTalkBtn.classList.add("sending");
  setTimeout(() => elTalkBtn.classList.remove("sending"), 320);
  send({ type: "end", ts: Date.now() });
  // 不立刻停音频节点：让尾部几帧 PCM 也发出去。延后一点清理。
  setTimeout(cleanupAudio, 250);
}

function cleanupAudio() {
  stopMeter();
  try { workletNode?.port.postMessage({ cmd: "stop" }); } catch {}
  try { workletNode?.disconnect(); } catch {}
  workletNode = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  analyser = null;
}

function startMeter() {
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    elMeterBar.style.width = Math.min(100, rms * 300) + "%";
    // 把嗓音强度喂给按钮辉光（--level: 0..1），让它随你的声音"活"起来。
    elTalkBtn.style.setProperty("--level", Math.min(1, rms * 3.4).toFixed(3));
    levelRAF = requestAnimationFrame(tick);
  };
  tick();
}
function stopMeter() {
  if (levelRAF) cancelAnimationFrame(levelRAF);
  levelRAF = 0;
  elMeterBar.style.width = "0%";
}

// 启动即连接（等待用户输入配对码）
connect().catch(() => { /* onclose 会自动重连 */ });
