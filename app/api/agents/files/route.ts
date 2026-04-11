import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import {
  AgentConfigValidationError,
  isManagedAgentFileName,
  readManagedAgentFiles,
  readManagedAgentFile,
  writeManagedAgentFile,
  AGENT_MANAGED_FILE_NAMES,
  type AgentManagedFileName,
} from '@/app/lib/agents/storage';

type PutPayload = {
  fileName?: string;
  content?: string;
};

type PostPayload = {
  action: 'reset';
  fileName?: string;
};

async function requireSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return {
      session: null,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  return { session, response: null };
}

export async function GET(request: NextRequest) {
  const { response } = await requireSession(request);
  if (response) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'agents-files-get',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const files = await readManagedAgentFiles();
    return NextResponse.json({
      success: true,
      data: { files },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read agent files.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  const { response } = await requireSession(request);
  if (response) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'agents-files-put',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json()) as PutPayload;
    const fileName = payload.fileName?.trim();

    if (!fileName || !isManagedAgentFileName(fileName)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid fileName. Allowed: AGENTS.md, IDENTITY.md, USER.md, MEMORY.md, SOUL.md, TOOLS.md',
        },
        { status: 400 }
      );
    }

    if (typeof payload.content !== 'string') {
      return NextResponse.json({ success: false, error: 'content must be a string.' }, { status: 400 });
    }

    const content = await writeManagedAgentFile(fileName, payload.content);
    return NextResponse.json({
      success: true,
      data: {
        fileName,
        content,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to write agent file.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

// POST /api/agents/files - Reset to seed
export async function POST(request: NextRequest) {
  const { response } = await requireSession(request);
  if (response) {
    return response;
  }

  const limited = rateLimit(request, {
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'agents-files-post',
  });
  if (!limited.ok) {
    return limited.response;
  }

  try {
    const payload = (await request.json()) as PostPayload;

    if (payload.action !== 'reset') {
      return NextResponse.json(
        { success: false, error: 'Invalid action. Only "reset" is supported.' },
        { status: 400 }
      );
    }

    // Reset single file or all files
    if (payload.fileName) {
      // Reset single file
      const fileName = payload.fileName.trim() as AgentManagedFileName;
      if (!isManagedAgentFileName(fileName)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Invalid fileName. Allowed: AGENTS.md, IDENTITY.md, USER.md, MEMORY.md, SOUL.md, TOOLS.md',
          },
          { status: 400 }
        );
      }

      // Write empty content - this triggers seed fallback in readManagedAgentFile
      await writeManagedAgentFile(fileName, '');
      const content = await readManagedAgentFile(fileName);

      return NextResponse.json({
        success: true,
        data: {
          fileName,
          content,
          reset: true,
        },
      });
    } else {
      // Reset all files
      const results: Array<{ fileName: AgentManagedFileName; content: string }> = [];

      for (const fileName of AGENT_MANAGED_FILE_NAMES) {
        await writeManagedAgentFile(fileName, '');
        const content = await readManagedAgentFile(fileName);
        results.push({ fileName, content });
      }

      return NextResponse.json({
        success: true,
        data: {
          files: results,
          reset: true,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reset agent file.';
    const status = error instanceof AgentConfigValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
