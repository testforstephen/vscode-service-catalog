'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import * as clipboard from 'clipboardy';
import * as glob from 'glob';

import { insertEnvToDraftTemplate } from './draftTemplate';
import * as explorer from './explorer';
import { KubernetesExplorerDataProviderRegistry, KubernetesObject } from './explorer.api';
import * as svcat from './svcat';
import { svcatChannel } from './svcatChannel';
import * as svcatUtils from './svcatUtils';
import * as utils from './utils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const explorerRegistry = await getKubernetesExplorerRegistry();
    if (explorerRegistry) {
        explorerRegistry.register(new explorer.ServiceCatalogProvider());
        await vscode.commands.executeCommand("extension.vsKubernetesRefreshExplorer");
    }

    vscode.commands.registerCommand("extension.vsSvcatGet", svcatGet);
    vscode.commands.registerCommand("extension.vsSvcatDescribe", svcatDescribe);
    vscode.commands.registerCommand("extension.vsSvcatConnectExternalService", connectToExternalService);
}

export function deactivate() {
}

async function getKubernetesExplorerRegistry(): Promise<KubernetesExplorerDataProviderRegistry | undefined> {
    const extension = vscode.extensions.getExtension("ms-kubernetes-tools.vscode-kubernetes-tools");
    if (extension) {
        try {
            const extensionApi = await extension.activate();
            return extensionApi.explorerDataProviderRegistry;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to activate VSCode Kubernetes Tools Extension: ${error}`);
        }
    }
}

function svcatGet(explorerNode: any) {
    let cmd = "svcat get instance";
    if (explorerNode) {
        switch (explorerNode.constructor.name) {
            case "ServiceCatalogResource":
                cmd = `svcat get ${explorerNode.kind} ${explorerNode.id}`;
                break;
            default:
                break;
        }
    }
    svcat.invokeInTerminal(cmd);
}

function svcatDescribe(explorerNode: KubernetesObject) {
    svcat.invokeInTerminal(`svcat describe instance ${explorerNode.id} --traverse`);
}

async function connectToExternalService(explorerNode: any) {
    if (explorerNode && explorerNode.fsPath) {
        const picked = await pickupChart(explorerNode.fsPath);
        if (!picked) {
            return;
        }
        const deploymentYamlFilePath = path.join(explorerNode.fsPath, picked);

        const instances = await svcatUtils.getSvcatResource("instance");
        if (!instances.length) {
            vscode.window.showErrorMessage("Don't find any External Services. Please provision an External Service via svcat first.");
            return;
        }
        const selectedInstance = await vscode.window.showQuickPick(instances, {
            placeHolder: "Select the existing External Service"
        });
        if (!selectedInstance) {
            return;
        }

        let maxRetry = 1;
        let binding = await svcatUtils.getBindingForInstance(selectedInstance);
        if (!binding) {
            binding = await createBinding(selectedInstance);
            maxRetry = 5;
        }
        if (!binding) {
            return;
        }
        
        let secret: string = "";
        for (let retry = 0; retry < maxRetry; retry++) {
            const shellResult = await svcat.invoke(`kubectl get secret/${selectedInstance} -o json`);
            if (shellResult && shellResult.code === 0) {
                secret = shellResult.stdout;
                break;
            }
            await utils.sleep(500);
        }
        if (!secret) {
            vscode.window.showErrorMessage(`Don't find the secret associated with the External Service "${selectedInstance}". Please bind it first.`);
            return;
        }
        const secretJson = JSON.parse(secret);
        let secretEnv = [];
        let secretText: string = "";
        for (const key of Object.keys(secretJson.data)) {
            secretEnv.push({
                name: `${selectedInstance}_${key}`,
                valueFrom: {
                    secretKeyRef: {
                        name: selectedInstance,
                        key: key
                    }
                }
            });
            if (secretText) {
                secretText += ",\n";
            }
            secretText += `"${key}": "${new Buffer(secretJson.data[key], "base64").toString()}"`;
        }

        const answer = await vscode.window.showInformationMessage(`Do you want to mount the secret of External Service "${selectedInstance}" to your deployment.yaml file as Env var?`, "Yes", "No");
        if (answer === "Yes") {
            insertEnvToDraftTemplate(deploymentYamlFilePath, secretEnv);
            vscode.commands.executeCommand("vscode.open", deploymentYamlFilePath);
            vscode.window.showInformationMessage(`Secret "${selectedInstance}" has been mounted as Env var in the file ${deploymentYamlFilePath}. See more details in "${svcatChannel.name()}" Output window.`);
            svcatChannel.appendLine(`Secret "${selectedInstance}" has been mounted as Env var in the file ${deploymentYamlFilePath}:`);
            secretEnv.forEach((env) => {
                svcatChannel.appendLine(`- name: ${env.name}`);
                svcatChannel.appendLine(`  valueFrom: `);
                svcatChannel.appendLine(`    secretKeyRef:`);
                svcatChannel.appendLine(`      name: ${env.valueFrom.secretKeyRef.name}`);
                svcatChannel.appendLine(`      key: ${env.valueFrom.secretKeyRef.key}`);
            });
            svcatChannel.appendLine("Notice that the auto-generated environment variable name may not be same as what's used by your application. Please check the environment variable names and change them on demand.");
            svcatChannel.show(true);
        } else {
            clipboard.write(secretText);
            vscode.window.showInformationMessage(`Secret "${selectedInstance}" was copied to clipboard.`);
        }
    }
}

async function createBinding(instanceName: string, namespace?: string): Promise<string | undefined> {
    const shellResult = await svcat.invoke(`svcat bind ${instanceName}`);
    if (!shellResult || shellResult.code !== 0) {
        vscode.window.showErrorMessage(`Failed to create binding for External Service "${instanceName}". Errors: ${shellResult && shellResult.stderr}`);
        return;
    }
    svcatChannel.appendLine(`A binding and secret are created for the service instance ${instanceName}`);
    return instanceName;
}

async function pickupChart(directory: string): Promise<string | undefined> {
    const result = glob.sync("**/templates/deployment.yaml", {
        cwd: directory,
        nodir: true,
        ignore: "**/charts/**/templates/deployment.yaml"
    });
    if (result.length === 1) {
        return result[0];
    } else if (result.length > 1) {
        return await vscode.window.showQuickPick(result, {
            placeHolder: "Select the target chart"
        });
    }
    vscode.window.showErrorMessage("No charts found!");
    return;
}
