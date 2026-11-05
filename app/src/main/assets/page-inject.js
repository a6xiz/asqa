(function () {
  if (window.__syncInjected) return;
  window.__syncInjected = true;
  var __handlers = {};
  var __ipc = {
    send: function (ch, data) { try { SyncPage.send(ch, JSON.stringify(data === undefined ? null : data)); } catch (e) {} },
    on: function (ch, fn) { (__handlers[ch] = __handlers[ch] || []).push(function (d) { fn({}, d); }); }
  };
  window.__syncDeliver = function (ch, json) {
    var d;
    try { d = json ? JSON.parse(json) : undefined; } catch (e) { d = undefined; }
    (__handlers[ch] || []).forEach(function (f) { try { f(d); } catch (e) {} });
  };
  var require = function () { return { ipcRenderer: __ipc }; };
// Runs inside the Cinemana page (sandboxed, isolated). Finds the video, reports local actions, applies remote ones.
const { ipcRenderer } = require("electron");

const SITE = {
  videoSelector: "#my-player_html5_api, video.vjs-tech", // Video.js v7 player on Cinemana (verified from a saved page)
  skipSeconds: 10,                                       // jumps of ~10 s are reported as "skip" (the site has no 10 s buttons)
};
const cfg = { isMain: false, connected: false, lag: 0 };
const attached = new WeakSet();
let active = null;
const mutes = {};

const send = (m) => { if (cfg.connected) ipcRenderer.send("sync:out", m); };

// A remote command makes the player fire its own events; "arm" swallows exactly those so they are not echoed back.
const arm = (k) => { const m = mutes[k] || (mutes[k] = { n: 0, until: 0 }); m.n++; m.until = Date.now() + 3000; };
const muted = (k) => {
  const m = mutes[k];
  if (!m) return false;
  if (Date.now() >= m.until) { m.n = 0; return false; }
  if (m.n > 0) { m.n--; return true; }
  return false;
};

function pickVideo() {
  const pref = document.querySelector(SITE.videoSelector);
  if (pref) return pref;
  const all = Array.from(document.querySelectorAll("video"));
  all.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  return all[0] || null;
}

function seekTo(v, time) {
  if (typeof time !== "number" || !isFinite(time)) return;
  if (Math.abs(v.currentTime - time) > 0.3) { arm("seeked"); v.currentTime = Math.max(0, time); }
}
function doPlay(v, time) {
  if (typeof time === "number") seekTo(v, time);
  if (v.paused) { arm("play"); const p = v.play(); if (p && p.catch) p.catch(() => { if (mutes.play) mutes.play.n = 0; }); }
}
function doPause(v, time) {
  if (!v.paused) { arm("pause"); v.pause(); }
  if (typeof time === "number") seekTo(v, time);
}

function attach(v) {
  if (attached.has(v)) return;
  attached.add(v);
  active = v;
  ipcRenderer.send("video:status", { found: true });
  const t = () => +v.currentTime.toFixed(2);
  let lastTime = v.currentTime;

  v.addEventListener("play", () => { if (!muted("play")) send({ type: "play", time: t() }); });
  v.addEventListener("pause", () => { if (v.ended || muted("pause")) return; send({ type: "pause", time: t() }); });
  v.addEventListener("ratechange", () => { if (!muted("ratechange")) send({ type: "ratechange", rate: v.playbackRate }); });
  v.addEventListener("timeupdate", () => { if (!v.seeking) lastTime = v.currentTime; });
  v.addEventListener("seeked", () => {
    if (muted("seeked")) { lastTime = v.currentTime; return; }
    const jump = v.currentTime - lastTime;
    const isSkip = Math.abs(Math.abs(jump) - SITE.skipSeconds) < 1.2;
    send(isSkip ? { type: "skip", delta: Math.sign(jump) * SITE.skipSeconds, time: t() } : { type: "seek", time: t() });
    lastTime = v.currentTime;
  });

  // Only Main sends heartbeats; Second follows them (prevents two clients correcting each other forever).
  const hb = setInterval(() => {
    if (!v.isConnected) { clearInterval(hb); return; }
    if (v === active && cfg.isMain && cfg.connected && !v.seeking) send({ type: "heartbeat", playing: !v.paused, time: t() });
  }, 5000);
}

function handleRemote(m) {
  const v = active;
  if (!v || !v.isConnected || !m) return;
  const lag = cfg.lag || 0;
  switch (m.type) {
    case "play": doPlay(v, typeof m.time === "number" ? m.time + lag : undefined); break;
    case "pause": doPause(v, m.time); break;
    case "seek": seekTo(v, m.time + (v.paused ? 0 : lag)); break;
    case "ratechange": if (m.rate && v.playbackRate !== m.rate) { arm("ratechange"); v.playbackRate = m.rate; } break;
    case "heartbeat": {
      if (cfg.isMain) break;
      const target = m.time + (m.playing ? lag : 0);
      if (m.playing && v.paused) doPlay(v, target);
      else if (!m.playing && !v.paused) doPause(v, m.time);
      else if (Math.abs(v.currentTime - target) > 1.5) seekTo(v, target);
      break;
    }
    case "welcome": {
      if (cfg.isMain || !m.state) break;
      if (m.state.rate && v.playbackRate !== m.state.rate) { arm("ratechange"); v.playbackRate = m.state.rate; }
      if (m.state.playing) doPlay(v, m.state.time + lag); else doPause(v, m.state.time);
      break;
    }
  }
}

ipcRenderer.on("sync:in", (_e, m) => handleRemote(m));
ipcRenderer.on("sync:config", (_e, c) => Object.assign(cfg, c || {}));

function scan() {
  const v = pickVideo();
  if (v && v !== active) attach(v);
  if (active && !active.isConnected) { active = null; ipcRenderer.send("video:status", { found: false }); }
}
setInterval(scan, 1000);
document.addEventListener("DOMContentLoaded", scan);
ipcRenderer.send("page:ready");

})();
