# @typescript/server-harness
Tool for communicationg with a TypeScript tsserver process (i.e. a node process running the JS/TS language service).
Pairs responses with requests and provides hooks for listening to events.
Chiefly useful for reproducibly running editor scenarios for standalone investigation.

## Usage

See `samples/index.js` for an example of how to use the harness.
It can be run with `npm ci && node index`.

The easiest way to figure out what the requests should contain is to look at the server log from a real editor session.
In VS Code, you can access the server log by running the command `TypeScript: Open TS Server Log`.

## Deployment

To publish a new version of this package, change the version in `package.json` and push to main.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
