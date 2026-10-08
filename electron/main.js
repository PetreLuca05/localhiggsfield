/* Electron shell for the studio. The Next app keeps its server actions (they
   hold the platform key and call the generation API), so the window cannot
   load static files: it needs a Next server beside it. This process starts
   one as a child — `next dev` under `pnpm electron:dev`, the standalone
   build otherwise — on a free loopback port, and points the window at it. */

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEV = !app.isPackaged && process.argv.includes("--dev");
const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_ENV = {
  HF_API_BASE_URL: "https://platform.higgsfield.ai",
  OPEN_HIGGSFIELD_READ_WRITE_TOKEN: "",
};

let server = null;
let mainWindow = null;
let quitting = false;

/* The settings file. In dev it is the repo's .env.local, which `next dev`
   reads on its own. A packaged app has no repo, so it keeps one in the
   user-data folder (%APPDATA%\OpenHiggsfield on Windows), created on first
   launch with the API origin filled in. */
function envFilePath() {
  return DEV ? path.join(REPO_ROOT, ".env.local") : path.join(app.getPath("userData"), ".env");
}

function ensureEnvFile(file) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    "# OpenHiggsfield settings. Restart the app after editing.",
    "# Generation API origin.",
    `HF_API_BASE_URL=${DEFAULT_ENV.HF_API_BASE_URL}`,
    "# Vercel Blob read-write token. Only needed to attach images/video/audio",
    "# as inputs; text-to-image and text-to-video work without it.",
    "OPEN_HIGGSFIELD_READ_WRITE_TOKEN=",
    "",
  ].join("\n");
  fs.writeFileSync(file, body);
}

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not answer at ${url} within ${timeoutMs / 1000}s`);
}

/* The child runs on Electron's own Node (ELECTRON_RUN_AS_NODE), so the
   packaged app needs no Node.js install on the machine. */
async function startServer() {
  const file = envFilePath();
  ensureEnvFile(file);
  const port = await freePort();
  const env = {
    ...process.env,
    ...DEFAULT_ENV,
    ...readEnvFile(file),
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  let args;
  let cwd;
  if (DEV) {
    cwd = REPO_ROOT;
    args = [path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--port", String(port), "--hostname", "127.0.0.1"];
  } else {
    cwd = app.isPackaged
      ? path.join(process.resourcesPath, "server")
      : path.join(REPO_ROOT, "electron-server");
    const entry = path.join(cwd, "server.js");
    if (!fs.existsSync(entry)) {
      throw new Error(`No server build at ${entry}. Run \`pnpm electron:build\` first.`);
    }
    env.NODE_ENV = "production";
    args = [entry];
  }

  server = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    /* Its own process group, so quitting can take down the workers `next dev`
       spawns along with it. */
    detached: process.platform !== "win32",
  });
  server.on("exit", (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox("OpenHiggsfield", `The studio server stopped (exit code ${code}).`);
      app.quit();
    }
  });

  const url = `http://127.0.0.1:${port}/`;
  await waitForServer(url, server, DEV ? 120_000 : 30_000);
  return url;
}

function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  if (process.platform === "win32") {
    /* `next dev` spawns workers; kill the whole tree. */
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function buildMenu() {
  const settingsFile = envFilePath();
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Settings File…",
          click: () => {
            ensureEnvFile(settingsFile);
            shell.openPath(settingsFile);
          },
        },
        {
          label: "Restart Server",
          click: () => {
            app.relaunch();
            app.quit();
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* Saves land in Downloads without a dialog: bulk download in the studio
   saves files one after another, and a dialog per file would stall it. */
function saveDownloadsToDisk(session) {
  session.on("will-download", (_event, item) => {
    const folder = app.getPath("downloads");
    const parsed = path.parse(item.getFilename() || "download");
    let target = path.join(folder, parsed.base);
    for (let n = 1; fs.existsSync(target); n++) {
      target = path.join(folder, `${parsed.name} (${n})${parsed.ext}`);
    }
    item.setSavePath(target);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0b",
    title: "OpenHiggsfield",
    icon: path.join(__dirname, "icon.png"),
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  saveDownloadsToDisk(mainWindow.webContents.session);

  /* Links that leave the studio open in the default browser. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const url = process.env.OHF_ELECTRON_URL || (await startServer());
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });
  await mainWindow.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      await createWindow();
    } catch (error) {
      dialog.showErrorBox("OpenHiggsfield", error instanceof Error ? error.message : String(error));
      quitting = true;
      stopServer();
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
}
