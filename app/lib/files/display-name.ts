type FileDisplayNode = {
  name: string;
  type: 'file' | 'directory';
};

export function getFileDisplayName(node: FileDisplayNode): string {
  if (node.type !== 'file') return node.name;

  const markdownExtension = '.md';
  if (
    node.name.length > markdownExtension.length &&
    node.name.toLowerCase().endsWith(markdownExtension)
  ) {
    return node.name.slice(0, -markdownExtension.length);
  }

  return node.name;
}
