import 'server-only';

type RoomInspector = (documentId: string) => number;

let roomInspector: RoomInspector | null = null;

export function installCollaborationRoomInspector(inspector: RoomInspector): () => void {
  roomInspector = inspector;
  return () => {
    if (roomInspector === inspector) roomInspector = null;
  };
}

export function getCollaborationRoomConnectionCount(documentId: string): number {
  return roomInspector?.(documentId) ?? 0;
}
