/**
 * Keeps a test file's stdout for the test runner alone: console.log, info
 * and debug go to stderr instead.
 *
 * `node --test` runs each test file in a child process and, on Node 20 (CI
 * and the Dockerfile), reads that child's stdout as a stream of v8-serialized
 * test reports. Anything else written there - the app's own console.log, such
 * as "🔔 Payment received from backend {...}" from the internal routes - is
 * mixed into that stream, and when a log line and a report land split across
 * the same pipe chunks the runner tries to deserialize the text and fails the
 * whole file: "Unable to deserialize cloned data due to invalid or
 * unsupported version" (ERR_TEST_FAILURE, failureType uncaughtException).
 * It is timing-dependent, so it showed up as a flaky file that passed on a
 * re-run. stderr is not parsed, only passed through, so the logs stay visible.
 *
 * Require this before anything that logs. Tests that capture console.log
 * still replace it and put back what they found, so they work unchanged.
 * Not a test file (node --test only picks up *.test.js here).
 */
const util = require("node:util");

const toStderr = (...args) => {
  process.stderr.write(`${util.format(...args)}\n`);
};

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
