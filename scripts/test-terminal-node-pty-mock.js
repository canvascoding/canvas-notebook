const Module = require('module');
const { EventEmitter } = require('events');

function createMockPty(shellPath) {
  const emitter = new EventEmitter();
  let killed = false;
  let promptTimer = setTimeout(() => {
    emitData(`mock:${shellPath}$ `);
  }, 10);

  function emitData(data) {
    if (!killed) {
      emitter.emit('data', data);
    }
  }

  function emitExit(exitCode) {
    if (killed) {
      return;
    }
    killed = true;
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
    }
    emitter.emit('exit', { exitCode });
  }

  function renderCommand(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return '\r\n';
    }
    if (trimmed === '\u0003') {
      return '^C\r\n';
    }
    const quoted = trimmed.match(/(?:printf|echo)\s+"([^"]*)"/);
    if (quoted) {
      return `${quoted[1]}\r\n`;
    }
    return `executed: ${trimmed}\r\n`;
  }

  return {
    pid: Math.floor(Math.random() * 10000) + 1000,
    onData(listener) {
      emitter.on('data', listener);
      return { dispose: () => emitter.off('data', listener) };
    },
    onExit(listener) {
      emitter.on('exit', listener);
      return { dispose: () => emitter.off('exit', listener) };
    },
    write(data) {
      if (killed) {
        return;
      }

      const chunks = data.split('\n');
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const isLast = index === chunks.length - 1;
        if (chunk.length === 0 && isLast) {
          continue;
        }

        emitData(renderCommand(chunk));
        if (!killed) {
          emitData(`mock:${shellPath}$ `);
        }
      }
    },
    resize() {},
    kill() {
      emitExit(0);
    },
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'node-pty') {
    return {
      spawn(shellPath) {
        return createMockPty(shellPath);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
