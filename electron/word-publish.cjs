// In its own process, the current directory pins the original folder across renames. Every destination
// below is relative to that directory, even if a parent symlink is redirected during conversion.
const fs = require("node:fs");
const fsp = fs.promises;
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const path = require("node:path");
const { sameFile, pdfName } = require("./document-files.cjs");
const { systemPowerShell } = require("./windows-powershell.cjs");

// Windows ignores POSIX mode bits. Supply a protected, current-user-only DACL to CreateNew before writing any bytes.
const PRIVATE_COPY = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
$inputFile = [IO.File]::OpenRead($env:FOLIO_SOURCE)
$created = $false
try {
  $rights = [Security.AccessControl.FileSystemRights]'Write, ReadPermissions'
  $outputFile = [IO.FileStream]::new($env:FOLIO_TARGET, 'CreateNew', $rights, 'None', 65536, 'None', $acl)
  $created = $true
  try {
    if (-not $outputFile.GetAccessControl().AreAccessRulesProtected) { throw 'Cannot keep this PDF private.' }
    $inputFile.CopyTo($outputFile)
  } finally { $outputFile.Dispose() }
  for ($i = 1; $i -le 99; $i++) {
    $suffix = if ($i -eq 1) { '' } else { " ($i)" }
    try {
      [IO.File]::Move($env:FOLIO_TARGET, $env:FOLIO_STEM + $suffix + '.pdf')
      $created = $false
      Write-Output $i
      break
    } catch [IO.IOException] { if (($_.Exception.GetBaseException().HResult -band 65535) -notin 80, 183) { throw } }
  }
} finally {
  $inputFile.Dispose()
  if ($created) { [IO.File]::Delete($env:FOLIO_TARGET) }
}
`;

async function copyExclusive(ready, name) {
  const file = await fsp.open(name, "wx", 0o600);
  const stat = await file.stat({ bigint: true });
  try {
    if (stat.mode & 0o077n) throw new Error("Cannot keep this PDF private.");
    await file.writeFile(fs.createReadStream(ready));
  } catch (error) {
    if (sameFile(stat, await fsp.lstat(name, { bigint: true }))) await fsp.unlink(name);
    throw error;
  } finally { await file.close(); }
}

async function publish({ location, ready }) {
  process.chdir(location.folder);
  if (!sameFile(await fsp.stat(".", { bigint: true }), location.directory)) return null;
  const source = await fsp.lstat(location.name, { bigint: true });
  if (!source.isFile() || source.nlink !== 1n || !sameFile(source, location.source) || source.ctimeNs !== location.source.ctimeNs) return null;

  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(systemPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PRIVATE_COPY], {
      windowsHide: true, timeout: 60_000, env: { ...process.env, FOLIO_SOURCE: ready, FOLIO_STEM: path.parse(location.name).name,
        FOLIO_TARGET: ".folio-" + crypto.randomUUID() + ".tmp" },
    });
    return Number(stdout.trim()) || null;
  }
  // A macOS ACL can grant access even with mode 0600. Remove it on our private inode and publish only by
  // linking that inode. A new file in the receiving directory could inherit a different ACL.
  if (process.platform === "darwin") await promisify(execFile)("/bin/chmod", ["-N", ready]);
  // On Linux, an exclusive owner-only copy also supports volumes and filesystems without hard links.
  for (let index = 1; index <= 99; index++) {
    const name = pdfName(location.name, index);
    try {
      try { await fsp.link(ready, name); }
      catch (error) {
        if (!["EXDEV", "EPERM", "ENOTSUP", "ENOSYS", "EMLINK"].includes(error.code)) throw error;
        if (process.platform === "darwin") return null;
        await copyExclusive(ready, name);
      }
      return index;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return null;
}

if (process.parentPort) process.parentPort.once("message", async ({ data }) => {
  try { process.parentPort.postMessage({ index: await publish(data) }); }
  catch (error) { process.parentPort.postMessage({ error: error.message }); }
});

module.exports = { publish };
