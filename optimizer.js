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

  function formatBytes(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function addToQueue(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (!/\.epub$/i.test(file.name)) return;
      var li = document.createElement("li");
      li.innerHTML = '<div class="row"><span class="name"></span><span class="state">Ready</span></div>';
      li.querySelector(".name").textContent = file.name;
      queue.appendChild(li);
      pending.push({ file: file, li: li });
    });
    start.disabled = busy || pending.length === 0;
  }

  function setState(item, text) {
    item.li.querySelector(".state").textContent = text;
  }

  async function optimize(item) {
    var li = item.li;
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
      var zip = await JSZip.loadAsync(blob);
      var locations = zip.file("META-INF/x-locations.json");
      var pages = locations ? JSON.parse(await locations.async("string")).totalReferencePages : 0;
      var splits = Object.keys(zip.files).filter(function (n) { return n.indexOf("__ci_section_") >= 0; }).length;

      bar.remove();
      setState(item, "Done");
      var detail = document.createElement("div");
      detail.className = "detail";
      var parts = [];
      if (pages) parts.push(pages + " stable pages");
      if (splits) parts.push("long chapters split into " + splits + " extra pieces");
      if (prep.fixed) parts.push(prep.fixed + " garbled characters repaired");
      if (prep.fontsRemoved) {
        parts.push(prep.fontsRemoved + " embedded font" + (prep.fontsRemoved === 1 ? "" : "s") + " removed" +
          (prep.fontBytes ? " (" + formatBytes(prep.fontBytes) + ")" : ""));
      }
      parts.push(formatBytes(item.file.size) + " → " + formatBytes(blob.size));
      detail.textContent = parts.join(" · ");
      li.appendChild(detail);

      var link = document.createElement("a");
      link.className = "dl";
      link.href = URL.createObjectURL(blob);
      var name = await outputName(item.file);
      if (name !== item.file.name) li.querySelector(".name").textContent = name;
      link.download = name;
      link.textContent = "Download";
      li.appendChild(link);
      try {
        await ChapterMarks.attach(li, blob, link);
      } catch (e) {
        console.error("Chapter marks editor unavailable:", e);
      }
    } catch (e) {
      bar.remove();
      setState(item, "Failed");
      var error = document.createElement("div");
      error.className = "detail bad";
      error.textContent = (e && e.message) || String(e);
      li.appendChild(error);
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
    while (pending.length) await optimize(pending.shift());
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
