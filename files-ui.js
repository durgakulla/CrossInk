// File manager for a CrossInk reader's SD card over USB (usb-send.js). Moves
// and renames go through the reader's rename command, which keeps a book's
// reading stats with it (firmware v1.3.0+); folders are moved by moving their
// contents one by one so the books inside keep theirs too. With firmware
// 1.5.0+ books show their cover, title, author and progress (the reader's own
// saved thumbnails), as a list or a grid.
(function () {
  "use strict";

  var fs = UsbSend.files;
  var idle = document.getElementById("idle");
  var browser = document.getElementById("browser");
  var crumbs = document.getElementById("crumbs");
  var list = document.getElementById("files");
  var message = document.getElementById("msg");
  var selbar = document.getElementById("selbar");
  var selCount = document.getElementById("selCount");
  var selMove = document.getElementById("selMove");
  var selDelete = document.getElementById("selDelete");
  var upload = document.getElementById("upload");
  var selRename = document.getElementById("selRename");
  var selEdit = document.getElementById("selEdit");
  var libNote = document.getElementById("libNote");
  var viewButtons = Array.prototype.slice.call(document.querySelectorAll("#view button"));

  var cwd = "/";
  var entries = [];
  var selected = new Set();
  var busy = false;
  var library = new Map();   // Book path -> the reader's record for this folder
  var libSupported = null;   // false on firmware older than 1.5.0
  var covers = new Map();    // "path|size" -> object URL, kept for the visit
  var coverRun = 0;          // Bumped to stop a folder's cover loading
  var refs = new Map();      // Path -> {li, nameEl, entry} for the rendered items
  var view = "list";
  try { if (localStorage.getItem("crossink-files-view") === "grid") view = "grid"; } catch (e) { /* default */ }

  function join(folder, name) { return (folder === "/" ? "" : folder) + "/" + name; }
  function parentOf(path) { var i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
  function baseName(path) { return path.slice(path.lastIndexOf("/") + 1); }
  function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

  function isBook(name) { return /\.(epub|xtch?|txt|md)$/i.test(name); }
  function isEpub(entry) { return !entry.folder && /\.epub$/i.test(entry.name); }
  function duration(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h) return h + "h" + (m ? " " + m + "m" : "");
    return m ? m + "m" : "<1m";
  }
  // "62% · 1h 33m", "Finished · 4h", or "" for a book never read.
  function progressText(info) {
    var parts = [];
    if (info.completed) parts.push("Finished");
    else if (info.progress != null) parts.push(Math.round(info.progress) + "%");
    if (info.seconds > 0) parts.push(duration(info.seconds));
    return parts.join(" · ");
  }
  function progressValue(info) { return info.completed ? 100 : info.progress != null ? info.progress : 0; }
  function displayTitle(name, info) { return (info && info.title) || name.replace(/\.[^.]+$/, ""); }

  function friendly(e) {
    var text = (e && e.message) || String(e);
    if (e && e.name === "NotFoundError") return "No reader picked.";
    if (/ERR:target_exists/.test(text)) return "Something with that name is already there.";
    if (/ERR:target_state_exists/.test(text)) return "That name has saved reading data from another book. Choose another name.";
    if (/ERR:book_type/.test(text)) return "Renaming a book can't change its file type.";
    if (/ERR:protected_path/.test(text)) return "That item is protected.";
    if (/ERR:not_found/.test(text)) return "That item no longer exists. Refresh the list.";
    return text;
  }

  function say(text, bad) {
    message.textContent = text || "";
    message.classList.toggle("bad", !!bad);
  }

  // Runs one operation at a time, with the list disabled meanwhile.
  async function run(label, fn) {
    if (busy) return;
    busy = true;
    browser.classList.add("busy");
    say(label);
    try {
      await fn();
    } catch (e) {
      say(friendly(e), true);
      busy = false;
      browser.classList.remove("busy");
      return false;
    }
    busy = false;
    browser.classList.remove("busy");
    return true;
  }

  function sortEntries(a, b) {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  }

  async function open(path) {
    var ok = await run("Loading…", async function () {
      var items = await fs.list(path);
      var books = new Map();
      if (libSupported !== false && items.some(function (i) { return !i.folder && isBook(i.name); })) {
        try {
          (await fs.library(path)).forEach(function (b) { books.set(b.path, b); });
          libSupported = true;
        } catch (e) {
          if (e.code !== "unknown_cmd") throw e;
          libSupported = false;
        }
      }
      cwd = path;
      entries = items.sort(sortEntries);
      library = books;
      selected.clear();
    });
    if (ok) {
      say("");
      render();
      loadCovers();
    }
  }

  // ---- Covers ------------------------------------------------------------

  function coverKey(info) { return info.path + "|" + info.cover; }

  // A book's cover: the reader's saved thumbnail once loaded, otherwise a
  // tile with its title.
  function coverElement(name, info, small) {
    var box = document.createElement("span");
    box.className = "cover" + (small ? " small" : "");
    var url = info && info.cover > 0 ? covers.get(coverKey(info)) : null;
    if (url) {
      var img = document.createElement("img");
      img.src = url;
      img.alt = "";
      box.appendChild(img);
    } else {
      box.classList.add("blank");
      if (info && info.cover > 0) box.setAttribute("data-cover", coverKey(info));
      if (!small) {
        var text = document.createElement("span");
        text.textContent = displayTitle(name, info);
        box.appendChild(text);
      }
    }
    return box;
  }

  // Fetches this folder's covers one at a time; operations the user starts
  // run in between, and leaving the folder stops it.
  async function loadCovers() {
    var run = ++coverRun;
    var wanted = Array.from(library.values()).filter(function (b) { return b.cover > 0 && !covers.has(coverKey(b)); });
    for (var i = 0; i < wanted.length; i++) {
      var blob = null;
      try { blob = await fs.cover(wanted[i].path); } catch (e) { return; }
      var key = coverKey(wanted[i]);
      if (blob && !covers.has(key)) covers.set(key, URL.createObjectURL(blob));  // Kept even if the folder changed
      if (run !== coverRun) return;
      if (!blob) continue;
      list.querySelectorAll(".cover[data-cover]").forEach(function (box) {
        if (box.getAttribute("data-cover") !== key) return;
        var img = document.createElement("img");
        img.src = covers.get(key);
        img.alt = "";
        box.textContent = "";
        box.classList.remove("blank");
        box.removeAttribute("data-cover");
        box.appendChild(img);
      });
    }
  }

  function refresh() { return open(cwd); }

  // ---- Moving ----------------------------------------------------------

  // Moves a folder by recreating it and moving its contents one by one, so
  // every book inside keeps its reading stats; the emptied folder is removed.
  async function moveFolder(from, to, progress) {
    await fs.mkdir(to);
    var items = await fs.list(from);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.folder) await moveFolder(join(from, item.name), join(to, item.name), progress);
      else {
        progress(join(from, item.name));
        await fs.rename(join(from, item.name), join(to, item.name));
      }
    }
    await fs.remove(from);
  }

  async function moveTo(path, folder, destination) {
    var target = join(destination, baseName(path));
    if (target === path) return;
    if (folder && (destination === path || destination.indexOf(path + "/") === 0)) {
      throw new Error("A folder can't be moved into itself.");
    }
    if (folder) await moveFolder(path, target, function (p) { say("Moving " + p + "…"); });
    else await fs.rename(path, target);
  }

  async function moveMany(items, destination) {
    var ok = await run("Moving…", async function () {
      for (var i = 0; i < items.length; i++) await moveTo(items[i].path, items[i].folder, destination);
    });
    if (ok) {
      await refresh();
      say("Moved " + items.length + " item" + (items.length === 1 ? "" : "s") + " to " + destination);
    }
  }

  // Every folder on the card, for the "Move to" pickers.
  async function allFolders() {
    var folders = ["/"];
    var queue = ["/"];
    while (queue.length && folders.length < 500) {
      var folder = queue.shift();
      var items = await fs.list(folder);
      items.filter(function (i) { return i.folder; }).sort(sortEntries).forEach(function (i) {
        var path = join(folder, i.name);
        folders.push(path);
        queue.push(path);
      });
    }
    return folders.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }

  // Shows a "Move to" folder picker in host; calls done(folder) on Move.
  async function showMovePicker(host, exclude, done) {
    var folders;
    var ok = await run("Reading folders…", async function () { folders = await allFolders(); });
    if (!ok) return;
    say("");
    host.textContent = "";
    var select = document.createElement("select");
    folders.filter(function (f) {
      return !exclude.some(function (e) { return e.folder && (f === e.path || f.indexOf(e.path + "/") === 0); });
    }).forEach(function (f) {
      var option = document.createElement("option");
      option.value = f;
      option.textContent = f === "/" ? "/ (card root)" : f;
      select.appendChild(option);
    });
    select.value = cwd;
    var go = button("Move", "primary", function () { host.hidden = true; done(select.value); });
    var cancel = button("Cancel", "", function () { host.hidden = true; });
    host.appendChild(select);
    host.appendChild(go);
    host.appendChild(cancel);
    host.hidden = false;
    select.focus();
  }

  // ---- Rows ------------------------------------------------------------

  function button(label, kind, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "act" + (kind ? " " + kind : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function folderIcon() {
    return '<svg viewBox="0 0 20 16" aria-hidden="true"><path d="M1 3a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  }
  function fileIcon(name) {
    var book = /\.(epub|xtch?|txt|md)$/i.test(name);
    return '<svg viewBox="0 0 16 20" aria-hidden="true"><path d="M2 1h8l4 4v14H2z" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
      (book ? '<path d="M5 9h6M5 12h6M5 15h4" stroke="currentColor" stroke-width="1.2"/>' : "") + "</svg>";
  }

  function renderRow(entry) {
    var path = join(cwd, entry.name);
    var li = document.createElement("li");
    li.className = "row" + (entry.folder ? " folder" : "");

    var check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(path);
    check.setAttribute("aria-label", "Select " + entry.name);
    check.addEventListener("change", function () { toggle(path, check.checked); });

    var info = entry.folder ? null : library.get(path);
    var icon = document.createElement("span");
    icon.className = "icon";
    if (info) icon.appendChild(coverElement(entry.name, info, true));
    else icon.innerHTML = entry.folder ? folderIcon() : fileIcon(entry.name);

    var name = document.createElement(entry.folder ? "button" : "span");
    name.className = "name";
    if (info) {
      name.classList.add("book");
      var title = document.createElement("span");
      title.className = "title";
      title.textContent = displayTitle(entry.name, info);
      name.appendChild(title);
      var meta = [info.author, info.title && info.title !== entry.name ? entry.name : ""].filter(Boolean).join(" · ");
      if (meta) {
        var sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = meta;
        name.appendChild(sub);
      }
      var progress = progressText(info);
      if (progress) {
        var line = document.createElement("span");
        line.className = "progress";
        line.innerHTML = '<span class="track"><span class="fill"></span></span>';
        line.querySelector(".fill").style.width = progressValue(info) + "%";
        line.appendChild(document.createTextNode(progress));
        name.appendChild(line);
      }
    } else {
      name.textContent = entry.name;
    }
    if (entry.folder) {
      name.type = "button";
      name.addEventListener("click", function () { if (!busy) open(path); });
    }

    var size = document.createElement("span");
    size.className = "size";
    size.textContent = entry.folder ? "" : formatBytes(entry.size);

    var actions = document.createElement("span");
    actions.className = "acts";
    var panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;

    actions.appendChild(button("Rename", "", function () { startRename(li, name, entry, path); }));
    actions.appendChild(button("Move…", "", function () {
      showMovePicker(panel, [{ path: path, folder: entry.folder }], function (dest) {
        moveMany([{ path: path, folder: entry.folder }], dest);
      });
    }));
    if (isEpub(entry)) actions.appendChild(button("Edit details", "", function () { editDetails(panel, path); }));
    if (!entry.folder) actions.appendChild(button("Download", "", function () { download(path, entry.size); }));
    actions.appendChild(button("Delete", "", function () { confirmDelete(actions, [{ path: path, folder: entry.folder }]); }));

    li.appendChild(check);
    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(size);
    li.appendChild(actions);
    li.appendChild(panel);

    draggable(li, path);
    if (entry.folder) dropTarget(li, path);
    refs.set(path, { li: li, nameEl: name, entry: entry });
    return li;
  }

  // Grid view: a card per item. Clicking a book or file selects it; clicking a
  // folder opens it. Actions come from the selection bar.
  function renderCard(entry) {
    var path = join(cwd, entry.name);
    var info = entry.folder ? null : library.get(path);
    var li = document.createElement("li");
    li.className = "gcard" + (entry.folder ? " folder" : "") + (selected.has(path) ? " sel" : "");

    var check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(path);
    check.setAttribute("aria-label", "Select " + entry.name);
    check.addEventListener("click", function (e) { e.stopPropagation(); });
    check.addEventListener("change", function () { toggle(path, check.checked); });

    var art;
    if (info) art = coverElement(entry.name, info, false);
    else {
      art = document.createElement("span");
      art.className = "cover blank icon-art";
      art.innerHTML = entry.folder ? folderIcon() : fileIcon(entry.name);
    }

    var title = document.createElement("span");
    title.className = "t";
    title.textContent = info ? displayTitle(entry.name, info) : entry.name;
    li.appendChild(check);
    li.appendChild(art);
    li.appendChild(title);
    var sub = entry.folder ? "Folder" : info ? (info.author || "") : formatBytes(entry.size);
    if (sub) {
      var a = document.createElement("span");
      a.className = "a";
      a.textContent = sub;
      li.appendChild(a);
    }
    var progress = info ? progressText(info) : "";
    if (progress) {
      var p = document.createElement("span");
      p.className = "p";
      p.innerHTML = '<span class="track"><span class="fill"></span></span>';
      p.querySelector(".fill").style.width = progressValue(info) + "%";
      p.appendChild(document.createTextNode(progress));
      li.appendChild(p);
    }
    li.title = entry.name;
    li.tabIndex = 0;
    function activate() {
      if (busy) return;
      if (entry.folder && !selected.size) open(path);
      else toggle(path, !selected.has(path));
    }
    li.addEventListener("click", activate);
    li.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
    draggable(li, path);
    if (entry.folder) dropTarget(li, path);
    refs.set(path, { li: li, nameEl: title, entry: entry });
    return li;
  }

  function toggle(path, on) {
    if (on) selected.add(path); else selected.delete(path);
    var ref = refs.get(path);
    if (ref) {
      ref.li.classList.toggle("sel", on);
      var box = ref.li.querySelector('input[type="checkbox"]');
      if (box) box.checked = on;
    }
    renderSelection();
  }

  function draggable(li, path) {
    li.draggable = true;
    li.addEventListener("dragstart", function (e) {
      if (!selected.has(path)) { selected.clear(); selected.add(path); renderSelection(); }
      e.dataTransfer.setData("text/x-crossink-paths", JSON.stringify(selectedItems()));
      e.dataTransfer.effectAllowed = "move";
    });
  }

  function selectedItems() {
    return entries.filter(function (e) { return selected.has(join(cwd, e.name)); })
      .map(function (e) { return { path: join(cwd, e.name), folder: e.folder }; });
  }

  // Lets rows from this list be dropped onto a folder (row or breadcrumb).
  function dropTarget(el, folder) {
    el.addEventListener("dragover", function (e) {
      if (busy || !Array.prototype.includes.call(e.dataTransfer.types, "text/x-crossink-paths")) return;
      e.preventDefault();
      el.classList.add("over");
    });
    el.addEventListener("dragleave", function () { el.classList.remove("over"); });
    el.addEventListener("drop", function (e) {
      el.classList.remove("over");
      var data = e.dataTransfer.getData("text/x-crossink-paths");
      if (!data) return;
      e.preventDefault();
      e.stopPropagation();
      var items = JSON.parse(data).filter(function (i) { return i.path !== folder; });
      if (items.length) moveMany(items, folder);
    });
  }

  function startRename(li, nameEl, entry, path) {
    if (busy) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "rename";
    input.value = entry.name;
    input.spellcheck = false;
    var dot = entry.folder ? -1 : entry.name.lastIndexOf(".");
    input.addEventListener("click", function (e) { e.stopPropagation(); });  // Not a card click
    nameEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);  // Name without its extension
    var done = false;
    async function finish(save) {
      if (done) return;
      done = true;
      var newName = input.value.trim();
      if (!save || !newName || newName === entry.name) { render(); return; }
      if (/[\/\\:*?"<>|]/.test(newName)) { say("A name can't contain / \\ : * ? \" < > |", true); render(); return; }
      var target = join(cwd, newName);
      var ok = await run("Renaming…", async function () {
        if (entry.folder) await moveFolder(path, target, function (p) { say("Moving " + p + "…"); });
        else await fs.rename(path, target);
      });
      if (ok) { await refresh(); say("Renamed to " + newName); } else render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(true); });
  }

  // Changes an EPUB's title and author inside the book and writes it back to
  // the same path, so the reader keeps its stats, position and settings
  // (replacing a book over USB keeps them). Optionally renames the file to
  // match, which keeps them too.
  async function editDetails(host, path) {
    var zip, info;
    var ok = await run("Reading the book…", async function () {
      var bytes = await fs.read(path, function (f) { say("Reading the book… " + Math.round(f * 100) + "%"); });
      zip = await JSZip.loadAsync(bytes);
      info = await EpubMeta.read(zip);
    });
    if (!ok) return;
    say("");
    host.textContent = "";
    var form = document.createElement("div");
    form.className = "meta-form";
    function field(label, value) {
      var wrap = document.createElement("label");
      wrap.appendChild(document.createTextNode(label));
      var input = document.createElement("input");
      input.type = "text";
      input.value = value;
      input.spellcheck = false;
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var title = field("Title", info.title);
    var author = field("Author", info.author);
    var renameWrap = document.createElement("label");
    renameWrap.className = "check";
    var rename = document.createElement("input");
    rename.type = "checkbox";
    var renameText = document.createElement("span");
    renameWrap.appendChild(rename);
    renameWrap.appendChild(renameText);
    form.appendChild(renameWrap);
    function fileName() {
      var name = [title.value.trim(), author.value.trim()].filter(Boolean).join(" - ")
        .replace(/[\/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
      return name ? name + ".epub" : "";
    }
    function update() {
      renameText.textContent = "Rename the file to “" + (fileName() || "…") + "”";
      rename.disabled = !fileName() || fileName() === baseName(path);
    }
    title.addEventListener("input", update);
    author.addEventListener("input", update);
    update();
    var bar = document.createElement("div");
    bar.className = "meta-bar";
    bar.appendChild(button("Save", "primary", save));
    bar.appendChild(button("Cancel", "", function () { host.hidden = true; say(""); }));
    form.appendChild(bar);
    form.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.type === "text") save();
      if (e.key === "Escape") { host.hidden = true; say(""); }
    });
    host.appendChild(form);
    host.hidden = false;
    title.focus();

    async function save() {
      var newTitle = title.value.trim().replace(/\s+/g, " ");
      var newAuthor = author.value.trim().replace(/\s+/g, " ");
      var target = rename.checked && !rename.disabled ? join(parentOf(path), fileName()) : path;
      if (!newTitle) { say("The title can't be empty.", true); return; }
      var changed = newTitle !== info.title || newAuthor !== info.author;
      if (!changed && target === path) { host.hidden = true; return; }
      host.hidden = true;
      var saved = !changed;
      var ok = await run("Saving…", async function () {
        if (changed) {
          var blob = await EpubMeta.save(zip, info, newTitle, newAuthor);
          await fs.write(path, blob, function (f) { say("Saving… " + Math.round(f * 100) + "%"); });
          saved = true;
        }
        if (target !== path) await fs.rename(path, target);
      });
      if (!ok && !saved) return;
      var error = message.textContent;
      await refresh();
      if (!ok) say((changed ? "Saved the new details, but couldn't rename the file: " : "") + error, true);
      else say(changed ? "Saved. The reader shows the new title and author once you open the book." :
        "Renamed to " + baseName(target));
    }
  }

  function confirmDelete(host, items) {
    if (busy) return;
    var saved = Array.prototype.slice.call(host.childNodes);
    function restore() {
      host.textContent = "";
      saved.forEach(function (n) { host.appendChild(n); });
    }
    host.textContent = "";
    var label = document.createElement("span");
    label.className = "confirm";
    label.textContent = items.length === 1 && items[0].folder ? "Delete folder and everything in it?" :
      items.length > 1 ? "Delete " + items.length + " items?" : "Delete?";
    host.appendChild(label);
    host.appendChild(button("Delete", "danger", async function () {
      var ok = await run("Deleting…", async function () {
        for (var i = 0; i < items.length; i++) await fs.remove(items[i].path);
      });
      restore();
      if (ok) { await refresh(); say("Deleted " + items.length + " item" + (items.length === 1 ? "" : "s")); }
    }));
    host.appendChild(button("Cancel", "", restore));
  }

  async function download(path, size) {
    var data;
    var ok = await run("Downloading…", async function () {
      data = await fs.read(path, function (f) { say("Downloading " + Math.round(f * 100) + "%"); });
    });
    if (!ok) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = baseName(path);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    say("Downloaded " + baseName(path) + " (" + formatBytes(size) + ")");
  }

  async function uploadFiles(files) {
    files = Array.prototype.slice.call(files);
    if (!files.length || busy) return;
    var ok = await run("Uploading…", async function () {
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        await fs.write(join(cwd, file.name), file, function (f) {
          say("Uploading " + file.name + " " + Math.round(f * 100) + "%" + (files.length > 1 ? " (" + (i + 1) + " of " + files.length + ")" : ""));
        });
      }
    });
    if (ok) { await refresh(); say("Uploaded " + files.length + " file" + (files.length === 1 ? "" : "s")); }
  }

  // ---- Page ------------------------------------------------------------

  function renderCrumbs() {
    crumbs.textContent = "";
    var parts = cwd === "/" ? [] : cwd.slice(1).split("/");
    var path = "/";
    var items = [{ label: "SD card", path: "/" }].concat(parts.map(function (p) {
      path = join(path, p);
      return { label: p, path: path };
    }));
    items.forEach(function (item, i) {
      if (i) {
        var sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "/";
        crumbs.appendChild(sep);
      }
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      if (i === items.length - 1) b.setAttribute("aria-current", "location");
      b.addEventListener("click", function () { if (!busy) open(item.path); });
      dropTarget(b, item.path);
      crumbs.appendChild(b);
    });
  }

  function renderSelection() {
    selbar.hidden = selected.size === 0;
    selCount.textContent = selected.size + " selected";
    selRename.hidden = selected.size !== 1;
    var only = selected.size === 1 ? refs.get(Array.from(selected)[0]) : null;
    selEdit.hidden = !(only && isEpub(only.entry));
    list.classList.toggle("selecting", selected.size > 0);
  }

  function render() {
    renderCrumbs();
    list.textContent = "";
    refs.clear();
    list.classList.toggle("grid", view === "grid");
    viewButtons.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-view") === view ? "true" : "false"); });
    libNote.hidden = libSupported !== false;
    if (!entries.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "This folder is empty. Drop files here to upload them.";
      list.appendChild(empty);
    }
    entries.forEach(function (entry) { list.appendChild(view === "grid" ? renderCard(entry) : renderRow(entry)); });
    renderSelection();
  }

  // The reader strip (reader.js) owns the connection; show the card while
  // it's connected, back in the folder that was open.
  var opened = false;
  Reader.onConnect(function () {
    libSupported = null;  // The firmware may have been updated meanwhile
    idle.hidden = true;
    browser.hidden = false;
    open(opened ? cwd : "/");
    opened = true;
  });
  Reader.onDisconnect(function () {
    browser.hidden = true;
    idle.hidden = false;
    busy = false;
    browser.classList.remove("busy");
  });

  document.getElementById("refresh").addEventListener("click", function () { if (!busy) refresh(); });
  document.getElementById("selectAll").addEventListener("click", function () {
    var all = entries.length && selected.size !== entries.length;
    selected.clear();
    if (all) entries.forEach(function (e) { selected.add(join(cwd, e.name)); });
    render();
  });
  document.getElementById("newFolder").addEventListener("click", function () {
    if (busy) return;
    var row = document.createElement("li");
    row.className = "row folder";
    row.innerHTML = '<span></span><span class="icon">' + folderIcon() + "</span>";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "rename";
    input.placeholder = "New folder name";
    row.appendChild(input);
    list.insertBefore(row, list.firstChild);
    input.focus();
    var done = false;
    async function finish(save) {
      if (done) return;
      done = true;
      var name = input.value.trim();
      if (!save || !name) { row.remove(); return; }
      if (/[\/\\:*?"<>|]/.test(name)) { say("A name can't contain / \\ : * ? \" < > |", true); row.remove(); return; }
      var ok = await run("Creating folder…", function () { return fs.mkdir(join(cwd, name)); });
      if (ok) { await refresh(); say("Created " + name); } else row.remove();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", function () { finish(true); });
  });
  upload.addEventListener("change", function () { uploadFiles(upload.files); upload.value = ""; });
  selRename.addEventListener("click", function () {
    var ref = refs.get(Array.from(selected)[0]);
    if (ref) startRename(ref.li, ref.nameEl, ref.entry, join(cwd, ref.entry.name));
  });
  viewButtons.forEach(function (b) {
    b.addEventListener("click", function () {
      view = b.getAttribute("data-view");
      try { localStorage.setItem("crossink-files-view", view); } catch (e) { /* not saved */ }
      if (!browser.hidden) render();
    });
  });
  selEdit.addEventListener("click", function () {
    var path = Array.from(selected)[0];
    if (path) editDetails(document.getElementById("selPanel"), path);
  });
  selMove.addEventListener("click", function () {
    var items = selectedItems();
    showMovePicker(document.getElementById("selPanel"), items, function (dest) { moveMany(items, dest); });
  });
  selDelete.addEventListener("click", function () {
    confirmDelete(document.getElementById("selActions"), selectedItems());
  });

  // Files dropped from the computer upload into the open folder.
  browser.addEventListener("dragover", function (e) {
    if (busy || !Array.prototype.includes.call(e.dataTransfer.types, "Files")) return;
    e.preventDefault();
    browser.classList.add("dropping");
  });
  browser.addEventListener("dragleave", function (e) {
    if (!browser.contains(e.relatedTarget)) browser.classList.remove("dropping");
  });
  browser.addEventListener("drop", function (e) {
    browser.classList.remove("dropping");
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadFiles(e.dataTransfer.files);
  });

  if (!UsbSend.supported) idle.textContent = "Use Chrome or Edge on a computer to manage your reader's files.";
})();
