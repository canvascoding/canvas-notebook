/**
 * Zentrale Logging-Utility für Canvas Notebook
 * 
 * Env-Vars:
 * - LOG_LEVEL: off | error | warn | info | debug (default: info)
 * - LOG_TO_STDOUT: true | false (default: true in dev, false in production)
 * - LOG_FILE: Pfad zur Log-Datei (default: /data/logs/runtime.log)
 */

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const getLogLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel;
  if (envLevel && LOG_LEVELS[envLevel] !== undefined) {
    return envLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
};

const shouldLogToStdout = (): boolean => {
  if (process.env.LOG_TO_STDOUT !== undefined) {
    return process.env.LOG_TO_STDOUT.toLowerCase() === 'true';
  }
  return process.env.NODE_ENV !== 'production';
};

const getLogFile = (): string | null => {
  if (process.env.LOG_FILE) {
    return process.env.LOG_FILE;
  }
  if (process.env.DATA && process.env.NODE_ENV === 'production') {
    return `${process.env.DATA}/logs/runtime.log`;
  }
  return null;
};

const writeToFile = async (message: string): Promise<void> => {
  const logFile = getLogFile();
  if (!logFile) return;

  try {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch {
    // Silent fail - don't crash on logging errors
  }
};

const formatMessage = (level: string, module: string, args: unknown[]): string => {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  const modulePrefix = module ? `[${module}] ` : '';
  return `[${level}] ${modulePrefix}${message}`;
};

const log = (level: LogLevel, module: string, args: unknown[]): void => {
  const currentLevel = getLogLevel();
  
  if (LOG_LEVELS[level] > LOG_LEVELS[currentLevel]) {
    return;
  }

  const message = formatMessage(level.toUpperCase(), module, args);
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}`;

  if (shouldLogToStdout()) {
    if (level === 'error') {
      console.error(fullMessage);
    } else if (level === 'warn') {
      console.warn(fullMessage);
    } else {
      console.log(fullMessage);
    }
  }

  if (process.env.NODE_ENV === 'production') {
    void writeToFile(message);
  }
};

export const logger = {
  debug: (...args: unknown[]) => log('debug', '', args),
  info: (...args: unknown[]) => log('info', '', args),
  warn: (...args: unknown[]) => log('warn', '', args),
  error: (...args: unknown[]) => log('error', '', args),
  
  module: (moduleName: string) => ({
    debug: (...args: unknown[]) => log('debug', moduleName, args),
    info: (...args: unknown[]) => log('info', moduleName, args),
    warn: (...args: unknown[]) => log('warn', moduleName, args),
    error: (...args: unknown[]) => log('error', moduleName, args),
  }),
};

export const getLogConfig = () => ({
  level: getLogLevel(),
  logToStdout: shouldLogToStdout(),
  logFile: getLogFile(),
});
