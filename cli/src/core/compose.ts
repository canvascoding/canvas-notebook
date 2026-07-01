import fs from 'node:fs/promises';
import path from 'node:path';

import { composePath } from './platform';
import type { CanvasCliConfig, HostPlatform } from './types';

function yamlDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderComposeFile(config: CanvasCliConfig, platform: HostPlatform): string {
  const envFile = composePath(config.paths.containerEnvFile, platform);

  return `services:
  canvas-notebook:
    container_name: canvas-notebook
    image: \${CANVAS_IMAGE:-ghcr.io/canvascoding/canvas-notebook:latest}
    ports:
      - "\${HOST_PORT:-3456}:\${CONTAINER_PORT:-3000}"
    env_file:
      - ${yamlDoubleQuote(envFile)}
    depends_on:
      postgres:
        condition: service_healthy
        required: false
    volumes:
      - "\${DATA_DIR:-./data}:/data"
    restart: unless-stopped

  postgres:
    profiles:
      - postgres
    container_name: canvas-notebook-postgres
    image: \${CANVAS_POSTGRES_IMAGE:-pgvector/pgvector:0.8.3-pg18}
    environment:
      POSTGRES_DB: \${CANVAS_POSTGRES_DB:-canvas_notebook}
      POSTGRES_USER: \${CANVAS_POSTGRES_USER:-canvas}
      POSTGRES_PASSWORD: \${CANVAS_POSTGRES_PASSWORD:-unused-sqlite-profile-disabled}
    volumes:
      - canvas-postgres-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${'$$'}{POSTGRES_USER} -d ${'$$'}{POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  canvas-postgres-data:
    name: \${CANVAS_POSTGRES_DATA_VOLUME:-canvas-postgres-data}
`;
}

export async function writeComposeFile(config: CanvasCliConfig, platform: HostPlatform): Promise<void> {
  await fs.mkdir(path.dirname(config.paths.composeFile), { recursive: true });
  await fs.writeFile(config.paths.composeFile, renderComposeFile(config, platform), 'utf8');
}
