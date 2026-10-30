// File manager for a CrossInk reader's SD card over USB (usb-send.js). Moves
// and renames go through the reader's rename command, which keeps a book's
// reading stats with it (firmware v1.3.0+); folders are moved by moving their
// contents one by one so the books inside keep theirs too.
(function () {
  "use strict";

  var fs = UsbSend.files;
  var connectButton = document.getElementById("connect");
  var device = document.getElementById("device");
  var browser = document.getElementById("browser");
  var crumbs = document.getElementById("crumbs");
  var list = document.getElementById("files");
  var message = document.getElementById("msg");
  var selbar = document.getElementById("selbar");
  var selCount = document.getElementById("selCount");
  var selMove = document.getElementById("selMove");
  var selDelete = document.getElementById("selDelete");
  var upload = document.getElementById("upload");

  var cwd = "/";
  var entries = [];
  var selected = new Set();
  var busy = false;

  function join(folder, name) { return (folder === "/" ? "" : folder) + "/" + name; }
  function parentOf(path) { var i = path.lastIndexOf("/"); return i <= 0 ? "/" : path.slice(0, i); }
  function baseName(path) { return path.slice(path.lastIndexOf("/") + 1); }
  function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return bytes + " B";
  }

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
      cwd = path;
      entries = items.sort(sortEntries);
      selected.clear();
    });
    if (ok) {
      say("");
      render();
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
    li.draggable = true;

    var check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(path);
    check.setAttribute("aria-label", "Select " + entry.name);
    check.addEventListener("change", function () {
      if (check.checked) selected.add(path); else selected.delete(path);
      renderSelection();
    });

    var icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = entry.folder ? folderIcon() : fileIcon(entry.name);

    var name = document.createElement(entry.folder ? "button" : "span");
    name.className = "name";
    name.textContent = entry.name;
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
    if (!entry.folder) actions.appendChild(button("Download", "", function () { download(path, entry.size); }));
    actions.appendChild(button("Delete", "", function () { confirmDelete(actions, [{ path: path, folder: entry.folder }]); }));

    li.appendChild(check);
    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(size);
    li.appendChild(actions);
    li.appendChild(panel);

    li.addEventListener("dragstart", function (e) {
      if (!selected.has(path)) { selected.clear(); selected.add(path); renderSelection(); }
      e.dataTransfer.setData("text/x-crossink-paths", JSON.stringify(selectedItems()));
      e.dataTransfer.effectAllowed = "move";
    });
    if (entry.folder) dropTarget(li, path);
    return li;
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
  }

  function render() {
    renderCrumbs();
    list.textContent = "";
    if (!entries.length) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "This folder is empty. Drop files here to upload them.";
      list.appendChild(empty);
    }
    entries.forEach(function (entry) { list.appendChild(renderRow(entry)); });
    renderSelection();
  }

  connectButton.addEventListener("click", async function () {
    connectButton.disabled = true;
    device.classList.remove("bad");
    device.textContent = "Connecting…";
    try {
      var info = await fs.status();
      device.textContent = "Connected · " + (info.device || "reader") + (info.firmware ? " · firmware " + info.firmware : "");
      connectButton.textContent = "Reconnect";
      browser.hidden = false;
      await open("/");
    } catch (e) {
      device.classList.add("bad");
      device.textContent = friendly(e);
    } finally {
      connectButton.disabled = false;
    }
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

  if (!UsbSend.supported) {
    connectButton.disabled = true;
    device.classList.add("bad");
    device.textContent = "This browser can't use USB. Use Chrome or Edge on a computer.";
  }
})();
