import * as vscode from "vscode";

import { ExplorerDataProvider, KubernetesObject } from "./explorer.api";
import { getSvcatResource } from "./svcatUtils";

export class ServiceCatalogProvider implements ExplorerDataProvider {
    async getChildren(parent: KubernetesObject): Promise<KubernetesObject[]> {
        if (parent) {
            switch (parent.constructor.name) {
                case "KubernetesCluster":
                    return [
                        new ServiceCatalogFolder("svcat", "External Services")
                    ];
            }
        }
        return [];
    }
}

export class ServiceCatalogFolder implements KubernetesObject {
    constructor(readonly id: string, readonly displayName: string, readonly metadata?: any) {
    }

    async getChildren(kubectl: any, host: any): Promise<KubernetesObject[]> {
        const resources = await getSvcatResource("instance");
        return resources.map((name) => {
            return new ServiceCatalogResource(name, "instance");  
        });
    }

    getTreeItem(): vscode.TreeItem | Thenable<vscode.TreeItem> {
        const treeItem = new vscode.TreeItem(this.displayName, vscode.TreeItemCollapsibleState.Collapsed);
        treeItem.contextValue = `vsSvcat`;
        return treeItem;
    }
}

export class ServiceCatalogResource implements KubernetesObject {
    constructor(readonly id: string, readonly kind: string, readonly metadata?: any) {
    }

    async getChildren(kubectl: any, host: any): Promise<KubernetesObject[]> {
        return [];
    }

    getTreeItem(): vscode.TreeItem | Thenable<vscode.TreeItem> {
        const treeItem = new vscode.TreeItem(this.id, vscode.TreeItemCollapsibleState.None);
        treeItem.contextValue = `vsSvcat.${this.kind}`;
        return treeItem;
    }
}
