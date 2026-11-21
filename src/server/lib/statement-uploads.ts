import fs from "node:fs";
import path from "node:path";

const reservedWindowsName = /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;

export const ledgerUploadsDirectory = (ledgerRoot: string) => path.join(ledgerRoot, "uploads");

export function isStatementFileName(name: string): boolean {
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name)) return false;
  return process.platform !== "win32" || (!/[<>:"|?*]|[. ]$/.test(name) && !reservedWindowsName.test(name));
}

export function archiveStatement(source: string, directory: string, name: string, hash: string): string {
  if (!isStatementFileName(name)) throw new Error("Invalid statement filename");
  fs.mkdirSync(directory, { recursive: true });
  const { name: stem, ext } = path.parse(name);
  const suffix = hash.slice(-4);
  // Exclusive copies reserve each candidate even when multiple imports run together.
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}${attempt === 1 ? "" : `-${attempt}`}-${suffix}${ext}`;
    try {
      fs.copyFileSync(source, path.join(directory, candidate), fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
