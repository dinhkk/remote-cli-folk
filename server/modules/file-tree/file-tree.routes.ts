import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  FileTreeLogger,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FileTreeUploadLimits = {
  maximumFileSizeMegabytes: number;
  maximumFileCount: number;
};

type UploadedRequest = Request & {
  files?: Express.Multer.File[];
};

/**
 * Policy of the HTML preview document: a sandbox without `allow-same-origin` (opaque origin: no cookie, no
 * storage, no access to the app), inline script and style only, no network source of any kind.
 */
const HTML_PREVIEW_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

function readBody(request: Request): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, fieldName: string, message?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(message ?? `${fieldName} is required`, {
      code: 'INVALID_FILE_TREE_REQUEST',
      statusCode: 400,
    });
  }
  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readProjectId(request: Request): string {
  return readRequiredString(request.params.projectId, 'projectId');
}

function readEntryType(value: unknown): 'file' | 'directory' {
  if (value !== 'file' && value !== 'directory') {
    throw new AppError('Type must be "file" or "directory"', {
      code: 'INVALID_FILE_TREE_ENTRY_TYPE',
      statusCode: 400,
    });
  }
  return value;
}

function readRelativePaths(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function readRequestedFileCount(value: unknown, fallbackCount: number): number {
  const parsedCount = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : fallbackCount;
}

function normalizeUploadedFiles(request: UploadedRequest): FileTreeUploadedFile[] {
  return Array.isArray(request.files)
    ? request.files.map((file) => ({
        originalName: file.originalname,
        temporaryPath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      }))
    : [];
}

function createRouteHandler(
  operation: (request: Request, response: Response) => void | Promise<void>,
  logger: FileTreeLogger,
): RequestHandler {
  return async (request, response) => {
    try {
      await operation(request, response);
    } catch (error) {
      if (error instanceof AppError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('File Tree API error', error);
      response.status(500).json({ error: message });
    }
  };
}

/**
 * Builds the File Tree HTTP router for the server composition root and route tests.
 * Paths are relative to the module's `/api/file-tree` mount point so the
 * complete HTTP surface has one feature-owned namespace.
 */
export function createFileTreeRouter(
  services: FileTreeServices,
  uploadFilesMiddleware: RequestHandler,
  uploadLimits: FileTreeUploadLimits,
  logger: FileTreeLogger,
): express.Router {
  const router = express.Router();

  router.get('/browse-filesystem', createRouteHandler(async (request, response) => {
    response.json(await services.browseWorkspace(readOptionalString(request.query.path)));
  }, logger));

  router.post('/create-folder', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const folderPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.createWorkspaceFolder(folderPath));
  }, logger));

  router.get('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const filePath = readRequiredString(request.query.filePath, 'filePath', 'Invalid file path');
    response.json(await services.readTextFile(readProjectId(request), filePath));
  }, logger));

  router.get('/projects/:projectId/files/content', createRouteHandler(async (request, response) => {
    // Raw bytes of any type: a browser that opens one as a page gets an opaque origin and never sniffs the type.
    response.setHeader('Content-Security-Policy', 'sandbox');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openFile(readProjectId(request), filePath);
    response.setHeader('Content-Type', file.contentType);
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming File Tree content', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      }
    });
  }, logger));

  // The Local HTML preview frame loads this page: the file's script runs in a sandboxed document with an
  // opaque origin and no network source, so it can read neither the session nor the app, nor call the server.
  router.get('/projects/:projectId/files/html-preview', createRouteHandler(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if ((request as Request & { authKind?: string }).authKind !== 'session') {
      throw new AppError('The preview needs a browser session', { code: 'HTML_PREVIEW_SESSION_REQUIRED', statusCode: 401 });
    }
    const filePath = readRequiredString(request.query.path, 'path', 'Invalid file path');
    const file = await services.openHtmlPreview(readProjectId(request), filePath, uploadLimits.maximumFileSizeMegabytes * 1024 * 1024);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', HTML_PREVIEW_CSP);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    file.stream.pipe(response);
    file.stream.on('error', (error) => {
      logger.error('Error streaming the HTML preview', error);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Error reading file' });
      } else {
        response.destroy();
      }
    });
  }, logger));

  router.put('/projects/:projectId/file', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const filePath = readRequiredString(body.filePath, 'filePath', 'Invalid file path');
    if (body.content === undefined) {
      throw new AppError('Content is required', {
        code: 'FILE_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }
    if (typeof body.content !== 'string') {
      throw new AppError('Content must be a string', {
        code: 'INVALID_FILE_CONTENT',
        statusCode: 400,
      });
    }
    response.json(await services.saveTextFile(readProjectId(request), filePath, body.content));
  }, logger));

  router.get('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const { path: directoryPath } = request.query;
    if (directoryPath !== undefined && typeof directoryPath !== 'string') {
      throw new AppError('path must be a single string', { code: 'INVALID_PATH', statusCode: 400 });
    }
    response.json(await services.listProjectFiles(readProjectId(request), {
      respectGitignore: request.query.respectGitignore === 'true',
      // "Show ignored files": only forwarded when asked for, so every other request reaches the service as before.
      ...(request.query.includeIgnored === 'true' ? { includeIgnored: true } : {}),
      // Only a `partial` folder the user opened is asked for again; without it the project root is listed.
      ...(directoryPath ? { path: directoryPath } : {}),
    }));
  }, logger));

  router.post('/projects/:projectId/files/create', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.name || !body.type) {
      throw new AppError('Name and type are required', {
        code: 'FILE_TREE_ENTRY_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    const name = readRequiredString(body.name, 'name');
    const type = readEntryType(body.type);
    const parentPath = readOptionalString(body.path) ?? '';
    response.json(await services.createEntry({
      projectId: readProjectId(request),
      parentPath,
      type,
      name,
    }));
  }, logger));

  router.put('/projects/:projectId/files/rename', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    if (!body.oldPath || !body.newName) {
      throw new AppError('oldPath and newName are required', {
        code: 'FILE_TREE_RENAME_FIELDS_REQUIRED',
        statusCode: 400,
      });
    }
    response.json(await services.renameEntry({
      projectId: readProjectId(request),
      oldPath: readRequiredString(body.oldPath, 'oldPath'),
      newName: readRequiredString(body.newName, 'newName'),
    }));
  }, logger));

  router.delete('/projects/:projectId/files', createRouteHandler(async (request, response) => {
    const body = readBody(request);
    const targetPath = readRequiredString(body.path, 'path', 'Path is required');
    response.json(await services.deleteEntry({
      projectId: readProjectId(request),
      targetPath,
    }));
  }, logger));

  const uploadHandler = createRouteHandler(async (request, response) => {
    const uploadedRequest = request as UploadedRequest;
    const body = readBody(request);
    const files = normalizeUploadedFiles(uploadedRequest);
    response.json(await services.storeUploadedFiles({
      projectId: readProjectId(request),
      targetPath: readOptionalString(body.targetPath) ?? '',
      relativePaths: readRelativePaths(body.relativePaths),
      requestedFileCount: readRequestedFileCount(body.requestedFileCount, files.length),
      files,
    }));
  }, logger);

  router.post(
    '/projects/:projectId/files/upload',
    (request: Request, response: Response, next: NextFunction) => {
      uploadFilesMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          void uploadHandler(request, response, next);
          return;
        }

        const errorCode = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
        if (errorCode === 'LIMIT_FILE_SIZE') {
          response.status(400).json({
            error: `File too large. Maximum size is ${uploadLimits.maximumFileSizeMegabytes}MB.`,
          });
          return;
        }
        if (errorCode === 'LIMIT_FILE_COUNT') {
          response.status(400).json({
            error: `Too many files. Maximum is ${uploadLimits.maximumFileCount} files.`,
          });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ error: message });
      });
    },
  );

  return router;
}
