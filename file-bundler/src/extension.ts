import * as vscode from "vscode";
import { BundlerSidebar } from "./sidebar";

export function activate(context: vscode.ExtensionContext) {
  const provider = new BundlerSidebar(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BundlerSidebar.viewType, provider)
  );
}

export function deactivate() {}