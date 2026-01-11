# GEMINI.md

## Project Overview

This is a Next.js web application called "Canvas Notebook". It functions as an online notebook, similar to Obsidian, but with SSH integration, a file browser, and an integrated terminal.

The application is built with a modern tech stack, including:

*   **Framework:** Next.js (with React and TypeScript)
*   **UI:** shadcn/ui, Tailwind CSS, Radix UI, lucide-react
*   **Backend:** Node.js, Next.js API Routes
*   **State Management:** Zustand
*   **Authentication:** iron-session with bcrypt hashing
*   **SSH/SFTP:** ssh2, ssh2-sftp-client
*   **Terminal:** xterm.js, node-pty

The project is structured as a standard Next.js application with the main application logic in the `app/` directory. It includes a file browser, file editor, and a terminal. The backend is handled by Next.js API routes, which are responsible for file operations, authentication, and managing the terminal.

## Building and Running

### Development

To run the application in a development environment, follow these steps:

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Configure environment variables:**
    Create a `.env.local` file and configure the necessary environment variables for SSH, authentication, and other settings. You can use the `README.md` as a reference.

3.  **Start the development server:**
    ```bash
    npm run dev
    ```
    The application will be available at `http://localhost:3001`.

### Production

The application is designed to be deployed as a standalone Next.js application.

1.  **Build the application:**
    ```bash
    npm run build
    ```

2.  **Start the production server:**
    ```bash
    npm run start
    ```

## Testing

The project includes several types of tests:

*   **Smoke Tests:**
    ```bash
    npm run test:smoke
    ```

*   **Integration Tests (API):**
    ```bash
    npm run test:integration
    ```

*   **End-to-End (E2E) Tests (Playwright):**
    ```bash
    npm run test:e2e
    ```

*   **All tests:**
    ```bash
    npm run test:all
    ```

## Development Conventions

*   **Coding Style:** The project uses ESLint for code linting. Run `npm run lint` to check the code for any style issues.
*   **Commits:** The commit history is not available, so there are no specific conventions to follow.
*   **Branching:** The branching strategy is not available, so there are no specific conventions to follow.

This `GEMINI.md` file provides a comprehensive overview of the project, how to get it running, and the development conventions to follow.
