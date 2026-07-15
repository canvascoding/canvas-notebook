const USER_COLORS = [
  ['#2563eb', '#dbeafe'],
  ['#7c3aed', '#ede9fe'],
  ['#db2777', '#fce7f3'],
  ['#059669', '#d1fae5'],
  ['#d97706', '#fef3c7'],
  ['#0891b2', '#cffafe'],
] as const;

export function collaborationUserColors(userId: string): { color: string; colorLight: string } {
  let hash = 0;
  for (const char of userId) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const [color, colorLight] = USER_COLORS[Math.abs(hash) % USER_COLORS.length];
  return { color, colorLight };
}
