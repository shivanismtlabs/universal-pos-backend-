import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { ApiSuccessResponse } from '../interfaces/api-response.interface';

/**
 * Wraps every successful controller return value as:
 * `{ success: true, data: <value> }`
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccessResponse<T>> {
    const reply = context.switchToHttp().getResponse<{
      getHeader?: (name: string) => unknown;
    }>();
    return next.handle().pipe(
      map((payload) => {
        if (payload instanceof StreamableFile) {
          return payload as unknown as ApiSuccessResponse<T>;
        }
        const contentType = String(
          reply.getHeader?.('content-type') ??
            reply.getHeader?.('Content-Type') ??
            '',
        );
        if (typeof payload === 'string' && contentType.includes('text/csv')) {
          return payload as unknown as ApiSuccessResponse<T>;
        }
        if (isAlreadyEnveloped(payload)) {
          return payload as ApiSuccessResponse<T>;
        }
        return {
          success: true as const,
          data: (payload === undefined ? null : payload) as T,
        };
      }),
    );
  }
}

function isAlreadyEnveloped(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    'data' in payload
  );
}
