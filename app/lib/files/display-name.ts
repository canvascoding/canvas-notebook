type FileDisplayNode = {
  name: string;
  type: 'file' | 'directory';
};

export function getFileDisplayName(node: FileDisplayNode): string {
  if (node.type !== 'file') return node.name;

  const markdownExtensions = ['.markdown', '.mdx', '.md'];
  const lowerName = node.name.toLowerCase();
  const extension = markdownExtensions.find((item) => (
    node.name.length > item.length && lowerName.endsWith(item)
  ));

  if (extension) {
    return node.name.slice(0, -extension.length);
  }

  return node.name;
}
