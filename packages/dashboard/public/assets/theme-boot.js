// Applies the saved dashboard theme to <html data-theme> before the first paint,
// so the window never flashes the wrong palette while the app bundle loads.
// Loaded as a blocking classic script from index.html; it lives under
// /assets/ because serve mode only serves files from that directory and the
// Content-Security-Policy (script-src 'self') forbids inline scripts.
// Keep in sync with src/lib/theme.ts (src/lib/theme-boot.test.ts checks this).
(function () {
  var preference = "system";
  try {
    var saved = window.localStorage.getItem("magic-context-dashboard.theme");
    if (saved === "light" || saved === "dark" || saved === "system") preference = saved;
  } catch (_error) {
    // Storage unavailable: follow the operating system.
  }
  var systemDark = false;
  try {
    systemDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (_error) {
    systemDark = false;
  }
  var dark = preference === "dark" || (preference === "system" && systemDark);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
