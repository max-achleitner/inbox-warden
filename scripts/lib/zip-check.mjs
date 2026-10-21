// Open a bundle the way Claude Desktop does: yauzl 3 with its strict end-of-central-directory
// check (a signature block appended after the ZIP end fails with "Invalid comment length").
import yauzl from "yauzl";

export function openLikeClaudeDesktop(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (openErr, zip) => {
      if (openErr) return reject(openErr);
      let entries = 0;
      let manifest = false;
      const fail = (err) => {
        zip.close();
        reject(err);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        zip.close();
        if (!manifest) return reject(new Error("manifest.json is missing"));
        resolve({ entries });
      });
      zip.on("entry", (entry) => {
        entries += 1;
        if (entry.fileName === "manifest.json") manifest = true;
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          stream.on("error", fail);
          stream.on("end", () => zip.readEntry());
          stream.resume();
        });
      });
      zip.readEntry();
    });
  });
}
