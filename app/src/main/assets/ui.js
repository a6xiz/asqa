// SyncWatch UI: lobby, server connection (WebSocket), link sync, voice (WebRTC), audio devices, chat bridge.
// The page-preload handles the video itself.
const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let S = {}, base = "", token = "", role = null, room = null;
let ws = null, wantConnected = false, retry = 0, timer = null, tick = 0, pollTimer = null;
let myId = null, members = {}, oneWay = 0.1, pingMs = 0, videoFound = false, navUrl = "", lastShared = null, linkOn = true;
let voiceOn = false, pc = null, localStream = null, peerReady = false, peerId = null, iceServers = null, pendingIce = [], muted = false, voiceTimer = null;
let prevStream = null, prevCtx = null, prevRaf = 0;
const DEFAULT_ICE = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const myName = () => (role === "main" ? "Main" : "Second");

// ---------- helpers ----------
function toast(t) { const e = $("#toast"); e.textContent = t; e.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => (e.style.display = "none"), 5000); }
function setMsg(t) { $("#msg").textContent = t || ""; }
function setStatus(kind, text) { $("#dot").className = kind; $("#stxt").textContent = text; $("#stxt").title = text; }
function showPanel(name) { // "lobby" | "audio" | null
  $("#lobby").classList.toggle("hidden", name !== "lobby");
  $("#audioPanel").classList.toggle("hidden", name !== "audio");
  api.send("view:show", !name);
  if (name === "audio") openAudio(); else closeAudio();
}
function busy(b) { for (const id of ["btnMain", "btnSecond", "server", "token", "room"]) $("#" + id).disabled = b; $("#cancel").hidden = !b && !(ws && ws.readyState === 1); }
const chatIn = (o) => api.send("chat:in", o);
const wsSend = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const wsVoice = (o) => wsSend(Object.assign({ type: "x-voice" }, o));
function sendCfg(connected) { api.send("sync:config", { isMain: role === "main", connected: !!connected, lag: oneWay }); }
const others = () => Object.keys(members).length - 1;

function refreshStatus() {
  if (!ws || ws.readyState !== 1) return;
  const names = Object.values(members);
  let kind, txt;
  if (others() < 1) { kind = "wait"; txt = role === "main" ? "waiting for your friend" : "waiting for Main"; }
  else if (names.includes("Main") && names.includes("Second")) { kind = "ok"; txt = "friend connected" + (pingMs ? " · " + pingMs + " ms" : ""); }
  else { kind = "bad"; txt = "you both chose " + myName() + ": one of you must pick the other role"; }
  setStatus(kind, `Room ${room} · ${txt}` + (videoFound ? "" : " · no video yet"));
  chatIn({ kind: "status", connected: true, friend: others() >= 1 });
}

// ---------- server calls ----------
async function call(path, method) {
  const r = await fetch(base + path + (path.includes("?") ? "&" : "?") + "t=" + enc(token), { method: method || "GET", cache: "no-store" });
  if (r.status === 401) throw new Error("Wrong password");
  if (!r.ok) throw new Error("Server answered " + r.status);
  return r.json();
}
const getCurrent = async () => (await call("/current")).room;
async function waitForMain() {
  setMsg("Waiting for Main to start the room…");
  while (wantConnected) {
    const r = await getCurrent();
    if (r) return String(r);
    await sleep(2000);
  }
  return null;
}

// ---------- connect ----------
async function start(r) {
  S.server = $("#server").value.trim(); S.token = $("#token").value; S.room = $("#room").value.trim();
  try { base = new URL(/^https?:\/\//i.test(S.server) ? S.server : "https://" + S.server).origin; } catch (e) { return setMsg("The server address is not valid."); }
  if (S.room && !/^(\d{1,2}|test)$/.test(S.room)) return setMsg("Room must be a number from 1 to 15.");
  token = S.token; role = r; wantConnected = true; retry = 0;
  await api.setSettings(S);
  busy(true); setMsg(r === "main" ? "Starting the room…" : "Looking for Main…");
  try {
    if (S.room) room = S.room;
    else if (r === "main") room = String((await call("/start", "POST")).room);
    else room = await waitForMain();
  } catch (e) { wantConnected = false; busy(false); return setMsg(e.message === "Failed to fetch" ? "Cannot reach the server. Check the address and your internet." : e.message); }
  if (!wantConnected || !room) { busy(false); return; }
  openSocket();
}
function stop() {
  wantConnected = false; setMsg("");
  if (voiceOn) stopVoice();
  closeSocket(); members = {}; sendCfg(false); setStatus("off", "Not connected");
  chatIn({ kind: "status", connected: false, friend: false }); busy(false);
}
function closeSocket() { clearInterval(timer); clearInterval(pollTimer); if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; } }

function openSocket() {
  closeSocket();
  const url = base.replace(/^http/, "ws") + "/room/" + room + "?t=" + enc(token) + "&name=" + myName();
  setStatus("wait", "Connecting…");
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retry = 0; busy(false); setMsg(""); showPanel(null); $("#cancel").hidden = false;
    sendCfg(true);
    tick = 0; timer = setInterval(() => { wsSend({ type: "ping", t: Date.now() }); if (++tick % 8 === 0) wsSend({ type: "keepalive" }); }, 4000);
    wsSend({ type: "ping", t: Date.now() });
    // Second keeps checking that it is in the room where Main really is (Main may restart into another room)
    if (role === "second" && !S.room) pollTimer = setInterval(async () => {
      try { const r = await getCurrent(); if (r && String(r) !== String(room)) { room = String(r); toast("Main moved to room " + room + ". Following…"); openSocket(); } } catch (e) {}
    }, 5000);
    if (voiceOn) wsVoice({ kind: "ready" });
  };
  sock.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (x) {} };
  sock.onclose = () => { if (ws !== sock) return; clearInterval(timer); clearInterval(pollTimer); closePc(); members = {}; if (wantConnected) reconnect(); else setStatus("off", "Not connected"); };
}
async function reconnect() {
  setStatus("wait", "Reconnecting…"); chatIn({ kind: "status", connected: false, friend: false });
  retry++; await sleep(Math.min(1000 * 2 ** (retry - 1), 8000));
  if (!wantConnected) return;
  if (role === "second" && !S.room) { try { const r = await getCurrent(); if (r && String(r) !== String(room)) room = String(r); } catch (e) {} }
  openSocket();
}

function onMsg(m) {
  switch (m.type) {
    case "welcome":
      myId = m.you; members = {}; (m.members || []).forEach((x) => (members[x.id] = x.name));
      refreshStatus();
      if (linkOn && m.state && m.state.media && m.state.media.url && role !== "main") api.send("nav:remote", m.state.media.url);
      if (role === "main" && others() >= 1) shareNow();
      api.send("sync:in", m); break;
    case "peer-joined":
      members[m.id] = m.name; refreshStatus(); toast("Friend connected");
      if (voiceOn) wsVoice({ kind: "ready" });
      if (role === "main") shareNow();
      break;
    case "peer-left":
      delete members[m.id]; refreshStatus(); toast("Friend left"); peerReady = false; closePc(); break;
    case "role-conflict":
      wantConnected = false; closeSocket(); setStatus("off", "Not connected"); showPanel("lobby"); busy(false);
      setMsg("Someone is already Main in this room. If your friend is Main, click “I'm Second”. If you restarted the app, wait 15 seconds and try again."); break;
    case "pong": {
      const rtt = Date.now() - m.t; pingMs = Math.round(rtt);
      oneWay = oneWay * 0.6 + (rtt / 2000) * 0.4; sendCfg(true); refreshStatus(); break;
    }
    case "media": if (linkOn && m.url) api.send("nav:remote", m.url); break;
    case "x-voice": onVoice(m); break;
    case "x-chat": chatIn({ kind: "msg", me: false, name: m.name || "Friend", text: m.text, ts: m.ts || Date.now() }); break;
    case "play": case "pause": case "seek": case "ratechange": case "heartbeat": api.send("sync:in", m); break;
  }
}

// ---------- link sync: "when on, both apps open the same page" ----------
function updateLinkBtn() { $("#link").textContent = "Link: " + (linkOn ? "on" : "off"); $("#link").classList.toggle("on", linkOn); }
function shareNow() { if (linkOn && lastShared) wsSend({ type: "media", url: lastShared, title: "" }); }

api.on("nav:changed", ({ url }) => { lastShared = url; if (linkOn) wsSend({ type: "media", url, title: "" }); });
api.on("sync:out", (m) => wsSend(m));
api.on("video:status", (s) => { videoFound = !!s.found; refreshStatus(); });
api.on("nav:state", (n) => {
  navUrl = n.url; if (document.activeElement !== $("#addr")) $("#addr").value = n.url;
  $("#back").disabled = !n.canGoBack; $("#fwd").disabled = !n.canGoForward;
});

// ---------- chat bridge ----------
api.on("chat:send", ({ text }) => {
  if (!ws || ws.readyState !== 1) return chatIn({ kind: "sys", text: "Not connected. Open Connection first." });
  const ts = Date.now();
  wsSend({ type: "x-chat", text, name: myName(), ts });
  chatIn({ kind: "msg", me: true, name: "You", text, ts });
});

// ---------- audio devices ----------
const micError = (e) => e && e.name === "NotAllowedError" ? "Windows is blocking the microphone. Open Windows Settings > Privacy & security > Microphone, and turn on “Let desktop apps access your microphone”."
  : e && e.name === "NotFoundError" ? "No microphone found. Plug one in or pick another device."
  : e && e.name === "NotReadableError" ? "The microphone is being used by another program."
  : "Microphone error: " + ((e && (e.message || e.name)) || e);
const gum = (c) => navigator.mediaDevices.getUserMedia(c);
async function getMic() {
  const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (S.micId) {
    try { return await gum({ audio: Object.assign({ deviceId: { exact: S.micId } }, opts), video: false }); }
    catch (e) { if (e.name !== "OverconstrainedError" && e.name !== "NotFoundError") throw e; toast("The chosen microphone was not found. Using the default one."); }
  }
  return gum({ audio: opts, video: false });
}
async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, saved, label) => {
    sel.textContent = "";
    const list = devs.filter((d) => d.kind === kind);
    if (!list.length) { const o = document.createElement("option"); o.textContent = "No " + label + " found"; o.value = ""; sel.appendChild(o); return; }
    const def = document.createElement("option"); def.value = ""; def.textContent = "System default"; sel.appendChild(def);
    list.forEach((d, i) => { if (d.deviceId === "default" || d.deviceId === "communications") return; const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || (label + " " + (i + 1)); sel.appendChild(o); });
    sel.value = [...sel.options].some((o) => o.value === saved) ? saved : "";
  };
  fill($("#micSel"), "audioinput", S.micId, "microphone");
  fill($("#spkSel"), "audiooutput", S.spkId, "speaker");
}
async function startMeter() {
  stopMeter();
  try {
    prevStream = await getMic();
    prevCtx = new AudioContext();
    const an = prevCtx.createAnalyser(); an.fftSize = 512;
    prevCtx.createMediaStreamSource(prevStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
      $("#meter").style.width = Math.min(100, (peak / 128) * 160) + "%";
      prevRaf = requestAnimationFrame(loop);
    };
    loop(); $("#audMsg").textContent = "";
  } catch (e) { $("#audMsg").textContent = micError(e); }
}
function stopMeter() {
  cancelAnimationFrame(prevRaf);
  if (prevStream) prevStream.getTracks().forEach((t) => t.stop());
  if (prevCtx) prevCtx.close().catch(() => {});
  prevStream = prevCtx = null; $("#meter").style.width = "0";
}
async function openAudio() { await startMeter(); await listDevices(); }
function closeAudio() { stopMeter(); }
async function applySink() { const a = $("#remoteAudio"); if (a.setSinkId) { try { await a.setSinkId(S.spkId || ""); } catch (e) {} } }
$("#micSel").onchange = async () => { S.micId = $("#micSel").value; await api.setSettings(S); await startMeter(); if (voiceOn) switchMic(); };
$("#spkSel").onchange = async () => { S.spkId = $("#spkSel").value; await api.setSettings(S); applySink(); };
$("#audDone").onclick = () => showPanel(null);
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", () => { if (!$("#audioPanel").classList.contains("hidden")) listDevices(); });

// ---------- voice (WebRTC, audio goes directly between you two) ----------
function voiceLabel(t, on) { $("#voice").textContent = t; $("#voice").classList.toggle("on", !!on); $("#mute").hidden = !voiceOn; }
async function loadIce() {
  iceServers = DEFAULT_ICE;
  try {
    const j = await call("/turn");
    if (j && j.iceServers && j.iceServers.length) iceServers = j.iceServers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
  } catch (e) {}
}
async function startVoice() {
  if (!ws || ws.readyState !== 1) return toast("Connect first (Connection button).");
  try { localStream = await getMic(); } catch (e) { return toast(micError(e)); }
  voiceOn = true; muted = false; $("#mute").textContent = "Mute";
  voiceLabel("Voice: waiting…", true);
  await loadIce(); applySink();
  wsVoice({ kind: "ready" });
  if (peerReady && iAmOfferer()) makeOffer();
}
function stopVoice() {
  voiceOn = false; closePc(); wsVoice({ kind: "bye" });
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null; voiceLabel("Voice: off", false);
}
async function switchMic() {
  try {
    const s = await getMic();
    const t = s.getAudioTracks()[0]; t.enabled = !muted;
    if (pc) { const snd = pc.getSenders().find((x) => x.track && x.track.kind === "audio"); if (snd) await snd.replaceTrack(t); }
    if (localStream) localStream.getTracks().forEach((x) => x.stop());
    localStream = s; toast("Microphone changed.");
  } catch (e) { toast(micError(e)); }
}
function closePc() {
  clearTimeout(voiceTimer);
  if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; try { pc.close(); } catch (e) {} pc = null; }
  pendingIce = []; $("#remoteAudio").srcObject = null;
  if (voiceOn) voiceLabel("Voice: waiting…", true);
}
// Who sends the call offer is decided by the connection ids (not by role), so any two people can connect.
const iAmOfferer = () => !!(myId && peerId && myId < peerId);
function newPc() {
  pc = new RTCPeerConnection({ iceServers: iceServers || DEFAULT_ICE });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) wsVoice({ kind: "ice", cand: e.candidate }); };
  pc.ontrack = (e) => { const a = $("#remoteAudio"); a.srcObject = e.streams[0]; a.play().catch(() => {}); };
  pc.onconnectionstatechange = async () => {
    const s = pc && pc.connectionState;
    if (s === "connected") { clearTimeout(voiceTimer); voiceLabel("Voice: on" + (await routeKind()), true); }
    else if (s === "connecting") voiceLabel("Voice: connecting…", true);
    else if (s === "failed") voiceFailed();
  };
  clearTimeout(voiceTimer);
  voiceTimer = setTimeout(() => { if (pc && pc.connectionState !== "connected") voiceFailed(); }, 20000);
}
function voiceFailed() {
  voiceLabel("Voice: failed", true);
  toast("Voice could not connect. Some internet providers block direct calls. The server owner can fix this once with START.bat --turn.");
}
async function routeKind() {
  try {
    const st = await pc.getStats(); let pair = null;
    st.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = r.selectedCandidatePairId; });
    let kind = null; st.forEach((r) => { if (r.id === pair) { const l = st.get(r.localCandidateId); if (l) kind = l.candidateType; } });
    return kind === "relay" ? " (relay)" : kind ? " (direct)" : "";
  } catch (e) { return ""; }
}
async function makeOffer() {
  if (!voiceOn || !localStream) return;
  closePc(); newPc();
  const o = await pc.createOffer(); await pc.setLocalDescription(o);
  wsVoice({ kind: "offer", sdp: pc.localDescription });
}
async function onVoice(m) {
  try {
    if (m.from) peerId = m.from;
    if (m.kind === "ready") { peerReady = true; if (voiceOn && iAmOfferer()) await makeOffer(); }
    else if (m.kind === "bye") { peerReady = false; closePc(); }
    else if (m.kind === "offer" && voiceOn) {
      closePc(); newPc();
      await pc.setRemoteDescription(m.sdp);
      for (const c of pendingIce) await pc.addIceCandidate(c).catch(() => {}); pendingIce = [];
      const a = await pc.createAnswer(); await pc.setLocalDescription(a);
      wsVoice({ kind: "answer", sdp: pc.localDescription });
    } else if (m.kind === "answer" && pc) await pc.setRemoteDescription(m.sdp);
    else if (m.kind === "ice" && m.cand) {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(m.cand).catch(() => {}); else pendingIce.push(m.cand);
    }
  } catch (e) { toast("Voice error: " + (e.message || e)); }
}

// ---------- buttons ----------
$("#btnMain").onclick = () => start("main");
$("#btnSecond").onclick = () => start("second");
$("#cancel").onclick = stop;
$("#skip").onclick = () => showPanel(null);
$("#conn").onclick = () => { const open = $("#lobby").classList.contains("hidden"); if (open && ws && ws.readyState === 1) { setMsg("You are connected. “Disconnect” leaves the room."); $("#cancel").hidden = false; } showPanel(open ? "lobby" : null); };
$("#audio").onclick = () => showPanel($("#audioPanel").classList.contains("hidden") ? "audio" : null);
$("#back").onclick = () => api.send("nav:cmd", "back");
$("#fwd").onclick = () => api.send("nav:cmd", "forward");
$("#reload").onclick = () => api.send("nav:cmd", "reload");
$("#home").onclick = () => api.send("nav:cmd", "home");
$("#addr").addEventListener("keydown", (e) => { if (e.key === "Enter") { api.send("nav:go", $("#addr").value); e.target.blur(); } });
$("#addr").addEventListener("blur", () => { $("#addr").value = navUrl; });
$("#voice").onclick = () => (voiceOn ? stopVoice() : startVoice());
$("#mute").onclick = () => { muted = !muted; if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = !muted)); $("#mute").textContent = muted ? "Unmute" : "Mute"; };
$("#link").onclick = () => { linkOn = !linkOn; S.link = linkOn; api.setSettings(S); updateLinkBtn(); if (linkOn) { shareNow(); toast("Link sync on: your page is now opened for your friend too."); } else toast("Link sync off: pages are no longer shared."); };

(async () => {
  S = (await api.getSettings()) || {};
  linkOn = S.link !== false; updateLinkBtn();
  $("#server").value = S.server || ""; $("#token").value = S.token || ""; $("#room").value = S.room || "";
  showPanel("lobby");
  if (S.auto === "main" || S.auto === "second") start(S.auto);
})();
