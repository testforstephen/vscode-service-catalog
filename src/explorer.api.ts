import * as vscode from "vscode";

export interface KubernetesObject {
    readonly id: string;
    readonly metadata?: any;
    getChildren(kubectl: any, host: any): vscode.ProviderResult<KubernetesObject[]>;
    getTreeItem(): vscode.TreeItem | Thenable<vscode.TreeItem>;
}

export interface ExplorerDataProvider {
    getChildren(parent: KubernetesObject): Promise<KubernetesObject[]>;
}

export interface KubernetesExplorerDataProviderRegistry {
    register(dataProvider: ExplorerDataProvider): void;
    list(): Array<ExplorerDataProvider>;
}
