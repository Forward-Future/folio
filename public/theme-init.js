// Applied before the app loads so the first paint uses the saved theme (dark by default).
// Storage can be blocked in the browser edition; the default theme is used then.
try { document.documentElement.dataset.theme = localStorage.getItem("folio:theme") || "dark"; }
catch { document.documentElement.dataset.theme = "dark"; }
