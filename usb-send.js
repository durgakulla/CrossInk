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
    if (/ERR:unknown_cmd/.test(message)) return "This reader's firmware is too old for this. Install CrossInk extras 1.4.0 or newer.";
    if (/ERR:protected_path/.test(message)) return "That folder can't be written to. Choose another folder.";
    return message;
  }

  // An open serial port with a byte queue fed by a background reader. The
  // queue holds the received chunks and an offset into the first, so large
  // reads don't shift arrays byte by byte.
  function Link(port) {
    this.port = port;
    this.chunks = [];
    this.offset = 0;
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
        var chunk = result.value;
        var i = 0;
        while (i < chunk.length && this.waiters.length) this.waiters.shift()(chunk[i++]);
        if (i < chunk.length) this.chunks.push(i ? chunk.subarray(i) : chunk);
      }
    } catch (e) {
      // Port closed or unplugged
    } finally {
      this.closed = true;
      try { this.reader.releaseLock(); } catch (e) {}
      this.waiters.splice(0).forEach(function (w) { w(-1); });
    }
  };

  Link.prototype.takeQueued = function () {
    var first = this.chunks[0];
    var byte = first[this.offset++];
    if (this.offset >= first.length) {
      this.chunks.shift();
      this.offset = 0;
    }
    return byte;
  };

  Link.prototype.drain = function () {
    this.chunks = [];
    this.offset = 0;
  };

  // Reads exactly n bytes, waiting up to idleMs for each gap in the data.
  Link.prototype.readBytes = async function (n, idleMs, onProgress) {
    var out = new Uint8Array(n);
    var filled = 0;
    var lastReport = 0;
    while (filled < n) {
      if (this.chunks.length) {
        var first = this.chunks[0];
        var count = Math.min(n - filled, first.length - this.offset);
        out.set(first.subarray(this.offset, this.offset + count), filled);
        filled += count;
        this.offset += count;
        if (this.offset >= first.length) {
          this.chunks.shift();
          this.offset = 0;
        }
      } else {
        out[filled++] = await this.readByte(idleMs);
      }
      if (onProgress && filled - lastReport >= 16384) {
        lastReport = filled;
        onProgress(filled / n);
      }
    }
    return out;
  };

  Link.prototype.readByte = function (timeoutMs) {
    if (this.chunks.length) return Promise.resolve(this.takeQueued());
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
    this.drain();  // Drop log output from before this command
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

  Link.prototype.remove = async function (path) {
    await this.command("R", this.pathPayload(path));
    await this.waitLine(function (l) { return l === "OK"; }, 120000, "delete");
  };

  Link.prototype.rename = async function (from, to) {
    await this.command("N", this.pathPayload(from).concat(this.pathPayload(to)));
    await this.waitLine(function (l) { return l === "OK"; }, 30000, "rename");
  };

  Link.prototype.mkdir = async function (path) {
    await this.command("K", this.pathPayload(path));
    await this.waitLine(function (l) { return l === "OK"; }, 5000, "create folder");
  };

  // "CMND" + 'T' + path -> "READY", u32 size, the bytes, u32 CRC-32.
  Link.prototype.readFile = async function (path, onProgress) {
    await this.command("T", this.pathPayload(path));
    await this.waitLine(function (l) { return l === "READY"; }, 10000, "start download");
    var sizeBytes = await this.readBytes(4, 10000);
    var size = (sizeBytes[0] | (sizeBytes[1] << 8) | (sizeBytes[2] << 16) | (sizeBytes[3] << 24)) >>> 0;
    var data = await this.readBytes(size, 10000, onProgress);
    var crcBytes = await this.readBytes(4, 10000);
    var crc = (crcBytes[0] | (crcBytes[1] << 8) | (crcBytes[2] << 16) | (crcBytes[3] << 24)) >>> 0;
    if (crc !== crc32(data)) throw new Error("ERR:crc: the download was damaged");
    return data;
  };

  // Collects the reader's "STATS:{json}" lines until "END" (stats commands).
  Link.prototype.statsRecords = async function (letter, payload, what) {
    await this.command(letter, payload);
    var records = [];
    for (;;) {
      var line = await this.waitLine(function (l) { return l === "END" || l.indexOf("STATS:") === 0; }, 30000, what);
      if (line === "END") return records;
      if (line !== "STATS:none") records.push(JSON.parse(line.slice(6)));
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

  // File manager operations on paths relative to the card's root ("/Books/a.epub").
  function card(path) { return "/sdcard" + (path === "/" ? "" : path); }
  var files = {
    status: function () { return queued(function (l) { return l.status(); }); },
    list: function (path) {
      return queued(async function (l) { await l.status(); return l.list(card(path)); });
    },
    mkdir: function (path) { return queued(function (l) { return l.mkdir(card(path)); }); },
    remove: function (path) { return queued(function (l) { return l.remove(card(path)); }); },
    rename: function (from, to) { return queued(function (l) { return l.rename(card(from), card(to)); }); },
    read: function (path, onProgress) {
      return queued(async function (l) {
        try {
          return await l.readFile(card(path), onProgress);
        } catch (e) {
          if (!/crc/i.test(e.message)) throw e;
          l.drain();
          return l.readFile(card(path), onProgress);  // Log output can corrupt a read; try once more
        }
      });
    },
    write: function (path, blob, onProgress) {
      return queued(async function (l) {
        await writeBook(l, card(path), new Uint8Array(await blob.arrayBuffer()), onProgress);
      });
    },
  };

  // Reading stats (firmware 1.4.0+): decoded by the reader, as JSON records.
  var IMPORT_PATH = "/crossink-stats-import.jsonl";
  var stats = {
    // {meta, global, daily}
    global: function () {
      return queued(async function (l) {
        await l.status();
        var out = {};
        (await l.statsRecords("G", [], "stats")).forEach(function (r) { out[r.type] = r; });
        if (!out.meta) throw new Error("This reader's firmware can't share its stats. Install CrossInk extras 1.4.0 or newer.");
        return out;
      });
    },
    // The book's record, or null when it has no stats.
    book: function (path) {
      return queued(async function (l) {
        var records = await l.statsRecords("B", l.pathPayload(card(path)), "book stats");
        return records[0] || null;
      });
    },
    // Uploads a JSON Lines backup and restores it; the reader restarts after.
    restore: function (jsonl, onProgress) {
      return queued(async function (l) {
        await l.status();
        await writeBook(l, card(IMPORT_PATH), new TextEncoder().encode(jsonl), onProgress);
        await l.command("I", l.pathPayload(card(IMPORT_PATH)));
        var line = await l.waitLine(function (r) { return r.indexOf("OK:") === 0; }, 120000, "restore");
        var result = {};
        line.slice(3).split(",").forEach(function (pair) {
          var kv = pair.split("=");
          result[kv[0]] = Number(kv[1]);
        });
        await l.close();  // The reader restarts now
        link = null;
        return result;
      });
    },
  };

  window.UsbSend = { send: send, listBooks: listBooks, replace: replace, files: files, stats: stats,
    supported: "serial" in navigator };
})();
