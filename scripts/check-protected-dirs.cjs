const childProcess = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const expected = {
  "compact-panel-demo": {
    files: 35,
    digest: "aa333f4b1ec57635a90194e93449557a797a5b998915afe72fdf05ffde7fe487",
  },
  "compact-panel-demo-v2": {
    files: 4808,
    digest: "d83e11a32fd8bf9a3ac3b6d6080902744ccabc007fd5cce516f469422b4162d6",
  },
};

for (const [name, baseline] of Object.entries(expected)) {
  const directory = path.join(root, name);
  const script = [
    "$root=(Resolve-Path -LiteralPath $env:PROTECTED_DIR).Path",
    "$rows=@(Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName | ForEach-Object {",
    "  $rel=$_.FullName.Substring($root.Length+1).Replace('\\','/')",
    "  $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()",
    '  "$rel`t$hash"',
    "})",
    "$algo=[Security.Cryptography.SHA256]::Create()",
    "try {",
    '  $bytes=[Text.Encoding]::UTF8.GetBytes(($rows -join "`n"))',
    "  $sum=([BitConverter]::ToString($algo.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()",
    "} finally { $algo.Dispose() }",
    'Write-Output "$($rows.Count)`t$sum"',
  ].join("; ");
  const output = childProcess.execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { encoding: "utf8", env: { ...process.env, PROTECTED_DIR: directory } },
  ).trim();
  const [fileCount, digest] = output.split("\t");
  if (Number(fileCount) !== baseline.files || digest !== baseline.digest) {
    throw new Error(`${name} changed: ${fileCount} files, ${digest}`);
  }
  console.log(`${name}: ${fileCount} files, ${digest}`);
}
