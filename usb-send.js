// Sends books to a CrossInk reader over USB with Web Serial, using the
// firmware's serial file-transfer protocol (src/network/UsbSerialFileTransfer.cpp):
//   "CMND" + 'S'                                  -> "STATUS:protocol=1,device=..."
//   "CMND" + 'K' + u16 path length + path         -> "OK" | "ERR:..."
//   "CMND" + 'A' + u16 path length + path         -> "DIR:path", "d|name" /
//     "f|name|size|0" lines, "END"
//   "CMND" + 'W' + u16 path length + path + u32 size -> "READY", then 256-byte
//     chunks each answered by ACK (0x06), then a CRC-32 -> "OK" | "ERR:..."
// The reader only accepts transfers on its Home screen. Text lines from its
// log are skipped.
(function () {
  "use strict";

  var MAGIC = [0x43, 0x4d, 0x4e, 0x44];  // "CMND"
  var ACK = 0x06;
  var CHUNK = 256;
  var CHUNK_TIMEOUT_MS = 45000;
  // Espressif USB (X3, X4 Pro), Seeed, CP210x and CH340 bridges.
  var FILTERS = [{ usbVendorId: 0x303a }, { usbVendorId: 0x2886 }, { usbVendorId: 0x10c4 }, { usbVendorId: 0x1a86 }];
  var encoder = new TextEncoder();

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function le16(v) { return [v & 255, (v >>> 8) & 255]; }
  function le32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }

  // A CrossInk log line ("[123] [INF] [TAG] ...") or an ESP-IDF one ("I (123) ...").
  function isLogLine(line) {
    return /^\[\d+\] \[[^\]]+\]/.test(line) || /^[IWED] \(\d+\)/.test(line);
  }

  function friendlyError(message) {
    if (/ERR:not_on_home/.test(message)) return "Open the Home screen on your reader, then try again.";
    if (/ERR:protected_path/.test(message)) return "That folder can't be written to. Choose another folder.";
    return message;
  }

  // An open serial port with a byte queue fed by a background reader.
  function Link(port) {
    this.port = port;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.pump();
  }

  Link.prototype.pump = async function () {
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        var result = await this.reader.read();
        if (result.done) break;
        for (var i = 0; i < result.value.length; i++) {
          var waiter = this.waiters.shift();
          if (waiter) waiter(result.value[i]);
          else this.queue.push(result.value[i]);
        }
      }
    } catch (e) {
      // Port closed or unplugged
    } finally {
      this.closed = true;
      try { this.reader.releaseLock(); } catch (e) {}
      this.waiters.splice(0).forEach(function (w) { w(-1); });
    }
  };

  Link.prototype.readByte = function (timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error("The reader was disconnected."));
    var self = this;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var i = self.waiters.indexOf(take);
        if (i >= 0) self.waiters.splice(i, 1);
        reject(new Error("timeout"));
      }, timeoutMs);
      function take(byte) {
        clearTimeout(timer);
        if (byte < 0) reject(new Error("The reader was disconnected."));
        else resolve(byte);
      }
      self.waiters.push(take);
    });
  };

  // Reads the rest of a text line that started with first.
  Link.prototype.readLineFrom = async function (first, timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    var line = first === 10 || first === 13 ? "" : String.fromCharCode(first);
    if (first === 10) return line;
    for (;;) {
      var byte;
      try {
        byte = await this.readByte(Math.max(1, deadline - Date.now()));
      } catch (e) {
        if (e.message === "timeout") return line;  // The caller's deadline reports it
        throw e;
      }
      if (byte === 10) return line;
      if (byte !== 13) line += String.fromCharCode(byte);
    }
  };

  // Waits for a protocol line matching accept, skipping log output.
  Link.prototype.waitLine = async function (accept, timeoutMs, what) {
    var deadline = Date.now() + timeoutMs;
    for (;;) {
      var left = deadline - Date.now();
      if (left <= 0) throw new Error("The reader didn't answer (" + what + ").");
      var byte;
      try {
        byte = await this.readByte(left);
      } catch (e) {
        if (e.message === "timeout") continue;
        throw e;
      }
      var line = await this.readLineFrom(byte, Math.max(1, deadline - Date.now()));
      if (!line || isLogLine(line)) continue;
      if (line.indexOf("ERR:") === 0) throw new Error(friendlyError(line));
      if (accept(line)) return line;
    }
  };

  // Waits for the ACK byte; BUSY lines from the reader extend the wait.
  Link.prototype.waitAck = async function (what) {
    var deadline = Date.now() + CHUNK_TIMEOUT_MS;
    for (;;) {
      var left = deadline - Date.now();
      if (left <= 0) throw new Error("The reader stopped answering (" + what + ").");
      var byte;
      try {
        byte = await this.readByte(left);
      } catch (e) {
        if (e.message === "timeout") continue;
        throw e;
      }
      if (byte === ACK) return;
      var line = await this.readLineFrom(byte, Math.max(1, deadline - Date.now()));
      if (line.indexOf("BUSY:") === 0) { deadline = Date.now() + CHUNK_TIMEOUT_MS; continue; }
      if (line.indexOf("ERR:") === 0) throw new Error(friendlyError(line));
    }
  };

  Link.prototype.write = async function (bytes) {
    var writer = this.port.writable.getWriter();
    try {
      await writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } finally {
      writer.releaseLock();
    }
  };

  Link.prototype.command = function (letter, payload) {
    return this.write(MAGIC.concat([letter.charCodeAt(0)], payload || []));
  };

  Link.prototype.pathPayload = function (path) {
    var bytes = Array.from(encoder.encode(path));
    return le16(bytes.length).concat(bytes);
  };

  Link.prototype.status = async function () {
    this.queue.length = 0;  // Drop log output from before this command
    await this.command("S");
    var line = await this.waitLine(function (l) { return l.indexOf("STATUS:") === 0; }, 3000, "status");
    var info = {};
    line.slice(7).split(",").forEach(function (pair) {
      var kv = pair.split("=");
      if (kv.length === 2) info[kv[0].trim()] = kv[1].trim();
    });
    return info;
  };

  Link.prototype.mkdirs = async function (folder) {
    var parts = folder.split("/").filter(function (p) { return p && p !== "."; });
    var path = "/sdcard";
    for (var i = 0; i < parts.length; i++) {
      path += "/" + parts[i];
      await this.command("K", this.pathPayload(path));
      await this.waitLine(function (l) { return l === "OK"; }, 5000, "create folder " + path);
    }
  };

  // Lists a folder as [{folder, name, size}].
  Link.prototype.list = async function (path) {
    await this.command("A", this.pathPayload(path));
    var entries = [];
    var started = false;
    var deadline = Date.now() + 10000;
    for (;;) {
      var line = await this.waitLine(function () { return true; }, Math.max(1, deadline - Date.now()), "list " + path);
      if (line.indexOf("DIR:") === 0) { started = true; continue; }
      if (line === "END") return entries;
      if (!started) continue;
      var parts = line.split("|");
      if (parts[0] === "d" && parts.length >= 2) entries.push({ folder: true, name: parts.slice(1).join("|") });
      else if (parts[0] === "f" && parts.length >= 4) {
        entries.push({ folder: false, name: parts.slice(1, -2).join("|"), size: Number(parts[parts.length - 2]) });
      }
    }
  };

  Link.prototype.sendFile = async function (path, bytes, onProgress) {
    await this.command("W", this.pathPayload(path).concat(le32(bytes.length)));
    await this.waitLine(function (l) { return l === "READY"; }, 10000, "start");
    for (var offset = 0; offset < bytes.length;) {
      var end = Math.min(offset + CHUNK, bytes.length);
      await this.write(bytes.subarray(offset, end));
      offset = end;
      await this.waitAck(Math.round(offset / 1024) + " KB");
      if (onProgress) onProgress(offset / bytes.length);
    }
    await this.write(le32(crc32(bytes)));
    await this.waitLine(function (l) { return l === "OK"; }, 30000, "finish");
  };

  Link.prototype.close = async function () {
    this.closed = true;
    try { await this.reader.cancel(); } catch (e) {}
    try { await this.port.close(); } catch (e) {}
  };

  var link = null;
  var busy = Promise.resolve();

  async function connect() {
    if (link && !link.closed) return link;
    if (!("serial" in navigator)) throw new Error("This browser can't use USB. Use Chrome or Edge on a computer.");
    var ports = await navigator.serial.getPorts();
    var port = ports.filter(function (p) {
      var info = p.getInfo();
      return FILTERS.some(function (f) { return f.usbVendorId === info.usbVendorId; });
    })[0] || await navigator.serial.requestPort({ filters: FILTERS });
    try {
      await port.open({ baudRate: 115200, bufferSize: 8192 });
    } catch (e) {
      if (/already open/i.test(e.message)) {
        // Opened by this page earlier; reuse it.
      } else if (/busy|in use|access denied|failed to open/i.test(e.message)) {
        throw new Error("The reader's USB port is busy. Close other tabs or serial tools using it, then try again.");
      } else {
        throw e;
      }
    }
    link = new Link(port);
    return link;
  }

  function cleanFolder(folder) {
    var parts = (folder || "/").replace(/\\/g, "/").split("/").filter(function (p) { return p && p !== "."; });
    if (parts.some(function (p) { return p === ".."; })) throw new Error("The folder can't contain \"..\".");
    if (parts.length && parts[0].toLowerCase() === "sdcard") parts.shift();
    return parts.join("/");
  }

  // Runs fn(link) after any earlier operation, one at a time on the shared
  // port; drops the connection if the reader stopped answering.
  function queued(fn) {
    var run = busy.then(async function () {
      var l = await connect();
      try {
        return await fn(l);
      } catch (e) {
        if (l.closed || /didn't answer|stopped answering|disconnected/.test(e.message)) {
          await l.close();
          link = null;
        }
        throw e;
      }
    });
    busy = run.catch(function () {});
    return run;
  }

  async function writeBook(l, path, bytes, onProgress) {
    try {
      await l.sendFile(path, bytes, onProgress);
    } catch (e) {
      if (!/crc/i.test(e.message)) throw e;
      await l.sendFile(path, bytes, onProgress);  // One retry after a checksum mismatch
    }
  }

  // Sends one book into folder (relative to the card's root).
  function send(blob, fileName, folder, onProgress) {
    return queued(async function (l) {
      var dir = cleanFolder(folder);
      var bytes = new Uint8Array(await blob.arrayBuffer());
      var info = await l.status();
      if (dir) await l.mkdirs(dir);
      await writeBook(l, "/sdcard/" + (dir ? dir + "/" : "") + fileName, bytes, onProgress);
      return { path: "/" + (dir ? dir + "/" : "") + fileName, device: info.device || "", firmware: info.firmware || "" };
    });
  }

  // Every EPUB on the reader's card, as [{path, name, size}], searching up to
  // MAX_DEPTH folders deep and MAX_FOLDERS folders in all.
  var MAX_DEPTH = 6;
  var MAX_FOLDERS = 300;
  function listBooks() {
    return queued(async function (l) {
      await l.status();
      var books = [];
      var folders = [{ path: "", depth: 0 }];
      var visited = 0;
      while (folders.length && visited < MAX_FOLDERS) {
        var folder = folders.shift();
        visited++;
        var entries = await l.list("/sdcard" + (folder.path ? "/" + folder.path : ""));
        entries.forEach(function (entry) {
          var path = (folder.path ? folder.path + "/" : "") + entry.name;
          if (entry.folder) {
            if (folder.depth + 1 <= MAX_DEPTH) folders.push({ path: path, depth: folder.depth + 1 });
          } else if (/\.epub$/i.test(entry.name)) {
            books.push({ path: "/" + path, name: entry.name, size: entry.size });
          }
        });
      }
      return books;
    });
  }

  // Overwrites the book at path (from listBooks), keeping its name, so the
  // reader keeps its reading stats, position and settings.
  function replace(blob, path, onProgress) {
    return queued(async function (l) {
      var bytes = new Uint8Array(await blob.arrayBuffer());
      await l.status();
      await writeBook(l, "/sdcard" + path, bytes, onProgress);
      return { path: path };
    });
  }

  window.UsbSend = { send: send, listBooks: listBooks, replace: replace, supported: "serial" in navigator };
})();
