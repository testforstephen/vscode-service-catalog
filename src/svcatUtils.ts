import { invoke } from "./svcat";

export async function getSvcatResource(resource: string): Promise<string[]> {
    const shellResult = await invoke(`svcat get ${resource}`);
    if (!shellResult || shellResult.code !== 0) {
        return [];
    }
    return extractName(shellResult.stdout);
}

export async function getPlanForClass(className: string): Promise<string[]> {
    const shellResult = await invoke(`svcat get plans --class ${className}`);
    if (!shellResult || shellResult.code !== 0) {
        return [];
    }
    return extractName(shellResult.stdout);
}

function extractName(resultText: string): string[] {
    const result = [];
    const rows = resultText.split("\n");
    const columns = rows[1].trim().split("+");
    const firstColumnWidth = columns[1].length;
    for (let i = 2; i < rows.length; i++) {
        const name = rows[i].substr(1, firstColumnWidth).trim();
        if (name.length) {
            result.push(name);
        }
    }
    return result;
}
