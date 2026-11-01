// Light/dark switch in the header. Loaded in <head> so a saved choice applies
// before the page paints. Without a saved choice the page follows the system.
(function () {
  "use strict";
  var KEY = "crossink-theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function current() {
    var s = saved();
    if (s === "light" || s === "dark") return s;
    return media && media.matches ? "dark" : "light";
  }
  function apply() {
    var s = saved();
    if (s === "light" || s === "dark") root.setAttribute("data-theme", s);
    else root.removeAttribute("data-theme");
    var now = current();
    root.setAttribute("data-theme-now", now);
    var button = document.getElementById("themeSwitch");
    if (button) button.setAttribute("aria-label", now === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }

  apply();
  if (media && media.addEventListener) media.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("themeSwitch");
    if (!button) return;
    apply();
    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      // Picking the system's own mode goes back to following the system.
      var system = media && media.matches ? "dark" : "light";
      try {
        if (next === system) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch (e) {
        root.setAttribute("data-theme", next);  // Storage blocked: switch for this page only
        root.setAttribute("data-theme-now", next);
        return;
      }
      apply();
    });
  });
})();
