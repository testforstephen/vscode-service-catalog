'use strict';

import * as vscode from 'vscode';

import * as explorer from './explorer';
import { KubernetesExplorerDataProviderRegistry } from './explorer.api';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('Congratulations, your extension "vscode-service-catalog" is now active!');

    const explorerRegistry = await getKubernetesExplorerRegistry();
    if (explorerRegistry) {
        console.log(explorerRegistry.constructor.name);
        explorerRegistry.register(new explorer.ServiceCatalogProvider());
        await vscode.commands.executeCommand("extension.vsKubernetesRefreshExplorer");
    }
}

export function deactivate() {
}

async function getKubernetesExplorerRegistry(): Promise<KubernetesExplorerDataProviderRegistry | undefined> {
    for (const extension of vscode.extensions.all) {
        if (extension.id === "ms-kubernetes-tools.vscode-kubernetes-tools") {
            try {
                const extensionApi = await extension.activate();
                return extensionApi.explorerDataProviderRegistry;
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to activate VSCode Kubernetes Tools Extension: ${error}`);
            }
            break;
        }
    }
}
