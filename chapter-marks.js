// Chapter-mark editor for optimized EPUBs. Lists the book's table of contents
// with checkboxes, pre-checked with what CrossInk picks automatically, and
// writes the choice to META-INF/crossink/chapter-marks.json, which the
// firmware uses for the chapter marks on its progress bars. Mirrors the
// firmware (src/activities/reader/BookProgressDetails.cpp): nav document
// before toc.ncx, links matched by path then filename, and the automatic
// level rule.
(function () {
  "use strict";

  var MARKS_PATH = "META-INF/crossink/chapter-marks.json";
  var MIN_AUTO_MARKS = 5;
  var MAX_AUTO_MARKS = 50;
  var MAX_MARKS = 64;
  var MIN_GAP = 0.013;  // kBookProgressMinChapterTickPermille

  function dirname(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i + 1);
  }

  function normalize(path) {
    var out = [];
    path.split("/").forEach(function (part) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    });
    return out.join("/");
  }

  function decode(text) {
    try { return decodeURIComponent(text); } catch (e) { return text; }
  }

  function parseXml(text, type) {
    var doc = new DOMParser().parseFromString(text, type || "application/xml");
    return doc.getElementsByTagName("parsererror").length ? null : doc;
  }

  function byLocalName(node, name) {
    return Array.prototype.filter.call(node.children || [], function (c) { return c.localName === name; });
  }

  // Splits a TOC link into the zip path of its file and its anchor.
  function resolveLink(baseDir, href) {
    var hash = href.indexOf("#");
    var file = hash < 0 ? href : href.slice(0, hash);
    return { path: normalize(baseDir + decode(file)), anchor: hash < 0 ? "" : decode(href.slice(hash + 1)) };
  }

  // Reads the book's TOC as [{title, level, path, anchor, spineIndex}].
  async function readToc(zip) {
    var container = parseXml(await zip.file("META-INF/container.xml").async("string"));
    var opfPath = container.getElementsByTagNameNS("*", "rootfile")[0].getAttribute("full-path");
    var opf = parseXml(await zip.file(opfPath).async("string"));
    var opfDir = dirname(opfPath);
    var manifest = {};
    var navPath = null;
    var ncxPath = null;
    Array.prototype.forEach.call(opf.getElementsByTagNameNS("*", "item"), function (item) {
      var path = normalize(opfDir + decode(item.getAttribute("href") || ""));
      manifest[item.getAttribute("id")] = path;
      if (/(^|\s)nav(\s|$)/.test(item.getAttribute("properties") || "")) navPath = path;
      if (item.getAttribute("media-type") === "application/x-dtbncx+xml") ncxPath = path;
    });
    var spineEl = opf.getElementsByTagNameNS("*", "spine")[0];
    if (spineEl.getAttribute("toc") && manifest[spineEl.getAttribute("toc")]) ncxPath = manifest[spineEl.getAttribute("toc")];
    var spine = Array.prototype.map.call(spineEl.getElementsByTagNameNS("*", "itemref"), function (ref) {
      return manifest[ref.getAttribute("idref")];
    });

    var entries = [];
    if (navPath && zip.file(navPath)) {
      var nav = parseXml(await zip.file(navPath).async("string"), "application/xhtml+xml");
      var tocNav = nav && Array.prototype.filter.call(nav.getElementsByTagNameNS("*", "nav"), function (n) {
        var type = n.getAttributeNS("http://www.idpf.org/2007/ops", "type") || n.getAttribute("epub:type") || "";
        return /(^|\s)toc(\s|$)/.test(type);
      })[0];
      var walkNav = function (ol, level) {
        byLocalName(ol, "li").forEach(function (li) {
          var link = byLocalName(li, "a")[0];
          if (link && link.getAttribute("href")) {
            var target = resolveLink(dirname(navPath), link.getAttribute("href"));
            entries.push({ title: link.textContent.trim(), level: level, path: target.path, anchor: target.anchor });
          }
          byLocalName(li, "ol").forEach(function (child) { walkNav(child, level + 1); });
        });
      };
      if (tocNav) byLocalName(tocNav, "ol").forEach(function (ol) { walkNav(ol, 1); });
    }
    if (!entries.length && ncxPath && zip.file(ncxPath)) {
      var ncx = parseXml(await zip.file(ncxPath).async("string"));
      var walkNcx = function (parent, level) {
        byLocalName(parent, "navPoint").forEach(function (point) {
          var label = point.getElementsByTagNameNS("*", "text")[0];
          var content = byLocalName(point, "content")[0];
          if (content && content.getAttribute("src")) {
            var target = resolveLink(dirname(ncxPath), content.getAttribute("src"));
            entries.push({ title: label ? label.textContent.trim() : "", level: level, path: target.path, anchor: target.anchor });
          }
          walkNcx(point, level + 1);
        });
      };
      var navMap = ncx && ncx.getElementsByTagNameNS("*", "navMap")[0];
      if (navMap) walkNcx(navMap, 1);
    }

    entries.forEach(function (entry) {
      entry.spineIndex = spine.indexOf(entry.path);
      if (entry.spineIndex < 0) {
        var name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        entry.spineIndex = spine.findIndex(function (p) { return p && p.slice(p.lastIndexOf("/") + 1) === name; });
      }
    });
    return entries;
  }

  // The entries CrossInk marks automatically (chooseChapterLevel).
  function autoSelection(entries) {
    var counts = {};
    entries.forEach(function (e) { counts[e.level] = (counts[e.level] || 0) + 1; });
    var levels = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    var chosen = null, shallowest = null, shallowestPair = null;
    levels.forEach(function (level) {
      if (chosen !== null) return;
      if (counts[level] >= MIN_AUTO_MARKS && counts[level] <= MAX_AUTO_MARKS) chosen = level;
      if (shallowest === null) shallowest = level;
      if (counts[level] >= 2 && shallowestPair === null) shallowestPair = level;
    });
    if (chosen === null) chosen = shallowestPair !== null ? shallowestPair : shallowest;
    var picked = [];
    entries.forEach(function (e, i) {
      if (e.level === chosen && e.spineIndex >= 0 && picked.length < MAX_MARKS) picked.push(i);
    });
    return picked;
  }

  // Each entry's position in the book, 0-1, from the stable-page character
  // counts; an anchored chapter is placed where its id appears in its file.
  async function positions(zip, entries) {
    var file = zip.file("META-INF/x-locations.json");
    var xl = file ? JSON.parse(await file.async("string")) : null;
    var texts = {};
    var out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.spineIndex < 0 || !xl || !xl.spine[e.spineIndex] || !xl.totalCharacters) { out.push(null); continue; }
      var span = xl.spine[e.spineIndex];
      var within = 0;
      if (e.anchor && zip.file(e.path)) {
        if (!(e.path in texts)) texts[e.path] = await zip.file(e.path).async("string");
        var text = texts[e.path];
        var escaped = e.anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var match = new RegExp("\\sid\\s*=\\s*[\"']" + escaped + "[\"']").exec(text);
        if (match) within = match.index / text.length;
      }
      out.push((span.characterStart + within * span.characterCount) / xl.totalCharacters);
    }
    return out;
  }

  async function readSaved(zip, entries) {
    var file = zip.file(MARKS_PATH);
    if (!file) return null;
    try {
      var doc = JSON.parse(await file.async("string"));
      var picked = [];
      (doc.marks || []).forEach(function (mark) {
        var i = entries.findIndex(function (e) { return e.path === mark.href && e.anchor === (mark.anchor || ""); });
        if (i >= 0) picked.push(i);
      });
      return picked;
    } catch (e) {
      return null;
    }
  }

  function sameSelection(a, b) {
    return a.length === b.length && a.every(function (v, i) { return v === b[i]; });
  }

  // Adds the editor under an optimized book. base is its blob; link is its
  // download link, which is updated when the marks are saved.
  async function attach(container, base, link) {
    var zip = await JSZip.loadAsync(base);
    var entries = await readToc(zip);
    if (!entries.length) return;
    var auto = autoSelection(entries);
    var where = await positions(zip, entries);
    var saved = await readSaved(zip, entries);
    var selected = new Set(saved || auto);

    var panel = document.createElement("details");
    panel.className = "marks";
    var summary = document.createElement("summary");
    panel.appendChild(summary);
    var help = document.createElement("p");
    help.className = "marks-help";
    help.textContent = "Choose which entries get a mark on the progress bars. Marks closer than about 1% are merged, " +
      "and a chapter at the very start of the book has no mark.";
    panel.appendChild(help);
    var bar = document.createElement("div");
    bar.className = "markbar";
    bar.setAttribute("aria-hidden", "true");
    panel.appendChild(bar);
    var list = document.createElement("div");
    list.className = "toc-list";
    panel.appendChild(list);
    var actions = document.createElement("div");
    actions.className = "marks-actions";
    var reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Use automatic";
    var save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save marks";
    actions.appendChild(reset);
    actions.appendChild(save);
    panel.appendChild(actions);

    var savedSelection = saved || auto;
    function current() { return Array.from(selected).sort(function (a, b) { return a - b; }); }
    function describe(picked) {
      return sameSelection(picked, auto) ? "automatic, " + picked.length : "custom, " + picked.length;
    }
    function render() {
      var picked = current();
      summary.textContent = "Chapter marks (" + describe(savedSelection) + ")" +
        (sameSelection(picked, savedSelection) ? "" : " · unsaved changes");
      bar.textContent = "";
      var last = 0;
      picked.map(function (i) { return where[i]; }).filter(function (p) { return p !== null; })
        .sort(function (a, b) { return a - b; })
        .forEach(function (p) {
          if (p - last < MIN_GAP || p >= 0.999) return;
          last = p;
          var tick = document.createElement("i");
          tick.style.left = (p * 100).toFixed(2) + "%";
          bar.appendChild(tick);
        });
      save.disabled = sameSelection(picked, savedSelection);
    }

    entries.forEach(function (entry, i) {
      var row = document.createElement("label");
      row.className = "toc-row";
      row.style.paddingLeft = (entry.level - 1) * 16 + "px";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(i);
      box.disabled = entry.spineIndex < 0;
      box.addEventListener("change", function () {
        if (box.checked) selected.add(i); else selected.delete(i);
        render();
      });
      var title = document.createElement("span");
      title.className = "toc-title";
      title.textContent = entry.title || "(untitled)";
      var pos = document.createElement("span");
      pos.className = "toc-pos";
      pos.textContent = where[i] === null ? "" : Math.round(where[i] * 1000) / 10 + "%";
      row.appendChild(box);
      row.appendChild(title);
      row.appendChild(pos);
      list.appendChild(row);
    });

    reset.addEventListener("click", function () {
      selected = new Set(auto);
      Array.prototype.forEach.call(list.querySelectorAll("input"), function (box, i) { box.checked = selected.has(i); });
      render();
    });

    save.addEventListener("click", async function () {
      save.disabled = true;
      var picked = current();
      var out = await JSZip.loadAsync(base);
      if (sameSelection(picked, auto)) {
        out.remove(MARKS_PATH);  // The firmware picks these by itself
      } else {
        out.file(MARKS_PATH, JSON.stringify({
          format: "crossink-chapter-marks", version: 1,
          marks: picked.map(function (i) {
            return { href: entries[i].path, anchor: entries[i].anchor, title: entries[i].title };
          }),
        }, null, 1));
      }
      out.file("mimetype", "application/epub+zip", { compression: "STORE" });  // Stays first and uncompressed
      var blob = await out.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/epub+zip" });
      URL.revokeObjectURL(link.href);
      link.href = URL.createObjectURL(blob);
      link.textContent = sameSelection(picked, auto) ? "Download" : "Download with custom marks";
      savedSelection = picked;
      render();
    });

    render();
    container.appendChild(panel);
  }

  window.ChapterMarks = { attach: attach, readToc: readToc, autoSelection: autoSelection };
})();
