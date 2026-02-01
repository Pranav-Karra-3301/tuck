import { Command } from 'commander';
import { basename, sep } from 'path';
import { prompts, logger, formatCount, colors as c } from '../ui/index.js';
import { getTuckDir } from '../lib/paths.js';
import { loadManifest, getAllTrackedFiles } from '../lib/manifest.js';
import { NotInitializedError } from '../errors.js';
import { CATEGORIES } from '../constants.js';
import type { ListOptions } from '../types.js';

interface CategoryGroup {
  name: string;
  icon: string;
  files: { id: string; source: string; destination: string; isDir: boolean }[];
}

const groupByCategory = async (tuckDir: string): Promise<CategoryGroup[]> => {
  const files = await getAllTrackedFiles(tuckDir);
  const groups: Map<string, CategoryGroup> = new Map();

  for (const [id, file] of Object.entries(files)) {
    const category = file.category;
    const categoryConfig = CATEGORIES[category] || { icon: '📄' };

    if (!groups.has(category)) {
      groups.set(category, {
        name: category,
        icon: categoryConfig.icon,
        files: [],
      });
    }

    groups.get(category)!.files.push({
      id,
      source: file.source,
      destination: file.destination,
      // Handle both Unix (/) and Windows (\) path separators for directory detection
      isDir: file.destination.endsWith('/') || file.destination.endsWith(sep) || basename(file.destination) === 'nvim',
    });
  }

  // Sort groups by name and files within each group
  return Array.from(groups.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      ...group,
      files: group.files.sort((a, b) => a.source.localeCompare(b.source)),
    }));
};

const printList = (groups: CategoryGroup[]): void => {
  prompts.intro('tuck list');

  if (groups.length === 0) {
    prompts.log.warning('No files are currently tracked');
    prompts.note("Run 'tuck add <path>' to start tracking files", 'Tip');
    return;
  }

  let totalFiles = 0;

  for (const group of groups) {
    const fileCount = group.files.length;
    totalFiles += fileCount;

    console.log();
    console.log(
      c.bold(`${group.icon} ${group.name}`) + c.dim(` (${formatCount(fileCount, 'file')})`)
    );

    group.files.forEach((file, index) => {
      const isLast = index === group.files.length - 1;
      const prefix = isLast ? '└── ' : '├── ';
      const name = basename(file.source) || file.source;
      const arrow = c.dim(' → ');
      const dest = c.dim(file.source);

      console.log(c.dim(prefix) + c.cyan(name) + arrow + dest);
    });
  }

  console.log();
  prompts.outro(`Total: ${formatCount(totalFiles, 'tracked item')}`);
};

const printPathsOnly = (groups: CategoryGroup[]): void => {
  for (const group of groups) {
    for (const file of group.files) {
      console.log(file.source);
    }
  }
};

const printJson = (groups: CategoryGroup[]): void => {
  const output = groups.reduce(
    (acc, group) => {
      acc[group.name] = group.files.map((f) => ({
        source: f.source,
        destination: f.destination,
      }));
      return acc;
    },
    {} as Record<string, { source: string; destination: string }[]>
  );

  console.log(JSON.stringify(output, null, 2));
};

const runList = async (options: ListOptions): Promise<void> => {
  const tuckDir = getTuckDir();

  // Verify tuck is initialized
  try {
    await loadManifest(tuckDir);
  } catch {
    throw new NotInitializedError();
  }

  let groups = await groupByCategory(tuckDir);

  // Filter by category if specified
  if (options.category) {
    groups = groups.filter((g) => g.name === options.category);
    if (groups.length === 0) {
      logger.warning(`No files found in category: ${options.category}`);
      return;
    }
  }

  // Output based on format
  if (options.json) {
    printJson(groups);
  } else if (options.paths) {
    printPathsOnly(groups);
  } else {
    printList(groups);
  }
};

export const listCommand = new Command('list')
  .description('List all tracked files')
  .option('-c, --category <name>', 'Filter by category')
  .option('--paths', 'Show only paths')
  .option('--json', 'Output as JSON')
  .action(async (options: ListOptions) => {
    await runList(options);
  });
