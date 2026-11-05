// Lets the Windows UI code run inside the Android app: provides window.api / window.chatApi using the native bridges.
(function () {
  var handlers = {};
  window.__deliver = function (ch, json) {
    var d;
    try { d = json ? JSON.parse(json) : undefined; } catch (e) { d = undefined; }
    (handlers[ch] || []).forEach(function (fn) { try { fn(d); } catch (e) {} });
  };
  function on(ch, fn) { (handlers[ch] = handlers[ch] || []).push(fn); }
  function j(v) { return JSON.stringify(v === undefined ? null : v); }
  if (window.AndroidUI && !window.api) {
    window.api = {
      send: function (ch, data) { AndroidUI.send(ch, j(data)); },
      on: on,
      getSettings: function () { return Promise.resolve(JSON.parse(AndroidUI.getSettings() || "{}")); },
      setSettings: function (s) { AndroidUI.setSettings(j(s)); return Promise.resolve(true); }
    };
  }
  if (window.AndroidChat && !window.chatApi) {
    window.chatApi = {
      send: function (text) { AndroidChat.send("chat:send", j({ text: String(text || "").slice(0, 1000) })); },
      size: function (open) { AndroidChat.send("chat:size", j(!!open)); },
      onIn: function (fn) { on("chat:in", fn); }
    };
  }
})();
