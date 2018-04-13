
import * as shelljs from 'shelljs';
import * as vscode from 'vscode';

export interface ShellResult {
    readonly code : number;
    readonly stdout : string;
    readonly stderr : string;
}

export async function invoke(command : string) : Promise<ShellResult | undefined> {
    return await exec(command);
}

export async function invokeWithProgress(command : string, progressMessage: string) : Promise<ShellResult | undefined> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (progress) => {
        progress.report({ message: progressMessage });
        return await invoke(command);
    });
}

const WINDOWS : string = 'win32';

function isWindows() : boolean {
    return (process.platform === WINDOWS);
}

function home() : string {
    const homeVar = isWindows() ? 'USERPROFILE' : 'HOME';
    return process.env[homeVar];
}

function execOpts() : any {
    let env = process.env;
    if (isWindows()) {
        env = Object.assign({ }, env, { HOME: home() });
    }
    const opts = {
        cwd: vscode.workspace.rootPath,
        env: env,
        async: true
    };
    return opts;
}

async function exec(cmd : string) : Promise<ShellResult | undefined> {
    try {
        return await execCore(cmd, execOpts());
    } catch (ex) {
        vscode.window.showErrorMessage(ex);
    }
}

function execCore(cmd : string, opts : any) : Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, reject) => {
        shelljs.exec(cmd, opts, (code, stdout, stderr) => resolve({code : code, stdout : stdout, stderr : stderr}));
    });
}
