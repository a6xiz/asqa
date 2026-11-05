// Runs after ui.js: the toolbar is only 52px tall, so messages are shown as native Android toasts instead.
if (window.AndroidUI) {
  window.toast = function (t) { AndroidUI.send("toast", JSON.stringify(String(t))); };
}
