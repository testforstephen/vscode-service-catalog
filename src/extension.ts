'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import * as clipboard from 'clipboardy';
import stringbuffer = require('stringbuffer');

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
    console.log(explorerNode);
    if (explorerNode && explorerNode.fsPath) {
        const languageFolders = utils.readdirSync(explorerNode.fsPath);
        let languageFolder;
        if (languageFolders.length === 1) {
            languageFolder = languageFolders[0];
        } else if (languageFolders.length > 1) {
            languageFolder = await vscode.window.showQuickPick(languageFolders, {
                placeHolder: "Select your application language"
            });
        }
        if (!languageFolder) {
            return;
        }
        const deploymentYamlFilePath = path.join(explorerNode.fsPath, languageFolder, "templates/deployment.yaml")
        if (!fs.existsSync(deploymentYamlFilePath)) {
            vscode.window.showErrorMessage(`Deployment file "${deploymentYamlFilePath}" doesn't exist.`);
            return;
        }

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
            insertEnvToHelmTemplate(deploymentYamlFilePath, secretEnv);
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

interface AccessedNode {
    key: string;
    value: any;
    lastAccessedArrayElement?: any;
    parentNode: any;
}

function insertEnvToHelmTemplate(filePath: string, env: any[]): void {
    const json = convertYamlToJson(filePath);

    if (!json.spec) {
        json.spec = {};
    }
    if (!json.spec.template) {
        json.spec.template = {};
    }
    if (!json.spec.template.spec) {
        json.spec.template.spec = {};
    }
    if (!json.spec.template.spec.containers) {
        json.spec.template.spec.containers = [{}];
    }
    const containers = json.spec.template.spec.containers;
    for (let i = 0; i < containers.length; i++) {
        if (!containers[i].env) {
            containers[i] = {
                env: [],
                ...containers[i]
            };
        }
        containers[i].env = env.concat(containers[i].env);
    }

    const yaml = convertJsonToYaml(json, 2);

    // console.log(yaml);

    fs.writeFileSync(filePath, yaml, "utf-8");
}

function convertYamlToJson(filePath: string): any {
    const rawYamlText = fs.readFileSync(filePath, "utf-8");
    const lines = rawYamlText.split(/\r\n|\n/);
    const yamlFileIndentation = detectIndentationOfYaml(lines);
    const lastAccessedNodeInLevel = new Array<AccessedNode>(100);
    const root: any = {};

    for (let i = 0; i < lines.length; i++) {
        if (!isStandardYamlLine(lines[i])) {
            root[`{{${i}}}`] = lines[i];
            continue;
        }
        const level = findIndentationOfLine(lines[i])/yamlFileIndentation;
        const pair = parsePair(lines[i]);
        if (level === 0) {
            root[pair.key] = pair.value;
            lastAccessedNodeInLevel[level] = {
                key: pair.key,
                value: pair.value,
                parentNode: root
            };
            continue;
        }

        const lastAccessedNode = lastAccessedNodeInLevel[level-1];
        if (pair.startsWithDash) {
            if (!Array.isArray(lastAccessedNode.value)) {
                const newNode: any[] = [];
                lastAccessedNode.parentNode[lastAccessedNode.key] = newNode;
                lastAccessedNode.value = newNode;
            }
            const newNode = {};
            lastAccessedNode.value.push(newNode);
            lastAccessedNode.lastAccessedArrayElement = newNode;
        }

        let parentNode: any = lastAccessedNode.value;
        if (lastAccessedNode.lastAccessedArrayElement) {
            parentNode = lastAccessedNode.lastAccessedArrayElement;
        } else if (typeof lastAccessedNode.value !== 'object') {
            const newNode: any = {};
            lastAccessedNode.value = newNode;
            lastAccessedNode.parentNode[lastAccessedNode.key] = newNode;
            parentNode = newNode;
        }
        parentNode[pair.key] = pair.value;
        lastAccessedNodeInLevel[level] = {
            key: pair.key,
            value: pair.value,
            parentNode
        };
    }

    // console.log(root);
    return root;
}

function convertJsonToYaml(root: any, yamlIndentation: number): string {
    const buffer = new stringbuffer();

    const stack: YamlPair[] = Object.keys(root).reverse().map((key) => {
        return {
            key,
            value: root[key],
            indentation: 0
        };
    });

    while (stack.length) {
        const pair = stack.pop();
        const dashIndentation = pair.startsWithDash ? 2 : 0;
        if (typeof pair.value === 'string') {
            buffer.append(" ".repeat(pair.indentation - dashIndentation));
            if (pair.startsWithDash) {
                buffer.append("- ");
            }
            if (/{{\d+}}/.test(pair.key)) {
                buffer.append(`${pair.value}\n`);
            } else {
                buffer.append(`${pair.key}: ${pair.value}\n`);
            }
        } else if (typeof pair.value === 'object' && !Array.isArray(pair.value)) {
            if (pair.key) {
                buffer.append(" ".repeat(pair.indentation - dashIndentation));
                if (pair.startsWithDash) {
                    buffer.append("- ");
                }
                buffer.append(`${pair.key}:\n`);
            }
            const keys = Object.keys(pair.value);
            for (let i = keys.length - 1; i >= 0; i--) {
                if (i > 0 || pair.key) {
                    stack.push({
                        key: keys[i],
                        value: pair.value[keys[i]],
                        indentation: pair.indentation + 2
                    });
                } else {
                    stack.push({
                        key: keys[i],
                        value: pair.value[keys[i]],
                        indentation: pair.indentation + 2,
                        startsWithDash: true
                    });
                }
            }
        } else if (Array.isArray(pair.value)) {
            buffer.append(" ".repeat(pair.indentation - dashIndentation));
            if (pair.startsWithDash) {
                buffer.append("- ");
            }
            buffer.append(`${pair.key}:\n`);
            for (let i = pair.value.length - 1; i >= 0; i--) {
                stack.push({
                    key: null,
                    value: pair.value[i],
                    indentation: pair.indentation
                });
            }
        }
    }

    return buffer.toString();
}

function detectIndentationOfYaml(lines: string[]): number {
    for (let i = 0; i < lines.length; i++) {
        let spaces = 0;
        for (const character of lines[i]) {
            if (character !== ' ') {
                break;
            }
            spaces++;
        }
        if (spaces) {
            return spaces;
        }
    }
    return 2;
}

function findIndentationOfLine(line: string): number {
    let indentation = 0;
    for (let i = 0; i < line.length; i++) {
        if (line.charAt(i) !== ' '  && line.charAt(i) !== '-') {
            break;
        }
        indentation++;
    }
    return indentation;
}

function isStandardYamlLine(line: string): boolean {
    if (line.trim() === "") {
        return false;
    } else if (line.trim().startsWith("{{")) {
        return false;
    } else if (line.trim().startsWith("#")) {
        return false;
    } else if (line.indexOf(":") < 1) {
        return false;
    }
    return true;
}

interface YamlPair {
    readonly key: string;
    readonly value: any;
    readonly startsWithDash?: boolean;
    readonly indentation?: number;
}

function parsePair(line: string): YamlPair {
    line = line.trim();
    let startsWithDash = false;
    if (line.startsWith("-")) {
        startsWithDash = true;
        line = line.substring(2, line.length).trim();
    }
    const separator = line.indexOf(":");
    return {
        key: line.substring(0, separator).trim(),
        value: line.substring(separator + 1, line.length).trim(),
        startsWithDash
    };
}
