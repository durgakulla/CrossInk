// Reads and changes an EPUB's title and author (its package file's first
// dc:title and its dc:creator entries) with JSZip, leaving every other file
// in the book as it was. Edits are made to the package file's text, not a
// re-serialised DOM, so nothing else in it changes.
(function () {
  "use strict";

  function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function decode(xmlText) {
    var doc = new DOMParser().parseFromString("<x>" + xmlText + "</x>", "application/xml");
    // An entity XML doesn't define (an EPUB 2 book's &nbsp;, say) fails to parse; show the raw text then.
    var text = doc.getElementsByTagName("parsererror").length ? xmlText.replace(/<[^>]*>/g, "") : doc.documentElement.textContent;
    return text.replace(/\s+/g, " ").trim();
  }

  // Elements named local (any prefix) inside <metadata>: [{start, end, open, attrs, inner}].
  function elements(opf, local) {
    var meta = /<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/.exec(opf);
    if (!meta) return [];
    var re = new RegExp("<((?:\\w+:)?" + local + ")\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1\\s*>)", "g");
    var found = [];
    var m;
    while ((m = re.exec(meta[0]))) {
      found.push({ start: meta.index + m.index, end: meta.index + m.index + m[0].length, tag: m[1],
                   attrs: m[2], inner: m[3] || "" });
    }
    return found;
  }

  // The book's title and author as the reader shows them (creators joined
  // with ", ", like ContentOpfParser).
  async function read(zip) {
    var container = zip.file("META-INF/container.xml");
    if (!container) throw new Error("This EPUB has no META-INF/container.xml.");
    var path = /full-path="([^"]+)"/.exec(await container.async("string"));
    var opfFile = path && zip.file(path[1]);
    if (!opfFile) throw new Error("This EPUB's package file is missing.");
    var opf = await opfFile.async("string");
    var titles = elements(opf, "title");
    var creators = elements(opf, "creator");
    return {
      opfPath: path[1], opf: opf,
      title: titles.length ? decode(titles[0].inner) : "",
      author: creators.map(function (c) { return decode(c.inner); }).filter(Boolean).join(", "),
    };
  }

  // Replaces [start, end) ranges in text, last first so offsets stay valid.
  function splice(text, edits) {
    edits.sort(function (a, b) { return b.start - a.start; });
    edits.forEach(function (e) { text = text.slice(0, e.start) + e.text + text.slice(e.end); });
    return text;
  }

  // Drops opf:file-as from an element's attributes; it would still sort by the old name.
  function withoutFileAs(attrs) { return attrs.replace(/\s+(?:\w+:)?file-as\s*=\s*("[^"]*"|'[^']*')/g, ""); }

  // Metadata <meta> refinements of an element id with one of these properties.
  function refinements(opf, id, properties) {
    if (!id) return [];
    return elements(opf, "meta").filter(function (m) {
      var refines = /\brefines\s*=\s*["']#([^"']+)["']/.exec(m.attrs);
      var property = /\bproperty\s*=\s*["']([^"']+)["']/.exec(m.attrs);
      return refines && refines[1] === id && (!properties || (property && properties.indexOf(property[1]) >= 0));
    });
  }
  function idOf(attrs) { var m = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs); return m ? m[1] : ""; }

  // The package file with a new title and/or author. A new author replaces
  // every dc:creator with one (keeping the first one's attributes, such as
  // its role) and drops the others' refinements.
  function write(info, title, author) {
    var opf = info.opf;
    var edits = [];
    if (title !== info.title) {
      var t = elements(opf, "title")[0];
      if (!t) throw new Error("This EPUB has no title to change.");
      edits.push({ start: t.start, end: t.end, text: "<" + t.tag + t.attrs + ">" + escapeXml(title) + "</" + t.tag + ">" });
      refinements(opf, idOf(t.attrs), ["file-as"]).forEach(function (m) { edits.push({ start: m.start, end: m.end, text: "" }); });
      elements(opf, "meta").forEach(function (m) {
        if (/\bname\s*=\s*["']calibre:title_sort["']/.test(m.attrs)) edits.push({ start: m.start, end: m.end, text: "" });
      });
    }
    if (author !== info.author) {
      var creators = elements(opf, "creator");
      if (!creators.length) throw new Error("This EPUB has no author to change.");
      creators.forEach(function (c, i) {
        var id = idOf(c.attrs);
        if (i === 0) {
          edits.push({ start: c.start, end: c.end,
                       text: "<" + c.tag + withoutFileAs(c.attrs) + ">" + escapeXml(author) + "</" + c.tag + ">" });
          refinements(opf, id, ["file-as"]).forEach(function (m) { edits.push({ start: m.start, end: m.end, text: "" }); });
        } else {
          edits.push({ start: c.start, end: c.end, text: "" });
          refinements(opf, id, null).forEach(function (m) { edits.push({ start: m.start, end: m.end, text: "" }); });
        }
      });
    }
    return splice(opf, edits);
  }

  // The edited book as a Blob, mimetype first and uncompressed as EPUB requires.
  async function save(zip, info, title, author) {
    zip.file(info.opfPath, write(info, title, author), { createFolders: false });
    if (zip.file("mimetype")) zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/epub+zip" });
  }

  window.EpubMeta = { read: read, write: write, save: save };
})();
