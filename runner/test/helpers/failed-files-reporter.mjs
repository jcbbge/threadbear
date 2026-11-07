// A node:test reporter that writes the test files with a failure, one
// path per line, and nothing else. check.sh runs the unit tests with it
// beside the spec reporter, so it can run just those files again, one at
// a time, when the whole suite under load failed tests that time out on a
// busy machine (6 Nov: six real-process tests took 13 to 145 s while other
// threads built the app). Plain .mjs so node loads it without a loader.
export default async function* failedFiles(source) {
  const files = new Set();
  for await (const event of source) {
    // A file that fails to load reports a test:fail for the file itself,
    // with the same `file`, so it's caught here too.
    if (event.type === 'test:fail' && event.data.file) files.add(event.data.file);
  }
  for (const f of files) yield `${f}\n`;
}
