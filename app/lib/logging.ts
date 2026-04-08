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

const writeToFile = (message: string): void => {
  const logFile = getLogFile();
  if (!logFile) return;

  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (error) {
    // Silent fail - don't crash on logging errors
  }
};

const formatMessage = (level: string, module: string, args: any[]): string => {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  const modulePrefix = module ? `[${module}] ` : '';
  return `[${level}] ${modulePrefix}${message}`;
};

const log = (level: LogLevel, module: string, args: any[]): void => {
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
    writeToFile(message);
  }
};

export const logger = {
  debug: (...args: any[]) => log('debug', '', args),
  info: (...args: any[]) => log('info', '', args),
  warn: (...args: any[]) => log('warn', '', args),
  error: (...args: any[]) => log('error', '', args),
  
  module: (moduleName: string) => ({
    debug: (...args: any[]) => log('debug', moduleName, args),
    info: (...args: any[]) => log('info', moduleName, args),
    warn: (...args: any[]) => log('warn', moduleName, args),
    error: (...args: any[]) => log('error', moduleName, args),
  }),
};

export const getLogConfig = () => ({
  level: getLogLevel(),
  logToStdout: shouldLogToStdout(),
  logFile: getLogFile(),
});
