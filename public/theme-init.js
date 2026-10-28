// Applied before the app loads so the first paint uses the saved theme (dark by default).
document.documentElement.dataset.theme = localStorage.getItem("folio:theme") || "dark";
