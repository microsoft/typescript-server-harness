import cp = require("child_process");
import os = require("os");

type EventListener = (obj: any) => void;
type ExitListener = (code: number | null) => void;
type CloseListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface Server {
    /** Returns the response (or event) with the matching `request_seq`. */
    message(request: any): Promise<any>;
    /**
     * Sends an exit message to the server and forcibly kills it if it hasn't exited after `timeoutMs`.
     * Throws if the request fails (e.g. if the server has already exited).
     * Throws if the server doesn't exit before `timeoutMs` and it cannot be killed.
     * Returns true if the server exited before `timeoutMs` and false if it was killed.
     */
    exitOrKill(timoutMs: number): Promise<boolean>;
    /** Kills the server, regardless of its current state. */
    kill(): Promise<void>;
    /** Fires when an event is received from the server. */
    on(event: "event", listener: EventListener): void;
    /** Fires when the server exits. */
    on(event: "exit", listener: ExitListener): void;
    /** Fires when the server closes (exits + closes IO streams). */
    on(event: "close", listener: CloseListener): void;
}

/**
 * Forks a new server process.  By default, the server will not have ATA or produce diagnostic events.
 */
export function launchServer(tsserverPath: string, args?: string[], execArgv?: string[], env?: NodeJS.ProcessEnv): Server {
    const eventListeners: EventListener[] = [];
    const exitListeners: ExitListener[] = [];
    const closeListeners: CloseListener[] = [];

    const serverProc = cp.fork(
        tsserverPath,
        args ?? ["--disableAutomaticTypingAcquisition"],
        {
            execArgv: execArgv ?? process.execArgv?.map(arg => bumpDebugPort(arg)),
            env,
            stdio: ["pipe", "pipe", "ignore", "ipc"]
        });

    const useNodeIpc = !!args && !!args.filter(a => a.toLocaleLowerCase() === "--useNodeIpc".toLocaleLowerCase()).length;

    const getNext = makeListeners(serverProc, useNodeIpc, eventListeners);

    serverProc.on("exit", code => {
        for (const listener of exitListeners) {
            listener(code);
        }
    });

    serverProc.on("close", (code, signal) => {
        for (const listener of closeListeners) {
            listener(code, signal);
        }
    });

    function on(event: "event", listener: EventListener): void;
    function on(event: "exit", listener: ExitListener): void;
    function on(event: "close", listener: CloseListener): void;
    function on(event: "event" | "exit" | "close", listener: EventListener | ExitListener | CloseListener): void {
        switch (event) {
            case "event":
                eventListeners.push(listener as EventListener);
                break;
            case "exit":
                exitListeners.push(listener as ExitListener);
                break;
            case "close":
                closeListeners.push(listener as CloseListener);
                break;
        }
    }

    return {
        message: request => message(serverProc, useNodeIpc, getNext, request),
        exitOrKill: timeoutMs => exitOrKill(serverProc, useNodeIpc, timeoutMs),
        kill: () => kill(serverProc),
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
        let unconsumedChunks: Buffer[] = [];
        let unconsumedByteLength = 0;
        let headerByteLength = -1;
        let currentByteLength = -1;
        serverProc.stdout!.on('data', buffer => {
            unconsumedChunks.push(buffer);
            unconsumedByteLength += buffer.byteLength;

            while (true) {
                if (headerByteLength < 0) {
                    // This could be done directly in the buffer, but strings are much simpler
                    const text = Buffer.concat(unconsumedChunks, unconsumedByteLength).toString("utf8");
                    const headerMatch = text.match(/Content-Length: (\d+)/); // Receiving a chunk shorter than this is very unlikely
                    if (!headerMatch) break;
                    headerByteLength = text.indexOf("{", headerMatch.index! + headerMatch[0].length); // All single-byte characters
                    const bodyByteLength = +headerMatch[1];
                    currentByteLength = headerByteLength + bodyByteLength + (os.EOL.length - 1); // tsserver assumes the final newline has length one on every OS
                }

                if (unconsumedByteLength < currentByteLength) return;

                const combined = Buffer.concat(unconsumedChunks, unconsumedByteLength);
                const jsonText = combined.toString("utf8", headerByteLength, currentByteLength);
                const obj = JSON.parse(jsonText);
                unconsumedByteLength -= currentByteLength;
                unconsumedChunks = unconsumedByteLength > 0 ? [combined.subarray(currentByteLength)] : [];
                headerByteLength = -1;
                currentByteLength = -1;

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
    // TODO: It would be more robust to handle write/send failures
    if (!serverProc.connected || serverProc.killed || serverProc.exitCode !== null || serverProc.signalCode !== null) {
        throw new Error("Server has exited");
    }

    const seq: number = request.seq;
    if (useNodeIpc) {
        serverProc.send(request);
    } else {
        serverProc.stdin!.write(JSON.stringify(request) + "\n");
    }

    // Several commands, such as `configure`, are flagged as not requiring a response.  In practice, however,
    // they do return trivial responses.  The only command that definitely won't return a response is `exit`.
    // If it eventually becomes necessary to handle to handle another non-responding command, we'll probably
    // need to make message take an optional parameter to that effect.
    if (request.command === "exit") {
        return Promise.resolve(undefined);
    }

    return await getResponse(seq);
}

async function exitOrKill(serverProc: cp.ChildProcess, useNodeIpc: boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        let timedOut = false;

        serverProc.once("close", () => {
            if (!timedOut) {
                clearTimeout(timeout);
                resolve(true);
            }
        });

        const timeout = setTimeout(async () => {
            timedOut = true;
            await kill(serverProc);
            resolve(false);
        }, timeoutMs);

        // No response, so nothing to await
        message(serverProc, useNodeIpc, /*getResponse*/ undefined as never, { "command": "exit" }).catch(err => reject(err));;
    });
}

function kill(serverProc: cp.ChildProcess) {
    return new Promise<void>((resolve, reject) => {
        serverProc.once("close", () => {
            resolve();
        });

        // If the server has already exited, there won't be a close event
        if (serverProc.exitCode !== null || serverProc.signalCode !== null) {
            resolve();
        }

        if (!serverProc.kill("SIGKILL")) {
            reject(new Error("Failed to send kill signal to server"));
        }
    });
}