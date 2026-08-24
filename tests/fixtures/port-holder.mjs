#!/usr/bin/env node
// Stand-in processes for tests/unit/pre-test-cleanup.test.ts.
//
// Unrecognised arguments are ignored on purpose. The caller marks a listener as
// a protected production process by passing the literal string `rust-ble-test`
// as an argument, because the guard under test matches that substring in
// `ps -o args=` -- so the marker has to be really present in this process's
// argv, not merely a flag this file reads and acts on.
//
// The marker must be an ARGUMENT, never part of this file's path: the
// unprotected variant is the control, and a path that carried the marker
// would make every case look protected and the control impossible to fail.
import net from 'net';

const args = process.argv.slice(2);
const mode = args[0];
const portArg = args.indexOf('--port');
const port = portArg === -1 ? 0 : Number(args[portArg + 1]);
const reusePort = args.includes('--reuse-port');

// Never outlive the test run that spawned us.
setTimeout(() => process.exit(0), 60_000);

if (mode === 'listen') {
  const server = net.createServer((socket) => socket.on('data', () => {}));
  server.on('error', (err) => {
    console.error(`fixture listen failed: ${err.message}`);
    process.exit(1);
  });
  server.listen({ port, reusePort }, () => {
    console.log(`ready ${process.pid} ${server.address().port}`);
  });
} else if (mode === 'connect') {
  const socket = net.connect(port, '127.0.0.1', () => {
    console.log(`ready ${process.pid} ${port}`);
  });
  socket.on('error', (err) => {
    console.error(`fixture connect failed: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
