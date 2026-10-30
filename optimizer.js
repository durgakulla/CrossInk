// Drives CrossInk's web-portal EPUB converter (vendor/crossink-files.js,
// unchanged) from this page, after repairing double-encoded text and removing
// embedded fonts, with an optional contrast boost for images. Everything
// runs in the browser; books never leave this computer.
(function () {
  "use strict";

  var TEXT_FILE = /\.(x?html?|ncx|opf|xml)$/i;
  // A UTF-8 lead byte and its continuation bytes, each read as Latin-1, e.g.
  // "’" (E2 80 99) saved again as "â" + U+0080 + U+0099.
  var MOJIBAKE = /[Â-ß][\u0080-¿]|[à-ï][\u0080-¿]{2}|[ð-ô][\u0080-¿]{3}/g;
  // A double-encoded no-break space whose second half was collapsed as
  // whitespace leaves a lone "Â" (e.g. between the dots of ". . .").
  var LONE_A_CIRCUMFLEX = /Â(?![\u0080-¿])/g;
  var decoder = new TextDecoder("utf-8", { fatal: true });

  var picker = document.getElementById("books");
  var drop = document.getElementById("drop");
  var start = document.getElementById("start");
  var queue = document.getElementById("queue");
  var quality = document.getElementById("qualityOption");
  var qualityValue = document.getElementById("qualityValue");
  var grayscale = document.getElementById("grayscaleOption");
  var repairToggle = document.getElementById("repairToggle");
  var removeFontsToggle = document.getElementById("removeFontsToggle");
  var nameOption = document.getElementById("nameOption");
  var usbFolder = document.getElementById("usbFolder");
  var pending = [];
  var busy = false;

  function unmangle(sequence) {
    var bytes = new Uint8Array(sequence.length);
    for (var i = 0; i < sequence.length; i++) bytes[i] = sequence.charCodeAt(i);
    try {
      return decoder.decode(bytes);
    } catch (e) {
      return sequence;  // Not a real UTF-8 sequence; leave it alone
    }
  }

  var FONT_FILE = /\.(ttf|otf|woff2?|eot)$/i;
  var FONT_TYPE = /font|opentype|truetype|woff/i;
  var FONT_OBFUSCATION = ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];
  var FONT_FACE = /@font-face\s*\{[^{}]*\}/gi;

  function dirname(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i + 1);
  }

  function resolvePath(base, href) {
    var out = [];
    (base + decodeURIComponent(href.split("#")[0])).split("/").forEach(function (part) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    });
    return out.join("/");
  }

  // Removes embedded fonts, which CrossInk never uses (its CSS parser skips
  // @font-face): the font files, their manifest items, their obfuscation
  // entries in META-INF/encryption.xml and the @font-face rules. Returns the
  // number of font files removed and the bytes saved.
  async function removeFonts(zip, texts) {
    var container = await zip.file("META-INF/container.xml").async("string");
    var opfPath = /full-path="([^"]+)"/.exec(container)[1];
    var opfDir = dirname(opfPath);
    var fonts = new Set();
    texts[opfPath] = texts[opfPath].replace(/<item\b[^>]*>/gi, function (tag) {
      var href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
      var type = /\bmedia-type\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!href) return tag;
      var path = resolvePath(opfDir, href[1]);
      if (!FONT_FILE.test(path) && !(type && FONT_TYPE.test(type[1]))) return tag;
      fonts.add(path);
      return "";
    });
    var encryption = zip.file("META-INF/encryption.xml");
    if (encryption) {
      // Obfuscated fonts may use any file name, so their algorithm marks them.
      var xml = await encryption.async("string");
      var kept = 0;
      var cleaned = xml.replace(/<(\w+:)?EncryptedData\b[\s\S]*?<\/(\w+:)?EncryptedData>/g, function (block) {
        var uri = /URI\s*=\s*["']([^"']+)["']/.exec(block);
        var obfuscated = FONT_OBFUSCATION.some(function (alg) { return block.indexOf(alg) >= 0; });
        if (uri && (obfuscated || fonts.has(resolvePath("", uri[1])))) {
          fonts.add(resolvePath("", uri[1]));
          return "";
        }
        kept++;
        return block;
      });
      if (kept === 0) zip.remove("META-INF/encryption.xml");
      else zip.file("META-INF/encryption.xml", cleaned);
    }
    var saved = 0;
    var removed = 0;
    fonts.forEach(function (path) {
      var entry = zip.file(path);
      if (!entry) return;
      saved += entry._data && entry._data.uncompressedSize ? entry._data.uncompressedSize : 0;
      zip.remove(path);
      removed++;
    });
    Object.keys(texts).forEach(function (name) {
      if (/\.(css|x?html?)$/i.test(name)) texts[name] = texts[name].replace(FONT_FACE, "");
    });
    return { removed: removed, saved: saved };
  }

  // Prepares a book for CrossInk's converter: repairs double-encoded text
  // and removes embedded fonts, as chosen. Returns what was changed and,
  // when anything was, the rewritten EPUB.
  async function prepare(file, options) {
    var zip = await JSZip.loadAsync(file);
    var names = Object.keys(zip.files).filter(function (n) {
      return !zip.files[n].dir && (TEXT_FILE.test(n) || /\.css$/i.test(n));
    });
    var texts = {};
    var originals = {};
    for (var i = 0; i < names.length; i++) {
      texts[names[i]] = originals[names[i]] = await zip.file(names[i]).async("string");
    }
    var result = { fixed: 0, fontsRemoved: 0, fontBytes: 0, file: file };

    if (options.repair) {
      names.forEach(function (name) {
        if (!TEXT_FILE.test(name)) return;
        texts[name] = texts[name].replace(MOJIBAKE, function (m) {
          var out = unmangle(m);
          if (out !== m) result.fixed++;
          return out;
        });
      });
      // Only a book that was double-encoded gets its lone "Â"s restored.
      if (result.fixed) {
        names.forEach(function (name) {
          if (!TEXT_FILE.test(name)) return;
          texts[name] = texts[name].replace(LONE_A_CIRCUMFLEX, function () {
            result.fixed++;
            return "\u00a0";
          });
        });
      }
    }
    if (options.removeFonts) {
      var fonts = await removeFonts(zip, texts);
      result.fontsRemoved = fonts.removed;
      result.fontBytes = fonts.saved;
    }

    var changed = result.fontsRemoved > 0;
    names.forEach(function (name) {
      if (texts[name] !== originals[name]) {
        zip.file(name, texts[name]);
        changed = true;
      }
    });
    if (!changed) return result;
    var blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/epub+zip" });
    result.file = new File([blob], file.name, { type: "application/epub+zip" });
    return result;
  }

  // Contrast boost: wraps the converter's grayscale step (used for every
  // grayscale image, before the 4-level e-ink sidecars are built from it) to
  // stretch each image's levels so its darkest 0.5% becomes black and its
  // lightest 0.5% white. The stretch is capped at MAX_CONTRAST_GAIN so a
  // deliberately dark or light picture keeps its look instead of blowing up
  // its noise; a capped stretch keeps whichever end is already black or
  // white. Already full-range or nearly flat images are left alone.
  var MAX_CONTRAST_GAIN = 2;
  var contrastToggle = document.getElementById("contrastToggle");
  var convertGrayscale = window.applyGrayscale;
  window.applyGrayscale = function (ctx, width, height) {
    convertGrayscale(ctx, width, height);
    if (contrastToggle.checked) boostContrast(ctx, width, height);
  };

  function boostContrast(ctx, width, height) {
    var image = ctx.getImageData(0, 0, width, height);
    var data = image.data;
    var histogram = new Uint32Array(256);
    for (var i = 0; i < data.length; i += 4) {
      histogram[Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)]++;
    }
    var pixels = data.length / 4;
    var clip = pixels * 0.005;
    var low = 0, high = 255, count = 0;
    while (low < 255 && (count += histogram[low]) <= clip) low++;
    count = 0;
    while (high > 0 && (count += histogram[high]) <= clip) high--;
    if (high - low < 32 || (low <= 4 && high >= 251)) return;
    var gain = Math.min(255 / (high - low), MAX_CONTRAST_GAIN);
    // Where the stretched range starts: at black, unless it is capped and the
    // image's light end is the one already at white.
    var start = 0;
    if (gain < 255 / (high - low)) {
      if (high >= 251) start = 255 - (high - low) * gain;
      else if (low > 4) start = (low + high) / 2 - (high - low) * gain / 2;
    }
    var map = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) map[v] = Math.round(start + (v - low) * gain);
    for (var j = 0; j < data.length; j += 4) {
      data[j] = map[data[j]];
      data[j + 1] = map[data[j + 1]];
      data[j + 2] = map[data[j + 2]];
    }
    ctx.putImageData(image, 0, 0);
  }

  // The book's title and first author from its metadata, using the
  // converter's own helpers. An author stored as "Last, First" becomes
  // "First Last".
  async function readTitleAuthor(file) {
    var zip = await JSZip.loadAsync(file);
    var opfPath = await findOPFPath(zip);
    if (!opfPath) return null;
    var doc = new DOMParser().parseFromString(await safeReadText(zip.files[opfPath]), "application/xml");
    if (doc.querySelector("parsererror")) return null;
    var titleEl = doc.getElementsByTagNameNS("*", "title")[0];
    var creators = Array.prototype.slice.call(doc.getElementsByTagNameNS("*", "creator"));
    var role = function (el) {
      return (el.getAttribute("role") || el.getAttribute("opf:role") ||
        el.getAttributeNS("http://www.idpf.org/2007/opf", "role") || "").toLowerCase();
    };
    var authorEl = creators.filter(function (el) { return role(el) === "aut"; })[0] ||
      creators.filter(function (el) { return !role(el); })[0];
    var author = authorEl ? authorEl.textContent.trim() : "";
    var lastFirst = /^([^,]+),\s*([^,]+)$/.exec(author);
    if (lastFirst) author = lastFirst[2] + " " + lastFirst[1];
    return {
      title: sanitizeMetadataFilenamePart(titleEl ? titleEl.textContent : ""),
      author: sanitizeMetadataFilenamePart(author),
    };
  }

  // "Title - Author.epub" or "Author - Title.epub"; the original name when
  // the book has no title. Names are made unique within this batch.
  var usedNames = new Set();
  async function outputName(file) {
    var order = nameOption.value;
    var name = file.name;
    if (order !== "keep") {
      try {
        var meta = await readTitleAuthor(file);
        if (meta && meta.title) {
          var parts = !meta.author ? [meta.title]
            : order === "author-title" ? [meta.author, meta.title] : [meta.title, meta.author];
          var base = parts.join(" - ");
          if (base.length > 180) base = base.substring(0, 180).replace(/\s+\S*$/, "").trim();
          name = base + ".epub";
        }
      } catch (e) {
        console.warn("Could not read the book's title and author:", e);
      }
    }
    return reserveAvailableUploadFilename(name, usedNames);
  }

  // "Send to reader": sends the same file Download would (custom chapter
  // marks included) to the reader over USB.
  function sendButton(link, status) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dl";
    button.textContent = "Send to reader";
    button.addEventListener("click", async function () {
      button.disabled = true;
      status.classList.remove("bad");
      status.textContent = "Connecting…";
      try {
        var blob = await (await fetch(link.href)).blob();
        var result = await UsbSend.send(blob, link.download, usbFolder.value, function (fraction) {
          status.textContent = "Sending " + Math.round(fraction * 100) + "%";
        });
        status.textContent = "Sent to " + result.path;
      } catch (e) {
        status.classList.add("bad");
        status.textContent = e && e.name === "NotFoundError" ? "No reader picked." : (e && e.message) || String(e);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  // Words for matching a book to file names: lower case, no accents or
  // punctuation, without filler words.
  var FILLER = new Set(["the", "a", "an", "of", "and", "epub", "by", "le", "la", "el"]);
  function words(text) {
    return (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").split(" ").filter(function (w) { return w && !FILLER.has(w); });
  }

  // How well a file name on the reader matches the book: mostly its title's
  // words, then its author's.
  function matchScore(fileName, meta) {
    var have = new Set(words(fileName.replace(/\.epub$/i, "")));
    var share = function (list) {
      return list.length ? list.filter(function (w) { return have.has(w); }).length / list.length : 0;
    };
    var title = share(words(meta.title));
    return { title: title, score: title * 0.75 + share(words(meta.author)) * 0.25 };
  }

  // "Replace on reader…": lists the reader's books, suggests the one that
  // matches this book, and writes over it keeping its file name, so the
  // reader keeps that book's reading stats, position and settings.
  function replaceButton(link, item, status, panel) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dl";
    button.textContent = "Replace on reader…";

    function fail(e) {
      status.classList.add("bad");
      status.textContent = e && e.name === "NotFoundError" ? "No reader picked." : (e && e.message) || String(e);
    }

    button.addEventListener("click", async function () {
      button.disabled = true;
      panel.hidden = true;
      status.classList.remove("bad");
      status.textContent = "Reading the reader's books…";
      try {
        var books = await UsbSend.listBooks();
        if (!books.length) throw new Error("No EPUBs found on the reader.");
        var meta = (await readTitleAuthor(item.file)) || { title: "", author: "" };
        books.forEach(function (b) { b.match = matchScore(b.name, meta); });
        books.sort(function (a, b) { return b.match.score - a.match.score || a.path.localeCompare(b.path); });
        var best = books[0].match.title >= 0.6 ? books[0] : null;

        panel.textContent = "";
        var select = document.createElement("select");
        var prompt = document.createElement("option");
        prompt.value = "";
        prompt.textContent = best ? "Choose the book to replace" : "No clear match: choose the book to replace";
        select.appendChild(prompt);
        books.forEach(function (b) {
          var option = document.createElement("option");
          option.value = b.path;
          option.textContent = b.path + (b === best ? "  (best match)" : "");
          select.appendChild(option);
        });
        select.value = best ? best.path : "";
        var go = document.createElement("button");
        go.type = "button";
        go.className = "dl primary";
        go.textContent = "Replace";
        go.disabled = !select.value;
        select.addEventListener("change", function () { go.disabled = !select.value; });
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "dl";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", function () { panel.hidden = true; status.textContent = ""; });
        go.addEventListener("click", async function () {
          go.disabled = select.disabled = true;
          status.classList.remove("bad");
          try {
            var blob = await (await fetch(link.href)).blob();
            var result = await UsbSend.replace(blob, select.value, function (fraction) {
              status.textContent = "Replacing " + Math.round(fraction * 100) + "%";
            });
            panel.hidden = true;
            status.textContent = "Replaced " + result.path + "; its reading stats were kept";
          } catch (e) {
            fail(e);
            go.disabled = select.disabled = false;
          }
        });
        panel.appendChild(select);
        panel.appendChild(go);
        panel.appendChild(cancel);
        panel.hidden = false;
        status.textContent = books.length + " book" + (books.length === 1 ? "" : "s") + " on the reader";
      } catch (e) {
        fail(e);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function formatBytes(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function addToQueue(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (!/\.epub$/i.test(file.name)) return;
      var li = document.createElement("li");
      li.innerHTML = '<img class="cover" alt=""><div class="body"><div class="row"><span class="name"></span>' +
        '<span class="side"><span class="state">Ready</span>' +
        '<button type="button" class="remove" aria-label="Remove">✕</button></span></div></div>';
      li.querySelector(".name").textContent = file.name;
      queue.appendChild(li);
      var item = { file: file, li: li, body: li.querySelector(".body"), running: false, removed: false, coverUrl: null };
      li.querySelector(".remove").addEventListener("click", function () { removeItem(item); });
      pending.push(item);
      showCover(item);
      item.inspection = inspect(item);
    });
    start.disabled = busy || pending.length === 0;
  }

  // Shows the book's cover beside its name, found the same way the converter
  // finds it for "Color cover". Books without one keep the empty placeholder.
  async function showCover(item) {
    try {
      var zip = await JSZip.loadAsync(item.file);
      var paths = Array.from(await findEpubCoverImagePaths(zip));
      var path = paths.filter(function (p) { return zip.file(p) && /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(p); })[0];
      if (!path || item.removed) return;
      var data = await zip.file(path).async("blob");
      var type = /\.svg$/i.test(path) ? "image/svg+xml" : "";
      item.coverUrl = URL.createObjectURL(type ? new Blob([data], { type: type }) : data);
      item.li.querySelector(".cover").src = item.coverUrl;
    } catch (e) {
      console.warn("No cover for " + item.file.name + ":", e);
    }
  }

  // Takes a book off the list. One being converted is cancelled first and
  // removed once the converter stops.
  function removeItem(item) {
    item.removed = true;
    if (item.running) {
      operationCancelled = true;
      setState(item, "Cancelling…");
      return;
    }
    var index = pending.indexOf(item);
    if (index >= 0) pending.splice(index, 1);
    Array.prototype.forEach.call(item.li.querySelectorAll("a.dl"), function (a) { URL.revokeObjectURL(a.href); });
    if (item.coverUrl) URL.revokeObjectURL(item.coverUrl);
    item.li.remove();
    start.disabled = busy || pending.length === 0;
  }

  function setState(item, text) {
    item.li.querySelector(".state").textContent = text;
  }

  async function optimize(item) {
    item.running = true;
    try {
      await convertItem(item);
    } finally {
      item.running = false;
      if (item.removed) removeItem(item);
    }
  }

  async function convertItem(item) {
    var li = item.body;
    var bar = document.createElement("progress");
    bar.max = 100;
    bar.value = 0;
    li.appendChild(bar);
    try {
      var source = item.file;
      var prep = { fixed: 0, fontsRemoved: 0, fontBytes: 0 };
      if (repairToggle.checked || removeFontsToggle.checked) {
        setState(item, "Preparing…");
        prep = await prepare(source, { repair: repairToggle.checked, removeFonts: removeFontsToggle.checked });
        source = prep.file;
      }
      setState(item, "Optimizing…");
      operationCancelled = false;
      var blob = await convertEpubFile(source, function (percent) { bar.value = Math.min(100, percent); });
      if (item.removed) return;
      var zip = await JSZip.loadAsync(blob);
      var locations = zip.file("META-INF/x-locations.json");
      var pages = locations ? JSON.parse(await locations.async("string")).totalReferencePages : 0;
      var splits = Object.keys(zip.files).filter(function (n) { return n.indexOf("__ci_section_") >= 0; }).length;

      bar.remove();
      setState(item, "Done");
      var parts = [];
      if (pages) parts.push(pages + " stable pages");
      if (splits) parts.push("long chapters split into " + splits + " extra pieces");
      if (prep.fixed) parts.push(prep.fixed + " garbled characters repaired");
      if (prep.fontsRemoved) {
        parts.push(prep.fontsRemoved + " embedded font" + (prep.fontsRemoved === 1 ? "" : "s") + " removed" +
          (prep.fontBytes ? " (" + formatBytes(prep.fontBytes) + ")" : ""));
      }
      parts.push(formatBytes(item.file.size) + " → " + formatBytes(blob.size));
      await showResult(item, blob, parts, false);
    } catch (e) {
      bar.remove();
      if (item.removed) return;  // Cancelled from the list
      setState(item, "Failed");
      var error = document.createElement("div");
      error.className = "detail bad";
      error.textContent = (e && e.message) || String(e);
      li.appendChild(error);
    }
  }

  // A finished book's summary, chapter-mark editor, Download and Send to
  // reader. An already-optimized book also gets "Optimize again".
  async function showResult(item, blob, parts, alreadyOptimized) {
    var li = item.body;
    var detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = parts.join(" · ");
    li.appendChild(detail);

    var link = document.createElement("a");
    link.className = "dl";
    link.href = URL.createObjectURL(blob);
    var name = await outputName(item.file);
    if (name !== item.file.name) li.querySelector(".name").textContent = name;
    link.download = name;
    link.textContent = "Download";
    // Chapter marks, then the buttons below them.
    var actions = document.createElement("div");
    actions.className = "actions";
    li.appendChild(actions);
    try {
      await ChapterMarks.attach(actions, blob, link);
    } catch (e) {
      console.error("Chapter marks editor unavailable:", e);
    }
    // All buttons on one row; the replace picker and any message go below
    // it, so the buttons never move.
    var buttons = document.createElement("div");
    buttons.className = "buttons";
    var panel = document.createElement("div");
    panel.className = "replace";
    panel.hidden = true;
    var status = document.createElement("div");
    status.className = "send-status";
    status.setAttribute("role", "status");
    buttons.appendChild(link);
    if (UsbSend.supported) {
      buttons.appendChild(sendButton(link, status));
      buttons.appendChild(replaceButton(link, item, status, panel));
    }
    if (alreadyOptimized) {
      var again = document.createElement("button");
      again.type = "button";
      again.className = "dl";
      again.textContent = "Optimize again";
      again.addEventListener("click", function () { requeue(item); });
      buttons.appendChild(again);
    }
    actions.appendChild(buttons);
    actions.appendChild(panel);
    actions.appendChild(status);
  }

  // Puts a book back in the batch, clearing its results.
  function requeue(item) {
    Array.prototype.forEach.call(item.li.querySelectorAll("a.dl"), function (a) { URL.revokeObjectURL(a.href); });
    Array.prototype.slice.call(item.body.children, 1).forEach(function (el) { el.remove(); });
    item.body.querySelector(".name").textContent = item.file.name;
    setState(item, "Ready");
    pending.push(item);
    start.disabled = busy;
  }

  // True when a book's text has double-encoded characters ("â€™").
  async function hasGarbledText(zip) {
    var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && /\.x?html?$/i.test(n); });
    for (var i = 0; i < names.length; i++) {
      var text = await zip.file(names[i]).async("string");
      var pattern = new RegExp(MOJIBAKE.source, "g");
      var m;
      while ((m = pattern.exec(text))) {
        if (unmangle(m[0]) !== m[0]) return true;
      }
    }
    return false;
  }

  // A book that is already optimized (it carries the optimizer's manifest,
  // written by CrossInk's optimizer and by Inky) skips conversion and goes
  // straight to its chapter marks, Download and Send to reader.
  async function inspect(item) {
    try {
      var zip = await JSZip.loadAsync(item.file);
      if (!zip.file("META-INF/crossink/optimizer-v1.json")) return;
      var index = pending.indexOf(item);
      if (index < 0 || item.removed) return;  // Already being converted, or gone
      pending.splice(index, 1);
      start.disabled = busy || pending.length === 0;
      setState(item, "Already optimized");
      var locations = zip.file("META-INF/x-locations.json");
      var pages = locations ? JSON.parse(await locations.async("string")).totalReferencePages : 0;
      var parts = [];
      if (pages) parts.push(pages + " stable pages");
      if (await hasGarbledText(zip)) parts.push("garbled characters found: Optimize again to repair them");
      parts.push(formatBytes(item.file.size));
      await showResult(item, item.file, parts, true);
    } catch (e) {
      console.warn("Could not inspect " + item.file.name + ":", e);  // Treated as a normal book
    }
  }

  start.addEventListener("click", async function () {
    if (busy) return;
    busy = true;
    start.disabled = true;
    // The converter's own startup may restore its defaults, so apply this
    // page's choices right before converting.
    selectDevice(deviceButtons.filter(function (b) { return b.getAttribute("aria-pressed") === "true"; })[0]);
    usedNames = new Set();  // Names only need to be unique within a batch
    JPEG_QUALITY = parseInt(quality.value, 10);
    ENABLE_GRAYSCALE = grayscale.checked;
    // Let detection finish so already-optimized books aren't converted again.
    await Promise.all(pending.map(function (item) { return item.inspection; }));
    while (pending.length) await optimize(pending.shift());
    operationCancelled = false;
    busy = false;
    start.disabled = true;
  });

  picker.addEventListener("change", function () {
    addToQueue(picker.files);
    picker.value = "";
  });
  ["dragenter", "dragover"].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    drop.addEventListener(type, function () { drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    addToQueue(e.dataTransfer.files);
  });

  quality.addEventListener("input", function () { qualityValue.textContent = quality.value + "%"; });

  var deviceButtons = Array.prototype.slice.call(document.querySelectorAll(".seg button"));
  function selectDevice(button) {
    deviceButtons.forEach(function (b) { b.setAttribute("aria-pressed", b === button ? "true" : "false"); });
    DEVICE_TARGET = button.getAttribute("data-device");
    applyDeviceTarget();
  }
  deviceButtons.forEach(function (button) {
    button.addEventListener("click", function () { selectDevice(button); });
  });
  selectDevice(deviceButtons[0]);
})();
