// Chat bubble. History is saved on THIS device only (browser storage in the app's data folder).
const $ = (s) => document.querySelector(s);
const KEY = "syncwatch_chat_v1";
let msgs = [], open = false, unread = 0, online = false, friend = false;
try { msgs = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { msgs = []; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(msgs.slice(-500))); } catch (e) {} };

function fmtTime(ts) { const d = new Date(ts); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function fmtDay(ts) { return new Date(ts).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); }

function render() {
  const list = $("#list"); list.textContent = "";
  let lastDay = "";
  for (const m of msgs) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) { lastDay = day; const d = document.createElement("div"); d.className = "day"; d.textContent = day; list.appendChild(d); }
    const row = document.createElement("div"); row.className = "row " + (m.me ? "me" : "fr");
    const b = document.createElement("div"); b.className = "b"; b.textContent = m.text; // textContent: no HTML injection
    const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = (m.me ? "You" : (m.name || "Friend")) + " · " + fmtTime(m.ts);
    row.append(b, meta); list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}
function sys(text) { const d = document.createElement("div"); d.className = "sys"; d.textContent = text; $("#list").appendChild(d); $("#list").scrollTop = 1e9; }
function badge() { const b = $("#badge"); b.hidden = unread === 0; b.textContent = unread > 9 ? "9+" : unread; }
function status() { $("#dot").className = online && friend ? "on" : ""; $("#title").textContent = !online ? "Chat (not connected)" : friend ? "Chat" : "Chat (waiting for friend)"; }
function setOpen(v) {
  open = v; $("#panel").hidden = !v; $("#bubble").hidden = v;
  chatApi.size(v);
  if (v) { unread = 0; badge(); render(); setTimeout(() => $("#inp").focus(), 50); }
}
function send() {
  const t = $("#inp").value.trim(); if (!t) return;
  $("#inp").value = ""; $("#inp").style.height = "";
  chatApi.send(t);
}

chatApi.onIn((m) => {
  if (m.kind === "status") { online = !!m.connected; friend = !!m.friend; status(); return; }
  if (m.kind === "sys") { if (open) sys(m.text); return; }
  if (m.kind === "msg") {
    msgs.push({ me: !!m.me, name: m.name, text: String(m.text), ts: m.ts || Date.now() }); save();
    if (open) render();
    else if (!m.me) { unread++; badge(); const b = $("#bubble"); b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); }
  }
});
$("#bubble").onclick = () => setOpen(true);
$("#close").onclick = () => setOpen(false);
$("#send").onclick = send;
$("#clear").onclick = () => { if (confirm("Delete the chat history on this device?")) { msgs = []; save(); render(); } };
$("#inp").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("#inp").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(90, e.target.scrollHeight) + "px"; });
status();
