# Canvas Notebook Service — Architecture Context

**Repository:** `canvasstudios-notebook` (this repo)  
**Role:** Container Service (Client VM Core)  
**Scope:** Unchanged. This repository continues to host the Canvas Notebook Next.js application and its Docker packaging.

---

## 1. Role in the Control Plane

This repository contains the **Canvas Notebook application** that runs inside a Docker container on every managed Client VM.

- **Docker Image:** Built from this repo, served via GitHub Container Registry or Docker Hub.
- **Runtime:** Node.js + Next.js inside Docker, port 3000.
- **Data Volumes:** `/data` (persistent workspace) and `/home/node` (optional CLI tools).
- **Management:** The Canvas Agent (part of the `canvas-control-plane` monorepo) manages the lifecycle of this container. It does **not** modify code in this repository.

This repository remains **untouched** by the Control Plane project. No refactoring is required.

---

## 2. Interfaces to the Control Plane

The following parts of this repository are relevant for the Control Plane integration:

### 2.1 Canvas Notebook CLI (`canvas-notebook`)

A CLI tool installed on the VM host (outside Docker) that controls the container:

| Command | Purpose | Used by Agent |
|---------|---------|-------------|
| `canvas-notebook update` | Pull latest image and recreate container | Yes |
| `canvas-notebook restart` | Restart container | Yes |
| `canvas-notebook start` | Start container | Yes |
| `canvas-notebook stop` | Stop container | Yes |
| `canvas-notebook health` | HTTP check on `/api/health` | Yes |
| `canvas-notebook logs` | Follow container logs | Yes |
| `canvas-notebook status` | Show container status | Yes |

**Reference:** Full specification in the Control Plane plan, sections 7.3 and 8.2.

### 2.2 Docker Compose

The existing `docker-compose.yml` in this repo defines the service. The Agent expects this file to exist at a known path (e.g. `/opt/canvas/canvas-notebook-compose.yaml`).

### 2.3 Health Endpoint

The application exposes `GET /api/health`. The Agent polls this to determine container readiness.

---

## 3. What Stays in This Repo

- Next.js application code (App Router, API routes, components).
- Docker build configuration.
- `install.sh` (for standalone installation, still supported).
- Canvas CLI (`canvas-notebook`) source code.

## 4. What Moves to the Monorepo

- **Canvas Agent:** A new Node.js service that runs on the VM host and connects to the Control Plane. This is **not** part of this repository. It will be developed in the `canvas-control-plane` monorepo under `packages/agent` or `apps/agent`.
- **Control Plane API:** The central management API. Developed in the monorepo under `apps/api`.
- **Admin Dashboard UI:** The serverless Next.js app for managing VMs. Developed in the monorepo under `apps/web`.

---

## 5. Summary

This repository is the **payload**. The Control Plane is the **orchestrator**. They communicate exclusively through:
- Docker CLI (Agent controls container).
- HTTP Health Checks (Agent reads container status).
- WebSocket Tunnel (Agent reports to Control Plane, receives commands).

No code changes in this repository are required for V1.

---

*For the complete system architecture, see `../canvas-control-plane/plan.md`.*