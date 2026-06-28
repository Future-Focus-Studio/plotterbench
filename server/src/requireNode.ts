// Runtime guard: fail loudly and clearly on unsupported Node.js versions.
//
// This is imported first by the server entry point so it runs before any
// dependency is evaluated. Unlike the `engines` field (which npm only warns
// about), this actually stops the app from starting on old Node, regardless
// of how it was launched or which package manager built node_modules.

const MIN_MAJOR = 20; // Node 20 LTS

const current = process.versions.node;
const major = Number(current.split(".")[0]);

if (!Number.isFinite(major) || major < MIN_MAJOR) {
  process.stderr.write(
    `\nplotterbench requires Node.js ${MIN_MAJOR} or newer (Node ${MIN_MAJOR} LTS is the minimum).\n` +
      `You are running Node ${current}.\n\n` +
      `Install a supported version (e.g. via https://nodejs.org or \`nvm install ${MIN_MAJOR}\`) and try again.\n\n`,
  );
  process.exit(1);
}
