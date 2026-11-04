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
  var sort = { key: "startDate", ascending: false };  // Newest started first

  // ---- Helpers -----------------------------------------------------------

  function dayDate(index) { return new Date(EPOCH + index * DAY_MS); }
  // Day index of a "YYYY-MM-DD" date, or null.
  function isoIndex(iso) { return iso ? Math.round((Date.parse(iso + "T00:00:00Z") - EPOCH) / DAY_MS) : null; }
  function monthIndex(year, month) { return Math.round((Date.UTC(year, month, 1) - EPOCH) / DAY_MS); }
  // Seconds read on a day, from the per-day log (about the last 6 months).
  function daySeconds(d, index) {
    if (!d.daily || !d.daily.anchorDay || index > d.daily.anchorDay) return 0;
    return d.daily.seconds[d.daily.anchorDay - index] || 0;
  }
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
  // Stable pages per minute, once the reader has measured 2 minutes of them
  // (books with stable page numbers, firmware 1.7.0+); 0 otherwise.
  function pagePace(book) {
    return book.stableSeconds >= 120 && book.stablePages ? book.stablePages * 60 / book.stableSeconds : 0;
  }
  // Screens turned forward per minute, for books without a stable pace yet.
  function screenPace(book) {
    if (pagePace(book)) return 0;
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

  // Loads everything from the reader. onUpdate(d, booksOnly) shows partial
  // results: first the overall stats, then books as they arrive (books still
  // shown from the last load stay until the reader has been read).
  async function loadFromReader(onUpdate) {
    say("Reading stats…");
    var g = await UsbSend.stats.global();
    var d = {
      format: "crossink-stats", version: 1, exported: new Date().toISOString(),
      meta: g.meta, global: g.global, daily: g.daily, books: [],
    };
    var known = new Map();
    if (onUpdate && data) data.books.forEach(function (b) { known.set(b.path, b); });
    var fresh = new Map();
    var lastUpdate = 0;
    function addBook(record) {
      fresh.set(record.path, record);
      known.set(record.path, record);
      if (onUpdate && Date.now() - lastUpdate > 250) {
        lastUpdate = Date.now();
        d.books = Array.from(known.values());
        onUpdate(d, true);
      }
    }
    if (onUpdate) { d.books = Array.from(known.values()); onUpdate(d, false); }

    var paths;
    try {
      // Firmware 1.6.0+: one stream for every book.
      say("Reading book stats…");
      paths = await UsbSend.stats.allBooks(addBook, function (folders) {
        say("Reading book stats… (" + folders + " folder" + (folders === 1 ? "" : "s") + ")");
      });
    } catch (e) {
      if (e.code !== "unknown_cmd") throw e;
      // Older firmware: list the card, then ask for each book.
      say("Finding books…");
      paths = (await UsbSend.listBooks()).map(function (b) { return b.path; })
        .filter(function (p) { return /\.(epub|xtch?)$/i.test(p); });
      for (var i = 0; i < paths.length; i++) {
        say("Reading book " + (i + 1) + " of " + paths.length + "…");
        var record = await UsbSend.stats.book(paths[i]);
        if (record) addBook(record);
      }
    }
    cardBooks = new Set(paths);
    d.books = Array.from(fresh.values());
    return d;
  }

  // The last stats loaded from a reader, shown straight away next time.
  var CACHE_KEY = "crossink-stats-last";
  function saveLast(d) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* not kept */ }
  }
  function loadLast() {
    try {
      var d = JSON.parse(localStorage.getItem(CACHE_KEY));
      return validBackup(d) ? d : null;
    } catch (e) { return null; }
  }
  function ago(iso) {
    var minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 2) return "just now";
    if (minutes < 60) return minutes + " minutes ago";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + " hour" + (hours === 1 ? "" : "s") + " ago";
    var days = Math.round(hours / 24);
    return days + " day" + (days === 1 ? "" : "s") + " ago";
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
      [d.global.pages.toLocaleString(), "Screen turns"],
      [(d.global.currentStreak || 0) + "d", "Current streak"],
      [(d.global.longestStreak || 0) + "d", "Longest streak"],
    ].concat(averageTiles(d)).forEach(function (t) {
      var tile = el("div", { class: "tile" });
      tile.appendChild(el("b", {}, String(t[0])));
      tile.appendChild(el("span", {}, t[1]));
      tiles.appendChild(tile);
    });
  }

  // Averages: per session, per reading day and how often you read.
  function averageTiles(d) {
    var today = todayIndex(d);
    var tiles = [[d.global.sessions ? duration(d.global.seconds / d.global.sessions) : "–", "Avg session"]];
    var seconds = 0, days = 0;
    for (var i = today - 29; i <= today; i++) {
      if (dayLevel(d, i).level) days++;
      seconds += daySeconds(d, i);
    }
    tiles.push([days ? duration(seconds / days) : "–", "Avg day (30d)"]);
    tiles.push([days + "/30", "Days read (30d)"]);
    var year = dayDate(today).getUTCFullYear();
    var yearDays = 0;
    for (var j = monthIndex(year, 0); j <= today; j++) if (dayLevel(d, j).level) yearDays++;
    tiles.push([Math.round(yearDays * 100 / (today - monthIndex(year, 0) + 1)) + "%", "Days read in " + year]);
    return tiles;
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

  // Like the Reading Heatmap sleep screen: each month is its own block, a
  // column per Monday-based week it touches, with a gap between months and
  // the weekday labels beside the current month.
  function renderHeatmap(d) {
    var host = document.getElementById("heat");
    host.textContent = "";
    var today = todayIndex(d);
    // Weeks start on Monday; day index 0 (Jan 1, 2000) was a Saturday.
    var weekday = function (index) { return (index + 5) % 7; };
    var cell = 10, gap = 2, pitch = cell + gap, monthGap = 8, top = 14, labelWidth = 26;
    var todayDate = dayDate(today);
    var months = [];
    for (var back = 23; back >= 0; back--) {
      var first = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() - back, 1));
      var next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      var firstIndex = Math.round((first.getTime() - EPOCH) / DAY_MS);
      // The current month ends at this week.
      var shownDays = back === 0 ? today - firstIndex + 1 : Math.round((next - first) / DAY_MS);
      months.push({ first: first, firstIndex: firstIndex, days: shownDays, offset: weekday(firstIndex),
                    columns: Math.ceil((weekday(firstIndex) + shownDays) / 7) });
    }
    var x = 0;
    months.forEach(function (m) { m.x = x; x += m.columns * pitch - gap + monthGap; });
    var gridWidth = x - monthGap;

    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", gridWidth + 6 + labelWidth);
    svg.setAttribute("height", top + 7 * pitch);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Reading days for the last two years");
    var text = function (x, y, label, anchor) {
      var t = document.createElementNS(ns, "text");
      t.setAttribute("x", x);
      t.setAttribute("y", y);
      if (anchor) t.setAttribute("text-anchor", anchor);
      t.textContent = label;
      svg.appendChild(t);
    };
    ["Mon", "", "Wed", "", "Fri", "", "Sun"].forEach(function (label, row) {
      if (label) text(gridWidth + 6, top + row * pitch + cell - 1, label);
    });
    var shades = ["var(--l0)", "var(--l1)", "var(--l2)", "var(--l3)"];
    var readDays = 0;
    months.forEach(function (m) {
      var month = m.first.getUTCMonth();
      text(m.x + (m.columns * pitch - gap) / 2, 9,
           MONTHS[month] + (month === 0 ? " " + m.first.getUTCFullYear() : ""), "middle");
      for (var day = 0; day < m.days; day++) {
        var index = m.firstIndex + day;
        var info = dayLevel(d, index);
        if (info.level) readDays++;
        var rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", m.x + Math.floor((m.offset + day) / 7) * pitch);
        rect.setAttribute("y", top + weekday(index) * pitch);
        rect.setAttribute("width", cell);
        rect.setAttribute("height", cell);
        rect.setAttribute("rx", 2);
        rect.setAttribute("fill", shades[info.level]);
        var title = document.createElementNS(ns, "title");
        title.textContent = dateText(dayDate(index)) + ": " + (info.seconds ? duration(info.seconds) :
          info.read ? "read" : "no reading");
        rect.appendChild(title);
        svg.appendChild(rect);
      }
    });
    host.appendChild(svg);
    host.scrollLeft = host.scrollWidth;  // Most recent months in view
    document.getElementById("heatNote").textContent = readDays + " reading days";
  }

  // The reader's estimated finish date: time left spread at the book's
  // average reading time per calendar day since it was started
  // (BookReadingStats::estimateFinishDate).
  function finishIndex(book, today) {
    var left = book.timeLeftSeconds || 0;
    if (!left) return null;
    var calendar = left;
    var start = isoIndex(book.startDate);
    if (start != null && book.seconds > 0) {
      calendar = left * Math.max(1, today - start) * 86400 / book.seconds;
    }
    return today + Math.round(calendar / 86400);
  }

  function renderCurrent(d) {
    var host = document.getElementById("current");
    host.textContent = "";
    var today = todayIndex(d);
    // Books read for at least 15 minutes, so ones only opened to look don't count.
    var books = d.books.filter(function (b) {
      return !b.completed && !b.deleted && b.progress != null && b.progress > 0 && b.progress < 100 &&
        b.seconds >= 15 * 60;
    }).sort(function (a, b) { return (b.startDate || "").localeCompare(a.startDate || ""); }).slice(0, 6);
    document.getElementById("currentCard").hidden = !books.length;
    books.forEach(function (book) {
      var item = el("div", { class: "reading" });
      item.appendChild(el("div", { class: "title" }, book.title || book.path.split("/").pop()));
      if (book.author) item.appendChild(el("div", { class: "author" }, book.author));
      var track = el("div", { class: "track" });
      var fill = el("div", { class: "fill" });
      fill.style.width = Math.min(100, book.progress).toFixed(1) + "%";
      track.appendChild(fill);
      item.appendChild(track);
      var parts = [Math.round(book.progress) + "%"];
      if (book.timeLeftSeconds) parts.push(duration(book.timeLeftSeconds) + " left");
      var finish = finishIndex(book, today);
      item.appendChild(el("div", { class: "meta" }, parts.join(" · ")));
      if (finish != null) {
        var date = dayDate(finish);
        item.appendChild(el("div", { class: "meta" }, "Finish ~" + MONTHS[date.getUTCMonth()] + " " + date.getUTCDate() +
          (date.getUTCFullYear() !== dayDate(today).getUTCFullYear() ? ", " + date.getUTCFullYear() : "")));
      }
      host.appendChild(item);
    });
  }

  // Time read in each month the per-day log fully covers, and this month.
  function renderMonths(d) {
    var today = todayIndex(d);
    var now = dayDate(today);
    var oldest = d.daily && d.daily.anchorDay ? d.daily.anchorDay - d.daily.seconds.length + 1 : today;
    var labels = [], values = [];
    for (var back = 0; back < 6; back++) {
      var first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      var start = monthIndex(first.getUTCFullYear(), first.getUTCMonth());
      if (back > 0 && start < oldest) break;
      var end = back === 0 ? today : monthIndex(first.getUTCFullYear(), first.getUTCMonth() + 1) - 1;
      var seconds = 0;
      for (var i = start; i <= end; i++) seconds += daySeconds(d, i);
      labels.unshift(MONTHS[first.getUTCMonth()] + (first.getUTCMonth() === 0 || back === 5 ? " " + first.getUTCFullYear() : ""));
      values.unshift(seconds);
    }
    renderBars("months", labels, values);
  }

  // Finished books, newest first, grouped by month, with the days each took.
  function renderFinished(d) {
    var host = document.getElementById("finished");
    host.textContent = "";
    var books = d.books.filter(function (b) { return b.completed; })
      .sort(function (a, b) { return (b.finishedDate || "").localeCompare(a.finishedDate || ""); });
    if (!books.length) {
      host.appendChild(el("p", { class: "empty" }, "No finished books yet."));
      return;
    }
    var year = dayDate(todayIndex(d)).getUTCFullYear();
    var thisYear = books.filter(function (b) { return (b.finishedDate || "").slice(0, 4) === String(year); }).length;
    document.getElementById("finishedNote").textContent = thisYear + " in " + year;
    var group = null;
    books.forEach(function (book) {
      var date = book.finishedDate ? new Date(book.finishedDate + "T00:00:00Z") : null;
      var heading = date ? MONTHS[date.getUTCMonth()] + " " + date.getUTCFullYear() : "Date unknown";
      if (heading !== group) {
        group = heading;
        host.appendChild(el("h3", {}, heading));
      }
      var row = el("div", { class: "done" });
      row.appendChild(el("span", { class: "title" }, book.title || book.path.split("/").pop()));
      var start = isoIndex(book.startDate), finish = isoIndex(book.finishedDate);
      var parts = [];
      if (date) parts.push(MONTHS[date.getUTCMonth()] + " " + date.getUTCDate());
      if (start != null && finish != null && finish >= start) {
        var days = finish - start;
        parts.push(days === 0 ? "same day" : days + (days === 1 ? " day" : " days"));
      }
      row.appendChild(el("span", { class: "meta" }, parts.join(" · ")));
      host.appendChild(row);
    });
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
    { key: "pages", label: "Screen turns", n: true },
    { key: "stablePages", label: "Pages read", n: true },
    { key: "pagePace", label: "Pg/min", n: true },
    { key: "screenPace", label: "Scr/min", n: true },
    { key: "startDate", label: "Started" },
    { key: "finishedDate", label: "Finished" },
    { key: "progress", label: "Progress", n: true },
  ];

  function sortValue(book, key) {
    if (key === "pagePace") return pagePace(book);
    if (key === "screenPace") return screenPace(book);
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
      if (book.deleted) name.appendChild(el("div", { class: "gone" }, "No longer on the reader"));
      tr.appendChild(name);
      tr.appendChild(el("td", { class: "n" }, duration(book.seconds)));
      tr.appendChild(el("td", { class: "n" }, String(book.sessions)));
      tr.appendChild(el("td", { class: "n" }, String(book.pages)));
      tr.appendChild(el("td", { class: "n" }, book.stablePages != null ? String(book.stablePages) : ""));
      tr.appendChild(el("td", { class: "n" }, pagePace(book) ? pagePace(book).toFixed(1) : ""));
      tr.appendChild(el("td", { class: "n" }, screenPace(book) ? screenPace(book).toFixed(1) : ""));
      tr.appendChild(el("td", { class: "d" }, shortDate(book.startDate)));
      tr.appendChild(el("td", { class: "d" }, book.completed ? shortDate(book.finishedDate) || "Yes" : ""));
      tr.appendChild(el("td", { class: "n" }, book.completed ? "100%" : book.progress != null ? Math.round(book.progress) + "%" : ""));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function render() {
    renderTiles(data);
    renderCurrent(data);
    renderHeatmap(data);
    renderMonths(data);
    renderFinished(data);
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
    var rows = [["Title", "Author", "Path", "Minutes read", "Sessions", "Screen turns", "Pages read", "Pages per minute",
      "Screens per minute", "Started", "Finished", "Completed", "Progress %", "On reader"]];
    d.books.forEach(function (b) {
      rows.push([b.title, b.author, b.path, Math.round(b.seconds / 60), b.sessions, b.pages,
        b.stablePages != null ? b.stablePages : "", pagePace(b) ? pagePace(b).toFixed(2) : "",
        screenPace(b) ? screenPace(b).toFixed(2) : "", b.startDate || "", b.finishedDate || "", b.completed ? "yes" : "no",
        b.completed ? 100 : b.progress != null ? Math.round(b.progress) : "", b.deleted ? "no" : "yes"]);
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
        // Firmware 1.8.2+ keeps their stats as deleted books; older firmware skips them.
        var kept = keepsDeletedBooks();
        restorePanel.appendChild(el("p", {}, (missing.length === 1 ? "1 of these books isn't" : missing.length +
          " of these books aren't") + " on this reader at the same path" +
          (kept ? "; their stats are restored and listed as no longer on the reader: " : " and will be skipped: ") +
          missing.slice(0, 5).map(function (b) { return b.title || b.path; }).join(", ") +
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

  function keepsDeletedBooks() {
    var m = /extras (\d+)\.(\d+)\.(\d+)/.exec((Reader.info && Reader.info.firmware) || "");
    if (!m) return false;
    var v = [Number(m[1]), Number(m[2]), Number(m[3])], min = [1, 8, 2];
    for (var i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
    return true;
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
      say("Restored " + (result.books || 0) + " book" + (result.books === 1 ? "" : "s") +
        (result.skipped ? " (" + result.skipped + " not on this reader)" : "") +
        ". The reader is restarting; this page reconnects and shows its stats when it's back.");
      show(backup, "Showing the restored backup.");
    } catch (e) {
      say(friendly(e), true);
      restorePanel.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
    } finally {
      busy = false;
    }
  }

  // ---- Events --------------------------------------------------------------

  async function loadReader() {
    if (busy) return;
    busy = true;
    connectButton.disabled = true;
    try {
      var d = await loadFromReader(function (partial, booksOnly) {
        if (booksOnly) { data = partial; renderBooks(partial); }
        else show(partial, "Updating from your reader…");
      });
      show(d, "From your reader" + (d.meta && d.meta.firmware ? " (firmware " + d.meta.firmware + ")" : "") +
        (d.meta && d.meta.today ? " · today is " + shortDate(d.meta.today) : ""));
      saveLast(d);
      say("Loaded from your reader");
      connectButton.textContent = "Refresh";
    } catch (e) {
      say(friendly(e), true);
    } finally {
      busy = false;
      connectButton.disabled = false;
    }
  }

  // Loads whenever the reader strip (reader.js) connects, including after a
  // restore restarts the reader.
  connectButton.addEventListener("click", function () {
    if (Reader.connected) loadReader(); else Reader.connect();
  });
  Reader.onConnect(loadReader);
  Reader.onDisconnect(function () {
    cardBooks = null;
    connectButton.textContent = "Load from reader";
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

  var last = loadLast();
  if (last) show(last, "Last loaded from your reader " + ago(last.exported) + ".");

  if (!UsbSend.supported) {
    connectButton.disabled = true;
    document.getElementById("restoreLabel").hidden = true;
    say("This browser can't use USB, but you can open a backup. Use Chrome or Edge to connect a reader.");
  }
})();
