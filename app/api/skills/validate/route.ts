import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/app/lib/auth';
import { parseFrontmatter, validateFrontmatter } from '@/app/lib/skills/skill-manifest-anthropic';

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { content } = body;

    if (typeof content !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Content must be a string' },
        { status: 400 }
      );
    }

    const { frontmatter, body: skillBody } = parseFrontmatter(content);

    if (!frontmatter) {
      return NextResponse.json({
        success: false,
        error: 'No valid YAML frontmatter found. SKILL.md must start with --- delimiters.',
        validation: { valid: false, errors: ['No valid YAML frontmatter found'], warnings: [] },
      });
    }

    const validation = validateFrontmatter(frontmatter);

    return NextResponse.json({
      success: true,
      validation,
      name: frontmatter.name,
      description: frontmatter.description,
      hasBody: skillBody.trim().length > 0,
    });
  } catch (error) {
    console.error('[Skills Validate API] Error:', error);
    return NextResponse.json(
      { success: false, error: 'Validation failed' },
      { status: 500 }
    );
  }
}