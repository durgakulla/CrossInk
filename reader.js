// The reader strip on the USB tool pages: one connection shared by the EPUB
// Optimizer, File Manager and Reading Stats. A browser closes the USB port
// when you leave a page, so each page reconnects by itself to a reader this
// site was already allowed to use (no picker), and again after it's
// replugged or restarts. Pages listen with Reader.onConnect/onDisconnect.
(function () {
  "use strict";

  var LATEST = [1, 8, 1];  // Newest CrossInk extras release
  var PREF = "crossink-autoconnect";
  var bar = document.getElementById("readerBar");
  var state = "idle";  // idle | connecting | connected | unsupported
  var info = null;
  var error = "";
  var connectListeners = [];
  var disconnectListeners = [];

  function autoConnectAllowed() {
    try { return localStorage.getItem(PREF) !== "off"; } catch (e) { return true; }
  }
  function setAutoConnect(on) {
    try { if (on) localStorage.removeItem(PREF); else localStorage.setItem(PREF, "off"); } catch (e) { /* not saved */ }
  }

  function deviceName(device) {
    return { "x3-x4": "X3 / X4", "x4-pro": "X4 Pro" }[device] || device || "Reader";
  }
  // The extras version in a firmware name like "1.6.1-extras 1.5.0", or null.
  function extrasVersion(firmware) {
    var m = /extras (\d+)\.(\d+)\.(\d+)/.exec(firmware || "");
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function isOlder(v) {
    for (var i = 0; i < 3; i++) if (v[i] !== LATEST[i]) return v[i] < LATEST[i];
    return false;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(label, onClick) {
    var b = el("button", "tool", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    if (!bar) return;
    bar.textContent = "";
    bar.className = "reader-bar " + state;
    bar.appendChild(el("span", "dot"));
    if (state === "unsupported") {
      bar.appendChild(el("span", "", "This browser can't use USB. Use Chrome or Edge on a computer."));
      return;
    }
    if (state === "connecting") {
      bar.appendChild(el("span", "", "Connecting to your reader…"));
      return;
    }
    if (state === "connected") {
      var text = el("span", "", deviceName(info.device) + " connected");
      bar.appendChild(text);
      if (info.firmware) bar.appendChild(el("span", "muted", info.firmware));
      var v = extrasVersion(info.firmware);
      if (!v || isOlder(v)) {
        var update = el("a", "update", v ? "Update to " + LATEST.join(".") : "Install CrossInk extras " + LATEST.join("."));
        update.href = "./#install";
        bar.appendChild(update);
      }
      bar.appendChild(el("span", "spacer"));
      bar.appendChild(button("Disconnect", function () {
        setAutoConnect(false);
        UsbSend.disconnect();
      }));
      return;
    }
    bar.appendChild(el("span", error ? "bad" : "", error || "No reader connected."));
    if (!error) bar.appendChild(el("span", "muted hint", "Plug it in by USB and leave it on its Home screen."));
    bar.appendChild(el("span", "spacer"));
    bar.appendChild(button("Connect reader", function () { connect(false); }));
  }

  var connecting = false;
  async function connect(auto) {
    if (connecting || state === "connected") return state === "connected";
    connecting = true;
    state = "connecting";
    error = "";
    render();
    try {
      info = await UsbSend.files.status();
      state = "connected";
      setAutoConnect(true);
    } catch (e) {
      state = "idle";
      info = null;
      // A quiet automatic attempt stays quiet; a click explains what failed.
      if (!auto && !(e && e.name === "NotFoundError")) error = (e && e.message) || String(e);
    }
    connecting = false;
    render();
    if (state === "connected") connectListeners.forEach(function (fn) { fn(info); });
    return state === "connected";
  }

  // Connections the pages open themselves (for example the optimizer's Send
  // to reader) and disconnections, including unplugging.
  window.addEventListener("crossink-reader", function (e) {
    if (e.detail.connected) {
      if (state !== "connected" && !connecting) connect(true);
    } else if (state === "connected") {
      state = "idle";
      info = null;
      render();
      disconnectListeners.forEach(function (fn) { fn(); });
    }
  });

  if (!window.UsbSend || !UsbSend.supported) {
    state = "unsupported";
  } else {
    // Plugged back in, or restarted after a stats restore.
    if (navigator.serial.addEventListener) {
      navigator.serial.addEventListener("connect", function () {
        if (autoConnectAllowed()) setTimeout(function () { connect(true); }, 1500);
      });
    }
    if (autoConnectAllowed()) {
      UsbSend.hasAllowedReader().then(function (allowed) { if (allowed) connect(true); });
    }
  }
  render();

  window.Reader = {
    connect: function () { return connect(false); },
    get connected() { return state === "connected"; },
    get info() { return info; },
    onConnect: function (fn) {
      connectListeners.push(fn);
      if (state === "connected") fn(info);
    },
    onDisconnect: function (fn) { disconnectListeners.push(fn); },
  };
})();
