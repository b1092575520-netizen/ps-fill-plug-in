// Copies the freshly built uxp/ folder over the plugin Photoshop actually
// loads (the External install), after backing up what is there now.
// Run through `npm run deploy`, which builds and verifies first.
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const built = path.join(root, "uxp");
const manifest = JSON.parse(fs.readFileSync(path.join(built, "manifest.json"), "utf8"));
const installRoot = process.env.PS_FILL_INSTALL_ROOT
  || "C:\\Program Files\\Common Files\\Adobe\\UXP\\Plugins\\External";
const target = path.join(installRoot, `${manifest.id}_${manifest.version}`);
const files = ["index.html", "manifest.json", "plugin.js", "style.css", "icon.png"];

function git(args) {
  return childProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

const dirty = git(["status", "--porcelain"]);
if (dirty) {
  console.error("工作区还有没提交的改动，先提交再安装，保证装进去的版本能找回：\n" + dirty);
  process.exit(1);
}
for (const file of files) {
  if (!fs.existsSync(path.join(built, file))) {
    console.error(`构建产物缺少 ${file}，请先运行 npm run build:uxp`);
    process.exit(1);
  }
}
if (!fs.existsSync(target)) {
  console.error(`没有找到已安装的插件目录：${target}\n首次安装请用 Creative Cloud 安装 .ccx，之后再用本命令更新。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const backup = path.join(root, "backups", `installed-${stamp}`);
fs.mkdirSync(backup, { recursive: true });
for (const entry of fs.readdirSync(target)) {
  fs.copyFileSync(path.join(target, entry), path.join(backup, entry));
}

for (const file of files) {
  fs.copyFileSync(path.join(built, file), path.join(target, file));
}
const commit = git(["log", "-1", "--format=%h %ci %s"]);
fs.writeFileSync(path.join(target, "build-info.txt"), `${commit}\n`, "utf8");

console.log(`已安装到 ${target}`);
console.log(`版本：${commit}`);
console.log(`上一版已备份到 ${backup}`);
console.log("重启 Photoshop 后生效。");
