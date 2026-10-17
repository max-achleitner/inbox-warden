// Bundle entry point. Runs on whatever Node.js the host provides, so it stays ES5-compatible:
// an old runtime gets a clear message instead of a SyntaxError from the real server code.
"use strict";

var REQUIRED_MAJOR = 20;
var major = parseInt(process.versions.node.split(".")[0], 10);

if (!(major >= REQUIRED_MAJOR)) {
  process.stderr.write(
    "inbox-warden needs Node.js " + REQUIRED_MAJOR + " or newer, but this host runs Node.js " +
      process.versions.node + ". Update Claude Desktop, or install inbox-warden with npm (see the user guide).\n"
  );
  process.exit(1);
}

var path = require("path");
var url = require("url");

// A file URL keeps paths with spaces and non-ASCII characters (C:\Users\Max Müller\...) intact.
import(url.pathToFileURL(path.join(__dirname, "bin.js")).href).catch(function (err) {
  process.stderr.write("inbox-warden failed to start: " + (err && err.message ? err.message : String(err)) + "\n");
  process.exit(1);
});
