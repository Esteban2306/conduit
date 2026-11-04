import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class AppLogger implements LoggerService {
  private context = 'Application';

  setContext(context: string) {
    this.context = context;
  }
  private format(level: string, message: unknown, context?: string): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context: context || this.context,
      message,
    });
  }

  log(message: unknown, context?: string) {
    console.log(this.format('info', message, context));
  }

  error(message: unknown, trace?: string, context?: string) {
    console.error(this.format('error', { message, trace }, context));
  }

  warn(message: unknown, context?: string) {
    console.warn(this.format('warn', message, context));
  }

  debug(message: unknown, context?: string) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.format('debug', message, context));
    }
  }

  fatal(message: unknown, context?: string) {
    console.error(this.format('fatal', message, context));
  }
}
