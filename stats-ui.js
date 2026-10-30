// Reading stats dashboard: loads the reader's stats over USB (usb-send.js,
// firmware 1.4.0+) or from a backup file, shows them, exports CSV and backups,
// and restores a backup to the reader.
(function () {
  "use strict";

  var DAY_MS = 86400000;
  var EPOCH = Date.UTC(2000, 0, 1);  // Day index 0 (readingStatsDayIndex)
  var HISTORY_DAYS = 730;
  var MEDIUM_DAY = 15 * 60;  // Same shades as the Reading Heatmap sleep screen
  var HEAVY_DAY = 45 * 60;
  var TIME_OF_DAY = ["Morning", "Afternoon", "Evening", "Night"];
  var WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var connectButton = document.getElementById("connect");
  var status = document.getElementById("status");
  var source = document.getElementById("source");
  var dashboard = document.getElementById("dashboard");
  var saveBackup = document.getElementById("saveBackup");
  var saveCsv = document.getElementById("saveCsv");
  var restorePanel = document.getElementById("restorePanel");

  var data = null;        // What the dashboard shows
  var cardBooks = null;   // Book paths on the connected reader
  var busy = false;
  var sort = { key: "seconds", ascending: false };

  // ---- Helpers -----------------------------------------------------------

  function dayDate(index) { return new Date(EPOCH + index * DAY_MS); }
  function dateText(d) { return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
  function isoDay(d) { return d.toISOString().slice(0, 10); }
  function shortDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00Z");
    return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
  }
  function duration(seconds) {
    seconds = seconds || 0;
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h) return h + "h" + (m ? " " + m + "m" : "");
    if (m) return m + "m";
    return seconds ? "<1m" : "0m";
  }
  function pace(book) {
    return book.seconds > 60 && book.pages ? book.pages * 60 / book.seconds : 0;
  }
  function say(text, bad) {
    status.textContent = text;
    status.classList.toggle("bad", !!bad);
  }
  function friendly(e) {
    if (e && e.name === "NotFoundError") return "No reader picked.";
    return (e && e.message) || String(e);
  }
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }
  function download(name, text, type) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  // ---- Loading -----------------------------------------------------------

  async function loadFromReader() {
    say("Reading stats…");
    var g = await UsbSend.stats.global();
    say("Finding books…");
    var paths = (await UsbSend.listBooks()).map(function (b) { return b.path; })
      .filter(function (p) { return /\.(epub|xtch?)$/i.test(p); });
    cardBooks = new Set(paths);
    var books = [];
    for (var i = 0; i < paths.length; i++) {
      say("Reading book " + (i + 1) + " of " + paths.length + "…");
      var record = await UsbSend.stats.book(paths[i]);
      if (record) books.push(record);
    }
    return {
      format: "crossink-stats", version: 1, exported: new Date().toISOString(),
      meta: g.meta, global: g.global, daily: g.daily, books: books,
    };
  }

  function validBackup(d) {
    return d && d.format === "crossink-stats" && d.version === 1 && d.global && Array.isArray(d.books);
  }

  function show(d, sourceText) {
    data = d;
    source.textContent = sourceText;
    saveBackup.disabled = saveCsv.disabled = false;
    dashboard.hidden = false;
    render();
  }

  // ---- Rendering ---------------------------------------------------------

  function todayIndex(d) {
    if (d.meta && d.meta.todayIndex) return d.meta.todayIndex;
    return Math.max(d.global.historyAnchor || 0, d.daily ? d.daily.anchorDay || 0 : 0);
  }

  function renderTiles(d) {
    var tiles = document.getElementById("tiles");
    tiles.textContent = "";
    [
      [duration(d.global.seconds), "Time read"],
      [d.global.completedBooks, "Books finished"],
      [d.global.sessions, "Sessions"],
      [d.global.pages.toLocaleString(), "Pages turned"],
      [(d.global.currentStreak || 0) + "d", "Current streak"],
      [(d.global.longestStreak || 0) + "d", "Longest streak"],
    ].forEach(function (t) {
      var tile = el("div", { class: "tile" });
      tile.appendChild(el("b", {}, String(t[0])));
      tile.appendChild(el("span", {}, t[1]));
      tiles.appendChild(tile);
    });
  }

  // Shade of a day: by minutes for the days in the per-day log, otherwise
  // the lightest shade for a day marked read in the history.
  function dayLevel(d, index) {
    var seconds = 0;
    if (d.daily && d.daily.anchorDay && index <= d.daily.anchorDay) {
      var slot = d.daily.anchorDay - index;
      if (slot < d.daily.seconds.length) seconds = d.daily.seconds[slot];
    }
    var read = false;
    var anchor = d.global.historyAnchor;
    var hex = d.global.history || "";
    if (index <= anchor && anchor - index < HISTORY_DAYS) {
      var bit = anchor - index;
      read = (parseInt(hex.substr(Math.floor(bit / 8) * 2, 2), 16) & (1 << (bit % 8))) !== 0;
    }
    if (seconds >= HEAVY_DAY) return { level: 3, seconds: seconds };
    if (seconds >= MEDIUM_DAY) return { level: 2, seconds: seconds };
    return { level: seconds > 0 || read ? 1 : 0, seconds: seconds, read: read };
  }

  function renderHeatmap(d) {
    var host = document.getElementById("heat");
    host.textContent = "";
    var today = todayIndex(d);
    // Weeks start on Monday; day index 0 (Jan 1, 2000) was a Saturday.
    var weekday = function (index) { return (index + 5) % 7; };
    var end = today + (6 - weekday(today));
    var start = end - 104 * 7 - 6;
    var cell = 10, gap = 2, top = 14, left = 24;
    var weeks = Math.ceil((end - start + 1) / 7);
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", left + weeks * (cell + gap));
    svg.setAttribute("height", top + 7 * (cell + gap));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Reading days for the last two years");
    ["Mon", "", "Wed", "", "Fri", "", ""].forEach(function (label, row) {
      if (!label) return;
      var t = document.createElementNS(ns, "text");
      t.setAttribute("x", 0);
      t.setAttribute("y", top + row * (cell + gap) + cell - 1);
      t.textContent = label;
      svg.appendChild(t);
    });
    var shades = ["var(--l0)", "var(--l1)", "var(--l2)", "var(--l3)"];
    var lastMonth = -1;
    var readDays = 0;
    for (var index = start; index <= end; index++) {
      var column = Math.floor((index - start) / 7);
      var row = weekday(index);
      var date = dayDate(index);
      if (row === 0 && date.getUTCMonth() !== lastMonth) {
        lastMonth = date.getUTCMonth();
        var m = document.createElementNS(ns, "text");
        m.setAttribute("x", left + column * (cell + gap));
        m.setAttribute("y", 9);
        m.textContent = MONTHS[lastMonth];
        svg.appendChild(m);
      }
      if (index > today) continue;
      var day = dayLevel(d, index);
      if (day.level) readDays++;
      var rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", left + column * (cell + gap));
      rect.setAttribute("y", top + row * (cell + gap));
      rect.setAttribute("width", cell);
      rect.setAttribute("height", cell);
      rect.setAttribute("rx", 2);
      rect.setAttribute("fill", shades[day.level]);
      var title = document.createElementNS(ns, "title");
      title.textContent = dateText(date) + ": " + (day.seconds ? duration(day.seconds) :
        day.read ? "read" : "no reading");
      rect.appendChild(title);
      svg.appendChild(rect);
    }
    host.appendChild(svg);
    host.scrollLeft = host.scrollWidth;  // Most recent weeks in view
    document.getElementById("heatNote").textContent = readDays + " reading days";
  }

  function renderBars(id, labels, values) {
    var host = document.getElementById(id);
    host.textContent = "";
    var max = Math.max.apply(null, values.concat([1]));
    labels.forEach(function (label, i) {
      host.appendChild(el("span", {}, label));
      var track = el("div", { class: "track" });
      var fill = el("div", { class: "fill" });
      fill.style.width = (values[i] / max * 100).toFixed(1) + "%";
      track.appendChild(fill);
      host.appendChild(track);
      host.appendChild(el("span", { class: "v" }, duration(values[i])));
    });
  }

  var COLUMNS = [
    { key: "title", label: "Book" },
    { key: "seconds", label: "Time read", n: true },
    { key: "sessions", label: "Sessions", n: true },
    { key: "pages", label: "Pages", n: true },
    { key: "pace", label: "Pages/min", n: true },
    { key: "startDate", label: "Started" },
    { key: "finishedDate", label: "Finished" },
    { key: "progress", label: "Progress", n: true },
  ];

  function sortValue(book, key) {
    if (key === "pace") return pace(book);
    if (key === "title") return (book.title || book.path).toLowerCase();
    var v = book[key];
    return v == null ? "" : v;
  }

  function renderBooks(d) {
    var table = document.getElementById("books");
    table.textContent = "";
    if (!d.books.length) {
      var row = el("tr");
      row.appendChild(el("td", { class: "empty" }, "No books with reading stats."));
      table.appendChild(row);
      return;
    }
    var head = el("tr");
    COLUMNS.forEach(function (c) {
      var th = el("th", { scope: "col" }, c.label);
      if (c.n) th.style.textAlign = "right";
      if (sort.key === c.key) th.setAttribute("aria-sort", sort.ascending ? "ascending" : "descending");
      th.addEventListener("click", function () {
        sort = { key: c.key, ascending: sort.key === c.key ? !sort.ascending : c.key === "title" };
        renderBooks(data);
      });
      head.appendChild(th);
    });
    var thead = el("thead");
    thead.appendChild(head);
    table.appendChild(thead);
    var books = d.books.slice().sort(function (a, b) {
      var x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      var c = x < y ? -1 : x > y ? 1 : 0;
      return sort.ascending ? c : -c;
    });
    var tbody = el("tbody");
    books.forEach(function (book) {
      var tr = el("tr");
      var name = el("td");
      name.appendChild(el("div", { class: "title" }, book.title || book.path.split("/").pop()));
      if (book.author) name.appendChild(el("div", { class: "author" }, book.author));
      tr.appendChild(name);
      tr.appendChild(el("td", { class: "n" }, duration(book.seconds)));
      tr.appendChild(el("td", { class: "n" }, String(book.sessions)));
      tr.appendChild(el("td", { class: "n" }, String(book.pages)));
      tr.appendChild(el("td", { class: "n" }, pace(book) ? pace(book).toFixed(1) : ""));
      tr.appendChild(el("td", { class: "d" }, shortDate(book.startDate)));
      tr.appendChild(el("td", { class: "d" }, book.completed ? shortDate(book.finishedDate) || "Yes" : ""));
      tr.appendChild(el("td", { class: "n" }, book.completed ? "100%" : book.progress != null ? Math.round(book.progress) + "%" : ""));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function render() {
    renderTiles(data);
    renderHeatmap(data);
    renderBars("timeOfDay", TIME_OF_DAY, data.global.timeOfDay || [0, 0, 0, 0]);
    renderBars("dayOfWeek", WEEKDAYS, data.global.dayOfWeek || [0, 0, 0, 0, 0, 0, 0]);
    renderBooks(data);
  }

  // ---- Export --------------------------------------------------------------

  function backupName(prefix) { return prefix + " " + isoDay(new Date()) + ".json"; }

  function csv(d) {
    var quote = function (v) {
      v = v == null ? "" : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var rows = [["Title", "Author", "Path", "Minutes read", "Sessions", "Pages", "Pages per minute", "Started",
      "Finished", "Completed", "Progress %"]];
    d.books.forEach(function (b) {
      rows.push([b.title, b.author, b.path, Math.round(b.seconds / 60), b.sessions, b.pages,
        pace(b) ? pace(b).toFixed(2) : "", b.startDate || "", b.finishedDate || "", b.completed ? "yes" : "no",
        b.completed ? 100 : b.progress != null ? Math.round(b.progress) : ""]);
    });
    return rows.map(function (r) { return r.map(quote).join(","); }).join("\n") + "\n";
  }

  // The reader's import format: one record per line, meta first.
  function toJsonl(d) {
    var lines = [JSON.stringify({ type: "meta", format: "crossink-stats", version: 1 })];
    lines.push(JSON.stringify(Object.assign({}, d.global, { type: "global" })));
    if (d.daily) lines.push(JSON.stringify(Object.assign({}, d.daily, { type: "daily" })));
    d.books.forEach(function (b) { lines.push(JSON.stringify(Object.assign({}, b, { type: "book" }))); });
    return lines.join("\n") + "\n";
  }

  // ---- Restore -------------------------------------------------------------

  function showRestore(backup) {
    restorePanel.textContent = "";
    var when = backup.exported ? dateText(new Date(backup.exported)) : "an unknown date";
    restorePanel.appendChild(el("p", {}, "Restore the backup from " + when + ": " + duration(backup.global.seconds) +
      " read, " + backup.books.length + " books with stats. This replaces the reader's stats."));
    if (cardBooks) {
      var missing = backup.books.filter(function (b) { return !cardBooks.has(b.path); });
      if (missing.length) {
        restorePanel.appendChild(el("p", {}, (missing.length === 1 ? "1 of these books isn't" : missing.length +
          " of these books aren't") + " on this reader at the same path and will be skipped: " + missing.slice(0, 5).map(function (b) { return b.title || b.path; }).join(", ") +
          (missing.length > 5 ? "…" : "")));
      }
    }
    restorePanel.appendChild(el("p", {}, "A backup of the reader's current stats downloads first. The reader " +
      "restarts when the restore is done."));
    var bar = el("div", { class: "bar" });
    var go = el("button", { type: "button", class: "tool primary" }, "Restore");
    var cancel = el("button", { type: "button", class: "tool" }, "Cancel");
    go.addEventListener("click", function () { restore(backup); });
    cancel.addEventListener("click", function () { restorePanel.hidden = true; });
    bar.appendChild(go);
    bar.appendChild(cancel);
    restorePanel.appendChild(bar);
    restorePanel.hidden = false;
  }

  async function restore(backup) {
    if (busy) return;
    busy = true;
    restorePanel.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    try {
      var current = await loadFromReader();
      download(backupName("CrossInk stats before restore"), JSON.stringify(current, null, 1), "application/json");
      say("Restoring…");
      var result = await UsbSend.stats.restore(toJsonl(backup), function (f) {
        say("Restoring " + Math.round(f * 100) + "%");
      });
      restorePanel.hidden = true;
      cardBooks = null;
      connectButton.textContent = "Reconnect";
      say("Restored " + (result.books || 0) + " book" + (result.books === 1 ? "" : "s") +
        (result.skipped ? " (" + result.skipped + " not on this reader)" : "") +
        ". The reader is restarting; reconnect in a moment to see the restored stats.");
      show(backup, "Showing the restored backup.");
    } catch (e) {
      say(friendly(e), true);
      restorePanel.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
    } finally {
      busy = false;
    }
  }

  // ---- Events --------------------------------------------------------------

  connectButton.addEventListener("click", async function () {
    if (busy) return;
    busy = true;
    connectButton.disabled = true;
    try {
      var d = await loadFromReader();
      show(d, "From your reader" + (d.meta && d.meta.firmware ? " (firmware " + d.meta.firmware + ")" : "") +
        (d.meta && d.meta.today ? " · today is " + shortDate(d.meta.today) : ""));
      say("Connected");
      connectButton.textContent = "Refresh";
    } catch (e) {
      say(friendly(e), true);
    } finally {
      busy = false;
      connectButton.disabled = false;
    }
  });

  async function readBackupFile(input) {
    var file = input.files[0];
    input.value = "";
    if (!file) return null;
    try {
      var d = JSON.parse(await file.text());
      if (!validBackup(d)) throw new Error("bad");
      return d;
    } catch (e) {
      say("That file isn't a CrossInk stats backup.", true);
      return null;
    }
  }

  document.getElementById("openBackup").addEventListener("change", async function () {
    var d = await readBackupFile(this);
    if (!d) return;
    show(d, "From backup " + (d.exported ? "made " + dateText(new Date(d.exported)) : "file") + ".");
    say("Opened backup");
  });

  document.getElementById("restoreFile").addEventListener("change", async function () {
    var d = await readBackupFile(this);
    if (d) showRestore(d);
  });

  saveBackup.addEventListener("click", function () {
    if (data) download(backupName("CrossInk stats"), JSON.stringify(data, null, 1), "application/json");
  });
  saveCsv.addEventListener("click", function () {
    if (data) download("CrossInk books " + isoDay(new Date()) + ".csv", csv(data), "text/csv");
  });

  if (!UsbSend.supported) {
    connectButton.disabled = true;
    document.getElementById("restoreLabel").hidden = true;
    say("This browser can't use USB, but you can open a backup. Use Chrome or Edge to connect a reader.");
  }
})();
