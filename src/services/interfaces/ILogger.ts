interface ILogger {
  error(message: string, ...optionalParams: unknown[]): void;
  info(message: string): void;
  log(message: string, ...optionalParams: unknown[]): void;
  warn(message: string): void;
}

export type {
  ILogger
};

