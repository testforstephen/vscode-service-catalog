import * as vscode from "vscode";

export interface ISvcatChannel {
    appendLine(message: any);
    append(message: any);
    show(preserveFocus?: boolean);
    name(): string;
}

class SvcatChannel implements ISvcatChannel {
    private readonly channel: vscode.OutputChannel = vscode.window.createOutputChannel("Service Catalog");

    appendLine(message: any) {
        this.channel.appendLine(message);
    }

    append(message: any) {
        this.channel.append(message);
    }

    show(preserveFocus?: boolean) {
        this.channel.show(preserveFocus);
    }

    name(): string {
        return this.channel.name;
    }
}

export const svcatChannel: ISvcatChannel = new SvcatChannel();
