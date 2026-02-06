import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";

const SEP = "\n\n--\n\n";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
]);

const IGNORE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".pdf",
  ".zip", ".rar", ".7z", ".tar", ".gz",
  ".mp3", ".wav", ".mp4", ".mov",
  ".woff", ".woff2", ".ttf", ".otf",
  ".exe", ".dll", ".dmg", ".app",
]);

const MAX_FILE_BYTES = 500_000;
const BINARY_SNIFF_BYTES = 8000;

type BundleOptions = {
  useBasenameOnly: boolean;
};

export class BundlerSidebar implements vscode.WebviewViewProvider {
  public static readonly viewType = "fileBundler.sidebar";

  private view?: vscode.WebviewView;
  private targetRoot: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "useWorkspace") {
          const wf = vscode.workspace.workspaceFolders?.[0];
          if (!wf) {
            vscode.window.showErrorMessage("No workspace folder is open.");
            return;
          }
          this.targetRoot = wf.uri.fsPath;
          this.postState();
        }

        if (msg.type === "pickFolder") {
          const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select folder to bundle",
          });
          if (!folderUris || folderUris.length === 0) return;
          this.targetRoot = folderUris[0].fsPath;
          this.postState();
        }

        if (msg.type === "bundleCopy" || msg.type === "bundlePreview") {
          if (!this.targetRoot) {
            vscode.window.showErrorMessage("Select a target folder first.");
            return;
          }

          const opts: BundleOptions = {
            useBasenameOnly: !!msg.useBasenameOnly,
          };

          const output = await bundleFolder(this.targetRoot, opts);

          await vscode.env.clipboard.writeText(output);

          if (msg.type === "bundlePreview") {
            const doc = await vscode.workspace.openTextDocument({
              content: output,
              language: "text",
            });
            await vscode.window.showTextDocument(doc, { preview: false });
          }

          vscode.window.showInformationMessage(
            "Bundled output copied to clipboard."
          );
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `File Bundler error: ${err?.message ?? String(err)}`
        );
      }
    });

    // Default target to workspace folder if available
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (wf) {
      this.targetRoot = wf.uri.fsPath;
      this.postState();
    }
  }

  private postState() {
    this.view?.webview.postMessage({
      type: "state",
      targetRoot: this.targetRoot,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());

    return /* html */ `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta http-equiv="Content-Security-Policy"
            content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>File Bundler</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, Segoe WPC, Segoe UI, sans-serif; padding: 12px; }
            .row { margin: 10px 0; }
            button { width: 100%; padding: 8px; margin: 6px 0; }
            .muted { opacity: 0.75; font-size: 12px; word-break: break-all; }
            label { display: flex; gap: 8px; align-items: center; }
          </style>
        </head>
        <body>
          <h3>File Bundler</h3>

          <div class="row">
            <div class="muted">Target folder:</div>
            <div id="target" class="muted">(none)</div>
          </div>

          <div class="row">
            <button id="useWorkspace">Use Workspace Folder</button>
            <button id="pickFolder">Pick Folder…</button>
          </div>

          <div class="row">
            <label>
              <input type="checkbox" id="basenameOnly" />
              Use base file name only
            </label>
            <div class="muted">If off, uses relative paths (recommended).</div>
          </div>

          <div class="row">
            <button id="bundleCopy">Bundle & Copy</button>
            <button id="bundlePreview">Bundle, Copy & Preview</button>
          </div>

          <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();

            const targetEl = document.getElementById("target");
            const basenameOnlyEl = document.getElementById("basenameOnly");

            document.getElementById("useWorkspace").addEventListener("click", () => {
              vscode.postMessage({ type: "useWorkspace" });
            });

            document.getElementById("pickFolder").addEventListener("click", () => {
              vscode.postMessage({ type: "pickFolder" });
            });

            document.getElementById("bundleCopy").addEventListener("click", () => {
              vscode.postMessage({
                type: "bundleCopy",
                useBasenameOnly: basenameOnlyEl.checked
              });
            });

            document.getElementById("bundlePreview").addEventListener("click", () => {
              vscode.postMessage({
                type: "bundlePreview",
                useBasenameOnly: basenameOnlyEl.checked
              });
            });

            window.addEventListener("message", (event) => {
              const msg = event.data;
              if (msg.type === "state") {
                targetEl.textContent = msg.targetRoot ?? "(none)";
              }
            });
          </script>
        </body>
      </html>
    `;
  }
}

// --- core bundling ---
async function bundleFolder(root: string, opts: BundleOptions): Promise<string> {
  const files = await listFilesRecursive(root);
  files.sort((a, b) => a.localeCompare(b));

  const parts: string[] = [];

  for (const absPath of files) {
    const ext = path.extname(absPath).toLowerCase();
    if (IGNORE_EXTS.has(ext)) continue;

    const stat = await fs.stat(absPath);
    if (stat.size > MAX_FILE_BYTES) continue;

    if (await sniffBinary(absPath)) continue;

    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }

    content = content.replace(/\r\n/g, "\n");

    const label = opts.useBasenameOnly
      ? path.basename(absPath)
      : path.relative(root, absPath).replace(/\\/g, "/");

    parts.push(`${label}:\n${content}`);
  }

  return parts.join(SEP);
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }

  await walk(root);
  return out;
}

async function sniffBinary(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      const slice = buf.subarray(0, bytesRead);

      if (slice.includes(0)) return true;

      let weird = 0;
      for (const b of slice) {
        if (b < 9) weird++;
        else if (b > 13 && b < 32) weird++;
      }
      return bytesRead > 0 && weird / bytesRead > 0.2;
    } finally {
      await handle.close();
    }
  } catch {
    return true;
  }
}