const STUDIO_IMAGE_MEDIA_URL_REGEX =
  /\/api\/studio\/media\/[^\s<>"')\]]+\.(?:png|jpe?g|webp|gif)(?:[?#][^\s<>"')\]]*)?/gi;

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\n]+)\)/g;

type MarkdownImageDestination = {
  src: string;
  suffix: string;
  wrappedInAngles: boolean;
};

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function parseMarkdownImageDestination(value: string): MarkdownImageDestination {
  const trimmed = value.trim();
  if (trimmed.startsWith('<')) {
    const closingIndex = trimmed.indexOf('>');
    if (closingIndex > 0) {
      return {
        src: trimmed.slice(1, closingIndex),
        suffix: trimmed.slice(closingIndex + 1),
        wrappedInAngles: true,
      };
    }
  }

  const titled = trimmed.match(/^(\S+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/);
  if (titled) {
    return {
      src: titled[1],
      suffix: titled[2],
      wrappedInAngles: false,
    };
  }

  return {
    src: trimmed,
    suffix: '',
    wrappedInAngles: false,
  };
}

function formatMarkdownImageDestination(
  destination: MarkdownImageDestination,
  nextSrc: string,
): string {
  if (destination.wrappedInAngles) {
    return `<${nextSrc}>${destination.suffix}`;
  }
  return `${nextSrc}${destination.suffix}`;
}

function isRelativeImageSrc(src: string): boolean {
  const trimmed = src.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return true;
}

export function extractStudioImageMediaUrls(content: string): string[] {
  if (!content) return [];
  return uniqueValues([...content.matchAll(STUDIO_IMAGE_MEDIA_URL_REGEX)].map((match) => match[0]));
}

export function rewriteRelativeStudioImageMarkdown(
  content: string,
  studioMediaUrls: string[],
): string {
  const uniqueUrls = uniqueValues(studioMediaUrls).filter(Boolean);
  if (!content || uniqueUrls.length === 0) {
    return content;
  }

  let replacementIndex = 0;
  return content.replace(MARKDOWN_IMAGE_REGEX, (match, alt: string, rawDestination: string) => {
    const destination = parseMarkdownImageDestination(rawDestination);
    if (!isRelativeImageSrc(destination.src)) {
      return match;
    }

    const nextUrl = uniqueUrls[Math.min(replacementIndex, uniqueUrls.length - 1)];
    replacementIndex += 1;
    return `![${alt}](${formatMarkdownImageDestination(destination, nextUrl)})`;
  });
}
