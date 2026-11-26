import * as fs   from 'fs';
import * as path from 'path';
import { readProjectMeta } from './uv2make';
import { readProjectSettings } from './settingsWebview';
import { pathStartsWith } from './utils';

/** Return the minimal covering set: remove any dir that is a sub-dir of another dir in the list. */
function minimalRoots(absDirs: string[]): string[] {
  const unique = [...new Set(absDirs.map(d => path.normalize(d)))];
  return unique.filter(d => !unique.some(other => other !== d && pathStartsWith(d, other)));
}

// ── exports ───────────────────────────────────────────────────────────────────

/**
 * Compute the folders array for a .code-workspace file.
 *
 * @param wsDir      Absolute path to HT32_VSCode/.
 * @param bgDirNames build-gen dir names (entries from .ht32vs projects[]).
 */
export function computeWorkspaceFolders(
  wsDir: string,
  bgDirNames: string[]
): Array<{ path: string; name?: string }> {
  const projectRoot  = path.dirname(wsDir);
  const externalDirs: string[] = [];

  for (const bgName of bgDirNames) {
    const bgDir = path.join(wsDir, bgName);

    // Source files from project.meta.json
    const meta = readProjectMeta(bgDir);
    if (meta) {
      for (const files of Object.values(meta.groups)) {
        for (const src of files as string[]) {
          const absDir = path.dirname(path.resolve(bgDir, src));
          if (!pathStartsWith(absDir, projectRoot) && !pathStartsWith(projectRoot, absDir)) {
            externalDirs.push(absDir);
          }
        }
      }
    }

    // Include paths from project.settings.json
    const settings = readProjectSettings(bgDir);
    for (const inc of settings.includePaths) {
      const absInc = path.resolve(bgDir, inc);
      if (!pathStartsWith(absInc, projectRoot) && !pathStartsWith(projectRoot, absInc)) {
        externalDirs.push(absInc);
      }
    }
  }

  const folders: Array<{ path: string; name?: string }> = [
    { path: '.' },
    { path: '..' },
  ];

  for (const extRoot of minimalRoots(externalDirs)) {
    const rel = path.relative(wsDir, extRoot).replace(/\\/g, '/');
    folders.push({ path: rel, name: path.basename(extRoot) });
  }

  return folders;
}

/**
 * Write a .code-workspace file alongside the .ht32vs file.
 * File name matches the .ht32vs base name.
 *
 * @returns Absolute path to the written .code-workspace file.
 */
export function writeCodeWorkspace(ht32vsPath: string, bgDirNames: string[]): string {
  const wsDir    = path.dirname(ht32vsPath);
  const baseName = path.basename(ht32vsPath, '.ht32vs');
  const outPath  = path.join(wsDir, `${baseName}.code-workspace`);

  const folders = computeWorkspaceFolders(wsDir, bgDirNames);
  const content = {
    folders,
    settings: {
      'search.exclude': { '**/build/**': true },
    },
  };

  fs.writeFileSync(outPath, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return outPath;
}
