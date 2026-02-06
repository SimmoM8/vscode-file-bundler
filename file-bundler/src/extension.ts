import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";

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

const MAX_FILE_BYTES = 500_000; // 500 KB per file (MVP safety cap)
const BINARY_SNIFF_BYTES = 8000;

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "fileBundler.bundleFolder",
    async () => {
      try {
        const folderUris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "Select folder to bundle",
        });

        if (!folderUris || folderUris.length === 0) return;

        const root = folderUris[0].fsPath;

        const files = await listFilesRecursive(root);
        files.sort((a, b) => a.localeCompare(b));

        const parts: string[] = [];
        let included = 0;
        let skipped = 0;

        for (const absPath of files) {
          const rel = path.relative(root, absPath).replace(/\\/g, "/");
          const ext = path.extname(absPath).toLowerCase();

          if (IGNORE_EXTS.has(ext)) {
            skipped++;
            continue;
          }

          const stat = await fs.stat(absPath);
          if (stat.size > MAX_FILE_BYTES) {
            skipped++;
            continue;
          }

          const isProbablyBinary = await sniffBinary(absPath);
          if (isProbablyBinary) {
            skipped++;
            continue;
          }

          let content: string;
          try {
            content = await fs.readFile(absPath, "utf8");
          } catch {
            skipped++;
            continue;
          }

          // Normalize newlines for consistent output
          content = content.replace(/\r\n/g, "\n");

          // Your format: file_name.*:
          // We'll use relative path as "file name" to avoid collisions
          parts.push(`${rel}:\n${content}`);
          included++;
        }

        const output = parts.join(SEP);

        await vscode.env.clipboard.writeText(output);

        // Open preview tab
        const doc = await vscode.workspace.openTextDocument({
          content: output,
          language: "text",
        });
        await vscode.window.showTextDocument(doc, { preview: false });

        vscode.window.showInformationMessage(
          `Bundled ${included} file(s) (skipped ${skipped}). Copied to clipboard.`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `File Bundler failed: ${err?.message ?? String(err)}`
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}

// --- helpers ---

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

      // If there's a null byte, it's very likely binary
      if (slice.includes(0)) return true;

      // Heuristic: if too many control chars (excluding \n\r\t), treat as binary-ish
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
    // If we can't read it, skip it (treat as binary/unreadable)
    return true;
  }
}