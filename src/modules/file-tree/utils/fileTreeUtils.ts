import type { TFunction } from 'i18next';

import type { FileTreeNode } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

export function filterFileTree(items: FileTreeNode[], query: string): FileTreeNode[] {
  return items.reduce<FileTreeNode[]>((filteredItems, item) => {
    const matchesName = item.name.toLowerCase().includes(query);
    const filteredChildren =
      item.type === 'directory' && item.children ? filterFileTree(item.children, query) : [];

    if (matchesName || filteredChildren.length > 0) {
      filteredItems.push({
        ...item,
        children: filteredChildren,
      });
    }

    return filteredItems;
  }, []);
}

// The folders the server left unlisted (its entry budget or depth limit ran out). They are listed when
// the user opens them.
export function collectPartialDirectories(items: FileTreeNode[]): FileTreeNode[] {
  const directories: FileTreeNode[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type !== 'directory') return;
      if (node.partial) directories.push(node);
      if (node.children) visit(node.children);
    });
  };

  visit(items);
  return directories;
}

// Returns a tree where the folder at `directoryPath` holds `children` (what the server listed when it was
// opened) or, when `children` is null, is marked as failed to load. Only the nodes on the way to it are copied.
export function replaceDirectoryChildren(
  items: FileTreeNode[],
  directoryPath: string,
  children: FileTreeNode[] | null,
): FileTreeNode[] {
  let changed = false;

  const visit = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes.map((node) => {
      if (node.type !== 'directory') return node;
      if (node.path === directoryPath) {
        changed = true;
        if (children === null) return { ...node, loadError: true };
        const { partial: _partial, loadError: _loadError, ...loaded } = node;
        return { ...loaded, children };
      }
      if (!node.children || changed) return node;
      const nextChildren = visit(node.children);
      return nextChildren === node.children || nextChildren.every((child, index) => child === node.children![index])
        ? node
        : { ...node, children: nextChildren };
    });

  const next = visit(items);
  return changed ? next : items;
}

// Lets a folder that failed to load be tried again the next time it is opened.
export function clearDirectoryLoadError(items: FileTreeNode[], directoryPath: string): FileTreeNode[] {
  const visit = (nodes: FileTreeNode[]): FileTreeNode[] | null => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.type !== 'directory') continue;
      if (node.path === directoryPath) {
        if (!node.loadError) return null;
        const { loadError: _loadError, ...rest } = node;
        return [...nodes.slice(0, index), rest, ...nodes.slice(index + 1)];
      }
      if (node.children) {
        const nextChildren = visit(node.children);
        if (nextChildren) return [...nodes.slice(0, index), { ...node, children: nextChildren }, ...nodes.slice(index + 1)];
      }
    }
    return null;
  };

  return visit(items) ?? items;
}

// During search we auto-expand every directory present in the filtered subtree.
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

