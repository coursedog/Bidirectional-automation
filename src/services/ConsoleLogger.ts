import type { ILogger } from './interfaces/ILogger';

class ConsoleLogger implements ILogger {

  error(message: string, ...optionalParams: unknown[]): void {
    console.error(message, optionalParams);
  }

  info(message: string): void {
    console.info(message);
  }

  log(message: string, ...optionalParams: unknown[]): void {
    console.log(message, optionalParams);
  }

  warn(message: string): void {
    console.warn(message);
  }
}

export default ConsoleLogger;
