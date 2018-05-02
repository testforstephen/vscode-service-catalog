import * as fs from "fs";
import stringbuffer = require("stringbuffer");

interface YamlNode {
    key: string;
    value: any;
    parentNode: any;
    lastListMember?: any;
}

export function insertEnvToDraftTemplate(filePath: string, env: any[]): void {
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

    fs.writeFileSync(filePath, yaml, "utf-8");
}


function convertYamlToJson(filePath: string): any {
    const rawYamlText = fs.readFileSync(filePath, "utf-8");
    const lines = rawYamlText.split(/\r\n|\n/);
    const yamlFileIndentation = detectIndentationOfYamlFile(lines);
    const recentlyVisitedNodeInGivenLevel = new Array<YamlNode>(100);
    const documentRoot: any = {};

    for (let i = 0; i < lines.length; i++) {
        if (!canBeParsedToKeyValuePair(lines[i])) {
            documentRoot[`{{${i}}}`] = lines[i];
            continue;
        }
        const level = findIndentationOfLine(lines[i])/yamlFileIndentation;
        const yamlPair = resolveYamlPair(lines[i]);
        if (level === 0) {
            documentRoot[yamlPair.key] = yamlPair.value;
            recentlyVisitedNodeInGivenLevel[level] = {
                key: yamlPair.key,
                value: yamlPair.value,
                parentNode: documentRoot
            };
            continue;
        }

        const recentlyVisitedNode = recentlyVisitedNodeInGivenLevel[level-1];
        if (yamlPair.startsWithDash) {
            // The parent node should be an array. If not, correct its data type.
            if (!Array.isArray(recentlyVisitedNode.value)) {
                const newArray: any[] = [];
                recentlyVisitedNode.parentNode[recentlyVisitedNode.key] = newArray;
                recentlyVisitedNode.value = newArray;
            }
            const newListMember = {};
            recentlyVisitedNode.value.push(newListMember);
            recentlyVisitedNode.lastListMember = newListMember;
        }

        let parentNode: any = recentlyVisitedNode.value;
        if (recentlyVisitedNode.lastListMember) {
            parentNode = recentlyVisitedNode.lastListMember;
        } else if (typeof recentlyVisitedNode.value !== 'object') {
            // The parent node should be an object. If not, correct its data type.
            const newMap: any = {};
            recentlyVisitedNode.value = newMap;
            recentlyVisitedNode.parentNode[recentlyVisitedNode.key] = newMap;
            parentNode = newMap;
        }
        parentNode[yamlPair.key] = yamlPair.value;
        recentlyVisitedNodeInGivenLevel[level] = {
            key: yamlPair.key,
            value: yamlPair.value,
            parentNode
        };
    }

    return documentRoot;
}


function convertJsonToYaml(documentRoot: any, yamlIndentation: number): string {
    const buffer = new stringbuffer();

    const stack: YamlPair[] = Object.keys(documentRoot).reverse().map((key) => {
        return {
            key,
            value: documentRoot[key],
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
                buffer.append(`${pair.value}`);
            } else {
                buffer.append(`${pair.key}: ${pair.value}`);
            }
            // If the processing node is arriving at the document end, no need to print the additional LF.
            if (stack.length) {
                buffer.append("\n");
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
                    // Insert a dash at the first property of the list member.
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

function detectIndentationOfYamlFile(lines: string[]): number {
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

function canBeParsedToKeyValuePair(line: string): boolean {
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

function resolveYamlPair(line: string): YamlPair {
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
