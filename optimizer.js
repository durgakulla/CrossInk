// Drives CrossInk's web-portal EPUB converter (vendor/crossink-files.js,
// unchanged) from this page, after repairing double-encoded text. Everything
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

  // Repairs double-encoded text in every text file of the book. Returns the
  // number of characters fixed and, when any were, the repaired EPUB.
  async function repairGarbled(file) {
    var zip = await JSZip.loadAsync(file);
    var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && TEXT_FILE.test(n); });
    var texts = {};
    var fixed = 0;
    for (var i = 0; i < names.length; i++) {
      var text = await zip.file(names[i]).async("string");
      var repaired = text.replace(MOJIBAKE, function (m) {
        var out = unmangle(m);
        if (out !== m) fixed++;
        return out;
      });
      texts[names[i]] = { original: text, repaired: repaired };
    }
    if (fixed === 0) return { fixed: 0, file: file };
    // Only a book that was double-encoded gets its lone "Â"s restored.
    names.forEach(function (name) {
      var entry = texts[name];
      var repaired = entry.repaired.replace(LONE_A_CIRCUMFLEX, function () {
        fixed++;
        return " ";
      });
      if (repaired !== entry.original) zip.file(name, repaired);
    });
    var blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/epub+zip" });
    return { fixed: fixed, file: new File([blob], file.name, { type: "application/epub+zip" }) };
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
      var fixed = 0;
      if (repairToggle.checked) {
        setState(item, "Checking text…");
        var repair = await repairGarbled(source);
        fixed = repair.fixed;
        source = repair.file;
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
      if (fixed) parts.push(fixed + " garbled characters repaired");
      parts.push(formatBytes(item.file.size) + " → " + formatBytes(blob.size));
      detail.textContent = parts.join(" · ");
      li.appendChild(detail);

      var link = document.createElement("a");
      link.className = "dl";
      link.href = URL.createObjectURL(blob);
      link.download = item.file.name;
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
