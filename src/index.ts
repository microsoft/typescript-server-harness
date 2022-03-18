import cp = require("child_process");

type EventListener = (obj: any) => void;
type ExitListener = (code: number | null) => void;

export interface Server {
    /** Returns the response (or event) with the matching `request_seq`. */
    message(request: any): Promise<any>;
    /** Kills the server, regardless of its current state. */
    kill(): void;
    /** Fires when an event is received from the server. */
    on(event: "event", listener: EventListener): void;
    /** Fires when the server exits. */
    on(event: "exit", listener: ExitListener): void;
}

/**
 * Forks a new server process.  By default, the server will not have ATA or produce diagnostic events.
 */
export function launchServer(tsserverPath: string, args?: string[], execArgv?: string[]): Server {
    const eventListeners: EventListener[] = [];
    const exitListeners: ExitListener[] = [];

    const serverProc = cp.fork(
        tsserverPath,
        args ?? [ "--disableAutomaticTypingAcquisition" ],
        {
            execArgv: execArgv ?? process.execArgv?.map(arg => bumpDebugPort(arg)),
            stdio: ["pipe", "pipe", "ignore", "ipc"]
        });

    const useNodeIpc = !!args && !!args.filter(a => a.toLocaleLowerCase() === "--useNodeIpc".toLocaleLowerCase()).length;

    const getNext = makeListeners(serverProc, useNodeIpc, eventListeners);

    serverProc.on("exit", code => {
        for (const listener of exitListeners) {
            listener(code);
        }
    });

    function on(event: "event", listener: EventListener): void;
    function on(event: "exit", listener: ExitListener): void;
    function on(event: "event" | "exit", listener: EventListener | ExitListener): void {
        switch (event) {
            case "event":
                eventListeners.push(listener as EventListener);
                break;
            case "exit":
                exitListeners.push(listener as ExitListener);
                break;
        }
    }

    return {
        message: request => message(serverProc, useNodeIpc, getNext, request),
        kill: () => serverProc.kill(),
        on,
    };
}

function bumpDebugPort(arg: string): string {
    const match = /^(--inspect(?:-brk)?)(?:=(\d+))?$/.exec(arg);
    return match
        ? `${match[1]}=${match[2] ? (+match[2] + 1) : 9230}`
        : arg;
}

function makeListeners(serverProc: cp.ChildProcess, useNodeIpc: boolean, eventListeners: readonly EventListener[]): (seq: number) => Promise<any> {
    const waiters = new Map<number, ((obj: any) => void)>();
    const objects = new Map<number, any>();

    if (useNodeIpc) {
        serverProc.on('message', handleMessage);
    }
    else {
        let unconsumedText = "";
        let currentLength = -1;
        serverProc.stdout!.on('data', buffer => {
            unconsumedText += buffer.toString("utf8");

            while (true) {
                if (currentLength < 0) {
                    const headerMatch = unconsumedText.match(/Content-Length: (\d+)/);
                    if (!headerMatch) break;
                    currentLength = +headerMatch[1];
                    unconsumedText = unconsumedText.substring(unconsumedText.indexOf("{", headerMatch.index! + headerMatch.length));
                }

                if (unconsumedText.length < currentLength) return;

                const obj = JSON.parse(unconsumedText.substring(0, currentLength));
                unconsumedText = unconsumedText.substring(currentLength);
                currentLength = -1;

                handleMessage(obj);
            }
        });
    }

    function handleMessage(obj: any): void {
        if (obj.type === "event" && obj.event !== "requestCompleted") {
            for (const listener of eventListeners) {
                listener(obj);
            }
            return;
        }

        const requestSeq = obj.type === "event"
            ? obj.body.request_seq
            : obj.request_seq

        const w = waiters.get(requestSeq);
        if (w) {
            waiters.delete(requestSeq);
            w(obj);
        }
        else {
            objects.set(requestSeq, obj);
        }
    }

    const getResponse = (seq: number) => new Promise<any>(resolve => {
        const obj = objects.get(seq);
        if (obj) {
            objects.delete(seq);
            resolve(obj);
        }
        else {
            waiters.set(seq, resolve);
        }
    });

    return getResponse;
}

async function message(serverProc: cp.ChildProcess, useNodeIpc: boolean, getResponse: (seq: number) => Promise<any>, request: any) {
    const seq: number = request.seq;
    if (useNodeIpc) {
        serverProc.send(request);
    } else {
        serverProc.stdin!.write(JSON.stringify(request) + "\n");
    }
    return await getResponse(seq);
}