import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    openHtmlPreview: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectFiles: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
  authKind: string | null = 'session',
): Promise<void> {
  const app = express();
  app.use(express.json());
  // What authenticateToken records for the request in the real server.
  app.use((request, _response, next) => {
    if (authKind) (request as typeof request & { authKind?: string }).authKind = authKind;
    next();
  });
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route uses the File Tree API namespace and forwards the project id', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: false }]]);
});

test('project files route requests gitignore filtering when explicitly enabled', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [['project-1', { respectGitignore: true }]]);
});

test('project files route forwards includeIgnored only when it is exactly "true"', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const base = `${baseUrl}/api/file-tree/projects/project-1/files`;
    for (const suffix of ['?respectGitignore=true&includeIgnored=true', '?respectGitignore=true&includeIgnored=false', '?respectGitignore=true&includeIgnored=1', '?respectGitignore=true']) {
      assert.equal((await fetch(`${base}${suffix}`)).status, 200);
    }
  });

  assert.deepEqual(inputs, [
    ['project-1', { respectGitignore: true, includeIgnored: true }],
    ['project-1', { respectGitignore: true }],
    ['project-1', { respectGitignore: true }],
    ['project-1', { respectGitignore: true }],
  ]);
});

test('project files route forwards the folder to list again and rejects a repeated path', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFiles']>[] = [];
  const services = createFakeServices({
    listProjectFiles: async (...input) => {
      inputs.push(input);
      return [];
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const folder = '/workspace/project/src/big folder';
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true&path=${encodeURIComponent(folder)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(inputs, [['project-1', { respectGitignore: true, path: folder }]]);

    const repeated = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files?path=a&path=b`);
    assert.equal(repeated.status, 400);
    assert.equal(inputs.length, 1, 'a malformed request never reaches the service');
  });
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});

const HTML_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

test('HP-04/HP-10a: the HTML preview page is the saved file under a sandbox policy with no network source', async () => {
  for (const html of ['<p>plain</p>', '<script>document.title = "ran"</script><p>with script</p>']) {
    const inputs: string[][] = [];
    await withFileTreeServer(createFakeServices({
      openHtmlPreview: async (projectId, filePath, maximumBytes) => {
        inputs.push([projectId, filePath]);
        assert.equal(maximumBytes, 200 * 1024 * 1024, 'the file tree size limit');
        return { stream: Readable.from([Buffer.from(html)]) };
      },
    }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/html-preview?path=${encodeURIComponent('site/index.html')}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), html);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('content-security-policy'), HTML_PREVIEW_CSP);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    });
    assert.deepEqual(inputs, [['p1', 'site/index.html']]);
  }
  const sandbox = HTML_PREVIEW_CSP.split('; ')[0].split(' ').slice(1);
  assert.deepEqual(sandbox, ['allow-scripts']);
  // No source the document could fetch from (frame-ancestors only says who may frame it).
  const fetchSources = HTML_PREVIEW_CSP.split('; ').filter((directive) => !directive.startsWith('frame-ancestors') && !directive.startsWith('sandbox'))
    .flatMap((directive) => directive.split(' ').slice(1));
  for (const network of ['http:', 'https:', 'ws:', 'wss:', "'self'", '*']) {
    assert.ok(!fetchSources.includes(network), network);
  }
});

test('HP-02/HP-04: the HTML preview answers JSON errors and serves nothing without a browser session', async () => {
  const opened: string[] = [];
  const services = createFakeServices({
    openHtmlPreview: async (_projectId, filePath) => {
      opened.push(filePath);
      throw new AppError('Path must be under project root', { statusCode: 403, code: 'PATH_OUTSIDE_PROJECT' });
    },
  });
  for (const authKind of [null, 'loopback', 'platform']) {
    await withFileTreeServer(services, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/html-preview?path=a.html`);
      assert.equal(response.status, 401, String(authKind));
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('content-security-policy'), null);
    }, authKind);
  }
  assert.deepEqual(opened, [], 'no file is opened without a session');
  await withFileTreeServer(services, async (baseUrl) => {
    const outside = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/html-preview?path=${encodeURIComponent('../../etc/x.html')}`);
    assert.equal(outside.status, 403);
    assert.deepEqual(await outside.json(), { error: 'Path must be under project root' });
    const missing = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/html-preview`);
    assert.equal(missing.status, 400);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
  });
});

test('HP-09: raw file content carries a sandbox policy and nosniff, and still streams the file', async () => {
  await withFileTreeServer(createFakeServices({
    openFile: async () => ({ contentType: 'image/png', stream: Readable.from([Buffer.from([0x89, 0x50, 0x4e, 0x47])]) }),
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/p1/files/content?path=logo.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('content-security-policy'), 'sandbox');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  });
});
