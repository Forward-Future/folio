const path = require("node:path");

function systemPowerShell() {
  // Windows maps this Known DLL into every process before application code runs. Its directory comes from
  // the loaded image, independent of the launch folder, PATH, or a caller-supplied SystemRoot.
  const ntdll = process.report.getReport().sharedObjects.find((name) => /^[a-z]:\\.*\\(?:system32|syswow64)\\ntdll\.dll$/i.test(name));
  if (!ntdll) throw new Error("Windows PowerShell is unavailable.");
  return path.win32.join(path.win32.dirname(ntdll), "WindowsPowerShell", "v1.0", "powershell.exe");
}

module.exports = { systemPowerShell };
