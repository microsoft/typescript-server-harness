// @ts-check

const serverHarness = require("@typescript/server-harness");

const fs = require("fs");
const path = require("path");
const process = require("process");
const { performance } = require("perf_hooks");

const testDir = path.join(__dirname, "reproProject");

// Needed for excludedDirectories
process.chdir(testDir);

main().catch(e => console.error(e));

async function main() {
    const server = serverHarness.launchServer(
        path.join(__dirname, "node_modules", "typescript", "lib", "tsserver.js"),
        // Arguments to tsserver.js
        [
            // ATA generates some extra network traffic and isn't usually relevant when profiling
            "--disableAutomaticTypingAcquisition",

            // Enable this if you're emulating VS
            // "--suppressDiagnosticEvents",

            // Produce a performance trace
            "--traceDirectory", path.join(__dirname, "traces"),

            // Produce a server log
            "--logVerbosity", "verbose",
            "--logFile", path.join(__dirname, "logs", "tsserver.PID.log"),
        ],
        // Arguments to node
        [
            // Enable this to debug the server process (not the driver process)
            // "--inspect-brk=9230",

            // Generate time and heap profiles (see https://github.com/jakebailey/pprof-it for config options)
            // Disable logging if profiling - their cleanup handlers conflict
            // Disable tracing if profiling - it causes unrealistic slowdowns
            // `--require=${path.join(__dirname, "node_modules", "pprof-it", "dist", "index.js")}`,

            // Increasing the heap size is just generally a good idea
            "--max-old-space-size=4096",

            // This will enable some GC output in the server log
            "--expose-gc"
        ],
        // Environment variables for server process (mostly useful for pprof-it)
        {
            "PPROF_OUT": path.join(__dirname, "profiles")
        });

    server.on("exit", code => console.log(code ? `Exited with code ${code}` : `Terminated`));
    server.on("event", e => console.log(e));

    let seq = 1;

    // Always start with a `configure` message (possibly preceded by `status` if emulating VS)
    await server.message({
        "seq": seq++,
        "type": "request",
        "command": "configure",
        "arguments": {
            "preferences": {
                "includePackageJsonAutoImports": "auto"
            },
            "watchOptions": {
                "excludeDirectories": ["**/node_modules"]
            }
        }
    });

    // Open a file
    let start = performance.now();
    const openFilePath = path.join(testDir, "src", "analyze-trace-utilities.ts");
    const updateOpenResponse = await server.message({
        "seq": seq++,
        "type": "request",
        "command": "updateOpen",
        "arguments": {
            "changedFiles": [],
            "closedFiles": [],
            "openFiles": [
                {
                    "file": openFilePath,
                    "fileContent": await fs.promises.readFile(openFilePath, { encoding: "utf-8" }),
                    "projectRootPath": testDir,
                    "scriptKindName": "TS", // It's easy to get this wrong when copy-pasting
                }
            ]
        }
    });
    let end = performance.now();
    // Note: reporting the time like this is redundant if you're also collecting a trace
    console.log(`Initial file open took ${Math.round(end - start)} ms including ${Math.round(updateOpenResponse.performanceData.updateGraphDurationMs)} ms of update graph time`);

    // Request squiggles
    // Note: the response is uninteresting - the actual diagnostics are in events
    start = performance.now();
    await server.message({
        "seq": seq++,
        "type": "request",
        "command": "geterr",
        "arguments": {
            "delay": 0,
            "files": [ openFilePath ],
        }
    });
    end = performance.now();
    console.log(`Computing squiggles took ${Math.round(end - start)} ms`);

    // Edit the file, introducing an error
    // - import fs = require("fs");
    // + import fs = require("fs1");
    await server.message({
        "seq": seq++,
        "type": "request",
        "command": "updateOpen",
        "arguments": {
            "closedFiles": [],
            "openFiles": [],
            "changedFiles": [
                {
                    "fileName": openFilePath,
                    "textChanges": [{"newText":"1","start":{"line":4,"offset":24},"end":{"line":4,"offset":24}}],
                }
            ],
        }
    });

    start = performance.now();
    await server.message({
        "seq": seq++,
        "type": "request",
        "command": "geterr",
        "arguments": {
            "delay": 0,
            "files": [ openFilePath ],
        }
    });
    end = performance.now();
    console.log(`Computing squiggles (with error) took ${Math.round(end - start)} ms`);

    // Revert edit
    await server.message({
        "seq": seq++,
        "type": "request",
        "command": "updateOpen",
        "arguments": {
            "closedFiles": [],
            "openFiles": [],
            "changedFiles": [
                {
                    "fileName": openFilePath,
                    "textChanges": [{"newText":"","start":{"line":4,"offset":24},"end":{"line":4,"offset":25}}],
                }
            ],
        }
    });

    // Find all references to `normalizePositions`
    start = performance.now();
    const references = await server.message({
        "seq": seq++,
        "type": "request",
        "command": "references",
        "arguments": {
            "file": openFilePath,
            "line": 7,
            "offset": 8
        }
    });
    end = performance.now();
    console.log(`Found ${references.body.refs.length} references in ${Math.round(end - start)} ms`);

    // Tell the server to shut down
    await server.message({ "seq": seq++, "command": "exit" });
}